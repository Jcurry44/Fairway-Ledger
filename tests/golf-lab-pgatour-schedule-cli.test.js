/*
 * Unit tests for scripts/golf-lab-pgatour-schedule.js - public PGA TOUR schedule enrichment.
 *
 * Run: node --test tests/golf-lab-pgatour-schedule-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const {
  parseArgs,
  parseDisplayDate,
  scheduleFromPayload,
  tournamentRecords,
  matchTournamentsToEvents,
  enrichPgaTourSchedule
} = require("../scripts/golf-lab-pgatour-schedule.js");

function sampleSchedule() {
  return {
    tourCode: "R",
    season: 2026,
    tournaments: [
      {
        tournamentId: "R2026006",
        name: "Sony Open in Hawaii",
        year: "2026",
        displayDate: "Jan 15 - 18",
        status: "COMPLETED",
        courseData: {
          name: "Waialae Country Club",
          city: "Honolulu",
          stateCode: "HI",
          country: "United States of America",
          countryCode: "USA"
        }
      },
      {
        tournamentId: "R2026026",
        name: "U.S. Open",
        year: "2026",
        displayDate: "Jun 18 - 21",
        status: "IN_PROGRESS",
        courseData: {
          name: "Shinnecock Hills Golf Club",
          city: "Southampton",
          stateCode: "NY",
          country: "United States of America",
          countryCode: "USA"
        }
      }
    ]
  };
}

test("parseArgs: reads schedule enrichment options", () => {
  const args = parseArgs([
    "--in", "schedule-2026.html",
    "--batch", "raw/pgatour",
    "--out", "warehouse",
    "--provider", "PGA TOUR schedule",
    "--source-url", "https://www.pgatour.com/schedule/2026",
    "--fetched-at", "2026-06-19T22:00:00Z",
    "--min-match-score", "0.7"
  ]);

  assert.deepEqual(args.inputFiles, ["schedule-2026.html"]);
  assert.equal(args.batchDir, "raw/pgatour");
  assert.equal(args.outputDir, "warehouse");
  assert.equal(args.provider, "PGA TOUR schedule");
  assert.equal(args.sourceUrl, "https://www.pgatour.com/schedule/2026");
  assert.equal(args.fetchedAt, "2026-06-19T22:00:00Z");
  assert.equal(args.minMatchScore, 0.7);
});

test("parseDisplayDate: handles same-month and cross-month ranges", () => {
  assert.deepEqual(parseDisplayDate("Jan 15 - 18", "2026"), {
    startDate: "2026-01-15",
    endDate: "2026-01-18"
  });
  assert.deepEqual(parseDisplayDate("May 29 - Jun 1", "2026"), {
    startDate: "2026-05-29",
    endDate: "2026-06-01"
  });
});

test("scheduleFromPayload and tournamentRecords: extract official course metadata", () => {
  const payload = {
    props: {
      pageProps: {
        dehydratedState: {
          queries: [{
            queryKey: ["schedule", { tourCode: "R", season: "2026" }],
            state: { data: sampleSchedule() }
          }]
        }
      }
    }
  };
  const schedules = scheduleFromPayload(payload);
  const records = tournamentRecords(schedules, {
    sourceUrl: "https://www.pgatour.com/schedule/2026"
  });

  assert.equal(schedules.length, 1);
  assert.equal(records.length, 2);
  assert.equal(records[0].courseId, "waialae-country-club-honolulu-hi");
  assert.equal(records[0].location, "Honolulu, HI, USA");
  assert.equal(records[1].courseName, "Shinnecock Hills Golf Club");
});

test("matchTournamentsToEvents: matches by date plus tournament name", () => {
  const tournaments = tournamentRecords([sampleSchedule()]);
  const events = [
    {
      id: "2026-sony-open-in-hawaii-401",
      name: "Sony Open in Hawaii",
      season: "2026",
      startDate: "2026-01-15",
      endDate: "2026-01-18"
    },
    {
      id: "2026-us-open-402",
      name: "U.S. Open",
      season: "2026",
      startDate: "2026-06-18",
      endDate: "2026-06-21"
    }
  ];
  const result = matchTournamentsToEvents(tournaments, events);

  assert.equal(result.matches.length, 2);
  assert.equal(result.unmatched.length, 0);
  assert.equal(result.matches[0].event.id, "2026-sony-open-in-hawaii-401");
  assert.equal(result.matches[1].tournament.courseName, "Shinnecock Hills Golf Club");
});

test("enrichPgaTourSchedule: updates events, rounds, courses, setups, and source proof", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-pgatour-schedule-"));
  try {
    const scheduleFile = path.join(tempRoot, "schedule-2026.json");
    await fsp.writeFile(scheduleFile, JSON.stringify(sampleSchedule()), "utf8");
    await fsp.writeFile(path.join(tempRoot, "events.csv"), [
      "id,name,tour,season,startDate,endDate,courseId,courseName,fieldStrength,status,sourceProvider,sourceUrl,sourceUpdatedAt",
      "2026-sony-open-in-hawaii-401,Sony Open in Hawaii,PGA TOUR,2026,2026-01-15,2026-01-18,,,Final,ESPN,https://example.com/scoreboard,2026-06-19T12:00:00Z",
      "2026-us-open-402,U.S. Open,PGA TOUR,2026,2026-06-18,2026-06-21,,,Final,ESPN,https://example.com/scoreboard,2026-06-19T12:00:00Z"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(tempRoot, "rounds.csv"), [
      "id,playerId,playerName,eventId,courseId,courseName,roundNumber,date,score,toPar,adjustedToPar,sgTotal,difficultyBucket,sourceProvider,sourceUrl,sourceUpdatedAt",
      "sony-alpha-r1,alpha,Alpha,2026-sony-open-in-hawaii-401,,,1,2026-01-15,68,-2,-1.5,1.5,Easy,ESPN + Golf Lab derived scoring model,https://example.com/scoreboard,2026-06-19T12:00:00Z",
      "us-open-alpha-r1,alpha,Alpha,2026-us-open-402,,,1,2026-06-18,73,3,2,-2,Tough,ESPN + Golf Lab derived scoring model,https://example.com/scoreboard,2026-06-19T12:00:00Z"
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(tempRoot, "courses.csv"), "id,name,location,par,yards,rating,slope,fieldAdjustedToPar,sgDifficulty,style,sourceProvider,sourceUrl,sourceUpdatedAt\n", "utf8");
    await fsp.writeFile(path.join(tempRoot, "course_setups.csv"), "id,eventId,courseId,par,yards,rough,greenSpeed,firmness,weatherNote,fieldAdjustedToPar,sgDifficulty,sourceProvider,sourceUrl,sourceUpdatedAt\n", "utf8");
    await fsp.writeFile(path.join(tempRoot, "source_fetches.csv"), "id,provider,endpoint,eventId,modelRunId,modelVersion,modelProfile,modelWeatherScenario,modelWeatherLabel,fetchedAt,status,rowCount,manifestJson,sourceUrl\n", "utf8");

    const result = await enrichPgaTourSchedule([scheduleFile], tempRoot, {
      sourceUrl: "https://www.pgatour.com/schedule/2026",
      fetchedAt: "2026-06-19T22:00:00Z"
    });

    const events = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "events.csv"), "utf8"));
    const rounds = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "rounds.csv"), "utf8"));
    const courses = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "courses.csv"), "utf8"));
    const setups = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "course_setups.csv"), "utf8"));
    const sources = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "source_fetches.csv"), "utf8"));

    assert.equal(result.summary.matches, 2);
    assert.equal(result.summary.roundsUpdated, 2);
    assert.equal(events.find((row) => row.id === "2026-us-open-402").courseName, "Shinnecock Hills Golf Club");
    assert.equal(rounds.find((row) => row.id === "sony-alpha-r1").courseId, "waialae-country-club-honolulu-hi");
    assert.equal(courses.length, 2);
    assert.equal(setups.length, 2);
    assert.equal(setups.find((row) => row.eventId === "2026-us-open-402").fieldAdjustedToPar, "2");
    assert.equal(sources[0].endpoint, "pgatour-schedule/2026");
    assert.match(sources[0].manifestJson, /matchedEvents/);
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
