/*
 * Fairway Ledger - Golf Lab data contracts and pure analytics helpers.
 *
 * This module is intentionally data-only: no DOM, no localStorage, no fetches.
 * It gives the pro-golf side a stable, provider-neutral shape before source
 * importers, weather joins, and the owned prediction model grow around it.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.GolfLab = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const GOLF_LAB_SCHEMA_VERSION = 1;

  const COLLECTION_KEYS = Object.freeze([
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
    "modelPredictions",
    "predictionLedger",
    "equipmentSnapshots",
    "accomplishments",
    "sourceFetches"
  ]);

  const LAB_LANES = Object.freeze([
    {
      id: "tournament-board",
      label: "Tournament Board",
      metricKey: "events",
      accent: "green"
    },
    {
      id: "player-scorecards",
      label: "Player Scorecards",
      metricKey: "players",
      accent: "gold"
    },
    {
      id: "course-scorecards",
      label: "Course Scorecards",
      metricKey: "courses",
      accent: "blue"
    },
    {
      id: "prediction-ledger",
      label: "Prediction Ledger",
      metricKey: "predictionLedger",
      accent: "red"
    }
  ]);

  function blankGolfLabState() {
    return COLLECTION_KEYS.reduce((state, key) => {
      state[key] = [];
      return state;
    }, { schemaVersion: GOLF_LAB_SCHEMA_VERSION });
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function cleanString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function intOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isInteger(numeric) ? numeric : null;
  }

  function boolOrNull(value) {
    if (value === true || value === "true" || value === 1 || value === "1") return true;
    if (value === false || value === "false" || value === 0 || value === "0") return false;
    return null;
  }

  function slugifyId(value) {
    return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function compositeId(parts) {
    return parts.map(cleanString).filter(Boolean).join("-");
  }

  function recordId(prefix, raw, fallbackIndex, candidates = []) {
    const values = [raw.id, ...candidates].map(slugifyId).filter(Boolean);
    if (values.length) {
      return values[0];
    }
    return `${prefix}-${fallbackIndex + 1}`;
  }

  function sourceFields(raw) {
    return {
      sourceProvider: cleanString(raw.sourceProvider || raw.provider),
      sourceUrl: cleanString(raw.sourceUrl || raw.url),
      sourceUpdatedAt: cleanString(raw.sourceUpdatedAt || raw.updatedAt || raw.fetchedAt)
    };
  }

  function normalizePlayer(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      id: recordId("player", raw, index, [raw.playerId, raw.dataGolfId, raw.dgId, raw.pgaTourId, raw.pgaId, raw.name, raw.playerName]),
      name: cleanString(raw.name || raw.playerName),
      country: cleanString(raw.country),
      tour: cleanString(raw.tour),
      dataGolfId: cleanString(raw.dataGolfId || raw.dgId),
      pgaTourId: cleanString(raw.pgaTourId || raw.pgaId),
      owgrRank: intOrNull(raw.owgrRank),
      dataGolfRank: intOrNull(raw.dataGolfRank || raw.dgRank),
      photoUrl: cleanString(raw.photoUrl),
      handedness: cleanString(raw.handedness),
      age: intOrNull(raw.age),
      turnedPro: intOrNull(raw.turnedPro),
      college: cleanString(raw.college),
      profileUrl: cleanString(raw.profileUrl),
      ...sourceFields(raw)
    };
  }

  function normalizeTour(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      id: recordId("tour", raw, index, [raw.code, raw.name]),
      name: cleanString(raw.name),
      code: cleanString(raw.code),
      ...sourceFields(raw)
    };
  }

  function normalizeCourse(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      id: recordId("course", raw, index, [raw.courseId, raw.dataGolfCourseId, raw.dgCourseId, raw.name, raw.courseName]),
      name: cleanString(raw.name || raw.courseName),
      location: cleanString(raw.location || [raw.city, raw.state, raw.country].map(cleanString).filter(Boolean).join(", ")),
      dataGolfCourseId: cleanString(raw.dataGolfCourseId || raw.dgCourseId),
      par: numberOrNull(raw.par),
      yards: numberOrNull(raw.yards),
      rating: numberOrNull(raw.rating || raw.courseRating),
      slope: numberOrNull(raw.slope || raw.slopeRating),
      fieldAdjustedToPar: numberOrNull(raw.fieldAdjustedToPar),
      sgDifficulty: numberOrNull(raw.sgDifficulty),
      style: cleanString(raw.style),
      ...sourceFields(raw)
    };
  }

  function normalizeEvent(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      id: recordId("event", raw, index, [raw.eventId, compositeId([raw.tour, raw.season, raw.name || raw.eventName])]),
      name: cleanString(raw.name || raw.eventName),
      tour: cleanString(raw.tour),
      season: intOrNull(raw.season),
      startDate: cleanString(raw.startDate),
      endDate: cleanString(raw.endDate),
      courseId: cleanString(raw.courseId),
      courseName: cleanString(raw.courseName),
      fieldStrength: numberOrNull(raw.fieldStrength),
      status: cleanString(raw.status),
      ...sourceFields(raw)
    };
  }

  function normalizeCourseSetup(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      id: recordId("course-setup", raw, index, [raw.courseSetupId, compositeId([raw.eventId, raw.courseId])]),
      eventId: cleanString(raw.eventId),
      courseId: cleanString(raw.courseId),
      par: numberOrNull(raw.par),
      yards: numberOrNull(raw.yards),
      rough: cleanString(raw.rough),
      greenSpeed: cleanString(raw.greenSpeed),
      firmness: cleanString(raw.firmness),
      weatherNote: cleanString(raw.weatherNote),
      fieldAdjustedToPar: numberOrNull(raw.fieldAdjustedToPar),
      sgDifficulty: numberOrNull(raw.sgDifficulty),
      ...sourceFields(raw)
    };
  }

  function normalizeEventCourse(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    const eventId = cleanString(raw.eventId);
    const courseId = cleanString(raw.courseId);
    const courseName = cleanString(raw.courseName || raw.name);
    return {
      id: recordId("event-course", raw, index, [raw.eventCourseId, compositeId([eventId, courseId || courseName, raw.courseOrder || raw.rotationRole])]),
      eventId,
      courseId,
      courseName,
      location: cleanString(raw.location),
      courseOrder: intOrNull(raw.courseOrder || raw.order),
      roundNumbers: cleanString(raw.roundNumbers || raw.rounds),
      rotationRole: cleanString(raw.rotationRole || raw.role),
      par: numberOrNull(raw.par),
      yards: numberOrNull(raw.yards),
      confidence: cleanString(raw.confidence),
      note: cleanString(raw.note),
      ...sourceFields(raw)
    };
  }

  function normalizeField(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      id: recordId("field", raw, index, [raw.fieldId, compositeId([raw.eventId, raw.playerId || raw.playerName || raw.name])]),
      eventId: cleanString(raw.eventId),
      playerId: cleanString(raw.playerId),
      playerName: cleanString(raw.playerName || raw.name),
      status: cleanString(raw.status),
      teeTime: cleanString(raw.teeTime),
      ...sourceFields(raw)
    };
  }

  function normalizeRound(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    const courseId = cleanString(raw.courseId);
    return {
      id: recordId("round", raw, index, [raw.roundId, compositeId([raw.eventId, raw.playerId || raw.playerName || raw.name, raw.roundNumber || raw.round, raw.date, raw.courseId || raw.courseName])]),
      playerId: cleanString(raw.playerId),
      playerName: cleanString(raw.playerName || raw.name),
      eventId: cleanString(raw.eventId),
      courseId,
      courseName: cleanString(raw.courseName),
      roundNumber: intOrNull(raw.roundNumber || raw.round),
      date: cleanString(raw.date),
      score: numberOrNull(raw.score),
      toPar: numberOrNull(raw.toPar),
      adjustedToPar: numberOrNull(raw.adjustedToPar || raw.fieldAdjustedToPar),
      sgTotal: numberOrNull(raw.sgTotal || raw.sg_total),
      difficultyBucket: cleanString(raw.difficultyBucket),
      ...sourceFields(raw)
    };
  }

  function normalizeStrokesGained(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      id: recordId("sg", raw, index, [raw.sgId, raw.roundId, compositeId([raw.eventId, raw.playerId || raw.playerName || raw.name, raw.period])]),
      playerId: cleanString(raw.playerId),
      playerName: cleanString(raw.playerName || raw.name),
      eventId: cleanString(raw.eventId),
      roundId: cleanString(raw.roundId),
      period: cleanString(raw.period),
      sgTotal: numberOrNull(raw.sgTotal || raw.sg_total),
      sgOtt: numberOrNull(raw.sgOtt || raw.sg_ott),
      sgApp: numberOrNull(raw.sgApp || raw.sg_app),
      sgArg: numberOrNull(raw.sgArg || raw.sg_arg),
      sgPutt: numberOrNull(raw.sgPutt || raw.sg_putt),
      sgT2g: numberOrNull(raw.sgT2g || raw.sg_t2g),
      drivingDistance: numberOrNull(raw.drivingDistance || raw.distance),
      accuracy: numberOrNull(raw.accuracy),
      gir: numberOrNull(raw.gir),
      proximity: numberOrNull(raw.proximity || raw.prox_fw),
      scrambling: numberOrNull(raw.scrambling),
      ...sourceFields(raw)
    };
  }

  function normalizeWeatherSnapshot(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      id: recordId("weather", raw, index, [raw.weatherId, compositeId([raw.eventId, raw.courseId || raw.courseName, raw.roundNumber || raw.round, raw.observedAt || raw.forecastAt || raw.date])]),
      eventId: cleanString(raw.eventId),
      courseId: cleanString(raw.courseId),
      courseName: cleanString(raw.courseName),
      roundNumber: intOrNull(raw.roundNumber || raw.round),
      date: cleanString(raw.date),
      observedAt: cleanString(raw.observedAt),
      forecastAt: cleanString(raw.forecastAt),
      temperatureF: numberOrNull(raw.temperatureF || raw.tempF),
      windMph: numberOrNull(raw.windMph || raw.windSpeedMph),
      gustMph: numberOrNull(raw.gustMph || raw.windGustMph),
      windDirection: numberOrNull(raw.windDirection || raw.windDirectionDeg),
      humidity: numberOrNull(raw.humidity || raw.relativeHumidity),
      precipitationIn: numberOrNull(raw.precipitationIn || raw.precipIn),
      pressureMb: numberOrNull(raw.pressureMb),
      weatherCode: cleanString(raw.weatherCode),
      wave: cleanString(raw.wave),
      ...sourceFields(raw)
    };
  }

  function normalizeOddsSnapshot(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      id: recordId("odds", raw, index, [raw.oddsId, compositeId([raw.eventId, raw.playerId, raw.market, raw.book, raw.capturedAt])]),
      eventId: cleanString(raw.eventId),
      playerId: cleanString(raw.playerId),
      market: cleanString(raw.market),
      book: cleanString(raw.book),
      oddsAmerican: numberOrNull(raw.oddsAmerican),
      oddsDecimal: numberOrNull(raw.oddsDecimal),
      impliedProbability: numberOrNull(raw.impliedProbability),
      capturedAt: cleanString(raw.capturedAt),
      ...sourceFields(raw)
    };
  }

  function normalizePrediction(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      id: recordId("prediction", raw, index, [raw.predictionId, compositeId([raw.eventId, raw.playerId, raw.market, raw.modelVersion, raw.modelRunId || raw.runId || raw.createdAt])]),
      eventId: cleanString(raw.eventId),
      playerId: cleanString(raw.playerId),
      market: cleanString(raw.market),
      modelVersion: cleanString(raw.modelVersion),
      modelRunId: cleanString(raw.modelRunId || raw.runId),
      modelProfile: cleanString(raw.modelProfile || raw.profile || raw.preset),
      modelWeatherScenario: cleanString(raw.modelWeatherScenario || raw.weatherScenario),
      modelWeatherLabel: cleanString(raw.modelWeatherLabel || raw.weatherLabel),
      probability: numberOrNull(raw.probability),
      fairOddsAmerican: numberOrNull(raw.fairOddsAmerican),
      marketOddsAmerican: numberOrNull(raw.marketOddsAmerican),
      edge: numberOrNull(raw.edge),
      rank: intOrNull(raw.rank),
      score: numberOrNull(raw.score),
      skill: numberOrNull(raw.skill),
      recentForm: numberOrNull(raw.recentForm),
      courseFit: numberOrNull(raw.courseFit),
      difficultyFit: numberOrNull(raw.difficultyFit),
      weatherFit: numberOrNull(raw.weatherFit),
      liveState: numberOrNull(raw.liveState),
      livePosition: intOrNull(raw.livePosition),
      liveToPar: numberOrNull(raw.liveToPar),
      liveRounds: intOrNull(raw.liveRounds),
      liveStrokesBack: numberOrNull(raw.liveStrokesBack),
      sampleRounds: intOrNull(raw.sampleRounds),
      settled: boolOrNull(raw.settled),
      hit: boolOrNull(raw.hit),
      qualifies: boolOrNull(raw.qualifies),
      finishPosition: intOrNull(raw.finishPosition),
      finishToPar: numberOrNull(raw.finishToPar),
      finishRounds: intOrNull(raw.finishRounds),
      profitUnits: numberOrNull(raw.profitUnits),
      confidence: cleanString(raw.confidence),
      createdAt: cleanString(raw.createdAt),
      result: cleanString(raw.result),
      ...sourceFields(raw)
    };
  }

  function normalizeEquipmentSnapshot(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      id: recordId("equipment", raw, index, [raw.equipmentId, compositeId([raw.playerId, raw.capturedDate || raw.date, raw.sourceProvider || raw.provider])]),
      playerId: cleanString(raw.playerId),
      capturedDate: cleanString(raw.capturedDate || raw.date),
      driver: cleanString(raw.driver),
      fairwayWoods: cleanString(raw.fairwayWoods),
      hybrids: cleanString(raw.hybrids),
      irons: cleanString(raw.irons),
      wedges: cleanString(raw.wedges),
      putter: cleanString(raw.putter),
      ball: cleanString(raw.ball),
      apparel: cleanString(raw.apparel),
      confidence: cleanString(raw.confidence),
      ...sourceFields(raw)
    };
  }

  function normalizeAccomplishment(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      id: recordId("accomplishment", raw, index, [raw.accomplishmentId, compositeId([raw.playerId, raw.type, raw.label || raw.name, raw.season || raw.date])]),
      playerId: cleanString(raw.playerId),
      type: cleanString(raw.type),
      label: cleanString(raw.label || raw.name),
      eventName: cleanString(raw.eventName),
      season: intOrNull(raw.season),
      date: cleanString(raw.date),
      ...sourceFields(raw)
    };
  }

  function normalizeSourceFetch(raw, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      id: recordId("source", raw, index, [raw.sourceId, compositeId([raw.provider || raw.sourceProvider, raw.endpoint, raw.modelRunId || raw.runId, raw.fetchedAt || raw.sourceUpdatedAt])]),
      provider: cleanString(raw.provider || raw.sourceProvider),
      endpoint: cleanString(raw.endpoint),
      eventId: cleanString(raw.eventId),
      modelRunId: cleanString(raw.modelRunId || raw.runId),
      modelVersion: cleanString(raw.modelVersion),
      modelProfile: cleanString(raw.modelProfile || raw.profile || raw.preset),
      modelWeatherScenario: cleanString(raw.modelWeatherScenario || raw.weatherScenario),
      modelWeatherLabel: cleanString(raw.modelWeatherLabel || raw.weatherLabel),
      fetchedAt: cleanString(raw.fetchedAt || raw.sourceUpdatedAt),
      status: cleanString(raw.status),
      rowCount: intOrNull(raw.rowCount),
      manifestJson: cleanString(raw.manifestJson || raw.manifest || raw.runManifest),
      ...sourceFields(raw)
    };
  }

  const NORMALIZERS = Object.freeze({
    players: normalizePlayer,
    tours: normalizeTour,
    events: normalizeEvent,
    courses: normalizeCourse,
    courseSetups: normalizeCourseSetup,
    eventCourses: normalizeEventCourse,
    fields: normalizeField,
    rounds: normalizeRound,
    strokesGained: normalizeStrokesGained,
    weatherSnapshots: normalizeWeatherSnapshot,
    oddsSnapshots: normalizeOddsSnapshot,
    modelPredictions: normalizePrediction,
    predictionLedger: normalizePrediction,
    equipmentSnapshots: normalizeEquipmentSnapshot,
    accomplishments: normalizeAccomplishment,
    sourceFetches: normalizeSourceFetch
  });

  function normalizeGolfLabState(input) {
    const source = input && typeof input === "object" ? input : {};
    const output = blankGolfLabState();
    COLLECTION_KEYS.forEach((key) => {
      const normalizer = NORMALIZERS[key] || ((item) => item);
      output[key] = asArray(source[key]).map(normalizer).filter(Boolean);
    });
    return output;
  }

  function mergeRecord(existing, incoming) {
    const merged = { ...(existing || {}) };
    Object.entries(incoming || {}).forEach(([key, value]) => {
      if (value === "" || value === null || value === undefined) {
        if (!(key in merged)) merged[key] = value;
        return;
      }
      merged[key] = value;
    });
    return merged;
  }

  function mergeGolfLabStates(...inputs) {
    const output = blankGolfLabState();
    inputs.map(normalizeGolfLabState).forEach((lab) => {
      COLLECTION_KEYS.forEach((key) => {
        const byId = new Map(output[key].map((item) => [item.id, item]));
        lab[key].forEach((item) => {
          if (!item || !item.id) return;
          byId.set(item.id, mergeRecord(byId.get(item.id), item));
        });
        output[key] = [...byId.values()];
      });
    });
    return output;
  }

  function hasGolfLabData(input) {
    const lab = normalizeGolfLabState(input);
    return COLLECTION_KEYS.some((key) => key !== "sourceFetches" && lab[key].length > 0);
  }

  function summarizeGolfLabState(input) {
    const lab = normalizeGolfLabState(input);
    const latestFetch = lab.sourceFetches
      .map((fetch) => fetch.fetchedAt || fetch.sourceUpdatedAt)
      .filter(Boolean)
      .sort()
      .slice(-1)[0] || "";
    const counts = COLLECTION_KEYS.reduce((acc, key) => {
      acc[key] = lab[key].length;
      return acc;
    }, {});
    let readiness = "setup";
    if (counts.players && counts.events && counts.rounds) readiness = "analysis-ready";
    else if (counts.players || counts.events || counts.courses || counts.rounds) readiness = "partial";
    return {
      counts,
      latestFetch,
      readiness,
      hasData: hasGolfLabData(lab),
      lanes: LAB_LANES.map((lane) => ({
        ...lane,
        count: counts[lane.metricKey] || 0
      }))
    };
  }

  function classifyCourseDifficulty(input) {
    const course = input && typeof input === "object" ? input : {};
    const proScore = numberOrNull(course.fieldAdjustedToPar);
    const sgDifficulty = numberOrNull(course.sgDifficulty);
    if (Number.isFinite(proScore)) {
      if (proScore <= -1) return { bucket: "Easy", score: proScore, basis: "field-adjusted scoring" };
      if (proScore < 0.75) return { bucket: "Neutral", score: proScore, basis: "field-adjusted scoring" };
      if (proScore < 2.5) return { bucket: "Tough", score: proScore, basis: "field-adjusted scoring" };
      return { bucket: "Brutal", score: proScore, basis: "field-adjusted scoring" };
    }
    if (Number.isFinite(sgDifficulty)) {
      if (sgDifficulty >= 0.75) return { bucket: "Easy", score: sgDifficulty, basis: "strokes-gained difficulty" };
      if (sgDifficulty > -0.75) return { bucket: "Neutral", score: sgDifficulty, basis: "strokes-gained difficulty" };
      if (sgDifficulty > -2.25) return { bucket: "Tough", score: sgDifficulty, basis: "strokes-gained difficulty" };
      return { bucket: "Brutal", score: sgDifficulty, basis: "strokes-gained difficulty" };
    }
    const par = numberOrNull(course.par);
    const rating = numberOrNull(course.rating || course.courseRating);
    const slope = numberOrNull(course.slope || course.slopeRating);
    if (Number.isFinite(par) && Number.isFinite(rating)) {
      const slopeComponent = Number.isFinite(slope) ? (slope - 113) / 16 : 0;
      const score = (rating - par) + slopeComponent;
      if (score <= -1) return { bucket: "Easy", score, basis: "rating and slope" };
      if (score < 1.5) return { bucket: "Neutral", score, basis: "rating and slope" };
      if (score < 3.25) return { bucket: "Tough", score, basis: "rating and slope" };
      return { bucket: "Brutal", score, basis: "rating and slope" };
    }
    return { bucket: "Unknown", score: null, basis: "insufficient data" };
  }

  function avg(values) {
    const valid = values.filter(Number.isFinite);
    if (!valid.length) return null;
    return valid.reduce((sum, value) => sum + value, 0) / valid.length;
  }

  function latestByDate(items, dateKey) {
    return [...items].sort((a, b) => cleanString(b[dateKey]).localeCompare(cleanString(a[dateKey])))[0] || null;
  }

  function groupByKey(items, key) {
    return items.reduce((groups, item) => {
      const value = cleanString(item[key]);
      if (!value) return groups;
      if (!groups[value]) groups[value] = [];
      groups[value].push(item);
      return groups;
    }, {});
  }

  function compactIdentityValue(value) {
    return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function buildCourseRows(playerRounds, coursesById, coursesByName) {
    const grouped = playerRounds.reduce((groups, round) => {
      const key = cleanString(round.courseId) || cleanString(round.courseName);
      if (!key) return groups;
      if (!groups[key]) groups[key] = [];
      groups[key].push(round);
      return groups;
    }, {});
    return Object.entries(grouped).map(([courseId, rounds]) => {
      const course = coursesById.get(courseId) || coursesByName.get(courseId.toLowerCase()) || {};
      const scoreValues = rounds.map((round) => {
        const adjusted = numberOrNull(round.adjustedToPar);
        if (Number.isFinite(adjusted)) return adjusted;
        return numberOrNull(round.toPar);
      });
      const sgValues = rounds.map((round) => numberOrNull(round.sgTotal));
      return {
        courseId,
        courseName: course.name || rounds[0].courseName || courseId,
        rounds: rounds.length,
        avgToPar: avg(scoreValues),
        avgSg: avg(sgValues),
        difficulty: classifyCourseDifficulty(course).bucket
      };
    }).filter((row) => row.rounds > 0);
  }

  function buildDifficultySplits(playerRounds, coursesById, coursesByName) {
    const groups = playerRounds.reduce((acc, round) => {
      const key = cleanString(round.courseId) || cleanString(round.courseName);
      const course = coursesById.get(key) || coursesByName.get(cleanString(round.courseName || key).toLowerCase()) || {};
      const bucket = cleanString(round.difficultyBucket) || classifyCourseDifficulty(course).bucket;
      if (!acc[bucket]) acc[bucket] = [];
      acc[bucket].push(round);
      return acc;
    }, {});
    const order = ["Brutal", "Tough", "Neutral", "Easy", "Unknown"];
    return order
      .filter((bucket) => groups[bucket] && groups[bucket].length)
      .map((bucket) => {
        const rounds = groups[bucket];
        return {
          bucket,
          rounds: rounds.length,
          avgSg: avg(rounds.map((round) => numberOrNull(round.sgTotal))),
          avgToPar: avg(rounds.map(roundScoreValue))
        };
      });
  }

  function weatherBucket(snapshot) {
    if (!snapshot) return "";
    const wind = numberOrNull(snapshot.windMph);
    const gust = numberOrNull(snapshot.gustMph);
    const temp = numberOrNull(snapshot.temperatureF);
    const rain = numberOrNull(snapshot.precipitationIn);
    if (Number.isFinite(rain) && rain > 0.05) return "Rain";
    if ((Number.isFinite(gust) && gust >= 28) || (Number.isFinite(wind) && wind >= 18)) return "Wind";
    if (Number.isFinite(temp) && temp >= 85) return "Heat";
    if (Number.isFinite(temp) && temp <= 55) return "Cold";
    if (Number.isFinite(wind) && wind <= 8 && (!Number.isFinite(rain) || rain <= 0.01)) return "Calm";
    return "Neutral";
  }

  function weatherForRound(weatherRows, round) {
    const eventRows = weatherRows.filter((weather) => weather.eventId === round.eventId);
    if (!eventRows.length) return null;
    const roundMatch = eventRows.find((weather) =>
      weather.roundNumber && round.roundNumber && weather.roundNumber === round.roundNumber
    );
    if (roundMatch) return roundMatch;
    const courseMatch = eventRows.find((weather) =>
      (weather.courseId && weather.courseId === round.courseId) ||
      (weather.courseName && weather.courseName === round.courseName)
    );
    return courseMatch || eventRows[0];
  }

  function buildWeatherSplits(playerRounds, weatherRows) {
    const groups = playerRounds.reduce((acc, round) => {
      const snapshot = weatherForRound(weatherRows, round);
      const bucket = weatherBucket(snapshot);
      if (!bucket) return acc;
      if (!acc[bucket]) acc[bucket] = [];
      acc[bucket].push({ round, snapshot });
      return acc;
    }, {});
    const order = ["Wind", "Rain", "Heat", "Cold", "Calm", "Neutral"];
    return order
      .filter((bucket) => groups[bucket] && groups[bucket].length)
      .map((bucket) => {
        const rows = groups[bucket];
        return {
          bucket,
          rounds: rows.length,
          avgSg: avg(rows.map(({ round }) => numberOrNull(round.sgTotal))),
          avgToPar: avg(rows.map(({ round }) => roundScoreValue(round))),
          avgWindMph: avg(rows.map(({ snapshot }) => numberOrNull(snapshot.windMph))),
          avgTemperatureF: avg(rows.map(({ snapshot }) => numberOrNull(snapshot.temperatureF)))
        };
      });
  }

  function eventWeatherMatrixTarget(weatherRows) {
    if (!weatherRows.length) {
      return {
        bucket: "No weather",
        count: 0,
        windMph: null,
        gustMph: null,
        temperatureF: null,
        precipitationIn: null
      };
    }
    const buckets = weatherRows.reduce((acc, row) => {
      const bucket = weatherBucket(row) || "Neutral";
      if (!acc[bucket]) acc[bucket] = [];
      acc[bucket].push(row);
      return acc;
    }, {});
    const bucketOrder = ["Wind", "Rain", "Heat", "Cold", "Calm", "Neutral"];
    const bucket = Object.entries(buckets).sort((a, b) =>
      b[1].length - a[1].length ||
      bucketOrder.indexOf(a[0]) - bucketOrder.indexOf(b[0])
    )[0][0];
    return {
      bucket,
      count: weatherRows.length,
      windMph: avg(weatherRows.map((row) => numberOrNull(row.windMph))),
      gustMph: avg(weatherRows.map((row) => numberOrNull(row.gustMph))),
      temperatureF: avg(weatherRows.map((row) => numberOrNull(row.temperatureF))),
      precipitationIn: avg(weatherRows.map((row) => numberOrNull(row.precipitationIn)))
    };
  }

  function weatherPerformanceValue(avgSg, avgToPar) {
    if (Number.isFinite(avgSg)) return avgSg;
    if (Number.isFinite(avgToPar)) return -avgToPar / 2;
    return null;
  }

  function weatherDnaStatus(totalRounds) {
    if (totalRounds >= 8) return { status: "trusted", label: "Trusted sample" };
    if (totalRounds >= 3) return { status: "building", label: "Building sample" };
    if (totalRounds > 0) return { status: "thin", label: "Thin sample" };
    return { status: "missing", label: "No weather sample" };
  }

  function weatherDnaLabel(delta) {
    if (!Number.isFinite(delta)) return "Sample only";
    if (delta >= 0.7) return "Clear weather riser";
    if (delta >= 0.25) return "Weather riser";
    if (delta <= -0.7) return "Clear weather drag";
    if (delta <= -0.25) return "Weather drag";
    return "Stable";
  }

  function buildPlayerWeatherDna(playerRounds, weatherSplits, targetWeather) {
    const baselineAvgSg = avg(playerRounds.map((round) => numberOrNull(round.sgTotal)));
    const baselineAvgToPar = avg(playerRounds.map(roundScoreValue));
    const baselineValue = weatherPerformanceValue(baselineAvgSg, baselineAvgToPar);
    const rows = weatherSplits.map((row) => {
      const value = weatherPerformanceValue(row.avgSg, row.avgToPar);
      const delta = Number.isFinite(value) && Number.isFinite(baselineValue) ? value - baselineValue : null;
      const confidence = row.rounds
        ? Math.min(100, Math.round(30 + Math.min(45, row.rounds * 15) + (Number.isFinite(delta) ? 15 : 0) + (row.rounds >= 3 ? 10 : 0)))
        : 0;
      return {
        ...row,
        value,
        delta,
        confidence,
        label: weatherDnaLabel(delta)
      };
    });
    const scored = rows.filter((row) => Number.isFinite(row.delta));
    const byDelta = [...scored].sort((a, b) =>
      b.delta - a.delta ||
      b.rounds - a.rounds ||
      cleanString(a.bucket).localeCompare(cleanString(b.bucket))
    );
    const totalRounds = rows.reduce((sum, row) => sum + row.rounds, 0);
    const status = weatherDnaStatus(totalRounds);
    const targetBucket = targetWeather && targetWeather.bucket && targetWeather.bucket !== "No weather"
      ? targetWeather.bucket
      : "";
    const targetSplit = targetBucket ? rows.find((row) => row.bucket === targetBucket) || null : null;
    const targetScore = targetSplit && Number.isFinite(targetSplit.delta)
      ? Math.max(0, Math.min(100, Math.round(50 + targetSplit.delta * 18 + Math.min(24, targetSplit.rounds * 8))))
      : null;
    return {
      status: status.status,
      statusLabel: status.label,
      totalRounds,
      bucketCount: rows.length,
      baseline: {
        avgSg: baselineAvgSg,
        avgToPar: baselineAvgToPar,
        value: baselineValue,
        rounds: playerRounds.length
      },
      best: byDelta[0] || null,
      worst: byDelta.length ? byDelta[byDelta.length - 1] : null,
      target: targetWeather ? {
        bucket: targetWeather.bucket,
        windMph: targetWeather.windMph,
        gustMph: targetWeather.gustMph,
        temperatureF: targetWeather.temperatureF,
        precipitationIn: targetWeather.precipitationIn,
        count: targetWeather.count,
        split: targetSplit,
        rounds: targetSplit ? targetSplit.rounds : 0,
        delta: targetSplit ? targetSplit.delta : null,
        score: targetScore,
        label: targetSplit ? targetSplit.label : targetBucket ? "No matching history" : "No event weather"
      } : null,
      rows
    };
  }

  function parseTeeTimeMinutes(value) {
    const raw = cleanString(value);
    if (!raw) return null;
    const match = raw.match(/(?:T|\b)(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?(?:\.?\s*m\.?)?/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const meridiem = cleanString(match[3]).toLowerCase();
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return null;
    if (meridiem === "p" && hour < 12) hour += 12;
    if (meridiem === "a" && hour === 12) hour = 0;
    if (hour < 0 || hour > 23) return null;
    return hour * 60 + minute;
  }

  function minutesToTeeLabel(minutes) {
    if (!Number.isFinite(minutes)) return "";
    const hour24 = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const suffix = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
  }

  function waveKeyFromText(value) {
    const raw = cleanString(value).toLowerCase();
    if (!raw) return "";
    if (/\b(am|morning|early)\b/.test(raw)) return "AM";
    if (/\b(pm|afternoon|late)\b/.test(raw)) return "PM";
    return "";
  }

  function waveKeyFromMinutes(minutes) {
    if (!Number.isFinite(minutes)) return "";
    return minutes < 12 * 60 ? "AM" : "PM";
  }

  function weatherSnapshotWaveKey(row) {
    const explicit = waveKeyFromText(row && row.wave);
    if (explicit) return explicit;
    return waveKeyFromMinutes(parseTeeTimeMinutes(row && (row.observedAt || row.forecastAt || row.date)));
  }

  function teeTimeRange(fields) {
    const minutes = fields.map((field) => parseTeeTimeMinutes(field.teeTime)).filter(Number.isFinite).sort((a, b) => a - b);
    if (!minutes.length) return "";
    if (minutes.length === 1) return minutesToTeeLabel(minutes[0]);
    return `${minutesToTeeLabel(minutes[0])} - ${minutesToTeeLabel(minutes[minutes.length - 1])}`;
  }

  function weatherDifficultyScore(weather) {
    if (!weather || !weather.count) return null;
    const wind = Number.isFinite(weather.windMph) ? weather.windMph : 0;
    const gust = Number.isFinite(weather.gustMph) ? weather.gustMph : wind;
    const rain = Number.isFinite(weather.precipitationIn) ? weather.precipitationIn : 0;
    const temp = Number.isFinite(weather.temperatureF) ? weather.temperatureF : 70;
    const gustPenalty = Math.max(0, gust - wind) * 0.65;
    const tempPenalty = Math.max(0, 55 - temp, temp - 85) * 0.28;
    return wind + gustPenalty + rain * 120 + tempPenalty;
  }

  function weatherAggregate(rows) {
    const weather = {
      count: rows.length,
      windMph: avg(rows.map((row) => numberOrNull(row.windMph))),
      gustMph: avg(rows.map((row) => numberOrNull(row.gustMph))),
      temperatureF: avg(rows.map((row) => numberOrNull(row.temperatureF))),
      precipitationIn: avg(rows.map((row) => numberOrNull(row.precipitationIn))),
      providers: [...new Set(rows.map((row) => cleanString(row.sourceProvider)).filter(Boolean))].sort()
    };
    return {
      ...weather,
      bucket: eventWeatherMatrixTarget(rows).bucket,
      label: weatherLabel(weather),
      difficultyScore: weatherDifficultyScore(weather)
    };
  }

  function playerWeatherFitForBucket(lab, aliases, bucket) {
    if (!bucket || bucket === "No weather") {
      return { weatherFit: null, weatherRounds: 0, taggedRounds: 0 };
    }
    const playerRounds = lab.rounds.filter((round) => rowMatchesPlayerAliases(round, aliases));
    const taggedRounds = playerRounds
      .map((round) => ({ round, snapshot: weatherForRound(lab.weatherSnapshots, round) }))
      .filter(({ snapshot }) => snapshot);
    const targetRounds = taggedRounds.filter(({ snapshot }) => weatherBucket(snapshot) === bucket);
    const targetValue = weatherPerformanceValue(
      avg(targetRounds.map(({ round }) => numberOrNull(round.sgTotal))),
      avg(targetRounds.map(({ round }) => roundScoreValue(round)))
    );
    const baselineValue = weatherPerformanceValue(
      avg(playerRounds.map((round) => numberOrNull(round.sgTotal))),
      avg(playerRounds.map(roundScoreValue))
    );
    const weatherFit = Number.isFinite(targetValue) && Number.isFinite(baselineValue)
      ? targetValue - baselineValue
      : targetValue;
    return {
      weatherFit,
      weatherRounds: targetRounds.length,
      taggedRounds: taggedRounds.length
    };
  }

  function buildTeeTimeWaveBoard(input, options = {}) {
    const lab = normalizeGolfLabState(input);
    const event = chooseEventForDossier(lab, options.eventId);
    if (!event) return null;
    const aliasIndex = buildPlayerAliasIndex(lab.players);
    const limit = Math.max(1, intOrNull(options.limit) || 6);
    const fields = lab.fields
      .filter((field) => field.eventId === event.id)
      .filter((field) => !["wd", "withdrawn", "out"].includes(cleanString(field.status).toLowerCase()))
      .map((field) => ({
        ...field,
        teeMinutes: parseTeeTimeMinutes(field.teeTime),
        waveKey: waveKeyFromMinutes(parseTeeTimeMinutes(field.teeTime)) || "Unassigned"
      }));
    const weatherRows = lab.weatherSnapshots.filter((row) => row.eventId === event.id);
    const weatherByWave = weatherRows.reduce((acc, row) => {
      const waveKey = weatherSnapshotWaveKey(row) || "Shared";
      if (!acc[waveKey]) acc[waveKey] = [];
      acc[waveKey].push(row);
      return acc;
    }, {});
    const waveKeys = ["AM", "PM"].filter((key) =>
      fields.some((field) => field.waveKey === key) ||
      (weatherByWave[key] && weatherByWave[key].length)
    );
    if (fields.some((field) => field.waveKey === "Unassigned")) waveKeys.push("Unassigned");
    if (!waveKeys.length) waveKeys.push("Unassigned");
    const baseRows = waveKeys.map((waveKey) => {
      const waveFields = fields.filter((field) => field.waveKey === waveKey);
      const directWeather = weatherByWave[waveKey] || [];
      const sharedWeather = weatherByWave.Shared || [];
      const waveWeather = directWeather.length ? directWeather : waveKey === "Unassigned" ? sharedWeather : sharedWeather.length ? sharedWeather : weatherRows;
      const weather = weatherAggregate(waveWeather);
      const players = waveFields.map((field) => {
        const player = fieldPlayer(aliasIndex, field);
        const aliases = [
          field.playerId,
          field.playerName,
          player && player.id,
          player && player.name,
          player && player.dataGolfId,
          player && player.pgaTourId
        ].map(cleanString).filter(Boolean);
        const fit = playerWeatherFitForBucket(lab, aliases, weather.bucket);
        return {
          fieldId: field.id,
          playerId: player ? player.id : cleanString(field.playerId || field.playerName),
          playerName: player ? player.name : cleanString(field.playerName || field.playerId),
          teeTime: field.teeTime,
          teeMinutes: field.teeMinutes,
          status: field.status || "active",
          matchedProfile: Boolean(player),
          ...fit
        };
      }).sort((a, b) =>
        Number.isFinite(b.weatherFit) - Number.isFinite(a.weatherFit) ||
        (Number.isFinite(b.weatherFit) && Number.isFinite(a.weatherFit) ? b.weatherFit - a.weatherFit : 0) ||
        (Number.isFinite(a.teeMinutes) ? a.teeMinutes : 9999) - (Number.isFinite(b.teeMinutes) ? b.teeMinutes : 9999) ||
        cleanString(a.playerName).localeCompare(cleanString(b.playerName))
      );
      return {
        waveKey,
        label: waveKey === "AM" ? "AM wave" : waveKey === "PM" ? "PM wave" : "Unassigned tee times",
        fieldCount: waveFields.length,
        assignedTeeTimes: waveFields.filter((field) => Number.isFinite(field.teeMinutes)).length,
        teeTimeRange: teeTimeRange(waveFields),
        weather,
        players: players.slice(0, limit),
        allPlayers: players
      };
    });
    const scored = baseRows.filter((row) => Number.isFinite(row.weather.difficultyScore));
    const avgDifficulty = avg(scored.map((row) => row.weather.difficultyScore));
    const rows = baseRows.map((row) => {
      const drawEdge = Number.isFinite(avgDifficulty) && Number.isFinite(row.weather.difficultyScore)
        ? avgDifficulty - row.weather.difficultyScore
        : null;
      let drawLabel = "Needs weather";
      if (Number.isFinite(drawEdge)) {
        drawLabel = drawEdge >= 2 ? "Advantage" : drawEdge <= -2 ? "Tough draw" : "Neutral";
      }
      return { ...row, drawEdge, drawLabel };
    }).sort((a, b) =>
      Number.isFinite(b.drawEdge) - Number.isFinite(a.drawEdge) ||
      (Number.isFinite(b.drawEdge) && Number.isFinite(a.drawEdge) ? b.drawEdge - a.drawEdge : 0) ||
      cleanString(a.waveKey).localeCompare(cleanString(b.waveKey))
    );
    const easiest = scored.length ? rows.filter((row) => Number.isFinite(row.weather.difficultyScore)).sort((a, b) => a.weather.difficultyScore - b.weather.difficultyScore)[0] : null;
    const toughest = scored.length ? rows.filter((row) => Number.isFinite(row.weather.difficultyScore)).sort((a, b) => b.weather.difficultyScore - a.weather.difficultyScore)[0] : null;
    return {
      event: {
        eventId: event.id,
        name: event.name || event.id,
        startDate: event.startDate,
        courseName: event.courseName,
        tour: event.tour
      },
      summary: {
        fieldCount: fields.length,
        assignedTeeTimes: fields.filter((field) => Number.isFinite(field.teeMinutes)).length,
        weatherSnapshots: weatherRows.length,
        waves: rows.length,
        advantagedWave: easiest ? easiest.label : "",
        toughWave: toughest ? toughest.label : "",
        drawSpread: easiest && toughest ? toughest.weather.difficultyScore - easiest.weather.difficultyScore : null
      },
      waves: rows,
      warnings: [
        fields.length && !fields.some((field) => Number.isFinite(field.teeMinutes)) ? "Import tee times to split the field into AM and PM waves." : "",
        !weatherRows.length ? "Import wave-level or timestamped weather snapshots to price the draw." : ""
      ].filter(Boolean)
    };
  }

  function buildWeatherMatrixBoard(input, options = {}) {
    const lab = normalizeGolfLabState(input);
    const event = chooseEventForDossier(lab, options.eventId);
    if (!event) return null;
    const aliasIndex = buildPlayerAliasIndex(lab.players);
    const fieldRows = lab.fields
      .filter((field) => field.eventId === event.id)
      .filter((field) => !["wd", "withdrawn", "out"].includes(cleanString(field.status).toLowerCase()));
    const candidatePlayers = fieldRows.length
      ? fieldRows.map((field) => {
        const player = fieldPlayer(aliasIndex, field);
        return {
          playerId: player ? player.id : cleanString(field.playerId || field.playerName),
          playerName: player ? player.name : cleanString(field.playerName || field.playerId),
          inField: true
        };
      }).filter((row) => row.playerId || row.playerName)
      : lab.players.map((player) => ({
        playerId: player.id,
        playerName: player.name || player.id,
        inField: false
      }));
    const weatherRows = lab.weatherSnapshots.filter((row) => row.eventId === event.id);
    const target = eventWeatherMatrixTarget(weatherRows);
    const limit = Math.max(1, intOrNull(options.limit) || 8);
    const rows = candidatePlayers.map((candidate) => {
      const player = aliasIndex.get(cleanString(candidate.playerId).toLowerCase())
        || aliasIndex.get(cleanString(candidate.playerName).toLowerCase())
        || null;
      const aliases = [candidate.playerId, candidate.playerName, player && player.id, player && player.name, player && player.dataGolfId, player && player.pgaTourId]
        .map(cleanString)
        .filter(Boolean);
      const playerRounds = lab.rounds.filter((round) =>
        aliases.includes(round.playerId) || aliases.includes(round.playerName)
      );
      const taggedRounds = playerRounds
        .map((round) => ({ round, snapshot: weatherForRound(lab.weatherSnapshots, round) }))
        .filter(({ snapshot }) => snapshot);
      const targetRounds = target.bucket === "No weather"
        ? []
        : taggedRounds.filter(({ snapshot }) => weatherBucket(snapshot) === target.bucket);
      const baselineAvgSg = avg(playerRounds.map((round) => numberOrNull(round.sgTotal)));
      const baselineAvgToPar = avg(playerRounds.map(roundScoreValue));
      const targetAvgSg = avg(targetRounds.map(({ round }) => numberOrNull(round.sgTotal)));
      const targetAvgToPar = avg(targetRounds.map(({ round }) => roundScoreValue(round)));
      const targetValue = weatherPerformanceValue(targetAvgSg, targetAvgToPar);
      const baselineValue = weatherPerformanceValue(baselineAvgSg, baselineAvgToPar);
      const delta = Number.isFinite(targetValue) && Number.isFinite(baselineValue) ? targetValue - baselineValue : null;
      const sampleBonus = Math.min(0.3, Math.log(targetRounds.length + 1) / 7);
      const fitScore = (Number.isFinite(targetValue) ? targetValue : -2) + sampleBonus + (Number.isFinite(delta) ? delta * 0.35 : 0);
      return {
        playerId: player ? player.id : candidate.playerId,
        playerName: player ? player.name : candidate.playerName || candidate.playerId,
        inField: candidate.inField,
        weatherBucket: target.bucket,
        weatherRounds: targetRounds.length,
        taggedRounds: taggedRounds.length,
        totalRounds: playerRounds.length,
        avgSg: targetAvgSg,
        avgToPar: targetAvgToPar,
        baselineAvgSg,
        baselineAvgToPar,
        delta,
        fitScore,
        tags: [
          candidate.inField ? "In field" : "",
          targetRounds.length >= 3 ? "Weather sample" : "",
          targetRounds.length > 0 && targetRounds.length < 3 ? "Thin weather sample" : "",
          Number.isFinite(delta) && delta > 0.5 ? "Weather riser" : "",
          Number.isFinite(delta) && delta < -0.5 ? "Weather drag" : ""
        ].filter(Boolean)
      };
    }).filter((row) => row.totalRounds > 0)
      .sort((a, b) =>
        Number(b.weatherRounds > 0) - Number(a.weatherRounds > 0) ||
        b.fitScore - a.fitScore ||
        b.weatherRounds - a.weatherRounds ||
        cleanString(a.playerName).localeCompare(cleanString(b.playerName))
      );
    return {
      event: {
        eventId: event.id,
        name: event.name || event.id,
        startDate: event.startDate,
        courseName: event.courseName,
        tour: event.tour
      },
      target,
      summary: {
        players: candidatePlayers.length,
        rankedPlayers: rows.length,
        playersWithWeatherHistory: rows.filter((row) => row.weatherRounds > 0).length,
        weatherRounds: rows.reduce((sum, row) => sum + row.weatherRounds, 0),
        taggedRounds: rows.reduce((sum, row) => sum + row.taggedRounds, 0),
        topFit: rows.find((row) => row.weatherRounds > 0) || rows[0] || null
      },
      rows: rows.slice(0, limit),
      allRows: rows
    };
  }

  function fieldReadinessMarketMatches(market, filter) {
    const target = cleanString(filter).toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!target || target === "all" || target === "allmarkets") return true;
    return cleanString(market).toLowerCase().replace(/[^a-z0-9]+/g, "") === target;
  }

  function rowMatchesPlayerAliases(row, aliases) {
    return aliases.includes(cleanString(row && row.playerId)) || aliases.includes(cleanString(row && row.playerName));
  }

  function rowHasSourceProof(row) {
    return Boolean(row && (
      cleanString(row.sourceProvider) ||
      cleanString(row.sourceUrl) ||
      cleanString(row.sourceUpdatedAt) ||
      cleanString(row.profileUrl)
    ));
  }

  function readinessStatus(score) {
    if (score >= 85) return "premium-ready";
    if (score >= 70) return "model-ready";
    if (score >= 50) return "building";
    return "thin";
  }

  function readinessStatusLabel(status) {
    return {
      "premium-ready": "Premium ready",
      "model-ready": "Model ready",
      building: "Building",
      thin: "Thin"
    }[status] || "Building";
  }

  function weightedReadinessScore(parts) {
    const weights = {
      profile: 0.16,
      field: 0.12,
      form: 0.22,
      course: 0.16,
      weather: 0.10,
      market: 0.10,
      model: 0.09,
      enrichment: 0.05
    };
    return Math.round(Object.entries(weights).reduce((sum, [key, weight]) => sum + (parts[key] || 0) * weight, 0));
  }

  function buildFieldReadinessBoard(input, options = {}) {
    const lab = normalizeGolfLabState(input);
    const event = chooseEventForDossier(lab, options.eventId);
    if (!event) return null;
    const course = courseForEvent(lab, event);
    const aliasIndex = buildPlayerAliasIndex(lab.players);
    const fields = lab.fields
      .filter((field) => field.eventId === event.id)
      .filter((field) => !["wd", "withdrawn", "out"].includes(cleanString(field.status).toLowerCase()));
    const targetWeather = eventWeatherMatrixTarget(lab.weatherSnapshots.filter((row) => row.eventId === event.id));
    const compBoard = course
      ? buildCourseCompBoard(lab, {
        eventId: event.id,
        courseLimit: Math.max(1, intOrNull(options.courseLimit) || 8),
        playerLimit: lab.players.length || 1
      })
      : null;
    const compCourseIds = new Set((compBoard ? compBoard.compCourses : []).map((row) => row.courseId).filter(Boolean));
    const compCourseNames = new Set((compBoard ? compBoard.compCourses : []).map((row) => row.courseName).filter(Boolean));
    const limit = Math.max(1, intOrNull(options.limit) || 10);
    const rows = fields.map((field) => {
      const player = fieldPlayer(aliasIndex, field);
      const aliases = [
        field.playerId,
        field.playerName,
        player && player.id,
        player && player.name,
        player && player.dataGolfId,
        player && player.pgaTourId
      ].map(cleanString).filter(Boolean);
      const playerRounds = lab.rounds.filter((round) => rowMatchesPlayerAliases(round, aliases));
      const sgRows = lab.strokesGained.filter((row) => rowMatchesPlayerAliases(row, aliases));
      const eventOdds = lab.oddsSnapshots.filter((row) =>
        row.eventId === event.id &&
        rowMatchesPlayerAliases(row, aliases) &&
        fieldReadinessMarketMatches(row.market, options.market || options.marketFilter)
      );
      const predictionRows = [...lab.modelPredictions, ...lab.predictionLedger].filter((row) =>
        row.eventId === event.id &&
        rowMatchesPlayerAliases(row, aliases) &&
        fieldReadinessMarketMatches(row.market, options.market || options.marketFilter)
      );
      const equipmentRows = lab.equipmentSnapshots.filter((row) => rowMatchesPlayerAliases(row, aliases));
      const accomplishmentRows = lab.accomplishments.filter((row) => rowMatchesPlayerAliases(row, aliases));
      const courseRounds = course ? playerRounds.filter((round) => rowMatchesCourse(round, course)) : [];
      const compRounds = playerRounds.filter((round) =>
        compCourseIds.has(cleanString(round.courseId)) ||
        compCourseNames.has(cleanString(round.courseName))
      );
      const taggedWeatherRounds = playerRounds
        .map((round) => ({ round, snapshot: weatherForRound(lab.weatherSnapshots, round) }))
        .filter(({ snapshot }) => snapshot);
      const targetWeatherRounds = targetWeather.bucket === "No weather"
        ? []
        : taggedWeatherRounds.filter(({ snapshot }) => weatherBucket(snapshot) === targetWeather.bucket);
      const proofRows = [
        player,
        field,
        ...playerRounds,
        ...sgRows,
        ...eventOdds,
        ...predictionRows,
        ...equipmentRows,
        ...accomplishmentRows
      ].filter(Boolean);
      const sourceProofRows = proofRows.filter(rowHasSourceProof).length;
      const sourceProofPct = proofRows.length ? Math.round((sourceProofRows / proofRows.length) * 100) : 0;
      const profileFields = player
        ? [player.name, player.country, player.tour, player.owgrRank, player.profileUrl, player.sourceProvider || player.sourceUrl]
        : [];
      const profileScore = player
        ? Math.min(100, 45 + profileFields.filter((value) => value !== null && value !== undefined && value !== "").length * 10)
        : 0;
      const formScore = Math.min(100, Math.round(Math.min(1, playerRounds.length / 12) * 62 + Math.min(1, sgRows.length / 6) * 38));
      const courseScore = courseRounds.length
        ? Math.min(100, 45 + courseRounds.length * 25)
        : compRounds.length
          ? Math.min(85, 25 + compRounds.length * 18)
          : 0;
      const weatherScore = targetWeather.bucket === "No weather"
        ? 0
        : Math.min(100, targetWeatherRounds.length * 40 + Math.min(20, taggedWeatherRounds.length * 4));
      const enrichmentScore = Math.min(100,
        (equipmentRows.length ? 35 : 0) +
        (accomplishmentRows.length ? 30 : 0) +
        Math.min(35, Math.round(sourceProofPct * 0.35))
      );
      const parts = {
        profile: profileScore,
        field: 100,
        form: formScore,
        course: course ? courseScore : 0,
        weather: weatherScore,
        market: eventOdds.length ? 100 : 0,
        model: predictionRows.length ? 100 : 0,
        enrichment: enrichmentScore
      };
      const score = weightedReadinessScore(parts);
      const gaps = [
        !player ? "Profile match" : "",
        profileScore < 75 ? "Profile metadata" : "",
        formScore < 60 ? "Round/SG history" : "",
        course ? (courseScore < 55 ? "Course or comp rounds" : "") : "Course profile",
        targetWeather.bucket !== "No weather" && weatherScore < 55 ? `${targetWeather.bucket} history` : "",
        !eventOdds.length ? "Market odds" : "",
        !predictionRows.length ? "Model run" : "",
        enrichmentScore < 45 ? "Equipment/accomplishments" : "",
        sourceProofPct < 50 ? "Source proof" : ""
      ].filter(Boolean);
      const status = readinessStatus(score);
      return {
        fieldId: field.id,
        playerId: player ? player.id : cleanString(field.playerId || field.playerName),
        playerName: player ? player.name : cleanString(field.playerName || field.playerId),
        matchedProfile: Boolean(player),
        status,
        statusLabel: readinessStatusLabel(status),
        score,
        parts,
        gaps,
        counts: {
          rounds: playerRounds.length,
          strokesGainedRows: sgRows.length,
          courseRounds: courseRounds.length,
          compRounds: compRounds.length,
          weatherTaggedRounds: taggedWeatherRounds.length,
          targetWeatherRounds: targetWeatherRounds.length,
          oddsRows: eventOdds.length,
          predictions: predictionRows.length,
          equipmentSnapshots: equipmentRows.length,
          accomplishments: accomplishmentRows.length,
          sourceProofRows,
          sourceProofTotal: proofRows.length
        },
        sourceProofPct
      };
    }).sort((a, b) =>
      a.score - b.score ||
      b.gaps.length - a.gaps.length ||
      cleanString(a.playerName).localeCompare(cleanString(b.playerName))
    );
    const gapCounts = rows.reduce((acc, row) => {
      row.gaps.forEach((gap) => {
        acc[gap] = (acc[gap] || 0) + 1;
      });
      return acc;
    }, {});
    const topGaps = Object.entries(gapCounts)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || cleanString(a.label).localeCompare(cleanString(b.label)))
      .slice(0, 6);
    return {
      event: {
        eventId: event.id,
        name: event.name || event.id,
        startDate: event.startDate,
        courseName: event.courseName,
        tour: event.tour
      },
      course: course ? {
        courseId: course.id,
        courseName: course.name || course.id,
        location: course.location
      } : null,
      targetWeather,
      market: cleanString(options.market || options.marketFilter || "all") || "all",
      summary: {
        players: fields.length,
        avgScore: avg(rows.map((row) => row.score)),
        premiumReady: rows.filter((row) => row.status === "premium-ready").length,
        modelReady: rows.filter((row) => row.status === "model-ready" || row.status === "premium-ready").length,
        building: rows.filter((row) => row.status === "building").length,
        thin: rows.filter((row) => row.status === "thin").length,
        matchedProfiles: rows.filter((row) => row.matchedProfile).length,
        marketReady: rows.filter((row) => row.counts.oddsRows > 0).length,
        modelRunReady: rows.filter((row) => row.counts.predictions > 0).length,
        topGaps
      },
      rows: rows.slice(0, limit),
      allRows: rows
    };
  }

  function leaderboardRows(lab, rounds, limit) {
    const aliasIndex = buildPlayerAliasIndex(lab.players);
    const groups = rounds.reduce((acc, round) => {
      const player = findPlayerByRound(aliasIndex, round);
      const key = player ? player.id : cleanString(round.playerId || round.playerName);
      if (!key) return acc;
      if (!acc[key]) {
        acc[key] = {
          playerId: key,
          playerName: player ? player.name : round.playerName || key,
          rounds: []
        };
      }
      acc[key].rounds.push(round);
      return acc;
    }, {});
    return Object.values(groups)
      .map((group) => {
        const sgValues = group.rounds.map((round) => numberOrNull(round.sgTotal));
        const scoreValues = group.rounds.map(roundScoreValue);
        return {
          playerId: group.playerId,
          playerName: group.playerName,
          rounds: group.rounds.length,
          avgSg: avg(sgValues),
          avgToPar: avg(scoreValues)
        };
      })
      .filter((row) => row.rounds > 0)
      .sort((a, b) => {
        const aValue = Number.isFinite(a.avgSg) ? -a.avgSg : a.avgToPar;
        const bValue = Number.isFinite(b.avgSg) ? -b.avgSg : b.avgToPar;
        return aValue - bValue || b.rounds - a.rounds || cleanString(a.playerName).localeCompare(cleanString(b.playerName));
      })
      .slice(0, limit);
  }

  function buildPlayerSplitLeaderboards(input, options = {}) {
    const lab = normalizeGolfLabState(input);
    const limit = Math.max(1, intOrNull(options.limit) || 8);
    const coursesById = new Map(lab.courses.map((course) => [course.id, course]));
    const coursesByName = new Map(lab.courses.map((course) => [course.name.toLowerCase(), course]));
    const difficultyRounds = lab.rounds.reduce((acc, round) => {
      const key = cleanString(round.courseId) || cleanString(round.courseName);
      const course = coursesById.get(key) || coursesByName.get(cleanString(round.courseName || key).toLowerCase()) || {};
      const bucket = cleanString(round.difficultyBucket) || classifyCourseDifficulty(course).bucket;
      if (!acc[bucket]) acc[bucket] = [];
      acc[bucket].push(round);
      return acc;
    }, {});
    const weatherRounds = lab.rounds.reduce((acc, round) => {
      const snapshot = weatherForRound(lab.weatherSnapshots, round);
      const bucket = weatherBucket(snapshot);
      if (!bucket) return acc;
      if (!acc[bucket]) acc[bucket] = [];
      acc[bucket].push(round);
      return acc;
    }, {});
    return {
      toughCourseLeaders: leaderboardRows(lab, [...(difficultyRounds.Brutal || []), ...(difficultyRounds.Tough || [])], limit),
      easyCourseLeaders: leaderboardRows(lab, difficultyRounds.Easy || [], limit),
      windLeaders: leaderboardRows(lab, weatherRounds.Wind || [], limit),
      rainLeaders: leaderboardRows(lab, weatherRounds.Rain || [], limit),
      calmLeaders: leaderboardRows(lab, weatherRounds.Calm || [], limit)
    };
  }

  function sourceCoverageStatus(score) {
    if (score >= 85) return { key: "premium-ready", label: "Premium ready" };
    if (score >= 68) return { key: "model-ready", label: "Model ready" };
    if (score >= 45) return { key: "building", label: "Building" };
    return { key: "thin", label: "Thin" };
  }

  function splitDisplay(row) {
    if (!row) return "--";
    if (Number.isFinite(row.avgSg)) return `${row.avgSg >= 0 ? "+" : ""}${row.avgSg.toFixed(2)} SG`;
    if (Number.isFinite(row.avgToPar)) return `${row.avgToPar >= 0 ? "+" : ""}${row.avgToPar.toFixed(1)} to par`;
    return "--";
  }

  function signalRow(id, label, value, detail, tone = "neutral", meta = {}) {
    return {
      id,
      label,
      value,
      detail: cleanString(detail),
      tone,
      ...meta
    };
  }

  function skillSignals(skills) {
    const rows = [
      signalRow("sgTotal", "Total Skill", numberOrNull(skills.sgTotal), "Strokes gained total"),
      signalRow("sgT2g", "Tee to Green", numberOrNull(skills.sgT2g), "Ball-striking baseline"),
      signalRow("sgOtt", "Off the Tee", numberOrNull(skills.sgOtt), "Driving value"),
      signalRow("sgApp", "Approach", numberOrNull(skills.sgApp), "Iron and wedge value"),
      signalRow("sgArg", "Around Green", numberOrNull(skills.sgArg), "Short-game value"),
      signalRow("sgPutt", "Putting", numberOrNull(skills.sgPutt), "Putting value")
    ];
    return rows.filter((row) => Number.isFinite(row.value));
  }

  function buildPlayerProfile(card, toughSplit, easySplit, windSplit, rainSplit) {
    const skills = card.skills;
    const skillRows = skillSignals(skills);
    const sortedSkills = [...skillRows].sort((a, b) => b.value - a.value);
    const bestSkill = sortedSkills[0] || null;
    const tags = [];
    if (Number.isFinite(skills.sgTotal) && skills.sgTotal >= 1.25) tags.push("Elite SG profile");
    if (Number.isFinite(skills.sgApp) && skills.sgApp >= 0.55) tags.push("Approach engine");
    if (Number.isFinite(skills.sgOtt) && skills.sgOtt >= 0.45) tags.push("Driver positive");
    if (Number.isFinite(skills.drivingDistance) && skills.drivingDistance >= 305) tags.push("Power");
    if (Number.isFinite(skills.accuracy) && skills.accuracy >= 0.65) tags.push("Accuracy");
    if (Number.isFinite(performanceValue(toughSplit)) && performanceValue(toughSplit) >= 0.45) tags.push("Tough-course positive");
    if (Number.isFinite(performanceValue(easySplit)) && performanceValue(easySplit) >= 0.45) tags.push("Birdie-course scorer");
    if (Number.isFinite(performanceValue(windSplit)) && performanceValue(windSplit) >= 0.35) tags.push("Wind positive");
    if (Number.isFinite(performanceValue(rainSplit)) && performanceValue(rainSplit) >= 0.35) tags.push("Rain positive");
    if (!tags.length && card.sample.rounds) tags.push("Balanced profile");

    let archetype = "Needs profile";
    if (Number.isFinite(skills.sgTotal) && skills.sgTotal >= 1.25 && Number.isFinite(skills.sgT2g) && skills.sgT2g >= 1) archetype = "All-Around Contender";
    else if (Number.isFinite(skills.sgApp) && skills.sgApp >= 0.55) archetype = "Approach Engine";
    else if (Number.isFinite(skills.sgOtt) && skills.sgOtt >= 0.45 && Number.isFinite(skills.drivingDistance) && skills.drivingDistance >= 305) archetype = "Power Driver";
    else if (Number.isFinite(skills.accuracy) && skills.accuracy >= 0.65) archetype = "Fairway Finder";
    else if (Number.isFinite(skills.sgPutt) && skills.sgPutt >= 0.45) archetype = "Putter Driven";
    else if (card.sample.rounds || card.sample.strokesGainedRows) archetype = "Balanced Profile";

    const strengths = [
      ...sortedSkills
        .filter((row) => row.value >= 0.25)
        .slice(0, 4)
        .map((row) => signalRow(row.id, row.label, row.value, `${row.value >= 0 ? "+" : ""}${row.value.toFixed(2)} SG`, "positive")),
      Number.isFinite(skills.drivingDistance) && skills.drivingDistance >= 305
        ? signalRow("distance", "Distance", skills.drivingDistance, `${Math.round(skills.drivingDistance)} yards`, "positive")
        : null,
      Number.isFinite(skills.accuracy) && skills.accuracy >= 0.65
        ? signalRow("accuracy", "Accuracy", skills.accuracy, `${Math.round(skills.accuracy * 100)}% fairways`, "positive")
        : null,
      Number.isFinite(performanceValue(toughSplit)) && performanceValue(toughSplit) >= 0.35
        ? signalRow("tough", "Tough Courses", performanceValue(toughSplit), `${splitDisplay(toughSplit)} | ${toughSplit.rounds} rounds`, "positive")
        : null,
      Number.isFinite(performanceValue(windSplit)) && performanceValue(windSplit) >= 0.35
        ? signalRow("wind", "Wind", performanceValue(windSplit), `${splitDisplay(windSplit)} | ${windSplit.rounds} rounds`, "positive")
        : null
    ].filter(Boolean).slice(0, 6);

    const risks = [
      ...skillRows
        .filter((row) => row.value <= -0.2)
        .sort((a, b) => a.value - b.value)
        .slice(0, 3)
        .map((row) => signalRow(row.id, row.label, row.value, `${row.value.toFixed(2)} SG`, "risk")),
      !card.sample.rounds ? signalRow("rounds", "Round History", 0, "No imported pro rounds", "risk") : null,
      card.sample.rounds > 0 && card.sample.rounds < 8 ? signalRow("thin-rounds", "Round Sample", card.sample.rounds, `${card.sample.rounds} imported rounds`, "watch") : null,
      !card.sample.strokesGainedRows ? signalRow("sg", "SG Profile", 0, "No strokes-gained rows", "risk") : null,
      !card.equipment ? signalRow("bag", "Bag Snapshot", 0, "No source-backed equipment", "watch") : null,
      !card.accomplishments.length ? signalRow("accomplishments", "Accomplishments", 0, "No accomplishment rows", "watch") : null
    ].filter(Boolean).slice(0, 5);

    return {
      archetype,
      primarySkill: bestSkill ? bestSkill.label : "",
      tags: tags.slice(0, 7),
      strengths,
      risks
    };
  }

  function buildPlayerSourceCoverage(player, playerRows, sgRows, courseRows, weatherSplits, equipment, accomplishments, proofRows) {
    const profileFields = [player.name, player.country, player.tour, player.owgrRank, player.profileUrl, player.sourceProvider || player.sourceUrl];
    const profileScore = Math.round((profileFields.filter((value) => value !== null && value !== undefined && value !== "").length / profileFields.length) * 100);
    const roundScore = Math.min(100, Math.round((playerRows.length / 12) * 100));
    const sgScore = Math.min(100, Math.round((sgRows.length / 6) * 100));
    const courseScore = Math.min(100, Math.round((courseRows.length / 4) * 100));
    const weatherScore = Math.min(100, Math.round((weatherSplits.reduce((sum, row) => sum + row.rounds, 0) / 6) * 100));
    const enrichmentScore = Math.min(100, (equipment ? 45 : 0) + Math.min(35, accomplishments.length * 12) + (player.profileUrl ? 20 : 0));
    const proofTotal = proofRows.length;
    const proofReady = proofRows.filter(rowHasSourceProof).length;
    const proofScore = proofTotal ? Math.round((proofReady / proofTotal) * 100) : 0;
    const score = Math.round(
      profileScore * 0.15 +
      roundScore * 0.2 +
      sgScore * 0.22 +
      courseScore * 0.14 +
      weatherScore * 0.08 +
      enrichmentScore * 0.08 +
      proofScore * 0.13
    );
    const status = sourceCoverageStatus(score);
    const gaps = [
      profileScore < 75 ? "Profile metadata" : "",
      roundScore < 70 ? "Round history" : "",
      sgScore < 70 ? "Strokes gained rows" : "",
      courseScore < 50 ? "Course history" : "",
      weatherScore < 40 ? "Weather-linked rounds" : "",
      !equipment ? "Bag snapshot" : "",
      !accomplishments.length ? "Accomplishments" : "",
      proofScore < 60 ? "Source proof" : ""
    ].filter(Boolean);
    return {
      score,
      status: status.key,
      statusLabel: status.label,
      counts: {
        rounds: playerRows.length,
        strokesGainedRows: sgRows.length,
        courses: courseRows.length,
        weatherSplits: weatherSplits.length,
        equipmentSnapshots: equipment ? 1 : 0,
        accomplishments: accomplishments.length,
        proofReady,
        proofTotal
      },
      parts: {
        profile: profileScore,
        rounds: roundScore,
        strokesGained: sgScore,
        courses: courseScore,
        weather: weatherScore,
        enrichment: enrichmentScore,
        proof: proofScore
      },
      gaps
    };
  }

  function scoreFromPerformance(value) {
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, Math.round(55 + value * 16)));
  }

  function buildPlayerEventFit(lab, player, aliases, card, options = {}) {
    const event = chooseEventForDossier(lab, options.eventId);
    if (!event) return null;
    const course = courseForEvent(lab, event);
    const courseDifficulty = course ? classifyCourseDifficulty(course).bucket : "Unknown";
    const eventWeather = eventWeatherMatrixTarget(lab.weatherSnapshots.filter((row) => row.eventId === event.id));
    const aliasIndex = buildPlayerAliasIndex(lab.players);
    const field = lab.fields.find((row) =>
      row.eventId === event.id &&
      rowMatchesPlayerAliases(row, aliases)
    );
    const resolvedFieldPlayer = field ? fieldPlayer(aliasIndex, field) : null;
    const inField = Boolean(field && (!resolvedFieldPlayer || resolvedFieldPlayer.id === player.id));
    const courseSplit = course
      ? [...card.bestCourses, ...card.worstCourses].find((row) => rowMatchesCourse(row, course)) || null
      : null;
    const difficultyRows = courseDifficulty === "Brutal" || courseDifficulty === "Tough"
      ? card.difficultySplits.filter((row) => row.bucket === "Brutal" || row.bucket === "Tough")
      : card.difficultySplits.filter((row) => row.bucket === courseDifficulty);
    const difficultySplit = combinePerformanceRows(difficultyRows);
    const weatherSplit = card.weatherSplits.find((row) => row.bucket === eventWeather.bucket) || null;
    const eventPredictions = [...lab.modelPredictions, ...lab.predictionLedger].filter((row) =>
      row.eventId === event.id &&
      rowMatchesPlayerAliases(row, aliases)
    );
    const eventOdds = lab.oddsSnapshots.filter((row) =>
      row.eventId === event.id &&
      rowMatchesPlayerAliases(row, aliases)
    );
    const skillScore = scoreFromPerformance(numberOrNull(card.skills.sgTotal));
    const courseScore = scoreFromPerformance(performanceValue(courseSplit));
    const difficultyScore = scoreFromPerformance(performanceValue(difficultySplit));
    const weatherScore = eventWeather.bucket && eventWeather.bucket !== "No weather"
      ? scoreFromPerformance(performanceValue(weatherSplit))
      : null;
    const components = [
      Number.isFinite(skillScore) ? skillScore * 0.28 : null,
      Number.isFinite(courseScore) ? courseScore * 0.2 : null,
      Number.isFinite(difficultyScore) ? difficultyScore * 0.2 : null,
      Number.isFinite(weatherScore) ? weatherScore * 0.12 : null,
      inField ? 10 : 0,
      eventPredictions.length ? 6 : 0,
      eventOdds.length ? 4 : 0
    ].filter(Number.isFinite);
    const score = components.length ? Math.round(components.reduce((sum, value) => sum + value, 0)) : 0;
    const cappedScore = Math.max(0, Math.min(100, score));
    const label = cappedScore >= 78 ? "Strong fit" : cappedScore >= 58 ? "Viable fit" : cappedScore >= 35 ? "Thin fit" : "Needs data";
    const signals = [
      inField ? signalRow("field", "Field", 1, field.status || "active", "positive") : signalRow("field", "Field", 0, "Not in imported field", "risk"),
      courseSplit ? signalRow("course", course ? course.name || course.id : "Course", performanceValue(courseSplit), `${splitDisplay(courseSplit)} | ${courseSplit.rounds} rounds`, performanceValue(courseSplit) >= 0 ? "positive" : "risk") : null,
      difficultySplit ? signalRow("difficulty", `${courseDifficulty} Courses`, performanceValue(difficultySplit), `${splitDisplay(difficultySplit)} | ${difficultySplit.rounds} rounds`, performanceValue(difficultySplit) >= 0 ? "positive" : "risk") : null,
      weatherSplit ? signalRow("weather", eventWeather.bucket, performanceValue(weatherSplit), `${splitDisplay(weatherSplit)} | ${weatherSplit.rounds} rounds`, performanceValue(weatherSplit) >= 0 ? "positive" : "risk") : null,
      eventPredictions.length ? signalRow("model", "Model", eventPredictions.length, `${eventPredictions.length} prediction rows`, "positive") : null,
      eventOdds.length ? signalRow("market", "Market", eventOdds.length, `${eventOdds.length} odds rows`, "positive") : null
    ].filter(Boolean);
    const gaps = [
      !inField ? "Import or confirm field status" : "",
      !course ? "Course profile" : "",
      course && !courseSplit ? "Course-specific player history" : "",
      !difficultySplit ? "Difficulty split history" : "",
      eventWeather.bucket !== "No weather" && !weatherSplit ? `${eventWeather.bucket} weather history` : "",
      !eventPredictions.length ? "Model output" : "",
      !eventOdds.length ? "Market odds" : ""
    ].filter(Boolean);
    return {
      event: {
        eventId: event.id,
        name: event.name || event.id,
        startDate: event.startDate,
        courseName: event.courseName,
        tour: event.tour
      },
      course: course ? {
        courseId: course.id,
        courseName: course.name || course.id,
        difficulty: courseDifficulty
      } : null,
      inField,
      fieldStatus: field ? field.status || "active" : "",
      targetWeather: eventWeather,
      score: cappedScore,
      label,
      courseSplit,
      difficultySplit,
      weatherSplit,
      predictions: eventPredictions.length,
      oddsRows: eventOdds.length,
      signals,
      gaps
    };
  }

  function summarizePlayerCourseRow(row) {
    if (!row) return null;
    return {
      courseName: row.courseName || row.courseId || "",
      difficulty: row.difficulty || "",
      rounds: row.rounds || 0,
      avgSg: row.avgSg,
      avgToPar: row.avgToPar,
      display: splitDisplay(row)
    };
  }

  function summarizePlayerEquipment(equipment) {
    if (!equipment) return null;
    const parts = [
      { label: "Driver", value: equipment.driver },
      { label: "Woods", value: equipment.fairwayWoods },
      { label: "Hybrids", value: equipment.hybrids },
      { label: "Irons", value: equipment.irons },
      { label: "Wedges", value: equipment.wedges },
      { label: "Putter", value: equipment.putter },
      { label: "Ball", value: equipment.ball }
    ].filter((item) => cleanString(item.value));
    return {
      capturedDate: equipment.capturedDate || "",
      sourceUrl: equipment.sourceUrl || "",
      primaryLabel: parts[0] ? parts[0].label : "Snapshot",
      primaryValue: parts[0] ? parts[0].value : equipment.capturedDate || "Imported",
      parts
    };
  }

  function summarizePlayerAccomplishment(accomplishments) {
    const item = accomplishments && accomplishments[0] ? accomplishments[0] : null;
    if (!item) return null;
    return {
      label: item.label || item.eventName || "",
      type: item.type || "",
      season: item.season || "",
      date: item.date || ""
    };
  }

  function summarizePlayerTopSkill(skills) {
    const rows = [
      { label: "SG Total", value: skills.sgTotal },
      { label: "Tee to Green", value: skills.sgT2g },
      { label: "Approach", value: skills.sgApp },
      { label: "Off the Tee", value: skills.sgOtt },
      { label: "Around Green", value: skills.sgArg },
      { label: "Putting", value: skills.sgPutt }
    ].filter((row) => Number.isFinite(row.value));
    return rows.sort((a, b) => b.value - a.value)[0] || null;
  }

  function buildPlayerScorecardSnapshot(card) {
    const profile = card.profile || {};
    const eventFit = card.eventFit || null;
    const sourceCoverage = card.sourceCoverage || {};
    return {
      headline: eventFit ? eventFit.label : profile.archetype || "Profile building",
      headlineDetail: eventFit && eventFit.event
        ? [eventFit.event.name, eventFit.course && eventFit.course.courseName].filter(Boolean).join(" | ")
        : profile.primarySkill || "",
      topSkill: summarizePlayerTopSkill(card.skills),
      bestCourse: summarizePlayerCourseRow(card.bestCourses[0]),
      worstCourse: summarizePlayerCourseRow(card.worstCourses[0]),
      equipment: summarizePlayerEquipment(card.equipment),
      accomplishment: summarizePlayerAccomplishment(card.accomplishments),
      sourceStatus: sourceCoverage.status || "thin",
      sourceScore: sourceCoverage.score
    };
  }

  function buildPlayerScorecard(input, playerId, options = {}) {
    const lab = normalizeGolfLabState(input);
    const id = cleanString(playerId) || (lab.players[0] && lab.players[0].id) || "";
    if (!id) return null;
    const player = lab.players.find((candidate) => candidate.id === id || candidate.dataGolfId === id || candidate.pgaTourId === id);
    if (!player) return null;
    const playerIds = [player.id, player.dataGolfId, player.pgaTourId].filter(Boolean);
    const aliases = [player.id, player.name, player.dataGolfId, player.pgaTourId].map(cleanString).filter(Boolean);
    const playerRounds = lab.rounds.filter((round) => playerIds.includes(round.playerId) || round.playerName === player.name);
    const sgRows = lab.strokesGained.filter((row) => playerIds.includes(row.playerId) || row.playerName === player.name);
    const coursesById = new Map(lab.courses.map((course) => [course.id, course]));
    const coursesByName = new Map(lab.courses.map((course) => [course.name.toLowerCase(), course]));
    const courseRows = buildCourseRows(playerRounds, coursesById, coursesByName);
    const eventsById = new Map(lab.events.map((event) => [event.id, event]));
    const multiCourseEvents = Object.entries(groupByKey(
      playerRounds.filter((round) => !cleanString(round.courseId) && !cleanString(round.courseName)),
      "eventId"
    )).map(([eventId, rounds]) => {
      const event = eventsById.get(eventId);
      const coursePool = eventCoursePoolSummary(lab, event);
      if (!event || !coursePool) return null;
      return {
        eventId,
        eventName: event.name || eventId,
        startDate: event.startDate,
        rounds: rounds.length,
        avgSg: avg(rounds.map((round) => numberOrNull(round.sgTotal))),
        avgToPar: avg(rounds.map(roundScoreValue)),
        courseCount: coursePool.courseCount,
        courseNames: coursePool.courseNames,
        label: coursePool.label,
        confidence: coursePool.confidence
      };
    }).filter(Boolean).sort((a, b) => cleanString(b.startDate).localeCompare(cleanString(a.startDate))).slice(0, 6);
    const difficultySplits = buildDifficultySplits(playerRounds, coursesById, coursesByName);
    const weatherSplits = buildWeatherSplits(playerRounds, lab.weatherSnapshots);
    const bestCourses = [...courseRows].sort((a, b) => {
      const aValue = Number.isFinite(a.avgSg) ? -a.avgSg : a.avgToPar;
      const bValue = Number.isFinite(b.avgSg) ? -b.avgSg : b.avgToPar;
      return aValue - bValue;
    }).slice(0, 5);
    const worstCourses = [...courseRows].sort((a, b) => {
      const aValue = Number.isFinite(a.avgSg) ? -a.avgSg : a.avgToPar;
      const bValue = Number.isFinite(b.avgSg) ? -b.avgSg : b.avgToPar;
      return bValue - aValue;
    }).slice(0, 5);
    const equipment = latestByDate(
      lab.equipmentSnapshots.filter((item) => playerIds.includes(item.playerId)),
      "capturedDate"
    );
    const accomplishments = lab.accomplishments
      .filter((item) => playerIds.includes(item.playerId))
      .sort((a, b) => cleanString(b.date).localeCompare(cleanString(a.date)))
      .slice(0, 8);
    const skillValues = sgRows.length ? sgRows : playerRounds;
    const card = {
      player,
      sample: {
        rounds: playerRounds.length,
        strokesGainedRows: sgRows.length,
        courses: courseRows.length,
        multiCourseEvents: multiCourseEvents.length
      },
      skills: {
        sgTotal: avg(skillValues.map((row) => numberOrNull(row.sgTotal))),
        sgOtt: avg(skillValues.map((row) => numberOrNull(row.sgOtt))),
        sgApp: avg(skillValues.map((row) => numberOrNull(row.sgApp))),
        sgArg: avg(skillValues.map((row) => numberOrNull(row.sgArg))),
        sgPutt: avg(skillValues.map((row) => numberOrNull(row.sgPutt))),
        sgT2g: avg(skillValues.map((row) => numberOrNull(row.sgT2g))),
        drivingDistance: avg(skillValues.map((row) => numberOrNull(row.drivingDistance))),
        accuracy: avg(skillValues.map((row) => numberOrNull(row.accuracy))),
        gir: avg(skillValues.map((row) => numberOrNull(row.gir))),
        scrambling: avg(skillValues.map((row) => numberOrNull(row.scrambling)))
      },
      bestCourses,
      worstCourses,
      multiCourseEvents,
      difficultySplits,
      weatherSplits,
      equipment,
      accomplishments
    };
    const toughSplit = combinePerformanceRows(difficultySplits.filter((row) => ["Brutal", "Tough"].includes(row.bucket)));
    const easySplit = combinePerformanceRows(difficultySplits.filter((row) => row.bucket === "Easy"));
    const windSplit = combinePerformanceRows(weatherSplits.filter((row) => row.bucket === "Wind"));
    const rainSplit = combinePerformanceRows(weatherSplits.filter((row) => row.bucket === "Rain"));
    const proofRows = [player, ...playerRounds, ...sgRows, ...(equipment ? [equipment] : []), ...accomplishments].filter(Boolean);
    card.profile = buildPlayerProfile(card, toughSplit, easySplit, windSplit, rainSplit);
    card.sourceCoverage = buildPlayerSourceCoverage(player, playerRounds, sgRows, courseRows, weatherSplits, equipment, accomplishments, proofRows);
    card.eventFit = buildPlayerEventFit(lab, player, aliases, card, options);
    card.weatherDna = buildPlayerWeatherDna(playerRounds, weatherSplits, card.eventFit ? card.eventFit.targetWeather : null);
    card.snapshot = buildPlayerScorecardSnapshot(card);
    return card;
  }

  function combinePerformanceRows(rows) {
    const usable = rows.filter((row) => row && row.rounds > 0);
    const rounds = usable.reduce((sum, row) => sum + row.rounds, 0);
    if (!rounds) return null;
    const weightedAvg = (key) => {
      const values = usable.filter((row) => Number.isFinite(row[key]));
      if (!values.length) return null;
      return values.reduce((sum, row) => sum + row[key] * row.rounds, 0) / values.reduce((sum, row) => sum + row.rounds, 0);
    };
    return {
      rounds,
      avgSg: weightedAvg("avgSg"),
      avgToPar: weightedAvg("avgToPar")
    };
  }

  function performanceValue(row) {
    if (!row) return null;
    if (Number.isFinite(row.avgSg)) return row.avgSg;
    if (Number.isFinite(row.avgToPar)) return -row.avgToPar;
    return null;
  }

  function playerIndexScore(card, toughSplit, windSplit) {
    const skill = Number.isFinite(card.skills.sgTotal) ? card.skills.sgTotal * 24 : 0;
    const recent = Math.min(18, card.sample.rounds * 1.2);
    const courseDepth = Math.min(16, card.sample.courses * 4);
    const tough = Number.isFinite(performanceValue(toughSplit)) ? performanceValue(toughSplit) * 8 : 0;
    const wind = Number.isFinite(performanceValue(windSplit)) ? performanceValue(windSplit) * 5 : 0;
    const profile = (card.equipment ? 4 : 0) + Math.min(6, card.accomplishments.length);
    return Math.round((skill + recent + courseDepth + tough + wind + profile) * 10) / 10;
  }

  function buildPlayerIndexBoard(input, options = {}) {
    const lab = normalizeGolfLabState(input);
    const limit = Math.max(1, intOrNull(options.limit) || lab.players.length || 1);
    const rows = lab.players.map((player) => {
      const card = buildPlayerScorecard(lab, player.id, { eventId: options.eventId });
      if (!card) return null;
      const toughSplit = combinePerformanceRows(card.difficultySplits.filter((row) => ["Brutal", "Tough"].includes(row.bucket)));
      const easySplit = combinePerformanceRows(card.difficultySplits.filter((row) => row.bucket === "Easy"));
      const windSplit = combinePerformanceRows(card.weatherSplits.filter((row) => row.bucket === "Wind"));
      const rainSplit = combinePerformanceRows(card.weatherSplits.filter((row) => row.bucket === "Rain"));
      const calmSplit = combinePerformanceRows(card.weatherSplits.filter((row) => row.bucket === "Calm"));
      const tags = [];
      if (Number.isFinite(card.skills.sgTotal) && card.skills.sgTotal >= 1) tags.push("Elite SG");
      if (Number.isFinite(card.skills.drivingDistance) && card.skills.drivingDistance >= 305) tags.push("Power");
      if (Number.isFinite(card.skills.accuracy) && card.skills.accuracy >= 0.65) tags.push("Accurate");
      if (Number.isFinite(performanceValue(toughSplit)) && performanceValue(toughSplit) >= 0.5) tags.push("Tough-course plus");
      if (Number.isFinite(performanceValue(windSplit)) && performanceValue(windSplit) >= 0.4) tags.push("Wind fit");
      if (card.equipment) tags.push("Bag sourced");
      if (card.profile && card.profile.archetype && card.profile.archetype !== "Needs profile") tags.unshift(card.profile.archetype);
      return {
        playerId: player.id,
        playerName: player.name || player.id,
        player,
        sample: card.sample,
        skills: card.skills,
        bestCourse: card.bestCourses[0] || null,
        worstCourse: card.worstCourses[0] || null,
        splits: {
          tough: toughSplit,
          easy: easySplit,
          wind: windSplit,
          rain: rainSplit,
          calm: calmSplit
        },
        equipment: card.equipment,
        accomplishmentCount: card.accomplishments.length,
        profile: card.profile,
        sourceCoverage: card.sourceCoverage,
        eventFit: card.eventFit,
        tags: [...new Set(tags)],
        indexScore: playerIndexScore(card, toughSplit, windSplit)
      };
    }).filter(Boolean).sort((a, b) => {
      const sgDiff = (Number.isFinite(b.skills.sgTotal) ? b.skills.sgTotal : -99) - (Number.isFinite(a.skills.sgTotal) ? a.skills.sgTotal : -99);
      if (sgDiff) return sgDiff;
      return b.indexScore - a.indexScore || b.sample.rounds - a.sample.rounds || cleanString(a.playerName).localeCompare(cleanString(b.playerName));
    });
    const rankedBy = (getValue) => rows
      .filter((row) => Number.isFinite(getValue(row)))
      .sort((a, b) => getValue(b) - getValue(a))[0] || null;
    return {
      summary: {
        players: rows.length,
        playersWithRounds: rows.filter((row) => row.sample.rounds > 0).length,
        playersWithEquipment: rows.filter((row) => row.equipment).length,
        playersWithAccomplishments: rows.filter((row) => row.accomplishmentCount > 0).length,
        sgLeader: rankedBy((row) => row.skills.sgTotal),
        distanceLeader: rankedBy((row) => row.skills.drivingDistance),
        accuracyLeader: rankedBy((row) => row.skills.accuracy),
        toughCourseLeader: rankedBy((row) => performanceValue(row.splits.tough)),
        windLeader: rankedBy((row) => performanceValue(row.splits.wind)),
        eventFitLeader: rankedBy((row) => row.eventFit ? row.eventFit.score : null),
        avgSourceScore: avg(rows.map((row) => row.sourceCoverage ? row.sourceCoverage.score : null)),
        strongEventFits: rows.filter((row) => row.eventFit && row.eventFit.label === "Strong fit").length
      },
      rows: rows.slice(0, limit),
      allRows: rows
    };
  }

  function splitMetric(label, split) {
    const value = performanceValue(split);
    let tone = "missing";
    if (Number.isFinite(value)) {
      tone = value >= 0.35 ? "positive" : value <= -0.25 ? "risk" : "neutral";
    }
    return {
      label,
      value,
      display: splitDisplay(split),
      rounds: split ? split.rounds : 0,
      tone
    };
  }

  function splitScore(value) {
    const score = scoreFromPerformance(value);
    return Number.isFinite(score) ? score : 0;
  }

  function playerSplitRecommendation(row, target) {
    const toughTarget = ["Brutal", "Tough"].includes(target.difficultyBucket);
    const easyTarget = target.difficultyBucket === "Easy";
    if (toughTarget && Number.isFinite(row.metrics.tough.value) && row.metrics.tough.value >= 0.35) return "Major-test fit";
    if (easyTarget && Number.isFinite(row.metrics.easy.value) && row.metrics.easy.value >= 0.35) return "Scoring-course fit";
    if (target.weatherBucket === "Wind" && Number.isFinite(row.metrics.wind.value) && row.metrics.wind.value >= 0.25) return "Wind-window fit";
    if (target.weatherBucket === "Rain" && Number.isFinite(row.metrics.rain.value) && row.metrics.rain.value >= 0.25) return "Rain-window fit";
    if (Number.isFinite(row.metrics.comp.value) && row.metrics.comp.value >= 0.35) return "Comp-course fit";
    if (Number.isFinite(row.skills.sgTotal) && row.skills.sgTotal >= 1) return "Skill-led fit";
    return "Needs split depth";
  }

  function splitLeader(rows, getValue) {
    return rows
      .filter((row) => Number.isFinite(getValue(row)))
      .sort((a, b) => getValue(b) - getValue(a) || b.splitScore - a.splitScore || cleanString(a.playerName).localeCompare(cleanString(b.playerName)))[0] || null;
  }

  function buildPlayerSplitLab(input, options = {}) {
    const lab = normalizeGolfLabState(input);
    const event = chooseEventForDossier(lab, options.eventId);
    const limit = Math.max(1, intOrNull(options.limit) || 12);
    if (!event) return null;
    const course = courseForEvent(lab, event);
    const setup = course ? latestCourseSetup(lab, course, event) : null;
    const difficulty = course ? classifyCourseForBoard(course, setup, null) : { bucket: "Unknown", score: null, basis: "course missing" };
    const targetWeather = eventWeatherMatrixTarget(lab.weatherSnapshots.filter((row) => row.eventId === event.id));
    const aliasIndex = buildPlayerAliasIndex(lab.players);
    const activeFieldRows = lab.fields.filter((field) =>
      field.eventId === event.id &&
      !["wd", "withdrawn", "out"].includes(cleanString(field.status).toLowerCase())
    );
    const fieldPlayers = activeFieldRows.map((field) => fieldPlayer(aliasIndex, field)).filter(Boolean);
    const fieldIds = new Set(fieldPlayers.map((player) => player.id));
    const playerPool = fieldPlayers.length ? fieldPlayers : lab.players;
    const compBoard = course ? buildCourseCompBoard(lab, {
      eventId: event.id,
      courseLimit: Math.max(1, intOrNull(options.courseLimit) || 5),
      playerLimit: lab.players.length || 1
    }) : null;
    const compByPlayer = new Map((compBoard && compBoard.playerRows ? compBoard.playerRows : []).map((row) => [row.playerId, row]));
    const target = {
      difficultyBucket: difficulty.bucket,
      weatherBucket: targetWeather.bucket,
      toughSetup: ["Brutal", "Tough"].includes(difficulty.bucket),
      scoringSetup: difficulty.bucket === "Easy"
    };
    const rows = playerPool.map((player) => {
      const card = buildPlayerScorecard(lab, player.id, { eventId: event.id });
      if (!card) return null;
      const toughSplit = combinePerformanceRows(card.difficultySplits.filter((row) => ["Brutal", "Tough"].includes(row.bucket)));
      const easySplit = combinePerformanceRows(card.difficultySplits.filter((row) => row.bucket === "Easy"));
      const neutralSplit = combinePerformanceRows(card.difficultySplits.filter((row) => row.bucket === "Neutral"));
      const windSplit = combinePerformanceRows(card.weatherSplits.filter((row) => row.bucket === "Wind"));
      const rainSplit = combinePerformanceRows(card.weatherSplits.filter((row) => row.bucket === "Rain"));
      const calmSplit = combinePerformanceRows(card.weatherSplits.filter((row) => row.bucket === "Calm"));
      const targetDifficultySplit = target.toughSetup ? toughSplit : target.scoringSetup ? easySplit : neutralSplit;
      const targetWeatherSplit = target.weatherBucket === "Wind"
        ? windSplit
        : target.weatherBucket === "Rain"
          ? rainSplit
          : target.weatherBucket === "Calm"
            ? calmSplit
            : null;
      const compFit = compByPlayer.get(player.id) || null;
      const compValue = compFit ? performanceValue(compFit) : null;
      const metricRows = {
        tough: splitMetric("Tough", toughSplit),
        easy: splitMetric("Easy", easySplit),
        targetDifficulty: splitMetric("Target difficulty", targetDifficultySplit),
        wind: splitMetric("Wind", windSplit),
        rain: splitMetric("Rain", rainSplit),
        targetWeather: splitMetric("Target weather", targetWeatherSplit),
        comp: {
          label: "Comp courses",
          value: compValue,
          display: compFit ? splitDisplay(compFit) : "--",
          rounds: compFit ? compFit.rounds : 0,
          tone: Number.isFinite(compValue) ? compValue >= 0.35 ? "positive" : compValue <= -0.25 ? "risk" : "neutral" : "missing"
        }
      };
      const sampleScore = Math.min(100, Math.round((card.sample.rounds / 10) * 100));
      const weightedScore = Math.round(
        splitScore(card.skills.sgTotal) * 0.14 +
        splitScore(metricRows.targetDifficulty.value) * 0.2 +
        splitScore(metricRows.targetWeather.value) * 0.12 +
        splitScore(metricRows.comp.value) * 0.14 +
        (card.eventFit ? card.eventFit.score : 0) * 0.18 +
        (card.sourceCoverage ? card.sourceCoverage.score : 0) * 0.14 +
        sampleScore * 0.08
      );
      const row = {
        playerId: player.id,
        playerName: player.name || player.id,
        inField: !fieldPlayers.length || fieldIds.has(player.id),
        profile: card.profile,
        skills: card.skills,
        sample: card.sample,
        bestCourse: card.bestCourses[0] || null,
        worstCourse: card.worstCourses[0] || null,
        metrics: metricRows,
        compFit,
        eventFit: card.eventFit,
        sourceCoverage: card.sourceCoverage,
        splitScore: Math.max(0, Math.min(100, weightedScore)),
        gaps: [
          !card.sample.rounds ? "Round history" : "",
          !card.difficultySplits.length ? "Difficulty splits" : "",
          !card.weatherSplits.length ? "Weather splits" : "",
          course && !compFit ? "Comp-course rounds" : "",
          card.sourceCoverage && card.sourceCoverage.score < 68 ? "Source coverage" : ""
        ].filter(Boolean)
      };
      row.recommendation = playerSplitRecommendation(row, target);
      return row;
    }).filter(Boolean).sort((a, b) =>
      b.splitScore - a.splitScore ||
      splitScore(b.metrics.targetDifficulty.value) - splitScore(a.metrics.targetDifficulty.value) ||
      cleanString(a.playerName).localeCompare(cleanString(b.playerName))
    );
    const rowsWithSplits = rows.filter((row) =>
      Number.isFinite(row.metrics.tough.value) ||
      Number.isFinite(row.metrics.easy.value) ||
      Number.isFinite(row.metrics.wind.value) ||
      Number.isFinite(row.metrics.rain.value)
    );
    const blockers = [
      !activeFieldRows.length ? "Selected field missing" : "",
      !course ? "Course profile missing" : "",
      !rowsWithSplits.length ? "Player split history missing" : "",
      course && !(compBoard && compBoard.compCourses.length) ? "Course comps missing" : "",
      targetWeather.bucket !== "No weather" && !rows.some((row) => Number.isFinite(row.metrics.targetWeather.value)) ? `${targetWeather.bucket} player weather history missing` : "",
      rows.length && avg(rows.map((row) => row.sourceCoverage ? row.sourceCoverage.score : null)) < 35 ? "Source coverage thin" : ""
    ].filter(Boolean);
    return {
      event: {
        eventId: event.id,
        name: event.name || event.id,
        startDate: event.startDate,
        courseName: event.courseName,
        tour: event.tour
      },
      course: course ? {
        courseId: course.id,
        courseName: course.name || course.id,
        location: course.location,
        style: course.style
      } : null,
      target: {
        difficulty,
        weather: targetWeather,
        compCourses: compBoard ? compBoard.compCourses.length : 0,
        fieldMode: activeFieldRows.length ? "selected-field" : "all-players"
      },
      summary: {
        players: rows.length,
        fieldRows: activeFieldRows.length,
        matchedFieldPlayers: fieldPlayers.length,
        splitReadyPlayers: rowsWithSplits.length,
        strongFits: rows.filter((row) => row.splitScore >= 78).length,
        toughPositive: rows.filter((row) => Number.isFinite(row.metrics.tough.value) && row.metrics.tough.value >= 0.35).length,
        easyPositive: rows.filter((row) => Number.isFinite(row.metrics.easy.value) && row.metrics.easy.value >= 0.35).length,
        weatherPositive: rows.filter((row) => Number.isFinite(row.metrics.targetWeather.value) && row.metrics.targetWeather.value >= 0.25).length,
        compPositive: rows.filter((row) => Number.isFinite(row.metrics.comp.value) && row.metrics.comp.value >= 0.35).length,
        avgSourceScore: avg(rows.map((row) => row.sourceCoverage ? row.sourceCoverage.score : null)),
        blockers: blockers.length
      },
      leaders: {
        overall: rows[0] || null,
        tough: splitLeader(rows, (row) => row.metrics.tough.value),
        easy: splitLeader(rows, (row) => row.metrics.easy.value),
        weather: splitLeader(rows, (row) => row.metrics.targetWeather.value),
        comp: splitLeader(rows, (row) => row.metrics.comp.value)
      },
      blockers,
      rows: rows.slice(0, limit),
      allRows: rows
    };
  }

  function playerIdentityAliases(player) {
    return [...new Set([player.id, player.name, player.dataGolfId, player.pgaTourId].map(cleanString).filter(Boolean))].sort();
  }

  function identityTokens(value) {
    return cleanString(value).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);
  }

  function identitySimilarity(rawValue, aliasValue) {
    const rawCompact = compactIdentityValue(rawValue);
    const aliasCompact = compactIdentityValue(aliasValue);
    if (!rawCompact || !aliasCompact) return 0;
    if (rawCompact === aliasCompact) return 1;
    const minLength = Math.min(rawCompact.length, aliasCompact.length);
    if (minLength >= 6 && (rawCompact.includes(aliasCompact) || aliasCompact.includes(rawCompact))) return 0.82;
    const rawTokens = new Set(identityTokens(rawValue));
    const aliasTokens = new Set(identityTokens(aliasValue));
    if (!rawTokens.size || !aliasTokens.size) return 0;
    const overlap = [...rawTokens].filter((token) => aliasTokens.has(token)).length;
    const coverage = overlap / Math.max(rawTokens.size, aliasTokens.size);
    return coverage >= 0.5 ? coverage : 0;
  }

  function addIdentityOwner(map, key, player, alias) {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    const owners = map.get(key);
    if (!owners.some((owner) => owner.player.id === player.id)) owners.push({ player, alias });
  }

  function buildPlayerIdentityIndexes(players) {
    const directOwners = new Map();
    const compactOwners = new Map();
    const nameOwners = new Map();
    players.forEach((player) => {
      playerIdentityAliases(player).forEach((alias) => {
        addIdentityOwner(directOwners, alias.toLowerCase(), player, alias);
        addIdentityOwner(compactOwners, compactIdentityValue(alias), player, alias);
      });
      addIdentityOwner(nameOwners, compactIdentityValue(player.name), player, player.name || player.id);
    });
    const compactRows = (map) => [...map.entries()]
      .filter(([, owners]) => owners.length > 1)
      .map(([alias, owners]) => ({
        alias,
        players: owners.map((owner) => ({
          playerId: owner.player.id,
          playerName: owner.player.name || owner.player.id
        }))
      }));
    return {
      players,
      directOwners,
      compactOwners,
      aliasConflicts: compactRows(directOwners),
      compactConflicts: compactRows(compactOwners),
      duplicateProfiles: compactRows(nameOwners)
    };
  }

  function rowIdentityValues(row) {
    return [row && row.playerId, row && row.playerName].map(cleanString).filter(Boolean);
  }

  function bestIdentitySuggestion(values, players) {
    const rawValues = values.map(cleanString).filter(Boolean);
    let best = null;
    players.forEach((player) => {
      playerIdentityAliases(player).forEach((alias) => {
        rawValues.forEach((rawValue) => {
          const score = identitySimilarity(rawValue, alias);
          if (!best || score > best.score) best = { player, alias, rawValue, score };
        });
      });
    });
    if (!best || best.score < 0.58) return null;
    return {
      playerId: best.player.id,
      playerName: best.player.name || best.player.id,
      alias: best.alias,
      rawValue: best.rawValue,
      score: Math.round(best.score * 100)
    };
  }

  function resolveIdentityRow(row, indexes) {
    const values = rowIdentityValues(row);
    for (const value of values) {
      const owners = indexes.directOwners.get(value.toLowerCase()) || [];
      if (owners.length === 1) {
        return { matched: true, matchType: "exact", player: owners[0].player, matchedAlias: owners[0].alias, ambiguousPlayers: [] };
      }
      if (owners.length > 1) {
        return { matched: false, matchType: "ambiguous", player: null, matchedAlias: value, ambiguousPlayers: owners.map((owner) => owner.player) };
      }
    }
    for (const value of values) {
      const owners = indexes.compactOwners.get(compactIdentityValue(value)) || [];
      if (owners.length === 1) {
        return { matched: true, matchType: "normalized", player: owners[0].player, matchedAlias: owners[0].alias, ambiguousPlayers: [] };
      }
      if (owners.length > 1) {
        return { matched: false, matchType: "ambiguous", player: null, matchedAlias: value, ambiguousPlayers: owners.map((owner) => owner.player) };
      }
    }
    const suggestion = bestIdentitySuggestion(values, indexes.players);
    return { matched: false, matchType: suggestion ? "suggested" : "unmatched", player: null, matchedAlias: "", ambiguousPlayers: [], suggestion };
  }

  function identityCollectionDefinitions(lab) {
    return [
      { key: "fields", label: "Field Rows", rows: lab.fields, critical: true, eventScoped: true },
      { key: "rounds", label: "Round Results", rows: lab.rounds, critical: true, eventScoped: true },
      { key: "strokesGained", label: "Strokes Gained", rows: lab.strokesGained, critical: true, eventScoped: true },
      { key: "oddsSnapshots", label: "Market Odds", rows: lab.oddsSnapshots, critical: true, eventScoped: true },
      { key: "predictions", label: "Model Predictions", rows: [...lab.modelPredictions, ...lab.predictionLedger], critical: true, eventScoped: true },
      { key: "equipmentSnapshots", label: "Bag Snapshots", rows: lab.equipmentSnapshots, critical: false, eventScoped: false },
      { key: "accomplishments", label: "Accomplishments", rows: lab.accomplishments, critical: false, eventScoped: false }
    ];
  }

  function identityStatus(score, unresolvedRows, ambiguousRows) {
    if (ambiguousRows > 0) return "review";
    if (!unresolvedRows && score >= 95) return "resolved";
    if (score >= 85) return "watch";
    if (score >= 65) return "partial";
    return "blocked";
  }

  function buildPlayerIdentityBoard(input, options = {}) {
    const lab = normalizeGolfLabState(input);
    const event = chooseEventForDossier(lab, options.eventId);
    const indexes = buildPlayerIdentityIndexes(lab.players);
    const definitions = identityCollectionDefinitions(lab);
    const collectionRows = definitions.map((definition) => {
      const rows = definition.rows.filter((row) => rowIdentityValues(row).length);
      const resolvedRows = rows.map((row, index) => ({ row, index, resolution: resolveIdentityRow(row, indexes) }));
      const matchedRows = resolvedRows.filter((item) => item.resolution.matched);
      const exactRows = matchedRows.filter((item) => item.resolution.matchType === "exact");
      const normalizedRows = matchedRows.filter((item) => item.resolution.matchType === "normalized");
      const unresolvedRows = resolvedRows.filter((item) => !item.resolution.matched);
      const ambiguousRows = unresolvedRows.filter((item) => item.resolution.matchType === "ambiguous");
      const eventRows = event && definition.eventScoped ? resolvedRows.filter((item) => item.row.eventId === event.id) : [];
      const eventUnresolvedRows = eventRows.filter((item) => !item.resolution.matched);
      const matchRate = rows.length ? Math.round((matchedRows.length / rows.length) * 100) : 100;
      return {
        key: definition.key,
        label: definition.label,
        critical: definition.critical,
        eventScoped: definition.eventScoped,
        rowCount: rows.length,
        matchedRows: matchedRows.length,
        exactRows: exactRows.length,
        normalizedRows: normalizedRows.length,
        unresolvedRows: unresolvedRows.length,
        ambiguousRows: ambiguousRows.length,
        eventRows: eventRows.length,
        eventUnresolvedRows: eventUnresolvedRows.length,
        matchRate,
        status: rows.length ? identityStatus(matchRate, unresolvedRows.length, ambiguousRows.length) : "empty",
        gaps: [
          unresolvedRows.length ? `${unresolvedRows.length} unresolved player row${unresolvedRows.length === 1 ? "" : "s"}` : "",
          ambiguousRows.length ? `${ambiguousRows.length} ambiguous alias collision${ambiguousRows.length === 1 ? "" : "s"}` : "",
          eventUnresolvedRows.length ? `${eventUnresolvedRows.length} selected-event unresolved row${eventUnresolvedRows.length === 1 ? "" : "s"}` : ""
        ].filter(Boolean)
      };
    });
    const unresolvedRows = definitions.flatMap((definition) =>
      definition.rows
        .filter((row) => rowIdentityValues(row).length)
        .map((row, index) => ({ row, index, definition, resolution: resolveIdentityRow(row, indexes) }))
        .filter((item) => !item.resolution.matched)
        .map((item) => {
          const suggestion = item.resolution.suggestion || null;
          return {
            collectionKey: item.definition.key,
            collectionLabel: item.definition.label,
            rowId: item.row.id || `${item.definition.key}-${item.index + 1}`,
            eventId: item.row.eventId || "",
            playerId: item.row.playerId || "",
            playerName: item.row.playerName || "",
            sourceProvider: item.row.sourceProvider || "",
            sourceUrl: item.row.sourceUrl || "",
            status: item.resolution.matchType,
            ambiguousPlayers: item.resolution.ambiguousPlayers.map((player) => ({
              playerId: player.id,
              playerName: player.name || player.id
            })),
            suggestedPlayerId: suggestion ? suggestion.playerId : "",
            suggestedPlayerName: suggestion ? suggestion.playerName : "",
            suggestionScore: suggestion ? suggestion.score : null
          };
        })
    ).sort((a, b) =>
      Number(Boolean(event && a.eventId === event.id)) * -1 - Number(Boolean(event && b.eventId === event.id)) * -1 ||
      cleanString(a.collectionLabel).localeCompare(cleanString(b.collectionLabel)) ||
      cleanString(a.playerName || a.playerId).localeCompare(cleanString(b.playerName || b.playerId))
    );
    const totalRows = collectionRows.reduce((sum, row) => sum + row.rowCount, 0);
    const matchedRows = collectionRows.reduce((sum, row) => sum + row.matchedRows, 0);
    const normalizedRows = collectionRows.reduce((sum, row) => sum + row.normalizedRows, 0);
    const ambiguousRows = collectionRows.reduce((sum, row) => sum + row.ambiguousRows, 0);
    const matchRate = totalRows ? Math.round((matchedRows / totalRows) * 100) : 100;
    const selectedEventUnresolved = event ? unresolvedRows.filter((row) => row.eventId === event.id).length : 0;
    const blockers = [
      !lab.players.length ? { severity: "high", label: "Profiles missing", detail: "Import player profiles before trusting fields, rounds, odds, or model output." } : null,
      selectedEventUnresolved ? { severity: "high", label: "Selected event identities", detail: `${selectedEventUnresolved} selected-event player row${selectedEventUnresolved === 1 ? "" : "s"} need resolution.` } : null,
      collectionRows.some((row) => row.critical && row.unresolvedRows) ? { severity: "high", label: "Critical row matching", detail: `${collectionRows.filter((row) => row.critical && row.unresolvedRows).length} model-critical collections have unresolved players.` } : null,
      indexes.duplicateProfiles.length ? { severity: "medium", label: "Duplicate profiles", detail: `${indexes.duplicateProfiles.length} duplicate player profile signal${indexes.duplicateProfiles.length === 1 ? "" : "s"} detected.` } : null,
      indexes.aliasConflicts.length ? { severity: "medium", label: "Alias conflicts", detail: `${indexes.aliasConflicts.length} raw alias collision${indexes.aliasConflicts.length === 1 ? "" : "s"} detected.` } : null
    ].filter(Boolean);
    return {
      generatedAt: new Date().toISOString(),
      selectedEvent: event ? {
        eventId: event.id,
        name: event.name || event.id,
        startDate: event.startDate,
        courseName: event.courseName
      } : null,
      summary: {
        players: lab.players.length,
        identityRows: totalRows,
        matchedRows,
        normalizedRows,
        unresolvedRows: unresolvedRows.length,
        ambiguousRows,
        matchRate,
        selectedEventUnresolved,
        collectionIssues: collectionRows.filter((row) => row.unresolvedRows || row.ambiguousRows).length,
        duplicateProfiles: indexes.duplicateProfiles.length,
        aliasConflicts: indexes.aliasConflicts.length,
        status: identityStatus(matchRate, unresolvedRows.length, ambiguousRows)
      },
      blockers,
      collectionRows,
      unresolvedRows,
      duplicateProfiles: indexes.duplicateProfiles,
      aliasConflicts: indexes.aliasConflicts,
      compactConflicts: indexes.compactConflicts
    };
  }

  function courseIdentity(course) {
    return [course.id, course.name, course.dataGolfCourseId].map(cleanString).filter(Boolean);
  }

  function eventCourseRowsForEvent(lab, event) {
    if (!event) return [];
    const byId = new Map(lab.courses.map((course) => [course.id, course]));
    const byName = new Map(lab.courses.map((course) => [cleanString(course.name).toLowerCase(), course]));
    return lab.eventCourses
      .filter((row) => row.eventId === event.id)
      .map((row) => {
        const course = byId.get(row.courseId) || byName.get(cleanString(row.courseName).toLowerCase()) || null;
        const par = numberOrNull(row.par) ?? numberOrNull(course && course.par);
        const yards = numberOrNull(row.yards) ?? numberOrNull(course && course.yards);
        const difficulty = course ? classifyCourseDifficulty(course) : { bucket: "Unknown", score: null, basis: "course-pool row" };
        return {
          ...row,
          course,
          courseId: row.courseId || (course && course.id) || "",
          courseName: row.courseName || (course && course.name) || row.courseId,
          location: row.location || (course && course.location) || "",
          par,
          yards,
          difficulty
        };
      })
      .sort((a, b) =>
        (Number.isFinite(a.courseOrder) ? a.courseOrder : 999) - (Number.isFinite(b.courseOrder) ? b.courseOrder : 999) ||
        cleanString(a.courseName).localeCompare(cleanString(b.courseName))
      );
  }

  function eventCoursePoolSummary(lab, event) {
    const rows = eventCourseRowsForEvent(lab, event);
    if (!rows.length) return null;
    const providers = [...new Set(rows.map((row) => cleanString(row.sourceProvider)).filter(Boolean))];
    const courseNames = rows.map((row) => row.courseName).filter(Boolean);
    const roundSpecific = rows.filter((row) => cleanString(row.roundNumbers)).length;
    return {
      courses: rows,
      courseCount: rows.length,
      courseNames,
      label: courseNames.slice(0, 3).join(" / ") + (courseNames.length > 3 ? ` +${courseNames.length - 3}` : ""),
      parRange: rows.map((row) => row.par).filter(Number.isFinite),
      yardageRange: rows.map((row) => row.yards).filter(Number.isFinite),
      roundSpecific,
      providers,
      confidence: rows.some((row) => cleanString(row.confidence).toLowerCase() === "estimated") ? "estimated" : "verified",
      notes: rows.map((row) => cleanString(row.note)).filter(Boolean)
    };
  }

  function rowMatchesCourse(row, course) {
    const ids = courseIdentity(course);
    const rowCourseId = cleanString(row.courseId);
    const rowCourseName = cleanString(row.courseName);
    return ids.includes(rowCourseId) || ids.includes(rowCourseName);
  }

  function eventUsesCourse(lab, event, course) {
    if (!event || !course) return false;
    if (rowMatchesCourse(event, course)) return true;
    return eventCourseRowsForEvent(lab, event).some((row) =>
      rowMatchesCourse(row, course) ||
      (row.course && rowMatchesCourse(row.course, course))
    );
  }

  function buildPlayerAliasIndex(players) {
    const aliases = new Map();
    players.forEach((player) => {
      [player.id, player.name, player.dataGolfId, player.pgaTourId]
        .map(cleanString)
        .filter(Boolean)
        .forEach((alias) => {
          aliases.set(alias.toLowerCase(), player);
          const compact = compactIdentityValue(alias);
          if (compact && !aliases.has(compact)) aliases.set(compact, player);
        });
    });
    return aliases;
  }

  function findPlayerByRound(aliasIndex, round) {
    return aliasIndex.get(cleanString(round.playerId).toLowerCase())
      || aliasIndex.get(cleanString(round.playerName).toLowerCase())
      || null;
  }

  function roundScoreValue(round) {
    const adjusted = numberOrNull(round.adjustedToPar);
    if (Number.isFinite(adjusted)) return adjusted;
    return numberOrNull(round.toPar);
  }

  function buildCoursePlayerRows(lab, courseRounds) {
    const aliasIndex = buildPlayerAliasIndex(lab.players);
    const grouped = courseRounds.reduce((groups, round) => {
      const player = findPlayerByRound(aliasIndex, round);
      const key = player ? player.id : cleanString(round.playerId || round.playerName);
      if (!key) return groups;
      if (!groups[key]) groups[key] = { player, rounds: [] };
      groups[key].rounds.push(round);
      return groups;
    }, {});
    return Object.entries(grouped).map(([key, group]) => {
      const rounds = group.rounds;
      const sgValues = rounds.map((round) => numberOrNull(round.sgTotal));
      const scoreValues = rounds.map(roundScoreValue);
      const validSg = sgValues.filter(Number.isFinite);
      const validScores = scoreValues.filter(Number.isFinite);
      return {
        playerId: group.player ? group.player.id : key,
        playerName: group.player ? group.player.name : rounds[0].playerName || key,
        rounds: rounds.length,
        avgSg: avg(validSg),
        avgToPar: avg(validScores),
        bestSg: validSg.length ? Math.max(...validSg) : null,
        bestToPar: validScores.length ? Math.min(...validScores) : null,
        lastDate: (latestByDate(rounds, "date") || {}).date || ""
      };
    }).filter((row) => row.rounds > 0);
  }

  function courseFitSortValue(row) {
    if (Number.isFinite(row.avgSg)) return -row.avgSg;
    if (Number.isFinite(row.avgToPar)) return row.avgToPar;
    return 999;
  }

  function chooseEventForDossier(lab, eventId) {
    const explicit = cleanString(eventId);
    if (explicit) {
      return lab.events.find((event) => event.id === explicit || event.name === explicit) || null;
    }
    const today = new Date().toISOString().slice(0, 10);
    return [...lab.events]
      .filter((event) => !event.startDate || event.startDate >= today)
      .sort((a, b) => cleanString(a.startDate).localeCompare(cleanString(b.startDate)) || cleanString(a.name || a.id).localeCompare(cleanString(b.name || b.id)))[0]
      || [...lab.events].sort((a, b) => cleanString(b.startDate).localeCompare(cleanString(a.startDate)))[0]
      || null;
  }

  function courseForEvent(lab, event) {
    if (!event) return null;
    return lab.courses.find((course) =>
      course.id === event.courseId ||
      course.name === event.courseName ||
      course.dataGolfCourseId === event.courseId
    ) || (eventCourseRowsForEvent(lab, event).find((row) => row.course)?.course || null);
  }

  function fieldPlayer(aliasIndex, field) {
    return aliasIndex.get(cleanString(field.playerId).toLowerCase())
      || aliasIndex.get(cleanString(field.playerName).toLowerCase())
      || null;
  }

  function percentScore(value, target) {
    if (!target) return value ? 100 : 0;
    return Math.max(0, Math.min(100, Math.round((value / target) * 100)));
  }

  function weatherLabel(weather) {
    if (!weather || !weather.count) return "No weather";
    if (Number.isFinite(weather.gustMph) && weather.gustMph >= 30) return "Gust factor";
    if (Number.isFinite(weather.windMph) && weather.windMph >= 18) return "High wind";
    if (Number.isFinite(weather.windMph) && weather.windMph >= 12) return "Wind factor";
    if (Number.isFinite(weather.precipitationIn) && weather.precipitationIn > 0.05) return "Rain factor";
    return "Playable";
  }

  function buildEventDossier(input, eventId) {
    const lab = normalizeGolfLabState(input);
    const event = chooseEventForDossier(lab, eventId);
    if (!event) return null;
    const course = courseForEvent(lab, event);
    const coursePool = eventCoursePoolSummary(lab, event);
    const fields = lab.fields.filter((field) => field.eventId === event.id);
    const activeFields = fields.filter((field) => !["wd", "withdrawn"].includes(cleanString(field.status).toLowerCase()));
    const aliasIndex = buildPlayerAliasIndex(lab.players);
    const fieldRows = activeFields.map((field) => {
      const player = fieldPlayer(aliasIndex, field);
      return {
        fieldId: field.id,
        playerId: player ? player.id : field.playerId,
        playerName: player ? player.name : field.playerName || field.playerId,
        status: field.status || "active",
        teeTime: field.teeTime,
        matched: !!player
      };
    });
    const matchedFields = fieldRows.filter((field) => field.matched).length;
    const rounds = lab.rounds.filter((round) => round.eventId === event.id);
    const strokesGainedRows = lab.strokesGained.filter((row) => row.eventId === event.id);
    const weatherRows = lab.weatherSnapshots.filter((row) => row.eventId === event.id);
    const oddsRows = lab.oddsSnapshots.filter((row) => row.eventId === event.id);
    const predictionRows = [...lab.modelPredictions, ...lab.predictionLedger].filter((row) => row.eventId === event.id);
    const setups = lab.courseSetups
      .filter((setup) => setup.eventId === event.id || (course && rowMatchesCourse(setup, course)))
      .sort((a, b) => cleanString(b.sourceUpdatedAt).localeCompare(cleanString(a.sourceUpdatedAt)));
    const weather = {
      count: weatherRows.length,
      windMph: avg(weatherRows.map((row) => numberOrNull(row.windMph))),
      gustMph: avg(weatherRows.map((row) => numberOrNull(row.gustMph))),
      temperatureF: avg(weatherRows.map((row) => numberOrNull(row.temperatureF))),
      precipitationIn: avg(weatherRows.map((row) => numberOrNull(row.precipitationIn)))
    };
    const scoreParts = {
      field: percentScore(activeFields.length, 20),
      matching: activeFields.length ? percentScore(matchedFields, activeFields.length) : 0,
      course: course || coursePool ? 100 : 0,
      scoring: percentScore(rounds.length + strokesGainedRows.length, 12),
      weather: weatherRows.length ? 100 : 0,
      market: oddsRows.length ? 100 : 0,
      model: predictionRows.length ? 100 : 0
    };
    const readinessScore = Math.round(
      scoreParts.field * 0.2 +
      scoreParts.matching * 0.15 +
      scoreParts.course * 0.15 +
      scoreParts.scoring * 0.2 +
      scoreParts.weather * 0.1 +
      scoreParts.market * 0.1 +
      scoreParts.model * 0.1
    );
    const blockers = [];
    if (!course && !coursePool) blockers.push("Course profile missing");
    if (activeFields.length < 20) blockers.push("Field list thin");
    if (activeFields.length && matchedFields < activeFields.length) blockers.push("Unmatched field players");
    if (!rounds.length && !strokesGainedRows.length) blockers.push("Scoring history missing");
    if (!weatherRows.length) blockers.push("Weather snapshot missing");
    if (!oddsRows.length) blockers.push("Market odds missing");
    if (!predictionRows.length) blockers.push("Model run missing");
    const winnerPredictions = predictionRows
      .filter((row) => cleanString(row.market).toLowerCase() === "winner")
      .sort((a, b) => (a.rank || 999) - (b.rank || 999) || (b.probability || 0) - (a.probability || 0))
      .slice(0, 5)
      .map((row) => {
        const player = aliasIndex.get(cleanString(row.playerId).toLowerCase());
        return {
          playerId: row.playerId,
          playerName: player ? player.name : row.playerId,
          probability: row.probability,
          fairOddsAmerican: row.fairOddsAmerican,
          edge: row.edge,
          rank: row.rank
        };
      });
    return {
      event,
      course,
      coursePool,
      setup: setups[0] || null,
      readinessScore,
      readiness: readinessScore >= 80 ? "prediction-ready" : readinessScore >= 55 ? "research-ready" : readinessScore > 0 ? "building" : "setup",
      scoreParts,
      blockers,
      counts: {
        field: activeFields.length,
        matchedFields,
        rounds: rounds.length,
        strokesGainedRows: strokesGainedRows.length,
        weatherSnapshots: weatherRows.length,
        oddsSnapshots: oddsRows.length,
        predictions: predictionRows.length
      },
      weather: {
        ...weather,
        label: weatherLabel(weather)
      },
      fieldRows: fieldRows.slice(0, 12),
      winnerPredictions
    };
  }

  function buildCourseScorecard(input, courseId) {
    const lab = normalizeGolfLabState(input);
    const id = cleanString(courseId) || (lab.courses[0] && lab.courses[0].id) || "";
    if (!id) return null;
    const course = lab.courses.find((candidate) =>
      candidate.id === id ||
      candidate.name === id ||
      candidate.dataGolfCourseId === id
    );
    if (!course) return null;
    const rounds = lab.rounds.filter((round) => rowMatchesCourse(round, course));
    const events = lab.events
      .filter((event) => eventUsesCourse(lab, event, course))
      .sort((a, b) => cleanString(b.startDate).localeCompare(cleanString(a.startDate)))
      .slice(0, 8);
    const eventIds = new Set(events.map((event) => event.id));
    const weatherRows = lab.weatherSnapshots.filter((row) =>
      rowMatchesCourse(row, course) || eventIds.has(row.eventId)
    );
    const setups = lab.courseSetups
      .filter((setup) => rowMatchesCourse(setup, course))
      .sort((a, b) => cleanString(b.sourceUpdatedAt).localeCompare(cleanString(a.sourceUpdatedAt)));
    const playerRows = buildCoursePlayerRows(lab, rounds);
    const topFits = [...playerRows].sort((a, b) => courseFitSortValue(a) - courseFitSortValue(b)).slice(0, 8);
    const toughFits = [...playerRows].sort((a, b) => courseFitSortValue(b) - courseFitSortValue(a)).slice(0, 8);
    return {
      course,
      difficulty: classifyCourseDifficulty({ ...course, ...(setups[0] || {}) }),
      sample: {
        rounds: rounds.length,
        players: playerRows.length,
        events: events.length,
        weatherSnapshots: weatherRows.length
      },
      setup: setups[0] || null,
      weather: {
        windMph: avg(weatherRows.map((row) => numberOrNull(row.windMph))),
        gustMph: avg(weatherRows.map((row) => numberOrNull(row.gustMph))),
        temperatureF: avg(weatherRows.map((row) => numberOrNull(row.temperatureF))),
        precipitationIn: avg(weatherRows.map((row) => numberOrNull(row.precipitationIn)))
      },
      events,
      topFits,
      toughFits
    };
  }

  function courseHardnessScore(difficulty) {
    if (!difficulty || !Number.isFinite(difficulty.score)) return null;
    return difficulty.basis === "strokes-gained difficulty" ? -difficulty.score : difficulty.score;
  }

  function classifyCourseForBoard(course, setup, scoringScore) {
    const difficulty = classifyCourseDifficulty({ ...course, ...(setup || {}) });
    if (difficulty.bucket !== "Unknown" || !Number.isFinite(scoringScore)) return difficulty;
    const derived = classifyCourseDifficulty({ fieldAdjustedToPar: scoringScore });
    return {
      ...derived,
      basis: "imported scoring average"
    };
  }

  function sourceStamp(row) {
    if (!row || typeof row !== "object") return "";
    return cleanString(row.sourceUpdatedAt || row.fetchedAt || row.date || row.startDate || row.endDate);
  }

  function buildCourseSourceSummary(rows) {
    const providers = [...new Set(rows.map((row) => cleanString(row && row.sourceProvider)).filter(Boolean))].sort();
    const latestAt = rows.map(sourceStamp).filter(Boolean).sort().slice(-1)[0] || "";
    return {
      latestAt,
      providers
    };
  }

  function buildCourseDifficultyBoard(input, options = {}) {
    const lab = normalizeGolfLabState(input);
    const limit = Math.max(1, intOrNull(options.limit) || lab.courses.length || 1);
    const rows = lab.courses.map((course) => {
      const rounds = lab.rounds.filter((round) => rowMatchesCourse(round, course));
      const events = lab.events.filter((event) => eventUsesCourse(lab, event, course));
      const eventIds = new Set(events.map((event) => event.id));
      const weatherRows = lab.weatherSnapshots.filter((row) =>
        rowMatchesCourse(row, course) || eventIds.has(row.eventId)
      );
      const setups = lab.courseSetups
        .filter((setup) => rowMatchesCourse(setup, course))
        .sort((a, b) => cleanString(b.sourceUpdatedAt).localeCompare(cleanString(a.sourceUpdatedAt)));
      const playerRows = buildCoursePlayerRows(lab, rounds);
      const adjustedToPar = avg(rounds.map((round) => numberOrNull(round.adjustedToPar)));
      const avgToPar = avg(rounds.map(roundScoreValue));
      const avgSgTotal = avg(rounds.map((round) => numberOrNull(round.sgTotal)));
      const scoringScore = Number.isFinite(adjustedToPar) ? adjustedToPar : avgToPar;
      const difficulty = classifyCourseForBoard(course, setups[0], scoringScore);
      const explicitHardness = courseHardnessScore(difficulty);
      const hardnessScore = Number.isFinite(explicitHardness) ? explicitHardness : scoringScore;
      const sortedBest = [...playerRows].sort((a, b) => courseFitSortValue(a) - courseFitSortValue(b));
      const sortedWorst = [...playerRows].sort((a, b) => courseFitSortValue(b) - courseFitSortValue(a));
      const scoringValues = rounds.map(roundScoreValue).filter(Number.isFinite);
      const source = buildCourseSourceSummary([course, ...setups, ...events, ...rounds, ...weatherRows]);
      return {
        courseId: course.id,
        courseName: course.name || course.id,
        location: course.location,
        style: course.style,
        difficulty,
        hardnessScore,
        sample: {
          rounds: rounds.length,
          players: playerRows.length,
          events: events.length,
          weatherSnapshots: weatherRows.length,
          sourceProviders: source.providers.length
        },
        scoring: {
          avgToPar,
          avgAdjustedToPar: adjustedToPar,
          avgSgTotal,
          bestToPar: scoringValues.length ? Math.min(...scoringValues) : null,
          worstToPar: scoringValues.length ? Math.max(...scoringValues) : null
        },
        weather: {
          windMph: avg(weatherRows.map((row) => numberOrNull(row.windMph))),
          gustMph: avg(weatherRows.map((row) => numberOrNull(row.gustMph))),
          temperatureF: avg(weatherRows.map((row) => numberOrNull(row.temperatureF))),
          precipitationIn: avg(weatherRows.map((row) => numberOrNull(row.precipitationIn)))
        },
        topFit: sortedBest[0] || null,
        toughFit: sortedWorst[0] || null,
        latestEvent: [...events].sort((a, b) => cleanString(b.startDate).localeCompare(cleanString(a.startDate)))[0] || null,
        source
      };
    }).sort((a, b) => {
      const aKnown = Number.isFinite(a.hardnessScore);
      const bKnown = Number.isFinite(b.hardnessScore);
      if (aKnown && bKnown && b.hardnessScore !== a.hardnessScore) return b.hardnessScore - a.hardnessScore;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return b.sample.rounds - a.sample.rounds || cleanString(a.courseName).localeCompare(cleanString(b.courseName));
    });
    const scoredRows = rows.filter((row) => Number.isFinite(row.hardnessScore));
    const buckets = ["Brutal", "Tough", "Neutral", "Easy", "Unknown"].map((bucket) => ({
      bucket,
      count: rows.filter((row) => row.difficulty.bucket === bucket).length
    }));
    return {
      summary: {
        courses: rows.length,
        scoredCourses: scoredRows.length,
        toughCourses: rows.filter((row) => ["Brutal", "Tough"].includes(row.difficulty.bucket)).length,
        easyCourses: rows.filter((row) => row.difficulty.bucket === "Easy").length,
        averageHardnessScore: avg(scoredRows.map((row) => row.hardnessScore)),
        hardest: scoredRows[0] || null,
        easiest: scoredRows.length ? scoredRows[scoredRows.length - 1] : null
      },
      buckets,
      rows: rows.slice(0, limit),
      allRows: rows
    };
  }

  function findCourseForComps(lab, event, options = {}) {
    const explicit = cleanString(options.courseId);
    if (explicit) {
      const course = lab.courses.find((candidate) =>
        candidate.id === explicit ||
        candidate.name === explicit ||
        candidate.dataGolfCourseId === explicit
      );
      if (course) return course;
    }
    return courseForEvent(lab, event) || lab.courses[0] || null;
  }

  function latestCourseSetup(lab, course, event) {
    return lab.courseSetups
      .filter((setup) =>
        (event && setup.eventId === event.id) ||
        rowMatchesCourse(setup, course)
      )
      .sort((a, b) => cleanString(b.sourceUpdatedAt).localeCompare(cleanString(a.sourceUpdatedAt)))[0] || null;
  }

  function courseCompProfile(lab, course, event) {
    const setup = latestCourseSetup(lab, course, event);
    const rounds = lab.rounds.filter((round) => rowMatchesCourse(round, course));
    const events = lab.events.filter((row) => eventUsesCourse(lab, row, course));
    const eventIds = new Set(events.map((row) => row.id));
    const weatherRows = lab.weatherSnapshots.filter((row) =>
      rowMatchesCourse(row, course) || eventIds.has(row.eventId)
    );
    const scoringScore = avg(rounds.map((round) => {
      const adjusted = numberOrNull(round.adjustedToPar);
      return Number.isFinite(adjusted) ? adjusted : roundScoreValue(round);
    }));
    const difficulty = classifyCourseForBoard(course, setup, scoringScore);
    const explicitHardness = courseHardnessScore(difficulty);
    const hardnessScore = Number.isFinite(explicitHardness) ? explicitHardness : scoringScore;
    return {
      course,
      setup,
      difficulty,
      hardnessScore,
      par: numberOrNull((setup && setup.par) || course.par),
      yards: numberOrNull((setup && setup.yards) || course.yards),
      rating: numberOrNull(course.rating),
      slope: numberOrNull(course.slope),
      style: cleanString((setup && setup.style) || course.style),
      rounds,
      events,
      weatherRows,
      source: buildCourseSourceSummary([course, setup, ...events, ...rounds, ...weatherRows].filter(Boolean))
    };
  }

  function scoreNumericSimilarity(a, b, scale) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.max(0, Math.min(100, Math.round(100 - (Math.abs(a - b) / scale) * 100)));
  }

  function scoreStyleSimilarity(a, b) {
    const left = cleanString(a).toLowerCase();
    const right = cleanString(b).toLowerCase();
    if (!left && !right) return null;
    if (!left || !right) return 40;
    if (left === right) return 100;
    const leftWords = left.split(/[^a-z0-9]+/).filter(Boolean);
    const rightWords = new Set(right.split(/[^a-z0-9]+/).filter(Boolean));
    return leftWords.some((word) => rightWords.has(word)) ? 70 : 35;
  }

  function weightedCompSimilarity(parts) {
    const usable = parts.filter((part) => Number.isFinite(part.value));
    if (!usable.length) return 0;
    const weight = usable.reduce((sum, part) => sum + part.weight, 0) || 1;
    return Math.round(usable.reduce((sum, part) => sum + part.value * part.weight, 0) / weight);
  }

  function courseCompEvidence(target, comp) {
    const evidence = [];
    if (Number.isFinite(target.hardnessScore) && Number.isFinite(comp.hardnessScore)) {
      evidence.push(`${comp.difficulty.bucket} test`);
    }
    if (Number.isFinite(target.yards) && Number.isFinite(comp.yards)) {
      const diff = Math.round(comp.yards - target.yards);
      evidence.push(`${diff >= 0 ? "+" : ""}${diff} yards`);
    }
    if (Number.isFinite(target.par) && Number.isFinite(comp.par)) {
      evidence.push(target.par === comp.par ? `same par ${target.par}` : `par ${comp.par}`);
    }
    if (cleanString(comp.style)) evidence.push(comp.style);
    return evidence.slice(0, 4);
  }

  function buildCourseCompRows(lab, targetProfile, targetCourse, limit) {
    return lab.courses
      .filter((course) => course.id !== targetCourse.id && course.name !== targetCourse.name)
      .map((course) => {
        const profile = courseCompProfile(lab, course, null);
        const parts = [
          { key: "difficulty", label: "Difficulty", value: scoreNumericSimilarity(targetProfile.hardnessScore, profile.hardnessScore, 4), weight: 0.32 },
          { key: "yards", label: "Yards", value: scoreNumericSimilarity(targetProfile.yards, profile.yards, 900), weight: 0.23 },
          { key: "par", label: "Par", value: scoreNumericSimilarity(targetProfile.par, profile.par, 4), weight: 0.14 },
          { key: "style", label: "Style", value: scoreStyleSimilarity(targetProfile.style, profile.style), weight: 0.16 },
          { key: "rating", label: "Rating", value: scoreNumericSimilarity(targetProfile.rating, profile.rating, 6), weight: 0.08 },
          { key: "slope", label: "Slope", value: scoreNumericSimilarity(targetProfile.slope, profile.slope, 35), weight: 0.07 }
        ];
        return {
          courseId: course.id,
          courseName: course.name || course.id,
          location: course.location,
          style: profile.style,
          similarity: weightedCompSimilarity(parts),
          parts: parts.map((part) => ({ key: part.key, label: part.label, value: part.value })),
          evidence: courseCompEvidence(targetProfile, profile),
          difficulty: profile.difficulty,
          hardnessScore: profile.hardnessScore,
          yards: profile.yards,
          par: profile.par,
          sample: {
            rounds: profile.rounds.length,
            players: buildCoursePlayerRows(lab, profile.rounds).length,
            events: profile.events.length,
            weatherSnapshots: profile.weatherRows.length
          },
          source: profile.source
        };
      })
      .sort((a, b) =>
        b.similarity - a.similarity ||
        b.sample.rounds - a.sample.rounds ||
        cleanString(a.courseName).localeCompare(cleanString(b.courseName))
      )
      .slice(0, limit);
  }

  function buildCompPlayerRows(lab, compCourses, event, limit) {
    const aliasIndex = buildPlayerAliasIndex(lab.players);
    const fieldRows = event
      ? lab.fields.filter((field) => field.eventId === event.id && !["wd", "withdrawn", "out"].includes(cleanString(field.status).toLowerCase()))
      : [];
    const fieldKeys = new Set(fieldRows.map((field) => {
      const player = fieldPlayer(aliasIndex, field);
      return player ? player.id : cleanString(field.playerId || field.playerName);
    }).filter(Boolean));
    const compCourseMap = new Map(compCourses.map((course) => [course.courseId, course]));
    const compRounds = lab.rounds.filter((round) =>
      compCourses.some((course) => rowMatchesCourse(round, { id: course.courseId, name: course.courseName }))
    );
    const groups = compRounds.reduce((acc, round) => {
      const player = findPlayerByRound(aliasIndex, round);
      const key = player ? player.id : cleanString(round.playerId || round.playerName);
      if (!key) return acc;
      if (!acc[key]) acc[key] = { player, rounds: [] };
      acc[key].rounds.push(round);
      return acc;
    }, {});
    return Object.entries(groups)
      .map(([key, group]) => {
        const rounds = group.rounds;
        const courseRows = Object.entries(groupByKey(rounds, "courseId")).map(([courseId, courseRounds]) => {
          const comp = compCourseMap.get(courseId) || compCourses.find((course) => course.courseName === courseRounds[0].courseName) || {};
          return {
            courseId,
            courseName: comp.courseName || courseRounds[0].courseName || courseId,
            rounds: courseRounds.length,
            avgSg: avg(courseRounds.map((round) => numberOrNull(round.sgTotal))),
            avgToPar: avg(courseRounds.map(roundScoreValue)),
            similarity: comp.similarity || 0
          };
        }).sort((a, b) => courseFitSortValue(a) - courseFitSortValue(b));
        const avgSg = avg(rounds.map((round) => numberOrNull(round.sgTotal)));
        const avgToPar = avg(rounds.map(roundScoreValue));
        const baseValue = Number.isFinite(avgSg) ? avgSg : Number.isFinite(avgToPar) ? -avgToPar / 2 : 0;
        const sampleBonus = Math.min(0.35, Math.log(rounds.length + 1) / 6);
        const inField = fieldKeys.has(key);
        return {
          playerId: group.player ? group.player.id : key,
          playerName: group.player ? group.player.name : rounds[0].playerName || key,
          inField,
          rounds: rounds.length,
          compCourses: courseRows.length,
          avgSg,
          avgToPar,
          fitScore: baseValue + sampleBonus + (inField ? 0.15 : 0),
          bestComp: courseRows[0] || null,
          worstComp: courseRows.length ? [...courseRows].sort((a, b) => courseFitSortValue(b) - courseFitSortValue(a))[0] : null,
          tags: [
            inField ? "In field" : "",
            Number.isFinite(avgSg) && avgSg >= 1 ? "Comp plus" : "",
            rounds < 3 ? "Thin sample" : "",
            courseRows.length >= 3 ? "Broad comps" : ""
          ].filter(Boolean)
        };
      })
      .filter((row) => row.rounds > 0)
      .sort((a, b) =>
        b.fitScore - a.fitScore ||
        Number(b.inField) - Number(a.inField) ||
        b.rounds - a.rounds ||
        cleanString(a.playerName).localeCompare(cleanString(b.playerName))
      )
      .slice(0, limit);
  }

  function buildCourseCompBoard(input, options = {}) {
    const lab = normalizeGolfLabState(input);
    const event = chooseEventForDossier(lab, options.eventId);
    const targetCourse = findCourseForComps(lab, event, options);
    if (!targetCourse) return null;
    const courseLimit = Math.max(1, intOrNull(options.courseLimit) || 6);
    const playerLimit = Math.max(1, intOrNull(options.playerLimit) || 8);
    const targetProfile = courseCompProfile(lab, targetCourse, event);
    const compCourses = buildCourseCompRows(lab, targetProfile, targetCourse, courseLimit);
    const playerRows = buildCompPlayerRows(lab, compCourses, event, playerLimit);
    return {
      event: event ? {
        eventId: event.id,
        name: event.name || event.id,
        startDate: event.startDate,
        tour: event.tour
      } : null,
      targetCourse: {
        courseId: targetCourse.id,
        courseName: targetCourse.name || targetCourse.id,
        location: targetCourse.location,
        style: targetProfile.style,
        difficulty: targetProfile.difficulty,
        hardnessScore: targetProfile.hardnessScore,
        yards: targetProfile.yards,
        par: targetProfile.par,
        setup: targetProfile.setup,
        sample: {
          rounds: targetProfile.rounds.length,
          events: targetProfile.events.length,
          weatherSnapshots: targetProfile.weatherRows.length
        },
        source: targetProfile.source
      },
      summary: {
        compCourses: compCourses.length,
        avgSimilarity: avg(compCourses.map((row) => row.similarity)),
        compRounds: compCourses.reduce((sum, row) => sum + row.sample.rounds, 0),
        compPlayers: playerRows.length,
        fieldPlayersWithComps: playerRows.filter((row) => row.inField).length,
        strongestComp: compCourses[0] || null,
        topPlayer: playerRows[0] || null
      },
      compCourses,
      playerRows
    };
  }

  function courseSetupDimension(label, value, note, critical = false) {
    const text = value === null || value === undefined ? "" : String(value).trim();
    const filled = text !== "";
    return {
      label,
      value: filled ? text : "",
      note: cleanString(note),
      critical,
      status: filled ? "ready" : critical ? "missing" : "planned"
    };
  }

  function setupPressureLabel(score) {
    if (!Number.isFinite(score)) return "Unknown setup";
    if (score >= 80) return "Major stress";
    if (score >= 62) return "Demanding";
    if (score >= 42) return "Balanced";
    return "Scoring setup";
  }

  function setupDimensionScore(rows) {
    const weighted = rows.reduce((acc, row) => {
      const weight = row.critical ? 1.4 : 1;
      return {
        total: acc.total + weight,
        filled: acc.filled + (row.status === "ready" ? weight : 0)
      };
    }, { total: 0, filled: 0 });
    return weighted.total ? Math.round((weighted.filled / weighted.total) * 100) : 0;
  }

  function buildCourseSetupBoard(input, options = {}) {
    const lab = normalizeGolfLabState(input);
    const event = chooseEventForDossier(lab, options.eventId);
    if (!event) return null;
    const course = courseForEvent(lab, event);
    const coursePool = eventCoursePoolSummary(lab, event);
    const setup = course ? latestCourseSetup(lab, course, event) : null;
    const poolCourseIds = new Set((coursePool ? coursePool.courses : []).map((row) => row.courseId).filter(Boolean));
    const poolCourseNames = new Set((coursePool ? coursePool.courses : []).map((row) => row.courseName).filter(Boolean));
    const matchesCoursePool = (row) => poolCourseIds.has(cleanString(row.courseId)) || poolCourseNames.has(cleanString(row.courseName));
    const rounds = lab.rounds.filter((round) => round.eventId === event.id || (course && rowMatchesCourse(round, course)) || matchesCoursePool(round));
    const weatherRows = lab.weatherSnapshots.filter((row) => row.eventId === event.id || (course && rowMatchesCourse(row, course)) || matchesCoursePool(row));
    const fieldRows = lab.fields.filter((field) => field.eventId === event.id && !["wd", "withdrawn", "out"].includes(cleanString(field.status).toLowerCase()));
    const scoringScore = avg(rounds.map((round) => {
      const adjusted = numberOrNull(round.adjustedToPar);
      return Number.isFinite(adjusted) ? adjusted : roundScoreValue(round);
    }));
    const difficulty = course ? classifyCourseForBoard(course, setup, scoringScore) : { bucket: "Unknown", score: null, basis: "course missing" };
    const hardness = courseHardnessScore(difficulty);
    const par = numberOrNull((setup && setup.par) || (course && course.par));
    const yards = numberOrNull((setup && setup.yards) || (course && course.yards));
    const poolParValues = coursePool ? coursePool.parRange : [];
    const poolYardageValues = coursePool ? coursePool.yardageRange : [];
    const dimensions = [
      courseSetupDimension("Par", Number.isFinite(par) ? par : "", course ? course.name : "Course missing", true),
      courseSetupDimension("Yardage", Number.isFinite(yards) ? `${Math.round(yards)} yards` : "", setup && setup.yards ? "Tournament setup" : "Course profile", true),
      coursePool ? courseSetupDimension("Course Pool", `${coursePool.courseCount} courses`, coursePool.label, true) : null,
      coursePool && poolParValues.length ? courseSetupDimension("Pool Par", [...new Set(poolParValues)].sort((a, b) => a - b).join(" / "), "Multi-course setup", false) : null,
      coursePool && poolYardageValues.length ? courseSetupDimension("Pool Yardage", `${Math.min(...poolYardageValues)}-${Math.max(...poolYardageValues)} yards`, "Multi-course setup", false) : null,
      courseSetupDimension("Rough", setup && setup.rough, "Tournament setup note", true),
      courseSetupDimension("Green Speed", setup && setup.greenSpeed, "Stimp or qualitative speed", true),
      courseSetupDimension("Firmness", setup && setup.firmness, "Fairway/green firmness", true),
      courseSetupDimension("Difficulty", difficulty.bucket, difficulty.basis, true),
      courseSetupDimension("Style", (course && course.style) || "", "Course architecture profile"),
      courseSetupDimension("Weather Note", setup && setup.weatherNote, "Setup-weather interaction")
    ].filter(Boolean);
    const dimensionScore = setupDimensionScore(dimensions);
    const compBoard = course ? buildCourseCompBoard(lab, {
      eventId: event.id,
      courseLimit: Math.max(1, intOrNull(options.courseLimit) || 5),
      playerLimit: Math.max(1, intOrNull(options.playerLimit) || 6)
    }) : null;
    const source = buildCourseSourceSummary([course, setup, event, ...(coursePool ? coursePool.courses : []), ...rounds, ...weatherRows].filter(Boolean));
    const scoringRows = buildCoursePlayerRows(lab, rounds);
    const setupScore = Math.round(
      (course ? 18 : 0) +
      (setup ? 20 : 0) +
      dimensionScore * 0.28 +
      Math.min(14, rounds.length * 2) +
      Math.min(10, weatherRows.length * 4) +
      (compBoard && compBoard.compCourses.length ? 6 : 0) +
      Math.min(4, source.providers.length * 2)
    );
    const pressureScore = Math.max(0, Math.min(100, Math.round(
      (Number.isFinite(hardness) ? Math.max(0, Math.min(100, 50 + hardness * 14)) : 42) +
      (setup && cleanString(setup.rough).toLowerCase().match(/heavy|major|long|thick/) ? 9 : 0) +
      (setup && cleanString(setup.greenSpeed).toLowerCase().match(/fast|firm|major/) ? 6 : 0) +
      (setup && cleanString(setup.firmness).toLowerCase().match(/firm|hard/) ? 5 : 0) +
      (weatherRows.some((row) => numberOrNull(row.windMph) >= 18 || numberOrNull(row.gustMph) >= 28) ? 6 : 0)
    )));
    const signals = [
      { id: "difficulty", label: difficulty.bucket, detail: difficulty.basis, tone: ["Brutal", "Tough"].includes(difficulty.bucket) ? "risk" : difficulty.bucket === "Easy" ? "positive" : "neutral" },
      coursePool ? { id: "course-pool", label: `${coursePool.courseCount} courses`, detail: coursePool.confidence === "estimated" ? "course pool estimated" : "course pool verified", tone: coursePool.confidence === "estimated" ? "neutral" : "positive" } : null,
      Number.isFinite(yards) ? { id: "yardage", label: `${Math.round(yards)} yards`, detail: Number.isFinite(par) ? `par ${par}` : "par unknown", tone: yards >= 7400 ? "risk" : "neutral" } : null,
      setup && setup.rough ? { id: "rough", label: `Rough: ${setup.rough}`, detail: "recovery penalty input", tone: cleanString(setup.rough).toLowerCase().match(/heavy|major|long|thick/) ? "risk" : "neutral" } : null,
      setup && setup.greenSpeed ? { id: "greens", label: `Greens: ${setup.greenSpeed}`, detail: "putting/approach stress", tone: cleanString(setup.greenSpeed).toLowerCase().match(/fast|firm/) ? "risk" : "neutral" } : null,
      setup && setup.firmness ? { id: "firmness", label: `Firmness: ${setup.firmness}`, detail: "landing control", tone: cleanString(setup.firmness).toLowerCase().match(/firm|hard/) ? "risk" : "neutral" } : null
    ].filter(Boolean);
    const blockers = [
      !course ? "Course profile missing" : "",
      coursePool && !rounds.some((round) => cleanString(round.courseId) || cleanString(round.courseName)) ? "Round-level course assignment pending" : "",
      !setup && !coursePool ? "Tournament setup row missing" : "",
      dimensions.filter((row) => row.critical && row.status !== "ready").length ? `${dimensions.filter((row) => row.critical && row.status !== "ready").length} critical setup dimensions missing` : "",
      !(compBoard && compBoard.compCourses.length) ? "Comparable courses missing" : "",
      !rounds.length ? "Course scoring history missing" : "",
      !source.providers.length ? "Setup source proof missing" : ""
    ].filter(Boolean);
    return {
      event: {
        eventId: event.id,
        name: event.name || event.id,
        startDate: event.startDate,
        courseName: event.courseName,
        tour: event.tour,
        coursePoolLabel: coursePool ? coursePool.label : ""
      },
      course: course ? {
        courseId: course.id,
        courseName: course.name || course.id,
        location: course.location,
        style: course.style
      } : null,
      setup,
      coursePool,
      readiness: setupScore >= 82 ? "premium-ready" : setupScore >= 64 ? "model-ready" : setupScore >= 42 ? "building" : "thin",
      setupScore: Math.max(0, Math.min(100, setupScore)),
      pressureScore,
      pressureLabel: setupPressureLabel(pressureScore),
      difficulty,
      dimensions,
      signals,
      compCourses: compBoard ? compBoard.compCourses : [],
      playerFits: compBoard ? compBoard.playerRows : [],
      source,
      blockers,
      summary: {
        fieldCount: fieldRows.length,
        scoringRounds: rounds.length,
        weatherSnapshots: weatherRows.length,
        compCourses: compBoard ? compBoard.compCourses.length : 0,
        compPlayers: compBoard ? compBoard.playerRows.length : 0,
        dimensionsReady: dimensions.filter((row) => row.status === "ready").length,
        criticalMissing: dimensions.filter((row) => row.critical && row.status !== "ready").length,
        sourceProviders: source.providers.length,
        coursePoolCourses: coursePool ? coursePool.courseCount : 0,
        topFit: compBoard && compBoard.playerRows.length ? compBoard.playerRows[0] : null,
        hardestSignal: signals.find((row) => row.tone === "risk") || signals[0] || null
      }
    };
  }

  return {
    GOLF_LAB_SCHEMA_VERSION,
    COLLECTION_KEYS,
    LAB_LANES,
    blankGolfLabState,
    normalizeGolfLabState,
    mergeGolfLabStates,
    summarizeGolfLabState,
    hasGolfLabData,
    classifyCourseDifficulty,
    eventCoursePoolSummary,
    buildPlayerSplitLeaderboards,
    buildPlayerScorecard,
    buildPlayerIndexBoard,
    buildPlayerSplitLab,
    buildPlayerIdentityBoard,
    buildWeatherMatrixBoard,
    buildTeeTimeWaveBoard,
    buildFieldReadinessBoard,
    buildEventDossier,
    buildCourseScorecard,
    buildCourseDifficultyBoard,
    buildCourseSetupBoard,
    buildCourseCompBoard
  };
});
