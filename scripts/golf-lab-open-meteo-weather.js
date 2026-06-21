#!/usr/bin/env node
/*
 * Backfill historical tournament weather from Open-Meteo archive data.
 *
 * The script keeps raw geocoding and archive JSON files beside the warehouse so
 * weather snapshots remain reproducible and source-backed.
 */
const fs = require("node:fs/promises");
const path = require("node:path");
const https = require("node:https");
const Warehouse = require("../lib/golf-lab-warehouse.js");

const DEFAULT_PROVIDER = "Open-Meteo historical weather";

const US_STATES = Object.freeze({
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  IL: "Illinois",
  IN: "Indiana",
  KY: "Kentucky",
  LA: "Louisiana",
  MA: "Massachusetts",
  MD: "Maryland",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  NC: "North Carolina",
  NJ: "New Jersey",
  NY: "New York",
  OH: "Ohio",
  OK: "Oklahoma",
  PA: "Pennsylvania",
  SC: "South Carolina",
  TX: "Texas",
  UT: "Utah",
  VA: "Virginia",
  WA: "Washington",
  WI: "Wisconsin",
  WV: "West Virginia"
});

const CANADIAN_PROVINCES = Object.freeze({
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon"
});

const COUNTRY_CODE_MAP = Object.freeze({
  USA: "US",
  US: "US",
  CAN: "CA",
  CA: "CA",
  MEX: "MX",
  MX: "MX",
  ENG: "GB",
  SCO: "GB",
  NIR: "GB",
  GBR: "GB",
  UK: "GB",
  BAH: "BS",
  JPN: "JP",
  MAS: "MY",
  MYS: "MY",
  CHN: "CN",
  KOR: "KR",
  DOM: "DO",
  PUR: "PR",
  BER: "BM",
  BMU: "BM"
});

const COURSE_GEOCODE_OVERRIDES = Object.freeze({
  "cordevalle-gc-san-martin-ca": { geocodeName: "Morgan Hill", city: "Morgan Hill", region: "CA", countryCode: "US" },
  "sea-island-golf-club-seaside-course-st-simons-island-ga": { geocodeName: "Saint Simons Island", city: "Saint Simons Island", region: "GA", countryCode: "US" },
  "merion-gc-ardome-pa": { geocodeName: "Ardmore", city: "Ardmore", region: "PA", countryCode: "US" },
  "muirfield-muirfield-sco": { geocodeName: "Gullane", city: "Gullane", region: "Scotland", countryCode: "GB" },
  "st-andrews-gc-old-course-fife-sco": { geocodeName: "St Andrews", city: "St Andrews", region: "Scotland", countryCode: "GB" },
  "albany-new-providence-bah": { geocodeName: "Nassau", city: "Nassau", region: "New Providence", countryCode: "BS" },
  "albany-gc-albany-bah": { geocodeName: "Nassau", city: "Nassau", region: "New Providence", countryCode: "BS" },
  "rtj-trail-grand-national-auburn-opelika-al": { geocodeName: "Opelika", city: "Opelika", region: "AL", countryCode: "US" },
  "nine-bridges-jeju-island-kor": { geocodeName: "Jeju", city: "Jeju", region: "Jeju-do", countryCode: "KR" },
  "port-royal-golf-course-southampton-ber": { geocodeName: "Hamilton", city: "Hamilton", region: "Hamilton", countryCode: "BM" },
  "pinehurst-resort-country-club-course-no-2-village-of-pinehurst-nc": { geocodeName: "Pinehurst", city: "Pinehurst", region: "NC", countryCode: "US" }
});

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
    eventIds: [],
    provider: DEFAULT_PROVIDER,
    status: "ok",
    rawDir: path.join("data", "golf-lab", "raw", "open-meteo"),
    refresh: false,
    refreshRaw: false,
    offline: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--out") args.outputDir = argv[index += 1];
    else if (token === "--raw-dir") args.rawDir = argv[index += 1];
    else if (token === "--provider") args.provider = argv[index += 1];
    else if (token === "--fetched-at") args.fetchedAt = argv[index += 1];
    else if (token === "--event-id") args.eventIds.push(argv[index += 1]);
    else if (token === "--season-min") args.seasonMin = Number(argv[index += 1]);
    else if (token === "--season-max") args.seasonMax = Number(argv[index += 1]);
    else if (token === "--limit") args.limit = Number(argv[index += 1]);
    else if (token === "--refresh") args.refresh = true;
    else if (token === "--refresh-raw") args.refreshRaw = true;
    else if (token === "--offline") args.offline = true;
    else if (token === "--status") args.status = argv[index += 1];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!Number.isFinite(args.limit)) delete args.limit;
  if (!Number.isFinite(args.seasonMin)) delete args.seasonMin;
  if (!Number.isFinite(args.seasonMax)) delete args.seasonMax;
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-open-meteo-weather.js --out <warehouse-folder> [options]",
    "",
    "Options:",
    "  --raw-dir <folder>         Folder for saved Open-Meteo raw JSON. Defaults to data/golf-lab/raw/open-meteo.",
    "  --event-id <id>            Backfill one event. Repeatable.",
    "  --season-min <year>        First season to include.",
    "  --season-max <year>        Last season to include.",
    "  --limit <number>           Maximum new events to backfill.",
    "  --offline                  Only use existing raw files; do not call APIs.",
    "  --refresh                  Re-fetch even when raw/weather rows already exist.",
    "  --refresh-raw              Re-fetch raw API files for selected events without selecting events that already have weather.",
    "  --fetched-at <iso>         Source fetch timestamp. Defaults to now.",
    "  --provider <name>          Provider label. Defaults to Open-Meteo historical weather."
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

