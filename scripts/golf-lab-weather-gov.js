#!/usr/bin/env node
/*
 * Convert a saved weather.gov hourly forecast JSON response into Golf Lab CSVs.
 *
 * Fetch raw NWS/weather.gov JSON separately and keep it with the output folder
 * so every weather snapshot remains source-backed and replayable.
 */
const fs = require("node:fs/promises");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function slug(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseArgs(argv) {
  const args = {
    provider: "NOAA/NWS hourly forecast",
    status: "ok"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--in") args.inputFile = argv[index += 1];
    else if (token === "--out") args.outputDir = argv[index += 1];
    else if (token === "--event-id") args.eventId = argv[index += 1];
    else if (token === "--course-id") args.courseId = argv[index += 1];
    else if (token === "--course-name") args.courseName = argv[index += 1];
    else if (token === "--provider") args.provider = argv[index += 1];
    else if (token === "--source-url") args.sourceUrl = argv[index += 1];
    else if (token === "--fetched-at") args.fetchedAt = argv[index += 1];
    else if (token === "--start-date") args.startDate = argv[index += 1];
    else if (token === "--end-date") args.endDate = argv[index += 1];
    else if (token === "--event-start-date") args.eventStartDate = argv[index += 1];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-weather-gov.js --in <hourly-forecast.json> --out <folder> [options]",
    "",
    "Options:",
    "  --event-id <id>             Golf Lab event id.",
    "  --course-id <id>            Course id for weather snapshots.",
    "  --course-name <name>        Course name for weather snapshots.",
    "  --source-url <url>          weather.gov hourly forecast endpoint.",
    "  --fetched-at <iso>          Fetch timestamp. Defaults to forecast generatedAt/updateTime.",
    "  --start-date <yyyy-mm-dd>   First local date to include.",
    "  --end-date <yyyy-mm-dd>     Last local date to include.",
    "  --event-start-date <date>   Date used to infer roundNumber. Defaults to --start-date."
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

function upsertRows(existingRows, incomingRows) {
  const byId = new Map();
  existingRows.forEach((row) => {
    if (row && row.id) byId.set(row.id, row);
  });
  incomingRows.forEach((row) => {
    if (!row || !row.id) return;
    byId.set(row.id, { ...(byId.get(row.id) || {}), ...row });
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

function dateOnly(value) {
  return cleanString(value).slice(0, 10);
}

function dateValue(date) {
  const clean = dateOnly(date);
  return clean ? new Date(`${clean}T00:00:00Z`).getTime() : NaN;
}

function dateInRange(date, startDate, endDate) {
  const value = dateValue(date);
  if (!Number.isFinite(value)) return false;
  const start = dateValue(startDate);
  const end = dateValue(endDate);
  if (Number.isFinite(start) && value < start) return false;
  if (Number.isFinite(end) && value > end) return false;
  return true;
}

function roundForDate(date, eventStartDate) {
  const start = dateValue(eventStartDate);
  const value = dateValue(date);
  if (!Number.isFinite(start) || !Number.isFinite(value)) return "";
  return String(Math.floor((value - start) / 86400000) + 1);
}

function numberText(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.round(number * 10) / 10) : "";
}

function parseMph(value) {
  const text = cleanString(value);
  if (!text) return "";
  const values = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0])).filter(Number.isFinite);
  return values.length ? numberText(Math.max(...values)) : "";
}

function waveForTime(startTime) {
  const match = cleanString(startTime).match(/T(\d{2}):/);
  if (!match) return "";
  return Number(match[1]) < 12 ? "AM" : "PM";
}

function forecastEndpoint(sourceUrl) {
  const clean = cleanString(sourceUrl);
  const match = clean.match(/gridpoints\/([^/]+)\/([^/]+)\/forecast\/hourly/i);
  return match ? `weather-gov-hourly/${match[1]}/${match[2]}` : "weather-gov-hourly";
}

function buildRows(payload, options = {}) {
  const properties = payload && payload.properties ? payload.properties : {};
  const periods = Array.isArray(properties.periods) ? properties.periods : [];
  const forecastAt = cleanString(properties.generatedAt || properties.updateTime || options.fetchedAt);
  const fetchedAt = cleanString(options.fetchedAt || forecastAt) || new Date().toISOString();
  const sourceProvider = cleanString(options.provider || "NOAA/NWS hourly forecast");
  const sourceUrl = cleanString(options.sourceUrl);
  const eventId = cleanString(options.eventId);
  const courseId = cleanString(options.courseId);
  const courseName = cleanString(options.courseName);
  const startDate = dateOnly(options.startDate);
  const endDate = dateOnly(options.endDate || options.startDate);
  const eventStartDate = dateOnly(options.eventStartDate || startDate);
  const weatherSnapshots = [];

  periods.forEach((period, index) => {
    const startTime = cleanString(period.startTime);
    const date = dateOnly(startTime);
    if ((startDate || endDate) && !dateInRange(date, startDate, endDate)) return;
    const precipitationProbability = period.probabilityOfPrecipitation && period.probabilityOfPrecipitation.value;
    weatherSnapshots.push({
      id: slug([eventId, courseId || courseName, "weather", date, startTime.slice(11, 16), index + 1].join(" ")),
      eventId,
      courseId,
      courseName,
      roundNumber: roundForDate(date, eventStartDate),
      date,
      observedAt: "",
      forecastAt,
      temperatureF: numberText(period.temperature),
      windMph: parseMph(period.windSpeed),
      gustMph: parseMph(period.windGust),
      precipitationIn: Number(precipitationProbability) === 0 ? "0" : "",
      wave: waveForTime(startTime),
      sourceProvider,
      sourceUrl,
      sourceUpdatedAt: fetchedAt
    });
  });

  const sourceFetches = [{
    id: slug(`${sourceProvider} ${eventId || courseId || "course"} hourly forecast ${fetchedAt}`),
    provider: sourceProvider,
    endpoint: forecastEndpoint(sourceUrl),
    eventId,
    fetchedAt,
    status: cleanString(options.status || "ok"),
    rowCount: weatherSnapshots.length,
    sourceUrl
  }];

  return {
    tables: {
      weatherSnapshots,
      sourceFetches
    },
    summary: {
      eventId,
      courseId,
      periods: periods.length,
      weatherSnapshots: weatherSnapshots.length,
      forecastAt,
      fetchedAt
    }
  };
}

async function adaptWeatherGovForecast(inputFile, outputDir, options = {}) {
  const resolvedInput = path.resolve(inputFile);
  const resolvedOutput = path.resolve(outputDir);
  const payload = JSON.parse(await fs.readFile(resolvedInput, "utf8"));
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
  const result = await adaptWeatherGovForecast(args.inputFile, args.outputDir, args);
  console.log(`Golf Lab weather.gov forecast adapted: ${result.outputDir}`);
  console.log(`${result.summary.weatherSnapshots} weather snapshots from ${result.summary.periods} hourly periods`);
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
  adaptWeatherGovForecast,
  usage
};
