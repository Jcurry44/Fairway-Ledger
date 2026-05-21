/*
 * Unit tests for lib/golf-math.js — the pure golf math.
 *
 * Run:  node --test tests/
 * (Uses only the Node built-in test runner + assert — no dependencies.)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../lib/golf-math.js");

// Float comparison helper.
function near(actual, expected, eps = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`
  );
}

// ---- average -------------------------------------------------------------

test("average: mean of finite numbers", () => {
  near(G.average([2, 4, 6]), 4);
  near(G.average([10]), 10);
});

test("average: ignores non-finite values", () => {
  near(G.average([2, NaN, 4, Infinity, 6]), 4);
});

test("average: empty (or all non-finite) input returns NaN", () => {
  assert.ok(Number.isNaN(G.average([])));
  assert.ok(Number.isNaN(G.average([NaN, Infinity])));
});

// ---- percentage ----------------------------------------------------------

test("percentage: rounds to a whole-number percent string", () => {
  assert.equal(G.percentage(1, 2), "50%");
  assert.equal(G.percentage(1, 3), "33%");
  assert.equal(G.percentage(2, 3), "67%");
  assert.equal(G.percentage(7, 7), "100%");
});

test("percentage: zero total returns a dash", () => {
  assert.equal(G.percentage(0, 0), "--");
});

// ---- formatSigned --------------------------------------------------------

test("formatSigned: positive gets a leading +", () => {
  assert.equal(G.formatSigned(3.2), "+3.2");
  assert.equal(G.formatSigned(0.04, 0), "0");
});

test("formatSigned: zero and negative", () => {
  assert.equal(G.formatSigned(0), "0");
  assert.equal(G.formatSigned(-2.5), "-2.5");
});

test("formatSigned: non-finite returns a dash", () => {
  assert.equal(G.formatSigned(NaN), "--");
  assert.equal(G.formatSigned(Infinity), "--");
});

// ---- tourExpectedStrokes -------------------------------------------------

test("tourExpectedStrokes: exact table point", () => {
  near(G.tourExpectedStrokes(4, 380), 3.98);
  near(G.tourExpectedStrokes(3, 150), 3.0);
});

test("tourExpectedStrokes: linear interpolation between points", () => {
  // par 4: 350 -> 3.84, 380 -> 3.98; midpoint 365 -> 3.91
  near(G.tourExpectedStrokes(4, 365), 3.91);
});

test("tourExpectedStrokes: clamps below and above the table", () => {
  near(G.tourExpectedStrokes(4, 50), 3.40); // below first row (250)
  near(G.tourExpectedStrokes(4, 9999), 4.40); // above last row (500)
});

test("tourExpectedStrokes: missing yardage falls back to table midpoint", () => {
  // par 4 table has 11 rows; midpoint index floor(11/2)=5 = { 400, 4.04 }
  near(G.tourExpectedStrokes(4, 0), 4.04);
  near(G.tourExpectedStrokes(4, null), 4.04);
});

test("tourExpectedStrokes: unknown par returns par itself", () => {
  assert.equal(G.tourExpectedStrokes(7, 600), 7);
});

// ---- holeStrokesGained ---------------------------------------------------

test("holeStrokesGained: expected minus score", () => {
  // par 4, 380 yds -> 3.98 expected; score 4 -> SG -0.02
  near(G.holeStrokesGained({ par: 4, yards: 380, score: 4 }), -0.02);
  // a birdie beats the benchmark
  near(G.holeStrokesGained({ par: 4, yards: 380, score: 3 }), 0.98);
});

test("holeStrokesGained: null when the hole has no score", () => {
  assert.equal(G.holeStrokesGained({ par: 4, yards: 380, score: 0 }), null);
  assert.equal(G.holeStrokesGained({ par: 4, yards: 380 }), null);
  assert.equal(G.holeStrokesGained(null), null);
});

// ---- roundStrokesGained --------------------------------------------------

test("roundStrokesGained: sums SG over scored holes only", () => {
  const round = {
    holes: [
      { par: 4, yards: 380, score: 4 }, // -0.02
      { par: 3, yards: 150, score: 3 }, //  0.00
      { par: 5, yards: 500, score: 0 } // not scored -> ignored
    ]
  };
  const sg = G.roundStrokesGained(round);
  assert.equal(sg.holes, 2);
  near(sg.total, -0.02);
});

test("roundStrokesGained: null when nothing is scored", () => {
  assert.equal(G.roundStrokesGained({ holes: [{ par: 4, score: 0 }] }), null);
  assert.equal(G.roundStrokesGained({ holes: [] }), null);
  assert.equal(G.roundStrokesGained(null), null);
});

// ---- roundTotals ---------------------------------------------------------

test("roundTotals: gross, par, to-par, putts", () => {
  const round = {
    holes: [
      { par: 4, score: 5, putts: 2, gir: false, fairway: "miss" },
      { par: 3, score: 3, putts: 2, gir: true, fairway: "na" },
      { par: 5, score: 6, putts: 1, gir: false, fairway: "hit" }
    ]
  };
  const t = G.roundTotals(round);
  assert.equal(t.gross, 14);
  assert.equal(t.par, 12);
  assert.equal(t.toPar, 2);
  assert.equal(t.putts, 5);
});

test("roundTotals: GIR and FIR counts (par 3s excluded from fairways)", () => {
  const round = {
    holes: [
      { par: 4, score: 4, putts: 2, gir: true, fairway: "hit" },
      { par: 3, score: 3, putts: 2, gir: true, fairway: "na" },
      { par: 5, score: 5, putts: 2, gir: false, fairway: "left" }
    ]
  };
  const t = G.roundTotals(round);
  assert.equal(t.girMade, 2);
  assert.equal(t.girTotal, 3);
  assert.equal(t.firMade, 1); // only the par 4 was "hit"
  assert.equal(t.firTotal, 2); // par 3 excluded
});

// ---- scoreMarkClass ------------------------------------------------------

test("scoreMarkClass: each scoring tier", () => {
  assert.equal(G.scoreMarkClass(2, 4), "score-mark-eagle"); // -2
  assert.equal(G.scoreMarkClass(1, 4), "score-mark-eagle"); // -3 (albatross)
  assert.equal(G.scoreMarkClass(3, 4), "score-mark-birdie"); // -1
  assert.equal(G.scoreMarkClass(4, 4), "score-mark-par"); // 0
  assert.equal(G.scoreMarkClass(5, 4), "score-mark-bogey"); // +1
  assert.equal(G.scoreMarkClass(6, 4), "score-mark-double"); // +2
  assert.equal(G.scoreMarkClass(7, 4), "score-mark-triple"); // +3
  assert.equal(G.scoreMarkClass(9, 4), "score-mark-triple"); // +5 still triple+
});

test("scoreMarkClass: hole-in-one on a par 3 is an eagle", () => {
  assert.equal(G.scoreMarkClass(1, 3), "score-mark-eagle"); // -2
});

test("scoreMarkClass: empty string when there is no real score", () => {
  assert.equal(G.scoreMarkClass(0, 4), "");
  assert.equal(G.scoreMarkClass(NaN, 4), "");
  assert.equal(G.scoreMarkClass(4, NaN), "");
});

// ---- isDeerwoodCourseId --------------------------------------------------

test("isDeerwoodCourseId", () => {
  assert.equal(G.isDeerwoodCourseId("deerwood-buck-doe-white"), true);
  assert.equal(G.isDeerwoodCourseId("deerwood-buck-white"), true);
  assert.equal(G.isDeerwoodCourseId("ridgeview-blue"), false);
  assert.equal(G.isDeerwoodCourseId(""), false);
  assert.equal(G.isDeerwoodCourseId(null), false);
});

// ---- physicalHoleId ------------------------------------------------------

test("physicalHoleId: Deerwood hole identity comes from the label", () => {
  assert.equal(
    G.physicalHoleId("deerwood-buck-doe-white", { label: "Buck 3", number: 3 }),
    "deerwood:buck:3"
  );
  assert.equal(
    G.physicalHoleId("deerwood-buck-doe-white", { label: "Doe 7", number: 16 }),
    "deerwood:doe:7"
  );
});

test("physicalHoleId: same physical hole pools across routings and tees", () => {
  // "Buck 3" is hole 3 when Buck is the front nine...
  const front = G.physicalHoleId("deerwood-buck-doe-white", { label: "Buck 3", number: 3 });
  // ...and hole 12 when Buck is the back nine, on a different tee.
  const back = G.physicalHoleId("deerwood-doe-buck-blue", { label: "Buck 3", number: 12 });
  assert.equal(front, back, "the same physical hole must produce one shared id");
});

test("physicalHoleId: non-Deerwood courses key on courseId + number", () => {
  assert.equal(
    G.physicalHoleId("ridgeview-blue", { label: "7", number: 7 }),
    "course:ridgeview-blue:7"
  );
});

test("physicalHoleId: unparseable Deerwood label falls back to courseId + number", () => {
  assert.equal(
    G.physicalHoleId("deerwood-buck-doe-white", { label: "", number: 5 }),
    "course:deerwood-buck-doe-white:5"
  );
});

// ---- geo -----------------------------------------------------------------

test("haversineMeters: one degree of latitude is ~111 km", () => {
  near(G.haversineMeters(0, 0, 1, 0), 111194.9, 1);
});

test("haversineMeters: zero distance for identical points", () => {
  near(G.haversineMeters(40.1, -74.2, 40.1, -74.2), 0);
});

test("metersToYards: standard conversion", () => {
  near(G.metersToYards(100), 109.36133, 1e-4);
  near(G.metersToYards(0), 0);
});

// ---- handicap helpers ----------------------------------------------------

test("expectedNineHoleDifferential: linear formula, floored at 0", () => {
  near(G.expectedNineHoleDifferential(10), 6.4); // 0.52*10 + 1.2
  near(G.expectedNineHoleDifferential(0), 1.2);
  near(G.expectedNineHoleDifferential(-10), 0); // would be negative -> 0
});

test("handicapRuleForCount: too few rounds returns null", () => {
  assert.equal(G.handicapRuleForCount(0), null);
  assert.equal(G.handicapRuleForCount(2), null);
});

test("handicapRuleForCount: WHS count + adjustment table", () => {
  assert.deepEqual(G.handicapRuleForCount(3), { count: 1, adjustment: -2 });
  assert.deepEqual(G.handicapRuleForCount(4), { count: 1, adjustment: -1 });
  assert.deepEqual(G.handicapRuleForCount(5), { count: 1, adjustment: 0 });
  assert.deepEqual(G.handicapRuleForCount(6), { count: 2, adjustment: -1 });
  assert.deepEqual(G.handicapRuleForCount(8), { count: 2, adjustment: 0 });
  assert.deepEqual(G.handicapRuleForCount(11), { count: 3, adjustment: 0 });
  assert.deepEqual(G.handicapRuleForCount(14), { count: 4, adjustment: 0 });
  assert.deepEqual(G.handicapRuleForCount(16), { count: 5, adjustment: 0 });
  assert.deepEqual(G.handicapRuleForCount(18), { count: 6, adjustment: 0 });
  assert.deepEqual(G.handicapRuleForCount(19), { count: 7, adjustment: 0 });
  assert.deepEqual(G.handicapRuleForCount(20), { count: 8, adjustment: 0 });
  assert.deepEqual(G.handicapRuleForCount(50), { count: 8, adjustment: 0 });
});
