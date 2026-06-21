/*
 * Unit tests for scripts/golf-lab-course-inference.js - recurring course repair generation.
 *
 * Run: node --test tests/golf-lab-course-inference-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const {
  parseArgs,
  canonicalSeriesKey,
  buildCourseInference,
  loadCourseInference,
  writeCourseInference
} = require("../scripts/golf-lab-course-inference.js");

test("parseArgs: reads inference report options", () => {
  const args = parseArgs(["--in", "warehouse", "--out", "repairs.csv", "--summary", "summary.json", "--max-season", "2011"]);

  assert.equal(args.inputDir, "warehouse");
  assert.equal(args.outputFile, "repairs.csv");
  assert.equal(args.summaryFile, "summary.json");
  assert.equal(args.maxSeason, 2011);
});

test("canonicalSeriesKey: normalizes sponsor-renamed stable series", () => {
  assert.equal(canonicalSeriesKey("FBR Open"), "phoenix open");
  assert.equal(canonicalSeriesKey("Waste Management Phoenix Open"), "phoenix open");
  assert.equal(canonicalSeriesKey("Mercedes Championships"), "tournament of champions");
  assert.equal(canonicalSeriesKey("Hyundai Tournament of Champions"), "tournament of champions");
  assert.equal(canonicalSeriesKey("WGC-NEC Invitational"), "wgc bridgestone invitational");
});

test("buildCourseInference: creates repairs only from explicit stable policies", () => {
  const events = [
    { id: "missing-fbr-2009", name: "FBR Open", season: "2009" },
    { id: "verified-phx-2012", name: "Waste Management Phoenix Open", season: "2012", courseId: "tpc-scottsdale", courseName: "TPC Scottsdale" },
    { id: "verified-phx-2013", name: "Waste Management Phoenix Open", season: "2013", courseId: "tpc-scottsdale", courseName: "TPC Scottsdale" },
    { id: "verified-phx-2014", name: "Waste Management Phoenix Open", season: "2014", courseId: "tpc-scottsdale", courseName: "TPC Scottsdale" },
    { id: "verified-phx-2015", name: "Waste Management Phoenix Open", season: "2015", courseId: "tpc-scottsdale", courseName: "TPC Scottsdale" },
    { id: "missing-honda-2006", name: "The Honda Classic", season: "2006" },
    { id: "missing-honda-2007", name: "The Honda Classic", season: "2007" },
    { id: "verified-honda-2012", name: "The Honda Classic", season: "2012", courseId: "pga-national", courseName: "PGA National" },
    { id: "verified-honda-2013", name: "The Honda Classic", season: "2013", courseId: "pga-national", courseName: "PGA National" },
    { id: "verified-honda-2014", name: "The Honda Classic", season: "2014", courseId: "pga-national", courseName: "PGA National" },
    { id: "verified-honda-2015", name: "The Honda Classic", season: "2015", courseId: "pga-national", courseName: "PGA National" },
    { id: "missing-zurich-2006", name: "Zurich Classic of New Orleans", season: "2006" },
    { id: "missing-zurich-2007", name: "Zurich Classic of New Orleans", season: "2007" },
    { id: "verified-zurich-2012", name: "Zurich Classic of New Orleans", season: "2012", courseId: "tpc-louisiana", courseName: "TPC Louisiana" },
    { id: "verified-zurich-2013", name: "Zurich Classic of New Orleans", season: "2013", courseId: "tpc-louisiana", courseName: "TPC Louisiana" },
    { id: "verified-zurich-2014", name: "Zurich Classic of New Orleans", season: "2014", courseId: "tpc-louisiana", courseName: "TPC Louisiana" },
    { id: "verified-zurich-2015", name: "Zurich Classic of New Orleans", season: "2015", courseId: "tpc-louisiana", courseName: "TPC Louisiana" }
  ];
  const courses = [
    { id: "tpc-scottsdale", name: "TPC Scottsdale", location: "Scottsdale, AZ", par: "71", yards: "7261" },
    { id: "pga-national", name: "PGA National", location: "Palm Beach Gardens, FL", par: "70", yards: "7125" },
    { id: "tpc-louisiana", name: "TPC Louisiana", location: "Avondale, LA", par: "72", yards: "7425" }
  ];

  const report = buildCourseInference(events, courses, { fetchedAt: "2026-06-20T13:30:00-04:00" });

  assert.deepEqual(report.repairs.map((row) => row.eventId).sort(), [
    "missing-fbr-2009",
    "missing-honda-2007",
    "missing-zurich-2007"
  ]);
  assert.equal(report.repairs.find((row) => row.eventId === "missing-fbr-2009").courseName, "TPC Scottsdale");
  assert.equal(report.repairs.find((row) => row.eventId === "missing-honda-2007").location, "Palm Beach Gardens, FL");
});

test("buildCourseInference: skips ambiguous verified course histories", () => {
  const events = [
    { id: "missing-sony", name: "Sony Open in Hawaii", season: "2011" },
    { id: "verified-sony-1", name: "Sony Open in Hawaii", season: "2012", courseId: "course-a", courseName: "Course A" },
    { id: "verified-sony-2", name: "Sony Open in Hawaii", season: "2013", courseId: "course-a", courseName: "Course A" },
    { id: "verified-sony-3", name: "Sony Open in Hawaii", season: "2014", courseId: "course-b", courseName: "Course B" },
    { id: "verified-sony-4", name: "Sony Open in Hawaii", season: "2015", courseId: "course-a", courseName: "Course A" }
  ];

  const report = buildCourseInference(events, []);

  assert.equal(report.repairs.length, 0);
  assert.equal(report.skipped[0].reason, "multiple verified courses");
});

test("buildCourseInference: accepts equivalent labels for the same verified course", () => {
  const events = [
    { id: "missing-players", name: "THE PLAYERS Championship", season: "2011" },
    { id: "verified-players-1", name: "THE PLAYERS Championship", season: "2012", courseId: "sawgrass-a", courseName: "TPC Sawgrass (THE PLAYERS Stadium Course)" },
    { id: "verified-players-2", name: "THE PLAYERS Championship", season: "2013", courseId: "sawgrass-a", courseName: "TPC Sawgrass (THE PLAYERS Stadium Course)" },
    { id: "verified-players-3", name: "THE PLAYERS Championship", season: "2014", courseId: "sawgrass-b", courseName: "TPC Sawgrass - THE PLAYERS Stadium Course" },
    { id: "verified-players-4", name: "THE PLAYERS Championship", season: "2015", courseId: "sawgrass-a", courseName: "TPC Sawgrass (THE PLAYERS Stadium Course)" }
  ];

  const report = buildCourseInference(events, []);

  assert.equal(report.repairs.length, 1);
  assert.equal(report.repairs[0].courseName, "TPC Sawgrass (THE PLAYERS Stadium Course)");
});

test("buildCourseInference: preferred policy course handles later alternate venues", () => {
  const events = [
    { id: "missing-wachovia-2008", name: "Wachovia Championship", season: "2008" },
    { id: "verified-wells-2012", name: "Wells Fargo Championship", season: "2012", courseId: "quail", courseName: "Quail Hollow Club" },
    { id: "verified-wells-2013", name: "Wells Fargo Championship", season: "2013", courseId: "quail", courseName: "Quail Hollow Club" },
    { id: "verified-wells-2014", name: "Wells Fargo Championship", season: "2014", courseId: "quail", courseName: "Quail Hollow Club" },
    { id: "verified-wells-2015", name: "Wells Fargo Championship", season: "2015", courseId: "quail", courseName: "Quail Hollow Club" },
    { id: "verified-wells-alt", name: "Wells Fargo Championship", season: "2017", courseId: "eagle", courseName: "Eagle Point Golf Club" }
  ];

  const report = buildCourseInference(events, []);

  assert.equal(report.repairs.length, 1);
  assert.equal(report.repairs[0].courseId, "quail");
});

test("loadCourseInference and writeCourseInference: persist reviewable CSV and summary", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-course-inference-"));
  try {
    await fsp.writeFile(path.join(tempRoot, "events.csv"), [
      "id,name,tour,season,startDate,endDate,courseId,courseName,fieldStrength,status,sourceProvider,sourceUrl,sourceUpdatedAt",
      "missing-fbr-2009,FBR Open,PGA TOUR,2009,2009-01-29,2009-02-01,,,,Final,ESPN,https://example.com,2026-06-20T00:00:00Z",
      "verified-phx-2012,Waste Management Phoenix Open,PGA TOUR,2012,2012-02-02,2012-02-05,tpc-scottsdale,TPC Scottsdale,,,PGA TOUR,https://example.com,2026-06-20T00:00:00Z",
      "verified-phx-2013,Waste Management Phoenix Open,PGA TOUR,2013,2013-01-31,2013-02-03,tpc-scottsdale,TPC Scottsdale,,,PGA TOUR,https://example.com,2026-06-20T00:00:00Z",
      "verified-phx-2014,Waste Management Phoenix Open,PGA TOUR,2014,2014-01-30,2014-02-02,tpc-scottsdale,TPC Scottsdale,,,PGA TOUR,https://example.com,2026-06-20T00:00:00Z",
      "verified-phx-2015,Waste Management Phoenix Open,PGA TOUR,2015,2015-01-29,2015-02-01,tpc-scottsdale,TPC Scottsdale,,,PGA TOUR,https://example.com,2026-06-20T00:00:00Z"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(tempRoot, "courses.csv"), [
      Warehouse.COLLECTION_COLUMNS.courses.join(","),
      "tpc-scottsdale,TPC Scottsdale,\"Scottsdale, AZ\",71,7261,,,,,PGA TOUR,https://example.com,2026-06-20T00:00:00Z"
    ].join("\n"), "utf8");

    const report = await loadCourseInference(tempRoot, { fetchedAt: "2026-06-20T13:30:00-04:00" });
    const outputFile = path.join(tempRoot, "repairs.csv");
    const summaryFile = path.join(tempRoot, "summary.json");
    await writeCourseInference(report, { outputFile, summaryFile });

    const repairs = Warehouse.parseGolfLabCsv(await fsp.readFile(outputFile, "utf8"));
    const summary = JSON.parse(await fsp.readFile(summaryFile, "utf8"));

    assert.equal(repairs[0].eventId, "missing-fbr-2009");
    assert.equal(summary.summary.repairs, 1);
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
