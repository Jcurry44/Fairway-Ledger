#!/usr/bin/env node
/*
 * Refresh the source-backed Golf Lab public warehouse and publish the app seed.
 *
 * This is the no-manual-import path: source adapters update the local warehouse,
 * the owned model reruns, and data/golf-lab-showcase.js is regenerated for the UI.
 */
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const GolfLab = require("../lib/golf-lab.js");
const Warehouse = require("../lib/golf-lab-warehouse.js");

const DEFAULT_WAREHOUSE_DIR = path.join("data", "golf-lab", "pga-public-history-2002-2026");
const DEFAULT_ARTIFACT_FILE = path.join("data", "golf-lab-showcase.js");
const DEFAULT_REPORT_FILE = path.join("data", "golf-lab", "public-refresh-report.json");
const DEFAULT_RAW_DIR = path.join("data", "golf-lab", "raw", "auto-refresh");
const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard";
const DEFAULT_SOURCE_PROVIDER = "ESPN public season scoreboard + Golf Lab derived scoring model + PGA TOUR public stats + Open-Meteo + public/paid odds snapshots";

const COLLECTIONS = Object.keys(Warehouse.COLLECTION_COLUMNS);

function cleanString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function slug(value) {
  return cleanString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseBool(value) {
  return ["1", "true", "yes", "y", "on"].includes(cleanString(value).toLowerCase());
}

function parseArgs(argv) {
  const args = {
    warehouseDir: DEFAULT_WAREHOUSE_DIR,
    artifactFile: DEFAULT_ARTIFACT_FILE,
    reportFile: DEFAULT_REPORT_FILE,
    rawDir: DEFAULT_RAW_DIR,
    sourceProvider: DEFAULT_SOURCE_PROVIDER,
    selectedEventId: "",
    modelProfile: "Major Test",
    weatherScenario: "baseline",
    playerLimit: 60,
    eventLimit: 32,
    roundsPerPlayer: 24,
    sourceFetchLimit: 120,
    oddsSport: "golf_us_open_winner",
    oddsMarket: "winner",
    envFile: "",
    fetchedAt: "",
    publishOnly: false,
    offline: false,
    skipEspn: false,
    skipDerived: false,
    skipWeather: false,
    skipOdds: false,
    skipModel: false,
    forceLive: false,
    dryRun: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--warehouse") args.warehouseDir = argv[index += 1];
    else if (token === "--artifact") args.artifactFile = argv[index += 1];
    else if (token === "--report") args.reportFile = argv[index += 1];
    else if (token === "--raw-dir") args.rawDir = argv[index += 1];
    else if (token === "--event-id") args.selectedEventId = argv[index += 1];
    else if (token === "--espn-date") args.espnDate = argv[index += 1];
    else if (token === "--model-profile") args.modelProfile = argv[index += 1];
    else if (token === "--weather-scenario") args.weatherScenario = argv[index += 1];
    else if (token === "--player-limit") args.playerLimit = Number(argv[index += 1]);
    else if (token === "--event-limit") args.eventLimit = Number(argv[index += 1]);
    else if (token === "--rounds-per-player") args.roundsPerPlayer = Number(argv[index += 1]);
    else if (token === "--source-fetch-limit") args.sourceFetchLimit = Number(argv[index += 1]);
    else if (token === "--odds-sport") args.oddsSport = argv[index += 1];
    else if (token === "--odds-market") args.oddsMarket = argv[index += 1];
    else if (token === "--env-file") args.envFile = argv[index += 1];
    else if (token === "--fetched-at") args.fetchedAt = argv[index += 1];
    else if (token === "--source-provider") args.sourceProvider = argv[index += 1];
    else if (token === "--publish-only") args.publishOnly = true;
    else if (token === "--offline") args.offline = true;
    else if (token === "--skip-espn") args.skipEspn = true;
    else if (token === "--skip-derived") args.skipDerived = true;
    else if (token === "--skip-weather") args.skipWeather = true;
    else if (token === "--skip-odds") args.skipOdds = true;
    else if (token === "--skip-model") args.skipModel = true;
    else if (token === "--force-live") args.forceLive = true;
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!Number.isFinite(args.playerLimit) || args.playerLimit < 1) args.playerLimit = 60;
  if (!Number.isFinite(args.eventLimit) || args.eventLimit < 1) args.eventLimit = 32;
  if (!Number.isFinite(args.roundsPerPlayer) || args.roundsPerPlayer < 1) args.roundsPerPlayer = 24;
  if (!Number.isFinite(args.sourceFetchLimit) || args.sourceFetchLimit < 1) args.sourceFetchLimit = 120;
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-refresh-public.js [options]",
    "",
    "Options:",
    "  --warehouse <folder>        Golf Lab CSV warehouse. Defaults to data/golf-lab/pga-public-history-2002-2026.",
    "  --artifact <file>           Published app seed. Defaults to data/golf-lab-showcase.js.",
    "  --report <file>             Refresh report JSON. Defaults to data/golf-lab/public-refresh-report.json.",
    "  --event-id <id>             Force the modeled/published event.",
    "  --publish-only              Skip live source calls; rebuild the app seed from the current warehouse.",
    "  --offline                   Do not call remote sources; adapters may use existing raw files.",
    "  --env-file <file>           Optional env file for THE_ODDS_API_KEY.",
    "  --force-live                Refresh remote live lanes even outside the selected event window.",
    "  --skip-espn|--skip-weather|--skip-odds|--skip-model|--skip-derived",
    "  --dry-run                   Build report without writing the published artifact."
  ].join("\n");
}

