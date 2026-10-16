/*
 * Unit tests for lib/eclectic.js — eclectic boards, round deltas, record diffs.
 *
 * Run:  node --test tests/*.test.js
 * (Uses only the Node built-in test runner + assert — no dependencies.)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../lib/golf-math.js");
const E = require("../lib/eclectic.js");

// ---- Fixtures: real identity from golf-math + a tiny local courseKey -------

// Pool tee variants into one physical course (what app.js physicalCourseName
// does): every Deerwood id is one course; "<course>-<tee>" collapses to
// "<course>".
function courseKey(round) {
  const id = String(round.courseId || "");
  if (G.isDeerwoodCourseId(id)) return "deerwood";
  return id.replace(/-(black|gold|green|silver|burgundy|blue|white|red)$/, "");
}

// Deerwood hole identity comes from the real GolfMath.physicalHoleId (label
// "Buck 3" => "deerwood:buck:3"). Other courses key by physical course +
// number, so tee variants share a hole (physicalHoleId alone keeps courseId).
function holeKey(round, hole) {
  if (G.isDeerwoodCourseId(round.courseId)) return G.physicalHoleId(round.courseId, hole);
  return `${courseKey(round)}:${hole.number}`;
}

// Deerwood nine name ("buck") as the group; null elsewhere => 'all'.
function groupKey(round, hole) {
  const match = String(hole.label || "").match(/^(buck|doe|fawn)\s+\d+$/i);
  return G.isDeerwoodCourseId(round.courseId) && match ? match[1].toLowerCase() : null;
}

const OPTS = { courseKey, holeKey, groupKey };

const PARS9 = [4, 3, 5, 4, 4, 3, 4, 5, 4]; // 36

// A round on a plain course. `scores` may contain null for "not entered".
function round(id, date, courseId, scores, pars) {
  const parList = pars || PARS9;
  return {
    id,
    date,
    courseId,
    entryMode: "hole",
    holes: scores.map((score, index) => ({
      number: index + 1,
      label: String(index + 1),
      par: parList[index % parList.length],
      score
    }))
  };
}

const NINE_PARS = {
  buck: [5, 3, 4, 4, 4, 4, 5, 3, 4],
  doe: [4, 4, 3, 5, 4, 4, 3, 4, 5],
  fawn: [4, 5, 3, 4, 4, 3, 5, 4, 4]
};

// A Deerwood round over the given nines in order (e.g. ["buck","doe"]).
function deerwood(id, date, courseId, nines, scoresByNine) {
  const holes = [];
  nines.forEach((nine, nineIndex) => {
    NINE_PARS[nine].forEach((par, index) => {
      holes.push({
        number: nineIndex * 9 + index + 1,
        label: `${nine[0].toUpperCase()}${nine.slice(1)} ${index + 1}`,
        par,
        score: scoresByNine[nine][index]
      });
    });
  });
  return { id, date, courseId, entryMode: "hole", holes };
}

function fill(value, count = 9) {
  return Array.from({ length: count }, () => value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

// ---- buildBoards: single course -----------------------------------------

test("buildBoards: best-ever per hole sums to the dream-round total", () => {
  const rounds = [
    round("r1", "2026-05-01", "ridgeview-blue", [5, 4, 6, 5, 4, 4, 5, 6, 5]),
    round("r2", "2026-06-01", "ridgeview-blue", [4, 3, 6, 4, 5, 3, 5, 5, 4])
  ];
  const board = E.buildBoards(rounds, OPTS).get("ridgeview");
  assert.ok(board);
  assert.equal(board.courseKey, "ridgeview");
  assert.equal(board.holes.size, 9);
  // best per hole: 4,3,6,4,4,3,5,5,4
  assert.equal(board.total, 38);
  assert.equal(board.par, 36);
  assert.equal(board.plays, 2);
  const hole1 = board.holes.get("ridgeview:1");
  assert.equal(hole1.best, 4);
  assert.equal(hole1.bestVsPar, 0);
  assert.equal(hole1.bestDate, "2026-06-01");
  assert.equal(hole1.bestRoundId, "r2");
  assert.equal(hole1.plays, 2);
  assert.equal(hole1.sumVsPar, 1); // +1, then 0
  assert.equal(hole1.avgVsPar, 0.5);
  assert.equal(hole1.lastScore, 4);
  assert.equal(hole1.birdieOrBetter, false);
  const hole2 = board.holes.get("ridgeview:2");
  assert.equal(hole2.best, 3);
  assert.equal(hole2.bestVsPar, 0);
  assert.equal(hole2.lastScore, 3);
});

test("buildBoards: non-grouped course gets one 'all' group; complete needs 18 by default", () => {
  const nine = E.buildBoards([round("r1", "2026-05-01", "ridgeview-blue", [4, 3, 5, 4, 4, 3, 4, 5, 4])], OPTS).get("ridgeview");
  assert.deepEqual([...nine.groups.keys()], ["all"]);
  const all = nine.groups.get("all");
  assert.equal(all.holeKeys.length, 9);
  assert.equal(all.total, 36);
  assert.equal(all.par, 36);
  assert.equal(all.complete, false);

  const eighteen = round("r2", "2026-05-02", "ridgeview-blue", fill(5, 18), PARS9);
  const full = E.buildBoards([eighteen], OPTS).get("ridgeview");
  assert.equal(full.groups.get("all").complete, true);

  // A 9-hole course can say so via expectedHoles.
  const small = E.buildBoards(
    [round("r3", "2026-05-03", "cross-creek-1-white", fill(4))],
    Object.assign({}, OPTS, { expectedHoles: () => 9 })
  ).get("cross-creek-1");
  assert.equal(small.groups.get("all").complete, true);
});

test("buildBoards: tee variants pool into one physical course via courseKey", () => {
  const rounds = [
    round("r1", "2026-05-01", "diamond-hawk-black", [6, 5, 7, 6, 6, 5, 6, 7, 6]),
    round("r2", "2026-05-08", "diamond-hawk-gold", [5, 6, 7, 5, 6, 5, 7, 6, 6]),
    round("r3", "2026-05-15", "ridgeview-blue", fill(4))
  ];
  const boards = E.buildBoards(rounds, OPTS);
  assert.deepEqual([...boards.keys()].sort(), ["diamond-hawk", "ridgeview"]);
  const dh = boards.get("diamond-hawk");
  assert.equal(dh.holes.size, 9);
  assert.equal(dh.plays, 2);
  assert.equal(dh.holes.get("diamond-hawk:1").best, 5);
  assert.equal(dh.holes.get("diamond-hawk:1").bestRoundId, "r2");
  assert.equal(dh.holes.get("diamond-hawk:2").best, 5);
  assert.equal(dh.holes.get("diamond-hawk:2").bestRoundId, "r1");
  assert.equal(dh.total, 5 + 5 + 7 + 5 + 6 + 5 + 6 + 6 + 6);
});

// ---- buildBoards: Deerwood ----------------------------------------------

test("buildBoards: Deerwood nines pool across routings and tees, with per-nine totals", () => {
  const front = deerwood("d1", "2026-06-01", "deerwood-buck-doe-white", ["buck", "doe"], {
    buck: [6, 4, 5, 5, 5, 5, 6, 4, 5],
    doe: [5, 5, 4, 6, 5, 5, 4, 5, 6]
  });
  // Doe plays first here, so Doe 4 is hole number 4 on one card and 13 on the other.
  const back = deerwood("d2", "2026-06-15", "deerwood-doe-buck-blue", ["doe", "buck"], {
    doe: [4, 5, 4, 5, 5, 5, 4, 5, 6],
    buck: [5, 4, 4, 5, 4, 5, 6, 3, 5]
  });
  const boards = E.buildBoards([front, back], OPTS);
  assert.deepEqual([...boards.keys()], ["deerwood"]);
  const board = boards.get("deerwood");
  assert.equal(board.holes.size, 18);
  assert.equal(board.plays, 2);

  const doe4 = board.holes.get("deerwood:doe:4");
  assert.equal(doe4.plays, 2);
  assert.equal(doe4.best, 5);
  assert.equal(doe4.label, "Doe 4");
  assert.equal(doe4.group, "doe");
  assert.equal(doe4.bestRoundId, "d2");

  assert.deepEqual([...board.groups.keys()], ["buck", "doe"]);
  const buck = board.groups.get("buck");
  const doe = board.groups.get("doe");
  assert.equal(buck.holeKeys.length, 9);
  assert.equal(doe.holeKeys.length, 9);
  assert.equal(buck.complete, true);
  assert.equal(doe.complete, true);
  // best Buck: min of [6,4,5,5,5,5,6,4,5] and [5,4,4,5,4,5,6,3,5]
  assert.equal(buck.total, 5 + 4 + 4 + 5 + 4 + 5 + 6 + 3 + 5);
  assert.equal(buck.par, 36);
  // best Doe: min of [5,5,4,6,5,5,4,5,6] and [4,5,4,5,5,5,4,5,6]
  assert.equal(doe.total, 4 + 5 + 4 + 5 + 5 + 5 + 4 + 5 + 6);
  assert.equal(board.total, buck.total + doe.total);
  assert.equal(board.par, buck.par + doe.par);
  assert.deepEqual(buck.holeKeys[0], "deerwood:buck:1");
});

test("buildBoards: a nine with fewer than 9 holes is not complete", () => {
  const partial = deerwood("d1", "2026-06-01", "deerwood-fawn-blue", ["fawn"], {
    fawn: [4, 5, 3, 4, 4, 3, null, null, null]
  });
  const fawn = E.buildBoards([partial], OPTS).get("deerwood").groups.get("fawn");
  assert.equal(fawn.holeKeys.length, 6);
  assert.equal(fawn.complete, false);
});

// ---- buildBoards: filtering + determinism --------------------------------

test("buildBoards: unscored, null, zero and non-finite holes are ignored", () => {
  const messy = round("r1", "2026-05-01", "ridgeview-blue", [4, null, 0, NaN, Infinity, -2, "five", undefined, 3]);
  const empty = { id: "r2", date: "2026-05-02", courseId: "ridgeview-blue", holes: [] };
  const allNull = round("r3", "2026-05-03", "glen-oak-white", fill(null));
  const boards = E.buildBoards([messy, empty, allNull, null], OPTS);
  assert.deepEqual([...boards.keys()], ["ridgeview"]); // glen-oak never played
  const board = boards.get("ridgeview");
  assert.equal(board.holes.size, 2);
  assert.equal(board.plays, 1);
  assert.equal(board.total, 7);
  assert.ok(board.holes.has("ridgeview:1"));
  assert.ok(board.holes.has("ridgeview:9"));
});

test("buildBoards: equal scores keep the earliest round regardless of input order", () => {
  const early = round("a", "2026-05-01", "ridgeview-blue", fill(4));
  const late = round("b", "2026-07-01", "ridgeview-blue", fill(4));
  const sameDayLaterId = round("c", "2026-05-01", "ridgeview-blue", fill(4));
  [[late, sameDayLaterId, early], [early, late, sameDayLaterId], [sameDayLaterId, early, late]].forEach((order) => {
    const cell = E.buildBoards(order, OPTS).get("ridgeview").holes.get("ridgeview:1");
    assert.equal(cell.bestRoundId, "a");
    assert.equal(cell.bestDate, "2026-05-01");
    assert.equal(cell.plays, 3);
  });
  // Same date: lower id wins.
  const dayTie = E.buildBoards([sameDayLaterId, round("b0", "2026-05-01", "ridgeview-blue", fill(4))], OPTS);
  assert.equal(dayTie.get("ridgeview").holes.get("ridgeview:1").bestRoundId, "b0");
});

test("buildBoards: birdieOrBetter and lastScore follow play order", () => {
  const rounds = [
    round("r1", "2026-05-01", "ridgeview-blue", [3, 4, 5, 4, 4, 3, 4, 5, 4]), // birdie on 1
    round("r2", "2026-06-01", "ridgeview-blue", [6, 4, 5, 4, 4, 3, 4, 5, 4])
  ];
  const board = E.buildBoards(rounds, OPTS).get("ridgeview");
  const h1 = board.holes.get("ridgeview:1");
  assert.equal(h1.birdieOrBetter, true);
  assert.equal(h1.best, 3);
  assert.equal(h1.lastScore, 6);
  assert.equal(board.holes.get("ridgeview:2").birdieOrBetter, false);
});

test("buildBoards: exceptRoundId leaves that round out of the board", () => {
  const rounds = [
    round("r1", "2026-05-01", "ridgeview-blue", fill(5)),
    round("r2", "2026-06-01", "ridgeview-blue", fill(4))
  ];
  const withAll = E.buildBoards(rounds, OPTS).get("ridgeview");
  assert.equal(withAll.total, 36);
  const without = E.buildBoards(rounds, Object.assign({}, OPTS, { exceptRoundId: "r2" })).get("ridgeview");
  assert.equal(without.total, 45);
  assert.equal(without.plays, 1);
  const none = E.buildBoards([rounds[1]], Object.assign({}, OPTS, { exceptRoundId: "r2" }));
  assert.equal(none.size, 0);
});

test("buildBoards: defaults work without options (courseId + hole number)", () => {
  const board = E.buildBoards([round("r1", "2026-05-01", "ridgeview-blue", fill(4))]).get("ridgeview-blue");
  assert.equal(board.holes.size, 9);
  assert.ok(board.holes.has("ridgeview-blue:1"));
  assert.equal(E.buildBoards(null).size, 0);
});

// ---- nemesis -------------------------------------------------------------

test("nemesis: worst average vs par among holes with enough plays", () => {
  const rounds = [
    round("r1", "2026-05-01", "ridgeview-blue", [4, 7, 5, 4, 4, 3, 4, 5, 4]),
    round("r2", "2026-05-08", "ridgeview-blue", [4, 6, 5, 4, 4, 3, 4, 5, 4]),
    round("r3", "2026-05-15", "ridgeview-blue", [4, 5, 5, 4, 4, 3, 4, 5, 9]),
    round("r4", "2026-05-22", "ridgeview-blue", [4, 6, 5, 4, 4, 3, 4, 5, null])
  ];
  const board = E.buildBoards(rounds, OPTS).get("ridgeview");
  const worst = E.nemesis(board);
  assert.equal(worst.key, "ridgeview:2"); // par 3: +4,+3,+2,+3 => +3 avg
  assert.equal(worst.plays, 4);
  assert.equal(worst.avgVsPar, 3);
  // Hole 9 has a blow-up (+5) but only 3 plays and averages +1.67, so hole 2 still wins.
  assert.equal(board.holes.get("ridgeview:9").plays, 3);
  assert.equal(E.nemesis(board, { minPlays: 3 }).key, "ridgeview:2");
  // At minPlays 4 only holes 1-8 qualify (hole 9 has 3 plays): hole 2 again.
  assert.equal(E.nemesis(board, { minPlays: 4 }).key, "ridgeview:2");
});

test("nemesis: minPlays excludes thin samples and returns null when none qualify", () => {
  const rounds = [
    round("r1", "2026-05-01", "ridgeview-blue", [9, 4, 5, 4, 4, 3, 4, 5, 4]),
    round("r2", "2026-05-08", "ridgeview-blue", [4, 4, 5, 4, 4, 3, 4, 5, 4])
  ];
  const board = E.buildBoards(rounds, OPTS).get("ridgeview");
  assert.equal(E.nemesis(board), null); // nothing has 3 plays
  assert.equal(E.nemesis(board, { minPlays: 2 }).key, "ridgeview:1"); // +5 and 0 => +2.5
  assert.equal(E.nemesis(board, { minPlays: 3 }), null);
  assert.equal(E.nemesis(null), null);
  assert.equal(E.nemesis({}), null);
});

test("nemesis: ties go to the hole played more, then to the lower label", () => {
  // Hole 3 and hole 1 both average +1 over 3 plays; hole 5 averages +1 over 4.
  const mk = (id, date, scores) => round(id, date, "ridgeview-blue", scores);
  const rounds = [
    mk("r1", "2026-05-01", [5, 3, 6, 4, 5, 3, 4, 5, 4]),
    mk("r2", "2026-05-08", [5, 3, 6, 4, 5, 3, 4, 5, 4]),
    mk("r3", "2026-05-15", [5, 3, 6, 4, 5, 3, 4, 5, 4]),
    mk("r4", "2026-05-22", [null, 3, null, 4, 5, 3, 4, 5, 4])
  ];
  const board = E.buildBoards(rounds, OPTS).get("ridgeview");
  assert.equal(board.holes.get("ridgeview:5").avgVsPar, 1);
  assert.equal(E.nemesis(board).key, "ridgeview:5"); // more plays wins the tie

  // Without the extra play, holes 1, 3 and 5 are fully tied: lowest label (1).
  const flat = E.buildBoards(rounds.slice(0, 3), OPTS).get("ridgeview");
  assert.equal(E.nemesis(flat).key, "ridgeview:1");
  // Natural order, not string order: hole 2 sorts before hole 10.
  const eighteen = [1, 2, 3].map((n) =>
    round(`e${n}`, `2026-06-0${n}`, "glen-oak-white", fill(6, 18), [4])
  );
  const longBoard = E.buildBoards(eighteen, OPTS).get("glen-oak");
  assert.equal(E.nemesis(longBoard).key, "glen-oak:1");
});

// ---- roundDelta ----------------------------------------------------------

test("roundDelta: moved holes, first plays, new birdies, revenge and totals", () => {
  const history = [
    round("r1", "2026-05-01", "ridgeview-blue", [5, 6, 5, 4, 5, 3, 4, 5, null]),
    round("r2", "2026-05-08", "ridgeview-blue", [5, 5, 5, 4, 5, 3, 4, 5, null]),
    round("r3", "2026-05-15", "ridgeview-blue", [5, 5, 5, 4, 4, 3, 4, 5, null]),
    round("x1", "2026-05-16", "glen-oak-white", fill(3)) // other course: must not leak
  ];
  // Hole 2 (par 3) is the nemesis: +3, +2, +2 over 3 plays.
  const newRound = round("r4", "2026-06-01", "ridgeview-blue", [4, 3, 5, 4, 4, 2, 4, 5, 4]);
  const delta = E.roundDelta(history, newRound, OPTS);

  assert.equal(delta.courseKey, "ridgeview");
  assert.deepEqual(
    delta.moved.map((m) => [m.label, m.from, m.to, m.firstPlay]),
    [["1", 5, 4, false], ["2", 5, 3, false], ["6", 3, 2, false]]
  );
  assert.equal(delta.moved[1].par, 3);
  assert.deepEqual(delta.firstPlays.map((f) => [f.label, f.to, f.firstPlay]), [["9", 4, true]]);
  // Hole 2 par 3 -> 3 is not a birdie; hole 6 (par 3) 2 is the first birdie; hole 1 4-on-4-par is par.
  assert.deepEqual(delta.newBirdieHoles, [{ key: "ridgeview:6", label: "6" }]);
  assert.deepEqual(delta.revenge, { key: "ridgeview:2", label: "2", score: 3, par: 3 });
  // before: 5,5,5,4,4,3,4,5 = 35 over 8 holes; after adds hole 9 and lowers 1, 2, 6.
  assert.equal(delta.totalBefore, 35);
  assert.equal(delta.holesBefore, 8);
  assert.equal(delta.parBefore, 32);
  assert.equal(delta.totalAfter, 4 + 3 + 5 + 4 + 4 + 2 + 4 + 5 + 4);
  assert.equal(delta.holesAfter, 9);
  assert.equal(delta.parAfter, 36);
  assert.equal(delta.groupBefore.all.total, 35);
  assert.equal(delta.groupBefore.all.complete, false);
  assert.equal(delta.groupAfter.all.total, delta.totalAfter);
});

test("roundDelta: no revenge when the nemesis hole is not scored par or better", () => {
  const history = [1, 2, 3].map((n) =>
    round(`r${n}`, `2026-05-0${n}`, "ridgeview-blue", [4, 7, 5, 4, 4, 3, 4, 5, 4])
  );
  const newRound = round("r4", "2026-06-01", "ridgeview-blue", [4, 4, 5, 4, 4, 3, 4, 5, 4]); // bogey on the par-3 nemesis
  const delta = E.roundDelta(history, newRound, OPTS);
  assert.equal(delta.revenge, null);
  assert.equal(delta.moved.length, 1);
  assert.equal(delta.moved[0].label, "2");
  // The nemesis was NOT yet beaten, but the round skipped it entirely: still null.
  const skip = round("r5", "2026-06-02", "ridgeview-blue", [4, null, 5, 4, 4, 3, 4, 5, 4]);
  assert.equal(E.roundDelta(history, skip, OPTS).revenge, null);
});

test("roundDelta: first round at a course is all first plays", () => {
  const newRound = round("r1", "2026-06-01", "ridgeview-blue", [3, 4, 5, 4, 4, 3, 4, 5, 4]);
  const delta = E.roundDelta([], newRound, OPTS);
  assert.equal(delta.moved.length, 0);
  assert.equal(delta.firstPlays.length, 9);
  assert.equal(delta.totalBefore, 0);
  assert.equal(delta.holesBefore, 0);
  assert.deepEqual(delta.groupBefore, {});
  assert.equal(delta.totalAfter, 36);
  assert.equal(delta.revenge, null);
  // The birdie on hole 1 is a first-ever birdie even on a first play.
  assert.deepEqual(delta.newBirdieHoles, [{ key: "ridgeview:1", label: "1" }]);
});

test("roundDelta: a second birdie on a hole is not a new birdie hole", () => {
  const history = [round("r1", "2026-05-01", "ridgeview-blue", [3, 4, 5, 4, 4, 3, 4, 5, 4])];
  const newRound = round("r2", "2026-06-01", "ridgeview-blue", [3, 4, 5, 4, 4, 2, 4, 5, 4]);
  const delta = E.roundDelta(history, newRound, OPTS);
  assert.deepEqual(delta.newBirdieHoles, [{ key: "ridgeview:6", label: "6" }]);
  assert.deepEqual(delta.moved.map((m) => m.label), ["6"]);
});

test("roundDelta: an equal later score is not 'moved'", () => {
  const history = [round("r1", "2026-05-01", "ridgeview-blue", [4, 3, 5, 4, 4, 3, 4, 5, 4])];
  const newRound = round("r2", "2026-06-01", "ridgeview-blue", [4, 3, 5, 4, 4, 3, 4, 5, 4]);
  const delta = E.roundDelta(history, newRound, OPTS);
  assert.deepEqual(delta.moved, []);
  assert.deepEqual(delta.firstPlays, []);
  assert.equal(delta.totalBefore, delta.totalAfter);
});

test("roundDelta: excludes newRound if it is already in roundsBefore", () => {
  const prior = round("r1", "2026-05-01", "ridgeview-blue", fill(5));
  const newRound = round("r2", "2026-06-01", "ridgeview-blue", fill(4));
  const clean = E.roundDelta([prior], newRound, OPTS);
  const dirty = E.roundDelta([prior, newRound], newRound, OPTS);
  assert.deepEqual(dirty, clean);
  assert.equal(dirty.totalBefore, 45);
  assert.equal(dirty.totalAfter, 36);
  assert.equal(dirty.moved.length, 9);
});

test("roundDelta: exceptRoundId drops that earlier round from the baseline", () => {
  const rounds = [
    round("r1", "2026-05-01", "ridgeview-blue", fill(4)),
    round("r2", "2026-05-08", "ridgeview-blue", fill(6))
  ];
  const newRound = round("r3", "2026-06-01", "ridgeview-blue", fill(5));
  const base = E.roundDelta(rounds, newRound, OPTS);
  assert.equal(base.moved.length, 0);
  const without = E.roundDelta(rounds, newRound, Object.assign({}, OPTS, { exceptRoundId: "r1" }));
  assert.equal(without.totalBefore, 54);
  assert.equal(without.moved.length, 9);
  // Excluding the new round's own id must not erase it from the "after" board.
  const self = E.roundDelta(rounds, newRound, Object.assign({}, OPTS, { exceptRoundId: "r3" }));
  assert.equal(self.totalAfter, base.totalAfter);
});

test("roundDelta: Deerwood group totals before and after, per nine", () => {
  const history = [
    deerwood("d1", "2026-06-01", "deerwood-buck-doe-white", ["buck", "doe"], {
      buck: fill(6), doe: fill(6)
    })
  ];
  const newRound = deerwood("d2", "2026-06-15", "deerwood-fawn-buck-blue", ["fawn", "buck"], {
    fawn: fill(5), buck: [5, 3, 4, 4, 4, 4, 5, 3, 4] // buck: all pars
  });
  const delta = E.roundDelta(history, newRound, OPTS);
  assert.equal(delta.courseKey, "deerwood");
  assert.deepEqual(Object.keys(delta.groupBefore), ["buck", "doe"]);
  assert.deepEqual(Object.keys(delta.groupAfter), ["buck", "doe", "fawn"]);
  assert.equal(delta.groupBefore.buck.total, 54);
  assert.equal(delta.groupAfter.buck.total, 36);
  assert.equal(delta.groupAfter.buck.par, 36);
  assert.equal(delta.groupAfter.doe.total, 54);
  assert.equal(delta.groupAfter.fawn.total, 45);
  assert.equal(delta.groupAfter.fawn.complete, true);
  assert.equal(delta.moved.length, 9);
  assert.ok(delta.moved.every((m) => m.key.startsWith("deerwood:buck:")));
  assert.equal(delta.firstPlays.length, 9);
  assert.ok(delta.firstPlays.every((f) => f.key.startsWith("deerwood:fawn:")));
  assert.equal(delta.totalAfter, 36 + 54 + 45);
});

test("roundDelta: invalid new round returns an empty delta", () => {
  const empty = E.roundDelta([], null, OPTS);
  assert.equal(empty.courseKey, null);
  assert.deepEqual(empty.moved, []);
  assert.deepEqual(empty.firstPlays, []);
  assert.equal(empty.revenge, null);
  assert.equal(E.roundDelta(null, round("r1", "2026-06-01", "ridgeview-blue", fill(4)), OPTS).firstPlays.length, 9);
});

// ---- diffRecords ---------------------------------------------------------

test("diffRecords: changed and new records only, in afterList order", () => {
  const before = [
    { id: "low", label: "Lowest round", value: 82 },
    { id: "streak", label: "Par streak", value: 3 },
    { id: "putts", label: "Fewest putts", value: 28 },
    { id: "gone", label: "Removed", value: 1 }
  ];
  const after = [
    { id: "new-one", label: "Eagle", value: "Hole 7", roundId: "r9" },
    { id: "low", label: "Lowest round", value: 79, roundId: "r9" },
    { id: "streak", label: "Par streak", value: 3 },
    { id: "putts", label: "Fewest putts", value: 26, roundId: "r9" }
  ];
  assert.deepEqual(E.diffRecords(before, after), [
    { id: "new-one", label: "Eagle", from: null, to: "Hole 7", roundId: "r9" },
    { id: "low", label: "Lowest round", from: 82, to: 79, roundId: "r9" },
    { id: "putts", label: "Fewest putts", from: 28, to: 26, roundId: "r9" }
  ]);
});

test("diffRecords: unchanged lists produce nothing; number/string of equal text is unchanged", () => {
  const list = [{ id: "a", label: "A", value: 4 }, { id: "b", label: "B", value: "x" }];
  assert.deepEqual(E.diffRecords(list, list), []);
  assert.deepEqual(E.diffRecords([{ id: "a", label: "A", value: 4 }], [{ id: "a", label: "A", value: "4" }]), []);
  assert.deepEqual(E.diffRecords(null, null), []);
  assert.equal(E.diffRecords(null, [{ id: "z", label: "Z", value: 1 }]).length, 1);
});

test("diffRecords: roundId keeps only records this round set", () => {
  const before = [{ id: "a", label: "A", value: 10 }, { id: "b", label: "B", value: 10 }];
  const after = [
    { id: "a", label: "A", value: 8, roundId: "r2" },
    { id: "b", label: "B", value: 9, roundId: "r1" },
    { id: "c", label: "C", value: 1 }
  ];
  assert.deepEqual(E.diffRecords(before, after, { roundId: "r2" }), [
    { id: "a", label: "A", from: 10, to: 8, roundId: "r2" }
  ]);
  assert.equal(E.diffRecords(before, after, { roundId: "r1" }).length, 1);
  assert.equal(E.diffRecords(before, after, { roundId: "nope" }).length, 0);
  assert.equal(E.diffRecords(before, after, {}).length, 3);
});

// ---- purity --------------------------------------------------------------

test("inputs are never mutated (deep-frozen inputs do not throw)", () => {
  const history = deepFreeze([
    round("r1", "2026-05-01", "ridgeview-blue", [5, 6, 5, 4, 5, 3, 4, 5, 4]),
    round("r2", "2026-05-08", "ridgeview-blue", [5, 5, 5, 4, 5, 3, 4, 5, 4]),
    round("r3", "2026-05-15", "ridgeview-blue", [5, 5, 5, 4, 4, 3, 4, 5, 4]),
    deerwood("d1", "2026-06-01", "deerwood-buck-doe-white", ["buck", "doe"], { buck: fill(5), doe: fill(5) })
  ]);
  const newRound = deepFreeze(round("r4", "2026-06-01", "ridgeview-blue", [4, 3, 5, 4, 4, 2, 4, 5, 4]));
  const snapshot = JSON.stringify([history, newRound]);
  const opts = deepFreeze({ courseKey, holeKey, groupKey, exceptRoundId: "nope" });

  const boards = E.buildBoards(history, opts);
  E.nemesis(boards.get("ridgeview"));
  E.roundDelta(history, newRound, opts);
  const before = deepFreeze([{ id: "a", label: "A", value: 1 }]);
  const after = deepFreeze([{ id: "a", label: "A", value: 2, roundId: "r4" }]);
  E.diffRecords(before, after, { roundId: "r4" });

  assert.equal(JSON.stringify([history, newRound]), snapshot);
});

test("output cells are independent of the input holes", () => {
  const input = round("r1", "2026-05-01", "ridgeview-blue", fill(4));
  const board = E.buildBoards([input], OPTS).get("ridgeview");
  board.holes.get("ridgeview:1").best = 99;
  assert.equal(input.holes[0].score, 4);
  assert.equal(E.buildBoards([input], OPTS).get("ridgeview").holes.get("ridgeview:1").best, 4);
});
