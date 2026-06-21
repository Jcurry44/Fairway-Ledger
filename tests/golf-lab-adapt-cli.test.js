/*
 * Unit tests for scripts/golf-lab-adapt.js - source export adapters.
 *
 * Run:  node --test tests/golf-lab-adapt-cli.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const {
  adaptRows,
  adaptRawSourceFile,
  adaptBatchSourceDirectory,
  inferAdapterTypeFromFileName,
  writeAdaptedSource,
  parseArgs
} = require("../scripts/golf-lab-adapt.js");

test("parseArgs: reads source adapter options", () => {
  const args = parseArgs([
    "--type", "leaderboard",
    "--in", "raw.csv",
    "--out", "adapted",
    "--event-id", "event-1",
    "--event-name", "Test Open",
    "--course-id", "course-1",
    "--course-name", "Test Club",
    "--tour", "PGA Tour",
    "--season", "2026",
    "--provider", "Official Leaderboard",
    "--source-url", "https://example.com/source",
    "--fetched-at", "2026-06-18T12:00:00Z",
    "--status", "ok"
  ]);

  assert.equal(args.type, "leaderboard");
  assert.equal(args.inputFile, "raw.csv");
  assert.equal(args.outputDir, "adapted");
  assert.equal(args.eventId, "event-1");
  assert.equal(args.eventName, "Test Open");
  assert.equal(args.courseId, "course-1");
  assert.equal(args.courseName, "Test Club");
  assert.equal(args.tour, "PGA Tour");
  assert.equal(args.season, "2026");
  assert.equal(args.provider, "Official Leaderboard");
  assert.equal(args.sourceUrl, "https://example.com/source");
  assert.equal(args.fetchedAt, "2026-06-18T12:00:00Z");
  assert.equal(args.status, "ok");
});

test("parseArgs and inferAdapterTypeFromFileName: support one-pass batch ingest", () => {
  const args = parseArgs([
    "--batch", "downloads/us-open-raw",
    "--out", "data/golf-lab/us-open",
    "--event-id", "us-open-2026"
  ]);

  assert.equal(args.batchDir, "downloads/us-open-raw");
  assert.equal(args.outputDir, "data/golf-lab/us-open");
  assert.equal(args.eventId, "us-open-2026");
  assert.equal(inferAdapterTypeFromFileName("player-profiles.csv"), "profile");
  assert.equal(inferAdapterTypeFromFileName("course-setup.csv"), "course");
  assert.equal(inferAdapterTypeFromFileName("leaderboard-r1.csv"), "leaderboard");
  assert.equal(inferAdapterTypeFromFileName("market-odds.csv"), "odds");
  assert.equal(inferAdapterTypeFromFileName("notes.csv"), "");
});

test("adaptRows: maps leaderboard rows into players, rounds, SG, and provenance", () => {
  const adapted = adaptRows("leaderboard", [
    {
      player: "Alpha Player",
      country: "USA",
      round: "1",
      score: "68",
      toPar: "-2",
      sgTotal: "3.1",
      sgOtt: "1.4",
      sgApp: "0.9",
      drivingDistance: "315.2",
      accuracy: "71.4"
    }
  ], {
    eventId: "event-1",
    courseId: "course-1",
    courseName: "Test Club",
    provider: "Official Leaderboard",
    sourceUrl: "https://example.com/leaderboard",
    fetchedAt: "2026-06-18T12:00:00Z"
  });

  assert.equal(adapted.type, "leaderboard");
  assert.equal(adapted.rowCount, 1);
  assert.equal(adapted.tables.players[0].id, "alpha-player");
  assert.equal(adapted.tables.players[0].sourceProvider, "Official Leaderboard");
  assert.equal(adapted.tables.rounds[0].eventId, "event-1");
  assert.equal(adapted.tables.rounds[0].courseName, "Test Club");
  assert.equal(adapted.tables.rounds[0].roundNumber, "1");
  assert.equal(adapted.tables.rounds[0].score, "68");
  assert.equal(adapted.tables.rounds[0].toPar, "-2");
  assert.equal(adapted.tables.strokesGained[0].sgTotal, "3.1");
  assert.equal(adapted.tables.strokesGained[0].sgOtt, "1.4");
  assert.equal(adapted.tables.strokesGained[0].drivingDistance, "315.2");
  assert.equal(adapted.tables.sourceFetches[0].provider, "Official Leaderboard");
  assert.equal(adapted.tables.sourceFetches[0].eventId, "event-1");
  assert.equal(adapted.tables.sourceFetches[0].rowCount, 1);
});

test("adaptRows: maps odds and weather exports into model-ready collections", () => {
  const odds = adaptRows("odds", [
    {
      playerName: "Beta Player",
      market: "winner",
      book: "Book A",
      odds: "+1400",
      impliedProbability: "0.0667",
      capturedAt: "2026-06-18T11:00:00Z"
    }
  ], {
    eventId: "event-1",
    provider: "Book Export",
    sourceUrl: "https://example.com/odds",
    fetchedAt: "2026-06-18T12:00:00Z"
  });
  const weather = adaptRows("weather", [
    {
      courseName: "Test Club",
      round: "2",
      temperature: "72",
      wind: "18",
      gust: "27",
      wave: "AM"
    }
  ], {
    eventId: "event-1",
    courseId: "course-1",
    provider: "Weather Export",
    fetchedAt: "2026-06-18T12:05:00Z"
  });

  assert.equal(odds.tables.players[0].name, "Beta Player");
  assert.equal(odds.tables.oddsSnapshots[0].playerId, "beta-player");
  assert.equal(odds.tables.oddsSnapshots[0].oddsAmerican, "1400");
  assert.equal(odds.tables.oddsSnapshots[0].impliedProbability, "0.0667");
  assert.equal(weather.tables.weatherSnapshots[0].eventId, "event-1");
  assert.equal(weather.tables.weatherSnapshots[0].courseId, "course-1");
  assert.equal(weather.tables.weatherSnapshots[0].roundNumber, "2");
  assert.equal(weather.tables.weatherSnapshots[0].windMph, "18");
  assert.equal(weather.tables.weatherSnapshots[0].wave, "AM");
});

test("adaptRows: maps profile, course, and enrichment exports into scorecard-ready collections", () => {
  const profile = adaptRows("profile", [
    {
      playerName: "Gamma Player",
      country: "England",
      tour: "DP World Tour",
      owgr: "44",
      dataGolfId: "dg-gamma",
      pgaTourId: "12345",
      college: "Test University",
      turnedPro: "2019",
      profileUrl: "https://example.com/gamma"
    }
  ], {
    provider: "Official Profiles",
    sourceUrl: "https://example.com/profiles",
    fetchedAt: "2026-06-18T12:00:00Z"
  });
  const course = adaptRows("course", [
    {
      courseName: "North Course",
      location: "Pittsburgh, PA",
      par: "70",
      yards: "7350",
      rating: "76.2",
      slope: "148",
      style: "parkland",
      rough: "Heavy",
      greenSpeed: "13",
      firmness: "Firm"
    }
  ], {
    eventId: "event-1",
    courseId: "north-course",
    provider: "Tournament Setup",
    sourceUrl: "https://example.com/course",
    fetchedAt: "2026-06-18T12:05:00Z"
  });
  const enrichment = adaptRows("enrichment", [
    {
      playerName: "Gamma Player",
      capturedDate: "2026-04-01",
      driver: "Test Driver",
      irons: "Test Irons",
      putter: "Test Putter",
      ball: "Test Ball",
      accomplishment: "Major champion",
      type: "major",
      eventName: "Test Major",
      season: "2025"
    }
  ], {
    provider: "WITB Export",
    sourceUrl: "https://example.com/witb",
    fetchedAt: "2026-06-18T12:10:00Z"
  });

  assert.equal(profile.tables.players[0].dataGolfId, "dg-gamma");
  assert.equal(profile.tables.players[0].college, "Test University");
  assert.equal(profile.tables.sourceFetches[0].endpoint.includes("profile"), true);
  assert.equal(course.tables.courses[0].id, "north-course");
  assert.equal(course.tables.courses[0].yards, "7350");
  assert.equal(course.tables.courseSetups[0].eventId, "event-1");
  assert.equal(course.tables.courseSetups[0].greenSpeed, "13");
  assert.equal(enrichment.tables.players[0].id, "gamma-player");
  assert.equal(enrichment.tables.equipmentSnapshots[0].driver, "Test Driver");
  assert.equal(enrichment.tables.equipmentSnapshots[0].ball, "Test Ball");
  assert.equal(enrichment.tables.accomplishments[0].label, "Major champion");
  assert.equal(enrichment.tables.accomplishments[0].eventName, "Test Major");
});

test("adaptRawSourceFile and writeAdaptedSource: accept flexible headers and merge collection CSVs", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-adapt-"));
  try {
    const rawFile = path.join(tempRoot, "field-export.csv");
    await fsp.writeFile(
      rawFile,
      [
        "Player Name,Country,OWGR,Tee Time",
        "Alpha Player,USA,8,08:10"
      ].join("\n"),
      "utf8"
    );

    const first = await adaptRawSourceFile(rawFile, {
      type: "field",
      eventId: "event-1",
      provider: "Official Field",
      sourceUrl: "https://example.com/field",
      fetchedAt: "2026-06-18T12:00:00Z"
    });
    const firstWrite = await writeAdaptedSource(tempRoot, first);
    const second = adaptRows("field", [
      {
        playerName: "Alpha Player",
        country: "USA",
        owgr: "7",
        teeTime: "08:20"
      }
    ], {
      eventId: "event-1",
      provider: "Official Field",
      sourceUrl: "https://example.com/field",
      fetchedAt: "2026-06-18T13:00:00Z"
    });
    await writeAdaptedSource(tempRoot, second);

    const players = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "players.csv"), "utf8"));
    const fields = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "fields.csv"), "utf8"));
    const sources = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(tempRoot, "source_fetches.csv"), "utf8"));

    assert.ok(firstWrite.files.some((file) => file.collection === "players"));
    assert.ok(firstWrite.files.some((file) => file.collection === "fields"));
    assert.ok(firstWrite.files.some((file) => file.collection === "sourceFetches"));
    assert.equal(players.length, 1);
    assert.equal(players[0].id, "alpha-player");
    assert.equal(players[0].owgrRank, "7");
    assert.equal(players[0].sourceProvider, "Official Field");
    assert.equal(fields.length, 1);
    assert.equal(fields[0].id, "event-1-alpha-player-field");
    assert.equal(fields[0].teeTime, "08:20");
    assert.equal(sources.length, 2);
    assert.equal(sources[0].provider, "Official Field");
    assert.equal(sources.some((source) => source.endpoint.includes("field-export.csv")), true);
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});

test("adaptBatchSourceDirectory: infers source files and builds a normalized event folder", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "golf-lab-adapt-batch-"));
  try {
    const rawDir = path.join(tempRoot, "raw");
    const outputDir = path.join(tempRoot, "out");
    await fsp.mkdir(rawDir);
    await fsp.writeFile(
      path.join(rawDir, "player-profiles.csv"),
      [
        "Player Name,Country,Tour,OWGR,DataGolf ID,College",
        "Alpha Player,USA,PGA Tour,8,dg-alpha,State U"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(rawDir, "course-setup.csv"),
      [
        "Course Name,Location,Par,Yards,Green Speed,Firmness",
        "Test Club,Pittsburgh PA,70,7350,13,Firm"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(rawDir, "leaderboard-r1.csv"),
      [
        "Player Name,Round,Score,To Par,SG Total,Driving Distance,Accuracy",
        "Alpha Player,1,68,-2,3.1,315.2,71.4"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(
      path.join(rawDir, "market-odds.csv"),
      [
        "Player Name,Market,Book,Odds,Implied Probability,Captured At",
        "Alpha Player,winner,Book A,+1400,0.0667,2026-06-18T11:00:00Z"
      ].join("\n"),
      "utf8"
    );
    await fsp.writeFile(path.join(rawDir, "notes.csv"), "note\nignore me\n", "utf8");

    const result = await adaptBatchSourceDirectory(rawDir, {
      outputDir,
      eventId: "event-1",
      courseId: "course-1",
      courseName: "Test Club",
      provider: "Owned Batch",
      sourceUrl: "https://example.com/export",
      fetchedAt: "2026-06-18T12:00:00Z"
    });

    const players = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "players.csv"), "utf8"));
    const courses = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "courses.csv"), "utf8"));
    const setups = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "course_setups.csv"), "utf8"));
    const rounds = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "rounds.csv"), "utf8"));
    const odds = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "odds_snapshots.csv"), "utf8"));
    const sources = Warehouse.parseGolfLabCsv(await fsp.readFile(path.join(outputDir, "source_fetches.csv"), "utf8"));

    assert.equal(result.totals.files, 4);
    assert.equal(result.totals.rawRows, 4);
    assert.equal(result.totals.skipped, 1);
    assert.deepEqual(result.adapted.map((item) => item.type).sort(), ["course", "leaderboard", "odds", "profile"]);
    assert.equal(result.skipped[0].file, "notes.csv");
    assert.equal(players.length, 1);
    assert.equal(players[0].dataGolfId, "dg-alpha");
    assert.equal(courses[0].name, "Test Club");
    assert.equal(setups[0].eventId, "event-1");
    assert.equal(rounds[0].score, "68");
    assert.equal(odds[0].oddsAmerican, "1400");
    assert.equal(sources.length, 4);
    assert.equal(sources.every((source) => source.provider === "Owned Batch"), true);
    assert.equal(sources.every((source) => source.eventId === "event-1"), true);
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      await fsp.rm(resolved, { recursive: true, force: true });
    }
  }
});
