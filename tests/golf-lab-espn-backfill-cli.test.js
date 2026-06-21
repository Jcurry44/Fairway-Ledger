/*
 * Unit tests for scripts/golf-lab-espn-backfill.js - manifest historical ESPN backfill.
 *
 * Run: node --test tests/golf-lab-espn-backfill-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const {
  parseArgs,
  manifestEntries,
  runEspnBackfill
} = require("../scripts/golf-lab-espn-backfill.js");

function sampleScoreboard(eventId, date, endDate, playerName, score, toPar) {
  return {
    leagues: [{ name: "PGA TOUR", abbreviation: "PGA", season: { year: Number(date.slice(0, 4)) } }],
    events: [{
      id: eventId,
      date,
      endDate,
      name: "U.S. Open",
      season: { year: Number(date.slice(0, 4)) },
      status: { type: { description: "Final" } },
      competitions: [{
        id: eventId,
        competitors: [{
          id: eventId,
          athlete: { displayName: playerName, flag: { alt: "USA" } },
          score: String(toPar),
          linescores: [{
            value: score,
            displayValue: String(toPar),
            period: 1,
            linescores: Array.from({ length: 18 }, () => ({ value: 4 }))
          }]
        }]
      }]
    }]
  };
}

test("parseArgs: reads historical backfill runner options", () => {
  const args = parseArgs([
    "--manifest", "manifest.json",
    "--out", "out",
    "--build-out", "bundle.json",
    "--report", "report.json",
    "--provider", "ESPN historical",
    "--clean",
    "--compact"
  ]);

  assert.equal(args.manifestFile, "manifest.json");
  assert.equal(args.outputDir, "out");
  assert.equal(args.bundleFile, "bundle.json");
  assert.equal(args.reportFile, "report.json");
  assert.equal(args.provider, "ESPN historical");
  assert.equal(args.clean, true);
  assert.equal(args.pretty, false);
});

test("manifestEntries: accepts array and events wrapper manifests", () => {
  assert.equal(manifestEntries([{ eventId: "one" }]).length, 1);
  assert.equal(manifestEntries({ events: [{ eventId: "two" }] })[0].eventId, "two");
});

test("runEspnBackfill: adapts saved scoreboards sequentially and builds a bundle", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-espn-backfill-"));
  try {
    const rawDir = path.join(tempRoot, "raw");
    const outDir = path.join(tempRoot, "out");
    await fsp.mkdir(rawDir, { recursive: true });
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.writeFile(path.join(outDir, "courses.csv"), "id,name\nstale,\n", "utf8");
    await fsp.writeFile(
      path.join(rawDir, "open-2025.json"),
      JSON.stringify(sampleScoreboard("401", "2025-06-12T04:00Z", "2025-06-15T04:00Z", "J.J. Spaun", 66, "-4")),
      "utf8"
    );
    await fsp.writeFile(
      path.join(rawDir, "open-2024.json"),
      JSON.stringify(sampleScoreboard("402", "2024-06-13T04:00Z", "2024-06-16T04:00Z", "Bryson DeChambeau", 67, "-3")),
      "utf8"
    );
    const manifestFile = path.join(tempRoot, "manifest.json");
    await fsp.writeFile(manifestFile, JSON.stringify({
      events: [
        {
          inputFile: "raw/open-2025.json",
          eventId: "us-open-2025",
          courseId: "oakmont-country-club",
          courseName: "Oakmont Country Club",
          sourceUrl: "https://example.com/2025",
          fetchedAt: "2026-06-19T14:00:00-04:00"
        },
        {
          inputFile: "raw/open-2024.json",
          eventId: "us-open-2024",
          courseId: "pinehurst-no-2",
          courseName: "Pinehurst Resort Course No. 2",
          sourceUrl: "https://example.com/2024",
          fetchedAt: "2026-06-19T14:05:00-04:00"
        }
      ]
    }), "utf8");

    const bundleFile = path.join(tempRoot, "bundle.json");
    const reportFile = path.join(tempRoot, "report.json");
    const result = await runEspnBackfill(manifestFile, outDir, {
      clean: true,
      bundleFile,
      reportFile,
      provider: "ESPN public historical scoreboard"
    });

    assert.equal(result.adapted.length, 2);
    assert.equal(result.bundleReport.totalRecords, 14);
    const courses = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outDir, "courses.csv"), "utf8"));
    const rounds = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outDir, "rounds.csv"), "utf8"));
    const bundle = JSON.parse(await fsp.readFile(bundleFile, "utf8"));
    const report = JSON.parse(await fsp.readFile(reportFile, "utf8"));
    assert.equal(courses.length, 2);
    assert.equal(rounds.length, 2);
    assert.equal(bundle.report.totalRecords, 14);
    assert.equal(report.summary.totalRecords, 14);
    assert.equal(courses.some((course) => course.id === "stale"), false);
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
