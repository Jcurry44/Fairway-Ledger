/* Browser-shell integration guards for Deerwood's draft map-label workflow. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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

test("draft label module loads before the map UI and is available offline", () => {
  const labelsIndex = INDEX_SOURCE.indexOf("./lib/course-map-labels.js?v=2026-07-14c");
  const mapUiIndex = INDEX_SOURCE.indexOf("./lib/course-map-ui.js?v=2026-07-14c");
  assert.notEqual(labelsIndex, -1);
  assert.ok(labelsIndex < mapUiIndex);
  assert.match(SERVICE_WORKER_SOURCE, /'\.\/lib\/course-map-labels\.js'/);
  assert.match(SERVICE_WORKER_SOURCE, /fairway-ledger-v82-2026-07-14c/);
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
  assert.match(shape, /hole\.hazards = \[\]/);
  assert.match(shape, /return structuredClone\(value\)/);
  assert.match(shape, /!Object\.prototype\.hasOwnProperty\.call\(value, "legacyHazards"\)/);
  const controller = between(APP_SOURCE, "function ensureCourseMapController", "function activeCourseMapHoleNumber");
  assert.match(controller, /getAnnotations: \(\) => state\.mapAnnotations/);
  assert.match(controller, /state\.mapAnnotations = normalizeCourseMapAnnotations\(nextCollection\)/);
  assert.doesNotMatch(controller, /\.hazards/);
});
