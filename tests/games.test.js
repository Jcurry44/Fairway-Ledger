"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../lib/games.js");

// Helpers to build hole arrays tersely.
function hole(number, scores, extra) {
  return { number, par: 4, scores, ...(extra || {}) };
}

// ---- Catalog ---------------------------------------------------------------

test("catalog: every game has the fields the UI needs", () => {
  for (const g of G.GAME_CATALOG) {
    assert.ok(g.id && g.name && g.blurb, g.id);
    assert.ok(Array.isArray(g.players) && g.players.length, g.id);
    assert.ok(Array.isArray(g.rules) && g.rules.length >= 3, g.id);
    assert.ok(Array.isArray(g.holeCounts), g.id);
  }
});

test("gamesForPlayerCount(3) puts Nines (best-with-3) before Skins fallback ordering", () => {
  const games = G.gamesForPlayerCount(3);
  const ids = games.map((g) => g.id);
  assert.ok(ids.includes("nines"));
  assert.ok(ids.includes("skins"));
  assert.ok(!ids.includes("matchplay"));
  assert.ok(!ids.includes("wolf"));
  // best-with-3 games come first
  const ninesIdx = ids.indexOf("nines");
  const stablefordIdx = ids.indexOf("stableford");
  assert.ok(ninesIdx < stablefordIdx);
});

test("gamesForPlayerCount(2) excludes 4-player-only games", () => {
  const ids = G.gamesForPlayerCount(2).map((g) => g.id);
  assert.ok(ids.includes("matchplay"));
  assert.ok(ids.includes("nassau"));
  assert.ok(!ids.includes("bestball"));
  assert.ok(!ids.includes("vegas"));
  assert.ok(!ids.includes("nines"));
});

// ---- Match play -------------------------------------------------------------

test("match play: basic up/down and AS", () => {
  const holes = [
    hole(1, { a: 4, b: 5 }), // a up 1
    hole(2, { a: 4, b: 4 }), // halve
    hole(3, { a: 6, b: 4 })  // b wins, AS
  ];
  const m = G.computeMatchPlay(holes, "a", "b", 18);
  assert.equal(m.thru, 3);
  assert.equal(m.diff, 0);
  assert.equal(m.status, "AS");
  assert.equal(m.done, false);
});

test("match play: closeout reports N&M and ignores later holes", () => {
  // a wins 10 straight: after hole 10, a is 10 up with 8 to play → closed at 10&8
  const holes = [];
  for (let i = 1; i <= 12; i++) holes.push(hole(i, { a: 3, b: 5 }));
  const m = G.computeMatchPlay(holes, "a", "b", 18);
  assert.equal(m.done, true);
  assert.equal(m.winner, 0);
  assert.equal(m.status, "10&8");
  assert.equal(m.thru, 10);
});

test("match play: dormie flagged", () => {
  // 15 holes played, a 3 up, 3 to play
  const holes = [];
  for (let i = 1; i <= 3; i++) holes.push(hole(i, { a: 3, b: 5 }));
  for (let i = 4; i <= 15; i++) holes.push(hole(i, { a: 4, b: 4 }));
  const m = G.computeMatchPlay(holes, "a", "b", 18);
  assert.equal(m.done, false);
  assert.match(m.status, /dormie/);
});

test("match play: incomplete holes are skipped", () => {
  const holes = [hole(1, { a: 4, b: null }), hole(2, { a: 4, b: 5 })];
  const m = G.computeMatchPlay(holes, "a", "b", 18);
  assert.equal(m.thru, 1);
  assert.equal(m.diff, 1);
});

// ---- Nassau -------------------------------------------------------------------

test("nassau: three independent bets", () => {
  const holes = [];
  // a sweeps the front
  for (let i = 1; i <= 9; i++) holes.push(hole(i, { a: 4, b: 5 }));
  // b takes the back narrowly
  for (let i = 10; i <= 18; i++) holes.push(hole(i, { a: 5, b: i === 10 ? 4 : 5 }));
  const n = G.computeNassau(holes, "a", "b");
  assert.equal(n.front.winner, 0);
  assert.equal(n.back.winner, 1);
  assert.equal(n.overall.winner, 0); // a won 9, lost 1, halved 8
});

