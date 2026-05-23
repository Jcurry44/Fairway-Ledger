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

// ---- derivedGir ----------------------------------------------------------

test("derivedGir: par 4 score 4 with 2 putts = GIR (on in reg)", () => {
  assert.equal(G.derivedGir(4, 2, 4), true);
});

test("derivedGir: par 4 score 5 with 2 putts = no GIR (on in 3, one over reg)", () => {
  assert.equal(G.derivedGir(5, 2, 4), false);
});

test("derivedGir: 3-putt from on-in-reg still GIR", () => {
  // par 4, on in 2, 3-putt, score 5 -> (5-3)=2 ≤ 2 -> GIR
  assert.equal(G.derivedGir(5, 3, 4), true);
});

test("derivedGir: chip-in for par fails GIR (not on in reg)", () => {
  // par 4, missed green, chip in (0 putts), score 4 -> (4-0)=4 > 2 -> no GIR
  assert.equal(G.derivedGir(4, 0, 4), false);
});

test("derivedGir: par 3 hole-in-one is GIR", () => {
  // par 3, score 1, 0 putts -> (1-0)=1 ≤ 1 -> GIR
  assert.equal(G.derivedGir(1, 0, 3), true);
});

test("derivedGir: par 3 birdie via on-in-1 and 1-putt is GIR", () => {
  // par 3, score 2, 1 putt -> (2-1)=1 ≤ 1 -> GIR
  assert.equal(G.derivedGir(2, 1, 3), true);
});

test("derivedGir: par 5 reached in 3 with 2 putts (par) is GIR", () => {
  assert.equal(G.derivedGir(5, 2, 5), true);
});

test("derivedGir: par 5 reached in 4 (bogey or with up-and-down) is not GIR", () => {
  // par 5, score 5, 1 putt -> (5-1)=4 > 3 -> no GIR
  assert.equal(G.derivedGir(5, 1, 5), false);
});

test("derivedGir: missing or zero score is not GIR", () => {
  assert.equal(G.derivedGir(0, 2, 4), false);
  assert.equal(G.derivedGir(NaN, 2, 4), false);
  assert.equal(G.derivedGir(4, 2, NaN), false);
});

