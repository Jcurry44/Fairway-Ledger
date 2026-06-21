/*
 * Unit tests for scripts/golf-lab-course-repairs.js - verified course repair applier.
 *
 * Run: node --test tests/golf-lab-course-repairs-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const {
  parseArgs,
  normalizeRepair,
  applyCourseRepairsToTables,
  applyCourseRepairs
} = require("../scripts/golf-lab-course-repairs.js");

test("parseArgs: reads course repair options", () => {
  const args = parseArgs(["--repairs", "repairs.csv", "--out", "warehouse", "--provider", "Verified", "--fetched-at", "2026-06-20T13:00:00-04:00"]);

  assert.equal(args.repairsFile, "repairs.csv");
  assert.equal(args.outputDir, "warehouse");
  assert.equal(args.provider, "Verified");
  assert.equal(args.fetchedAt, "2026-06-20T13:00:00-04:00");
});

test("normalizeRepair: builds a stable course id when one is not supplied", () => {
  const repair = normalizeRepair({
    eventId: "event-a",
    courseName: "Royal Test Golf Club",
    location: "Test City, TS"
  }, {
    fetchedAt: "2026-06-20T13:00:00-04:00"
  });

  assert.equal(repair.courseId, "royal-test-golf-club-test-city-ts");
  assert.equal(repair.sourceProvider, "Verified public course repair");
});

test("applyCourseRepairsToTables: updates events, rounds, courses, setups, and source proof", () => {
  const existing = {
    events: [{ id: "event-a", name: "A Open", season: "2025", sourceProvider: "ESPN", sourceUpdatedAt: "2026-06-19T00:00:00Z" }],
    rounds: [
      { id: "round-a1", eventId: "event-a", adjustedToPar: "1.5", sourceProvider: "ESPN" },
      { id: "round-a2", eventId: "event-a", adjustedToPar: "-0.5", sourceProvider: "ESPN" }
    ],
    courses: [],
    courseSetups: [],
    sourceFetches: []
  };
  const repairs = [{
    eventId: "event-a",
    courseId: "course-a",
    courseName: "Course A",
    location: "City, ST",
    par: "71",
    yards: "7200",
    sourceProvider: "Verified",
    sourceUrl: "https://example.com/course",
    sourceUpdatedAt: "2026-06-20T13:00:00-04:00"
  }];

  const result = applyCourseRepairsToTables(existing, repairs, {
    provider: "Verified",
    fetchedAt: "2026-06-20T13:00:00-04:00"
  });

  assert.equal(result.summary.repairs, 1);
  assert.equal(result.summary.eventsUpdated, 1);
  assert.equal(result.summary.roundsUpdated, 2);
  assert.equal(result.tables.events[0].courseName, "Course A");
  assert.equal(result.tables.rounds[0].courseId, "course-a");
  assert.equal(result.tables.courses[0].sgDifficulty, "-0.5");
  assert.equal(result.tables.courseSetups[0].fieldAdjustedToPar, "0.5");
  assert.equal(result.tables.sourceFetches[0].rowCount, 1);
});

test("applyCourseRepairsToTables: course difficulty averages existing and repaired setups", () => {
  const existing = {
    events: [{ id: "event-a", name: "A Open" }],
    rounds: [{ id: "round-a1", eventId: "event-a", adjustedToPar: "0.5", sourceProvider: "ESPN" }],
    courses: [{ id: "course-a", name: "Course A", fieldAdjustedToPar: "2", sgDifficulty: "-2" }],
    courseSetups: [{ id: "old-setup", eventId: "old-event", courseId: "course-a", fieldAdjustedToPar: "1.5", sgDifficulty: "-1.5" }],
    sourceFetches: []
  };
  const result = applyCourseRepairsToTables(existing, [{
    eventId: "event-a",
    courseId: "course-a",
    courseName: "Course A",
    sourceProvider: "Verified"
  }]);

  assert.equal(result.tables.courses[0].fieldAdjustedToPar, "1");
  assert.equal(result.tables.courses[0].sgDifficulty, "-1");
});

test("applyCourseRepairs: persists repaired warehouse CSVs", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-course-repairs-"));
  try {
    await fsp.writeFile(path.join(tempRoot, "events.csv"), [
      "id,name,tour,season,startDate,endDate,courseId,courseName,fieldStrength,status,sourceProvider,sourceUrl,sourceUpdatedAt",
      "event-a,A Open,PGA TOUR,2025,2025-01-01,2025-01-04,,,,Final,ESPN,https://example.com,2026-06-19T00:00:00Z"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(tempRoot, "rounds.csv"), [
      "id,playerId,playerName,eventId,courseId,courseName,roundNumber,date,score,toPar,adjustedToPar,sgTotal,difficultyBucket,sourceProvider,sourceUrl,sourceUpdatedAt",
      "round-a1,player-a,Player A,event-a,,,1,2025-01-01,70,-2,1.5,1,Easy,ESPN,https://example.com,2026-06-19T00:00:00Z"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(tempRoot, "courses.csv"), `${Warehouse.COLLECTION_COLUMNS.courses.join(",")}\n`, "utf8");
    await fsp.writeFile(path.join(tempRoot, "course_setups.csv"), `${Warehouse.COLLECTION_COLUMNS.courseSetups.join(",")}\n`, "utf8");
    await fsp.writeFile(path.join(tempRoot, "source_fetches.csv"), `${Warehouse.COLLECTION_COLUMNS.sourceFetches.join(",")}\n`, "utf8");
    const repairsFile = path.join(tempRoot, "repairs.csv");
    await fsp.writeFile(repairsFile, [
      "eventId,courseId,courseName,location,par,yards,sourceProvider,sourceUrl,sourceUpdatedAt",
      "event-a,course-a,Course A,\"City, ST\",71,7200,Verified,https://example.com/course,2026-06-20T13:00:00-04:00"
    ].join("\n"), "utf8");

    const result = await applyCourseRepairs(repairsFile, tempRoot, {
      provider: "Verified",
      fetchedAt: "2026-06-20T13:00:00-04:00"
    });
    const events = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "events.csv"), "utf8"));
    const rounds = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "rounds.csv"), "utf8"));

    assert.equal(result.summary.roundsUpdated, 1);
    assert.equal(events[0].courseId, "course-a");
    assert.equal(rounds[0].courseName, "Course A");
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