// ---- Skins ----------------------------------------------------------------------

test("skins: outright win takes the skin, tie pushes", () => {
  const holes = [
    hole(1, { a: 4, b: 4, c: 5 }), // tie a/b → no skin
    hole(2, { a: 3, b: 4, c: 4 })  // a outright
  ];
  const s = G.computeSkins(holes, ["a", "b", "c"], { carryovers: false });
  assert.equal(s.skinsByPlayer.a, 1);
  assert.equal(s.skinsByPlayer.b, 0);
  assert.equal(s.holeOutcomes[0].winner, null);
});

test("skins: carryovers roll the pot", () => {
  const holes = [
    hole(1, { a: 4, b: 4 }), // push, carry 1
    hole(2, { a: 5, b: 5 }), // push, carry 2
    hole(3, { a: 3, b: 4 })  // a takes 3 skins
  ];
  const s = G.computeSkins(holes, ["a", "b"], { carryovers: true });
  assert.equal(s.skinsByPlayer.a, 3);
  assert.equal(s.carrying, 0);
});

test("skins: pot still carrying at the end is reported", () => {
  const holes = [hole(1, { a: 4, b: 4 }), hole(2, { a: 5, b: 5 })];
  const s = G.computeSkins(holes, ["a", "b"], { carryovers: true });
  assert.equal(s.carrying, 2);
});

test("skins: incomplete hole neither awards nor carries", () => {
  const holes = [hole(1, { a: 4, b: null })];
  const s = G.computeSkins(holes, ["a", "b"], { carryovers: true });
  assert.equal(s.carrying, 0);
  assert.equal(s.holeOutcomes.length, 0);
});

// ---- Best ball ---------------------------------------------------------------------

test("best ball: team score is the lower of the pair", () => {
  const holes = [
    hole(1, { a: 6, b: 4, c: 5, d: 5 }) // team1 best 4, team2 best 5 → team1 wins
  ];
  const m = G.computeBestBall(holes, [["a", "b"], ["c", "d"]], 18);
  assert.equal(m.diff, 1);
  assert.equal(m.leader, 0);
});

test("best ball: hole with a missing score on either team is skipped", () => {
  const holes = [hole(1, { a: 4, b: null, c: 5, d: 5 })];
  const m = G.computeBestBall(holes, [["a", "b"], ["c", "d"]], 18);
  assert.equal(m.thru, 0);
});

// ---- Wolf --------------------------------------------------------------------------

test("wolf: partnered win gives each winner 1 point", () => {
  const holes = [
    hole(1, { a: 4, b: 4, c: 5, d: 6 }, { wolf: { wolfId: "a", partnerId: "b", lone: false } })
  ];
  const w = G.computeWolf(holes, ["a", "b", "c", "d"]);
  assert.equal(w.pointsByPlayer.a, 1);
  assert.equal(w.pointsByPlayer.b, 1);
  assert.equal(w.pointsByPlayer.c, 0);
});

test("wolf: lone wolf win pays 3, lone wolf loss pays the pack 1 each", () => {
  const win = [hole(1, { a: 3, b: 4, c: 5, d: 6 }, { wolf: { wolfId: "a", partnerId: null, lone: true } })];
  const wW = G.computeWolf(win, ["a", "b", "c", "d"]);
  assert.equal(wW.pointsByPlayer.a, 3);

  const lose = [hole(1, { a: 5, b: 4, c: 5, d: 6 }, { wolf: { wolfId: "a", partnerId: null, lone: true } })];
  const wL = G.computeWolf(lose, ["a", "b", "c", "d"]);
  assert.equal(wL.pointsByPlayer.a, 0);
  assert.equal(wL.pointsByPlayer.b, 1);
  assert.equal(wL.pointsByPlayer.c, 1);
  assert.equal(wL.pointsByPlayer.d, 1);
});

test("wolf: tie is no blood", () => {
  const holes = [hole(1, { a: 4, b: 5, c: 4, d: 6 }, { wolf: { wolfId: "a", partnerId: "b", lone: false } })];
  const w = G.computeWolf(holes, ["a", "b", "c", "d"]);
  assert.equal(Object.values(w.pointsByPlayer).reduce((s, v) => s + v, 0), 0);
});

