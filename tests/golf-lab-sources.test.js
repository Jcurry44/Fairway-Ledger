/*
 * Unit tests for lib/golf-lab-sources.js - owned source playbook helpers.
 *
 * Run:  node --test tests/golf-lab-sources.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../lib/golf-lab.js");
const S = require("../lib/golf-lab-sources.js");

function taskById(plan, id) {
  return plan.tasks.find((task) => task.id === id);
}

test("buildEventSourcePlan: turns a blank warehouse into critical source tasks", () => {
  const plan = S.buildEventSourcePlan(G.blankGolfLabState());

  assert.equal(plan.event, null);
  assert.equal(plan.score, 0);
  assert.equal(plan.totalTasks, S.SOURCE_PLAYBOOK.length);
  assert.equal(taskById(plan, "event-schedule").status, "missing");
  assert.equal(taskById(plan, "event-schedule").sourceProof.status, "missing");
  assert.equal(taskById(plan, "player-profiles").status, "missing");
  assert.ok(plan.nextActions.some((task) => task.id === "event-schedule"));
});

test("buildEventSourcePlan: scores a source-backed event queue", () => {
  const players = [
    { id: "alpha", name: "Alpha Player" },
    { id: "beta", name: "Beta Player" }
  ];
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
    toPar: index % 3
  }));
  const plan = S.buildEventSourcePlan({
    players,
    events: [{
      id: "us-open-2026",
      name: "U.S. Open",
      startDate: "2026-06-19",
      courseId: "oakmont",
      courseName: "Oakmont"
    }],
    courses: [{ id: "oakmont", name: "Oakmont", par: 70, fieldAdjustedToPar: 2.2 }],
    courseSetups: [{ eventId: "us-open-2026", courseId: "oakmont", rough: "Heavy" }],
    fields,
    rounds,
    weatherSnapshots: [{ eventId: "us-open-2026", courseId: "oakmont", windMph: 18 }],
    oddsSnapshots: [{ eventId: "us-open-2026", playerId: "alpha", market: "winner", oddsAmerican: 700 }],
    equipmentSnapshots: [{ playerId: "alpha", driver: "TaylorMade Qi10" }],
    accomplishments: [{ playerId: "alpha", label: "Major champion" }],
    sourceFetches: [
      { id: "us-open-2026-field-list-source", provider: "PGA Tour", endpoint: "official field page", fetchedAt: "2026-06-18T12:00:00Z", status: "ok", rowCount: 156, sourceUrl: "https://example.com/field" },
      { id: "us-open-2026-markets-source", provider: "Sportsbook", endpoint: "sportsbook odds history", status: "planned" }
    ]
  }, { eventId: "us-open-2026" });

  assert.equal(plan.event.name, "U.S. Open");
  assert.equal(plan.score, 100);
  assert.equal(plan.readyCount, plan.totalTasks);
  assert.equal(taskById(plan, "field-list").status, "ready");
  assert.equal(taskById(plan, "field-list").sourceProof.status, "ready");
  assert.equal(taskById(plan, "field-list").sourceProof.providers[0], "PGA Tour");
  assert.equal(taskById(plan, "field-list").sourceProof.rowCount, 156);
  assert.equal(taskById(plan, "markets").sourceProof.status, "planned");
  assert.equal(plan.sourceReadyCount, 1);
  assert.equal(taskById(plan, "field-list").suggestedFileName, "u-s-open-fields.csv");
  assert.deepEqual(taskById(plan, "weather").columns.weatherSnapshots.includes("windMph"), true);
});

test("buildEventSourcePlan: links planned event-kit source ledger rows to research tasks", () => {
  const plan = S.buildEventSourcePlan({
    events: [{ id: "masters-2026", name: "Masters", startDate: "2026-04-09" }],
    sourceFetches: [
      { id: "masters-2026-event-schedule-source", provider: "Owned Research", endpoint: "official tour schedule", status: "planned" },
      { id: "masters-2026-weather-source", provider: "Owned Research", endpoint: "weather observations / forecast archive", status: "planned" }
    ]
  }, { eventId: "masters-2026" });

  assert.equal(taskById(plan, "event-schedule").sourceProof.status, "planned");
  assert.equal(taskById(plan, "event-schedule").sourceProof.ledgerRows, 1);
  assert.equal(taskById(plan, "weather").sourceProof.status, "planned");
  assert.equal(taskById(plan, "field-list").sourceProof.status, "missing");
});

test("buildSourceOpsBoard: promotes source proof into refresh risk and alerts", () => {
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
    toPar: index % 3
  }));
  const board = S.buildSourceOpsBoard({
    players: [
      { id: "alpha", name: "Alpha Player", sourceProvider: "PGA Tour", sourceUpdatedAt: "2026-06-17T10:00:00Z" },
      { id: "beta", name: "Beta Player", sourceProvider: "PGA Tour", sourceUpdatedAt: "2026-06-17T10:00:00Z" }
    ],
    events: [{ id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-19", courseId: "oakmont", courseName: "Oakmont" }],
    courses: [{ id: "oakmont", name: "Oakmont", par: 70, fieldAdjustedToPar: 2.2, sourceProvider: "USGA", sourceUpdatedAt: "2026-06-10T10:00:00Z" }],
    courseSetups: [{ eventId: "us-open-2026", courseId: "oakmont", rough: "Heavy" }],
    fields,
    rounds,
    weatherSnapshots: [{ eventId: "us-open-2026", courseId: "oakmont", windMph: 18 }],
    oddsSnapshots: [{ eventId: "us-open-2026", playerId: "alpha", market: "winner", oddsAmerican: 700 }],
    equipmentSnapshots: [{ playerId: "alpha", driver: "TaylorMade Qi10" }],
    accomplishments: [{ playerId: "alpha", label: "Major champion" }],
    sourceFetches: [
      { id: "us-open-2026-field-list-source", provider: "PGA Tour", endpoint: "official field page", fetchedAt: "2026-06-18T12:00:00Z", status: "ok", rowCount: 156, sourceUrl: "https://example.com/field" },
      { id: "us-open-2026-markets-source", provider: "Sportsbook", endpoint: "sportsbook odds history", status: "planned" }
    ]
  }, {
    eventId: "us-open-2026",
    now: "2026-06-20T12:00:00Z"
  });

  const fieldTask = board.tasks.find((task) => task.id === "field-list");
  const marketTask = board.tasks.find((task) => task.id === "markets");
  const weatherTask = board.tasks.find((task) => task.id === "weather");

  assert.equal(board.event.name, "U.S. Open");
  assert.equal(board.summary.tasks, S.SOURCE_PLAYBOOK.length);
  assert.equal(fieldTask.status, "fresh");
  assert.equal(fieldTask.sourceProof.status, "ready");
  assert.equal(marketTask.status, "planned");
  assert.equal(weatherTask.status, "review");
  assert.ok(board.alerts.some((alert) => alert.label === "Market Odds"));
  assert.ok(board.recentFetches.some((row) => row.provider === "PGA Tour"));
  assert.ok(board.opsScore > 0);
  assert.equal(board.summary.proofReady, 1);
});

test("buildSourceCatalogBoard: maps source lanes into an operator manifest", () => {
  const fields = Array.from({ length: 20 }, (_, index) => ({
    eventId: "us-open-2026",
    playerId: index % 2 === 0 ? "alpha" : "beta",
    status: "active"
  }));
  const board = S.buildSourceCatalogBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    events: [{ id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-19", courseId: "oakmont", courseName: "Oakmont" }],
    fields,
    sourceFetches: [
      { id: "us-open-2026-field-list-source", provider: "PGA Tour", endpoint: "official field page", fetchedAt: "2026-06-18T12:00:00Z", status: "ok", rowCount: 156, sourceUrl: "https://example.com/field" },
      { id: "us-open-2026-markets-source", provider: "Sportsbook", endpoint: "sportsbook odds history", status: "planned" }
    ]
  }, {
    eventId: "us-open-2026",
    now: "2026-06-19T12:00:00Z"
  });

  const fieldLane = board.rows.find((row) => row.id === "field-list");
  const marketLane = board.rows.find((row) => row.id === "markets");

  assert.equal(board.event.name, "U.S. Open");
  assert.equal(board.summary.tasks, S.SOURCE_PLAYBOOK.length);
  assert.equal(board.summary.sourceUrls, 1);
  assert.equal(fieldLane.status, "ready");
  assert.equal(fieldLane.sourceUrl, "https://example.com/field");
  assert.equal(fieldLane.cadenceDays, 4);
  assert.equal(fieldLane.targetCollections[0].key, "fields");
  assert.equal(marketLane.status, "needed");
  assert.equal(marketLane.collectionFiles, "odds.csv");
  assert.equal(marketLane.nextAction.includes("odds.csv"), true);
  assert.ok(board.nextActions.some((row) => row.id === "markets"));
  assert.ok(board.score > 0);
});

test("buildDataIntakeBoard: turns source lanes into adapter commands and target files", () => {
  const board = S.buildDataIntakeBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    events: [{ id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-19", courseId: "oakmont", courseName: "Oakmont", tour: "PGA Tour", season: "2026" }],
    courses: [{ id: "oakmont", name: "Oakmont", par: 70 }],
    fields: [{ eventId: "us-open-2026", playerId: "alpha", status: "active" }],
    sourceFetches: [
      { id: "us-open-2026-field-list-source", provider: "PGA Tour", endpoint: "official field page", fetchedAt: "2026-06-18T12:00:00Z", status: "ok", rowCount: 156, sourceUrl: "https://example.com/field" }
    ]
  }, {
    eventId: "us-open-2026",
    now: "2026-06-19T12:00:00Z"
  });

  const leaderboard = board.rows.find((row) => row.id === "round-results");
  const markets = board.rows.find((row) => row.id === "markets");
  const course = board.rows.find((row) => row.id === "course-profile");
  const profile = board.rows.find((row) => row.id === "player-profiles");
  const enrichment = board.rows.find((row) => row.id === "enrichment");

  assert.equal(board.event.name, "U.S. Open");
  assert.equal(board.summary.adapterLanes, 8);
  assert.equal(board.summary.manualLanes, 0);
  assert.equal(board.summary.commandsReady, 8);
  assert.equal(board.outputDir, "data/golf-lab/u-s-open");
  assert.equal(board.batchInputDir, "downloads/u-s-open-raw");
  assert.ok(board.batchCommand.includes("node scripts/golf-lab-adapt.js --batch downloads/u-s-open-raw"));
  assert.ok(board.batchCommand.includes("--out data/golf-lab/u-s-open"));
  assert.ok(board.batchCommand.includes("--season 2026"));
  assert.ok(board.batchFileHints.includes("leaderboard"));
  assert.equal(leaderboard.mode, "adapter");
  assert.equal(leaderboard.adapterType, "leaderboard");
  assert.ok(leaderboard.command.includes("node scripts/golf-lab-adapt.js --type leaderboard"));
  assert.ok(leaderboard.command.includes("--event-id us-open-2026"));
  assert.ok(leaderboard.command.includes('--event-name "U.S. Open"'));
  assert.ok(leaderboard.command.includes("--season 2026"));
  assert.ok(leaderboard.command.includes('--provider "official leaderboard / stat pages"'));
  assert.deepEqual(leaderboard.requiredHeaders.slice(0, 4), ["Player Name", "Round", "Score", "To Par"]);
  assert.ok(leaderboard.targetFiles.includes("rounds.csv"));
  assert.ok(leaderboard.targetFiles.includes("strokes_gained.csv"));
  assert.ok(leaderboard.targetFiles.includes("source_fetches.csv"));
  assert.equal(leaderboard.rawFileName, "downloads/u-s-open-leaderboard.csv");
  assert.ok(leaderboard.sourceRecipe.primarySource.includes("Official leaderboard"));
  assert.ok(leaderboard.sourceRecipe.proofRule.includes("source ledger"));
  assert.ok(leaderboard.sourceRecipe.qualityGates.some((gate) => gate.includes("official leaderboard")));
  assert.equal(markets.adapterType, "odds");
  assert.equal(markets.sourceRecipe.publicLane, "mixed");
  assert.ok(markets.targetFiles.includes("odds_snapshots.csv"));
  assert.equal(course.mode, "adapter");
  assert.equal(course.adapterType, "course");
  assert.ok(course.targetFiles.includes("course_setups.csv"));
  assert.equal(profile.adapterType, "profile");
  assert.ok(profile.targetFiles.includes("players.csv"));
  assert.equal(enrichment.adapterType, "enrichment");
  assert.ok(enrichment.targetFiles.includes("equipment_snapshots.csv"));
  assert.ok(enrichment.targetFiles.includes("accomplishments.csv"));
  assert.ok(board.priorityRows.some((row) => row.id === "round-results"));
  assert.ok(board.score > 0);
});

test("buildAcquisitionRunbook: gives public-first source recipes and proof gates", () => {
  const runbook = S.buildAcquisitionRunbook({
    players: [{ id: "alpha", name: "Alpha Player" }],
    events: [{ id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-19", courseId: "oakmont", courseName: "Oakmont", tour: "PGA Tour", season: "2026" }],
    courses: [{ id: "oakmont", name: "Oakmont", par: 70 }],
    fields: [{ eventId: "us-open-2026", playerId: "alpha", status: "active" }],
    sourceFetches: [
      { id: "us-open-2026-field-list-source", provider: "PGA Tour", endpoint: "official field page", fetchedAt: "2026-06-18T12:00:00Z", status: "ok", rowCount: 156, sourceUrl: "https://example.com/field" }
    ]
  }, {
    eventId: "us-open-2026",
    now: "2026-06-19T12:00:00Z"
  });

  const field = runbook.rows.find((row) => row.id === "field-list");
  const weather = runbook.rows.find((row) => row.id === "weather");
  const markets = runbook.rows.find((row) => row.id === "markets");

  assert.equal(runbook.event.name, "U.S. Open");
  assert.equal(runbook.batchInputDir, "downloads/u-s-open-raw");
  assert.equal(runbook.summary.lanes, S.SOURCE_PLAYBOOK.length);
  assert.equal(runbook.summary.publicFirst, 7);
  assert.equal(runbook.summary.mixedCost, 1);
  assert.equal(runbook.summary.adapterLanes, 8);
  assert.equal(field.primarySource, "Official tournament field page");
  assert.ok(field.searchQuery.includes("U.S. Open"));
  assert.ok(field.rawFileName.endsWith("field.csv"));
  assert.ok(field.proofFields.includes("sourceUrl"));
  assert.ok(field.qualityGates.some((gate) => gate.includes("official field")));
  assert.ok(weather.captureSteps.some((step) => step.includes("observed weather")));
  assert.equal(markets.publicLane, "mixed");
  assert.ok(markets.premiumSignal.includes("fair odds"));
  assert.ok(runbook.nextActions.some((row) => row.id === "round-results"));
});

test("buildTournamentActivationPlan: prioritizes source-backed tournament activation", () => {
  const fields = Array.from({ length: 20 }, (_, index) => ({
    eventId: "us-open-2026",
    playerId: index % 2 === 0 ? "alpha" : "beta",
    playerName: index % 2 === 0 ? "Alpha Player" : "Beta Player",
    status: "active"
  }));
  const rounds = Array.from({ length: 12 }, (_, index) => ({
    eventId: "us-open-2026",
    playerId: index % 2 === 0 ? "alpha" : "beta",
    courseId: "oakmont",
    round: (index % 4) + 1,
    toPar: index % 3,
    sourceProvider: "Official leaderboard"
  }));
  const board = S.buildTournamentActivationPlan({
    players: [
      { id: "alpha", name: "Alpha Player", sourceProvider: "PGA Tour", sourceUpdatedAt: "2026-06-17T10:00:00Z" },
      { id: "beta", name: "Beta Player", sourceProvider: "PGA Tour", sourceUpdatedAt: "2026-06-17T10:00:00Z" }
    ],
    events: [{ id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-19", courseId: "oakmont", courseName: "Oakmont" }],
    courses: [{ id: "oakmont", name: "Oakmont", par: 70, yards: 7350, sourceProvider: "USGA", sourceUpdatedAt: "2026-06-10T10:00:00Z" }],
    courseSetups: [{ eventId: "us-open-2026", courseId: "oakmont", rough: "Heavy", sourceProvider: "USGA" }],
    fields,
    rounds,
    strokesGained: [{ eventId: "us-open-2026", playerId: "alpha", sgTotal: 1.2 }],
    weatherSnapshots: [{ eventId: "us-open-2026", courseId: "oakmont", windMph: 18 }],
    oddsSnapshots: [{ eventId: "us-open-2026", playerId: "alpha", market: "winner", oddsAmerican: 700 }],
    sourceFetches: [
      { id: "us-open-2026-event-schedule-source", provider: "USGA", endpoint: "official tour schedule", fetchedAt: "2026-06-18T12:00:00Z", status: "ok", rowCount: 1, sourceUrl: "https://example.com/schedule" },
      { id: "us-open-2026-field-list-source", provider: "PGA Tour", endpoint: "official field page", fetchedAt: "2026-06-18T12:00:00Z", status: "ok", rowCount: 156, sourceUrl: "https://example.com/field" },
      { id: "us-open-2026-markets-source", provider: "Sportsbook", endpoint: "sportsbook odds history", status: "planned" }
    ]
  }, {
    eventId: "us-open-2026",
    now: "2026-06-19T12:00:00Z"
  });

  const fieldLane = board.lanes.find((lane) => lane.id === "field-matching");
  const modelLane = board.lanes.find((lane) => lane.id === "model-output");

  assert.equal(board.event.name, "U.S. Open");
  assert.equal(board.summary.fieldRows, 20);
  assert.equal(board.summary.matchedFieldPlayers, 20);
  assert.equal(fieldLane.status, "ready");
  assert.equal(modelLane.status, "missing");
  assert.equal(board.status, "ready-to-model");
  assert.ok(board.phases.some((phase) => phase.id === "model"));
  assert.ok(board.nextActions.some((row) => row.id === "model-output"));
  assert.ok(board.commands.some((row) => row.adapterType === "leaderboard"));
  assert.ok(board.targetFiles.includes("source_fetches.csv"));
});

test("buildDataIntakePacket: exports adapter commands, blank raw templates, and proof checklist", () => {
  const packet = S.buildDataIntakePacket({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    events: [{ id: "us-open-2026", name: "U.S. Open", startDate: "2026-06-19", courseId: "oakmont", courseName: "Oakmont", tour: "PGA Tour" }],
    courses: [{ id: "oakmont", name: "Oakmont", par: 70 }],
    fields: [{ eventId: "us-open-2026", playerId: "alpha", status: "active" }]
  }, {
    eventId: "us-open-2026",
    createdAt: "2026-06-19T12:00:00Z"
  });

  const leaderboardCommand = packet.adapterCommands.find((row) => row.adapterType === "leaderboard");
  const fieldTemplate = packet.rawTemplates.find((row) => row.adapterType === "field");
  const courseTemplate = packet.rawTemplates.find((row) => row.adapterType === "course");
  const enrichmentTemplate = packet.rawTemplates.find((row) => row.adapterType === "enrichment");

  assert.equal(packet.meta.template, "Golf Lab data intake packet");
  assert.equal(packet.meta.eventName, "U.S. Open");
  assert.equal(packet.adapterCommands.length, 8);
  assert.equal(packet.rawTemplates.length, 8);
  assert.equal(packet.manualTemplates.length, 0);
  assert.equal(packet.acquisitionRunbook.summary.publicFirst, 7);
  assert.equal(packet.acquisitionRunbook.summary.mixedCost, 1);
  assert.ok(leaderboardCommand.command.includes("golf-lab-adapt.js --type leaderboard"));
  assert.ok(leaderboardCommand.primarySource.includes("Official leaderboard"));
  assert.ok(leaderboardCommand.proofRule.includes("source ledger"));
  assert.ok(fieldTemplate.csv.startsWith("\"Player Name\",\"Country\",\"OWGR\""));
  assert.equal(fieldTemplate.sourceRecipe.primarySource, "Official tournament field page");
  assert.equal(fieldTemplate.csv.split("\n").length, 2);
  assert.ok(courseTemplate.csv.includes("\"Green Speed\""));
  assert.ok(enrichmentTemplate.csv.includes("\"Accomplishment\""));
  assert.ok(packet.sourceProofChecklist.every((row) => row.requiredFields.includes("sourceUrl")));
  assert.ok(packet.sourceProofChecklist.some((row) => row.id === "field-list" && row.qualityGates.length));
  assert.ok(packet.importChecklist.some((row) => row.includes("Replace SOURCE_URL")));
  assert.ok(packet.importChecklist.some((row) => row.includes("acquisitionRunbook")));
  assert.equal(packet.warehouseHealth.grade, "building");
});

test("buildHistoricalBackfillBoard: prioritizes thin historical tournament datasets", () => {
  const board = S.buildHistoricalBackfillBoard({
    players: [
      { id: "alpha", name: "Alpha Player" },
      { id: "beta", name: "Beta Player" }
    ],
    events: [
      { id: "thin-2024", name: "Thin Open", startDate: "2024-05-10", courseId: "thin-course", courseName: "Thin Club" },
      { id: "rich-2024", name: "Rich Open", startDate: "2024-07-10", courseId: "rich-course", courseName: "Rich Club" }
    ],
    courses: [
      { id: "thin-course", name: "Thin Club" },
      { id: "rich-course", name: "Rich Club" }
    ],
    courseSetups: [{ eventId: "rich-2024", courseId: "rich-course" }],
    fields: [
      { eventId: "thin-2024", playerId: "alpha", status: "active" },
      ...Array.from({ length: 20 }, (_, index) => ({
        eventId: "rich-2024",
        playerId: index % 2 === 0 ? "alpha" : "beta",
        status: "active"
      }))
    ],
    rounds: Array.from({ length: 12 }, (_, index) => ({
      eventId: "rich-2024",
      playerId: index % 2 === 0 ? "alpha" : "beta",
      courseId: "rich-course",
      round: (index % 4) + 1,
      toPar: index % 3
    })),
    strokesGained: [{ eventId: "rich-2024", playerId: "alpha", sgTotal: 1.2 }],
    weatherSnapshots: [{ eventId: "rich-2024", courseId: "rich-course", windMph: 12 }],
    oddsSnapshots: [{ eventId: "rich-2024", playerId: "alpha", market: "winner", oddsAmerican: 900 }],
    equipmentSnapshots: [{ playerId: "alpha", driver: "TaylorMade Qi10" }],
    accomplishments: [{ playerId: "alpha", label: "Major champion" }],
    sourceFetches: [
      { id: "rich-2024-round-results-source", endpoint: "official leaderboard / stat pages rich-2024", fetchedAt: "2024-07-15T12:00:00Z", status: "ok", rowCount: 12, sourceUrl: "https://example.com/rich" }
    ]
  }, {
    now: "2026-06-18T12:00:00Z",
    limit: 2
  });

  assert.equal(board.summary.events, 2);
  assert.equal(board.summary.historicalEvents, 2);
  assert.equal(board.summary.missingRoundResults, 1);
  assert.equal(board.summary.batchCommands, 2);
  assert.equal(board.rows[0].eventId, "thin-2024");
  assert.equal(board.rows[0].stage, "historical");
  assert.equal(board.rows[0].batchInputDir, "downloads/thin-open-raw");
  assert.ok(board.rows[0].batchCommand.includes("golf-lab-adapt.js --batch downloads/thin-open-raw"));
  assert.ok(board.rows[0].missingAdapterTypes.includes("leaderboard"));
  assert.ok(board.rows[0].targetFiles.includes("rounds.csv"));
  assert.ok(board.rows[0].targetFiles.includes("source_fetches.csv"));
  assert.ok(board.rows[0].missingLanes.some((lane) => lane.id === "round-results"));
  assert.ok(board.rows[0].nextAction.includes("Field List"));
  assert.ok(board.rows[0].priorityScore > board.rows[1].priorityScore);
  assert.ok(board.nextActions.some((row) => row.eventId === "thin-2024"));
});

test("buildEventResearchPacket: exports event skeleton and column contracts", () => {
  const packet = S.buildEventResearchPacket({
    events: [{ id: "masters-2026", name: "Masters", startDate: "2026-04-09", courseId: "augusta" }],
    courses: [{ id: "augusta", name: "Augusta National", par: 72 }]
  }, {
    eventId: "masters-2026",
    createdAt: "2026-06-18T12:00:00Z"
  });

  assert.equal(packet.meta.version, S.SOURCE_PLAN_VERSION);
  assert.equal(packet.meta.eventName, "Masters");
  assert.equal(packet.golfLab.events[0].id, "masters-2026");
  assert.equal(packet.golfLab.courses[0].name, "Augusta National");
  assert.equal(packet.warehouseHealth.grade, "building");
  assert.ok(packet.warehouseHealth.sourceFreshness);
  assert.ok(packet.warehouseHealth.validation);
  assert.equal(packet.acquisitionRunbook.event.name, "Masters");
  assert.equal(packet.acquisitionRunbook.summary.publicFirst, 7);
  assert.ok(packet.acquisitionRunbook.rows.some((row) => row.id === "course-profile" && row.searchQuery.includes("Augusta National")));
  assert.ok(packet.collectionColumns.rounds.includes("toPar"));
  assert.ok(packet.sourcePlan.tasks.some((task) => task.id === "round-results"));
});
