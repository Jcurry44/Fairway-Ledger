/*
 * Unit tests for lib/golf-lab.js - pro-golf data contracts and scorecards.
 *
 * Run:  node --test tests/golf-lab.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../lib/golf-lab.js");

function near(actual, expected, eps = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`
  );
}

test("normalizeGolfLabState: fills collections and normalizes source-backed records", () => {
  const lab = G.normalizeGolfLabState({
    players: [{
      name: "Scottie Scheffler",
      dataGolfId: "dg-1",
      owgrRank: "1",
      provider: "PGA Tour",
      url: "https://example.com/scottie"
    }],
    rounds: [{
      eventId: "masters-2026",
      playerId: "dg-1",
      round: "1",
      date: "2026-04-09",
      courseName: "Augusta National",
      toPar: "-2"
    }],
    strokesGained: [{
      playerId: "dg-1",
      name: "Scottie Scheffler",
      period: "last-24",
      sg_ott: "0.7",
      accuracy: "0.66"
    }],
    predictionLedger: [{
      eventId: "masters-2026",
      playerId: "dg-1",
      market: "winner",
      probability: "0.12",
      modelProfile: "Weather Desk",
      modelWeatherScenario: "wind",
      modelWeatherLabel: "Wind test",
      settled: "true",
      hit: "false",
      finishPosition: "12",
      finishToPar: "1",
      profitUnits: "-1"
    }],
    weatherSnapshots: [{
      eventId: "masters-2026",
      courseName: "Augusta National",
      round: "1",
      date: "2026-04-09",
      tempF: "78",
      windSpeedMph: "16",
      windGustMph: "24",
      precipitationIn: "0.03",
      provider: "NOAA"
    }],
    equipmentSnapshots: [{
      playerId: "dg-1",
      date: "2026-04-01",
      driver: "TaylorMade Qi10",
      sourceUrl: "https://example.com/witb"
    }]
  });

  assert.equal(lab.schemaVersion, G.GOLF_LAB_SCHEMA_VERSION);
  G.COLLECTION_KEYS.forEach((key) => assert.ok(Array.isArray(lab[key]), `${key} should be an array`));
  assert.equal(lab.players[0].id, "dg-1");
  assert.equal(lab.players[0].sourceProvider, "PGA Tour");
  assert.equal(lab.rounds[0].id, "masters-2026-dg-1-1-2026-04-09-augusta-national");
  assert.equal(lab.rounds[0].roundNumber, 1);
  near(lab.rounds[0].toPar, -2);
  near(lab.strokesGained[0].sgOtt, 0.7);
  near(lab.strokesGained[0].accuracy, 0.66);
  assert.equal(lab.predictionLedger[0].settled, true);
  assert.equal(lab.predictionLedger[0].modelProfile, "Weather Desk");
  assert.equal(lab.predictionLedger[0].modelWeatherScenario, "wind");
  assert.equal(lab.predictionLedger[0].modelWeatherLabel, "Wind test");
  assert.equal(lab.predictionLedger[0].hit, false);
  assert.equal(lab.predictionLedger[0].finishPosition, 12);
  near(lab.predictionLedger[0].profitUnits, -1);
  assert.equal(lab.weatherSnapshots[0].roundNumber, 1);
  near(lab.weatherSnapshots[0].temperatureF, 78);
  near(lab.weatherSnapshots[0].windMph, 16);
  assert.equal(lab.weatherSnapshots[0].sourceProvider, "NOAA");
  assert.equal(lab.equipmentSnapshots[0].capturedDate, "2026-04-01");
});

test("eventCoursePoolSummary: normalizes and summarizes multi-course event pools", () => {
  const lab = G.normalizeGolfLabState({
    events: [{ id: "pebble-2026", name: "Pebble Pro-Am" }],
    courses: [
      { id: "pebble", name: "Pebble Beach Golf Links", par: 72, yards: 6816, location: "Pebble Beach, CA" },
      { id: "spyglass", name: "Spyglass Hill Golf Course", par: 72, yards: 7026, location: "Pebble Beach, CA" }
    ],
    eventCourses: [
      { eventId: "pebble-2026", courseId: "spyglass", courseName: "Spyglass Hill Golf Course", location: "Pebble Beach, CA", courseOrder: "2", confidence: "verified", sourceProvider: "Pool" },
      { eventId: "pebble-2026", courseId: "pebble", courseName: "Pebble Beach Golf Links", location: "Pebble Beach, CA", courseOrder: "1", confidence: "verified", sourceProvider: "Pool" }
    ]
  });

  const pool = G.eventCoursePoolSummary(lab, lab.events[0]);

  assert.equal(pool.courseCount, 2);
  assert.equal(pool.label, "Pebble Beach Golf Links / Spyglass Hill Golf Course");
  assert.deepEqual(pool.parRange, [72, 72]);
  assert.equal(pool.confidence, "verified");
  assert.equal(pool.courses[0].location, "Pebble Beach, CA");
});

test("classifyCourseDifficulty: labels pro setup difficulty with fallbacks", () => {
  assert.equal(G.classifyCourseDifficulty({ fieldAdjustedToPar: -1.4 }).bucket, "Easy");
  assert.equal(G.classifyCourseDifficulty({ fieldAdjustedToPar: 0.4 }).bucket, "Neutral");
  assert.equal(G.classifyCourseDifficulty({ fieldAdjustedToPar: 1.1 }).bucket, "Tough");
  assert.equal(G.classifyCourseDifficulty({ fieldAdjustedToPar: 3 }).bucket, "Brutal");

  const rated = G.classifyCourseDifficulty({ par: 72, rating: 75, slope: 145 });
  assert.equal(rated.bucket, "Brutal");
  assert.equal(rated.basis, "rating and slope");

  assert.deepEqual(
    G.classifyCourseDifficulty({ name: "Unknown Municipal" }),
    { bucket: "Unknown", score: null, basis: "insufficient data" }
  );
});

test("summarizeGolfLabState: reports readiness and lane counts", () => {
  const blank = G.summarizeGolfLabState(G.blankGolfLabState());
  assert.equal(blank.readiness, "setup");
  assert.equal(blank.hasData, false);

  const partial = G.summarizeGolfLabState({ players: [{ name: "Rory McIlroy" }] });
  assert.equal(partial.readiness, "partial");
  assert.equal(partial.counts.players, 1);

  const ready = G.summarizeGolfLabState({
    players: [{ name: "Rory McIlroy" }],
    events: [{ name: "U.S. Open", startDate: "2026-06-18" }],
    rounds: [{ playerName: "Rory McIlroy", round: 1, toPar: 0 }],
    predictionLedger: [{ playerId: "rory-mcilroy", market: "winner", probability: 0.08 }],
    sourceFetches: [{ provider: "PGA Tour", fetchedAt: "2026-06-18T09:00:00Z" }]
  });

  assert.equal(ready.readiness, "analysis-ready");
  assert.equal(ready.latestFetch, "2026-06-18T09:00:00Z");
  assert.equal(ready.lanes.find((lane) => lane.id === "prediction-ledger").count, 1);
});

test("mergeGolfLabStates: upserts by id without wiping other collections", () => {
  const merged = G.mergeGolfLabStates(
    {
      players: [{ id: "dg-1", name: "Old Name", country: "USA" }],
      equipmentSnapshots: [{ id: "bag-1", playerId: "dg-1", driver: "Old Driver" }]
    },
    {
      players: [{ id: "dg-1", name: "Scottie Scheffler", owgrRank: 1 }],
      rounds: [{ id: "round-1", playerId: "dg-1", eventId: "masters", round: 1, toPar: -2 }]
    }
  );

  assert.equal(merged.players.length, 1);
  assert.equal(merged.players[0].name, "Scottie Scheffler");
  assert.equal(merged.players[0].country, "USA");
  assert.equal(merged.players[0].owgrRank, 1);
  assert.equal(merged.equipmentSnapshots[0].driver, "Old Driver");
  assert.equal(merged.rounds[0].id, "round-1");
});

test("buildEventDossier: rolls up tournament readiness and model context", () => {
  const fields = Array.from({ length: 20 }, (_, index) => ({
    eventId: "us-open-2026",
    playerId: index % 2 === 0 ? "alpha" : "beta",
    status: "active"
  }));
  const rounds = Array.from({ length: 12 }, (_, index) => ({
    eventId: "us-open-2026",
    playerId: index % 2 === 0 ? "alpha" : "beta",
    courseId: "oakmont",
    round: (index % 4) + 1,
    sgTotal: index % 2 === 0 ? 1.2 : -0.3,
    toPar: index % 2 === 0 ? -1 : 2
  }));
  const dossier = G.buildEventDossier({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    events: [{ id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-19", courseId: "oakmont", courseName: "Oakmont" }],
    courses: [{ id: "oakmont", name: "Oakmont", fieldAdjustedToPar: 2.5 }],
    fields,
    rounds,
    weatherSnapshots: [{ eventId: "us-open-2026", courseId: "oakmont", windMph: 19, gustMph: 27 }],
    oddsSnapshots: [{ eventId: "us-open-2026", playerId: "alpha", market: "winner", oddsAmerican: 600 }],
    modelPredictions: [{ eventId: "us-open-2026", playerId: "alpha", market: "winner", probability: 0.18, rank: 1, fairOddsAmerican: 456, edge: 0.04 }]
  }, "us-open-2026");

  assert.equal(dossier.event.name, "U.S. Open");
  assert.equal(dossier.course.name, "Oakmont");
  assert.equal(dossier.readinessScore, 100);
  assert.equal(dossier.readiness, "prediction-ready");
  assert.equal(dossier.counts.field, 20);
  assert.equal(dossier.counts.matchedFields, 20);
  assert.equal(dossier.weather.label, "High wind");
  assert.equal(dossier.winnerPredictions[0].playerName, "Alpha Player");
  assert.deepEqual(dossier.blockers, []);
});

test("buildPlayerSplitLeaderboards: ranks tough, easy, and weather specialists", () => {
  const leaders = G.buildPlayerSplitLeaderboards({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", fieldAdjustedToPar: 2.4 },
      { id: "kapalua", name: "Kapalua", fieldAdjustedToPar: -1.4 }
    ],
    rounds: [
      { eventId: "hard-open", playerId: "alpha", courseId: "oakmont", round: 1, sgTotal: 2.1, toPar: -1 },
      { eventId: "hard-open", playerId: "beta", courseId: "oakmont", round: 1, sgTotal: 0.1, toPar: 2 },
      { eventId: "birdie-fest", playerId: "alpha", courseId: "kapalua", round: 1, sgTotal: 0.5, toPar: -3 },
      { eventId: "birdie-fest", playerId: "beta", courseId: "kapalua", round: 1, sgTotal: 2.4, toPar: -7 }
    ],
    weatherSnapshots: [
      { eventId: "hard-open", courseId: "oakmont", round: 1, windMph: 21, gustMph: 30, temperatureF: 64 },
      { eventId: "birdie-fest", courseId: "kapalua", round: 1, windMph: 5, temperatureF: 82 }
    ]
  });

  assert.equal(leaders.toughCourseLeaders[0].playerName, "Alpha Player");
  assert.equal(leaders.easyCourseLeaders[0].playerName, "Beta Player");
  assert.equal(leaders.windLeaders[0].playerName, "Alpha Player");
  assert.equal(leaders.calmLeaders[0].playerName, "Beta Player");
});

test("buildWeatherMatrixBoard: ranks selected-field players for event weather", () => {
  const board = G.buildWeatherMatrixBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-18", courseId: "oakmont", courseName: "Oakmont" },
      { id: "wind-open", name: "Wind Open", startDate: "2025-07-01", courseId: "oakmont", courseName: "Oakmont" },
      { id: "calm-open", name: "Calm Open", startDate: "2025-08-01", courseId: "harbor", courseName: "Harbor Links" }
    ],
    fields: [
      { eventId: "us-open-2026", playerId: "alpha" },
      { eventId: "us-open-2026", playerId: "beta" },
      { eventId: "us-open-2026", playerId: "gamma" }
    ],
    rounds: [
      { playerId: "alpha", eventId: "wind-open", courseId: "oakmont", round: 1, sgTotal: 2.2, toPar: -2 },
      { playerId: "alpha", eventId: "calm-open", courseId: "harbor", round: 1, sgTotal: 0.5, toPar: -1 },
      { playerId: "beta", eventId: "wind-open", courseId: "oakmont", round: 1, sgTotal: -0.4, toPar: 3 },
      { playerId: "gamma", eventId: "calm-open", courseId: "harbor", round: 1, sgTotal: 1.8, toPar: -4 }
    ],
    weatherSnapshots: [
      { eventId: "us-open-2026", courseId: "oakmont", windMph: 21, gustMph: 30, temperatureF: 68 },
      { eventId: "wind-open", courseId: "oakmont", round: 1, windMph: 22, gustMph: 31, temperatureF: 66 },
      { eventId: "calm-open", courseId: "harbor", round: 1, windMph: 5, gustMph: 8, temperatureF: 79 }
    ]
  }, {
    eventId: "us-open-2026",
    limit: 5
  });

  assert.equal(board.event.name, "U.S. Open");
  assert.equal(board.target.bucket, "Wind");
  assert.equal(board.summary.players, 3);
  assert.equal(board.summary.playersWithWeatherHistory, 2);
  assert.equal(board.summary.weatherRounds, 2);
  assert.equal(board.rows[0].playerName, "Alpha Player");
  assert.equal(board.rows[0].weatherRounds, 1);
  assert.equal(board.rows[0].tags.includes("Weather riser"), true);
  near(board.rows[0].avgSg, 2.2);
});

test("buildTeeTimeWaveBoard: compares tee-time weather draw by wave", () => {
  const board = G.buildTeeTimeWaveBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-18", courseId: "oakmont", courseName: "Oakmont" },
      { id: "wind-open", name: "Wind Open", startDate: "2025-07-01", courseId: "oakmont", courseName: "Oakmont" },
      { id: "calm-open", name: "Calm Open", startDate: "2025-08-01", courseId: "harbor", courseName: "Harbor Links" }
    ],
    fields: [
      { eventId: "us-open-2026", playerId: "alpha", teeTime: "1:20 PM" },
      { eventId: "us-open-2026", playerId: "beta", teeTime: "7:40 AM" },
      { eventId: "us-open-2026", playerId: "gamma", teeTime: "2:10 PM" }
    ],
    rounds: [
      { playerId: "alpha", eventId: "wind-open", courseId: "oakmont", round: 1, sgTotal: 2.2, toPar: -2 },
      { playerId: "alpha", eventId: "calm-open", courseId: "harbor", round: 1, sgTotal: 0.2, toPar: 0 },
      { playerId: "beta", eventId: "calm-open", courseId: "harbor", round: 1, sgTotal: 1.5, toPar: -3 }
    ],
    weatherSnapshots: [
      { eventId: "us-open-2026", courseId: "oakmont", wave: "AM", forecastAt: "2026-06-18T08:00:00", windMph: 6, gustMph: 9, temperatureF: 70 },
      { eventId: "us-open-2026", courseId: "oakmont", wave: "PM", forecastAt: "2026-06-18T14:00:00", windMph: 22, gustMph: 34, temperatureF: 76 },
      { eventId: "wind-open", courseId: "oakmont", round: 1, windMph: 22, gustMph: 31, temperatureF: 66 },
      { eventId: "calm-open", courseId: "harbor", round: 1, windMph: 5, gustMph: 8, temperatureF: 79 }
    ]
  }, {
    eventId: "us-open-2026",
    limit: 4
  });

  const am = board.waves.find((row) => row.waveKey === "AM");
  const pm = board.waves.find((row) => row.waveKey === "PM");

  assert.equal(board.event.name, "U.S. Open");
  assert.equal(board.summary.fieldCount, 3);
  assert.equal(board.summary.assignedTeeTimes, 3);
  assert.equal(board.summary.weatherSnapshots, 2);
  assert.equal(board.summary.advantagedWave, "AM wave");
  assert.equal(board.summary.toughWave, "PM wave");
  assert.ok(board.summary.drawSpread > 20);
  assert.equal(am.drawLabel, "Advantage");
  assert.equal(am.teeTimeRange, "7:40 AM");
  assert.equal(pm.drawLabel, "Tough draw");
  assert.equal(pm.weather.bucket, "Wind");
  assert.equal(pm.fieldCount, 2);
  assert.equal(pm.players[0].playerName, "Alpha Player");
  assert.equal(pm.players[0].weatherRounds, 1);
  near(pm.players[0].weatherFit, 1);
});

test("buildFieldReadinessBoard: audits selected-field player data depth", () => {
  const board = G.buildFieldReadinessBoard({
    players: [
      { id: "alpha", name: "Alpha Player", country: "USA", tour: "PGA Tour", owgrRank: 8, profileUrl: "https://example.com/alpha", sourceProvider: "Owned Research" },
      { id: "beta", name: "Beta Player" }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-18", courseId: "oakmont", courseName: "Oakmont" },
      { id: "wind-open", name: "Wind Open", startDate: "2025-07-01", courseId: "oakmont", courseName: "Oakmont" },
      { id: "pinehurst-2024", name: "U.S. Open", startDate: "2024-06-13", courseId: "pinehurst", courseName: "Pinehurst No. 2" }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", par: 70, yards: 7255, fieldAdjustedToPar: 2.6, style: "major test" },
      { id: "pinehurst", name: "Pinehurst No. 2", par: 70, yards: 7540, fieldAdjustedToPar: 2.2, style: "major test" }
    ],
    fields: [
      { id: "field-alpha", eventId: "us-open-2026", playerId: "alpha", sourceProvider: "Field List" },
      { id: "field-missing", eventId: "us-open-2026", playerName: "Missing Player" }
    ],
    rounds: [
      { playerId: "alpha", eventId: "wind-open", courseId: "oakmont", round: 1, sgTotal: 2.2, toPar: -2, sourceProvider: "Round Archive" },
      { playerId: "alpha", eventId: "pinehurst-2024", courseId: "pinehurst", round: 1, sgTotal: 1.4, toPar: 0, sourceProvider: "Round Archive" }
    ],
    strokesGained: [
      { playerId: "alpha", period: "rolling", sgTotal: 1.5, sgApp: 0.8, sourceProvider: "SG Archive" }
    ],
    weatherSnapshots: [
      { eventId: "us-open-2026", courseId: "oakmont", windMph: 21, gustMph: 30 },
      { eventId: "wind-open", courseId: "oakmont", round: 1, windMph: 22, gustMph: 31 },
      { eventId: "pinehurst-2024", courseId: "pinehurst", round: 1, windMph: 14 }
    ],
    oddsSnapshots: [
      { eventId: "us-open-2026", playerId: "alpha", market: "winner", oddsAmerican: 1200, sourceProvider: "Odds Feed" }
    ],
    modelPredictions: [
      { eventId: "us-open-2026", playerId: "alpha", market: "winner", probability: 0.08, sourceProvider: "Owned Model" }
    ],
    equipmentSnapshots: [
      { playerId: "alpha", capturedDate: "2026-05-01", driver: "Driver", sourceProvider: "Bag Source" }
    ],
    accomplishments: [
      { playerId: "alpha", label: "Tour winner", season: 2025, sourceProvider: "Bio Source" }
    ]
  }, {
    eventId: "us-open-2026",
    market: "winner"
  });

  const missing = board.rows.find((row) => row.playerName === "Missing Player");
  const alpha = board.allRows.find((row) => row.playerName === "Alpha Player");

  assert.equal(board.summary.players, 2);
  assert.equal(board.summary.matchedProfiles, 1);
  assert.equal(board.summary.marketReady, 1);
  assert.equal(board.summary.modelRunReady, 1);
  assert.equal(board.rows[0].playerName, "Missing Player");
  assert.equal(missing.matchedProfile, false);
  assert.equal(missing.gaps.includes("Profile match"), true);
  assert.equal(missing.gaps.includes("Market odds"), true);
  assert.equal(missing.gaps.includes("Model run"), true);
  assert.ok(alpha.score > missing.score);
  assert.equal(alpha.counts.oddsRows, 1);
  assert.equal(alpha.counts.predictions, 1);
  assert.equal(alpha.counts.targetWeatherRounds, 1);
  assert.ok(board.summary.topGaps.some((gap) => gap.label === "Market odds"));
});

test("buildPlayerScorecard: rolls up skills, course splits, equipment, and accomplishments", () => {
  const lab = G.normalizeGolfLabState({
    players: [{
      name: "Scottie Scheffler",
      dataGolfId: "scottie-scheffler",
      country: "USA",
      tour: "PGA Tour",
      owgrRank: 1
    }],
    events: [
      { id: "major-2026", name: "Major Test", courseId: "oakmont", courseName: "Oakmont", startDate: "2026-06-18" }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", fieldAdjustedToPar: 2.2 },
      { id: "plantation", name: "Kapalua Plantation", fieldAdjustedToPar: -1.8 },
      { name: "Pinehurst No. 2", fieldAdjustedToPar: 1.8 }
    ],
    fields: [
      { eventId: "major-2026", playerId: "scottie-scheffler", status: "active" }
    ],
    rounds: [
      { playerId: "scottie-scheffler", eventId: "oakmont-open", courseId: "oakmont", round: 1, toPar: 1, adjustedToPar: 0.5, sgTotal: 1.2 },
      { playerId: "scottie-scheffler", eventId: "oakmont-open", courseId: "oakmont", round: 2, toPar: 0, adjustedToPar: 0.1, sgTotal: 0.8 },
      { playerId: "scottie-scheffler", eventId: "sentry", courseId: "plantation", round: 1, toPar: -4, adjustedToPar: -2, sgTotal: 2.5 },
      { playerId: "scottie-scheffler", eventId: "us-open", courseName: "Pinehurst No. 2", round: 1, toPar: 4 }
    ],
    weatherSnapshots: [
      { eventId: "oakmont-open", courseId: "oakmont", round: 1, windMph: 20, gustMph: 27, temperatureF: 62 },
      { eventId: "oakmont-open", courseId: "oakmont", round: 2, windMph: 19, gustMph: 25, temperatureF: 63 },
      { eventId: "sentry", courseId: "plantation", round: 1, windMph: 7, temperatureF: 86 },
      { eventId: "us-open", courseName: "Pinehurst No. 2", round: 1, windMph: 11, precipitationIn: 0.08, temperatureF: 58 },
      { eventId: "major-2026", courseId: "oakmont", round: 1, windMph: 21, gustMph: 31, temperatureF: 70 }
    ],
    strokesGained: [
      { playerId: "scottie-scheffler", period: "rolling-1", sgOtt: 0.8, sgApp: 1.1, sgArg: 0.1, sgPutt: -0.2, sgT2g: 2, sgTotal: 1.8, drivingDistance: 312, accuracy: 0.64, gir: 0.73, scrambling: 0.68 },
      { playerId: "scottie-scheffler", period: "rolling-2", sgOtt: 0.4, sgApp: 0.9, sgArg: 0.3, sgPutt: 0.2, sgT2g: 1.6, sgTotal: 1.9, drivingDistance: 308, accuracy: 0.6, gir: 0.71, scrambling: 0.72 }
    ],
    equipmentSnapshots: [
      { playerId: "scottie-scheffler", capturedDate: "2026-01-01", driver: "TaylorMade Stealth 2", sourceUrl: "https://example.com/old" },
      { playerId: "scottie-scheffler", capturedDate: "2026-04-01", driver: "TaylorMade Qi10", putter: "TaylorMade Spider", sourceUrl: "https://example.com/new" }
    ],
    accomplishments: [
      { playerId: "scottie-scheffler", season: 2025, label: "The Players champion", date: "2025-03-16" },
      { playerId: "scottie-scheffler", season: 2026, label: "Masters champion", date: "2026-04-12" }
    ],
    oddsSnapshots: [
      { eventId: "major-2026", playerId: "scottie-scheffler", market: "winner", oddsAmerican: 500 }
    ],
    predictionLedger: [
      { eventId: "major-2026", playerId: "scottie-scheffler", market: "winner", probability: 0.22, edge: 0.05, marketOddsAmerican: 500 }
    ]
  });

  const card = G.buildPlayerScorecard(lab, "scottie-scheffler", { eventId: "major-2026" });

  assert.equal(card.player.name, "Scottie Scheffler");
  assert.equal(card.sample.rounds, 4);
  assert.equal(card.sample.courses, 3);
  near(card.skills.sgOtt, 0.6);
  near(card.skills.drivingDistance, 310);
  near(card.skills.accuracy, 0.62);
  assert.equal(card.bestCourses[0].courseName, "Kapalua Plantation");
  assert.equal(card.worstCourses[0].courseName, "Pinehurst No. 2");
  assert.equal(card.bestCourses.find((row) => row.courseName === "Oakmont").difficulty, "Tough");
  assert.equal(card.difficultySplits.find((row) => row.bucket === "Tough").rounds, 3);
  near(card.difficultySplits.find((row) => row.bucket === "Easy").avgSg, 2.5);
  assert.equal(card.weatherSplits.find((row) => row.bucket === "Wind").rounds, 2);
  near(card.weatherSplits.find((row) => row.bucket === "Wind").avgSg, 1);
  assert.equal(card.weatherSplits.find((row) => row.bucket === "Rain").rounds, 1);
  assert.equal(card.weatherSplits.find((row) => row.bucket === "Heat").rounds, 1);
  assert.equal(card.weatherDna.status, "building");
  assert.equal(card.weatherDna.best.bucket, "Heat");
  assert.equal(card.weatherDna.worst.bucket, "Rain");
  assert.equal(card.weatherDna.target.bucket, "Wind");
  assert.equal(card.weatherDna.target.rounds, 2);
  near(card.weatherDna.target.delta, -0.5);
  assert.equal(card.equipment.driver, "TaylorMade Qi10");
  assert.equal(card.accomplishments[0].label, "Masters champion");
  assert.equal(card.snapshot.headline, "Strong fit");
  assert.equal(card.snapshot.bestCourse.courseName, "Kapalua Plantation");
  assert.equal(card.snapshot.worstCourse.courseName, "Pinehurst No. 2");
  assert.equal(card.snapshot.equipment.primaryLabel, "Driver");
  assert.equal(card.snapshot.equipment.primaryValue, "TaylorMade Qi10");
  assert.equal(card.snapshot.accomplishment.label, "Masters champion");
  assert.equal(card.snapshot.topSkill.label, "SG Total");
  assert.equal(card.profile.archetype, "All-Around Contender");
  assert.equal(card.profile.tags.includes("Approach engine"), true);
  assert.equal(card.profile.strengths.some((row) => row.id === "sgTotal"), true);
  assert.equal(card.sourceCoverage.status, "building");
  assert.equal(card.sourceCoverage.gaps.includes("Source proof"), true);
  assert.equal(card.eventFit.event.name, "Major Test");
  assert.equal(card.eventFit.inField, true);
  assert.equal(card.eventFit.label, "Strong fit");
  assert.equal(card.eventFit.targetWeather.bucket, "Wind");
  assert.equal(card.eventFit.predictions, 1);
  assert.equal(card.eventFit.oddsRows, 1);
});

test("buildPlayerScorecard: tracks multi-course events when round courses are pending", () => {
  const lab = G.normalizeGolfLabState({
    players: [{ id: "alpha", name: "Alpha Player" }],
    events: [{ id: "pebble-2026", name: "Pebble Pro-Am", startDate: "2026-02-01" }],
    courses: [
      { id: "pebble", name: "Pebble Beach Golf Links" },
      { id: "spyglass", name: "Spyglass Hill Golf Course" }
    ],
    eventCourses: [
      { eventId: "pebble-2026", courseId: "pebble", courseName: "Pebble Beach Golf Links", courseOrder: 1, confidence: "verified" },
      { eventId: "pebble-2026", courseId: "spyglass", courseName: "Spyglass Hill Golf Course", courseOrder: 2, confidence: "verified" }
    ],
    rounds: [
      { playerId: "alpha", eventId: "pebble-2026", round: 1, sgTotal: 1.5, toPar: -3 },
      { playerId: "alpha", eventId: "pebble-2026", round: 2, sgTotal: 0.5, toPar: -1 }
    ]
  });

  const card = G.buildPlayerScorecard(lab, "alpha");

  assert.equal(card.sample.multiCourseEvents, 1);
  assert.equal(card.multiCourseEvents[0].eventName, "Pebble Pro-Am");
  assert.equal(card.multiCourseEvents[0].courseCount, 2);
  assert.equal(card.multiCourseEvents[0].confidence, "verified");
  near(card.multiCourseEvents[0].avgSg, 1);
});

test("buildPlayerIndexBoard: turns scorecards into a roster intelligence board", () => {
  const board = G.buildPlayerIndexBoard({
    players: [
      { id: "alpha", name: "Alpha Player", owgrRank: 4 },
      { id: "beta", name: "Beta Player", owgrRank: 22 },
      { id: "gamma", name: "Gamma Player", owgrRank: 39 }
    ],
    events: [
      { id: "event-1", name: "Oakmont Invitational", courseId: "oakmont", courseName: "Oakmont", startDate: "2026-06-18" }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", fieldAdjustedToPar: 2.2 },
      { id: "kapalua", name: "Kapalua Plantation", fieldAdjustedToPar: -1.4 }
    ],
    fields: [
      { eventId: "event-1", playerId: "alpha", status: "active" },
      { eventId: "event-1", playerId: "beta", status: "active" }
    ],
    rounds: [
      { playerId: "alpha", eventId: "hard-open", courseId: "oakmont", round: 1, sgTotal: 2.2, toPar: -2 },
      { playerId: "alpha", eventId: "wind-open", courseId: "oakmont", round: 2, sgTotal: 1.4, toPar: 0 },
      { playerId: "beta", eventId: "hard-open", courseId: "oakmont", round: 1, sgTotal: -0.4, toPar: 4 },
      { playerId: "beta", eventId: "birdie-fest", courseId: "kapalua", round: 1, sgTotal: 1.6, toPar: -6 },
      { playerId: "gamma", eventId: "birdie-fest", courseId: "kapalua", round: 1, sgTotal: 0.2, toPar: -3 }
    ],
    strokesGained: [
      { playerId: "alpha", sgTotal: 1.7, sgOtt: 0.8, sgApp: 0.7, drivingDistance: 318, accuracy: 0.67 },
      { playerId: "beta", sgTotal: 0.8, sgOtt: 0.4, sgApp: 0.2, drivingDistance: 306, accuracy: 0.58 },
      { playerId: "gamma", sgTotal: 0.4, sgOtt: 0.1, sgApp: 0.1, drivingDistance: 292, accuracy: 0.71 }
    ],
    weatherSnapshots: [
      { eventId: "wind-open", courseId: "oakmont", round: 2, windMph: 22, gustMph: 30 },
      { eventId: "birdie-fest", courseId: "kapalua", round: 1, windMph: 6 },
      { eventId: "event-1", courseId: "oakmont", round: 1, windMph: 20, gustMph: 28 }
    ],
    equipmentSnapshots: [
      { playerId: "alpha", capturedDate: "2026-05-01", driver: "TaylorMade Qi10" }
    ],
    accomplishments: [
      { playerId: "alpha", label: "Major champion", season: 2025 }
    ],
    predictionLedger: [
      { eventId: "event-1", playerId: "alpha", market: "winner", probability: 0.2 },
      { eventId: "event-1", playerId: "beta", market: "winner", probability: 0.12 }
    ]
  }, { eventId: "event-1" });

  assert.equal(board.summary.players, 3);
  assert.equal(board.summary.playersWithRounds, 3);
  assert.equal(board.summary.playersWithEquipment, 1);
  assert.equal(board.summary.sgLeader.playerName, "Alpha Player");
  assert.equal(board.summary.distanceLeader.playerName, "Alpha Player");
  assert.equal(board.summary.accuracyLeader.playerName, "Gamma Player");
  assert.equal(board.summary.toughCourseLeader.playerName, "Alpha Player");
  assert.equal(board.summary.windLeader.playerName, "Alpha Player");
  assert.equal(board.summary.eventFitLeader.playerName, "Alpha Player");
  assert.equal(board.summary.strongEventFits, 1);
  assert.equal(board.rows[0].playerName, "Alpha Player");
  assert.equal(board.rows[0].profile.archetype, "Approach Engine");
  assert.equal(board.rows[0].eventFit.inField, true);
  assert.equal(board.rows[0].sourceCoverage.score > 0, true);
  assert.equal(board.rows[0].bestCourse.courseName, "Oakmont");
  assert.equal(board.rows[0].tags.includes("Elite SG"), true);
  assert.equal(board.rows[0].tags.includes("Power"), true);
  assert.equal(board.rows[0].tags.includes("Tough-course plus"), true);
});

test("buildPlayerSplitLab: ranks selected-field players by setup splits", () => {
  const board = G.buildPlayerSplitLab({
    players: [
      { id: "alpha", name: "Alpha Player", country: "USA", sourceProvider: "Profiles" },
      { id: "beta", name: "Beta Player", country: "CAN", sourceProvider: "Profiles" },
      { id: "gamma", name: "Gamma Player", country: "ENG", sourceProvider: "Profiles" }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-18", courseId: "oakmont", courseName: "Oakmont" },
      { id: "hard-open", name: "Hard Open", startDate: "2026-05-18", courseId: "pinehurst", courseName: "Pinehurst No. 2" },
      { id: "easy-open", name: "Easy Open", startDate: "2026-04-18", courseId: "kapalua", courseName: "Kapalua Plantation" }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", fieldAdjustedToPar: 2.7, par: 70, yards: 7372, rating: 76.4, slope: 145, style: "major test", sourceProvider: "Course Guide" },
      { id: "pinehurst", name: "Pinehurst No. 2", fieldAdjustedToPar: 2.1, par: 70, yards: 7540, rating: 75.8, slope: 143, style: "major test", sourceProvider: "Course Guide" },
      { id: "kapalua", name: "Kapalua Plantation", fieldAdjustedToPar: -1.5, par: 73, yards: 7596, rating: 75.2, slope: 138, style: "resort scorer", sourceProvider: "Course Guide" }
    ],
    courseSetups: [
      { eventId: "us-open-2026", courseId: "oakmont", fieldAdjustedToPar: 3.1, rough: "Heavy", greenSpeed: "Fast", firmness: "Firm", sourceProvider: "Setup Notes" }
    ],
    fields: [
      { eventId: "us-open-2026", playerId: "alpha", status: "active" },
      { eventId: "us-open-2026", playerId: "beta", status: "active" },
      { eventId: "us-open-2026", playerId: "gamma", status: "active" }
    ],
    rounds: [
      { playerId: "alpha", eventId: "hard-open", courseId: "pinehurst", round: 1, sgTotal: 2.3, toPar: -2, sourceProvider: "Round Archive" },
      { playerId: "alpha", eventId: "hard-open", courseId: "pinehurst", round: 2, sgTotal: 1.7, toPar: 0, sourceProvider: "Round Archive" },
      { playerId: "beta", eventId: "hard-open", courseId: "pinehurst", round: 1, sgTotal: -0.6, toPar: 4, sourceProvider: "Round Archive" },
      { playerId: "beta", eventId: "easy-open", courseId: "kapalua", round: 1, sgTotal: 2.6, toPar: -7, sourceProvider: "Round Archive" },
      { playerId: "gamma", eventId: "easy-open", courseId: "kapalua", round: 1, sgTotal: 0.2, toPar: -2, sourceProvider: "Round Archive" }
    ],
    strokesGained: [
      { playerId: "alpha", sgTotal: 1.5, sgApp: 0.7, sgOtt: 0.4, drivingDistance: 309, accuracy: 0.64, sourceProvider: "SG Export" },
      { playerId: "beta", sgTotal: 0.9, sgApp: 0.2, sgOtt: 0.5, drivingDistance: 315, accuracy: 0.52, sourceProvider: "SG Export" },
      { playerId: "gamma", sgTotal: 0.1, sgApp: 0.1, sgOtt: -0.1, drivingDistance: 292, accuracy: 0.66, sourceProvider: "SG Export" }
    ],
    weatherSnapshots: [
      { eventId: "us-open-2026", courseId: "oakmont", windMph: 21, gustMph: 30, sourceProvider: "Weather" },
      { eventId: "hard-open", courseId: "pinehurst", round: 1, windMph: 22, gustMph: 31, sourceProvider: "Weather" },
      { eventId: "hard-open", courseId: "pinehurst", round: 2, windMph: 18, gustMph: 28, sourceProvider: "Weather" },
      { eventId: "easy-open", courseId: "kapalua", round: 1, windMph: 6, sourceProvider: "Weather" }
    ],
    equipmentSnapshots: [
      { playerId: "alpha", capturedDate: "2026-05-01", driver: "TaylorMade Qi10", sourceProvider: "WITB" }
    ],
    accomplishments: [
      { playerId: "alpha", label: "Major champion", season: 2025, sourceProvider: "Profile" }
    ],
    modelPredictions: [
      { eventId: "us-open-2026", playerId: "alpha", market: "winner", probability: 0.22, sourceProvider: "Owned Model" }
    ],
    oddsSnapshots: [
      { eventId: "us-open-2026", playerId: "alpha", market: "winner", oddsAmerican: 900, sourceProvider: "Book" }
    ]
  }, { eventId: "us-open-2026" });

  assert.equal(board.event.name, "U.S. Open");
  assert.equal(board.target.difficulty.bucket, "Brutal");
  assert.equal(board.target.weather.bucket, "Wind");
  assert.equal(board.target.fieldMode, "selected-field");
  assert.equal(board.summary.players, 3);
  assert.equal(board.summary.fieldRows, 3);
  assert.equal(board.summary.splitReadyPlayers, 3);
  assert.equal(board.leaders.overall.playerId, "alpha");
  assert.equal(board.leaders.tough.playerId, "alpha");
  assert.equal(board.leaders.easy.playerId, "beta");
  assert.equal(board.leaders.weather.playerId, "alpha");
  assert.equal(board.leaders.comp.playerId, "alpha");
  assert.equal(board.rows[0].recommendation, "Major-test fit");
  assert.equal(board.rows[0].metrics.tough.tone, "positive");
  assert.equal(board.rows[0].metrics.targetWeather.tone, "positive");
  assert.equal(board.rows[0].sourceCoverage.score > board.rows[2].sourceCoverage.score, true);
  assert.equal(board.blockers.length, 0);
});

test("buildPlayerIdentityBoard: audits cross-source player identity resolution", () => {
  const board = G.buildPlayerIdentityBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta-player", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" },
      { id: "alpha-duplicate", name: "Alpha Player" }
    ],
    events: [{ id: "event-1", name: "Identity Open", startDate: "2026-06-18" }],
    fields: [
      { eventId: "event-1", playerId: "alpha" },
      { eventId: "event-1", playerName: "Gamma Player Amateur", sourceProvider: "Field List" }
    ],
    rounds: [
      { eventId: "event-1", playerName: "Beta_Player", round: 1, sgTotal: 1.2 }
    ],
    oddsSnapshots: [
      { eventId: "event-1", playerId: "unknown-player", market: "winner", oddsAmerican: 5000 }
    ]
  }, { eventId: "event-1" });

  assert.equal(board.selectedEvent.name, "Identity Open");
  assert.equal(board.summary.identityRows, 4);
  assert.equal(board.summary.matchedRows, 2);
  assert.equal(board.summary.normalizedRows, 1);
  assert.equal(board.summary.unresolvedRows, 2);
  assert.equal(board.summary.selectedEventUnresolved, 2);
  assert.equal(board.duplicateProfiles.length, 1);
  assert.equal(board.collectionRows.find((row) => row.key === "rounds").normalizedRows, 1);
  const suggested = board.unresolvedRows.find((row) => row.playerName === "Gamma Player Amateur");
  assert.equal(suggested.suggestedPlayerName, "Gamma Player");
  assert.equal(suggested.status, "suggested");
});

test("buildCourseScorecard: ranks player fits and rolls up course context", () => {
  const lab = G.normalizeGolfLabState({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", location: "Oakmont, PA", fieldAdjustedToPar: 2.4 },
      { id: "harbor", name: "Harbor Links", fieldAdjustedToPar: -1.2 }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", tour: "PGA Tour", startDate: "2026-06-18", courseId: "oakmont", courseName: "Oakmont" },
      { id: "pga-2025", name: "PGA Championship", tour: "PGA Tour", startDate: "2025-05-15", courseId: "oakmont", courseName: "Oakmont" }
    ],
    courseSetups: [
      { eventId: "us-open-2026", courseId: "oakmont", fieldAdjustedToPar: 3.1, rough: "Heavy", sourceUpdatedAt: "2026-06-18T09:00:00Z" }
    ],
    rounds: [
      { playerId: "alpha", eventId: "us-open-2026", courseId: "oakmont", round: 1, date: "2026-06-18", sgTotal: 2.2, toPar: -1 },
      { playerId: "alpha", eventId: "pga-2025", courseId: "oakmont", round: 1, date: "2025-05-15", sgTotal: 1.4, toPar: 0 },
      { playerId: "beta", eventId: "us-open-2026", courseId: "oakmont", round: 1, date: "2026-06-18", sgTotal: -0.5, toPar: 4 },
      { playerId: "beta", eventId: "pga-2025", courseId: "oakmont", round: 1, date: "2025-05-15", sgTotal: -1.2, toPar: 6 }
    ],
    weatherSnapshots: [
      { eventId: "us-open-2026", courseId: "oakmont", windMph: 18, gustMph: 28, temperatureF: 74 },
      { eventId: "pga-2025", courseId: "oakmont", windMph: 12, gustMph: 20, temperatureF: 68 }
    ]
  });

  const card = G.buildCourseScorecard(lab, "oakmont");

  assert.equal(card.course.name, "Oakmont");
  assert.equal(card.difficulty.bucket, "Brutal");
  assert.equal(card.sample.rounds, 4);
  assert.equal(card.sample.players, 2);
  assert.equal(card.sample.events, 2);
  near(card.weather.windMph, 15);
  assert.equal(card.topFits[0].playerName, "Alpha Player");
  assert.equal(card.toughFits[0].playerName, "Beta Player");
  assert.equal(card.setup.rough, "Heavy");
});

test("buildCourseSetupBoard: profiles selected tournament setup pressure and comp fits", () => {
  const board = G.buildCourseSetupBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-18", courseId: "oakmont", courseName: "Oakmont" },
      { id: "pga-2025", name: "PGA Championship", startDate: "2025-05-15", courseId: "oakmont", courseName: "Oakmont" },
      { id: "pinehurst-2024", name: "U.S. Open", startDate: "2024-06-13", courseId: "pinehurst", courseName: "Pinehurst No. 2" },
      { id: "heritage-2025", name: "Heritage", startDate: "2025-04-17", courseId: "harbor", courseName: "Harbor Links" }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", par: 70, yards: 7255, rating: 76.4, slope: 145, fieldAdjustedToPar: 2.6, style: "major test", sourceProvider: "Course Guide" },
      { id: "pinehurst", name: "Pinehurst No. 2", par: 70, yards: 7540, rating: 75.8, slope: 143, fieldAdjustedToPar: 2.2, style: "major test" },
      { id: "harbor", name: "Harbor Links", par: 71, yards: 7100, rating: 74.1, slope: 138, fieldAdjustedToPar: 0.8, style: "strategic positional" }
    ],
    courseSetups: [
      { eventId: "us-open-2026", courseId: "oakmont", par: 70, yards: 7372, rough: "Heavy", greenSpeed: "Fast", firmness: "Firm", fieldAdjustedToPar: 3.1, sourceProvider: "Setup Notes" }
    ],
    fields: [
      { eventId: "us-open-2026", playerId: "alpha" },
      { eventId: "us-open-2026", playerId: "beta" }
    ],
    rounds: [
      { playerId: "alpha", eventId: "pga-2025", courseId: "oakmont", round: 1, sgTotal: 1.1, toPar: 0, sourceProvider: "Round Archive" },
      { playerId: "beta", eventId: "pga-2025", courseId: "oakmont", round: 1, sgTotal: -0.4, toPar: 3, sourceProvider: "Round Archive" },
      { playerId: "alpha", eventId: "pinehurst-2024", courseId: "pinehurst", round: 1, sgTotal: 2.0, toPar: -1, sourceProvider: "Round Archive" },
      { playerId: "beta", eventId: "pinehurst-2024", courseId: "pinehurst", round: 1, sgTotal: -0.5, toPar: 4, sourceProvider: "Round Archive" },
      { playerId: "alpha", eventId: "heritage-2025", courseId: "harbor", round: 1, sgTotal: 0.8, toPar: 0 }
    ],
    weatherSnapshots: [
      { eventId: "us-open-2026", courseId: "oakmont", windMph: 21, gustMph: 30, sourceProvider: "Weather" }
    ]
  }, { eventId: "us-open-2026" });

  assert.equal(board.event.name, "U.S. Open");
  assert.equal(board.course.courseName, "Oakmont");
  assert.equal(board.setup.rough, "Heavy");
  assert.equal(board.readiness, "model-ready");
  assert.equal(board.pressureLabel, "Major stress");
  assert.equal(board.summary.criticalMissing, 0);
  assert.equal(board.dimensions.find((row) => row.label === "Firmness").status, "ready");
  assert.equal(board.compCourses[0].courseName, "Pinehurst No. 2");
  assert.equal(board.playerFits[0].playerName, "Alpha Player");
  assert.equal(board.source.providers.includes("Setup Notes"), true);
  assert.equal(board.blockers.length, 0);
});

test("buildCourseSetupBoard: accepts a multi-course pool with pending round assignment", () => {
  const board = G.buildCourseSetupBoard({
    players: [{ id: "alpha", name: "Alpha Player" }],
    events: [{ id: "pebble-2026", name: "Pebble Pro-Am", startDate: "2026-02-01" }],
    courses: [
      { id: "pebble", name: "Pebble Beach Golf Links", par: 72, yards: 6816, sourceProvider: "Course Guide" },
      { id: "spyglass", name: "Spyglass Hill Golf Course", par: 72, yards: 7026, sourceProvider: "Course Guide" }
    ],
    eventCourses: [
      { eventId: "pebble-2026", courseId: "pebble", courseName: "Pebble Beach Golf Links", courseOrder: 1, par: 72, yards: 6816, confidence: "verified", sourceProvider: "Pool Source" },
      { eventId: "pebble-2026", courseId: "spyglass", courseName: "Spyglass Hill Golf Course", courseOrder: 2, par: 72, yards: 7026, confidence: "verified", sourceProvider: "Pool Source" }
    ],
    rounds: [
      { playerId: "alpha", eventId: "pebble-2026", round: 1, sgTotal: 1.4, toPar: -3, sourceProvider: "Round Archive" }
    ]
  }, { eventId: "pebble-2026" });

  assert.equal(board.coursePool.courseCount, 2);
  assert.equal(board.summary.coursePoolCourses, 2);
  assert.equal(board.dimensions.find((row) => row.label === "Course Pool").status, "ready");
  assert.equal(board.blockers.includes("Course profile missing"), false);
  assert.equal(board.blockers.includes("Tournament setup row missing"), false);
  assert.equal(board.blockers.includes("Round-level course assignment pending"), true);
});

test("buildCourseDifficultyBoard: ranks course difficulty with player fit context", () => {
  const board = G.buildCourseDifficultyBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", location: "Oakmont, PA", fieldAdjustedToPar: 2.6, style: "major test", sourceProvider: "Owned Research", sourceUpdatedAt: "2026-06-18T09:00:00Z" },
      { id: "kapalua", name: "Kapalua Plantation", location: "Lahaina, HI", fieldAdjustedToPar: -1.6, style: "resort scorer", sourceProvider: "Owned Research", sourceUpdatedAt: "2026-01-04T10:00:00Z" },
      { id: "harbor", name: "Harbor Links", location: "Hilton Head, SC" }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-18", courseId: "oakmont", courseName: "Oakmont" },
      { id: "sentry-2026", name: "The Sentry", startDate: "2026-01-04", courseId: "kapalua", courseName: "Kapalua Plantation" }
    ],
    rounds: [
      { playerId: "alpha", eventId: "us-open-2026", courseId: "oakmont", round: 1, sgTotal: 2.1, toPar: -1, sourceProvider: "Round Archive", sourceUpdatedAt: "2026-06-18T20:00:00Z" },
      { playerId: "beta", eventId: "us-open-2026", courseId: "oakmont", round: 1, sgTotal: -0.6, toPar: 4, sourceProvider: "Round Archive", sourceUpdatedAt: "2026-06-18T20:00:00Z" },
      { playerId: "alpha", eventId: "sentry-2026", courseId: "kapalua", round: 1, sgTotal: 0.3, toPar: -4 },
      { playerId: "gamma", eventId: "sentry-2026", courseId: "kapalua", round: 1, sgTotal: 2.7, toPar: -9 },
      { playerId: "beta", eventId: "sentry-2026", courseId: "kapalua", round: 1, sgTotal: -0.4, toPar: -1 },
      { playerId: "gamma", eventId: "harbor-open", courseId: "harbor", round: 1, adjustedToPar: 1.1, toPar: 2, sgTotal: 0.5 }
    ],
    weatherSnapshots: [
      { eventId: "us-open-2026", courseId: "oakmont", windMph: 21, gustMph: 29, sourceProvider: "NOAA" },
      { eventId: "sentry-2026", courseId: "kapalua", windMph: 8, temperatureF: 79, sourceProvider: "NOAA" }
    ]
  });

  assert.equal(board.summary.courses, 3);
  assert.equal(board.summary.scoredCourses, 3);
  assert.equal(board.summary.toughCourses, 2);
  assert.equal(board.summary.easyCourses, 1);
  assert.equal(board.summary.hardest.courseName, "Oakmont");
  assert.equal(board.summary.easiest.courseName, "Kapalua Plantation");
  assert.equal(board.rows[0].difficulty.bucket, "Brutal");
  assert.equal(board.rows[0].topFit.playerName, "Alpha Player");
  assert.equal(board.rows[0].toughFit.playerName, "Beta Player");
  assert.equal(board.rows[0].source.providers.includes("Owned Research"), true);
  assert.equal(board.rows[0].source.providers.includes("Round Archive"), true);
  assert.equal(board.rows[0].sample.weatherSnapshots, 1);
  near(board.rows.find((row) => row.courseId === "harbor").scoring.avgAdjustedToPar, 1.1);
  assert.equal(board.buckets.find((bucket) => bucket.bucket === "Brutal").count, 1);
  assert.equal(board.buckets.find((bucket) => bucket.bucket === "Easy").count, 1);
});

test("buildCourseCompBoard: finds similar courses and player comp fits", () => {
  const board = G.buildCourseCompBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-18", courseId: "oakmont", courseName: "Oakmont" },
      { id: "pinehurst-2024", name: "U.S. Open", startDate: "2024-06-13", courseId: "pinehurst", courseName: "Pinehurst No. 2" },
      { id: "heritage-2025", name: "Heritage", startDate: "2025-04-17", courseId: "harbor", courseName: "Harbor Links" },
      { id: "sentry-2026", name: "The Sentry", startDate: "2026-01-04", courseId: "kapalua", courseName: "Kapalua Plantation" }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", par: 70, yards: 7255, rating: 76.4, slope: 145, fieldAdjustedToPar: 2.6, style: "major test" },
      { id: "pinehurst", name: "Pinehurst No. 2", par: 70, yards: 7540, rating: 75.8, slope: 143, fieldAdjustedToPar: 2.2, style: "major test" },
      { id: "harbor", name: "Harbor Links", par: 71, yards: 7100, rating: 74.1, slope: 138, fieldAdjustedToPar: 0.8, style: "strategic positional" },
      { id: "kapalua", name: "Kapalua Plantation", par: 73, yards: 7600, rating: 73.2, slope: 135, fieldAdjustedToPar: -1.5, style: "resort scorer" }
    ],
    fields: [
      { eventId: "us-open-2026", playerId: "alpha" },
      { eventId: "us-open-2026", playerId: "beta" }
    ],
    rounds: [
      { playerId: "alpha", eventId: "pinehurst-2024", courseId: "pinehurst", round: 1, sgTotal: 2.0, toPar: -1 },
      { playerId: "beta", eventId: "pinehurst-2024", courseId: "pinehurst", round: 1, sgTotal: -0.5, toPar: 4 },
      { playerId: "alpha", eventId: "heritage-2025", courseId: "harbor", round: 1, sgTotal: 0.8, toPar: 0 },
      { playerId: "gamma", eventId: "heritage-2025", courseId: "harbor", round: 1, sgTotal: 1.5, toPar: -2 },
      { playerId: "gamma", eventId: "sentry-2026", courseId: "kapalua", round: 1, sgTotal: 2.5, toPar: -8 }
    ],
    weatherSnapshots: [
      { eventId: "pinehurst-2024", courseId: "pinehurst", windMph: 14 },
      { eventId: "heritage-2025", courseId: "harbor", windMph: 11 }
    ]
  }, {
    eventId: "us-open-2026",
    courseLimit: 2,
    playerLimit: 5
  });

  assert.equal(board.targetCourse.courseName, "Oakmont");
  assert.equal(board.targetCourse.difficulty.bucket, "Brutal");
  assert.equal(board.compCourses.length, 2);
  assert.equal(board.compCourses[0].courseName, "Pinehurst No. 2");
  assert.equal(board.compCourses[0].similarity > board.compCourses[1].similarity, true);
  assert.equal(board.compCourses[0].evidence.includes("major test"), true);
  assert.equal(board.summary.strongestComp.courseName, "Pinehurst No. 2");
  assert.equal(board.summary.fieldPlayersWithComps, 2);
  assert.equal(board.playerRows[0].playerName, "Alpha Player");
  assert.equal(board.playerRows[0].inField, true);
  assert.equal(board.playerRows[0].bestComp.courseName, "Pinehurst No. 2");
  near(board.playerRows[0].avgSg, 1.4);
});
