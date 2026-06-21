/*
 * Unit tests for scripts/golf-lab-refresh-public.js - automated public warehouse publisher.
 *
 * Run: node --test tests/golf-lab-refresh-public-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  parseArgs,
  selectEvent,
  buildPublicShowcase,
  writePublicShowcase
} = require("../scripts/golf-lab-refresh-public.js");

function sampleLab() {
  return {
    players: [
      { id: "alpha", name: "Alpha Player", tour: "PGA", sourceProvider: "ESPN", sourceUrl: "https://example.com", sourceUpdatedAt: "2026-06-20T10:00:00Z" },
      { id: "beta", name: "Beta Player", tour: "PGA", sourceProvider: "ESPN", sourceUrl: "https://example.com", sourceUpdatedAt: "2026-06-20T10:00:00Z" },
      { id: "gamma", name: "Gamma Player", tour: "PGA", sourceProvider: "ESPN", sourceUrl: "https://example.com", sourceUpdatedAt: "2026-06-20T10:00:00Z" }
    ],
    events: [
      { id: "old-event", name: "Old Open", startDate: "2026-05-01", endDate: "2026-05-04", courseId: "old-course", courseName: "Old Club", sourceProvider: "ESPN", sourceUrl: "https://example.com/old", sourceUpdatedAt: "2026-05-04T10:00:00Z" },
      { id: "current-event", name: "Current Open", startDate: "2026-06-18", endDate: "2026-06-21", courseId: "current-course", courseName: "Current Club", sourceProvider: "ESPN", sourceUrl: "https://example.com/current", sourceUpdatedAt: "2026-06-20T10:00:00Z" }
    ],
    courses: [
      { id: "old-course", name: "Old Club", sourceProvider: "PGA TOUR", sourceUrl: "https://example.com/old-course", sourceUpdatedAt: "2026-05-04T10:00:00Z" },
      { id: "current-course", name: "Current Club", sourceProvider: "PGA TOUR", sourceUrl: "https://example.com/current-course", sourceUpdatedAt: "2026-06-20T10:00:00Z" }
    ],
    courseSetups: [
      { id: "current-setup", eventId: "current-event", courseId: "current-course", sourceProvider: "PGA TOUR", sourceUrl: "https://example.com/current-course", sourceUpdatedAt: "2026-06-20T10:00:00Z" }
    ],
    fields: [
      { id: "field-alpha", eventId: "current-event", playerId: "alpha", playerName: "Alpha Player", status: "active", sourceProvider: "ESPN", sourceUrl: "https://example.com/field", sourceUpdatedAt: "2026-06-20T10:00:00Z" },
      { id: "field-beta", eventId: "current-event", playerId: "beta", playerName: "Beta Player", status: "active", sourceProvider: "ESPN", sourceUrl: "https://example.com/field", sourceUpdatedAt: "2026-06-20T10:00:00Z" }
    ],
    rounds: [
      { id: "alpha-r1", eventId: "old-event", playerId: "alpha", playerName: "Alpha Player", courseId: "old-course", roundNumber: 1, date: "2026-05-01", score: 70, toPar: 0, sgTotal: 1, sourceProvider: "ESPN", sourceUrl: "https://example.com/old", sourceUpdatedAt: "2026-05-04T10:00:00Z" },
      { id: "alpha-r2", eventId: "current-event", playerId: "alpha", playerName: "Alpha Player", courseId: "current-course", roundNumber: 1, date: "2026-06-18", score: 68, toPar: -2, sgTotal: 2, sourceProvider: "ESPN", sourceUrl: "https://example.com/current", sourceUpdatedAt: "2026-06-20T10:00:00Z" },
      { id: "beta-r1", eventId: "current-event", playerId: "beta", playerName: "Beta Player", courseId: "current-course", roundNumber: 1, date: "2026-06-18", score: 72, toPar: 2, sgTotal: -1, sourceProvider: "ESPN", sourceUrl: "https://example.com/current", sourceUpdatedAt: "2026-06-20T10:00:00Z" },
      { id: "gamma-r1", eventId: "current-event", playerId: "gamma", playerName: "Gamma Player", courseId: "current-course", roundNumber: 1, date: "2026-06-18", score: 74, toPar: 4, sgTotal: -3, sourceProvider: "ESPN", sourceUrl: "https://example.com/current", sourceUpdatedAt: "2026-06-20T10:00:00Z" }
    ],
    strokesGained: [
      { id: "alpha-r1-sg", eventId: "old-event", roundId: "alpha-r1", playerId: "alpha", sgTotal: 1, sourceProvider: "Derived", sourceUrl: "https://example.com/old", sourceUpdatedAt: "2026-05-04T10:00:00Z" },
      { id: "alpha-r2-sg", eventId: "current-event", roundId: "alpha-r2", playerId: "alpha", sgTotal: 2, sourceProvider: "Derived", sourceUrl: "https://example.com/current", sourceUpdatedAt: "2026-06-20T10:00:00Z" },
      { id: "beta-r1-sg", eventId: "current-event", roundId: "beta-r1", playerId: "beta", sgTotal: -1, sourceProvider: "Derived", sourceUrl: "https://example.com/current", sourceUpdatedAt: "2026-06-20T10:00:00Z" }
    ],
    weatherSnapshots: [
      { id: "weather-current", eventId: "current-event", courseId: "current-course", roundNumber: 1, date: "2026-06-18", windMph: 14, temperatureF: 74, sourceProvider: "Open-Meteo", sourceUrl: "https://example.com/weather", sourceUpdatedAt: "2026-06-20T10:00:00Z" }
    ],
    oddsSnapshots: [
      { id: "alpha-odds", eventId: "current-event", playerId: "alpha", market: "winner", book: "Book", oddsAmerican: 500, impliedProbability: 0.16, capturedAt: "2026-06-20T10:00:00Z", sourceProvider: "The Odds API", sourceUrl: "https://example.com/odds", sourceUpdatedAt: "2026-06-20T10:00:00Z" }
    ],
    modelPredictions: [
      { id: "alpha-pred", eventId: "current-event", playerId: "alpha", market: "winner", modelRunId: "run-1", modelProfile: "Major Test", modelWeatherScenario: "baseline", modelWeatherLabel: "Live forecast", probability: 0.22, rank: 1, createdAt: "2026-06-20T11:00:00Z", sourceProvider: "Owned model", sourceUrl: "owned-model/run-1", sourceUpdatedAt: "2026-06-20T11:00:00Z" },
      { id: "beta-pred", eventId: "current-event", playerId: "beta", market: "winner", modelRunId: "run-1", modelProfile: "Major Test", modelWeatherScenario: "baseline", modelWeatherLabel: "Live forecast", probability: 0.12, rank: 2, createdAt: "2026-06-20T11:00:00Z", sourceProvider: "Owned model", sourceUrl: "owned-model/run-1", sourceUpdatedAt: "2026-06-20T11:00:00Z" }
    ],
    predictionLedger: [
      { id: "alpha-ledger", eventId: "current-event", playerId: "alpha", market: "winner", modelRunId: "run-1", probability: 0.22, rank: 1, createdAt: "2026-06-20T11:00:00Z", sourceProvider: "Owned model", sourceUrl: "owned-model/run-1", sourceUpdatedAt: "2026-06-20T11:00:00Z" }
    ],
    sourceFetches: [
      { id: "current-source", provider: "ESPN", endpoint: "scoreboard", eventId: "current-event", fetchedAt: "2026-06-20T10:00:00Z", status: "ok", rowCount: 2, sourceUrl: "https://example.com/current" },
      { id: "model-source", provider: "Owned model", endpoint: "model", modelRunId: "run-1", fetchedAt: "2026-06-20T11:00:00Z", status: "ok", rowCount: 2, sourceUrl: "owned-model/run-1" }
    ]
  };
}

test("parseArgs: reads refresh/publish options", () => {
  const args = parseArgs([
    "--warehouse", "warehouse",
    "--artifact", "data/showcase.js",
    "--report", "report.json",
    "--event-id", "event-1",
    "--publish-only",
    "--offline",
    "--force-live",
    "--skip-odds",
    "--env-file", ".env",
    "--player-limit", "25"
  ]);

  assert.equal(args.warehouseDir, "warehouse");
  assert.equal(args.artifactFile, "data/showcase.js");
  assert.equal(args.reportFile, "report.json");
  assert.equal(args.selectedEventId, "event-1");
  assert.equal(args.publishOnly, true);
  assert.equal(args.offline, true);
  assert.equal(args.forceLive, true);
  assert.equal(args.skipOdds, true);
  assert.equal(args.envFile, ".env");
  assert.equal(args.playerLimit, 25);
});

test("selectEvent: favors current event before latest modeled fallback", () => {
  const event = selectEvent(sampleLab(), { now: new Date("2026-06-20T12:00:00Z") });

  assert.equal(event.id, "current-event");
});

test("buildPublicShowcase: publishes selected model players and source-backed context", () => {
  const showcase = buildPublicShowcase(sampleLab(), {
    now: new Date("2026-06-20T12:00:00Z"),
    fetchedAt: "2026-06-20T12:00:00Z",
    playerLimit: 2,
    roundsPerPlayer: 3,
    eventLimit: 4
  });

  assert.equal(showcase.selectedEventId, "current-event");
  assert.equal(showcase.modelRunId, "run-1");
  assert.equal(showcase.golfLab.players.length, 2);
  assert.equal(showcase.golfLab.players.some((player) => player.id === "gamma"), false);
  assert.equal(showcase.golfLab.fields.length, 2);
  assert.equal(showcase.golfLab.rounds.some((round) => round.playerId === "gamma"), false);
  assert.equal(showcase.golfLab.rounds.some((round) => round.eventId === "old-event"), true);
  assert.equal(showcase.golfLab.oddsSnapshots.length, 1);
  assert.equal(showcase.golfLab.modelPredictions.length, 2);
  assert.equal(showcase.golfLab.sourceFetches.length, 2);
  assert.equal(showcase.counts.players, 2);
  assert.ok(showcase.report.totalRecords > 0);
});

test("writePublicShowcase: writes executable app seed", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-refresh-public-"));
  try {
    const showcase = buildPublicShowcase(sampleLab(), {
      fetchedAt: "2026-06-20T12:00:00Z"
    });
    const file = path.join(tempRoot, "showcase.js");
    await writePublicShowcase(file, showcase, { warehouseDir: "warehouse" });
    const text = await fsp.readFile(file, "utf8");

    assert.match(text, /GolfLabPublicShowcase/);
    assert.match(text, /current-event/);
    assert.match(text, /Source-backed Golf Lab public warehouse/);
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
