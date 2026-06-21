#!/usr/bin/env node
/*
 * Convert saved public PGA TOUR stats exports into Golf Lab CSVs.
 *
 * This lane is for official aggregate player skill stats such as SG Total,
 * SG approach, driving distance, accuracy, GIR, and scrambling. It does not
 * claim raw ShotLink shot-by-shot access.
 */
const fs = require("node:fs/promises");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");

const METRICS = Object.freeze({
  sgTotal: {
    label: "SG: Total",
    aliases: ["sgTotal", "strokesGainedTotal", "strokesGained", "sgTotalAvg", "strokesGainedAverage"]
  },
  sgOtt: {
    label: "SG: Off-the-Tee",
    aliases: ["sgOtt", "sgOffTheTee", "strokesGainedOffTheTee", "ott"]
  },
  sgApp: {
    label: "SG: Approach",
    aliases: ["sgApp", "sgApproach", "sgApproachTheGreen", "strokesGainedApproach", "strokesGainedApproachTheGreen"]
  },
  sgArg: {
    label: "SG: Around-the-Green",
    aliases: ["sgArg", "sgAroundTheGreen", "strokesGainedAroundTheGreen"]
  },
  sgPutt: {
    label: "SG: Putting",
    aliases: ["sgPutt", "sgPutting", "strokesGainedPutting"]
  },
  sgT2g: {
    label: "SG: Tee-to-Green",
    aliases: ["sgT2g", "sgTeeToGreen", "strokesGainedTeeToGreen"]
  },
  drivingDistance: {
    label: "Driving Distance",
    aliases: ["drivingDistance", "driveDistance", "avgDistance", "averageDistance", "drivingDistanceAvg"]
  },
  accuracy: {
    label: "Driving Accuracy",
    aliases: ["accuracy", "drivingAccuracy", "drivingAccuracyPct", "fairwayPercentage", "fairwaysHitPct", "fairwaysHitPercentage"]
  },
  gir: {
    label: "Greens in Regulation",
    aliases: ["gir", "girPct", "greensInRegulation", "greensInRegulationPct", "greensInRegulationPercentage"]
  },
  scrambling: {
    label: "Scrambling",
    aliases: ["scrambling", "scramblingPct", "scramblingPercentage"]
  }
});

const PERCENT_METRICS = new Set(["accuracy", "gir", "scrambling"]);

function cleanString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return "";
}

