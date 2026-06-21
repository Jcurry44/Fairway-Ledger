/*
 * Unit tests for scripts/golf-lab-oddschecker-odds.js - public Oddschecker odds adapter.
 *
 * Run: node --test tests/golf-lab-oddschecker-odds-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const {
  parseArgs,
  extractOddscheckerOdds,
  buildRowsFromExtracted,
  parseOddsToken,
  impliedProbabilityFromAmerican,
  adaptOddscheckerOdds
} = require("../scripts/golf-lab-oddschecker-odds.js");

function sampleRenderedText() {
  return [
    "# US Open - Top 10 Finish Betting Odds",
    "Change Market",
    "Top 20 Finish",
    "Top 10 Finish",
    "Sort By",
    "Favourite",
    "Name",
    "Image: bet365 Image: William Hill Image: Unibet Image: Betfred",
    "QuickBet",
    "Scottie Scheffler",
    "4/5",
    "4/5",
    "4/6",
    "10/11",
    "Rory McIlroy",
    "8/11",
    "1",
    "4/5",
    "11/10",
    "J.J Spaun",
    "21/10",
    "15/8",
    "2",
    "5/2",
    "## Latest US Open Betting Odds"
  ].join("\n");
}

function sampleHtml() {
  return `<!doctype html>
    <html>
      <body>
        <h1>US Open - Top 20 Finish Betting Odds</h1>
        <section>
          <p>Sort By</p>
          <button>Favourite</button><button>Name</button>
          <img alt="bet365" /><img alt="William Hill" /><img alt="BetMGM UK" />
          <p>QuickBet</p>
          <a href="/golf/us-open/scottie-scheffler">Scottie Scheffler</a>
          <span>1/3</span><span>7/20</span><span>2/5</span>
          <a href="/golf/us-open/rory-mcilroy">Rory McIlroy</a>
          <span>8/13</span><span>4/7</span><span>8/11</span>
        </section>
      </body>
    </html>`;
}

test("parseArgs: reads Oddschecker odds adapter options", () => {
  const args = parseArgs([
    "--in", "raw/top-10.html",
    "--out", "warehouse",
    "--event-id", "2026-u-s-open-401811952",
    "--market", "top 10",
    "--provider", "OC",
    "--source-url", "https://www.oddschecker.com/golf/us-open/top-10-finish",
    "--fetched-at", "2026-06-20T08:20:00-04:00",
    "--best-only"
  ]);

  assert.equal(args.inputFile, "raw/top-10.html");
  assert.equal(args.outputDir, "warehouse");
  assert.equal(args.eventId, "2026-u-s-open-401811952");
  assert.equal(args.market, "top 10");
  assert.equal(args.provider, "OC");
  assert.equal(args.sourceUrl, "https://www.oddschecker.com/golf/us-open/top-10-finish");
  assert.equal(args.fetchedAt, "2026-06-20T08:20:00-04:00");
  assert.equal(args.bestOnly, true);
});

test("parseOddsToken: converts fractional, whole fractional, decimal, and American prices", () => {
  assert.equal(parseOddsToken("4/5"), -125);
  assert.equal(parseOddsToken("10/11"), -110);
  assert.equal(parseOddsToken("5/2"), 250);
  assert.equal(parseOddsToken("2"), 200);
  assert.equal(parseOddsToken("2.50"), 150);
  assert.equal(parseOddsToken("+450"), 450);
  assert.equal(parseOddsToken("-120"), -120);
  assert.equal(Math.round(impliedProbabilityFromAmerican(-125) * 10000) / 10000, 0.5556);
});

test("extractOddscheckerOdds: parses rendered market text with books and best rows", () => {
  const extracted = extractOddscheckerOdds(sampleRenderedText(), {
    fetchedAt: "2026-06-20T08:20:00-04:00"
  });

  assert.equal(extracted.title, "US Open - Top 10 Finish Betting Odds");
  assert.equal(extracted.market, "top 10");
  assert.deepEqual(extracted.books, ["Bet365", "William Hill", "Unibet", "Betfred"]);
  assert.equal(extracted.playerRows.length, 3);
  assert.equal(extracted.rows.length, 15);
  assert.deepEqual(extracted.rows.filter((row) => row.book === "Oddschecker Best").map((row) => row.oddsAmerican), [-110, 110, 250]);
  assert.equal(extracted.rows.find((row) => row.playerName === "J.J Spaun" && row.book === "Bet365").oddsAmerican, 210);
});

test("extractOddscheckerOdds: parses HTML table text and can emit best-only rows", () => {
  const extracted = extractOddscheckerOdds(sampleHtml(), {
    market: "top 20",
    bestOnly: true
  });

  assert.equal(extracted.title, "US Open - Top 20 Finish Betting Odds");
  assert.deepEqual(extracted.books, ["Bet365", "William Hill", "BetMGM UK"]);
  assert.equal(extracted.rows.length, 2);
  assert.deepEqual(extracted.rows.map((row) => row.book), ["Oddschecker Best", "Oddschecker Best"]);
  assert.deepEqual(extracted.rows.map((row) => row.oddsAmerican), [-250, -137]);
});

test("buildRowsFromExtracted: maps Oddschecker players to selected event field IDs", () => {
  const extracted = extractOddscheckerOdds(sampleRenderedText(), { market: "top 10" });
  const result = buildRowsFromExtracted(extracted, {
    players: [{ id: "scottie-scheffler", name: "Scottie Scheffler" }],
    fields: [
      { eventId: "2026-u-s-open-401811952", playerId: "scottie-scheffler", playerName: "Scottie Scheffler" },
      { eventId: "2026-u-s-open-401811952", playerId: "rory-mcilroy", playerName: "Rory McIlroy" },
      { eventId: "2026-u-s-open-401811952", playerId: "jj-spaun", playerName: "J.J. Spaun" }
    ]
  }, {
    eventId: "2026-u-s-open-401811952",
    market: "top 10",
    provider: "Oddschecker public odds",
    sourceUrl: "https://www.oddschecker.com/golf/us-open/top-10-finish",
    fetchedAt: "2026-06-20T08:20:00-04:00"
  });

  assert.equal(result.summary.oddsSnapshots, 15);
  assert.equal(result.summary.bestRows, 3);
  assert.equal(result.summary.createdPlayers, 2);
  assert.equal(result.tables.oddsSnapshots[0].playerId, "scottie-scheffler");
  assert.equal(result.tables.oddsSnapshots.find((row) => row.playerId === "jj-spaun").playerId, "jj-spaun");
  assert.equal(result.tables.oddsSnapshots.find((row) => row.book === "Oddschecker Best").impliedProbability, "0.5238");
  assert.match(result.tables.sourceFetches[0].manifestJson, /public-oddschecker-html-odds/);
});

test("adaptOddscheckerOdds: writes placement market rows and source proof", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-oddschecker-"));
  try {
    const inputFile = path.join(tempRoot, "top-10.html");
    const outputDir = path.join(tempRoot, "warehouse");
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(inputFile, sampleRenderedText(), "utf8");
    await fsp.writeFile(path.join(outputDir, "players.csv"), [
      "id,name,country,tour,owgrRank,dataGolfId,pgaTourId,photoUrl,profileUrl,handedness,age,turnedPro,college,sourceProvider,sourceUrl,sourceUpdatedAt",
      "scottie-scheffler,Scottie Scheffler,,,,,,,,,,,,ESPN,https://example.com,2026-06-20T08:00:00Z"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(outputDir, "fields.csv"), [
      "id,eventId,playerId,playerName,status,teeTime,sourceProvider,sourceUrl,sourceUpdatedAt",
      "field-1,2026-u-s-open-401811952,scottie-scheffler,Scottie Scheffler,active,,ESPN,https://example.com,2026-06-20T08:00:00Z",
      "field-2,2026-u-s-open-401811952,rory-mcilroy,Rory McIlroy,active,,ESPN,https://example.com,2026-06-20T08:00:00Z",
      "field-3,2026-u-s-open-401811952,jj-spaun,J.J. Spaun,active,,ESPN,https://example.com,2026-06-20T08:00:00Z"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(outputDir, "odds_snapshots.csv"), "id,eventId,playerId,market,book,oddsAmerican,impliedProbability,capturedAt,sourceProvider,sourceUrl,sourceUpdatedAt\n", "utf8");
    await fsp.writeFile(path.join(outputDir, "source_fetches.csv"), "id,provider,endpoint,eventId,modelRunId,modelVersion,modelProfile,modelWeatherScenario,modelWeatherLabel,fetchedAt,status,rowCount,manifestJson,sourceUrl\n", "utf8");

    const result = await adaptOddscheckerOdds(inputFile, outputDir, {
      eventId: "2026-u-s-open-401811952",
      market: "top 10",
      sourceUrl: "https://www.oddschecker.com/golf/us-open/top-10-finish",
      fetchedAt: "2026-06-20T08:20:00-04:00"
    });

    const players = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "players.csv"), "utf8"));
    const odds = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "odds_snapshots.csv"), "utf8"));
    const sources = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "source_fetches.csv"), "utf8"));

    assert.equal(result.summary.oddsSnapshots, 15);
    assert.equal(players.some((row) => row.id === "rory-mcilroy"), true);
    assert.equal(odds.filter((row) => row.market === "top 10").length, 15);
    assert.equal(odds.filter((row) => row.book === "Oddschecker Best").length, 3);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].endpoint, "oddschecker-golf-market/2026-u-s-open-401811952/top-10");
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