function latestDate(a, b) {
  return [cleanString(a), cleanString(b)].filter(Boolean).sort().slice(-1)[0] || "";
}

function dateOnly(value) {
  return cleanString(value).slice(0, 10);
}

function dateValue(value) {
  const clean = dateOnly(value);
  if (!clean) return NaN;
  return new Date(`${clean}T00:00:00Z`).getTime();
}

function addDays(date, days) {
  const value = dateValue(date);
  if (!Number.isFinite(value)) return "";
  const next = new Date(value + days * 86400000);
  return next.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const av = dateValue(a);
  const bv = dateValue(b);
  if (!Number.isFinite(av) || !Number.isFinite(bv)) return NaN;
  return Math.round((av - bv) / 86400000);
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function sum(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((total, value) => total + value, 0) : null;
}

function max(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? Math.max(...valid) : null;
}

function numberText(value, digits = 1) {
  if (!Number.isFinite(value)) return "";
  const factor = 10 ** digits;
  return String(Math.round(value * factor) / factor);
}

function normalizeCountryCode(value) {
  const raw = cleanString(value).toUpperCase().replace(/[^A-Z]/g, "");
  return COUNTRY_CODE_MAP[raw] || (raw.length === 2 ? raw : "");
}

function stateName(value, countryCode) {
  const clean = cleanString(value);
  if (!clean) return "";
  const upper = clean.toUpperCase().replace(/[^A-Z]/g, "");
  if (countryCode === "US") return US_STATES[upper] || clean;
  if (countryCode === "CA") return CANADIAN_PROVINCES[upper] || clean;
  return clean;
}

function inferCountryFromRegion(region) {
  const clean = cleanString(region);
  const upper = clean.toUpperCase().replace(/[^A-Z]/g, "");
  if (US_STATES[upper] || Object.values(US_STATES).some((name) => name.toLowerCase() === clean.toLowerCase())) return "US";
  if (CANADIAN_PROVINCES[upper] || Object.values(CANADIAN_PROVINCES).some((name) => name.toLowerCase() === clean.toLowerCase())) return "CA";
  return "";
}

function parseLocation(location) {
  const parts = cleanString(location).split(",").map((part) => part.trim()).filter(Boolean);
  const city = parts[0] || "";
  const last = parts[parts.length - 1] || "";
  let countryCode = normalizeCountryCode(last);
  let region = "";
  if (countryCode) {
    region = parts.length > 2 ? parts[parts.length - 2] : "";
  } else {
    region = parts.length > 1 ? last : "";
    countryCode = inferCountryFromRegion(region);
  }
  if (!region && countryCode === "CA" && /ontario|quebec|on|qc/i.test(cleanString(location))) {
    region = /quebec|qc/i.test(cleanString(location)) ? "Quebec" : "Ontario";
  }
  return {
    raw: cleanString(location),
    city,
    region,
    regionName: stateName(region, countryCode),
    countryCode,
    geocodeName: city
  };
}

function applyCourseGeocodeOverride(locationParts, course) {
  const courseId = cleanString(course && course.id);
  const override = COURSE_GEOCODE_OVERRIDES[courseId];
  if (!override) return locationParts;
  const countryCode = override.countryCode || locationParts.countryCode;
  return {
    ...locationParts,
    ...override,
    countryCode,
    regionName: stateName(override.region || locationParts.region, countryCode),
    raw: locationParts.raw
  };
}

function geocodeUrl(locationParts) {
  const params = new URLSearchParams({
    name: locationParts.geocodeName,
    count: "10",
    language: "en",
    format: "json"
  });
  if (locationParts.countryCode) params.set("countryCode", locationParts.countryCode);
  return `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`;
}

function normalizeCompare(value) {
  return cleanString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreGeocodeResult(result, locationParts) {
  if (!result || typeof result !== "object") return 0;
  let score = 0;
  const country = cleanString(result.country_code).toUpperCase();
  if (locationParts.countryCode && country === locationParts.countryCode) score += 0.28;
  else if (!locationParts.countryCode) score += 0.08;
  if (normalizeCompare(result.name) === normalizeCompare(locationParts.city)) score += 0.34;
  else if (normalizeCompare(result.name).includes(normalizeCompare(locationParts.city))) score += 0.2;
  const region = normalizeCompare(locationParts.regionName || locationParts.region);
  const adminFields = [result.admin1, result.admin2, result.admin3, result.admin4].map(normalizeCompare).filter(Boolean);
  if (region && adminFields.some((field) => field === region)) score += 0.22;
  else if (region && adminFields.some((field) => field.includes(region) || region.includes(field))) score += 0.12;
  if (result.latitude !== undefined && result.longitude !== undefined) score += 0.08;
  if (result.timezone) score += 0.08;
  return score;
}

function selectGeocodeResult(payload, locationParts) {
  const results = payload && Array.isArray(payload.results) ? payload.results : [];
  if (!results.length) return null;
  return results
    .map((result) => ({ result, score: scoreGeocodeResult(result, locationParts) }))
    .sort((a, b) => b.score - a.score)[0].result;
}

function effectiveWeatherEndDate(event, options = {}) {
  const eventEnd = dateOnly(event.endDate || event.startDate);
  const maxDate = dateOnly(options.maxDate || options.fetchedAt || new Date().toISOString());
  if (!eventEnd) return "";
  if (!maxDate) return eventEnd;
  return dateValue(eventEnd) > dateValue(maxDate) ? maxDate : eventEnd;
}

function archiveUrl(geocode, event, options = {}) {
  const latitude = Number(geocode.latitude);
  const longitude = Number(geocode.longitude);
  const endDate = effectiveWeatherEndDate(event, options);
  const params = new URLSearchParams({
    latitude: Number.isFinite(latitude) ? String(Math.round(latitude * 10000) / 10000) : cleanString(geocode.latitude),
    longitude: Number.isFinite(longitude) ? String(Math.round(longitude * 10000) / 10000) : cleanString(geocode.longitude),
    start_date: dateOnly(event.startDate),
    end_date: endDate,
    hourly: "temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: "auto",
    cell_selection: "land"
  });
  return `https://archive-api.open-meteo.com/v1/archive?${params.toString()}`;
}

function waveForHour(hour) {
  if (hour >= 7 && hour <= 11) return "AM";
  if (hour >= 12 && hour <= 18) return "PM";
  return "";
}

function hourlyRows(payload) {
  const hourly = payload && payload.hourly && typeof payload.hourly === "object" ? payload.hourly : {};
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  return times.map((time, index) => ({
    time: cleanString(time),
    date: dateOnly(time),
    hour: Number(cleanString(time).slice(11, 13)),
    temperatureF: numeric(Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m[index] : null),
    precipitationIn: numeric(Array.isArray(hourly.precipitation) ? hourly.precipitation[index] : null),
    windMph: numeric(Array.isArray(hourly.wind_speed_10m) ? hourly.wind_speed_10m[index] : null),
    gustMph: numeric(Array.isArray(hourly.wind_gusts_10m) ? hourly.wind_gusts_10m[index] : null)
  })).filter((row) => row.date && Number.isFinite(row.hour));
}

function summarizeWeatherRows(rows) {
  return {
    temperatureF: average(rows.map((row) => row.temperatureF)),
    windMph: average(rows.map((row) => row.windMph)),
    gustMph: max(rows.map((row) => row.gustMph)),
    precipitationIn: sum(rows.map((row) => row.precipitationIn))
  };
}

function eventDates(event, options = {}) {
  const startDate = dateOnly(event.startDate);
  const endDate = effectiveWeatherEndDate(event, options);
  if (!startDate || !endDate) return [];
  const length = Math.max(0, daysBetween(endDate, startDate));
  return Array.from({ length: length + 1 }, (_, index) => addDays(startDate, index)).filter(Boolean);
}

function buildWeatherSnapshots(event, course, payload, geocode, options = {}) {
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  const provider = cleanString(options.provider || DEFAULT_PROVIDER);
  const sourceUrl = cleanString(options.sourceUrl) || archiveUrl(geocode, event, options);
  const rows = hourlyRows(payload);
  const snapshots = [];
  eventDates(event, options).forEach((date) => {
    const dayRows = rows.filter((row) => row.date === date);
    if (!dayRows.length) return;
    const roundNumber = String(daysBetween(date, event.startDate) + 1);
    ["AM", "PM"].forEach((wave) => {
      let waveRows = dayRows.filter((row) => waveForHour(row.hour) === wave);
      if (!waveRows.length && wave === "AM") waveRows = dayRows.filter((row) => row.hour >= 6 && row.hour <= 12);
      if (!waveRows.length && wave === "PM") waveRows = dayRows.filter((row) => row.hour >= 12 && row.hour <= 19);
      if (!waveRows.length) return;
      const summary = summarizeWeatherRows(waveRows);
      snapshots.push({
        id: slug([event.id, course.id || event.courseId, "weather", date, wave, "open-meteo"].join(" ")),
        eventId: event.id,
        courseId: event.courseId || (course && course.id) || "",
        courseName: event.courseName || (course && course.name) || "",
        roundNumber,
        date,
        observedAt: `${date}T${wave === "AM" ? "09:00:00" : "14:00:00"}`,
        forecastAt: "",
        temperatureF: numberText(summary.temperatureF),
        windMph: numberText(summary.windMph),
        gustMph: numberText(summary.gustMph),
        precipitationIn: numberText(summary.precipitationIn, 2),
        wave,
        sourceProvider: provider,
        sourceUrl,
        sourceUpdatedAt: fetchedAt
      });
    });
  });
  return snapshots;
}

function sourceFetchForEvent(event, course, geocode, rowCount, options = {}) {
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  const provider = cleanString(options.provider || DEFAULT_PROVIDER);
  const sourceUrl = cleanString(options.sourceUrl) || (geocode ? archiveUrl(geocode, event, options) : "");
  const status = cleanString(options.status || "ok");
  return {
    id: slug([provider, event.id, "weather", fetchedAt].join(" ")),
    provider,
    endpoint: `open-meteo-archive/${event.id}`,
    eventId: event.id,
    fetchedAt,
    status,
    rowCount,
    manifestJson: JSON.stringify({
      sourceType: "open-meteo-historical-weather",
      eventId: event.id,
      eventName: event.name,
      courseId: event.courseId || (course && course.id) || "",
      courseName: event.courseName || (course && course.name) || "",
      latitude: geocode ? geocode.latitude : "",
      longitude: geocode ? geocode.longitude : "",
      timezone: geocode ? geocode.timezone : "",
      dateRange: [dateOnly(event.startDate), effectiveWeatherEndDate(event, options)].filter(Boolean).join(" to "),
      granularity: "AM/PM hourly archive aggregation"
    }),
    sourceUrl
  };
}

function sourceFetchForFailure(event, course, reason, options = {}) {
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  const provider = cleanString(options.provider || DEFAULT_PROVIDER);
  return {
    id: slug([provider, event.id, "weather", "failed", fetchedAt].join(" ")),
    provider,
    endpoint: `open-meteo-archive/${event.id}`,
    eventId: event.id,
    fetchedAt,
    status: "error",
    rowCount: 0,
    manifestJson: JSON.stringify({
      sourceType: "open-meteo-historical-weather",
      eventId: event.id,
      courseId: event.courseId || (course && course.id) || "",
      reason: cleanString(reason)
    }),
    sourceUrl: ""
  };
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        "user-agent": "Fairway Ledger Golf Lab weather backfill/1.0"
      }
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          resolve(httpsGet(new URL(response.headers.location, url).toString()));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}: ${body.slice(0, 180)}`));
          return;
        }
        resolve(body);
      });
    }).on("error", reject);
  });
}

async function defaultFetchJson(url) {
  if (typeof fetch === "function") {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "Fairway Ledger Golf Lab weather backfill/1.0"
        }
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 180)}`);
      return JSON.parse(text);
    } catch (error) {
      if (error && /^HTTP \d+/.test(error.message || "")) throw error;
    }
  }
  return JSON.parse(await httpsGet(url));
}

