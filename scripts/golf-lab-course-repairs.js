#!/usr/bin/env node
/*
 * Apply verified event-course repairs to a Golf Lab warehouse.
 *
 * Input CSV columns:
 *   eventId,courseId,courseName,location,par,yards,sourceProvider,sourceUrl,sourceUpdatedAt
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");

function cleanString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\s+/g, " ");
}

function slug(value) {
  return cleanString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function collectionFileName(collection) {
  return `${collection.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}.csv`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(columns, row = {}) {
  return columns.map((column) => csvCell(row[column])).join(",");
}

async function readCollection(outputDir, collection) {
  try {
    return Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, collectionFileName(collection)), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeCollection(outputDir, collection, rows) {
  const columns = Warehouse.COLLECTION_COLUMNS[collection] || [];
  const body = [columns.map(csvCell).join(","), ...rows.map((row) => csvLine(columns, row))].join("\n");
  await fsp.writeFile(path.join(outputDir, collectionFileName(collection)), `${body}\n`, "utf8");
}

function hasValue(value) {
  return value !== null && value !== undefined && cleanString(value) !== "";
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

function mergeProvider(existing, provider) {
  const parts = cleanString(existing).split(/\s+\+\s+/).filter(Boolean);
  const incoming = cleanString(provider);
  if (incoming && !parts.includes(incoming)) parts.push(incoming);
  return parts.join(" + ");
}

function latestDate(...values) {
  return values.map(cleanString).filter(Boolean).sort().slice(-1)[0] || "";
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function roundText(value) {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "";
}

function eventDifficulty(rounds) {
  const fieldAdjustedToPar = average((rounds || []).map((round) => number(round.adjustedToPar)));
  if (!Number.isFinite(fieldAdjustedToPar)) return { fieldAdjustedToPar: "", sgDifficulty: "" };
  return {
    fieldAdjustedToPar: roundText(fieldAdjustedToPar),
    sgDifficulty: roundText(-fieldAdjustedToPar)
  };
}

function buildCourseAverage(setups) {
  const byCourse = new Map();
  setups.forEach((setup) => {
    const courseId = cleanString(setup.courseId);
    if (!courseId) return;
    if (!byCourse.has(courseId)) byCourse.set(courseId, []);
    byCourse.get(courseId).push(setup);
  });
  const averages = new Map();
  byCourse.forEach((rows, courseId) => {
    const fieldAdjustedToPar = average(rows.map((row) => number(row.fieldAdjustedToPar)));
    averages.set(courseId, {
      fieldAdjustedToPar: Number.isFinite(fieldAdjustedToPar) ? roundText(fieldAdjustedToPar) : "",
      sgDifficulty: Number.isFinite(fieldAdjustedToPar) ? roundText(-fieldAdjustedToPar) : ""
    });
  });
  return averages;
}

function normalizeRepair(row = {}, options = {}) {
  const eventId = cleanString(row.eventId || row.event_id);
  const courseName = cleanString(row.courseName || row.course_name);
  const location = cleanString(row.location);
  const courseId = cleanString(row.courseId || row.course_id) || slug([courseName, location].filter(Boolean).join(" "));
  const provider = cleanString(row.sourceProvider || row.source_provider || options.provider || "Verified public course repair");
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  return {
    eventId,
    courseId,
    courseName,
    location,
    par: cleanString(row.par),
    yards: cleanString(row.yards),
    sourceProvider: provider,
    sourceUrl: cleanString(row.sourceUrl || row.source_url),
    sourceUpdatedAt: cleanString(row.sourceUpdatedAt || row.source_updated_at || options.sourceUpdatedAt || fetchedAt)
  };
}

function applyCourseRepairsToTables(existing, repairRows, options = {}) {
  const repairs = (repairRows || []).map((row) => normalizeRepair(row, options)).filter((row) => row.eventId && row.courseId && row.courseName);
  const repairByEvent = new Map(repairs.map((repair) => [repair.eventId, repair]));
  const roundsByEvent = new Map();
  (existing.rounds || []).forEach((round) => {
    const eventId = cleanString(round.eventId);
    if (!eventId) return;
    if (!roundsByEvent.has(eventId)) roundsByEvent.set(eventId, []);
    roundsByEvent.get(eventId).push(round);
  });

  let eventsUpdated = 0;
  let roundsUpdated = 0;
  const updatedEvents = (existing.events || []).map((event) => {
    const repair = repairByEvent.get(cleanString(event.id));
    if (!repair) return event;
    eventsUpdated += 1;
    return {
      ...event,
      courseId: repair.courseId,
      courseName: repair.courseName,
      sourceProvider: mergeProvider(event.sourceProvider, repair.sourceProvider),
      sourceUpdatedAt: latestDate(event.sourceUpdatedAt, repair.sourceUpdatedAt)
    };
  });

  const updatedRounds = (existing.rounds || []).map((round) => {
    const repair = repairByEvent.get(cleanString(round.eventId));
    if (!repair) return round;
    roundsUpdated += 1;
    return {
      ...round,
      courseId: repair.courseId,
      courseName: repair.courseName,
      sourceProvider: mergeProvider(round.sourceProvider, repair.sourceProvider),
      sourceUpdatedAt: latestDate(round.sourceUpdatedAt, repair.sourceUpdatedAt)
    };
  });

  const coursesIncoming = [];
  const setupsIncoming = [];
  repairs.forEach((repair) => {
    const difficulty = eventDifficulty(roundsByEvent.get(repair.eventId) || []);
    coursesIncoming.push({
      id: repair.courseId,
      name: repair.courseName,
      location: repair.location,
      par: repair.par,
      yards: repair.yards,
      fieldAdjustedToPar: difficulty.fieldAdjustedToPar,
      sgDifficulty: difficulty.sgDifficulty,
      sourceProvider: repair.sourceProvider,
      sourceUrl: repair.sourceUrl,
      sourceUpdatedAt: repair.sourceUpdatedAt
    });
    setupsIncoming.push({
      id: slug([repair.eventId, repair.courseId, "course-repair-setup"].join(" ")),
      eventId: repair.eventId,
      courseId: repair.courseId,
      par: repair.par,
      yards: repair.yards,
      fieldAdjustedToPar: difficulty.fieldAdjustedToPar,
      sgDifficulty: difficulty.sgDifficulty,
      sourceProvider: repair.sourceProvider,
      sourceUrl: repair.sourceUrl,
      sourceUpdatedAt: repair.sourceUpdatedAt
    });
  });

  const courseSetups = upsertRows(existing.courseSetups || [], setupsIncoming);
  const courseAverages = buildCourseAverage(courseSetups);
  const courses = upsertRows(existing.courses || [], coursesIncoming).map((course) => {
    const averageDifficulty = courseAverages.get(cleanString(course.id));
    if (!averageDifficulty) return course;
    return {
      ...course,
      fieldAdjustedToPar: averageDifficulty.fieldAdjustedToPar || course.fieldAdjustedToPar,
      sgDifficulty: averageDifficulty.sgDifficulty || course.sgDifficulty
    };
  });
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  const provider = cleanString(options.provider || (repairs[0] && repairs[0].sourceProvider) || "Verified public course repair");
  const sourceFetches = upsertRows(existing.sourceFetches || [], [{
    id: slug([provider, "course-repairs", fetchedAt].join(" ")),
    provider,
    endpoint: "course-repairs/manual-verified",
    fetchedAt,
    status: cleanString(options.status || "ok"),
    rowCount: repairs.length,
    manifestJson: JSON.stringify({
      sourceType: "manual-verified-course-repairs",
      eventsUpdated,
      roundsUpdated,
      eventIds: repairs.map((repair) => repair.eventId),
      note: "Event-course repairs sourced from public venue references; updates event, round, course, and setup rows together."
    }),
    sourceUrl: cleanString(options.sourceUrl || "data/golf-lab/course-repairs")
  }]);

  return {
    tables: {
      events: updatedEvents,
      rounds: updatedRounds,
      courses,
      courseSetups,
      sourceFetches
    },
    summary: {
      repairs: repairs.length,
      eventsUpdated,
      roundsUpdated,
      courses: courses.length,
      courseSetups: courseSetups.length
    }
  };
}

async function loadExistingWarehouse(outputDir) {
  return {
    events: await readCollection(outputDir, "events"),
    rounds: await readCollection(outputDir, "rounds"),
    courses: await readCollection(outputDir, "courses"),
    courseSetups: await readCollection(outputDir, "courseSetups"),
    sourceFetches: await readCollection(outputDir, "sourceFetches")
  };
}

async function loadRepairRows(repairsFile) {
  return Warehouse.parseGolfLabCsv(await fsp.readFile(path.resolve(repairsFile), "utf8"));
}

async function applyCourseRepairs(repairsFile, outputDir, options = {}) {
  const resolvedOutput = path.resolve(outputDir);
  const existing = await loadExistingWarehouse(resolvedOutput);
  const repairRows = await loadRepairRows(repairsFile);
  const result = applyCourseRepairsToTables(existing, repairRows, options);
  await fsp.mkdir(resolvedOutput, { recursive: true });
  await writeCollection(resolvedOutput, "events", result.tables.events);
  await writeCollection(resolvedOutput, "rounds", result.tables.rounds);
  await writeCollection(resolvedOutput, "courses", result.tables.courses);
  await writeCollection(resolvedOutput, "courseSetups", result.tables.courseSetups);
  await writeCollection(resolvedOutput, "sourceFetches", result.tables.sourceFetches);
  return {
    repairsFile: path.resolve(repairsFile),
    outputDir: resolvedOutput,
    summary: result.summary
  };
}

function parseArgs(argv) {
  const args = {
    provider: "Verified public course repair",
    status: "ok"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--repairs") args.repairsFile = argv[index += 1];
    else if (token === "--out") args.outputDir = argv[index += 1];
    else if (token === "--provider") args.provider = argv[index += 1];
    else if (token === "--fetched-at") args.fetchedAt = argv[index += 1];
    else if (token === "--source-url") args.sourceUrl = argv[index += 1];
    else if (token === "--status") args.status = argv[index += 1];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-course-repairs.js --repairs <csv> --out <warehouse-folder> [options]",
    "",
    "Options:",
    "  --provider <name>       Source provider label. Defaults to Verified public course repair.",
    "  --fetched-at <iso>      Repair timestamp. Defaults to now.",
    "  --source-url <url>      Source pointer for source_fetches.csv."
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.repairsFile || !args.outputDir) throw new Error(`${usage()}\n\nMissing --repairs or --out.`);
  const result = await applyCourseRepairs(args.repairsFile, args.outputDir, args);
  console.log(`Golf Lab course repairs written: ${result.outputDir}`);
  console.log(`${result.summary.repairs} repairs | ${result.summary.eventsUpdated} events updated | ${result.summary.roundsUpdated} rounds updated`);
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
  normalizeRepair,
  applyCourseRepairsToTables,
  applyCourseRepairs,
  usage
};
