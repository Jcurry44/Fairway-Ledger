/*
 * Unit tests for scripts/golf-lab-course-gap-report.js - course repair queue reporting.
 *
 * Run: node --test tests/golf-lab-course-gap-report-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  parseArgs,
  buildCourseGapReport,
  loadCourseGapReport,
  writeCourseGapReport
} = require("../scripts/golf-lab-course-gap-report.js");

test("parseArgs: reads course gap report options", () => {
  const args = parseArgs(["--in", "warehouse", "--out", "gaps.csv", "--summary", "summary.json"]);

  assert.equal(args.inputDir, "warehouse");
  assert.equal(args.outputFile, "gaps.csv");
  assert.equal(args.summaryFile, "summary.json");
});

test("buildCourseGapReport: ranks event and round course gaps", () => {
  const events = [
    { id: "event-a", name: "A Open", season: "2025", startDate: "2025-01-01", courseId: "", courseName: "" },
    { id: "event-b", name: "B Open", season: "2025", startDate: "2025-02-01", courseId: "course-b", courseName: "Course B" },
    { id: "event-c", name: "C Open", season: "2026", startDate: "2026-03-01", courseId: "course-c", courseName: "Course C" }
  ];
  const rounds = [
    { eventId: "event-a", courseId: "", courseName: "" },
    { eventId: "event-a", courseId: "", courseName: "" },
    { eventId: "event-b", courseId: "", courseName: "" },
    { eventId: "event-b", courseId: "course-b", courseName: "Course B" },
    { eventId: "event-c", courseId: "course-c", courseName: "Course C" }
  ];

  const report = buildCourseGapReport(events, rounds);

  assert.equal(report.summary.eventsMissingCourse, 1);
  assert.equal(report.summary.roundsMissingCourse, 3);
  assert.equal(report.summary.gapEvents, 2);
  assert.equal(report.summary.eventCourseCoveragePct, "66.7");
  assert.equal(report.gapRows[0].eventId, "event-a");
  assert.equal(report.gapRows[0].severity, "event-and-rounds");
  assert.equal(report.gapRows[1].severity, "rounds");
});

test("buildCourseGapReport: treats event course pools as event-level course coverage", () => {
  const events = [
    { id: "event-a", name: "A Open", season: "2025", startDate: "2025-01-01", courseId: "", courseName: "" },
    { id: "event-b", name: "B Open", season: "2025", startDate: "2025-02-01", courseId: "", courseName: "" }
  ];
  const rounds = [
    { eventId: "event-a", courseId: "", courseName: "" },
    { eventId: "event-b", courseId: "", courseName: "" },
    { eventId: "event-b", courseId: "", courseName: "" }
  ];
  const eventCourses = [
    { eventId: "event-b", courseId: "course-b1", courseName: "Course B1" },
    { eventId: "event-b", courseId: "course-b2", courseName: "Course B2" }
  ];

  const report = buildCourseGapReport(events, rounds, eventCourses);

  assert.equal(report.summary.eventsMissingCourse, 1);
  assert.equal(report.summary.eventsWithCoursePool, 1);
  assert.equal(report.summary.eventsWithSingleCourse, 0);
  assert.equal(report.summary.eventCourseCoveragePct, "50");
  assert.equal(report.gapRows[0].eventId, "event-b");
  assert.equal(report.gapRows[0].severity, "rounds-course-pool");
  assert.equal(report.gapRows[0].coursePoolCourses, "2");
  assert.equal(report.gapRows[0].courseName, "Course B1 / Course B2");
});

test("loadCourseGapReport and writeCourseGapReport: read warehouse CSVs and write outputs", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-course-gaps-"));
  try {
    await fsp.writeFile(path.join(tempRoot, "events.csv"), [
      "id,name,tour,season,startDate,endDate,courseId,courseName,fieldStrength,status,sourceProvider,sourceUrl,sourceUpdatedAt",
      "event-a,A Open,PGA TOUR,2025,2025-01-01,2025-01-04,,,,Final,ESPN,https://example.com,2026-06-20T12:00:00Z"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(tempRoot, "rounds.csv"), [
      "id,playerId,playerName,eventId,courseId,courseName,roundNumber,date,score,toPar,adjustedToPar,sgTotal,difficultyBucket,sourceProvider,sourceUrl,sourceUpdatedAt",
      "round-a,player-a,Player A,event-a,,,1,2025-01-01,70,-2,-1,1,Easy,ESPN,https://example.com,2026-06-20T12:00:00Z"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(tempRoot, "event_courses.csv"), [
      "id,eventId,courseId,courseName,location,courseOrder,roundNumbers,rotationRole,par,yards,confidence,note,sourceProvider,sourceUrl,sourceUpdatedAt",
      "pool-a,event-a,course-a,Course A,,1,,Rotation,,,,verified,,Source,https://example.com,2026-06-20T12:00:00Z"
    ].join("\n"), "utf8");

    const report = await loadCourseGapReport(tempRoot);
    const csvFile = path.join(tempRoot, "gaps.csv");
    const summaryFile = path.join(tempRoot, "summary.json");
    await writeCourseGapReport(report, { outputFile: csvFile, summaryFile });

    const csv = await fsp.readFile(csvFile, "utf8");
    const summary = JSON.parse(await fsp.readFile(summaryFile, "utf8"));

    assert.ok(csv.includes("rounds-course-pool,2025,event-a,A Open"));
    assert.equal(summary.summary.gapEvents, 1);
    assert.equal(summary.summary.eventsMissingCourse, 0);
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