function slug(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeToken(value) {
  return cleanString(value)
    .replace(/^\uFEFF/, "")
    .replace(/&/g, " and ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function parseArgs(argv) {
  const args = {
    provider: "PGA TOUR public stats",
    sourceUrl: "https://www.pgatour.com/stats",
    status: "ok",
    tour: "PGA TOUR"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--in") args.inputFile = argv[index += 1];
    else if (token === "--out") args.outputDir = argv[index += 1];
    else if (token === "--provider") args.provider = argv[index += 1];
    else if (token === "--source-url") args.sourceUrl = argv[index += 1];
    else if (token === "--fetched-at") args.fetchedAt = argv[index += 1];
    else if (token === "--season") args.season = argv[index += 1];
    else if (token === "--period") args.period = argv[index += 1];
    else if (token === "--tour") args.tour = argv[index += 1];
    else if (token === "--stat-key") args.statKey = argv[index += 1];
    else if (token === "--status") args.status = argv[index += 1];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-pgatour-stats.js --in <stats.json|stats.csv|stats.html> --out <folder> [options]",
    "",
    "Options:",
    "  --season <year>       Season label used for period when the file does not include one.",
    "  --period <period>     Explicit strokes-gained period. Defaults to season-<year> or career.",
    "  --stat-key <metric>   Metric for one-stat exports, e.g. sgApp, sgPutt, drivingDistance.",
    "  --tour <tour>         Tour label for player rows. Defaults to PGA TOUR.",
    "  --source-url <url>    Public source URL for provenance rows.",
    "  --fetched-at <iso>    Fetch/export timestamp. Defaults to now.",
    "  --provider <name>     Source provider label. Defaults to PGA TOUR public stats."
  ].join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(columns, row = {}) {
  return columns.map((column) => csvCell(row[column])).join(",");
}

async function readExistingRows(outputDir, fileName) {
  try {
    return Warehouse.parseGolfLabCsv(await fs.readFile(path.join(outputDir, fileName), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
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

function upsertRows(existingRows, incomingRows) {
  const byId = new Map();
  existingRows.forEach((row) => {
    if (row && row.id) byId.set(row.id, row);
  });
  incomingRows.forEach((row) => {
    if (!row || !row.id) return;
    byId.set(row.id, mergePreservingExisting(byId.get(row.id), row));
  });
  return [...byId.values()];
}

async function writeCollection(outputDir, collection, rows) {
  const fileName = `${collection.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}.csv`;
  const columns = Warehouse.COLLECTION_COLUMNS[collection] || [];
  const existing = await readExistingRows(outputDir, fileName);
  const merged = upsertRows(existing, rows);
  const body = [columns.map(csvCell).join(","), ...merged.map((row) => csvLine(columns, row))].join("\n");
  await fs.writeFile(path.join(outputDir, fileName), `${body}\n`, "utf8");
  return { collection, fileName, rows: merged.length, incoming: rows.length };
}

function aliasSet(metric) {
  const metricConfig = METRICS[metric] || {};
  return new Set([metric, ...(metricConfig.aliases || [])].map(normalizeToken));
}

const METRIC_ALIAS_INDEX = Object.freeze(Object.keys(METRICS).reduce((index, metric) => {
  aliasSet(metric).forEach((alias) => {
    index[alias] = metric;
  });
  return index;
}, {}));

function metricFromHeader(value) {
  return METRIC_ALIAS_INDEX[normalizeToken(value)] || "";
}

function metricFromLabel(value) {
  const token = normalizeToken(value);
  if (!token) return "";
  const direct = METRIC_ALIAS_INDEX[token];
  if (direct) return direct;
  if ((token.includes("strokesgained") || token.startsWith("sg")) && token.includes("offthetee")) return "sgOtt";
  if ((token.includes("strokesgained") || token.startsWith("sg")) && token.includes("approach")) return "sgApp";
  if ((token.includes("strokesgained") || token.startsWith("sg")) && token.includes("aroundthegreen")) return "sgArg";
  if ((token.includes("strokesgained") || token.startsWith("sg")) && token.includes("putt")) return "sgPutt";
  if ((token.includes("strokesgained") || token.startsWith("sg")) && token.includes("teetogreen")) return "sgT2g";
  if ((token.includes("strokesgained") || token.startsWith("sg")) && token.includes("total")) return "sgTotal";
  if (token.includes("drivingdistance") || token.includes("averagedistance")) return "drivingDistance";
  if (token.includes("drivingaccuracy") || token.includes("fairway")) return "accuracy";
  if (token.includes("greensinregulation") || token === "gir" || token.includes("girpct")) return "gir";
  if (token.includes("scrambling")) return "scrambling";
  return "";
}

function normalizeMetricKey(value) {
  return metricFromHeader(value) || metricFromLabel(value);
}

function valueFor(row, aliases) {
  if (!row || typeof row !== "object") return "";
  const wanted = new Set(aliases.map(normalizeToken));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalizeToken(key))) return value;
  }
  return "";
}

function textFor(row, aliases) {
  return cleanString(valueFor(row, aliases));
}

function nestedObject(row, aliases) {
  if (!row || typeof row !== "object") return null;
  const wanted = new Set(aliases.map(normalizeToken));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalizeToken(key)) && value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return null;
}

function nestedArray(row, aliases) {
  if (!row || typeof row !== "object") return [];
  const wanted = new Set(aliases.map(normalizeToken));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalizeToken(key)) && Array.isArray(value)) return value;
  }
  return [];
}

function firstValue(rows, aliases) {
  for (const row of rows) {
    const value = textFor(row, aliases);
    if (value) return value;
  }
  return "";
}

function playerNameFor(row) {
  const player = nestedObject(row, ["player", "athlete", "competitor", "profile", "golfer"]);
  const direct = textFor(row, ["playerName", "playerDisplayName", "displayName", "fullName", "athleteName", "golferName", "competitorName", "player", "golfer"]);
  if (direct && !metricFromLabel(direct)) return direct;
  const nested = firstValue([player || {}], ["displayName", "fullName", "name", "shortName"]);
  if (nested) return nested;
  const firstName = textFor(row, ["firstName", "givenName"]);
  const lastName = textFor(row, ["lastName", "familyName", "surname"]);
  if (firstName || lastName) return [firstName, lastName].filter(Boolean).join(" ");
  const name = textFor(row, ["name"]);
  return metricFromLabel(name) ? "" : name;
}

