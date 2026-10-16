/*
 * Fairway Ledger — eclectic boards.
 *
 * An "eclectic" is the classic golf-club competition: take the best score you
 * have ever posted on each hole of a course and add them up, so the total is
 * the "dream round" you have collectively played across every visit. This
 * module builds that board per physical course, reports what a freshly saved
 * round did to it (new best holes, first birdies, revenge on the hole that
 * usually beats you), and diffs generic Trophy Room records.
 *
 * Everything here is pure and dependency-free: no DOM, no storage, no module
 * state, and inputs are never mutated. Identity is INJECTED so this file knows
 * nothing about tee variants or Deerwood routings:
 *
 *   opts.courseKey(round)        -> string   physical course (tees pooled)
 *   opts.holeKey(round, hole)    -> string   physical hole within the course
 *   opts.groupKey(round, hole)   -> string|null  optional sub-board, e.g. a
 *                                   Deerwood nine; null/absent => 'all'
 *   opts.exceptRoundId           -> round id to leave out of the board
 *   opts.expectedHoles(courseKey, groupKey) -> number  optional; how many
 *                                   holes make a group "complete". Defaults:
 *                                   9 for a named group, 18 for 'all'.
 *
 * With no opts, courseKey is round.courseId and holeKey is
 * "<courseKey>:<hole.number>", which is enough for a single-tee course.
 *
 * Tie-breaks are deterministic: rounds are replayed oldest first (date, then
 * round id), and a score only replaces the best when STRICTLY lower, so the
 * earliest round to post a score keeps it and a later equal score never counts
 * as "moved".
 *
 * Loaded two ways, same as lib/golf-math.js:
 *   - Browser: a plain <script> that sets window.FairwayEclectic.
 *   - Node: require("../lib/eclectic.js") for the test suite.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.FairwayEclectic = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ALL_GROUP = "all";
  const DEFAULT_PAR = 4; // matches HOLE_DEFAULTS.par in lib/shapes.js

  // ---- Identity + ordering helpers ---------------------------------------

  function defaultCourseKey(round) {
    return round && round.courseId ? String(round.courseId) : "";
  }

  function resolveOptions(opts) {
    const o = opts || {};
    const courseKey = typeof o.courseKey === "function" ? o.courseKey : defaultCourseKey;
    return {
      courseKey,
      holeKey: typeof o.holeKey === "function"
        ? o.holeKey
        : (round, hole) => `${courseKey(round)}:${hole && hole.number}`,
      groupKey: typeof o.groupKey === "function" ? o.groupKey : null,
      expectedHoles: typeof o.expectedHoles === "function" ? o.expectedHoles : null,
      exceptRoundId: o.exceptRoundId == null ? null : o.exceptRoundId
    };
  }

  function naturalCompare(a, b) {
    const left = String(a == null ? "" : a);
    const right = String(b == null ? "" : b);
    const cmp = left.localeCompare(right, "en", { numeric: true });
    if (cmp) return cmp;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function compareRounds(a, b) {
    const dateCmp = String(a.date || "").localeCompare(String(b.date || ""));
    if (dateCmp) return dateCmp;
    const left = String(a.id == null ? "" : a.id);
    const right = String(b.id == null ? "" : b.id);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function isScored(hole) {
    return !!hole && Number.isFinite(hole.score) && hole.score >= 1;
  }

  function parOf(hole) {
    return Number.isFinite(hole.par) && hole.par >= 1 ? hole.par : DEFAULT_PAR;
  }

  function labelOf(hole) {
    const label = hole.label == null ? "" : String(hole.label).trim();
    if (label) return label;
    return hole.number == null ? "" : String(hole.number);
  }

  // Rounds worth replaying (have holes, not excluded), oldest first. Returns a
  // new array; the input array and its rounds are untouched.
  function replayOrder(rounds, exceptRoundId) {
    const list = [];
    (Array.isArray(rounds) ? rounds : []).forEach((round) => {
      if (!round || !Array.isArray(round.holes) || !round.holes.length) return;
      if (exceptRoundId != null && round.id === exceptRoundId) return;
      list.push(round);
    });
    return list.sort(compareRounds);
  }

  // ---- Boards ------------------------------------------------------------

  function emptyBoard(courseKey) {
    return { courseKey, holes: new Map(), groups: new Map(), total: 0, par: 0, plays: 0 };
  }

  function finalizeBoard(courseKey, cellMap, roundCount, o) {
    const cells = Array.from(cellMap.values()).sort((a, b) =>
      naturalCompare(a.group, b.group) || naturalCompare(a.label, b.label) || naturalCompare(a.key, b.key)
    );
    const board = emptyBoard(courseKey);
    board.plays = roundCount;
    cells.forEach((cell) => {
      cell.avgVsPar = cell.sumVsPar / cell.plays;
      board.holes.set(cell.key, cell);
      board.total += cell.best;
      board.par += cell.par;
      let group = board.groups.get(cell.group);
      if (!group) {
        group = { holeKeys: [], total: 0, par: 0, complete: false };
        board.groups.set(cell.group, group);
      }
      group.holeKeys.push(cell.key);
      group.total += cell.best;
      group.par += cell.par;
    });
    board.groups.forEach((group, groupName) => {
      let expected = groupName === ALL_GROUP ? 18 : 9;
      if (o.expectedHoles) {
        const injected = Number(o.expectedHoles(courseKey, groupName));
        if (Number.isFinite(injected) && injected > 0) expected = injected;
      }
      group.complete = group.holeKeys.length >= expected;
    });
    return board;
  }

  // Map<courseKey, Board>. Board.plays is the number of rounds that
  // contributed at least one scored hole; Cell.plays counts plays of that hole.
  function buildBoards(rounds, opts) {
    const o = resolveOptions(opts);
    const perCourse = new Map(); // courseKey -> { cells: Map, rounds: number }

    replayOrder(rounds, o.exceptRoundId).forEach((round) => {
      const courseKey = o.courseKey(round);
      if (!courseKey) return;
      let entry = null;
      let contributed = false;
      round.holes.forEach((hole) => {
        if (!isScored(hole)) return;
        const key = o.holeKey(round, hole);
        if (!key) return;
        if (!entry) {
          entry = perCourse.get(courseKey);
          if (!entry) {
            entry = { cells: new Map(), rounds: 0 };
            perCourse.set(courseKey, entry);
          }
        }
        contributed = true;
        const par = parOf(hole);
        const score = hole.score;
        const vsPar = score - par;
        const group = (o.groupKey && o.groupKey(round, hole)) || ALL_GROUP;
        let cell = entry.cells.get(key);
        if (!cell) {
          cell = {
            key,
            label: labelOf(hole),
            par,
            group,
            best: score,
            bestVsPar: vsPar,
            bestDate: round.date || "",
            bestRoundId: round.id == null ? null : round.id,
            plays: 0,
            sumVsPar: 0,
            avgVsPar: 0,
            birdieOrBetter: false,
            lastScore: score
          };
          entry.cells.set(key, cell);
        } else if (score < cell.best) {
          cell.par = par;
          cell.best = score;
          cell.bestVsPar = vsPar;
          cell.bestDate = round.date || "";
          cell.bestRoundId = round.id == null ? null : round.id;
        }
        cell.plays += 1;
        cell.sumVsPar += vsPar;
        cell.lastScore = score;
        cell.label = labelOf(hole) || cell.label;
        cell.group = group;
        if (vsPar <= -1) cell.birdieOrBetter = true;
      });
      if (contributed) entry.rounds += 1;
    });

    const boards = new Map();
    perCourse.forEach((entry, courseKey) => {
      boards.set(courseKey, finalizeBoard(courseKey, entry.cells, entry.rounds, o));
    });
    return boards;
  }

  // ---- Nemesis -----------------------------------------------------------

  // Is `a` a worse hole than `b`? Highest average vs par; ties go to the hole
  // played more often, then to the lower label. Compares sum/plays exactly via
  // cross-multiplication so float rounding can't flip a tie.
  function isWorseCell(a, b) {
    const diff = a.sumVsPar * b.plays - b.sumVsPar * a.plays;
    if (diff) return diff > 0;
    if (a.plays !== b.plays) return a.plays > b.plays;
    return (naturalCompare(a.label, b.label) || naturalCompare(a.key, b.key)) < 0;
  }

  function nemesis(board, options) {
    if (!board || !board.holes) return null;
    const minPlays = options && Number.isFinite(options.minPlays) ? options.minPlays : 3;
    let worst = null;
    board.holes.forEach((cell) => {
      if (cell.plays < minPlays) return;
      if (!worst || isWorseCell(cell, worst)) worst = cell;
    });
    return worst;
  }

  // ---- Round delta -------------------------------------------------------

  function groupsToObject(board) {
    const out = {};
    board.groups.forEach((group, name) => {
      out[name] = { holeKeys: group.holeKeys.slice(), total: group.total, par: group.par, complete: group.complete };
    });
    return out;
  }

  // What did `newRound` do to its course's board? roundsBefore should not
  // contain newRound; if it does, it is excluded by id so it can't count
  // against itself.
  function roundDelta(roundsBefore, newRound, opts) {
    const o = resolveOptions(opts);
    const courseKey = newRound ? o.courseKey(newRound) : "";
    const result = {
      courseKey: courseKey || null,
      moved: [],
      firstPlays: [],
      newBirdieHoles: [],
      revenge: null,
      totalBefore: 0,
      totalAfter: 0,
      parBefore: 0,
      parAfter: 0,
      holesBefore: 0,
      holesAfter: 0,
      groupBefore: {},
      groupAfter: {}
    };
    if (!newRound || !courseKey) return result;

    const newId = newRound.id;
    const priorRounds = (Array.isArray(roundsBefore) ? roundsBefore : []).filter((round) => {
      if (!round) return false;
      if (newId != null && round.id === newId) return false;
      if (o.exceptRoundId != null && round.id === o.exceptRoundId) return false;
      return o.courseKey(round) === courseKey;
    });
    // exceptRoundId is already applied above; the new round itself must count.
    const boardOpts = Object.assign({}, opts, { exceptRoundId: null });
    const before = buildBoards(priorRounds, boardOpts).get(courseKey) || emptyBoard(courseKey);
    const after = buildBoards(priorRounds.concat([newRound]), boardOpts).get(courseKey) || emptyBoard(courseKey);

    result.totalBefore = before.total;
    result.totalAfter = after.total;
    result.parBefore = before.par;
    result.parAfter = after.par;
    result.holesBefore = before.holes.size;
    result.holesAfter = after.holes.size;
    result.groupBefore = groupsToObject(before);
    result.groupAfter = groupsToObject(after);

    // The new round's best score per physical hole, in hole order.
    const played = new Map();
    (Array.isArray(newRound.holes) ? newRound.holes : []).forEach((hole) => {
      if (!isScored(hole)) return;
      const key = o.holeKey(newRound, hole);
      if (!key) return;
      const par = parOf(hole);
      const existing = played.get(key);
      if (!existing) {
        played.set(key, { key, label: labelOf(hole), par, score: hole.score });
      } else if (hole.score < existing.score) {
        existing.score = hole.score;
        existing.par = par;
      }
    });

    const nemesisBefore = nemesis(before, { minPlays: 3 });

    played.forEach((entry) => {
      const prior = before.holes.get(entry.key);
      if (!prior) {
        result.firstPlays.push({
          key: entry.key, label: entry.label, par: entry.par, from: null, to: entry.score, firstPlay: true
        });
      } else if (entry.score < prior.best) {
        result.moved.push({
          key: entry.key, label: entry.label, par: entry.par, from: prior.best, to: entry.score, firstPlay: false
        });
      }
      if (entry.score - entry.par <= -1 && (!prior || !prior.birdieOrBetter)) {
        result.newBirdieHoles.push({ key: entry.key, label: entry.label });
      }
      if (nemesisBefore && nemesisBefore.key === entry.key && entry.score <= entry.par) {
        result.revenge = { key: entry.key, label: entry.label, score: entry.score, par: entry.par };
      }
    });

    return result;
  }

  // ---- Trophy Room diff --------------------------------------------------

  function sameValue(a, b) {
    if (a == null || b == null) return a == null && b == null;
    return String(a) === String(b);
  }

  // Records are { id, label, value, sub?, context?, roundId? }. Returns the
  // ones whose value changed or that are new, in afterList order, as
  // { id, label, from, to, roundId } (from is null for a new record). With
  // { roundId }, keeps only records the after-list credits to that round.
  function diffRecords(beforeList, afterList, options) {
    const previous = new Map();
    (Array.isArray(beforeList) ? beforeList : []).forEach((item) => {
      if (item && item.id != null && !previous.has(item.id)) previous.set(item.id, item);
    });
    const filterId = options && options.roundId != null ? options.roundId : null;
    const changes = [];
    (Array.isArray(afterList) ? afterList : []).forEach((item) => {
      if (!item || item.id == null) return;
      const prior = previous.get(item.id);
      if (prior && sameValue(prior.value, item.value)) return;
      const roundId = item.roundId == null ? null : item.roundId;
      if (filterId !== null && roundId !== filterId) return;
      changes.push({
        id: item.id,
        label: item.label,
        from: prior ? (prior.value == null ? null : prior.value) : null,
        to: item.value,
        roundId
      });
    });
    return changes;
  }

  return {
    buildBoards,
    nemesis,
    roundDelta,
    diffRecords
  };
});
