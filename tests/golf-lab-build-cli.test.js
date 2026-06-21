/*
 * Unit tests for scripts/golf-lab-build.js - local Golf Lab bundle builder.
 *
 * Run:  node --test tests/golf-lab-build-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  buildGolfLabBundleFromDirectory,
  buildGolfLabLiteBundleFromDirectory,
  buildGolfLabBuildReport,
  writeCsvStarterKit,
  writeEventResearchKit,
  writeJsonFile,
  parseArgs
} = require("../scripts/golf-lab-build.js");

test("parseArgs: reads local bundle builder options", () => {
  const args = parseArgs(["--init", "starter", "--event-kit", "event", "--event-name", "Test Open", "--course-name", "Test Club", "--start-date", "2026-06-18", "--tour", "PGA Tour", "--in", "raw", "--out", "import.json", "--report", "report.json", "--provider", "Owned", "--lite", "--compact"]);

  assert.equal(args.initDir, "starter");
  assert.equal(args.eventKitDir, "event");
  assert.equal(args.eventName, "Test Open");
  assert.equal(args.courseName, "Test Club");
  assert.equal(args.startDate, "2026-06-18");
  assert.equal(args.tour, "PGA Tour");
  assert.equal(args.inputDir, "raw");
  assert.equal(args.outputFile, "import.json");
  assert.equal(args.reportFile, "report.json");
  assert.equal(args.provider, "Owned");
  assert.equal(args.lite, true);
  assert.equal(args.pretty, false);
});

test("writeJsonFile: compact mode streams parseable JSON", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-json-"));
  try {
    const file = path.join(tempRoot, "compact.json");
    const payload = {
      meta: { template: "streamed" },
      rows: Array.from({ length: 20 }, (_, index) => ({
        id: `row-${index}`,
        value: index,
        nested: { label: `Label ${index}` }
      }))
    };
    await writeJsonFile(file, payload, false);
    const text = await fsp.readFile(file, "utf8");
    const parsed = JSON.parse(text);

    assert.equal(text.includes("\n  "), false);
    assert.equal(parsed.rows.length, 20);
    assert.deepEqual(parsed, payload);
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});

test("writeEventResearchKit: writes event-specific source folders", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-event-kit-"));
  try {
    const kit = await writeEventResearchKit(tempRoot, {
      eventName: "Test Open",
      courseName: "Test Club",
      startDate: "2026-06-18",
      tour: "PGA Tour",
      provider: "Owned Research"
    });
    const events = await fsp.readFile(path.join(tempRoot, "events.csv"), "utf8");
    const courses = await fsp.readFile(path.join(tempRoot, "courses.csv"), "utf8");
    const sources = await fsp.readFile(path.join(tempRoot, "source_fetches.csv"), "utf8");
    const sourceCatalog = await fsp.readFile(path.join(tempRoot, "source_catalog.csv"), "utf8");
    const acquisitionRunbook = JSON.parse(await fsp.readFile(path.join(tempRoot, "acquisition_runbook.json"), "utf8"));
    const readme = await fsp.readFile(path.join(tempRoot, "README.md"), "utf8");

    assert.equal(kit.event.name, "Test Open");
    assert.equal(kit.sourceCatalog.file, "source_catalog.csv");
    assert.equal(kit.sourceCatalog.role, "operator-manifest");
    assert.equal(kit.acquisitionRunbook.file, "acquisition_runbook.json");
    assert.equal(kit.acquisitionRunbook.role, "source-acquisition-runbook");
    assert.equal(kit.acquisitionRunbook.rows, 8);
    assert.ok(kit.files.some((file) => file.collection === "fields"));
    assert.ok(kit.files.some((file) => file.collection === "oddsSnapshots"));
    assert.ok(kit.files.some((file) => file.collection === "sourceFetches"));
    assert.ok(events.includes("Test Open"));
    assert.ok(events.includes("2026-06-18"));
    assert.ok(courses.includes("Test Club"));
    assert.ok(sources.includes("planned"));
    assert.ok(sources.includes("official tour schedule"));
    assert.ok(sources.includes("sportsbook odds history"));
    assert.ok(sourceCatalog.startsWith("taskId,label,priority,cadenceDays,status"));
    assert.ok(sourceCatalog.includes("field-list,Field List,high,4,planned"));
    assert.ok(sourceCatalog.includes("Market Odds"));
    assert.ok(sourceCatalog.includes("markets,Market Odds,medium,2,planned"));
    assert.ok(sourceCatalog.includes("sportsbook odds history"));
    assert.ok(sourceCatalog.includes("Test Open"));
    assert.equal(acquisitionRunbook.summary.publicFirst, 7);
    assert.equal(acquisitionRunbook.summary.mixedCost, 1);
    assert.ok(acquisitionRunbook.rows.some((row) => row.id === "field-list" && row.primarySource === "Official tournament field page"));
    assert.ok(readme.includes("Research Checklist"));
    assert.ok(readme.includes("Source Fetch Ledger"));
    assert.ok(readme.includes("Source Catalog"));
    assert.ok(readme.includes("source_catalog.csv"));
    assert.ok(readme.includes("Acquisition Runbook"));
    assert.ok(readme.includes("acquisition_runbook.json"));
    assert.ok(readme.includes("Market Odds"));
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});

test("writeCsvStarterKit: writes header-only files for supported collections", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-starter-"));
  try {
    const kit = await writeCsvStarterKit(tempRoot);
    const players = await fsp.readFile(path.join(tempRoot, "players.csv"), "utf8");
    const weather = await fsp.readFile(path.join(tempRoot, "weather_snapshots.csv"), "utf8");

    assert.equal(kit.files.some((file) => file.collection === "players"), true);
    assert.ok(players.startsWith("id,name,country"));
    assert.ok(weather.includes("windMph"));
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});

test("buildGolfLabBundleFromDirectory: combines collection CSV files into one import bundle", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-build-"));
  try {
    await fsp.writeFile(
      path.join(tempRoot, "players.csv"),
      [
        "playerId,playerName,country",
        "alpha,Alpha Player,USA"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(tempRoot, "events.csv"),
      [
        "eventId,eventName,startDate,courseId,courseName,sourceProvider",
        "event-1,Test Open,2026-06-18,course-1,Test Club,Owned Research"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(tempRoot, "courses.csv"),
      [
        "courseId,courseName,par,yards,rating,slope,fieldAdjustedToPar,style,sourceProvider",
        "course-1,Test Club,70,7200,75.3,140,1.8,major test,Owned Research"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(tempRoot, "course_setups.csv"),
      [
        "eventId,courseId,par,yards,rough,greenSpeed,firmness,fieldAdjustedToPar,sourceProvider",
        "event-1,course-1,70,7350,Heavy,Fast,Firm,2.4,Owned Research"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(tempRoot, "rounds.csv"),
      [
        "eventId,playerId,courseId,round,toPar,sgTotal,sourceProvider",
        "event-1,alpha,course-1,1,-2,1.5,Owned Research"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(tempRoot, "weather_snapshots.csv"),
      [
        "eventId,courseId,round,windMph,gustMph,temperatureF,sourceProvider",
        "event-1,course-1,1,18,26,74,Owned Research"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(tempRoot, "source_catalog.csv"),
      [
        "taskId,label,priority,cadenceDays,status",
        "markets,Market Odds,medium,3,planned"
      ].join("\n"),
      "utf8"
    );

    const bundle = await buildGolfLabBundleFromDirectory(tempRoot, { provider: "Owned Research" });

    assert.equal(bundle.meta.fileCount, 6);
    assert.equal(bundle.golfLab.players[0].name, "Alpha Player");
    assert.equal(bundle.golfLab.events[0].name, "Test Open");
    assert.equal(bundle.golfLab.rounds[0].toPar, -2);
    assert.equal(bundle.golfLab.sourceFetches[0].provider, "Owned Research");
    assert.equal(bundle.importPreview.summary.addedRecords, bundle.report.totalRecords);
    assert.equal(bundle.importPreview.summary.updatedRecords, 0);
    assert.ok(["ready", "thin-proof", "review"].includes(bundle.importPreview.verdict.status));
    assert.equal(bundle.report.counts.players, 1);
    assert.ok(bundle.report.totalRecords >= 4);
    assert.equal(bundle.coverageMap.summary.eventCount, 1);
    assert.equal(bundle.sourceOpsBoard.summary.tasks > 0, true);
    assert.equal(bundle.sourceLineageBoard.selectedEvent.eventName, "Test Open");
    assert.equal(bundle.sourceLineageBoard.summary.providers, 1);
    assert.ok(bundle.sourceLineageBoard.collectionRows.some((row) => row.key === "rounds" && row.sourceFetches >= 1));
    assert.equal(bundle.playerIdentityBoard.summary.matchRate, 100);
    assert.equal(bundle.playerIdentityBoard.summary.unresolvedRows, 0);
    assert.equal(bundle.playerIdentityBoard.collectionRows.some((row) => row.key === "rounds" && row.matchedRows === 1), true);
    assert.equal(bundle.playerSplitLabBoard.event.name, "Test Open");
    assert.equal(bundle.playerSplitLabBoard.target.fieldMode, "all-players");
    assert.equal(bundle.playerSplitLabBoard.summary.players, 1);
    assert.equal(bundle.playerSplitLabBoard.rows[0].playerName, "Alpha Player");
    assert.equal(bundle.playerSplitLabBoard.rows[0].recommendation, "Major-test fit");
    assert.equal(bundle.courseSetupBoard.event.name, "Test Open");
    assert.equal(bundle.courseSetupBoard.course.courseName, "Test Club");
    assert.equal(bundle.courseSetupBoard.setup.rough, "Heavy");
    assert.equal(bundle.courseSetupBoard.pressureLabel, "Major stress");
    assert.equal(bundle.courseSetupBoard.summary.scoringRounds, 1);
    assert.equal(bundle.tournamentActivationPlan.event.name, "Test Open");
    assert.equal(bundle.tournamentActivationPlan.summary.fieldRows, 0);
    assert.equal(bundle.tournamentActivationPlan.summary.roundRows, 1);
    assert.equal(bundle.tournamentActivationPlan.lanes.some((lane) => lane.id === "model-output"), true);
    assert.equal(bundle.tournamentActivationPlan.nextActions.some((row) => row.id === "field-matching"), true);
    assert.equal(bundle.featureStoreAuditBoard.event.name, "Test Open");
    assert.equal(bundle.featureStoreAuditBoard.summary.players, 1);
    assert.equal(bundle.featureStoreAuditBoard.rows[0].playerName, "Alpha Player");
    assert.equal(bundle.featureStoreAuditBoard.gates.some((gate) => gate.key === "model" && gate.status === "blocked"), true);
    assert.equal(bundle.featureStoreAuditBoard.blockers.includes("Model output missing"), true);
    assert.equal(bundle.dataIntakeBoard.summary.adapterLanes, 8);
    assert.equal(bundle.dataIntakeBoard.summary.commandsReady, 8);
    assert.ok(bundle.dataIntakeBoard.batchCommand.includes("node scripts/golf-lab-adapt.js --batch"));
    assert.ok(bundle.dataIntakeBoard.batchFileHints.includes("leaderboard"));
    assert.ok(bundle.dataIntakeBoard.rows.some((row) => row.adapterType === "leaderboard"));
    assert.ok(bundle.dataIntakeBoard.rows.some((row) => row.adapterType === "course"));
    assert.ok(bundle.dataIntakeBoard.rows.some((row) => row.adapterType === "enrichment"));
    assert.equal(bundle.acquisitionRunbook.summary.publicFirst, 7);
    assert.equal(bundle.acquisitionRunbook.summary.mixedCost, 1);
    assert.ok(bundle.acquisitionRunbook.rows.some((row) => row.id === "round-results" && row.primarySource.includes("Official leaderboard")));
    assert.ok(bundle.acquisitionRunbook.rows.some((row) => row.id === "markets" && row.publicLane === "mixed"));
    assert.equal(bundle.predictionPrepBoard.event.name, "Test Open");
    assert.equal(bundle.predictionPrepBoard.status, "research");
    assert.equal(bundle.predictionPrepBoard.summary.fieldCount, 1);
    assert.equal(bundle.predictionPrepBoard.runBrief.action, "Resolve critical source gates");
    assert.equal(bundle.modelRunHistoryBoard.summary.runs, 0);
    assert.equal(bundle.sourceCatalog.rows.length, bundle.sourceOpsBoard.summary.tasks);
    assert.equal(bundle.sourceCatalog.eventName, "Test Open");
    assert.equal(bundle.historicalBackfillBoard.summary.events, 1);
    assert.equal(bundle.historicalBackfillBoard.rows[0].eventName, "Test Open");
    assert.ok(bundle.historicalBackfillBoard.rows[0].batchCommand.includes("golf-lab-adapt.js --batch"));
    assert.ok(bundle.historicalBackfillBoard.rows[0].targetFiles.includes("fields.csv"));
    assert.equal(bundle.trainingDataset.summary.events, 1);
    assert.equal(bundle.trainingDataset.summary.rows, 1);
    assert.ok(bundle.collectionColumns.rounds.includes("sgTotal"));

    const report = buildGolfLabBuildReport(bundle);
    assert.equal(report.meta.template, "Golf Lab local build report");
    assert.equal(report.summary.totalRecords, bundle.report.totalRecords);
    assert.equal(report.summary.importAddedRecords, bundle.importPreview.summary.addedRecords);
    assert.equal(report.summary.importUpdatedRecords, 0);
    assert.equal(report.summary.importVerdict, bundle.importPreview.verdict.status);
    assert.equal(report.summary.score, bundle.report.score);
    assert.equal(report.summary.sourceOpsScore, bundle.sourceOpsBoard.opsScore);
    assert.equal(report.summary.dataIntakeCommands, bundle.dataIntakeBoard.summary.commandsReady);
    assert.equal(report.summary.dataIntakeAdapterLanes, bundle.dataIntakeBoard.summary.adapterLanes);
    assert.equal(report.summary.acquisitionPublicFirstLanes, bundle.acquisitionRunbook.summary.publicFirst);
    assert.equal(report.summary.acquisitionMixedCostLanes, 1);
    assert.equal(report.summary.acquisitionNeedsProof, bundle.acquisitionRunbook.summary.needsProof);
    assert.equal(report.summary.activationScore, bundle.tournamentActivationPlan.score);
    assert.equal(report.summary.activationStatus, bundle.tournamentActivationPlan.status);
    assert.equal(report.summary.activationReadyLanes, bundle.tournamentActivationPlan.summary.readyLanes);
    assert.equal(report.summary.activationCriticalBlockers, bundle.tournamentActivationPlan.summary.criticalBlockers);
    assert.equal(report.summary.sourceLineageScore, bundle.sourceLineageBoard.summary.proofScore);
    assert.equal(report.summary.sourceLineageStatus, bundle.sourceLineageBoard.summary.status);
    assert.equal(report.summary.sourceLineageBlockers, bundle.sourceLineageBoard.summary.blockers);
    assert.equal(report.summary.playerIdentityScore, bundle.playerIdentityBoard.summary.matchRate);
    assert.equal(report.summary.playerIdentityUnresolved, 0);
    assert.equal(report.summary.playerIdentitySelectedEventUnresolved, 0);
    assert.equal(report.summary.playerSplitLabPlayers, bundle.playerSplitLabBoard.summary.players);
    assert.equal(report.summary.playerSplitLabStrongFits, bundle.playerSplitLabBoard.summary.strongFits);
    assert.equal(report.summary.playerSplitLabBlockers, bundle.playerSplitLabBoard.blockers.length);
    assert.equal(report.summary.courseSetupScore, bundle.courseSetupBoard.setupScore);
    assert.equal(report.summary.courseSetupReadiness, bundle.courseSetupBoard.readiness);
    assert.equal(report.summary.courseSetupPressure, bundle.courseSetupBoard.pressureLabel);
    assert.equal(report.summary.courseSetupBlockers, bundle.courseSetupBoard.blockers.length);
    assert.equal(report.summary.featureStoreScore, bundle.featureStoreAuditBoard.score);
    assert.equal(report.summary.featureStoreReadiness, bundle.featureStoreAuditBoard.readiness);
    assert.equal(report.summary.featureStoreBlockedPlayers, bundle.featureStoreAuditBoard.summary.blockedPlayers);
    assert.equal(report.summary.featureStoreBlockers, bundle.featureStoreAuditBoard.blockers.length);
    assert.equal(report.summary.predictionPrepScore, bundle.predictionPrepBoard.score);
    assert.equal(report.summary.predictionPrepStatus, bundle.predictionPrepBoard.status);
    assert.equal(report.summary.predictionPrepCriticalBlockers, bundle.predictionPrepBoard.summary.criticalBlockers);
    assert.equal(report.summary.modelRunHistoryRuns, 0);
    assert.equal(report.summary.modelRunHistoryManifestRuns, 0);
    assert.equal(report.summary.lineShoppingEdges, 0);
    assert.equal(report.summary.sourceCatalogTasks, bundle.sourceCatalog.rows.length);
    assert.equal(report.summary.backfillPriorityEvents, bundle.historicalBackfillBoard.summary.priorityEvents);
    assert.equal(report.summary.backfillModelReadyEvents, bundle.historicalBackfillBoard.summary.modelReadyEvents);
    assert.equal(report.summary.trainingExamples, bundle.trainingDataset.summary.rows);
    assert.equal(report.summary.trainingFeatureCoverage, bundle.trainingDataset.summary.featureCoverage);
    assert.equal(report.counts.players, 1);
    assert.equal(report.coverageMap.report, undefined);
    assert.equal(report.coverageMap.summary.eventCount, 1);
    assert.equal(report.sourceOpsBoard.warehouseReport, undefined);
    assert.equal(report.sourceOpsBoard.summary.tasks, bundle.sourceOpsBoard.summary.tasks);
    assert.equal(report.sourceLineageBoard.selectedEvent.eventName, "Test Open");
    assert.equal(report.importPreview.summary.addedRecords, bundle.importPreview.summary.addedRecords);
    assert.equal(report.importPreview.verdict.status, bundle.importPreview.verdict.status);
    assert.equal(report.sourceLineageBoard.summary.providers, 1);
    assert.equal(report.sourceLineageBoard.freshness, undefined);
    assert.equal(report.playerIdentityBoard.summary.matchRate, 100);
    assert.equal(report.playerIdentityBoard.collectionRows.some((row) => row.key === "rounds" && row.matchedRows === 1), true);
    assert.equal(report.playerSplitLabBoard.rows[0].playerName, "Alpha Player");
    assert.equal(report.playerSplitLabBoard.rows[0].metrics.tough.display, "+1.50 SG");
    assert.equal(report.courseSetupBoard.course.courseName, "Test Club");
    assert.equal(report.courseSetupBoard.setup.yards, 7350);
    assert.equal(report.courseSetupBoard.dimensions.some((row) => row.label === "Rough" && row.value === "Heavy"), true);
    assert.equal(report.featureStoreAuditBoard.rows[0].playerName, "Alpha Player");
    assert.equal(report.featureStoreAuditBoard.gates.some((gate) => gate.key === "source"), true);
    assert.equal(report.featureStoreAuditBoard.rows[0].parts.some((part) => part.key === "model" && part.status === "blocked"), true);
    assert.equal(report.dataIntakeBoard.summary.commandsReady, 8);
    assert.ok(report.dataIntakeBoard.rows.some((row) => row.command.includes("golf-lab-adapt.js")));
    assert.ok(report.dataIntakeBoard.rows.some((row) => row.sourceRecipe && row.sourceRecipe.primarySource));
    assert.equal(report.acquisitionRunbook.summary.publicFirst, 7);
    assert.ok(report.acquisitionRunbook.rows.some((row) => row.rawFileName && row.proofRule));
    assert.equal(report.tournamentActivationPlan.event.name, "Test Open");
    assert.equal(report.tournamentActivationPlan.lanes.some((lane) => lane.id === "feature-history"), true);
    assert.equal(report.tournamentActivationPlan.commands.some((row) => row.command.includes("golf-lab-adapt.js")), true);
    assert.equal(report.predictionPrepBoard.event.name, "Test Open");
    assert.equal(report.predictionPrepBoard.gates.some((gate) => gate.id === "field"), true);
    assert.equal(report.modelRunHistoryBoard.summary.runs, 0);
    assert.equal(report.sourceCatalog.rows.some((row) => row.label === "Market Odds"), true);
    assert.equal(report.historicalBackfillBoard.summary.events, 1);
    assert.equal(report.historicalBackfillBoard.rows[0].eventName, "Test Open");
    assert.equal(report.trainingDataset.summary.rows, 1);
    assert.equal(report.trainingDataset.rows[0].playerName, "Alpha Player");
    assert.equal(report.oddsShoppingBoard.summary.lines, 0);
    assert.ok(report.sources.some((source) => source.file === "players.csv"));
    assert.equal(report.sources.some((source) => source.file === "source_catalog.csv"), false);
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});

test("buildGolfLabLiteBundleFromDirectory: skips heavy boards for large history bundles", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-build-lite-"));
  try {
    await fsp.writeFile(
      path.join(tempRoot, "players.csv"),
      [
        "id,name,sourceProvider,sourceUrl,sourceUpdatedAt",
        "alpha,Alpha Player,ESPN,https://example.com/scoreboard,2026-06-19T15:00:00Z"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(tempRoot, "events.csv"),
      [
        "id,name,tour,season,startDate,endDate,sourceProvider,sourceUrl,sourceUpdatedAt",
        "event-1,Test Open,PGA TOUR,2025,2025-01-02,2025-01-05,ESPN,https://example.com/scoreboard,2026-06-19T15:00:00Z"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(tempRoot, "fields.csv"),
      [
        "id,eventId,playerId,playerName,status,sourceProvider,sourceUrl,sourceUpdatedAt",
        "field-1,event-1,alpha,Alpha Player,active,ESPN,https://example.com/scoreboard,2026-06-19T15:00:00Z"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(tempRoot, "rounds.csv"),
      [
        "id,eventId,playerId,playerName,roundNumber,date,score,toPar,sourceProvider,sourceUrl,sourceUpdatedAt",
        "round-1,event-1,alpha,Alpha Player,1,2025-01-02,68,-2,ESPN,https://example.com/scoreboard,2026-06-19T15:00:00Z"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(tempRoot, "source_fetches.csv"),
      [
        "id,provider,endpoint,eventId,fetchedAt,status,rowCount,sourceUrl",
        "source-1,ESPN,scoreboard,event-1,2026-06-19T15:00:00Z,ok,1,https://example.com/scoreboard"
      ].join("\n"),
      "utf8"
    );

    const bundle = await buildGolfLabLiteBundleFromDirectory(tempRoot, { provider: "ESPN" });
    const report = buildGolfLabBuildReport(bundle);

    assert.equal(bundle.meta.lite, true);
    assert.equal(bundle.golfLab.rounds.length, 1);
    assert.equal(bundle.report.totalRecords, 5);
    assert.equal(bundle.report.validation.highIssueCount, 1);
    assert.equal(bundle.importPreview.summary.addedRecords, 5);
    assert.equal(bundle.importPreview.verdict.status, "review");
    assert.equal(bundle.coverageMap, undefined);
    assert.equal(bundle.trainingDataset, undefined);
    assert.equal(report.summary.totalRecords, 5);
    assert.equal(report.summary.importAddedRecords, 5);
    assert.equal(report.validation.highIssueCount, 1);
    assert.equal(report.counts.rounds, 1);
    assert.ok(report.gaps.some((gap) => gap.label === "Course coverage"));
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
