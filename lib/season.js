/*
 * Fairway Ledger — the Season Story.
 *
 * One calendar year of golf, told from saved rounds: how much you played, your
 * best round, how your scoring average and handicap moved, the hole you got
 * better at, the nemesis holes you beat, how far your eclectics moved, the
 * records that fell, putting and greens trends, and where you played most.
 *
 * Pure and dependency-injected like lib/eclectic.js: no DOM, no storage, no
 * module state, and inputs are never mutated. What this file can't know is
 * passed in:
 *
 *   opts.eclecticOpts      { courseKey, holeKey, groupKey } for FairwayEclectic
 *                          (physical course / hole identity). Without it,
 *                          courseKey is round.courseId.
 *   opts.handicapOf(rounds) -> index | null   the app's WHS-style estimate.
 *   opts.trophies(rounds)   -> [{ id, label, value, roundId }]   the app's
 *                          Trophy Room records, diffed to find what fell.
 *   opts.today             "YYYY-MM-DD"; marks the current year in progress.
 *
 * Honest-data rules (lib/golf-math.js): putting and greens come from detail
 * rounds only (isDetailRound), counting only holes where putts were entered
 * (puttsKnown / girKnown). Scoring averages use complete 18-hole rounds only.
 * A trend needs at least 4 qualifying rounds; it compares the first N with the
 * last N (N = up to 5, never overlapping). Anything below a threshold is
 * reported as null with a reason, never guessed.
 *
 * Ordering matches lib/eclectic.js: rounds replay oldest first (date, then id),
 * and on a tie the earlier round keeps a "best".
 *
 * Loaded two ways:
 *   - Browser: a plain <script> after golf-math.js and eclectic.js; sets
 *     window.FairwaySeason.
 *   - Node: require("../lib/season.js") for the test suite.
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./golf-math.js"), require("./eclectic.js"));
  } else {
    root.FairwaySeason = factory(root.GolfMath, root.FairwayEclectic);
  }
})(typeof self !== "undefined" ? self : this, function (GolfMath, Eclectic) {
  "use strict";

  const MIN_REPEAT_PLAYS = 4;  // a hole needs 4 plays in the year before "improved" can be said
  const MIN_IMPROVE = 0.3;     // strokes per play, first half minus second half
  const MIN_TREND_ROUNDS = 4;  // rounds needed before start -> now is shown
  const TREND_WINDOW = 5;      // up to the first 5 vs the last 5
  const DEFAULT_PAR = 4;       // matches HOLE_DEFAULTS.par in lib/shapes.js

  // ---- Small helpers -------------------------------------------------------

  const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
  const mean = (list) => (list.length ? list.reduce((s, x) => s + x, 0) / list.length : null);

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

  function yearOf(round) {
    const match = /^(\d{4})-\d{2}-\d{2}/.exec(String(round && round.date || ""));
    return match ? match[1] : null;
  }

  function compareRounds(a, b) {
    const dateCmp = String(a.date || "").localeCompare(String(b.date || ""));
    if (dateCmp) return dateCmp;
    const left = String(a.id == null ? "" : a.id);
    const right = String(b.id == null ? "" : b.id);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function naturalCompare(a, b) {
    return String(a == null ? "" : a).localeCompare(String(b == null ? "" : b), "en", { numeric: true });
  }

  function scoredHoles(round) {
    return Array.isArray(round && round.holes) ? round.holes.filter(isScored) : [];
  }

  // Every hole of the round's card has a score: an 18 you finished.
  function isComplete(round, holeCount) {
    return Array.isArray(round.holes) && round.holes.length === holeCount && round.holes.every(isScored);
  }

  function grossOf(round) {
    return scoredHoles(round).reduce((s, h) => s + h.score, 0);
  }

  function parTotal(round) {
    return scoredHoles(round).reduce((s, h) => s + parOf(h), 0);
  }

  // Rounds with a real date and at least one scored hole, oldest first.
  function usableRounds(rounds) {
    return (Array.isArray(rounds) ? rounds : [])
      .filter((r) => r && yearOf(r) && scoredHoles(r).length)
      .slice()
      .sort(compareRounds);
  }

  function courseKeyFn(opts) {
    const eo = opts && opts.eclecticOpts;
    return eo && typeof eo.courseKey === "function"
      ? eo.courseKey
      : (round) => (round && round.courseId ? String(round.courseId) : "");
  }

  function holeKeyFn(opts) {
    const eo = opts && opts.eclecticOpts;
    if (eo && typeof eo.holeKey === "function") return eo.holeKey;
    const courseKey = courseKeyFn(opts);
    return (round, hole) => `${courseKey(round)}:${hole && hole.number}`;
  }

  // First N vs last N of an ordered list, N = min(5, floor(len / 2)); 0 when
  // there are too few to call it a trend.
  function trendWindow(count) {
    return count >= MIN_TREND_ROUNDS ? Math.min(TREND_WINDOW, Math.floor(count / 2)) : 0;
  }

  function roundRef(round, courseKey) {
    return {
      roundId: round.id == null ? null : round.id,
      date: round.date || "",
      courseKey: courseKey(round) || null
    };
  }

  // ---- Years -----------------------------------------------------------------

  function seasonYears(rounds) {
    const years = new Set();
    usableRounds(rounds).forEach((r) => years.add(yearOf(r)));
    return Array.from(years).sort().reverse();
  }

  // ---- Sections ----------------------------------------------------------------

  function playedSection(mine) {
    const byMonth = new Map();
    let holes = 0;
    let fulls = 0;
    mine.forEach((r) => {
      const scored = scoredHoles(r).length;
      holes += scored;
      if (r.holes.length >= 18) fulls += 1;
      const month = String(r.date).slice(0, 7);
      const entry = byMonth.get(month) || { month, rounds: 0, holes: 0 };
      entry.rounds += 1;
      entry.holes += scored;
      byMonth.set(month, entry);
    });
    // Fill the gaps between the first and last month so a chart reads as time.
    const months = [];
    const keys = Array.from(byMonth.keys()).sort();
    if (keys.length) {
      let [y, m] = keys[0].split("-").map(Number);
      const [lastY, lastM] = keys[keys.length - 1].split("-").map(Number);
      while (y < lastY || (y === lastY && m <= lastM)) {
        const key = `${y}-${String(m).padStart(2, "0")}`;
        months.push(byMonth.get(key) || { month: key, rounds: 0, holes: 0 });
        m += 1;
        if (m > 12) { m = 1; y += 1; }
      }
    }
    return { rounds: mine.length, holes, eighteens: fulls, nines: mine.length - fulls, byMonth: months };
  }

  function bestSection(mine, courseKey) {
    const pick = (holeCount) => {
      let best = null;
      mine.forEach((r) => {
        if (!isComplete(r, holeCount)) return;
        const gross = grossOf(r);
        if (!best || gross < best.gross) best = { round: r, gross };
      });
      if (!best) return null;
      const par = parTotal(best.round);
      return Object.assign(roundRef(best.round, courseKey), {
        gross: best.gross, par, toPar: best.gross - par, holes: holeCount
      });
    };
    return pick(18) || pick(9);
  }

  function scoringSection(mine, courseKey) {
    const series = mine.filter((r) => isComplete(r, 18)).map((r) => {
      const gross = grossOf(r);
      const par = parTotal(r);
      return Object.assign(roundRef(r, courseKey), { gross, par, toPar: gross - par });
    });
    const n = series.length;
    const window = trendWindow(n);
    const avg = r1(mean(series.map((s) => s.gross)));
    const avgToPar = r1(mean(series.map((s) => s.toPar)));
    let start = null;
    let now = null;
    let change = null;
    if (window) {
      start = r1(mean(series.slice(0, window).map((s) => s.gross)));
      now = r1(mean(series.slice(n - window).map((s) => s.gross)));
      change = r1(now - start);
    }
    return {
      rounds: n,
      avg,
      avgToPar,
      window,
      start,
      now,
      change,
      reason: n === 0 ? "no-eighteens" : window ? null : "too-few",
      series
    };
  }

  function handicapSection(before, mine, handicapOf, courseKey) {
    const empty = { start: null, startKind: null, startRef: null, now: null, change: null, trail: [] };
    if (typeof handicapOf !== "function") return Object.assign(empty, { reason: "unavailable" });
    const safe = (list) => {
      try {
        const value = handicapOf(list);
        return Number.isFinite(value) ? value : null;
      } catch { return null; }
    };
    const carried = before.length ? safe(before) : null;
    const trail = [];
    for (let i = 0; i < mine.length; i += 1) {
      const index = safe(before.concat(mine.slice(0, i + 1)));
      trail.push(Object.assign(roundRef(mine[i], courseKey), { index: r1(index) }));
    }
    let start = carried;
    let startKind = carried != null ? "carried" : null;
    let startRef = null;
    if (start == null) {
      const first = trail.find((t) => t.index != null);
      if (first) {
        start = first.index;
        startKind = "first";
        startRef = { roundId: first.roundId, date: first.date, roundNumber: trail.indexOf(first) + 1 };
      }
    }
    const last = trail.length ? trail[trail.length - 1].index : null;
    const startR = r1(start);
    const nowR = r1(last);
    return {
      start: startR,
      startKind,
      startRef,
      now: nowR,
      change: startR != null && nowR != null ? r1(nowR - startR) : null,
      reason: nowR == null ? "too-few" : null,
      trail
    };
  }

  function improvementSection(mine, opts) {
    const courseKey = courseKeyFn(opts);
    const holeKey = holeKeyFn(opts);
    const groups = new Map();
    mine.forEach((round) => {
      round.holes.forEach((hole) => {
        if (!isScored(hole)) return;
        const key = holeKey(round, hole);
        if (!key) return;
        let group = groups.get(key);
        if (!group) {
          group = { key, courseKey: courseKey(round) || null, label: labelOf(hole), par: parOf(hole), plays: [] };
          groups.set(key, group);
        }
        group.label = labelOf(hole) || group.label;
        group.par = parOf(hole);
        group.plays.push({
          roundId: round.id == null ? null : round.id,
          date: round.date || "",
          number: hole.number == null ? null : hole.number,
          score: hole.score,
          par: parOf(hole),
          vsPar: hole.score - parOf(hole)
        });
      });
    });
    let candidates = 0;
    let best = null;
    groups.forEach((group) => {
      const n = group.plays.length;
      if (n < MIN_REPEAT_PLAYS) return;
      candidates += 1;
      const half = Math.floor(n / 2);
      const early = mean(group.plays.slice(0, half).map((p) => p.vsPar));
      const late = mean(group.plays.slice(n - half).map((p) => p.vsPar));
      const gain = early - late;
      if (gain < MIN_IMPROVE - 1e-9) return;
      const better = !best
        || gain > best.gainExact + 1e-9
        || (Math.abs(gain - best.gainExact) <= 1e-9 && (n > best.plays.length
          || (n === best.plays.length && naturalCompare(group.label, best.label) < 0)));
      if (better) best = Object.assign({}, group, { half, early, late, gainExact: gain });
    });
    if (!best) {
      return { hole: null, candidates, reason: candidates ? "none-improved" : "none-repeated" };
    }
    const last = best.plays[best.plays.length - 1];
    const earlyAvg = r1(best.par + best.early);
    const lateAvg = r1(best.par + best.late);
    return {
      hole: {
        key: best.key,
        courseKey: best.courseKey,
        label: best.label,
        par: best.par,
        plays: best.plays.length,
        half: best.half,
        earlyAvg,
        lateAvg,
        gain: r1(earlyAvg - lateAvg),
        ref: { roundId: last.roundId, number: last.number },
        series: best.plays.slice()
      },
      candidates,
      reason: null
    };
  }

  function nemesisSection(through, mine, opts) {
    if (!Eclectic || typeof Eclectic.roundDelta !== "function") return { events: [], holes: 0 };
    const eo = (opts && opts.eclecticOpts) || undefined;
    const position = new Map();
    through.forEach((r, i) => position.set(r, i));
    const events = [];
    mine.forEach((round) => {
      let delta = null;
      try { delta = Eclectic.roundDelta(through.slice(0, position.get(round)), round, eo); } catch { delta = null; }
      if (!delta || !delta.revenge) return;
      events.push({
        roundId: round.id == null ? null : round.id,
        date: round.date || "",
        courseKey: delta.courseKey,
        key: delta.revenge.key,
        label: delta.revenge.label,
        score: delta.revenge.score,
        par: delta.revenge.par
      });
    });
    return { events, holes: new Set(events.map((e) => `${e.courseKey}|${e.key}`)).size };
  }

  function eclecticSection(before, through, mine, opts) {
    const empty = { courses: [], strokes: 0, holesImproved: 0, newHoles: 0 };
    if (!Eclectic || typeof Eclectic.buildBoards !== "function") return empty;
    const eo = (opts && opts.eclecticOpts) || undefined;
    const courseKey = courseKeyFn(opts);
    let boardsBefore;
    let boardsAfter;
    try {
      boardsBefore = Eclectic.buildBoards(before, eo);
      boardsAfter = Eclectic.buildBoards(through, eo);
    } catch { return empty; }
    const played = new Map();
    mine.forEach((r) => {
      const key = courseKey(r);
      if (key) played.set(key, (played.get(key) || 0) + 1);
    });
    const courses = [];
    played.forEach((roundsHere, key) => {
      const after = boardsAfter.get(key);
      if (!after) return;
      const prior = boardsBefore.get(key) || null;
      const improved = [];
      let newHoles = 0;
      let strokes = 0;
      after.holes.forEach((cell) => {
        const was = prior ? prior.holes.get(cell.key) : null;
        if (!was) { newHoles += 1; return; }
        if (cell.best < was.best) {
          strokes += was.best - cell.best;
          improved.push({
            key: cell.key, label: cell.label, par: cell.par, from: was.best, to: cell.best,
            date: cell.bestDate, roundId: cell.bestRoundId
          });
        }
      });
      courses.push({
        courseKey: key,
        rounds: roundsHere,
        before: prior ? { total: prior.total, par: prior.par, holes: prior.holes.size } : null,
        after: { total: after.total, par: after.par, holes: after.holes.size },
        improved,
        newHoles,
        strokes
      });
    });
    courses.sort((a, b) => b.strokes - a.strokes || b.improved.length - a.improved.length
      || b.rounds - a.rounds || naturalCompare(a.courseKey, b.courseKey));
    return {
      courses,
      strokes: courses.reduce((s, c) => s + c.strokes, 0),
      holesImproved: courses.reduce((s, c) => s + c.improved.length, 0),
      newHoles: courses.reduce((s, c) => s + c.newHoles, 0)
    };
  }

  function recordsSection(before, through, mine, trophies) {
    if (typeof trophies !== "function" || !Eclectic || typeof Eclectic.diffRecords !== "function") {
      return { fell: [], reason: "unavailable" };
    }
    let beforeList = [];
    let afterList = [];
    try {
      beforeList = before.length ? trophies(before) : [];
      afterList = trophies(through);
    } catch { return { fell: [], reason: "unavailable" }; }
    const ids = new Set(mine.map((r) => r.id).filter((id) => id != null));
    const fell = Eclectic.diffRecords(beforeList, afterList).filter((rec) => rec.roundId != null && ids.has(rec.roundId));
    return { fell, reason: null };
  }

  // Putting and greens from detail rounds only, pooled over the holes where
  // putts were actually entered.
  function detailSection(mine, courseKey) {
    const isDetail = GolfMath && GolfMath.isDetailRound ? GolfMath.isDetailRound : (r) => !!r && r.entryMode !== "speed";
    const puttsKnown = GolfMath && GolfMath.puttsKnown ? GolfMath.puttsKnown : (h) => !!h && Number.isFinite(h.putts) && h.putts >= 0;
    const girKnown = GolfMath && GolfMath.girKnown ? GolfMath.girKnown : (h) => puttsKnown(h) && isScored(h);
    const detailRounds = mine.filter(isDetail);
    const series = detailRounds.map((r) => {
      const putted = r.holes.filter((h) => isScored(h) && puttsKnown(h));
      const greens = r.holes.filter(girKnown);
      return Object.assign(roundRef(r, courseKey), {
        puttHoles: putted.length,
        putts: putted.reduce((s, h) => s + h.putts, 0),
        girHoles: greens.length,
        girMade: greens.filter((h) => h.gir).length
      });
    });

    function trend(rows, valueOf, holesOf, scale) {
      const usable = rows.filter((row) => holesOf(row) > 0);
      const pooled = (list) => {
        const holes = list.reduce((s, row) => s + holesOf(row), 0);
        return holes ? (list.reduce((s, row) => s + valueOf(row), 0) / holes) * scale : null;
      };
      const n = usable.length;
      const window = trendWindow(n);
      const start = window ? r1(pooled(usable.slice(0, window))) : null;
      const now = window ? r1(pooled(usable.slice(n - window))) : null;
      return {
        rounds: n,
        holes: usable.reduce((s, row) => s + holesOf(row), 0),
        season: r1(pooled(usable)),
        window,
        start,
        now,
        change: start != null && now != null ? r1(now - start) : null,
        reason: n === 0 ? "none" : window ? null : "too-few"
      };
    }

    return {
      detailRounds: detailRounds.length,
      speedRounds: mine.length - detailRounds.length,
      // Putts per 18 holes (lower is better).
      putting: trend(series, (row) => row.putts, (row) => row.puttHoles, 18),
      // Greens in regulation, percent (higher is better).
      greens: trend(series, (row) => row.girMade, (row) => row.girHoles, 100),
      series
    };
  }

  function courseSection(mine, courseKey) {
    const map = new Map();
    mine.forEach((r) => {
      const key = courseKey(r) || "";
      if (!key) return;
      const entry = map.get(key) || { courseKey: key, rounds: 0, holes: 0, lastDate: "", roundIds: [] };
      entry.rounds += 1;
      entry.holes += scoredHoles(r).length;
      if (String(r.date) > entry.lastDate) entry.lastDate = String(r.date);
      entry.roundIds.push(r.id == null ? null : r.id);
      map.set(key, entry);
    });
    const courses = Array.from(map.values()).sort((a, b) => b.rounds - a.rounds || b.holes - a.holes
      || b.lastDate.localeCompare(a.lastDate) || naturalCompare(a.courseKey, b.courseKey));
    return { top: courses[0] || null, courses };
  }

  // ---- The story -------------------------------------------------------------

  function buildSeason(rounds, year, opts) {
    const o = opts || {};
    const y = String(year);
    const all = usableRounds(rounds);
    const mine = all.filter((r) => yearOf(r) === y);
    const today = typeof o.today === "string" ? o.today : "";
    if (!mine.length) return { state: "empty", year: y, inProgress: today.slice(0, 4) === y };
    const before = all.filter((r) => yearOf(r) < y);
    const through = before.concat(mine);
    const courseKey = courseKeyFn(o);
    return {
      state: "ready",
      year: y,
      inProgress: today.slice(0, 4) === y,
      firstSeason: before.length === 0,
      roundIds: mine.map((r) => (r.id == null ? null : r.id)),
      played: playedSection(mine),
      best: bestSection(mine, courseKey),
      scoring: scoringSection(mine, courseKey),
      handicap: handicapSection(before, mine, o.handicapOf, courseKey),
      improvement: improvementSection(mine, o),
      nemesis: nemesisSection(through, mine, o),
      eclectic: eclecticSection(before, through, mine, o),
      records: recordsSection(before, through, mine, o.trophies),
      detail: detailSection(mine, courseKey),
      courses: courseSection(mine, courseKey)
    };
  }

  // ---- Words -------------------------------------------------------------------

  const plural = (n, word, many) => `${n} ${n === 1 ? word : (many || `${word}s`)}`;
  const fmt1 = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

  // One honest sentence for the top of the story. Celebrates what improved and
  // never scolds: a worse index or average simply isn't the headline.
  function headline(story) {
    if (!story || story.state !== "ready") return null;
    const h = story.handicap;
    const s = story.scoring;
    const played = story.played;
    if (h && h.change != null && h.change <= -1) {
      return { kind: "handicap", text: `Your index fell ${fmt1(-h.change)}, from ${fmt1(h.start)} to ${fmt1(h.now)}.` };
    }
    if (s && s.change != null && s.change <= -1) {
      return { kind: "scoring", text: `You shot ${fmt1(-s.change)} strokes better, ${fmt1(s.start)} to ${fmt1(s.now)} on average.` };
    }
    const fell = story.records ? story.records.fell.length : 0;
    if (fell && !story.firstSeason) {
      return { kind: "records", text: `${plural(fell, "personal record")} fell.` };
    }
    if (story.firstSeason) {
      return { kind: "first", text: `Your first season on the Ledger: ${plural(played.rounds, "round")}, ${plural(played.holes, "hole")}.` };
    }
    return { kind: "played", text: `${plural(played.rounds, "round")} and ${plural(played.holes, "hole")} in the books.` };
  }

  // A plain-text line for the share sheet / clipboard.
  function shareLine(story, options) {
    if (!story || story.state !== "ready") return "";
    const appName = (options && options.appName) || "Fairway Ledger";
    const bits = [`${plural(story.played.rounds, "round")}, ${plural(story.played.holes, "hole")}`];
    if (story.best) bits.push(`best ${story.best.gross}${story.best.holes === 9 ? " (9)" : ""}`);
    const s = story.scoring;
    if (s.change != null) bits.push(`avg ${fmt1(s.start)} → ${fmt1(s.now)}`);
    else if (s.avg != null) bits.push(`avg ${fmt1(s.avg)}`);
    const h = story.handicap;
    if (h.change != null && h.change !== 0) bits.push(`index ${fmt1(h.start)} → ${fmt1(h.now)}`);
    else if (h.now != null) bits.push(`index ${fmt1(h.now)}`);
    const fell = story.records.fell.length;
    if (fell && !story.firstSeason) bits.push(`${plural(fell, "record")} fell`);
    if (story.nemesis.holes) bits.push(`${plural(story.nemesis.holes, "nemesis", "nemeses")} beaten`);
    const lead = `My ${story.year} in golf${story.inProgress ? " so far" : ""}`;
    return `${lead}: ${bits.join(" · ")} — ${appName}`;
  }

  return {
    MIN_REPEAT_PLAYS,
    MIN_IMPROVE,
    MIN_TREND_ROUNDS,
    TREND_WINDOW,
    seasonYears,
    buildSeason,
    headline,
    shareLine
  };
});
