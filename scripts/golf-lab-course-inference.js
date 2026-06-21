#!/usr/bin/env node
/*
 * Generate conservative course repair rows from recurring verified event history.
 *
 * This does not fetch new sources and does not mutate the warehouse. It uses
 * already verified event-course rows, explicit stable-series policies, and
 * writes a reviewable repairs CSV for golf-lab-course-repairs.js.
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");

const REPAIR_COLUMNS = [
  "eventId",
  "courseId",
  "courseName",
  "location",
  "par",
  "yards",
  "sourceProvider",
  "sourceUrl",
  "sourceUpdatedAt",
  "inferenceKey",
  "verifiedEvents",
  "verifiedSeasons",
  "policyNote"
];

const SERIES_POLICIES = Object.freeze({
  "arnold palmer invitational": { minVerified: 4, minSeason: 2005, note: "Bay Hill hosted the recurring Arnold Palmer/Bay Hill Invitational series." },
  "byron nelson": { minVerified: 4, minSeason: 2005, preferredCourseName: "TPC Four Seasons Resort", note: "TPC Four Seasons hosted the Byron Nelson before the later Trinity Forest and TPC Craig Ranch venue moves." },
  "colonial": { minVerified: 4, minSeason: 2005, note: "Colonial is a stable recurring venue series." },
  "deutsche bank championship": { minVerified: 4, minSeason: 2005, note: "TPC Boston stable FedExCup playoff series." },
  "heritage": { minVerified: 4, minSeason: 2005, note: "Harbour Town stable Heritage/RBC Heritage venue lineage." },
  "farmers insurance open": { minVerified: 4, minSeason: 2005, note: "Torrey Pines host-course inference; multi-course early rounds remain a known limitation." },
  "fedex st jude classic": { minVerified: 4, minSeason: 2005, note: "TPC Southwind stable Memphis series." },
  "greenbrier classic": { minVerified: 4, minSeason: 2010, note: "The Old White TPC stable Greenbrier series." },
  "honda classic": { minVerified: 4, minSeason: 2007, note: "PGA National only after the event moved there in 2007." },
  "mayakoba": { minVerified: 4, minSeason: 2007, note: "El Camaleon stable Mayakoba host course lineage." },
  "rsm classic": { minVerified: 3, minSeason: 2010, note: "Sea Island Seaside stable McGladrey/RSM host-course lineage." },
  "shriners open": { minVerified: 4, minSeason: 2005, note: "TPC Summerlin stable Las Vegas/Shriners host-course lineage." },
  "john deere classic": { minVerified: 4, minSeason: 2005, note: "TPC Deere Run stable John Deere Classic series." },
  "masters tournament": { minVerified: 4, minSeason: 2002, note: "Augusta National stable Masters venue." },
  "memorial tournament": { minVerified: 4, minSeason: 2002, note: "Muirfield Village stable Memorial venue." },
  "northern trust open": { minVerified: 4, minSeason: 2005, note: "Riviera stable Los Angeles Open/Nissan/Northern Trust series." },
  "phoenix open": { minVerified: 4, minSeason: 2005, note: "TPC Scottsdale stable Phoenix Open series." },
  "puerto rico open": { minVerified: 4, minSeason: 2008, note: "Coco Beach/Grand Reserve host-course lineage." },
  "shell houston open": { minVerified: 4, minSeason: 2006, note: "Houston Open course inference begins after the Tournament Course era." },
  "sony open in hawaii": { minVerified: 4, minSeason: 2002, note: "Waialae stable Sony Open venue." },
  "the players championship": { minVerified: 4, minSeason: 2002, note: "TPC Sawgrass Stadium Course stable PLAYERS venue." },
  "tour championship": { minVerified: 4, minSeason: 2002, note: "East Lake stable modern TOUR Championship venue." },
  "tournament of champions": { minVerified: 4, minSeason: 2002, note: "Kapalua Plantation stable Tournament of Champions venue." },
  "travelers championship": { minVerified: 4, minSeason: 2007, note: "TPC River Highlands stable Travelers/Buick Championship lineage." },
  "valero texas open": { minVerified: 4, minSeason: 2010, preferredCourseName: "TPC San Antonio (Oaks Course)", note: "TPC San Antonio Oaks inference begins with the 2010 venue move; earlier La Cantera years need manual verification." },
  "valspar championship": { minVerified: 4, minSeason: 2007, preferredCourseName: "Innisbrook Resort (Copperhead Course)", note: "Innisbrook Copperhead stable PODS/Transitions/Valspar venue lineage." },
  "wells fargo championship": { minVerified: 4, minSeason: 2005, preferredCourseName: "Quail Hollow Club", note: "Quail Hollow stable Wachovia/Wells Fargo series for these missing seasons; later alternate verified venues are intentionally ignored." },
  "wgc bridgestone invitational": { minVerified: 4, minSeason: 2002, note: "Firestone South stable NEC/Bridgestone WGC series." },
  "wgc doral": { minVerified: 4, minSeason: 2007, note: "Doral WGC CA/Cadillac lineage." },
  "wgc hsbc champions": { minVerified: 4, minSeason: 2010, note: "Sheshan stable WGC-HSBC lineage except known 2012 move." },
  "wyndham championship": { minVerified: 4, minSeason: 2008, note: "Sedgefield only after the 2008 venue move." },
  "zurich classic of new orleans": { minVerified: 4, minSeason: 2005, excludedSeasons: ["2006"], note: "TPC Louisiana stable except 2006 post-Katrina venue exception." }
});

function cleanString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\s+/g, " ");
}

function ascii(value) {
  return cleanString(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function baseKey(value) {
  return ascii(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bst\.?\b/g, "st")
    .replace(/\bchampionships\b/g, "championship")
    .replace(/\b(presented by|hosted by|powered by|sponsored by|benefiting)\b.*$/g, "")
    .replace(/\b(the|pga tour|fedexcup|coca cola|mastercard|mastercard)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalSeriesKey(name) {
  const key = baseKey(name);
  if (!key) return "";
  if (/^(arnold palmer invitational|bay hill invitational)/.test(key)) return "arnold palmer invitational";
  if (/^(bank of america colonial|crowne plaza invitational at colonial)$/.test(key)) return "colonial";
  if (/^(eds byron nelson championship|hp byron nelson championship|at and t byron nelson)$/.test(key)) return "byron nelson";
  if (/^deutsche bank championship$/.test(key)) return "deutsche bank championship";
  if (/^(mci heritage|verizon heritage|heritage|rbc heritage)$/.test(key)) return "heritage";
  if (/^(buick invitational|farmers insurance open)$/.test(key)) return "farmers insurance open";
  if (/^(fedex st jude classic|st jude classic|stanford st jude championship)/.test(key)) return "fedex st jude classic";
  if (/^greenbrier classic$/.test(key)) return "greenbrier classic";
  if (/^honda classic$/.test(key)) return "honda classic";
  if (/^(mayakoba golf classic|mayakoba golf classic at riviera maya cancun|ohl classic at mayakoba|world wide technology championship at mayakoba)/.test(key)) return "mayakoba";
  if (/^(mcgladrey classic|rsm classic)$/.test(key)) return "rsm classic";
  if (/^(michelin championship at las vegas|frys com open benefiting shriners hospitals for ch|justin timberlake shriners hospitals for children|justin timberlake shriners hospitals for children open|shriners hospitals for children open|shriners hospital for children open|shriners children s open)$/.test(key)) return "shriners open";
  if (/^john deere classic$/.test(key)) return "john deere classic";
  if (/^masters tournament$/.test(key) || key === "masters") return "masters tournament";
  if (/^memorial tournament/.test(key)) return "memorial tournament";
  if (/^(nissan open|northern trust open)$/.test(key)) return "northern trust open";
  if (/^(fbr open|waste management phoenix open)$/.test(key)) return "phoenix open";
  if (/^puerto rico open/.test(key)) return "puerto rico open";
  if (/^shell houston open$/.test(key)) return "shell houston open";
  if (/^sony open in hawaii$/.test(key)) return "sony open in hawaii";
  if (/^players championship$/.test(key)) return "the players championship";
  if (/^tour championship/.test(key)) return "tour championship";
  if (/^(mercedes championship|mercedes benz championship|hyundai tournament of champions|sbs championship)$/.test(key)) return "tournament of champions";
  if (/^travelers championship$/.test(key) || key === "buick championship") return "travelers championship";
  if (/^valero texas open$/.test(key)) return "valero texas open";
  if (/^(pods championship|transitions championship|tampa bay championship|valspar championship)$/.test(key)) return "valspar championship";
  if (/^(wachovia championship|quail hollow championship|wells fargo championship)$/.test(key)) return "wells fargo championship";
  if (/^(wgc nec invitational|world golf championship nec invitational|world golf championship bridgestone invitational)$/.test(key)) return "wgc bridgestone invitational";
  if (/^(ford championship at doral|world golf championship ca championship|world golf championship cadillac championship)$/.test(key)) return "wgc doral";
  if (/^(wgc hsbc champions|world golf championship hsbc champions)$/.test(key)) return "wgc hsbc champions";
  if (/^wyndham championship$/.test(key) || key === "chrysler classic of greensboro") return "wyndham championship";
  if (/^zurich classic of new orleans$/.test(key)) return "zurich classic of new orleans";
  return key;
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

function courseKey(row = {}) {
  return `${cleanString(row.courseId)}|${cleanString(row.courseName)}`;
}

function canonicalCourseKey(row = {}) {
  return baseKey(row.courseName)
    .replace(/\bcc\b/g, "country club")
    .replace(/\bgc\b/g, "golf club")
    .replace(/\binternational\b/g, "")
    .replace(/\b(the|course)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function courseFromKey(key) {
  const [courseId, courseName] = String(key || "").split("|");
  return { courseId: cleanString(courseId), courseName: cleanString(courseName) };
}

function rowSeason(row = {}) {
  const parsed = Number(row.season);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildCourseInference(events = [], courses = [], options = {}) {
  const maxSeason = Number.isFinite(Number(options.maxSeason)) ? Number(options.maxSeason) : 2011;
  const provider = cleanString(options.provider || "Golf Lab recurring-course inference");
  const sourceUpdatedAt = cleanString(options.sourceUpdatedAt || options.fetchedAt) || new Date().toISOString();
  const sourceUrl = cleanString(options.sourceUrl || "data/golf-lab/recurring-course-inference");
  const courseById = new Map((courses || []).map((course) => [cleanString(course.id), course]));
  const eventsByKey = new Map();
  const skipped = [];

  (events || []).forEach((event) => {
    const key = canonicalSeriesKey(event.name);
    if (!key) return;
    if (!eventsByKey.has(key)) eventsByKey.set(key, []);
    eventsByKey.get(key).push(event);
  });

  const repairs = [];
  Object.entries(SERIES_POLICIES).forEach(([key, policy]) => {
    const rows = eventsByKey.get(key) || [];
    const verified = rows.filter((event) => cleanString(event.courseId) || cleanString(event.courseName));
    const missing = rows.filter((event) => !(cleanString(event.courseId) || cleanString(event.courseName)));
    if (!missing.length) return;
    if (verified.length < policy.minVerified) {
      skipped.push({ key, reason: "thin verified history", verifiedEvents: verified.length, missingEvents: missing.length });
      return;
    }
    const coursesByKey = new Map();
    verified.forEach((event) => {
      const keyValue = canonicalCourseKey(event);
      if (!keyValue) return;
      if (!coursesByKey.has(keyValue)) coursesByKey.set(keyValue, []);
      coursesByKey.get(keyValue).push(event);
    });
    if (coursesByKey.size !== 1 && cleanString(policy.preferredCourseName)) {
      const preferredKey = canonicalCourseKey({ courseName: policy.preferredCourseName });
      [...coursesByKey.entries()].forEach(([courseIdentity, rows]) => {
        if (courseIdentity !== preferredKey) coursesByKey.delete(courseIdentity);
        else if (rows.length < policy.minVerified) coursesByKey.delete(courseIdentity);
      });
    }
    if (coursesByKey.size !== 1) {
      skipped.push({
        key,
        reason: "multiple verified courses",
        verifiedEvents: verified.length,
        missingEvents: missing.length,
        courses: [...coursesByKey.values()].map((rows) => [...new Set(rows.map(courseKey))].join(" || "))
      });
      return;
    }
    const [, verifiedRows] = [...coursesByKey.entries()][0];
    const rawCourseCounts = new Map();
    verifiedRows.forEach((event) => rawCourseCounts.set(courseKey(event), (rawCourseCounts.get(courseKey(event)) || 0) + 1));
    const verifiedCourseKey = [...rawCourseCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const inferredCourse = courseFromKey(verifiedCourseKey);
    const course = courseById.get(inferredCourse.courseId) || {};
    const verifiedSeasons = [...new Set(verifiedRows.map((event) => cleanString(event.season)).filter(Boolean))].sort();
    missing.forEach((event) => {
      const season = rowSeason(event);
      if (!Number.isFinite(season)) return;
      if (season > maxSeason || season < policy.minSeason) return;
      if ((policy.excludedSeasons || []).includes(String(season))) return;
      repairs.push({
        eventId: cleanString(event.id),
        courseId: inferredCourse.courseId,
        courseName: inferredCourse.courseName,
        location: cleanString(course.location),
        par: cleanString(course.par),
        yards: cleanString(course.yards),
        sourceProvider: provider,
        sourceUrl,
        sourceUpdatedAt,
        inferenceKey: key,
        verifiedEvents: String(verifiedRows.length),
        verifiedSeasons: verifiedSeasons.join("|"),
        policyNote: policy.note
      });
    });
  });

  repairs.sort((a, b) =>
    cleanString(a.inferenceKey).localeCompare(cleanString(b.inferenceKey)) ||
    cleanString(a.eventId).localeCompare(cleanString(b.eventId))
  );

  const byKey = new Map();
  repairs.forEach((row) => {
    if (!byKey.has(row.inferenceKey)) byKey.set(row.inferenceKey, { inferenceKey: row.inferenceKey, repairs: 0, courseName: row.courseName });
    byKey.get(row.inferenceKey).repairs += 1;
  });

  return {
    generatedAt: sourceUpdatedAt,
    summary: {
      repairs: repairs.length,
      series: byKey.size,
      provider,
      maxSeason,
      skipped: skipped.length
    },
    bySeries: [...byKey.values()].sort((a, b) => b.repairs - a.repairs || a.inferenceKey.localeCompare(b.inferenceKey)),
    skipped,
    repairs
  };
}

async function loadCourseInference(inputDir, options = {}) {
  const resolved = path.resolve(inputDir);
  const events = await readCollection(resolved, "events");
  const courses = await readCollection(resolved, "courses");
  return buildCourseInference(events, courses, options);
}

async function writeCourseInference(report, options = {}) {
  if (cleanString(options.outputFile)) {
    const outputFile = path.resolve(options.outputFile);
    await fsp.mkdir(path.dirname(outputFile), { recursive: true });
    const body = [REPAIR_COLUMNS.join(","), ...report.repairs.map((row) => csvLine(REPAIR_COLUMNS, row))].join("\n");
    await fsp.writeFile(outputFile, `${body}\n`, "utf8");
  }
  if (cleanString(options.summaryFile)) {
    const summaryFile = path.resolve(options.summaryFile);
    await fsp.mkdir(path.dirname(summaryFile), { recursive: true });
    await fsp.writeFile(summaryFile, `${JSON.stringify({
      generatedAt: report.generatedAt,
      summary: report.summary,
      bySeries: report.bySeries,
      skipped: report.skipped
    }, null, 2)}\n`, "utf8");
  }
}

function parseArgs(argv) {
  const args = {
    provider: "Golf Lab recurring-course inference",
    maxSeason: 2011
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--in") args.inputDir = argv[index += 1];
    else if (token === "--out") args.outputFile = argv[index += 1];
    else if (token === "--summary") args.summaryFile = argv[index += 1];
    else if (token === "--provider") args.provider = argv[index += 1];
    else if (token === "--source-url") args.sourceUrl = argv[index += 1];
    else if (token === "--fetched-at") args.fetchedAt = argv[index += 1];
    else if (token === "--source-updated-at") args.sourceUpdatedAt = argv[index += 1];
    else if (token === "--max-season") args.maxSeason = Number(argv[index += 1]);
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-course-inference.js --in <warehouse-folder> --out <repairs.csv> [--summary <json>]",
    "",
    "Creates reviewable recurring-course repair rows from verified historical course series."
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.inputDir) throw new Error(`${usage()}\n\nMissing --in.`);
  const report = await loadCourseInference(args.inputDir, args);
  await writeCourseInference(report, args);
  console.log(`Golf Lab course inference: ${report.summary.repairs} repairs across ${report.summary.series} series`);
  if (args.outputFile) console.log(`Repair CSV: ${path.resolve(args.outputFile)}`);
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
  REPAIR_COLUMNS,
  SERIES_POLICIES,
  parseArgs,
  canonicalSeriesKey,
  buildCourseInference,
  loadCourseInference,
  writeCourseInference,
  usage
};
