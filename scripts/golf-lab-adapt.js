#!/usr/bin/env node
/*
 * Adapt messy source exports into Golf Lab collection CSVs.
 *
 * Example:
 *   node scripts/golf-lab-adapt.js --type leaderboard --in raw/us-open-r1.csv --out data/golf-lab/us-open-2026 --event-id us-open-2026 --course-id oakmont --provider "Official leaderboard"
 *   node scripts/golf-lab-adapt.js --batch downloads/us-open-raw --out data/golf-lab/us-open-2026 --event-id us-open-2026 --course-id oakmont
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");

const ADAPTER_TYPES = new Set(["schedule", "profile", "field", "course", "leaderboard", "odds", "weather", "enrichment"]);

function parseArgs(argv) {
  const args = {
    provider: "Owned Research",
    status: "ok"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--type") args.type = argv[index += 1];
    else if (token === "--in") args.inputFile = argv[index += 1];
    else if (token === "--batch" || token === "--batch-dir") args.batchDir = argv[index += 1];
    else if (token === "--out") args.outputDir = argv[index += 1];
    else if (token === "--event-id") args.eventId = argv[index += 1];
    else if (token === "--event-name") args.eventName = argv[index += 1];
    else if (token === "--course-id") args.courseId = argv[index += 1];
    else if (token === "--course-name") args.courseName = argv[index += 1];
    else if (token === "--tour") args.tour = argv[index += 1];
    else if (token === "--season") args.season = argv[index += 1];
    else if (token === "--provider") args.provider = argv[index += 1];
    else if (token === "--source-url") args.sourceUrl = argv[index += 1];
    else if (token === "--fetched-at") args.fetchedAt = argv[index += 1];
    else if (token === "--status") args.status = argv[index += 1];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-adapt.js --type <schedule|profile|field|course|leaderboard|odds|weather|enrichment> --in <raw.csv> --out <folder> [options]",
    "   or: node scripts/golf-lab-adapt.js --batch <raw-folder> --out <folder> [options]",
    "",
    "Options:",
    "  --event-id <id>       Event id to apply when the raw file does not include one.",
    "  --event-name <name>   Event name for schedule/provenance context.",
    "  --course-id <id>      Course id to apply when the raw file does not include one.",
    "  --course-name <name>  Course name to apply when the raw file does not include one.",
    "  --tour <tour>         Tour label for schedule/player/event rows.",
    "  --season <season>     Season for schedule/event rows.",
    "  --provider <name>     Source provider name.",
    "  --source-url <url>    Source URL to attach to generated rows.",
    "  --fetched-at <iso>    Fetch timestamp. Defaults to now.",
    "  --batch <folder>      Infer supported CSV types from file names and adapt them in one pass.",
    "",
    "Batch file-name hints: schedule/event/tournament, profile/player/players, field/tee-time, course/setup, leaderboard/round/results/scorecard, odds/market/lines, weather/forecast/wind, enrichment/equipment/witb/accomplishment.",
    "Writes/merges Golf Lab collection CSVs such as players.csv, courses.csv, course_setups.csv, fields.csv, rounds.csv, odds_snapshots.csv, weather_snapshots.csv, equipment_snapshots.csv, accomplishments.csv, and source_fetches.csv."
  ].join("\n");
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function slug(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function numberText(value) {
  const raw = cleanString(value).replace(/^\+/, "");
  if (!raw) return "";
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? String(numeric) : raw;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(columns, row = {}) {
  return columns.map((column) => csvCell(row[column])).join(",");
}

function firstValue(row, aliases) {
  for (const alias of aliases) {
    const value = cleanString(row[alias]);
    if (value) return value;
  }
  return "";
}

function eventIdFor(row, options) {
  return firstValue(row, ["eventId", "tournamentId", "event"]) || cleanString(options.eventId) || slug(options.eventName);
}

function eventNameFor(row, options) {
  return firstValue(row, ["eventName", "tournament", "tournamentName", "event"]) || cleanString(options.eventName);
}

function courseIdFor(row, options) {
  return firstValue(row, ["courseId", "venueId"]) || cleanString(options.courseId) || slug(courseNameFor(row, options));
}

function courseNameFor(row, options) {
  return firstValue(row, ["courseName", "course", "venue", "site"]) || cleanString(options.courseName);
}

function playerNameFor(row) {
  return firstValue(row, ["playerName", "player", "name", "golfer", "competitor"]);
}

function playerIdFor(row) {
  return firstValue(row, ["playerId", "golfLabId"])
    || slug(playerNameFor(row))
    || firstValue(row, ["pgaTourId", "dataGolfId", "id"]);
}

function sourceMeta(options) {
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  return {
    provider: cleanString(options.provider || "Owned Research"),
    sourceProvider: cleanString(options.provider || "Owned Research"),
    sourceUrl: cleanString(options.sourceUrl),
    sourceUpdatedAt: fetchedAt,
    fetchedAt
  };
}

function attachSource(row, options) {
  const meta = sourceMeta(options);
  return {
    ...row,
    sourceProvider: meta.sourceProvider,
    sourceUrl: meta.sourceUrl,
    sourceUpdatedAt: meta.sourceUpdatedAt
  };
}

function addPlayer(tables, row, options = {}) {
  const name = playerNameFor(row);
  const id = playerIdFor(row);
  if (!id && !name) return;
  tables.players.push(attachSource({
    id: id || slug(name),
    name,
    country: firstValue(row, ["country", "nationality"]),
    tour: firstValue(row, ["tour"]) || cleanString(options.tour),
    owgrRank: numberText(firstValue(row, ["owgrRank", "owgr", "worldRank", "rank"])),
    dataGolfId: firstValue(row, ["dataGolfId", "dgId"]),
    pgaTourId: firstValue(row, ["pgaTourId"]),
    photoUrl: firstValue(row, ["photoUrl", "headshotUrl", "imageUrl"]),
    handedness: firstValue(row, ["handedness", "hand"]),
    age: numberText(firstValue(row, ["age"])),
    turnedPro: numberText(firstValue(row, ["turnedPro", "turnedProfessional", "proSince"])),
    college: firstValue(row, ["college", "school"]),
    profileUrl: firstValue(row, ["profileUrl", "playerUrl", "url"])
  }, options));
}

function sourceFetch(type, rowCount, options) {
  const meta = sourceMeta(options);
  const endpoint = [
    type,
    cleanString(options.eventId || options.eventName),
    cleanString(options.inputFile ? path.basename(options.inputFile) : "")
  ].filter(Boolean).join("/");
  return {
    id: slug([meta.provider, endpoint, meta.fetchedAt].join(" ")) || `${type}-source`,
    provider: meta.provider,
    endpoint,
    eventId: cleanString(options.eventId),
    fetchedAt: meta.fetchedAt,
    status: cleanString(options.status || "ok"),
    rowCount,
    sourceUrl: meta.sourceUrl
  };
}

function blankTables() {
  return {
    players: [],
    events: [],
    courses: [],
    courseSetups: [],
    fields: [],
    rounds: [],
    strokesGained: [],
    weatherSnapshots: [],
    oddsSnapshots: [],
    equipmentSnapshots: [],
    accomplishments: [],
    sourceFetches: []
  };
}

function adaptSchedule(rows, options, tables) {
  rows.forEach((row, index) => {
    const eventId = eventIdFor(row, options) || `event-${index + 1}`;
    const eventName = eventNameFor(row, options) || eventId;
    const courseName = courseNameFor(row, options);
    const courseId = courseIdFor(row, options);
    tables.events.push(attachSource({
      id: eventId,
      name: eventName,
      tour: firstValue(row, ["tour"]) || cleanString(options.tour),
      season: firstValue(row, ["season", "year"]) || cleanString(options.season),
      startDate: firstValue(row, ["startDate", "date", "starts", "start"]),
      endDate: firstValue(row, ["endDate", "ends", "finishDate"]),
      courseId,
      courseName,
      fieldStrength: numberText(firstValue(row, ["fieldStrength", "strength"])),
      status: firstValue(row, ["status"]) || "scheduled"
    }, options));
    if (courseName || courseId) {
      tables.courses.push(attachSource({
        id: courseId || slug(courseName),
        name: courseName || courseId,
        location: firstValue(row, ["location", "city", "state", "country"]),
        par: numberText(firstValue(row, ["par"])),
        yards: numberText(firstValue(row, ["yards", "yardage"])),
        rating: numberText(firstValue(row, ["rating"])),
        slope: numberText(firstValue(row, ["slope"])),
        fieldAdjustedToPar: numberText(firstValue(row, ["fieldAdjustedToPar", "difficulty", "scoringAverageToPar"])),
        sgDifficulty: numberText(firstValue(row, ["sgDifficulty"])),
        style: firstValue(row, ["style", "courseStyle"])
      }, options));
    }
  });
}

function adaptField(rows, options, tables) {
  rows.forEach((row, index) => {
    addPlayer(tables, row, options);
    const eventId = eventIdFor(row, options);
    const playerId = playerIdFor(row);
    const playerName = playerNameFor(row);
    if (!eventId || (!playerId && !playerName)) return;
    tables.fields.push(attachSource({
      id: firstValue(row, ["fieldId"]) || slug([eventId, playerId || playerName, "field"].join(" ")),
      eventId,
      playerId,
      playerName,
      status: firstValue(row, ["status", "fieldStatus"]) || "active",
      teeTime: firstValue(row, ["teeTime", "teeTimeLocal", "startingTime"])
    }, options));
  });
}

function adaptProfile(rows, options, tables) {
  rows.forEach((row) => {
    addPlayer(tables, row, options);
  });
}

function adaptCourse(rows, options, tables) {
  rows.forEach((row, index) => {
    const eventId = eventIdFor(row, options);
    const courseName = courseNameFor(row, options);
    const courseId = courseIdFor(row, options) || (courseName ? slug(courseName) : "");
    if (!courseId && !courseName) return;
    tables.courses.push(attachSource({
      id: courseId || slug(courseName),
      name: courseName || courseId,
      location: firstValue(row, ["location", "city", "state", "country"]),
      par: numberText(firstValue(row, ["par"])),
      yards: numberText(firstValue(row, ["yards", "yardage", "courseYards"])),
      rating: numberText(firstValue(row, ["rating", "courseRating"])),
      slope: numberText(firstValue(row, ["slope", "slopeRating"])),
      fieldAdjustedToPar: numberText(firstValue(row, ["fieldAdjustedToPar", "difficulty", "scoringAverageToPar"])),
      sgDifficulty: numberText(firstValue(row, ["sgDifficulty"])),
      style: firstValue(row, ["style", "courseStyle", "architectureStyle"])
    }, options));

    const setupValues = {
      rough: firstValue(row, ["rough", "roughLength", "roughNote"]),
      greenSpeed: firstValue(row, ["greenSpeed", "stimp", "stimpmeter"]),
      firmness: firstValue(row, ["firmness", "firmnessNote"]),
      weatherNote: firstValue(row, ["weatherNote", "setupWeatherNote"]),
      fieldAdjustedToPar: numberText(firstValue(row, ["setupFieldAdjustedToPar", "fieldAdjustedToPar", "difficulty", "scoringAverageToPar"])),
      sgDifficulty: numberText(firstValue(row, ["setupSgDifficulty", "sgDifficulty"]))
    };
    const hasSetup = eventId || Object.values(setupValues).some(Boolean);
    if (hasSetup) {
      tables.courseSetups.push(attachSource({
        id: firstValue(row, ["courseSetupId", "setupId"]) || slug([eventId || "course", courseId || courseName, "setup", index + 1].join(" ")),
        eventId,
        courseId: courseId || slug(courseName),
        par: numberText(firstValue(row, ["setupPar", "par"])),
        yards: numberText(firstValue(row, ["setupYards", "yards", "yardage", "courseYards"])),
        ...setupValues
      }, options));
    }
  });
}

function adaptLeaderboard(rows, options, tables) {
  rows.forEach((row, index) => {
    addPlayer(tables, row, options);
    const eventId = eventIdFor(row, options);
    const playerId = playerIdFor(row);
    const playerName = playerNameFor(row);
    const roundNumber = numberText(firstValue(row, ["roundNumber", "round", "r"]));
    const courseId = courseIdFor(row, options);
    const courseName = courseNameFor(row, options);
    if (!eventId || (!playerId && !playerName)) return;
    const roundId = firstValue(row, ["roundId"]) || slug([eventId, playerId || playerName, roundNumber || index + 1].join(" "));
    tables.rounds.push(attachSource({
      id: roundId,
      playerId,
      playerName,
      eventId,
      courseId,
      courseName,
      roundNumber,
      date: firstValue(row, ["date", "roundDate"]),
      score: numberText(firstValue(row, ["score", "strokes"])),
      toPar: numberText(firstValue(row, ["toPar", "roundToPar", "parRelativeScore"])),
      adjustedToPar: numberText(firstValue(row, ["adjustedToPar", "adjToPar"])),
      sgTotal: numberText(firstValue(row, ["sgTotal", "strokesGainedTotal"]))
    }, options));
    const sgValues = {
      sgTotal: numberText(firstValue(row, ["sgTotal", "strokesGainedTotal"])),
      sgOtt: numberText(firstValue(row, ["sgOtt", "sgOffTheTee", "offTheTee"])),
      sgApp: numberText(firstValue(row, ["sgApp", "sgApproach", "approach"])),
      sgArg: numberText(firstValue(row, ["sgArg", "sgAroundGreen", "aroundGreen"])),
      sgPutt: numberText(firstValue(row, ["sgPutt", "sgPutting", "putting"])),
      sgT2g: numberText(firstValue(row, ["sgT2g", "sgTeeToGreen", "teeToGreen"])),
      drivingDistance: numberText(firstValue(row, ["drivingDistance", "distance"])),
      accuracy: numberText(firstValue(row, ["accuracy", "drivingAccuracy", "fairwayAccuracy"])),
      gir: numberText(firstValue(row, ["gir", "greensInRegulation"])),
      scrambling: numberText(firstValue(row, ["scrambling"]))
    };
    if (Object.values(sgValues).some(Boolean)) {
      tables.strokesGained.push(attachSource({
        id: slug([roundId, "sg"].join(" ")),
        playerId,
        playerName,
        eventId,
        roundId,
        period: firstValue(row, ["period"]) || (roundNumber ? "round" : "event"),
        ...sgValues
      }, options));
    }
  });
}

function adaptOdds(rows, options, tables) {
  rows.forEach((row, index) => {
    addPlayer(tables, row, options);
    const eventId = eventIdFor(row, options);
    const playerId = playerIdFor(row);
    const market = firstValue(row, ["market", "betType", "type"]) || "winner";
    const capturedAt = firstValue(row, ["capturedAt", "timestamp", "date", "fetchedAt"]) || sourceMeta(options).fetchedAt;
    if (!eventId || !playerId) return;
    tables.oddsSnapshots.push(attachSource({
      id: firstValue(row, ["oddsId"]) || slug([eventId, playerId, market, firstValue(row, ["book", "sportsbook"]), capturedAt, index + 1].join(" ")),
      eventId,
      playerId,
      market,
      book: firstValue(row, ["book", "sportsbook", "operator"]) || "Market",
      oddsAmerican: numberText(firstValue(row, ["oddsAmerican", "americanOdds", "odds", "price"])),
      impliedProbability: numberText(firstValue(row, ["impliedProbability", "impliedProb"])),
      capturedAt
    }, options));
  });
}

function adaptWeather(rows, options, tables) {
  rows.forEach((row, index) => {
    const eventId = eventIdFor(row, options);
    const courseId = courseIdFor(row, options);
    const courseName = courseNameFor(row, options);
    if (!eventId && !courseId && !courseName) return;
    tables.weatherSnapshots.push(attachSource({
      id: firstValue(row, ["weatherId"]) || slug([eventId, courseId || courseName, firstValue(row, ["roundNumber", "round"]), firstValue(row, ["observedAt", "forecastAt", "date"]), index + 1].join(" ")),
      eventId,
      courseId,
      courseName,
      roundNumber: numberText(firstValue(row, ["roundNumber", "round"])),
      date: firstValue(row, ["date"]),
      observedAt: firstValue(row, ["observedAt", "timestamp"]),
      forecastAt: firstValue(row, ["forecastAt"]),
      temperatureF: numberText(firstValue(row, ["temperatureF", "tempF", "temperature"])),
      windMph: numberText(firstValue(row, ["windMph", "wind"])),
      gustMph: numberText(firstValue(row, ["gustMph", "gust"])),
      precipitationIn: numberText(firstValue(row, ["precipitationIn", "precipIn", "rainIn"])),
      wave: firstValue(row, ["wave", "teeWave"])
    }, options));
  });
}

function adaptEnrichment(rows, options, tables) {
  rows.forEach((row, index) => {
    addPlayer(tables, row, options);
    const playerId = playerIdFor(row);
    const playerName = playerNameFor(row);
    if (!playerId && !playerName) return;
    const resolvedPlayerId = playerId || slug(playerName);
    const capturedDate = firstValue(row, ["capturedDate", "date", "capturedAt", "asOfDate"]) || cleanString(options.fetchedAt).slice(0, 10);
    const equipmentValues = {
      driver: firstValue(row, ["driver"]),
      fairwayWoods: firstValue(row, ["fairwayWoods", "fairway", "woods"]),
      hybrids: firstValue(row, ["hybrids", "hybrid"]),
      irons: firstValue(row, ["irons"]),
      wedges: firstValue(row, ["wedges"]),
      putter: firstValue(row, ["putter"]),
      ball: firstValue(row, ["ball"]),
      apparel: firstValue(row, ["apparel", "sponsor", "clothing"]),
      confidence: firstValue(row, ["equipmentConfidence", "bagConfidence", "confidence"])
    };
    if (Object.values(equipmentValues).some(Boolean)) {
      tables.equipmentSnapshots.push(attachSource({
        id: firstValue(row, ["equipmentId", "bagId"]) || slug([resolvedPlayerId, capturedDate || index + 1, "bag"].join(" ")),
        playerId: resolvedPlayerId,
        capturedDate,
        ...equipmentValues
      }, options));
    }

    const label = firstValue(row, ["accomplishment", "accomplishmentLabel", "achievement", "label", "title"]);
    const accomplishmentEvent = firstValue(row, ["accomplishmentEvent", "eventName", "event"]);
    const accomplishmentType = firstValue(row, ["accomplishmentType", "type", "category"]) || (label ? "achievement" : "");
    if (label || accomplishmentEvent || accomplishmentType) {
      tables.accomplishments.push(attachSource({
        id: firstValue(row, ["accomplishmentId", "achievementId"]) || slug([resolvedPlayerId, accomplishmentType, label || accomplishmentEvent, firstValue(row, ["season", "year"]), index + 1].join(" ")),
        playerId: resolvedPlayerId,
        type: accomplishmentType,
        label: label || accomplishmentEvent,
        eventName: accomplishmentEvent,
        season: numberText(firstValue(row, ["season", "year"])),
        date: firstValue(row, ["accomplishmentDate", "resultDate", "date"])
      }, options));
    }
  });
}

function pruneTables(tables) {
  return Object.fromEntries(Object.entries(tables).filter(([, rows]) => Array.isArray(rows) && rows.length));
}

function dedupeRows(rows, collection) {
  const seen = new Map();
  rows.forEach((row, index) => {
    const key = cleanString(row.id) || [
      row.eventId,
      row.playerId,
      row.playerName,
      row.market,
      row.roundNumber,
      row.date,
      row.courseId,
      index
    ].map(cleanString).filter(Boolean).join("|") || String(index);
    seen.set(`${collection}:${key}`, row);
  });
  return [...seen.values()];
}

function adaptRows(type, rows, options = {}) {
  const cleanType = cleanString(type).toLowerCase();
  if (!ADAPTER_TYPES.has(cleanType)) {
    throw new Error(`Unsupported Golf Lab adapter type: ${type}`);
  }
  const tables = blankTables();
  if (cleanType === "schedule") adaptSchedule(rows, options, tables);
  if (cleanType === "profile") adaptProfile(rows, options, tables);
  if (cleanType === "field") adaptField(rows, options, tables);
  if (cleanType === "course") adaptCourse(rows, options, tables);
  if (cleanType === "leaderboard") adaptLeaderboard(rows, options, tables);
  if (cleanType === "odds") adaptOdds(rows, options, tables);
  if (cleanType === "weather") adaptWeather(rows, options, tables);
  if (cleanType === "enrichment") adaptEnrichment(rows, options, tables);
  tables.sourceFetches.push(sourceFetch(cleanType, rows.length, options));
  Object.keys(tables).forEach((collection) => {
    tables[collection] = dedupeRows(tables[collection], collection);
  });
  return {
    type: cleanType,
    rowCount: rows.length,
    tables: pruneTables(tables)
  };
}

async function readRawCsv(filePath) {
  return Warehouse.parseGolfLabCsv(await fsp.readFile(filePath, "utf8"));
}

async function readExistingRows(filePath) {
  try {
    return Warehouse.parseGolfLabCsv(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeCollectionCsv(outputDir, collection, rows) {
  const columns = Warehouse.COLLECTION_COLUMNS[collection] || [];
  const fileName = `${collection.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}.csv`;
  const filePath = path.join(outputDir, fileName);
  const existing = await readExistingRows(filePath);
  const merged = dedupeRows([...existing, ...rows], collection);
  const body = [columns.map(csvCell).join(","), ...merged.map((row) => csvLine(columns, row))].join("\n");
  await fsp.writeFile(filePath, `${body}\n`, "utf8");
  return {
    collection,
    file: fileName,
    rows: merged.length,
    addedRows: rows.length
  };
}

async function adaptRawSourceFile(inputFile, options = {}) {
  const rows = await readRawCsv(inputFile);
  return adaptRows(options.type, rows, { ...options, inputFile });
}

function inferAdapterTypeFromFileName(fileName) {
  const base = path.basename(cleanString(fileName)).toLowerCase().replace(/\.[^.]+$/, "");
  const tokens = base.split(/[^a-z0-9]+/).filter(Boolean);
  const tokenSet = new Set(tokens);
  const has = (...values) => values.some((value) => tokenSet.has(value) || base.includes(value));
  if (has("schedule", "event-schedule", "tournament-schedule", "tournament-calendar")) return "schedule";
  if (has("profile", "profiles", "player-profile", "player-profiles", "owgr")) return "profile";
  if (has("field", "fields", "tee-time", "tee-times", "teetime", "teetimes")) return "field";
  if (has("course", "courses", "setup", "course-scorecard", "yardage", "venue")) return "course";
  if (has("leaderboard", "leaderboards", "round", "rounds", "results", "scoring", "scorecard", "scorecards")) return "leaderboard";
  if (has("odds", "market", "markets", "prices", "lines", "sportsbook")) return "odds";
  if (has("weather", "forecast", "wind", "winds")) return "weather";
  if (has("enrichment", "equipment", "witb", "bag", "bags", "accomplishment", "accomplishments", "achievement", "achievements")) return "enrichment";
  if (has("players")) return "profile";
  return "";
}

async function adaptBatchSourceDirectory(batchDir, options = {}) {
  const resolvedInput = path.resolve(batchDir || "");
  const resolvedOutput = path.resolve(options.outputDir || "");
  if (!batchDir) throw new Error("Missing --batch folder.");
  if (!options.outputDir) throw new Error("Missing --out folder for batch adapter.");
  if (resolvedInput === resolvedOutput) {
    throw new Error("Batch input folder and output folder must be different.");
  }
  const entries = await fsp.readdir(resolvedInput, { withFileTypes: true });
  const csvFiles = entries
    .filter((entry) => entry.isFile() && /\.csv$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const adapted = [];
  const skipped = [];
  for (const fileName of csvFiles) {
    const type = inferAdapterTypeFromFileName(fileName);
    if (!type) {
      skipped.push({ file: fileName, reason: "No supported adapter type inferred from file name." });
      continue;
    }
    const inputFile = path.join(resolvedInput, fileName);
    const source = await adaptRawSourceFile(inputFile, { ...options, type, inputFile });
    const result = await writeAdaptedSource(resolvedOutput, source);
    adapted.push({
      file: fileName,
      type,
      rowCount: source.rowCount,
      outputDir: result.outputDir,
      files: result.files
    });
  }
  if (!adapted.length) {
    throw new Error(`No supported Golf Lab CSV source files found in ${resolvedInput}.`);
  }
  const writtenFiles = adapted.reduce((sum, item) => sum + item.files.length, 0);
  return {
    inputDir: resolvedInput,
    outputDir: resolvedOutput,
    adapted,
    skipped,
    totals: {
      files: adapted.length,
      rawRows: adapted.reduce((sum, item) => sum + item.rowCount, 0),
      collectionWrites: writtenFiles,
      skipped: skipped.length
    }
  };
}

async function writeAdaptedSource(outputDir, adapted) {
  const resolvedOutput = path.resolve(outputDir);
  await fsp.mkdir(resolvedOutput, { recursive: true });
  const files = [];
  for (const [collection, rows] of Object.entries(adapted.tables || {})) {
    files.push(await writeCollectionCsv(resolvedOutput, collection, rows));
  }
  return {
    outputDir: resolvedOutput,
    type: adapted.type,
    files
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.batchDir) {
    const result = await adaptBatchSourceDirectory(args.batchDir, args);
    console.log(`Golf Lab batch sources adapted: ${result.outputDir}`);
    console.log(`${result.totals.files} source files | ${result.totals.rawRows} raw rows | ${result.totals.collectionWrites} collection writes`);
    if (result.skipped.length) console.log(`Skipped ${result.skipped.length} unsupported CSV files`);
    return 0;
  }
  if (!args.type || !args.inputFile || !args.outputDir) {
    throw new Error(`${usage()}\n\nMissing --type, --in, or --out.`);
  }
  const adapted = await adaptRawSourceFile(args.inputFile, args);
  const result = await writeAdaptedSource(args.outputDir, adapted);
  console.log(`Golf Lab ${adapted.type} source adapted: ${result.outputDir}`);
  console.log(`${result.files.length} collection files | ${adapted.rowCount} raw rows`);
  return 0;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  adaptRows,
  adaptRawSourceFile,
  adaptBatchSourceDirectory,
  inferAdapterTypeFromFileName,
  writeAdaptedSource,
  parseArgs,
  usage
};
