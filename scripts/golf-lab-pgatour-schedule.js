#!/usr/bin/env node
/*
 * Enrich an existing Golf Lab warehouse with public PGA TOUR schedule courses.
 *
 * Reads saved PGA TOUR schedule pages/JSON, matches official tournament course
 * metadata back to existing event rows, then updates events, rounds, courses,
 * course setups, and source-fetch proof rows together.
 */
const fs = require("node:fs/promises");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");

const MONTHS = Object.freeze({
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
});

const STOP_WORDS = new Set([
  "the",
  "presented",
  "presentedby",
  "by",
  "sponsored",
  "sponsoredby",
  "powered",
  "poweredby",
  "official",
  "pga",
  "tour"
]);

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

function parseArgs(argv) {
  const args = {
    inputFiles: [],
    provider: "PGA TOUR public schedule",
    status: "ok",
    minMatchScore: 0.62
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--in") args.inputFiles.push(argv[index += 1]);
    else if (token === "--batch" || token === "--batch-dir") args.batchDir = argv[index += 1];
    else if (token === "--out") args.outputDir = argv[index += 1];
    else if (token === "--provider") args.provider = argv[index += 1];
    else if (token === "--source-url") args.sourceUrl = argv[index += 1];
    else if (token === "--fetched-at") args.fetchedAt = argv[index += 1];
    else if (token === "--min-match-score") args.minMatchScore = Number(argv[index += 1]);
    else if (token === "--status") args.status = argv[index += 1];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!Number.isFinite(args.minMatchScore)) args.minMatchScore = 0.62;
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-pgatour-schedule.js --in <schedule.html|json> --out <warehouse-folder> [options]",
    "   or: node scripts/golf-lab-pgatour-schedule.js --batch <raw-pgatour-folder> --out <warehouse-folder> [options]",
    "",
    "Options:",
    "  --source-url <url>          Source URL to attach when importing one file.",
    "  --fetched-at <iso>          Fetch timestamp. Defaults to now.",
    "  --provider <name>           Source provider label. Defaults to PGA TOUR public schedule.",
    "  --min-match-score <number>  Conservative event matching threshold. Default 0.62.",
    "  --batch <folder>            Imports schedule*.html/json files from a raw folder."
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

async function readCollection(outputDir, collection) {
  try {
    return Warehouse.parseGolfLabCsv(await fs.readFile(path.join(outputDir, collectionFileName(collection)), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeCollection(outputDir, collection, rows) {
  const columns = Warehouse.COLLECTION_COLUMNS[collection] || [];
  const body = [columns.map(csvCell).join(","), ...rows.map((row) => csvLine(columns, row))].join("\n");
  await fs.writeFile(path.join(outputDir, collectionFileName(collection)), `${body}\n`, "utf8");
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

function mergeProvider(existingProvider, provider) {
  const existing = cleanString(existingProvider);
  const incoming = cleanString(provider);
  if (!existing) return incoming;
  if (!incoming || existing === incoming) return existing;
  if (existing.split(/\s+\+\s+/).includes(incoming)) return existing;
  return `${existing} + ${incoming}`;
}

function latestDate(a, b) {
  return [cleanString(a), cleanString(b)].filter(Boolean).sort().slice(-1)[0] || "";
}

function dateOnly(value) {
  return cleanString(value).slice(0, 10);
}

function isoDate(year, month, day) {
  if (!year || !month || !day) return "";
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function parseDisplayDate(displayDate, year) {
  const clean = cleanString(displayDate).replace(/\./g, "");
  const baseYear = Number(year);
  if (!clean || !Number.isFinite(baseYear)) return { startDate: "", endDate: "" };
  const range = clean.match(/^([A-Za-z]+)\s+(\d{1,2})(?:\s*-\s*(?:([A-Za-z]+)\s+)?(\d{1,2}))?/);
  if (!range) return { startDate: "", endDate: "" };
  const startMonth = MONTHS[range[1].toLowerCase()];
  const startDay = Number(range[2]);
  const endMonth = range[3] ? MONTHS[range[3].toLowerCase()] : startMonth;
  const endDay = range[4] ? Number(range[4]) : startDay;
  if (!startMonth || !endMonth || !startDay || !endDay) return { startDate: "", endDate: "" };
  let endYear = baseYear;
  let startYear = baseYear;
  if (endMonth < startMonth) endYear += 1;
  if (startMonth === 12 && endMonth === 1) startYear = endYear - 1;
  return {
    startDate: isoDate(startYear, startMonth, startDay),
    endDate: isoDate(endYear, endMonth, endDay)
  };
}

function extractNextDataPayload(text) {
  const match = String(text || "").match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  return match ? JSON.parse(match[1]) : null;
}

function scheduleFromPayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.tournaments)) return [payload];
  if (payload.schedule && Array.isArray(payload.schedule.tournaments)) return [payload.schedule];
  const queries = payload.props && payload.props.pageProps && payload.props.pageProps.dehydratedState && payload.props.pageProps.dehydratedState.queries;
  if (Array.isArray(queries)) {
    return queries
      .filter((query) => Array.isArray(query.queryKey) && query.queryKey[0] === "schedule")
      .map((query) => query.state && query.state.data)
      .filter((schedule) => schedule && Array.isArray(schedule.tournaments));
  }
  return [];
}

async function readScheduleInput(inputFile) {
  const text = await fs.readFile(path.resolve(inputFile), "utf8");
  const trimmed = text.trimStart();
  if (/^<!doctype html/i.test(trimmed) || /^<html/i.test(trimmed)) {
    return scheduleFromPayload(extractNextDataPayload(text));
  }
  return scheduleFromPayload(JSON.parse(text));
}

function scheduleSourceUrl(options, schedule) {
  const explicit = cleanString(options.sourceUrl);
  if (explicit) return explicit;
  const season = cleanString(schedule && schedule.season);
  return season ? `https://www.pgatour.com/schedule/${season}` : "https://www.pgatour.com/schedule";
}

function courseLocation(courseData = {}) {
  return [
    cleanString(courseData.city),
    cleanString(courseData.stateCode || courseData.state),
    cleanString(courseData.countryCode || courseData.country)
  ].filter(Boolean).join(", ");
}

function tournamentRecords(schedules, options = {}) {
  const rows = [];
  schedules.forEach((schedule) => {
    const season = cleanString(schedule.season);
    const sourceUrl = scheduleSourceUrl(options, schedule);
    (schedule.tournaments || []).forEach((tournament) => {
      const courseData = tournament.courseData || {};
      const courseName = cleanString(courseData.name);
      if (!courseName) return;
      const year = cleanString(tournament.year || season);
      const dates = parseDisplayDate(tournament.displayDate, year);
      rows.push({
        pgaTourTournamentId: cleanString(tournament.tournamentId),
        name: cleanString(tournament.name),
        season,
        year,
        startDate: dates.startDate,
        endDate: dates.endDate,
        displayDate: cleanString(tournament.displayDate),
        status: cleanString(tournament.status),
        courseId: slug([courseName, courseData.city, courseData.stateCode || courseData.countryCode].filter(Boolean).join(" ")),
        courseName,
        location: courseLocation(courseData),
        city: cleanString(courseData.city),
        stateCode: cleanString(courseData.stateCode),
        country: cleanString(courseData.country || courseData.countryCode),
        sourceUrl
      });
    });
  });
  return rows;
}

function normalizeName(value) {
  return cleanString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/\bpresented\s+by\b.*$/g, "")
    .replace(/\bsponsored\s+by\b.*$/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function nameTokens(value) {
  return normalizeName(value)
    .split(/\s+/)
    .filter((token) => token && !STOP_WORDS.has(token));
}

function tokenScore(a, b) {
  const aTokens = new Set(nameTokens(a));
  const bTokens = new Set(nameTokens(b));
  if (!aTokens.size || !bTokens.size) return 0;
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const score = intersection / Math.max(aTokens.size, bTokens.size);
  if (normalizeName(a) === normalizeName(b)) return 1;
  return score;
}

function dateValue(value) {
  const clean = dateOnly(value);
  if (!clean) return NaN;
  return new Date(`${clean}T00:00:00Z`).getTime();
}

function daysBetween(a, b) {
  const av = dateValue(a);
  const bv = dateValue(b);
  if (!Number.isFinite(av) || !Number.isFinite(bv)) return NaN;
  return Math.abs(Math.round((av - bv) / 86400000));
}

function dateScore(tournament, event) {
  const startDelta = daysBetween(tournament.startDate, event.startDate);
  const endDelta = daysBetween(tournament.endDate, event.endDate);
  const best = Math.min(
    Number.isFinite(startDelta) ? startDelta : Infinity,
    Number.isFinite(endDelta) ? endDelta : Infinity
  );
  if (best === 0) return 1;
  if (best <= 3) return 0.92;
  if (best <= 10) return 0.78;
  if (best <= 21) return 0.48;
  if (cleanString(tournament.year) && cleanString(event.season) === cleanString(tournament.year)) return 0.25;
  return 0;
}

function matchScore(tournament, event) {
  const names = tokenScore(tournament.name, event.name);
  const dates = dateScore(tournament, event);
  if (dates >= 0.78 && names >= 0.3) return (dates * 0.55) + (names * 0.45);
  if (names >= 0.82 && dates >= 0.25) return (names * 0.75) + (dates * 0.25);
  return (names * 0.7) + (dates * 0.3);
}

function matchTournamentsToEvents(tournaments, events, options = {}) {
  const minScore = Number.isFinite(Number(options.minMatchScore)) ? Number(options.minMatchScore) : 0.62;
  const usedEventIds = new Set();
  const matches = [];
  const unmatched = [];
  tournaments.forEach((tournament) => {
    const candidates = events
      .filter((event) => event && event.id && !usedEventIds.has(event.id))
      .map((event) => ({ event, score: matchScore(tournament, event) }))
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const second = candidates[1];
    const clearEnough = best && best.score >= minScore && (!second || best.score - second.score >= 0.04 || best.score >= 0.86);
    if (!clearEnough) {
      unmatched.push({
        tournamentName: tournament.name,
        tournamentId: tournament.pgaTourTournamentId,
        courseName: tournament.courseName,
        bestEvent: best && best.event && best.event.name,
        bestScore: best ? Math.round(best.score * 1000) / 1000 : 0
      });
      return;
    }
    usedEventIds.add(best.event.id);
    matches.push({
      tournament,
      event: best.event,
      score: Math.round(best.score * 1000) / 1000
    });
  });
  return { matches, unmatched };
}

function number(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function roundText(value, digits = 3) {
  if (!Number.isFinite(value)) return "";
  const factor = 10 ** digits;
  return String(Math.round(value * factor) / factor);
}

function eventDifficulty(rounds) {
  const fieldAdjustedToPar = average(rounds.map((round) => number(round.adjustedToPar)));
  if (!Number.isFinite(fieldAdjustedToPar)) return { fieldAdjustedToPar: "", sgDifficulty: "" };
  return {
    fieldAdjustedToPar: roundText(fieldAdjustedToPar),
    sgDifficulty: roundText(-fieldAdjustedToPar)
  };
}

function buildCourseAverage(setups) {
  const byCourse = new Map();
  setups.forEach((setup) => {
    if (!setup.courseId) return;
    if (!byCourse.has(setup.courseId)) byCourse.set(setup.courseId, []);
    byCourse.get(setup.courseId).push(setup);
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

function sourceFetch(provider, schedule, tournaments, matches, options = {}) {
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  const season = cleanString(schedule.season || (tournaments[0] && tournaments[0].season));
  const sourceUrl = scheduleSourceUrl(options, schedule);
  return {
    id: slug([provider, "schedule", season, fetchedAt].join(" ")),
    provider,
    endpoint: season ? `pgatour-schedule/${season}` : "pgatour-schedule",
    eventId: "",
    fetchedAt,
    status: cleanString(options.status || "ok"),
    rowCount: tournaments.length,
    manifestJson: JSON.stringify({
      sourceType: "public-pgatour-schedule",
      season,
      matchedEvents: matches.length,
      courseRows: tournaments.filter((row) => row.courseName).length
    }),
    sourceUrl
  };
}

function buildEnrichment(existing, schedules, options = {}) {
  const provider = cleanString(options.provider || "PGA TOUR public schedule");
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  const tournaments = tournamentRecords(schedules, options);
  const { matches, unmatched } = matchTournamentsToEvents(tournaments, existing.events || [], options);
  const matchedByEvent = new Map(matches.map((match) => [match.event.id, match]));
  const roundsByEvent = new Map();
  (existing.rounds || []).forEach((round) => {
    if (!round.eventId) return;
    if (!roundsByEvent.has(round.eventId)) roundsByEvent.set(round.eventId, []);
    roundsByEvent.get(round.eventId).push(round);
  });

  const sourceFields = { sourceProvider: provider, sourceUpdatedAt: fetchedAt };
  const events = (existing.events || []).map((event) => {
    const match = matchedByEvent.get(event.id);
    if (!match) return event;
    return {
      ...event,
      courseId: match.tournament.courseId,
      courseName: match.tournament.courseName,
      sourceProvider: mergeProvider(event.sourceProvider, provider),
      sourceUpdatedAt: latestDate(event.sourceUpdatedAt, fetchedAt)
    };
  });

  const rounds = (existing.rounds || []).map((round) => {
    const match = matchedByEvent.get(round.eventId);
    if (!match) return round;
    return {
      ...round,
      courseId: match.tournament.courseId,
      courseName: match.tournament.courseName,
      sourceProvider: mergeProvider(round.sourceProvider, provider),
      sourceUpdatedAt: latestDate(round.sourceUpdatedAt, fetchedAt)
    };
  });

  const coursesIncoming = [];
  const setupsIncoming = [];
  matches.forEach((match) => {
    const eventRounds = roundsByEvent.get(match.event.id) || [];
    const difficulty = eventDifficulty(eventRounds);
    coursesIncoming.push({
      id: match.tournament.courseId,
      name: match.tournament.courseName,
      location: match.tournament.location,
      fieldAdjustedToPar: difficulty.fieldAdjustedToPar,
      sgDifficulty: difficulty.sgDifficulty,
      style: "",
      sourceUrl: match.tournament.sourceUrl,
      ...sourceFields
    });
    setupsIncoming.push({
      id: slug([match.event.id, match.tournament.courseId, "schedule-setup"].join(" ")),
      eventId: match.event.id,
      courseId: match.tournament.courseId,
      fieldAdjustedToPar: difficulty.fieldAdjustedToPar,
      sgDifficulty: difficulty.sgDifficulty,
      sourceUrl: match.tournament.sourceUrl,
      ...sourceFields
    });
  });

  const courseAverages = buildCourseAverage(setupsIncoming);
  const courses = upsertRows(existing.courses || [], coursesIncoming).map((course) => {
    const averageDifficulty = courseAverages.get(course.id);
    if (!averageDifficulty) return course;
    return {
      ...course,
      fieldAdjustedToPar: averageDifficulty.fieldAdjustedToPar || course.fieldAdjustedToPar,
      sgDifficulty: averageDifficulty.sgDifficulty || course.sgDifficulty
    };
  });
  const courseSetups = upsertRows(existing.courseSetups || [], setupsIncoming);
  const sourceFetches = upsertRows(
    existing.sourceFetches || [],
    schedules.map((schedule) =>
      sourceFetch(
        provider,
        schedule,
        tournaments.filter((row) => row.season === cleanString(schedule.season)),
        matches.filter((match) => match.tournament.season === cleanString(schedule.season)),
        options
      )
    )
  );

  return {
    tables: {
      events,
      rounds,
      courses,
      courseSetups,
      sourceFetches
    },
    summary: {
      schedules: schedules.length,
      tournaments: tournaments.length,
      matches: matches.length,
      unmatchedCount: unmatched.length,
      courses: courses.length,
      courseSetups: courseSetups.length,
      roundsUpdated: rounds.filter((round) => matchedByEvent.has(round.eventId)).length,
      matchedEvents: matches.map((match) => ({
        eventId: match.event.id,
        eventName: match.event.name,
        courseName: match.tournament.courseName,
        score: match.score
      })),
      unmatched: unmatched.slice(0, 40)
    }
  };
}

async function batchInputFiles(batchDir) {
  if (!batchDir) return [];
  const resolved = path.resolve(batchDir);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(resolved, entry.name))
    .filter((file) => /schedule.*\.(html|json)$/i.test(path.basename(file)))
    .sort((a, b) => a.localeCompare(b));
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

async function enrichPgaTourSchedule(inputFiles, outputDir, options = {}) {
  const resolvedOutput = path.resolve(outputDir);
  const files = [...(inputFiles || []), ...(await batchInputFiles(options.batchDir))].map((file) => path.resolve(file));
  if (!files.length) throw new Error("No PGA TOUR schedule input files were provided.");
  const schedules = [];
  for (const file of files) {
    schedules.push(...await readScheduleInput(file));
  }
  const existing = await loadExistingWarehouse(resolvedOutput);
  const result = buildEnrichment(existing, schedules, options);
  await writeCollection(resolvedOutput, "events", result.tables.events);
  await writeCollection(resolvedOutput, "rounds", result.tables.rounds);
  await writeCollection(resolvedOutput, "courses", result.tables.courses);
  await writeCollection(resolvedOutput, "courseSetups", result.tables.courseSetups);
  await writeCollection(resolvedOutput, "sourceFetches", result.tables.sourceFetches);
  return {
    inputFiles: files,
    outputDir: resolvedOutput,
    summary: result.summary
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.outputDir) throw new Error(`${usage()}\n\nMissing --out.`);
  const result = await enrichPgaTourSchedule(args.inputFiles, args.outputDir, args);
  console.log(`Golf Lab PGA TOUR schedule enrichment written: ${result.outputDir}`);
  console.log(`${result.summary.matches} matched events | ${result.summary.roundsUpdated} rounds updated | ${result.summary.unmatchedCount} unmatched tournaments`);
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
  parseDisplayDate,
  scheduleFromPayload,
  tournamentRecords,
  matchTournamentsToEvents,
  buildEnrichment,
  enrichPgaTourSchedule,
  usage
};
