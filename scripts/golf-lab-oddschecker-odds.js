#!/usr/bin/env node
/*
 * Convert a saved public Oddschecker golf market page into Golf Lab odds rows.
 *
 * Oddschecker markets are usually rendered as player names followed by one
 * price per book. This adapter keeps the book-level cells and appends an
 * "Oddschecker Best" row for each player so the model prices against the best
 * available public market while preserving source audit detail.
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");

const DEFAULT_PROVIDER = "Oddschecker public odds";
const DEFAULT_SOURCE_URL = "https://www.oddschecker.com/golf/us-open/winner";
const DEFAULT_BOOKS = Object.freeze([
  "Bet365",
  "William Hill",
  "Unibet",
  "Betfred",
  "888sport",
  "Spreadex",
  "Ladbrokes",
  "BetVictor",
  "BetMGM UK",
  "BoyleSports",
  "10bet",
  "Star Sports",
  "PricedUp",
  "Sporting Index",
  "BetGoodwin",
  "Virgin Bet",
  "QuinnBet",
  "Betway",
  "Coral",
  "BetAhoy",
  "BetTom",
  "BresBet",
  "Skybet",
  "Paddy Power",
  "AK Bets",
  "Betfair",
  "Matchbook"
]);

function cleanString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return "";
}

function decodeHtmlEntities(value) {
  return String(value || "")
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

function parseArgs(argv) {
  const args = {
    provider: DEFAULT_PROVIDER,
    sourceUrl: DEFAULT_SOURCE_URL,
    market: "",
    status: "ok",
    includeBestRow: true,
    bestOnly: false
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
    else if (token === "--best-only") args.bestOnly = true;
    else if (token === "--no-best-row") args.includeBestRow = false;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-oddschecker-odds.js --in <saved-html-or-text> --out <warehouse-folder> --event-id <event-id> [options]",
    "",
    "Options:",
    "  --market <market>       Golf Lab market label. Defaults to the page title when possible.",
    "  --provider <name>       Source provider label. Defaults to Oddschecker public odds.",
    "  --source-url <url>      Public source URL for provenance.",
    "  --fetched-at <iso>      Snapshot timestamp. Defaults to now.",
    "  --status <status>       Source ledger status. Defaults to ok.",
    "  --best-only             Write only each player's best visible price.",
    "  --no-best-row           Do not append Oddschecker Best rows."
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

function titleCaseBook(value) {
  const clean = cleanString(value)
    .replace(/\b(logo|icon|odds|image)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const known = {
    "888sport": "888sport",
    "10bet": "10bet",
    akbets: "AK Bets",
    bet365: "Bet365",
    betahoy: "BetAhoy",
    betfair: "Betfair",
    betfred: "Betfred",
    betgoodwin: "BetGoodwin",
    betmgm: "BetMGM",
    betmgmuk: "BetMGM UK",
    bettom: "BetTom",
    betvictor: "BetVictor",
    betway: "Betway",
    boylesports: "BoyleSports",
    bresbet: "BresBet",
    coral: "Coral",
    ladbrokes: "Ladbrokes",
    matchbook: "Matchbook",
    paddypower: "Paddy Power",
    pricedup: "PricedUp",
    quinnbet: "QuinnBet",
    skybet: "Skybet",
    sportingindex: "Sporting Index",
    spreadex: "Spreadex",
    starsports: "Star Sports",
    unibet: "Unibet",
    virginbet: "Virgin Bet",
    williamhill: "William Hill"
  };
  return known[key] || clean.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function removeCitationMarkup(value) {
  return String(value || "")
    .replace(/cite\d+†([^†]+)(?:†[^]*)?/g, "$1")
    .replace(/【\d+†([^】]+)】/g, "$1")
    .replace(/\[[0-9]+\]/g, " ");
}

function visibleTextFromMarkup(input) {
  let text = removeCitationMarkup(String(input || ""));
  text = text
    .replace(/<script\b[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "\n")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "\n")
    .replace(/<img[^>]*\balt=["']([^"']+)["'][^>]*>/gi, "\nImage: $1\n")
    .replace(/<h([1-6])\b[^>]*>/gi, "\n# ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(a|button|div|li|p|section|span|td|th|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeHtmlEntities(text);
}

function cleanLine(value) {
  return cleanString(removeCitationMarkup(value))
    .replace(/^L[0-9]+:\s*/i, "")
    .replace(/\s*\|\s*$/, "")
    .trim();
}

