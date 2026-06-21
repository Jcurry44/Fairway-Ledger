/*
 * Fairway Ledger - Golf Lab warehouse/import helpers.
 *
 * Pure database layer for owned pro-golf data: import normalization, quality
 * scoring, model-readiness checks, and blank source templates.
 */
(function (root, factory) {
  "use strict";
  let golfLab = root.GolfLab;
  if (typeof module === "object" && module.exports) {
    golfLab = require("./golf-lab.js");
    module.exports = factory(golfLab);
  } else {
    root.GolfLabWarehouse = factory(golfLab);
  }
})(typeof self !== "undefined" ? self : this, function (GolfLab) {
  "use strict";

  if (!GolfLab) throw new Error("GolfLabWarehouse requires GolfLab.");

  const WAREHOUSE_VERSION = "warehouse-v0.1";

  const COLLECTION_COLUMNS = Object.freeze({
    players: ["id", "name", "country", "tour", "owgrRank", "dataGolfId", "pgaTourId", "photoUrl", "profileUrl", "handedness", "age", "turnedPro", "college", "sourceProvider", "sourceUrl", "sourceUpdatedAt"],
    tours: ["id", "name", "code", "sourceProvider", "sourceUrl", "sourceUpdatedAt"],
    events: ["id", "name", "tour", "season", "startDate", "endDate", "courseId", "courseName", "fieldStrength", "status", "sourceProvider", "sourceUrl", "sourceUpdatedAt"],
    courses: ["id", "name", "location", "par", "yards", "rating", "slope", "fieldAdjustedToPar", "sgDifficulty", "style", "sourceProvider", "sourceUrl", "sourceUpdatedAt"],
    courseSetups: ["id", "eventId", "courseId", "par", "yards", "rough", "greenSpeed", "firmness", "weatherNote", "fieldAdjustedToPar", "sgDifficulty", "sourceProvider", "sourceUrl", "sourceUpdatedAt"],
    eventCourses: ["id", "eventId", "courseId", "courseName", "location", "courseOrder", "roundNumbers", "rotationRole", "par", "yards", "confidence", "note", "sourceProvider", "sourceUrl", "sourceUpdatedAt"],
    fields: ["id", "eventId", "playerId", "playerName", "status", "teeTime", "sourceProvider", "sourceUrl", "sourceUpdatedAt"],
    rounds: ["id", "playerId", "playerName", "eventId", "courseId", "courseName", "roundNumber", "date", "score", "toPar", "adjustedToPar", "sgTotal", "difficultyBucket", "sourceProvider", "sourceUrl", "sourceUpdatedAt"],
    strokesGained: ["id", "playerId", "playerName", "eventId", "roundId", "period", "sgTotal", "sgOtt", "sgApp", "sgArg", "sgPutt", "sgT2g", "drivingDistance", "accuracy", "gir", "scrambling", "sourceProvider", "sourceUrl", "sourceUpdatedAt"],
    weatherSnapshots: ["id", "eventId", "courseId", "courseName", "roundNumber", "date", "observedAt", "forecastAt", "temperatureF", "windMph", "gustMph", "precipitationIn", "wave", "sourceProvider", "sourceUrl", "sourceUpdatedAt"],
    oddsSnapshots: ["id", "eventId", "playerId", "market", "book", "oddsAmerican", "impliedProbability", "capturedAt", "sourceProvider", "sourceUrl", "sourceUpdatedAt"],
    modelPredictions: ["id", "eventId", "playerId", "market", "modelVersion", "modelRunId", "modelProfile", "modelWeatherScenario", "modelWeatherLabel", "probability", "fairOddsAmerican", "marketOddsAmerican", "edge", "rank", "score", "skill", "recentForm", "courseFit", "difficultyFit", "weatherFit", "liveState", "livePosition", "liveToPar", "liveRounds", "liveStrokesBack", "sampleRounds", "confidence", "createdAt", "settled", "hit", "finishPosition", "finishToPar", "profitUnits", "result"],
    predictionLedger: ["id", "eventId", "playerId", "market", "modelVersion", "modelRunId", "modelProfile", "modelWeatherScenario", "modelWeatherLabel", "probability", "fairOddsAmerican", "marketOddsAmerican", "edge", "rank", "score", "skill", "recentForm", "courseFit", "difficultyFit", "weatherFit", "liveState", "livePosition", "liveToPar", "liveRounds", "liveStrokesBack", "sampleRounds", "confidence", "createdAt", "settled", "hit", "finishPosition", "finishToPar", "profitUnits", "result"],
    equipmentSnapshots: ["id", "playerId", "capturedDate", "driver", "fairwayWoods", "hybrids", "irons", "wedges", "putter", "ball", "apparel", "confidence", "sourceProvider", "sourceUrl", "sourceUpdatedAt"],
    accomplishments: ["id", "playerId", "type", "label", "eventName", "season", "date", "sourceProvider", "sourceUrl", "sourceUpdatedAt"],
    sourceFetches: ["id", "provider", "endpoint", "eventId", "modelRunId", "modelVersion", "modelProfile", "modelWeatherScenario", "modelWeatherLabel", "fetchedAt", "status", "rowCount", "manifestJson", "sourceUrl"]
  });

  const SCORE_WEIGHTS = Object.freeze({
    core: 0.24,
    matching: 0.20,
    scoring: 0.18,
    market: 0.12,
    weather: 0.10,
    sources: 0.10,
    enrichment: 0.06
  });

  const SOURCE_COLLECTION_KEYS = Object.freeze([
    "players",
    "tours",
    "events",
    "courses",
    "courseSetups",
    "eventCourses",
    "fields",
    "rounds",
    "strokesGained",
    "weatherSnapshots",
    "oddsSnapshots",
    "equipmentSnapshots",
    "accomplishments"
  ]);

  const COLLECTION_ROLES = Object.freeze({
    players: "Core",
    tours: "Core",
    events: "Core",
    courses: "Core",
    courseSetups: "Course",
    eventCourses: "Course",
    fields: "Field",
    rounds: "Scoring",
    strokesGained: "Scoring",
    weatherSnapshots: "Weather",
    oddsSnapshots: "Market",
    modelPredictions: "Model",
    predictionLedger: "Model",
    equipmentSnapshots: "Enrichment",
    accomplishments: "Enrichment",
    sourceFetches: "Source"
  });

  const VALIDATION_REQUIREMENTS = Object.freeze({
    players: [["id"], ["name"]],
    tours: [["id"], ["name"]],
    events: [["id"], ["name"], ["startDate"], ["courseId", "courseName"]],
    courses: [["id"], ["name"]],
    courseSetups: [["eventId"], ["courseId", "courseName"], ["par", "yards", "sgDifficulty", "fieldAdjustedToPar"]],
    eventCourses: [["eventId"], ["courseId", "courseName"], ["sourceProvider", "sourceUrl"]],
    fields: [["eventId"], ["playerId", "playerName"]],
    rounds: [["eventId"], ["playerId", "playerName"], ["courseId", "courseName"], ["roundNumber", "date"], ["score", "toPar", "adjustedToPar", "sgTotal"]],
    strokesGained: [["playerId", "playerName"], ["period", "eventId", "roundId"], ["sgTotal", "sgT2g", "sgOtt", "sgApp", "sgPutt"]],
    weatherSnapshots: [["eventId"], ["windMph", "temperatureF", "precipitationIn", "observedAt", "forecastAt", "date"]],
    oddsSnapshots: [["eventId"], ["playerId"], ["market"], ["oddsAmerican", "impliedProbability"]],
    modelPredictions: [["eventId"], ["playerId"], ["market"], ["probability"]],
    predictionLedger: [["eventId"], ["playerId"], ["market"], ["probability"]],
    equipmentSnapshots: [["playerId"], ["capturedDate"], ["driver", "irons", "putter"]],
    accomplishments: [["playerId"], ["label"], ["type", "eventName", "season"]],
    sourceFetches: [["provider", "sourceProvider"], ["fetchedAt", "sourceUpdatedAt"]]
  });

  const COLLECTION_FILE_ALIASES = Object.freeze({
    players: "players",
    player: "players",
    tours: "tours",
    tour: "tours",
    events: "events",
    event: "events",
    schedule: "events",
    tournaments: "events",
    tournament: "events",
    courses: "courses",
    course: "courses",
    "course-setups": "courseSetups",
    "course-setup": "courseSetups",
    setups: "courseSetups",
    setup: "courseSetups",
    "event-courses": "eventCourses",
    "event-course": "eventCourses",
    event_courses: "eventCourses",
    event_course: "eventCourses",
    course_pool: "eventCourses",
    course_pools: "eventCourses",
    "course-pool": "eventCourses",
    "course-pools": "eventCourses",
    fields: "fields",
    field: "fields",
    rounds: "rounds",
    round: "rounds",
    scorecards: "rounds",
    scorecard: "rounds",
    "strokes-gained": "strokesGained",
    "strokes-gained-rows": "strokesGained",
    sg: "strokesGained",
    skills: "strokesGained",
    weather: "weatherSnapshots",
    "weather-snapshots": "weatherSnapshots",
    "weather-snapshot": "weatherSnapshots",
    odds: "oddsSnapshots",
    "odds-snapshots": "oddsSnapshots",
    "odds-snapshot": "oddsSnapshots",
    markets: "oddsSnapshots",
    market: "oddsSnapshots",
    "model-predictions": "modelPredictions",
    "model-prediction": "modelPredictions",
    predictions: "modelPredictions",
    "prediction-ledger": "predictionLedger",
    ledger: "predictionLedger",
    equipment: "equipmentSnapshots",
    "equipment-snapshots": "equipmentSnapshots",
    "equipment-snapshot": "equipmentSnapshots",
    bags: "equipmentSnapshots",
    bag: "equipmentSnapshots",
    accomplishments: "accomplishments",
    accomplishment: "accomplishments",
    results: "accomplishments",
    "source-fetches": "sourceFetches",
    "source-fetch": "sourceFetches",
    sources: "sourceFetches",
    source: "sourceFetches"
  });

  function cleanString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function ratio(numerator, denominator) {
    if (!denominator) return 0;
    return Math.max(0, Math.min(1, numerator / denominator));
  }

  function pct(value) {
    return Math.round(Math.max(0, Math.min(1, value)) * 100);
  }

  function latestDate(values) {
    return values.map(cleanString).filter(Boolean).sort().slice(-1)[0] || "";
  }

  function average(values) {
    const clean = values.filter(Number.isFinite);
    if (!clean.length) return 0;
    return clean.reduce((sum, value) => sum + value, 0) / clean.length;
  }

  function parseDateValue(value) {
    const raw = cleanString(value);
    if (!raw) return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function dateAgeDays(value, nowValue) {
    const date = parseDateValue(value);
    if (!date) return null;
    const now = parseDateValue(nowValue) || new Date();
    const ms = now.getTime() - date.getTime();
    return Math.max(0, Math.floor(ms / 86400000));
  }

  function freshnessStatus(ageDays) {
    if (!Number.isFinite(ageDays)) return "unknown";
    if (ageDays <= 3) return "fresh";
    if (ageDays <= 10) return "watch";
    return "stale";
  }

  function freshnessScore(status) {
    if (status === "fresh") return 1;
    if (status === "watch") return 0.68;
    if (status === "stale") return 0.18;
    return 0.35;
  }

  function sourceRowDate(row) {
    return cleanString(
      (row && (row.fetchedAt || row.sourceUpdatedAt || row.updatedAt || row.capturedAt || row.createdAt || row.date || row.observedAt || row.forecastAt)) || ""
    );
  }

  function hasSourceMeta(row) {
    return Boolean(row && (cleanString(row.sourceProvider) || cleanString(row.sourceUrl) || cleanString(row.sourceUpdatedAt)));
  }

  function fieldGroupLabel(fields) {
    return fields.join("/");
  }

  function fieldGroupComplete(row, fields) {
    return fields.some((field) => hasValue(row && row[field]));
  }

  function hasValue(value) {
    return value !== null && value !== undefined && value !== "";
  }

  function normalizeColumnName(value) {
    const raw = cleanString(value)
      .replace(/^\uFEFF/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    if (!raw) return "";
    const words = raw.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    if (!words.length) return "";
    return words.map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join("");
  }

  function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const source = String(text || "");
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];
      if (inQuotes) {
        if (char === '"' && next === '"') {
          field += '"';
          index += 1;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          field += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (char !== "\r") {
        field += char;
      }
    }
    row.push(field);
    if (row.some((cell) => cleanString(cell))) rows.push(row);
    return rows;
  }

  function parseGolfLabCsv(text) {
    const rows = parseCsvRows(text);
    if (!rows.length) return [];
    const headers = rows[0].map(normalizeColumnName);
    return rows.slice(1)
      .filter((row) => row.some((cell) => cleanString(cell)))
      .map((row) => headers.reduce((record, header, index) => {
        if (!header) return record;
        record[header] = cleanString(row[index]);
        return record;
      }, {}));
  }

  function collectionKeyFromFileName(fileName) {
    const stem = cleanString(fileName)
      .replace(/\.[^.]+$/, "")
      .replace(/^golf[-_\s]?lab[-_\s]?/i, "")
      .replace(/^owned[-_\s]?golf[-_\s]?/i, "");
    const normalized = stem
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return COLLECTION_FILE_ALIASES[normalized] || "";
  }

  function recordCount(lab) {
    return GolfLab.COLLECTION_KEYS.reduce((sum, key) => sum + lab[key].length, 0);
  }

  function collectionCounts(lab) {
    return GolfLab.COLLECTION_KEYS.reduce((counts, key) => {
      counts[key] = lab[key].length;
      return counts;
    }, {});
  }

  function sourceMeta(payload, options) {
    const source = payload && typeof payload === "object" && payload.source && typeof payload.source === "object"
      ? payload.source
      : {};
    return {
      provider: cleanString(options.provider || source.provider || source.sourceProvider || payload.provider || payload.sourceProvider),
      endpoint: cleanString(options.endpoint || source.endpoint || payload.endpoint || "manual-import"),
      sourceUrl: cleanString(options.sourceUrl || source.sourceUrl || source.url || payload.sourceUrl || payload.url),
      fetchedAt: cleanString(options.fetchedAt || source.fetchedAt || source.sourceUpdatedAt || payload.fetchedAt || payload.sourceUpdatedAt || new Date().toISOString()),
      status: cleanString(options.status || source.status || "ok")
    };
  }

  function extractGolfLabPayload(payload) {
    if (!payload || typeof payload !== "object") return {};
    if (payload.collection && Array.isArray(payload.records)) {
      const key = cleanString(payload.collection);
      return GolfLab.COLLECTION_KEYS.includes(key) ? { [key]: payload.records } : {};
    }
    if (payload.golfLab && typeof payload.golfLab === "object") return payload.golfLab;
    if (payload.tables && typeof payload.tables === "object") return payload.tables;
    if (payload.collections && typeof payload.collections === "object") return payload.collections;
    return payload;
  }

  function buildSyntheticSourceFetch(payload, lab, options) {
    const meta = sourceMeta(payload || {}, options || {});
    if (!meta.provider && !meta.sourceUrl && !meta.endpoint) return null;
    return {
      id: `source-${cleanString(meta.provider || "manual").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${cleanString(meta.fetchedAt).slice(0, 10) || "import"}`,
      provider: meta.provider || "Manual import",
      endpoint: meta.endpoint || "manual-import",
      fetchedAt: meta.fetchedAt,
      status: meta.status || "ok",
      rowCount: recordCount(lab),
      sourceUrl: meta.sourceUrl
    };
  }

  function playerAliases(player) {
    return [player.id, player.name, player.pgaTourId, player.dataGolfId].map(cleanString).filter(Boolean);
  }

  function lowerSet(values) {
    return new Set(values.map(cleanString).filter(Boolean).map((value) => value.toLowerCase()));
  }

  function buildIndexes(lab) {
    const players = new Map();
    lab.players.forEach((player) => {
      playerAliases(player).forEach((alias) => players.set(alias.toLowerCase(), player));
    });
    const coursesById = new Map(lab.courses.map((course) => [course.id, course]));
    const coursesByName = new Map(lab.courses.map((course) => [cleanString(course.name).toLowerCase(), course]));
    return { players, coursesById, coursesByName };
  }

  function findPlayer(indexes, id, name) {
    return indexes.players.get(cleanString(id).toLowerCase()) || indexes.players.get(cleanString(name).toLowerCase()) || null;
  }

  function findCourse(indexes, id, name) {
    return indexes.coursesById.get(cleanString(id)) || indexes.coursesByName.get(cleanString(name).toLowerCase()) || null;
  }

  function rowMatchesAliases(row, aliases) {
    if (!row || !aliases || !aliases.size) return false;
    return [
      row.playerId,
      row.playerName,
      row.name,
      row.pgaTourId,
      row.dataGolfId
    ].map(cleanString).filter(Boolean).some((value) => aliases.has(value.toLowerCase()));
  }

  function rowMatchesCourse(row, course) {
    if (!row || !course) return false;
    const courseId = cleanString(course.id);
    const courseName = cleanString(course.name).toLowerCase();
    return (courseId && cleanString(row.courseId) === courseId) ||
      (courseName && cleanString(row.courseName || row.name).toLowerCase() === courseName);
  }

  function marketKey(value) {
    return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  const MODELED_MARKETS = Object.freeze([
    { key: "winner", value: "winner", label: "Winner" },
    { key: "top10", value: "top 10", label: "Top 10" },
    { key: "top20", value: "top 20", label: "Top 20" },
    { key: "makecut", value: "make cut", label: "Make cut" }
  ]);

  function marketLabel(value) {
    const key = marketKey(value);
    const modeled = MODELED_MARKETS.find((market) => market.key === key);
    return modeled ? modeled.label : cleanString(value) || "Market";
  }

  function isModeledMarket(value) {
    return ["winner", "top10", "top20", "makecut"].includes(marketKey(value));
  }

  function marketListFromOptions(options = {}) {
    const explicitMarkets = Array.isArray(options.markets) && options.markets.length
      ? options.markets.map((value) => ({
        key: marketKey(value),
        value: cleanString(value),
        label: marketLabel(value)
      })).filter((market) => market.key)
      : MODELED_MARKETS;
    const filterKey = marketKey(options.market);
    if (!filterKey || filterKey === "all" || filterKey === "allmarkets") return explicitMarkets;
    return explicitMarkets.filter((market) => market.key === filterKey);
  }

  function eventRows(lab) {
    const indexes = buildIndexes(lab);
    return lab.events.map((event) => {
      const fields = lab.fields.filter((field) => field.eventId === event.id);
      const rounds = lab.rounds.filter((round) => round.eventId === event.id);
      const weather = lab.weatherSnapshots.filter((row) => row.eventId === event.id);
      const odds = lab.oddsSnapshots.filter((row) => row.eventId === event.id);
      const eventCourses = lab.eventCourses.filter((row) => row.eventId === event.id);
      const matchedFieldPlayers = fields.filter((field) => findPlayer(indexes, field.playerId, field.playerName)).length;
      const matchedRoundPlayers = rounds.filter((round) => findPlayer(indexes, round.playerId, round.playerName)).length;
      const course = findCourse(indexes, event.courseId, event.courseName);
      const hasCoursePool = eventCourses.some((row) => findCourse(indexes, row.courseId, row.courseName));
      const hasScoring = rounds.some((round) => hasValue(round.sgTotal) || hasValue(round.toPar) || hasValue(round.adjustedToPar));
      const hasMarket = odds.some((row) => isModeledMarket(row.market));
      const readinessBits = [
        fields.length > 0,
        matchedFieldPlayers > 0,
        Boolean(course || hasCoursePool),
        hasScoring,
        weather.length > 0,
        hasMarket
      ];
      const readinessScore = pct(readinessBits.filter(Boolean).length / readinessBits.length);
      const readiness = readinessScore >= 84 ? "model-ready" : readinessScore >= 50 ? "building" : "needs data";
      return {
        eventId: event.id,
        name: event.name || event.id,
        tour: event.tour,
        startDate: event.startDate,
        courseName: event.courseName || (course && course.name) || (eventCourses.length ? `${eventCourses.length} course pool` : ""),
        fieldCount: fields.length,
        matchedFieldPlayers,
        rounds: rounds.length,
        matchedRoundPlayers,
        weatherSnapshots: weather.length,
        oddsSnapshots: odds.length,
        hasCourse: Boolean(course || hasCoursePool),
        coursePoolCourses: eventCourses.length,
        hasScoring,
        hasMarket,
        readiness,
        readinessScore
      };
    }).sort((a, b) =>
      b.readinessScore - a.readinessScore ||
      cleanString(a.startDate).localeCompare(cleanString(b.startDate)) ||
      cleanString(a.name).localeCompare(cleanString(b.name))
    );
  }

  function buildCoverage(lab, rows) {
    const indexes = buildIndexes(lab);
    const matchedFields = lab.fields.filter((field) => findPlayer(indexes, field.playerId, field.playerName)).length;
    const matchedRounds = lab.rounds.filter((round) => findPlayer(indexes, round.playerId, round.playerName)).length;
    const matchedRoundCourses = lab.rounds.filter((round) => findCourse(indexes, round.courseId, round.courseName)).length;
    const eventsWithCourses = rows.filter((row) => row.hasCourse).length;
    const eventsWithWeather = rows.filter((row) => row.weatherSnapshots > 0).length;
    const eventsWithOdds = rows.filter((row) => row.oddsSnapshots > 0).length;
    const eventsWithScoring = rows.filter((row) => row.hasScoring).length;
    return {
      fieldPlayerMatch: ratio(matchedFields, lab.fields.length),
      roundPlayerMatch: ratio(matchedRounds, lab.rounds.length),
      roundCourseMatch: ratio(matchedRoundCourses, lab.rounds.length),
      eventCourseMatch: ratio(eventsWithCourses, lab.events.length),
      eventWeather: ratio(eventsWithWeather, lab.events.length),
      eventOdds: ratio(eventsWithOdds, lab.events.length),
      eventScoring: ratio(eventsWithScoring, lab.events.length)
    };
  }

  function coveragePlayerKey(row, indexes) {
    const player = findPlayer(indexes, row && row.playerId, row && row.playerName);
    if (player && player.id) return `id:${player.id}`;
    const rawId = cleanString(row && row.playerId);
    if (rawId) return `id:${rawId}`;
    const rawName = cleanString(row && row.playerName);
    return rawName ? `name:${rawName.toLowerCase()}` : "";
  }

  function coveragePlayerName(row, indexes) {
    const player = findPlayer(indexes, row && row.playerId, row && row.playerName);
    return (player && player.name) || cleanString(row && row.playerName) || cleanString(row && row.playerId) || "Unknown player";
  }

  function uniqueSorted(values) {
    return [...new Set(values.map(cleanString).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  function predictionRowsForEvent(lab, eventId) {
    const byKey = new Map();
    [...lab.predictionLedger, ...lab.modelPredictions].forEach((row) => {
      if (!row || row.eventId !== eventId) return;
      const key = [
        row.eventId,
        marketKey(row.market),
        cleanString(row.playerId || row.playerName),
        cleanString(row.modelVersion),
        cleanString(row.createdAt)
      ].join("|");
      byKey.set(key, row);
    });
    return [...byKey.values()];
  }

  function selectMarketCoverageEvent(lab, rows, options = {}) {
    const eventId = cleanString(options.eventId);
    if (eventId) {
      return lab.events.find((event) => event.id === eventId || event.eventId === eventId) || null;
    }
    const today = cleanString(options.today) || new Date().toISOString().slice(0, 10);
    const upcoming = [...lab.events]
      .filter((event) => !event.startDate || cleanString(event.startDate) >= today)
      .sort((a, b) =>
        cleanString(a.startDate).localeCompare(cleanString(b.startDate)) ||
        cleanString(a.name).localeCompare(cleanString(b.name))
      );
    if (upcoming[0]) return upcoming[0];
    const bestRow = rows[0];
    return bestRow ? lab.events.find((event) => event.id === bestRow.eventId) || null : null;
  }

  function buildMarketCoverageEventRow(lab, event, markets, generatedAt) {
    const indexes = buildIndexes(lab);
    const eventId = event && (event.id || event.eventId);
    const fields = lab.fields
      .filter((row) => row.eventId === eventId)
      .filter((row) => !["wd", "withdrawn", "out"].includes(cleanString(row.status).toLowerCase()));
    const fieldKeys = new Set(fields.map((row) => coveragePlayerKey(row, indexes)).filter(Boolean));
    const odds = lab.oddsSnapshots.filter((row) => row.eventId === eventId);
    const predictions = predictionRowsForEvent(lab, eventId);
    const sourceRows = lab.sourceFetches.filter((row) =>
      marketKey(row.endpoint).includes("odds") ||
      marketKey(row.endpoint).includes("market") ||
      marketKey(row.provider).includes("odds") ||
      marketKey(row.provider).includes("sportsbook")
    );

    const marketRows = markets.map((market) => {
      const marketOdds = odds.filter((row) => marketKey(row.market) === market.key);
      const marketPredictions = predictions.filter((row) => marketKey(row.market) === market.key);
      const pricedKeys = new Set(marketOdds.map((row) => coveragePlayerKey(row, indexes)).filter(Boolean));
      const predictedRows = marketPredictions
        .map((row) => ({
          row,
          key: coveragePlayerKey(row, indexes),
          name: coveragePlayerName(row, indexes)
        }))
        .filter((row) => row.key);
      const predictedKeys = new Set(predictedRows.map((row) => row.key));
      const fieldPricedPlayers = [...pricedKeys].filter((key) => fieldKeys.has(key)).length;
      const pricedPredictions = [...predictedKeys].filter((key) => pricedKeys.has(key)).length;
      const missingPredictions = predictedRows
        .filter((row) => !pricedKeys.has(row.key))
        .sort((a, b) => (Number(a.row.rank) || 999) - (Number(b.row.rank) || 999) || a.name.localeCompare(b.name))
        .map((row) => row.name);
      const latestOddsAt = latestDate(marketOdds.flatMap((row) => [row.capturedAt, row.sourceUpdatedAt]));
      const fieldCoverage = fields.length ? ratio(fieldPricedPlayers, fields.length) : 0;
      const predictionCoverage = predictedKeys.size ? ratio(pricedPredictions, predictedKeys.size) : 0;
      const oddsAgeDays = dateAgeDays(latestOddsAt, generatedAt);
      const books = uniqueSorted(marketOdds.map((row) => row.book));
      let status = "empty";
      let statusLabel = "No odds";
      if (predictedKeys.size === 0 && pricedKeys.size > 0) {
        status = "unmodeled";
        statusLabel = "Odds only";
      } else if (pricedKeys.size === 0 && predictedKeys.size > 0) {
        status = "missing";
        statusLabel = "Needs odds";
      } else if (predictionCoverage >= 0.9 && (!fields.length || fieldCoverage >= 0.6)) {
        status = "ready";
        statusLabel = "Ready";
      } else if (predictionCoverage >= 0.5 || fieldCoverage >= 0.35) {
        status = "partial";
        statusLabel = "Partial";
      } else if (pricedKeys.size > 0) {
        status = "thin";
        statusLabel = "Thin";
      }
      return {
        market: market.value,
        marketKey: market.key,
        label: market.label,
        status,
        statusLabel,
        activeFieldCount: fields.length,
        pricedPlayers: pricedKeys.size,
        fieldPricedPlayers,
        predictedPlayers: predictedKeys.size,
        pricedPredictions,
        missingPredictionCount: missingPredictions.length,
        missingPredictions: missingPredictions.slice(0, 6),
        fieldCoverage: pct(fieldCoverage),
        predictionCoverage: pct(predictionCoverage),
        books,
        bookCount: books.length,
        latestOddsAt,
        oddsAgeDays,
        freshness: freshnessStatus(oddsAgeDays),
        sourceProviders: uniqueSorted(marketOdds.map((row) => row.sourceProvider))
      };
    });

    const pricedPlayerKeys = new Set();
    const predictedPlayerKeys = new Set();
    const books = new Set();
    const sourceProviders = new Set();
    marketRows.forEach((row) => {
      odds
        .filter((oddsRow) => row.marketKey === marketKey(oddsRow.market))
        .forEach((oddsRow) => {
          const playerKey = coveragePlayerKey(oddsRow, indexes);
          if (playerKey) pricedPlayerKeys.add(playerKey);
          if (cleanString(oddsRow.book)) books.add(cleanString(oddsRow.book));
          if (cleanString(oddsRow.sourceProvider)) sourceProviders.add(cleanString(oddsRow.sourceProvider));
        });
      predictions
        .filter((prediction) => row.marketKey === marketKey(prediction.market))
        .forEach((prediction) => {
          const playerKey = coveragePlayerKey(prediction, indexes);
          if (playerKey) predictedPlayerKeys.add(playerKey);
        });
    });

    const predictionCoverageValues = marketRows.filter((row) => row.predictedPlayers > 0).map((row) => row.predictionCoverage / 100);
    const fieldCoverageValues = marketRows.filter((row) => row.activeFieldCount > 0).map((row) => row.fieldCoverage / 100);
    return {
      eventId,
      name: event.name || eventId,
      tour: event.tour,
      startDate: event.startDate,
      courseName: event.courseName,
      activeFieldCount: fields.length,
      markets: marketRows,
      summary: {
        markets: marketRows.length,
        readyMarkets: marketRows.filter((row) => row.status === "ready").length,
        pricedMarkets: marketRows.filter((row) => row.pricedPlayers > 0).length,
        missingMarkets: marketRows.filter((row) => row.status === "empty" || row.status === "missing").length,
        uniquePricedPlayers: pricedPlayerKeys.size,
        uniquePredictedPlayers: predictedPlayerKeys.size,
        avgFieldCoverage: pct(average(fieldCoverageValues)),
        avgPredictionCoverage: pct(average(predictionCoverageValues)),
        missingPredictionCount: marketRows.reduce((sum, row) => sum + row.missingPredictionCount, 0),
        bookCount: books.size,
        books: [...books].sort((a, b) => a.localeCompare(b)),
        sourceProviders: [...sourceProviders].sort((a, b) => a.localeCompare(b)),
        latestOddsAt: latestDate(marketRows.map((row) => row.latestOddsAt)),
        sourceAuditRows: sourceRows.length
      }
    };
  }

  function buildMarketCoverageBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const generatedAt = cleanString(options.now) || new Date().toISOString();
    const markets = marketListFromOptions(options);
    const readinessRows = eventRows(lab);
    const selectedEvent = selectMarketCoverageEvent(lab, readinessRows, options);
    const eventRowsForMarkets = lab.events.map((event) => buildMarketCoverageEventRow(lab, event, markets, generatedAt))
      .sort((a, b) =>
        (selectedEvent && a.eventId === selectedEvent.id ? -1 : 0) - (selectedEvent && b.eventId === selectedEvent.id ? -1 : 0) ||
        b.summary.readyMarkets - a.summary.readyMarkets ||
        b.summary.pricedMarkets - a.summary.pricedMarkets ||
        cleanString(a.startDate).localeCompare(cleanString(b.startDate)) ||
        cleanString(a.name).localeCompare(cleanString(b.name))
      );
    const selectedEventRow = selectedEvent
      ? eventRowsForMarkets.find((row) => row.eventId === selectedEvent.id) || null
      : null;
    const marketRows = selectedEventRow ? selectedEventRow.markets : [];
    const summary = selectedEventRow
      ? selectedEventRow.summary
      : {
        markets: markets.length,
        readyMarkets: 0,
        pricedMarkets: 0,
        missingMarkets: markets.length,
        uniquePricedPlayers: 0,
        uniquePredictedPlayers: 0,
        avgFieldCoverage: 0,
        avgPredictionCoverage: 0,
        missingPredictionCount: 0,
        bookCount: 0,
        books: [],
        sourceProviders: [],
        latestOddsAt: "",
        sourceAuditRows: 0
      };
    return {
      generatedAt,
      markets,
      selectedEvent: selectedEvent ? {
        eventId: selectedEvent.id,
        name: selectedEvent.name || selectedEvent.id,
        startDate: selectedEvent.startDate,
        courseName: selectedEvent.courseName,
        tour: selectedEvent.tour
      } : null,
      selectedEventRow,
      summary,
      eventRows: eventRowsForMarkets,
      marketRows
    };
  }

  function oddsAmericanToImplied(oddsAmerican) {
    const odds = Number(oddsAmerican);
    if (!Number.isFinite(odds) || odds === 0) return null;
    if (odds > 0) return 100 / (odds + 100);
    const favorite = Math.abs(odds);
    return favorite / (favorite + 100);
  }

  function normalizedImpliedProbability(row) {
    const explicit = Number(row && row.impliedProbability);
    if (Number.isFinite(explicit) && explicit > 0) {
      return explicit > 1 ? explicit / 100 : explicit;
    }
    return oddsAmericanToImplied(row && row.oddsAmerican);
  }

  function oddsSnapshotTimestamp(row) {
    return cleanString(
      (row && (row.capturedAt || row.sourceUpdatedAt || row.fetchedAt || row.createdAt || row.date)) || ""
    );
  }

  function marketMatchesFilter(market, filter) {
    const target = marketKey(filter);
    if (!target || target === "all" || target === "allmarkets") return true;
    return marketKey(market) === target;
  }

  function oddsMovementStatus(impliedDelta) {
    if (!Number.isFinite(impliedDelta)) return { key: "unknown", label: "Unknown" };
    if (impliedDelta >= 0.015) return { key: "steam", label: "Steam" };
    if (impliedDelta <= -0.015) return { key: "drift", label: "Drift" };
    return { key: "flat", label: "Flat" };
  }

  function buildOddsMovementBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const generatedAt = cleanString(options.now) || new Date().toISOString();
    const readinessRows = eventRows(lab);
    const selectedEvent = selectMarketCoverageEvent(lab, readinessRows, options);
    const maxRows = Math.max(1, Number(options.maxRows) || 12);
    if (!selectedEvent) {
      return {
        generatedAt,
        selectedEvent: null,
        summary: {
          snapshots: 0,
          trackedLines: 0,
          movingLines: 0,
          markets: 0,
          players: 0,
          books: 0,
          steam: 0,
          drift: 0,
          flat: 0,
          latestOddsAt: "",
          latestAgeDays: null,
          maxMove: 0,
          avgAbsMove: 0
        },
        marketRows: [],
        lineRows: [],
        rows: [],
        warnings: ["Import an event before odds movement can be audited."]
      };
    }

    const eventId = cleanString(selectedEvent.id || selectedEvent.eventId);
    const indexes = buildIndexes(lab);
    const eventOdds = lab.oddsSnapshots
      .filter((row) => cleanString(row.eventId) === eventId)
      .filter((row) => marketMatchesFilter(row.market, options.market))
      .sort((a, b) =>
        oddsSnapshotTimestamp(a).localeCompare(oddsSnapshotTimestamp(b)) ||
        cleanString(a.book).localeCompare(cleanString(b.book)) ||
        cleanString(a.playerId).localeCompare(cleanString(b.playerId)) ||
        cleanString(a.id).localeCompare(cleanString(b.id))
      );
    const grouped = new Map();
    eventOdds.forEach((row) => {
      const playerKey = coveragePlayerKey(row, indexes) || cleanString(row.playerId) || cleanString(row.id) || "unknown";
      const key = [
        marketKey(row.market) || "market",
        playerKey,
        cleanString(row.book).toLowerCase() || "market"
      ].join("|");
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    });

    const lineRows = [...grouped.values()].map((snapshots) => {
      const ordered = snapshots.slice().sort((a, b) =>
        oddsSnapshotTimestamp(a).localeCompare(oddsSnapshotTimestamp(b)) ||
        cleanString(a.id).localeCompare(cleanString(b.id))
      );
      const opening = ordered[0] || {};
      const latest = ordered[ordered.length - 1] || {};
      const openingImplied = normalizedImpliedProbability(opening);
      const latestImplied = normalizedImpliedProbability(latest);
      const impliedDelta = Number.isFinite(openingImplied) && Number.isFinite(latestImplied)
        ? latestImplied - openingImplied
        : null;
      const status = oddsMovementStatus(impliedDelta);
      const numericOdds = ordered.map((row) => Number(row.oddsAmerican)).filter(Number.isFinite);
      const timestampValues = ordered.map(oddsSnapshotTimestamp).filter(Boolean);
      const latestOddsAt = latestDate(timestampValues);
      return {
        eventId,
        market: opening.market || latest.market,
        marketKey: marketKey(opening.market || latest.market),
        marketLabel: marketLabel(opening.market || latest.market),
        playerId: cleanString(opening.playerId || latest.playerId),
        playerName: coveragePlayerName(opening.playerId ? opening : latest, indexes),
        book: cleanString(opening.book || latest.book) || "Market",
        snapshots: ordered.length,
        openingOddsAmerican: Number.isFinite(Number(opening.oddsAmerican)) ? Number(opening.oddsAmerican) : null,
        latestOddsAmerican: Number.isFinite(Number(latest.oddsAmerican)) ? Number(latest.oddsAmerican) : null,
        oddsDeltaAmerican: Number.isFinite(Number(opening.oddsAmerican)) && Number.isFinite(Number(latest.oddsAmerican))
          ? Number(latest.oddsAmerican) - Number(opening.oddsAmerican)
          : null,
        openingImplied,
        latestImplied,
        impliedDelta,
        absImpliedDelta: Number.isFinite(impliedDelta) ? Math.abs(impliedDelta) : 0,
        movement: status.key,
        movementLabel: status.label,
        firstCapturedAt: timestampValues[0] || "",
        latestOddsAt,
        latestAgeDays: dateAgeDays(latestOddsAt, generatedAt),
        bestOddsAmerican: numericOdds.length ? Math.max(...numericOdds) : null,
        worstOddsAmerican: numericOdds.length ? Math.min(...numericOdds) : null,
        sourceProvider: cleanString(latest.sourceProvider || opening.sourceProvider),
        sourceUrl: cleanString(latest.sourceUrl || opening.sourceUrl)
      };
    }).sort((a, b) =>
      b.absImpliedDelta - a.absImpliedDelta ||
      b.snapshots - a.snapshots ||
      cleanString(b.latestOddsAt).localeCompare(cleanString(a.latestOddsAt)) ||
      cleanString(a.playerName).localeCompare(cleanString(b.playerName))
    );

    const markets = new Map();
    const players = new Set();
    const books = new Set();
    const sourceProviders = new Set();
    lineRows.forEach((row) => {
      if (!markets.has(row.marketKey)) {
        markets.set(row.marketKey, {
          market: row.market,
          marketKey: row.marketKey,
          label: row.marketLabel,
          trackedLines: 0,
          snapshots: 0,
          players: new Set(),
          books: new Set(),
          steam: 0,
          drift: 0,
          flat: 0,
          avgAbsMove: 0,
          maxMove: 0,
          latestOddsAt: ""
        });
      }
      const marketRow = markets.get(row.marketKey);
      marketRow.trackedLines += 1;
      marketRow.snapshots += row.snapshots;
      marketRow.players.add(row.playerId || row.playerName);
      marketRow.books.add(row.book);
      marketRow.steam += row.movement === "steam" ? 1 : 0;
      marketRow.drift += row.movement === "drift" ? 1 : 0;
      marketRow.flat += row.movement === "flat" ? 1 : 0;
      marketRow.maxMove = Math.max(marketRow.maxMove, row.absImpliedDelta);
      marketRow.latestOddsAt = latestDate([marketRow.latestOddsAt, row.latestOddsAt]);
      if (row.playerId || row.playerName) players.add(row.playerId || row.playerName);
      if (row.book) books.add(row.book);
      if (row.sourceProvider) sourceProviders.add(row.sourceProvider);
    });

    const marketRows = [...markets.values()].map((row) => {
      const marketLineRows = lineRows.filter((line) => line.marketKey === row.marketKey);
      return {
        ...row,
        players: row.players.size,
        books: [...row.books].sort((a, b) => a.localeCompare(b)),
        bookCount: row.books.size,
        avgAbsMove: average(marketLineRows.map((line) => line.absImpliedDelta)),
        maxMove: row.maxMove,
        latestAgeDays: dateAgeDays(row.latestOddsAt, generatedAt)
      };
    }).sort((a, b) =>
      b.maxMove - a.maxMove ||
      b.trackedLines - a.trackedLines ||
      cleanString(a.label).localeCompare(cleanString(b.label))
    );

    const latestOddsAt = latestDate(lineRows.map((row) => row.latestOddsAt));
    return {
      generatedAt,
      selectedEvent: {
        eventId,
        name: selectedEvent.name || eventId,
        startDate: selectedEvent.startDate,
        courseName: selectedEvent.courseName,
        tour: selectedEvent.tour
      },
      summary: {
        snapshots: eventOdds.length,
        trackedLines: lineRows.length,
        movingLines: lineRows.filter((row) => row.movement === "steam" || row.movement === "drift").length,
        markets: marketRows.length,
        players: players.size,
        books: books.size,
        bookList: [...books].sort((a, b) => a.localeCompare(b)),
        sourceProviders: [...sourceProviders].sort((a, b) => a.localeCompare(b)),
        steam: lineRows.filter((row) => row.movement === "steam").length,
        drift: lineRows.filter((row) => row.movement === "drift").length,
        flat: lineRows.filter((row) => row.movement === "flat").length,
        latestOddsAt,
        latestAgeDays: dateAgeDays(latestOddsAt, generatedAt),
        maxMove: lineRows.length ? Math.max(...lineRows.map((row) => row.absImpliedDelta)) : 0,
        avgAbsMove: average(lineRows.map((row) => row.absImpliedDelta))
      },
      marketRows,
      lineRows,
      rows: lineRows.slice(0, maxRows),
      warnings: eventOdds.length ? [] : ["Import at least two timestamped odds snapshots per market line to see movement."]
    };
  }

  function latestOddsByBookRows(oddsRows) {
    const grouped = new Map();
    oddsRows.forEach((row) => {
      const key = cleanString(row.book).toLowerCase() || "market";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    });
    return [...grouped.values()].map((rows) => rows.slice().sort((a, b) =>
      oddsSnapshotTimestamp(b).localeCompare(oddsSnapshotTimestamp(a)) ||
      cleanString(b.id).localeCompare(cleanString(a.id))
    )[0]);
  }

  function bestPredictionForShopping(predictions, playerKey, market) {
    const targetMarket = marketKey(market);
    return predictions
      .filter((row) => marketKey(row.market) === targetMarket)
      .filter((row) => {
        const rawKey = cleanString(row.playerId || row.playerName).toLowerCase();
        return rawKey && (playerKey.toLowerCase().includes(rawKey) || rawKey === playerKey.toLowerCase().replace(/^id:|^name:/, ""));
      })
      .sort((a, b) =>
        cleanString(b.createdAt).localeCompare(cleanString(a.createdAt)) ||
        (Number(a.rank) || 999) - (Number(b.rank) || 999) ||
        cleanString(a.id).localeCompare(cleanString(b.id))
      )[0] || null;
  }

  function shoppingStatus(edgeAtBest, bookCount) {
    if (bookCount < 2) return { key: "single-book", label: "Single book" };
    if (!Number.isFinite(edgeAtBest)) return { key: "unmodeled", label: "Odds only" };
    if (edgeAtBest >= 0.03) return { key: "edge", label: "Best edge" };
    if (edgeAtBest >= 0) return { key: "lean", label: "Lean" };
    return { key: "overpriced", label: "Overpriced" };
  }

  function buildOddsShoppingBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const generatedAt = cleanString(options.now) || new Date().toISOString();
    const readinessRows = eventRows(lab);
    const selectedEvent = selectMarketCoverageEvent(lab, readinessRows, options);
    const maxRows = Math.max(1, Number(options.maxRows) || 12);
    if (!selectedEvent) {
      return {
        generatedAt,
        selectedEvent: null,
        summary: {
          players: 0,
          lines: 0,
          markets: 0,
          books: 0,
          bestEdges: 0,
          avgBestLift: 0,
          maxBestLift: 0,
          latestOddsAt: "",
          latestAgeDays: null,
          staleBooks: 0
        },
        marketRows: [],
        bookRows: [],
        lineRows: [],
        rows: [],
        warnings: ["Import an event before line shopping can be audited."]
      };
    }

    const eventId = cleanString(selectedEvent.id || selectedEvent.eventId);
    const indexes = buildIndexes(lab);
    const eventOdds = lab.oddsSnapshots
      .filter((row) => cleanString(row.eventId) === eventId)
      .filter((row) => marketMatchesFilter(row.market, options.market))
      .filter((row) => Number.isFinite(Number(row.oddsAmerican)) || Number.isFinite(Number(row.impliedProbability)));
    const predictions = predictionRowsForEvent(lab, eventId);
    const grouped = new Map();
    eventOdds.forEach((row) => {
      const playerKey = coveragePlayerKey(row, indexes) || cleanString(row.playerId || row.playerName).toLowerCase();
      if (!playerKey) return;
      const key = [marketKey(row.market) || "market", playerKey].join("|");
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    });

    const lineRows = [...grouped.values()].map((rows) => {
      const latestByBook = latestOddsByBookRows(rows)
        .filter((row) => Number.isFinite(Number(row.oddsAmerican)))
        .sort((a, b) =>
          Number(b.oddsAmerican) - Number(a.oddsAmerican) ||
          oddsSnapshotTimestamp(b).localeCompare(oddsSnapshotTimestamp(a)) ||
          cleanString(a.book).localeCompare(cleanString(b.book))
        );
      const best = latestByBook[0] || {};
      const worst = latestByBook[latestByBook.length - 1] || {};
      const playerKey = coveragePlayerKey(best, indexes) || coveragePlayerKey(rows[0], indexes) || cleanString(best.playerId || rows[0].playerId || best.playerName || rows[0].playerName);
      const prediction = bestPredictionForShopping(predictions, playerKey, best.market || rows[0].market);
      const modelProbability = prediction ? Number(prediction.probability) : null;
      const impliedValues = latestByBook.map(normalizedImpliedProbability).filter(Number.isFinite);
      const consensusImplied = impliedValues.length ? average(impliedValues) : null;
      const bestImplied = normalizedImpliedProbability(best);
      const worstImplied = normalizedImpliedProbability(worst);
      const edgeAtBest = Number.isFinite(modelProbability) && Number.isFinite(bestImplied) ? modelProbability - bestImplied : null;
      const edgeAtConsensus = Number.isFinite(modelProbability) && Number.isFinite(consensusImplied) ? modelProbability - consensusImplied : null;
      const bestLift = Number.isFinite(consensusImplied) && Number.isFinite(bestImplied) ? consensusImplied - bestImplied : 0;
      const latestOddsAt = latestDate(latestByBook.map(oddsSnapshotTimestamp));
      const status = shoppingStatus(edgeAtBest, latestByBook.length);
      return {
        eventId,
        market: best.market || rows[0].market,
        marketKey: marketKey(best.market || rows[0].market),
        marketLabel: marketLabel(best.market || rows[0].market),
        playerId: cleanString(best.playerId || rows[0].playerId),
        playerName: coveragePlayerName(best.playerId ? best : rows[0], indexes),
        bookCount: latestByBook.length,
        books: uniqueSorted(latestByBook.map((row) => row.book || "Market")),
        bestBook: cleanString(best.book) || "Market",
        bestOddsAmerican: Number.isFinite(Number(best.oddsAmerican)) ? Number(best.oddsAmerican) : null,
        bestImplied,
        worstBook: cleanString(worst.book) || "Market",
        worstOddsAmerican: Number.isFinite(Number(worst.oddsAmerican)) ? Number(worst.oddsAmerican) : null,
        worstImplied,
        consensusImplied,
        modelProbability: Number.isFinite(modelProbability) ? modelProbability : null,
        fairOddsAmerican: prediction && Number.isFinite(Number(prediction.fairOddsAmerican)) ? Number(prediction.fairOddsAmerican) : null,
        edgeAtBest,
        edgeAtConsensus,
        bestLift,
        oddsSpreadAmerican: Number.isFinite(Number(best.oddsAmerican)) && Number.isFinite(Number(worst.oddsAmerican))
          ? Number(best.oddsAmerican) - Number(worst.oddsAmerican)
          : null,
        latestOddsAt,
        latestAgeDays: dateAgeDays(latestOddsAt, generatedAt),
        status: status.key,
        statusLabel: status.label,
        sourceProvider: cleanString(best.sourceProvider || rows[0].sourceProvider),
        sourceUrl: cleanString(best.sourceUrl || rows[0].sourceUrl)
      };
    }).sort((a, b) =>
      (Number.isFinite(b.edgeAtBest) ? b.edgeAtBest : -999) - (Number.isFinite(a.edgeAtBest) ? a.edgeAtBest : -999) ||
      b.bestLift - a.bestLift ||
      b.bookCount - a.bookCount ||
      cleanString(a.playerName).localeCompare(cleanString(b.playerName))
    );

    const markets = new Map();
    const books = new Map();
    const players = new Set();
    lineRows.forEach((row) => {
      const marketKeyValue = row.marketKey || "market";
      if (!markets.has(marketKeyValue)) {
        markets.set(marketKeyValue, {
          market: row.market,
          marketKey: marketKeyValue,
          label: row.marketLabel,
          lines: 0,
          players: new Set(),
          books: new Set(),
          bestEdges: 0,
          avgBestLift: 0,
          maxBestLift: 0,
          latestOddsAt: ""
        });
      }
      const marketRow = markets.get(marketKeyValue);
      marketRow.lines += 1;
      marketRow.players.add(row.playerId || row.playerName);
      row.books.forEach((book) => marketRow.books.add(book));
      marketRow.bestEdges += row.status === "edge" ? 1 : 0;
      marketRow.maxBestLift = Math.max(marketRow.maxBestLift, row.bestLift || 0);
      marketRow.latestOddsAt = latestDate([marketRow.latestOddsAt, row.latestOddsAt]);
      if (row.playerId || row.playerName) players.add(row.playerId || row.playerName);
      row.books.forEach((book) => {
        if (!books.has(book)) {
          books.set(book, { book, lines: 0, markets: new Set(), players: new Set(), latestOddsAt: "" });
        }
        const bookRow = books.get(book);
        bookRow.lines += 1;
        bookRow.markets.add(marketKeyValue);
        if (row.playerId || row.playerName) bookRow.players.add(row.playerId || row.playerName);
        bookRow.latestOddsAt = latestDate([bookRow.latestOddsAt, row.latestOddsAt]);
      });
    });

    const marketRows = [...markets.values()].map((row) => {
      const rows = lineRows.filter((line) => line.marketKey === row.marketKey);
      return {
        ...row,
        players: row.players.size,
        books: [...row.books].sort((a, b) => a.localeCompare(b)),
        bookCount: row.books.size,
        avgBestLift: average(rows.map((line) => line.bestLift || 0)),
        latestAgeDays: dateAgeDays(row.latestOddsAt, generatedAt)
      };
    }).sort((a, b) =>
      b.bestEdges - a.bestEdges ||
      b.maxBestLift - a.maxBestLift ||
      b.lines - a.lines ||
      cleanString(a.label).localeCompare(cleanString(b.label))
    );
    const bookRows = [...books.values()].map((row) => ({
      book: row.book,
      lines: row.lines,
      markets: row.markets.size,
      players: row.players.size,
      latestOddsAt: row.latestOddsAt,
      latestAgeDays: dateAgeDays(row.latestOddsAt, generatedAt),
      freshness: freshnessStatus(dateAgeDays(row.latestOddsAt, generatedAt))
    })).sort((a, b) =>
      b.lines - a.lines ||
      cleanString(b.latestOddsAt).localeCompare(cleanString(a.latestOddsAt)) ||
      cleanString(a.book).localeCompare(cleanString(b.book))
    );
    const latestOddsAt = latestDate(lineRows.map((row) => row.latestOddsAt));
    const liftValues = lineRows.map((row) => row.bestLift).filter(Number.isFinite);
    return {
      generatedAt,
      selectedEvent: {
        eventId,
        name: selectedEvent.name || eventId,
        startDate: selectedEvent.startDate,
        courseName: selectedEvent.courseName,
        tour: selectedEvent.tour
      },
      summary: {
        players: players.size,
        lines: lineRows.length,
        markets: marketRows.length,
        books: bookRows.length,
        bestEdges: lineRows.filter((row) => row.status === "edge").length,
        avgBestLift: average(liftValues),
        maxBestLift: liftValues.length ? Math.max(...liftValues) : 0,
        latestOddsAt,
        latestAgeDays: dateAgeDays(latestOddsAt, generatedAt),
        staleBooks: bookRows.filter((row) => row.freshness === "stale").length
      },
      marketRows,
      bookRows,
      lineRows,
      rows: lineRows.slice(0, maxRows),
      warnings: eventOdds.length ? [] : ["Import odds snapshots from two or more books to compare prices."]
    };
  }

  function buildWarehouseValidation(input) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const issues = [];
    const collections = GolfLab.COLLECTION_KEYS.map((key) => {
      const rows = lab[key] || [];
      const requirements = VALIDATION_REQUIREMENTS[key] || [["id"]];
      const seenIds = new Set();
      const duplicateIds = new Set();
      rows.forEach((row) => {
        const id = cleanString(row && row.id);
        if (!id) return;
        if (seenIds.has(id)) duplicateIds.add(id);
        seenIds.add(id);
      });
      const missingByField = {};
      let completeChecks = 0;
      let totalChecks = rows.length * requirements.length;
      rows.forEach((row) => {
        requirements.forEach((fields) => {
          if (fieldGroupComplete(row, fields)) {
            completeChecks += 1;
            return;
          }
          const label = fieldGroupLabel(fields);
          missingByField[label] = (missingByField[label] || 0) + 1;
        });
      });
      if (!rows.length) totalChecks = 0;
      const completeness = pct(ratio(completeChecks, totalChecks));
      const missingChecks = Math.max(0, totalChecks - completeChecks);
      const status = !rows.length
        ? "empty"
        : duplicateIds.size > 0 || completeness < 80
          ? "issue"
          : completeness < 95
            ? "watch"
            : "clean";
      const collection = {
        key,
        label: key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase()),
        rowCount: rows.length,
        requiredChecks: totalChecks,
        missingChecks,
        completeness,
        duplicateIds: duplicateIds.size,
        duplicateSamples: [...duplicateIds].slice(0, 3),
        missingByField,
        status
      };
      if (rows.length && duplicateIds.size) {
        issues.push({
          severity: "high",
          collection: key,
          label: `${collection.label} duplicate IDs`,
          detail: `${duplicateIds.size} duplicate id${duplicateIds.size === 1 ? "" : "s"} found: ${collection.duplicateSamples.join(", ")}.`
        });
      }
      if (rows.length && completeness < 95) {
        const topMissing = Object.entries(missingByField)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([field, count]) => `${field} (${count})`)
          .join(", ");
        issues.push({
          severity: completeness < 80 ? "high" : "medium",
          collection: key,
          label: `${collection.label} required fields`,
          detail: `${completeness}% complete${topMissing ? `; missing ${topMissing}` : ""}.`
        });
      }
      return collection;
    });
    const populated = collections.filter((row) => row.rowCount > 0);
    const score = populated.length ? pct(average(populated.map((row) => row.completeness / 100))) : 0;
    return {
      score,
      issueCount: issues.length,
      highIssueCount: issues.filter((issue) => issue.severity === "high").length,
      watchCollectionCount: collections.filter((row) => row.status === "watch").length,
      issueCollectionCount: collections.filter((row) => row.status === "issue").length,
      collections,
      issues: issues.sort((a, b) => {
        const severityRank = { high: 0, medium: 1, low: 2 };
        return (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) ||
          cleanString(a.collection).localeCompare(cleanString(b.collection)) ||
          cleanString(a.label).localeCompare(cleanString(b.label));
      })
    };
  }

  function buildSourceFreshness(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const now = cleanString(options.now || options.generatedAt) || new Date().toISOString();
    const sourceAuditRows = lab.sourceFetches.map((row) => ({
      provider: row.provider || row.sourceProvider || "Unknown",
      endpoint: row.endpoint || "manual-import",
      fetchedAt: row.fetchedAt || row.sourceUpdatedAt || "",
      status: row.status || "ok",
      rowCount: Number.isFinite(row.rowCount) ? row.rowCount : 0,
      sourceUrl: row.sourceUrl || ""
    }));
    const providerMap = new Map();
    sourceAuditRows.forEach((row) => {
      const provider = row.provider || "Unknown";
      if (!providerMap.has(provider)) {
        providerMap.set(provider, {
          provider,
          fetches: 0,
          rowCount: 0,
          endpoints: new Set(),
          dates: [],
          statuses: new Set(),
          sourceUrls: new Set()
        });
      }
      const entry = providerMap.get(provider);
      entry.fetches += 1;
      entry.rowCount += Number.isFinite(row.rowCount) ? row.rowCount : 0;
      if (row.endpoint) entry.endpoints.add(row.endpoint);
      if (row.fetchedAt) entry.dates.push(row.fetchedAt);
      if (row.status) entry.statuses.add(row.status);
      if (row.sourceUrl) entry.sourceUrls.add(row.sourceUrl);
    });

    const providers = [...providerMap.values()].map((entry) => {
      const latestAt = latestDate(entry.dates);
      const latestAgeDays = dateAgeDays(latestAt, now);
      const sourceStatus = freshnessStatus(latestAgeDays);
      const fetchStatus = [...entry.statuses].some((status) => !["", "ok", "success", "complete", "completed"].includes(cleanString(status).toLowerCase()))
        ? "review"
        : "ok";
      return {
        provider: entry.provider,
        fetches: entry.fetches,
        rowCount: entry.rowCount,
        latestAt,
        latestAgeDays,
        freshness: sourceStatus,
        status: fetchStatus === "review" ? "review" : sourceStatus,
        endpoints: [...entry.endpoints].slice(0, 4),
        sourceUrl: [...entry.sourceUrls][0] || ""
      };
    }).sort((a, b) =>
      cleanString(b.latestAt).localeCompare(cleanString(a.latestAt)) ||
      b.rowCount - a.rowCount ||
      cleanString(a.provider).localeCompare(cleanString(b.provider))
    );

    const collections = SOURCE_COLLECTION_KEYS.map((key) => {
      const rows = lab[key] || [];
      const sourcedRows = rows.filter(hasSourceMeta).length;
      const dates = rows.map(sourceRowDate).filter(Boolean);
      const latestAt = latestDate(dates);
      const latestAgeDays = dateAgeDays(latestAt, now);
      const freshness = freshnessStatus(latestAgeDays);
      let status = "empty";
      if (rows.length && sourcedRows === 0) status = "unverified";
      else if (rows.length && ratio(sourcedRows, rows.length) < 0.75) status = "partial";
      else if (rows.length) status = freshness;
      return {
        key,
        label: key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase()),
        rowCount: rows.length,
        sourcedRows,
        coverage: pct(ratio(sourcedRows, rows.length)),
        latestAt,
        latestAgeDays,
        freshness,
        status
      };
    });

    const populatedCollections = collections.filter((row) => row.rowCount > 0);
    const auditedRowCount = populatedCollections.reduce((sum, row) => sum + row.rowCount, 0);
    const sourcedRowCount = populatedCollections.reduce((sum, row) => sum + row.sourcedRows, 0);
    const latestSourceAt = latestDate([
      ...sourceAuditRows.map((row) => row.fetchedAt),
      ...collections.map((row) => row.latestAt)
    ]);
    const latestSourceAgeDays = dateAgeDays(latestSourceAt, now);
    const latestStatus = freshnessStatus(latestSourceAgeDays);
    const providerScore = providers.length ? average(providers.map((row) => freshnessScore(row.freshness))) : 0;
    const collectionCoverageScore = populatedCollections.length ? average(populatedCollections.map((row) => row.coverage / 100)) : 0;
    const sourceLedgerScore = lab.sourceFetches.length ? 1 : 0;
    const qualityScore = pct((sourceLedgerScore * 0.35) + (collectionCoverageScore * 0.40) + (providerScore * 0.25));

    return {
      generatedAt: now,
      latestSourceAt,
      latestSourceAgeDays,
      latestStatus,
      providerCount: providers.length,
      staleProviderCount: providers.filter((row) => row.freshness === "stale").length,
      reviewProviderCount: providers.filter((row) => row.status === "review").length,
      collectionCount: populatedCollections.length,
      staleCollectionCount: collections.filter((row) => row.status === "stale").length,
      unverifiedCollectionCount: collections.filter((row) => row.status === "unverified").length,
      auditedRowCount,
      sourcedRowCount,
      provenanceCoverage: pct(ratio(sourcedRowCount, auditedRowCount)),
      qualityScore,
      providers,
      collections
    };
  }

  function sourceFetchCollectionHints(row) {
    const haystack = [
      row && row.id,
      row && row.endpoint,
      row && row.sourceUrl,
      row && row.provider
    ].map(cleanString).join(" ").toLowerCase();
    return SOURCE_COLLECTION_KEYS.filter((key) => {
      const label = key.replace(/([A-Z])/g, "-$1").toLowerCase();
      const compact = key.toLowerCase();
      const alias = COLLECTION_FILE_ALIASES[compact] || "";
      return haystack.includes(compact) ||
        haystack.includes(label) ||
        haystack.includes(label.replace(/-/g, "_")) ||
        (alias && haystack.includes(alias));
    });
  }

  function sourceFetchEventMatches(row, event) {
    if (!event) return false;
    const needles = [event.id, event.name, event.courseName]
      .map(cleanString)
      .filter(Boolean)
      .map((value) => value.toLowerCase());
    if (!needles.length) return false;
    const haystack = [
      row && row.id,
      row && row.endpoint,
      row && row.sourceUrl,
      row && row.provider
    ].map(cleanString).join(" ").toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  }

  function collectionSourceProviders(rows) {
    const providers = new Map();
    rows.forEach((row) => {
      const provider = cleanString(row.sourceProvider || row.provider) || "Unattributed";
      if (!providers.has(provider)) {
        providers.set(provider, { provider, rows: 0, latestAt: "", sourceUrls: new Set() });
      }
      const entry = providers.get(provider);
      entry.rows += 1;
      entry.latestAt = latestDate([entry.latestAt, sourceRowDate(row)]);
      if (row.sourceUrl) entry.sourceUrls.add(row.sourceUrl);
    });
    return [...providers.values()].map((row) => ({
      provider: row.provider,
      rows: row.rows,
      latestAt: row.latestAt,
      sourceUrl: [...row.sourceUrls][0] || ""
    })).sort((a, b) =>
      b.rows - a.rows ||
      cleanString(b.latestAt).localeCompare(cleanString(a.latestAt)) ||
      cleanString(a.provider).localeCompare(cleanString(b.provider))
    );
  }

  function buildSourceLineageBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const now = cleanString(options.now || options.generatedAt) || new Date().toISOString();
    const eventId = cleanString(options.eventId);
    const selectedEvent = eventId
      ? lab.events.find((event) => event.id === eventId || event.name === eventId) || null
      : [...lab.events].sort((a, b) => cleanString(a.startDate).localeCompare(cleanString(b.startDate)))[0] || null;
    const freshness = buildSourceFreshness(lab, { now });
    const collectionRows = SOURCE_COLLECTION_KEYS.map((key) => {
      const rows = lab[key] || [];
      const sourcedRows = rows.filter(hasSourceMeta);
      const sourceFetchRows = lab.sourceFetches.filter((row) => sourceFetchCollectionHints(row).includes(key));
      const providers = collectionSourceProviders(sourcedRows);
      const sourceFetchRowCount = sourceFetchRows.reduce((sum, row) => sum + (Number.isFinite(row.rowCount) ? row.rowCount : 0), 0);
      const latestAt = latestDate([
        ...sourcedRows.map(sourceRowDate),
        ...sourceFetchRows.map((row) => row.fetchedAt || row.sourceUpdatedAt)
      ]);
      const coverage = pct(ratio(sourcedRows.length, rows.length));
      const ledgerCoverage = rows.length ? pct(ratio(sourceFetchRowCount || sourcedRows.length, rows.length)) : 0;
      const proofScore = pct((coverage / 100 * 0.68) + (ledgerCoverage / 100 * 0.22) + (sourceFetchRows.length ? 0.10 : 0));
      let status = "empty";
      if (rows.length && proofScore >= 85) status = "verified";
      else if (rows.length && proofScore >= 60) status = "linked";
      else if (rows.length && proofScore >= 25) status = "partial";
      else if (rows.length) status = "untraced";
      return {
        key,
        label: key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase()),
        role: COLLECTION_ROLES[key] || "Warehouse",
        rowCount: rows.length,
        sourcedRows: sourcedRows.length,
        coverage,
        sourceFetches: sourceFetchRows.length,
        sourceFetchRowCount,
        ledgerCoverage,
        latestAt,
        ageDays: dateAgeDays(latestAt, now),
        proofScore,
        status,
        providers: providers.slice(0, 4),
        topProvider: providers[0] || null,
        gaps: [
          rows.length && !sourcedRows.length ? "No row source metadata" : "",
          rows.length && !sourceFetchRows.length ? "No matching source_fetches row" : "",
          rows.length && coverage < 75 ? "Partial row provenance" : "",
          rows.length && Number.isFinite(dateAgeDays(latestAt, now)) && dateAgeDays(latestAt, now) > 10 ? "Stale latest source" : ""
        ].filter(Boolean)
      };
    });

    const eventRows = lab.events.map((event) => {
      const eventNeedles = [event.id, event.name, event.courseName].map(cleanString).filter(Boolean);
      const eventSourceFetches = lab.sourceFetches.filter((row) => sourceFetchEventMatches(row, event));
      const eventCollections = {
        fields: lab.fields.filter((row) => row.eventId === event.id),
        rounds: lab.rounds.filter((row) => row.eventId === event.id),
        strokesGained: lab.strokesGained.filter((row) => row.eventId === event.id),
        weatherSnapshots: lab.weatherSnapshots.filter((row) => row.eventId === event.id),
        oddsSnapshots: lab.oddsSnapshots.filter((row) => row.eventId === event.id),
        courseSetups: lab.courseSetups.filter((row) => row.eventId === event.id),
        eventCourses: lab.eventCourses.filter((row) => row.eventId === event.id)
      };
      const linkedRows = Object.values(eventCollections).flat();
      const sourcedRows = linkedRows.filter(hasSourceMeta);
      const latestAt = latestDate([
        sourceRowDate(event),
        ...linkedRows.map(sourceRowDate),
        ...eventSourceFetches.map((row) => row.fetchedAt || row.sourceUpdatedAt)
      ]);
      const collectionCount = Object.values(eventCollections).filter((rows) => rows.length).length;
      const coverage = pct(ratio(sourcedRows.length, linkedRows.length));
      const proofScore = pct(
        (hasSourceMeta(event) ? 0.16 : 0) +
        (eventSourceFetches.length ? 0.24 : 0) +
        (coverage / 100 * 0.38) +
        (collectionCount / 7 * 0.22)
      );
      let status = "setup";
      if (proofScore >= 82) status = "verified";
      else if (proofScore >= 62) status = "linked";
      else if (proofScore >= 35) status = "partial";
      else if (linkedRows.length || eventSourceFetches.length) status = "thin";
      return {
        eventId: event.id,
        eventName: event.name || event.id,
        startDate: event.startDate,
        courseName: event.courseName,
        sourceFetches: eventSourceFetches.length,
        linkedRows: linkedRows.length,
        sourcedRows: sourcedRows.length,
        collectionCount,
        coverage,
        latestAt,
        ageDays: dateAgeDays(latestAt, now),
        proofScore,
        status,
        providers: [...new Set([
          cleanString(event.sourceProvider || event.provider),
          ...eventSourceFetches.map((row) => cleanString(row.provider || row.sourceProvider)),
          ...linkedRows.map((row) => cleanString(row.sourceProvider || row.provider))
        ].filter(Boolean))].sort(),
        gaps: [
          !hasSourceMeta(event) ? "Event source metadata" : "",
          !eventSourceFetches.length ? "Event source_fetches row" : "",
          linkedRows.length && coverage < 75 ? "Linked row provenance" : "",
          !eventCollections.fields.length ? "Field lineage" : "",
          !eventCollections.rounds.length ? "Round lineage" : "",
          !eventCollections.weatherSnapshots.length ? "Weather lineage" : "",
          !eventCollections.oddsSnapshots.length ? "Odds lineage" : ""
        ].filter(Boolean),
        eventNeedles
      };
    }).sort((a, b) =>
      (selectedEvent && a.eventId === selectedEvent.id ? -1 : 0) - (selectedEvent && b.eventId === selectedEvent.id ? -1 : 0) ||
      b.proofScore - a.proofScore ||
      cleanString(a.startDate).localeCompare(cleanString(b.startDate))
    );

    const providerRows = freshness.providers.map((provider) => {
      const collections = collectionRows.filter((row) =>
        row.providers.some((item) => item.provider === provider.provider) ||
        lab.sourceFetches.some((fetch) =>
          cleanString(fetch.provider || fetch.sourceProvider) === provider.provider &&
          sourceFetchCollectionHints(fetch).includes(row.key)
        )
      );
      const events = eventRows.filter((event) => event.providers.includes(provider.provider));
      return {
        provider: provider.provider,
        status: provider.status,
        freshness: provider.freshness,
        latestAt: provider.latestAt,
        latestAgeDays: provider.latestAgeDays,
        rowCount: provider.rowCount,
        fetches: provider.fetches,
        collections: collections.map((row) => row.key),
        events: events.map((row) => row.eventId),
        endpoints: provider.endpoints || [],
        sourceUrl: provider.sourceUrl || ""
      };
    }).sort((a, b) =>
      b.events.length - a.events.length ||
      b.collections.length - a.collections.length ||
      b.rowCount - a.rowCount ||
      cleanString(a.provider).localeCompare(cleanString(b.provider))
    );

    const populatedCollections = collectionRows.filter((row) => row.rowCount > 0);
    const selectedEventRow = selectedEvent ? eventRows.find((row) => row.eventId === selectedEvent.id) || null : null;
    const criticalCollections = ["events", "courses", "courseSetups", "eventCourses", "fields", "rounds", "strokesGained", "weatherSnapshots", "oddsSnapshots"];
    const criticalCollectionRows = collectionRows.filter((row) => criticalCollections.includes(row.key) && row.rowCount > 0);
    const proofScore = pct(
      ((freshness.qualityScore || 0) / 100 * 0.28) +
      (average(populatedCollections.map((row) => row.proofScore)) / 100 * 0.28) +
      (average(criticalCollectionRows.map((row) => row.proofScore)) / 100 * 0.22) +
      ((selectedEventRow ? selectedEventRow.proofScore : average(eventRows.map((row) => row.proofScore))) / 100 * 0.22)
    );
    const blockers = [
      !lab.sourceFetches.length ? { severity: "high", label: "Source ledger missing", detail: "Import source_fetches rows to trace owned research." } : null,
      populatedCollections.some((row) => row.status === "untraced") ? { severity: "high", label: "Untraced collections", detail: `${populatedCollections.filter((row) => row.status === "untraced").length} populated collections have no source chain.` } : null,
      selectedEventRow && selectedEventRow.proofScore < 60 ? { severity: "medium", label: "Selected event lineage", detail: `${selectedEventRow.eventName} is only ${selectedEventRow.proofScore}% traced.` } : null,
      freshness.provenanceCoverage < 70 && freshness.auditedRowCount ? { severity: "medium", label: "Row provenance", detail: `${freshness.provenanceCoverage}% of populated rows carry source metadata.` } : null
    ].filter(Boolean);

    return {
      generatedAt: now,
      selectedEvent: selectedEventRow,
      summary: {
        proofScore,
        status: proofScore >= 85 ? "verified" : proofScore >= 65 ? "linked" : proofScore >= 40 ? "partial" : "thin",
        providers: providerRows.length,
        sourceFetches: lab.sourceFetches.length,
        populatedCollections: populatedCollections.length,
        verifiedCollections: collectionRows.filter((row) => row.status === "verified").length,
        linkedEvents: eventRows.filter((row) => row.status === "verified" || row.status === "linked").length,
        eventCount: eventRows.length,
        provenanceCoverage: freshness.provenanceCoverage,
        latestSourceAt: freshness.latestSourceAt,
        latestSourceAgeDays: freshness.latestSourceAgeDays,
        blockers: blockers.length
      },
      blockers,
      providerRows,
      collectionRows,
      eventRows,
      freshness
    };
  }

  function buildScoreParts(lab, counts, coverage, sourceFreshness) {
    const core = [
      counts.players > 0,
      counts.events > 0,
      counts.courses > 0,
      counts.fields > 0
    ].filter(Boolean).length / 4;
    const matching = (
      coverage.fieldPlayerMatch +
      coverage.roundPlayerMatch +
      coverage.roundCourseMatch +
      coverage.eventCourseMatch
    ) / 4;
    const scoring = (coverage.eventScoring + ratio(counts.strokesGained, Math.max(1, counts.players))) / 2;
    const market = coverage.eventOdds;
    const weather = coverage.eventWeather;
    const sources = sourceFreshness ? sourceFreshness.qualityScore / 100 : (counts.sourceFetches > 0 ? 1 : 0);
    const enrichment = [
      counts.equipmentSnapshots > 0,
      counts.accomplishments > 0,
      counts.courseSetups > 0
    ].filter(Boolean).length / 3;
    return { core, matching, scoring, market, weather, sources, enrichment };
  }

  function buildGaps(lab, counts, coverage, rows, sourceFreshness, validation) {
    const gaps = [];
    function add(severity, label, detail) {
      gaps.push({ severity, label, detail });
    }
    if (!counts.players) add("critical", "Players missing", "Import player rows before building scorecards or fields.");
    if (!counts.events) add("critical", "Events missing", "Import tournament schedule rows to anchor fields, rounds, weather, and odds.");
    if (!counts.courses) add("critical", "Courses missing", "Import course profiles so difficulty and course-fit splits can work.");
    if (!counts.fields) add("high", "Fields missing", "Import field rows for upcoming tournaments before running predictions.");
    if (!counts.rounds) add("high", "Round history missing", "Import historical scorecards or strokes-gained rows for form and course splits.");
    if (counts.fields && coverage.fieldPlayerMatch < 0.95) add("high", "Field-player matching", `${pct(coverage.fieldPlayerMatch)}% of field rows match an imported player.`);
    if (counts.rounds && coverage.roundPlayerMatch < 0.95) add("medium", "Round-player matching", `${pct(coverage.roundPlayerMatch)}% of round rows match an imported player.`);
    if (counts.rounds && coverage.roundCourseMatch < 0.85) add("medium", "Round-course matching", `${pct(coverage.roundCourseMatch)}% of round rows match an imported course.`);
    if (counts.events && coverage.eventWeather < 0.5) add("medium", "Weather coverage", `${pct(coverage.eventWeather)}% of events have weather snapshots.`);
    if (counts.events && coverage.eventOdds < 0.5) add("medium", "Market coverage", `${pct(coverage.eventOdds)}% of events have odds snapshots.`);
    if (!counts.sourceFetches) add("medium", "Source audit missing", "Import files should include provider/source rows for traceability.");
    if (sourceFreshness && counts.sourceFetches && sourceFreshness.latestStatus === "stale") {
      add("medium", "Source freshness", `Latest source refresh is ${sourceFreshness.latestSourceAgeDays} days old.`);
    }
    if (sourceFreshness && sourceFreshness.auditedRowCount && sourceFreshness.provenanceCoverage < 50) {
      add("medium", "Collection provenance", `${sourceFreshness.provenanceCoverage}% of populated warehouse rows carry source metadata.`);
    }
    if (validation && validation.highIssueCount) {
      add("high", "Validation issues", `${validation.highIssueCount} high-priority row validation issue${validation.highIssueCount === 1 ? "" : "s"} detected.`);
    } else if (validation && validation.issueCount) {
      add("medium", "Validation watchlist", `${validation.issueCount} row validation issue${validation.issueCount === 1 ? "" : "s"} detected.`);
    }
    const topEvent = rows[0];
    if (topEvent && topEvent.readinessScore < 84) add("high", "No model-ready event", "The best event still needs field, course, scoring, weather, and market coverage.");
    return gaps;
  }

  function readinessFromScore(score) {
    if (score >= 85) return { status: "premium-ready", label: "Premium ready" };
    if (score >= 70) return { status: "model-ready", label: "Model ready" };
    if (score >= 45) return { status: "building", label: "Building" };
    return { status: "thin", label: "Thin" };
  }

  function collectionCoverageStatus(rowCount, validation, source) {
    if (!rowCount) return "empty";
    if (validation && validation.status === "issue") return "issue";
    if (source && ["stale", "unverified", "partial"].includes(source.status)) return source.status;
    if (validation && validation.status === "watch") return "watch";
    return "ready";
  }

  function collectionCoverageLabel(status) {
    return {
      empty: "Empty",
      issue: "Issue",
      stale: "Stale",
      unverified: "Unverified",
      partial: "Partial",
      watch: "Watch",
      ready: "Ready"
    }[status] || "Review";
  }

  function buildCoverageCollectionRows(report) {
    const freshnessRows = new Map(((report.sourceFreshness && report.sourceFreshness.collections) || []).map((row) => [row.key, row]));
    const validationRows = new Map(((report.validation && report.validation.collections) || []).map((row) => [row.key, row]));
    return GolfLab.COLLECTION_KEYS.map((key) => {
      const source = freshnessRows.get(key) || {};
      const validation = validationRows.get(key) || {};
      const rowCount = (report.counts && report.counts[key]) || 0;
      const sourceScore = freshnessScore(source.freshness || source.status);
      const completeness = Number.isFinite(validation.completeness) ? validation.completeness : 0;
      const provenance = Number.isFinite(source.coverage) ? source.coverage : 0;
      const score = rowCount
        ? pct((0.30) + (completeness / 100 * 0.30) + (provenance / 100 * 0.25) + (sourceScore * 0.15))
        : 0;
      const status = collectionCoverageStatus(rowCount, validation, source);
      return {
        key,
        label: key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase()),
        role: COLLECTION_ROLES[key] || "Other",
        rowCount,
        score,
        status,
        statusLabel: collectionCoverageLabel(status),
        completeness,
        missingChecks: validation.missingChecks || 0,
        duplicateIds: validation.duplicateIds || 0,
        sourceCoverage: provenance,
        latestAt: source.latestAt || "",
        latestAgeDays: source.latestAgeDays,
        freshness: source.freshness || "unknown"
      };
    }).sort((a, b) =>
      (a.rowCount ? 0 : 1) - (b.rowCount ? 0 : 1) ||
      a.score - b.score ||
      cleanString(a.role).localeCompare(cleanString(b.role)) ||
      cleanString(a.label).localeCompare(cleanString(b.label))
    );
  }

  function buildCoveragePlayerRows(lab, options = {}) {
    const allPredictions = [...lab.modelPredictions, ...lab.predictionLedger];
    const rows = lab.players.map((player) => {
      const aliases = lowerSet(playerAliases(player));
      const fieldRows = lab.fields.filter((row) => rowMatchesAliases(row, aliases));
      const rounds = lab.rounds.filter((row) => rowMatchesAliases(row, aliases));
      const sgRows = lab.strokesGained.filter((row) => rowMatchesAliases(row, aliases));
      const oddsRows = lab.oddsSnapshots.filter((row) => rowMatchesAliases(row, aliases));
      const predictionRows = allPredictions.filter((row) => rowMatchesAliases(row, aliases));
      const equipmentRows = lab.equipmentSnapshots.filter((row) => rowMatchesAliases(row, aliases));
      const accomplishmentRows = lab.accomplishments.filter((row) => rowMatchesAliases(row, aliases));
      const proofRows = [
        player,
        ...fieldRows,
        ...rounds,
        ...sgRows,
        ...oddsRows,
        ...equipmentRows,
        ...accomplishmentRows
      ].filter(Boolean);
      const sourceProofRows = proofRows.filter(hasSourceMeta).length;
      const sourceProofPct = proofRows.length ? pct(ratio(sourceProofRows, proofRows.length)) : 0;
      const courseCount = uniqueSorted(rounds.map((row) => row.courseId || row.courseName)).length;
      const eventCount = uniqueSorted(fieldRows.map((row) => row.eventId)).length;
      const profileFields = [
        player.name,
        player.country,
        player.tour,
        player.owgrRank,
        player.profileUrl,
        player.photoUrl,
        player.sourceProvider || player.sourceUrl
      ];
      const profileScore = pct(ratio(profileFields.filter(hasValue).length, profileFields.length));
      const fieldScore = Math.min(100, fieldRows.length * 35);
      const formScore = Math.round(Math.min(1, rounds.length / 16) * 55 + Math.min(1, sgRows.length / 8) * 45);
      const courseScore = Math.min(100, courseCount * 18);
      const marketScore = oddsRows.length ? 100 : 0;
      const modelScore = predictionRows.length ? 100 : 0;
      const enrichmentScore = Math.min(100,
        (equipmentRows.length ? 35 : 0) +
        (accomplishmentRows.length ? 30 : 0) +
        Math.round(sourceProofPct * 0.35)
      );
      const score = Math.round(
        profileScore * 0.16 +
        fieldScore * 0.09 +
        formScore * 0.28 +
        courseScore * 0.15 +
        marketScore * 0.08 +
        modelScore * 0.08 +
        enrichmentScore * 0.10 +
        sourceProofPct * 0.06
      );
      const readiness = readinessFromScore(score);
      const gaps = [
        profileScore < 70 ? "Profile metadata" : "",
        formScore < 60 ? "Round/SG history" : "",
        courseScore < 45 ? "Course sample" : "",
        !oddsRows.length ? "Market odds" : "",
        !predictionRows.length ? "Model run" : "",
        enrichmentScore < 45 ? "Equipment/accomplishments" : "",
        sourceProofPct < 50 ? "Source proof" : ""
      ].filter(Boolean);
      return {
        playerId: player.id,
        playerName: player.name || player.id,
        country: player.country,
        tour: player.tour,
        score,
        status: readiness.status,
        statusLabel: readiness.label,
        gaps,
        counts: {
          fields: fieldRows.length,
          events: eventCount,
          rounds: rounds.length,
          strokesGainedRows: sgRows.length,
          courses: courseCount,
          oddsRows: oddsRows.length,
          predictions: predictionRows.length,
          equipmentSnapshots: equipmentRows.length,
          accomplishments: accomplishmentRows.length
        },
        parts: {
          profile: profileScore,
          field: fieldScore,
          form: formScore,
          course: courseScore,
          market: marketScore,
          model: modelScore,
          enrichment: enrichmentScore,
          sources: sourceProofPct
        },
        sourceProofPct
      };
    }).sort((a, b) =>
      a.score - b.score ||
      b.gaps.length - a.gaps.length ||
      cleanString(a.playerName).localeCompare(cleanString(b.playerName))
    );
    const limit = Math.max(1, Number(options.playerLimit) || 8);
    return {
      rows: rows.slice(0, limit),
      allRows: rows
    };
  }

  function buildCoverageCourseRows(lab, options = {}) {
    const rows = lab.courses.map((course) => {
      const events = lab.events.filter((row) => rowMatchesCourse(row, course));
      const setups = lab.courseSetups.filter((row) => rowMatchesCourse(row, course));
      const rounds = lab.rounds.filter((row) => rowMatchesCourse(row, course));
      const weatherRows = lab.weatherSnapshots.filter((row) =>
        rowMatchesCourse(row, course) ||
        events.some((event) => cleanString(event.id) && cleanString(row.eventId) === cleanString(event.id))
      );
      const proofRows = [course, ...events, ...setups, ...rounds, ...weatherRows].filter(Boolean);
      const sourceProofRows = proofRows.filter(hasSourceMeta).length;
      const sourceProofPct = proofRows.length ? pct(ratio(sourceProofRows, proofRows.length)) : 0;
      const playerCount = uniqueSorted(rounds.map((row) => row.playerId || row.playerName)).length;
      const profileFields = [
        course.name,
        course.location,
        course.par,
        course.yards,
        course.rating || course.slope,
        course.fieldAdjustedToPar || course.sgDifficulty,
        course.style,
        course.sourceProvider || course.sourceUrl
      ];
      const profileScore = pct(ratio(profileFields.filter(hasValue).length, profileFields.length));
      const eventScore = Math.min(100, events.length * 35);
      const setupScore = setups.length ? 100 : 0;
      const scoringScore = Math.min(100, Math.round(Math.min(1, rounds.length / 24) * 70 + Math.min(1, playerCount / 8) * 30));
      const weatherScore = Math.min(100, weatherRows.length * 35);
      const score = Math.round(
        profileScore * 0.24 +
        eventScore * 0.12 +
        setupScore * 0.14 +
        scoringScore * 0.26 +
        weatherScore * 0.12 +
        sourceProofPct * 0.12
      );
      const readiness = readinessFromScore(score);
      const gaps = [
        profileScore < 70 ? "Course profile" : "",
        !setups.length ? "Tournament setup" : "",
        scoringScore < 55 ? "Round history" : "",
        weatherScore < 45 ? "Weather snapshots" : "",
        sourceProofPct < 50 ? "Source proof" : ""
      ].filter(Boolean);
      return {
        courseId: course.id,
        courseName: course.name || course.id,
        location: course.location,
        score,
        status: readiness.status,
        statusLabel: readiness.label,
        gaps,
        counts: {
          events: events.length,
          setups: setups.length,
          rounds: rounds.length,
          players: playerCount,
          weatherSnapshots: weatherRows.length
        },
        parts: {
          profile: profileScore,
          events: eventScore,
          setups: setupScore,
          scoring: scoringScore,
          weather: weatherScore,
          sources: sourceProofPct
        },
        sourceProofPct
      };
    }).sort((a, b) =>
      a.score - b.score ||
      b.gaps.length - a.gaps.length ||
      cleanString(a.courseName).localeCompare(cleanString(b.courseName))
    );
    const limit = Math.max(1, Number(options.courseLimit) || 6);
    return {
      rows: rows.slice(0, limit),
      allRows: rows
    };
  }

  function eventCoverageGaps(row) {
    return [
      !row.fieldCount ? "Field" : "",
      row.fieldCount && row.matchedFieldPlayers < row.fieldCount ? "Player matching" : "",
      !row.hasCourse ? "Course profile" : "",
      !row.hasScoring ? "Scoring" : "",
      !row.weatherSnapshots ? "Weather" : "",
      !row.hasMarket ? "Markets" : ""
    ].filter(Boolean);
  }

  function buildWarehouseCoverageMap(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const generatedAt = cleanString(options.now || options.generatedAt) || new Date().toISOString();
    const report = buildWarehouseReport(lab, { ...options, now: generatedAt });
    const collectionRows = buildCoverageCollectionRows(report);
    const playerCoverage = buildCoveragePlayerRows(lab, options);
    const courseCoverage = buildCoverageCourseRows(lab, options);
    const eventLimit = Math.max(1, Number(options.eventLimit) || 6);
    const eventRowsForMap = report.events.map((row) => ({
      ...row,
      status: row.readiness === "model-ready" ? "model-ready" : row.readinessScore >= 50 ? "building" : "thin",
      statusLabel: row.readiness === "model-ready" ? "Model ready" : row.readinessScore >= 50 ? "Building" : "Thin",
      gaps: eventCoverageGaps(row)
    })).sort((a, b) =>
      a.readinessScore - b.readinessScore ||
      b.gaps.length - a.gaps.length ||
      cleanString(a.startDate).localeCompare(cleanString(b.startDate)) ||
      cleanString(a.name).localeCompare(cleanString(b.name))
    );
    const blockers = [
      ...report.gaps.filter((gap) => gap.severity === "critical" || gap.severity === "high"),
      ...((report.validation && report.validation.issues) || []).filter((issue) => issue.severity === "high")
    ].slice(0, 8);
    const weakCollection = collectionRows.find((row) => row.rowCount > 0 && row.status !== "ready") ||
      collectionRows.find((row) => row.rowCount === 0 && ["Core", "Field", "Scoring"].includes(row.role)) ||
      collectionRows[0] ||
      null;
    const weakPlayer = playerCoverage.allRows[0] || null;
    const weakCourse = courseCoverage.allRows[0] || null;
    const nextActions = [
      ...blockers.map((row) => ({
        severity: row.severity || "high",
        label: row.label,
        detail: row.detail
      })),
      weakCollection ? {
        severity: weakCollection.rowCount ? "medium" : "high",
        label: `${weakCollection.label} coverage`,
        detail: `${weakCollection.statusLabel} | ${weakCollection.rowCount} rows | ${weakCollection.sourceCoverage}% sourced`
      } : null,
      weakPlayer ? {
        severity: weakPlayer.status === "thin" ? "medium" : "low",
        label: `${weakPlayer.playerName} profile depth`,
        detail: weakPlayer.gaps.slice(0, 3).join(", ") || `${weakPlayer.score}% ready`
      } : null,
      weakCourse ? {
        severity: weakCourse.status === "thin" ? "medium" : "low",
        label: `${weakCourse.courseName} course depth`,
        detail: weakCourse.gaps.slice(0, 3).join(", ") || `${weakCourse.score}% ready`
      } : null
    ].filter(Boolean).slice(0, 8);

    return {
      version: WAREHOUSE_VERSION,
      generatedAt,
      score: report.score,
      grade: report.grade,
      totalRecords: report.totalRecords,
      summary: {
        populatedCollections: collectionRows.filter((row) => row.rowCount > 0).length,
        readyCollections: collectionRows.filter((row) => row.status === "ready").length,
        modelReadyEvents: report.modelReadyEvents.length,
        eventCount: report.events.length,
        modelReadyPlayers: playerCoverage.allRows.filter((row) => row.score >= 70).length,
        premiumPlayers: playerCoverage.allRows.filter((row) => row.score >= 85).length,
        playerCount: playerCoverage.allRows.length,
        modelReadyCourses: courseCoverage.allRows.filter((row) => row.score >= 70).length,
        courseCount: courseCoverage.allRows.length,
        sourceQuality: report.sourceFreshness ? report.sourceFreshness.qualityScore : 0,
        provenanceCoverage: report.sourceFreshness ? report.sourceFreshness.provenanceCoverage : 0,
        validationIssues: report.validation ? report.validation.issueCount : 0,
        blockers: blockers.length
      },
      collectionRows,
      eventRows: eventRowsForMap.slice(0, eventLimit),
      playerRows: playerCoverage.rows,
      courseRows: courseCoverage.rows,
      blockers,
      nextActions,
      report
    };
  }

  function buildWarehouseReport(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const counts = collectionCounts(lab);
    const events = eventRows(lab);
    const coverage = buildCoverage(lab, events);
    const sourceFreshness = buildSourceFreshness(lab, options);
    const validation = buildWarehouseValidation(lab);
    const sourceLineage = buildSourceLineageBoard(lab, options);
    const marketCoverage = buildMarketCoverageBoard(lab, options);
    const oddsMovement = buildOddsMovementBoard(lab, options);
    const oddsShopping = buildOddsShoppingBoard(lab, options);
    const scoreParts = buildScoreParts(lab, counts, coverage, sourceFreshness);
    const score = pct(Object.entries(SCORE_WEIGHTS).reduce((sum, [key, weight]) => sum + (scoreParts[key] || 0) * weight, 0));
    const gaps = buildGaps(lab, counts, coverage, events, sourceFreshness, validation);
    const totalRecords = recordCount(lab);
    const sourceAudit = lab.sourceFetches
      .map((row) => ({
        provider: row.provider || row.sourceProvider || "Unknown",
        endpoint: row.endpoint || "",
        fetchedAt: row.fetchedAt || row.sourceUpdatedAt || "",
        status: row.status || "",
        rowCount: row.rowCount,
        sourceUrl: row.sourceUrl || "",
        ageDays: dateAgeDays(row.fetchedAt || row.sourceUpdatedAt, sourceFreshness.generatedAt),
        freshness: freshnessStatus(dateAgeDays(row.fetchedAt || row.sourceUpdatedAt, sourceFreshness.generatedAt))
      }))
      .sort((a, b) => cleanString(b.fetchedAt).localeCompare(cleanString(a.fetchedAt)))
      .slice(0, 8);
    return {
      version: WAREHOUSE_VERSION,
      score,
      grade: score >= 85 ? "premium" : score >= 65 ? "solid" : totalRecords > 0 ? "building" : "setup",
      counts,
      totalRecords,
      latestSourceAt: sourceFreshness.latestSourceAt,
      coverage,
      scoreParts: Object.fromEntries(Object.entries(scoreParts).map(([key, value]) => [key, pct(value)])),
      events,
      modelReadyEvents: events.filter((event) => event.readiness === "model-ready"),
      gaps,
      sourceAudit,
      sourceFreshness,
      sourceLineage,
      marketCoverage,
      oddsMovement,
      oddsShopping,
      validation
    };
  }

  function collectionLabel(key) {
    return cleanString(key).replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
  }

  function importCollectionDelta(beforeLab, incomingLab, afterLab, key) {
    const beforeRows = beforeLab[key] || [];
    const incomingRows = incomingLab[key] || [];
    const afterRows = afterLab[key] || [];
    const beforeIds = new Set(beforeRows.map((row) => row && row.id).filter(Boolean));
    let added = 0;
    let updated = 0;
    let skipped = 0;
    incomingRows.forEach((row) => {
      const id = row && row.id;
      if (!id) {
        skipped += 1;
      } else if (beforeIds.has(id)) {
        updated += 1;
      } else {
        added += 1;
      }
    });
    return {
      key,
      label: collectionLabel(key),
      before: beforeRows.length,
      incoming: incomingRows.length,
      after: afterRows.length,
      added,
      updated,
      skipped,
      netNew: Math.max(0, afterRows.length - beforeRows.length),
      sourceBacked: incomingRows.filter(hasSourceMeta).length
    };
  }

  function previewVerdict(preview) {
    const incomingRecords = preview.summary.incomingRecords || 0;
    if (!incomingRecords) {
      return {
        status: "empty",
        label: "No import data",
        tone: "blocked",
        detail: "No source-backed Golf Lab rows were found in the import."
      };
    }
    if (preview.validationDelta.highIssueDelta > 0) {
      return {
        status: "review",
        label: "Review before trust",
        tone: "warning",
        detail: `${preview.validationDelta.highIssueDelta} new high-priority validation issue${preview.validationDelta.highIssueDelta === 1 ? "" : "s"} would be introduced.`
      };
    }
    if (preview.summary.scoreDelta < -5) {
      return {
        status: "review",
        label: "Score regression",
        tone: "warning",
        detail: `Warehouse score would move ${preview.summary.scoreBefore} -> ${preview.summary.scoreAfter}.`
      };
    }
    if (preview.summary.sourceCoverageAfter < 50 && preview.summary.incomingRecords > 0) {
      return {
        status: "thin-proof",
        label: "Thin proof",
        tone: "watch",
        detail: `${preview.summary.sourceCoverageAfter}% provenance coverage after import.`
      };
    }
    return {
      status: "ready",
      label: "Import ready",
      tone: "good",
      detail: `${preview.summary.addedRecords} new and ${preview.summary.updatedRecords} updated rows previewed.`
    };
  }

  function buildGolfLabImportPreview(currentInput, incomingPayload, options = {}) {
    const now = cleanString(options.now || options.generatedAt) || new Date().toISOString();
    const beforeLab = GolfLab.normalizeGolfLabState(currentInput);
    const incomingSnapshot = buildGolfLabImportSnapshot(incomingPayload, options.importOptions || options);
    const incomingLab = incomingSnapshot.golfLab;
    const afterLab = GolfLab.mergeGolfLabStates(beforeLab, incomingLab);
    const beforeReport = buildWarehouseReport(beforeLab, { ...options, now });
    const afterReport = buildWarehouseReport(afterLab, { ...options, now });
    const collectionRows = GolfLab.COLLECTION_KEYS.map((key) =>
      importCollectionDelta(beforeLab, incomingLab, afterLab, key)
    );
    const changedRows = collectionRows.filter((row) => row.incoming > 0 || row.added > 0 || row.updated > 0 || row.skipped > 0);
    const beforeValidation = beforeReport.validation || {};
    const afterValidation = afterReport.validation || {};
    const warnings = [
      ...(incomingSnapshot.warnings || []),
      ...((afterValidation.issues || []).filter((issue) => issue.severity === "high"))
    ].slice(0, 8);
    const blockers = [
      ...(afterReport.gaps || []).filter((gap) => gap.severity === "critical" || gap.severity === "high"),
      ...((afterValidation.issues || []).filter((issue) => issue.severity === "high"))
    ].slice(0, 8);
    const preview = {
      version: WAREHOUSE_VERSION,
      generatedAt: now,
      summary: {
        beforeRecords: beforeReport.totalRecords || 0,
        incomingRecords: recordCount(incomingLab),
        afterRecords: afterReport.totalRecords || 0,
        addedRecords: collectionRows.reduce((sum, row) => sum + row.added, 0),
        updatedRecords: collectionRows.reduce((sum, row) => sum + row.updated, 0),
        skippedRows: collectionRows.reduce((sum, row) => sum + row.skipped, 0),
        changedCollections: changedRows.length,
        scoreBefore: beforeReport.score || 0,
        scoreAfter: afterReport.score || 0,
        scoreDelta: (afterReport.score || 0) - (beforeReport.score || 0),
        gradeBefore: beforeReport.grade || "setup",
        gradeAfter: afterReport.grade || "setup",
        sourceCoverageBefore: beforeReport.sourceFreshness ? beforeReport.sourceFreshness.provenanceCoverage || 0 : 0,
        sourceCoverageAfter: afterReport.sourceFreshness ? afterReport.sourceFreshness.provenanceCoverage || 0 : 0,
        validationIssuesBefore: beforeValidation.issueCount || 0,
        validationIssuesAfter: afterValidation.issueCount || 0,
        highIssuesBefore: beforeValidation.highIssueCount || 0,
        highIssuesAfter: afterValidation.highIssueCount || 0
      },
      validationDelta: {
        issueDelta: (afterValidation.issueCount || 0) - (beforeValidation.issueCount || 0),
        highIssueDelta: (afterValidation.highIssueCount || 0) - (beforeValidation.highIssueCount || 0),
        watchCollectionDelta: (afterValidation.watchCollectionCount || 0) - (beforeValidation.watchCollectionCount || 0),
        issueCollectionDelta: (afterValidation.issueCollectionCount || 0) - (beforeValidation.issueCollectionCount || 0)
      },
      collectionRows: changedRows.sort((a, b) =>
        b.added - a.added ||
        b.updated - a.updated ||
        cleanString(a.label).localeCompare(cleanString(b.label))
      ),
      topCollections: changedRows
        .filter((row) => row.added || row.updated)
        .sort((a, b) => (b.added + b.updated) - (a.added + a.updated))
        .slice(0, 5),
      blockers,
      warnings,
      beforeReport: {
        score: beforeReport.score,
        grade: beforeReport.grade,
        totalRecords: beforeReport.totalRecords
      },
      afterReport: {
        score: afterReport.score,
        grade: afterReport.grade,
        totalRecords: afterReport.totalRecords,
        validation: afterReport.validation,
        sourceFreshness: afterReport.sourceFreshness,
        gaps: afterReport.gaps
      }
    };
    preview.verdict = previewVerdict(preview);
    preview.nextActions = [
      preview.verdict.status !== "ready" ? {
        severity: preview.verdict.tone === "warning" ? "high" : "medium",
        label: preview.verdict.label,
        detail: preview.verdict.detail
      } : null,
      ...blockers.map((row) => ({
        severity: row.severity || "high",
        label: row.label,
        detail: row.detail
      }))
    ].filter(Boolean).slice(0, 6);
    return preview;
  }

  function buildGolfLabImportSnapshot(payload, options = {}) {
    const extracted = extractGolfLabPayload(payload);
    let lab = GolfLab.normalizeGolfLabState(extracted);
    const sourceFetch = buildSyntheticSourceFetch(payload || {}, lab, options);
    if (sourceFetch && !lab.sourceFetches.length) {
      lab = GolfLab.mergeGolfLabStates(lab, { sourceFetches: [sourceFetch] });
    }
    const report = buildWarehouseReport(lab);
    return {
      golfLab: lab,
      report,
      warnings: report.gaps.filter((gap) => gap.severity === "critical" || gap.severity === "high")
    };
  }

  function buildGolfLabTemplate(options = {}) {
    const now = cleanString(options.createdAt) || new Date().toISOString();
    const provider = cleanString(options.provider) || "";
    return {
      meta: {
        template: "Golf Lab owned warehouse import",
        version: WAREHOUSE_VERSION,
        createdAt: now,
        provider,
        note: "Fill collections with source-backed rows. Leave unavailable collections as empty arrays."
      },
      collectionColumns: COLLECTION_COLUMNS,
      source: {
        provider,
        endpoint: "",
        sourceUrl: "",
        fetchedAt: now
      },
      golfLab: GolfLab.blankGolfLabState()
    };
  }

  return {
    WAREHOUSE_VERSION,
    COLLECTION_COLUMNS,
    collectionKeyFromFileName,
    parseGolfLabCsv,
    buildSourceFreshness,
    buildSourceLineageBoard,
    buildWarehouseValidation,
    buildWarehouseCoverageMap,
    buildMarketCoverageBoard,
    buildOddsMovementBoard,
    buildOddsShoppingBoard,
    buildGolfLabImportPreview,
    buildGolfLabImportSnapshot,
    buildGolfLabTemplate,
    buildWarehouseReport
  };
});
