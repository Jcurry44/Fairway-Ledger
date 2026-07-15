/* Unit tests for lib/course-map.js. Run: node --test tests/course-map.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const CourseMap = require("../lib/course-map.js");

const BOUNDS = { west: -80, south: 40, east: -70, north: 50 };
const IMAGE = { width: 1000, height: 500 };
const DEERWOOD_PROJECTED_BOUNDS = {
  minX: 1077000,
  minY: 1106000,
  maxX: 1083000,
  maxY: 1110000,
};

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

test("WGS84 and image-pixel projections preserve orientation and round trip", () => {
  assert.deepEqual(
    CourseMap.lonLatToImagePixel({ lng: -80, lat: 50 }, BOUNDS, IMAGE),
    { x: 0, y: 0 },
  );
  assert.deepEqual(
    CourseMap.lonLatToImagePixel({ longitude: -70, latitude: 40 }, BOUNDS, IMAGE),
    { x: 1000, y: 500 },
  );

  const imagePoint = CourseMap.lonLatToImagePixel({ lng: -77.123, lat: 43.456 }, BOUNDS, IMAGE);
  const roundTrip = CourseMap.imagePixelToLonLat(imagePoint, BOUNDS, IMAGE);
  closeTo(roundTrip.lng, -77.123);
  closeTo(roundTrip.lat, 43.456);

  // Deliberately do not clamp: off-course fixes can be identified by callers.
  assert.equal(CourseMap.lonLatToImagePixel({ lng: -81, lat: 45 }, BOUNDS, IMAGE).x, -100);
});

test("EPSG:6541 uses the official GRS80 Transverse Mercator origin and US survey feet", () => {
  const origin = CourseMap.wgs84ToEpsg6541({
    lng: CourseMap.EPSG_6541.centralMeridianDeg,
    lat: CourseMap.EPSG_6541.latitudeOfOriginDeg,
  });
  closeTo(origin.x, 350000 / CourseMap.US_SURVEY_FOOT_M, 1e-7);
  closeTo(origin.y, 0, 1e-7);

  const originRoundTrip = CourseMap.epsg6541ToWgs84(origin);
  closeTo(originRoundTrip.lng, CourseMap.EPSG_6541.centralMeridianDeg, 1e-9);
  closeTo(originRoundTrip.lat, CourseMap.EPSG_6541.latitudeOfOriginDeg, 1e-9);
});

test("Deerwood WGS84 fixes project into the EPSG:6541 raster and round trip", () => {
  const deerwoodCenter = { lng: -78.83765, lat: 43.04078 };
  const statePlane = CourseMap.wgs84ToEpsg6541(deerwoodCenter);
  // NOAA NCAT NAD83(2011) / New York West reference, rounded to .001 ftUS.
  closeTo(statePlane.x, 1080305.526, 0.001);
  closeTo(statePlane.y, 1108040.805, 0.001);
  assert.ok(statePlane.x > DEERWOOD_PROJECTED_BOUNDS.minX);
  assert.ok(statePlane.x < DEERWOOD_PROJECTED_BOUNDS.maxX);
  assert.ok(statePlane.y > DEERWOOD_PROJECTED_BOUNDS.minY);
  assert.ok(statePlane.y < DEERWOOD_PROJECTED_BOUNDS.maxY);

  const imagePoint = CourseMap.lonLatToImagePixel(
    deerwoodCenter,
    DEERWOOD_PROJECTED_BOUNDS,
    { width: 6000, height: 4000 },
  );
  closeTo(imagePoint.x, statePlane.x - DEERWOOD_PROJECTED_BOUNDS.minX, 1e-6);
  closeTo(imagePoint.y, DEERWOOD_PROJECTED_BOUNDS.maxY - statePlane.y, 1e-6);

  const projectedRoundTrip = CourseMap.imagePixelToLonLat(
    imagePoint,
    DEERWOOD_PROJECTED_BOUNDS,
    { width: 6000, height: 4000 },
  );
  closeTo(projectedRoundTrip.lng, deerwoodCenter.lng, 1e-9);
  closeTo(projectedRoundTrip.lat, deerwoodCenter.lat, 1e-9);
});

test("projected bounds map north-up State Plane edges to raster edges", () => {
  assert.deepEqual(CourseMap.projectedToImagePixel(
    { x: 1077000, y: 1110000 },
    DEERWOOD_PROJECTED_BOUNDS,
    { width: 6000, height: 4000 },
  ), { x: 0, y: 0 });
  assert.deepEqual(CourseMap.projectedToImagePixel(
    { x: 1083000, y: 1106000 },
    DEERWOOD_PROJECTED_BOUNDS,
    { width: 6000, height: 4000 },
  ), { x: 6000, y: 4000 });
  assert.deepEqual(CourseMap.imagePixelToProjected(
    { x: 3000, y: 2000 },
    DEERWOOD_PROJECTED_BOUNDS,
    { width: 6000, height: 4000 },
  ), { x: 1080000, y: 1108000 });
});

test("image and container conversions share the top-left view transform", () => {
  const view = { scale: 0.5, x: 10, y: 20 };
  const containerPoint = CourseMap.imageToContainerPixel({ x: 500, y: 250 }, view);
  assert.deepEqual(containerPoint, { x: 260, y: 145 });
  assert.deepEqual(CourseMap.containerToImagePixel(containerPoint, view), { x: 500, y: 250 });

  const direct = CourseMap.lonLatToContainerPixel(
    { lng: -75, lat: 45 },
    BOUNDS,
    IMAGE,
    view,
  );
  assert.deepEqual(direct, containerPoint);
  assert.deepEqual(
    CourseMap.containerPixelToLonLat(direct, BOUNDS, IMAGE, view),
    { lng: -75, lat: 45 },
  );
});

test("fitView contains and centers the raster with optional padding", () => {
  assert.deepEqual(CourseMap.fitView(IMAGE, { width: 400, height: 400 }), {
    scale: 0.4,
    x: 0,
    y: 100,
    zoom: 1,
    minScale: 0.4,
    maxScale: 3.2,
  });

  const padded = CourseMap.fitView(IMAGE, { width: 400, height: 400 }, {
    padding: 20,
    maxZoom: 4,
  });
  closeTo(padded.scale, 0.36);
  closeTo(padded.x, 20);
  closeTo(padded.y, 110);
  closeTo(padded.maxScale, 1.44);
});

test("fitImageBoundsView centers and contains an image region", () => {
  const bounds = { minX: 250, minY: 100, maxX: 750, maxY: 400 };
  const view = CourseMap.fitImageBoundsView(bounds, IMAGE, { width: 400, height: 400 });

  assert.deepEqual(view, {
    scale: 0.8,
    x: -200,
    y: 0,
    zoom: 2,
    minScale: 0.4,
    maxScale: 3.2,
  });
  assert.deepEqual(
    CourseMap.imageToContainerPixel({ x: bounds.minX, y: bounds.minY }, view),
    { x: 0, y: 80 },
  );
  assert.deepEqual(
    CourseMap.imageToContainerPixel({ x: bounds.maxX, y: bounds.maxY }, view),
    { x: 400, y: 320 },
  );
});

test("fitImageBoundsView honors asymmetric padding and the zoom ceiling", () => {
  const padded = CourseMap.fitImageBoundsView(
    { minX: 200, minY: 100, maxX: 600, maxY: 300 },
    IMAGE,
    { width: 500, height: 400 },
    { padding: { top: 20, right: 10, bottom: 40, left: 50 } },
  );
  closeTo(padded.scale, 1.1);
  closeTo(padded.x, -170);
  closeTo(padded.y, -30);

  const zoomLimited = CourseMap.fitImageBoundsView(
    { minX: 450, minY: 225, maxX: 550, maxY: 275 },
    IMAGE,
    { width: 400, height: 400 },
    { maxZoom: 2 },
  );
  assert.deepEqual(zoomLimited, {
    scale: 0.8,
    x: -200,
    y: 0,
    zoom: 2,
    minScale: 0.4,
    maxScale: 0.8,
  });
});

test("fitImageBoundsView frames the confirmed Buck 1 corridor without exposing the aerial edge", () => {
  const buckOne = { minX: 1633, minY: 1191, maxX: 2627, maxY: 1704 };
  const image = { width: 3000, height: 2000 };
  const container = { width: 400, height: 600 };
  const view = CourseMap.fitImageBoundsView(buckOne, image, container, { padding: 20 });
  const topLeft = CourseMap.imageToContainerPixel(
    { x: buckOne.minX, y: buckOne.minY },
    view,
  );
  const bottomRight = CourseMap.imageToContainerPixel(
    { x: buckOne.maxX, y: buckOne.maxY },
    view,
  );

  closeTo(view.scale, 360 / 994);
  closeTo(topLeft.x, 20);
  closeTo(bottomRight.x, 380);
  assert.ok(topLeft.y >= 20);
  assert.ok(bottomRight.y <= 580);
  closeTo(view.y + image.height * view.scale, 580);
});

test("constrainView clamps scale and pan without exposing an edge", () => {
  const container = { width: 400, height: 400 };
  const tooFar = CourseMap.constrainView(
    { scale: 0.8, x: 500, y: -500 },
    IMAGE,
    container,
  );
  assert.deepEqual(tooFar, {
    scale: 0.8,
    x: 0,
    y: 0,
    zoom: 2,
    minScale: 0.4,
    maxScale: 3.2,
  });

  const oppositeEdge = CourseMap.constrainView(
    { scale: 0.8, x: -900, y: 100 },
    IMAGE,
    container,
  );
  assert.equal(oppositeEdge.x, -400);
  assert.equal(oppositeEdge.y, 0);

  // At this scale the image is narrower vertically, so that axis stays centered.
  const centeredAxis = CourseMap.constrainView(
    { scale: 0.6, x: -50, y: -100 },
    IMAGE,
    container,
  );
  assert.equal(centeredAxis.x, -50);
  assert.equal(centeredAxis.y, 50);
});

test("zoomViewAt anchors the focal map point and panView respects bounds", () => {
  const container = { width: 400, height: 400 };
  const fitted = CourseMap.fitView(IMAGE, container);
  const zoomed = CourseMap.zoomViewAt(fitted, 2, { x: 200, y: 200 }, IMAGE, container);
  assert.deepEqual(zoomed, {
    scale: 0.8,
    x: -200,
    y: 0,
    zoom: 2,
    minScale: 0.4,
    maxScale: 3.2,
  });
  assert.deepEqual(
    CourseMap.containerToImagePixel({ x: 200, y: 200 }, zoomed),
    CourseMap.containerToImagePixel({ x: 200, y: 200 }, fitted),
  );

  assert.equal(CourseMap.panView(zoomed, { x: 999, y: 0 }, IMAGE, container).x, 0);
  assert.equal(CourseMap.panView(zoomed, { x: -999, y: 0 }, IMAGE, container).x, -400);

  const maxed = CourseMap.zoomViewAt(fitted, 100, { x: 200, y: 200 }, IMAGE, container);
  assert.deepEqual(maxed, {
    scale: 3.2,
    x: -1400,
    y: -600,
    zoom: 8,
    minScale: 0.4,
    maxScale: 3.2,
  });
  assert.deepEqual(
    CourseMap.containerToImagePixel({ x: 200, y: 200 }, maxed),
    CourseMap.containerToImagePixel({ x: 200, y: 200 }, fitted),
  );
});

test("projectShotSegment aligns finished and in-progress shots with the view", () => {
  const view = { scale: 0.5, x: 10, y: 20 };
  const projected = CourseMap.projectShotSegment({
    start: { lng: -79, lat: 49 },
    finish: { lng: -71, lat: 41 },
  }, BOUNDS, IMAGE, view);

  assert.deepEqual(projected.start, { x: 60, y: 45 });
  assert.deepEqual(projected.finish, { x: 460, y: 245 });
  assert.deepEqual(projected.vector, { dx: 400, dy: 200 });
  closeTo(projected.lengthPx, Math.hypot(400, 200));

  assert.deepEqual(CourseMap.projectShotSegment({
    start: { lat: 45, lng: -75 },
    finish: null,
  }, BOUNDS, IMAGE, view), {
    start: { x: 260, y: 145 },
    finish: null,
    vector: null,
    lengthPx: null,
  });
  assert.equal(CourseMap.projectShotSegment({ start: null }, BOUNDS, IMAGE, view), null);
});

test("gpsAccuracyCircle converts meter radius at the current zoom and reports axes", () => {
  const flattening = 1 / CourseMap.EPSG_6541.inverseFlattening;
  const eccentricitySquared = flattening * (2 - flattening);
  const longitudeMetersPerDegree = CourseMap.EPSG_6541.semiMajorAxisM * Math.PI / 180;
  const latitudeMetersPerDegree = CourseMap.EPSG_6541.semiMajorAxisM
    * (1 - eccentricitySquared) * Math.PI / 180;
  const squareAtEquator = { west: 0, south: -0.5, east: 1, north: 0.5 };
  const meterScaledImage = {
    width: longitudeMetersPerDegree,
    height: latitudeMetersPerDegree,
  };
  const circle = CourseMap.gpsAccuracyCircle(
    { lng: 0.5, lat: 0, accuracyM: 10 },
    squareAtEquator,
    meterScaledImage,
    { scale: 2, x: 0, y: 0 },
  );
  closeTo(circle.radiusX, 20, 1e-7);
  closeTo(circle.radiusY, 20, 1e-7);
  closeTo(circle.radiusPx, 20, 1e-7);
  closeTo(circle.diameterPx, 40, 1e-7);

  const clamped = CourseMap.gpsAccuracyCircle(
    { lng: 0.5, lat: 0, accuracyM: 10 },
    squareAtEquator,
    meterScaledImage,
    { scale: 2, x: 0, y: 0 },
    { minRadiusPx: 24, maxRadiusPx: 30 },
  );
  closeTo(clamped.rawRadiusPx, 20, 1e-7);
  assert.equal(clamped.radiusPx, 24);
  assert.equal(clamped.diameterPx, 48);

  assert.equal(CourseMap.gpsAccuracyCircle(
    { lng: 0.5, lat: 0, accuracyM: null },
    squareAtEquator,
    meterScaledImage,
    { scale: 1, x: 0, y: 0 },
  ), null);
});

test("gpsAccuracyCircle follows the EPSG:6541 mosaic scale", () => {
  const circle = CourseMap.gpsAccuracyCircle(
    { lng: -78.83765, lat: 43.04078, accuracyM: 10 },
    DEERWOOD_PROJECTED_BOUNDS,
    { width: 6000, height: 4000 },
    { scale: 1, x: 0, y: 0 },
  );
  // The synthetic image is one pixel per State Plane survey foot.
  const expectedStatePlaneFeet = 10 * CourseMap.EPSG_6541.scaleFactor
    / CourseMap.US_SURVEY_FOOT_M;
  closeTo(circle.radiusX, expectedStatePlaneFeet, 0.01);
  closeTo(circle.radiusY, expectedStatePlaneFeet, 0.01);
  assert.ok(circle.radiusPx >= circle.radiusX);
  assert.ok(circle.radiusPx >= circle.radiusY);
});

test("invalid bounds, dimensions, transforms, and zoom requests fail clearly", () => {
  assert.throws(
    () => CourseMap.lonLatToImagePixel({ lng: -75, lat: 45 }, { ...BOUNDS, east: -80 }, IMAGE),
    /west < east/,
  );
  assert.throws(
    () => CourseMap.projectedToImagePixel(
      { x: 1, y: 1 },
      { ...DEERWOOD_PROJECTED_BOUNDS, maxX: 1077000 },
      IMAGE,
    ),
    /minX < maxX/,
  );
  assert.throws(
    () => CourseMap.fitView({ width: 0, height: 10 }, { width: 10, height: 10 }),
    /greater than zero/,
  );
  assert.throws(
    () => CourseMap.fitView(IMAGE, { width: 100, height: 100 }, { padding: 50 }),
    /positive container area/,
  );
  assert.throws(
    () => CourseMap.fitImageBoundsView(
      { minX: 10, minY: 10, maxX: 10, maxY: 20 },
      IMAGE,
      { width: 100, height: 100 },
    ),
    /minX < maxX/,
  );
  assert.throws(
    () => CourseMap.fitImageBoundsView(
      { minX: -1, minY: 10, maxX: 20, maxY: 20 },
      IMAGE,
      { width: 100, height: 100 },
    ),
    /within imageSize/,
  );
  assert.throws(
    () => CourseMap.zoomViewAt({ scale: 1, x: 0, y: 0 }, 0, { x: 0, y: 0 }, IMAGE, IMAGE),
    /greater than zero/,
  );
  assert.throws(
    () => CourseMap.constrainView({ scale: -1, x: 0, y: 0 }, IMAGE, IMAGE),
    /greater than zero/,
  );
});
