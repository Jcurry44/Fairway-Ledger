/*
 * Unit tests for lib/golf-lab-model.js - owned Golf Lab prediction model.
 *
 * Run:  node --test tests/golf-lab-model.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../lib/golf-lab-model.js");

function near(actual, expected, eps = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`
  );
}

test("buildOwnedModelSnapshot: scores field with skill, course, weather, and market context", () => {
  const snapshot = M.buildOwnedModelSnapshot({
    players: [
      { id: "alpha", name: "Alpha Player", owgrRank: 8, tour: "PGA Tour" },
      { id: "beta", name: "Beta Player", owgrRank: 24, tour: "PGA Tour" }
    ],
    events: [
      {
        id: "us-open-2026",
        name: "U.S. Open",
        tour: "PGA Tour",
        startDate: "2026-06-19",
        courseId: "oakmont",
        courseName: "Oakmont"
      }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", par: 70, fieldAdjustedToPar: 2.3 },
      { id: "harbor", name: "Harbor Links", par: 72, fieldAdjustedToPar: -1.1 }
    ],
    fields: [
      { eventId: "us-open-2026", playerId: "alpha", status: "active" },
      { eventId: "us-open-2026", playerId: "beta", status: "active" }
    ],
    rounds: [
      { playerId: "alpha", eventId: "wind-1", courseId: "oakmont", round: 1, date: "2026-05-18", sgTotal: 3.2 },
      { playerId: "alpha", eventId: "wind-1", courseId: "oakmont", round: 2, date: "2026-05-19", sgTotal: 2.6 },
      { playerId: "alpha", eventId: "easy-1", courseId: "harbor", round: 1, date: "2026-04-12", sgTotal: 1.4 },
      { playerId: "beta", eventId: "wind-1", courseId: "oakmont", round: 1, date: "2026-05-18", sgTotal: -0.2 },
      { playerId: "beta", eventId: "wind-1", courseId: "oakmont", round: 2, date: "2026-05-19", sgTotal: 0.1 },
      { playerId: "beta", eventId: "easy-1", courseId: "harbor", round: 1, date: "2026-04-12", sgTotal: 0.4 }
    ],
    strokesGained: [
      { playerId: "alpha", period: "rolling", sgTotal: 2.4, sgT2g: 2.0, sgOtt: 0.7, sgApp: 1.1 },
      { playerId: "beta", period: "rolling", sgTotal: 0.5, sgT2g: 0.4, sgOtt: 0.1, sgApp: 0.2 }
    ],
    weatherSnapshots: [
      { eventId: "us-open-2026", courseId: "oakmont", round: 1, windMph: 22, gustMph: 31, temperatureF: 69 },
      { eventId: "wind-1", courseId: "oakmont", round: 1, windMph: 20, gustMph: 29, temperatureF: 66 },
      { eventId: "wind-1", courseId: "oakmont", round: 2, windMph: 19, gustMph: 28, temperatureF: 67 }
    ],
    oddsSnapshots: [
      { eventId: "us-open-2026", playerId: "alpha", market: "winner", book: "Market", oddsAmerican: 450 },
      { eventId: "us-open-2026", playerId: "alpha", market: "top10", book: "Market", oddsAmerican: -120 },
      { eventId: "us-open-2026", playerId: "alpha", market: "top-20", book: "Market", oddsAmerican: -260 },
      { eventId: "us-open-2026", playerId: "alpha", market: "make cut", book: "Market", oddsAmerican: -450 },
      { eventId: "us-open-2026", playerId: "beta", market: "winner", book: "Market", oddsAmerican: 900 }
    ],
    sourceFetches: [
      { provider: "PGA Tour", endpoint: "/fields/us-open-2026", fetchedAt: "2026-06-18T10:00:00Z", status: "ok", rowCount: 2 }
    ]
  }, {
    eventId: "us-open-2026",
    createdAt: "2026-06-18T12:00:00Z",
    modelProfile: "Major Test"
  });

  const winnerRows = snapshot.predictions.filter((row) => row.market === "winner");
  const top10Rows = snapshot.predictions.filter((row) => row.market === "top 10");
  const top20Rows = snapshot.predictions.filter((row) => row.market === "top 20");
  const makeCutRows = snapshot.predictions.filter((row) => row.market === "make cut");

  assert.equal(snapshot.event.name, "U.S. Open");
  assert.equal(snapshot.course.name, "Oakmont");
  assert.equal(M.weatherBucket(snapshot.weather), "wind");
  assert.equal(winnerRows.length, 2);
  assert.equal(top10Rows.length, 2);
  assert.equal(top20Rows.length, 2);
  assert.equal(makeCutRows.length, 2);
  assert.equal(winnerRows[0].playerId, "alpha");
  assert.equal(snapshot.features[0].playerId, "alpha");
  assert.ok(snapshot.features[0].weatherFit > snapshot.features[1].weatherFit);
  assert.equal(winnerRows[0].rank, 1);
  assert.equal(winnerRows[0].modelProfile, "Major Test");
  assert.equal(winnerRows[0].modelWeatherScenario, "baseline");
  assert.equal(winnerRows[0].modelWeatherLabel, "Live forecast");
  assert.equal(snapshot.weatherScenario.key, "baseline");
  assert.ok(Number.isFinite(winnerRows[0].skill));
  assert.ok(Number.isFinite(winnerRows[0].recentForm));
  assert.ok(Number.isFinite(winnerRows[0].courseFit));
  assert.ok(Number.isFinite(winnerRows[0].weatherFit));
  assert.equal(winnerRows[0].sampleRounds, 3);
  assert.ok(Number.isFinite(winnerRows[0].fairOddsAmerican));
  assert.ok(Number.isFinite(winnerRows[0].edge));
  assert.ok(Number.isFinite(top10Rows.find((row) => row.playerId === "alpha").edge));
  assert.ok(Number.isFinite(top20Rows.find((row) => row.playerId === "alpha").edge));
  assert.ok(Number.isFinite(makeCutRows.find((row) => row.playerId === "alpha").edge));
  assert.equal(snapshot.golfLab.modelPredictions.length, 8);
  assert.ok(Number.isFinite(snapshot.golfLab.modelPredictions[0].skill));
  assert.equal(snapshot.golfLab.sourceFetches[0].provider, "Golf Lab Owned Model");
  assert.ok(snapshot.manifest.modelRunId.startsWith("model-run-us-open-2026-major-test-baseline-"));
  assert.equal(snapshot.golfLab.modelPredictions[0].modelRunId, snapshot.manifest.modelRunId);
  assert.equal(snapshot.golfLab.sourceFetches[0].modelRunId, snapshot.manifest.modelRunId);
  assert.equal(JSON.parse(snapshot.golfLab.sourceFetches[0].manifestJson).counts.predictions, 8);
  near(winnerRows.reduce((sum, row) => sum + row.probability, 0), 1);
});

test("buildModelRunHistoryBoard: reconstructs reproducible owned model runs", () => {
  const base = {
    players: [
      { id: "alpha", name: "Alpha Player", owgrRank: 8 },
      { id: "beta", name: "Beta Player", owgrRank: 24 }
    ],
    events: [
      { id: "event-1", name: "Run History Open", startDate: "2026-06-19", courseId: "course-1", courseName: "History Club" }
    ],
    courses: [{ id: "course-1", name: "History Club", fieldAdjustedToPar: 1.4 }],
    fields: [
      { eventId: "event-1", playerId: "alpha" },
      { eventId: "event-1", playerId: "beta" }
    ],
    rounds: [
      { eventId: "prior-1", playerId: "alpha", courseId: "course-1", round: 1, sgTotal: 2.4 },
      { eventId: "prior-1", playerId: "beta", courseId: "course-1", round: 1, sgTotal: 0.4 }
    ],
    strokesGained: [
      { playerId: "alpha", sgTotal: 1.7, sgT2g: 1.3 },
      { playerId: "beta", sgTotal: 0.3, sgT2g: 0.2 }
    ],
    oddsSnapshots: [
      { eventId: "event-1", playerId: "alpha", market: "winner", oddsAmerican: 500 },
      { eventId: "event-1", playerId: "beta", market: "winner", oddsAmerican: 1200 }
    ],
    sourceFetches: [
      { provider: "Official Field", endpoint: "/fields/event-1", fetchedAt: "2026-06-18T10:00:00Z", rowCount: 2 }
    ]
  };
  const snapshot = M.buildOwnedModelSnapshot(base, {
    eventId: "event-1",
    createdAt: "2026-06-18T12:00:00Z",
    modelProfile: "Balanced",
    activationPlan: {
      score: 91,
      status: "ready",
      statusLabel: "Launch Ready",
      criticalBlockers: [],
      nextActions: []
    }
  });
  const board = M.buildModelRunHistoryBoard({
    ...base,
    modelPredictions: snapshot.golfLab.modelPredictions,
    predictionLedger: snapshot.golfLab.predictionLedger,
    sourceFetches: snapshot.golfLab.sourceFetches
  }, {
    eventId: "event-1",
    market: "all"
  });

  assert.equal(board.summary.runs, 1);
  assert.equal(board.summary.manifestRuns, 1);
  assert.equal(board.summary.reproduciblePct, 100);
  assert.equal(board.rows[0].modelRunId, snapshot.manifest.modelRunId);
  assert.equal(board.rows[0].statusLabel, "Reproducible");
  assert.equal(board.rows[0].predictions, 8);
  assert.equal(board.rows[0].players, 2);
  assert.equal(board.rows[0].activationScore, 91);
  assert.ok(board.rows[0].sourceProviders.includes("Official Field"));
});

test("buildOwnedModelSnapshot: applies weather scenarios to weather-fit scoring", () => {
  const input = {
    players: [
      { id: "wind-player", name: "Wind Player" },
      { id: "rain-player", name: "Rain Player" }
    ],
    events: [
      { id: "event-1", name: "Scenario Open", startDate: "2026-06-19", courseId: "course-1", courseName: "Scenario Club" }
    ],
    courses: [
      { id: "course-1", name: "Scenario Club", fieldAdjustedToPar: 1.2 }
    ],
    fields: [
      { eventId: "event-1", playerId: "wind-player" },
      { eventId: "event-1", playerId: "rain-player" }
    ],
    rounds: [
      { eventId: "wind-history", playerId: "wind-player", courseId: "course-1", round: 1, sgTotal: 2.2 },
      { eventId: "rain-history", playerId: "rain-player", courseId: "course-1", round: 1, sgTotal: 2.4 }
    ],
    strokesGained: [
      { playerId: "wind-player", sgTotal: 0.5, sgT2g: 0.5, sgOtt: 0.2, sgApp: 0.2 },
      { playerId: "rain-player", sgTotal: 0.5, sgT2g: 0.5, sgOtt: 0.2, sgApp: 0.2 }
    ],
    weatherSnapshots: [
      { eventId: "wind-history", courseId: "course-1", round: 1, windMph: 22, gustMph: 32 },
      { eventId: "rain-history", courseId: "course-1", round: 1, windMph: 8, precipitationIn: 0.12 }
    ]
  };

  const wind = M.buildOwnedModelSnapshot(input, {
    eventId: "event-1",
    weatherScenario: "wind",
    weights: { skill: 0, recentForm: 0, courseFit: 0, difficultyFit: 0, weatherFit: 1 }
  });
  const rain = M.buildOwnedModelSnapshot(input, {
    eventId: "event-1",
    weatherScenario: "rain",
    weights: { skill: 0, recentForm: 0, courseFit: 0, difficultyFit: 0, weatherFit: 1 }
  });

  assert.equal(wind.weatherScenario.key, "wind");
  assert.equal(wind.weatherScenario.label, "Wind test");
  assert.equal(wind.features[0].playerId, "wind-player");
  assert.equal(wind.predictions[0].modelWeatherScenario, "wind");
  assert.equal(rain.weatherScenario.key, "rain");
  assert.equal(rain.features[0].playerId, "rain-player");
  assert.equal(rain.predictions[0].modelWeatherLabel, "Rain draw");
});

test("buildOwnedModelSnapshot: weights live standings when current event rounds exist", () => {
  const snapshot = M.buildOwnedModelSnapshot({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    events: [
      { id: "event-1", name: "Weekend Open", startDate: "2026-06-18", courseId: "course-1", courseName: "Weekend Club" }
    ],
    courses: [
      { id: "course-1", name: "Weekend Club", fieldAdjustedToPar: 2.4 }
    ],
    fields: [
      { eventId: "event-1", playerId: "alpha" },
      { eventId: "event-1", playerId: "beta" }
    ],
    rounds: [
      { eventId: "prior-1", playerId: "alpha", courseId: "course-1", round: 1, date: "2026-05-01", sgTotal: 4 },
      { eventId: "prior-1", playerId: "alpha", courseId: "course-1", round: 2, date: "2026-05-02", sgTotal: 3 },
      { eventId: "prior-1", playerId: "beta", courseId: "course-1", round: 1, date: "2026-05-01", sgTotal: 0.1 },
      { eventId: "prior-1", playerId: "beta", courseId: "course-1", round: 2, date: "2026-05-02", sgTotal: 0.1 },
      { eventId: "event-1", playerId: "alpha", courseId: "course-1", round: 1, date: "2026-06-18", toPar: 1 },
      { eventId: "event-1", playerId: "alpha", courseId: "course-1", round: 2, date: "2026-06-19", toPar: 1 },
      { eventId: "event-1", playerId: "beta", courseId: "course-1", round: 1, date: "2026-06-18", toPar: -3 },
      { eventId: "event-1", playerId: "beta", courseId: "course-1", round: 2, date: "2026-06-19", toPar: -2 }
    ],
    strokesGained: [
      { playerId: "alpha", period: "season", sgTotal: 3, sgT2g: 2.5 },
      { playerId: "beta", period: "season", sgTotal: 0.1, sgT2g: 0.1 }
    ]
  }, {
    eventId: "event-1",
    createdAt: "2026-06-20T08:00:00-04:00"
  });

  const winnerRows = snapshot.predictions.filter((row) => row.market === "winner");

  assert.equal(snapshot.manifest.modelVersion, "owned-v0.4");
  assert.equal(snapshot.manifest.liveState.active, true);
  assert.equal(snapshot.manifest.liveState.coveragePct, 100);
  assert.ok(snapshot.manifest.weights.liveState > 0);
  assert.equal(winnerRows[0].playerId, "beta");
  assert.equal(winnerRows[0].livePosition, 1);
  assert.equal(winnerRows[0].liveToPar, -5);
  assert.equal(winnerRows[0].liveRounds, 2);
  assert.equal(winnerRows[0].liveStrokesBack, 0);
  assert.ok(winnerRows[0].liveState > winnerRows[1].liveState);
});

test("buildProjectedStandingsBoard: turns saved model output into plain-English finish projections", () => {
  const base = {
    players: [
      { id: "alpha", name: "Alpha Player", country: "USA" },
      { id: "beta", name: "Beta Player", country: "ENG" },
      { id: "gamma", name: "Gamma Player", country: "CAN" }
    ],
    events: [
      { id: "event-1", name: "Weekend Open", startDate: "2026-06-18", courseId: "course-1", courseName: "Weekend Club" }
    ],
    courses: [
      { id: "course-1", name: "Weekend Club", fieldAdjustedToPar: 2.4 }
    ],
    fields: [
      { eventId: "event-1", playerId: "alpha" },
      { eventId: "event-1", playerId: "beta" },
      { eventId: "event-1", playerId: "gamma" }
    ],
    rounds: [
      { eventId: "prior-1", playerId: "alpha", courseId: "course-1", round: 1, date: "2026-05-01", sgTotal: 4 },
      { eventId: "prior-1", playerId: "alpha", courseId: "course-1", round: 2, date: "2026-05-02", sgTotal: 3 },
      { eventId: "prior-1", playerId: "beta", courseId: "course-1", round: 1, date: "2026-05-01", sgTotal: 0.6 },
      { eventId: "prior-1", playerId: "beta", courseId: "course-1", round: 2, date: "2026-05-02", sgTotal: 0.4 },
      { eventId: "prior-1", playerId: "gamma", courseId: "course-1", round: 1, date: "2026-05-01", sgTotal: -0.5 },
      { eventId: "event-1", playerId: "alpha", courseId: "course-1", round: 1, date: "2026-06-18", toPar: 1 },
      { eventId: "event-1", playerId: "alpha", courseId: "course-1", round: 2, date: "2026-06-19", toPar: 1 },
      { eventId: "event-1", playerId: "beta", courseId: "course-1", round: 1, date: "2026-06-18", toPar: -3 },
      { eventId: "event-1", playerId: "beta", courseId: "course-1", round: 2, date: "2026-06-19", toPar: -2 },
      { eventId: "event-1", playerId: "gamma", courseId: "course-1", round: 1, date: "2026-06-18", toPar: 4 },
      { eventId: "event-1", playerId: "gamma", courseId: "course-1", round: 2, date: "2026-06-19", toPar: 3 }
    ],
    strokesGained: [
      { playerId: "alpha", period: "season", sgTotal: 3, sgT2g: 2.5 },
      { playerId: "beta", period: "season", sgTotal: 0.7, sgT2g: 0.5 },
      { playerId: "gamma", period: "season", sgTotal: -0.2, sgT2g: -0.1 }
    ],
    oddsSnapshots: [
      { eventId: "event-1", playerId: "beta", market: "winner", oddsAmerican: 500 },
      { eventId: "event-1", playerId: "alpha", market: "winner", oddsAmerican: 900 }
    ]
  };
  const snapshot = M.buildOwnedModelSnapshot(base, {
    eventId: "event-1",
    createdAt: "2026-06-20T08:00:00-04:00",
    modelProfile: "Major Test"
  });
  const board = M.buildProjectedStandingsBoard({
    ...base,
    modelPredictions: snapshot.golfLab.modelPredictions,
    predictionLedger: snapshot.golfLab.predictionLedger,
    sourceFetches: snapshot.golfLab.sourceFetches
  }, {
    eventId: "event-1",
    maxRows: 3
  });

  assert.equal(board.event.name, "Weekend Open");
  assert.equal(board.summary.players, 3);
  assert.equal(board.summary.liveRounds, 2);
  assert.equal(board.summary.liveLeaderToPar, -5);
  assert.equal(board.rows.length, 3);
  assert.equal(board.rows[0].playerId, "beta");
  assert.equal(board.rows[0].projectedPositionLabel, "1");
  assert.equal(Number.isFinite(board.rows[0].projectedToPar), true);
  assert.equal(board.rows[0].plainEnglish.some((line) => line.includes("lead")), true);
  assert.ok(board.rows[0].riskFlags.length > 0);
  assert.equal(board.rows[0].contributions.some((row) => row.key === "liveState"), true);
  assert.equal(board.rows[1].projectedPosition >= 2, true);
});

test("buildPredictionResultsSummaryBoard: explains settled player hits, misses, and undercalled upside", () => {
  const players = Array.from({ length: 30 }, (_, index) => {
    const id = index === 0 ? "alpha" : index === 1 ? "beta" : index === 2 ? "gamma" : `player-${index + 1}`;
    const name = index === 0 ? "Alpha Player" : index === 1 ? "Beta Player" : index === 2 ? "Gamma Player" : `Player ${index + 1}`;
    return { id, name };
  });
  const totals = new Map(players.map((player, index) => [player.id, index + 1]));
  totals.set("alpha", -8);
  totals.set("gamma", -6);
  totals.set("beta", 40);
  const rounds = players.flatMap((player) => {
    const total = totals.get(player.id);
    return [1, 2, 3, 4].map((round) => ({
      eventId: "event-1",
      playerId: player.id,
      round,
      toPar: round === 4 ? total : 0
    }));
  });
  const predictionBase = {
    eventId: "event-1",
    modelRunId: "model-run-event-1-balanced-baseline-test",
    modelProfile: "Balanced",
    modelWeatherScenario: "baseline",
    modelWeatherLabel: "Live forecast",
    modelVersion: M.MODEL_VERSION,
    createdAt: "2026-06-17T12:00:00Z",
    confidence: "high",
    sampleRounds: 24,
    courseFit: 0.4,
    difficultyFit: 0.2,
    weatherFit: 0,
    liveState: 0
  };
  const predictionLedger = [
    { ...predictionBase, id: "alpha-win", playerId: "alpha", market: "winner", probability: 0.22, fairOddsAmerican: 355, marketOddsAmerican: 500, edge: 0.05, rank: 2, score: 3.1, skill: 2.2, recentForm: 1.1 },
    { ...predictionBase, id: "alpha-top10", playerId: "alpha", market: "top 10", probability: 0.72, fairOddsAmerican: -257, marketOddsAmerican: -140, edge: 0.08, rank: 2, score: 3.1, skill: 2.2, recentForm: 1.1 },
    { ...predictionBase, id: "beta-win", playerId: "beta", market: "winner", probability: 0.3, fairOddsAmerican: 233, marketOddsAmerican: 400, edge: 0.1, rank: 1, score: 3.4, skill: 2.6, recentForm: 1.4 },
    { ...predictionBase, id: "beta-top10", playerId: "beta", market: "top 10", probability: 0.76, fairOddsAmerican: -317, marketOddsAmerican: -130, edge: 0.09, rank: 1, score: 3.4, skill: 2.6, recentForm: 1.4 },
    { ...predictionBase, id: "gamma-win", playerId: "gamma", market: "winner", probability: 0.02, fairOddsAmerican: 4900, marketOddsAmerican: 8000, edge: 0.008, rank: 35, score: -0.2, skill: -0.5, recentForm: -0.4, courseFit: -0.3 }
  ];

  const board = M.buildPredictionResultsSummaryBoard({
    players,
    events: [{ id: "event-1", name: "Results Open", startDate: "2026-06-18", courseName: "Accountability Club" }],
    rounds,
    predictionLedger
  }, {
    eventId: "event-1",
    minEdge: 0,
    maxRows: 6
  });

  const alpha = board.allRows.find((row) => row.playerId === "alpha");
  const beta = board.allRows.find((row) => row.playerId === "beta");
  const gamma = board.allRows.find((row) => row.playerId === "gamma");

  assert.equal(board.summary.players, 3);
  assert.equal(board.summary.settledPlayers, 3);
  assert.equal(board.summary.rightReads, 1);
  assert.equal(board.summary.misses, 1);
  assert.equal(board.summary.undercalled, 1);
  assert.equal(alpha.outcome, "worked");
  assert.ok(alpha.plainEnglish.some((line) => line.includes("direction was right")));
  assert.equal(beta.outcome, "missed");
  assert.ok(beta.plainEnglish.some((line) => line.includes("missed high")));
  assert.ok(beta.lessons.some((line) => line.includes("model miss") || line.includes("warning signs")));
  assert.equal(gamma.outcome, "undercalled");
  assert.ok(gamma.plainEnglish.some((line) => line.includes("beat the model")));
  assert.equal(beta.marketOutcomes.some((market) => market.status === "miss"), true);
  assert.equal(alpha.marketOutcomes.some((market) => market.status === "hit"), true);
});

test("buildOwnedModelSnapshot: reports no-event datasets clearly", () => {
  const snapshot = M.buildOwnedModelSnapshot({ players: [{ id: "alpha", name: "Alpha Player" }] });

  assert.equal(snapshot.event, null);
  assert.deepEqual(snapshot.predictions, []);
  assert.equal(snapshot.warnings[0], "No events available for modeling.");
});

test("buildOwnedModelSnapshot: strict saved runs require official field rows", () => {
  const snapshot = M.buildOwnedModelSnapshot({
    players: [{ id: "alpha", name: "Alpha Player" }],
    events: [{ id: "event-1", name: "No Field Open", startDate: "2026-06-19" }],
    rounds: [{ eventId: "prior-1", playerId: "alpha", round: 1, sgTotal: 2.1 }]
  }, {
    eventId: "event-1",
    requireOfficialField: true
  });

  assert.equal(snapshot.event.name, "No Field Open");
  assert.deepEqual(snapshot.predictions, []);
  assert.equal(snapshot.warnings[0], "Official field rows are required before saving model predictions.");
});

test("buildModelTrainingDataset: creates leakage-aware event/player examples", () => {
  const dataset = M.buildModelTrainingDataset({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    events: [
      { id: "prior-1", name: "Prior Open", startDate: "2026-04-01", courseId: "course-1", courseName: "Course One" },
      { id: "target-1", name: "Target Open", startDate: "2026-06-01", courseId: "course-1", courseName: "Course One" }
    ],
    courses: [{ id: "course-1", name: "Course One", fieldAdjustedToPar: 1.1 }],
    fields: [
      { eventId: "target-1", playerId: "alpha", status: "active" },
      { eventId: "target-1", playerId: "beta", status: "active" }
    ],
    rounds: [
      { eventId: "prior-1", playerId: "alpha", courseId: "course-1", round: 1, date: "2026-04-01", toPar: -2, sgTotal: 2 },
      { eventId: "prior-1", playerId: "beta", courseId: "course-1", round: 1, date: "2026-04-01", toPar: 2, sgTotal: -1 },
      { eventId: "target-1", playerId: "alpha", courseId: "course-1", round: 1, date: "2026-06-01", toPar: -4, sgTotal: 4 },
      { eventId: "target-1", playerId: "alpha", courseId: "course-1", round: 2, date: "2026-06-02", toPar: -1, sgTotal: 1 },
      { eventId: "target-1", playerId: "beta", courseId: "course-1", round: 1, date: "2026-06-01", toPar: 1, sgTotal: -0.4 },
      { eventId: "target-1", playerId: "beta", courseId: "course-1", round: 2, date: "2026-06-02", toPar: 2, sgTotal: -0.8 }
    ],
    strokesGained: [
      { playerId: "alpha", sgTotal: 1.2, sgT2g: 1.1, sgOtt: 0.3, sgApp: 0.6 },
      { playerId: "beta", sgTotal: -0.2, sgT2g: -0.1, sgOtt: 0, sgApp: -0.1 }
    ],
    weatherSnapshots: [{ eventId: "target-1", courseId: "course-1", windMph: 14, gustMph: 20 }],
    oddsSnapshots: [{ eventId: "target-1", playerId: "alpha", market: "winner", oddsAmerican: 500 }]
  }, {
    eventLimit: 1,
    createdAt: "2026-06-18T12:00:00Z"
  });

  const alpha = dataset.rows.find((row) => row.playerId === "alpha");
  const beta = dataset.rows.find((row) => row.playerId === "beta");

  assert.equal(dataset.summary.events, 1);
  assert.equal(dataset.summary.rows, 2);
  assert.equal(dataset.eventRows[0].eventId, "target-1");
  assert.equal(alpha.winner, true);
  assert.equal(alpha.finishPosition, 1);
  assert.equal(alpha.sampleRounds, 1);
  assert.equal(alpha.totalToPar, -5);
  assert.equal(alpha.marketOddsAmerican, 500);
  assert.equal(beta.winner, false);
  assert.equal(beta.sampleRounds, 1);
  assert.equal(dataset.summary.featureCoverage, 100);
});

test("americanFromProbability: converts fair probability into moneyline odds", () => {
  assert.equal(M.americanFromProbability(0.2), 400);
  assert.equal(M.americanFromProbability(0.6), -150);
  assert.equal(M.americanFromProbability(0), null);
});

test("buildEventStandings: ranks finished event scoring with ties", () => {
  const standings = M.buildEventStandings({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    rounds: [
      { eventId: "event-1", playerId: "alpha", round: 1, toPar: -2, adjustedToPar: 8 },
      { eventId: "event-1", playerId: "alpha", round: 2, toPar: 1 },
      { eventId: "event-1", playerId: "beta", round: 1, toPar: -1, adjustedToPar: -8 },
      { eventId: "event-1", playerId: "beta", round: 2, toPar: 0 },
      { eventId: "event-1", playerId: "gamma", round: 1, toPar: 3 }
    ]
  }, "event-1");

  assert.equal(standings[0].playerId, "alpha");
  assert.equal(standings[0].position, 1);
  assert.equal(standings[1].playerId, "beta");
  assert.equal(standings[1].position, 1);
  assert.equal(standings[2].position, 3);
});

test("buildPredictionBacktest: grades winner, placement, and make-cut predictions with units", () => {
  const backtest = M.buildPredictionBacktest({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    rounds: [
      { eventId: "event-1", playerId: "alpha", round: 1, toPar: -3 },
      { eventId: "event-1", playerId: "alpha", round: 2, toPar: 0 },
      { eventId: "event-1", playerId: "beta", round: 1, toPar: 2 },
      { eventId: "event-1", playerId: "beta", round: 2, toPar: 1 }
    ],
    predictionLedger: [
      { id: "p1", eventId: "event-1", playerId: "alpha", market: "winner", probability: 0.25, edge: 0.03, marketOddsAmerican: 500, createdAt: "2026-06-18T10:00:00Z" },
      { id: "p2", eventId: "event-1", playerId: "beta", market: "winner", probability: 0.2, edge: 0.02, marketOddsAmerican: 400, createdAt: "2026-06-18T10:00:00Z" },
      { id: "p3", eventId: "event-1", playerId: "beta", market: "top 10", probability: 0.7, edge: 0.01, marketOddsAmerican: -150, createdAt: "2026-06-18T10:00:00Z" },
      { id: "p4", eventId: "event-1", playerId: "alpha", market: "top 20", probability: 0.82, edge: 0.04, marketOddsAmerican: -200, createdAt: "2026-06-18T10:00:00Z" },
      { id: "p5", eventId: "event-1", playerId: "beta", market: "make cut", probability: 0.58, edge: 0.02, marketOddsAmerican: -110, createdAt: "2026-06-18T10:00:00Z" }
    ]
  }, { minEdge: 0 });

  const alpha = backtest.graded.find((row) => row.id === "p1");
  const betaWin = backtest.graded.find((row) => row.id === "p2");
  const betaTop10 = backtest.graded.find((row) => row.id === "p3");
  const alphaTop20 = backtest.graded.find((row) => row.id === "p4");
  const betaMakeCut = backtest.graded.find((row) => row.id === "p5");

  assert.equal(alpha.hit, true);
  assert.equal(alpha.finishPosition, 1);
  near(alpha.profitUnits, 5);
  assert.equal(betaWin.hit, false);
  near(betaWin.profitUnits, -1);
  assert.equal(betaTop10.hit, true);
  near(betaTop10.profitUnits, 100 / 150);
  assert.equal(alphaTop20.hit, true);
  near(alphaTop20.profitUnits, 0.5);
  assert.equal(betaMakeCut.hit, false);
  near(betaMakeCut.profitUnits, -1);
  assert.equal(backtest.summary.settled, 5);
  assert.equal(backtest.summary.hits, 3);
  near(backtest.summary.profitUnits, 4.1666666667, 1e-6);
});

test("buildPredictionSettlementBoard: separates gradeable, settled, and pending events", () => {
  const board = M.buildPredictionSettlementBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    events: [
      { id: "event-1", name: "U.S. Open", startDate: "2026-06-18", courseName: "Oakmont" },
      { id: "event-2", name: "Travelers", startDate: "2026-06-25", courseName: "TPC River Highlands" }
    ],
    rounds: [
      { eventId: "event-1", playerId: "alpha", round: 1, date: "2026-06-18", toPar: -3 },
      { eventId: "event-1", playerId: "alpha", round: 2, date: "2026-06-19", toPar: 0 },
      { eventId: "event-1", playerId: "beta", round: 1, date: "2026-06-18", toPar: 2 },
      { eventId: "event-1", playerId: "beta", round: 2, date: "2026-06-19", toPar: 1 }
    ],
    predictionLedger: [
      { id: "p1", eventId: "event-1", playerId: "alpha", market: "winner", probability: 0.25, edge: 0.03, marketOddsAmerican: 500, createdAt: "2026-06-18T10:00:00Z" },
      { id: "p2", eventId: "event-1", playerId: "beta", market: "winner", probability: 0.2, edge: 0.02, marketOddsAmerican: 400, createdAt: "2026-06-18T10:00:00Z", settled: true, hit: false, profitUnits: -1, result: "miss" },
      { id: "p3", eventId: "event-2", playerId: "gamma", market: "winner", probability: 0.12, edge: 0.04, marketOddsAmerican: 900, createdAt: "2026-06-25T10:00:00Z" }
    ]
  }, { minEdge: 0 });

  const usOpen = board.eventRows.find((row) => row.eventId === "event-1");
  const travelers = board.eventRows.find((row) => row.eventId === "event-2");

  assert.equal(board.summary.events, 2);
  assert.equal(board.summary.predictions, 3);
  assert.equal(board.summary.settled, 2);
  assert.equal(board.summary.gradeable, 1);
  assert.equal(board.summary.alreadySettled, 1);
  assert.equal(board.summary.pending, 1);
  assert.equal(board.summary.readyEvents, 1);
  assert.equal(board.summary.waitingEvents, 1);
  near(board.summary.profitUnits, 4);
  assert.equal(usOpen.status, "ready");
  assert.equal(usOpen.gradeable, 1);
  assert.equal(usOpen.alreadySettled, 1);
  assert.equal(usOpen.resultRounds, 4);
  assert.equal(usOpen.latestResultAt, "2026-06-19");
  assert.ok(usOpen.blockers.some((label) => label.includes("ready to write")));
  assert.equal(travelers.status, "waiting");
  assert.equal(travelers.pending, 1);
  assert.ok(travelers.blockers.includes("Import final round results"));
  assert.equal(board.gradeableRows[0].id, "p1");
  assert.equal(board.pendingRows[0].id, "p3");
});

test("buildModelPerformanceBoard: groups settled prediction results by model dimensions", () => {
  const board = M.buildModelPerformanceBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    rounds: [
      { eventId: "event-1", playerId: "alpha", round: 1, toPar: -3 },
      { eventId: "event-1", playerId: "alpha", round: 2, toPar: 0 },
      { eventId: "event-1", playerId: "beta", round: 1, toPar: 2 },
      { eventId: "event-1", playerId: "beta", round: 2, toPar: 1 },
      { eventId: "event-1", playerId: "gamma", round: 1, toPar: 4 },
      { eventId: "event-1", playerId: "gamma", round: 2, toPar: 4 }
    ],
    predictionLedger: [
      { id: "p1", eventId: "event-1", playerId: "alpha", market: "winner", probability: 0.25, edge: 0.06, marketOddsAmerican: 500, createdAt: "2026-06-18T10:00:00Z", modelProfile: "Major Test", modelWeatherScenario: "wind", modelWeatherLabel: "Wind test", confidence: "high" },
      { id: "p2", eventId: "event-1", playerId: "beta", market: "winner", probability: 0.2, edge: 0.03, marketOddsAmerican: 400, createdAt: "2026-06-18T10:00:00Z", modelProfile: "Major Test", modelWeatherScenario: "wind", modelWeatherLabel: "Wind test", confidence: "medium" },
      { id: "p3", eventId: "event-1", playerId: "beta", market: "top 20", probability: 0.7, edge: 0.015, marketOddsAmerican: -150, createdAt: "2026-06-18T10:00:00Z", modelProfile: "Balanced", modelWeatherScenario: "baseline", modelWeatherLabel: "Live forecast", confidence: "medium" },
      { id: "p4", eventId: "event-1", playerId: "gamma", market: "make cut", probability: 0.48, edge: -0.02, marketOddsAmerican: -110, createdAt: "2026-06-18T10:00:00Z", modelProfile: "Balanced", modelWeatherScenario: "baseline", modelWeatherLabel: "Live forecast", confidence: "thin sample" }
    ]
  }, { minEdge: 0, recentRows: 3 });

  const winner = board.groups.markets.find((group) => group.label === "winner");
  const major = board.groups.profiles.find((group) => group.label === "Major Test");
  const wind = board.groups.weather.find((group) => group.label === "Wind test");
  const highConfidence = board.groups.confidence.find((group) => group.label === "high");
  const fivePlus = board.groups.edgeBuckets.find((group) => group.label === "5+ pp");
  const negative = board.groups.edgeBuckets.find((group) => group.label === "Negative");

  assert.equal(board.summary.total, 4);
  assert.equal(board.summary.settled, 4);
  assert.equal(winner.total, 2);
  assert.equal(major.total, 2);
  assert.equal(wind.total, 2);
  assert.equal(highConfidence.hits, 1);
  assert.equal(fivePlus.total, 1);
  assert.equal(negative.total, 1);
  assert.equal(board.recent.length, 3);
});

test("buildModelTuningBoard: recommends feature weight adjustments from settled results", () => {
  const board = M.buildModelTuningBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    rounds: [
      { eventId: "event-1", playerId: "alpha", round: 1, toPar: -4 },
      { eventId: "event-1", playerId: "alpha", round: 2, toPar: 0 },
      { eventId: "event-1", playerId: "beta", round: 1, toPar: 2 },
      { eventId: "event-1", playerId: "beta", round: 2, toPar: 2 },
      { eventId: "event-1", playerId: "gamma", round: 1, toPar: 5 },
      { eventId: "event-1", playerId: "gamma", round: 2, toPar: 5 }
    ],
    predictionLedger: [
      { id: "p1", eventId: "event-1", playerId: "alpha", market: "winner", probability: 0.25, edge: 0.06, marketOddsAmerican: 500, createdAt: "2026-06-18T10:00:00Z", modelProfile: "Balanced", skill: 2, recentForm: 0, courseFit: 0, difficultyFit: 0, weatherFit: 0 },
      { id: "p2", eventId: "event-1", playerId: "beta", market: "winner", probability: 0.2, edge: 0.03, marketOddsAmerican: 400, createdAt: "2026-06-18T10:01:00Z", modelProfile: "Balanced", skill: -1, recentForm: 0, courseFit: 0, difficultyFit: 0, weatherFit: 0.4 },
      { id: "p3", eventId: "event-1", playerId: "alpha", market: "top 20", probability: 0.8, edge: 0.04, marketOddsAmerican: -150, createdAt: "2026-06-18T10:02:00Z", modelProfile: "Balanced", skill: 1.5, recentForm: 0, courseFit: 0, difficultyFit: 0, weatherFit: 0 },
      { id: "p4", eventId: "event-1", playerId: "gamma", market: "winner", probability: 0.12, edge: 0.02, marketOddsAmerican: 100, createdAt: "2026-06-18T10:03:00Z", modelProfile: "Weather Desk", skill: -1.5, recentForm: 0, courseFit: 0, difficultyFit: 0, weatherFit: 2 }
    ]
  }, {
    minEdge: 0,
    minSamples: 2,
    weights: M.DEFAULT_WEIGHTS
  });

  const skill = board.featureRows.find((row) => row.key === "skill");
  const weather = board.featureRows.find((row) => row.key === "weatherFit");

  assert.equal(board.summary.settled, 4);
  assert.equal(board.summary.bets, 4);
  assert.equal(skill.action, "increase");
  assert.ok(skill.deltaRoi > 3);
  assert.equal(weather.action, "decrease");
  assert.ok(weather.deltaRoi < -3);
  assert.ok(board.alerts.some((alert) => alert.label.includes("Skill")));
});

test("buildPredictionRunAuditBoard: audits modeled, priced, and unresolved tournament markets", () => {
  const board = M.buildPredictionRunAuditBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", courseName: "Oakmont", startDate: "2026-06-18" }
    ],
    fields: [
      { eventId: "us-open-2026", playerId: "alpha", status: "active" },
      { eventId: "us-open-2026", playerId: "beta", status: "active" },
      { eventId: "us-open-2026", playerId: "gamma", status: "active" }
    ],
    oddsSnapshots: [
      { eventId: "us-open-2026", playerId: "alpha", market: "winner", book: "Market A", oddsAmerican: 500, capturedAt: "2026-06-18T09:40:00Z" },
      { eventId: "us-open-2026", playerId: "beta", market: "winner", book: "Market A", oddsAmerican: 650, capturedAt: "2026-06-18T09:45:00Z" },
      { eventId: "us-open-2026", playerId: "alpha", market: "top 20", book: "Market A", oddsAmerican: -120, capturedAt: "2026-06-18T09:50:00Z" }
    ],
    predictionLedger: [
      { id: "p1", eventId: "us-open-2026", playerId: "alpha", market: "winner", probability: 0.23, edge: 0.06, marketOddsAmerican: 500, createdAt: "2026-06-18T10:00:00Z" },
      { id: "p2", eventId: "us-open-2026", playerId: "beta", market: "winner", probability: 0.18, edge: 0.03, marketOddsAmerican: 650, createdAt: "2026-06-18T10:00:00Z" },
      { id: "p3", eventId: "us-open-2026", playerId: "gamma", market: "winner", probability: 0.12, edge: null, createdAt: "2026-06-18T10:00:00Z" },
      { id: "p4", eventId: "us-open-2026", playerId: "alpha", market: "top 20", probability: 0.72, edge: 0.04, marketOddsAmerican: -120, createdAt: "2026-06-18T10:00:00Z" }
    ]
  }, {
    eventId: "us-open-2026",
    market: "all",
    minEdge: 0.02,
    now: "2026-06-18T12:00:00Z"
  });

  const winner = board.marketRows.find((row) => row.key === "winner");
  const top20 = board.marketRows.find((row) => row.key === "top20");

  assert.equal(board.selectedEvent.name, "U.S. Open");
  assert.equal(board.summary.activeFieldCount, 3);
  assert.equal(board.summary.totalPredictions, 4);
  assert.equal(board.summary.modeledFieldPlayers, 3);
  assert.equal(board.summary.fieldCoveragePct, 100);
  assert.equal(board.summary.pricedPredictions, 3);
  assert.equal(board.summary.pricedPct, 75);
  assert.equal(board.summary.thresholdEdges, 3);
  assert.equal(board.summary.unresolved, 4);
  assert.equal(winner.predictedPlayers, 3);
  assert.equal(winner.pricedPredictions, 2);
  assert.equal(winner.modelOnlyCount, 1);
  assert.deepEqual(winner.modelOnlyPlayers, ["Gamma Player"]);
  assert.equal(winner.status, "partial");
  assert.equal(top20.fieldCoveragePct, 33);
  assert.equal(top20.missingPredictionCount, 2);
  assert.equal(top20.status, "partial");
  assert.ok(board.gaps.some((gap) => gap.label === "Winner odds"));
  assert.ok(board.gaps.some((gap) => gap.label === "Top 20 field"));
});

function predictionPrepFixture(overrides = {}) {
  const players = [
    { id: "alpha", name: "Alpha Player", country: "USA", tour: "PGA Tour", owgrRank: 8, sg: 2.2 },
    { id: "beta", name: "Beta Player", country: "USA", tour: "PGA Tour", owgrRank: 24, sg: 1.1 },
    { id: "gamma", name: "Gamma Player", country: "CAN", tour: "PGA Tour", owgrRank: 41, sg: 0.4 }
  ];
  const historyRounds = players.flatMap((player, playerIndex) =>
    Array.from({ length: 12 }, (_, index) => ({
      eventId: `history-${player.id}-${index + 1}`,
      courseId: index % 2 === 0 ? "oakmont" : "winged-foot",
      playerId: player.id,
      round: index + 1,
      date: `2026-05-${String(index + 1).padStart(2, "0")}`,
      sgTotal: player.sg - playerIndex * 0.08 - index * 0.02,
      toPar: playerIndex + Math.floor(index / 4) - 2
    }))
  );
  const strokesGainedRows = players.flatMap((player) =>
    Array.from({ length: 6 }, (_, index) => ({
      playerId: player.id,
      period: `rolling-${index + 1}`,
      sgTotal: player.sg - index * 0.03,
      sgT2g: player.sg * 0.75,
      sgOtt: player.sg * 0.2,
      sgApp: player.sg * 0.35
    }))
  );
  const lab = {
    players: players.map(({ sg, ...player }) => player),
    events: [
      { id: "us-open-2026", name: "U.S. Open", tour: "PGA Tour", courseId: "oakmont", courseName: "Oakmont", startDate: "2026-06-18" }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", par: 70, yards: 7255, fieldAdjustedToPar: 2.4, style: "major test" },
      { id: "winged-foot", name: "Winged Foot", par: 70, yards: 7477, fieldAdjustedToPar: 2.1, style: "major test" }
    ],
    courseSetups: [
      { id: "setup-us-open-2026", eventId: "us-open-2026", courseId: "oakmont", rough: "major", greenSpeed: "fast" }
    ],
    fields: [
      { eventId: "us-open-2026", playerId: "alpha", status: "active" },
      { eventId: "us-open-2026", playerId: "beta", status: "active" },
      { eventId: "us-open-2026", playerId: "gamma", status: "active" }
    ],
    rounds: historyRounds,
    strokesGained: strokesGainedRows,
    weatherSnapshots: [
      { eventId: "us-open-2026", courseId: "oakmont", round: 1, windMph: 18, gustMph: 27, temperatureF: 72 }
    ],
    oddsSnapshots: [
      { eventId: "us-open-2026", playerId: "alpha", market: "winner", book: "Market A", oddsAmerican: 550, capturedAt: "2026-06-18T09:40:00Z" },
      { eventId: "us-open-2026", playerId: "beta", market: "winner", book: "Market A", oddsAmerican: 900, capturedAt: "2026-06-18T09:45:00Z" }
    ],
    predictionLedger: [
      { id: "p1", eventId: "us-open-2026", playerId: "alpha", market: "winner", probability: 0.24, edge: 0.08, marketOddsAmerican: 550, createdAt: "2026-06-18T10:00:00Z" },
      { id: "p2", eventId: "us-open-2026", playerId: "beta", market: "winner", probability: 0.16, edge: 0.06, marketOddsAmerican: 900, createdAt: "2026-06-18T10:00:00Z" },
      { id: "p3", eventId: "us-open-2026", playerId: "gamma", market: "winner", probability: 0.09, edge: null, createdAt: "2026-06-18T10:00:00Z" }
    ],
    sourceFetches: [
      { id: "fetch-us-open-2026-field", provider: "Owned Research", endpoint: "/field/us-open-2026", sourceUrl: "https://example.com/us-open-2026/field", fetchedAt: "2026-06-18T08:00:00Z", status: "ok", rowCount: 3 }
    ]
  };
  return { ...lab, ...overrides };
}

test("buildPredictionPrepBoard: gates a selected tournament prediction slate", () => {
  const board = M.buildPredictionPrepBoard(predictionPrepFixture(), {
    eventId: "us-open-2026",
    market: "winner",
    minEdge: 0.02,
    minFieldSize: 3,
    now: "2026-06-18T12:00:00Z"
  });

  const gateById = Object.fromEntries(board.gates.map((gate) => [gate.id, gate]));

  assert.equal(board.event.name, "U.S. Open");
  assert.equal(board.status, "bet-ready");
  assert.equal(board.summary.fieldCount, 3);
  assert.equal(board.summary.matchedProfiles, 3);
  assert.equal(board.summary.modelReadyPlayers, 3);
  assert.equal(board.summary.totalPredictions, 3);
  assert.equal(board.summary.thresholdEdges, 2);
  assert.equal(gateById.proof.status, "ready");
  assert.equal(gateById.model.score, 100);
  assert.ok(board.score >= 80);
  assert.equal(board.topSignals.topEdge.playerName, "Alpha Player");
  assert.equal(board.runBrief.action, "Review portfolio and line shop");
  assert.equal(board.runBrief.sourceSafe, true);
  assert.equal(board.runBrief.modelProfile, "Owned model");
  assert.equal(board.runBrief.marketFilter, "winner");
  assert.equal(board.runBrief.minEdge, 0.02);
  assert.equal(board.runBrief.counts.field, 3);
  assert.equal(board.runBrief.counts.predictions, 3);
  assert.equal(board.runBrief.counts.pricedPredictions, 2);
  assert.equal(board.runBrief.counts.playableEdges, 2);
  assert.equal(board.runBrief.nextGate.id, "markets");
  assert.equal(board.runAudit.summary.activeFieldCount, 3);
  assert.equal(board.fieldReadiness.summary.players, 3);
});

test("buildPredictionPrepBoard: blocks premium readiness without event source proof", () => {
  const board = M.buildPredictionPrepBoard(predictionPrepFixture({ sourceFetches: [] }), {
    eventId: "us-open-2026",
    market: "winner",
    minEdge: 0.02,
    minFieldSize: 3,
    now: "2026-06-18T12:00:00Z"
  });
  const proofGate = board.gates.find((gate) => gate.id === "proof");

  assert.equal(board.status, "research");
  assert.equal(proofGate.status, "blocked");
  assert.equal(board.summary.criticalBlockers, 1);
  assert.equal(board.nextActions[0].id, "proof");
  assert.equal(board.runBrief.action, "Resolve critical source gates");
  assert.equal(board.runBrief.sourceSafe, false);
  assert.equal(board.runBrief.nextGate.id, "proof");
});

function sourceBackedPredictionFixture(overrides = {}) {
  const base = predictionPrepFixture(overrides);
  const source = { sourceProvider: "Owned Research", sourceUpdatedAt: "2026-06-18T08:00:00Z" };
  return {
    ...base,
    players: base.players.map((row) => ({ ...row, ...source })),
    fields: base.fields.map((row) => ({ ...row, ...source })),
    rounds: base.rounds.map((row) => ({ ...row, ...source })),
    strokesGained: base.strokesGained.map((row) => ({ ...row, ...source })),
    weatherSnapshots: base.weatherSnapshots.map((row) => ({ ...row, ...source })),
    oddsSnapshots: base.oddsSnapshots.map((row) => ({ ...row, ...source })),
    predictionLedger: base.predictionLedger.map((row) => ({ ...row, ...source }))
  };
}

test("buildFeatureStoreAuditBoard: audits selected-event model feature readiness", () => {
  const board = M.buildFeatureStoreAuditBoard(sourceBackedPredictionFixture(), {
    eventId: "us-open-2026",
    market: "winner",
    now: "2026-06-18T12:00:00Z"
  });

  const gates = Object.fromEntries(board.gates.map((gate) => [gate.key, gate]));
  const alpha = board.rows.find((row) => row.playerId === "alpha");

  assert.equal(board.event.name, "U.S. Open");
  assert.equal(board.summary.players, 3);
  assert.equal(board.summary.fieldRows, 3);
  assert.equal(board.summary.modelReadyPlayers, 3);
  assert.equal(board.summary.blockers, 0);
  assert.equal(board.readiness, "premium-ready");
  assert.equal(gates.skill.status, "ready");
  assert.equal(gates.recentForm.status, "ready");
  assert.equal(gates.difficultyFit.status, "ready");
  assert.equal(gates.model.status, "ready");
  assert.equal(gates.source.status, "ready");
  assert.equal(alpha.parts.find((part) => part.key === "skill").status, "ready");
  assert.equal(alpha.parts.find((part) => part.key === "source").status, "ready");
  assert.equal(Number.isFinite(alpha.features.skill), true);
});

test("buildFeatureStoreAuditBoard: blocks trust when model output is missing", () => {
  const board = M.buildFeatureStoreAuditBoard(sourceBackedPredictionFixture({ predictionLedger: [] }), {
    eventId: "us-open-2026",
    market: "winner",
    now: "2026-06-18T12:00:00Z"
  });
  const modelGate = board.gates.find((gate) => gate.key === "model");

  assert.equal(board.readiness, "research");
  assert.equal(modelGate.status, "blocked");
  assert.equal(board.blockers.includes("Model output missing"), true);
  assert.equal(board.rows.every((row) => row.blockers.includes("Model Output")), true);
});

test("buildModelCalibrationBoard: compares expected probability to settled outcomes", () => {
  const board = M.buildModelCalibrationBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    rounds: [
      { eventId: "event-1", playerId: "alpha", round: 1, toPar: -3 },
      { eventId: "event-1", playerId: "alpha", round: 2, toPar: -2 },
      { eventId: "event-1", playerId: "beta", round: 1, toPar: 0 },
      { eventId: "event-1", playerId: "beta", round: 2, toPar: 1 },
      { eventId: "event-1", playerId: "gamma", round: 1, toPar: 3 },
      { eventId: "event-1", playerId: "gamma", round: 2, toPar: 4 }
    ],
    predictionLedger: [
      { id: "p1", eventId: "event-1", playerId: "alpha", market: "winner", probability: 0.3, edge: 0.05, marketOddsAmerican: 400 },
      { id: "p2", eventId: "event-1", playerId: "beta", market: "winner", probability: 0.2, edge: 0.02, marketOddsAmerican: 700 },
      { id: "p3", eventId: "event-1", playerId: "gamma", market: "winner", probability: 0.1, edge: -0.01, marketOddsAmerican: 1200 },
      { id: "p4", eventId: "event-1", playerId: "alpha", market: "top 20", probability: 0.8, edge: 0.04, marketOddsAmerican: -200 },
      { id: "p5", eventId: "event-1", playerId: "beta", market: "top 20", probability: 0.7, edge: 0.03, marketOddsAmerican: -150 },
      { id: "p6", eventId: "event-1", playerId: "gamma", market: "make cut", probability: 0.4, edge: 0.01, marketOddsAmerican: 120 }
    ]
  }, { minEdge: 0, minSamples: 2 });

  const winner = board.marketRows.find((row) => row.key === "winner");
  const top20 = board.marketRows.find((row) => row.key === "top20");
  const lowBucket = board.probabilityBuckets.find((row) => row.key === "p10-p20");
  const highBucket = board.probabilityBuckets.find((row) => row.key === "p80-plus");

  assert.equal(board.summary.totalPredictions, 6);
  assert.equal(board.summary.settled, 6);
  assert.equal(board.summary.pending, 0);
  assert.equal(board.summary.hits, 3);
  near(board.summary.expectedHits, 2.5);
  near(board.summary.avgProbability, 2.5 / 6);
  near(board.summary.hitRate, 0.5);
  assert.equal(board.summary.status, "undercalled");
  assert.ok(board.summary.brierScore > 0);
  assert.equal(winner.total, 3);
  assert.equal(winner.hits, 1);
  assert.equal(top20.hits, 2);
  assert.equal(lowBucket.total, 1);
  assert.equal(highBucket.total, 1);
  assert.ok(board.edgeBuckets.some((row) => row.key === "edge-2-5"));
  assert.ok(board.alerts.some((alert) => alert.label === "Calibration drift"));
});

test("buildPredictionEdgeBoard: ranks playable positive edges with conservative unit sizing", () => {
  const board = M.buildPredictionEdgeBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    events: [
      { id: "event-1", name: "Test Open" }
    ],
    predictionLedger: [
      { id: "p1", eventId: "event-1", playerId: "alpha", market: "winner", probability: 0.24, edge: 0.04, marketOddsAmerican: 500, score: 1.2, rank: 1, confidence: "high" },
      { id: "p2", eventId: "event-1", playerId: "beta", market: "top 20", probability: 0.7, edge: 0.03, marketOddsAmerican: -110, score: 0.6, rank: 2, confidence: "medium" },
      { id: "p3", eventId: "event-1", playerId: "beta", market: "make cut", probability: 0.54, edge: -0.02, marketOddsAmerican: -150, score: 0.4, rank: 2, confidence: "medium" },
      { id: "p4", eventId: "event-1", playerId: "alpha", market: "top 10", probability: 0.52, edge: 0.005, marketOddsAmerican: 120, score: 1.2, rank: 1, confidence: "thin sample" }
    ]
  }, { minEdge: 0.01, maxRows: 5 });

  assert.equal(board.candidates.length, 4);
  assert.equal(board.playable.length, 2);
  assert.equal(board.playable[0].playerName, "Alpha Player");
  assert.equal(board.playable[0].eventName, "Test Open");
  assert.equal(board.playable[0].market, "winner");
  assert.ok(board.playable[0].stakeUnits > 0);
  assert.equal(board.summary.markets.winner, 1);
  assert.equal(board.summary.markets["top 20"], 1);
  assert.ok(board.summary.totalStakeUnits > 0);
  assert.ok(board.summary.avgEdge > 0.02);
});

test("buildPredictionEdgeBoard: filters to the selected market", () => {
  const board = M.buildPredictionEdgeBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    events: [
      { id: "event-1", name: "Test Open" }
    ],
    predictionLedger: [
      { id: "p1", eventId: "event-1", playerId: "alpha", market: "winner", probability: 0.24, edge: 0.04, marketOddsAmerican: 500, score: 1.2, rank: 1, confidence: "high" },
      { id: "p2", eventId: "event-1", playerId: "beta", market: "top 20", probability: 0.7, edge: 0.03, marketOddsAmerican: -110, score: 0.6, rank: 2, confidence: "medium" }
    ]
  }, { minEdge: 0.01, market: "top20" });

  assert.equal(board.candidates.length, 1);
  assert.equal(board.playable.length, 1);
  assert.equal(board.playable[0].market, "top 20");
  assert.equal(board.summary.marketFilter, "top20");
});

test("buildBetPortfolioBoard: converts playable edges into capped unit exposure", () => {
  const board = M.buildBetPortfolioBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    events: [
      { id: "event-1", name: "Test Open" }
    ],
    predictionLedger: [
      { id: "p1", eventId: "event-1", playerId: "alpha", market: "winner", probability: 0.3, edge: 0.08, marketOddsAmerican: 400, score: 1.5, rank: 1, confidence: "high" },
      { id: "p2", eventId: "event-1", playerId: "beta", market: "top 20", probability: 0.7, edge: 0.05, marketOddsAmerican: -110, score: 1.0, rank: 2, confidence: "high" },
      { id: "p3", eventId: "event-1", playerId: "alpha", market: "top 10", probability: 0.55, edge: 0.04, marketOddsAmerican: 150, score: 0.9, rank: 1, confidence: "high" }
    ]
  }, {
    minEdge: 0.01,
    maxRows: 5,
    maxTotalUnits: 3,
    maxPlayerUnits: 2.5,
    maxMarketUnits: 4,
    maxEventUnits: 3,
    minStakeUnits: 0.25
  });

  assert.equal(board.summary.candidates, 3);
  assert.equal(board.summary.playable, 3);
  assert.equal(board.summary.included, 2);
  assert.equal(board.summary.trimmed, 1);
  assert.equal(board.summary.capped, 1);
  near(board.summary.totalStakeUnits, 3);
  assert.equal(board.rows[0].status, "included");
  assert.equal(board.rows[1].status, "trimmed");
  assert.equal(board.rows[2].status, "capped");
  assert.ok(board.summary.expectedProfitUnits > 0);
  assert.ok(board.groups.markets.length >= 2);
  assert.ok(board.warnings.some((warning) => warning.label === "Risk caps"));
});

test("buildPredictionExplainerBoard: explains model predictions with weighted feature contributions", () => {
  const board = M.buildPredictionExplainerBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    events: [
      { id: "event-1", name: "Test Open", startDate: "2026-06-18" }
    ],
    predictionLedger: [
      {
        id: "p1",
        eventId: "event-1",
        playerId: "alpha",
        market: "winner",
        probability: 0.24,
        edge: 0.045,
        marketOddsAmerican: 500,
        fairOddsAmerican: 317,
        rank: 1,
        confidence: "high",
        skill: 1.4,
        recentForm: 0.8,
        courseFit: 0.5,
        difficultyFit: 0.7,
        weatherFit: -0.2,
        sampleRounds: 24,
        modelProfile: "Major Test",
        modelWeatherLabel: "Wind test"
      },
      {
        id: "p2",
        eventId: "event-1",
        playerId: "beta",
        market: "winner",
        probability: 0.18,
        edge: 0.01,
        marketOddsAmerican: 600,
        fairOddsAmerican: 456,
        rank: 2,
        confidence: "medium",
        skill: 0.4,
        recentForm: 0.1,
        courseFit: -0.2,
        difficultyFit: 0.1,
        weatherFit: 0.3,
        sampleRounds: 12
      },
      {
        id: "p3",
        eventId: "event-1",
        playerId: "gamma",
        market: "top 20",
        probability: 0.64,
        rank: 3,
        confidence: "thin sample",
        skill: 0.3,
        recentForm: 0.5,
        courseFit: 0.1,
        difficultyFit: 0.1,
        weatherFit: 0.1,
        sampleRounds: 3
      }
    ]
  }, {
    market: "winner",
    minEdge: 0.02,
    weights: { skill: 0.5, recentForm: 0.2, courseFit: 0.1, difficultyFit: 0.1, weatherFit: 0.1 }
  });

  assert.equal(board.rows.length, 2);
  assert.equal(board.summary.predictions, 2);
  assert.equal(board.summary.priced, 2);
  assert.equal(board.summary.plays, 1);
  assert.equal(board.summary.leans, 1);
  assert.equal(board.summary.highConfidence, 1);
  assert.equal(board.summary.topPlay.playerName, "Alpha Player");
  assert.equal(board.rows[0].verdict, "play");
  assert.equal(board.rows[0].strengths[0].label, "Skill");
  near(board.rows[0].strengths[0].contribution, 0.7);
  assert.equal(board.rows[0].concerns[0].label, "Weather");
  assert.ok(board.rows[0].expectedUnitReturn > 0);
  assert.equal(board.rows[1].verdict, "lean");
  assert.equal(board.allRows.some((row) => row.market === "top 20"), false);
});

test("buildEventFitBoard: ranks event fits before market odds exist", () => {
  const board = M.buildEventFitBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    events: [
      {
        id: "us-open-2026",
        name: "U.S. Open",
        startDate: "2026-06-19",
        courseId: "oakmont",
        courseName: "Oakmont"
      }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", fieldAdjustedToPar: 2.3 }
    ],
    fields: [
      { eventId: "us-open-2026", playerId: "alpha", status: "active" },
      { eventId: "us-open-2026", playerId: "beta", status: "active" }
    ],
    rounds: [
      { playerId: "alpha", eventId: "hard-open", courseId: "oakmont", round: 1, date: "2026-05-18", sgTotal: 2.4 },
      { playerId: "alpha", eventId: "hard-open", courseId: "oakmont", round: 2, date: "2026-05-19", sgTotal: 1.8 },
      { playerId: "beta", eventId: "hard-open", courseId: "oakmont", round: 1, date: "2026-05-18", sgTotal: -0.4 }
    ],
    strokesGained: [
      { playerId: "alpha", sgTotal: 2.0, sgT2g: 1.8, sgOtt: 0.6, sgApp: 0.9 },
      { playerId: "beta", sgTotal: 0.1, sgT2g: 0.2, sgOtt: 0.1, sgApp: 0.1 }
    ],
    weatherSnapshots: [
      { eventId: "us-open-2026", courseId: "oakmont", windMph: 20, gustMph: 29 },
      { eventId: "hard-open", courseId: "oakmont", round: 1, windMph: 19, gustMph: 28 }
    ]
  }, {
    eventId: "us-open-2026",
    modelProfile: "Major Test",
    weights: { skill: 0.35, recentForm: 0.15, courseFit: 0.2, difficultyFit: 0.2, weatherFit: 0.1 }
  });

  assert.equal(board.event.name, "U.S. Open");
  assert.equal(board.course.name, "Oakmont");
  assert.equal(board.modelProfile, "Major Test");
  assert.equal(board.weatherScenario.key, "baseline");
  assert.equal(board.rows.length, 2);
  assert.equal(board.rows[0].playerName, "Alpha Player");
  assert.equal(board.rows[0].rank, 1);
  assert.ok(board.rows[0].strengths.length >= 1);
  assert.ok(Number.isFinite(board.rows[0].winProbability));
  assert.equal(board.summary.players, 2);
  assert.equal(board.summary.topFit.playerId, "alpha");
});

test("buildFieldIntelligenceBoard: summarizes full-field fit, pricing, and specialists", () => {
  const board = M.buildFieldIntelligenceBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-19", courseId: "oakmont", courseName: "Oakmont" }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", fieldAdjustedToPar: 2.3 }
    ],
    fields: [
      { eventId: "us-open-2026", playerId: "alpha", status: "active" },
      { eventId: "us-open-2026", playerId: "beta", status: "active" },
      { eventId: "us-open-2026", playerId: "gamma", status: "active" }
    ],
    rounds: [
      { playerId: "alpha", eventId: "hard-open", courseId: "oakmont", round: 1, date: "2026-05-18", sgTotal: 2.4 },
      { playerId: "alpha", eventId: "hard-open", courseId: "oakmont", round: 2, date: "2026-05-19", sgTotal: 2.0 },
      { playerId: "beta", eventId: "wind-open", courseId: "oakmont", round: 1, date: "2026-05-18", sgTotal: 1.1 },
      { playerId: "gamma", eventId: "soft-open", courseId: "oakmont", round: 1, date: "2026-05-18", sgTotal: -0.4 }
    ],
    strokesGained: [
      { playerId: "alpha", sgTotal: 2.0, sgT2g: 1.8, sgOtt: 0.6, sgApp: 0.9 },
      { playerId: "beta", sgTotal: 0.7, sgT2g: 0.8, sgOtt: 0.2, sgApp: 0.4 },
      { playerId: "gamma", sgTotal: -0.1, sgT2g: 0.0, sgOtt: 0.0, sgApp: 0.0 }
    ],
    weatherSnapshots: [
      { eventId: "us-open-2026", courseId: "oakmont", windMph: 20, gustMph: 29 },
      { eventId: "wind-open", courseId: "oakmont", round: 1, windMph: 22, gustMph: 31 }
    ],
    oddsSnapshots: [
      { eventId: "us-open-2026", playerId: "alpha", market: "top 20", oddsAmerican: 180 },
      { eventId: "us-open-2026", playerId: "beta", market: "top 20", oddsAmerican: -110 }
    ]
  }, {
    eventId: "us-open-2026",
    market: "top 20",
    modelProfile: "Major Test",
    weights: { skill: 0.35, recentForm: 0.15, courseFit: 0.2, difficultyFit: 0.2, weatherFit: 0.1 },
    minEdge: 0.01
  });

  assert.equal(board.event.name, "U.S. Open");
  assert.equal(board.market, "top 20");
  assert.equal(board.rows.length, 3);
  assert.equal(board.rows[0].playerId, "alpha");
  assert.equal(board.summary.players, 3);
  assert.equal(board.summary.priced, 2);
  assert.ok(board.summary.positiveEdges >= 1);
  assert.equal(board.specialists.course.playerId, "alpha");
  assert.ok(["edge", "lean", "pass"].includes(board.rows[0].priceStatus));
  assert.ok(Number.isFinite(board.rows[0].features.courseFit));
});

test("buildWeatherScenarioBoard: compares event fits across weather scenarios", () => {
  const board = M.buildWeatherScenarioBoard({
    players: [
      { id: "steady", name: "Steady Player" },
      { id: "wind", name: "Wind Player" },
      { id: "rain", name: "Rain Player" }
    ],
    events: [
      { id: "event-1", name: "Scenario Open", startDate: "2026-06-19", courseId: "course-1", courseName: "Scenario Club" }
    ],
    courses: [
      { id: "course-1", name: "Scenario Club", fieldAdjustedToPar: 1.4 }
    ],
    fields: [
      { eventId: "event-1", playerId: "steady" },
      { eventId: "event-1", playerId: "wind" },
      { eventId: "event-1", playerId: "rain" }
    ],
    rounds: [
      { eventId: "baseline-1", playerId: "steady", courseId: "course-1", round: 1, sgTotal: 1.2 },
      { eventId: "wind-1", playerId: "wind", courseId: "course-1", round: 1, sgTotal: 3.2 },
      { eventId: "rain-1", playerId: "rain", courseId: "course-1", round: 1, sgTotal: 3.4 }
    ],
    strokesGained: [
      { playerId: "steady", sgTotal: 1.4, sgT2g: 1.2, sgOtt: 0.4, sgApp: 0.4 },
      { playerId: "wind", sgTotal: 0.2, sgT2g: 0.2, sgOtt: 0.1, sgApp: 0.1 },
      { playerId: "rain", sgTotal: 0.2, sgT2g: 0.2, sgOtt: 0.1, sgApp: 0.1 }
    ],
    weatherSnapshots: [
      { eventId: "baseline-1", courseId: "course-1", round: 1, windMph: 8, temperatureF: 72 },
      { eventId: "wind-1", courseId: "course-1", round: 1, windMph: 22, gustMph: 32 },
      { eventId: "rain-1", courseId: "course-1", round: 1, windMph: 8, precipitationIn: 0.18 }
    ]
  }, {
    eventId: "event-1",
    weatherScenarios: ["baseline", "wind", "rain"],
    weights: { skill: 0.25, recentForm: 0, courseFit: 0, difficultyFit: 0, weatherFit: 0.75 },
    maxRows: 3
  });

  const windScenario = board.scenarios.find((scenario) => scenario.key === "wind");
  const rainScenario = board.scenarios.find((scenario) => scenario.key === "rain");

  assert.equal(board.event.name, "Scenario Open");
  assert.equal(board.scenarios.length, 3);
  assert.equal(windScenario.topFit.playerId, "wind");
  assert.equal(rainScenario.topFit.playerId, "rain");
  assert.ok(board.movers.some((row) => row.playerId === "wind" && row.rankChange > 0));
  assert.ok(board.summary.topMover);
});

test("buildModelConsensusBoard: compares player ranks across model profiles", () => {
  const board = M.buildModelConsensusBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    events: [
      { id: "event-1", name: "Consensus Open", startDate: "2026-06-19", courseId: "course-1", courseName: "Oakmont" }
    ],
    courses: [
      { id: "course-1", name: "Oakmont", fieldAdjustedToPar: 2.4 }
    ],
    fields: [
      { eventId: "event-1", playerId: "alpha" },
      { eventId: "event-1", playerId: "beta" },
      { eventId: "event-1", playerId: "gamma" }
    ],
    rounds: [
      { eventId: "alpha-wind", playerId: "alpha", courseId: "course-1", round: 1, date: "2026-05-20", sgTotal: 3.0 },
      { eventId: "alpha-wind", playerId: "alpha", courseId: "course-1", round: 2, date: "2026-05-21", sgTotal: 2.6 },
      { eventId: "beta-wind", playerId: "beta", courseId: "course-1", round: 1, date: "2026-05-20", sgTotal: 1.0 },
      { eventId: "gamma-soft", playerId: "gamma", courseId: "course-1", round: 1, date: "2026-05-20", sgTotal: -0.8 }
    ],
    strokesGained: [
      { playerId: "alpha", sgTotal: 2.1, sgT2g: 2.0, sgOtt: 0.7, sgApp: 0.9 },
      { playerId: "beta", sgTotal: 0.8, sgT2g: 0.7, sgOtt: 0.2, sgApp: 0.4 },
      { playerId: "gamma", sgTotal: -0.2, sgT2g: -0.1, sgOtt: 0, sgApp: -0.1 }
    ],
    weatherSnapshots: [
      { eventId: "event-1", courseId: "course-1", windMph: 20, gustMph: 31 },
      { eventId: "alpha-wind", courseId: "course-1", round: 1, windMph: 21, gustMph: 32 },
      { eventId: "alpha-wind", courseId: "course-1", round: 2, windMph: 19, gustMph: 30 },
      { eventId: "beta-wind", courseId: "course-1", round: 1, windMph: 20, gustMph: 30 }
    ],
    oddsSnapshots: [
      { eventId: "event-1", playerId: "alpha", market: "winner", oddsAmerican: 450 },
      { eventId: "event-1", playerId: "beta", market: "winner", oddsAmerican: 900 }
    ]
  }, {
    eventId: "event-1",
    market: "winner",
    weatherScenario: "baseline",
    contenderCutoff: 1,
    profiles: [
      { key: "skill", label: "Skill Lens", weights: { skill: 1, recentForm: 0, courseFit: 0, difficultyFit: 0, weatherFit: 0 } },
      { key: "course", label: "Course Lens", weights: { skill: 0, recentForm: 0, courseFit: 1, difficultyFit: 0, weatherFit: 0 } },
      { key: "weather", label: "Weather Lens", weights: { skill: 0, recentForm: 0, courseFit: 0, difficultyFit: 0, weatherFit: 1 } }
    ],
    maxRows: 5
  });

  const alpha = board.allRows.find((row) => row.playerId === "alpha");

  assert.equal(board.event.name, "Consensus Open");
  assert.equal(board.profiles.length, 3);
  assert.equal(board.summary.players, 3);
  assert.equal(board.summary.consensusCores, 1);
  assert.equal(board.rows[0].playerId, "alpha");
  assert.equal(alpha.profileRows.length, 3);
  assert.equal(alpha.contenderProfiles, 3);
  assert.equal(alpha.consensusPct, 1);
  assert.equal(alpha.verdict, "core");
  assert.ok(alpha.profileRows.every((row) => row.rank === 1));
  assert.ok(alpha.pricedProfiles > 0);
});

test("buildFeatureSensitivityBoard: measures rank damage when model features are removed", () => {
  const board = M.buildFeatureSensitivityBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    events: [
      { id: "event-1", name: "Sensitivity Open", startDate: "2026-06-19", courseId: "course-1", courseName: "Oakmont" }
    ],
    courses: [
      { id: "course-1", name: "Oakmont", fieldAdjustedToPar: 2.4 }
    ],
    fields: [
      { eventId: "event-1", playerId: "alpha" },
      { eventId: "event-1", playerId: "beta" },
      { eventId: "event-1", playerId: "gamma" }
    ],
    rounds: [
      { eventId: "alpha-wind", playerId: "alpha", courseId: "course-1", round: 1, date: "2026-05-20", sgTotal: 3.0 },
      { eventId: "alpha-wind", playerId: "alpha", courseId: "course-1", round: 2, date: "2026-05-21", sgTotal: 2.6 },
      { eventId: "beta-wind", playerId: "beta", courseId: "course-1", round: 1, date: "2026-05-20", sgTotal: 1.0 },
      { eventId: "gamma-soft", playerId: "gamma", courseId: "course-1", round: 1, date: "2026-05-20", sgTotal: -0.8 }
    ],
    strokesGained: [
      { playerId: "alpha", sgTotal: 2.1, sgT2g: 2.0, sgOtt: 0.7, sgApp: 0.9 },
      { playerId: "beta", sgTotal: 0.8, sgT2g: 0.7, sgOtt: 0.2, sgApp: 0.4 },
      { playerId: "gamma", sgTotal: -0.2, sgT2g: -0.1, sgOtt: 0, sgApp: -0.1 }
    ],
    weatherSnapshots: [
      { eventId: "event-1", courseId: "course-1", windMph: 20, gustMph: 31 },
      { eventId: "alpha-wind", courseId: "course-1", round: 1, windMph: 21, gustMph: 32 },
      { eventId: "alpha-wind", courseId: "course-1", round: 2, windMph: 19, gustMph: 30 },
      { eventId: "beta-wind", courseId: "course-1", round: 1, windMph: 20, gustMph: 30 }
    ],
    oddsSnapshots: [
      { eventId: "event-1", playerId: "alpha", market: "winner", oddsAmerican: 450 }
    ]
  }, {
    eventId: "event-1",
    market: "winner",
    weights: { skill: 0.4, recentForm: 0.15, courseFit: 0.2, difficultyFit: 0.15, weatherFit: 0.1 },
    maxRows: 5
  });

  const alpha = board.allRows.find((row) => row.playerId === "alpha");

  assert.equal(board.event.name, "Sensitivity Open");
  assert.equal(board.summary.players, 3);
  assert.equal(board.summary.dimensions, 5);
  assert.equal(board.rows.length, 3);
  assert.equal(alpha.sensitivityRows.length, 5);
  assert.ok(alpha.sensitivityRows.some((row) => row.label === "Course"));
  assert.ok(alpha.strongestDependency);
  assert.ok(Number.isFinite(alpha.maxRankLoss));
  assert.ok(["robust", "balanced", "dependent", "fragile"].includes(alpha.verdict));
  assert.ok(board.summary.topDependency);
});
