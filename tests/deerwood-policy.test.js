/* Regression guards for Deerwood's rejected legacy-hazard policy. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SOURCE = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const INDEX_SOURCE = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Deerwood hazards are scrubbed at the shared course-state boundary", () => {
  const shape = between(APP_SOURCE, "function ensureCourseDataShape", "function getSiblingCourses");
  assert.match(shape, /course\.id === DEERWOOD_COURSE_ID \|\| isDeerwoodCourseId\(course\.id\)/);
  assert.match(shape, /if \(rejectLegacyHazards\) \{\s*hole\.hazards = \[\];\s*return;/);
  assert.match(shape, /hole\.hazards = hole\.hazards\.map\(normalizeHazard\)\.filter\(Boolean\)/);
});

test("Deerwood catalog refresh never restores saved legacy hazards", () => {
  const merge = between(APP_SOURCE, "function mergeNewDefaultCourses", "function saveState");
  assert.doesNotMatch(merge, /userHazards|preserve any user-entered hazards/i);
  assert.match(merge, /return structuredClone\(defaultDeerwoodById\.get\(course\.id\)\)/);
});

test("load, snapshot restore, and import all pass through the scrub boundary", () => {
  const normalizationCalls = APP_SOURCE.match(/ensureCourseDataShape\(mergeNewDefaultCourses\(/g) || [];
  assert.equal(normalizationCalls.length, 3);
  const restore = between(APP_SOURCE, "function restoreSnapshot", "function deleteSnapshot");
  assert.match(restore, /ensureCourseDataShape\(mergeNewDefaultCourses\(normalized\)\)/);
  const importBlock = between(APP_SOURCE, "function applyImport", "els.importInput.addEventListener");
  assert.match(importBlock, /ensureCourseDataShape\(mergeNewDefaultCourses\(imported\)\)/);
});

test("visible map badge identifies the dashed outline as non-playing reference", () => {
  assert.match(INDEX_SOURCE, /Dashed outline: facility reference only — not course\/OB/);
});
