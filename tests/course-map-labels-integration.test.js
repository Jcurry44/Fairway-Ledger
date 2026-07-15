/* Browser-shell integration guards for Deerwood's draft map-label workflow. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const APP_SOURCE = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const INDEX_SOURCE = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const MAP_UI_SOURCE = fs.readFileSync(path.join(ROOT, "lib", "course-map-ui.js"), "utf8");
const RUNTIME_SOURCE = fs.readFileSync(path.join(ROOT, "data", "course-maps", "deerwood-runtime.js"), "utf8");
const SERVICE_WORKER_SOURCE = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("draft and seeded label modules load before the map UI and are available offline", () => {
  const labelsIndex = INDEX_SOURCE.indexOf("./lib/course-map-labels.js?v=2026-07-15a");
  const seedIndex = INDEX_SOURCE.indexOf("./data/course-maps/deerwood-aerial-labels-v1.js?v=2026-07-15a");
  const mapUiIndex = INDEX_SOURCE.indexOf("./lib/course-map-ui.js?v=2026-07-15a");
  assert.notEqual(labelsIndex, -1);
  assert.ok(labelsIndex < seedIndex && seedIndex < mapUiIndex);
  assert.match(SERVICE_WORKER_SOURCE, /'\.\/lib\/course-map-labels\.js'/);
  assert.match(SERVICE_WORKER_SOURCE, /'\.\/data\/course-maps\/deerwood-aerial-labels-v1\.js'/);
  assert.match(SERVICE_WORKER_SOURCE, /fairway-ledger-v85-2026-07-15a/);
  assert.match(RUNTIME_SOURCE, /mapId: "deerwood-aerial-2024"/);
  assert.match(MAP_UI_SOURCE, /config\.mapId === labelsApi\.MAP_ID/);
  assert.match(MAP_UI_SOURCE, /imageConfig\.sha256\.toLowerCase\(\) === labelsApi\.MAP_SHA256\.toLowerCase\(\)/);
});

test("visible editor controls match the controller integration", () => {
  for (const id of [
    "courseMapEdit", "courseMapEditor", "courseMapFeatureType", "courseMapFeatureLabel",
    "courseMapEditorHint", "courseMapUndoVertex", "courseMapResetDraft",
    "courseMapCancelEdit", "courseMapSaveFeature", "courseMapDeleteFeature"
  ]) {
    assert.match(INDEX_SOURCE, new RegExp(`id="${id}"`));
    assert.match(APP_SOURCE, new RegExp(`getElementById\\("${id}"\\)`));
  }
  assert.match(MAP_UI_SOURCE, /getAnnotations/);
  assert.match(MAP_UI_SOURCE, /onAnnotationsChange/);
  const hitTest = between(MAP_UI_SOURCE, "function annotationAtPoint", "function shotMarkup");
  assert.match(hitTest, /distanceToSegment/);
  assert.doesNotMatch(hitTest, /pointInRing/);
});

test("map annotations persist separately and never re-enter Deerwood hazards", () => {
  const shape = between(APP_SOURCE, "function getCourseMapLabelsApi", "function getSiblingCourses");
  assert.match(shape, /stateValue\.mapAnnotations = normalizeCourseMapAnnotations\(stateValue\.mapAnnotations\)/);
  assert.match(shape, /stateValue\.mapAnnotationSeedState = normalizeCourseMapSeedState\(stateValue\.mapAnnotationSeedState\)/);
  assert.match(shape, /hole\.hazards = \[\]/);
  assert.match(shape, /return structuredClone\(value\)/);
  assert.match(shape, /!Object\.prototype\.hasOwnProperty\.call\(value, "legacyHazards"\)/);
  const controller = between(APP_SOURCE, "function ensureCourseMapController", "function activeCourseMapHoleNumber");
  assert.match(controller, /getAnnotations: \(\) => state\.mapAnnotations/);
  assert.match(controller, /state\.mapAnnotations = normalizeCourseMapAnnotations\(nextCollection\)/);
  assert.match(controller, /seedAnnotations: getDeerwoodAerialLabels\(\)/);
  assert.match(controller, /getSeedState: \(\) => state\.mapAnnotationSeedState/);
  assert.match(controller, /state\.mapAnnotationSeedState = normalizeCourseMapSeedState\(nextSeedState\)/);
  assert.doesNotMatch(controller, /\.hazards/);
});

test("seeded suggestions render beneath user labels and hide through tombstones", () => {
  const annotationMarkup = between(MAP_UI_SOURCE, "function annotationMarkup", "function draftAnnotationMarkup");
  assert.match(annotationMarkup, /visibleAnnotationsForCurrentHole\(\)/);
  assert.match(annotationMarkup, /course-map-annotation--baseline/);
  assert.match(annotationMarkup, /aerial-suggestion/);
  const deleteFlow = between(MAP_UI_SOURCE, "function deleteAnnotation", "function addAnnotationPoint");
  assert.match(deleteFlow, /labelsApi\.hideSeedFeature\(readSeedState\(\), featureId\)/);
  assert.match(deleteFlow, /labelsApi\.removeFeature\(readAnnotations\(\), featureId\)/);
});

test("Buck 1 focus metadata is user-confirmed, bounded, and contains its tee and green", () => {
  const context = {};
  vm.runInNewContext(RUNTIME_SOURCE, context, { filename: "deerwood-runtime.js" });
  const runtimeMap = JSON.parse(JSON.stringify(context.FairwayCourseMaps.deerwood));
  const buck1 = runtimeMap.holeViews["buck-1"];

  assert.deepEqual(runtimeMap.image && {
    width: runtimeMap.image.width,
    height: runtimeMap.image.height
  }, { width: 3000, height: 2000 });
  assert.deepEqual(buck1.teePixel, [2550, 1415]);
  assert.deepEqual(buck1.greenPixel, [1710, 1480]);
  assert.deepEqual(buck1.pixelBounds, {
    minX: 1633,
    minY: 1191,
    maxX: 2627,
    maxY: 1704
  });
  assert.equal(buck1.source, "user_confirmed_2024_aerial_corridor");
  assert.equal(buck1.confidence, "user_confirmed");

  const { minX, minY, maxX, maxY } = buck1.pixelBounds;
  assert.ok(minX >= 0 && minY >= 0);
  assert.ok(maxX <= runtimeMap.image.width && maxY <= runtimeMap.image.height);
  assert.ok(minX < maxX && minY < maxY);
  for (const [x, y] of [buck1.teePixel, buck1.greenPixel]) {
    assert.ok(x >= minX && x <= maxX, `expected x=${x} inside Buck 1 focus`);
    assert.ok(y >= minY && y <= maxY, `expected y=${y} inside Buck 1 focus`);
  }
});

test("selected Deerwood holes resolve only validated per-hole focus metadata", () => {
  const identityFlow = between(MAP_UI_SOURCE, "function selectedHoleIdentity", "function currentHoleFocus");
  assert.match(identityFlow, /options\.getHoleIdentity\(state\.selectedHole\)/);
  assert.match(identityFlow, /holeId/);

  const focusFlow = between(MAP_UI_SOURCE, "function currentHoleFocus", "function syncFitButton");
  assert.match(focusFlow, /selectedHoleIdentity\(\)/);
  assert.match(focusFlow, /config\.holeViews\[identity\.holeId\]/);
  assert.match(focusFlow, /normalized\.minX < 0/);
  assert.match(focusFlow, /normalized\.maxX > imageSize\.width/);
  assert.match(focusFlow, /normalized\.minX >= normalized\.maxX/);
  assert.match(focusFlow, /return \{ \.\.\.identity, pixelBounds: normalized \}/);
});

test("map open, image load, and hole selection all restore selected-hole focus", () => {
  const selectionFlow = between(MAP_UI_SOURCE, "function setSelectedHole", "function setPosition");
  assert.match(selectionFlow, /if \(state\.open\) fitSelectedHole\(\)/);

  const openFlow = between(MAP_UI_SOURCE, "function open(input)", "function close()");
  assert.match(openFlow, /state\.focusMode = "hole"/);
  assert.match(openFlow, /requestAnimationFrame\(fitSelectedHole\)/);

  const imageLoadFlow = between(
    MAP_UI_SOURCE,
    'elements.image.addEventListener("load"',
    'elements.image.addEventListener("error"'
  );
  assert.match(imageLoadFlow, /state\.imageReady = true/);
  assert.match(imageLoadFlow, /fitSelectedHole\(\)/);
  assert.doesNotMatch(imageLoadFlow, /fitWholeCourse\(\)/);
});

test("hole focus falls back safely and the Course button strictly toggles whole-course view", () => {
  const wholeCourseFlow = between(MAP_UI_SOURCE, "function fitWholeCourse", "function fitSelectedHole");
  assert.match(wholeCourseFlow, /state\.focusMode = "course"/);
  assert.match(wholeCourseFlow, /engine\.fitView\(imageSize, size, viewOptions\)/);
  assert.doesNotMatch(wholeCourseFlow, /fitImageBoundsView/);

  const selectedHoleFlow = between(MAP_UI_SOURCE, "function fitSelectedHole", "function fit()");
  assert.match(selectedHoleFlow, /if \(!focus \|\| typeof engine\.fitImageBoundsView !== "function"\)/);
  assert.match(selectedHoleFlow, /fitWholeCourse\(\)/);
  assert.match(selectedHoleFlow, /return false/);
  assert.match(selectedHoleFlow, /state\.focusMode = "hole"/);
  assert.match(selectedHoleFlow, /engine\.fitImageBoundsView\(focus\.pixelBounds, imageSize, viewportSize\(\), viewOptions\)/);

  const toggleFlow = between(MAP_UI_SOURCE, "function toggleFitView", "function zoom");
  assert.match(toggleFlow, /if \(!focusAvailable \|\| state\.focusMode === "hole"\)/);
  assert.match(toggleFlow, /fitWholeCourse\(\);[\s\S]*return;[\s\S]*fitSelectedHole\(\)/);
  assert.match(MAP_UI_SOURCE, /elements\.fit\.addEventListener\("click", toggleFitView\)/);
  assert.match(INDEX_SOURCE, /<button id="courseMapFit"[^>]*aria-label="Show whole course"[^>]*>Course<\/button>/);
});