function collectionFileName(collection) {
  return `${collection.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}.csv`;
}

function normalizeCsvColumnName(value) {
  const raw = cleanString(value)
    .replace(/^\uFEFF/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  if (!raw) return "";
  const words = raw.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (!words.length) return "";
  return words.map((word, index) => {
    const lower = word.toLowerCase();
    return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join("");
}

function parseCsvLine(line) {
  const row = [];
  let field = "";
  let inQuotes = false;
  const source = String(line || "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  row.push(field);
  return row;
}

function rowFromCsvCells(headers, cells) {
  return headers.reduce((record, header, index) => {
    if (!header) return record;
    record[header] = cleanString(cells[index]);
    return record;
  }, {});
}

async function readCollectionFiltered(inputDir, collection, predicate = () => true, options = {}) {
  const filePath = path.join(inputDir, collectionFileName(collection));
  const rows = [];
  const limit = Number.isFinite(options.limit) ? options.limit : 0;
  try {
    await fsp.access(filePath, fs.constants.R_OK);
  } catch (error) {
    if (error && error.code === "ENOENT") return rows;
    throw error;
  }

  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let headers = null;
  for await (const line of rl) {
    if (!headers) {
      headers = parseCsvLine(line).map(normalizeCsvColumnName);
      continue;
    }
    if (!cleanString(line)) continue;
    const row = rowFromCsvCells(headers, parseCsvLine(line));
    if (!Object.values(row).some((cell) => cleanString(cell))) continue;
    if (predicate(row)) {
      rows.push(row);
      if (limit && rows.length >= limit) {
        rl.close();
        input.destroy();
        break;
      }
    }
  }
  return rows;
}

async function readCollection(inputDir, collection) {
  try {
    return Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(inputDir, collectionFileName(collection)), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function loadWarehouse(inputDir) {
  const lab = {};
  for (const collection of COLLECTIONS) {
    lab[collection] = await readCollection(inputDir, collection);
  }
  return GolfLab.normalizeGolfLabState(lab);
}

async function loadEventSelectionWarehouse(inputDir) {
  const [events, modelPredictions] = await Promise.all([
    readCollectionFiltered(inputDir, "events"),
    readCollectionFiltered(inputDir, "modelPredictions")
  ]);
  return GolfLab.normalizeGolfLabState({ events, modelPredictions });
}

function dateOnly(value) {
  return cleanString(value).slice(0, 10);
}

function dateValue(value) {
  const clean = dateOnly(value);
  if (!clean) return NaN;
  return new Date(`${clean}T00:00:00Z`).getTime();
}

function dateKey(value) {
  return dateOnly(value).replace(/-/g, "");
}

function nowIso(options = {}) {
  return cleanString(options.fetchedAt) || new Date().toISOString();
}

function eventSortDate(event) {
  return dateOnly(event && (event.endDate || event.startDate)) || "";
}

function eventIsCurrent(event, now = new Date()) {
  const start = dateValue(event && event.startDate);
  const end = dateValue(event && (event.endDate || event.startDate));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return start <= today && today <= end + 86400000;
}

function latestByDate(rows, valueFn) {
  return rows
    .map((row) => ({ row, value: cleanString(valueFn(row)) }))
    .filter((item) => item.value)
    .sort((a, b) => a.value.localeCompare(b.value))
    .slice(-1)[0]?.row || null;
}

function selectEvent(lab, options = {}) {
  const forced = cleanString(options.selectedEventId);
  if (forced) {
    const exact = lab.events.find((event) => event.id === forced);
    if (exact) return exact;
  }
  const now = options.now instanceof Date ? options.now : new Date();
  const current = lab.events
    .filter((event) => eventIsCurrent(event, now))
    .sort((a, b) => eventSortDate(b).localeCompare(eventSortDate(a)))[0];
  if (current) return current;

  const predictionEventIds = new Set(lab.modelPredictions.map((row) => cleanString(row.eventId)).filter(Boolean));
  const latestModeled = lab.events
    .filter((event) => predictionEventIds.has(event.id))
    .sort((a, b) => eventSortDate(b).localeCompare(eventSortDate(a)))[0];
  if (latestModeled) return latestModeled;

  return latestByDate(lab.events, (event) => event.endDate || event.startDate) || lab.events[0] || null;
}

function playerIdSetForEvent(lab, eventId, options = {}) {
  const limit = options.playerLimit || 60;
  const ids = [];
  const seen = new Set();
  const push = (value) => {
    const id = cleanString(value);
    if (!id || seen.has(id) || ids.length >= limit) return;
    seen.add(id);
    ids.push(id);
  };
  lab.modelPredictions
    .filter((row) => row.eventId === eventId)
    .sort((a, b) => (Number(a.rank) || 9999) - (Number(b.rank) || 9999))
    .forEach((row) => push(row.playerId));
  lab.predictionLedger
    .filter((row) => row.eventId === eventId)
    .sort((a, b) => (Number(a.rank) || 9999) - (Number(b.rank) || 9999))
    .forEach((row) => push(row.playerId));
  lab.oddsSnapshots
    .filter((row) => row.eventId === eventId)
    .forEach((row) => push(row.playerId));
  lab.fields
    .filter((row) => row.eventId === eventId)
    .forEach((row) => push(row.playerId));
  return new Set(ids);
}

function sortRoundsDesc(a, b) {
  return cleanString(b.date || b.sourceUpdatedAt).localeCompare(cleanString(a.date || a.sourceUpdatedAt)) ||
    cleanString(b.eventId).localeCompare(cleanString(a.eventId)) ||
    Number(b.roundNumber || 0) - Number(a.roundNumber || 0);
}

function limitedRowsPerPlayer(rows, playerIds, limit) {
  const byPlayer = new Map();
  rows
    .filter((row) => playerIds.has(cleanString(row.playerId)))
    .sort(sortRoundsDesc)
    .forEach((row) => {
      const id = cleanString(row.playerId);
      if (!byPlayer.has(id)) byPlayer.set(id, []);
      const bucket = byPlayer.get(id);
      if (bucket.length < limit) bucket.push(row);
    });
  return [...byPlayer.values()].flat();
}

async function readLimitedRowsPerPlayer(inputDir, playerIds, limit) {
  const byPlayer = new Map();
  await readCollectionFiltered(inputDir, "rounds", (row) => {
    const id = cleanString(row.playerId);
    if (!playerIds.has(id)) return false;
    if (!byPlayer.has(id)) byPlayer.set(id, []);
    const bucket = byPlayer.get(id);
    bucket.push(row);
    if (bucket.length > limit) {
      bucket.sort(sortRoundsDesc);
      bucket.length = limit;
    }
    return false;
  });
  return [...byPlayer.values()].flat().sort(sortRoundsDesc);
}

function eventIdsFromRows(rows) {
  return new Set(rows.map((row) => cleanString(row.eventId)).filter(Boolean));
}

function courseIdsFromRows(rows) {
  return new Set(rows.flatMap((row) => [row.courseId, row.courseName]).map(cleanString).filter(Boolean));
}

function capEvents(lab, eventIds, selectedEventId, limit) {
  const byId = new Map(lab.events.map((event) => [event.id, event]));
  const selected = byId.get(selectedEventId);
  const events = [...eventIds]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .sort((a, b) => eventSortDate(b).localeCompare(eventSortDate(a)));
  const capped = [];
  const seen = new Set();
  const push = (event) => {
    if (!event || seen.has(event.id) || capped.length >= limit) return;
    seen.add(event.id);
    capped.push(event);
  };
  push(selected);
  events.forEach(push);
  return capped;
}

function sourceFetchMatches(row, eventIds, modelRunIds) {
  const eventId = cleanString(row.eventId);
  const modelRunId = cleanString(row.modelRunId);
  if (eventId && eventIds.has(eventId)) return true;
  if (modelRunId && modelRunIds.has(modelRunId)) return true;
  return false;
}

function buildPublicShowcase(labInput, options = {}) {
  const lab = GolfLab.normalizeGolfLabState(labInput);
  const selectedEvent = selectEvent(lab, options);
  if (!selectedEvent) throw new Error("Cannot publish Golf Lab showcase without at least one event.");
  const selectedEventId = selectedEvent.id;
  const playerIds = playerIdSetForEvent(lab, selectedEventId, options);
  if (!playerIds.size) {
    lab.players.slice(0, options.playerLimit || 60).forEach((player) => playerIds.add(player.id));
  }

  const rounds = limitedRowsPerPlayer(lab.rounds, playerIds, options.roundsPerPlayer || 24);
  const strokesGained = lab.strokesGained.filter((row) => {
    if (!playerIds.has(cleanString(row.playerId))) return false;
    if (cleanString(row.eventId) === selectedEventId) return true;
    return rounds.some((round) => cleanString(round.id) === cleanString(row.roundId) || (
      cleanString(round.eventId) === cleanString(row.eventId) &&
      cleanString(round.playerId) === cleanString(row.playerId) &&
      cleanString(round.roundNumber) === cleanString(row.period).replace(/^round-/, "")
    ));
  });
  const predictionRows = lab.modelPredictions.filter((row) => row.eventId === selectedEventId && playerIds.has(cleanString(row.playerId)));
  const ledgerRows = lab.predictionLedger.filter((row) => row.eventId === selectedEventId && playerIds.has(cleanString(row.playerId)));
  const oddsRows = lab.oddsSnapshots.filter((row) => row.eventId === selectedEventId && playerIds.has(cleanString(row.playerId)));

  const roundEventIds = eventIdsFromRows(rounds);
  roundEventIds.add(selectedEventId);
  const selectedEvents = capEvents(lab, roundEventIds, selectedEventId, options.eventLimit || 32);
  const selectedEventIds = new Set(selectedEvents.map((event) => event.id));
  const filteredRounds = rounds.filter((row) => selectedEventIds.has(cleanString(row.eventId)));
  const filteredSg = strokesGained.filter((row) => selectedEventIds.has(cleanString(row.eventId)));
  const courseKeys = courseIdsFromRows([...selectedEvents, ...filteredRounds]);
  const courses = lab.courses.filter((course) => courseKeys.has(cleanString(course.id)) || courseKeys.has(cleanString(course.name)));
  const courseSetups = lab.courseSetups.filter((setup) =>
    selectedEventIds.has(cleanString(setup.eventId)) ||
    courseKeys.has(cleanString(setup.courseId)) ||
    courseKeys.has(cleanString(setup.courseName))
  );
  const weatherSnapshots = lab.weatherSnapshots.filter((row) => selectedEventIds.has(cleanString(row.eventId)));
  const fields = lab.fields.filter((row) => cleanString(row.eventId) === selectedEventId);
  const players = lab.players.filter((player) => playerIds.has(cleanString(player.id)));
  const modelRunIds = new Set([...predictionRows, ...ledgerRows].map((row) => cleanString(row.modelRunId)).filter(Boolean));
  const sourceFetches = lab.sourceFetches
    .filter((row) => sourceFetchMatches(row, selectedEventIds, modelRunIds))
    .sort((a, b) => cleanString(b.fetchedAt || b.sourceUpdatedAt).localeCompare(cleanString(a.fetchedAt || a.sourceUpdatedAt)))
    .slice(0, options.sourceFetchLimit || 120);

  const curated = GolfLab.normalizeGolfLabState({
    ...GolfLab.blankGolfLabState(),
    players,
    events: selectedEvents,
    courses,
    courseSetups,
    fields,
    rounds: filteredRounds,
    strokesGained: filteredSg,
    weatherSnapshots,
    oddsSnapshots: oddsRows,
    modelPredictions: predictionRows,
    predictionLedger: ledgerRows,
    sourceFetches
  });
  const warehouseReport = Warehouse.buildWarehouseReport(curated, { now: nowIso(options) });
  const latestPrediction = [...predictionRows]
    .sort((a, b) => cleanString(b.createdAt).localeCompare(cleanString(a.createdAt)) || (Number(a.rank) || 9999) - (Number(b.rank) || 9999))[0];
  const counts = {};
  COLLECTIONS.forEach((collection) => {
    counts[collection] = Array.isArray(curated[collection]) ? curated[collection].length : 0;
  });
  return {
    label: "Golf Lab public warehouse",
    description: "Auto-refreshed, source-backed PGA public warehouse subset for the premium Golf Lab first-run experience.",
    builtAt: nowIso(options),
    selectedEventId,
    modelRunId: latestPrediction ? cleanString(latestPrediction.modelRunId) : "",
    sourceProvider: cleanString(options.sourceProvider || DEFAULT_SOURCE_PROVIDER),
    counts,
    report: {
      score: warehouseReport.score,
      grade: warehouseReport.grade,
      totalRecords: warehouseReport.totalRecords,
      sourceQualityScore: warehouseReport.sourceFreshness ? warehouseReport.sourceFreshness.qualityScore : 0
    },
    golfLab: curated
  };
}

async function buildPublicShowcaseFromWarehouse(inputDir, options = {}) {
  const eventSelectionLab = await loadEventSelectionWarehouse(inputDir);
  const selectedEvent = selectEvent(eventSelectionLab, options);
  if (!selectedEvent) throw new Error("Cannot publish Golf Lab showcase without at least one event.");
  const selectedEventId = selectedEvent.id;

  const selectedEventPredicate = (row) => cleanString(row.eventId) === selectedEventId;
  const [modelPredictions, predictionLedger, oddsSnapshots, fields] = await Promise.all([
    readCollectionFiltered(inputDir, "modelPredictions", selectedEventPredicate),
    readCollectionFiltered(inputDir, "predictionLedger", selectedEventPredicate),
    readCollectionFiltered(inputDir, "oddsSnapshots", selectedEventPredicate),
    readCollectionFiltered(inputDir, "fields", selectedEventPredicate)
  ]);
  const selectionLab = GolfLab.normalizeGolfLabState({
    ...eventSelectionLab,
    modelPredictions,
    predictionLedger,
    oddsSnapshots,
    fields
  });
  const playerIds = playerIdSetForEvent(selectionLab, selectedEventId, options);
  if (!playerIds.size) {
    const fallbackPlayers = await readCollectionFiltered(inputDir, "players", () => true, { limit: options.playerLimit || 60 });
    fallbackPlayers.forEach((player) => playerIds.add(cleanString(player.id)));
  }

  const rounds = await readLimitedRowsPerPlayer(inputDir, playerIds, options.roundsPerPlayer || 24);
  const roundIds = new Set(rounds.map((round) => cleanString(round.id)).filter(Boolean));
  const roundKeys = new Set(rounds.map((round) => [
    cleanString(round.eventId),
    cleanString(round.playerId),
    cleanString(round.roundNumber)
  ].join("|")));
  const strokesGained = await readCollectionFiltered(inputDir, "strokesGained", (row) => {
    if (!playerIds.has(cleanString(row.playerId))) return false;
    if (cleanString(row.eventId) === selectedEventId) return true;
    if (roundIds.has(cleanString(row.roundId))) return true;
    const key = [
      cleanString(row.eventId),
      cleanString(row.playerId),
      cleanString(row.period).replace(/^round-/, "")
    ].join("|");
    return roundKeys.has(key);
  });

  const roundEventIds = eventIdsFromRows(rounds);
  roundEventIds.add(selectedEventId);
  const selectedEvents = capEvents(eventSelectionLab, roundEventIds, selectedEventId, options.eventLimit || 32);
  const selectedEventIds = new Set(selectedEvents.map((event) => cleanString(event.id)));
  const filteredRounds = rounds.filter((row) => selectedEventIds.has(cleanString(row.eventId)));
  const filteredSg = strokesGained.filter((row) => selectedEventIds.has(cleanString(row.eventId)));
  const courseKeys = courseIdsFromRows([...selectedEvents, ...filteredRounds]);
  const modelRunIds = new Set([...modelPredictions, ...predictionLedger].map((row) => cleanString(row.modelRunId)).filter(Boolean));

  const [players, courses, courseSetups, weatherSnapshots, sourceFetches] = await Promise.all([
    readCollectionFiltered(inputDir, "players", (row) => playerIds.has(cleanString(row.id))),
    readCollectionFiltered(inputDir, "courses", (row) => courseKeys.has(cleanString(row.id)) || courseKeys.has(cleanString(row.name))),
    readCollectionFiltered(inputDir, "courseSetups", (row) =>
      selectedEventIds.has(cleanString(row.eventId)) ||
      courseKeys.has(cleanString(row.courseId)) ||
      courseKeys.has(cleanString(row.courseName))
    ),
    readCollectionFiltered(inputDir, "weatherSnapshots", (row) => selectedEventIds.has(cleanString(row.eventId))),
    readCollectionFiltered(inputDir, "sourceFetches", (row) => sourceFetchMatches(row, selectedEventIds, modelRunIds))
  ]);

  return buildPublicShowcase({
    ...GolfLab.blankGolfLabState(),
    players,
    events: selectedEvents,
    courses,
    courseSetups,
    fields,
    rounds: filteredRounds,
    strokesGained: filteredSg,
    weatherSnapshots,
    oddsSnapshots,
    modelPredictions,
    predictionLedger,
    sourceFetches: sourceFetches
      .sort((a, b) => cleanString(b.fetchedAt || b.sourceUpdatedAt).localeCompare(cleanString(a.fetchedAt || a.sourceUpdatedAt)))
      .slice(0, options.sourceFetchLimit || 120)
  }, { ...options, selectedEventId });
}

async function writePublicShowcase(filePath, showcase, options = {}) {
  const resolvedFile = path.resolve(filePath);
  await fsp.mkdir(path.dirname(resolvedFile), { recursive: true });
  const header = `// Source-backed Golf Lab public warehouse. Generated from ${options.warehouseDir || DEFAULT_WAREHOUSE_DIR} on ${showcase.builtAt}.\n`;
  const body = `(function(root){\n  root.GolfLabPublicShowcase = ${JSON.stringify(showcase)};\n})(typeof window !== "undefined" ? window : globalThis);\n`;
  if (!options.dryRun) await fsp.writeFile(resolvedFile, `${header}${body}`, "utf8");
  return resolvedFile;
}

async function writeReport(filePath, report, options = {}) {
  const resolvedFile = path.resolve(filePath);
  await fsp.mkdir(path.dirname(resolvedFile), { recursive: true });
  if (!options.dryRun) await fsp.writeFile(resolvedFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return resolvedFile;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { accept: "application/json,text/plain,*/*" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`Fetch failed ${response.status} ${response.statusText}: ${url} ${text.slice(0, 180)}`);
  return text;
}

function eventMatchesEspnEvent(event, espnEvent) {
  const espnId = cleanString(espnEvent && espnEvent.id);
  const eventId = cleanString(event && event.id);
  if (espnId && eventId.includes(espnId)) return true;
  return slug(event && event.name) === slug(espnEvent && (espnEvent.name || espnEvent.shortName));
}

function filteredEspnPayload(payload, event) {
  const events = Array.isArray(payload && payload.events) ? payload.events : [];
  const match = events.find((candidate) => eventMatchesEspnEvent(event, candidate));
  if (!match) throw new Error(`ESPN scoreboard did not include ${event.name || event.id}.`);
  return {
    ...payload,
    events: [match]
  };
}

async function runNodeScript(scriptName, args, options = {}) {
  const scriptPath = path.resolve(__dirname, scriptName);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: path.resolve(__dirname, ".."),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { script: scriptName, code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0 || options.allowFailure) resolve(result);
      else reject(new Error(`${scriptName} failed with ${code}: ${stderr || stdout}`));
    });
  });
}

async function refreshEspn(lab, event, options, report) {
  if (options.publishOnly || options.offline || options.skipEspn) return;
  const fetchedAt = nowIso(options);
  const key = cleanString(options.espnDate) || dateKey(event.endDate || event.startDate || fetchedAt);
  if (!key) return;
  const url = `${ESPN_SCOREBOARD_URL}?dates=${key}`;
  const rawDir = path.resolve(options.rawDir);
  await fsp.mkdir(rawDir, { recursive: true });
  const rawFile = path.join(rawDir, `espn-scoreboard-${key}.json`);
  const eventFile = path.join(rawDir, `espn-scoreboard-${key}-${slug(event.id)}.json`);
  const text = await fetchText(url);
  await fsp.writeFile(rawFile, text, "utf8");
  const payload = filteredEspnPayload(JSON.parse(text), event);
  await fsp.writeFile(eventFile, JSON.stringify(payload, null, 2), "utf8");
  const args = [
    "--in", eventFile,
    "--out", path.resolve(options.warehouseDir),
    "--event-id", event.id,
    "--source-url", url,
    "--fetched-at", fetchedAt,
    "--include-partial"
  ];
  if (event.courseId) args.push("--course-id", event.courseId);
  if (event.courseName) args.push("--course-name", event.courseName);
  const result = await runNodeScript("golf-lab-espn.js", args);
  report.steps.push({ step: "espn", status: "ok", sourceUrl: url, rawFile, stdout: result.stdout });
}

async function refreshDerived(options, report) {
  if (options.publishOnly || options.skipDerived) return;
  const result = await runNodeScript("golf-lab-derived-scoring.js", [
    "--in", path.resolve(options.warehouseDir),
    "--source-url", options.warehouseDir,
    "--fetched-at", nowIso(options)
  ]);
  report.steps.push({ step: "derived-scoring", status: "ok", stdout: result.stdout });
}

async function refreshWeather(event, options, report) {
  if (options.publishOnly || options.offline || options.skipWeather) return;
  const result = await runNodeScript("golf-lab-open-meteo-weather.js", [
    "--out", path.resolve(options.warehouseDir),
    "--event-id", event.id,
    "--raw-dir", path.resolve(options.rawDir, "open-meteo"),
    "--fetched-at", nowIso(options),
    "--refresh-raw"
  ], { allowFailure: true });
  report.steps.push({
    step: "weather",
    status: result.code === 0 ? "ok" : "warning",
    stdout: result.stdout,
    stderr: result.stderr
  });
}

function hasOddsCredentials(options = {}) {
  if (cleanString(options.envFile)) return fs.existsSync(path.resolve(options.envFile));
  return Boolean(process.env.THE_ODDS_API_KEY);
}

async function refreshOdds(event, options, report) {
  if (options.publishOnly || options.offline || options.skipOdds) return;
  if (!hasOddsCredentials(options)) {
    report.steps.push({ step: "odds", status: "skipped", reason: "THE_ODDS_API_KEY not available" });
    return;
  }
  const rawDir = path.resolve(options.rawDir, "odds-api");
  await fsp.mkdir(rawDir, { recursive: true });
  const rawOut = path.join(rawDir, `${slug(event.id)}-${Date.now()}.json`);
  const args = [
    "--out", path.resolve(options.warehouseDir),
    "--event-id", event.id,
    "--sport", options.oddsSport,
    "--market", options.oddsMarket,
    "--api-market", "outrights",
    "--raw-out", rawOut,
    "--fetched-at", nowIso(options)
  ];
  if (options.envFile) args.push("--env-file", path.resolve(options.envFile));
  const result = await runNodeScript("golf-lab-the-odds-api.js", args, { allowFailure: true });
  report.steps.push({
    step: "odds",
    status: result.code === 0 ? "ok" : "warning",
    rawOut,
    stdout: result.stdout,
    stderr: result.stderr
  });
}

async function refreshModel(event, options, report) {
  if (options.publishOnly || options.skipModel) return;
  const result = await runNodeScript("golf-lab-run-model.js", [
    "--in", path.resolve(options.warehouseDir),
    "--event-id", event.id,
    "--profile", options.modelProfile,
    "--weather-scenario", options.weatherScenario,
    "--created-at", nowIso(options)
  ], { allowFailure: true });
  report.steps.push({
    step: "model",
    status: result.code === 0 ? "ok" : "warning",
    stdout: result.stdout,
    stderr: result.stderr
  });
}

async function refreshPublicWarehouse(options = {}) {
  const report = {
    generatedAt: nowIso(options),
    warehouseDir: path.resolve(options.warehouseDir),
    artifactFile: path.resolve(options.artifactFile),
    publishOnly: Boolean(options.publishOnly),
    offline: Boolean(options.offline),
    steps: []
  };

  const eventSelectionLab = await loadEventSelectionWarehouse(options.warehouseDir);
  const selectedEvent = selectEvent(eventSelectionLab, options);
  if (!selectedEvent) throw new Error("Golf Lab warehouse has no events to refresh.");
  report.selectedEvent = {
    id: selectedEvent.id,
    name: selectedEvent.name,
    startDate: selectedEvent.startDate,
    endDate: selectedEvent.endDate,
    courseName: selectedEvent.courseName
  };

  const liveWindow = options.forceLive || eventIsCurrent(selectedEvent, options.now instanceof Date ? options.now : new Date());
  const activeOptions = (!options.publishOnly && !options.offline && !liveWindow)
    ? { ...options, publishOnly: true }
    : options;
  if (activeOptions.publishOnly && !options.publishOnly) {
    report.steps.push({
      step: "live-window",
      status: "skipped",
      reason: "selected event is outside the active tournament window"
    });
  }

  await refreshEspn(eventSelectionLab, selectedEvent, activeOptions, report);
  await refreshDerived(activeOptions, report);
  await refreshWeather(selectedEvent, activeOptions, report);
  await refreshOdds(selectedEvent, activeOptions, report);
  await refreshModel(selectedEvent, activeOptions, report);

  const showcase = await buildPublicShowcaseFromWarehouse(options.warehouseDir, { ...options, selectedEventId: selectedEvent.id });
  report.showcase = {
    selectedEventId: showcase.selectedEventId,
    modelRunId: showcase.modelRunId,
    counts: showcase.counts,
    score: showcase.report.score,
    grade: showcase.report.grade,
    totalRecords: showcase.report.totalRecords
  };
  await writePublicShowcase(options.artifactFile, showcase, options);
  await writeReport(options.reportFile, report, options);
  return { report, showcase };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const result = await refreshPublicWarehouse(args);
  const summary = result.report.showcase;
  console.log(`Golf Lab public warehouse ${args.dryRun ? "checked" : "published"}: ${path.resolve(args.artifactFile)}`);
  console.log(`${summary.totalRecords} records | score ${summary.score} | grade ${summary.grade} | event ${summary.selectedEventId}`);
  result.report.steps.forEach((step) => {
    console.log(`${step.step}: ${step.status}${step.reason ? ` | ${step.reason}` : ""}`);
  });
  return 0;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  selectEvent,
  buildPublicShowcase,
  buildPublicShowcaseFromWarehouse,
  writePublicShowcase,
  refreshPublicWarehouse,
  usage
};
