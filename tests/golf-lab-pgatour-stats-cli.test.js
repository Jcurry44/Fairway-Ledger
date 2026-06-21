/*
 * Unit tests for scripts/golf-lab-pgatour-stats.js - public PGA TOUR stats adapter.
 *
 * Run: node --test tests/golf-lab-pgatour-stats-cli.test.js
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
  adaptPgaTourStats
} = require("../scripts/golf-lab-pgatour-stats.js");

function multiMetricPayload() {
  return {
    rows: [
      {
        player: {
          displayName: "Scottie Scheffler",
          id: "46046",
          country: "USA",
          profileUrl: "https://www.pgatour.com/player/46046/scottie-scheffler"
        },
        season: "2026",
        sgTotal: "2.451",
        sgOffTheTee: "0.721",
        sgApproachTheGreen: "1.120",
        sgAroundTheGreen: "0.150",
        sgPutting: "0.460",
        sgTeeToGreen: "1.991",
        drivingDistance: "312.4",
        drivingAccuracy: "64.2%",
        greensInRegulation: "72.8%",
        scrambling: "66.7%"
      },
      {
        playerName: "Rory McIlroy",
        pgaTourId: "28237",
        country: "NIR",
        season: "2026",
        strokesGainedTotal: "1.812",
        strokesGainedOffTheTee: "0.890",
        strokesGainedApproach: "0.410",
        strokesGainedPutting: "-0.120",
        drivingDistance: "319.8",
        drivingAccuracy: "59.1%",
        girPct: "70.2%",
        scramblingPct: "61.3%"
      }
    ]
  };
}

test("parseArgs: reads PGA TOUR stats adapter options", () => {
  const args = parseArgs([
    "--in", "stats.json",
    "--out", "out",
    "--provider", "PGA TOUR Stats",
    "--source-url", "https://www.pgatour.com/stats/approach-green",
    "--fetched-at", "2026-06-19T19:00:00Z",
    "--season", "2026",
    "--period", "season-2026",
    "--tour", "PGA TOUR",
    "--stat-key", "sgApp"
  ]);

  assert.equal(args.inputFile, "stats.json");
  assert.equal(args.outputDir, "out");
  assert.equal(args.provider, "PGA TOUR Stats");
  assert.equal(args.sourceUrl, "https://www.pgatour.com/stats/approach-green");
  assert.equal(args.fetchedAt, "2026-06-19T19:00:00Z");
  assert.equal(args.season, "2026");
  assert.equal(args.period, "season-2026");
  assert.equal(args.tour, "PGA TOUR");
  assert.equal(args.statKey, "sgApp");
});

test("buildRows: maps a wide public stats export into player skill rows", () => {
  const result = buildRows(multiMetricPayload(), {
    sourceUrl: "https://www.pgatour.com/stats",
    fetchedAt: "2026-06-19T19:00:00Z"
  });

  assert.equal(result.summary.rowsRead, 2);
  assert.equal(result.summary.players, 2);
  assert.equal(result.summary.strokesGainedRows, 2);
  assert.deepEqual(result.summary.periods, ["season-2026"]);
  assert.ok(result.summary.metricsImported.includes("sgTotal"));
  assert.ok(result.summary.metricsImported.includes("drivingDistance"));

  const scottie = result.tables.strokesGained.find((row) => row.playerName === "Scottie Scheffler");
  const rory = result.tables.strokesGained.find((row) => row.playerName === "Rory McIlroy");

  assert.equal(result.tables.players.find((row) => row.name === "Scottie Scheffler").pgaTourId, "46046");
  assert.equal(scottie.period, "season-2026");
  assert.equal(scottie.sgTotal, "2.451");
  assert.equal(scottie.sgOtt, "0.721");
  assert.equal(scottie.sgApp, "1.12");
  assert.equal(scottie.sgArg, "0.15");
  assert.equal(scottie.sgPutt, "0.46");
  assert.equal(scottie.sgT2g, "1.991");
  assert.equal(scottie.drivingDistance, "312.4");
  assert.equal(scottie.accuracy, "0.642");
  assert.equal(scottie.gir, "0.728");
  assert.equal(scottie.scrambling, "0.667");
  assert.equal(rory.sgPutt, "-0.12");
});

test("buildRows: maps one-stat payloads with stat-key into the right SG component", () => {
  const result = buildRows({
    statDetails: {
      rows: [
        {
          player: { displayName: "Ludvig Aberg", id: "52955", country: "SWE" },
          stats: [
            { statName: "Avg", statValue: "0.884" },
            { statName: "Measured Rounds", statValue: "42" }
          ],
          rank: "4"
        }
      ]
    }
  }, {
    statKey: "sgApp",
    season: "2026",
    sourceUrl: "https://www.pgatour.com/stats/approach-green",
    fetchedAt: "2026-06-19T19:10:00Z"
  });

  assert.equal(result.summary.rowsRead, 1);
  assert.deepEqual(result.summary.metricsImported, ["sgApp"]);
  assert.equal(result.tables.strokesGained[0].playerName, "Ludvig Aberg");
  assert.equal(result.tables.strokesGained[0].period, "season-2026");
  assert.equal(result.tables.strokesGained[0].sgApp, "0.884");
  assert.equal(result.tables.sourceFetches[0].endpoint, "pgatour-stats/sgApp");
});

test("adaptPgaTourStats: writes and merges aggregate components without erasing earlier metrics", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-pgatour-stats-"));
  try {
    const firstInput = path.join(tempRoot, "approach.csv");
    const secondInput = path.join(tempRoot, "putting.json");
    const outputDir = path.join(tempRoot, "out");

    await fsp.writeFile(firstInput, [
      "Player Name,PGA Tour ID,Country,Value",
      "Scottie Scheffler,46046,USA,1.234"
    ].join("\n"), "utf8");
    await fsp.writeFile(secondInput, JSON.stringify([
      {
        player: { displayName: "Scottie Scheffler", id: "46046", country: "USA" },
        statName: "SG: Putting",
        value: "0.512"
      }
    ]), "utf8");

    const first = await adaptPgaTourStats(firstInput, outputDir, {
      statKey: "sgApp",
      season: "2026",
      sourceUrl: "https://www.pgatour.com/stats/approach-green",
      fetchedAt: "2026-06-19T19:20:00Z"
    });
    const second = await adaptPgaTourStats(secondInput, outputDir, {
      season: "2026",
      sourceUrl: "https://www.pgatour.com/stats/putting",
      fetchedAt: "2026-06-19T19:30:00Z"
    });

    const players = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "players.csv"), "utf8"));
    const sg = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "strokes_gained.csv"), "utf8"));
    const sources = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "source_fetches.csv"), "utf8"));

    assert.equal(first.summary.strokesGainedRows, 1);
    assert.equal(second.summary.strokesGainedRows, 1);
    assert.equal(players.length, 1);
    assert.equal(sg.length, 1);
    assert.equal(sg[0].sgApp, "1.234");
    assert.equal(sg[0].sgPutt, "0.512");
    assert.equal(sg[0].period, "season-2026");
    assert.equal(sources.length, 2);
    assert.equal(sources.some((row) => row.endpoint === "pgatour-stats/sgApp"), true);
    assert.equal(sources.some((row) => row.endpoint === "pgatour-stats/sgPutt"), true);
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
