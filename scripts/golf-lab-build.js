#!/usr/bin/env node
/*
 * Build one Golf Lab import bundle from a directory of source-backed files.
 *
 * Example:
 *   node scripts/golf-lab-build.js --in data/golf-lab/raw --out data/golf-lab/import.json --provider "Owned Research"
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const GolfLab = require("../lib/golf-lab.js");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const Sources = require("../lib/golf-lab-sources.js");
const Model = require("../lib/golf-lab-model.js");

const AUXILIARY_RESEARCH_FILES = new Set([
  "source_catalog.csv"
]);

const SOURCE_CATALOG_COLUMNS = [
  "taskId",
  "label",
  "priority",
  "cadenceDays",
  "status",
  "sourceType",
  "targetCollections",
  "collectionFiles",
  "eventId",
  "eventName",
  "sourceUrl",
  "owner",
  "notes"
];

function parseArgs(argv) {
  const args = { provider: "Owned Research", pretty: true };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--in") args.inputDir = argv[index += 1];
    else if (token === "--out") args.outputFile = argv[index += 1];
    else if (token === "--report") args.reportFile = argv[index += 1];
    else if (token === "--init") args.initDir = argv[index += 1];
    else if (token === "--event-kit") args.eventKitDir = argv[index += 1];
    else if (token === "--event-id") args.eventId = argv[index += 1];
    else if (token === "--event-name") args.eventName = argv[index += 1];
    else if (token === "--course-id") args.courseId = argv[index += 1];
    else if (token === "--course-name") args.courseName = argv[index += 1];
    else if (token === "--start-date") args.startDate = argv[index += 1];
    else if (token === "--end-date") args.endDate = argv[index += 1];
    else if (token === "--tour") args.tour = argv[index += 1];
    else if (token === "--season") args.season = argv[index += 1];
    else if (token === "--provider") args.provider = argv[index += 1];
    else if (token === "--lite") args.lite = true;
    else if (token === "--compact") args.pretty = false;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-build.js --init <folder>",
    "Usage: node scripts/golf-lab-build.js --event-kit <folder> --event-name <name> [--course-name <name>] [--start-date YYYY-MM-DD] [--tour <tour>]",
    "Usage: node scripts/golf-lab-build.js --in <folder> --out <file> [--report <file>] [--provider <name>] [--lite] [--compact]",
    "",
    "--init writes header-only CSV starter files for every supported collection.",
    "--event-kit writes a tournament research folder with task CSVs and a checklist README.",
    "Reads .json and collection-named .csv files, then writes one Golf Lab import bundle.",
    "--lite skips heavy UI boards for very large historical backfills while preserving data, counts, validation, and provenance.",
    "CSV examples: players.csv, events.csv, rounds.csv, strokes_gained.csv, weather_snapshots.csv, odds.csv"
  ].join("\n");
}

function snakeFileName(key) {
  return String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function csvCell(value) {
  const text = String(value || "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function csvLine(columns, row = {}) {
  return columns.map((column) => csvCell(row[column])).join(",");
}

async function writeCompactJsonFile(filePath, value) {
  const handle = await fsp.open(filePath, "w");
  let buffer = "";
  async function flush(force = false) {
    if (!buffer || (!force && buffer.length < 1048576)) return;
    await handle.write(buffer, null, "utf8");
    buffer = "";
  }
  async function write(chunk) {
    buffer += chunk;
    await flush(false);
  }
  async function writeValue(current) {
    if (current === undefined || typeof current === "function" || typeof current === "symbol") {
      await write("null");
      return;
    }
    if (current === null || typeof current !== "object") {
      await write(JSON.stringify(current));
      return;
    }
    if (Array.isArray(current)) {
      await write("[");
      for (let index = 0; index < current.length; index += 1) {
        if (index) await write(",");
        await writeValue(current[index]);
      }
      await write("]");
      return;
    }
    await write("{");
    let written = 0;
    for (const [key, child] of Object.entries(current)) {
      if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
      if (written) await write(",");
      await write(JSON.stringify(key));
      await write(":");
      await writeValue(child);
      written += 1;
    }
    await write("}");
  }
  try {
    await writeValue(value);
    await write("\n");
    await flush(true);
  } finally {
    await handle.close();
  }
}

async function writeJsonFile(filePath, value, pretty = true) {
  if (pretty) {
    await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
    return;
  }
  await writeCompactJsonFile(filePath, value);
}

async function writeCollectionCsv(outputDir, fileName, collection, rows = []) {
  const columns = Warehouse.COLLECTION_COLUMNS[collection] || [];
  const body = [columns.map(csvCell).join(","), ...rows.map((row) => csvLine(columns, row))].join("\n");
  await fsp.writeFile(path.join(outputDir, fileName), `${body}\n`, "utf8");
  return { collection, file: fileName, columns: columns.length, rows: rows.length };
}

async function writeCsvStarterKit(outputDir) {
  const resolvedOutput = path.resolve(outputDir);
  await fsp.mkdir(resolvedOutput, { recursive: true });
  const files = [];
  for (const [collection, columns] of Object.entries(Warehouse.COLLECTION_COLUMNS)) {
    const fileName = `${snakeFileName(collection)}.csv`;
    files.push(await writeCollectionCsv(resolvedOutput, fileName, collection));
  }
  return {
    outputDir: resolvedOutput,
    files
  };
}

function eventSeedFromOptions(options = {}) {
  const eventName = String(options.eventName || "").trim();
  const eventId = String(options.eventId || "").trim() || slug([options.tour, options.season, eventName].filter(Boolean).join(" ")) || slug(eventName);
  if (!eventName && !eventId) return null;
  return {
    id: eventId || "event-1",
    name: eventName || eventId || "New Tournament",
    tour: options.tour || "",
    season: options.season || "",
    startDate: options.startDate || "",
    endDate: options.endDate || "",
    courseId: options.courseId || slug(options.courseName),
    courseName: options.courseName || "",
    status: "researching",
    sourceProvider: options.provider || "Owned Research"
  };
}

function courseSeedFromOptions(options = {}, eventSeed = null) {
  const courseName = String(options.courseName || "").trim();
  const courseId = String(options.courseId || "").trim() || (eventSeed ? eventSeed.courseId : "") || slug(courseName);
  if (!courseName && !courseId) return null;
  return {
    id: courseId || "course-1",
    name: courseName || courseId || "Course",
    sourceProvider: options.provider || "Owned Research"
  };
}

function courseSetupSeedFromOptions(options = {}, eventSeed = null, courseSeed = null) {
  if (!eventSeed || !courseSeed) return null;
  return {
    id: slug([eventSeed.id, courseSeed.id, "setup"].join(" ")) || "course-setup-1",
    eventId: eventSeed.id,
    courseId: courseSeed.id,
    sourceProvider: options.provider || "Owned Research"
  };
}

function researchKitCollections() {
  const fileMap = new Map();
  Sources.SOURCE_PLAYBOOK.forEach((task) => {
    task.collectionKeys.forEach((collection) => {
      fileMap.set(collection, `${snakeFileName(collection)}.csv`);
    });
  });
  fileMap.set("sourceFetches", "source_fetches.csv");
  return [...fileMap.entries()];
}

function sourceFetchSeedsFromOptions(options = {}, eventSeed = null) {
  const provider = options.provider || "Owned Research";
  const baseId = slug(eventSeed ? eventSeed.id || eventSeed.name : options.eventName || "event-research") || "event-research";
  return Sources.SOURCE_PLAYBOOK.map((task) => ({
    id: `${baseId}-${task.id}-source`,
    provider,
    endpoint: task.sourceType || task.fileName || task.id,
    fetchedAt: "",
    status: "planned",
    rowCount: "",
    sourceUrl: ""
  }));
}

function sourceCatalogCadenceDays(task) {
  if (!task) return 10;
  if (task.id === "markets" || task.id === "weather") return 2;
  if (task.id === "field-list") return 4;
  if (task.id === "round-results") return 14;
  if (task.id === "enrichment") return 30;
  return task.priority === "critical" ? 7 : 10;
}

function sourceCatalogRowsFromPlaybook(options = {}, eventSeed = null) {
  const eventId = eventSeed ? eventSeed.id || "" : "";
  const eventName = eventSeed ? eventSeed.name || "" : "";
  return Sources.SOURCE_PLAYBOOK.map((task) => ({
    taskId: task.id,
    label: task.label,
    priority: task.priority,
    cadenceDays: sourceCatalogCadenceDays(task),
    status: "planned",
    sourceType: task.sourceType,
    targetCollections: task.collectionKeys.join(" | "),
    collectionFiles: task.fileName,
    eventId,
    eventName,
    sourceUrl: "",
    owner: "",
    notes: task.detail
  }));
}

function buildSourceCatalogManifest(options = {}, eventSeed = null) {
  const event = eventSeed || options.event || null;
  return {
    version: Sources.SOURCE_PLAN_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    provider: options.provider || "Owned Research",
    eventId: event ? event.id || "" : "",
    eventName: event ? event.name || "" : "",
    rows: sourceCatalogRowsFromPlaybook(options, event)
  };
}

async function writeSourceCatalog(outputDir, options = {}, eventSeed = null) {
  const manifest = buildSourceCatalogManifest(options, eventSeed);
  const fileName = "source_catalog.csv";
  const body = [
    SOURCE_CATALOG_COLUMNS.map(csvCell).join(","),
    ...manifest.rows.map((row) => csvLine(SOURCE_CATALOG_COLUMNS, row))
  ].join("\n");
  await fsp.writeFile(path.join(outputDir, fileName), `${body}\n`, "utf8");
  return {
    file: fileName,
    role: "operator-manifest",
    columns: SOURCE_CATALOG_COLUMNS.length,
    rows: manifest.rows.length
  };
}

async function writeAcquisitionRunbook(outputDir, seedRows = {}, options = {}, eventSeed = null) {
  const fileName = "acquisition_runbook.json";
  const runbook = Sources.buildAcquisitionRunbook(seedRows, {
    eventId: eventSeed ? eventSeed.id || "" : "",
    createdAt: options.createdAt || new Date().toISOString()
  });
  await fsp.writeFile(path.join(outputDir, fileName), `${JSON.stringify(runbook, null, 2)}\n`, "utf8");
  return {
    file: fileName,
    role: "source-acquisition-runbook",
    rows: runbook.rows.length,
    summary: runbook.summary
  };
}

function researchKitReadme(options, eventSeed, files, sourceCatalog, acquisitionRunbook) {
  const title = eventSeed ? eventSeed.name : "Golf Lab Event Research Kit";
  const tasks = Sources.SOURCE_PLAYBOOK.map((task) =>
    `- [ ] ${task.label}: ${task.detail} (${task.fileName})`
  ).join("\n");
  const fileList = files.map((file) => `- ${file.file}: ${file.collection}, ${file.rows} starter row${file.rows === 1 ? "" : "s"}`).join("\n");
  return [
    `# ${title}`,
    "",
    "Source-backed collection folder for Golf Lab.",
    "",
    "## Event",
    "",
    `- Event ID: ${eventSeed ? eventSeed.id : ""}`,
    `- Tour: ${eventSeed ? eventSeed.tour : ""}`,
    `- Start: ${eventSeed ? eventSeed.startDate : ""}`,
    `- Course: ${eventSeed ? eventSeed.courseName : ""}`,
    "",
    "## Research Checklist",
    "",
    tasks,
    "",
    "## Source Fetch Ledger",
    "",
    "Fill `source_fetches.csv` as each research lane is completed. Keep status, sourceUrl, rowCount, and fetchedAt current so the Source Audit Board can grade provenance and freshness.",
    "",
    "## Source Catalog",
    "",
    `${sourceCatalog ? `Use \`${sourceCatalog.file}\` as the operator manifest for source lane priority, cadence, target files, owner, notes, and working URLs. It is ignored by the build importer; completed proof still belongs in \`source_fetches.csv\`.` : "Use the source catalog as the operator manifest for source lane priority and cadence."}`,
    "",
    "## Acquisition Runbook",
    "",
    `${acquisitionRunbook ? `Use \`${acquisitionRunbook.file}\` for each lane's public-first source recommendation, search cue, capture steps, proof rule, and quality gates.` : "Use the acquisition runbook for source recommendations and proof gates."}`,
    "",
    "## Data Intake",
    "",
    "For schedule, profile, field, course, leaderboard, odds, weather, and enrichment exports, use the Golf Lab Data Intake board or `scripts/golf-lab-adapt.js` to convert source-backed raw CSVs into the collection files in this folder.",
    "",
    "## Files",
    "",
    fileList,
    "",
    "## Build",
    "",
    "```",
    `node scripts/golf-lab-build.js --in \"${path.relative(process.cwd(), path.resolve(options.outputDir || ".")).replace(/\\/g, "/")}\" --out data/golf-lab/import.json --provider \"${options.provider || "Owned Research"}\"`,
    "```",
    ""
  ].join("\n");
}

async function writeEventResearchKit(outputDir, options = {}) {
  const resolvedOutput = path.resolve(outputDir);
  await fsp.mkdir(resolvedOutput, { recursive: true });
  const eventSeed = eventSeedFromOptions(options);
  const courseSeed = courseSeedFromOptions(options, eventSeed);
  const courseSetupSeed = courseSetupSeedFromOptions(options, eventSeed, courseSeed);
  const seedRows = {
    events: eventSeed ? [eventSeed] : [],
    courses: courseSeed ? [courseSeed] : [],
    courseSetups: courseSetupSeed ? [courseSetupSeed] : [],
    sourceFetches: sourceFetchSeedsFromOptions(options, eventSeed)
  };
  const files = [];
  for (const [collection, fileName] of researchKitCollections()) {
    files.push(await writeCollectionCsv(resolvedOutput, fileName, collection, seedRows[collection] || []));
  }
  const sourceCatalog = await writeSourceCatalog(resolvedOutput, options, eventSeed);
  const acquisitionRunbook = await writeAcquisitionRunbook(resolvedOutput, seedRows, options, eventSeed);
  const readme = researchKitReadme({ ...options, outputDir: resolvedOutput }, eventSeed, files, sourceCatalog, acquisitionRunbook);
  await fsp.writeFile(path.join(resolvedOutput, "README.md"), readme, "utf8");
  return {
    outputDir: resolvedOutput,
    event: eventSeed,
    files,
    sourceCatalog,
    acquisitionRunbook,
    readme: "README.md"
  };
}

async function readJsonFile(filePath, provider) {
  const payload = JSON.parse(await fsp.readFile(filePath, "utf8"));
  const snapshot = Warehouse.buildGolfLabImportSnapshot(payload, {
    provider,
    endpoint: path.basename(filePath),
    fetchedAt: new Date().toISOString()
  });
  return {
    golfLab: snapshot.golfLab,
    warnings: snapshot.warnings || [],
    source: {
      file: path.basename(filePath),
      type: "json",
      records: snapshot.report ? snapshot.report.totalRecords : 0
    }
  };
}

async function readCsvFile(filePath) {
  const collection = Warehouse.collectionKeyFromFileName(path.basename(filePath));
  if (!collection) {
    throw new Error(`Could not infer a Golf Lab collection from ${path.basename(filePath)}.`);
  }
  const rows = Warehouse.parseGolfLabCsv(await fsp.readFile(filePath, "utf8"));
  return {
    collection,
    rows,
    source: {
      file: path.basename(filePath),
      type: "csv",
      collection,
      records: rows.length
    }
  };
}

async function listSourceFiles(inputDir) {
  const entries = await fsp.readdir(inputDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(inputDir, entry.name))
    .filter((filePath) => !AUXILIARY_RESEARCH_FILES.has(path.basename(filePath).toLowerCase()))
    .filter((filePath) => [".json", ".csv"].includes(path.extname(filePath).toLowerCase()))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

async function buildGolfLabBundleFromDirectory(inputDir, options = {}) {
  const provider = options.provider || "Owned Research";
  const resolvedInput = path.resolve(inputDir);
  const files = await listSourceFiles(resolvedInput);
  let mergedLab = GolfLab.blankGolfLabState();
  const warnings = [];
  const sources = [];
  const csvTables = {};
  for (const filePath of files) {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === ".json") {
      const result = await readJsonFile(filePath, provider);
      mergedLab = GolfLab.mergeGolfLabStates(mergedLab, result.golfLab);
      warnings.push(...result.warnings);
      sources.push(result.source);
    } else if (extension === ".csv") {
      const result = await readCsvFile(filePath);
      if (!csvTables[result.collection]) csvTables[result.collection] = [];
      result.rows.forEach((row) => csvTables[result.collection].push(row));
      sources.push(result.source);
    }
  }
  if (Object.keys(csvTables).length) {
    const csvSnapshot = Warehouse.buildGolfLabImportSnapshot({
      source: {
        provider,
        endpoint: sources.filter((source) => source.type === "csv").map((source) => source.file).join(", "),
        fetchedAt: new Date().toISOString()
      },
      tables: csvTables
    });
    mergedLab = GolfLab.mergeGolfLabStates(mergedLab, csvSnapshot.golfLab);
    warnings.push(...(csvSnapshot.warnings || []));
  }
  const normalized = GolfLab.normalizeGolfLabState(mergedLab);
  const report = Warehouse.buildWarehouseReport(normalized);
  const importPreview = Warehouse.buildGolfLabImportPreview(GolfLab.blankGolfLabState(), { golfLab: normalized });
  const coverageMap = Warehouse.buildWarehouseCoverageMap(normalized);
  const sourceOpsBoard = Sources.buildSourceOpsBoard(normalized);
  const selectedEventId = sourceOpsBoard.event ? sourceOpsBoard.event.id : "";
  const sourceLineageBoard = Warehouse.buildSourceLineageBoard(normalized, {
    eventId: selectedEventId
  });
  const playerIdentityBoard = GolfLab.buildPlayerIdentityBoard(normalized, {
    eventId: selectedEventId
  });
  const playerSplitLabBoard = GolfLab.buildPlayerSplitLab(normalized, {
    eventId: selectedEventId,
    limit: normalized.players.length || 1,
    courseLimit: 5
  });
  const courseSetupBoard = GolfLab.buildCourseSetupBoard(normalized, {
    eventId: selectedEventId,
    courseLimit: 5,
    playerLimit: 6
  });
  const dataIntakeBoard = Sources.buildDataIntakeBoard(normalized, {
    eventId: selectedEventId
  });
  const acquisitionRunbook = Sources.buildAcquisitionRunbook(normalized, {
    eventId: selectedEventId
  });
  const tournamentActivationPlan = Sources.buildTournamentActivationPlan(normalized, {
    eventId: selectedEventId
  });
  const predictionPrepBoard = Model.buildPredictionPrepBoard(normalized, {
    eventId: selectedEventId,
    market: "all",
    minEdge: 0.01
  });
  const modelRunHistoryBoard = Model.buildModelRunHistoryBoard(normalized, {
    eventId: selectedEventId,
    market: "all",
    maxRows: normalized.modelPredictions.length + normalized.predictionLedger.length || 1
  });
  const featureStoreAuditBoard = Model.buildFeatureStoreAuditBoard(normalized, {
    eventId: selectedEventId,
    market: "all",
    maxFieldSize: normalized.players.length || 1
  });
  const sourceCatalog = buildSourceCatalogManifest({
    provider,
    event: sourceOpsBoard.event
  });
  const historicalBackfillBoard = Sources.buildHistoricalBackfillBoard(normalized, {
    limit: normalized.events.length || 1
  });
  const trainingDataset = Model.buildModelTrainingDataset(normalized, {
    eventLimit: normalized.events.length || 1,
    rowLimit: normalized.rounds.length || 1
  });
  return {
    meta: {
      template: "Golf Lab built import bundle",
      generatedAt: new Date().toISOString(),
      provider,
      inputDir: resolvedInput,
      fileCount: files.length
    },
    sources,
    warnings,
    collectionColumns: Warehouse.COLLECTION_COLUMNS,
    golfLab: normalized,
    report,
    importPreview,
    coverageMap,
    sourceOpsBoard,
    sourceLineageBoard,
    playerIdentityBoard,
    playerSplitLabBoard,
    courseSetupBoard,
    dataIntakeBoard,
    acquisitionRunbook,
    tournamentActivationPlan,
    featureStoreAuditBoard,
    predictionPrepBoard,
    modelRunHistoryBoard,
    sourceCatalog,
    historicalBackfillBoard,
    trainingDataset
  };
}

function gradeFromScore(score) {
  if (score >= 85) return "premium";
  if (score >= 65) return "solid";
  if (score >= 45) return "building";
  return "thin";
}

function countCollections(lab) {
  return Object.keys(Warehouse.COLLECTION_COLUMNS).reduce((counts, collection) => {
    counts[collection] = Array.isArray(lab[collection]) ? lab[collection].length : 0;
    return counts;
  }, {});
}

function sumCounts(counts) {
  return Object.values(counts).reduce((sum, count) => sum + (Number(count) || 0), 0);
}

function pct(value, total) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function buildLiteWarehouseReport(lab) {
  const counts = countCollections(lab);
  const validation = Warehouse.buildWarehouseValidation(lab);
  const sourceFreshness = Warehouse.buildSourceFreshness(lab);
  const eventsWithCourses = lab.events.filter((event) => event.courseId || event.courseName).length;
  const courseCoverage = pct(eventsWithCourses, counts.events);
  const scoreParts = {
    core: counts.players && counts.events && counts.fields && counts.rounds ? 100 : 0,
    matching: counts.players && counts.fields ? Math.min(100, 70 + Math.round(courseCoverage * 0.3)) : 0,
    scoring: counts.rounds && counts.events ? 100 : 0,
    market: counts.oddsSnapshots ? Math.min(100, pct(counts.oddsSnapshots, Math.max(counts.fields, 1))) : 0,
    weather: counts.weatherSnapshots ? Math.min(100, pct(counts.weatherSnapshots, Math.max(counts.events, 1))) : 0,
    sources: sourceFreshness.qualityScore || 0,
    enrichment: Math.min(100, Math.round(((counts.strokesGained ? 40 : 0) + (counts.equipmentSnapshots ? 30 : 0) + (counts.accomplishments ? 30 : 0))))
  };
  const score = Math.round(
    scoreParts.core * 0.24 +
    scoreParts.matching * 0.16 +
    scoreParts.scoring * 0.2 +
    scoreParts.market * 0.1 +
    scoreParts.weather * 0.1 +
    scoreParts.sources * 0.15 +
    scoreParts.enrichment * 0.05
  );
  const gaps = [];
  if (counts.events && courseCoverage < 80) {
    gaps.push({
      severity: courseCoverage ? "medium" : "high",
      label: "Course coverage",
      detail: `${courseCoverage}% of events have verified course metadata.`
    });
  }
  if (!counts.weatherSnapshots) {
    gaps.push({
      severity: "medium",
      label: "Weather coverage",
      detail: "0% of events have weather snapshots."
    });
  }
  if (!counts.oddsSnapshots) {
    gaps.push({
      severity: "medium",
      label: "Market coverage",
      detail: "0% of events have odds snapshots."
    });
  }
  if (validation.highIssueCount) {
    gaps.push({
      severity: "high",
      label: "Validation issues",
      detail: `${validation.highIssueCount} high-priority row validation issue${validation.highIssueCount === 1 ? "" : "s"} detected.`
    });
  }
  return {
    totalRecords: sumCounts(counts),
    score,
    grade: gradeFromScore(score),
    latestSourceAt: sourceFreshness.latestSourceAt || "",
    counts,
    scoreParts,
    sourceFreshness,
    validation,
    gaps,
    oddsShopping: null
  };
}

async function buildGolfLabLiteBundleFromDirectory(inputDir, options = {}) {
  const provider = options.provider || "Owned Research";
  const resolvedInput = path.resolve(inputDir);
  const files = await listSourceFiles(resolvedInput);
  const csvTables = {};
  const warnings = [];
  const sources = [];
  for (const filePath of files) {
    const extension = path.extname(filePath).toLowerCase();
    if (extension !== ".csv") {
      warnings.push(`Lite build skipped non-CSV source file ${path.basename(filePath)}.`);
      continue;
    }
    const result = await readCsvFile(filePath);
    if (!csvTables[result.collection]) csvTables[result.collection] = [];
    result.rows.forEach((row) => csvTables[result.collection].push(row));
    sources.push(result.source);
  }
  const normalized = GolfLab.normalizeGolfLabState(csvTables);
  const report = buildLiteWarehouseReport(normalized);
  const generatedAt = new Date().toISOString();
  const importPreview = {
    version: "golf-lab-import-preview-lite-1",
    generatedAt,
    summary: {
      beforeRecords: 0,
      incomingRecords: report.totalRecords,
      afterRecords: report.totalRecords,
      addedRecords: report.totalRecords,
      updatedRecords: 0,
      skippedRecords: 0,
      scoreBefore: 0,
      scoreAfter: report.score,
      scoreDelta: report.score
    },
    verdict: {
      status: report.validation && report.validation.highIssueCount ? "review" : "ready",
      label: report.validation && report.validation.highIssueCount ? "Review Before Import" : "Ready To Import"
    },
    topCollections: Object.entries(report.counts)
      .filter(([, count]) => count)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([collection, count]) => ({ collection, added: count, updated: 0, after: count })),
    blockers: report.gaps.filter((gap) => gap.severity === "high"),
    nextActions: report.gaps.slice(0, 6).map((gap) => gap.detail)
  };
  return {
    meta: {
      template: "Golf Lab lite built import bundle",
      generatedAt,
      provider,
      inputDir: resolvedInput,
      fileCount: files.length,
      lite: true
    },
    sources,
    warnings,
    collectionColumns: Warehouse.COLLECTION_COLUMNS,
    golfLab: normalized,
    report,
    importPreview,
    sourceLineageBoard: {
      summary: {
        proofScore: report.sourceFreshness ? report.sourceFreshness.qualityScore || 0 : 0,
        status: normalized.sourceFetches.length ? "verified" : "thin",
        blockers: normalized.sourceFetches.length ? 0 : 1
      }
    }
  };
}

function compactCoverageMap(coverageMap) {
  if (!coverageMap || typeof coverageMap !== "object") return null;
  const { report, ...rest } = coverageMap;
  return rest;
}

function compactSourceOpsBoard(sourceOpsBoard) {
  if (!sourceOpsBoard || typeof sourceOpsBoard !== "object") return null;
  const { warehouseReport, sourcePlan, ...rest } = sourceOpsBoard;
  return {
    ...rest,
    sourcePlan: sourcePlan ? {
      version: sourcePlan.version,
      score: sourcePlan.score,
      readyCount: sourcePlan.readyCount,
      sourceReadyCount: sourcePlan.sourceReadyCount,
      totalTasks: sourcePlan.totalTasks,
      nextActions: sourcePlan.nextActions
    } : null
  };
}

function compactDataIntakeBoard(board) {
  if (!board || typeof board !== "object") return null;
  return {
    version: board.version || Sources.SOURCE_PLAN_VERSION,
    generatedAt: board.generatedAt || "",
    event: board.event || null,
    outputDir: board.outputDir || "",
    batchInputDir: board.batchInputDir || "",
    batchCommand: board.batchCommand || "",
    batchFileHints: board.batchFileHints || [],
    score: board.score || 0,
    summary: board.summary || {},
    rows: Array.isArray(board.rows) ? board.rows.map((row) => ({
      id: row.id,
      label: row.label,
      priority: row.priority,
      mode: row.mode,
      adapterType: row.adapterType,
      status: row.status,
      sourceProofStatus: row.sourceProofStatus,
      command: row.command,
      sampleInputFile: row.sampleInputFile,
      rawFileName: row.rawFileName,
      outputDir: row.outputDir,
      targetFiles: row.targetFiles,
      requiredHeaders: row.requiredHeaders,
      sourceRecipe: row.sourceRecipe,
      nextAction: row.nextAction
    })) : [],
    priorityRows: Array.isArray(board.priorityRows) ? board.priorityRows.map((row) => ({
      id: row.id,
      label: row.label,
      priority: row.priority,
      mode: row.mode,
      adapterType: row.adapterType,
      command: row.command,
      nextAction: row.nextAction
    })) : []
  };
}

function compactAcquisitionRunbook(runbook) {
  if (!runbook || typeof runbook !== "object") return null;
  return {
    version: runbook.version || Sources.SOURCE_PLAN_VERSION,
    generatedAt: runbook.generatedAt || "",
    event: runbook.event || null,
    course: runbook.course || null,
    batchInputDir: runbook.batchInputDir || "",
    batchCommand: runbook.batchCommand || "",
    summary: runbook.summary || {},
    rows: Array.isArray(runbook.rows) ? runbook.rows.map((row) => ({
      id: row.id,
      label: row.label,
      priority: row.priority,
      mode: row.mode,
      adapterType: row.adapterType,
      status: row.status,
      sourceProofStatus: row.sourceProofStatus,
      publicLane: row.publicLane,
      confidence: row.confidence,
      primarySource: row.primarySource,
      fallbackSource: row.fallbackSource,
      searchQuery: row.searchQuery,
      rawFileName: row.rawFileName,
      proofRule: row.proofRule,
      qualityGates: row.qualityGates,
      premiumSignal: row.premiumSignal,
      targetFiles: row.targetFiles,
      nextAction: row.nextAction
    })) : [],
    nextActions: Array.isArray(runbook.nextActions) ? runbook.nextActions.map((row) => ({
      id: row.id,
      label: row.label,
      priority: row.priority,
      primarySource: row.primarySource,
      rawFileName: row.rawFileName,
      proofRule: row.proofRule,
      nextAction: row.nextAction
    })) : []
  };
}

function compactImportPreview(preview) {
  if (!preview || typeof preview !== "object") return null;
  return {
    version: preview.version || "",
    generatedAt: preview.generatedAt || "",
    summary: preview.summary || {},
    verdict: preview.verdict || null,
    validationDelta: preview.validationDelta || {},
    topCollections: Array.isArray(preview.topCollections) ? preview.topCollections : [],
    blockers: Array.isArray(preview.blockers) ? preview.blockers.slice(0, 8) : [],
    nextActions: Array.isArray(preview.nextActions) ? preview.nextActions.slice(0, 6) : []
  };
}

function compactTournamentActivationPlan(board) {
  if (!board || typeof board !== "object") return null;
  return {
    version: board.version || Sources.SOURCE_PLAN_VERSION,
    generatedAt: board.generatedAt || "",
    event: board.event || null,
    course: board.course || null,
    status: board.status || "thin",
    statusLabel: board.statusLabel || "",
    score: board.score || 0,
    summary: board.summary || {},
    phases: Array.isArray(board.phases) ? board.phases.map((phase) => ({
      id: phase.id,
      label: phase.label,
      score: phase.score,
      status: phase.status,
      statusLabel: phase.statusLabel,
      detail: phase.detail
    })) : [],
    lanes: Array.isArray(board.lanes) ? board.lanes.map((lane) => ({
      id: lane.id,
      label: lane.label,
      group: lane.group,
      critical: lane.critical,
      score: lane.score,
      status: lane.status,
      statusLabel: lane.statusLabel,
      detail: lane.detail,
      nextAction: lane.nextAction,
      command: lane.command,
      targetFiles: lane.targetFiles
    })) : [],
    nextActions: Array.isArray(board.nextActions) ? board.nextActions : [],
    commands: Array.isArray(board.commands) ? board.commands : [],
    targetFiles: Array.isArray(board.targetFiles) ? board.targetFiles : [],
    blockers: Array.isArray(board.blockers) ? board.blockers : []
  };
}

function compactSourceLineageBoard(board) {
  if (!board || typeof board !== "object") return null;
  return {
    generatedAt: board.generatedAt || "",
    selectedEvent: board.selectedEvent ? {
      eventId: board.selectedEvent.eventId,
      eventName: board.selectedEvent.eventName,
      startDate: board.selectedEvent.startDate,
      courseName: board.selectedEvent.courseName,
      status: board.selectedEvent.status,
      proofScore: board.selectedEvent.proofScore
    } : null,
    summary: board.summary || {},
    blockers: Array.isArray(board.blockers) ? board.blockers : [],
    providerRows: Array.isArray(board.providerRows) ? board.providerRows.map((row) => ({
      provider: row.provider,
      status: row.status,
      latestAt: row.latestAt,
      rowCount: row.rowCount,
      fetches: row.fetches,
      collections: row.collections,
      events: row.events
    })) : [],
    collectionRows: Array.isArray(board.collectionRows) ? board.collectionRows.map((row) => ({
      key: row.key,
      label: row.label,
      role: row.role,
      rowCount: row.rowCount,
      sourcedRows: row.sourcedRows,
      sourceFetches: row.sourceFetches,
      coverage: row.coverage,
      ledgerCoverage: row.ledgerCoverage,
      proofScore: row.proofScore,
      status: row.status,
      latestAt: row.latestAt,
      gaps: row.gaps
    })) : [],
    eventRows: Array.isArray(board.eventRows) ? board.eventRows.map((row) => ({
      eventId: row.eventId,
      eventName: row.eventName,
      startDate: row.startDate,
      courseName: row.courseName,
      sourceFetches: row.sourceFetches,
      linkedRows: row.linkedRows,
      sourcedRows: row.sourcedRows,
      collectionCount: row.collectionCount,
      coverage: row.coverage,
      proofScore: row.proofScore,
      status: row.status,
      providers: row.providers,
      gaps: row.gaps
    })) : []
  };
}

function compactPlayerIdentityBoard(board) {
  if (!board || typeof board !== "object") return null;
  return {
    generatedAt: board.generatedAt || "",
    selectedEvent: board.selectedEvent || null,
    summary: board.summary || {},
    blockers: Array.isArray(board.blockers) ? board.blockers : [],
    collectionRows: Array.isArray(board.collectionRows) ? board.collectionRows.map((row) => ({
      key: row.key,
      label: row.label,
      critical: row.critical,
      rowCount: row.rowCount,
      matchedRows: row.matchedRows,
      exactRows: row.exactRows,
      normalizedRows: row.normalizedRows,
      unresolvedRows: row.unresolvedRows,
      ambiguousRows: row.ambiguousRows,
      eventRows: row.eventRows,
      eventUnresolvedRows: row.eventUnresolvedRows,
      matchRate: row.matchRate,
      status: row.status,
      gaps: row.gaps
    })) : [],
    unresolvedRows: Array.isArray(board.unresolvedRows) ? board.unresolvedRows.slice(0, 25) : [],
    duplicateProfiles: Array.isArray(board.duplicateProfiles) ? board.duplicateProfiles : [],
    aliasConflicts: Array.isArray(board.aliasConflicts) ? board.aliasConflicts : []
  };
}

function compactPlayerSplitLabBoard(board) {
  if (!board || typeof board !== "object") return null;
  const compactRow = (row) => row ? ({
    playerId: row.playerId,
    playerName: row.playerName,
    inField: row.inField,
    splitScore: row.splitScore,
    recommendation: row.recommendation,
    sample: row.sample,
    metrics: row.metrics,
    sourceCoverage: row.sourceCoverage ? {
      score: row.sourceCoverage.score,
      status: row.sourceCoverage.status,
      statusLabel: row.sourceCoverage.statusLabel,
      gaps: row.sourceCoverage.gaps
    } : null,
    eventFit: row.eventFit ? {
      score: row.eventFit.score,
      label: row.eventFit.label,
      inField: row.eventFit.inField,
      gaps: row.eventFit.gaps
    } : null,
    gaps: row.gaps
  }) : null;
  return {
    event: board.event || null,
    course: board.course || null,
    target: board.target || null,
    summary: board.summary || {},
    blockers: Array.isArray(board.blockers) ? board.blockers : [],
    leaders: board.leaders ? {
      overall: compactRow(board.leaders.overall),
      tough: compactRow(board.leaders.tough),
      easy: compactRow(board.leaders.easy),
      weather: compactRow(board.leaders.weather),
      comp: compactRow(board.leaders.comp)
    } : {},
    rows: Array.isArray(board.rows) ? board.rows.map(compactRow) : []
  };
}

function compactCourseSetupBoard(board) {
  if (!board || typeof board !== "object") return null;
  return {
    event: board.event || null,
    course: board.course || null,
    readiness: board.readiness || "thin",
    setupScore: board.setupScore || 0,
    pressureScore: board.pressureScore || 0,
    pressureLabel: board.pressureLabel || "",
    difficulty: board.difficulty || null,
    summary: board.summary || {},
    setup: board.setup ? {
      eventId: board.setup.eventId,
      courseId: board.setup.courseId,
      par: board.setup.par,
      yards: board.setup.yards,
      rough: board.setup.rough,
      greenSpeed: board.setup.greenSpeed,
      firmness: board.setup.firmness,
      weatherNote: board.setup.weatherNote,
      fieldAdjustedToPar: board.setup.fieldAdjustedToPar,
      sgDifficulty: board.setup.sgDifficulty,
      sourceProvider: board.setup.sourceProvider,
      sourceUpdatedAt: board.setup.sourceUpdatedAt
    } : null,
    dimensions: Array.isArray(board.dimensions) ? board.dimensions.map((row) => ({
      label: row.label,
      value: row.value,
      note: row.note,
      critical: row.critical,
      status: row.status
    })) : [],
    signals: Array.isArray(board.signals) ? board.signals.map((row) => ({
      id: row.id,
      label: row.label,
      detail: row.detail,
      tone: row.tone
    })) : [],
    compCourses: Array.isArray(board.compCourses) ? board.compCourses.map((row) => ({
      courseId: row.courseId,
      courseName: row.courseName,
      similarity: row.similarity,
      difficulty: row.difficulty,
      sample: row.sample,
      evidence: row.evidence
    })) : [],
    playerFits: Array.isArray(board.playerFits) ? board.playerFits.map((row) => ({
      playerId: row.playerId,
      playerName: row.playerName,
      inField: row.inField,
      rounds: row.rounds,
      compCourses: row.compCourses,
      avgSg: row.avgSg,
      avgToPar: row.avgToPar,
      fitScore: row.fitScore,
      bestComp: row.bestComp,
      tags: row.tags
    })) : [],
    source: board.source || null,
    blockers: Array.isArray(board.blockers) ? board.blockers : []
  };
}

function compactFeatureStoreAuditBoard(board) {
  if (!board || typeof board !== "object") return null;
  return {
    generatedAt: board.generatedAt || "",
    event: board.event || null,
    course: board.course || null,
    weatherScenario: board.weatherScenario || null,
    marketFilter: board.marketFilter || "all",
    readiness: board.readiness || "thin",
    score: board.score || 0,
    summary: board.summary || {},
    blockers: Array.isArray(board.blockers) ? board.blockers : [],
    gates: Array.isArray(board.gates) ? board.gates.map((gate) => ({
      key: gate.key,
      label: gate.label,
      score: gate.score,
      status: gate.status,
      statusLabel: gate.statusLabel,
      readyPlayers: gate.readyPlayers,
      playerCount: gate.playerCount
    })) : [],
    rows: Array.isArray(board.rows) ? board.rows.map((row) => ({
      playerId: row.playerId,
      playerName: row.playerName,
      matchedProfile: row.matchedProfile,
      fieldStatus: row.fieldStatus,
      score: row.score,
      readiness: row.readiness,
      blockers: Array.isArray(row.blockers) ? row.blockers : [],
      warnings: Array.isArray(row.warnings) ? row.warnings : [],
      sample: row.sample || {},
      features: row.features || {},
      parts: Array.isArray(row.parts) ? row.parts.map((part) => ({
        key: part.key,
        label: part.label,
        score: part.score,
        status: part.status,
        statusLabel: part.statusLabel,
        critical: part.critical,
        sample: part.sample,
        sampleTarget: part.sampleTarget,
        detail: part.detail,
        nextAction: part.nextAction
      })) : []
    })) : []
  };
}

function compactSourceCatalog(sourceCatalog) {
  if (!sourceCatalog || typeof sourceCatalog !== "object") return null;
  const rows = Array.isArray(sourceCatalog.rows) ? sourceCatalog.rows : [];
  return {
    version: sourceCatalog.version || Sources.SOURCE_PLAN_VERSION,
    generatedAt: sourceCatalog.generatedAt || "",
    provider: sourceCatalog.provider || "",
    eventId: sourceCatalog.eventId || "",
    eventName: sourceCatalog.eventName || "",
    rows: rows.map((row) => ({
      taskId: row.taskId,
      label: row.label,
      priority: row.priority,
      cadenceDays: row.cadenceDays,
      status: row.status,
      sourceType: row.sourceType,
      targetCollections: row.targetCollections,
      collectionFiles: row.collectionFiles
    }))
  };
}

function compactHistoricalBackfillBoard(board) {
  if (!board || typeof board !== "object") return null;
  return {
    version: board.version || Sources.SOURCE_PLAN_VERSION,
    generatedAt: board.generatedAt || "",
    summary: board.summary || {},
    rows: Array.isArray(board.rows) ? board.rows.map((row) => ({
      eventId: row.eventId,
      eventName: row.eventName,
      startDate: row.startDate,
      courseName: row.courseName,
      stage: row.stage,
      priorityScore: row.priorityScore,
      readinessScore: row.readinessScore,
      proofScore: row.proofScore,
      counts: row.counts,
      batchInputDir: row.batchInputDir,
      outputDir: row.outputDir,
      batchCommand: row.batchCommand,
      batchFileHints: row.batchFileHints,
      missingAdapterTypes: row.missingAdapterTypes,
      targetFiles: row.targetFiles,
      missingLanes: row.missingLanes,
      nextAction: row.nextAction
    })) : [],
    nextActions: Array.isArray(board.nextActions) ? board.nextActions.map((row) => ({
      eventId: row.eventId,
      eventName: row.eventName,
      priorityScore: row.priorityScore,
      nextAction: row.nextAction
    })) : []
  };
}

function compactPredictionPrepBoard(board) {
  if (!board || typeof board !== "object") return null;
  return {
    generatedAt: board.generatedAt || "",
    event: board.event ? {
      id: board.event.id,
      name: board.event.name,
      startDate: board.event.startDate,
      courseName: board.event.courseName
    } : null,
    course: board.course ? {
      id: board.course.id,
      name: board.course.name
    } : null,
    marketFilter: board.marketFilter || "all",
    status: board.status || "setup",
    statusLabel: board.statusLabel || "",
    score: board.score || 0,
    summary: board.summary || {},
    runBrief: board.runBrief || null,
    gates: Array.isArray(board.gates) ? board.gates.map((gate) => ({
      id: gate.id,
      label: gate.label,
      score: gate.score,
      status: gate.status,
      statusLabel: gate.statusLabel,
      critical: gate.critical,
      detail: gate.detail,
      nextAction: gate.nextAction
    })) : [],
    nextActions: Array.isArray(board.nextActions) ? board.nextActions.map((gate) => ({
      id: gate.id,
      label: gate.label,
      status: gate.status,
      detail: gate.detail,
      nextAction: gate.nextAction
    })) : []
  };
}

function compactModelRunHistoryBoard(board) {
  if (!board || typeof board !== "object") return null;
  return {
    version: board.version || "",
    generatedAt: board.generatedAt || "",
    selectedEvent: board.selectedEvent ? {
      id: board.selectedEvent.id,
      name: board.selectedEvent.name,
      startDate: board.selectedEvent.startDate,
      courseName: board.selectedEvent.courseName
    } : null,
    marketFilter: board.marketFilter || "all",
    summary: board.summary || {},
    rows: Array.isArray(board.rows) ? board.rows.map((row) => ({
      modelRunId: row.modelRunId,
      modelVersion: row.modelVersion,
      eventId: row.eventId,
      eventName: row.eventName,
      modelProfile: row.modelProfile,
      modelWeatherScenario: row.modelWeatherScenario,
      modelWeatherLabel: row.modelWeatherLabel,
      createdAt: row.createdAt,
      statusKey: row.statusKey,
      statusLabel: row.statusLabel,
      proofScore: row.proofScore,
      predictions: row.predictions,
      players: row.players,
      markets: row.markets,
      fieldCoveragePct: row.fieldCoveragePct,
      pricedPct: row.pricedPct,
      sourceBacked: row.sourceBacked,
      hasManifest: row.hasManifest,
      sourceProviders: row.sourceProviders,
      activationScore: row.activationScore,
      activationStatus: row.activationStatus
    })) : [],
    warnings: Array.isArray(board.warnings) ? board.warnings : []
  };
}

function compactTrainingDataset(dataset) {
  if (!dataset || typeof dataset !== "object") return null;
  return {
    version: dataset.version || "",
    generatedAt: dataset.generatedAt || "",
    summary: dataset.summary || {},
    eventRows: Array.isArray(dataset.eventRows) ? dataset.eventRows.map((row) => ({
      eventId: row.eventId,
      eventName: row.eventName,
      startDate: row.startDate,
      courseName: row.courseName,
      examples: row.examples,
      standings: row.standings,
      featureCoverage: row.featureCoverage
    })) : [],
    rows: Array.isArray(dataset.rows) ? dataset.rows.slice(0, 25) : [],
    warnings: dataset.warnings || []
  };
}

function buildGolfLabBuildReport(bundle) {
  const source = bundle && typeof bundle === "object" ? bundle : {};
  const report = source.report || {};
  const validation = report.validation || {};
  const sourceFreshness = report.sourceFreshness || {};
  const sourceCatalog = compactSourceCatalog(source.sourceCatalog);
  const dataIntakeBoard = compactDataIntakeBoard(source.dataIntakeBoard);
  const acquisitionRunbook = compactAcquisitionRunbook(source.acquisitionRunbook);
  const importPreview = compactImportPreview(source.importPreview);
  const tournamentActivationPlan = compactTournamentActivationPlan(source.tournamentActivationPlan);
  const sourceLineageBoard = compactSourceLineageBoard(source.sourceLineageBoard || report.sourceLineage);
  const playerIdentityBoard = compactPlayerIdentityBoard(source.playerIdentityBoard);
  const playerSplitLabBoard = compactPlayerSplitLabBoard(source.playerSplitLabBoard);
  const courseSetupBoard = compactCourseSetupBoard(source.courseSetupBoard);
  const featureStoreAuditBoard = compactFeatureStoreAuditBoard(source.featureStoreAuditBoard);
  const predictionPrepBoard = compactPredictionPrepBoard(source.predictionPrepBoard);
  const modelRunHistoryBoard = compactModelRunHistoryBoard(source.modelRunHistoryBoard);
  const historicalBackfillBoard = compactHistoricalBackfillBoard(source.historicalBackfillBoard);
  const trainingDataset = compactTrainingDataset(source.trainingDataset);
  return {
    meta: {
      template: "Golf Lab local build report",
      generatedAt: source.meta ? source.meta.generatedAt : new Date().toISOString(),
      provider: source.meta ? source.meta.provider : "",
      inputDir: source.meta ? source.meta.inputDir : "",
      fileCount: source.meta ? source.meta.fileCount : 0
    },
    summary: {
      totalRecords: report.totalRecords || 0,
      importAddedRecords: importPreview && importPreview.summary ? importPreview.summary.addedRecords || 0 : 0,
      importUpdatedRecords: importPreview && importPreview.summary ? importPreview.summary.updatedRecords || 0 : 0,
      importVerdict: importPreview && importPreview.verdict ? importPreview.verdict.status || "" : "",
      score: report.score || 0,
      grade: report.grade || "building",
      latestSourceAt: report.latestSourceAt || "",
      sourceQualityScore: sourceFreshness.qualityScore || 0,
      provenanceCoverage: sourceFreshness.provenanceCoverage || 0,
      validationScore: validation.score || 0,
      coverageBlockers: source.coverageMap && source.coverageMap.summary ? source.coverageMap.summary.blockers || 0 : 0,
      sourceOpsScore: source.sourceOpsBoard ? source.sourceOpsBoard.opsScore || 0 : 0,
      dataIntakeCommands: dataIntakeBoard && dataIntakeBoard.summary ? dataIntakeBoard.summary.commandsReady || 0 : 0,
      dataIntakeAdapterLanes: dataIntakeBoard && dataIntakeBoard.summary ? dataIntakeBoard.summary.adapterLanes || 0 : 0,
      acquisitionPublicFirstLanes: acquisitionRunbook && acquisitionRunbook.summary ? acquisitionRunbook.summary.publicFirst || 0 : 0,
      acquisitionMixedCostLanes: acquisitionRunbook && acquisitionRunbook.summary ? acquisitionRunbook.summary.mixedCost || 0 : 0,
      acquisitionNeedsProof: acquisitionRunbook && acquisitionRunbook.summary ? acquisitionRunbook.summary.needsProof || 0 : 0,
      activationScore: tournamentActivationPlan ? tournamentActivationPlan.score || 0 : 0,
      activationStatus: tournamentActivationPlan ? tournamentActivationPlan.status || "thin" : "thin",
      activationReadyLanes: tournamentActivationPlan && tournamentActivationPlan.summary ? tournamentActivationPlan.summary.readyLanes || 0 : 0,
      activationCriticalBlockers: tournamentActivationPlan && tournamentActivationPlan.summary ? tournamentActivationPlan.summary.criticalBlockers || 0 : 0,
      activationAdapterCommands: tournamentActivationPlan && tournamentActivationPlan.summary ? tournamentActivationPlan.summary.adapterCommands || 0 : 0,
      sourceLineageScore: sourceLineageBoard && sourceLineageBoard.summary ? sourceLineageBoard.summary.proofScore || 0 : 0,
      sourceLineageStatus: sourceLineageBoard && sourceLineageBoard.summary ? sourceLineageBoard.summary.status || "thin" : "thin",
      sourceLineageBlockers: sourceLineageBoard && sourceLineageBoard.summary ? sourceLineageBoard.summary.blockers || 0 : 0,
      playerIdentityScore: playerIdentityBoard && playerIdentityBoard.summary ? playerIdentityBoard.summary.matchRate || 0 : 0,
      playerIdentityUnresolved: playerIdentityBoard && playerIdentityBoard.summary ? playerIdentityBoard.summary.unresolvedRows || 0 : 0,
      playerIdentitySelectedEventUnresolved: playerIdentityBoard && playerIdentityBoard.summary ? playerIdentityBoard.summary.selectedEventUnresolved || 0 : 0,
      playerSplitLabPlayers: playerSplitLabBoard && playerSplitLabBoard.summary ? playerSplitLabBoard.summary.players || 0 : 0,
      playerSplitLabStrongFits: playerSplitLabBoard && playerSplitLabBoard.summary ? playerSplitLabBoard.summary.strongFits || 0 : 0,
      playerSplitLabBlockers: playerSplitLabBoard && Array.isArray(playerSplitLabBoard.blockers) ? playerSplitLabBoard.blockers.length : 0,
      courseSetupScore: courseSetupBoard ? courseSetupBoard.setupScore || 0 : 0,
      courseSetupReadiness: courseSetupBoard ? courseSetupBoard.readiness || "thin" : "thin",
      courseSetupPressure: courseSetupBoard ? courseSetupBoard.pressureLabel || "" : "",
      courseSetupBlockers: courseSetupBoard && Array.isArray(courseSetupBoard.blockers) ? courseSetupBoard.blockers.length : 0,
      featureStoreScore: featureStoreAuditBoard ? featureStoreAuditBoard.score || 0 : 0,
      featureStoreReadiness: featureStoreAuditBoard ? featureStoreAuditBoard.readiness || "thin" : "thin",
      featureStoreReadyPlayers: featureStoreAuditBoard && featureStoreAuditBoard.summary ? featureStoreAuditBoard.summary.readyPlayers || 0 : 0,
      featureStoreBlockedPlayers: featureStoreAuditBoard && featureStoreAuditBoard.summary ? featureStoreAuditBoard.summary.blockedPlayers || 0 : 0,
      featureStoreBlockers: featureStoreAuditBoard && Array.isArray(featureStoreAuditBoard.blockers) ? featureStoreAuditBoard.blockers.length : 0,
      predictionPrepScore: predictionPrepBoard ? predictionPrepBoard.score || 0 : 0,
      predictionPrepStatus: predictionPrepBoard ? predictionPrepBoard.status || "setup" : "setup",
      predictionPrepCriticalBlockers: predictionPrepBoard && predictionPrepBoard.summary ? predictionPrepBoard.summary.criticalBlockers || 0 : 0,
      modelRunHistoryRuns: modelRunHistoryBoard && modelRunHistoryBoard.summary ? modelRunHistoryBoard.summary.runs || 0 : 0,
      modelRunHistoryManifestRuns: modelRunHistoryBoard && modelRunHistoryBoard.summary ? modelRunHistoryBoard.summary.manifestRuns || 0 : 0,
      modelRunHistoryReproduciblePct: modelRunHistoryBoard && modelRunHistoryBoard.summary ? modelRunHistoryBoard.summary.reproduciblePct || 0 : 0,
      lineShoppingEdges: report.oddsShopping && report.oddsShopping.summary ? report.oddsShopping.summary.bestEdges || 0 : 0,
      sourceCatalogTasks: sourceCatalog && Array.isArray(sourceCatalog.rows) ? sourceCatalog.rows.length : 0,
      backfillPriorityEvents: historicalBackfillBoard && historicalBackfillBoard.summary ? historicalBackfillBoard.summary.priorityEvents || 0 : 0,
      backfillModelReadyEvents: historicalBackfillBoard && historicalBackfillBoard.summary ? historicalBackfillBoard.summary.modelReadyEvents || 0 : 0,
      trainingExamples: trainingDataset && trainingDataset.summary ? trainingDataset.summary.rows || 0 : 0,
      trainingFeatureCoverage: trainingDataset && trainingDataset.summary ? trainingDataset.summary.featureCoverage || 0 : 0,
      gapCount: Array.isArray(report.gaps) ? report.gaps.length : 0,
      warningCount: Array.isArray(source.warnings) ? source.warnings.length : 0
    },
    counts: report.counts || {},
    scoreParts: report.scoreParts || {},
    gaps: report.gaps || [],
    validation,
    sourceFreshness,
    sourceLineageBoard,
    importPreview,
    playerIdentityBoard,
    playerSplitLabBoard,
    courseSetupBoard,
    featureStoreAuditBoard,
    coverageMap: compactCoverageMap(source.coverageMap),
    sourceOpsBoard: compactSourceOpsBoard(source.sourceOpsBoard),
    dataIntakeBoard,
    acquisitionRunbook,
    tournamentActivationPlan,
    predictionPrepBoard,
    modelRunHistoryBoard,
    sourceCatalog,
    historicalBackfillBoard,
    trainingDataset,
    oddsShoppingBoard: report.oddsShopping || null,
    sources: source.sources || [],
    warnings: source.warnings || []
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.initDir) {
    const kit = await writeCsvStarterKit(args.initDir);
    console.log(`Golf Lab CSV starter kit written: ${kit.outputDir}`);
    console.log(`${kit.files.length} files`);
    return 0;
  }
  if (args.eventKitDir) {
    const kit = await writeEventResearchKit(args.eventKitDir, args);
    console.log(`Golf Lab event research kit written: ${kit.outputDir}`);
    console.log(`${kit.files.length} collection files | ${kit.sourceCatalog.file} | ${kit.acquisitionRunbook.file} | ${kit.event ? kit.event.name : "blank event"}`);
    return 0;
  }
  if (!args.inputDir || !args.outputFile) {
    throw new Error(`${usage()}\n\nMissing --in or --out.`);
  }
  const bundle = args.lite
    ? await buildGolfLabLiteBundleFromDirectory(args.inputDir, { provider: args.provider })
    : await buildGolfLabBundleFromDirectory(args.inputDir, { provider: args.provider });
  await fsp.mkdir(path.dirname(path.resolve(args.outputFile)), { recursive: true });
  await writeJsonFile(args.outputFile, bundle, args.pretty);
  if (args.reportFile) {
    await fsp.mkdir(path.dirname(path.resolve(args.reportFile)), { recursive: true });
    await writeJsonFile(args.reportFile, buildGolfLabBuildReport(bundle), args.pretty);
  }
  const report = bundle.report;
  console.log(`Golf Lab bundle written: ${args.outputFile}`);
  if (args.reportFile) console.log(`Golf Lab build report written: ${args.reportFile}`);
  console.log(`${report.totalRecords} records | warehouse score ${report.score} | grade ${report.grade}${args.lite ? " | lite" : ""}`);
  return 0;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildGolfLabBundleFromDirectory,
  buildGolfLabLiteBundleFromDirectory,
  buildGolfLabBuildReport,
  writeCsvStarterKit,
  writeEventResearchKit,
  buildSourceCatalogManifest,
  writeJsonFile,
  parseArgs,
  usage
};