test("derivedGir: missing putts treated as 0", () => {
  // par 4, score 2 (an albatross/eagle), no putt count -> (2-0)=2 ≤ 2 -> GIR
  assert.equal(G.derivedGir(2, undefined, 4), true);
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

// ---- estimateRoundDifferential ------------------------------------------

test("estimateRoundDifferential: 18-hole formula (gross - rating) * 113 / slope", () => {
  // Rating 70.5, Slope 130, Gross 80 -> (80 - 70.5) * 113 / 130 = ~8.258 -> 8.3
  const holes = Array.from({ length: 18 }, (_, i) => ({ score: i < 8 ? 5 : 4, par: 4 }));
  // 8 fives + 10 fours = 40 + 40 = 80
  near(G.estimateRoundDifferential({ rating: 70.5, slope: 130 }, holes), 8.3, 0.05);
});

test("estimateRoundDifferential: 9-hole rounds add expected-9-hole differential", () => {
  // Gross 42 on 9 holes, rating 70.5, slope 130 -> base = (42-70.5)*113/130 = -24.77
  // With currentIndex 10: expected9 = 0.52*10 + 1.2 = 6.4
  // Final = -24.77 + 6.4 = -18.37 -> -18.4
  const holes = Array.from({ length: 9 }, () => ({ score: 42 / 9, par: 4 }));
  // Use exact gross via integer-ish scores
  const holes9 = Array.from({ length: 9 }, (_, i) => ({ score: i < 6 ? 5 : 4, par: 4 }));
  // 6 fives + 3 fours = 30 + 12 = 42
  const diff = G.estimateRoundDifferential({ rating: 70.5, slope: 130 }, holes9, 10);
  // base = (42 - 70.5) * 113 / 130 = -24.77
  // expected9(10) = 6.4
  // total = -18.4 (rounded)
  near(diff, -18.4, 0.1);
});

test("estimateRoundDifferential: 9-hole with no currentIndex uses fallback doubling", () => {
  const holes9 = Array.from({ length: 9 }, (_, i) => ({ score: i < 6 ? 5 : 4, par: 4 }));
  const diffNullIndex = G.estimateRoundDifferential({ rating: 70.5, slope: 130 }, holes9, null);
  // base = -24.77, fallbackIndex = max(0, -24.77 * 2) = 0
  // expected9(0) = 1.2
  // total = -24.77 + 1.2 = -23.57 -> -23.6
  near(diffNullIndex, -23.6, 0.1);
});

test("estimateRoundDifferential: missing course/rating/slope/holes returns null", () => {
  assert.equal(G.estimateRoundDifferential(null, [{ score: 4 }]), null);
  assert.equal(G.estimateRoundDifferential({ rating: 70 }, [{ score: 4 }]), null); // no slope
  assert.equal(G.estimateRoundDifferential({ slope: 130 }, [{ score: 4 }]), null); // no rating
  assert.equal(G.estimateRoundDifferential({ rating: 70, slope: 130 }, []), null); // no holes
});

// ---- buildHandicapResult ------------------------------------------------

test("buildHandicapResult: <3 differentials returns null index", () => {
  const result = G.buildHandicapResult([
    { differential: 8.3 },
    { differential: 9.1 }
  ]);
  assert.equal(result.index, null);
  assert.ok(result.note.includes("three rated"));
});

test("buildHandicapResult: 3 differentials uses best 1 with adjustment -2", () => {
  const result = G.buildHandicapResult([
    { differential: 12.0 },
    { differential: 9.0 },
    { differential: 15.0 }
  ]);
  // Best 1: 9.0. Adjustment -2. Index = 9.0 - 2 = 7.0
  near(result.index, 7.0);
  assert.deepEqual(result.rule, { count: 1, adjustment: -2 });
});

test("buildHandicapResult: 8 differentials uses best 2 with no adjustment", () => {
  const result = G.buildHandicapResult([
    { differential: 12 }, { differential: 9 }, { differential: 15 },
    { differential: 11 }, { differential: 13 }, { differential: 8 },
    { differential: 10 }, { differential: 14 }
  ]);
  // Best 2: 8 and 9. Avg = 8.5. No adjustment. Index = 8.5
  near(result.index, 8.5);
  assert.deepEqual(result.rule, { count: 2, adjustment: 0 });
});

test("buildHandicapResult: negative result clamps to 0", () => {
  // Three very low differentials that would average below the adjustment
  const result = G.buildHandicapResult([
    { differential: 1.0 }, { differential: 0.5 }, { differential: 2.0 }
  ]);
  // Best 1: 0.5. Adjustment -2. Raw = -1.5. Clamped to 0.
  near(result.index, 0);
});

// ---- getRatedDifferentialEntries ----------------------------------------

function mkRound(date, courseId, gross, holesCount) {
  const baseScore = Math.floor(gross / holesCount);
  const remainder = gross - baseScore * holesCount;
  const holes = Array.from({ length: holesCount }, (_, i) => ({
    number: i + 1,
    par: 4,
    score: baseScore + (i < remainder ? 1 : 0),
    putts: 2,
    gir: true,
    fairway: "hit",
    penalties: 0
  }));
  return { date, courseId, holes, tee: "White" };
}

test("getRatedDifferentialEntries: skips rounds whose course lookup returns null", () => {
  const rounds = [
    mkRound("2024-01-01", "ridgeview", 85, 18),
    mkRound("2024-01-02", "unknown", 90, 18)
  ];
  const lookup = (id) => (id === "ridgeview" ? { rating: 70.5, slope: 130 } : null);
  const entries = G.getRatedDifferentialEntries(rounds, lookup, null, false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].round.courseId, "ridgeview");
});

test("getRatedDifferentialEntries: 9-hole excluded when includeNineHoleRounds=false", () => {
  const rounds = [
    mkRound("2024-01-01", "rv", 85, 18),
    mkRound("2024-01-02", "rv", 42, 9)
  ];
  const lookup = () => ({ rating: 70.5, slope: 130 });
  const without9 = G.getRatedDifferentialEntries(rounds, lookup, null, false);
  const with9 = G.getRatedDifferentialEntries(rounds, lookup, 10, true);
  assert.equal(without9.length, 1);
  assert.equal(with9.length, 2);
});

test("getRatedDifferentialEntries: 9-hole entries carry the approximate flag", () => {
  const rounds = [mkRound("2024-01-02", "rv", 42, 9)];
  const lookup = () => ({ rating: 70.5, slope: 130 });
  const entries = G.getRatedDifferentialEntries(rounds, lookup, 10, true);
  assert.equal(entries[0].approximate, true);
  assert.ok("nineHoleDifferential" in entries[0]);
  assert.ok("expectedDifferential" in entries[0]);
});

test("getRatedDifferentialEntries: sorted by date desc, capped at 20", () => {
  const rounds = Array.from({ length: 25 }, (_, i) =>
    mkRound(`2024-${String(Math.floor(i / 12) + 1).padStart(2, "0")}-${String((i % 12) + 1).padStart(2, "0")}`, "rv", 80, 18)
  );
  const lookup = () => ({ rating: 70.5, slope: 130 });
  const entries = G.getRatedDifferentialEntries(rounds, lookup, null, false);
  assert.equal(entries.length, 20);
  // First entry should be the most recent date
  const dates = entries.map((e) => e.round.date);
  const sortedDesc = [...dates].sort((a, b) => b.localeCompare(a));
  assert.deepEqual(dates, sortedDesc);
});

// ---- calculateHandicapEstimate ------------------------------------------

test("calculateHandicapEstimate: empty rounds returns null index", () => {
  const result = G.calculateHandicapEstimate([], () => null);
  assert.equal(result.index, null);
  assert.equal(result.approximateNineCount, 0);
});

test("calculateHandicapEstimate: <3 rated rounds returns null index", () => {
  const rounds = [
    mkRound("2024-01-01", "rv", 85, 18),
    mkRound("2024-01-02", "rv", 82, 18)
  ];
  const lookup = () => ({ rating: 70.5, slope: 130 });
  const result = G.calculateHandicapEstimate(rounds, lookup);
  assert.equal(result.index, null);
  assert.ok(result.note.includes("Estimate only"));
});

test("calculateHandicapEstimate: 3 18-hole rounds, best 1 - 2", () => {
  const rounds = [
    mkRound("2024-01-01", "rv", 85, 18), // diff = (85-70.5)*113/130 = 12.6
    mkRound("2024-01-08", "rv", 82, 18), // diff = (82-70.5)*113/130 = 10.0
    mkRound("2024-01-15", "rv", 80, 18)  // diff = (80-70.5)*113/130 = 8.3
  ];
  const lookup = () => ({ rating: 70.5, slope: 130 });
  const result = G.calculateHandicapEstimate(rounds, lookup);
  // Best 1: 8.3. Adjustment -2. Index = 6.3.
  near(result.index, 6.3, 0.05);
  assert.equal(result.eligible.length, 3);
  assert.equal(result.used.length, 1);
});

test("calculateHandicapEstimate: rounds w/o rated course are silently skipped", () => {
  const rounds = [
    mkRound("2024-01-01", "rv", 85, 18),
    mkRound("2024-01-02", "unrated", 75, 18), // skipped
    mkRound("2024-01-08", "rv", 82, 18),
    mkRound("2024-01-15", "rv", 80, 18)
  ];
  const lookup = (id) => (id === "rv" ? { rating: 70.5, slope: 130 } : null);
  const result = G.calculateHandicapEstimate(rounds, lookup);
  assert.equal(result.eligible.length, 3); // only "rv" rounds
  near(result.index, 6.3, 0.05);
});

test("calculateHandicapEstimate: 9-hole rounds mark approximateNineCount", () => {
  const rounds = [
    mkRound("2024-01-01", "rv", 85, 18),
    mkRound("2024-01-08", "rv", 82, 18),
    mkRound("2024-01-15", "rv", 80, 18),
    mkRound("2024-01-22", "rv", 42, 9), // 9-hole, approximate
    mkRound("2024-01-29", "rv", 40, 9)  // 9-hole, approximate
  ];
  const lookup = () => ({ rating: 70.5, slope: 130 });
  const result = G.calculateHandicapEstimate(rounds, lookup);
  assert.equal(result.approximateNineCount, 2);
  assert.ok(result.note.includes("9-hole"));
  // index is positive and finite
  assert.ok(result.index !== null);
  assert.ok(Number.isFinite(result.index));
});

test("calculateHandicapEstimate: 9-hole-only seeds from doubled differentials", () => {
  // Three 9-hole rounds, no 18-hole. Should still produce an index via the
  // estimateSeedIndexFromNineHoleRounds path.
  const rounds = [
    mkRound("2024-01-01", "rv", 42, 9),
    mkRound("2024-01-08", "rv", 40, 9),
    mkRound("2024-01-15", "rv", 38, 9)
  ];
  const lookup = () => ({ rating: 70.5, slope: 130 });
  const result = G.calculateHandicapEstimate(rounds, lookup);
  assert.equal(result.eligible.length, 3);
  assert.equal(result.approximateNineCount, 3);
  assert.ok(result.index !== null);
});

test("calculateHandicapEstimate: 19 rounds uses best 7", () => {
  const rounds = Array.from({ length: 19 }, (_, i) =>
    mkRound(`2024-${String(Math.floor(i / 12) + 1).padStart(2, "0")}-${String((i % 12) + 1).padStart(2, "0")}`, "rv", 80 + i, 18)
  );
  const lookup = () => ({ rating: 70.5, slope: 130 });
  const result = G.calculateHandicapEstimate(rounds, lookup);
  assert.deepEqual(result.rule, { count: 7, adjustment: 0 });
  assert.equal(result.used.length, 7);
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
