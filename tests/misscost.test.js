/*
 * Unit tests for lib/misscost.js — the Miss Cost map.
 *
 * Run:  node --test tests/*.test.js
 * (Uses only the Node built-in test runner + assert — no dependencies.)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../lib/misscost.js");

// ---- Fixtures ----------------------------------------------------------------

// A round from a list of hole specs: { par, score, fairway?, bunker?, putts?, penalties? }.
// Unset fields stay "not entered": fairway "" (par 3 => "na"), bunker "", putts null.
function round(id, date, holes, entryMode) {
  return {
    id,
    date,
    courseId: "ridge",
    entryMode: entryMode || "detailed",
    holes: holes.map((h, i) => ({
      number: i + 1,
      label: String(i + 1),
      par: h.par,
      score: h.score,
      fairway: h.fairway != null ? h.fairway : (h.par === 3 ? "na" : ""),
      bunker: h.bunker != null ? h.bunker : "",
      putts: h.putts != null ? h.putts : null,
      penalties: h.penalties || 0
    }))
  };
}
const rep = (n, spec) => Array.from({ length: n }, () => Object.assign({}, spec));
const bucket = (res, id) => res.ranked.concat(res.thin, res.free).find((b) => b.id === id) || null;

// ---- Pricing ---------------------------------------------------------------------

test("tee misses are priced against fairways hit on the same par", () => {
  // Par 4s: 6 fairways at 4.5 avg (alternating 4/5), 6 rights at 5.5 avg.
  const holes = []
    .concat(rep(3, { par: 4, score: 4, fairway: "hit" }), rep(3, { par: 4, score: 5, fairway: "hit" }))
    .concat(rep(3, { par: 4, score: 5, fairway: "right" }), rep(3, { par: 4, score: 6, fairway: "right" }))
    .concat(rep(6, { par: 3, score: 3 }));
  const res = M.computeMissCost([round("a", "2026-05-01", holes)]);
  const right = bucket(res, "tee-right");
  assert.equal(right.status, "costs");
  assert.equal(right.n, 6);
  assert.equal(right.perMiss, 1);
  // 6 rights in 18 holes played = 6 per 18 -> 6 strokes per 18.
  assert.equal(right.freq18, 6);
  assert.equal(right.per18, 6);
  // 6 misses vs 6 clean holes is a price, but an early read (under 10 a side):
  // the headline won't promote it, the UI offers it as an early leader.
  assert.equal(right.early, true);
  assert.equal(res.biggest, null);
  assert.equal(res.earlyLeader.id, "tee-right");
  assert.deepEqual(right.pars.map((p) => [p.par, p.misses, p.missAvg, p.clean, p.cleanAvg, p.diff]), [[4, 6, 5.5, 6, 4.5, 1]]);
});

test("pars are matched: a par-5 habit isn't blamed on the miss", () => {
  // Fairways: par 4 at 4.0 (x5), par 5 at 6.0 (x5). Lefts: all on par 4 at 4.5 (x5).
  // Unmatched average would compare 4.5-4 = +0.5 per miss vs a pooled baseline
  // of +0.5 over par -> 0. Matched by par it's +0.5 a miss.
  const holes = []
    .concat(rep(5, { par: 4, score: 4, fairway: "hit" }), rep(5, { par: 5, score: 6, fairway: "hit" }))
    .concat(rep(2, { par: 4, score: 4, fairway: "left" }), rep(3, { par: 4, score: 5, fairway: "left" }))
    .concat(rep(3, { par: 3, score: 3 }));
  const left = bucket(M.computeMissCost([round("a", "2026-05-01", holes)]), "tee-left");
  assert.equal(left.perMiss, 0.6);
  assert.equal(left.matched, 5);
  assert.equal(left.baseline, 5); // only the par-4 fairways are compared
});

test("misses on a par with no clean holes to compare are left out, not guessed", () => {
  const holes = []
    .concat(rep(5, { par: 4, score: 4, fairway: "hit" }))
    .concat(rep(5, { par: 4, score: 5, fairway: "right" }), rep(2, { par: 5, score: 7, fairway: "right" }));
  const right = bucket(M.computeMissCost([round("a", "2026-05-01", holes)]), "tee-right");
  assert.equal(right.n, 7);
  assert.equal(right.matched, 5);
  assert.equal(right.unmatched, 2);
  assert.equal(right.perMiss, 1);
});

test("fewer than 5 misses or 5 clean holes is 'thin', with counts and no price", () => {
  const holes = rep(5, { par: 4, score: 4, fairway: "hit" }).concat(rep(3, { par: 4, score: 6, fairway: "left" }));
  const res = M.computeMissCost([round("a", "2026-05-01", holes)]);
  const left = bucket(res, "tee-left");
  assert.equal(left.status, "thin");
  assert.equal(left.n, 3);
  assert.equal(left.perMiss, null);
  assert.equal(left.per18, null);
  assert.equal(res.ranked.length, 0);
  assert.equal(res.biggest, null);
  assert.equal(res.thin[0].id, "tee-left");
});

test("a miss that costs nothing is reported as free, never as a negative cost in the ranking", () => {
  const holes = rep(5, { par: 4, score: 5, fairway: "hit" }).concat(rep(5, { par: 4, score: 4, fairway: "short" }));
  const res = M.computeMissCost([round("a", "2026-05-01", holes)]);
  const short = bucket(res, "tee-short");
  assert.equal(short.status, "free");
  assert.equal(short.perMiss, -1);
  assert.equal(res.ranked.length, 0);
  assert.equal(res.free[0].id, "tee-short");
});

// ---- Review fixes (Fable build review 2026-10-16) -----------------------------------

test("10+ holes a side is a firm price that can headline", () => {
  const holes = rep(10, { par: 4, score: 4, fairway: "hit" }).concat(rep(10, { par: 4, score: 5, fairway: "right" }));
  const res = M.computeMissCost([round("a", "2026-05-01", holes.slice(0, 10)), round("b", "2026-05-02", holes.slice(10))]);
  const right = bucket(res, "tee-right");
  assert.equal(right.early, false);
  assert.equal(res.biggest.id, "tee-right");
  assert.equal(res.earlyLeader, null);
});

test("a par needs 3 clean holes before its misses are compared", () => {
  // 4 par-4 rights (+1 vs 20 clean par 4s) and 1 par-5 right vs a single clean
  // par 5 that was an eagle: the par-5 cell is left out, so it stays +1.0.
  const holes = []
    .concat(rep(20, { par: 4, score: 4, fairway: "hit" }), rep(5, { par: 4, score: 5, fairway: "right" }))
    .concat([{ par: 5, score: 3, fairway: "hit" }, { par: 5, score: 6, fairway: "right" }]);
  const right = bucket(M.computeMissCost([round("a", "2026-05-01", holes)]), "tee-right");
  assert.equal(right.perMiss, 1);
  assert.equal(right.unmatched, 1);
  const p5 = right.pars.find((p) => p.par === 5);
  assert.equal(p5.diff, null);
  assert.equal(p5.clean, 1);
});

test("per-18 frequency uses the logged rate when putts or tee chips are optional per hole", () => {
  // Putts entered on 9 of 18 holes, 3 of them 3-putts: 6 per 18, not 3.
  const holes = []
    .concat(rep(3, { par: 4, score: 6, putts: 3 }), rep(6, { par: 4, score: 4, putts: 2 }))
    .concat(rep(9, { par: 4, score: 5 }));
  const many = [1, 2, 3].map((i) => round(`r${i}`, `2026-05-0${i}`, holes));
  const three = bucket(M.computeMissCost(many), "three-putt");
  assert.equal(three.freq18, 6);
  // Tee: par 3s aren't eligible, so 2 rights in 6 logged par 4s of a round with
  // 12 par 4/5s out of 18 holes = 2/6 x 12 = 4 per 18.
  const tee = []
    .concat(rep(2, { par: 4, score: 5, fairway: "right" }), rep(4, { par: 4, score: 4, fairway: "hit" }))
    .concat(rep(6, { par: 4, score: 4 }), rep(6, { par: 3, score: 3 }));
  const right = bucket(M.computeMissCost([1, 2, 3].map((i) => round(`t${i}`, `2026-05-1${i}`, tee))), "tee-right");
  assert.equal(right.freq18, 4);
});

test("a cost that rounds below 0.1 per 18 is 'no cost so far', not a ranked leak", () => {
  // Rare and nearly free: 10 long tee shots in 216 holes, only one a stroke
  // worse -> +0.1 a miss x 0.83 per 18 = 0.08 per 18.
  const r = Array.from({ length: 12 }, (_, i) => {
    const holes = rep(18, { par: 4, score: 4, fairway: "hit" });
    if (i < 10) holes[0] = { par: 4, score: i === 0 ? 5 : 4, fairway: "long" };
    return round(`x${i}`, `2026-06-${String(i + 1).padStart(2, "0")}`, holes);
  });
  const res = M.computeMissCost(r);
  const b = bucket(res, "tee-long");
  assert.ok(b.perMiss > 0);
  assert.equal(b.status, "free");
  assert.equal(res.ranked.some((x) => x.id === "tee-long"), false);
});

test("sand: in a round that logged sand anywhere, a blank hole counts as 'no sand' (Quick entry)", () => {
  // Quick entry writes a bunker value only when you were in sand.
  const quick = (id, d) => round(id, d, []
    .concat(rep(2, { par: 4, score: 5, bunker: "greenside" }))
    .concat(rep(4, { par: 4, score: 4 })), "quick");
  const res = M.computeMissCost([quick("a", "2026-05-01"), quick("b", "2026-05-02"), quick("c", "2026-05-03")]);
  const g = bucket(res, "sand-greenside");
  assert.equal(g.n, 6);
  assert.equal(g.baseline, 12);
  assert.equal(g.perMiss, 1);
  // A round with no bunker value anywhere still tells us nothing about sand.
  const blank = round("z", "2026-05-04", rep(6, { par: 4, score: 4 }));
  assert.equal(M.computeMissCost([blank]).families.find((f) => f.id === "sand").knownHoles, 0);
});

test("a miss that would print '+0.0 a miss' is no cost, however often it happens", () => {
  // 30 rights at +0.03 each (one +1 in 30): frequent but effectively free.
  const holes = rep(30, { par: 4, score: 4, fairway: "hit" }).concat(rep(29, { par: 4, score: 4, fairway: "right" }), [{ par: 4, score: 5, fairway: "right" }]);
  const b = bucket(M.computeMissCost([round("a", "2026-05-01", holes)]), "tee-right");
  assert.equal(b.status, "free");
});

test("arrow glyphs ask for text presentation (never colour emoji)", () => {
  const tee = M.FAMILIES.find((f) => f.id === "tee");
  assert.ok(tee.buckets.find((b) => b.id === "tee-left").glyph.endsWith("\uFE0E"));
  assert.ok(tee.buckets.find((b) => b.id === "tee-right").glyph.endsWith("\uFE0E"));
});

// ---- Honest data ---------------------------------------------------------------------

test("speed rounds and blank fields stay out", () => {
  const detail = round("d", "2026-05-01", []
    .concat(rep(5, { par: 4, score: 4, fairway: "hit", putts: 2 }))
    .concat(rep(5, { par: 4, score: 5, fairway: "right", putts: 3 }))
    .concat(rep(4, { par: 4, score: 9 }))); // nothing entered: no fairway, putts, bunker
  const speed = round("s", "2026-05-02", rep(10, { par: 4, score: 8, fairway: "right", putts: 3 }), "speed");
  const res = M.computeMissCost([detail, speed]);
  assert.equal(res.rounds, 1);
  assert.equal(res.speedRounds, 1);
  const right = bucket(res, "tee-right");
  assert.equal(right.n, 5);
  assert.equal(right.perMiss, 1);
  const tee = res.families.find((f) => f.id === "tee");
  assert.equal(tee.knownHoles, 10);
  // Sand was never entered: no sand rows at all.
  assert.equal(res.families.find((f) => f.id === "sand").knownHoles, 0);
  assert.equal(res.families.find((f) => f.id === "sand").buckets.length, 0);
  assert.deepEqual(M.missingData(res), ["sand"]);
});

test("3-putts are priced against 1-2 putt holes; chip-ins (0 putts) and blanks are skipped", () => {
  const holes = []
    .concat(rep(3, { par: 4, score: 4, putts: 2 }), rep(3, { par: 4, score: 4, putts: 1 }))
    .concat(rep(5, { par: 4, score: 6, putts: 3 }))
    .concat(rep(2, { par: 4, score: 3, putts: 0 }))
    .concat(rep(2, { par: 4, score: 9 }));
  const three = bucket(M.computeMissCost([round("a", "2026-05-01", holes)]), "three-putt");
  assert.equal(three.n, 5);
  assert.equal(three.baseline, 6);
  assert.equal(three.perMiss, 2);
});

test("sand by kind against holes marked 'no sand'; penalties against holes without one", () => {
  const holes = []
    .concat(rep(6, { par: 4, score: 4, bunker: "none" }))
    .concat(rep(5, { par: 4, score: 5, bunker: "greenside" }))
    .concat(rep(5, { par: 4, score: 6, bunker: "fairway", penalties: 1 }));
  const res = M.computeMissCost([round("a", "2026-05-01", holes)]);
  assert.equal(bucket(res, "sand-greenside").perMiss, 1);
  assert.equal(bucket(res, "sand-fairway").perMiss, 2);
  const pen = bucket(res, "penalty");
  assert.equal(pen.n, 5);
  assert.equal(pen.baseline, 11);
  assert.equal(pen.perMiss, 1.55); // 2 over par vs 5/11 over par on the 11 clean holes = 1.545
});

test("frequency is per 18 holes played in rounds that logged the field (9-hole rounds count half)", () => {
  // Two nines, each with 2 rights + 3 fairways + 4 par 3s: 4 rights in 18 holes = 4 per 18.
  const nine = (id, d) => round(id, d, []
    .concat(rep(3, { par: 4, score: 4, fairway: "hit" }), rep(2, { par: 4, score: 5, fairway: "right" }), rep(4, { par: 3, score: 3 })));
  const res = M.computeMissCost([nine("a", "2026-05-01"), nine("b", "2026-05-02"), nine("c", "2026-05-03")]);
  const right = bucket(res, "tee-right");
  assert.equal(right.freq18, 4);
  assert.equal(right.perMiss, 1);
  assert.equal(right.per18, 4);
});

test("ranking: biggest strokes per 18 first, and the total adds up", () => {
  const holes = []
    .concat(rep(10, { par: 4, score: 4, fairway: "hit", putts: 2 }))
    .concat(rep(5, { par: 4, score: 5, fairway: "left", putts: 2 }))
    .concat(rep(3, { par: 4, score: 4, fairway: "hit", putts: 1 }));
  const r1 = round("a", "2026-05-01", holes);
  const r2 = round("b", "2026-05-02", []
    .concat(rep(5, { par: 4, score: 6, fairway: "right", putts: 3 }))
    .concat(rep(13, { par: 4, score: 4, fairway: "hit", putts: 2 })));
  const res = M.computeMissCost([r1, r2]);
  assert.deepEqual(res.ranked.map((b) => b.id), ["tee-right", "three-putt", "tee-left"]);
  assert.equal(res.totalPer18, Math.round(res.ranked.reduce((s, b) => s + b.per18, 0) * 10) / 10);
});

test("each bucket lists its holes newest first, ready to drill into", () => {
  const a = round("a", "2026-05-01", rep(5, { par: 4, score: 4, fairway: "hit" }).concat(rep(3, { par: 4, score: 5, fairway: "right" })));
  const b = round("b", "2026-06-01", rep(5, { par: 4, score: 4, fairway: "hit" }).concat(rep(3, { par: 4, score: 6, fairway: "right" })));
  const right = bucket(M.computeMissCost([a, b]), "tee-right");
  assert.equal(right.holes.length, 6);
  assert.equal(right.holes[0].roundId, "b");
  assert.deepEqual(Object.keys(right.holes[0]).sort(), ["courseId", "date", "label", "number", "par", "roundId", "score", "vsPar"]);
});

test("empty and odd inputs don't throw; input is never mutated", () => {
  assert.equal(M.computeMissCost([]).rounds, 0);
  assert.equal(M.computeMissCost(null).ranked.length, 0);
  assert.equal(M.missingData(M.computeMissCost([])), null);
  const rounds = [round("a", "2026-05-01", rep(6, { par: 4, score: 4, fairway: "hit" }).concat(rep(6, { par: 4, score: 5, fairway: "left" })))];
  const before = JSON.stringify(rounds);
  M.computeMissCost(rounds, { minSample: 2 });
  assert.equal(JSON.stringify(rounds), before);
});