async function readRawJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeRawJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function courseByIdOrName(courses) {
  const byId = new Map();
  const byName = new Map();
  courses.forEach((course) => {
    if (course.id) byId.set(course.id, course);
    if (course.name) byName.set(normalizeCompare(course.name), course);
  });
  return { byId, byName };
}

function findCourse(index, event) {
  return index.byId.get(cleanString(event.courseId)) ||
    index.byName.get(normalizeCompare(event.courseName)) ||
    null;
}

function seasonAllowed(event, options = {}) {
  const season = Number(event.season || dateOnly(event.startDate).slice(0, 4));
  if (Number.isFinite(options.seasonMin) && season < options.seasonMin) return false;
  if (Number.isFinite(options.seasonMax) && season > options.seasonMax) return false;
  return true;
}

function shouldBackfillEvent(event, existingWeatherByEvent, options = {}) {
  if (!event || !event.id || !dateOnly(event.startDate) || !(event.courseId || event.courseName)) return false;
  if (options.eventIds && options.eventIds.length && !options.eventIds.includes(event.id)) return false;
  if (!seasonAllowed(event, options)) return false;
  if (!options.refresh && existingWeatherByEvent.has(event.id)) return false;
  return true;
}

async function loadJsonThroughCache(filePath, url, options = {}) {
  const cached = await readRawJson(filePath);
  if (cached && !options.refresh && !options.refreshRaw) return { payload: cached, fetched: false, url };
  if (options.offline) return { payload: cached, fetched: false, url };
  const payload = await options.fetchJson(url);
  await writeRawJson(filePath, payload);
  return { payload, fetched: true, url };
}