function visibleLines(input) {
  return visibleTextFromMarkup(input)
    .split(/\n+/)
    .map(cleanLine)
    .filter(Boolean);
}

function extractPageTitle(lines) {
  const title = lines.find((line) => /^#\s+.+Betting Odds/i.test(line)) ||
    lines.find((line) => /US Open\s+-\s+.+Betting Odds/i.test(line)) ||
    "";
  return cleanString(title.replace(/^#+\s*/, ""));
}

function inferMarketFromTitle(title) {
  const clean = cleanString(title)
    .replace(/\bBetting Odds\b/gi, "")
    .replace(/\bUS Open\b/gi, "")
    .replace(/^\s*-\s*/, "")
    .trim();
  const key = slug(clean).replace(/-/g, "");
  if (key === "winner" || key === "outright" || key === "winonly") return "winner";
  if (key.includes("top10")) return "top 10";
  if (key.includes("top20")) return "top 20";
  if (key.includes("tomakethecut") || key.includes("makecut")) return "make cut";
  return cleanString(clean) || "";
}

function extractBookHeaders(lines) {
  const quickBetIndex = lines.findIndex((line) => /^QuickBet$/i.test(line));
  const sortIndex = lines.findIndex((line) => /^Sort By$/i.test(line));
  const start = sortIndex >= 0 ? sortIndex : Math.max(0, quickBetIndex - 5);
  const end = quickBetIndex >= 0 ? quickBetIndex : Math.min(lines.length, start + 20);
  const headerText = lines.slice(start, end).join(" ");
  const books = [];
  const imageRegex = /Image:\s*([A-Za-z0-9 .&+'-]+?)(?=\s+Image:|$)/g;
  let match;
  while ((match = imageRegex.exec(headerText)) !== null) {
    const book = titleCaseBook(match[1]);
    if (book && !books.includes(book)) books.push(book);
  }
  return books.length ? books : [...DEFAULT_BOOKS];
}

function decimalToAmerican(decimalOdds) {
  const decimal = Number(decimalOdds);
  if (!Number.isFinite(decimal) || decimal <= 1) return null;
  const payout = decimal - 1;
  return payout >= 1 ? Math.round(payout * 100) : Math.round(-100 / payout);
}

function fractionalToAmerican(numerator, denominator) {
  const top = Number(numerator);
  const bottom = Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || top <= 0 || bottom <= 0) return null;
  const payout = top / bottom;
  return payout >= 1 ? Math.round(payout * 100) : Math.round(-100 / payout);
}

function parseOddsToken(value) {
  const token = cleanString(value)
    .replace(/,/g, "")
    .replace(/\*/g, "")
    .toLowerCase();
  if (!token || token.length > 14) return null;
  if (/^(evs|even|evens)$/.test(token)) return 100;
  const american = token.match(/^([+-])\s*([0-9]{2,6})$/);
  if (american) {
    const number = Number(`${american[1]}${american[2]}`);
    return Number.isFinite(number) && number !== 0 ? number : null;
  }
  const fraction = token.match(/^([0-9]{1,4})\s*\/\s*([0-9]{1,4})$/);
  if (fraction) return fractionalToAmerican(fraction[1], fraction[2]);
  const decimal = token.match(/^([0-9]{1,3}\.[0-9]{1,3})$/);
  if (decimal) return decimalToAmerican(Number(decimal[1]));
  const wholeFraction = token.match(/^([1-9][0-9]?)$/);
  if (wholeFraction) return Number(wholeFraction[1]) * 100;
  return null;
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

function isIgnorableLine(line) {
  return !line ||
    /^(\*|Odds format|Fractional Decimal|Favourite|Name|QuickBet|Sportsbooks Exchanges|Best Odds|Odds Shortening|Odds Drifting)$/i.test(line) ||
    /^Sort By$/i.test(line) ||
    /^Image:/i.test(line) ||
    /^Change (Event|Market)$/i.test(line) ||
    /^US Open (Outrights|Matches)$/i.test(line) ||
    /^View All Markets/i.test(line);
}

function isStopLine(line) {
  return /^#{1,3}\s+/i.test(line) ||
    /^Latest /i.test(line) ||
    /^How to /i.test(line) ||
    /^US Open Betting/i.test(line) ||
    /^US Open Odds/i.test(line) ||
    /^Compare /i.test(line) ||
    /^Frequently Asked/i.test(line) ||
    /^FAQs/i.test(line);
}

function isLikelyPlayerName(line) {
  const clean = cleanLine(line);
  if (!clean || clean.length > 45 || clean.length < 3) return false;
  if (isIgnorableLine(clean) || isStopLine(clean)) return false;
  if (parseOddsToken(clean) !== null) return false;
  if (/^[0-9]+$/.test(clean)) return false;
  if (/[£$%]|T&Cs|Claim|Offer|GambleAware|Deposit|customer|minimum|stake|oddschecker/i.test(clean)) return false;
  if (!/[A-Za-z]/.test(clean)) return false;
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  return words.every((word) => /^[A-Za-z][A-Za-z'.-]*$/.test(word) || /^[A-Z]\.?[A-Z]?\.?$/.test(word));
}

function nextHasOdds(lines, index) {
  for (let offset = 1; offset <= 4 && index + offset < lines.length; offset += 1) {
    const line = lines[index + offset];
    if (parseOddsToken(line) !== null) return true;
    if (line && !isIgnorableLine(line)) return false;
  }
  return false;
}

function addBestRows(playerRows, options = {}) {
  if (options.includeBestRow === false) return playerRows;
  const rows = [];
  playerRows.forEach((playerRow) => {
    const odds = [...playerRow.odds];
    const best = odds
      .filter((row) => Number.isFinite(row.oddsAmerican))
      .sort((a, b) => b.oddsAmerican - a.oddsAmerican)[0];
    rows.push({
      playerName: playerRow.playerName,
      odds: options.bestOnly ? [] : odds
    });
    if (best) {
      rows[rows.length - 1].odds.push({
        book: "Oddschecker Best",
        rawOdds: best.rawOdds,
        oddsAmerican: best.oddsAmerican,
        impliedProbability: impliedProbabilityFromAmerican(best.oddsAmerican)
      });
    }
  });
  return rows;
}

function parsePlayerRows(lines, books, options = {}) {
  const quickBetIndex = lines.findIndex((line) => /^QuickBet$/i.test(line));
  const start = quickBetIndex >= 0 ? quickBetIndex + 1 : Math.max(0, lines.findIndex((line) => /^Best Odds$/i.test(line)) + 1);
  const rows = [];
  let current = null;
  const flush = () => {
    if (current && current.odds.length) rows.push(current);
    current = null;
  };

  for (let index = start; index < lines.length; index += 1) {
    const line = cleanLine(lines[index]);
    if (!line || isIgnorableLine(line)) continue;
    if (isStopLine(line)) break;
    const oddsAmerican = parseOddsToken(line);
    if (oddsAmerican !== null) {
      if (!current) continue;
      const book = books[current.odds.length] || `Book ${current.odds.length + 1}`;
      current.odds.push({
        book,
        rawOdds: line,
        oddsAmerican,
        impliedProbability: impliedProbabilityFromAmerican(oddsAmerican)
      });
      continue;
    }
    if (isLikelyPlayerName(line) && nextHasOdds(lines, index)) {
      flush();
      current = {
        playerName: line,
        odds: []
      };
    }
  }
  flush();
  return addBestRows(rows, options);
}

function flattenPlayerRows(playerRows) {
  const rows = [];
  playerRows.forEach((playerRow) => {
    playerRow.odds.forEach((oddsRow) => {
      rows.push({
        playerName: playerRow.playerName,
        book: oddsRow.book,
        rawOdds: oddsRow.rawOdds,
        oddsAmerican: oddsRow.oddsAmerican,
        impliedProbability: oddsRow.impliedProbability
      });
    });
  });
  return rows;
}

function extractOddscheckerOdds(input, options = {}) {
  const lines = visibleLines(input);
  const title = extractPageTitle(lines);
  const books = extractBookHeaders(lines);
  const inferredMarket = inferMarketFromTitle(title);
  const market = cleanString(options.market || inferredMarket || "winner");
  const playerRows = parsePlayerRows(lines, books, options);
  const flattened = flattenPlayerRows(playerRows);
  return {
    title,
    market,
    books,
    playerRows,
    rows: flattened,
    sourceUpdatedAt: cleanString(options.sourceUpdatedAt || options.fetchedAt || "")
  };
}

function sourceFields(options, sourceUpdatedAt = "") {
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  return {
    provider: cleanString(options.provider || DEFAULT_PROVIDER),
    sourceProvider: cleanString(options.provider || DEFAULT_PROVIDER),
    sourceUrl: cleanString(options.sourceUrl || DEFAULT_SOURCE_URL),
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

  const playerCount = new Set(extracted.rows.map((row) => normalizeName(row.playerName)).filter(Boolean)).size;
  const sourceFetches = [{
    id: slug([source.provider, "oddschecker-golf-market", eventId, market, source.fetchedAt].join(" ")),
    provider: source.provider,
    endpoint: `oddschecker-golf-market/${eventId}/${slug(market)}`,
    eventId,
    fetchedAt: source.fetchedAt,
    status: cleanString(options.status || "ok"),
    rowCount: oddsSnapshots.length,
    manifestJson: JSON.stringify({
      sourceType: "public-oddschecker-html-odds",
      title: cleanString(extracted.title),
      market,
      books: extracted.books,
      playerCount,
      playerRows: extracted.playerRows.length,
      bestRowIncluded: options.includeBestRow !== false,
      bestOnly: Boolean(options.bestOnly),
      note: "Public multi-book market table; Oddschecker Best rows are derived from visible book cells and are not betting advice."
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
      playerRows: extracted.playerRows.length,
      playerOddsRows: extracted.rows.length,
      oddsSnapshots: oddsSnapshots.length,
      createdPlayers: createdPlayers.size,
      bestRows: extracted.rows.filter((row) => row.book === "Oddschecker Best").length
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

async function adaptOddscheckerOdds(inputFile, outputDir, options = {}) {
  const resolvedInput = path.resolve(inputFile);
  const resolvedOutput = path.resolve(outputDir);
  const html = await fsp.readFile(resolvedInput, "utf8");
  const extracted = extractOddscheckerOdds(html, options);
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
  const result = await adaptOddscheckerOdds(args.inputFile, args.outputDir, args);
  console.log(`Golf Lab Oddschecker odds adapted: ${result.outputDir}`);
  console.log(`${result.summary.oddsSnapshots} odds rows | ${result.summary.playerRows} players | ${result.summary.bestRows} best-price rows`);
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
  extractOddscheckerOdds,
  buildRowsFromExtracted,
  parseOddsToken,
  impliedProbabilityFromAmerican,
  adaptOddscheckerOdds,
  usage
};
