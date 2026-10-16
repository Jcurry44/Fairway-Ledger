/*
 * Unit tests for lib/season.js — the Season Story.
 *
 * Run:  node --test tests/*.test.js
 * (Uses only the Node built-in test runner + assert — no dependencies.)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../lib/season.js");

// ---- Fixtures ----------------------------------------------------------------

const PARS18 = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5]; // 72
const PARS9 = PARS18.slice(0, 9); // 36

// Tee variants pool into one physical course ("ridge-blue" + "ridge-white" =>
// "ridge"), the way app.js physicalCourseName does.
const courseKey = (round) => String(round.courseId || "").replace(/-(blue|white|red)$/, "");
const holeKey = (round, hole) => `${courseKey(round)}:${hole.number}`;
const OPTS = { eclecticOpts: { courseKey, holeKey } };

// scores: a number per hole (null = not entered). extra: per-hole overrides.
function round(id, date, courseId, scores, extra) {
  const e = extra || {};
  const pars = e.pars || (scores.length === 9 ? PARS9 : PARS18);
  return {
    id,
    date,
    courseId,
    entryMode: e.entryMode || "hole",
    holes: scores.map((score, i) => ({
      number: i + 1,
      label: String(i + 1),
      par: pars[i],
      score,
      putts: e.putts ? e.putts[i] : null,
      gir: e.gir ? e.gir[i] : false
    }))
  };
}

// Every hole at par + `over`, i.e. gross = 72 + 18*over for an 18.
const even18 = (over) => PARS18.map((p) => p + over);
// An 18 with a given gross: spread the extra strokes over the first holes.
function gross18(total) {
  const scores = PARS18.slice();
  let extra = total - 72;
  for (let i = 0; extra > 0; i = (i + 1) % 18, extra -= 1) scores[i] += 1;
  return scores;
}

// ---- Years + empty ---------------------------------------------------------------

test("seasonYears: newest first, ignores rounds with no date or no scores", () => {
  const rounds = [
    round("a", "2025-06-01", "ridge-blue", gross18(90)),
    round("b", "2026-05-01", "ridge-blue", gross18(88)),
    round("c", "", "ridge-blue", gross18(80)),
    round("d", "2024-07-01", "ridge-blue", PARS18.map(() => null))
  ];
  assert.deepEqual(S.seasonYears(rounds), ["2026", "2025"]);
  assert.deepEqual(S.seasonYears([]), []);
  assert.deepEqual(S.seasonYears(null), []);
});

test("buildSeason: a year with no rounds is empty, and in progress when it is this year", () => {
  const rounds = [round("a", "2025-06-01", "ridge-blue", gross18(90))];
  assert.deepEqual(S.buildSeason(rounds, 2026, { today: "2026-10-16" }), { state: "empty", year: "2026", inProgress: true });
  assert.equal(S.buildSeason(rounds, 2024, { today: "2026-10-16" }).inProgress, false);
});

// ---- Played + best -----------------------------------------------------------------

test("played: rounds, scored holes, complete 18s / 9s / unfinished, months with gaps filled", () => {
  const rounds = [
    round("a", "2026-04-20", "ridge-blue", gross18(90)),
    round("b", "2026-06-02", "ridge-blue", PARS9.map((p) => p + 1)),
    round("c", "2026-06-20", "ridge-blue", gross18(88).map((s, i) => (i === 17 ? null : s)))
  ];
  const story = S.buildSeason(rounds, "2026", OPTS);
  assert.equal(story.played.rounds, 3);
  assert.equal(story.played.holes, 18 + 9 + 17);
  assert.equal(story.played.eighteens, 1); // the 17-hole card is unfinished, not an 18
  assert.equal(story.played.nines, 1);
  assert.equal(story.played.unfinished, 1);
  assert.deepEqual(story.played.byMonth.map((m) => [m.month, m.rounds]), [
    ["2026-04", 1], ["2026-05", 0], ["2026-06", 2]
  ]);
});

test("best: lowest complete 18, earliest wins a tie, an unfinished 18 never counts", () => {
  const rounds = [
    round("late", "2026-08-01", "ridge-blue", gross18(84)),
    round("early", "2026-05-01", "ridge-blue", gross18(84)),
    round("partial", "2026-06-01", "ridge-blue", gross18(75).map((s, i) => (i > 14 ? null : s))),
    round("nine", "2026-07-01", "ridge-blue", PARS9.slice())
  ];
  const best = S.buildSeason(rounds, "2026", OPTS).best;
  assert.equal(best.roundId, "early");
  assert.equal(best.gross, 84);
  assert.equal(best.toPar, 12);
  assert.equal(best.holes, 18);
  assert.equal(best.courseKey, "ridge");
});

test("best: falls back to the best complete 9 when there is no complete 18", () => {
  const rounds = [
    round("n1", "2026-05-01", "ridge-blue", PARS9.map((p) => p + 1)),
    round("n2", "2026-05-08", "ridge-blue", PARS9.map((p) => p + 2))
  ];
  const best = S.buildSeason(rounds, "2026", OPTS).best;
  assert.equal(best.roundId, "n1");
  assert.equal(best.gross, 45);
  assert.equal(best.holes, 9);
});

// ---- Scoring average -------------------------------------------------------------------

test("scoring: fewer than 4 complete 18s gives an average but no start -> now", () => {
  const rounds = [
    round("a", "2026-05-01", "ridge-blue", gross18(90)),
    round("b", "2026-05-08", "ridge-blue", gross18(86)),
    round("c", "2026-05-15", "ridge-blue", gross18(85)),
    round("n", "2026-05-20", "ridge-blue", PARS9.slice())
  ];
  const s = S.buildSeason(rounds, "2026", OPTS).scoring;
  assert.equal(s.rounds, 3);
  assert.equal(s.avg, 87);
  assert.equal(s.window, 0);
  assert.equal(s.start, null);
  assert.equal(s.change, null);
  assert.equal(s.reason, "too-few");
});

test("scoring: first N vs last N, N = min(5, half), 18-hole rounds only", () => {
  const grosses = [92, 90, 91, 88, 87, 86];
  const rounds = grosses.map((g, i) => round(`r${i}`, `2026-05-${String(i + 1).padStart(2, "0")}`, "ridge-blue", gross18(g)));
  rounds.push(round("nine", "2026-05-03", "ridge-blue", PARS9.map((p) => p + 3)));
  const s = S.buildSeason(rounds, "2026", OPTS).scoring;
  assert.equal(s.rounds, 6);
  assert.equal(s.window, 3);
  assert.equal(s.start, 91);
  assert.equal(s.now, 87);
  assert.equal(s.change, -4);
  assert.equal(s.series.length, 6);

  const many = Array.from({ length: 12 }, (_, i) =>
    round(`m${i}`, `2026-06-${String(i + 1).padStart(2, "0")}`, "ridge-blue", gross18(100 - i)));
  const m = S.buildSeason(many, "2026", OPTS).scoring;
  assert.equal(m.window, 5);
  assert.equal(m.start, 98); // 100..96
  assert.equal(m.now, 91);   // 93..89
  assert.equal(m.change, -7);
});

test("scoring: change is computed from the rounded start and now so the words add up", () => {
  // start = (90+91)/2 = 90.5 -> 90.5; now = (87+86)/2 = 86.5; change -4.
  const grosses = [90, 91, 87, 86];
  const rounds = grosses.map((g, i) => round(`r${i}`, `2026-05-0${i + 1}`, "ridge-blue", gross18(g)));
  const s = S.buildSeason(rounds, "2026", OPTS).scoring;
  assert.equal(s.start, 90.5);
  assert.equal(s.now, 86.5);
  assert.equal(s.change, r1(s.now - s.start));
});
function r1(x) { return Math.round(x * 10) / 10; }

// ---- Handicap ------------------------------------------------------------------------------

// A fake estimate: average gross minus 72 of the 18s seen, needs 3 rounds.
function fakeHandicap(list) {
  const eighteens = list.filter((r) => r.holes.length === 18);
  if (eighteens.length < 3) return null;
  const total = eighteens.reduce((s, r) => s + r.holes.reduce((t, h) => t + (h.score || 0), 0), 0);
  return total / eighteens.length - 72;
}

test("handicap: start carries over from earlier seasons; now is through this year only", () => {
  const rounds = [
    round("p1", "2025-06-01", "ridge-blue", gross18(92)),
    round("p2", "2025-07-01", "ridge-blue", gross18(92)),
    round("p3", "2025-08-01", "ridge-blue", gross18(92)),
    round("t1", "2026-05-01", "ridge-blue", gross18(84)),
    round("t2", "2026-06-01", "ridge-blue", gross18(84)),
    round("t3", "2026-07-01", "ridge-blue", gross18(84)),
    round("next", "2027-05-01", "ridge-blue", gross18(70))
  ];
  const h = S.buildSeason(rounds, "2026", Object.assign({ handicapOf: fakeHandicap }, OPTS)).handicap;
  assert.equal(h.startKind, "carried");
  assert.equal(h.start, 20);
  assert.equal(h.now, 16);
  assert.equal(h.change, -4);
  assert.equal(h.trail.length, 3);
  assert.deepEqual(h.trail.map((t) => t.roundId), ["t1", "t2", "t3"]);
});

test("handicap: a first season starts at the first estimate, and says after which round", () => {
  const rounds = [90, 90, 90, 84, 84].map((g, i) => round(`t${i}`, `2026-05-0${i + 1}`, "ridge-blue", gross18(g)));
  const h = S.buildSeason(rounds, "2026", Object.assign({ handicapOf: fakeHandicap }, OPTS)).handicap;
  assert.equal(h.startKind, "first");
  assert.equal(h.start, 18);
  assert.equal(h.startRef.roundNumber, 3);
  assert.equal(h.startRef.roundId, "t2");
  assert.equal(h.now, 15.6);
  assert.equal(h.change, -2.4);
  assert.equal(h.trail[0].index, null);
});

test("handicap: missing or throwing estimator is reported, not guessed", () => {
  const rounds = [round("a", "2026-05-01", "ridge-blue", gross18(90))];
  const none = S.buildSeason(rounds, "2026", OPTS).handicap;
  assert.equal(none.reason, "unavailable");
  assert.equal(none.now, null);
  const boom = S.buildSeason(rounds, "2026", Object.assign({ handicapOf: () => { throw new Error("x"); } }, OPTS)).handicap;
  assert.equal(boom.now, null);
  assert.equal(boom.reason, "unavailable");
  const few = S.buildSeason(rounds, "2026", Object.assign({ handicapOf: () => null }, OPTS)).handicap;
  assert.equal(few.reason, "too-few");
});

// ---- Biggest hole improvement -------------------------------------------------------------------

test("improvement: 4+ plays and 0.3+ strokes, pooled across tees by physical hole", () => {
  const scores = (h7) => even18(1).map((s, i) => (i === 6 ? h7 : s));
  // Hole 7 is a par 3: 6, 5 early (avg 5.5) then 3, 3 late (avg 3.0).
  const rounds = [
    round("a", "2026-05-01", "ridge-blue", scores(6)),
    round("b", "2026-05-08", "ridge-white", scores(5)),
    round("c", "2026-05-15", "ridge-blue", scores(3)),
    round("d", "2026-05-22", "ridge-white", scores(3))
  ];
  const imp = S.buildSeason(rounds, "2026", OPTS).improvement;
  assert.equal(imp.reason, null);
  assert.equal(imp.hole.key, "ridge:7");
  assert.equal(imp.hole.courseKey, "ridge");
  assert.equal(imp.hole.plays, 4);
  assert.equal(imp.hole.earlyAvg, 5.5);
  assert.equal(imp.hole.lateAvg, 3);
  assert.equal(imp.hole.gain, 2.5);
  assert.deepEqual(imp.hole.ref, { roundId: "d", number: 7 });
  assert.equal(imp.hole.series.length, 4);
});

test("improvement: says why when nothing qualifies", () => {
  const three = [1, 2, 3].map((i) => round(`r${i}`, `2026-05-0${i}`, "ridge-blue", even18(1)));
  assert.equal(S.buildSeason(three, "2026", OPTS).improvement.reason, "none-repeated");
  assert.equal(S.buildSeason(three, "2026", OPTS).improvement.hole, null);
  const flat = [1, 2, 3, 4].map((i) => round(`r${i}`, `2026-05-0${i}`, "ridge-blue", even18(1)));
  const imp = S.buildSeason(flat, "2026", OPTS).improvement;
  assert.equal(imp.reason, "none-improved");
  assert.equal(imp.candidates, 18);
});

test("improvement: only this year's plays count", () => {
  const scores = (h1) => even18(1).map((s, i) => (i === 0 ? h1 : s));
  const rounds = [
    round("old1", "2025-05-01", "ridge-blue", scores(9)),
    round("old2", "2025-05-02", "ridge-blue", scores(9)),
    round("a", "2026-05-01", "ridge-blue", scores(5)),
    round("b", "2026-05-02", "ridge-blue", scores(5)),
    round("c", "2026-05-03", "ridge-blue", scores(5))
  ];
  assert.equal(S.buildSeason(rounds, "2026", OPTS).improvement.reason, "none-repeated");
});

// ---- Nemesis slain -------------------------------------------------------------------------------------

test("nemesis: beating the hole that usually beats you counts in the year you did it", () => {
  const scores = (h4) => even18(0).map((s, i) => (i === 3 ? h4 : s)); // hole 4 is a par 5
  const rounds = [
    round("a", "2025-05-01", "ridge-blue", scores(8)),
    round("b", "2025-06-01", "ridge-blue", scores(8)),
    round("c", "2025-07-01", "ridge-blue", scores(8)),
    round("rev", "2026-05-01", "ridge-blue", scores(5)),
    round("other", "2026-06-01", "ridge-blue", scores(8))
  ];
  const n = S.buildSeason(rounds, "2026", OPTS).nemesis;
  assert.equal(n.events.length, 1);
  assert.equal(n.holes, 1);
  assert.deepEqual(n.events[0], { roundId: "rev", date: "2026-05-01", courseKey: "ridge", key: "ridge:4", group: null, label: "4", score: 5, par: 5 });
  assert.equal(S.buildSeason(rounds, "2025", OPTS).nemesis.events.length, 0);
});

// ---- Eclectic movement ---------------------------------------------------------------------------------

test("eclectic: strokes knocked off holes you'd already played, plus new holes", () => {
  const rounds = [
    round("old", "2025-05-01", "ridge-blue", PARS9.map((p) => p + 2)),
    round("a", "2026-05-01", "ridge-white", PARS9.map((p, i) => (i === 0 ? p : p + 2))),
    round("b", "2026-06-01", "ridge-blue", even18(2).map((s, i) => (i === 1 ? PARS18[1] - 1 : s))),
    round("lake", "2026-07-01", "lake", PARS9.map((p) => p + 1))
  ];
  const ec = S.buildSeason(rounds, "2026", OPTS).eclectic;
  const ridge = ec.courses.find((c) => c.courseKey === "ridge");
  assert.equal(ridge.rounds, 2);
  assert.deepEqual(ridge.before, { total: 36 + 18, par: 36, holes: 9 });
  assert.equal(ridge.after.holes, 18);
  assert.equal(ridge.newHoles, 9);
  assert.deepEqual(ridge.improved.map((c) => [c.key, c.from, c.to, c.roundId]), [
    ["ridge:1", 6, 4, "a"],
    ["ridge:2", 6, 3, "b"]
  ]);
  assert.equal(ridge.strokes, 5);
  const lake = ec.courses.find((c) => c.courseKey === "lake");
  assert.equal(lake.before, null);
  assert.equal(lake.newHoles, 9);
  assert.equal(lake.strokes, 0);
  assert.equal(ec.strokes, 5);
  assert.equal(ec.holesImproved, 2);
  assert.equal(ec.courses[0].courseKey, "ridge");
});

// ---- Records -----------------------------------------------------------------------------------------------

// A tiny Trophy Room: lowest 18 gross, credited to its round.
function fakeTrophies(list) {
  let best = null;
  list.forEach((r) => {
    if (r.holes.length !== 18) return;
    const gross = r.holes.reduce((s, h) => s + h.score, 0);
    if (!best || gross < best.gross) best = { gross, id: r.id };
  });
  return best ? [{ id: "low-18-gross", label: "Lowest 18", value: String(best.gross), roundId: best.id }] : [];
}

test("records: what fell this year, from the Jan 1 value to the year-end value", () => {
  const rounds = [
    round("old", "2025-05-01", "ridge-blue", gross18(90)),
    round("a", "2026-05-01", "ridge-blue", gross18(88)),
    round("b", "2026-06-01", "ridge-blue", gross18(85)),
    round("next", "2027-06-01", "ridge-blue", gross18(80))
  ];
  const story = S.buildSeason(rounds, "2026", Object.assign({ trophies: fakeTrophies }, OPTS));
  assert.equal(story.firstSeason, false);
  assert.deepEqual(story.records.fell, [{ id: "low-18-gross", label: "Lowest 18", from: "90", to: "85", roundId: "b" }]);
  const quiet = S.buildSeason(rounds.slice(0, 1).concat([round("x", "2026-05-01", "ridge-blue", gross18(95))]), "2026",
    Object.assign({ trophies: fakeTrophies }, OPTS));
  assert.deepEqual(quiet.records.fell, []);
});

test("records: a first season sets records from nothing; no trophies fn is reported", () => {
  const rounds = [round("a", "2026-05-01", "ridge-blue", gross18(88))];
  const story = S.buildSeason(rounds, "2026", Object.assign({ trophies: fakeTrophies }, OPTS));
  assert.equal(story.firstSeason, true);
  assert.equal(story.records.fell[0].from, null);
  assert.equal(S.buildSeason(rounds, "2026", OPTS).records.reason, "unavailable");
});

// ---- Putting + greens (honest data) --------------------------------------------------------------------------

test("detail: speed rounds and blank putts stay out; putts are per 18 over entered holes", () => {
  const two = PARS18.map(() => 2);
  const rounds = [
    round("s", "2026-05-01", "ridge-blue", even18(1), { entryMode: "speed", putts: PARS18.map(() => 1), gir: PARS18.map(() => true) }),
    // 9 holes entered at 2 putts, 9 blank: 36 per 18, not 18.
    round("h", "2026-05-02", "ridge-blue", even18(1), { putts: two.map((p, i) => (i < 9 ? p : null)), gir: PARS18.map((_, i) => i < 3) })
  ];
  const d = S.buildSeason(rounds, "2026", OPTS).detail;
  assert.equal(d.detailRounds, 1);
  assert.equal(d.speedRounds, 1);
  assert.equal(d.putting.rounds, 1);
  assert.equal(d.putting.holes, 9);
  assert.equal(d.putting.season, 36);
  assert.equal(d.putting.reason, "too-few");
  assert.equal(d.greens.holes, 9);
  assert.equal(d.greens.season, r1((3 / 9) * 100));
});

test("detail: putting and greens trends compare the first N with the last N detail rounds", () => {
  const rounds = [36, 35, 33, 31].map((total, i) => {
    const putts = PARS18.map((_, h) => (h < total - 18 ? 2 : 1));
    const gir = PARS18.map((_, h) => h < 3 + i * 2);
    return round(`r${i}`, `2026-05-0${i + 1}`, "ridge-blue", even18(1), { putts, gir });
  });
  const d = S.buildSeason(rounds, "2026", OPTS).detail;
  assert.equal(d.putting.window, 2);
  assert.equal(d.putting.start, 35.5);
  assert.equal(d.putting.now, 32);
  assert.equal(d.putting.change, -3.5);
  assert.equal(d.greens.start, r1((8 / 36) * 100));
  assert.equal(d.greens.now, r1((16 / 36) * 100));
  assert.equal(d.series.length, 4);
});

// ---- Courses ----------------------------------------------------------------------------------------------------

test("courses: most-played physical course, tees pooled; ties go to more holes", () => {
  const rounds = [
    round("a", "2026-05-01", "ridge-blue", PARS9.slice()),
    round("b", "2026-05-02", "ridge-white", PARS9.slice()),
    round("c", "2026-05-03", "lake", gross18(80)),
    round("d", "2026-05-04", "lake", gross18(80))
  ];
  const c = S.buildSeason(rounds, "2026", OPTS).courses;
  assert.equal(c.top.courseKey, "lake");
  assert.equal(c.top.rounds, 2);
  assert.equal(c.top.holes, 36);
  assert.deepEqual(c.courses.map((x) => [x.courseKey, x.rounds, x.holes]), [["lake", 2, 36], ["ridge", 2, 18]]);
});

// ---- Words -----------------------------------------------------------------------------------------------------------

test("headline: celebrates a falling index first, never scolds a rising one", () => {
  const base = (handicap, scoring) => ({
    state: "ready", firstSeason: false, played: { rounds: 20, holes: 330 },
    handicap, scoring, records: { fell: [] }
  });
  assert.equal(S.headline(base({ start: 18.1, now: 14.3, change: -3.8 }, { change: null })).text,
    "Your index fell 3.8, from 18.1 to 14.3.");
  assert.equal(S.headline(base({ change: 1.5 }, { start: 90, now: 87.4, change: -2.6 })).kind, "scoring");
  const rising = S.headline(base({ change: 2 }, { change: 1 }));
  assert.equal(rising.kind, "played");
  assert.equal(rising.text, "20 rounds and 330 holes in the books.");
  assert.equal(S.headline({ state: "empty" }), null);
});

test("shareLine: plain text built only from facts that exist", () => {
  const rounds = [88, 87, 85, 84].map((g, i) => round(`r${i}`, `2026-05-0${i + 1}`, "ridge-blue", gross18(g)));
  const story = S.buildSeason(rounds, "2026", Object.assign({ today: "2026-10-16", handicapOf: fakeHandicap, trophies: fakeTrophies }, OPTS));
  const line = S.shareLine(story);
  assert.match(line, /^My 2026 in golf so far: 4 rounds, 72 holes · best 84 · avg 87\.5 → 84\.5 · index /);
  assert.match(line, / — Fairway Ledger$/);
  assert.doesNotMatch(line, /record/); // a first season's records aren't "fell"
  assert.equal(S.shareLine({ state: "empty" }), "");
});

// ---- Review fixes (Fable build review 2026-10-16) ----------------------------------------------------

test("undated rounds are history: they hold records and eclectics but never join a season", () => {
  const rounds = [
    round("undated", "", "ridge-blue", gross18(72)),
    round("a", "2026-05-01", "ridge-blue", gross18(88)),
    round("b", "2026-06-01", "ridge-blue", gross18(82))
  ];
  assert.deepEqual(S.seasonYears(rounds), ["2026"]);
  const story = S.buildSeason(rounds, "2026", Object.assign({ trophies: fakeTrophies }, OPTS));
  assert.equal(story.undated, 1);
  assert.equal(story.played.rounds, 2);
  assert.equal(story.firstSeason, false);
  // The undated 72 still holds the record, so nothing "fell" (Trophy Room agrees).
  assert.deepEqual(story.records.fell, []);
  // Its holes are already on the board, so this year's rounds can't be "new holes".
  assert.equal(story.eclectic.newHoles, 0);
});

test("a season of nines tells its scoring story in 9-hole rounds", () => {
  const rounds = [46, 45, 43, 42].map((g, i) => {
    const scores = PARS9.slice();
    let extra = g - 36;
    for (let h = 0; extra > 0; h = (h + 1) % 9, extra -= 1) scores[h] += 1;
    return round(`n${i}`, `2026-05-0${i + 1}`, "ridge-blue", scores);
  });
  const story = S.buildSeason(rounds, "2026", OPTS);
  assert.equal(story.scoring.rounds, 0);
  assert.equal(story.scoring.reason, "none");
  assert.equal(story.scoring9.rounds, 4);
  assert.equal(story.scoring9.start, 45.5);
  assert.equal(story.scoring9.now, 42.5);
  assert.equal(S.scoringFor(story), story.scoring9);
  assert.equal(S.headline(story).text, "You shot 3 strokes better per nine, 45.5 to 42.5 on average.");
  assert.match(S.shareLine(story), /avg \(9s\) 45\.5 → 42\.5/);
});

test("a 9-hole variant's name rides along with improvement, nemesis and eclectic holes", () => {
  const groupKey = (r) => (r.courseId.startsWith("cross-") ? r.courseId.slice(6) : null);
  const opts = { eclecticOpts: { courseKey: () => "cross", holeKey: (r, h) => `${r.courseId}:${h.number}`, groupKey } };
  const scores = (h1) => PARS9.map((p, i) => (i === 0 ? h1 : p + 1));
  const rounds = [
    round("a", "2026-05-01", "cross-red", scores(7)),
    round("b", "2026-05-02", "cross-red", scores(7)),
    round("c", "2026-05-03", "cross-red", scores(4)),
    round("d", "2026-05-04", "cross-red", scores(4))
  ];
  const story = S.buildSeason(rounds, "2026", opts);
  assert.equal(story.improvement.hole.group, "red");
  assert.equal(story.improvement.hole.label, "1");
});

// ---- Purity ----------------------------------------------------------------------------------------------------------

test("buildSeason never mutates its input", () => {
  const rounds = [
    round("b", "2026-06-01", "ridge-blue", gross18(85), { putts: PARS18.map(() => 2) }),
    round("a", "2026-05-01", "ridge-white", gross18(90)),
    round("old", "2025-05-01", "lake", gross18(95))
  ];
  const before = JSON.stringify(rounds);
  S.buildSeason(rounds, "2026", Object.assign({ handicapOf: fakeHandicap, trophies: fakeTrophies, today: "2026-10-16" }, OPTS));
  assert.equal(JSON.stringify(rounds), before);
  assert.deepEqual(rounds.map((r) => r.id), ["b", "a", "old"]);
});
