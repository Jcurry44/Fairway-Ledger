/*
 * Unit tests for scripts/golf-lab-open-meteo-weather.js - Open-Meteo historical weather backfill.
 *
 * Run: node --test tests/golf-lab-open-meteo-weather-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const {
  parseArgs,
  parseLocation,
  geocodeUrl,
  archiveUrl,
  selectGeocodeResult,
  buildWeatherSnapshots,
  backfillOpenMeteoWeather
} = require("../scripts/golf-lab-open-meteo-weather.js");

function sampleGeocodePayload() {
  return {
    results: [
      {
        name: "Honolulu",
        latitude: 21.30455,
        longitude: -157.85568,
        country_code: "US",
        admin1: "Hawaii",
        timezone: "Pacific/Honolulu"
      },
      {
        name: "Honolulu County",
        latitude: 21.45,
        longitude: -158,
        country_code: "US",
        admin1: "Hawaii",
        timezone: "Pacific/Honolulu"
      }
    ]
  };
}

function sampleArchivePayload() {
  const times = [];
  const temp = [];
  const precip = [];
  const wind = [];
  const gust = [];
  ["2026-01-15", "2026-01-16"].forEach((date, dayIndex) => {
    for (let hour = 0; hour < 24; hour += 1) {
      times.push(`${date}T${String(hour).padStart(2, "0")}:00`);
      temp.push(70 + dayIndex + (hour >= 12 ? 4 : 0));
      precip.push(hour === 14 && dayIndex === 1 ? 0.08 : 0);
      wind.push(hour >= 12 ? 16 + dayIndex : 9 + dayIndex);
      gust.push(hour >= 12 ? 24 + dayIndex : 15 + dayIndex);
    }
  });
  return {
    latitude: 21.30455,
    longitude: -157.85568,
    timezone: "Pacific/Honolulu",
    hourly: {
      time: times,
      temperature_2m: temp,
      precipitation: precip,
      wind_speed_10m: wind,
      wind_gusts_10m: gust
    }
  };
}

test("parseArgs: reads Open-Meteo weather backfill options", () => {
  const args = parseArgs([
    "--out", "warehouse",
    "--raw-dir", "raw/open-meteo",
    "--event-id", "sony-2026",
    "--event-id", "us-open-2026",
    "--season-min", "2012",
    "--season-max", "2026",
    "--limit", "25",
    "--provider", "Open-Meteo",
    "--fetched-at", "2026-06-19T23:00:00Z",
    "--refresh",
    "--refresh-raw",
    "--offline"
  ]);

  assert.equal(args.outputDir, "warehouse");
  assert.equal(args.rawDir, "raw/open-meteo");
  assert.deepEqual(args.eventIds, ["sony-2026", "us-open-2026"]);
  assert.equal(args.seasonMin, 2012);
  assert.equal(args.seasonMax, 2026);
  assert.equal(args.limit, 25);
  assert.equal(args.provider, "Open-Meteo");
  assert.equal(args.fetchedAt, "2026-06-19T23:00:00Z");
  assert.equal(args.refresh, true);
  assert.equal(args.refreshRaw, true);
  assert.equal(args.offline, true);
});

test("parseLocation and geocodeUrl: normalize PGA TOUR schedule locations", () => {
  const hawaii = parseLocation("Kapalua, Maui, HI, USA");
  assert.equal(hawaii.city, "Kapalua");
  assert.equal(hawaii.region, "HI");
  assert.equal(hawaii.regionName, "Hawaii");
  assert.equal(hawaii.countryCode, "US");
  assert.ok(geocodeUrl(hawaii).includes("countryCode=US"));

  const oakville = parseLocation("Oakville,Ontario");
  assert.equal(oakville.city, "Oakville");
  assert.equal(oakville.regionName, "Ontario");
  assert.equal(oakville.countryCode, "CA");
});

test("selectGeocodeResult: prefers exact city/state match", () => {
  const location = parseLocation("Honolulu, HI, USA");
  const result = selectGeocodeResult(sampleGeocodePayload(), location);

  assert.equal(result.name, "Honolulu");
  assert.equal(result.admin1, "Hawaii");
  assert.equal(result.timezone, "Pacific/Honolulu");
});

test("buildWeatherSnapshots: creates AM and PM tournament-day rows", () => {
  const event = {
    id: "2026-sony-open-in-hawaii-401",
    name: "Sony Open in Hawaii",
    startDate: "2026-01-15",
    endDate: "2026-01-16",
    courseId: "waialae-country-club-honolulu-hi",
    courseName: "Waialae Country Club"
  };
  const course = {
    id: "waialae-country-club-honolulu-hi",
    name: "Waialae Country Club"
  };
  const geocode = sampleGeocodePayload().results[0];
  const snapshots = buildWeatherSnapshots(event, course, sampleArchivePayload(), geocode, {
    fetchedAt: "2026-06-19T23:00:00Z"
  });

  assert.equal(snapshots.length, 4);
  assert.equal(snapshots[0].roundNumber, "1");
  assert.equal(snapshots[0].wave, "AM");
  assert.equal(snapshots[0].windMph, "9");
  assert.equal(snapshots[1].wave, "PM");
  assert.equal(snapshots[1].windMph, "16");
  assert.equal(snapshots[3].precipitationIn, "0.08");
  assert.equal(snapshots[0].sourceProvider, "Open-Meteo historical weather");
});

test("backfillOpenMeteoWeather: writes weather snapshots and source proof", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-open-meteo-"));
  const rawDir = path.join(tempRoot, "raw");
  try {
    await fsp.writeFile(path.join(tempRoot, "events.csv"), [
      "id,name,tour,season,startDate,endDate,courseId,courseName,fieldStrength,status,sourceProvider,sourceUrl,sourceUpdatedAt",
      "2026-sony-open-in-hawaii-401,Sony Open in Hawaii,PGA TOUR,2026,2026-01-15,2026-01-16,waialae-country-club-honolulu-hi,Waialae Country Club,,Final,ESPN,https://example.com,2026-06-19T12:00:00Z"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(tempRoot, "courses.csv"), [
      "id,name,location,par,yards,rating,slope,fieldAdjustedToPar,sgDifficulty,style,sourceProvider,sourceUrl,sourceUpdatedAt",
      "waialae-country-club-honolulu-hi,Waialae Country Club,\"Honolulu, HI, USA\",,,,,0,0,,PGA TOUR public schedule,https://www.pgatour.com/schedule/2026,2026-06-19T18:55:00-04:00"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(tempRoot, "weather_snapshots.csv"), "id,eventId,courseId,courseName,roundNumber,date,observedAt,forecastAt,temperatureF,windMph,gustMph,precipitationIn,wave,sourceProvider,sourceUrl,sourceUpdatedAt\n", "utf8");
    await fsp.writeFile(path.join(tempRoot, "source_fetches.csv"), "id,provider,endpoint,eventId,modelRunId,modelVersion,modelProfile,modelWeatherScenario,modelWeatherLabel,fetchedAt,status,rowCount,manifestJson,sourceUrl\n", "utf8");

    const fetchJson = async (url) => {
      if (url.includes("geocoding-api.open-meteo.com")) return sampleGeocodePayload();
      if (url.includes("archive-api.open-meteo.com")) return sampleArchivePayload();
      throw new Error(`Unexpected URL ${url}`);
    };
    const result = await backfillOpenMeteoWeather(tempRoot, {
      rawDir,
      fetchedAt: "2026-06-19T23:00:00Z",
      fetchJson
    });

    const weather = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "weather_snapshots.csv"), "utf8"));
    const sources = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "source_fetches.csv"), "utf8"));
    const rawFiles = await fsp.readdir(rawDir);

    assert.equal(result.summary.selectedEvents, 1);
    assert.equal(result.summary.newWeatherSnapshots, 4);
    assert.equal(result.summary.geocodeFetches, 1);
    assert.equal(result.summary.archiveFetches, 1);
    assert.equal(weather.length, 4);
    assert.equal(weather[0].eventId, "2026-sony-open-in-hawaii-401");
    assert.equal(weather[0].sourceProvider, "Open-Meteo historical weather");
    assert.equal(sources.length, 1);
    assert.equal(sources[0].endpoint, "open-meteo-archive/2026-sony-open-in-hawaii-401");
    assert.match(sources[0].manifestJson, /AM\/PM hourly archive aggregation/);
    assert.equal(rawFiles.some((file) => file.startsWith("open-meteo-geocode-")), true);
    assert.equal(rawFiles.some((file) => file.startsWith("open-meteo-archive-")), true);
    assert.ok(archiveUrl(sampleGeocodePayload().results[0], {
      startDate: "2026-01-15",
      endDate: "2026-01-16"
    }).includes("temperature_unit=fahrenheit"));
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
