/*
 * Unit tests for lib/golf-lab-warehouse.js - owned warehouse/import helpers.
 *
 * Run:  node --test tests/golf-lab-warehouse.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("../lib/golf-lab-warehouse.js");
const G = require("../lib/golf-lab.js");

test("buildGolfLabImportSnapshot: accepts table bundles and adds source audit row", () => {
  const snapshot = W.buildGolfLabImportSnapshot({
    source: {
      provider: "PGA Tour",
      endpoint: "/owned/fields/us-open-2026",
      sourceUrl: "https://example.com/source",
      fetchedAt: "2026-06-18T10:00:00Z"
    },
    tables: {
      players: [{ id: "alpha", name: "Alpha Player" }],
      events: [{ id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-19", courseId: "oakmont" }],
      courses: [{ id: "oakmont", name: "Oakmont", fieldAdjustedToPar: 2.4 }],
      fields: [{ eventId: "us-open-2026", playerId: "alpha" }],
      rounds: [{ eventId: "us-open-2026", playerId: "alpha", courseId: "oakmont", round: 1, sgTotal: 2.1 }],
      weatherSnapshots: [{ eventId: "us-open-2026", courseId: "oakmont", windMph: 14 }],
      oddsSnapshots: [{ eventId: "us-open-2026", playerId: "alpha", market: "top 20", oddsAmerican: -140 }]
    }
  });

  assert.equal(snapshot.golfLab.players[0].name, "Alpha Player");
  assert.equal(snapshot.golfLab.sourceFetches[0].provider, "PGA Tour");
  assert.equal(snapshot.golfLab.sourceFetches[0].rowCount, 7);
  assert.equal(snapshot.report.events[0].readiness, "model-ready");
  assert.equal(snapshot.report.sourceFreshness.providerCount, 1);
  assert.ok(snapshot.report.sourceFreshness.qualityScore > 0);
  assert.equal(snapshot.report.validation.highIssueCount, 0);
  assert.ok(snapshot.report.score >= 70);
});

test("buildGolfLabImportPreview: reports add/update impact and validation risk before merge", () => {
  const preview = W.buildGolfLabImportPreview({
    players: [{ id: "alpha", name: "Alpha Player" }]
  }, {
    source: {
      provider: "Owned Preview",
      endpoint: "preview.csv",
      sourceUrl: "https://example.com/preview",
      fetchedAt: "2026-06-19T12:00:00Z"
    },
    tables: {
      players: [
        { id: "alpha", name: "Alpha Player", country: "USA" },
        { id: "beta", name: "Beta Player", country: "CAN" }
      ],
      rounds: [
        { id: "round-beta-1", playerId: "beta", score: 71 }
      ]
    }
  }, {
    now: "2026-06-19T12:00:00Z"
  });

  const players = preview.collectionRows.find((row) => row.key === "players");
  const rounds = preview.collectionRows.find((row) => row.key === "rounds");
  const sources = preview.collectionRows.find((row) => row.key === "sourceFetches");

  assert.equal(preview.summary.beforeRecords, 1);
  assert.equal(preview.summary.addedRecords, 3);
  assert.equal(preview.summary.updatedRecords, 1);
  assert.equal(preview.summary.afterRecords, 4);
  assert.equal(players.added, 1);
  assert.equal(players.updated, 1);
  assert.equal(rounds.added, 1);
  assert.equal(sources.added, 1);
  assert.ok(preview.validationDelta.highIssueDelta > 0);
  assert.equal(preview.verdict.status, "review");
  assert.ok(preview.nextActions.some((row) => row.label.includes("Review")));
});

test("buildSourceFreshness: grades provider recency and collection provenance", () => {
  const freshness = W.buildSourceFreshness({
    players: [{ id: "alpha", name: "Alpha Player", sourceProvider: "PGA Tour", sourceUpdatedAt: "2026-06-17T10:00:00Z" }],
    courses: [{ id: "oakmont", name: "Oakmont" }],
    rounds: [{ id: "round-1", playerId: "alpha", courseId: "oakmont", sourceUrl: "https://example.com/round", sourceUpdatedAt: "2026-06-01T10:00:00Z" }],
    sourceFetches: [
      { provider: "PGA Tour", endpoint: "players", fetchedAt: "2026-06-18T10:00:00Z", rowCount: 1, status: "ok" },
      { provider: "Weather Archive", endpoint: "weather", fetchedAt: "2026-06-04T10:00:00Z", rowCount: 4, status: "ok" }
    ]
  }, {
    now: "2026-06-18T12:00:00Z"
  });

  const pgaTour = freshness.providers.find((row) => row.provider === "PGA Tour");
  const weatherArchive = freshness.providers.find((row) => row.provider === "Weather Archive");
  const players = freshness.collections.find((row) => row.key === "players");
  const courses = freshness.collections.find((row) => row.key === "courses");
  const rounds = freshness.collections.find((row) => row.key === "rounds");

  assert.equal(pgaTour.freshness, "fresh");
  assert.equal(weatherArchive.freshness, "stale");
  assert.equal(players.status, "fresh");
  assert.equal(courses.status, "unverified");
  assert.equal(rounds.status, "stale");
  assert.equal(freshness.provenanceCoverage, 67);
  assert.equal(freshness.staleProviderCount, 1);
  assert.equal(freshness.unverifiedCollectionCount, 1);
});

test("buildSourceLineageBoard: links providers, collections, and event proof chains", () => {
  const board = W.buildSourceLineageBoard({
    players: [
      { id: "alpha", name: "Alpha Player", sourceProvider: "Official Profiles", sourceUpdatedAt: "2026-06-18T08:00:00Z" }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", courseId: "oakmont", courseName: "Oakmont", startDate: "2026-06-18", sourceProvider: "Official Schedule", sourceUpdatedAt: "2026-06-18T08:05:00Z" }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", sourceProvider: "Course Guide", sourceUpdatedAt: "2026-06-18T08:10:00Z" }
    ],
    fields: [
      { eventId: "us-open-2026", playerId: "alpha", status: "active", sourceProvider: "Official Field", sourceUpdatedAt: "2026-06-18T08:20:00Z" }
    ],
    rounds: [
      { eventId: "us-open-2026", playerId: "alpha", courseId: "oakmont", roundNumber: 1, sgTotal: 1.4, sourceProvider: "Official Scoring", sourceUpdatedAt: "2026-06-18T20:00:00Z" }
    ],
    weatherSnapshots: [
      { eventId: "us-open-2026", courseId: "oakmont", windMph: 18, sourceProvider: "Weather Feed", sourceUpdatedAt: "2026-06-18T07:30:00Z" }
    ],
    oddsSnapshots: [
      { eventId: "us-open-2026", playerId: "alpha", market: "winner", oddsAmerican: 500, sourceProvider: "Sportsbook Export", sourceUpdatedAt: "2026-06-18T09:30:00Z" }
    ],
    sourceFetches: [
      { provider: "Official Field", endpoint: "/field/us-open-2026/fields.csv", fetchedAt: "2026-06-18T08:25:00Z", rowCount: 1, status: "ok" },
      { provider: "Official Scoring", endpoint: "/leaderboard/us-open-2026/rounds.csv", fetchedAt: "2026-06-18T20:05:00Z", rowCount: 1, status: "ok" },
      { provider: "Weather Feed", endpoint: "/weather/us-open-2026/weather_snapshots.csv", fetchedAt: "2026-06-18T07:35:00Z", rowCount: 1, status: "ok" },
      { provider: "Sportsbook Export", endpoint: "/odds/us-open-2026/odds_snapshots.csv", fetchedAt: "2026-06-18T09:35:00Z", rowCount: 1, status: "ok" }
    ]
  }, {
    eventId: "us-open-2026",
    now: "2026-06-18T21:00:00Z"
  });

  const fields = board.collectionRows.find((row) => row.key === "fields");
  const rounds = board.collectionRows.find((row) => row.key === "rounds");
  const event = board.eventRows.find((row) => row.eventId === "us-open-2026");
  const scoringProvider = board.providerRows.find((row) => row.provider === "Official Scoring");

  assert.equal(board.selectedEvent.eventName, "U.S. Open");
  assert.ok(board.summary.proofScore >= 70);
  assert.equal(fields.status, "verified");
  assert.equal(rounds.sourceFetches, 1);
  assert.equal(event.status, "verified");
  assert.ok(event.providers.includes("Official Scoring"));
  assert.ok(scoringProvider.collections.includes("rounds"));
  assert.ok(scoringProvider.events.includes("us-open-2026"));
});

test("buildWarehouseValidation: flags duplicate ids and missing model-critical fields", () => {
  const validation = W.buildWarehouseValidation({
    players: [
      { id: "alpha" },
      { id: "alpha", name: "Alpha Player" }
    ],
    rounds: [
      { id: "round-1", playerId: "alpha" }
    ]
  });

  const playerIssues = validation.issues.filter((issue) => issue.collection === "players");
  const roundIssues = validation.issues.filter((issue) => issue.collection === "rounds");
  const players = validation.collections.find((row) => row.key === "players");
  const rounds = validation.collections.find((row) => row.key === "rounds");

  assert.equal(players.duplicateIds, 1);
  assert.equal(players.completeness, 75);
  assert.equal(rounds.status, "issue");
  assert.ok(playerIssues.some((issue) => issue.label === "Players duplicate IDs"));
  assert.ok(playerIssues.some((issue) => issue.label === "Players required fields"));
  assert.ok(roundIssues.some((issue) => issue.label === "Rounds required fields"));
  assert.ok(validation.highIssueCount >= 2);
});

test("buildWarehouseReport: surfaces priority gaps for thin datasets", () => {
  const report = W.buildWarehouseReport({
    players: [{ id: "alpha", name: "Alpha Player" }],
    events: [{ id: "masters-2026", name: "Masters", courseName: "Augusta National" }],
    fields: [{ eventId: "masters-2026", playerId: "missing-player" }]
  });

  assert.equal(report.grade, "building");
  assert.equal(report.events[0].readiness, "needs data");
  assert.ok(report.gaps.some((gap) => gap.label === "Courses missing"));
  assert.ok(report.gaps.some((gap) => gap.label === "Field-player matching"));
  assert.equal(report.coverage.fieldPlayerMatch, 0);
});

test("buildWarehouseReport: handles blank warehouse without crashing", () => {
  const report = W.buildWarehouseReport(G.blankGolfLabState());

  assert.equal(report.score, 0);
  assert.equal(report.grade, "setup");
  assert.equal(report.totalRecords, 0);
  assert.ok(report.gaps.some((gap) => gap.severity === "critical"));
});

test("buildWarehouseCoverageMap: spotlights collection, event, player, and course depth", () => {
  const rounds = Array.from({ length: 16 }, (_, index) => ({
    id: `round-alpha-${index + 1}`,
    eventId: "us-open-2026",
    playerId: "alpha",
    courseId: "oakmont",
    courseName: "Oakmont",
    roundNumber: (index % 4) + 1,
    date: `2026-06-${String(1 + index).padStart(2, "0")}`,
    score: 70 + (index % 3),
    sgTotal: 1.2,
    sourceProvider: "Owned Results",
    sourceUpdatedAt: "2026-06-18T09:00:00Z"
  }));
  const sgRows = Array.from({ length: 8 }, (_, index) => ({
    id: `sg-alpha-${index + 1}`,
    eventId: "us-open-2026",
    playerId: "alpha",
    period: "round",
    sgTotal: 1.4,
    sgT2g: 1.1,
    sourceProvider: "Owned SG",
    sourceUpdatedAt: "2026-06-18T09:10:00Z"
  }));
  const board = W.buildWarehouseCoverageMap({
    players: [
      { id: "alpha", name: "Alpha Player", country: "USA", tour: "PGA", owgrRank: 5, profileUrl: "https://example.com/alpha", sourceProvider: "Owned Profiles", sourceUpdatedAt: "2026-06-18T08:00:00Z" },
      { id: "beta", name: "Beta Player", country: "CAN" }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-18", courseId: "oakmont", courseName: "Oakmont", sourceProvider: "Owned Schedule", sourceUpdatedAt: "2026-06-18T08:05:00Z" }
    ],
    courses: [
      { id: "oakmont", name: "Oakmont", location: "Oakmont, PA", par: 70, yards: 7372, rating: 76, slope: 148, style: "major test", sgDifficulty: 2.4, sourceProvider: "Owned Courses", sourceUpdatedAt: "2026-06-18T08:15:00Z" }
    ],
    courseSetups: [
      { id: "setup-us-open-2026", eventId: "us-open-2026", courseId: "oakmont", par: 70, yards: 7372, rough: "heavy", greenSpeed: "fast", sgDifficulty: 2.4, sourceProvider: "Owned Setup", sourceUpdatedAt: "2026-06-18T08:20:00Z" }
    ],
    fields: [
      { id: "field-alpha", eventId: "us-open-2026", playerId: "alpha", sourceProvider: "Owned Field", sourceUpdatedAt: "2026-06-18T08:30:00Z" },
      { id: "field-beta", eventId: "us-open-2026", playerId: "beta" }
    ],
    rounds,
    strokesGained: sgRows,
    weatherSnapshots: [
      { id: "weather-1", eventId: "us-open-2026", courseId: "oakmont", windMph: 15, temperatureF: 74, forecastAt: "2026-06-18T06:00:00Z", sourceProvider: "Owned Weather", sourceUpdatedAt: "2026-06-18T06:00:00Z" }
    ],
    oddsSnapshots: [
      { id: "odds-alpha", eventId: "us-open-2026", playerId: "alpha", market: "winner", book: "Book A", oddsAmerican: 1400, capturedAt: "2026-06-18T10:00:00Z", sourceProvider: "Owned Odds", sourceUpdatedAt: "2026-06-18T10:00:00Z" }
    ],
    modelPredictions: [
      { id: "pred-alpha", eventId: "us-open-2026", playerId: "alpha", market: "winner", probability: 0.08, rank: 1, createdAt: "2026-06-18T11:00:00Z" }
    ],
    equipmentSnapshots: [
      { id: "bag-alpha", playerId: "alpha", capturedDate: "2026-06-18", driver: "Driver", irons: "Irons", putter: "Putter", sourceProvider: "Owned Bag", sourceUpdatedAt: "2026-06-18T08:45:00Z" }
    ],
    accomplishments: [
      { id: "win-alpha", playerId: "alpha", type: "win", label: "Major champion", season: 2025, sourceProvider: "Owned Results", sourceUpdatedAt: "2026-06-18T08:50:00Z" }
    ],
    sourceFetches: [
      { provider: "Owned Research", endpoint: "us-open-2026", fetchedAt: "2026-06-18T12:00:00Z", rowCount: 32, status: "ok" }
    ]
  }, {
    now: "2026-06-18T12:00:00Z"
  });

  const players = board.collectionRows.find((row) => row.key === "players");
  const event = board.eventRows.find((row) => row.eventId === "us-open-2026");
  const beta = board.playerRows.find((row) => row.playerName === "Beta Player");
  const oakmont = board.courseRows.find((row) => row.courseName === "Oakmont");

  assert.equal(board.summary.eventCount, 1);
  assert.equal(board.summary.modelReadyEvents, 1);
  assert.equal(players.rowCount, 2);
  assert.equal(players.status, "partial");
  assert.equal(event.status, "model-ready");
  assert.ok(beta.gaps.includes("Round/SG history"));
  assert.ok(beta.gaps.includes("Source proof"));
  assert.equal(oakmont.counts.rounds, 16);
  assert.ok(board.nextActions.some((row) => row.label.includes("coverage") || row.label.includes("depth")));
});

test("buildMarketCoverageBoard: audits odds coverage against field and model predictions", () => {
  const board = W.buildMarketCoverageBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" },
      { id: "gamma", name: "Gamma Player" }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-18", courseName: "Oakmont" }
    ],
    fields: [
      { eventId: "us-open-2026", playerId: "alpha" },
      { eventId: "us-open-2026", playerId: "beta" },
      { eventId: "us-open-2026", playerId: "gamma" }
    ],
    oddsSnapshots: [
      { eventId: "us-open-2026", playerId: "alpha", market: "winner", book: "Book A", oddsAmerican: 1200, capturedAt: "2026-06-18T09:00:00Z", sourceProvider: "Odds Feed" },
      { eventId: "us-open-2026", playerId: "beta", market: "winner", book: "Book B", oddsAmerican: 1800, capturedAt: "2026-06-18T09:05:00Z", sourceProvider: "Odds Feed" },
      { eventId: "us-open-2026", playerId: "alpha", market: "top 20", book: "Book A", oddsAmerican: -135, capturedAt: "2026-06-18T09:10:00Z", sourceProvider: "Odds Feed" }
    ],
    modelPredictions: [
      { id: "p-alpha-win", eventId: "us-open-2026", playerId: "alpha", market: "winner", probability: 0.08, rank: 1, createdAt: "2026-06-18T10:00:00Z" },
      { id: "p-beta-win", eventId: "us-open-2026", playerId: "beta", market: "winner", probability: 0.05, rank: 2, createdAt: "2026-06-18T10:00:00Z" },
      { id: "p-gamma-win", eventId: "us-open-2026", playerId: "gamma", market: "winner", probability: 0.03, rank: 3, createdAt: "2026-06-18T10:00:00Z" },
      { id: "p-alpha-top20", eventId: "us-open-2026", playerId: "alpha", market: "top 20", probability: 0.62, rank: 1, createdAt: "2026-06-18T10:00:00Z" },
      { id: "p-gamma-top20", eventId: "us-open-2026", playerId: "gamma", market: "top 20", probability: 0.41, rank: 2, createdAt: "2026-06-18T10:00:00Z" }
    ],
    sourceFetches: [
      { provider: "Odds Feed", endpoint: "markets/us-open-2026", fetchedAt: "2026-06-18T09:15:00Z", rowCount: 3, status: "ok" }
    ]
  }, {
    eventId: "us-open-2026",
    now: "2026-06-18T12:00:00Z"
  });

  const winner = board.marketRows.find((row) => row.marketKey === "winner");
  const top20 = board.marketRows.find((row) => row.marketKey === "top20");
  const makeCut = board.marketRows.find((row) => row.marketKey === "makecut");

  assert.equal(board.selectedEvent.name, "U.S. Open");
  assert.equal(board.summary.pricedMarkets, 2);
  assert.equal(board.summary.uniquePricedPlayers, 2);
  assert.equal(board.summary.bookCount, 2);
  assert.equal(winner.pricedPlayers, 2);
  assert.equal(winner.predictedPlayers, 3);
  assert.equal(winner.fieldCoverage, 67);
  assert.equal(winner.predictionCoverage, 67);
  assert.deepEqual(winner.missingPredictions, ["Gamma Player"]);
  assert.equal(top20.status, "partial");
  assert.deepEqual(top20.books, ["Book A"]);
  assert.equal(makeCut.status, "empty");
});

test("buildOddsMovementBoard: tracks timestamped market line movement", () => {
  const board = W.buildOddsMovementBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-18", courseName: "Oakmont" },
      { id: "travelers-2026", name: "Travelers", startDate: "2026-06-25", courseName: "TPC River Highlands" }
    ],
    oddsSnapshots: [
      { eventId: "us-open-2026", playerId: "alpha", market: "winner", book: "Book A", oddsAmerican: 1600, capturedAt: "2026-06-18T09:00:00Z", sourceProvider: "Owned Odds" },
      { eventId: "us-open-2026", playerId: "alpha", market: "winner", book: "Book A", oddsAmerican: 600, capturedAt: "2026-06-18T11:00:00Z", sourceProvider: "Owned Odds" },
      { eventId: "us-open-2026", playerId: "beta", market: "winner", book: "Book A", oddsAmerican: 500, capturedAt: "2026-06-18T09:00:00Z", sourceProvider: "Owned Odds" },
      { eventId: "us-open-2026", playerId: "beta", market: "winner", book: "Book A", oddsAmerican: 650, capturedAt: "2026-06-18T11:00:00Z", sourceProvider: "Owned Odds" },
      { eventId: "us-open-2026", playerId: "alpha", market: "top 20", book: "Book B", oddsAmerican: -110, capturedAt: "2026-06-18T09:30:00Z", sourceProvider: "Owned Odds" },
      { eventId: "us-open-2026", playerId: "alpha", market: "top 20", book: "Book B", oddsAmerican: -150, capturedAt: "2026-06-18T11:30:00Z", sourceProvider: "Owned Odds" },
      { eventId: "travelers-2026", playerId: "alpha", market: "winner", book: "Book A", oddsAmerican: 900, capturedAt: "2026-06-18T11:30:00Z", sourceProvider: "Owned Odds" }
    ]
  }, {
    eventId: "us-open-2026",
    now: "2026-06-18T12:00:00Z"
  });

  const winner = board.marketRows.find((row) => row.marketKey === "winner");
  const top20 = board.marketRows.find((row) => row.marketKey === "top20");

  assert.equal(board.selectedEvent.name, "U.S. Open");
  assert.equal(board.summary.snapshots, 6);
  assert.equal(board.summary.trackedLines, 3);
  assert.equal(board.summary.markets, 2);
  assert.equal(board.summary.players, 2);
  assert.equal(board.summary.books, 2);
  assert.equal(board.summary.steam, 2);
  assert.equal(board.summary.drift, 1);
  assert.equal(board.rows[0].playerName, "Alpha Player");
  assert.equal(board.rows[0].marketKey, "winner");
  assert.equal(board.rows[0].movement, "steam");
  assert.ok(board.rows[0].impliedDelta > 0.08);
  assert.equal(board.rows[0].bestOddsAmerican, 1600);
  assert.equal(board.rows[0].worstOddsAmerican, 600);
  assert.equal(winner.trackedLines, 2);
  assert.equal(winner.steam, 1);
  assert.equal(winner.drift, 1);
  assert.deepEqual(winner.books, ["Book A"]);
  assert.equal(top20.trackedLines, 1);
  assert.equal(top20.steam, 1);
});

test("buildOddsShoppingBoard: finds best book prices and model edge lift", () => {
  const board = W.buildOddsShoppingBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    events: [
      { id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-18", courseName: "Oakmont" }
    ],
    oddsSnapshots: [
      { eventId: "us-open-2026", playerId: "alpha", market: "winner", book: "Book A", oddsAmerican: 1200, capturedAt: "2026-06-18T09:00:00Z" },
      { eventId: "us-open-2026", playerId: "alpha", market: "winner", book: "Book B", oddsAmerican: 1600, capturedAt: "2026-06-18T09:05:00Z" },
      { eventId: "us-open-2026", playerId: "beta", market: "winner", book: "Book A", oddsAmerican: 500, capturedAt: "2026-06-18T09:00:00Z" },
      { eventId: "us-open-2026", playerId: "beta", market: "winner", book: "Book B", oddsAmerican: 650, capturedAt: "2026-06-18T09:05:00Z" },
      { eventId: "us-open-2026", playerId: "alpha", market: "top 20", book: "Book A", oddsAmerican: -120, capturedAt: "2026-06-18T09:10:00Z" },
      { eventId: "us-open-2026", playerId: "alpha", market: "top 20", book: "Book B", oddsAmerican: 100, capturedAt: "2026-06-18T09:15:00Z" }
    ],
    modelPredictions: [
      { id: "pred-alpha-win", eventId: "us-open-2026", playerId: "alpha", market: "winner", probability: 0.09, fairOddsAmerican: 1011, createdAt: "2026-06-18T10:00:00Z" },
      { id: "pred-beta-win", eventId: "us-open-2026", playerId: "beta", market: "winner", probability: 0.12, fairOddsAmerican: 733, createdAt: "2026-06-18T10:00:00Z" },
      { id: "pred-alpha-top20", eventId: "us-open-2026", playerId: "alpha", market: "top 20", probability: 0.62, fairOddsAmerican: -163, createdAt: "2026-06-18T10:00:00Z" }
    ]
  }, {
    eventId: "us-open-2026",
    now: "2026-06-18T12:00:00Z"
  });

  const alphaWinner = board.lineRows.find((row) => row.playerId === "alpha" && row.marketKey === "winner");
  const alphaTop20 = board.lineRows.find((row) => row.playerId === "alpha" && row.marketKey === "top20");
  const betaWinner = board.lineRows.find((row) => row.playerId === "beta" && row.marketKey === "winner");

  assert.equal(board.summary.lines, 3);
  assert.equal(board.summary.books, 2);
  assert.equal(board.summary.bestEdges, 2);
  assert.equal(alphaWinner.bestBook, "Book B");
  assert.equal(alphaWinner.bestOddsAmerican, 1600);
  assert.equal(alphaWinner.status, "edge");
  assert.ok(alphaWinner.edgeAtBest > 0.03);
  assert.ok(alphaWinner.bestLift > 0.008);
  assert.equal(alphaTop20.bestBook, "Book B");
  assert.equal(alphaTop20.bestOddsAmerican, 100);
  assert.equal(betaWinner.status, "overpriced");
  assert.equal(board.bookRows[0].lines, 3);
});

test("buildGolfLabTemplate: exports every collection and column contract", () => {
  const template = W.buildGolfLabTemplate({
    createdAt: "2026-06-18T12:00:00Z",
    provider: "Owned Research"
  });

  assert.equal(template.meta.version, W.WAREHOUSE_VERSION);
  assert.equal(template.source.provider, "Owned Research");
  G.COLLECTION_KEYS.forEach((key) => {
    assert.ok(Array.isArray(template.golfLab[key]), `${key} should be an import array`);
    assert.ok(Array.isArray(template.collectionColumns[key]), `${key} should have columns`);
  });
  assert.ok(template.collectionColumns.weatherSnapshots.includes("windMph"));
  assert.ok(template.collectionColumns.players.includes("dataGolfId"));
  assert.ok(template.collectionColumns.players.includes("college"));
  assert.ok(template.collectionColumns.equipmentSnapshots.includes("apparel"));
  assert.ok(template.collectionColumns.modelPredictions.includes("modelRunId"));
  assert.ok(template.collectionColumns.modelPredictions.includes("modelProfile"));
  assert.ok(template.collectionColumns.modelPredictions.includes("modelWeatherScenario"));
  assert.ok(template.collectionColumns.sourceFetches.includes("manifestJson"));
  assert.ok(template.collectionColumns.predictionLedger.includes("modelProfile"));
  assert.ok(template.collectionColumns.predictionLedger.includes("modelWeatherLabel"));
});

test("parseGolfLabCsv: parses quoted CSV and normalizes headers", () => {
  const rows = W.parseGolfLabCsv([
    "Player ID,Player Name,Country,Source URL",
    "alpha,\"Alpha, Player\",USA,https://example.com/alpha",
    "beta,\"Beta \"\"B\"\" Player\",CAN,https://example.com/beta"
  ].join("\n"));

  assert.deepEqual(rows, [
    {
      playerId: "alpha",
      playerName: "Alpha, Player",
      country: "USA",
      sourceUrl: "https://example.com/alpha"
    },
    {
      playerId: "beta",
      playerName: "Beta \"B\" Player",
      country: "CAN",
      sourceUrl: "https://example.com/beta"
    }
  ]);
});

test("collectionKeyFromFileName: infers owned warehouse collection names", () => {
  assert.equal(W.collectionKeyFromFileName("players.csv"), "players");
  assert.equal(W.collectionKeyFromFileName("golf_lab_weather_snapshots.csv"), "weatherSnapshots");
  assert.equal(W.collectionKeyFromFileName("owned-golf-strokes-gained.csv"), "strokesGained");
  assert.equal(W.collectionKeyFromFileName("prediction-ledger.csv"), "predictionLedger");
  assert.equal(W.collectionKeyFromFileName("unknown-table.csv"), "");
});

test("buildGolfLabImportSnapshot: accepts single collection record bundles", () => {
  const snapshot = W.buildGolfLabImportSnapshot({
    collection: "players",
    records: [{ id: "alpha", name: "Alpha Player" }]
  }, {
    provider: "Manual table",
    endpoint: "players.csv",
    fetchedAt: "2026-06-18T13:00:00Z"
  });

  assert.equal(snapshot.golfLab.players.length, 1);
  assert.equal(snapshot.golfLab.players[0].id, "alpha");
  assert.equal(snapshot.golfLab.sourceFetches[0].provider, "Manual table");
});
