#!/usr/bin/env node
/*
 * Convert a saved ESPN PGA season scoreboard JSON response into Golf Lab CSVs.
 *
 * ESPN's public season payload can include many completed tournament scoreboards.
 * This adapter walks every event in that saved payload and imports source-backed
 * player, field, event, and round rows. Course rows are only written when a
 * verified course map supplies venue details.
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const { buildRows } = require("./golf-lab-espn.js");
const {
  buildGolfLabBundleFromDirectory,
  buildGolfLabBuildReport
} = require("./golf-lab-build.js");

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
    provider: "ESPN public season scoreboard",
    sourceBaseUrl: "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard",
    status: "ok",
    minCompletedRounds: 1,
    includePartial: false,
    includeZeroRoundEvents: false,
    pretty: true,
    clean: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--in") args.inputFile = argv[index += 1];
    else if (token === "--out") args.outputDir = argv[index += 1];
    else if (token === "--build-out") args.bundleFile = argv[index += 1];
    else if (token === "--report") args.reportFile = argv[index += 1];
    else if (token === "--provider") args.provider = argv[index += 1];
    else if (token === "--source-base-url") args.sourceBaseUrl = argv[index += 1];
    else if (token === "--fetched-at") args.fetchedAt = argv[index += 1];
    else if (token === "--course-map") args.courseMapFile = argv[index += 1];
    else if (token === "--min-completed-rounds") args.minCompletedRounds = Number(argv[index += 1]);
    else if (token === "--include-partial") args.includePartial = true;
    else if (token === "--include-zero-round-events") args.includeZeroRoundEvents = true;
    else if (token === "--clean") args.clean = true;
    else if (token === "--compact") args.pretty = false;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!Number.isFinite(args.minCompletedRounds) || args.minCompletedRounds < 0) args.minCompletedRounds = 1;
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-espn-season.js --in <season-scoreboard.json> --out <folder> [options]",
    "",
    "Options:",
    "  --build-out <file>              Optional Golf Lab import bundle output.",
    "  --report <file>                 Optional build report output.",
    "  --provider <name>               Source provider label.",
    "  --source-base-url <url>         Base ESPN scoreboard URL.",
    "  --fetched-at <iso>              Fetch timestamp for source rows.",
    "  --course-map <file.json>        Optional verified course metadata by ESPN id or event id.",
    "  --min-completed-rounds <count>  Skip events below this completed-round count. Default 1.",
    "  --include-partial               Include in-progress/partial round rows.",
    "  --include-zero-round-events     Keep team/match events with no completed round rows.",
    "  --clean                         Clear existing collection CSVs in --out before adapting.",
    "  --compact                       Write bundle/report JSON without indentation."
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
    return Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, fileName), "utf8"));
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
  if (!rows.length) return null;
  const fileName = `${collection.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}.csv`;
  const columns = Warehouse.COLLECTION_COLUMNS[collection] || [];
  const existing = await readExistingRows(outputDir, fileName);
  const merged = upsertRows(existing, rows);
  const body = [columns.map(csvCell).join(","), ...merged.map((row) => csvLine(columns, row))].join("\n");
  await fsp.writeFile(path.join(outputDir, fileName), `${body}\n`, "utf8");
  return { collection, fileName, rows: merged.length, incoming: rows.length };
}

async function cleanOutputCollections(outputDir) {
  await fsp.mkdir(outputDir, { recursive: true });
  const fileNames = Object.keys(Warehouse.COLLECTION_COLUMNS).map((collection) =>
    `${collection.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}.csv`
  );
  await Promise.all(fileNames.map(async (fileName) => {
    try {
      await fsp.unlink(path.join(outputDir, fileName));
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }));
}

async function readCourseMap(courseMapFile) {
  if (!courseMapFile) return {};
  return JSON.parse(await fsp.readFile(path.resolve(courseMapFile), "utf8"));
}

function courseForEvent(event, eventId, courseMap = {}) {
  return courseMap[event.id] || courseMap[eventId] || courseMap[slug(event.name)] || {};
}

function eventDateKey(event) {
  return cleanString(event.endDate || event.date).slice(0, 10).replace(/-/g, "");
}

function eventSourceUrl(baseUrl, event) {
  const key = eventDateKey(event);
  return key ? `${cleanString(baseUrl).replace(/\?+$/, "")}?dates=${key}` : cleanString(baseUrl);
}

function singleEventPayload(payload, event) {
  return {
    ...payload,
    events: [event]
  };
}

async function writeTables(outputDir, tables) {
  const writes = [];
  for (const [collection, rows] of Object.entries(tables)) {
    const write = await writeCollection(outputDir, collection, rows);
    if (write) writes.push(write);
  }
  return writes;
}

async function adaptEspnSeasonScoreboard(inputFile, outputDir, options = {}) {
  const resolvedInput = path.resolve(inputFile);
  const resolvedOutput = path.resolve(outputDir);
  const payload = JSON.parse(await fsp.readFile(resolvedInput, "utf8"));
  const events = Array.isArray(payload.events) ? payload.events : [];
  const courseMap = await readCourseMap(options.courseMapFile);
  const minCompletedRounds = Number.isFinite(Number(options.minCompletedRounds)) ? Number(options.minCompletedRounds) : 1;
  if (options.clean) await cleanOutputCollections(resolvedOutput);
  await fsp.mkdir(resolvedOutput, { recursive: true });

  const adapted = [];
  const skipped = [];
  const combinedTables = {};
  for (const event of events) {
    const eventId = slug(`${event.season && event.season.year ? event.season.year : ""} ${event.name} ${event.id || ""}`) || cleanString(event.id);
    const competition = event && Array.isArray(event.competitions) ? event.competitions[0] : null;
    if (!competition || !Array.isArray(competition.competitors)) {
      skipped.push({
        eventId,
        espnEventId: cleanString(event && event.id),
        eventName: cleanString(event && event.name),
        completedRounds: 0,
        reason: "missing-competition"
      });
      continue;
    }
    const course = courseForEvent(event, eventId, courseMap);
    const result = buildRows(singleEventPayload(payload, event), {
      eventId,
      courseId: cleanString(course.courseId || course.id),
      courseName: cleanString(course.courseName || course.name),
      courseLocation: cleanString(course.courseLocation || course.location),
      courseSourceUrl: cleanString(course.courseSourceUrl || course.sourceUrl),
      provider: cleanString(options.provider || "ESPN public season scoreboard"),
      sourceUrl: eventSourceUrl(options.sourceBaseUrl, event),
      fetchedAt: cleanString(options.fetchedAt) || new Date().toISOString(),
      includePartial: Boolean(options.includePartial),
      status: cleanString(options.status || "ok")
    });
    const completedRounds = result.summary.completedRounds;
    if (!options.includeZeroRoundEvents && completedRounds < minCompletedRounds) {
      skipped.push({
        eventId,
        espnEventId: cleanString(event.id),
        eventName: cleanString(event.name),
        completedRounds,
        reason: "below-min-completed-rounds"
      });
      continue;
    }
    Object.entries(result.tables).forEach(([collection, rows]) => {
      if (!combinedTables[collection]) combinedTables[collection] = [];
      combinedTables[collection].push(...rows);
    });
    adapted.push({
      eventId,
      espnEventId: cleanString(event.id),
      eventName: result.summary.eventName,
      players: result.summary.players,
      completedRounds,
      skippedPartialRounds: result.summary.skippedPartialRounds,
      courseMapped: Boolean(cleanString(course.courseName || course.name))
    });
  }
  const writes = await writeTables(resolvedOutput, combinedTables);

  let bundle = null;
  if (options.bundleFile || options.reportFile) {
    bundle = await buildGolfLabBundleFromDirectory(resolvedOutput, { provider: options.provider });
    if (options.bundleFile) {
      await fsp.mkdir(path.dirname(path.resolve(options.bundleFile)), { recursive: true });
      await fsp.writeFile(
        options.bundleFile,
        JSON.stringify(bundle, null, options.pretty === false ? 0 : 2),
        "utf8"
      );
    }
    if (options.reportFile) {
      await fsp.mkdir(path.dirname(path.resolve(options.reportFile)), { recursive: true });
      await fsp.writeFile(
        options.reportFile,
        JSON.stringify(buildGolfLabBuildReport(bundle), null, options.pretty === false ? 0 : 2),
        "utf8"
      );
    }
  }

  return {
    inputFile: resolvedInput,
    outputDir: resolvedOutput,
    writes,
    adapted,
    skipped,
    bundleReport: bundle ? bundle.report : null
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.inputFile || !args.outputDir) throw new Error(`${usage()}\n\nMissing --in or --out.`);
  const result = await adaptEspnSeasonScoreboard(args.inputFile, args.outputDir, args);
  console.log(`Golf Lab ESPN season adapted: ${result.outputDir}`);
  console.log(`${result.adapted.length} events imported | ${result.skipped.length} events skipped`);
  const rounds = result.adapted.reduce((sum, event) => sum + event.completedRounds, 0);
  console.log(`${rounds} completed rounds imported`);
  if (result.bundleReport) {
    console.log(`${result.bundleReport.totalRecords} records | warehouse score ${result.bundleReport.score} | grade ${result.bundleReport.grade}`);
  }
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
  eventSourceUrl,
  adaptEspnSeasonScoreboard,
  usage
};