async function backfillEventWeather(event, course, rawDir, options = {}) {
  const provider = cleanString(options.provider || DEFAULT_PROVIDER);
  const courseKey = slug(course && course.id ? course.id : event.courseId || event.courseName || event.id);
  const eventKey = slug(event.id);
  const locationParts = applyCourseGeocodeOverride(parseLocation(course && course.location ? course.location : ""), course);
  if (!locationParts.city) {
    return {
      weatherSnapshots: [],
      sourceFetches: [sourceFetchForFailure(event, course, "Missing course location for geocoding.", { ...options, provider })],
      skipped: "missing-location"
    };
  }

  const geocodeSourceUrl = geocodeUrl(locationParts);
  const geocodeFile = path.join(rawDir, `open-meteo-geocode-${courseKey}.json`);
  const geocodeLoad = await loadJsonThroughCache(geocodeFile, geocodeSourceUrl, options);
  const geocode = selectGeocodeResult(geocodeLoad.payload, locationParts);
  if (!geocode) {
    return {
      weatherSnapshots: [],
      sourceFetches: [sourceFetchForFailure(event, course, `No geocode match for ${locationParts.raw}.`, { ...options, provider })],
      skipped: "missing-geocode"
    };
  }

  const sourceUrl = archiveUrl(geocode, event, options);
  const archiveFile = path.join(rawDir, `open-meteo-archive-${eventKey}.json`);
  const archiveLoad = await loadJsonThroughCache(archiveFile, sourceUrl, options);
  if (!archiveLoad.payload) {
    return {
      weatherSnapshots: [],
      sourceFetches: [sourceFetchForFailure(event, course, "Archive raw file missing in offline mode.", { ...options, provider })],
      skipped: "missing-archive"
    };
  }

  const weatherSnapshots = buildWeatherSnapshots(event, course, archiveLoad.payload, geocode, {
    ...options,
    provider,
    sourceUrl
  });
  const sourceFetches = [sourceFetchForEvent(event, course, geocode, weatherSnapshots.length, {
    ...options,
    provider,
    sourceUrl
  })];
  return {
    weatherSnapshots,
    sourceFetches,
    rawFiles: [geocodeFile, archiveFile],
    fetched: {
      geocode: geocodeLoad.fetched,
      archive: archiveLoad.fetched
    }
  };
}

