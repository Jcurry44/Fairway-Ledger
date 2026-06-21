/*
 * Unit tests for scripts/golf-lab-espn.js - ESPN scoreboard adapter.
 *
 * Run: node --test tests/golf-lab-espn-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const {
  parseArgs,
  buildRows,
  adaptEspnScoreboard
} = require("../scripts/golf-lab-espn.js");

function sampleScoreboard() {
  return {
    leagues: [{ name: "PGA TOUR", abbreviation: "PGA", season: { year: 2026 } }],
    events: [{
      id: "401811952",
      date: "2026-06-18T04:00Z",
      endDate: "2026-06-21T04:00Z",
      name: "U.S. Open",
      season: { year: 2026 },
      status: { type: { description: "In Progress" } },
      competitions: [{
        id: "401811952",
        competitors: [{
          id: "11119",
          athlete: {
            displayName: "Wyndham Clark",
            flag: { alt: "USA" }
          },
          score: "-6",
          linescores: [
            {
              value: 64,
              displayValue: "-6",
              period: 1,
              linescores: Array.from({ length: 18 }, (_, index) => ({ value: index === 0 ? 3 : 4 }))
            },
            {
              value: 31,
              displayValue: "-1",
              period: 2,
              linescores: Array.from({ length: 9 }, () => ({ value: 4 }))
            }
          ]
        }]
      }]
    }]
  };
}

test("parseArgs: reads ESPN scoreboard adapter options", () => {
  const args = parseArgs([
    "--in", "scoreboard.json",
    "--out", "out",
    "--event-id", "us-open-2026",
    "--course-id", "shinnecock-hills",
    "--course-name", "Shinnecock Hills Golf Club",
    "--course-location", "Southampton, NY",
    "--course-source-url", "https://example.com/course",
    "--source-url", "https://example.com/scoreboard",
    "--fetched-at", "2026-06-19T12:00:00Z",
    "--include-partial"
  ]);

  assert.equal(args.inputFile, "scoreboard.json");
  assert.equal(args.outputDir, "out");
  assert.equal(args.eventId, "us-open-2026");
  assert.equal(args.courseId, "shinnecock-hills");
  assert.equal(args.courseName, "Shinnecock Hills Golf Club");
  assert.equal(args.courseLocation, "Southampton, NY");
  assert.equal(args.courseSourceUrl, "https://example.com/course");
  assert.equal(args.includePartial, true);
});

test("buildRows: maps ESPN scoreboard into source-backed Golf Lab rows", () => {
  const rows = buildRows(sampleScoreboard(), {
    eventId: "us-open-2026",
    courseId: "shinnecock-hills",
    courseName: "Shinnecock Hills Golf Club",
    courseLocation: "Southampton, NY",
    courseSourceUrl: "https://example.com/course",
    sourceUrl: "https://example.com/scoreboard",
    fetchedAt: "2026-06-19T12:00:00Z"
  });

  assert.equal(rows.summary.players, 1);
  assert.equal(rows.summary.completedRounds, 1);
  assert.equal(rows.summary.skippedPartialRounds, 1);
  assert.equal(rows.summary.inferredPar, 70);
  assert.equal(rows.tables.players[0].id, "wyndham-clark");
  assert.equal(rows.tables.players[0].country, "USA");
  assert.equal(rows.tables.events[0].courseName, "Shinnecock Hills Golf Club");
  assert.equal(rows.tables.courses[0].par, "70");
  assert.equal(rows.tables.fields[0].eventId, "us-open-2026");
  assert.equal(rows.tables.rounds[0].score, "64");
  assert.equal(rows.tables.rounds[0].toPar, "-6");
  assert.equal(rows.tables.sourceFetches[0].rowCount, 1);
});

test("adaptEspnScoreboard: writes normalized collection CSVs", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-espn-"));
  try {
    const inputFile = path.join(tempRoot, "scoreboard.json");
    const outputDir = path.join(tempRoot, "out");
    await fsp.writeFile(inputFile, JSON.stringify(sampleScoreboard()), "utf8");

    const result = await adaptEspnScoreboard(inputFile, outputDir, {
      eventId: "us-open-2026",
      courseId: "shinnecock-hills",
      courseName: "Shinnecock Hills Golf Club",
      sourceUrl: "https://example.com/scoreboard",
      fetchedAt: "2026-06-19T12:00:00Z"
    });
    const players = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "players.csv"), "utf8"));
    const rounds = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "rounds.csv"), "utf8"));
    const sources = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "source_fetches.csv"), "utf8"));

    assert.equal(result.summary.completedRounds, 1);
    assert.equal(players[0].name, "Wyndham Clark");
    assert.equal(rounds[0].roundNumber, "1");
    assert.equal(sources[0].provider, "ESPN public scoreboard");
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
