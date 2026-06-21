/*
 * Unit tests for scripts/golf-lab-vegasinsider-odds.js - public VegasInsider odds adapter.
 *
 * Run: node --test tests/golf-lab-vegasinsider-odds-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const {
  parseArgs,
  extractVegasInsiderOdds,
  buildRowsFromExtracted,
  impliedProbabilityFromAmerican,
  adaptVegasInsiderOdds
} = require("../scripts/golf-lab-vegasinsider-odds.js");

function sampleHtml() {
  return `<!doctype html>
    <html>
      <body>
        <p>Updated on 6/19/26</p>
        <div id="futures-component">
          <header><h2>U.S. Open Odds</h2></header>
          <table id="table-tournament-winner">
            <thead>
              <tr>
                <th class="game-legend"><span class="hidden">Time</span></th>
                <th class="book-pinup blank"><span class="hidden">Bet365</span></th>
                <th class="book-pinup blank"><span class="hidden">BetMGM</span></th>
                <th class="book-pinup blank"><span class="hidden">DraftKings</span></th>
              </tr>
            </thead>
            <tbody id="see-all-tournament-winner" class="drawer active">
              <tr class="divided" data-name="scottie scheffler">
                <td class="game-team"><img src="player.png" /><span>Scottie Scheffler</span></td>
                <td class="game-odds"><a><span class="data-moneyline"> +600 </span></a></td>
                <td class="game-odds"><a><span class="data-moneyline"> +1400 </span></a></td>
                <td class="game-odds"><a><span class="data-moneyline"> +450 </span></a></td>
              </tr>
              <tr data-name="rory mcilroy">
                <td class="game-team"><span>Rory McIlroy</span></td>
                <td class="game-odds"><a><span class="data-moneyline"> +1100 </span></a></td>
                <td class="game-odds blank">&nbsp;</td>
                <td class="game-odds"><a><span class="data-moneyline"> +930 </span></a></td>
              </tr>
            </tbody>
          </table>
        </div>
      </body>
    </html>`;
}

test("parseArgs: reads VegasInsider odds adapter options", () => {
  const args = parseArgs([
    "--in", "raw/us-open.html",
    "--out", "warehouse",
    "--event-id", "2026-u-s-open-401811952",
    "--market", "winner",
    "--provider", "VI",
    "--source-url", "https://www.vegasinsider.com/golf/odds/futures/",
    "--fetched-at", "2026-06-19T20:30:00-04:00"
  ]);

  assert.equal(args.inputFile, "raw/us-open.html");
  assert.equal(args.outputDir, "warehouse");
  assert.equal(args.eventId, "2026-u-s-open-401811952");
  assert.equal(args.market, "winner");
  assert.equal(args.provider, "VI");
  assert.equal(args.sourceUrl, "https://www.vegasinsider.com/golf/odds/futures/");
  assert.equal(args.fetchedAt, "2026-06-19T20:30:00-04:00");
});

test("extractVegasInsiderOdds: parses books, player rows, blank odds, and page freshness", () => {
  const extracted = extractVegasInsiderOdds(sampleHtml(), { market: "winner" });

  assert.equal(extracted.title, "U.S. Open Odds");
  assert.deepEqual(extracted.books, ["Bet365", "BetMGM", "DraftKings"]);
  assert.equal(extracted.pageUpdatedText, "Updated on 6/19/26");
  assert.equal(extracted.pageUpdatedAt, "2026-06-19");
  assert.equal(extracted.rows.length, 5);
  assert.deepEqual(extracted.rows.slice(0, 3).map((row) => row.oddsAmerican), [600, 1400, 450]);
  assert.equal(extracted.rows[0].playerName, "Scottie Scheffler");
  assert.equal(extracted.rows[4].book, "DraftKings");
});

test("impliedProbabilityFromAmerican: converts American prices", () => {
  assert.equal(Math.round(impliedProbabilityFromAmerican(600) * 10000) / 10000, 0.1429);
  assert.equal(Math.round(impliedProbabilityFromAmerican(-120) * 10000) / 10000, 0.5455);
});

test("buildRowsFromExtracted: maps odds players to selected event field IDs", () => {
  const extracted = extractVegasInsiderOdds(sampleHtml(), { market: "winner" });
  const result = buildRowsFromExtracted(extracted, {
    players: [{ id: "scottie-scheffler", name: "Scottie Scheffler" }],
    fields: [
      { eventId: "2026-u-s-open-401811952", playerId: "scottie-scheffler", playerName: "Scottie Scheffler" },
      { eventId: "2026-u-s-open-401811952", playerId: "rory-mcilroy", playerName: "Rory McIlroy" }
    ]
  }, {
    eventId: "2026-u-s-open-401811952",
    market: "winner",
    provider: "VegasInsider public odds",
    sourceUrl: "https://www.vegasinsider.com/golf/odds/futures/",
    fetchedAt: "2026-06-19T20:30:00-04:00"
  });

  assert.equal(result.summary.oddsSnapshots, 5);
  assert.equal(result.summary.createdPlayers, 1);
  assert.equal(result.tables.oddsSnapshots[0].playerId, "scottie-scheffler");
  assert.equal(result.tables.oddsSnapshots.find((row) => row.playerId === "rory-mcilroy").book, "Bet365");
  assert.equal(result.tables.oddsSnapshots[0].impliedProbability, "0.1429");
  assert.match(result.tables.sourceFetches[0].manifestJson, /public-vegasinsider-html-odds/);
});

test("adaptVegasInsiderOdds: writes market rows and source proof", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-vegasinsider-"));
  try {
    const inputFile = path.join(tempRoot, "us-open.html");
    const outputDir = path.join(tempRoot, "warehouse");
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(inputFile, sampleHtml(), "utf8");
    await fsp.writeFile(path.join(outputDir, "players.csv"), [
      "id,name,country,tour,owgrRank,dataGolfId,pgaTourId,photoUrl,profileUrl,handedness,age,turnedPro,college,sourceProvider,sourceUrl,sourceUpdatedAt",
      "scottie-scheffler,Scottie Scheffler,,,,,,,,,,,,ESPN,https://example.com,2026-06-19T12:00:00Z"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(outputDir, "fields.csv"), [
      "id,eventId,playerId,playerName,status,teeTime,sourceProvider,sourceUrl,sourceUpdatedAt",
      "field-1,2026-u-s-open-401811952,scottie-scheffler,Scottie Scheffler,active,,ESPN,https://example.com,2026-06-19T12:00:00Z",
      "field-2,2026-u-s-open-401811952,rory-mcilroy,Rory McIlroy,active,,ESPN,https://example.com,2026-06-19T12:00:00Z"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(outputDir, "odds_snapshots.csv"), "id,eventId,playerId,market,book,oddsAmerican,impliedProbability,capturedAt,sourceProvider,sourceUrl,sourceUpdatedAt\n", "utf8");
    await fsp.writeFile(path.join(outputDir, "source_fetches.csv"), "id,provider,endpoint,eventId,modelRunId,modelVersion,modelProfile,modelWeatherScenario,modelWeatherLabel,fetchedAt,status,rowCount,manifestJson,sourceUrl\n", "utf8");

    const result = await adaptVegasInsiderOdds(inputFile, outputDir, {
      eventId: "2026-u-s-open-401811952",
      market: "winner",
      fetchedAt: "2026-06-19T20:30:00-04:00"
    });

    const players = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "players.csv"), "utf8"));
    const odds = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "odds_snapshots.csv"), "utf8"));
    const sources = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "source_fetches.csv"), "utf8"));

    assert.equal(result.summary.oddsSnapshots, 5);
    assert.equal(players.some((row) => row.id === "rory-mcilroy"), true);
    assert.equal(odds.length, 5);
    assert.equal(odds[0].eventId, "2026-u-s-open-401811952");
    assert.equal(odds[0].sourceProvider, "VegasInsider public odds");
    assert.equal(sources.length, 1);
    assert.equal(sources[0].endpoint, "vegasinsider-golf-futures/2026-u-s-open-401811952/winner");
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