test("wolfForHole rotates through setup order", () => {
  const ids = ["a", "b", "c", "d"];
  assert.equal(G.wolfForHole(ids, 0), "a");
  assert.equal(G.wolfForHole(ids, 3), "d");
  assert.equal(G.wolfForHole(ids, 4), "a");
});

// ---- Vegas ----------------------------------------------------------------------------

test("vegas: numbers pair low-first and diff scores points", () => {
  const holes = [hole(1, { a: 4, b: 5, c: 5, d: 6 })]; // A=45, B=56 → +11 for A
  const v = G.computeVegas(holes, [["a", "b"], ["c", "d"]], { birdieFlip: false });
  assert.equal(v.points, 11);
});

test("vegas: birdie flip flips the losing team's number", () => {
  // par 4; a birdies (3). A = 3,5 → 35. B = 4,5 → 45 normally, flipped to 54.
  const holes = [hole(1, { a: 3, b: 5, c: 4, d: 5 })];
  const flip = G.computeVegas(holes, [["a", "b"], ["c", "d"]], { birdieFlip: true });
  assert.equal(flip.points, 54 - 35);
  const noFlip = G.computeVegas(holes, [["a", "b"], ["c", "d"]], { birdieFlip: false });
  assert.equal(noFlip.points, 45 - 35);
});

test("vegas: scores cap at 9 for number building", () => {
  assert.equal(G.vegasNumber([12, 4], false), 49);
  assert.equal(G.vegasNumber([12, 4], true), 94);
});

// ---- Nines -------------------------------------------------------------------------------

test("nines: clean 5/3/1 split", () => {
  const holes = [hole(1, { a: 3, b: 4, c: 5 })];
  const n = G.computeNines(holes, ["a", "b", "c"]);
  assert.equal(n.pointsByPlayer.a, 5);
  assert.equal(n.pointsByPlayer.b, 3);
  assert.equal(n.pointsByPlayer.c, 1);
});

test("nines: two tied for best take 4 each", () => {
  const holes = [hole(1, { a: 4, b: 4, c: 6 })];
  const n = G.computeNines(holes, ["a", "b", "c"]);
  assert.equal(n.pointsByPlayer.a, 4);
  assert.equal(n.pointsByPlayer.b, 4);
  assert.equal(n.pointsByPlayer.c, 1);
});

test("nines: two tied for worst take 2 each", () => {
  const holes = [hole(1, { a: 3, b: 5, c: 5 })];
  const n = G.computeNines(holes, ["a", "b", "c"]);
  assert.equal(n.pointsByPlayer.a, 5);
  assert.equal(n.pointsByPlayer.b, 2);
  assert.equal(n.pointsByPlayer.c, 2);
});

test("nines: all square is 3-3-3, and every hole sums to 9", () => {
  const holes = [hole(1, { a: 4, b: 4, c: 4 }), hole(2, { a: 3, b: 4, c: 4 })];
  const n = G.computeNines(holes, ["a", "b", "c"]);
  const total = Object.values(n.pointsByPlayer).reduce((s, v) => s + v, 0);
  assert.equal(total, 18);
  assert.equal(n.pointsByPlayer.a, 3 + 5);
});

test("nines: throws on wrong player count", () => {
  assert.throws(() => G.computeNines([], ["a", "b"]));
});

// ---- Stableford ----------------------------------------------------------------------------

test("stableford points table", () => {
  assert.equal(G.stablefordPoints(4, 4), 2);  // par
  assert.equal(G.stablefordPoints(3, 4), 3);  // birdie
  assert.equal(G.stablefordPoints(2, 4), 4);  // eagle
  assert.equal(G.stablefordPoints(2, 5), 5);  // albatross
  assert.equal(G.stablefordPoints(5, 4), 1);  // bogey
  assert.equal(G.stablefordPoints(6, 4), 0);  // double
  assert.equal(G.stablefordPoints(9, 4), 0);  // blow-up still 0
});

test("stableford: accumulates per player, skips empty scores", () => {
  const holes = [
    { number: 1, par: 4, scores: { a: 4, b: 6 } },
    { number: 2, par: 3, scores: { a: 2, b: null } }
  ];
  const s = G.computeStableford(holes, ["a", "b"]);
  assert.equal(s.pointsByPlayer.a, 2 + 3);
  assert.equal(s.pointsByPlayer.b, 0);
});

