/*
 * Unit tests for lib/shapes.js — canonical Round + Hole shapes.
 *
 * Run:  node --test tests/
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../lib/shapes.js");

// ---- HOLE_FIELDS / ROUND_FIELDS expose the canonical field lists ---------

test("HOLE_FIELDS lists all canonical hole fields", () => {
  // If this set changes, audit every reader/writer of holes.
  const expected = [
    "number",
    "label",
    "par",
    "yards",
    "hcp",
    "score",
    "putts",
    "fairway",
    "gir",
    "penalties",
    "penaltyClub",
    "firstPuttDistance",
    "note",
    "shots",
    "clubsHit",
  ];
  assert.deepEqual([...S.HOLE_FIELDS], expected);
});

test("ROUND_FIELDS lists all canonical round fields", () => {
  const expected = ["id", "date", "courseId", "tee", "wind", "note", "narrative", "holes"];
  assert.deepEqual([...S.ROUND_FIELDS], expected);
});

// ---- makeHole ------------------------------------------------------------

test("makeHole(): no args returns every canonical field with defaults", () => {
  const h = S.makeHole();
  for (const key of S.HOLE_FIELDS) {
    assert.ok(key in h, `missing field: ${key}`);
  }
  assert.equal(h.number, 0);
  assert.equal(h.par, 4);
  assert.equal(h.score, null);
  assert.equal(h.gir, false);
  assert.equal(h.fairway, "na");
  assert.deepEqual(h.shots, []);
  assert.deepEqual(h.clubsHit, []);
});

test("makeHole(): overrides win over defaults", () => {
  const h = S.makeHole({ number: 7, par: 3, score: 2, gir: true });
  assert.equal(h.number, 7);
  assert.equal(h.par, 3);
  assert.equal(h.score, 2);
  assert.equal(h.gir, true);
  // Other defaults still present.
  assert.equal(h.putts, 0);
  assert.equal(h.fairway, "na");
});

test("makeHole(): clones array fields so mutation doesn't leak", () => {
  const shots = [{ club: "Driver", distance: 250 }];
  const clubsHit = ["Driver", "7i"];
  const h = S.makeHole({ shots, clubsHit });
  // Mutate the result.
  h.shots.push({ club: "Putter" });
  h.clubsHit.push("Putter");
  // Originals are untouched.
  assert.equal(shots.length, 1);
  assert.equal(clubsHit.length, 2);
});

test("makeHole(): two fresh holes have independent arrays", () => {
  const a = S.makeHole();
  const b = S.makeHole();
  a.shots.push({ club: "Driver" });
  a.clubsHit.push("Driver");
  assert.equal(b.shots.length, 0, "shots array leaked between holes");
  assert.equal(b.clubsHit.length, 0, "clubsHit array leaked between holes");
});

test("makeHole(): unknown fields are preserved (additive shape)", () => {
  const h = S.makeHole({ par: 4, futureField: "carry me", extras: { foo: 1 } });
  assert.equal(h.futureField, "carry me");
  assert.deepEqual(h.extras, { foo: 1 });
});

// ---- makeRound -----------------------------------------------------------

test("makeRound(): no args returns every canonical field with defaults", () => {
  const r = S.makeRound();
  for (const key of S.ROUND_FIELDS) {
    assert.ok(key in r, `missing field: ${key}`);
  }
  assert.equal(r.id, "");
  assert.equal(r.date, "");
  assert.equal(r.tee, "");
  assert.equal(r.narrative, null);
  assert.deepEqual(r.holes, []);
});

test("makeRound(): overrides win over defaults", () => {
  const r = S.makeRound({
    id: "round-abc",
    date: "2026-05-22",
    courseId: "deerwood-buck-white",
    tee: "White",
    wind: "S 8mph",
    note: "Great day",
  });
  assert.equal(r.id, "round-abc");
  assert.equal(r.date, "2026-05-22");
  assert.equal(r.courseId, "deerwood-buck-white");
  assert.equal(r.tee, "White");
  assert.equal(r.wind, "S 8mph");
  assert.equal(r.note, "Great day");
});

test("makeRound(): holes are mapped through makeHole", () => {
  const r = S.makeRound({
    holes: [
      { number: 1, par: 4, score: 4 },
      { number: 2, par: 3, score: 2, gir: true },
    ],
  });
  assert.equal(r.holes.length, 2);
  // Each hole should have all canonical fields filled.
  for (const key of S.HOLE_FIELDS) {
    assert.ok(key in r.holes[0], `hole missing field: ${key}`);
  }
  assert.equal(r.holes[0].number, 1);
  assert.equal(r.holes[1].par, 3);
  assert.equal(r.holes[1].gir, true);
});

test("makeRound(): non-array holes input becomes empty array", () => {
  const r = S.makeRound({ holes: null });
  assert.deepEqual(r.holes, []);
});

test("makeRound(): unknown fields preserved", () => {
  const r = S.makeRound({ tee: "Blue", weather: "sunny", v: 2 });
  assert.equal(r.weather, "sunny");
  assert.equal(r.v, 2);
});

// ---- normalizeHole / normalizeRound --------------------------------------

test("normalizeHole(): null/undefined returns a default-shaped hole", () => {
  for (const input of [null, undefined, "not an object", 42]) {
    const h = S.normalizeHole(input);
    for (const key of S.HOLE_FIELDS) {
      assert.ok(key in h, `missing field: ${key} for input ${String(input)}`);
    }
  }
});

test("normalizeHole(): old-shape input gets new fields with defaults", () => {
  // Simulate a hole saved before firstPuttDistance / shots / clubsHit existed.
  const legacy = {
    number: 5,
    par: 4,
    score: 5,
    putts: 2,
    gir: false,
    fairway: "left",
    penalties: 0,
  };
  const h = S.normalizeHole(legacy);
  // New fields are present at defaults.
  assert.equal(h.firstPuttDistance, null);
  assert.deepEqual(h.shots, []);
  assert.deepEqual(h.clubsHit, []);
  assert.equal(h.note, "");
  assert.equal(h.penaltyClub, "");
  // Original values untouched.
  assert.equal(h.number, 5);
  assert.equal(h.score, 5);
  assert.equal(h.fairway, "left");
});

test("normalizeRound(): null/undefined returns a default-shaped round", () => {
  for (const input of [null, undefined, "garbage", 0]) {
    const r = S.normalizeRound(input);
    for (const key of S.ROUND_FIELDS) {
      assert.ok(key in r, `missing field: ${key} for input ${String(input)}`);
    }
  }
});

test("normalizeRound(): legacy round picks up new fields and shapes holes", () => {
  const legacy = {
    id: "round-old",
    date: "2026-01-01",
    courseId: "lake-county-white",
    tee: "White",
    note: "pre-wind era",
    holes: [{ number: 1, par: 4, score: 4 }],
    // Note: no wind, no narrative.
  };
  const r = S.normalizeRound(legacy);
  assert.equal(r.wind, "");
  assert.equal(r.narrative, null);
  assert.equal(r.holes.length, 1);
  // Hole was reshaped.
  assert.ok("firstPuttDistance" in r.holes[0]);
  assert.deepEqual(r.holes[0].shots, []);
});

// ---- HOLE_DEFAULTS / ROUND_DEFAULTS are frozen ---------------------------

test("HOLE_DEFAULTS is frozen (can't accidentally mutate the source)", () => {
  assert.equal(Object.isFrozen(S.HOLE_DEFAULTS), true);
  // The shots/clubsHit array defaults are also frozen.
  assert.equal(Object.isFrozen(S.HOLE_DEFAULTS.shots), true);
  assert.equal(Object.isFrozen(S.HOLE_DEFAULTS.clubsHit), true);
});

test("ROUND_DEFAULTS is frozen", () => {
  assert.equal(Object.isFrozen(S.ROUND_DEFAULTS), true);
  assert.equal(Object.isFrozen(S.ROUND_DEFAULTS.holes), true);
});
