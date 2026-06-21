/*
 * Unit tests for scripts/golf-lab-espn-season.js - ESPN season scoreboard adapter.
 *
 * Run: node --test tests/golf-lab-espn-season-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const {
  parseArgs,
  eventSourceUrl,
  adaptEspnSeasonScoreboard
} = require("../scripts/golf-lab-espn-season.js");

function competitor(playerName, score, toPar) {
  return {
    id: playerName,
    athlete: { displayName: playerName, flag: { alt: "USA" } },
    score: String(toPar),
    linescores: [{
      value: score,
      displayValue: String(toPar),
      period: 1,
      linescores: Array.from({ length: 18 }, () => ({ value: 4 }))
    }]
  };
}

function sampleSeasonPayload() {
  return {
    leagues: [{ name: "PGA TOUR", abbreviation: "PGA", season: { year: 2025 } }],
    events: [
      {
        id: "401",
        date: "2025-01-02T05:00Z",
        endDate: "2025-01-05T05:00Z",
        name: "The Sentry",
        season: { year: 2025 },
        status: { type: { description: "Final" } },
        competitions: [{ id: "401", competitors: [competitor("Winner One", 66, "-4")] }]
      },
      {
        id: "402",
        date: "2025-09-26T04:00Z",
        endDate: "2025-09-28T04:00Z",
        name: "Ryder Cup",
        season: { year: 2025 },
        status: { type: { description: "Final" } },
        competitions: [{ id: "402", competitors: [{ athlete: { displayName: "Team Europe" }, linescores: [] }] }]
      },
      {
        id: "402b",
        date: "2025-03-01T05:00Z",
        endDate: "2025-03-04T05:00Z",
        name: "Missing Competition Open",
        season: { year: 2025 },
        status: { type: { description: "Final" } }
      },
      {
        id: "403",
        date: "2025-04-10T04:00Z",
        endDate: "2025-04-13T04:00Z",
        name: "Masters Tournament",
        season: { year: 2025 },
        status: { type: { description: "Final" } },
        competitions: [{ id: "403", competitors: [competitor("Winner Two", 70, "-2")] }]
      }
    ]
  };
}

test("parseArgs: reads season adapter options", () => {
  const args = parseArgs([
    "--in", "season.json",
    "--out", "out",
    "--build-out", "bundle.json",
    "--report", "report.json",
    "--provider", "ESPN season",
    "--source-base-url", "https://example.com/scoreboard",
    "--course-map", "courses.json",
    "--fetched-at", "2026-06-19T15:00:00Z",
    "--min-completed-rounds", "2",
    "--include-partial",
    "--include-zero-round-events",
    "--clean",
    "--compact"
  ]);

  assert.equal(args.inputFile, "season.json");
  assert.equal(args.outputDir, "out");
  assert.equal(args.bundleFile, "bundle.json");
  assert.equal(args.reportFile, "report.json");
  assert.equal(args.provider, "ESPN season");
  assert.equal(args.sourceBaseUrl, "https://example.com/scoreboard");
  assert.equal(args.courseMapFile, "courses.json");
  assert.equal(args.fetchedAt, "2026-06-19T15:00:00Z");
  assert.equal(args.minCompletedRounds, 2);
  assert.equal(args.includePartial, true);
  assert.equal(args.includeZeroRoundEvents, true);
  assert.equal(args.clean, true);
  assert.equal(args.pretty, false);
});

test("eventSourceUrl: points to the event end date", () => {
  assert.equal(
    eventSourceUrl("https://example.com/scoreboard", { date: "2025-01-02T05:00Z", endDate: "2025-01-05T05:00Z" }),
    "https://example.com/scoreboard?dates=20250105"
  );
});

test("adaptEspnSeasonScoreboard: imports stroke-play events and builds a bundle", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-espn-season-"));
  try {
    const inputFile = path.join(tempRoot, "season.json");
    const courseMapFile = path.join(tempRoot, "course-map.json");
    const outDir = path.join(tempRoot, "out");
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.writeFile(path.join(outDir, "players.csv"), "id,name\nstale,Stale Player\n", "utf8");
    await fsp.writeFile(inputFile, JSON.stringify(sampleSeasonPayload()), "utf8");
    await fsp.writeFile(courseMapFile, JSON.stringify({
      "401": {
        "courseId": "kapalua-plantation",
        "courseName": "Kapalua Plantation Course",
        "courseLocation": "Kapalua, Hawaii",
        "courseSourceUrl": "https://example.com/kapalua"
      }
    }), "utf8");

    const bundleFile = path.join(tempRoot, "bundle.json");
    const reportFile = path.join(tempRoot, "report.json");
    const result = await adaptEspnSeasonScoreboard(inputFile, outDir, {
      clean: true,
      courseMapFile,
      sourceBaseUrl: "https://example.com/scoreboard",
      fetchedAt: "2026-06-19T15:00:00Z",
      bundleFile,
      reportFile,
      provider: "ESPN public season scoreboard"
    });

    assert.equal(result.adapted.length, 2);
    assert.equal(result.skipped.length, 2);
    assert.equal(result.skipped[0].eventName, "Ryder Cup");
    assert.equal(result.skipped[1].reason, "missing-competition");
    const events = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outDir, "events.csv"), "utf8"));
    const players = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outDir, "players.csv"), "utf8"));
    const rounds = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outDir, "rounds.csv"), "utf8"));
    const courses = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outDir, "courses.csv"), "utf8"));
    const report = JSON.parse(await fsp.readFile(reportFile, "utf8"));
    assert.equal(events.length, 2);
    assert.equal(players.some((player) => player.id === "stale"), false);
    assert.equal(rounds.length, 2);
    assert.equal(courses.length, 1);
    assert.equal(report.summary.totalRecords, result.bundleReport.totalRecords);
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