async function loadExistingWarehouse(outputDir) {
  return {
    events: await readCollection(outputDir, "events"),
    courses: await readCollection(outputDir, "courses"),
    weatherSnapshots: await readCollection(outputDir, "weatherSnapshots"),
    sourceFetches: await readCollection(outputDir, "sourceFetches")
  };
}

async function backfillOpenMeteoWeather(outputDir, options = {}) {
  const resolvedOutput = path.resolve(outputDir);
  const rawDir = path.resolve(options.rawDir || path.join("data", "golf-lab", "raw", "open-meteo"));
  const fetchedAt = cleanString(options.fetchedAt) || new Date().toISOString();
  const fetchJson = options.fetchJson || defaultFetchJson;
  const provider = cleanString(options.provider || DEFAULT_PROVIDER);
  const existing = await loadExistingWarehouse(resolvedOutput);
  const courseIndex = courseByIdOrName(existing.courses || []);
  const existingWeatherByEvent = new Set((existing.weatherSnapshots || []).map((row) => row.eventId).filter(Boolean));
  let selectedEvents = (existing.events || []).filter((event) => shouldBackfillEvent(event, existingWeatherByEvent, options));
  selectedEvents = selectedEvents.sort((a, b) =>
    cleanString(a.startDate).localeCompare(cleanString(b.startDate)) ||
    cleanString(a.name).localeCompare(cleanString(b.name))
  );
  if (Number.isFinite(options.limit)) selectedEvents = selectedEvents.slice(0, Math.max(0, options.limit));

  await fs.mkdir(rawDir, { recursive: true });
  const incomingWeather = [];
  const incomingSources = [];
  const skipped = [];
  const fetchedCounts = { geocode: 0, archive: 0 };

  for (const event of selectedEvents) {
    const course = findCourse(courseIndex, event);
    try {
      const result = await backfillEventWeather(event, course, rawDir, {
        ...options,
        fetchedAt,
        provider,
        fetchJson
      });
      incomingWeather.push(...(result.weatherSnapshots || []));
      incomingSources.push(...(result.sourceFetches || []));
      if (result.skipped) skipped.push({ eventId: event.id, reason: result.skipped });
      if (result.fetched && result.fetched.geocode) fetchedCounts.geocode += 1;
      if (result.fetched && result.fetched.archive) fetchedCounts.archive += 1;
    } catch (error) {
      incomingSources.push(sourceFetchForFailure(event, course, error.message, { fetchedAt, provider }));
      skipped.push({ eventId: event.id, reason: error.message });
    }
  }

  const weatherSnapshots = upsertRows(existing.weatherSnapshots || [], incomingWeather)
    .sort((a, b) =>
      cleanString(a.eventId).localeCompare(cleanString(b.eventId)) ||
      cleanString(a.roundNumber).localeCompare(cleanString(b.roundNumber)) ||
      cleanString(a.wave).localeCompare(cleanString(b.wave))
    );
  const successfulEvents = new Set(incomingSources
    .filter((row) => cleanString(row.status) !== "error" && Number(row.rowCount) > 0)
    .map((row) => cleanString(row.eventId))
    .filter(Boolean));
  const touchedEvents = new Set(incomingSources
    .map((row) => cleanString(row.eventId))
    .filter(Boolean));
  const sourceBase = (existing.sourceFetches || []).filter((row) =>
    !((successfulEvents.has(cleanString(row.eventId)) || touchedEvents.has(cleanString(row.eventId))) &&
      cleanString(row.provider) === provider &&
      cleanString(row.status) === "error")
  );
  const sourceFetches = upsertRows(sourceBase, incomingSources);
  await writeCollection(resolvedOutput, "weatherSnapshots", weatherSnapshots);
  await writeCollection(resolvedOutput, "sourceFetches", sourceFetches);

  return {
    outputDir: resolvedOutput,
    rawDir,
    summary: {
      consideredEvents: (existing.events || []).length,
      selectedEvents: selectedEvents.length,
      newWeatherSnapshots: incomingWeather.length,
      totalWeatherSnapshots: weatherSnapshots.length,
      sourceFetches: incomingSources.length,
      skipped: skipped.length,
      geocodeFetches: fetchedCounts.geocode,
      archiveFetches: fetchedCounts.archive,
      provider,
      fetchedAt,
      skippedRows: skipped.slice(0, 20)
    }
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.outputDir) throw new Error(`${usage()}\n\nMissing --out.`);
  const result = await backfillOpenMeteoWeather(args.outputDir, args);
  console.log(`Golf Lab Open-Meteo weather backfill written: ${result.outputDir}`);
  console.log(`${result.summary.newWeatherSnapshots} weather snapshots | ${result.summary.selectedEvents} events | ${result.summary.skipped} skipped`);
  console.log(`${result.summary.geocodeFetches} geocode fetches | ${result.summary.archiveFetches} archive fetches | raw ${result.rawDir}`);
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
  parseLocation,
  geocodeUrl,
  archiveUrl,
  selectGeocodeResult,
  scoreGeocodeResult,
  buildWeatherSnapshots,
  backfillOpenMeteoWeather,
  usage
};
