#!/usr/bin/env node
/*
 * Report remaining Golf Lab course metadata gaps by event.
 *
 * This is a repair queue companion for the PGA TOUR schedule enrichment:
 * identify which events still need course proof, and how many scorecard rows
 * would be repaired when each event is resolved.
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");

const GAP_COLUMNS = [
  "severity",
  "season",
  "eventId",
  "eventName",
  "startDate",
  "status",
  "courseId",
  "courseName",
  "coursePoolCourses",
  "roundRows",
  "missingRoundCourseRows",
  "sourceProvider",
  "sourceUrl"
];

function cleanString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function hasCourse(row = {}) {
  return Boolean(cleanString(row.courseId) || cleanString(row.courseName));
}

function coursePoolLabel(rows = []) {
  const names = [...new Set(rows.map((row) => cleanString(row.courseName || row.courseId)).filter(Boolean))];
  if (!names.length) return "";
  return names.slice(0, 3).join(" / ") + (names.length > 3 ? ` +${names.length - 3}` : "");
}

function numberText(value) {
  return Number.isFinite(value) ? String(value) : "";
}

function pctText(numerator, denominator) {
  if (!denominator) return "100";
  return String(Math.round((Math.max(0, Math.min(1, numerator / denominator)) * 1000)) / 10);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(columns, row = {}) {
  return columns.map((column) => csvCell(row[column])).join(",");
}

async function readCollection(inputDir, fileName) {
  const filePath = path.join(inputDir, fileName);
  try {
    return Warehouse.parseGolfLabCsv(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

function buildCourseGapReport(events = [], rounds = [], eventCourses = []) {
  const roundsByEvent = new Map();
  rounds.forEach((round) => {
    const eventId = cleanString(round.eventId);
    if (!eventId) return;
    if (!roundsByEvent.has(eventId)) roundsByEvent.set(eventId, []);
    roundsByEvent.get(eventId).push(round);
  });
  const eventCoursesByEvent = new Map();
  eventCourses.forEach((row) => {
    const eventId = cleanString(row.eventId);
    if (!eventId || !hasCourse(row)) return;
    if (!eventCoursesByEvent.has(eventId)) eventCoursesByEvent.set(eventId, []);
    eventCoursesByEvent.get(eventId).push(row);
  });
  const hasEventCourseCoverage = (event) =>
    hasCourse(event) || (eventCoursesByEvent.get(cleanString(event.id)) || []).length > 0;

  const seasonStats = new Map();
  const gapRows = events
    .map((event) => {
      const poolRows = eventCoursesByEvent.get(cleanString(event.id)) || [];
      const eventRounds = roundsByEvent.get(cleanString(event.id)) || [];
      const missingRoundCourseRows = eventRounds.filter((round) => !hasCourse(round)).length;
      const missingEventCourse = !hasEventCourseCoverage(event);
      if (!missingEventCourse && !missingRoundCourseRows) return null;
      const severity = missingEventCourse && missingRoundCourseRows
        ? "event-and-rounds"
        : missingEventCourse
          ? "event"
          : poolRows.length && missingRoundCourseRows
            ? "rounds-course-pool"
            : "rounds";
      return {
        severity,
        season: cleanString(event.season),
        eventId: cleanString(event.id),
        eventName: cleanString(event.name),
        startDate: cleanString(event.startDate),
        status: cleanString(event.status),
        courseId: cleanString(event.courseId),
        courseName: cleanString(event.courseName) || coursePoolLabel(poolRows),
        coursePoolCourses: numberText(poolRows.length),
        roundRows: numberText(eventRounds.length),
        missingRoundCourseRows: numberText(missingRoundCourseRows),
        sourceProvider: cleanString(event.sourceProvider),
        sourceUrl: cleanString(event.sourceUrl)
      };
    })
    .filter(Boolean)
    .sort((a, b) =>
      Number(b.missingRoundCourseRows) - Number(a.missingRoundCourseRows) ||
      cleanString(a.season).localeCompare(cleanString(b.season)) ||
      cleanString(a.eventName).localeCompare(cleanString(b.eventName))
    );

  events.forEach((event) => {
    const season = cleanString(event.season) || "unknown";
    if (!seasonStats.has(season)) {
      seasonStats.set(season, {
        season,
        events: 0,
        eventsMissingCourse: 0,
        eventsWithCoursePool: 0,
        rounds: 0,
        roundsMissingCourse: 0
      });
    }
    const stat = seasonStats.get(season);
    const eventRounds = roundsByEvent.get(cleanString(event.id)) || [];
    stat.events += 1;
    stat.rounds += eventRounds.length;
    if ((eventCoursesByEvent.get(cleanString(event.id)) || []).length) stat.eventsWithCoursePool += 1;
    if (!hasEventCourseCoverage(event)) stat.eventsMissingCourse += 1;
    stat.roundsMissingCourse += eventRounds.filter((round) => !hasCourse(round)).length;
  });

  const roundsMissingCourse = rounds.filter((round) => !hasCourse(round)).length;
  const eventsWithSingleCourse = events.filter((event) =>
    hasCourse(event) && !(eventCoursesByEvent.get(cleanString(event.id)) || []).length
  ).length;
  const eventsWithCoursePool = events.filter((event) => (eventCoursesByEvent.get(cleanString(event.id)) || []).length).length;
  const eventsWithCourse = events.filter(hasEventCourseCoverage).length;
  const roundsWithCourse = rounds.length - roundsMissingCourse;
  const bySeason = [...seasonStats.values()]
    .map((row) => ({
      ...row,
      eventCourseCoveragePct: pctText(row.events - row.eventsMissingCourse, row.events),
      roundCourseCoveragePct: pctText(row.rounds - row.roundsMissingCourse, row.rounds)
    }))
    .sort((a, b) => cleanString(a.season).localeCompare(cleanString(b.season)));

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      events: events.length,
      eventsWithCourse,
      eventsWithSingleCourse,
      eventsWithCoursePool,
      eventsMissingCourse: events.length - eventsWithCourse,
      eventCourseCoveragePct: pctText(eventsWithCourse, events.length),
      rounds: rounds.length,
      roundsWithCourse,
      roundsMissingCourse,
      roundCourseCoveragePct: pctText(roundsWithCourse, rounds.length),
      gapEvents: gapRows.length
    },
    bySeason,
    gapRows
  };
}

async function loadCourseGapReport(inputDir) {
  const resolved = path.resolve(inputDir);
  const events = await readCollection(resolved, "events.csv");
  const rounds = await readCollection(resolved, "rounds.csv");
  const eventCourses = await readCollection(resolved, "event_courses.csv");
  return buildCourseGapReport(events, rounds, eventCourses);
}

async function writeCourseGapReport(report, options = {}) {
  if (cleanString(options.outputFile)) {
    const outputFile = path.resolve(options.outputFile);
    await fsp.mkdir(path.dirname(outputFile), { recursive: true });
    const body = [GAP_COLUMNS.join(","), ...report.gapRows.map((row) => csvLine(GAP_COLUMNS, row))].join("\n");
    await fsp.writeFile(outputFile, `${body}\n`, "utf8");
  }
  if (cleanString(options.summaryFile)) {
    const summaryFile = path.resolve(options.summaryFile);
    await fsp.mkdir(path.dirname(summaryFile), { recursive: true });
    await fsp.writeFile(summaryFile, `${JSON.stringify({
      generatedAt: report.generatedAt,
      summary: report.summary,
      bySeason: report.bySeason
    }, null, 2)}\n`, "utf8");
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--in") args.inputDir = argv[index += 1];
    else if (token === "--out") args.outputFile = argv[index += 1];
    else if (token === "--summary") args.summaryFile = argv[index += 1];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-course-gap-report.js --in <warehouse-folder> [--out <csv>] [--summary <json>]",
    "",
    "Outputs event-level course metadata gaps and optional season summary JSON."
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.inputDir) throw new Error(`${usage()}\n\nMissing --in.`);
  const report = await loadCourseGapReport(args.inputDir);
  await writeCourseGapReport(report, args);
  console.log(`Golf Lab course gap report: ${report.summary.gapEvents} gap events`);
  console.log(`${report.summary.eventsMissingCourse} events missing course | ${report.summary.roundsMissingCourse} rounds missing course`);
  if (args.outputFile) console.log(`Gap CSV: ${path.resolve(args.outputFile)}`);
  if (args.summaryFile) console.log(`Summary JSON: ${path.resolve(args.summaryFile)}`);
  return 0;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  GAP_COLUMNS,
  parseArgs,
  buildCourseGapReport,
  loadCourseGapReport,
  writeCourseGapReport,
  usage
};
