/*
 * Unit tests for scripts/golf-lab-run-model.js - owned model CLI writer.
 *
 * Run: node --test tests/golf-lab-run-model-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const {
  parseArgs,
  profileFromOption,
  reportFromSnapshot,
  runGolfLabModel
} = require("../scripts/golf-lab-run-model.js");

function csv(name, rows) {
  return [Warehouse.COLLECTION_COLUMNS[name].join(","), ...rows].join("\n");
}

test("parseArgs: reads owned model run options", () => {
  const args = parseArgs([
    "--in", "warehouse",
    "--event-id", "us-open-2026",
    "--profile", "weather",
    "--weather-scenario", "wind",
    "--created-at", "2026-06-20T08:00:00-04:00",
    "--max-field-size", "80",
    "--live-state-weight", "0.9",
    "--disable-live-state",
    "--allow-projected-field",
    "--report", "report.json"
  ]);

  assert.equal(args.inputDir, "warehouse");
  assert.equal(args.eventId, "us-open-2026");
  assert.equal(args.profile, "weather");
  assert.equal(args.weatherScenario, "wind");
  assert.equal(args.createdAt, "2026-06-20T08:00:00-04:00");
  assert.equal(args.maxFieldSize, 80);
  assert.equal(args.liveStateWeight, 0.9);
  assert.equal(args.disableLiveState, true);
  assert.equal(args.requireOfficialField, false);
  assert.equal(args.reportFile, "report.json");
});

test("profileFromOption: accepts profile keys and labels", () => {
  assert.equal(profileFromOption("Major Test").key, "tough");
  assert.equal(profileFromOption("weather").label, "Weather Desk");
});

test("reportFromSnapshot: ignores blank odds and edge cells", () => {
  const report = reportFromSnapshot({
    predictions: [
      { market: "winner", rank: "1", marketOddsAmerican: "500", edge: "0.04" },
      { market: "top5", rank: "1", marketOddsAmerican: "", edge: "" },
      { market: "top10", rank: "1", marketOddsAmerican: undefined, edge: undefined },
      { market: "makeCut", rank: "1", marketOddsAmerican: "-120", edge: "-0.01" }
    ],
    features: [{ playerId: "alpha" }],
    warnings: []
  });

  assert.equal(report.counts.predictions, 4);
  assert.equal(report.counts.pricedPredictions, 2);
  assert.equal(report.counts.positiveEdges, 1);
});

test("runGolfLabModel: writes predictions, ledger, source proof, and report", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-run-model-"));
  const reportFile = path.join(tempRoot, "model-report.json");
  try {
    await fsp.writeFile(path.join(tempRoot, "players.csv"), csv("players", [
      "alpha,Alpha Player,USA,PGA,,,,,,,,,,ESPN,https://example.com,2026-06-20T08:00:00-04:00",
      "beta,Beta Player,USA,PGA,,,,,,,,,,ESPN,https://example.com,2026-06-20T08:00:00-04:00"
    ]), "utf8");
    await fsp.writeFile(path.join(tempRoot, "events.csv"), csv("events", [
      "event-1,Weekend Open,PGA TOUR,2026,2026-06-18,2026-06-21,course-1,Weekend Club,,In Progress,ESPN,https://example.com,2026-06-20T08:00:00-04:00"
    ]), "utf8");
    await fsp.writeFile(path.join(tempRoot, "courses.csv"), csv("courses", [
      "course-1,Weekend Club,Southampton NY,70,7400,,,2.1,2.1,major championship,Course,https://example.com,2026-06-20T08:00:00-04:00"
    ]), "utf8");
    await fsp.writeFile(path.join(tempRoot, "fields.csv"), csv("fields", [
      "event-1-alpha-field,event-1,alpha,Alpha Player,active,,ESPN,https://example.com,2026-06-20T08:00:00-04:00",
      "event-1-beta-field,event-1,beta,Beta Player,active,,ESPN,https://example.com,2026-06-20T08:00:00-04:00"
    ]), "utf8");
    await fsp.writeFile(path.join(tempRoot, "rounds.csv"), csv("rounds", [
      "alpha-r1,alpha,Alpha Player,event-0,course-1,Weekend Club,1,2026-05-01,68,-2,-2,2.2,Tough,ESPN,https://example.com,2026-06-20T08:00:00-04:00",
      "alpha-r2,alpha,Alpha Player,event-0,course-1,Weekend Club,2,2026-05-02,69,-1,-1,1.4,Tough,ESPN,https://example.com,2026-06-20T08:00:00-04:00",
      "beta-r1,beta,Beta Player,event-0,course-1,Weekend Club,1,2026-05-01,72,2,2,-0.4,Tough,ESPN,https://example.com,2026-06-20T08:00:00-04:00"
    ]), "utf8");
    await fsp.writeFile(path.join(tempRoot, "strokes_gained.csv"), csv("strokesGained", [
      "alpha-sg,alpha,Alpha Player,,season-2026,season-2026,1.8,0.5,0.8,0.1,0.3,1.4,305,0.66,0.71,0.64,PGA TOUR,https://example.com,2026-06-20T08:00:00-04:00",
      "beta-sg,beta,Beta Player,,season-2026,season-2026,0.2,0.1,0.1,0,0,0.2,295,0.61,0.66,0.58,PGA TOUR,https://example.com,2026-06-20T08:00:00-04:00"
    ]), "utf8");
    await fsp.writeFile(path.join(tempRoot, "weather_snapshots.csv"), csv("weatherSnapshots", [
      "event-1-weather,event-1,course-1,Weekend Club,3,2026-06-20,,2026-06-20T08:00:00-04:00,72,18,25,0,AM,NWS,https://example.com,2026-06-20T08:00:00-04:00"
    ]), "utf8");
    await fsp.writeFile(path.join(tempRoot, "odds_snapshots.csv"), csv("oddsSnapshots", [
      "alpha-odds,event-1,alpha,winner,Book,500,0.1667,2026-06-20T08:00:00-04:00,Market,https://example.com,2026-06-20T08:00:00-04:00",
      "beta-odds,event-1,beta,winner,Book,1000,0.0909,2026-06-20T08:00:00-04:00,Market,https://example.com,2026-06-20T08:00:00-04:00"
    ]), "utf8");
    await fsp.writeFile(path.join(tempRoot, "source_fetches.csv"), csv("sourceFetches", [
      "field-source,ESPN,field,event-1,,,,,,2026-06-20T08:00:00-04:00,ok,2,,https://example.com"
    ]), "utf8");

    const result = await runGolfLabModel(tempRoot, {
      eventId: "event-1",
      profile: "Major Test",
      weatherScenario: "baseline",
      createdAt: "2026-06-20T08:10:00-04:00",
      requireOfficialField: true,
      reportFile
    });

    const predictions = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "model_predictions.csv"), "utf8"));
    const ledger = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "prediction_ledger.csv"), "utf8"));
    const sources = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "source_fetches.csv"), "utf8"));
    const report = JSON.parse(await fsp.readFile(reportFile, "utf8"));

    assert.equal(result.report.counts.predictions, 8);
    assert.equal(predictions.length, 8);
    assert.equal(ledger.length, 8);
    assert.equal(predictions[0].modelProfile, "Major Test");
    assert.equal(sources.some((row) => row.provider === "Golf Lab Owned Model"), true);
    assert.equal(report.counts.winnerRows, 2);
    assert.equal(report.event.id, "event-1");
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
