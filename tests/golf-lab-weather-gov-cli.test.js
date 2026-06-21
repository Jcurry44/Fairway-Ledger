/*
 * Unit tests for scripts/golf-lab-weather-gov.js - weather.gov hourly forecast adapter.
 *
 * Run:  node --test tests/golf-lab-weather-gov-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const {
  parseArgs,
  buildRows,
  adaptWeatherGovForecast
} = require("../scripts/golf-lab-weather-gov.js");

const sampleForecast = {
  type: "Feature",
  properties: {
    generatedAt: "2026-06-19T17:20:13+00:00",
    updateTime: "2026-06-19T13:36:19+00:00",
    periods: [
      {
        number: 1,
        startTime: "2026-06-19T08:00:00-04:00",
        endTime: "2026-06-19T09:00:00-04:00",
        temperature: 72,
        temperatureUnit: "F",
        probabilityOfPrecipitation: { value: 0 },
        windSpeed: "12 to 18 mph",
        windGust: "24 mph"
      },
      {
        number: 2,
        startTime: "2026-06-19T13:00:00-04:00",
        endTime: "2026-06-19T14:00:00-04:00",
        temperature: 77,
        temperatureUnit: "F",
        probabilityOfPrecipitation: { value: 20 },
        windSpeed: "14 mph"
      },
      {
        number: 3,
        startTime: "2026-06-22T08:00:00-04:00",
        endTime: "2026-06-22T09:00:00-04:00",
        temperature: 69,
        temperatureUnit: "F",
        probabilityOfPrecipitation: { value: 0 },
        windSpeed: "5 mph"
      }
    ]
  }
};

test("parseArgs: reads weather.gov forecast adapter options", () => {
  const args = parseArgs([
    "--in", "hourly.json",
    "--out", "adapted",
    "--event-id", "us-open-2026",
    "--course-id", "shinnecock-hills",
    "--course-name", "Shinnecock Hills Golf Club",
    "--source-url", "https://api.weather.gov/gridpoints/OKX/85,59/forecast/hourly",
    "--fetched-at", "2026-06-19T13:30:00-04:00",
    "--start-date", "2026-06-19",
    "--end-date", "2026-06-21",
    "--event-start-date", "2026-06-18"
  ]);

  assert.equal(args.inputFile, "hourly.json");
  assert.equal(args.outputDir, "adapted");
  assert.equal(args.eventId, "us-open-2026");
  assert.equal(args.courseId, "shinnecock-hills");
  assert.equal(args.courseName, "Shinnecock Hills Golf Club");
  assert.equal(args.sourceUrl, "https://api.weather.gov/gridpoints/OKX/85,59/forecast/hourly");
  assert.equal(args.fetchedAt, "2026-06-19T13:30:00-04:00");
  assert.equal(args.startDate, "2026-06-19");
  assert.equal(args.endDate, "2026-06-21");
  assert.equal(args.eventStartDate, "2026-06-18");
});

test("buildRows: filters tournament dates and maps hourly forecast fields", () => {
  const result = buildRows(sampleForecast, {
    eventId: "us-open-2026",
    courseId: "shinnecock-hills",
    courseName: "Shinnecock Hills Golf Club",
    sourceUrl: "https://api.weather.gov/gridpoints/OKX/85,59/forecast/hourly",
    fetchedAt: "2026-06-19T13:30:00-04:00",
    startDate: "2026-06-19",
    endDate: "2026-06-21",
    eventStartDate: "2026-06-18"
  });

  assert.equal(result.summary.periods, 3);
  assert.equal(result.summary.weatherSnapshots, 2);
  assert.equal(result.tables.weatherSnapshots.length, 2);
  assert.equal(result.tables.sourceFetches[0].rowCount, 2);

  const morning = result.tables.weatherSnapshots[0];
  assert.equal(morning.eventId, "us-open-2026");
  assert.equal(morning.courseId, "shinnecock-hills");
  assert.equal(morning.roundNumber, "2");
  assert.equal(morning.date, "2026-06-19");
  assert.equal(morning.forecastAt, "2026-06-19T17:20:13+00:00");
  assert.equal(morning.temperatureF, "72");
  assert.equal(morning.windMph, "18");
  assert.equal(morning.gustMph, "24");
  assert.equal(morning.precipitationIn, "0");
  assert.equal(morning.wave, "AM");

  const afternoon = result.tables.weatherSnapshots[1];
  assert.equal(afternoon.precipitationIn, "");
  assert.equal(afternoon.wave, "PM");
});

test("adaptWeatherGovForecast: writes normalized weather and provenance CSVs", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-weather-gov-"));
  const inputFile = path.join(tmp, "hourly.json");
  await fsp.writeFile(inputFile, JSON.stringify(sampleForecast), "utf8");

  const result = await adaptWeatherGovForecast(inputFile, tmp, {
    eventId: "us-open-2026",
    courseId: "shinnecock-hills",
    courseName: "Shinnecock Hills Golf Club",
    sourceUrl: "https://api.weather.gov/gridpoints/OKX/85,59/forecast/hourly",
    fetchedAt: "2026-06-19T13:30:00-04:00",
    startDate: "2026-06-19",
    endDate: "2026-06-21",
    eventStartDate: "2026-06-18"
  });

  assert.equal(result.summary.weatherSnapshots, 2);
  const weather = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tmp, "weather_snapshots.csv"), "utf8"));
  const sources = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tmp, "source_fetches.csv"), "utf8"));
  assert.equal(weather.length, 2);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].provider, "NOAA/NWS hourly forecast");
  assert.equal(sources[0].endpoint, "weather-gov-hourly/OKX/85,59");
});
