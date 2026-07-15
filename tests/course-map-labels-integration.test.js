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

test("draft and seeded label modules load before the map UI and are available offline", () => {
  const labelsIndex = INDEX_SOURCE.indexOf("./lib/course-map-labels.js?v=2026-07-14d");
  const seedIndex = INDEX_SOURCE.indexOf("./data/course-maps/deerwood-aerial-labels-v1.js?v=2026-07-14d");
  const mapUiIndex = INDEX_SOURCE.indexOf("./lib/course-map-ui.js?v=2026-07-14d");
  assert.notEqual(labelsIndex, -1);
  assert.ok(labelsIndex < seedIndex && seedIndex < mapUiIndex);
  assert.match(SERVICE_WORKER_SOURCE, /'\.\/lib\/course-map-labels\.js'/);
  assert.match(SERVICE_WORKER_SOURCE, /'\.\/data\/course-maps\/deerwood-aerial-labels-v1\.js'/);
  assert.match(SERVICE_WORKER_SOURCE, /fairway-ledger-v83-2026-07-14d/);
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
