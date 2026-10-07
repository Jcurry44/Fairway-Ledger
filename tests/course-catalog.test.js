"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const catalog = require("../lib/course-catalog.js");

// Snapshot of the shipped ids taken from data/courses.js before the
// extraction (H0a). Adding a course on purpose means updating this list.
const EXPECTED_IDS = ["ridgeview-blue","lake-county-white","arrowhead-white","diamond-hawk-black","diamond-hawk-gold","diamond-hawk-green","diamond-hawk-silver","diamond-hawk-burgundy","glen-oak-white","harvest-hill-black","harvest-hill-gold","harvest-hill-silver","harvest-hill-bronze","harvest-hill-blue","hickory-stick-black","hickory-stick-blue","hickory-stick-white","hickory-stick-green","hickory-stick-red","deerwood-buck-blue","deerwood-buck-white","deerwood-doe-blue","deerwood-doe-white","deerwood-fawn-blue","deerwood-fawn-white","deerwood-buck-red","deerwood-doe-red","deerwood-fawn-red","cross-creek-1-white","cross-creek-2-white","cross-creek-3-white"];

test("catalog exposes courses + version", () => {
  assert.ok(Array.isArray(catalog.courses));
  assert.equal(typeof catalog.version, "number");
});

test("course count and ids are identical to the pre-extraction catalog", () => {
  assert.equal(catalog.courses.length, 31);
  assert.deepEqual(catalog.courses.map((c) => c.id), EXPECTED_IDS);
});

test("ids are unique and every course has nine or eighteen holes with par", () => {
  assert.equal(new Set(catalog.courses.map((c) => c.id)).size, catalog.courses.length);
  catalog.courses.forEach((c) => {
    assert.ok([9, 18].includes(c.holes.length), c.id);
    c.holes.forEach((h) => assert.ok(h.par >= 3 && h.par <= 5, `${c.id} hole ${h.number}`));
  });
});

test("browser load sets FairwayCourseCatalog and the legacy alias", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "course-catalog.js"), "utf8");
  const sandbox = {};
  new Function("self", src)(sandbox);
  assert.equal(sandbox.FairwayCourseCatalog.courses.length, 31);
  assert.equal(sandbox.__golfCourseCatalog, sandbox.FairwayCourseCatalog.courses);
});