// ---- Bingo Bango Bongo -----------------------------------------------------------------------

test("bingo: three points per hole assigned by tap", () => {
  const holes = [
    { number: 1, par: 4, scores: {}, bingo: { bingo: "a", bango: "b", bongo: "a" } },
    { number: 2, par: 4, scores: {}, bingo: { bingo: "b", bango: null, bongo: null } }
  ];
  const b = G.computeBingo(holes, ["a", "b"]);
  assert.equal(b.pointsByPlayer.a, 2);
  assert.equal(b.pointsByPlayer.b, 2);
});

// ---- Scramble -----------------------------------------------------------------------------------

test("scramble: totals and to-par accumulate only complete holes", () => {
  const holes = [
    { number: 1, par: 4, scores: { t1: 4, t2: 5 } },
    { number: 2, par: 5, scores: { t1: 4, t2: 4 } },
    { number: 3, par: 3, scores: { t1: 3, t2: null } } // incomplete — ignored
  ];
  const s = G.computeScramble(holes, ["t1", "t2"]);
  assert.equal(s.holesPlayed, 2);
  assert.equal(s.parPlayed, 9);
  assert.equal(s.totals.t1, 8);
  assert.equal(s.toPar.t1, -1);
  assert.equal(s.toPar.t2, 0);
  assert.equal(s.leader, 0);
});

test("scramble: single team has no leader, still tracks vs par", () => {
  const holes = [{ number: 1, par: 4, scores: { t1: 3 } }];
  const s = G.computeScramble(holes, ["t1"]);
  assert.equal(s.leader, null);
  assert.equal(s.toPar.t1, -1);
});

test("scramble settlement: lower total takes the stake, tie pushes", () => {
  const g = fakeGame("scramble", ["t1", "t2"]);
  const win = G.computeSettlement(g, { holesPlayed: 9, leader: 1 }, 20);
  assert.equal(win.nets.t2, 20);
  assert.equal(win.nets.t1, -20);
  const tie = G.computeSettlement(g, { holesPlayed: 9, leader: null }, 20);
  assert.deepEqual(tie.transfers, []);
});

test("scramble: in catalog for every player count, entrant-based", () => {
  const meta = G.GAME_BY_ID.scramble;
  assert.equal(meta.entrantLabel, "Team");
  assert.deepEqual(meta.entrantCounts, [1, 2]);
  [2, 3, 4].forEach((n) => {
    assert.ok(G.gamesForPlayerCount(n).some((g) => g.id === "scramble"), `missing for ${n}`);
  });
});

// ---- Settlement --------------------------------------------------------------------------------

function fakeGame(gameType, playerIds, teams) {
  return {
    gameType,
    players: playerIds.map((id) => ({ id, name: id })),
    teams: teams || null
  };
}

test("settlement: null without a stake", () => {
  const g = fakeGame("matchplay", ["a", "b"]);
  assert.equal(G.computeSettlement(g, { winner: 0 }, 0), null);
  assert.equal(G.computeSettlement(g, { winner: 0 }, null), null);
});

test("settlement: match play winner takes the stake", () => {
  const g = fakeGame("matchplay", ["a", "b"]);
  const s = G.computeSettlement(g, { winner: 1 }, 10);
  assert.equal(s.nets.b, 10);
  assert.equal(s.nets.a, -10);
  assert.deepEqual(s.transfers, [{ from: "a", to: "b", amount: 10 }]);
});

test("settlement: match play called early pays whoever is up (the 9-of-18 bug)", () => {
  // The real-world repro: an 18-hole match, the group stops after 9 with a
  // clear leader, taps Finish. Pre-fix this settled as "all square" while
  // the standings read "9 UP" on the same screen.
  const g = fakeGame("matchplay", ["a", "b"]);
  const early = G.computeSettlement(g, { winner: null, leader: 0, thru: 9, done: false }, 5);
  assert.equal(early.nets.a, 5);
  assert.equal(early.nets.b, -5);
});

test("settlement: match play called early while all square pushes", () => {
  const g = fakeGame("matchplay", ["a", "b"]);
  const s = G.computeSettlement(g, { winner: null, leader: null, thru: 9, done: false }, 5);
  assert.deepEqual(s.transfers, []);
});