function playerRawIdFor(row) {
  const player = nestedObject(row, ["player", "athlete", "competitor", "profile", "golfer"]);
  return firstValue([row, player || {}], ["pgaTourId", "pgaTourPlayerId", "tourPlayerId", "playerId", "competitorId", "athleteId", "id"]);
}

function countryFor(row) {
  const player = nestedObject(row, ["player", "athlete", "competitor", "profile", "golfer"]);
  const flag = nestedObject(row, ["flag"]);
  return firstValue([row, player || {}, flag || {}], ["country", "countryCode", "nationality", "countryName", "alt"]);
}

function profileUrlFor(row) {
  const player = nestedObject(row, ["player", "athlete", "competitor", "profile", "golfer"]);
  return firstValue([row, player || {}], ["profileUrl", "playerUrl", "url", "href"]);
}

function photoUrlFor(row) {
  const player = nestedObject(row, ["player", "athlete", "competitor", "profile", "golfer"]);
  return firstValue([row, player || {}], ["photoUrl", "headshotUrl", "imageUrl", "avatarUrl"]);
}

function parseNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = cleanString(value)
    .replace(/,/g, "")
    .replace(/[−–—]/g, "-")
    .replace(/^\+/, "");
  if (!text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const numeric = Number(match[0]);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundedNumberText(value, digits = 3) {
  if (!Number.isFinite(value)) return "";
  const factor = 10 ** digits;
  return String(Math.round(value * factor) / factor);
}

function metricNumberText(value, metric) {
  const numeric = parseNumber(value);
  if (!Number.isFinite(numeric)) return "";
  const raw = cleanString(value);
  if (PERCENT_METRICS.has(metric)) {
    const ratio = raw.includes("%") || numeric > 1 ? numeric / 100 : numeric;
    return roundedNumberText(ratio, 4);
  }
  return roundedNumberText(numeric, metric === "drivingDistance" ? 1 : 3);
}

function statDescriptor(row) {
  const stat = nestedObject(row, ["stat", "metric", "category", "record"]);
  return firstValue([row, stat || {}], ["statKey", "statId", "statName", "stat", "metric", "metricName", "label", "displayText", "title", "category", "recordName", "recordId", "name"]);
}

function genericStatValue(row) {
  return valueFor(row, ["value", "statValue", "displayValue", "avg", "average", "perRound", "perRoundValue", "amount", "seasonAverage"]);
}

function primaryNestedStatValue(row) {
  const stats = nestedArray(row, ["stats", "statistics", "statValues", "values", "metrics"]);
  const preferred = stats.find((stat) => normalizeToken(statDescriptor(stat)) === "avg") || stats[0];
  return preferred ? genericStatValue(preferred) : "";
}

function applyMetric(metrics, metric, value) {
  if (!metric || !Object.prototype.hasOwnProperty.call(METRICS, metric)) return;
  const numberText = metricNumberText(value, metric);
  if (numberText !== "") metrics[metric] = numberText;
}

function appendDirectMetricValues(metrics, row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return;
  Object.entries(row).forEach(([key, value]) => {
    if (value && typeof value === "object") return;
    const metric = metricFromHeader(key);
    if (metric) applyMetric(metrics, metric, value);
  });
}

function appendNestedMetricValues(metrics, row) {
  const containers = [
    nestedArray(row, ["stats", "statistics", "statValues", "values", "metrics", "performance"]),
    nestedArray(nestedObject(row, ["stats", "statistics", "performance"]) || {}, ["rows", "records", "values", "metrics"])
  ].flat();
  containers.forEach((stat) => {
    if (!stat || typeof stat !== "object") return;
    const label = statDescriptor(stat);
    const metric = normalizeMetricKey(label) || metricFromHeader(textFor(stat, ["key", "id", "field", "statKey"]));
    const value = genericStatValue(stat) || valueFor(stat, ["value"]);
    applyMetric(metrics, metric, value);
  });

  ["stats", "statistics", "statValues", "values", "metrics", "performance"].forEach((key) => {
    const object = nestedObject(row, [key]);
    if (object) appendDirectMetricValues(metrics, object);
  });
}

function extractMetricValues(row, options = {}) {
  const metrics = {};
  appendDirectMetricValues(metrics, row);
  appendNestedMetricValues(metrics, row);

  const targetMetric = normalizeMetricKey(options.statKey) || normalizeMetricKey(statDescriptor(row));
  if (targetMetric) applyMetric(metrics, targetMetric, genericStatValue(row) || primaryNestedStatValue(row));
  return metrics;
}

function periodFor(row, options = {}) {
  const explicit = textFor(row, ["period", "timePeriod", "range"]) || cleanString(options.period);
  if (explicit) return explicit;
  const season = textFor(row, ["season", "year"]) || cleanString(options.season);
  return season ? `season-${season}` : "career";
}

function statRowScore(row, options = {}) {
  if (!row || typeof row !== "object") return 0;
  const hasPlayer = Boolean(playerNameFor(row) || playerRawIdFor(row));
  const metricCount = Object.keys(extractMetricValues(row, options)).length;
  const hasGeneric = genericStatValue(row) !== "";
  const hasDescriptor = Boolean(statDescriptor(row));
  if (!hasPlayer) return 0;
  return (metricCount * 4) + (hasGeneric ? 2 : 0) + (hasDescriptor ? 1 : 0);
}

function collectCandidateArrays(value, output, options, seen = new Set(), depth = 0) {
  if (!value || depth > 12) return;
  if (typeof value === "object") {
    if (seen.has(value)) return;
    seen.add(value);
  }
  if (Array.isArray(value)) {
    const objectRows = value.filter((row) => row && typeof row === "object" && !Array.isArray(row));
    if (objectRows.length) {
      const sample = objectRows.slice(0, 25);
      const score = sample.reduce((sum, row) => sum + statRowScore(row, options), 0);
      const matched = sample.filter((row) => statRowScore(row, options) > 0).length;
      if (matched) output.push({ rows: objectRows, score, matched });
    }
    objectRows.slice(0, 200).forEach((row) => collectCandidateArrays(row, output, options, seen, depth + 1));
    return;
  }
  if (typeof value === "object") {
    Object.values(value).forEach((child) => collectCandidateArrays(child, output, options, seen, depth + 1));
  }
}

function extractRows(payload, options = {}) {
  if (Array.isArray(payload)) return payload.filter((row) => row && typeof row === "object");
  if (!payload || typeof payload !== "object") return [];

  const preferred = [
    payload.rows,
    payload.records,
    payload.stats,
    payload.leaderboard,
    payload.players,
    payload.data,
    payload.statDetails && payload.statDetails.rows,
    payload.table && payload.table.rows,
    payload.pageProps && payload.pageProps.rows
  ].find((value) => Array.isArray(value));
  if (preferred) return preferred.filter((row) => row && typeof row === "object");

  const candidates = [];
  collectCandidateArrays(payload, candidates, options);
  candidates.sort((a, b) => (b.score - a.score) || (b.matched - a.matched) || (b.rows.length - a.rows.length));
  return candidates[0] ? candidates[0].rows : [];
}

function sourceEndpoint(options, metrics) {
  const target = normalizeMetricKey(options.statKey);
  if (target) return `pgatour-stats/${target}`;
  if (metrics.length === 1) return `pgatour-stats/${metrics[0]}`;
  return "pgatour-stats/aggregate";
}

function sourceFetchId(provider, endpoint, period, fetchedAt) {
  return slug([provider, endpoint, period, fetchedAt].join(" ")) || "pgatour-stats-source";
}

function buildRows(payload, options = {}) {
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  const sourceProvider = cleanString(options.provider || "PGA TOUR public stats");
  const sourceUrl = cleanString(options.sourceUrl || "https://www.pgatour.com/stats");
  const sourceFields = { sourceProvider, sourceUrl, sourceUpdatedAt: fetchedAt };
  const sourceRows = extractRows(payload, options);
  const playersById = new Map();
  const sgById = new Map();
  const importedMetrics = new Set();

  sourceRows.forEach((row) => {
    const playerName = playerNameFor(row);
    const rawPlayerId = playerRawIdFor(row);
    const playerId = slug(playerName) || (rawPlayerId ? `pgatour-${slug(rawPlayerId)}` : "");
    if (!playerId && !playerName) return;
    const metrics = extractMetricValues(row, options);
    Object.keys(metrics).forEach((metric) => importedMetrics.add(metric));

    playersById.set(playerId, mergePreservingExisting(playersById.get(playerId), {
      id: playerId,
      name: playerName || playerId,
      country: countryFor(row),
      tour: textFor(row, ["tour"]) || cleanString(options.tour || "PGA TOUR"),
      pgaTourId: rawPlayerId,
      photoUrl: photoUrlFor(row),
      profileUrl: profileUrlFor(row),
      ...sourceFields
    }));

    if (!Object.keys(metrics).length) return;
    const period = periodFor(row, options);
    const sgId = slug(["pgatour-stats", period, playerId].join(" "));
    sgById.set(sgId, mergePreservingExisting(sgById.get(sgId), {
      id: sgId,
      playerId,
      playerName: playerName || playerId,
      eventId: "",
      roundId: "",
      period,
      ...metrics,
      ...sourceFields
    }));
  });

  const metrics = [...importedMetrics].sort();
  const periods = [...new Set([...sgById.values()].map((row) => row.period).filter(Boolean))].sort();
  const endpoint = sourceEndpoint(options, metrics);
  const sourceFetches = [{
    id: sourceFetchId(sourceProvider, endpoint, periods.join("-") || cleanString(options.period || options.season), fetchedAt),
    provider: sourceProvider,
    endpoint,
    eventId: "",
    fetchedAt,
    status: cleanString(options.status || "ok"),
    rowCount: sourceRows.length,
    manifestJson: JSON.stringify({
      sourceType: "public-pgatour-aggregate-stats",
      season: cleanString(options.season),
      period: cleanString(options.period),
      statKey: cleanString(options.statKey),
      metrics,
      note: "Official aggregate stats import; not raw ShotLink shot-by-shot data."
    }),
    sourceUrl
  }];

  return {
    tables: {
      players: [...playersById.values()],
      strokesGained: [...sgById.values()],
      sourceFetches
    },
    summary: {
      rowsRead: sourceRows.length,
      players: playersById.size,
      strokesGainedRows: sgById.size,
      metricsImported: metrics,
      periods
    }
  };
}

function extractNextDataPayload(text) {
  const match = String(text || "").match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  return JSON.parse(match[1]);
}

function looksLikeCsv(text, inputFile) {
  const ext = path.extname(cleanString(inputFile)).toLowerCase();
  if (ext === ".csv" || ext === ".tsv") return true;
  const trimmed = String(text || "").trimStart();
  return Boolean(trimmed && !trimmed.startsWith("{") && !trimmed.startsWith("[") && trimmed.includes(","));
}

async function readInput(inputFile) {
  const text = await fs.readFile(inputFile, "utf8");
  const trimmed = text.trimStart();
  if (/^<!doctype html/i.test(trimmed) || /^<html/i.test(trimmed)) {
    const nextPayload = extractNextDataPayload(text);
    if (nextPayload) return nextPayload;
  }
  if (looksLikeCsv(text, inputFile)) return Warehouse.parseGolfLabCsv(text);
  return JSON.parse(text);
}

async function adaptPgaTourStats(inputFile, outputDir, options = {}) {
  const resolvedInput = path.resolve(inputFile);
  const resolvedOutput = path.resolve(outputDir);
  const payload = await readInput(resolvedInput);
  const result = buildRows(payload, options);
  await fs.mkdir(resolvedOutput, { recursive: true });
  const writes = [];
  for (const [collection, rows] of Object.entries(result.tables)) {
    if (rows.length) writes.push(await writeCollection(resolvedOutput, collection, rows));
  }
  return {
    inputFile: resolvedInput,
    outputDir: resolvedOutput,
    writes,
    summary: result.summary
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.inputFile || !args.outputDir) throw new Error(`${usage()}\n\nMissing --in or --out.`);
  const result = await adaptPgaTourStats(args.inputFile, args.outputDir, args);
  console.log(`Golf Lab PGA TOUR stats adapted: ${result.outputDir}`);
  console.log(`${result.summary.players} players | ${result.summary.strokesGainedRows} skill rows | ${result.summary.metricsImported.join(", ") || "no metrics"}`);
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
  buildRows,
  adaptPgaTourStats,
  extractRows,
  extractMetricValues,
  usage
};
