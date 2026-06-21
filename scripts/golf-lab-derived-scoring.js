#!/usr/bin/env node
/*
 * Derive owned Golf Lab scoring features from imported leaderboard rounds.
 *
 * This produces field-relative SG Total, not official ShotLink SG components:
 *   derived sgTotal = field average score for event/round - player score.
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const GolfLab = require("../lib/golf-lab.js");
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
    provider: "Golf Lab derived scoring model",
    fetchedAt: new Date().toISOString(),
    minRoundFieldSize: 2,
    minScore: 50,
    maxScore: 100,
    updateCourses: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--in") args.inputDir = argv[index += 1];
    else if (token === "--provider") args.provider = argv[index += 1];
    else if (token === "--source-url") args.sourceUrl = argv[index += 1];
    else if (token === "--fetched-at") args.fetchedAt = argv[index += 1];
    else if (token === "--min-round-field-size") args.minRoundFieldSize = Number(argv[index += 1]);
    else if (token === "--min-score") args.minScore = Number(argv[index += 1]);
    else if (token === "--max-score") args.maxScore = Number(argv[index += 1]);
    else if (token === "--report") args.reportFile = argv[index += 1];
    else if (token === "--no-course-updates") args.updateCourses = false;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!Number.isFinite(args.minRoundFieldSize) || args.minRoundFieldSize < 1) args.minRoundFieldSize = 2;
  if (!Number.isFinite(args.minScore)) args.minScore = 50;
  if (!Number.isFinite(args.maxScore)) args.maxScore = 100;
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-derived-scoring.js --in <golf-lab-folder> [options]",
    "",
    "Options:",
    "  --provider <name>               Source provider label for derived rows.",
    "  --source-url <url>              Optional methodology/source URL.",
    "  --fetched-at <iso>              Timestamp for derived source rows.",
    "  --min-round-field-size <count>  Minimum scored players for a round baseline. Default 2.",
    "  --min-score <score>             Minimum plausible round score. Default 50.",
    "  --max-score <score>             Maximum plausible round score. Default 100.",
    "  --report <file>                 Optional derivation report JSON.",
    "  --no-course-updates             Do not write derived course/course_setup difficulty rows."
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

async function readCollection(inputDir, collection) {
  const fileName = collectionFileName(collection);
  try {
    return Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(inputDir, fileName), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeCollection(inputDir, collection, rows) {
  const columns = Warehouse.COLLECTION_COLUMNS[collection] || [];
  const body = [columns.map(csvCell).join(","), ...rows.map((row) => csvLine(columns, row))].join("\n");
  await fsp.writeFile(path.join(inputDir, collectionFileName(collection)), `${body}\n`, "utf8");
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

function mergeProvider(existingProvider, provider) {
  const existing = cleanString(existingProvider);
  const incoming = cleanString(provider);
  if (!existing) return incoming;
  if (!incoming || existing === incoming) return existing;
  if (existing.split(/\s+\+\s+/).includes(incoming)) return existing;
  return `${existing} + ${incoming}`;
}

function removeProvider(existingProvider, provider) {
  const incoming = cleanString(provider);
  return cleanString(existingProvider)
    .split(/\s+\+\s+/)
    .map(cleanString)
    .filter((part) => part && part !== incoming)
    .join(" + ");
}

function avg(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function weightedAvg(rows) {
  const valid = rows.filter((row) => Number.isFinite(row.value) && Number.isFinite(row.weight) && row.weight > 0);
  const weight = valid.reduce((sum, row) => sum + row.weight, 0);
  return weight ? valid.reduce((sum, row) => sum + row.value * row.weight, 0) / weight : null;
}

function roundNumberOrDate(round) {
  return Number.isFinite(round.roundNumber) ? `r${round.roundNumber}` : cleanString(round.date);
}

function roundGroupKey(round) {
  return [round.eventId, roundNumberOrDate(round)].join("|");
}

function number(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundValue(value, digits = 3) {
  if (!Number.isFinite(value)) return "";
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function difficultyBucket(fieldAdjustedToPar) {
  if (!Number.isFinite(fieldAdjustedToPar)) return "";
  if (fieldAdjustedToPar <= -1) return "Easy";
  if (fieldAdjustedToPar < 0.75) return "Neutral";
  if (fieldAdjustedToPar < 2.5) return "Tough";
  return "Brutal";
}

function sourceUrlForRows(rows, fallback) {
  return cleanString(fallback) || cleanString(rows.find((row) => row.sourceUrl)?.sourceUrl);
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return groups;
}

function eventCourseKey(eventId, courseId) {
  return [cleanString(eventId), cleanString(courseId)].join("|");
}

function setupQuality(setup) {
  return ["par", "yards", "rough", "greenSpeed", "firmness", "weatherNote", "sourceProvider", "sourceUrl"]
    .filter((key) => cleanString(setup && setup[key]) || Number.isFinite(number(setup && setup[key]))).length;
}

function isGeneratedDerivedSetup(setup, provider) {
  return Boolean(
    setup &&
    /-derived-setup$/.test(cleanString(setup.id)) &&
    cleanString(setup.sourceProvider).includes(cleanString(provider))
  );
}

function isGeneratedDerivedSg(row, provider) {
  return Boolean(
    row &&
    /-derived-sg-total$/.test(cleanString(row.id)) &&
    cleanString(row.sourceProvider).includes(cleanString(provider))
  );
}

function isGeneratedDerivedSourceFetch(row, provider) {
  return Boolean(
    row &&
    cleanString(row.provider) === cleanString(provider) &&
    cleanString(row.endpoint) === "field-relative-round-sg-total"
  );
}

function buildSetupIndex(setups, provider) {
  const byEventCourse = new Map();
  setups.forEach((setup) => {
    const key = eventCourseKey(setup.eventId, setup.courseId);
    if (key === "|") return;
    const existing = byEventCourse.get(key);
    if (!existing) {
      byEventCourse.set(key, setup);
      return;
    }
    const existingGenerated = isGeneratedDerivedSetup(existing, provider);
    const candidateGenerated = isGeneratedDerivedSetup(setup, provider);
    if (
      (existingGenerated && !candidateGenerated) ||
      (existingGenerated === candidateGenerated && setupQuality(setup) > setupQuality(existing))
    ) {
      byEventCourse.set(key, setup);
    }
  });
  return byEventCourse;
}

function buildDerivedScoring(input, options = {}) {
  const lab = GolfLab.normalizeGolfLabState(input);
  const provider = cleanString(options.provider || "Golf Lab derived scoring model");
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  const minRoundFieldSize = Number.isFinite(Number(options.minRoundFieldSize)) ? Number(options.minRoundFieldSize) : 2;
  const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 50;
  const maxScore = Number.isFinite(Number(options.maxScore)) ? Number(options.maxScore) : 100;
  const invalidScoreRounds = lab.rounds.filter((round) => {
    const score = number(round.score);
    return cleanString(round.eventId) && Number.isFinite(score) && (score < minScore || score > maxScore);
  });
  const scoredRounds = lab.rounds.filter((round) => {
    const score = number(round.score);
    return Number.isFinite(score) && score >= minScore && score <= maxScore && cleanString(round.eventId);
  });
  const roundGroups = groupBy(scoredRounds, roundGroupKey);
  const baselines = new Map();
  const skippedGroups = [];

  roundGroups.forEach((rows, key) => {
    const scores = rows.map((row) => number(row.score)).filter(Number.isFinite);
    if (scores.length < minRoundFieldSize) {
      skippedGroups.push({ key, rounds: rows.length, reason: "below-min-round-field-size" });
      return;
    }
    baselines.set(key, {
      key,
      eventId: rows[0].eventId,
      roundNumber: rows[0].roundNumber,
      date: rows[0].date,
      fieldSize: scores.length,
      averageScore: avg(scores),
      averageToPar: avg(rows.map((row) => number(row.toPar)).filter(Number.isFinite)),
      sourceUrl: sourceUrlForRows(rows, options.sourceUrl)
    });
  });

  const derivedRounds = [];
  const strokesGained = [];
  lab.rounds.forEach((round) => {
    const score = number(round.score);
    const baseline = baselines.get(roundGroupKey(round));
    if (!baseline || !Number.isFinite(score) || score < minScore || score > maxScore) {
      const hadDerivedProvider = cleanString(round.sourceProvider).includes(provider);
      derivedRounds.push(hadDerivedProvider ? {
        ...round,
        adjustedToPar: null,
        sgTotal: null,
        difficultyBucket: "",
        sourceProvider: removeProvider(round.sourceProvider, provider)
      } : round);
      return;
    }
    const sgTotal = baseline.averageScore - score;
    const adjustedToPar = Number.isFinite(number(round.toPar)) && Number.isFinite(baseline.averageToPar)
      ? number(round.toPar) - baseline.averageToPar
      : score - baseline.averageScore;
    const sourceUrl = sourceUrlForRows([round], options.sourceUrl);
    const derivedRound = {
      ...round,
      adjustedToPar: roundValue(adjustedToPar),
      sgTotal: roundValue(sgTotal),
      difficultyBucket: difficultyBucket(baseline.averageToPar),
      sourceProvider: mergeProvider(round.sourceProvider, provider),
      sourceUrl,
      sourceUpdatedAt: fetchedAt
    };
    derivedRounds.push(derivedRound);
    strokesGained.push({
      id: `${round.id}-derived-sg-total`,
      playerId: round.playerId,
      playerName: round.playerName,
      eventId: round.eventId,
      roundId: round.id,
      period: Number.isFinite(round.roundNumber) ? `round-${round.roundNumber}` : "round",
      sgTotal: roundValue(sgTotal),
      sourceProvider: provider,
      sourceUrl,
      sourceUpdatedAt: fetchedAt
    });
  });

  const eventBaselines = [...baselines.values()].reduce((acc, row) => {
    if (!acc[row.eventId]) acc[row.eventId] = [];
    acc[row.eventId].push(row);
    return acc;
  }, {});
  const eventsById = new Map(lab.events.map((event) => [event.id, event]));
  const coursesById = new Map(lab.courses.map((course) => [course.id, course]));
  const setupsByEventCourse = buildSetupIndex(lab.courseSetups, provider);
  const derivedCourseSetups = [];
  Object.entries(eventBaselines).forEach(([eventId, rows]) => {
    const event = eventsById.get(eventId);
    if (!event || (!event.courseId && !event.courseName)) return;
    const weightedAverageToPar = weightedAvg(rows.map((row) => ({
      value: row.averageToPar,
      weight: row.fieldSize
    })));
    if (!Number.isFinite(weightedAverageToPar)) return;
    const courseId = event.courseId || slug(event.courseName);
    const existingSetup = setupsByEventCourse.get(eventCourseKey(eventId, courseId)) || {};
    const sourceUrl = sourceUrlForRows(rows, options.sourceUrl);
    derivedCourseSetups.push({
      ...existingSetup,
      id: existingSetup.id || slug(`${eventId} ${courseId || event.courseName} setup`),
      eventId,
      courseId,
      fieldAdjustedToPar: roundValue(weightedAverageToPar),
      sgDifficulty: roundValue(-weightedAverageToPar),
      sourceProvider: mergeProvider(existingSetup.sourceProvider, provider),
      sourceUrl: sourceUrl || existingSetup.sourceUrl,
      sourceUpdatedAt: fetchedAt
    });
  });

  const courseAverages = groupBy(derivedCourseSetups, (setup) => setup.courseId);
  const derivedCourses = [];
  courseAverages.forEach((setups, courseId) => {
    const existing = coursesById.get(courseId);
    const fieldAdjustedToPar = avg(setups.map((setup) => number(setup.fieldAdjustedToPar)).filter(Number.isFinite));
    if (!Number.isFinite(fieldAdjustedToPar)) return;
    derivedCourses.push({
      ...(existing || {}),
      id: courseId,
      name: existing ? existing.name : "",
      fieldAdjustedToPar: roundValue(fieldAdjustedToPar),
      sgDifficulty: roundValue(-fieldAdjustedToPar),
      sourceProvider: mergeProvider(existing && existing.sourceProvider, provider),
      sourceUrl: sourceUrlForRows(setups, options.sourceUrl) || (existing && existing.sourceUrl),
      sourceUpdatedAt: fetchedAt
    });
  });

  const sourceFetch = {
    id: slug(`${provider} derived scoring ${fetchedAt}`) || "golf-lab-derived-scoring",
    provider,
    endpoint: "field-relative-round-sg-total",
    fetchedAt,
    status: "ok",
    rowCount: strokesGained.length,
    manifestJson: JSON.stringify({
      method: "sgTotal = event-round field average score - player score",
      minRoundFieldSize,
      minScore,
      maxScore,
      derivedRounds: strokesGained.length,
      roundGroups: baselines.size,
      skippedGroups: skippedGroups.length,
      invalidScoreRounds: invalidScoreRounds.length
    }),
    sourceUrl: cleanString(options.sourceUrl)
  };

  const hardestEvents = Object.entries(eventBaselines)
    .map(([eventId, rows]) => ({
      eventId,
      eventName: eventsById.get(eventId) ? eventsById.get(eventId).name : eventId,
      fieldAdjustedToPar: roundValue(weightedAvg(rows.map((row) => ({
        value: row.averageToPar,
        weight: row.fieldSize
      })))),
      rounds: rows.length
    }))
    .filter((row) => Number.isFinite(number(row.fieldAdjustedToPar)))
    .sort((a, b) => number(b.fieldAdjustedToPar) - number(a.fieldAdjustedToPar));

  return {
    tables: {
      rounds: derivedRounds,
      strokesGained,
      courses: options.updateCourses === false ? lab.courses : upsertRows(lab.courses, derivedCourses),
      courseSetups: options.updateCourses === false
        ? lab.courseSetups
        : upsertRows(
          lab.courseSetups.filter((setup) => !isGeneratedDerivedSetup(setup, provider)),
          derivedCourseSetups
        ),
      sourceFetches: upsertRows(
        lab.sourceFetches.filter((row) => !isGeneratedDerivedSourceFetch(row, provider)),
        [sourceFetch]
      )
    },
    report: {
      generatedAt: fetchedAt,
      provider,
      methodology: "field-relative SG Total proxy; not official ShotLink component SG",
      minRoundFieldSize,
      minScore,
      maxScore,
      inputRounds: lab.rounds.length,
      scoredRounds: scoredRounds.length,
      invalidScoreRounds: invalidScoreRounds.length,
      derivedRounds: strokesGained.length,
      roundGroups: baselines.size,
      skippedGroups: skippedGroups.length,
      derivedCourseSetups: derivedCourseSetups.length,
      derivedCourses: derivedCourses.length,
      hardestEvents: hardestEvents.slice(0, 12),
      easiestEvents: hardestEvents.slice(-12).reverse()
    }
  };
}

async function deriveScoringForDirectory(inputDir, options = {}) {
  const resolvedInput = path.resolve(inputDir);
  const input = {
    rounds: await readCollection(resolvedInput, "rounds"),
    strokesGained: await readCollection(resolvedInput, "strokesGained"),
    events: await readCollection(resolvedInput, "events"),
    courses: await readCollection(resolvedInput, "courses"),
    courseSetups: await readCollection(resolvedInput, "courseSetups"),
    sourceFetches: await readCollection(resolvedInput, "sourceFetches")
  };
  const result = buildDerivedScoring(input, options);
  await writeCollection(resolvedInput, "rounds", result.tables.rounds);
  await writeCollection(
    resolvedInput,
    "strokesGained",
    upsertRows(input.strokesGained.filter((row) => !isGeneratedDerivedSg(row, options.provider || "Golf Lab derived scoring model")), result.tables.strokesGained)
  );
  if (options.updateCourses !== false) {
    await writeCollection(resolvedInput, "courses", result.tables.courses);
    await writeCollection(resolvedInput, "courseSetups", result.tables.courseSetups);
  }
  await writeCollection(resolvedInput, "sourceFetches", result.tables.sourceFetches);
  if (options.reportFile) {
    await fsp.mkdir(path.dirname(path.resolve(options.reportFile)), { recursive: true });
    await fsp.writeFile(path.resolve(options.reportFile), JSON.stringify(result.report, null, 2), "utf8");
  }
  return {
    inputDir: resolvedInput,
    report: result.report
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.inputDir) throw new Error(`${usage()}\n\nMissing --in.`);
  const result = await deriveScoringForDirectory(args.inputDir, args);
  console.log(`Golf Lab derived scoring written: ${result.inputDir}`);
  console.log(`${result.report.derivedRounds} derived SG rounds | ${result.report.roundGroups} baselines | ${result.report.skippedGroups} skipped groups`);
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
  buildDerivedScoring,
  deriveScoringForDirectory,
  usage
};
