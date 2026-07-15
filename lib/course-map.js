/*
 * Fairway Ledger - pure course-map projection helpers.
 *
 * Browser usage: window.FairwayCourseMap
 * Tests / Node:  require("../lib/course-map.js")
 *
 * Deerwood's source mosaic is a north-up EPSG:6541 raster. Geographic rasters
 * are also supported when their outer edges match an EPSG:4326 WGS84 box.
 * View transforms use a top-left transform origin:
 *   containerPixel = imagePixel * scale + { x, y }
 *
 * This module deliberately contains no course features or inferred geometry.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.FairwayCourseMap = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const EARTH_RADIUS_M = 6371008.8;
  const DEFAULT_MAX_ZOOM = 8;
  const US_SURVEY_FOOT_M = 1200 / 3937;
  const EPSG_6541 = Object.freeze({
    code: "EPSG:6541",
    name: "NAD83(2011) / New York West (ftUS)",
    semiMajorAxisM: 6378137,
    inverseFlattening: 298.257222101,
    latitudeOfOriginDeg: 40,
    centralMeridianDeg: -78.5833333333333,
    scaleFactor: 0.9999375,
    falseEastingM: 350000,
    falseNorthingM: 0,
    unitMeters: US_SURVEY_FOOT_M,
  });

  function finiteNumber(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`${label} must be a finite number.`);
    }
    return value;
  }

  function normalizeBounds(bounds) {
    if (!bounds || typeof bounds !== "object") {
      throw new TypeError("bounds must be an object.");
    }
    const west = finiteNumber(bounds.west, "bounds.west");
    const south = finiteNumber(bounds.south, "bounds.south");
    const east = finiteNumber(bounds.east, "bounds.east");
    const north = finiteNumber(bounds.north, "bounds.north");
    if (west < -180 || east > 180 || west >= east) {
      throw new RangeError("bounds must have west < east within WGS84 longitude limits.");
    }
    if (south < -90 || north > 90 || south >= north) {
      throw new RangeError("bounds must have south < north within WGS84 latitude limits.");
    }
    return { west, south, east, north };
  }

  function isProjectedBounds(bounds) {
    return Boolean(bounds && typeof bounds === "object"
      && ["minX", "minY", "maxX", "maxY"].every((key) => bounds[key] !== undefined));
  }

  function normalizeProjectedBounds(bounds) {
    if (!bounds || typeof bounds !== "object") {
      throw new TypeError("projectedBounds must be an object.");
    }
    const minX = finiteNumber(bounds.minX, "projectedBounds.minX");
    const minY = finiteNumber(bounds.minY, "projectedBounds.minY");
    const maxX = finiteNumber(bounds.maxX, "projectedBounds.maxX");
    const maxY = finiteNumber(bounds.maxY, "projectedBounds.maxY");
    if (minX >= maxX || minY >= maxY) {
      throw new RangeError("projectedBounds must have minX < maxX and minY < maxY.");
    }
    return { minX, minY, maxX, maxY };
  }

  function normalizeSize(size, label) {
    if (!size || typeof size !== "object") {
      throw new TypeError(`${label} must be an object.`);
    }
    const width = finiteNumber(size.width, `${label}.width`);
    const height = finiteNumber(size.height, `${label}.height`);
    if (width <= 0 || height <= 0) {
      throw new RangeError(`${label} width and height must be greater than zero.`);
    }
    return { width, height };
  }

  function normalizePixel(point, label) {
    if (!point || typeof point !== "object") {
      throw new TypeError(`${label} must be an object.`);
    }
    return {
      x: finiteNumber(point.x, `${label}.x`),
      y: finiteNumber(point.y, `${label}.y`),
    };
  }

  function readLonLat(position) {
    if (!position || typeof position !== "object") return null;
    const lng = typeof position.lng === "number" ? position.lng
      : (typeof position.lon === "number" ? position.lon : position.longitude);
    const lat = typeof position.lat === "number" ? position.lat : position.latitude;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
    return { lng, lat };
  }

  function requireLonLat(position) {
    const point = readLonLat(position);
    if (!point) throw new TypeError("position must contain valid WGS84 longitude and latitude.");
    return point;
  }

  function normalizeView(view) {
    if (!view || typeof view !== "object") {
      throw new TypeError("view must be an object.");
    }
    const scale = finiteNumber(view.scale, "view.scale");
    if (scale <= 0) throw new RangeError("view.scale must be greater than zero.");
    return {
      scale,
      x: finiteNumber(view.x, "view.x"),
      y: finiteNumber(view.y, "view.y"),
    };
  }

  function normalizePadding(value) {
    if (value === undefined || value === null) {
      return { top: 0, right: 0, bottom: 0, left: 0 };
    }
    if (typeof value === "number") {
      finiteNumber(value, "padding");
      if (value < 0) throw new RangeError("padding cannot be negative.");
      return { top: value, right: value, bottom: value, left: value };
    }
    if (typeof value !== "object") throw new TypeError("padding must be a number or object.");
    const padding = {
      top: finiteNumber(value.top === undefined ? 0 : value.top, "padding.top"),
      right: finiteNumber(value.right === undefined ? 0 : value.right, "padding.right"),
      bottom: finiteNumber(value.bottom === undefined ? 0 : value.bottom, "padding.bottom"),
      left: finiteNumber(value.left === undefined ? 0 : value.left, "padding.left"),
    };
    if (Object.values(padding).some((side) => side < 0)) {
      throw new RangeError("padding cannot be negative.");
    }
    return padding;
  }

  function normalizeOptions(options) {
    return options && typeof options === "object" ? options : {};
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function degreesToRadians(value) {
    return value * Math.PI / 180;
  }

  function radiansToDegrees(value) {
    return value * 180 / Math.PI;
  }

  function meridionalArc(latitudeRadians, ellipsoid) {
    const e2 = ellipsoid.e2;
    const e4 = e2 * e2;
    const e6 = e4 * e2;
    return ellipsoid.a * (
      (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * latitudeRadians
      - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * latitudeRadians)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * latitudeRadians)
      - (35 * e6 / 3072) * Math.sin(6 * latitudeRadians)
    );
  }

  function epsg6541Ellipsoid() {
    const flattening = 1 / EPSG_6541.inverseFlattening;
    const e2 = flattening * (2 - flattening);
    return {
      a: EPSG_6541.semiMajorAxisM,
      e2,
      ep2: e2 / (1 - e2),
    };
  }

  /**
   * WGS84 lon/lat to EPSG:6541 State Plane feet. EPSG:6541 is NAD83(2011),
   * whose sub-meter datum offset is below phone GPS accuracy; no grid shift is
   * applied. The official GRS80 Transverse Mercator parameters are used.
   */
  function wgs84ToEpsg6541(positionInput) {
    const position = requireLonLat(positionInput);
    const ellipsoid = epsg6541Ellipsoid();
    const latitude = degreesToRadians(position.lat);
    const longitude = degreesToRadians(position.lng);
    const latitude0 = degreesToRadians(EPSG_6541.latitudeOfOriginDeg);
    const longitude0 = degreesToRadians(EPSG_6541.centralMeridianDeg);
    const sinLatitude = Math.sin(latitude);
    const cosLatitude = Math.cos(latitude);
    const tanLatitude = Math.tan(latitude);
    const n = ellipsoid.a / Math.sqrt(1 - ellipsoid.e2 * sinLatitude * sinLatitude);
    const t = tanLatitude * tanLatitude;
    const c = ellipsoid.ep2 * cosLatitude * cosLatitude;
    const a = cosLatitude * (longitude - longitude0);
    const m = meridionalArc(latitude, ellipsoid);
    const m0 = meridionalArc(latitude0, ellipsoid);
    const a2 = a * a;
    const a3 = a2 * a;
    const a4 = a2 * a2;
    const a5 = a4 * a;
    const a6 = a3 * a3;
    const eastingM = EPSG_6541.falseEastingM + EPSG_6541.scaleFactor * n * (
      a
      + (1 - t + c) * a3 / 6
      + (5 - 18 * t + t * t + 72 * c - 58 * ellipsoid.ep2) * a5 / 120
    );
    const northingM = EPSG_6541.falseNorthingM + EPSG_6541.scaleFactor * (
      m - m0
      + n * tanLatitude * (
        a2 / 2
        + (5 - t + 9 * c + 4 * c * c) * a4 / 24
        + (61 - 58 * t + t * t + 600 * c - 330 * ellipsoid.ep2) * a6 / 720
      )
    );
    return {
      x: eastingM / US_SURVEY_FOOT_M,
      y: northingM / US_SURVEY_FOOT_M,
    };
  }

  /** Inverse EPSG:6541 State Plane feet to WGS84-compatible lon/lat. */
  function epsg6541ToWgs84(pointInput) {
    const point = normalizePixel(pointInput, "projectedPoint");
    const ellipsoid = epsg6541Ellipsoid();
    const latitude0 = degreesToRadians(EPSG_6541.latitudeOfOriginDeg);
    const longitude0 = degreesToRadians(EPSG_6541.centralMeridianDeg);
    const eastingM = point.x * US_SURVEY_FOOT_M;
    const northingM = point.y * US_SURVEY_FOOT_M;
    const m0 = meridionalArc(latitude0, ellipsoid);
    const m = m0 + (northingM - EPSG_6541.falseNorthingM) / EPSG_6541.scaleFactor;
    const e4 = ellipsoid.e2 * ellipsoid.e2;
    const e6 = e4 * ellipsoid.e2;
    const mu = m / (ellipsoid.a * (1 - ellipsoid.e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
    const root = Math.sqrt(1 - ellipsoid.e2);
    const e1 = (1 - root) / (1 + root);
    const e12 = e1 * e1;
    const e13 = e12 * e1;
    const e14 = e12 * e12;
    const footprint = mu
      + (3 * e1 / 2 - 27 * e13 / 32) * Math.sin(2 * mu)
      + (21 * e12 / 16 - 55 * e14 / 32) * Math.sin(4 * mu)
      + (151 * e13 / 96) * Math.sin(6 * mu)
      + (1097 * e14 / 512) * Math.sin(8 * mu);
    const sinFootprint = Math.sin(footprint);
    const cosFootprint = Math.cos(footprint);
    const tanFootprint = Math.tan(footprint);
    const n1 = ellipsoid.a / Math.sqrt(1 - ellipsoid.e2 * sinFootprint * sinFootprint);
    const r1 = ellipsoid.a * (1 - ellipsoid.e2)
      / Math.pow(1 - ellipsoid.e2 * sinFootprint * sinFootprint, 1.5);
    const t1 = tanFootprint * tanFootprint;
    const c1 = ellipsoid.ep2 * cosFootprint * cosFootprint;
    const d = (eastingM - EPSG_6541.falseEastingM) / (n1 * EPSG_6541.scaleFactor);
    const d2 = d * d;
    const d3 = d2 * d;
    const d4 = d2 * d2;
    const d5 = d4 * d;
    const d6 = d3 * d3;
    const latitude = footprint - (n1 * tanFootprint / r1) * (
      d2 / 2
      - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ellipsoid.ep2) * d4 / 24
      + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ellipsoid.ep2 - 3 * c1 * c1) * d6 / 720
    );
    const longitude = longitude0 + (
      d
      - (1 + 2 * t1 + c1) * d3 / 6
      + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ellipsoid.ep2 + 24 * t1 * t1) * d5 / 120
    ) / cosFootprint;
    return { lng: radiansToDegrees(longitude), lat: radiansToDegrees(latitude) };
  }

  function projectedToImagePixel(pointInput, boundsInput, imageSizeInput) {
    const point = normalizePixel(pointInput, "projectedPoint");
    const bounds = normalizeProjectedBounds(boundsInput);
    const image = normalizeSize(imageSizeInput, "imageSize");
    return {
      x: ((point.x - bounds.minX) / (bounds.maxX - bounds.minX)) * image.width,
      y: ((bounds.maxY - point.y) / (bounds.maxY - bounds.minY)) * image.height,
    };
  }

  function imagePixelToProjected(pixelInput, boundsInput, imageSizeInput) {
    const pixel = normalizePixel(pixelInput, "pixel");
    const bounds = normalizeProjectedBounds(boundsInput);
    const image = normalizeSize(imageSizeInput, "imageSize");
    return {
      x: bounds.minX + (pixel.x / image.width) * (bounds.maxX - bounds.minX),
      y: bounds.maxY - (pixel.y / image.height) * (bounds.maxY - bounds.minY),
    };
  }

  /** Convert a WGS84 position to a pixel on the source raster. */
  function lonLatToImagePixel(position, boundsInput, imageSizeInput) {
    if (isProjectedBounds(boundsInput)) {
      return projectedToImagePixel(wgs84ToEpsg6541(position), boundsInput, imageSizeInput);
    }
    const point = requireLonLat(position);
    const bounds = normalizeBounds(boundsInput);
    const image = normalizeSize(imageSizeInput, "imageSize");
    return {
      x: ((point.lng - bounds.west) / (bounds.east - bounds.west)) * image.width,
      y: ((bounds.north - point.lat) / (bounds.north - bounds.south)) * image.height,
    };
  }

  /** Convert a source-raster pixel to WGS84. Pixels outside the image remain projectable. */
  function imagePixelToLonLat(pixelInput, boundsInput, imageSizeInput) {
    if (isProjectedBounds(boundsInput)) {
      return epsg6541ToWgs84(imagePixelToProjected(pixelInput, boundsInput, imageSizeInput));
    }
    const pixel = normalizePixel(pixelInput, "pixel");
    const bounds = normalizeBounds(boundsInput);
    const image = normalizeSize(imageSizeInput, "imageSize");
    return {
      lng: bounds.west + (pixel.x / image.width) * (bounds.east - bounds.west),
      lat: bounds.north - (pixel.y / image.height) * (bounds.north - bounds.south),
    };
  }

  function imageToContainerPixel(pixelInput, viewInput) {
    const pixel = normalizePixel(pixelInput, "pixel");
    const view = normalizeView(viewInput);
    return {
      x: view.x + pixel.x * view.scale,
      y: view.y + pixel.y * view.scale,
    };
  }

  function containerToImagePixel(pixelInput, viewInput) {
    const pixel = normalizePixel(pixelInput, "pixel");
    const view = normalizeView(viewInput);
    return {
      x: (pixel.x - view.x) / view.scale,
      y: (pixel.y - view.y) / view.scale,
    };
  }

  function lonLatToContainerPixel(position, bounds, imageSize, view) {
    return imageToContainerPixel(lonLatToImagePixel(position, bounds, imageSize), view);
  }

  function containerPixelToLonLat(pixel, bounds, imageSize, view) {
    return imagePixelToLonLat(containerToImagePixel(pixel, view), bounds, imageSize);
  }

  function viewScaleLimits(imageSizeInput, containerSizeInput, optionsInput) {
    const image = normalizeSize(imageSizeInput, "imageSize");
    const container = normalizeSize(containerSizeInput, "containerSize");
    const options = normalizeOptions(optionsInput);
    const padding = normalizePadding(options.padding);
    const innerWidth = container.width - padding.left - padding.right;
    const innerHeight = container.height - padding.top - padding.bottom;
    if (innerWidth <= 0 || innerHeight <= 0) {
      throw new RangeError("padding must leave a positive container area.");
    }

    const minScale = Math.min(innerWidth / image.width, innerHeight / image.height);
    const maxZoom = options.maxZoom === undefined
      ? DEFAULT_MAX_ZOOM
      : finiteNumber(options.maxZoom, "maxZoom");
    if (maxZoom < 1) throw new RangeError("maxZoom must be at least 1.");
    const requestedMaxScale = options.maxScale === undefined
      ? minScale * maxZoom
      : finiteNumber(options.maxScale, "maxScale");
    const maxScale = Math.max(minScale, requestedMaxScale);

    return {
      minScale,
      maxScale,
      maxZoom: maxScale / minScale,
      padding,
      innerWidth,
      innerHeight,
    };
  }

  function constrainAxis(offset, scaledSize, innerSize, paddingStart) {
    if (scaledSize <= innerSize) {
      return paddingStart + (innerSize - scaledSize) / 2;
    }
    return clamp(offset, paddingStart + innerSize - scaledSize, paddingStart);
  }

  /** Clamp zoom and pan so the raster stays centered or covers the padded viewport. */
  function constrainView(viewInput, imageSizeInput, containerSizeInput, optionsInput) {
    const image = normalizeSize(imageSizeInput, "imageSize");
    const view = normalizeView(viewInput);
    const limits = viewScaleLimits(image, containerSizeInput, optionsInput);
    const scale = clamp(view.scale, limits.minScale, limits.maxScale);
    const scaledWidth = image.width * scale;
    const scaledHeight = image.height * scale;
    const x = constrainAxis(view.x, scaledWidth, limits.innerWidth, limits.padding.left);
    const y = constrainAxis(view.y, scaledHeight, limits.innerHeight, limits.padding.top);
    return {
      scale,
      x,
      y,
      zoom: scale / limits.minScale,
      minScale: limits.minScale,
      maxScale: limits.maxScale,
    };
  }

  function fitView(imageSize, containerSize, options) {
    const limits = viewScaleLimits(imageSize, containerSize, options);
    return constrainView(
      { scale: limits.minScale, x: limits.padding.left, y: limits.padding.top },
      imageSize,
      containerSize,
      options,
    );
  }

  /** Zoom by a multiplicative factor while preserving the image point below focalPoint. */
  function zoomViewAt(viewInput, factorInput, focalPointInput, imageSize, containerSize, options) {
    const view = normalizeView(viewInput);
    const factor = finiteNumber(factorInput, "factor");
    if (factor <= 0) throw new RangeError("factor must be greater than zero.");
    const focal = normalizePixel(focalPointInput, "focalPoint");
    const imagePoint = containerToImagePixel(focal, view);
    const limits = viewScaleLimits(imageSize, containerSize, options);
    const nextScale = clamp(view.scale * factor, limits.minScale, limits.maxScale);
    return constrainView({
      scale: nextScale,
      x: focal.x - imagePoint.x * nextScale,
      y: focal.y - imagePoint.y * nextScale,
    }, imageSize, containerSize, options);
  }

  function panView(viewInput, deltaInput, imageSize, containerSize, options) {
    const view = normalizeView(viewInput);
    const delta = normalizePixel(deltaInput, "delta");
    return constrainView({
      scale: view.scale,
      x: view.x + delta.x,
      y: view.y + delta.y,
    }, imageSize, containerSize, options);
  }

  /**
   * Project a stored shot into the container. An unfinished shot returns its
   * start point with finish/vector/lengthPx set to null.
   */
  function projectShotSegment(shot, bounds, imageSize, view) {
    if (!shot || typeof shot !== "object") return null;
    const startPosition = readLonLat(shot.start);
    if (!startPosition) return null;
    const finishPosition = readLonLat(shot.finish);
    const start = lonLatToContainerPixel(startPosition, bounds, imageSize, view);
    if (!finishPosition) {
      return { start, finish: null, vector: null, lengthPx: null };
    }
    const finish = lonLatToContainerPixel(finishPosition, bounds, imageSize, view);
    const vector = { dx: finish.x - start.x, dy: finish.y - start.y };
    return {
      start,
      finish,
      vector,
      lengthPx: Math.hypot(vector.dx, vector.dy),
    };
  }

  function localOffsetPoint(position, eastM, northM) {
    const ellipsoid = epsg6541Ellipsoid();
    const latitude = degreesToRadians(position.lat);
    const sinLatitude = Math.sin(latitude);
    const denominator = Math.sqrt(1 - ellipsoid.e2 * sinLatitude * sinLatitude);
    const primeVerticalRadius = ellipsoid.a / denominator;
    const meridionalRadius = ellipsoid.a * (1 - ellipsoid.e2) / Math.pow(denominator, 3);
    const latitudeOffset = northM / meridionalRadius;
    const longitudeOffset = eastM / (primeVerticalRadius * Math.max(Math.abs(Math.cos(latitude)), 1e-12));
    const longitudeDegrees = ((position.lng + radiansToDegrees(longitudeOffset) + 540) % 360) - 180;
    return { lng: longitudeDegrees, lat: position.lat + radiansToDegrees(latitudeOffset) };
  }

  /**
   * Convert device horizontal accuracy (a meter radius) to screen pixels.
   * radiusX/radiusY preserve georeference anisotropy; radiusPx uses the larger
   * value so a circular overlay never understates the reported uncertainty.
   */
  function gpsAccuracyCircle(positionInput, boundsInput, imageSizeInput, viewInput, optionsInput) {
    const position = readLonLat(positionInput);
    if (!position) return null;
    const rawAccuracy = typeof positionInput.accuracyM === "number"
      ? positionInput.accuracyM
      : positionInput.accuracy;
    if (!Number.isFinite(rawAccuracy) || rawAccuracy < 0) return null;

    const view = normalizeView(viewInput);
    const options = normalizeOptions(optionsInput);
    const minRadiusPx = options.minRadiusPx === undefined
      ? 0
      : finiteNumber(options.minRadiusPx, "minRadiusPx");
    const maxRadiusPx = options.maxRadiusPx === undefined
      ? Infinity
      : finiteNumber(options.maxRadiusPx, "maxRadiusPx");
    if (minRadiusPx < 0 || maxRadiusPx < minRadiusPx) {
      throw new RangeError("accuracy radius limits must satisfy 0 <= minRadiusPx <= maxRadiusPx.");
    }

    const center = lonLatToContainerPixel(position, boundsInput, imageSizeInput, view);
    const east = lonLatToContainerPixel(
      localOffsetPoint(position, rawAccuracy, 0),
      boundsInput,
      imageSizeInput,
      view,
    );
    const north = lonLatToContainerPixel(
      localOffsetPoint(position, 0, rawAccuracy),
      boundsInput,
      imageSizeInput,
      view,
    );
    const radiusX = Math.hypot(east.x - center.x, east.y - center.y);
    const radiusY = Math.hypot(north.x - center.x, north.y - center.y);
    const rawRadiusPx = Math.max(radiusX, radiusY);
    const radiusPx = clamp(rawRadiusPx, minRadiusPx, maxRadiusPx);
    return {
      accuracyM: rawAccuracy,
      radiusX,
      radiusY,
      rawRadiusPx,
      radiusPx,
      diameterPx: radiusPx * 2,
    };
  }

  return {
    EARTH_RADIUS_M,
    DEFAULT_MAX_ZOOM,
    US_SURVEY_FOOT_M,
    EPSG_6541,
    wgs84ToEpsg6541,
    epsg6541ToWgs84,
    projectedToImagePixel,
    imagePixelToProjected,
    lonLatToImagePixel,
    imagePixelToLonLat,
    imageToContainerPixel,
    containerToImagePixel,
    lonLatToContainerPixel,
    containerPixelToLonLat,
    viewScaleLimits,
    constrainView,
    fitView,
    zoomViewAt,
    panView,
    projectShotSegment,
    gpsAccuracyCircle,
  };
});
