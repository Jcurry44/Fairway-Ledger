#!/usr/bin/env python3
"""Build Deerwood's browser basemap from the authoritative 2024 NYSDOP tiles.

The four source ZIPs contain one-foot, four-band JPEG2000 imagery in
NAD83(2011) / New York West (ftUS), EPSG:6541.  This script verifies the
archives, reads each tile's world file, mosaics the RGB bands (band four is
near infrared), downsamples to a browser-sized WebP, and writes exact spatial
metadata for mapping pixels back to projected and geographic coordinates.

No course feature or legacy hazard data is read by this pipeline.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import sys
import zipfile

from PIL import Image, features


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_DIR = (
    REPO_ROOT / "data" / "course-source" / "deerwood" / "imagery" / "nysdop-2024"
)
DEFAULT_OUTPUT = REPO_ROOT / "assets" / "maps" / "deerwood" / "aerial-2024.webp"
DEFAULT_METADATA = REPO_ROOT / "data" / "course-maps" / "deerwood-aerial-2024.json"

EXPECTED_ARCHIVES = {
    "w_10771106_12_22500_4bd_2024.zip":
        "febb8722e4433c8d9dd7401cec4c92237efa950d1d798d36f83181a2e6aa1b9f",
    "w_10771108_12_22500_4bd_2024.zip":
        "b566f06abb1cb2a600be38b5ba3fd4b5e23d6fb7d869dd05dd20d8e393db4ae0",
    "w_10801106_12_22500_4bd_2024.zip":
        "da08a6760ceb27e194bf7a88ddcb85515fe0cb3c38a5b2a7b5a965cc60b70800",
    "w_10801108_12_22500_4bd_2024.zip":
        "aa0a6c5a91006853590e5e4b4ca3e99d96d36b7c15c6ab70a7e5674c77e56da9",
}

# EPSG:6541: NAD83(2011) / New York West (ftUS).
SEMI_MAJOR_M = 6_378_137.0
INVERSE_FLATTENING = 298.257222101
LATITUDE_OF_ORIGIN_DEG = 40.0
CENTRAL_MERIDIAN_DEG = -78.583333333333333
SCALE_FACTOR = 0.9999375
FALSE_EASTING_M = 350_000.0
FALSE_NORTHING_M = 0.0
US_SURVEY_FOOT_M = 1200.0 / 3937.0

COURSE_REFERENCE_BOUNDS = {
    "west": -78.8466930,
    "south": 43.0362622,
    "east": -78.8286029,
    "north": 43.0452657,
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def meridional_arc(latitude_rad: float) -> float:
    flattening = 1.0 / INVERSE_FLATTENING
    eccentricity_sq = flattening * (2.0 - flattening)
    e4 = eccentricity_sq * eccentricity_sq
    e6 = e4 * eccentricity_sq
    return SEMI_MAJOR_M * (
        (1.0 - eccentricity_sq / 4.0 - 3.0 * e4 / 64.0 - 5.0 * e6 / 256.0)
        * latitude_rad
        - (3.0 * eccentricity_sq / 8.0 + 3.0 * e4 / 32.0 + 45.0 * e6 / 1024.0)
        * math.sin(2.0 * latitude_rad)
        + (15.0 * e4 / 256.0 + 45.0 * e6 / 1024.0)
        * math.sin(4.0 * latitude_rad)
        - 35.0 * e6 / 3072.0 * math.sin(6.0 * latitude_rad)
    )


def project_wgs84(longitude_deg: float, latitude_deg: float) -> tuple[float, float]:
    """Project lon/lat to EPSG:6541, returning US survey feet.

    NAD83(2011) geographic coordinates are treated as browser WGS84 without a
    datum shift.  The difference is immaterial at this basemap's scale, while
    the full State Plane projection is retained.
    """

    flattening = 1.0 / INVERSE_FLATTENING
    eccentricity_sq = flattening * (2.0 - flattening)
    second_eccentricity_sq = eccentricity_sq / (1.0 - eccentricity_sq)
    latitude = math.radians(latitude_deg)
    longitude_delta = math.radians(longitude_deg - CENTRAL_MERIDIAN_DEG)
    origin = math.radians(LATITUDE_OF_ORIGIN_DEG)

    sin_latitude = math.sin(latitude)
    cos_latitude = math.cos(latitude)
    tangent = math.tan(latitude)
    radius = SEMI_MAJOR_M / math.sqrt(1.0 - eccentricity_sq * sin_latitude**2)
    tangent_sq = tangent**2
    eta_sq = second_eccentricity_sq * cos_latitude**2
    a_term = cos_latitude * longitude_delta

    easting_m = FALSE_EASTING_M + SCALE_FACTOR * radius * (
        a_term
        + (1.0 - tangent_sq + eta_sq) * a_term**3 / 6.0
        + (
            5.0
            - 18.0 * tangent_sq
            + tangent_sq**2
            + 72.0 * eta_sq
            - 58.0 * second_eccentricity_sq
        )
        * a_term**5
        / 120.0
    )
    northing_m = FALSE_NORTHING_M + SCALE_FACTOR * (
        meridional_arc(latitude)
        - meridional_arc(origin)
        + radius
        * tangent
        * (
            a_term**2 / 2.0
            + (5.0 - tangent_sq + 9.0 * eta_sq + 4.0 * eta_sq**2)
            * a_term**4
            / 24.0
            + (
                61.0
                - 58.0 * tangent_sq
                + tangent_sq**2
                + 600.0 * eta_sq
                - 330.0 * second_eccentricity_sq
            )
            * a_term**6
            / 720.0
        )
    )
    return easting_m / US_SURVEY_FOOT_M, northing_m / US_SURVEY_FOOT_M


def unproject_to_wgs84(easting_ft: float, northing_ft: float) -> tuple[float, float]:
    """Invert EPSG:6541, returning (longitude, latitude) in decimal degrees."""

    flattening = 1.0 / INVERSE_FLATTENING
    eccentricity_sq = flattening * (2.0 - flattening)
    second_eccentricity_sq = eccentricity_sq / (1.0 - eccentricity_sq)
    easting_m = easting_ft * US_SURVEY_FOOT_M
    northing_m = northing_ft * US_SURVEY_FOOT_M
    origin = math.radians(LATITUDE_OF_ORIGIN_DEG)

    m_value = meridional_arc(origin) + (northing_m - FALSE_NORTHING_M) / SCALE_FACTOR
    e4 = eccentricity_sq**2
    e6 = eccentricity_sq**3
    mu = m_value / (
        SEMI_MAJOR_M
        * (1.0 - eccentricity_sq / 4.0 - 3.0 * e4 / 64.0 - 5.0 * e6 / 256.0)
    )
    e1 = (1.0 - math.sqrt(1.0 - eccentricity_sq)) / (
        1.0 + math.sqrt(1.0 - eccentricity_sq)
    )
    footprint_latitude = (
        mu
        + (3.0 * e1 / 2.0 - 27.0 * e1**3 / 32.0) * math.sin(2.0 * mu)
        + (21.0 * e1**2 / 16.0 - 55.0 * e1**4 / 32.0) * math.sin(4.0 * mu)
        + 151.0 * e1**3 / 96.0 * math.sin(6.0 * mu)
        + 1097.0 * e1**4 / 512.0 * math.sin(8.0 * mu)
    )

    sin_footprint = math.sin(footprint_latitude)
    cos_footprint = math.cos(footprint_latitude)
    tangent_footprint = math.tan(footprint_latitude)
    c1 = second_eccentricity_sq * cos_footprint**2
    t1 = tangent_footprint**2
    n1 = SEMI_MAJOR_M / math.sqrt(1.0 - eccentricity_sq * sin_footprint**2)
    r1 = (
        SEMI_MAJOR_M
        * (1.0 - eccentricity_sq)
        / (1.0 - eccentricity_sq * sin_footprint**2) ** 1.5
    )
    d_term = (easting_m - FALSE_EASTING_M) / (n1 * SCALE_FACTOR)

    latitude = footprint_latitude - (n1 * tangent_footprint / r1) * (
        d_term**2 / 2.0
        - (5.0 + 3.0 * t1 + 10.0 * c1 - 4.0 * c1**2 - 9.0 * second_eccentricity_sq)
        * d_term**4
        / 24.0
        + (
            61.0
            + 90.0 * t1
            + 298.0 * c1
            + 45.0 * t1**2
            - 252.0 * second_eccentricity_sq
            - 3.0 * c1**2
        )
        * d_term**6
        / 720.0
    )
    longitude = math.radians(CENTRAL_MERIDIAN_DEG) + (
        d_term
        - (1.0 + 2.0 * t1 + c1) * d_term**3 / 6.0
        + (5.0 - 2.0 * c1 + 28.0 * t1 - 3.0 * c1**2 + 8.0 * second_eccentricity_sq + 24.0 * t1**2)
        * d_term**5
        / 120.0
    ) / cos_footprint
    return math.degrees(longitude), math.degrees(latitude)


def parse_world_file(contents: str) -> tuple[float, float, float, float, float, float]:
    values = [float(line.strip()) for line in contents.splitlines() if line.strip()]
    if len(values) != 6:
        raise ValueError(f"Expected six world-file values, received {len(values)}")
    return tuple(values)  # type: ignore[return-value]


def archive_tile(archive_path: Path) -> tuple[Image.Image, dict[str, float | int | str]]:
    expected_hash = EXPECTED_ARCHIVES[archive_path.name]
    actual_hash = sha256_file(archive_path)
    if actual_hash.lower() != expected_hash:
        raise ValueError(
            f"SHA-256 mismatch for {archive_path.name}: expected {expected_hash}, got {actual_hash}"
        )

    with zipfile.ZipFile(archive_path) as archive:
        jp2_names = [name for name in archive.namelist() if name.lower().endswith(".jp2")]
        world_names = [name for name in archive.namelist() if name.lower().endswith(".j2w")]
        if len(jp2_names) != 1 or len(world_names) != 1:
            raise ValueError(f"{archive_path.name} must contain exactly one JP2 and one J2W")
        world = parse_world_file(archive.read(world_names[0]).decode("ascii"))
        image = Image.open(io.BytesIO(archive.read(jp2_names[0])))
        image.load()

    pixel_x, rotation_y, rotation_x, pixel_y, center_x, center_y = world
    if not math.isclose(rotation_x, 0.0) or not math.isclose(rotation_y, 0.0):
        raise ValueError(f"Rotated source tiles are not supported: {archive_path.name}")
    if pixel_x <= 0.0 or pixel_y >= 0.0:
        raise ValueError(f"Unexpected pixel orientation in {archive_path.name}")
    if image.mode != "RGBA" or len(image.getbands()) != 4:
        raise ValueError(f"Expected four-band imagery in {archive_path.name}, got {image.mode}")

    # NYSDOP's fourth component is near infrared; never interpret it as alpha.
    red, green, blue, _near_infrared = image.split()
    natural_color = Image.merge("RGB", (red, green, blue))
    left = center_x - pixel_x / 2.0
    top = center_y - pixel_y / 2.0
    right = left + image.width * pixel_x
    bottom = top + image.height * pixel_y
    return natural_color, {
        "archive": archive_path.name,
        "sha256": actual_hash,
        "left": left,
        "right": right,
        "top": top,
        "bottom": bottom,
        "pixelX": pixel_x,
        "pixelY": pixel_y,
        "width": image.width,
        "height": image.height,
    }


def relative_repo_path(path: Path) -> str:
    return "./" + path.resolve().relative_to(REPO_ROOT.resolve()).as_posix()


def rounded_point(longitude: float, latitude: float) -> dict[str, float]:
    return {"longitude": round(longitude, 9), "latitude": round(latitude, 9)}


def build(source_dir: Path, output: Path, metadata_path: Path, width: int, quality: int) -> dict:
    if not features.check("jpg_2000"):
        raise RuntimeError("This Pillow build does not support JPEG2000")
    if not features.check("webp"):
        raise RuntimeError("This Pillow build does not support WebP")
    if width <= 0:
        raise ValueError("Output width must be positive")
    if not 1 <= quality <= 100:
        raise ValueError("WebP quality must be between 1 and 100")

    source_names = {path.name for path in source_dir.glob("*.zip")}
    if source_names != set(EXPECTED_ARCHIVES):
        missing = sorted(set(EXPECTED_ARCHIVES) - source_names)
        unexpected = sorted(source_names - set(EXPECTED_ARCHIVES))
        raise ValueError(f"Source archive set differs; missing={missing}, unexpected={unexpected}")

    tiles = []
    for archive_name in sorted(EXPECTED_ARCHIVES):
        image, spatial = archive_tile(source_dir / archive_name)
        tiles.append((image, spatial))

    pixel_sizes = {(tile[1]["pixelX"], tile[1]["pixelY"]) for tile in tiles}
    if pixel_sizes != {(1.0, -1.0)}:
        raise ValueError(f"Expected one-foot source pixels, got {pixel_sizes}")

    west = min(float(tile[1]["left"]) for tile in tiles)
    east = max(float(tile[1]["right"]) for tile in tiles)
    north = max(float(tile[1]["top"]) for tile in tiles)
    south = min(float(tile[1]["bottom"]) for tile in tiles)
    source_width = round(east - west)
    source_height = round(north - south)
    mosaic = Image.new("RGB", (source_width, source_height))

    for image, spatial in tiles:
        x_offset = round(float(spatial["left"]) - west)
        y_offset = round(north - float(spatial["top"]))
        mosaic.paste(image, (x_offset, y_offset))

    if mosaic.size != (6000, 4000):
        raise ValueError(f"Unexpected mosaic dimensions: {mosaic.size}")
    output_height = round(source_height * width / source_width)
    browser_image = mosaic.resize((width, output_height), Image.Resampling.LANCZOS)
    output.parent.mkdir(parents=True, exist_ok=True)
    browser_image.save(output, "WEBP", quality=quality, method=6)

    corners = {
        "northwest": rounded_point(*unproject_to_wgs84(west, north)),
        "northeast": rounded_point(*unproject_to_wgs84(east, north)),
        "southeast": rounded_point(*unproject_to_wgs84(east, south)),
        "southwest": rounded_point(*unproject_to_wgs84(west, south)),
    }
    longitudes = [point["longitude"] for point in corners.values()]
    latitudes = [point["latitude"] for point in corners.values()]
    projected_per_pixel_x = (east - west) / width
    projected_per_pixel_y = (north - south) / output_height

    center_projected = project_wgs84(-78.83765, 43.04078)
    # Independently confirmed by NOAA NGS NCAT for NAD83(2011), NY W-3103.
    if abs(center_projected[0] - 1_080_305.526) > 0.02 or abs(center_projected[1] - 1_108_040.805) > 0.02:
        raise ValueError(f"EPSG:6541 projection self-check failed: {center_projected}")
    for point in corners.values():
        round_trip = project_wgs84(point["longitude"], point["latitude"])
        # Rounded geographic coordinates should still round-trip well within one source pixel.
        if not west - 1.0 <= round_trip[0] <= east + 1.0 or not south - 1.0 <= round_trip[1] <= north + 1.0:
            raise ValueError(f"Projection round-trip failed: {point} -> {round_trip}")

    output_hash = sha256_file(output)
    metadata = {
        "schemaVersion": 1,
        "assetId": "deerwood-aerial-2024",
        "courseId": "deerwood",
        "status": "authoritative-source-mosaic",
        "image": {
            "path": relative_repo_path(output),
            "format": "webp",
            "width": width,
            "height": output_height,
            "byteSize": output.stat().st_size,
            "sha256": output_hash,
            "naturalColorBands": ["red", "green", "blue"],
            "excludedBand": "near-infrared",
        },
        "source": {
            "id": "nysdop-2024-north-tonawanda",
            "publisher": "New York State ITS Geospatial Services / NYSDOP",
            "acquisitionYear": 2024,
            "groundSampleDistanceFtUs": 1,
            "sourcePixelDimensions": {"width": source_width, "height": source_height},
            "archives": [
                {
                    "file": str(spatial["archive"]),
                    "sha256": str(spatial["sha256"]),
                }
                for _image, spatial in tiles
            ],
        },
        "spatialReference": {
            "crs": "EPSG:6541",
            "name": "NAD83(2011) / New York West (ftUS)",
            "method": "Transverse Mercator",
            "units": "US survey foot",
            "usSurveyFootMeters": US_SURVEY_FOOT_M,
            "parameters": {
                "ellipsoid": "GRS 1980",
                "semiMajorAxisMeters": SEMI_MAJOR_M,
                "inverseFlattening": INVERSE_FLATTENING,
                "latitudeOfNaturalOriginDegrees": LATITUDE_OF_ORIGIN_DEG,
                "longitudeOfNaturalOriginDegrees": CENTRAL_MERIDIAN_DEG,
                "scaleFactorAtNaturalOrigin": SCALE_FACTOR,
                "falseEastingMeters": FALSE_EASTING_M,
                "falseNorthingMeters": FALSE_NORTHING_M,
            },
            "projectedBoundsFtUs": {
                "west": west,
                "south": south,
                "east": east,
                "north": north,
            },
            "outputResolutionFtUsPerPixel": {
                "x": projected_per_pixel_x,
                "y": projected_per_pixel_y,
            },
            "pixelEdgeToProjectedAffine": [
                projected_per_pixel_x,
                0.0,
                west,
                0.0,
                -projected_per_pixel_y,
                north,
            ],
            "pixelEdgeToProjectedFormula": {
                "eastingFtUs": "west + column * xResolution",
                "northingFtUs": "north - row * yResolution",
            },
        },
        "browserGeographicReference": {
            "crs": "EPSG:4326",
            "datumHandling": "NAD83(2011) geographic coordinates represented as WGS84 longitude/latitude with no datum shift",
            "corners": corners,
            "axisAlignedBounds": {
                "west": min(longitudes),
                "south": min(latitudes),
                "east": max(longitudes),
                "north": max(latitudes),
            },
            "courseReferenceBounds": COURSE_REFERENCE_BOUNDS,
        },
        "attribution": {
            "display": "Imagery © NYS ITS Geospatial Services, NYSDOP 2024",
            "sourceIndex": "https://orthos.its.ny.gov/arcgis/rest/services/vector/ortho_indexes/MapServer/6",
        },
        "pipeline": {
            "script": relative_repo_path(Path(__file__)),
            "pillowVersion": Image.__version__,
            "command": "python tools/build_deerwood_aerial.py",
            "legacyHazardDataUsed": False,
        },
    }

    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return metadata


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE_DIR)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--width", type=int, default=3000)
    parser.add_argument("--quality", type=int, default=88)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        metadata = build(
            args.source_dir.resolve(),
            args.output.resolve(),
            args.metadata.resolve(),
            args.width,
            args.quality,
        )
    except Exception as error:  # Keep command-line failures concise and actionable.
        print(f"error: {error}", file=sys.stderr)
        return 1
    image = metadata["image"]
    bounds = metadata["spatialReference"]["projectedBoundsFtUs"]
    print(
        f"wrote {image['path']} ({image['width']}x{image['height']}, "
        f"{image['byteSize']} bytes, sha256={image['sha256']})"
    )
    print(f"projected bounds EPSG:6541 (ftUS): {bounds}")
    print(f"metadata: {relative_repo_path(args.metadata.resolve())}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
