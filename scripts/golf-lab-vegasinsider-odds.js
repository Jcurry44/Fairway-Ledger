#!/usr/bin/env node
/*
 * Convert a saved public VegasInsider golf futures page into Golf Lab odds rows.
 *
 * This imports market prices from a raw HTML snapshot. It is intentionally a
 * source-backed adapter, not a live betting recommendation engine.
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");

const DEFAULT_PROVIDER = "VegasInsider public odds";
const DEFAULT_SOURCE_URL = "https://www.vegasinsider.com/golf/odds/futures/";
const DEFAULT_BOOKS = Object.freeze(["Bet365", "BetMGM", "DraftKings", "Caesars", "FanDuel", "RiversCasino"]);

function cleanString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return "";
}

function decodeHtmlEntities(value) {
  return cleanString(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " "));
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

function titleCaseBook(value) {
  const clean = cleanString(value);
  if (!clean) return "";
  const known = {
    bet365: "Bet365",
    betmgm: "BetMGM",
    draftkings: "DraftKings",
    caesars: "Caesars",
    fanduel: "FanDuel",
    riverscasino: "RiversCasino",
    betrivers: "BetRivers"
  };
  return known[clean.toLowerCase().replace(/[^a-z0-9]+/g, "")] || clean;
}

function parseArgs(argv) {
  const args = {
    provider: DEFAULT_PROVIDER,
    sourceUrl: DEFAULT_SOURCE_URL,
    market: "winner",
    status: "ok"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--in") args.inputFile = argv[index += 1];
    else if (token === "--out") args.outputDir = argv[index += 1];
    else if (token === "--event-id") args.eventId = argv[index += 1];
    else if (token === "--market") args.market = argv[index += 1];
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
    "Usage: node scripts/golf-lab-vegasinsider-odds.js --in <saved-html> --out <warehouse-folder> --event-id <event-id> [options]",
    "",
    "Options:",
    "  --market <market>       Golf Lab market label. Defaults to winner.",
    "  --provider <name>       Source provider label. Defaults to VegasInsider public odds.",
    "  --source-url <url>      Public source URL for provenance.",
    "  --fetched-at <iso>      Snapshot timestamp. Defaults to now.",
    "  --status <status>       Source ledger status. Defaults to ok."
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

function extractTableTitle(html) {
  const match = String(html || "").match(/<h2[^>]*>\s*([^<]*Golf Odds|[^<]*Open Odds|[^<]*Odds)\s*<\/h2>/i);
  return match ? stripTags(match[1]) : "";
}

function extractPageUpdatedText(html) {
  const text = stripTags(html);
  const updatedOn = text.match(/Updated on\s+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i);
  if (updatedOn) return `Updated on ${updatedOn[1]}`;
  const lastUpdated = text.match(/Last Updated\s+([A-Z][a-z]{2,9}\s+[0-9]{1,2}\s+[0-9]{4}(?:,\s*[0-9]{1,2}:[0-9]{2}\s*[AP]M)?)/i);
  if (lastUpdated) return `Last Updated ${lastUpdated[1]}`;
  return "";
}

function monthNumber(value) {
  const token = cleanString(value).slice(0, 3).toLowerCase();
  return {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12"
  }[token] || "";
}

function pageUpdatedAtFromText(value) {
  const clean = cleanString(value);
  const slash = clean.match(/([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{2,4})/);
  if (slash) {
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${year}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
  }
  const named = clean.match(/([A-Z][a-z]{2,9})\s+([0-9]{1,2})\s+([0-9]{4})/);
  if (named) {
    const month = monthNumber(named[1]);
    if (month) return `${named[3]}-${month}-${named[2].padStart(2, "0")}`;
  }
  return "";
}

function extractBookHeaders(html) {
  const books = [];
  const theadMatch = String(html || "").match(/<thead[\s\S]*?<\/thead>/i);
  if (theadMatch) {
    const hiddenSpanRegex = /<th[^>]*class=["'][^"']*book-pinup[^"']*["'][^>]*>[\s\S]*?<span[^>]*class=["'][^"']*hidden[^"']*["'][^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/th>/gi;
    let match;
    while ((match = hiddenSpanRegex.exec(theadMatch[0])) !== null) {
      const book = titleCaseBook(stripTags(match[1]));
      if (book) books.push(book);
    }
  }
  if (books.length) return books;

  const headerRowMatch = String(html || "").match(/<tbody[^>]*class=["'][^"']*active[^"']*["'][^>]*>[\s\S]*?<tr[\s\S]*?<\/tr>[\s\S]*?<\/tbody>/i);
  if (headerRowMatch) {
    const altRegex = /<img[^>]+alt=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = altRegex.exec(headerRowMatch[0])) !== null) {
      const book = titleCaseBook(decodeHtmlEntities(match[1]));
      if (book) books.push(book);
    }
  }
  return books.length ? books : [...DEFAULT_BOOKS];
}

function drawerBody(html) {
  const match = String(html || "").match(/<tbody[^>]*id=["']see-all-tournament-winner["'][^>]*>([\s\S]*?)<\/tbody>/i);
  if (match) return match[1];
  const fallback = String(html || "").match(/<tbody[^>]*class=["'][^"']*drawer[^"']*["'][^>]*>([\s\S]*?)<\/tbody>/i);
  return fallback ? fallback[1] : "";
}

function extractNameFromRow(rowHtml) {
  const teamCell = String(rowHtml || "").match(/<td[^>]*class=["'][^"']*game-team[^"']*["'][^>]*>([\s\S]*?)<\/td>/i);
  if (teamCell) {
    const spans = [...teamCell[1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)]
      .map((match) => stripTags(match[1]))
      .filter(Boolean);
    if (spans.length) return spans[spans.length - 1];
    const text = stripTags(teamCell[1]);
    if (text) return text;
  }
  const dataName = String(rowHtml || "").match(/\sdata-name=["']([^"']+)["']/i);
  return dataName ? decodeHtmlEntities(dataName[1]).replace(/\b\w/g, (letter) => letter.toUpperCase()) : "";
}

function parseAmericanOdds(value) {
  const clean = stripTags(value).replace(/,/g, "").replace(/\s+/g, " ");
  const match = clean.match(/([+-]\s*\d{2,6}|\b\d{2,6}\b)/);
  if (!match) return null;
  const number = Number(match[1].replace(/\s+/g, ""));
  return Number.isFinite(number) && number !== 0 ? number : null;
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

function extractVegasInsiderOdds(html, options = {}) {
  const body = drawerBody(html);
  const books = extractBookHeaders(html);
  const rows = [];
  const trRegex = /<tr\b[\s\S]*?<\/tr>/gi;
  let match;
  while ((match = trRegex.exec(body)) !== null) {
    const rowHtml = match[0];
    const playerName = extractNameFromRow(rowHtml);
    if (!playerName) continue;
    const cells = [...rowHtml.matchAll(/<td[^>]*class=["'][^"']*game-odds[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi)];
    cells.slice(0, books.length).forEach((cell, index) => {
      const oddsAmerican = parseAmericanOdds(cell[1]);
      if (!Number.isFinite(oddsAmerican)) return;
      rows.push({
        playerName,
        book: books[index] || `Book ${index + 1}`,
        oddsAmerican,
        impliedProbability: impliedProbabilityFromAmerican(oddsAmerican)
      });
    });
  }

  const pageUpdatedText = extractPageUpdatedText(html);
  return {
    title: extractTableTitle(html),
    market: cleanString(options.market || "winner"),
    books,
    pageUpdatedText,
    pageUpdatedAt: pageUpdatedAtFromText(pageUpdatedText),
    rows
  };
}

function sourceFields(options, pageUpdatedAt = "") {
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  return {
    provider: cleanString(options.provider || DEFAULT_PROVIDER),
    sourceProvider: cleanString(options.provider || DEFAULT_PROVIDER),
    sourceUrl: cleanString(options.sourceUrl || DEFAULT_SOURCE_URL),
    fetchedAt,
    sourceUpdatedAt: cleanString(pageUpdatedAt) || fetchedAt
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
  const source = sourceFields(options, extracted.pageUpdatedAt);
  const market = cleanString(options.market || extracted.market || "winner");
  const createdPlayers = new Map();
  const indexes = buildPlayerIndexes(existing.players || [], existing.fields || [], eventId);
  const oddsSnapshots = [];

  extracted.rows.forEach((row) => {
    const resolved = resolvePlayer(row, indexes, options, createdPlayers);
    if (!resolved.playerId) return;
    const implied = formatProbability(row.impliedProbability);
    oddsSnapshots.push({
      id: slug([eventId, resolved.playerId, market, row.book, source.fetchedAt].join(" ")),
      eventId,
      playerId: resolved.playerId,
      market,
      book: row.book,
      oddsAmerican: String(row.oddsAmerican),
      impliedProbability: implied,
      capturedAt: source.fetchedAt,
      sourceProvider: source.sourceProvider,
      sourceUrl: source.sourceUrl,
      sourceUpdatedAt: source.sourceUpdatedAt
    });
  });

  const sourceFetches = [{
    id: slug([source.provider, "vegasinsider-golf-futures", eventId, market, source.fetchedAt].join(" ")),
    provider: source.provider,
    endpoint: `vegasinsider-golf-futures/${eventId}/${market}`,
    eventId,
    fetchedAt: source.fetchedAt,
    status: cleanString(options.status || "ok"),
    rowCount: oddsSnapshots.length,
    manifestJson: JSON.stringify({
      sourceType: "public-vegasinsider-html-odds",
      title: cleanString(extracted.title),
      market,
      books: extracted.books,
      playerCount: new Set(extracted.rows.map((row) => normalizeName(row.playerName)).filter(Boolean)).size,
      pageUpdatedText: cleanString(extracted.pageUpdatedText),
      pageUpdatedAt: cleanString(extracted.pageUpdatedAt),
      note: "Public multi-book futures table; prices are market snapshots, not betting advice."
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
      books: extracted.books,
      playerOddsRows: extracted.rows.length,
      oddsSnapshots: oddsSnapshots.length,
      createdPlayers: createdPlayers.size,
      pageUpdatedAt: extracted.pageUpdatedAt,
      pageUpdatedText: extracted.pageUpdatedText
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

async function adaptVegasInsiderOdds(inputFile, outputDir, options = {}) {
  const resolvedInput = path.resolve(inputFile);
  const resolvedOutput = path.resolve(outputDir);
  const html = await fsp.readFile(resolvedInput, "utf8");
  const extracted = extractVegasInsiderOdds(html, options);
  const existing = await loadExistingWarehouse(resolvedOutput);
  const result = buildRowsFromExtracted(extracted, existing, options);

  await fsp.mkdir(resolvedOutput, { recursive: true });
  await writeCollection(resolvedOutput, "players", upsertRows(existing.players, result.tables.players));
  await writeCollection(resolvedOutput, "oddsSnapshots", upsertRows(existing.oddsSnapshots, result.tables.oddsSnapshots));
  await writeCollection(resolvedOutput, "sourceFetches", upsertRows(existing.sourceFetches, result.tables.sourceFetches));

  return {
    inputFile: resolvedInput,
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
  if (!args.inputFile || !args.outputDir || !args.eventId) {
    throw new Error(`${usage()}\n\nMissing --in, --out, or --event-id.`);
  }
  const result = await adaptVegasInsiderOdds(args.inputFile, args.outputDir, args);
  console.log(`Golf Lab VegasInsider odds adapted: ${result.outputDir}`);
  console.log(`${result.summary.oddsSnapshots} odds rows | ${result.summary.books.length} books | ${result.summary.createdPlayers} new players`);
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
  extractVegasInsiderOdds,
  buildRowsFromExtracted,
  impliedProbabilityFromAmerican,
  adaptVegasInsiderOdds,
  usage
};
