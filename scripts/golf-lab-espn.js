#!/usr/bin/env node
/*
 * Convert an ESPN public golf scoreboard JSON response into Golf Lab CSVs.
 *
 * This adapter reads a saved raw JSON file. Fetch raw sources separately and
 * keep them with the output folder so every imported row remains auditable.
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
    provider: "ESPN public scoreboard",
    sourceUrl: "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard",
    status: "ok",
    includePartial: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--in") args.inputFile = argv[index += 1];
    else if (token === "--out") args.outputDir = argv[index += 1];
    else if (token === "--event-id") args.eventId = argv[index += 1];
    else if (token === "--course-id") args.courseId = argv[index += 1];
    else if (token === "--course-name") args.courseName = argv[index += 1];
    else if (token === "--course-location") args.courseLocation = argv[index += 1];
    else if (token === "--provider") args.provider = argv[index += 1];
    else if (token === "--source-url") args.sourceUrl = argv[index += 1];
    else if (token === "--course-source-url") args.courseSourceUrl = argv[index += 1];
    else if (token === "--fetched-at") args.fetchedAt = argv[index += 1];
    else if (token === "--include-partial") args.includePartial = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-espn.js --in <scoreboard.json> --out <folder> [options]",
    "",
    "Options:",
    "  --event-id <id>             Golf Lab event id override.",
    "  --course-id <id>            Course id override when ESPN does not provide venue.",
    "  --course-name <name>        Course name override when ESPN does not provide venue.",
    "  --course-location <value>   Course location for course profile rows.",
    "  --course-source-url <url>   Source URL for manual course override proof.",
    "  --source-url <url>          ESPN source URL for source_fetches.csv.",
    "  --fetched-at <iso>          Fetch timestamp. Defaults to now.",
    "  --include-partial           Include in-progress round rows. Default skips partial rounds."
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

function parseToPar(value) {
  const raw = cleanString(value);
  if (!raw || raw === "-") return "";
  if (/^(e|even)$/i.test(raw)) return "0";
  const numeric = Number(raw.replace(/^\+/, ""));
  return Number.isFinite(numeric) ? String(numeric) : "";
}

function addDays(dateValue, days) {
  const date = new Date(dateValue || "");
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function countryFromAthlete(athlete) {
  return cleanString(athlete && athlete.flag && athlete.flag.alt);
}

function scoreboardEvent(payload) {
  const event = (payload.events || [])[0];
  const competition = event && (event.competitions || [])[0];
  if (!event || !competition) throw new Error("ESPN scoreboard did not include an event competition.");
  return { event, competition };
}

function eventStatus(event) {
  return cleanString(event && event.status && event.status.type && (event.status.type.description || event.status.type.name)) || "scheduled";
}

function courseSourceUrl(options) {
  return cleanString(options.courseSourceUrl || options.sourceUrl);
}

function buildRows(payload, options = {}) {
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  const { event, competition } = scoreboardEvent(payload);
  const league = (payload.leagues || [])[0] || {};
  const season = event.season || league.season || payload.season || {};
  const eventName = cleanString(event.name || event.shortName || "Tournament");
  const eventId = cleanString(options.eventId) || slug(`${season.year || ""} ${eventName}`) || event.id;
  const courseName = cleanString(options.courseName);
  const courseId = cleanString(options.courseId) || slug(courseName);
  const sourceProvider = cleanString(options.provider || "ESPN public scoreboard");
  const sourceUrl = cleanString(options.sourceUrl);
  const sourceFields = { sourceProvider, sourceUrl, sourceUpdatedAt: fetchedAt };
  const competitors = competition.competitors || [];
  const players = [];
  const fields = [];
  const rounds = [];
  let skippedPartialRounds = 0;
  let inferredPar = null;

  competitors.forEach((competitor) => {
    const athlete = competitor.athlete || {};
    const playerName = cleanString(athlete.displayName || athlete.fullName || athlete.shortName);
    const playerId = slug(playerName) || `espn-${competitor.id}`;
    if (!playerName) return;
    players.push({
      id: playerId,
      name: playerName,
      country: countryFromAthlete(athlete),
      tour: cleanString(league.abbreviation || league.name || "PGA"),
      ...sourceFields
    });
    fields.push({
      id: slug(`${eventId} ${playerId} field`),
      eventId,
      playerId,
      playerName,
      status: "active",
      ...sourceFields
    });
    (competitor.linescores || []).forEach((line) => {
      const roundNumber = Number(line.period);
      const holeScores = (line.linescores || []).filter((hole) => Number.isFinite(Number(hole.value)));
      const isComplete = holeScores.length >= 18;
      if (!isComplete && !options.includePartial) {
        skippedPartialRounds += 1;
        return;
      }
      const toPar = parseToPar(line.displayValue);
      const score = Number(line.value);
      if (isComplete && Number.isFinite(score) && toPar !== "") {
        const par = score - Number(toPar);
        if (Number.isFinite(par) && par > 0) inferredPar = inferredPar || par;
      }
      rounds.push({
        id: slug(`${eventId} ${playerId} round ${roundNumber || rounds.length + 1}`),
        eventId,
        playerId,
        playerName,
        courseId,
        courseName,
        roundNumber: Number.isFinite(roundNumber) ? String(roundNumber) : "",
        date: Number.isFinite(roundNumber) ? addDays(event.date || competition.date, roundNumber - 1) : "",
        score: Number.isFinite(score) ? String(score) : "",
        toPar,
        sourceProvider,
        sourceUrl,
        sourceUpdatedAt: fetchedAt
      });
    });
  });

  const events = [{
    id: eventId,
    name: eventName,
    tour: cleanString(league.name || league.abbreviation || "PGA TOUR"),
    season: season.year ? String(season.year) : "",
    startDate: addDays(event.date || competition.date, 0),
    endDate: addDays(event.endDate || competition.endDate, 0),
    courseId,
    courseName,
    status: eventStatus(event),
    ...sourceFields
  }];
  const courses = courseName ? [{
    id: courseId || slug(courseName),
    name: courseName,
    location: cleanString(options.courseLocation),
    par: inferredPar ? String(inferredPar) : "",
    style: "major championship",
    sourceProvider: cleanString(options.courseSourceUrl ? "Owned course research" : sourceProvider),
    sourceUrl: courseSourceUrl(options),
    sourceUpdatedAt: fetchedAt
  }] : [];
  const courseSetups = courseName ? [{
    id: slug(`${eventId} ${courseId || courseName} setup`),
    eventId,
    courseId: courseId || slug(courseName),
    par: inferredPar ? String(inferredPar) : "",
    sourceProvider: cleanString(options.courseSourceUrl ? "Owned course research" : sourceProvider),
    sourceUrl: courseSourceUrl(options),
    sourceUpdatedAt: fetchedAt
  }] : [];
  const sourceFetches = [{
    id: slug(`${sourceProvider} ${eventId} scoreboard ${fetchedAt}`),
    provider: sourceProvider,
    endpoint: `espn-scoreboard/${event.id}`,
    eventId,
    fetchedAt,
    status: cleanString(options.status || "ok"),
    rowCount: competitors.length,
    sourceUrl
  }];

  return {
    tables: {
      players,
      events,
      courses,
      courseSetups,
      fields,
      rounds,
      sourceFetches
    },
    summary: {
      eventId,
      eventName,
      competitors: competitors.length,
      players: players.length,
      fields: fields.length,
      completedRounds: rounds.length,
      skippedPartialRounds,
      inferredPar
    }
  };
}

async function adaptEspnScoreboard(inputFile, outputDir, options = {}) {
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
  const result = await adaptEspnScoreboard(args.inputFile, args.outputDir, args);
  console.log(`Golf Lab ESPN scoreboard adapted: ${result.outputDir}`);
  console.log(`${result.summary.players} players | ${result.summary.completedRounds} completed rounds | ${result.summary.skippedPartialRounds} partial rounds skipped`);
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
  adaptEspnScoreboard,
  usage
};
