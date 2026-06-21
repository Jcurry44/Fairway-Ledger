/*
 * Unit tests for scripts/golf-lab-derived-scoring.js.
 *
 * Run: node --test tests/golf-lab-derived-scoring-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  parseArgs,
  buildDerivedScoring,
  deriveScoringForDirectory
} = require("../scripts/golf-lab-derived-scoring.js");

test("parseArgs: reads derived scoring options", () => {
  const args = parseArgs([
    "--in", "history",
    "--provider", "Owned SG",
    "--source-url", "https://example.com/methodology",
    "--fetched-at", "2026-06-19T18:00:00Z",
    "--min-round-field-size", "12",
    "--min-score", "55",
    "--max-score", "96",
    "--report", "derived-report.json",
    "--no-course-updates"
  ]);

  assert.equal(args.inputDir, "history");
  assert.equal(args.provider, "Owned SG");
  assert.equal(args.sourceUrl, "https://example.com/methodology");
  assert.equal(args.fetchedAt, "2026-06-19T18:00:00Z");
  assert.equal(args.minRoundFieldSize, 12);
  assert.equal(args.minScore, 55);
  assert.equal(args.maxScore, 96);
  assert.equal(args.reportFile, "derived-report.json");
  assert.equal(args.updateCourses, false);
});

test("buildDerivedScoring: creates field-relative SG Total and difficulty splits", () => {
  const result = buildDerivedScoring({
    events: [{
      id: "major-1",
      name: "Test Major",
      courseId: "oak",
      courseName: "Oak Club",
      sourceUrl: "https://example.com/event"
    }],
    courses: [{
      id: "oak",
      name: "Oak Club",
      par: 72
    }],
    rounds: [
      { id: "alpha-r1", eventId: "major-1", playerId: "alpha", playerName: "Alpha", courseId: "oak", courseName: "Oak Club", roundNumber: 1, score: 70, toPar: -2, sourceUrl: "https://example.com/r1" },
      { id: "beta-r1", eventId: "major-1", playerId: "beta", playerName: "Beta", courseId: "oak", courseName: "Oak Club", roundNumber: 1, score: 74, toPar: 2, sourceUrl: "https://example.com/r1" },
      { id: "alpha-r2", eventId: "major-1", playerId: "alpha", playerName: "Alpha", courseId: "oak", courseName: "Oak Club", roundNumber: 2, score: 76, toPar: 4, sourceUrl: "https://example.com/r2" },
      { id: "beta-r2", eventId: "major-1", playerId: "beta", playerName: "Beta", courseId: "oak", courseName: "Oak Club", roundNumber: 2, score: 78, toPar: 6, sourceUrl: "https://example.com/r2" }
    ],
    sourceFetches: []
  }, {
    provider: "Owned SG",
    fetchedAt: "2026-06-19T18:00:00Z",
    minRoundFieldSize: 2
  });

  const alphaRoundOne = result.tables.rounds.find((row) => row.id === "alpha-r1");
  const betaRoundTwo = result.tables.rounds.find((row) => row.id === "beta-r2");
  const course = result.tables.courses.find((row) => row.id === "oak");
  const setup = result.tables.courseSetups.find((row) => row.eventId === "major-1");

  assert.equal(result.report.derivedRounds, 4);
  assert.equal(result.report.roundGroups, 2);
  assert.equal(alphaRoundOne.sgTotal, 2);
  assert.equal(alphaRoundOne.adjustedToPar, -2);
  assert.equal(alphaRoundOne.difficultyBucket, "Neutral");
  assert.equal(betaRoundTwo.sgTotal, -1);
  assert.equal(betaRoundTwo.adjustedToPar, 1);
  assert.equal(betaRoundTwo.difficultyBucket, "Brutal");
  assert.equal(result.tables.strokesGained.length, 4);
  assert.equal(result.tables.strokesGained.find((row) => row.roundId === "alpha-r1").sgTotal, 2);
  assert.equal(result.tables.sourceFetches[0].provider, "Owned SG");
  assert.match(result.tables.sourceFetches[0].manifestJson, /field average score - player score/);
  assert.equal(setup.fieldAdjustedToPar, 2.5);
  assert.equal(setup.sgDifficulty, -2.5);
  assert.equal(course.fieldAdjustedToPar, 2.5);
  assert.equal(course.sgDifficulty, -2.5);
  assert.equal(result.report.hardestEvents[0].eventName, "Test Major");
});

test("buildDerivedScoring: skips thin round groups", () => {
  const result = buildDerivedScoring({
    rounds: [
      { id: "alpha-r1", eventId: "event-1", playerId: "alpha", playerName: "Alpha", roundNumber: 1, score: 70, toPar: -2 },
      { id: "beta-r1", eventId: "event-1", playerId: "beta", playerName: "Beta", roundNumber: 1, score: 74, toPar: 2 }
    ]
  }, {
    minRoundFieldSize: 3,
    fetchedAt: "2026-06-19T18:00:00Z"
  });

  assert.equal(result.report.derivedRounds, 0);
  assert.equal(result.report.skippedGroups, 1);
  assert.equal(result.tables.rounds[0].sgTotal, null);
  assert.equal(result.tables.strokesGained.length, 0);
});

test("buildDerivedScoring: excludes implausible scores and clears stale derived values", () => {
  const result = buildDerivedScoring({
    rounds: [
      { id: "alpha-r1", eventId: "event-1", playerId: "alpha", playerName: "Alpha", roundNumber: 1, score: 68, toPar: -4 },
      { id: "beta-r1", eventId: "event-1", playerId: "beta", playerName: "Beta", roundNumber: 1, score: 72, toPar: 0 },
      { id: "bad-r1", eventId: "event-1", playerId: "bad", playerName: "Bad Row", roundNumber: 1, score: 0, toPar: -72, adjustedToPar: -38.5, sgTotal: 38.5, difficultyBucket: "Easy", sourceProvider: "ESPN + Golf Lab derived scoring model" }
    ]
  }, {
    provider: "Golf Lab derived scoring model",
    fetchedAt: "2026-06-19T18:00:00Z",
    minRoundFieldSize: 2
  });

  const badRound = result.tables.rounds.find((row) => row.id === "bad-r1");

  assert.equal(result.report.invalidScoreRounds, 1);
  assert.equal(result.report.derivedRounds, 2);
  assert.equal(result.tables.strokesGained.length, 2);
  assert.equal(result.tables.strokesGained.some((row) => row.roundId === "bad-r1"), false);
  assert.equal(badRound.sgTotal, null);
  assert.equal(badRound.adjustedToPar, null);
  assert.equal(badRound.difficultyBucket, "");
  assert.equal(badRound.sourceProvider, "ESPN");
});

test("deriveScoringForDirectory: writes rounds, SG rows, sources, and report", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-derived-"));
  try {
    await fsp.writeFile(
      path.join(tempRoot, "events.csv"),
      [
        "id,name,tour,season,startDate,courseId,courseName,sourceProvider,sourceUrl,sourceUpdatedAt",
        "event-1,Test Open,PGA TOUR,2026,2026-06-18,course-1,Test Club,ESPN,https://example.com/event,2026-06-19T16:00:00Z"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(tempRoot, "courses.csv"),
      [
        "id,name,par,yards,sourceProvider,sourceUrl,sourceUpdatedAt",
        "course-1,Test Club,72,7400,Manual,https://example.com/course,2026-06-19T16:00:00Z"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(tempRoot, "course_setups.csv"),
      [
        "id,eventId,courseId,par,yards,rough,greenSpeed,firmness,sourceProvider,sourceUrl,sourceUpdatedAt",
        "event-1-course-1-setup,event-1,course-1,72,7420,Heavy,Fast,Firm,Manual,https://example.com/setup,2026-06-19T16:00:00Z"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(tempRoot, "rounds.csv"),
      [
        "id,playerId,playerName,eventId,courseId,courseName,roundNumber,date,score,toPar,sourceProvider,sourceUrl,sourceUpdatedAt",
        "alpha-r1,alpha,Alpha,event-1,course-1,Test Club,1,2026-06-18,68,-4,ESPN,https://example.com/scoreboard,2026-06-19T16:00:00Z",
        "beta-r1,beta,Beta,event-1,course-1,Test Club,1,2026-06-18,72,0,ESPN,https://example.com/scoreboard,2026-06-19T16:00:00Z"
      ].join("\n"),
      "utf8"
    );

    const reportFile = path.join(tempRoot, "derived-report.json");
    const result = await deriveScoringForDirectory(tempRoot, {
      provider: "Owned SG",
      fetchedAt: "2026-06-19T18:00:00Z",
      reportFile
    });
    const rounds = await fsp.readFile(path.join(tempRoot, "rounds.csv"), "utf8");
    const sgRows = await fsp.readFile(path.join(tempRoot, "strokes_gained.csv"), "utf8");
    const setups = await fsp.readFile(path.join(tempRoot, "course_setups.csv"), "utf8");
    const sources = await fsp.readFile(path.join(tempRoot, "source_fetches.csv"), "utf8");
    const report = JSON.parse(await fsp.readFile(reportFile, "utf8"));

    assert.equal(result.report.derivedRounds, 2);
    assert.match(rounds.split("\n")[0], /difficultyBucket/);
    assert.match(rounds, /alpha-r1,alpha,Alpha,event-1,course-1,Test Club,1,2026-06-18,68,-4,-2,2,Easy,ESPN \+ Owned SG/);
    assert.match(sgRows, /alpha-r1-derived-sg-total,alpha,Alpha,event-1,alpha-r1,round-1,2/);
    assert.match(setups, /event-1-course-1-setup,event-1,course-1,72,7420,Heavy,Fast,Firm,,-2,2,Manual \+ Owned SG/);
    assert.match(sources, /field-relative-round-sg-total/);
    assert.equal(report.derivedRounds, 2);

    await deriveScoringForDirectory(tempRoot, {
      provider: "Owned SG",
      fetchedAt: "2026-06-19T19:00:00Z",
      reportFile
    });
    const rerunSgRows = await fsp.readFile(path.join(tempRoot, "strokes_gained.csv"), "utf8");
    const rerunSources = await fsp.readFile(path.join(tempRoot, "source_fetches.csv"), "utf8");

    assert.equal((rerunSgRows.match(/derived-sg-total/g) || []).length, 2);
    assert.equal((rerunSources.match(/field-relative-round-sg-total/g) || []).length, 1);
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
