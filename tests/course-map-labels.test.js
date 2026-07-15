const test = require("node:test");
const assert = require("node:assert/strict");

const Labels = require("../lib/course-map-labels.js");
const SeedLabels = require("../data/course-maps/deerwood-aerial-labels-v1.js");

const POINT = [-78.8408, 43.0412];
const TRIANGLE = [
  [-78.8415, 43.042],
  [-78.8405, 43.042],
  [-78.841, 43.0412]
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function pointDraft(overrides = {}) {
  return Labels.buildDraftFeature({
    id: "target-1",
    holeId: "buck-1",
    kind: "strategy_target",
    geometry: { type: "Point", coordinates: POINT },
    ...overrides
  });
}

function polygonDraft(overrides = {}) {
  return Labels.buildDraftFeature({
    id: "surface-1",
    holeId: "buck-1",
    kind: "sand_surface",
    geometry: { type: "Polygon", coordinates: [TRIANGLE] },
    ...overrides
  });
}

function collectionWith(...features) {
  return { ...Labels.createEmptyCollection(), features };
}

test("publishes the fixed Deerwood dataset and authoritative map identity", () => {
  assert.equal(Labels.DATASET, "deerwood-user-map-v1");
  assert.equal(Labels.COORDINATE_SYSTEM, "WGS84");
  assert.equal(Labels.MAP_ID, "deerwood-aerial-2024");
  assert.equal(
    Labels.MAP_SHA256,
    "5FD178E66F235E7712E231DA2AC42BF466914BD889A2535875461D1CB9A1478A"
  );
  assert.deepEqual(Labels.createEmptyCollection(), {
    type: "FeatureCollection",
    dataset: Labels.DATASET,
    coordinateSystem: "WGS84",
    mapId: Labels.MAP_ID,
    mapSha256: Labels.MAP_SHA256,
    legacyHazardDataUsed: false,
    features: []
  });
  assert.deepEqual(Labels.FEATURE_DEFINITIONS.strategy_target, {
    label: "Personal aim",
    geometryType: "Point"
  });
  assert.deepEqual(Labels.FEATURE_DEFINITIONS.sand_surface, {
    label: "Sand / bunker candidate",
    geometryType: "Polygon"
  });
});

test("buildDraftFeature stamps conservative draft provenance on a strategy target", () => {
  const inputGeometry = { type: "Point", coordinates: [...POINT] };
  const feature = Labels.buildDraftFeature({
    id: "aim.buck-1.1",
    holeId: "buck-1",
    kind: "strategy_target",
    geometry: inputGeometry,
    source: "legacy",
    status: "verified",
    confidence: "authoritative"
  });

  assert.equal(feature.type, "Feature");
  assert.deepEqual(feature.geometry, inputGeometry);
  assert.notStrictEqual(feature.geometry, inputGeometry);
  assert.notStrictEqual(feature.geometry.coordinates, inputGeometry.coordinates);
  assert.deepEqual(feature.properties, {
    dataset: Labels.DATASET,
    courseId: "deerwood",
    mapId: Labels.MAP_ID,
    mapSha256: Labels.MAP_SHA256,
    holeId: "buck-1",
    holeAssignment: "user_selected",
    kind: "strategy_target",
    label: "Personal aim",
    source: Labels.STRATEGY_SOURCE,
    confidence: Labels.STRATEGY_CONFIDENCE,
    status: "draft",
    legacyHazardDataUsed: false
  });
});

test("polygon builders use conservative physical kinds and close the ring", () => {
  const expectedLabels = {
    sand_surface: "Sand / bunker candidate",
    open_water: "Visible water",
    green_surface: "Green surface",
    tee_surface: "Tee surface",
    tree_canopy: "Tree canopy"
  };

  for (const [kind, label] of Object.entries(expectedLabels)) {
    const feature = polygonDraft({ id: `draft-${kind}`, kind });
    assert.ok(feature, kind);
    assert.equal(feature.properties.label, label);
    assert.equal(feature.properties.source, Labels.SOURCE);
    assert.equal(feature.properties.confidence, Labels.CONFIDENCE);
    assert.equal(feature.geometry.type, "Polygon");
    assert.deepEqual(feature.geometry.coordinates[0][0], feature.geometry.coordinates[0].at(-1));
    assert.equal(feature.geometry.coordinates[0].length, 4);
  }
});

test("only canonical physical Buck, Doe, and Fawn hole IDs are accepted", () => {
  for (const nine of ["buck", "doe", "fawn"]) {
    for (const number of [1, 9]) {
      assert.ok(pointDraft({ id: `${nine}-${number}`, holeId: `${nine}-${number}` }));
    }
  }

  for (const holeId of ["Buck 1", "buck-0", "buck-10", "hole-1", "deer-1", "1", "doe-01"]) {
    assert.equal(pointDraft({ id: `bad-${holeId.replaceAll(" ", "-")}`, holeId }), null);
  }

  assert.equal(Labels.normalizeHoleId("buck-1"), "buck-1");
  assert.equal(Labels.normalizeHoleId("Buck 1"), null);
  assert.equal(Labels.holeIdentity("Buck 1"), "buck-1");
  assert.equal(Labels.holeIdentity("doe 9"), "doe-9");
  assert.equal(Labels.holeIdentity({ label: "Fawn 4" }), "fawn-4");
  assert.equal(Labels.holeIdentity({ nine: "Doe", number: 2 }), "doe-2");
  assert.equal(Labels.holeIdentity({ holeId: "fawn-8" }), "fawn-8");
  assert.equal(Labels.holeIdentity({ number: 1 }), null);
  assert.equal(Labels.holeIdentity("Hole 1"), null);
});

test("optional user names and canonical timestamps survive build and normalization", () => {
  const feature = pointDraft({
    id: "named-target",
    name: "  Lay up   left  ",
    createdAt: "2026-07-14T14:30:00.000Z",
    updatedAt: "2026-07-14T15:00:00.000Z"
  });
  assert.equal(feature.properties.name, "Lay up left");
  assert.equal(feature.properties.createdAt, "2026-07-14T14:30:00.000Z");
  assert.equal(feature.properties.updatedAt, "2026-07-14T15:00:00.000Z");
  assert.deepEqual(Labels.normalizeFeature(feature), feature);

  assert.equal(pointDraft({ name: "" }), null);
  assert.equal(pointDraft({ name: "x".repeat(81) }), null);
  assert.equal(pointDraft({ name: "bad\nname" }), null);
  assert.equal(pointDraft({ createdAt: "July 14" }), null);
  assert.equal(pointDraft({
    createdAt: "2026-07-14T15:00:00.000Z",
    updatedAt: "2026-07-14T14:30:00.000Z"
  }), null);
});

test("physical kinds require Polygon and strategy_target requires Point", () => {
  assert.equal(pointDraft({ kind: "sand_surface" }), null);
  assert.equal(polygonDraft({ kind: "strategy_target" }), null);
  assert.equal(pointDraft({ kind: "bunker" }), null);
  assert.equal(polygonDraft({ kind: "penalty_area" }), null);
  assert.equal(polygonDraft({ kind: "out_of_bounds" }), null);
  assert.equal(polygonDraft({ kind: "boundary" }), null);
});

test("coordinates must be finite WGS84 positions inside the authoritative image", () => {
  assert.equal(pointDraft({ geometry: { type: "Point", coordinates: [-78.9, 43.04] } }), null);
  assert.equal(pointDraft({ geometry: { type: "Point", coordinates: [NaN, 43.04] } }), null);
  assert.equal(pointDraft({ geometry: { type: "Point", coordinates: [POINT[0], Infinity] } }), null);
  assert.equal(pointDraft({ geometry: { type: "Point", coordinates: [String(POINT[0]), POINT[1]] } }), null);

  const outsidePolygon = clone(TRIANGLE);
  outsidePolygon[1] = [-78.9, 43.04];
  assert.equal(polygonDraft({ geometry: { type: "Polygon", coordinates: [outsidePolygon] } }), null);
});

test("degenerate, repeated, holed, and self-crossing polygons are rejected", () => {
  assert.equal(polygonDraft({ geometry: { type: "Polygon", coordinates: [[TRIANGLE[0], TRIANGLE[1]]] } }), null);
  assert.equal(polygonDraft({
    geometry: { type: "Polygon", coordinates: [[TRIANGLE[0], TRIANGLE[1], TRIANGLE[1], TRIANGLE[2]]] }
  }), null);
  assert.equal(polygonDraft({
    geometry: {
      type: "Polygon",
      coordinates: [[
        [-78.8415, 43.042],
        [-78.841, 43.0418],
        [-78.8405, 43.0416]
      ]]
    }
  }), null);
  assert.equal(polygonDraft({
    geometry: {
      type: "Polygon",
      coordinates: [[
        [-78.8415, 43.042],
        [-78.8405, 43.0412],
        [-78.8415, 43.0412],
        [-78.8405, 43.042]
      ]]
    }
  }), null);
  assert.equal(polygonDraft({
    geometry: { type: "Polygon", coordinates: [TRIANGLE, TRIANGLE] }
  }), null);
});

test("normalizeFeature rejects spoofed provenance, status, confidence, labels, and map identity", () => {
  const feature = pointDraft();
  const changes = [
    ["source", "legacy"],
    ["source", "osm"],
    ["source", "unknown"],
    ["status", "verified"],
    ["confidence", "authoritative"],
    ["holeAssignment", "inferred"],
    ["label", "Out of bounds"],
    ["mapId", "old-map"],
    ["mapSha256", "BAD"],
    ["legacyHazardDataUsed", true]
  ];

  for (const [property, value] of changes) {
    const changed = clone(feature);
    changed.properties[property] = value;
    assert.equal(Labels.normalizeFeature(changed), null, property);
  }

  const topLevelLegacy = clone(feature);
  topLevelLegacy.legacyHazardDataUsed = true;
  assert.equal(Labels.normalizeFeature(topLevelLegacy), null);

  const physicalAsStrategy = polygonDraft();
  physicalAsStrategy.properties.source = Labels.STRATEGY_SOURCE;
  physicalAsStrategy.properties.confidence = Labels.STRATEGY_CONFIDENCE;
  assert.equal(Labels.normalizeFeature(physicalAsStrategy), null);

  const strategyAsPhysical = pointDraft();
  strategyAsPhysical.properties.source = Labels.SOURCE;
  strategyAsPhysical.properties.confidence = Labels.CONFIDENCE;
  assert.equal(Labels.normalizeFeature(strategyAsPhysical), null);
});

test("normalizeFeature strips unknown properties and never mutates its input", () => {
  const input = pointDraft();
  input.properties.untrustedClaim = "definitely a penalty area";
  input.geometry.extra = "ignored";
  const before = clone(input);

  const normalized = Labels.normalizeFeature(input);
  assert.deepEqual(input, before);
  assert.equal("untrustedClaim" in normalized.properties, false);
  assert.equal("extra" in normalized.geometry, false);
  assert.notStrictEqual(normalized, input);
});

test("normalizeCollection is an idempotent GeoJSON persistence boundary", () => {
  const point = pointDraft();
  const polygon = polygonDraft();
  const input = collectionWith(point, polygon);
  input.untrusted = "discard me";

  const normalized = Labels.normalizeCollection(input);
  const roundTripped = Labels.normalizeCollection(JSON.parse(JSON.stringify(normalized)));
  assert.deepEqual(roundTripped, normalized);
  assert.equal("untrusted" in normalized, false);
  assert.notStrictEqual(normalized.features[0], point);
});

test("collection normalization keeps valid order and rejects invalid or duplicate features", () => {
  const first = pointDraft({ id: "same-id", holeId: "buck-1" });
  const duplicate = pointDraft({ id: "same-id", holeId: "doe-1" });
  const second = polygonDraft({ id: "surface-2", holeId: "fawn-9" });
  const invalid = clone(pointDraft({ id: "legacy-feature" }));
  invalid.properties.source = "legacy";

  const normalized = Labels.normalizeCollection(collectionWith(first, invalid, duplicate, second));
  assert.deepEqual(normalized.features.map((feature) => feature.id), ["same-id", "surface-2"]);
  assert.equal(normalized.features[0].properties.holeId, "buck-1");
});

test("legacy collections, raw course hazards, and malformed metadata fail closed", () => {
  const safe = pointDraft();
  const legacyFlag = collectionWith(safe);
  legacyFlag.legacyHazardDataUsed = true;
  assert.deepEqual(Labels.normalizeCollection(legacyFlag).features, []);

  const rawHazards = { hazards: [{ type: "water", hole: 1 }] };
  assert.deepEqual(Labels.normalizeCollection(rawHazards).features, []);

  const disguisedHazards = collectionWith(safe);
  disguisedHazards.hazards = [{ type: "bunker" }];
  assert.deepEqual(Labels.normalizeCollection(disguisedHazards).features, []);

  for (const [property, value] of [
    ["dataset", "old-deerwood-map"],
    ["coordinateSystem", "EPSG:6541"],
    ["mapId", "reference-boundary"],
    ["mapSha256", "BAD"]
  ]) {
    const changed = collectionWith(safe);
    changed[property] = value;
    assert.deepEqual(Labels.normalizeCollection(changed).features, [], property);
  }
});

test("featuresForHole filters by physical nine and returns defensive clones", () => {
  const buck = pointDraft({ id: "buck-target", holeId: "buck-1" });
  const doe = pointDraft({ id: "doe-target", holeId: "doe-1" });
  const fawn = polygonDraft({ id: "fawn-surface", holeId: "fawn-1" });
  const collection = collectionWith(buck, doe, fawn);

  const result = Labels.featuresForHole(collection, "doe-1");
  assert.deepEqual(result.map((feature) => feature.id), ["doe-target"]);
  result[0].properties.holeId = "buck-1";
  assert.equal(collection.features[1].properties.holeId, "doe-1");
  assert.deepEqual(Labels.featuresForHole(collection, "Doe 1"), []);
});

test("withFeature appends valid drafts but rejects invalid and duplicate IDs", () => {
  const first = pointDraft({ id: "first" });
  const second = polygonDraft({ id: "second" });
  const starting = collectionWith(first);

  const appended = Labels.withFeature(starting, second);
  assert.deepEqual(appended.features.map((feature) => feature.id), ["first", "second"]);
  assert.equal(starting.features.length, 1);
  assert.deepEqual(Labels.withFeature(appended, clone(first)), appended);

  const legacy = clone(second);
  legacy.id = "legacy";
  legacy.properties.source = "legacy";
  assert.deepEqual(Labels.withFeature(appended, legacy), appended);
});

test("removeFeature removes one canonical ID without mutating the collection", () => {
  const first = pointDraft({ id: "first" });
  const second = polygonDraft({ id: "second" });
  const starting = collectionWith(first, second);

  const removed = Labels.removeFeature(starting, "first");
  assert.deepEqual(removed.features.map((feature) => feature.id), ["second"]);
  assert.deepEqual(starting.features.map((feature) => feature.id), ["first", "second"]);
  assert.deepEqual(Labels.removeFeature(starting, "not valid id"), Labels.normalizeCollection(starting));
});

test("ships a strict 2024 aerial-observation layer without legacy or rules claims", () => {
  const normalized = Labels.normalizeSeedCollection(SeedLabels);
  assert.equal(normalized.features.length, 32);
  assert.equal(normalized.features.filter((feature) => feature.properties.kind === "open_water").length, 11);
  assert.equal(normalized.features.filter((feature) => feature.properties.kind === "sand_surface").length, 21);
  assert.equal(new Set(normalized.features.map((feature) => feature.id)).size, 32);
  for (const feature of normalized.features) {
    assert.match(feature.id, /^seed-v1-/);
    assert.equal(feature.properties.geometrySource, Labels.SEED_GEOMETRY_SOURCE);
    assert.equal(feature.properties.classificationSource, Labels.SEED_CLASSIFICATION_SOURCE);
    assert.equal(feature.properties.classificationConfidence, "high_visual");
    assert.equal(feature.properties.outlineConfidence, "draft_trace");
    assert.equal(feature.properties.rulesStatus, "not_official");
    assert.equal(feature.properties.legacyHazardDataUsed, false);
    assert.equal(feature.geometry.type, "Polygon");
    assert.ok(feature.properties.holeIds.length >= 1);
    assert.equal(Labels.normalizeFeature(feature), null);
  }
});

test("seed suggestions can be hidden persistently without changing user labels", () => {
  const starting = Labels.createEmptySeedState();
  const hidden = Labels.hideSeedFeature(starting, "seed-v1-water-08");
  assert.deepEqual(starting.hiddenFeatureIds, []);
  assert.deepEqual(hidden.hiddenFeatureIds, ["seed-v1-water-08"]);
  assert.equal(
    Labels.seedFeaturesForHole(SeedLabels, starting, "buck-1").some((feature) => feature.id === "seed-v1-water-08"),
    true
  );
  assert.equal(
    Labels.seedFeaturesForHole(SeedLabels, hidden, "buck-1").some((feature) => feature.id === "seed-v1-water-08"),
    false
  );
  assert.deepEqual(Labels.normalizeSeedState({ ...hidden, mapSha256: "BAD" }), Labels.createEmptySeedState());
});
