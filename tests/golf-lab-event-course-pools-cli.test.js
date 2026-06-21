/*
 * Unit tests for scripts/golf-lab-event-course-pools.js - multi-course pool repairs.
 *
 * Run: node --test tests/golf-lab-event-course-pools-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const {
  parseArgs,
  normalizePoolRow,
  applyEventCoursePoolsToTables,
  applyEventCoursePools
} = require("../scripts/golf-lab-event-course-pools.js");

test("parseArgs: reads event course pool options", () => {
  const args = parseArgs(["--pools", "pools.csv", "--out", "warehouse", "--fetched-at", "2026-06-20T12:00:00Z"]);

  assert.equal(args.poolsFile, "pools.csv");
  assert.equal(args.outputDir, "warehouse");
  assert.equal(args.fetchedAt, "2026-06-20T12:00:00Z");
});

test("normalizePoolRow: creates stable event course rows", () => {
  const row = normalizePoolRow({
    event_id: "event-a",
    course_name: "Pebble Beach Golf Links",
    location: "Pebble Beach, CA",
    course_order: "1",
    source_url: "https://example.com"
  }, {
    provider: "Provider",
    fetchedAt: "2026-06-20T12:00:00Z"
  });

  assert.equal(row.eventId, "event-a");
  assert.equal(row.courseId, "pebble-beach-golf-links-pebble-beach-ca");
  assert.equal(row.courseOrder, "1");
  assert.equal(row.sourceProvider, "Provider");
});

test("applyEventCoursePoolsToTables: upserts pools without assigning rounds to a guessed course", () => {
  const result = applyEventCoursePoolsToTables({
    events: [{ id: "event-a", name: "A Open", startDate: "2025-01-01", sourceProvider: "ESPN" }],
    courses: [],
    courseSetups: [],
    eventCourses: [],
    sourceFetches: []
  }, [
    { eventId: "event-a", courseId: "course-a", courseName: "Course A", par: "72", sourceProvider: "Pool Source", sourceUrl: "https://example.com" },
    { eventId: "event-a", courseId: "course-b", courseName: "Course B", par: "71", sourceProvider: "Pool Source", sourceUrl: "https://example.com" }
  ], {
    fetchedAt: "2026-06-20T12:00:00Z"
  });

  assert.equal(result.summary.pools, 2);
  assert.equal(result.summary.eventsUpdated, 1);
  assert.equal(result.tables.events[0].courseName, "Course A / Course B");
  assert.equal(result.tables.courses.length, 2);
  assert.equal(result.tables.courseSetups.length, 2);
  assert.equal(result.tables.eventCourses.length, 2);
  assert.equal(result.tables.sourceFetches[0].rowCount, 2);
});

test("applyEventCoursePools: reads and writes warehouse CSV collections", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-event-course-pools-"));
  try {
    const collectionCsv = (collection, rows = []) => {
      const columns = Warehouse.COLLECTION_COLUMNS[collection];
      const line = (row = {}) => columns.map((column) => row[column] || "").join(",");
      return [columns.join(","), ...rows.map(line)].join("\n");
    };
    await fsp.writeFile(path.join(tempRoot, "events.csv"), collectionCsv("events", [{
      id: "event-a",
      name: "A Open",
      startDate: "2025-01-01",
      status: "Final"
    }]), "utf8");
    await fsp.writeFile(path.join(tempRoot, "courses.csv"), collectionCsv("courses"), "utf8");
    await fsp.writeFile(path.join(tempRoot, "course_setups.csv"), collectionCsv("courseSetups"), "utf8");
    await fsp.writeFile(path.join(tempRoot, "event_courses.csv"), collectionCsv("eventCourses"), "utf8");
    await fsp.writeFile(path.join(tempRoot, "source_fetches.csv"), collectionCsv("sourceFetches"), "utf8");
    const poolsFile = path.join(tempRoot, "pools.csv");
    await fsp.writeFile(poolsFile, [
      Warehouse.COLLECTION_COLUMNS.eventCourses.join(","),
      "pool-a,event-a,course-a,Course A,,1,,Rotation,72,7000,verified,,Pool Source,https://example.com,2026-06-20T12:00:00Z"
    ].join("\n"), "utf8");

    const result = await applyEventCoursePools(poolsFile, tempRoot, {
      fetchedAt: "2026-06-20T12:00:00Z"
    });
    const eventCourses = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "event_courses.csv"), "utf8"));
    const events = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "events.csv"), "utf8"));

    assert.equal(result.summary.pools, 1);
    assert.equal(eventCourses[0].courseName, "Course A");
    assert.equal(events[0].courseName, "Course A");
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
