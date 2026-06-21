#!/usr/bin/env node
/*
 * Apply multi-course tournament pools to a Golf Lab warehouse.
 *
 * Input CSV columns:
 *   eventId,courseId,courseName,location,courseOrder,roundNumbers,rotationRole,par,yards,confidence,note,sourceProvider,sourceUrl,sourceUpdatedAt
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

function normalizePoolRow(row = {}, options = {}) {
  const eventId = cleanString(row.eventId || row.event_id);
  const courseName = cleanString(row.courseName || row.course_name || row.name);
  const location = cleanString(row.location);
  const courseId = cleanString(row.courseId || row.course_id) || slug([courseName, location].filter(Boolean).join(" "));
  const provider = cleanString(row.sourceProvider || row.source_provider || options.provider || "Verified public multi-course repair");
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  const courseOrder = cleanString(row.courseOrder || row.course_order || row.order);
  const rotationRole = cleanString(row.rotationRole || row.rotation_role || row.role);
  return {
    id: cleanString(row.id || row.eventCourseId || row.event_course_id) || slug([eventId, courseId || courseName, courseOrder || rotationRole].join(" ")),
    eventId,
    courseId,
    courseName,
    location,
    courseOrder,
    roundNumbers: cleanString(row.roundNumbers || row.round_numbers || row.rounds),
    rotationRole,
    par: cleanString(row.par),
    yards: cleanString(row.yards),
    confidence: cleanString(row.confidence || options.confidence || "verified"),
    note: cleanString(row.note),
    sourceProvider: provider,
    sourceUrl: cleanString(row.sourceUrl || row.source_url || options.sourceUrl),
    sourceUpdatedAt: cleanString(row.sourceUpdatedAt || row.source_updated_at || options.sourceUpdatedAt || fetchedAt)
  };
}

function groupByEvent(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const eventId = cleanString(row.eventId);
    if (!eventId) return;
    if (!groups.has(eventId)) groups.set(eventId, []);
    groups.get(eventId).push(row);
  });
  return groups;
}

function poolLabel(rows = []) {
  const names = rows.map((row) => cleanString(row.courseName || row.courseId)).filter(Boolean);
  return names.slice(0, 3).join(" / ") + (names.length > 3 ? ` +${names.length - 3}` : "");
}

function applyEventCoursePoolsToTables(existing, poolRows, options = {}) {
  const pools = (poolRows || [])
    .map((row) => normalizePoolRow(row, options))
    .filter((row) => row.eventId && row.courseId && row.courseName);
  const poolsByEvent = groupByEvent(pools);
  let eventsUpdated = 0;
  const updatedEvents = (existing.events || []).map((event) => {
    const eventPools = poolsByEvent.get(cleanString(event.id)) || [];
    if (!eventPools.length) return event;
    eventsUpdated += 1;
    const provider = eventPools.map((row) => row.sourceProvider).filter(Boolean)[0] || options.provider;
    return {
      ...event,
      courseName: cleanString(event.courseName) || poolLabel(eventPools),
      sourceProvider: mergeProvider(event.sourceProvider, provider),
      sourceUpdatedAt: latestDate(event.sourceUpdatedAt, ...eventPools.map((row) => row.sourceUpdatedAt))
    };
  });

  const coursesIncoming = pools.map((row) => ({
    id: row.courseId,
    name: row.courseName,
    location: row.location,
    par: row.par,
    yards: row.yards,
    sourceProvider: row.sourceProvider,
    sourceUrl: row.sourceUrl,
    sourceUpdatedAt: row.sourceUpdatedAt
  }));

  const setupsIncoming = pools
    .filter((row) => row.par || row.yards)
    .map((row) => ({
      id: slug([row.eventId, row.courseId, "course-pool-setup"].join(" ")),
      eventId: row.eventId,
      courseId: row.courseId,
      par: row.par,
      yards: row.yards,
      weatherNote: [row.rotationRole, row.roundNumbers, row.note].filter(Boolean).join(" | "),
      sourceProvider: row.sourceProvider,
      sourceUrl: row.sourceUrl,
      sourceUpdatedAt: row.sourceUpdatedAt
    }));

  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  const provider = cleanString(options.provider || (pools[0] && pools[0].sourceProvider) || "Verified public multi-course repair");
  const sourceFetches = upsertRows(existing.sourceFetches || [], [{
    id: slug([provider, "event-course-pools", fetchedAt].join(" ")),
    provider,
    endpoint: "course-repairs/manual-multi-course-pools",
    fetchedAt,
    status: cleanString(options.status || "ok"),
    rowCount: pools.length,
    manifestJson: JSON.stringify({
      sourceType: "manual-verified-event-course-pools",
      eventsUpdated,
      eventIds: [...poolsByEvent.keys()],
      note: "Adds multi-course event pools while preserving round-level course assignment as a separate data-quality step."
    }),
    sourceUrl: cleanString(options.sourceUrl || "data/golf-lab/event-course-pools")
  }]);

  return {
    tables: {
      events: updatedEvents,
      courses: upsertRows(existing.courses || [], coursesIncoming),
      courseSetups: upsertRows(existing.courseSetups || [], setupsIncoming),
      eventCourses: upsertRows(existing.eventCourses || [], pools),
      sourceFetches
    },
    summary: {
      pools: pools.length,
      eventsUpdated,
      eventsWithPools: poolsByEvent.size,
      courses: upsertRows(existing.courses || [], coursesIncoming).length,
      courseSetups: upsertRows(existing.courseSetups || [], setupsIncoming).length,
      eventCourses: upsertRows(existing.eventCourses || [], pools).length
    }
  };
}

async function loadExistingWarehouse(outputDir) {
  return {
    events: await readCollection(outputDir, "events"),
    courses: await readCollection(outputDir, "courses"),
    courseSetups: await readCollection(outputDir, "courseSetups"),
    eventCourses: await readCollection(outputDir, "eventCourses"),
    sourceFetches: await readCollection(outputDir, "sourceFetches")
  };
}

async function loadPoolRows(poolsFile) {
  return Warehouse.parseGolfLabCsv(await fsp.readFile(path.resolve(poolsFile), "utf8"));
}

async function applyEventCoursePools(poolsFile, outputDir, options = {}) {
  const resolvedOutput = path.resolve(outputDir);
  const existing = await loadExistingWarehouse(resolvedOutput);
  const poolRows = await loadPoolRows(poolsFile);
  const result = applyEventCoursePoolsToTables(existing, poolRows, options);
  await fsp.mkdir(resolvedOutput, { recursive: true });
  await writeCollection(resolvedOutput, "events", result.tables.events);
  await writeCollection(resolvedOutput, "courses", result.tables.courses);
  await writeCollection(resolvedOutput, "courseSetups", result.tables.courseSetups);
  await writeCollection(resolvedOutput, "eventCourses", result.tables.eventCourses);
  await writeCollection(resolvedOutput, "sourceFetches", result.tables.sourceFetches);
  return {
    poolsFile: path.resolve(poolsFile),
    outputDir: resolvedOutput,
    summary: result.summary
  };
}

function parseArgs(argv) {
  const args = {
    provider: "Verified public multi-course repair",
    status: "ok"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--pools") args.poolsFile = argv[index += 1];
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
    "Usage: node scripts/golf-lab-event-course-pools.js --pools <csv> --out <warehouse-folder> [options]",
    "",
    "Options:",
    "  --provider <name>       Source provider label. Defaults to Verified public multi-course repair.",
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
  if (!args.poolsFile || !args.outputDir) throw new Error(`${usage()}\n\nMissing --pools or --out.`);
  const result = await applyEventCoursePools(args.poolsFile, args.outputDir, args);
  console.log(`Golf Lab event course pools written: ${result.outputDir}`);
  console.log(`${result.summary.pools} pool rows | ${result.summary.eventsWithPools} events with course pools | ${result.summary.eventsUpdated} events updated`);
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
  normalizePoolRow,
  applyEventCoursePoolsToTables,
  applyEventCoursePools,
  usage
};
