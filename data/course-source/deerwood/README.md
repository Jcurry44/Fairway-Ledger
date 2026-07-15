# Deerwood map source package

This directory records the authoritative inputs for the new Deerwood course map. The rejected hand-entered hazard arrays are not an input and must never be used to trace, validate, or recommend targets.

## Aerial imagery

- Publisher: New York State ITS Geospatial Services / NYSDOP
- Acquisition: 2024 one-foot (12-inch), four-band orthophotography
- Source CRS: EPSG:6541
- Course-area tiles: four ZIP archives under `imagery/nysdop-2024/`
- Repository policy: the ZIP files remain local and are ignored by Git; this manifest and the checksums are tracked

| File | SHA-256 |
| --- | --- |
| `w_10771106_12_22500_4bd_2024.zip` | `FEBB8722E4433C8D9DD7401CEC4C92237EFA950D1D798D36F83181A2E6AA1B9F` |
| `w_10771108_12_22500_4bd_2024.zip` | `B566F06ABB1CB2A600BE38B5BA3FD4B5E23D6FB7D869DD05DD20D8E393DB4AE0` |
| `w_10801106_12_22500_4bd_2024.zip` | `DA08A6760CEB27E194BF7A88DDCB85515FE0CB3C38A5B2A7B5A965CC60B70800` |
| `w_10801108_12_22500_4bd_2024.zip` | `AA0A6C5A91006853590E5E4B4CA3E99D96D36B7C15C6AB70A7E5674C77E56DA9` |

Exact tile URLs, the ArcGIS index query, usage notes, and required attribution are recorded in `../../course-maps/deerwood.json`.

## Browser basemap build

From the repository root, run:

```powershell
python tools/build_deerwood_aerial.py
```

The command requires Pillow with JPEG2000 and WebP support. It verifies every source archive against the checksums above, places the tiles from their world files, uses only the red/green/blue bands, and writes:

- `assets/maps/deerwood/aerial-2024.webp` — deterministic 3000 × 2000 natural-color WebP
- `data/course-maps/deerwood-aerial-2024.json` — image hash, attribution, EPSG:6541 pixel affine, projected bounds, and browser WGS84 corner coordinates

The generated image covers exactly `1,077,000–1,083,000` ft easting and `1,106,000–1,110,000` ft northing in NAD83(2011) / New York West (ftUS), at 2 ft per browser pixel. The generator reads no course features or legacy hazard data.

## Reference geometry and terrain

- Facility boundary: OpenStreetMap way 24154378, used only as a discovery/crop boundary
- WGS84 bounds: west `-78.8466930`, south `43.0362622`, east `-78.8286029`, north `43.0452657`
- Elevation: USGS 3DEP project `NY_FEMAR2_Central_2018_D19`, one-meter DEM
- Official validation: Deerwood course details, scorecards, and hole flyovers

Hole, green, fairway, bunker, water, and target geometry remains intentionally empty until traced from the approved aerials and validated. Every published feature must carry a confidence state from the course-map manifest.
