#!/usr/bin/env node
/*
 * Fetch or adapt The Odds API golf outrights into Golf Lab odds rows.
 *
 * Uses the same THE_ODDS_API_KEY pattern as the MLB framework: read from
 * process.env or an env file, save a raw JSON proof file, then normalize into
 * odds_snapshots.csv and source_fetches.csv.
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const { URLSearchParams } = require("node:url");
const Warehouse = require("../lib/golf-lab-warehouse.js");

const DEFAULT_PROVIDER = "The Odds API";
const DEFAULT_SPORT = "golf_us_open_winner";
const DEFAULT_API_MARKET = "outrights";
const DEFAULT_GOLF_MARKET = "winner";
const DEFAULT_REGIONS = "us";
const DEFAULT_ENV_VAR = "THE_ODDS_API_KEY";

function cleanString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
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

function normalizeName(value) {
  return cleanString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function parseArgs(argv) {
  const args = {
    provider: DEFAULT_PROVIDER,
    sport: DEFAULT_SPORT,
    apiMarket: DEFAULT_API_MARKET,
    market: DEFAULT_GOLF_MARKET,
    regions: DEFAULT_REGIONS,
    oddsFormat: "american",
    dateFormat: "iso",
    apiKeyEnv: DEFAULT_ENV_VAR,
    status: "ok",
    includeBestRow: true,
    bestOnly: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--in") args.inputFile = argv[index += 1];
    else if (token === "--out") args.outputDir = argv[index += 1];
    else if (token === "--raw-out") args.rawOut = argv[index += 1];
    else if (token === "--event-id") args.eventId = argv[index += 1];
    else if (token === "--sport") args.sport = argv[index += 1];
    else if (token === "--api-market") args.apiMarket = argv[index += 1];
    else if (token === "--market") args.market = argv[index += 1];
    else if (token === "--regions") args.regions = argv[index += 1];
    else if (token === "--bookmakers") args.bookmakers = argv[index += 1];
    else if (token === "--provider") args.provider = argv[index += 1];
    else if (token === "--source-url") args.sourceUrl = argv[index += 1];
    else if (token === "--fetched-at") args.fetchedAt = argv[index += 1];
    else if (token === "--status") args.status = argv[index += 1];
    else if (token === "--env-file") args.envFile = argv[index += 1];
    else if (token === "--api-key-env") args.apiKeyEnv = argv[index += 1];
    else if (token === "--best-only") args.bestOnly = true;
    else if (token === "--no-best-row") args.includeBestRow = false;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-the-odds-api.js --out <warehouse-folder> --event-id <event-id> [--in <saved-json> | --env-file <file> --raw-out <file>]",
    "",
    "Options:",
    "  --in <json>             Adapt a saved The Odds API response instead of fetching.",
    "  --raw-out <json>        Save fetched raw response for provenance.",
    "  --env-file <file>       Env file containing THE_ODDS_API_KEY.",
    "  --api-key-env <name>    Env variable to read. Defaults to THE_ODDS_API_KEY.",
    "  --sport <key>           The Odds API sport key. Defaults to golf_us_open_winner.",
    "  --api-market <key>      The Odds API market. Defaults to outrights.",
    "  --market <label>        Golf Lab market label. Defaults to winner.",
    "  --regions <regions>     API regions. Defaults to us.",
    "  --bookmakers <keys>     Optional comma-separated book filter.",
    "  --fetched-at <iso>      Snapshot timestamp. Defaults to now.",
    "  --best-only             Write only each player's best visible price.",
    "  --no-best-row           Do not append The Odds API Best rows."
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

function impliedProbabilityFromAmerican(oddsAmerican) {
  const odds = Number(oddsAmerican);
  if (!Number.isFinite(odds) || odds === 0) return null;
  if (odds > 0) return 100 / (odds + 100);
  const favorite = Math.abs(odds);
  return favorite / (favorite + 100);
}

function formatProbability(value) {
  return Number.isFinite(value) ? String(Math.round(value * 10000) / 10000) : "";
}

function loadEnvText(text) {
  const values = {};
  String(text || "").split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) return;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  });
  return values;
}

function parseJsonText(text) {
  return JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
}

async function resolveApiKey(options = {}) {
  const envName = cleanString(options.apiKeyEnv || DEFAULT_ENV_VAR);
  if (envName && process.env[envName]) return process.env[envName];
  const envFile = cleanString(options.envFile);
  if (envFile) {
    const values = loadEnvText(await fsp.readFile(path.resolve(envFile), "utf8"));
    if (values[envName]) return values[envName];
  }
  throw new Error(`Missing ${envName}. Set it in the environment or pass --env-file.`);
}

function sourceUrlForRequest(options = {}) {
  const params = new URLSearchParams({
    regions: cleanString(options.regions || DEFAULT_REGIONS),
    markets: cleanString(options.apiMarket || DEFAULT_API_MARKET),
    oddsFormat: cleanString(options.oddsFormat || "american"),
    dateFormat: cleanString(options.dateFormat || "iso")
  });
  if (cleanString(options.bookmakers)) params.set("bookmakers", cleanString(options.bookmakers));
  return `https://api.the-odds-api.com/v4/sports/${cleanString(options.sport || DEFAULT_SPORT)}/odds?${params.toString()}`;
}

function fetchUrlForRequest(apiKey, options = {}) {
  const params = new URLSearchParams({
    apiKey,
    regions: cleanString(options.regions || DEFAULT_REGIONS),
    markets: cleanString(options.apiMarket || DEFAULT_API_MARKET),
    oddsFormat: cleanString(options.oddsFormat || "american"),
    dateFormat: cleanString(options.dateFormat || "iso")
  });
  if (cleanString(options.bookmakers)) params.set("bookmakers", cleanString(options.bookmakers));
  return `https://api.the-odds-api.com/v4/sports/${cleanString(options.sport || DEFAULT_SPORT)}/odds?${params.toString()}`;
}

async function fetchTheOddsApiGolfOdds(options = {}) {
  const apiKey = await resolveApiKey(options);
  const response = await fetch(fetchUrlForRequest(apiKey, options), {
    headers: { accept: "application/json" }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`The Odds API request failed: ${response.status} ${response.statusText} ${text.slice(0, 240)}`);
  }
  const headers = {
    requestsLast: response.headers.get("x-requests-last") || "",
    requestsRemaining: response.headers.get("x-requests-remaining") || "",
    requestsUsed: response.headers.get("x-requests-used") || ""
  };
  return {
    payload: parseJsonText(text),
    text,
    headers,
    sourceUrl: sourceUrlForRequest(options)
  };
}

function latestTimestamp(values) {
  return values.map(cleanString).filter(Boolean).sort().slice(-1)[0] || "";
}

function extractTheOddsApiGolfOdds(payload, options = {}) {
  const events = Array.isArray(payload) ? payload : [];
  const apiMarket = cleanString(options.apiMarket || DEFAULT_API_MARKET);
  const market = cleanString(options.market || DEFAULT_GOLF_MARKET);
  const rowsByPlayer = new Map();
  const books = new Set();
  const lastUpdates = [];
  const eventIds = [];
  let sportKey = cleanString(options.sport || DEFAULT_SPORT);
  let sportTitle = "";

  events.forEach((event) => {
    eventIds.push(cleanString(event.id));
    sportKey = cleanString(event.sport_key || sportKey);
    sportTitle = cleanString(event.sport_title || sportTitle);
    (event.bookmakers || []).forEach((bookmaker) => {
      const book = cleanString(bookmaker.title || bookmaker.key || "unknown");
      if (!book) return;
      books.add(book);
      lastUpdates.push(bookmaker.last_update);
      (bookmaker.markets || []).forEach((marketRow) => {
        if (cleanString(marketRow.key) !== apiMarket) return;
        lastUpdates.push(marketRow.last_update);
        (marketRow.outcomes || []).forEach((outcome) => {
          const playerName = cleanString(outcome.name);
          const oddsAmerican = Number(outcome.price);
          if (!playerName || !Number.isFinite(oddsAmerican) || oddsAmerican === 0) return;
          if (!rowsByPlayer.has(playerName)) rowsByPlayer.set(playerName, []);
          rowsByPlayer.get(playerName).push({
            playerName,
            book,
            oddsAmerican,
            impliedProbability: impliedProbabilityFromAmerican(oddsAmerican),
            lastUpdate: cleanString(marketRow.last_update || bookmaker.last_update)
          });
        });
      });
    });
  });

  const rows = [];
  rowsByPlayer.forEach((playerRows, playerName) => {
    if (!options.bestOnly) rows.push(...playerRows);
    if (options.includeBestRow !== false && playerRows.length) {
      const best = [...playerRows].sort((a, b) => b.oddsAmerican - a.oddsAmerican)[0];
      rows.push({
        playerName,
        book: "The Odds API Best",
        oddsAmerican: best.oddsAmerican,
        impliedProbability: impliedProbabilityFromAmerican(best.oddsAmerican),
        lastUpdate: best.lastUpdate
      });
    }
  });

  return {
    sportKey,
    sportTitle,
    apiMarket,
    market,
    eventIds: eventIds.filter(Boolean),
    books: [...books],
    playerCount: rowsByPlayer.size,
    rows,
    sourceUpdatedAt: latestTimestamp(lastUpdates)
  };
}

function sourceFields(options, sourceUpdatedAt = "") {
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  return {
    provider: cleanString(options.provider || DEFAULT_PROVIDER),
    sourceProvider: cleanString(options.provider || DEFAULT_PROVIDER),
    sourceUrl: cleanString(options.sourceUrl || sourceUrlForRequest(options)),
    fetchedAt,
    sourceUpdatedAt: cleanString(sourceUpdatedAt) || fetchedAt
  };
}

function buildPlayerIndexes(players, fields, eventId) {
  const byName = new Map();
  const byId = new Map();
  const eventFieldByName = new Map();
  players.forEach((player) => {
    const id = cleanString(player.id);
    const name = cleanString(player.name);
    if (id) byId.set(id, player);
    if (name && id) byName.set(normalizeName(name), player);
  });
  fields
    .filter((field) => cleanString(field.eventId) === cleanString(eventId))
    .forEach((field) => {
      const name = cleanString(field.playerName);
      const playerId = cleanString(field.playerId);
      if (name && playerId) eventFieldByName.set(normalizeName(name), field);
    });
  return { byName, byId, eventFieldByName };
}

function resolvePlayer(rawRow, indexes, options, createdPlayers) {
  const playerName = cleanString(rawRow.playerName);
  const key = normalizeName(playerName);
  const source = sourceFields(options);
  const field = indexes.eventFieldByName.get(key);
  if (field && cleanString(field.playerId)) {
    const playerId = cleanString(field.playerId);
    if (!indexes.byId.has(playerId) && playerName) {
      createdPlayers.set(playerId, {
        id: playerId,
        name: playerName,
        tour: "",
        sourceProvider: source.sourceProvider,
        sourceUrl: source.sourceUrl,
        sourceUpdatedAt: source.sourceUpdatedAt
      });
    }
    return { playerId, playerName: cleanString(field.playerName) || playerName };
  }
  const existing = indexes.byName.get(key);
  if (existing && cleanString(existing.id)) {
    return { playerId: cleanString(existing.id), playerName: cleanString(existing.name) || playerName };
  }
  const playerId = slug(playerName);
  if (playerId && !createdPlayers.has(playerId)) {
    createdPlayers.set(playerId, {
      id: playerId,
      name: playerName,
      tour: "",
      sourceProvider: source.sourceProvider,
      sourceUrl: source.sourceUrl,
      sourceUpdatedAt: source.sourceUpdatedAt
    });
  }
  return { playerId, playerName };
}

function buildRowsFromExtracted(extracted, existing, options = {}) {
  const eventId = cleanString(options.eventId);
  if (!eventId) throw new Error("Missing --event-id.");
  const source = sourceFields(options, extracted.sourceUpdatedAt);
  const market = cleanString(options.market || extracted.market || DEFAULT_GOLF_MARKET);
  const createdPlayers = new Map();
  const indexes = buildPlayerIndexes(existing.players || [], existing.fields || [], eventId);
  const oddsSnapshots = [];

  extracted.rows.forEach((row) => {
    const resolved = resolvePlayer(row, indexes, options, createdPlayers);
    if (!resolved.playerId) return;
    oddsSnapshots.push({
      id: slug([eventId, resolved.playerId, market, row.book, source.fetchedAt].join(" ")),
      eventId,
      playerId: resolved.playerId,
      market,
      book: row.book,
      oddsAmerican: String(row.oddsAmerican),
      impliedProbability: formatProbability(row.impliedProbability),
      capturedAt: source.fetchedAt,
      sourceProvider: source.sourceProvider,
      sourceUrl: source.sourceUrl,
      sourceUpdatedAt: cleanString(row.lastUpdate || extracted.sourceUpdatedAt || source.sourceUpdatedAt)
    });
  });

  const sourceFetches = [{
    id: slug([source.provider, "the-odds-api-golf", eventId, market, source.fetchedAt].join(" ")),
    provider: source.provider,
    endpoint: `the-odds-api/${cleanString(extracted.sportKey || options.sport || DEFAULT_SPORT)}/${slug(market)}`,
    eventId,
    fetchedAt: source.fetchedAt,
    status: cleanString(options.status || "ok"),
    rowCount: oddsSnapshots.length,
    manifestJson: JSON.stringify({
      sourceType: "the-odds-api-golf-outrights",
      sportKey: cleanString(extracted.sportKey || options.sport || DEFAULT_SPORT),
      sportTitle: cleanString(extracted.sportTitle),
      apiMarket: cleanString(extracted.apiMarket || options.apiMarket || DEFAULT_API_MARKET),
      market,
      apiEventIds: extracted.eventIds || [],
      books: extracted.books,
      playerCount: extracted.playerCount,
      bestRowIncluded: options.includeBestRow !== false,
      bestOnly: Boolean(options.bestOnly),
      requestsLast: cleanString(options.requestsLast),
      requestsRemaining: cleanString(options.requestsRemaining),
      requestsUsed: cleanString(options.requestsUsed),
      note: "Paid API market snapshot; The Odds API Best rows are derived from visible book outcomes and are not betting advice."
    }),
    sourceUrl: source.sourceUrl
  }];

  return {
    tables: {
      players: [...createdPlayers.values()],
      oddsSnapshots,
      sourceFetches
    },
    summary: {
      market,
      eventId,
      sportKey: extracted.sportKey,
      sportTitle: extracted.sportTitle,
      books: extracted.books,
      playerRows: extracted.playerCount,
      oddsSnapshots: oddsSnapshots.length,
      createdPlayers: createdPlayers.size,
      bestRows: extracted.rows.filter((row) => row.book === "The Odds API Best").length,
      sourceUpdatedAt: extracted.sourceUpdatedAt
    }
  };
}

async function loadExistingWarehouse(outputDir) {
  return {
    players: await readCollection(outputDir, "players"),
    fields: await readCollection(outputDir, "fields"),
    oddsSnapshots: await readCollection(outputDir, "oddsSnapshots"),
    sourceFetches: await readCollection(outputDir, "sourceFetches")
  };
}

async function readOrFetchPayload(options = {}) {
  if (cleanString(options.inputFile)) {
    const inputFile = path.resolve(options.inputFile);
    const text = await fsp.readFile(inputFile, "utf8");
    return {
      payload: parseJsonText(text),
      inputFile,
      rawOut: "",
      sourceUrl: cleanString(options.sourceUrl || sourceUrlForRequest(options)),
      headers: {}
    };
  }
  const fetched = await fetchTheOddsApiGolfOdds(options);
  let rawOut = "";
  if (cleanString(options.rawOut)) {
    rawOut = path.resolve(options.rawOut);
    await fsp.mkdir(path.dirname(rawOut), { recursive: true });
    await fsp.writeFile(rawOut, `${JSON.stringify(fetched.payload, null, 2)}\n`, "utf8");
  }
  return {
    payload: fetched.payload,
    inputFile: "",
    rawOut,
    sourceUrl: fetched.sourceUrl,
    headers: fetched.headers
  };
}

async function adaptTheOddsApiGolfOdds(options = {}) {
  const resolvedOutput = path.resolve(options.outputDir);
  const payloadResult = await readOrFetchPayload(options);
  const headerOptions = {
    ...options,
    sourceUrl: cleanString(options.sourceUrl || payloadResult.sourceUrl),
    requestsLast: payloadResult.headers.requestsLast,
    requestsRemaining: payloadResult.headers.requestsRemaining,
    requestsUsed: payloadResult.headers.requestsUsed
  };
  const extracted = extractTheOddsApiGolfOdds(payloadResult.payload, headerOptions);
  const existing = await loadExistingWarehouse(resolvedOutput);
  const result = buildRowsFromExtracted(extracted, existing, headerOptions);

  await fsp.mkdir(resolvedOutput, { recursive: true });
  await writeCollection(resolvedOutput, "players", upsertRows(existing.players, result.tables.players));
  await writeCollection(resolvedOutput, "oddsSnapshots", upsertRows(existing.oddsSnapshots, result.tables.oddsSnapshots));
  await writeCollection(resolvedOutput, "sourceFetches", upsertRows(existing.sourceFetches, result.tables.sourceFetches));

  return {
    inputFile: payloadResult.inputFile,
    rawOut: payloadResult.rawOut,
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
  if (!args.outputDir || !args.eventId) {
    throw new Error(`${usage()}\n\nMissing --out or --event-id.`);
  }
  const result = await adaptTheOddsApiGolfOdds(args);
  console.log(`Golf Lab The Odds API odds adapted: ${result.outputDir}`);
  console.log(`${result.summary.oddsSnapshots} odds rows | ${result.summary.playerRows} players | ${result.summary.bestRows} best-price rows`);
  if (result.rawOut) console.log(`Raw snapshot: ${result.rawOut}`);
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
  loadEnvText,
  parseJsonText,
  sourceUrlForRequest,
  extractTheOddsApiGolfOdds,
  buildRowsFromExtracted,
  impliedProbabilityFromAmerican,
  adaptTheOddsApiGolfOdds,
  usage
};
