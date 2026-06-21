#!/usr/bin/env node
/*
 * Run the owned Golf Lab model from a source-backed warehouse folder.
 *
 * This is the CLI equivalent of the in-app "Run Owned Model" action, so live
 * tournament slates can be rebuilt and audited from saved raw sources.
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const GolfLab = require("../lib/golf-lab.js");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const Model = require("../lib/golf-lab-model.js");

function cleanString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function slug(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseArgs(argv) {
  const args = {
    profile: "Major Test",
    weatherScenario: "baseline",
    requireOfficialField: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--in") args.inputDir = argv[index += 1];
    else if (token === "--event-id") args.eventId = argv[index += 1];
    else if (token === "--profile") args.profile = argv[index += 1];
    else if (token === "--weather-scenario") args.weatherScenario = argv[index += 1];
    else if (token === "--created-at") args.createdAt = argv[index += 1];
    else if (token === "--max-field-size") args.maxFieldSize = Number(argv[index += 1]);
    else if (token === "--live-state-weight") args.liveStateWeight = Number(argv[index += 1]);
    else if (token === "--disable-live-state") args.disableLiveState = true;
    else if (token === "--allow-projected-field") args.requireOfficialField = false;
    else if (token === "--report") args.reportFile = argv[index += 1];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!Number.isFinite(args.maxFieldSize)) delete args.maxFieldSize;
  if (!Number.isFinite(args.liveStateWeight)) delete args.liveStateWeight;
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-run-model.js --in <warehouse-folder> --event-id <event-id> [options]",
    "",
    "Options:",
    "  --profile <name|key>             Model profile. Defaults to Major Test.",
    "  --weather-scenario <scenario>    baseline, wind, rain, cold, heat, calm. Defaults to baseline.",
    "  --created-at <iso>               Model run timestamp. Defaults to now.",
    "  --max-field-size <number>        Field cap passed to the model.",
    "  --live-state-weight <number>     Optional live-score weight before normalization.",
    "  --disable-live-state             Ignore current-event scorecards for a pre-event style run.",
    "  --allow-projected-field          Permit modeling all players when official field rows are missing.",
    "  --report <file>                  Optional JSON report with top rows and manifest."
  ].join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(columns, row = {}) {
  return columns.map((column) => csvCell(row[column])).join(",");
}

function collectionFileName(collection) {
  return `${collection.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}.csv`;
}

async function readCollection(inputDir, collection) {
  try {
    return Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(inputDir, collectionFileName(collection)), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeCollection(inputDir, collection, rows) {
  const columns = Warehouse.COLLECTION_COLUMNS[collection] || [];
  const body = [columns.map(csvCell).join(","), ...rows.map((row) => csvLine(columns, row))].join("\n");
  await fsp.writeFile(path.join(inputDir, collectionFileName(collection)), `${body}\n`, "utf8");
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function mergePreservingExisting(existing, incoming) {
  const merged = { ...(existing || {}) };
  Object.entries(incoming || {}).forEach(([key, value]) => {
    if (hasValue(value) || !Object.prototype.hasOwnProperty.call(merged, key)) merged[key] = value;
  });
  return merged;
}

function truthyCell(value) {
  return ["true", "1", "yes", "hit", "miss", "push"].includes(cleanString(value).toLowerCase());
}

function mergePredictionRow(existing, incoming) {
  const merged = mergePreservingExisting(existing, incoming);
  const existingSettled = truthyCell(existing && existing.settled) || truthyCell(existing && existing.hit);
  if (!existingSettled && incoming && Object.prototype.hasOwnProperty.call(incoming, "result")) {
    merged.result = incoming.result;
  }
  return merged;
}

function marketOrder(value) {
  return { winner: 0, top10: 1, top20: 2, makecut: 3 }[slug(value).replace(/-/g, "")] ?? 99;
}

function sortPredictionRows(rows) {
  return [...rows].sort((a, b) =>
    cleanString(b.createdAt).localeCompare(cleanString(a.createdAt)) ||
    cleanString(a.eventId).localeCompare(cleanString(b.eventId)) ||
    cleanString(a.modelRunId).localeCompare(cleanString(b.modelRunId)) ||
    (Number(a.rank) || 9999) - (Number(b.rank) || 9999) ||
    marketOrder(a.market) - marketOrder(b.market) ||
    cleanString(a.playerId).localeCompare(cleanString(b.playerId))
  );
}

function upsertRows(existingRows, incomingRows, options = {}) {
  const byId = new Map();
  existingRows.forEach((row) => {
    if (row && row.id) byId.set(row.id, row);
  });
  incomingRows.forEach((row) => {
    if (!row || !row.id) return;
    byId.set(row.id, options.predictions ? mergePredictionRow(byId.get(row.id), row) : mergePreservingExisting(byId.get(row.id), row));
  });
  const rows = [...byId.values()];
  return options.predictions ? sortPredictionRows(rows) : rows;
}

function profileFromOption(value) {
  const token = slug(value || "Major Test");
  const profile = Model.DEFAULT_CONSENSUS_PROFILES.find((item) =>
    slug(item.key) === token ||
    slug(item.label) === token ||
    (token === "major" && item.key === "tough") ||
    (token === "tough" && item.key === "tough")
  ) || Model.DEFAULT_CONSENSUS_PROFILES.find((item) => item.key === "tough");
  return profile || { label: cleanString(value || "Major Test"), weights: Model.DEFAULT_WEIGHTS };
}

async function loadWarehouse(inputDir) {
  const lab = {};
  for (const collection of Object.keys(Warehouse.COLLECTION_COLUMNS)) {
    lab[collection] = await readCollection(inputDir, collection);
  }
  return GolfLab.normalizeGolfLabState(lab);
}

function rowPlayerKeys(row) {
  return [row && row.playerId, row && row.playerName, row && row.name]
    .map(cleanString)
    .filter(Boolean);
}

function playerMatchesKey(row, keys) {
  return rowPlayerKeys(row).some((key) => keys.has(key));
}

function eventForId(lab, eventId) {
  const cleanEventId = cleanString(eventId);
  return lab.events.find((event) => event.id === cleanEventId || event.eventId === cleanEventId) || null;
}

function sliceLabForEventModel(lab, options = {}) {
  const event = eventForId(lab, options.eventId);
  if (!event) return lab;
  const maxFieldSize = Number.isFinite(Number(options.maxFieldSize)) ? Math.max(1, Number(options.maxFieldSize)) : 156;
  const fieldRows = lab.fields
    .filter((field) => field.eventId === event.id || field.eventId === event.eventId)
    .filter((field) => !["wd", "withdrawn", "out"].includes(cleanString(field.status).toLowerCase()))
    .slice(0, maxFieldSize);
  if (!fieldRows.length) return lab;

  const fieldKeys = new Set(fieldRows.flatMap(rowPlayerKeys));
  const players = lab.players.filter((player) => playerMatchesKey(player, fieldKeys));
  players.forEach((player) => {
    rowPlayerKeys(player).forEach((key) => fieldKeys.add(key));
    [player.dataGolfId, player.pgaTourId].map(cleanString).filter(Boolean).forEach((key) => fieldKeys.add(key));
  });

  const rounds = lab.rounds.filter((round) => playerMatchesKey(round, fieldKeys));
  const roundEventIds = new Set(rounds.map((round) => cleanString(round.eventId)).filter(Boolean));
  roundEventIds.add(event.id);
  const courseKeys = new Set([
    event.courseId,
    event.courseName,
    ...rounds.flatMap((round) => [round.courseId, round.courseName])
  ].map(cleanString).filter(Boolean));
  const courses = lab.courses.filter((course) =>
    courseKeys.has(cleanString(course.id)) ||
    courseKeys.has(cleanString(course.name))
  );
  const courseSetups = lab.courseSetups.filter((setup) =>
    roundEventIds.has(cleanString(setup.eventId)) ||
    courseKeys.has(cleanString(setup.courseId)) ||
    courseKeys.has(cleanString(setup.courseName))
  );
  const strokesGained = lab.strokesGained.filter((row) => playerMatchesKey(row, fieldKeys));
  const weatherSnapshots = lab.weatherSnapshots.filter((row) => roundEventIds.has(cleanString(row.eventId)));
  const oddsSnapshots = lab.oddsSnapshots.filter((row) =>
    cleanString(row.eventId) === cleanString(event.id) &&
    playerMatchesKey(row, fieldKeys)
  );

  return GolfLab.normalizeGolfLabState({
    ...GolfLab.blankGolfLabState(),
    players,
    tours: lab.tours,
    events: [event],
    courses,
    courseSetups,
    fields: fieldRows,
    rounds,
    strokesGained,
    weatherSnapshots,
    oddsSnapshots,
    equipmentSnapshots: lab.equipmentSnapshots.filter((row) => playerMatchesKey(row, fieldKeys)),
    accomplishments: lab.accomplishments.filter((row) => playerMatchesKey(row, fieldKeys)),
    sourceFetches: lab.sourceFetches
  });
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function reportFromSnapshot(snapshot) {
  const predictions = Array.isArray(snapshot.predictions) ? snapshot.predictions : [];
  const topWinnerRows = predictions
    .filter((row) => row.market === "winner")
    .sort((a, b) => Number(a.rank) - Number(b.rank))
    .slice(0, 20);
  const positiveEdges = predictions
    .filter((row) => finiteNumber(row.edge) !== null && finiteNumber(row.edge) > 0)
    .sort((a, b) => finiteNumber(b.edge) - finiteNumber(a.edge) || Number(a.rank) - Number(b.rank))
    .slice(0, 20);
  return {
    generatedAt: snapshot.manifest && snapshot.manifest.createdAt,
    event: snapshot.event ? {
      id: snapshot.event.id,
      name: snapshot.event.name,
      startDate: snapshot.event.startDate,
      courseName: snapshot.event.courseName
    } : null,
    course: snapshot.course ? {
      id: snapshot.course.id,
      name: snapshot.course.name
    } : null,
    weatherScenario: snapshot.weatherScenario || null,
    manifest: snapshot.manifest || null,
    counts: {
      predictions: predictions.length,
      features: Array.isArray(snapshot.features) ? snapshot.features.length : 0,
      winnerRows: predictions.filter((row) => row.market === "winner").length,
      pricedPredictions: predictions.filter((row) => finiteNumber(row.marketOddsAmerican) !== null).length,
      positiveEdges: predictions.filter((row) => finiteNumber(row.edge) !== null && finiteNumber(row.edge) > 0).length
    },
    topWinnerRows,
    positiveEdges,
    warnings: Array.isArray(snapshot.warnings) ? snapshot.warnings : []
  };
}

async function runGolfLabModel(inputDir, options = {}) {
  const resolvedInput = path.resolve(inputDir);
  const lab = await loadWarehouse(resolvedInput);
  const modelLab = sliceLabForEventModel(lab, options);
  const profile = profileFromOption(options.profile);
  const snapshot = Model.buildOwnedModelSnapshot(modelLab, {
    eventId: options.eventId,
    createdAt: cleanString(options.createdAt) || new Date().toISOString(),
    weights: profile.weights,
    modelProfile: profile.label,
    weatherScenario: options.weatherScenario,
    requireOfficialField: options.requireOfficialField,
    maxFieldSize: options.maxFieldSize,
    liveStateWeight: options.liveStateWeight,
    disableLiveState: options.disableLiveState
  });
  if (!snapshot.predictions || !snapshot.predictions.length) {
    throw new Error((snapshot.warnings && snapshot.warnings[0]) || "No model predictions were created.");
  }

  const nextModelPredictions = upsertRows(lab.modelPredictions, snapshot.golfLab.modelPredictions, { predictions: true });
  const nextPredictionLedger = upsertRows(lab.predictionLedger, snapshot.golfLab.predictionLedger, { predictions: true });
  const nextSourceFetches = upsertRows(lab.sourceFetches, snapshot.golfLab.sourceFetches);
  await writeCollection(resolvedInput, "modelPredictions", nextModelPredictions);
  await writeCollection(resolvedInput, "predictionLedger", nextPredictionLedger);
  await writeCollection(resolvedInput, "sourceFetches", nextSourceFetches);

  const report = reportFromSnapshot(snapshot);
  report.slice = {
    players: modelLab.players.length,
    fields: modelLab.fields.length,
    rounds: modelLab.rounds.length,
    strokesGained: modelLab.strokesGained.length,
    weatherSnapshots: modelLab.weatherSnapshots.length,
    oddsSnapshots: modelLab.oddsSnapshots.length
  };
  if (options.reportFile) {
    await fsp.writeFile(path.resolve(options.reportFile), JSON.stringify(report, null, 2), "utf8");
  }
  return {
    inputDir: resolvedInput,
    profile,
    snapshot,
    report,
    writes: {
      modelPredictions: nextModelPredictions.length,
      predictionLedger: nextPredictionLedger.length,
      sourceFetches: nextSourceFetches.length
    }
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.inputDir || !args.eventId) throw new Error(`${usage()}\n\nMissing --in or --event-id.`);
  const result = await runGolfLabModel(args.inputDir, args);
  const eventName = result.snapshot.event ? result.snapshot.event.name || result.snapshot.event.id : args.eventId;
  console.log(`Golf Lab model run saved: ${eventName}`);
  console.log(`${result.report.counts.predictions} predictions | ${result.report.counts.pricedPredictions} priced | ${result.report.counts.positiveEdges} positive edges`);
  console.log(`Model run: ${result.snapshot.manifest.modelRunId}`);
  return 0;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  profileFromOption,
  runGolfLabModel,
  reportFromSnapshot,
  usage
};
