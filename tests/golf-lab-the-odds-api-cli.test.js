/*
 * Unit tests for scripts/golf-lab-the-odds-api.js - paid The Odds API golf adapter.
 *
 * Run: node --test tests/golf-lab-the-odds-api-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const {
  parseArgs,
  loadEnvText,
  parseJsonText,
  sourceUrlForRequest,
  extractTheOddsApiGolfOdds,
  buildRowsFromExtracted,
  impliedProbabilityFromAmerican,
  adaptTheOddsApiGolfOdds
} = require("../scripts/golf-lab-the-odds-api.js");

function samplePayload() {
  return [
    {
      id: "api-event-1",
      has_outrights: true,
      sport_key: "golf_us_open_winner",
      sport_title: "US Open Winner",
      commence_time: "2026-06-20T13:00:00Z",
      bookmakers: [
        {
          key: "betmgm",
          title: "BetMGM",
          last_update: "2026-06-20T02:20:17Z",
          markets: [
            {
              key: "outrights",
              last_update: "2026-06-20T02:20:17Z",
              outcomes: [
                { name: "Wyndham Clark", price: 175 },
                { name: "Scottie Scheffler", price: 1000 },
                { name: "Rory McIlroy", price: 1600 }
              ]
            }
          ]
        },
        {
          key: "betrivers",
          title: "BetRivers",
          last_update: "2026-06-20T02:21:19Z",
          markets: [
            {
              key: "outrights",
              last_update: "2026-06-20T02:21:19Z",
              outcomes: [
                { name: "Wyndham Clark", price: 150 },
                { name: "Scottie Scheffler", price: 1100 },
                { name: "Rory McIlroy", price: 1600 }
              ]
            }
          ]
        }
      ]
    }
  ];
}

test("parseArgs: reads The Odds API golf adapter options", () => {
  const args = parseArgs([
    "--out", "warehouse",
    "--event-id", "2026-u-s-open-401811952",
    "--sport", "golf_us_open_winner",
    "--api-market", "outrights",
    "--market", "winner",
    "--regions", "us",
    "--bookmakers", "betmgm,betrivers",
    "--env-file", "../MLB Betting Framework/.env",
    "--raw-out", "raw.json",
    "--fetched-at", "2026-06-20T08:25:00-04:00"
  ]);

  assert.equal(args.outputDir, "warehouse");
  assert.equal(args.eventId, "2026-u-s-open-401811952");
  assert.equal(args.sport, "golf_us_open_winner");
  assert.equal(args.apiMarket, "outrights");
  assert.equal(args.market, "winner");
  assert.equal(args.regions, "us");
  assert.equal(args.bookmakers, "betmgm,betrivers");
  assert.equal(args.envFile, "../MLB Betting Framework/.env");
  assert.equal(args.rawOut, "raw.json");
  assert.equal(args.fetchedAt, "2026-06-20T08:25:00-04:00");
});

test("loadEnvText and sourceUrlForRequest: read key names without leaking key into source URL", () => {
  const env = loadEnvText("THE_ODDS_API_KEY=secret\nOTHER='value here'\n");

  assert.equal(env.THE_ODDS_API_KEY, "secret");
  assert.equal(env.OTHER, "value here");
  const url = sourceUrlForRequest({
    sport: "golf_us_open_winner",
    apiMarket: "outrights",
    regions: "us",
    bookmakers: "betmgm"
  });
  assert.equal(url.includes("apiKey="), false);
  assert.match(url, /markets=outrights/);
  assert.match(url, /bookmakers=betmgm/);
});

test("parseJsonText: accepts saved UTF-8 JSON with a byte-order mark", () => {
  const parsed = parseJsonText(`\uFEFF${JSON.stringify(samplePayload())}`);

  assert.equal(parsed[0].sport_key, "golf_us_open_winner");
});

test("extractTheOddsApiGolfOdds: parses outrights and adds best rows", () => {
  const extracted = extractTheOddsApiGolfOdds(samplePayload(), {
    market: "winner"
  });

  assert.equal(extracted.sportKey, "golf_us_open_winner");
  assert.equal(extracted.sportTitle, "US Open Winner");
  assert.equal(extracted.sourceUpdatedAt, "2026-06-20T02:21:19Z");
  assert.deepEqual(extracted.books, ["BetMGM", "BetRivers"]);
  assert.equal(extracted.playerCount, 3);
  assert.equal(extracted.rows.length, 9);
  assert.deepEqual(extracted.rows.filter((row) => row.book === "The Odds API Best").map((row) => row.oddsAmerican), [175, 1100, 1600]);
  assert.equal(Math.round(impliedProbabilityFromAmerican(1100) * 10000) / 10000, 0.0833);
});

test("extractTheOddsApiGolfOdds: can emit best-only rows", () => {
  const extracted = extractTheOddsApiGolfOdds(samplePayload(), {
    bestOnly: true
  });

  assert.equal(extracted.rows.length, 3);
  assert.deepEqual(extracted.rows.map((row) => row.book), ["The Odds API Best", "The Odds API Best", "The Odds API Best"]);
});

test("buildRowsFromExtracted: maps API players to selected event field IDs", () => {
  const extracted = extractTheOddsApiGolfOdds(samplePayload(), { market: "winner" });
  const result = buildRowsFromExtracted(extracted, {
    players: [{ id: "scottie-scheffler", name: "Scottie Scheffler" }],
    fields: [
      { eventId: "2026-u-s-open-401811952", playerId: "wyndham-clark", playerName: "Wyndham Clark" },
      { eventId: "2026-u-s-open-401811952", playerId: "scottie-scheffler", playerName: "Scottie Scheffler" },
      { eventId: "2026-u-s-open-401811952", playerId: "rory-mcilroy", playerName: "Rory McIlroy" }
    ]
  }, {
    eventId: "2026-u-s-open-401811952",
    market: "winner",
    sport: "golf_us_open_winner",
    provider: "The Odds API",
    fetchedAt: "2026-06-20T08:25:00-04:00",
    requestsLast: "1",
    requestsRemaining: "18239",
    requestsUsed: "1761"
  });

  assert.equal(result.summary.oddsSnapshots, 9);
  assert.equal(result.summary.bestRows, 3);
  assert.equal(result.summary.createdPlayers, 2);
  assert.equal(result.tables.oddsSnapshots[0].playerId, "wyndham-clark");
  assert.equal(result.tables.oddsSnapshots.find((row) => row.playerId === "scottie-scheffler" && row.book === "The Odds API Best").oddsAmerican, "1100");
  assert.match(result.tables.sourceFetches[0].manifestJson, /requestsRemaining/);
});

test("adaptTheOddsApiGolfOdds: writes winner market rows and source proof from saved JSON", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-the-odds-api-"));
  try {
    const inputFile = path.join(tempRoot, "odds.json");
    const outputDir = path.join(tempRoot, "warehouse");
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(inputFile, JSON.stringify(samplePayload(), null, 2), "utf8");
    await fsp.writeFile(path.join(outputDir, "players.csv"), [
      "id,name,country,tour,owgrRank,dataGolfId,pgaTourId,photoUrl,profileUrl,handedness,age,turnedPro,college,sourceProvider,sourceUrl,sourceUpdatedAt",
      "scottie-scheffler,Scottie Scheffler,,,,,,,,,,,,ESPN,https://example.com,2026-06-20T08:00:00Z"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(outputDir, "fields.csv"), [
      "id,eventId,playerId,playerName,status,teeTime,sourceProvider,sourceUrl,sourceUpdatedAt",
      "field-1,2026-u-s-open-401811952,wyndham-clark,Wyndham Clark,active,,ESPN,https://example.com,2026-06-20T08:00:00Z",
      "field-2,2026-u-s-open-401811952,scottie-scheffler,Scottie Scheffler,active,,ESPN,https://example.com,2026-06-20T08:00:00Z",
      "field-3,2026-u-s-open-401811952,rory-mcilroy,Rory McIlroy,active,,ESPN,https://example.com,2026-06-20T08:00:00Z"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(outputDir, "odds_snapshots.csv"), "id,eventId,playerId,market,book,oddsAmerican,impliedProbability,capturedAt,sourceProvider,sourceUrl,sourceUpdatedAt\n", "utf8");
    await fsp.writeFile(path.join(outputDir, "source_fetches.csv"), "id,provider,endpoint,eventId,modelRunId,modelVersion,modelProfile,modelWeatherScenario,modelWeatherLabel,fetchedAt,status,rowCount,manifestJson,sourceUrl\n", "utf8");

    const result = await adaptTheOddsApiGolfOdds({
      inputFile,
      outputDir,
      eventId: "2026-u-s-open-401811952",
      market: "winner",
      fetchedAt: "2026-06-20T08:25:00-04:00"
    });

    const odds = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "odds_snapshots.csv"), "utf8"));
    const sources = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "source_fetches.csv"), "utf8"));

    assert.equal(result.summary.oddsSnapshots, 9);
    assert.equal(odds.filter((row) => row.sourceProvider === "The Odds API").length, 9);
    assert.equal(odds.filter((row) => row.book === "The Odds API Best").length, 3);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].endpoint, "the-odds-api/golf_us_open_winner/winner");
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