test("settlement: match play with zero holes entered pushes", () => {
  const g = fakeGame("matchplay", ["a", "b"]);
  const s = G.computeSettlement(g, { winner: null, leader: null, thru: 0, done: false }, 5);
  assert.deepEqual(s.transfers, []);
});

test("settlement: nassau called early pays started bets on the lead, skips untouched bets", () => {
  // 9 holes of a Nassau: front decided, back never started, overall mid-way.
  const g = fakeGame("nassau", ["a", "b"]);
  const computed = {
    front: { winner: 1, leader: 1, thru: 9, done: true },
    back: { winner: null, leader: null, thru: 0, done: false },
    overall: { winner: null, leader: 1, thru: 9, done: false }
  };
  const s = G.computeSettlement(g, computed, 5);
  assert.equal(s.nets.b, 10); // front + overall on the lead; back untouched
  assert.equal(s.nets.a, -10);
});

test("settlement: best ball called early pays the leading team per player", () => {
  const g = fakeGame("bestball", ["a", "b", "c", "d"], [["a", "b"], ["c", "d"]]);
  const s = G.computeSettlement(g, { winner: null, leader: 1, thru: 6, done: false }, 5);
  assert.equal(s.nets.c, 5);
  assert.equal(s.nets.d, 5);
  assert.equal(s.nets.a, -5);
  assert.equal(s.nets.b, -5);
});

test("matchBetWinner: finished match → winner, live match → leader, untouched → null", () => {
  assert.equal(G.matchBetWinner({ winner: 1, leader: 1, thru: 18, done: true }), 1);
  assert.equal(G.matchBetWinner({ winner: null, leader: 0, thru: 4, done: false }), 0);
  assert.equal(G.matchBetWinner({ winner: null, leader: null, thru: 0, done: false }), null);
  assert.equal(G.matchBetWinner(null), null);
});

test("settlement: nassau sums the three bets", () => {
  const g = fakeGame("nassau", ["a", "b"]);
  const computed = {
    front: { winner: 0 },
    back: { winner: 1 },
    overall: { winner: 0 }
  };
  const s = G.computeSettlement(g, computed, 5);
  assert.equal(s.nets.a, 5); // won 2 bets, lost 1 → +5
  assert.equal(s.nets.b, -5);
});

test("settlement: skins nets are zero-sum across 3 players", () => {
  const g = fakeGame("skins", ["a", "b", "c"]);
  const computed = { skinsByPlayer: { a: 3, b: 1, c: 0 } };
  const s = G.computeSettlement(g, computed, 2);
  const sum = Object.values(s.nets).reduce((x, y) => x + y, 0);
  assert.equal(Math.abs(sum) < 0.001, true);
  // a: 3 skins × $2 from 2 others = +12 minus 1 skin owed to b ×$2 = -2 → +10
  assert.equal(s.nets.a, 10);
});

test("settlement: nines point-difference nets are zero-sum", () => {
  const g = fakeGame("nines", ["a", "b", "c"]);
  const computed = { pointsByPlayer: { a: 50, b: 45, c: 40 } };
  const s = G.computeSettlement(g, computed, 1);
  const sum = Object.values(s.nets).reduce((x, y) => x + y, 0);
  assert.equal(Math.abs(sum) < 0.001, true);
  assert.equal(s.nets.a, 3 * 50 - 135); // +15
  assert.equal(s.nets.c, 3 * 40 - 135); // -15
});

test("settlement: vegas pays per player on team", () => {
  const g = fakeGame("vegas", ["a", "b", "c", "d"], [["a", "b"], ["c", "d"]]);
  const s = G.computeSettlement(g, { points: -7 }, 1); // team B up 7
  assert.equal(s.nets.c, 7);
  assert.equal(s.nets.a, -7);
});

test("settlement: transfers settle exactly", () => {
  const nets = { a: 15, b: -10, c: -5 };
  const t = G.settleTransfers(nets);
  const paid = t.reduce((s, x) => s + x.amount, 0);
  assert.equal(paid, 15);
  t.forEach((x) => assert.ok(["b", "c"].includes(x.from)));
  t.forEach((x) => assert.equal(x.to, "a"));
});
