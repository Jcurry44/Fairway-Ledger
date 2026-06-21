/*
 * Fairway Ledger - owned Golf Lab prediction model.
 *
 * Transparent by design: every prediction carries the feature pieces that
 * produced it so the ledger can be audited and improved over time.
 */
(function (root, factory) {
  "use strict";
  let golfLab = root.GolfLab;
  if (typeof module === "object" && module.exports) {
    golfLab = require("./golf-lab.js");
    module.exports = factory(golfLab);
  } else {
    root.GolfLabModel = factory(golfLab);
  }
})(typeof self !== "undefined" ? self : this, function (GolfLab) {
  "use strict";

  if (!GolfLab) throw new Error("GolfLabModel requires GolfLab.");

  const MODEL_VERSION = "owned-v0.4";

  const DEFAULT_WEIGHTS = Object.freeze({
    skill: 0.52,
    recentForm: 0.22,
    courseFit: 0.12,
    difficultyFit: 0.08,
    weatherFit: 0.06,
    liveState: 0
  });

  const MODEL_FEATURES = Object.freeze([
    { key: "skill", label: "Skill" },
    { key: "recentForm", label: "Recent" },
    { key: "courseFit", label: "Course" },
    { key: "difficultyFit", label: "Difficulty" },
    { key: "weatherFit", label: "Weather" },
    { key: "liveState", label: "Live" }
  ]);

  const DEFAULT_CONSENSUS_PROFILES = Object.freeze([
    {
      key: "balanced",
      label: "Balanced",
      weights: DEFAULT_WEIGHTS
    },
    {
      key: "form",
      label: "Hot Hand",
      weights: { skill: 0.38, recentForm: 0.36, courseFit: 0.10, difficultyFit: 0.08, weatherFit: 0.08 }
    },
    {
      key: "course",
      label: "Course Horse",
      weights: { skill: 0.34, recentForm: 0.14, courseFit: 0.30, difficultyFit: 0.14, weatherFit: 0.08 }
    },
    {
      key: "tough",
      label: "Major Test",
      weights: { skill: 0.36, recentForm: 0.16, courseFit: 0.18, difficultyFit: 0.22, weatherFit: 0.08 }
    },
    {
      key: "weather",
      label: "Weather Desk",
      weights: { skill: 0.34, recentForm: 0.16, courseFit: 0.12, difficultyFit: 0.10, weatherFit: 0.28 }
    }
  ]);

  const WEATHER_SCENARIOS = Object.freeze({
    baseline: {
      key: "baseline",
      label: "Live forecast",
      weather: null
    },
    calm: {
      key: "calm",
      label: "Calm scoring",
      weather: { windMph: 5, gustMph: 9, temperatureF: 74, precipitationIn: 0, sample: 0 }
    },
    wind: {
      key: "wind",
      label: "Wind test",
      weather: { windMph: 21, gustMph: 31, temperatureF: 68, precipitationIn: 0, sample: 0 }
    },
    rain: {
      key: "rain",
      label: "Rain draw",
      weather: { windMph: 12, gustMph: 20, temperatureF: 63, precipitationIn: 0.14, sample: 0 }
    },
    cold: {
      key: "cold",
      label: "Cold setup",
      weather: { windMph: 10, gustMph: 16, temperatureF: 50, precipitationIn: 0, sample: 0 }
    },
    heat: {
      key: "heat",
      label: "Heat setup",
      weather: { windMph: 8, gustMph: 13, temperatureF: 90, precipitationIn: 0, sample: 0 }
    }
  });

  function cleanString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function avg(values) {
    const valid = values.filter(Number.isFinite);
    if (!valid.length) return null;
    return valid.reduce((sum, value) => sum + value, 0) / valid.length;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function americanFromProbability(probability) {
    if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return null;
    if (probability >= 0.5) return Math.round((-100 * probability) / (1 - probability));
    return Math.round((100 * (1 - probability)) / probability);
  }

  function normalizeWeights(weights) {
    const merged = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
    const total = Object.values(merged).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0) || 1;
    return Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, Math.max(0, Number(value) || 0) / total]));
  }

  function playerAliases(player) {
    return [player.id, player.dataGolfId, player.pgaTourId, player.name].map(cleanString).filter(Boolean);
  }

  function roundPlayerMatches(round, aliases) {
    return aliases.includes(cleanString(round.playerId)) || aliases.includes(cleanString(round.playerName));
  }

  function eventFieldPlayers(lab, event, options) {
    const explicitField = lab.fields.filter((row) => row.eventId === event.id || row.eventId === event.eventId);
    const fieldRows = explicitField.length ? explicitField : lab.players.map((player) => ({
      eventId: event.id,
      playerId: player.id,
      playerName: player.name,
      status: "projected"
    }));
    const maxFieldSize = Number.isFinite(Number(options.maxFieldSize)) ? Number(options.maxFieldSize) : 156;
    return fieldRows
      .filter((row) => !["wd", "withdrawn", "out"].includes(cleanString(row.status).toLowerCase()))
      .slice(0, maxFieldSize);
  }

  function explicitEventFieldPlayers(lab, event, options = {}) {
    if (!event) return [];
    const maxFieldSize = Number.isFinite(Number(options.maxFieldSize)) ? Number(options.maxFieldSize) : 156;
    return lab.fields
      .filter((row) => row.eventId === event.id || row.eventId === event.eventId)
      .filter((row) => !["wd", "withdrawn", "out"].includes(cleanString(row.status).toLowerCase()))
      .slice(0, maxFieldSize);
  }

  function selectModelEvent(lab, options) {
    const eventId = cleanString(options.eventId);
    if (eventId) {
      return lab.events.find((event) => event.id === eventId || event.eventId === eventId) || null;
    }
    const today = cleanString(options.today) || new Date().toISOString().slice(0, 10);
    const upcoming = [...lab.events]
      .filter((event) => !event.startDate || event.startDate >= today)
      .sort((a, b) => cleanString(a.startDate).localeCompare(cleanString(b.startDate)));
    return upcoming[0] || [...lab.events].sort((a, b) => cleanString(b.startDate).localeCompare(cleanString(a.startDate)))[0] || null;
  }

  function courseForEvent(lab, event) {
    if (!event) return {};
    return lab.courses.find((course) =>
      course.id === event.courseId ||
      course.name === event.courseName ||
      course.dataGolfCourseId === event.courseId
    ) || { id: event.courseId, name: event.courseName };
  }

  function weatherForEvent(lab, event) {
    if (!event) return null;
    const rows = lab.weatherSnapshots.filter((row) => row.eventId === event.id || row.eventId === event.eventId);
    if (!rows.length) return null;
    return {
      windMph: avg(rows.map((row) => numberOrNull(row.windMph))),
      gustMph: avg(rows.map((row) => numberOrNull(row.gustMph))),
      temperatureF: avg(rows.map((row) => numberOrNull(row.temperatureF))),
      precipitationIn: avg(rows.map((row) => numberOrNull(row.precipitationIn))),
      sample: rows.length
    };
  }

  function normalizeWeatherScenarioKey(value) {
    return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function weatherScenarioFromOptions(options = {}) {
    const explicitWeather = options.weatherOverride && typeof options.weatherOverride === "object"
      ? options.weatherOverride
      : null;
    if (explicitWeather) {
      return {
        key: cleanString(options.weatherScenario || options.scenario || "custom") || "custom",
        label: cleanString(options.weatherLabel || options.weatherScenarioLabel || "Custom weather"),
        weather: {
          windMph: numberOrNull(explicitWeather.windMph),
          gustMph: numberOrNull(explicitWeather.gustMph),
          temperatureF: numberOrNull(explicitWeather.temperatureF || explicitWeather.tempF),
          precipitationIn: numberOrNull(explicitWeather.precipitationIn || explicitWeather.precipIn),
          sample: numberOrNull(explicitWeather.sample) || 0
        }
      };
    }
    const key = normalizeWeatherScenarioKey(options.weatherScenario || options.scenario || "baseline");
    return WEATHER_SCENARIOS[key] || WEATHER_SCENARIOS.baseline;
  }

  function eventWeatherForOptions(lab, event, options = {}) {
    const importedWeather = weatherForEvent(lab, event);
    const scenario = weatherScenarioFromOptions(options);
    if (scenario.key === "baseline") {
      return {
        weather: importedWeather,
        scenario: {
          ...scenario,
          label: importedWeather ? scenario.label : "No weather imported",
          importedWeather
        }
      };
    }
    return {
      weather: scenario.weather,
      scenario: {
        ...scenario,
        importedWeather
      }
    };
  }

  function weatherForRound(lab, round) {
    return lab.weatherSnapshots.find((row) =>
      row.eventId === round.eventId &&
      (!row.roundNumber || !round.roundNumber || row.roundNumber === round.roundNumber)
    ) || null;
  }

  function roundValue(round) {
    const sg = numberOrNull(round.sgTotal);
    if (Number.isFinite(sg)) return sg;
    const adjusted = numberOrNull(round.adjustedToPar);
    if (Number.isFinite(adjusted)) return -adjusted;
    const toPar = numberOrNull(round.toPar);
    if (Number.isFinite(toPar)) return -toPar;
    return null;
  }

  function scoreToParValue(round) {
    const toPar = numberOrNull(round.toPar);
    if (Number.isFinite(toPar)) return toPar;
    const adjusted = numberOrNull(round.adjustedToPar);
    if (Number.isFinite(adjusted)) return adjusted;
    const score = numberOrNull(round.score);
    return Number.isFinite(score) ? score : null;
  }

  function recentFormScore(rounds) {
    const recent = [...rounds]
      .sort((a, b) => cleanString(b.date).localeCompare(cleanString(a.date)))
      .slice(0, 10);
    return avg(recent.map(roundValue)) || 0;
  }

  function skillScore(card) {
    if (!card) return 0;
    return avg([
      numberOrNull(card.skills.sgTotal),
      numberOrNull(card.skills.sgT2g),
      numberOrNull(card.skills.sgOtt),
      numberOrNull(card.skills.sgApp)
    ]) || 0;
  }

  function courseFitScore(card, course) {
    if (!card || !course || (!course.id && !course.name)) return 0;
    const courseIds = [course.id, course.name].map(cleanString).filter(Boolean);
    const row = [...card.bestCourses, ...card.worstCourses].find((candidate) =>
      courseIds.includes(candidate.courseId) || courseIds.includes(candidate.courseName)
    );
    if (!row) return 0;
    if (Number.isFinite(row.avgSg)) return row.avgSg;
    if (Number.isFinite(row.avgToPar)) return -row.avgToPar;
    return 0;
  }

  function difficultyFitScore(lab, playerRounds, course) {
    const targetBucket = GolfLab.classifyCourseDifficulty(course).bucket;
    if (!targetBucket || targetBucket === "Unknown") return 0;
    const coursesById = new Map(lab.courses.map((item) => [item.id, item]));
    const values = playerRounds
      .filter((round) => {
        const roundCourse = coursesById.get(round.courseId) || {};
        return GolfLab.classifyCourseDifficulty(roundCourse).bucket === targetBucket;
      })
      .map(roundValue);
    return avg(values) || 0;
  }

  function weatherBucket(weather) {
    if (!weather) return "unknown";
    const wind = numberOrNull(weather.windMph) || 0;
    const gust = numberOrNull(weather.gustMph) || 0;
    const temp = numberOrNull(weather.temperatureF);
    const precip = numberOrNull(weather.precipitationIn) || 0;
    if (wind >= 18 || gust >= 28) return "wind";
    if (precip >= 0.05) return "rain";
    if (Number.isFinite(temp) && temp <= 55) return "cold";
    if (Number.isFinite(temp) && temp >= 86) return "heat";
    return "neutral";
  }

  function weatherFitScore(lab, playerRounds, targetWeather) {
    const targetBucket = weatherBucket(targetWeather);
    if (targetBucket === "unknown" || targetBucket === "neutral") return 0;
    const values = playerRounds
      .filter((round) => weatherBucket(weatherForRound(lab, round)) === targetBucket)
      .map(roundValue);
    return avg(values) || 0;
  }

  function modelWeightsForRun(options = {}, liveContext = {}) {
    const supplied = options.weights && typeof options.weights === "object" ? options.weights : {};
    const raw = { ...DEFAULT_WEIGHTS, ...supplied };
    const suppliedLiveWeight = numberOrNull(supplied.liveState);
    const explicitLiveWeight = Number.isFinite(suppliedLiveWeight) && suppliedLiveWeight > 0;
    const disableLiveState = Boolean(options.disableLiveState);
    if (liveContext.active && !explicitLiveWeight && !disableLiveState) {
      const optionWeight = numberOrNull(options.liveStateWeight);
      raw.liveState = Number.isFinite(optionWeight) ? optionWeight : 0.72;
    }
    if ((!liveContext.active || disableLiveState) && !explicitLiveWeight) raw.liveState = 0;
    return normalizeWeights(raw);
  }

  function liveStateContext(lab, event, fieldRows = []) {
    const eventId = event && (event.id || event.eventId);
    const standings = eventId ? buildEventStandings(lab, eventId) : [];
    const fieldSize = Math.max(fieldRows.length || 0, standings.length || 0);
    const maxRounds = standings.reduce((max, row) => Math.max(max, Number(row.rounds) || 0), 0);
    const leaderTotal = standings.length ? Math.min(...standings.map((row) => Number(row.total) || 0)) : null;
    const coveredPlayers = standings.length;
    const coveragePct = fieldSize ? Math.round((coveredPlayers / fieldSize) * 100) : 0;
    const minCoverage = fieldSize ? Math.min(fieldSize, Math.max(8, Math.ceil(fieldSize * 0.35))) : 0;
    const active = standings.length >= minCoverage && maxRounds > 0 && Number.isFinite(leaderTotal);
    const byPlayer = new Map();
    standings.forEach((row) => {
      [row.playerId, row.playerName].map(cleanString).filter(Boolean).forEach((key) => {
        byPlayer.set(key, row);
        byPlayer.set(key.toLowerCase(), row);
      });
    });
    return {
      active,
      byPlayer,
      standings,
      fieldSize,
      coveredPlayers,
      coveragePct,
      maxRounds,
      leaderTotal
    };
  }

  function liveStandingForPlayer(context, aliases) {
    if (!context || !context.byPlayer) return null;
    for (const alias of aliases.map(cleanString).filter(Boolean)) {
      const row = context.byPlayer.get(alias) || context.byPlayer.get(alias.toLowerCase());
      if (row) return row;
    }
    return null;
  }

  function liveStateScore(standing, context) {
    if (!context || !context.active) return 0;
    if (!standing) return -2.5;
    const total = numberOrNull(standing.total);
    const leaderTotal = numberOrNull(context.leaderTotal);
    const position = numberOrNull(standing.position);
    if (!Number.isFinite(total) || !Number.isFinite(leaderTotal)) return -2.5;
    const strokesBack = Math.max(0, total - leaderTotal);
    const maxRounds = Math.max(1, Number(context.maxRounds) || Number(standing.rounds) || 1);
    const completion = clamp((Number(standing.rounds) || maxRounds) / 4, 0.15, 1);
    const eventProgress = clamp(maxRounds / 4, 0.25, 1);
    const fieldSize = Math.max(1, Number(context.fieldSize) || 1);
    const positionPercentile = Number.isFinite(position) && fieldSize > 1
      ? 1 - ((position - 1) / (fieldSize - 1))
      : 0.5;
    const positionScore = ((positionPercentile * 2) - 1) * 0.75;
    const scoreScore = 1.6 - (strokesBack * (0.28 + (0.12 * eventProgress)));
    const completedBonus = completion >= 0.5 ? 0.15 : 0;
    return clamp(scoreScore + positionScore + completedBonus, -4, 3.2);
  }

  function impliedProbability(odds) {
    const explicit = numberOrNull(odds.impliedProbability);
    if (Number.isFinite(explicit)) return explicit <= 1 ? explicit : explicit / 100;
    const american = numberOrNull(odds.oddsAmerican);
    if (!Number.isFinite(american)) return null;
    return american < 0 ? Math.abs(american) / (Math.abs(american) + 100) : 100 / (american + 100);
  }

  function marketForPlayer(lab, event, playerId, market) {
    const target = normalizeMarketKey(market);
    return [...lab.oddsSnapshots]
      .reverse()
      .find((odds) =>
        odds.eventId === event.id &&
        odds.playerId === playerId &&
        normalizeMarketKey(odds.market) === target
      ) || null;
  }

  function normalizeMarketKey(value) {
    return cleanString(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  function marketSlug(label) {
    return cleanString(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function runSlug(value) {
    return marketSlug(value) || "unknown";
  }

  function runTimestampSlug(value) {
    const compact = cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
    return compact || "unscheduled";
  }

  function buildModelRunId(event, modelProfile, weatherScenario, createdAt) {
    const eventSlug = runSlug(event && (event.id || event.name));
    const profileSlug = runSlug(modelProfile || "balanced");
    const weatherSlug = runSlug(weatherScenario && (weatherScenario.key || weatherScenario.label) || "baseline");
    return `model-run-${eventSlug}-${profileSlug}-${weatherSlug}-${runTimestampSlug(createdAt)}`;
  }

  function safeJsonParse(value) {
    const raw = cleanString(value);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function safeJsonStringify(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  function latestString(values) {
    return values.map(cleanString).filter(Boolean).sort().slice(-1)[0] || "";
  }

  function uniqueClean(values) {
    return [...new Set(values.map(cleanString).filter(Boolean))];
  }

  function sourceFetchMatchesEvent(fetch, event) {
    if (!fetch || !event) return false;
    const eventId = cleanString(event.id || event.eventId);
    const eventName = cleanString(event.name);
    const endpoint = cleanString(fetch.endpoint).toLowerCase();
    return Boolean(
      (eventId && cleanString(fetch.eventId) === eventId) ||
      (eventId && endpoint.includes(eventId.toLowerCase())) ||
      (eventName && endpoint.includes(eventName.toLowerCase().replace(/\s+/g, "-")))
    );
  }

  function buildModelRunManifest({
    lab,
    event,
    course,
    weather,
    weatherScenario,
    createdAt,
    weights,
    modelProfile,
    fieldRows,
    explicitFieldRows,
    scoredRows,
    predictions,
    features,
    warnings,
    activationPlan,
    liveContext
  }) {
    const modelRunId = buildModelRunId(event, modelProfile, weatherScenario, createdAt);
    const eventSourceFetches = lab.sourceFetches.filter((fetch) => sourceFetchMatchesEvent(fetch, event));
    const relevantSources = eventSourceFetches.length ? eventSourceFetches : lab.sourceFetches;
    const marketKeys = uniqueClean(predictions.map((row) => row.market));
    const playerIds = uniqueClean(predictions.map((row) => row.playerId));
    const sampleRounds = features.map((row) => numberOrNull(row.sampleRounds)).filter(Number.isFinite);
    const pricedPredictions = predictions.filter((row) => Number.isFinite(numberOrNull(row.marketOddsAmerican))).length;
    const edgePredictions = predictions.filter((row) => Number.isFinite(numberOrNull(row.edge))).length;
    const activationBlockers = activationPlan && Array.isArray(activationPlan.criticalBlockers)
      ? activationPlan.criticalBlockers
      : [];
    const activationActions = activationPlan && Array.isArray(activationPlan.nextActions)
      ? activationPlan.nextActions
      : [];
    return {
      id: modelRunId,
      modelRunId,
      modelVersion: MODEL_VERSION,
      createdAt,
      eventId: event ? event.id || event.eventId || "" : "",
      eventName: event ? event.name || event.id || "" : "",
      eventStartDate: event ? event.startDate || "" : "",
      courseId: course ? course.id || "" : "",
      courseName: course ? course.name || "" : "",
      modelProfile,
      modelWeatherScenario: weatherScenario ? weatherScenario.key || "" : "",
      modelWeatherLabel: weatherScenario ? weatherScenario.label || "" : "",
      weights,
      liveState: liveContext ? {
        active: Boolean(liveContext.active),
        coveredPlayers: liveContext.coveredPlayers || 0,
        fieldSize: liveContext.fieldSize || 0,
        coveragePct: liveContext.coveragePct || 0,
        maxRounds: liveContext.maxRounds || 0,
        leaderToPar: Number.isFinite(numberOrNull(liveContext.leaderTotal)) ? liveContext.leaderTotal : null
      } : null,
      counts: {
        fieldRows: fieldRows.length,
        officialFieldRows: explicitFieldRows.length,
        modeledPlayers: scoredRows.length,
        predictionPlayers: playerIds.length,
        predictions: predictions.length,
        markets: marketKeys.length,
        pricedPredictions,
        edgePredictions,
        sourceFetches: relevantSources.length,
        eventSourceFetches: eventSourceFetches.length,
        rounds: lab.rounds.length,
        strokesGained: lab.strokesGained.length,
        weatherSnapshots: lab.weatherSnapshots.length,
        oddsSnapshots: lab.oddsSnapshots.length
      },
      quality: {
        avgSampleRounds: avg(sampleRounds) || 0,
        minSampleRounds: sampleRounds.length ? Math.min(...sampleRounds) : 0,
        thinSamplePlayers: features.filter((row) => (numberOrNull(row.sampleRounds) || 0) < 8).length,
        fieldCoveragePct: fieldRows.length ? Math.round((scoredRows.length / fieldRows.length) * 100) : 0,
        pricedPct: predictions.length ? Math.round((pricedPredictions / predictions.length) * 100) : 0
      },
      sourceProof: {
        providers: uniqueClean(relevantSources.map((row) => row.provider || row.sourceProvider)),
        latestSourceAt: latestString(relevantSources.map((row) => row.fetchedAt || row.sourceUpdatedAt)),
        sourceBacked: Boolean(relevantSources.length)
      },
      activation: activationPlan ? {
        score: Number.isFinite(Number(activationPlan.score)) ? Number(activationPlan.score) : null,
        status: cleanString(activationPlan.status),
        statusLabel: cleanString(activationPlan.statusLabel || activationPlan.label),
        criticalBlockers: activationBlockers.map((item) => ({
          label: cleanString(item.label),
          detail: cleanString(item.detail),
          nextAction: cleanString(item.nextAction)
        })),
        nextActions: activationActions.slice(0, 5).map((item) => ({
          label: cleanString(item.label),
          detail: cleanString(item.detail),
          nextAction: cleanString(item.nextAction),
          severity: cleanString(item.severity)
        }))
      } : null,
      warnings: warnings.map(cleanString).filter(Boolean)
    };
  }

  function predictionRunId(prediction) {
    const explicit = cleanString(prediction.modelRunId || prediction.runId);
    if (explicit) return explicit;
    return buildModelRunId(
      { id: prediction.eventId || "event" },
      prediction.modelProfile || "Balanced",
      { key: prediction.modelWeatherScenario || "baseline" },
      prediction.createdAt || prediction.sourceUpdatedAt || ""
    );
  }

  function sourceFetchRunId(fetch) {
    const explicit = cleanString(fetch.modelRunId || fetch.runId);
    if (explicit) return explicit;
    const manifest = safeJsonParse(fetch.manifestJson);
    if (manifest && cleanString(manifest.modelRunId || manifest.id)) {
      return cleanString(manifest.modelRunId || manifest.id);
    }
    const endpoint = cleanString(fetch.endpoint);
    if (endpoint.startsWith("owned-model/")) {
      const parts = endpoint.split("/").filter(Boolean);
      const last = parts[parts.length - 1] || "";
      if (last.startsWith("model-run-")) return last;
    }
    return buildModelRunId(
      { id: fetch.eventId || "event" },
      fetch.modelProfile || "Balanced",
      { key: fetch.modelWeatherScenario || "baseline" },
      fetch.fetchedAt || fetch.sourceUpdatedAt || ""
    );
  }

  function isOwnedModelFetch(fetch) {
    return cleanString(fetch.provider || fetch.sourceProvider) === "Golf Lab Owned Model" ||
      cleanString(fetch.endpoint).startsWith("owned-model/") ||
      Boolean(cleanString(fetch.modelRunId));
  }

  function buildModelRunHistoryBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const selectedEvent = selectModelEvent(lab, options);
    const eventId = cleanString(options.eventId || (selectedEvent && selectedEvent.id));
    const marketFilter = options.market || "all";
    const eventById = new Map(lab.events.map((event) => [event.id, event]));
    const runs = new Map();
    const ensureRun = (modelRunId) => {
      const key = cleanString(modelRunId) || "model-run-unknown";
      if (!runs.has(key)) {
        runs.set(key, {
          modelRunId: key,
          modelVersion: "",
          eventId: "",
          eventName: "",
          courseName: "",
          modelProfile: "",
          modelWeatherScenario: "",
          modelWeatherLabel: "",
          createdAt: "",
          fetchedAt: "",
          status: "",
          predictions: 0,
          players: 0,
          markets: 0,
          pricedPredictions: 0,
          edgePredictions: 0,
          fieldRows: 0,
          officialFieldRows: 0,
          modeledPlayers: 0,
          avgSampleRounds: 0,
          minSampleRounds: 0,
          thinSamplePlayers: 0,
          fieldCoveragePct: 0,
          pricedPct: 0,
          sourceFetches: 0,
          eventSourceFetches: 0,
          sourceProviders: [],
          latestSourceAt: "",
          activationScore: null,
          activationStatus: "",
          activationLabel: "",
          criticalBlockers: [],
          warnings: [],
          hasManifest: false,
          hasSourceFetch: false,
          sourceBacked: false,
          predictionRows: []
        });
      }
      return runs.get(key);
    };

    lab.sourceFetches
      .filter(isOwnedModelFetch)
      .forEach((fetch) => {
        const manifest = safeJsonParse(fetch.manifestJson) || {};
        const modelRunId = sourceFetchRunId(fetch);
        const row = ensureRun(modelRunId);
        const manifestCounts = manifest.counts || {};
        const manifestQuality = manifest.quality || {};
        const manifestProof = manifest.sourceProof || {};
        const manifestActivation = manifest.activation || {};
        row.hasSourceFetch = true;
        row.hasManifest = Boolean(fetch.manifestJson && Object.keys(manifest).length);
        row.sourceBacked = row.sourceBacked || Boolean(manifestProof.sourceBacked || fetch.sourceProvider || fetch.provider);
        row.modelVersion = cleanString(fetch.modelVersion || manifest.modelVersion || row.modelVersion);
        row.eventId = cleanString(fetch.eventId || manifest.eventId || row.eventId);
        row.eventName = cleanString(manifest.eventName || row.eventName);
        row.courseName = cleanString(manifest.courseName || row.courseName);
        row.modelProfile = cleanString(fetch.modelProfile || manifest.modelProfile || row.modelProfile);
        row.modelWeatherScenario = cleanString(fetch.modelWeatherScenario || manifest.modelWeatherScenario || row.modelWeatherScenario);
        row.modelWeatherLabel = cleanString(fetch.modelWeatherLabel || manifest.modelWeatherLabel || row.modelWeatherLabel);
        row.createdAt = latestString([row.createdAt, manifest.createdAt, fetch.fetchedAt]);
        row.fetchedAt = latestString([row.fetchedAt, fetch.fetchedAt || fetch.sourceUpdatedAt]);
        row.status = cleanString(fetch.status || row.status);
        row.predictions = Math.max(row.predictions, Number(manifestCounts.predictions) || Number(fetch.rowCount) || 0);
        row.players = Math.max(row.players, Number(manifestCounts.predictionPlayers) || 0);
        row.markets = Math.max(row.markets, Number(manifestCounts.markets) || 0);
        row.pricedPredictions = Math.max(row.pricedPredictions, Number(manifestCounts.pricedPredictions) || 0);
        row.edgePredictions = Math.max(row.edgePredictions, Number(manifestCounts.edgePredictions) || 0);
        row.fieldRows = Math.max(row.fieldRows, Number(manifestCounts.fieldRows) || 0);
        row.officialFieldRows = Math.max(row.officialFieldRows, Number(manifestCounts.officialFieldRows) || 0);
        row.modeledPlayers = Math.max(row.modeledPlayers, Number(manifestCounts.modeledPlayers) || 0);
        row.avgSampleRounds = Math.max(row.avgSampleRounds, Number(manifestQuality.avgSampleRounds) || 0);
        row.minSampleRounds = Math.max(row.minSampleRounds, Number(manifestQuality.minSampleRounds) || 0);
        row.thinSamplePlayers = Math.max(row.thinSamplePlayers, Number(manifestQuality.thinSamplePlayers) || 0);
        row.fieldCoveragePct = Math.max(row.fieldCoveragePct, Number(manifestQuality.fieldCoveragePct) || 0);
        row.pricedPct = Math.max(row.pricedPct, Number(manifestQuality.pricedPct) || 0);
        row.sourceFetches = Math.max(row.sourceFetches, Number(manifestCounts.sourceFetches) || 0);
        row.eventSourceFetches = Math.max(row.eventSourceFetches, Number(manifestCounts.eventSourceFetches) || 0);
        row.sourceProviders = uniqueClean([...row.sourceProviders, ...(manifestProof.providers || []), fetch.provider || fetch.sourceProvider]);
        row.latestSourceAt = latestString([row.latestSourceAt, manifestProof.latestSourceAt, fetch.fetchedAt || fetch.sourceUpdatedAt]);
        row.activationScore = Number.isFinite(Number(manifestActivation.score)) ? Number(manifestActivation.score) : row.activationScore;
        row.activationStatus = cleanString(manifestActivation.status || row.activationStatus);
        row.activationLabel = cleanString(manifestActivation.statusLabel || row.activationLabel);
        row.criticalBlockers = Array.isArray(manifestActivation.criticalBlockers) ? manifestActivation.criticalBlockers : row.criticalBlockers;
        row.warnings = uniqueClean([...row.warnings, ...(Array.isArray(manifest.warnings) ? manifest.warnings : [])]);
      });

    const predictionMap = new Map();
    [...lab.modelPredictions, ...lab.predictionLedger].forEach((prediction) => {
      if (!prediction || !prediction.id) return;
      if (eventId && prediction.eventId !== eventId) return;
      if (!marketMatchesFilter(prediction.market, marketFilter)) return;
      predictionMap.set(prediction.id, prediction);
    });

    const groupedPredictions = new Map();
    [...predictionMap.values()].forEach((prediction) => {
      const modelRunId = predictionRunId(prediction);
      if (!groupedPredictions.has(modelRunId)) groupedPredictions.set(modelRunId, []);
      groupedPredictions.get(modelRunId).push(prediction);
    });

    groupedPredictions.forEach((predictions, modelRunId) => {
      const row = ensureRun(modelRunId);
      const first = predictions[0] || {};
      const markets = uniqueClean(predictions.map((prediction) => prediction.market));
      const players = uniqueClean(predictions.map((prediction) => prediction.playerId));
      const priced = predictions.filter((prediction) => Number.isFinite(numberOrNull(prediction.marketOddsAmerican))).length;
      const edged = predictions.filter((prediction) => Number.isFinite(numberOrNull(prediction.edge))).length;
      const sampleRounds = predictions.map((prediction) => numberOrNull(prediction.sampleRounds)).filter(Number.isFinite);
      row.predictionRows = predictions;
      row.eventId = cleanString(row.eventId || first.eventId);
      row.modelVersion = cleanString(row.modelVersion || first.modelVersion);
      row.modelProfile = cleanString(row.modelProfile || first.modelProfile);
      row.modelWeatherScenario = cleanString(row.modelWeatherScenario || first.modelWeatherScenario);
      row.modelWeatherLabel = cleanString(row.modelWeatherLabel || first.modelWeatherLabel);
      row.createdAt = latestString([row.createdAt, ...predictions.map((prediction) => prediction.createdAt)]);
      row.predictions = Math.max(row.predictions, predictions.length);
      row.players = Math.max(row.players, players.length);
      row.markets = Math.max(row.markets, markets.length);
      row.pricedPredictions = Math.max(row.pricedPredictions, priced);
      row.edgePredictions = Math.max(row.edgePredictions, edged);
      row.avgSampleRounds = Math.max(row.avgSampleRounds, avg(sampleRounds) || 0);
      row.minSampleRounds = Math.max(row.minSampleRounds, sampleRounds.length ? Math.min(...sampleRounds) : 0);
      row.thinSamplePlayers = Math.max(row.thinSamplePlayers, predictions.filter((prediction) => (numberOrNull(prediction.sampleRounds) || 0) < 8).length);
      row.pricedPct = Math.max(row.pricedPct, predictions.length ? Math.round((priced / predictions.length) * 100) : 0);
    });

    const rows = [...runs.values()]
      .filter((row) => !eventId || row.eventId === eventId || sourceFetchMatchesEvent(row, { id: eventId }))
      .map((row) => {
        const event = eventById.get(row.eventId);
        const proofScore = Math.round(
          (row.hasManifest ? 36 : 0) +
          (row.hasSourceFetch ? 24 : 0) +
          (row.predictions ? 20 : 0) +
          (row.sourceProviders.length ? 10 : 0) +
          (row.officialFieldRows ? 10 : 0)
        );
        const statusKey = row.criticalBlockers.length ? "blocked" :
          !row.hasSourceFetch ? "prediction-only" :
            row.hasManifest ? "reproducible" : "source-backed";
        return {
          ...row,
          eventName: row.eventName || (event ? event.name : row.eventId),
          courseName: row.courseName || (event ? event.courseName : ""),
          proofScore: Math.max(0, Math.min(100, proofScore)),
          statusKey,
          statusLabel: statusKey === "reproducible" ? "Reproducible" :
            statusKey === "source-backed" ? "Source-backed" :
              statusKey === "blocked" ? "Blocked" : "Prediction only",
          createdAt: row.createdAt || row.fetchedAt || row.latestSourceAt
        };
      })
      .sort((a, b) => cleanString(b.createdAt).localeCompare(cleanString(a.createdAt)))
      .slice(0, Number.isFinite(Number(options.maxRows)) ? Math.max(1, Number(options.maxRows)) : 8);

    const latest = rows[0] || null;
    return {
      version: MODEL_VERSION,
      generatedAt: cleanString(options.generatedAt) || new Date().toISOString(),
      selectedEvent,
      marketFilter,
      rows,
      summary: {
        runs: rows.length,
        sourceBackedRuns: rows.filter((row) => row.hasSourceFetch).length,
        manifestRuns: rows.filter((row) => row.hasManifest).length,
        predictionRows: rows.reduce((sum, row) => sum + (row.predictions || 0), 0),
        latestRunAt: latest ? latest.createdAt : "",
        latestRun: latest,
        reproduciblePct: rows.length ? Math.round((rows.filter((row) => row.hasManifest).length / rows.length) * 100) : 0
      },
      warnings: rows.length ? [] : ["No owned model runs have been saved for this filter."]
    };
  }

  function marketMatchesFilter(market, filter) {
    const target = normalizeMarketKey(filter);
    if (!target || target === "all" || target === "allmarkets") return true;
    return normalizeMarketKey(market) === target;
  }

  function marketProbabilityForRow(row, market, fieldSize) {
    const rank = Number(row.rank) || 999;
    const base = numberOrNull(row.probability) || 0;
    if (market === "winner") return base;
    if (market === "top 10") return clamp(base * Math.min(10, fieldSize), 0, 0.92);
    if (market === "top 20") return clamp(base * Math.min(20, fieldSize), 0, 0.96);
    if (market === "make cut") {
      const rankPressure = fieldSize ? 1 - ((rank - 1) / Math.max(1, fieldSize - 1)) : 0.5;
      return clamp(0.48 + (rankPressure * 0.36) + (base * 1.8), 0.08, 0.94);
    }
    return base;
  }

  function softmax(scores) {
    const max = Math.max(...scores.map((item) => item.score));
    const expRows = scores.map((item) => ({ ...item, exp: Math.exp((item.score - max) / 3.5) }));
    const total = expRows.reduce((sum, item) => sum + item.exp, 0) || 1;
    return expRows.map((item) => ({ ...item, probability: item.exp / total }));
  }

  function profitForOdds(oddsAmerican) {
    const odds = numberOrNull(oddsAmerican);
    if (!Number.isFinite(odds)) return null;
    return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
  }

  function confidenceMultiplier(confidence) {
    const label = cleanString(confidence).toLowerCase();
    if (label === "high") return 1;
    if (label === "medium") return 0.75;
    return 0.45;
  }

  function fractionalKellyUnits(probability, oddsAmerican, confidence, options = {}) {
    const payout = profitForOdds(oddsAmerican);
    const p = numberOrNull(probability);
    if (!Number.isFinite(payout) || !Number.isFinite(p)) return null;
    const fullKelly = ((payout * p) - (1 - p)) / payout;
    if (!Number.isFinite(fullKelly) || fullKelly <= 0) return 0;
    const divisor = Number.isFinite(Number(options.kellyDivisor)) ? Number(options.kellyDivisor) : 4;
    const maxUnits = Number.isFinite(Number(options.maxUnits)) ? Number(options.maxUnits) : 2;
    const unitsPerBankrollPct = Number.isFinite(Number(options.unitsPerBankrollPct)) ? Number(options.unitsPerBankrollPct) : 100;
    const units = (fullKelly / Math.max(1, divisor)) * unitsPerBankrollPct * confidenceMultiplier(confidence);
    return clamp(units, 0.25, maxUnits);
  }

  function buildEventStandings(lab, eventId) {
    const playerLookup = new Map();
    lab.players.forEach((player) => {
      playerAliases(player).forEach((alias) => playerLookup.set(alias.toLowerCase(), player));
    });
    const grouped = lab.rounds
      .filter((round) => round.eventId === eventId)
      .reduce((groups, round) => {
        const player = playerLookup.get(cleanString(round.playerId).toLowerCase())
          || playerLookup.get(cleanString(round.playerName).toLowerCase())
          || null;
        const key = player ? player.id : cleanString(round.playerId || round.playerName);
        const value = scoreToParValue(round);
        if (!key || !Number.isFinite(value)) return groups;
        if (!groups[key]) groups[key] = { player, playerId: key, playerName: player ? player.name : round.playerName || key, total: 0, rounds: 0 };
        groups[key].total += value;
        groups[key].rounds += 1;
        return groups;
      }, {});
    const rows = Object.values(grouped).sort((a, b) => a.total - b.total || cleanString(a.playerName).localeCompare(cleanString(b.playerName)));
    let lastTotal = null;
    let lastRank = 0;
    rows.forEach((row, index) => {
      if (lastTotal === null || row.total !== lastTotal) {
        lastRank = index + 1;
        lastTotal = row.total;
      }
      row.position = lastRank;
    });
    return rows;
  }

  function predictionHit(prediction, standing) {
    if (!standing) return null;
    const market = cleanString(prediction.market).toLowerCase();
    if (market === "winner" || market === "win") return standing.position === 1;
    if (market === "top 10" || market === "top10") return standing.position <= 10;
    if (market === "top 20" || market === "top20") return standing.position <= 20;
    if (market === "make cut") return standing.rounds >= 3;
    return null;
  }

  function buildPredictionBacktest(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const minEdge = Number.isFinite(Number(options.minEdge)) ? Number(options.minEdge) : null;
    const predictionMap = new Map();
    [...lab.predictionLedger, ...lab.modelPredictions].forEach((prediction) => {
      if (!prediction || !prediction.id) return;
      predictionMap.set(prediction.id, prediction);
    });
    const standingsByEvent = new Map();
    function standingsFor(eventId) {
      if (!standingsByEvent.has(eventId)) {
        standingsByEvent.set(eventId, buildEventStandings(lab, eventId));
      }
      return standingsByEvent.get(eventId);
    }
    const graded = [...predictionMap.values()].map((prediction) => {
      const standings = standingsFor(prediction.eventId);
      const standing = standings.find((row) => row.playerId === prediction.playerId);
      const hit = predictionHit(prediction, standing);
      const edge = numberOrNull(prediction.edge);
      const qualifies = minEdge === null || (Number.isFinite(edge) && edge >= minEdge);
      const profitWin = profitForOdds(prediction.marketOddsAmerican);
      const profitUnits = hit === null || !qualifies || !Number.isFinite(profitWin)
        ? null
        : hit ? profitWin : -1;
      return {
        ...prediction,
        settled: hit !== null,
        hit,
        qualifies,
        finishPosition: standing ? standing.position : null,
        finishToPar: standing ? standing.total : null,
        finishRounds: standing ? standing.rounds : null,
        profitUnits,
        result: hit === null ? "pending" : hit ? "hit" : "miss"
      };
    });
    const settled = graded.filter((row) => row.settled);
    const betRows = graded.filter((row) => Number.isFinite(row.profitUnits));
    const hits = settled.filter((row) => row.hit).length;
    const profitUnits = betRows.reduce((sum, row) => sum + row.profitUnits, 0);
    return {
      graded,
      summary: {
        total: graded.length,
        settled: settled.length,
        pending: graded.length - settled.length,
        hits,
        hitRate: settled.length ? hits / settled.length : null,
        bets: betRows.length,
        profitUnits,
        roi: betRows.length ? profitUnits / betRows.length : null
      },
      standingsByEvent: Object.fromEntries([...standingsByEvent.entries()])
    };
  }

  function predictionSourceIsSettled(prediction) {
    if (!prediction) return false;
    if (prediction.settled === true || prediction.hit === true || prediction.hit === false) return true;
    if (Number.isFinite(numberOrNull(prediction.profitUnits))) return true;
    const result = cleanString(prediction.result).toLowerCase();
    return result === "hit" || result === "miss" || result === "push";
  }

  function settlementStatus(row) {
    if (row.gradeable > 0) return { key: "ready", label: "Ready to grade" };
    if (row.settled > 0 && row.pending > 0) return { key: "partial", label: "Partial results" };
    if (row.settled > 0 && row.pending === 0) return { key: "settled", label: "Settled" };
    return { key: "waiting", label: "Needs results" };
  }

  function buildPredictionSettlementBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const minEdge = Number.isFinite(Number(options.minEdge)) ? Number(options.minEdge) : 0;
    const marketFilter = cleanString(options.market || options.marketFilter || "all") || "all";
    const backtest = buildPredictionBacktest(lab, { ...options, minEdge });
    const sourceById = new Map();
    [...lab.modelPredictions, ...lab.predictionLedger].forEach((prediction) => {
      if (prediction && prediction.id) sourceById.set(cleanString(prediction.id), prediction);
    });
    const eventById = new Map(lab.events.map((event) => [cleanString(event.id), event]));
    const filtered = backtest.graded.filter((row) => marketMatchesFilter(row.market, marketFilter));
    const grouped = filtered.reduce((acc, row) => {
      const eventId = cleanString(row.eventId) || "event";
      if (!acc[eventId]) acc[eventId] = [];
      acc[eventId].push(row);
      return acc;
    }, {});
    const eventRows = Object.entries(grouped).map(([eventId, rows]) => {
      const event = eventById.get(eventId) || {};
      const resultRounds = lab.rounds.filter((round) => cleanString(round.eventId) === eventId);
      const standings = buildEventStandings(lab, eventId);
      const settledRows = rows.filter((row) => row.settled);
      const pendingRows = rows.filter((row) => !row.settled);
      const gradeableRows = settledRows.filter((row) => !predictionSourceIsSettled(sourceById.get(cleanString(row.id))));
      const alreadySettledRows = settledRows.filter((row) => predictionSourceIsSettled(sourceById.get(cleanString(row.id))));
      const marketLabels = [...new Set(rows.map((row) => cleanString(row.market)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      const summary = summarizeBacktestRows(rows);
      const status = settlementStatus({
        gradeable: gradeableRows.length,
        settled: settledRows.length,
        pending: pendingRows.length
      });
      const latestResultAt = resultRounds.map((round) => cleanString(round.date)).filter(Boolean).sort().slice(-1)[0] || "";
      const blockers = [
        !resultRounds.length ? "Import final round results" : "",
        resultRounds.length && !standings.length ? "Scoring totals incomplete" : "",
        pendingRows.length && standings.length ? `${pendingRows.length} unresolved predictions` : "",
        !summary.bets ? "No priced bets" : "",
        gradeableRows.length ? `${gradeableRows.length} ready to write to ledger` : ""
      ].filter(Boolean);
      return {
        eventId,
        eventName: event.name || eventId,
        tour: event.tour || "",
        startDate: event.startDate || "",
        courseName: event.courseName || "",
        status: status.key,
        statusLabel: status.label,
        markets: marketLabels,
        marketCount: marketLabels.length,
        total: rows.length,
        settled: settledRows.length,
        gradeable: gradeableRows.length,
        alreadySettled: alreadySettledRows.length,
        pending: pendingRows.length,
        hits: settledRows.filter((row) => row.hit).length,
        bets: summary.bets,
        profitUnits: summary.profitUnits,
        roi: summary.roi,
        hitRate: summary.hitRate,
        resultRounds: resultRounds.length,
        standingsPlayers: standings.length,
        latestResultAt,
        blockers,
        rows: rows.sort((a, b) =>
          Number(b.settled) - Number(a.settled) ||
          Number(b.hit) - Number(a.hit) ||
          cleanString(a.market).localeCompare(cleanString(b.market)) ||
          cleanString(a.playerId).localeCompare(cleanString(b.playerId))
        )
      };
    }).sort((a, b) => {
      const order = { ready: 0, partial: 1, waiting: 2, settled: 3 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9) ||
        b.gradeable - a.gradeable ||
        cleanString(b.latestResultAt).localeCompare(cleanString(a.latestResultAt)) ||
        cleanString(a.eventName).localeCompare(cleanString(b.eventName));
    });
    const settledRows = filtered.filter((row) => row.settled);
    const gradeableRows = settledRows.filter((row) => !predictionSourceIsSettled(sourceById.get(cleanString(row.id))));
    const alreadySettledRows = settledRows.filter((row) => predictionSourceIsSettled(sourceById.get(cleanString(row.id))));
    const pendingRows = filtered.filter((row) => !row.settled);
    const betRows = filtered.filter((row) => Number.isFinite(row.profitUnits));
    const profitUnits = betRows.reduce((sum, row) => sum + row.profitUnits, 0);
    const hits = settledRows.filter((row) => row.hit).length;
    return {
      minEdge,
      marketFilter,
      summary: {
        events: eventRows.length,
        predictions: filtered.length,
        settled: settledRows.length,
        gradeable: gradeableRows.length,
        alreadySettled: alreadySettledRows.length,
        pending: pendingRows.length,
        hits,
        hitRate: settledRows.length ? hits / settledRows.length : null,
        bets: betRows.length,
        profitUnits,
        roi: betRows.length ? profitUnits / betRows.length : null,
        readyEvents: eventRows.filter((row) => row.status === "ready").length,
        waitingEvents: eventRows.filter((row) => row.status === "waiting").length
      },
      eventRows,
      gradeableRows: gradeableRows.slice(0, Number.isFinite(Number(options.maxRows)) ? Number(options.maxRows) : 12),
      pendingRows: pendingRows.slice(0, Number.isFinite(Number(options.maxRows)) ? Number(options.maxRows) : 12),
      recentSettlements: settledRows
        .sort((a, b) =>
          cleanString(b.createdAt).localeCompare(cleanString(a.createdAt)) ||
          cleanString(a.eventId).localeCompare(cleanString(b.eventId)) ||
          cleanString(a.market).localeCompare(cleanString(b.market))
        )
        .slice(0, Number.isFinite(Number(options.maxRows)) ? Number(options.maxRows) : 12)
    };
  }

  function summarizeBacktestRows(rows) {
    const total = rows.length;
    const settled = rows.filter((row) => row.settled);
    const betRows = rows.filter((row) => Number.isFinite(row.profitUnits));
    const hits = settled.filter((row) => row.hit).length;
    const profitUnits = betRows.reduce((sum, row) => sum + row.profitUnits, 0);
    return {
      total,
      settled: settled.length,
      pending: total - settled.length,
      hits,
      hitRate: settled.length ? hits / settled.length : null,
      bets: betRows.length,
      profitUnits,
      roi: betRows.length ? profitUnits / betRows.length : null,
      avgEdge: avg(rows.map((row) => numberOrNull(row.edge))),
      avgProbability: avg(rows.map((row) => numberOrNull(row.probability)))
    };
  }

  function edgeBucket(row) {
    const edge = numberOrNull(row.edge);
    if (!Number.isFinite(edge)) return { key: "unpriced", label: "No Edge" };
    if (edge >= 0.05) return { key: "edge-5-plus", label: "5+ pp" };
    if (edge >= 0.02) return { key: "edge-2-5", label: "2-5 pp" };
    if (edge >= 0) return { key: "edge-0-2", label: "0-2 pp" };
    return { key: "negative", label: "Negative" };
  }

  function groupBacktestRows(rows, keyFn) {
    const groups = new Map();
    rows.forEach((row) => {
      const group = keyFn(row);
      const key = cleanString(group.key) || "unknown";
      const label = cleanString(group.label) || key;
      if (!groups.has(key)) groups.set(key, { key, label, rows: [] });
      groups.get(key).rows.push(row);
    });
    return [...groups.values()]
      .map((group) => ({ ...group, ...summarizeBacktestRows(group.rows) }))
      .sort((a, b) =>
        b.bets - a.bets ||
        b.settled - a.settled ||
        b.profitUnits - a.profitUnits ||
        cleanString(a.label).localeCompare(cleanString(b.label))
      );
  }

  function dateTimeValue(value) {
    const cleaned = cleanString(value);
    if (!cleaned) return null;
    const time = Date.parse(cleaned);
    return Number.isFinite(time) ? time : null;
  }

  function latestTimestamp(rows, fields) {
    return rows.reduce((latest, row) => {
      const value = fields
        .map((field) => row ? row[field] : "")
        .find((candidate) => dateTimeValue(candidate) !== null);
      const time = dateTimeValue(value);
      if (time === null) return latest;
      if (!latest || time > latest.time) return { value: cleanString(value), time };
      return latest;
    }, null);
  }

  function ageDays(value, nowValue) {
    const time = dateTimeValue(value);
    const now = dateTimeValue(nowValue) || Date.now();
    if (time === null || !Number.isFinite(now)) return null;
    return Math.max(0, (now - time) / 86400000);
  }

  function marketDisplayLabel(key) {
    const normalized = normalizeMarketKey(key);
    if (normalized === "winner" || normalized === "win") return "Winner";
    if (normalized === "top10") return "Top 10";
    if (normalized === "top20") return "Top 20";
    if (normalized === "makecut" || normalized === "cut") return "Make Cut";
    return cleanString(key) || "Market";
  }

  function personIdentityKeys(row, playerLookup) {
    const rawKeys = [row && row.playerId, row && row.playerName, row && row.dataGolfId, row && row.pgaTourId]
      .map(cleanString)
      .filter(Boolean);
    const expanded = new Set();
    rawKeys.forEach((key) => {
      expanded.add(key.toLowerCase());
      const player = playerLookup.get(key.toLowerCase());
      if (player) {
        playerAliases(player).forEach((alias) => expanded.add(alias.toLowerCase()));
      }
    });
    return [...expanded];
  }

  function canonicalPersonKey(row, playerLookup) {
    const keys = personIdentityKeys(row, playerLookup);
    for (const key of keys) {
      const player = playerLookup.get(key);
      if (player && cleanString(player.id)) return cleanString(player.id).toLowerCase();
    }
    return keys[0] || "";
  }

  function predictionRunStatus(predictedPlayers, fieldCoveragePct, pricedCoveragePct) {
    if (!predictedPlayers) return { key: "empty", label: "Not run" };
    if (fieldCoveragePct >= 95 && pricedCoveragePct >= 75) return { key: "ready", label: "Ready" };
    if (fieldCoveragePct >= 95 && pricedCoveragePct < 25) return { key: "model-only", label: "Model only" };
    if (pricedCoveragePct < 50) return { key: "unpriced", label: "Needs odds" };
    return { key: "partial", label: "Partial" };
  }

  function buildModelPerformanceBoard(input, options = {}) {
    const minEdge = Number.isFinite(Number(options.minEdge)) ? Number(options.minEdge) : 0;
    const backtest = buildPredictionBacktest(input, { ...options, minEdge });
    const graded = backtest.graded;
    const settled = graded.filter((row) => row.settled);
    const recent = settled
      .sort((a, b) =>
        cleanString(b.createdAt).localeCompare(cleanString(a.createdAt)) ||
        cleanString(a.market).localeCompare(cleanString(b.market)) ||
        cleanString(a.playerId).localeCompare(cleanString(b.playerId))
      )
      .slice(0, Number.isFinite(Number(options.recentRows)) ? Number(options.recentRows) : 6);
    return {
      minEdge,
      summary: {
        ...backtest.summary,
        avgEdge: avg(graded.map((row) => numberOrNull(row.edge))),
        avgProbability: avg(graded.map((row) => numberOrNull(row.probability)))
      },
      groups: {
        markets: groupBacktestRows(graded, (row) => ({ key: normalizeMarketKey(row.market) || "market", label: cleanString(row.market) || "Market" })),
        profiles: groupBacktestRows(graded, (row) => ({ key: marketSlug(row.modelProfile || "unprofiled"), label: cleanString(row.modelProfile) || "Unprofiled" })),
        weather: groupBacktestRows(graded, (row) => ({
          key: normalizeWeatherScenarioKey(row.modelWeatherScenario || row.modelWeatherLabel || "weather-na"),
          label: cleanString(row.modelWeatherLabel || row.modelWeatherScenario) || "Weather n/a"
        })),
        confidence: groupBacktestRows(graded, (row) => ({ key: marketSlug(row.confidence || "unlabeled"), label: cleanString(row.confidence) || "Unlabeled" })),
        edgeBuckets: groupBacktestRows(graded, edgeBucket)
      },
      recent,
      graded
    };
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function tuningAction(deltaRoi, highRoi, sampleCount, minSamples, highCount, lowCount) {
    if (sampleCount < minSamples) return { key: "collect", label: "Collect data", adjustment: 0 };
    if (highCount < Math.max(1, Math.floor(minSamples / 2)) || lowCount < Math.max(1, Math.floor(minSamples / 2))) {
      return { key: "collect", label: "Collect data", adjustment: 0 };
    }
    if (deltaRoi >= 0.35 && highRoi > 0) return { key: "increase", label: "Increase", adjustment: 0.03 };
    if (deltaRoi <= -0.25 || highRoi < -0.2) return { key: "decrease", label: "Decrease", adjustment: -0.03 };
    if (Math.abs(deltaRoi) <= 0.12) return { key: "hold", label: "Hold", adjustment: 0 };
    return deltaRoi > 0 ? { key: "watch-up", label: "Watch up", adjustment: 0.01 } : { key: "watch-down", label: "Watch down", adjustment: -0.01 };
  }

  function buildFeatureTuningRows(rows, weights, minSamples) {
    return MODEL_FEATURES.map((feature) => {
      const featureRows = rows
        .map((row) => ({ row, value: numberOrNull(row[feature.key]) }))
        .filter((entry) => Number.isFinite(entry.value) && Number.isFinite(entry.row.profitUnits));
      const cut = median(featureRows.map((entry) => entry.value));
      const highRows = Number.isFinite(cut) ? featureRows.filter((entry) => entry.value >= cut).map((entry) => entry.row) : [];
      const lowRows = Number.isFinite(cut) ? featureRows.filter((entry) => entry.value < cut).map((entry) => entry.row) : [];
      const high = summarizeBacktestRows(highRows);
      const low = summarizeBacktestRows(lowRows);
      const highRoi = Number.isFinite(high.roi) ? high.roi : 0;
      const lowRoi = Number.isFinite(low.roi) ? low.roi : 0;
      const deltaRoi = highRoi - lowRoi;
      const action = tuningAction(deltaRoi, highRoi, featureRows.length, minSamples, highRows.length, lowRows.length);
      const currentWeight = numberOrNull(weights[feature.key]) || 0;
      return {
        key: feature.key,
        label: feature.label,
        sampleCount: featureRows.length,
        splitValue: cut,
        high,
        low,
        deltaRoi,
        deltaHitRate: (Number.isFinite(high.hitRate) ? high.hitRate : 0) - (Number.isFinite(low.hitRate) ? low.hitRate : 0),
        action: action.key,
        actionLabel: action.label,
        currentWeight,
        adjustment: action.adjustment,
        suggestedWeight: Math.max(0, Number((currentWeight + action.adjustment).toFixed(3)))
      };
    }).sort((a, b) =>
      Math.abs(b.adjustment) - Math.abs(a.adjustment) ||
      Math.abs(b.deltaRoi) - Math.abs(a.deltaRoi) ||
      cleanString(a.label).localeCompare(cleanString(b.label))
    );
  }

  function buildModelTuningBoard(input, options = {}) {
    const minEdge = Number.isFinite(Number(options.minEdge)) ? Number(options.minEdge) : 0;
    const marketFilter = cleanString(options.market || options.marketFilter || "all");
    const minSamples = Number.isFinite(Number(options.minSamples)) ? Number(options.minSamples) : 4;
    const weights = normalizeWeights(options.weights || DEFAULT_WEIGHTS);
    const performance = buildModelPerformanceBoard(input, { ...options, minEdge });
    const filtered = performance.graded.filter((row) => marketMatchesFilter(row.market, marketFilter));
    const filteredSummary = summarizeBacktestRows(filtered);
    const settled = filtered.filter((row) => row.settled);
    const betRows = settled.filter((row) => Number.isFinite(row.profitUnits));
    const featureRows = buildFeatureTuningRows(betRows, weights, minSamples);
    const profileRows = groupBacktestRows(filtered, (row) => ({
      key: marketSlug(row.modelProfile || "unprofiled"),
      label: cleanString(row.modelProfile) || "Unprofiled"
    })).slice(0, 6);
    const marketRows = groupBacktestRows(filtered, (row) => ({
      key: normalizeMarketKey(row.market) || "market",
      label: marketDisplayLabel(row.market)
    })).slice(0, 6);
    const calibration = buildModelCalibrationBoard(input, {
      ...options,
      minEdge,
      market: marketFilter,
      minSamples
    });
    const bestProfile = profileRows.filter((row) => row.bets > 0).sort((a, b) =>
      (Number.isFinite(b.roi) ? b.roi : -999) - (Number.isFinite(a.roi) ? a.roi : -999)
    )[0] || null;
    const worstProfile = profileRows.filter((row) => row.bets > 0).sort((a, b) =>
      (Number.isFinite(a.roi) ? a.roi : 999) - (Number.isFinite(b.roi) ? b.roi : 999)
    )[0] || null;
    const tuneSignals = featureRows.filter((row) => row.action === "increase" || row.action === "decrease").length;
    const topRecommendation = featureRows.find((row) => row.action === "increase" || row.action === "decrease") || null;
    const alerts = [];
    if (settled.length < minSamples) {
      alerts.push({
        severity: "warning",
        label: "Thin sample",
        detail: `${settled.length}/${minSamples} settled predictions for this filter.`
      });
    }
    if (Number.isFinite(filteredSummary.roi) && filteredSummary.roi < 0) {
      alerts.push({
        severity: "warning",
        label: "ROI drag",
        detail: `${filteredSummary.profitUnits.toFixed(2)} units across ${filteredSummary.bets} bets.`
      });
    }
    if (topRecommendation) {
      alerts.push({
        severity: topRecommendation.action === "decrease" ? "warning" : "info",
        label: `${topRecommendation.actionLabel} ${topRecommendation.label}`,
        detail: `High split ROI delta ${topRecommendation.deltaRoi.toFixed(2)}u.`
      });
    }
    if (Number.isFinite(calibration.summary.calibrationError) && calibration.summary.calibrationError > 0.08) {
      alerts.push({
        severity: "warning",
        label: "Calibration drift",
        detail: `${Math.round(calibration.summary.calibrationError * 100)} points off settled hit rate.`
      });
    }
    return {
      minEdge,
      marketFilter,
      minSamples,
      weights,
      summary: {
        totalPredictions: filtered.length,
        settled: settled.length,
        bets: filteredSummary.bets,
        profitUnits: filteredSummary.profitUnits,
        roi: filteredSummary.roi,
        hitRate: filteredSummary.hitRate,
        tuneSignals,
        bestProfile: bestProfile ? bestProfile.label : "",
        worstProfile: worstProfile ? worstProfile.label : "",
        calibrationError: calibration.summary.calibrationError
      },
      featureRows,
      profileRows,
      marketRows,
      calibrationSummary: calibration.summary,
      alerts
    };
  }

  function buildPredictionRunAuditBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const selectedEvent = selectModelEvent(lab, options);
    const minEdge = Number.isFinite(Number(options.minEdge)) ? Number(options.minEdge) : 0.01;
    const marketFilter = cleanString(options.market || options.marketFilter || "all");
    const maxNames = Number.isFinite(Number(options.maxNames)) ? Number(options.maxNames) : 4;
    const now = cleanString(options.now) || new Date().toISOString();
    const emptySummary = {
      activeFieldCount: 0,
      markets: 0,
      readyMarkets: 0,
      totalPredictions: 0,
      modeledFieldPlayers: 0,
      fieldCoveragePct: 0,
      pricedPredictions: 0,
      pricedPct: 0,
      positiveEdges: 0,
      thresholdEdges: 0,
      settled: 0,
      unresolved: 0,
      profitUnits: 0,
      latestPredictionAt: "",
      latestOddsAt: ""
    };
    if (!selectedEvent) {
      return {
        selectedEvent: null,
        event: null,
        marketFilter,
        minEdge,
        generatedAt: now,
        summary: emptySummary,
        marketRows: [],
        gaps: [{
          severity: "blocker",
          label: "Import event",
          detail: "No tournament event is available for a prediction run audit."
        }]
      };
    }

    const eventIds = [selectedEvent.id, selectedEvent.eventId].map(cleanString).filter(Boolean);
    const playerLookup = new Map();
    lab.players.forEach((player) => {
      playerAliases(player).forEach((alias) => playerLookup.set(alias.toLowerCase(), player));
    });
    const fieldRows = eventFieldPlayers(lab, selectedEvent, options);
    const fieldPlayers = fieldRows.map((field) => {
      const player = playerLookup.get(cleanString(field.playerId).toLowerCase())
        || playerLookup.get(cleanString(field.playerName).toLowerCase())
        || null;
      const row = {
        playerId: player ? player.id : cleanString(field.playerId || field.playerName),
        playerName: player ? player.name : cleanString(field.playerName || field.playerId),
        player,
        field
      };
      return {
        ...row,
        key: canonicalPersonKey({ ...field, playerId: row.playerId, playerName: row.playerName }, playerLookup)
      };
    }).filter((row) => row.key);
    const fieldKeySet = new Set(fieldPlayers.map((row) => row.key));
    const fieldNameByKey = new Map(fieldPlayers.map((row) => [row.key, row.playerName || row.playerId]));

    const predictionMap = new Map();
    [...lab.predictionLedger, ...lab.modelPredictions].forEach((prediction, index) => {
      if (!prediction || !eventIds.includes(cleanString(prediction.eventId))) return;
      if (!marketMatchesFilter(prediction.market, marketFilter)) return;
      const fallback = [
        prediction.eventId,
        prediction.playerId,
        prediction.playerName,
        normalizeMarketKey(prediction.market),
        prediction.modelVersion,
        prediction.createdAt,
        index
      ].map(cleanString).join("|");
      predictionMap.set(cleanString(prediction.id) || fallback, prediction);
    });
    const predictions = [...predictionMap.values()];

    const eventOdds = lab.oddsSnapshots.filter((odds) =>
      odds &&
      eventIds.includes(cleanString(odds.eventId)) &&
      marketMatchesFilter(odds.market, marketFilter)
    );
    const oddsByMarketAndPlayer = new Map();
    const booksByMarket = new Map();
    eventOdds.forEach((odds) => {
      const marketKey = normalizeMarketKey(odds.market);
      const personKey = canonicalPersonKey(odds, playerLookup);
      if (marketKey && personKey) oddsByMarketAndPlayer.set(`${marketKey}|${personKey}`, odds);
      if (!booksByMarket.has(marketKey)) booksByMarket.set(marketKey, new Set());
      const book = cleanString(odds.book || odds.sportsbook || odds.provider || odds.sourceProvider);
      if (book) booksByMarket.get(marketKey).add(book);
    });

    const marketKeys = new Set(["winner", "top10", "top20", "makecut"]);
    predictions.forEach((prediction) => marketKeys.add(normalizeMarketKey(prediction.market)));
    eventOdds.forEach((odds) => marketKeys.add(normalizeMarketKey(odds.market)));
    const orderedMarkets = [...marketKeys]
      .filter(Boolean)
      .filter((market) => marketMatchesFilter(market, marketFilter))
      .sort((a, b) => {
        const order = { winner: 0, top10: 1, top20: 2, makecut: 3 };
        return (order[a] ?? 99) - (order[b] ?? 99) || marketDisplayLabel(a).localeCompare(marketDisplayLabel(b));
      });

    const backtest = buildPredictionBacktest(lab, { minEdge: 0 });
    const gradedById = new Map(backtest.graded.map((row) => [cleanString(row.id), row]));
    const modeledFieldKeys = new Set();
    const latestPrediction = latestTimestamp(predictions, ["createdAt", "sourceUpdatedAt", "fetchedAt", "updatedAt"]);
    const latestOdds = latestTimestamp(eventOdds, ["capturedAt", "sourceUpdatedAt", "fetchedAt", "createdAt", "updatedAt"]);

    const marketRows = orderedMarkets.map((marketKey) => {
      const marketPredictions = predictions.filter((prediction) => normalizeMarketKey(prediction.market) === marketKey);
      const marketOdds = eventOdds.filter((odds) => normalizeMarketKey(odds.market) === marketKey);
      const predictedKeys = new Set();
      const fieldPredictedKeys = new Set();
      const pricedKeys = new Set();
      const modelOnlyNames = [];
      let positiveEdges = 0;
      let thresholdEdges = 0;
      marketPredictions.forEach((prediction) => {
        const personKey = canonicalPersonKey(prediction, playerLookup);
        if (!personKey) return;
        predictedKeys.add(personKey);
        if (fieldKeySet.has(personKey)) {
          fieldPredictedKeys.add(personKey);
          modeledFieldKeys.add(personKey);
        }
        const edge = numberOrNull(prediction.edge);
        if (Number.isFinite(edge) && edge > 0) positiveEdges += 1;
        if (Number.isFinite(edge) && edge >= minEdge) thresholdEdges += 1;
        const directOdds = numberOrNull(prediction.marketOddsAmerican);
        const matchedOdds = oddsByMarketAndPlayer.get(`${marketKey}|${personKey}`);
        if (Number.isFinite(directOdds) || matchedOdds) {
          pricedKeys.add(personKey);
        } else {
          const player = playerLookup.get(personKey);
          modelOnlyNames.push(player ? player.name : cleanString(prediction.playerName || prediction.playerId));
        }
      });
      const pricedFieldKeys = new Set();
      marketOdds.forEach((odds) => {
        const key = canonicalPersonKey(odds, playerLookup);
        if (fieldKeySet.has(key)) pricedFieldKeys.add(key);
      });
      const missingFieldPlayers = fieldPlayers
        .filter((player) => !fieldPredictedKeys.has(player.key))
        .map((player) => player.playerName || player.playerId)
        .filter(Boolean);
      const gradedRows = marketPredictions
        .map((prediction) => gradedById.get(cleanString(prediction.id)))
        .filter(Boolean);
      const settledRows = gradedRows.filter((row) => row.settled);
      const betRows = gradedRows.filter((row) => Number.isFinite(row.profitUnits));
      const hits = settledRows.filter((row) => row.hit).length;
      const profitUnits = betRows.reduce((sum, row) => sum + row.profitUnits, 0);
      const fieldCoveragePct = fieldPlayers.length ? Math.round((fieldPredictedKeys.size / fieldPlayers.length) * 100) : 0;
      const pricedPct = predictedKeys.size ? Math.round((pricedKeys.size / predictedKeys.size) * 100) : 0;
      const status = predictionRunStatus(predictedKeys.size, fieldCoveragePct, pricedPct);
      const marketLatestPrediction = latestTimestamp(marketPredictions, ["createdAt", "sourceUpdatedAt", "fetchedAt", "updatedAt"]);
      const marketLatestOdds = latestTimestamp(marketOdds, ["capturedAt", "sourceUpdatedAt", "fetchedAt", "createdAt", "updatedAt"]);
      return {
        key: marketKey,
        label: marketDisplayLabel(marketKey),
        status: status.key,
        statusLabel: status.label,
        activeFieldCount: fieldPlayers.length,
        predictedPlayers: predictedKeys.size,
        fieldPredictedPlayers: fieldPredictedKeys.size,
        fieldCoveragePct,
        pricedPredictions: pricedKeys.size,
        pricedPct,
        pricedFieldPlayers: pricedFieldKeys.size,
        oddsRows: marketOdds.length,
        bookCount: booksByMarket.get(marketKey) ? booksByMarket.get(marketKey).size : 0,
        books: booksByMarket.get(marketKey) ? [...booksByMarket.get(marketKey)].sort() : [],
        positiveEdges,
        thresholdEdges,
        settled: settledRows.length,
        unresolved: Math.max(0, marketPredictions.length - settledRows.length),
        hits,
        hitRate: settledRows.length ? hits / settledRows.length : null,
        bets: betRows.length,
        profitUnits,
        latestPredictionAt: marketLatestPrediction ? marketLatestPrediction.value : "",
        latestOddsAt: marketLatestOdds ? marketLatestOdds.value : "",
        predictionAgeDays: marketLatestPrediction ? ageDays(marketLatestPrediction.value, now) : null,
        oddsAgeDays: marketLatestOdds ? ageDays(marketLatestOdds.value, now) : null,
        missingPredictionCount: missingFieldPlayers.length,
        missingPredictions: missingFieldPlayers.slice(0, maxNames),
        modelOnlyCount: modelOnlyNames.length,
        modelOnlyPlayers: modelOnlyNames.slice(0, maxNames)
      };
    });

    const totalPredictions = marketRows.reduce((sum, row) => sum + row.predictedPlayers, 0);
    const pricedPredictions = marketRows.reduce((sum, row) => sum + row.pricedPredictions, 0);
    const settled = marketRows.reduce((sum, row) => sum + row.settled, 0);
    const unresolved = marketRows.reduce((sum, row) => sum + row.unresolved, 0);
    const gaps = [];
    if (!fieldPlayers.length) {
      gaps.push({ severity: "blocker", label: "Import field", detail: "No active field rows exist for the selected event." });
    }
    if (!totalPredictions) {
      gaps.push({ severity: "blocker", label: "Run model", detail: "No saved predictions match this event and market filter." });
    }
    marketRows.forEach((row) => {
      if (row.predictedPlayers && row.modelOnlyCount) {
        gaps.push({
          severity: "warning",
          label: `${row.label} odds`,
          detail: `${row.modelOnlyCount} modeled player${row.modelOnlyCount === 1 ? "" : "s"} do not have matching market odds.`
        });
      }
      if (row.missingPredictionCount) {
        gaps.push({
          severity: "warning",
          label: `${row.label} field`,
          detail: `${row.missingPredictionCount} active field player${row.missingPredictionCount === 1 ? "" : "s"} are not modeled.`
        });
      }
    });
    if (totalPredictions && unresolved) {
      gaps.push({ severity: "info", label: "Grade results", detail: `${unresolved} prediction${unresolved === 1 ? "" : "s"} are still unresolved.` });
    }

    return {
      selectedEvent,
      event: selectedEvent,
      marketFilter,
      minEdge,
      generatedAt: now,
      summary: {
        activeFieldCount: fieldPlayers.length,
        markets: marketRows.length,
        readyMarkets: marketRows.filter((row) => row.status === "ready").length,
        totalPredictions,
        modeledFieldPlayers: modeledFieldKeys.size,
        fieldCoveragePct: fieldPlayers.length ? Math.round((modeledFieldKeys.size / fieldPlayers.length) * 100) : 0,
        pricedPredictions,
        pricedPct: totalPredictions ? Math.round((pricedPredictions / totalPredictions) * 100) : 0,
        positiveEdges: marketRows.reduce((sum, row) => sum + row.positiveEdges, 0),
        thresholdEdges: marketRows.reduce((sum, row) => sum + row.thresholdEdges, 0),
        settled,
        unresolved,
        profitUnits: marketRows.reduce((sum, row) => sum + row.profitUnits, 0),
        latestPredictionAt: latestPrediction ? latestPrediction.value : "",
        latestOddsAt: latestOdds ? latestOdds.value : "",
        predictionAgeDays: latestPrediction ? ageDays(latestPrediction.value, now) : null,
        oddsAgeDays: latestOdds ? ageDays(latestOdds.value, now) : null,
        topGaps: gaps.slice(0, 4)
      },
      marketRows,
      gaps
    };
  }

  function eventSourceFetchRows(lab, event) {
    if (!event) return [];
    const eventNeedles = [event.id, event.eventId, event.name]
      .map(cleanString)
      .filter(Boolean)
      .map((value) => value.toLowerCase());
    return lab.sourceFetches.filter((row) => {
      const haystack = [
        row.id,
        row.endpoint,
        row.sourceUrl,
        row.provider,
        row.status
      ].map(cleanString).join(" ").toLowerCase();
      return eventNeedles.some((needle) => haystack.includes(needle));
    });
  }

  function prepGate(id, label, score, detail, nextAction, options = {}) {
    const safeScore = Math.round(clamp(Number.isFinite(Number(score)) ? Number(score) : 0, 0, 100));
    let status = "blocked";
    let statusLabel = "Blocked";
    if (safeScore >= 90) {
      status = "ready";
      statusLabel = "Ready";
    } else if (safeScore >= 65) {
      status = "watch";
      statusLabel = "Watch";
    } else if (safeScore >= 35) {
      status = "partial";
      statusLabel = "Partial";
    }
    if (options.status) status = options.status;
    if (options.statusLabel) statusLabel = options.statusLabel;
    return {
      id,
      label,
      score: safeScore,
      status,
      statusLabel,
      detail: cleanString(detail),
      nextAction: cleanString(nextAction),
      severity: options.severity || (status === "blocked" ? "blocker" : status === "partial" ? "warning" : "info"),
      critical: Boolean(options.critical),
      meta: options.meta || {}
    };
  }

  function predictionPrepStatus(gates, summary, event) {
    if (!event) return { key: "setup", label: "Needs event" };
    const criticalBlockers = gates.filter((gate) => gate.critical && gate.status === "blocked");
    if (criticalBlockers.length) return { key: "research", label: "Research needed" };
    if (!summary.totalPredictions) return { key: "model-ready", label: "Ready to model" };
    if (!summary.pricedPredictions) return { key: "model-only", label: "Model only" };
    if (summary.thresholdEdges > 0) return { key: "bet-ready", label: "Bet slate ready" };
    if (summary.positiveEdges > 0) return { key: "edge-watch", label: "Edge watch" };
    return { key: "priced", label: "Priced, no edge" };
  }

  function predictionPrepRunAction(status, summary) {
    if (status.key === "research") return "Resolve critical source gates";
    if (status.key === "model-ready") return "Run owned model";
    if (status.key === "model-only") return "Import current odds";
    if (status.key === "bet-ready") return "Review portfolio and line shop";
    if (status.key === "edge-watch") return "Line shop and explain edge";
    if (status.key === "priced") return "Refresh model or wait";
    if (summary && summary.totalPredictions) return "Audit saved model run";
    return "Prepare tournament sources";
  }

  function buildPredictionPrepRunBrief(event, course, weatherScenario, gates, summary, status, options = {}) {
    const criticalGates = gates.filter((gate) => gate.critical);
    const criticalBlocked = criticalGates.filter((gate) => gate.status === "blocked");
    const blocked = gates.filter((gate) => gate.status === "blocked");
    const nextGate = gates
      .filter((gate) => gate.status !== "ready")
      .sort((a, b) =>
        Number(b.critical) - Number(a.critical) ||
        a.score - b.score ||
        cleanString(a.label).localeCompare(cleanString(b.label))
      )[0] || null;
    const modelProfile = cleanString(options.modelProfile || options.profile || options.preset) || "Owned model";
    const market = cleanString(options.market || options.marketFilter || "all") || "all";
    const minEdge = Number.isFinite(Number(options.minEdge)) ? Number(options.minEdge) : 0.01;
    const sourceSafe = Boolean(event) && !criticalBlocked.length && summary && summary.criticalBlockers === 0;
    const priced = summary && summary.pricedPredictions > 0;
    const modeled = summary && summary.totalPredictions > 0;
    return {
      eventId: event ? event.id || event.eventId || "" : "",
      eventName: event ? event.name || event.id || "" : "",
      courseName: course ? course.name || event.courseName || "" : event ? event.courseName || "" : "",
      modelProfile,
      weatherScenario: weatherScenario ? weatherScenario.key || "" : "",
      weatherLabel: weatherScenario ? weatherScenario.label || "" : "",
      marketFilter: market,
      minEdge,
      status: status ? status.key : "setup",
      statusLabel: status ? status.label : "Needs setup",
      action: predictionPrepRunAction(status || { key: "setup" }, summary || {}),
      sourceSafe,
      sourceSafeLabel: sourceSafe ? "Source-safe run" : "Source gates open",
      modeled,
      priced,
      betReady: Boolean(status && status.key === "bet-ready"),
      criticalReady: criticalGates.length - criticalBlocked.length,
      criticalGates: criticalGates.length,
      blockedGates: blocked.length,
      nextGate: nextGate ? {
        id: nextGate.id,
        label: nextGate.label,
        status: nextGate.status,
        detail: nextGate.detail,
        nextAction: nextGate.nextAction,
        critical: nextGate.critical
      } : null,
      counts: {
        field: summary ? summary.fieldCount || 0 : 0,
        matchedProfiles: summary ? summary.matchedProfiles || 0 : 0,
        modelReadyPlayers: summary ? summary.modelReadyPlayers || 0 : 0,
        predictions: summary ? summary.totalPredictions || 0 : 0,
        pricedPredictions: summary ? summary.pricedPredictions || 0 : 0,
        playableEdges: summary ? summary.thresholdEdges || 0 : 0
      }
    };
  }

  function hasFeatureSourceProof(row) {
    if (!row || typeof row !== "object") return false;
    return Boolean(cleanString(row.sourceProvider || row.provider) || cleanString(row.sourceUrl || row.url) || cleanString(row.sourceUpdatedAt || row.fetchedAt || row.updatedAt));
  }

  function featureAuditStatus(score, critical = false) {
    if (score >= 85) return { key: "ready", label: "Ready" };
    if (score >= 60) return { key: "partial", label: "Partial" };
    if (score >= 35) return { key: "thin", label: "Thin" };
    return { key: critical ? "blocked" : "missing", label: critical ? "Blocked" : "Missing" };
  }

  function featureAuditPart(key, label, sample, value, options = {}) {
    const critical = Boolean(options.critical);
    const neutralOk = Boolean(options.neutralOk);
    const numericSample = Math.max(0, Number(sample) || 0);
    const sampleTarget = Math.max(1, Number(options.sampleTarget) || 1);
    const sampleScore = neutralOk ? 100 : Math.min(100, Math.round((numericSample / sampleTarget) * 100));
    const valueScore = neutralOk || Number.isFinite(value) ? 100 : 0;
    const score = Math.round(sampleScore * 0.72 + valueScore * 0.28);
    const status = featureAuditStatus(score, critical);
    return {
      key,
      label,
      score,
      status: status.key,
      statusLabel: status.label,
      critical,
      value: Number.isFinite(value) ? value : null,
      sample: numericSample,
      sampleTarget,
      detail: cleanString(options.detail),
      nextAction: cleanString(options.nextAction)
    };
  }

  function featureAuditReadiness(score, blockers) {
    if (blockers > 0) return score >= 60 ? "research" : "blocked";
    if (score >= 85) return "premium-ready";
    if (score >= 70) return "model-ready";
    if (score >= 45) return "building";
    return "thin";
  }

  function matchingDifficultyRounds(lab, playerRounds, course) {
    const targetBucket = GolfLab.classifyCourseDifficulty(course).bucket;
    if (!targetBucket || targetBucket === "Unknown") return [];
    const coursesById = new Map(lab.courses.map((item) => [item.id, item]));
    return playerRounds.filter((round) => {
      const roundCourse = coursesById.get(round.courseId) || {};
      return GolfLab.classifyCourseDifficulty(roundCourse).bucket === targetBucket;
    });
  }

  function matchingWeatherRounds(lab, playerRounds, targetWeather) {
    const targetBucket = weatherBucket(targetWeather);
    if (targetBucket === "unknown" || targetBucket === "neutral") return [];
    return playerRounds.filter((round) => weatherBucket(weatherForRound(lab, round)) === targetBucket);
  }

  function directCourseRows(card, course) {
    if (!card || !course) return [];
    const ids = [course.id, course.name].map(cleanString).filter(Boolean);
    return [...card.bestCourses, ...card.worstCourses].filter((row) =>
      ids.includes(cleanString(row.courseId)) || ids.includes(cleanString(row.courseName))
    );
  }

  function buildFeatureStoreAuditBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const event = selectModelEvent(lab, options);
    const now = cleanString(options.now || options.createdAt) || new Date().toISOString();
    const marketFilter = cleanString(options.market || options.marketFilter || "all") || "all";
    if (!event) {
      return {
        generatedAt: now,
        event: null,
        readiness: "blocked",
        score: 0,
        marketFilter,
        summary: {
          players: 0,
          rows: 0,
          readyPlayers: 0,
          modelReadyPlayers: 0,
          blockers: 1,
          avgFeatureScore: 0
        },
        gates: [featureAuditPart("event", "Tournament", 0, null, { critical: true, detail: "No tournament event is available.", nextAction: "Import or create a tournament schedule row." })],
        blockers: ["Tournament event missing"],
        rows: []
      };
    }

    const course = courseForEvent(lab, event);
    const { weather: eventWeather, scenario: weatherScenario } = eventWeatherForOptions(lab, event, options);
    const fieldRows = eventFieldPlayers(lab, event, options);
    const eventIds = [event.id, event.eventId].map(cleanString).filter(Boolean);
    const playerLookup = new Map();
    lab.players.forEach((player) => {
      playerAliases(player).forEach((alias) => playerLookup.set(alias.toLowerCase(), player));
    });
    const rows = fieldRows.map((field) => {
      const player = playerLookup.get(cleanString(field.playerId).toLowerCase()) || playerLookup.get(cleanString(field.playerName).toLowerCase()) || null;
      if (!player) {
        const part = featureAuditPart("profile", "Profile Match", 0, null, { critical: true, detail: "Field row does not match an imported player profile.", nextAction: "Normalize playerId/playerName against players.csv." });
        return {
          playerId: cleanString(field.playerId || field.playerName),
          playerName: cleanString(field.playerName || field.playerId || "Unmatched player"),
          matchedProfile: false,
          fieldStatus: field.status || "active",
          score: part.score,
          readiness: "blocked",
          parts: [part],
          blockers: ["Profile match missing"],
          warnings: [],
          features: {},
          sample: { rounds: 0, strokesGainedRows: 0, oddsRows: 0, predictionRows: 0, sourceProofRows: 0, sourceRows: 1 }
        };
      }
      const aliases = playerAliases(player);
      const playerRounds = lab.rounds.filter((round) => roundPlayerMatches(round, aliases));
      const sgRows = lab.strokesGained.filter((row) => roundPlayerMatches(row, aliases));
      const oddsRows = lab.oddsSnapshots.filter((row) =>
        eventIds.includes(cleanString(row.eventId)) &&
        (aliases.includes(cleanString(row.playerId)) || aliases.includes(cleanString(row.playerName))) &&
        marketMatchesFilter(row.market, marketFilter)
      );
      const predictionRows = [...lab.predictionLedger, ...lab.modelPredictions].filter((row) =>
        eventIds.includes(cleanString(row.eventId)) &&
        (aliases.includes(cleanString(row.playerId)) || aliases.includes(cleanString(row.playerName))) &&
        marketMatchesFilter(row.market, marketFilter)
      );
      const card = GolfLab.buildPlayerScorecard(lab, player.id, { eventId: event.id });
      const courseRows = directCourseRows(card, course);
      const difficultyRows = matchingDifficultyRounds(lab, playerRounds, course);
      const weatherRows = matchingWeatherRounds(lab, playerRounds, eventWeather);
      const sourceRows = [player, field, ...playerRounds, ...sgRows, ...oddsRows, ...predictionRows].filter(Boolean);
      const sourceProofRows = sourceRows.filter(hasFeatureSourceProof);
      const features = {
        skill: skillScore(card),
        recentForm: recentFormScore(playerRounds),
        courseFit: courseFitScore(card, course),
        difficultyFit: difficultyFitScore(lab, playerRounds, course),
        weatherFit: weatherFitScore(lab, playerRounds, eventWeather)
      };
      const weatherNeutral = weatherBucket(eventWeather) === "unknown" || weatherBucket(eventWeather) === "neutral";
      const parts = [
        featureAuditPart("profile", "Profile", player ? 1 : 0, player ? 1 : null, { critical: true, detail: player ? "Matched player profile" : "Unmatched profile", nextAction: "Normalize field row to players.csv." }),
        featureAuditPart("skill", "Skill", sgRows.length || playerRounds.length, features.skill, { critical: true, sampleTarget: 3, detail: `${sgRows.length} SG rows | ${playerRounds.length} round rows`, nextAction: "Backfill strokes-gained or round scoring history." }),
        featureAuditPart("recentForm", "Recent Form", playerRounds.length, features.recentForm, { critical: true, sampleTarget: 5, detail: `${playerRounds.length} imported rounds`, nextAction: "Import recent leaderboard/round exports." }),
        featureAuditPart("courseFit", "Course Fit", courseRows.reduce((sum, row) => sum + (row.rounds || 0), 0), features.courseFit, { sampleTarget: 2, detail: course.name || event.courseName || "Selected course", nextAction: "Backfill player rounds on this course or close comps." }),
        featureAuditPart("difficultyFit", "Difficulty Fit", difficultyRows.length, features.difficultyFit, { critical: true, sampleTarget: 3, detail: `${GolfLab.classifyCourseDifficulty(course).bucket} course sample`, nextAction: "Backfill rounds on courses with similar difficulty." }),
        featureAuditPart("weatherFit", "Weather Fit", weatherRows.length, features.weatherFit, { sampleTarget: 2, neutralOk: weatherNeutral, detail: weatherNeutral ? "Neutral/no event weather" : `${weatherBucket(eventWeather)} weather sample`, nextAction: "Import weather-linked rounds for this condition." }),
        featureAuditPart("market", "Market", oddsRows.length, oddsRows.length ? oddsRows.length : null, { sampleTarget: 1, detail: `${oddsRows.length} odds rows`, nextAction: "Import current market odds for selected market." }),
        featureAuditPart("model", "Model Output", predictionRows.length, predictionRows.length ? predictionRows.length : null, { critical: true, sampleTarget: 1, detail: `${predictionRows.length} prediction rows`, nextAction: "Run the owned model for this event." }),
        featureAuditPart("source", "Source Proof", sourceRows.length ? sourceProofRows.length / sourceRows.length : 0, sourceProofRows.length ? sourceProofRows.length / sourceRows.length : null, { critical: true, sampleTarget: 1, detail: `${sourceProofRows.length}/${sourceRows.length} rows with proof`, nextAction: "Fill sourceProvider/sourceUrl/sourceUpdatedAt on input rows." })
      ];
      const blockers = parts.filter((part) => part.critical && part.status === "blocked").map((part) => part.label);
      const score = Math.round(avg(parts.map((part) => part.score)) || 0);
      const warnings = parts.filter((part) => !part.critical && ["missing", "thin"].includes(part.status)).map((part) => part.label);
      return {
        playerId: player.id,
        playerName: player.name || player.id,
        matchedProfile: true,
        fieldStatus: field.status || "active",
        score,
        readiness: featureAuditReadiness(score, blockers.length),
        parts,
        blockers,
        warnings,
        features,
        sample: {
          rounds: playerRounds.length,
          strokesGainedRows: sgRows.length,
          courseRows: courseRows.length,
          difficultyRows: difficultyRows.length,
          weatherRows: weatherRows.length,
          oddsRows: oddsRows.length,
          predictionRows: predictionRows.length,
          sourceProofRows: sourceProofRows.length,
          sourceRows: sourceRows.length
        }
      };
    }).filter(Boolean).sort((a, b) => b.score - a.score || cleanString(a.playerName).localeCompare(cleanString(b.playerName)));
    const gates = ["profile", "skill", "recentForm", "courseFit", "difficultyFit", "weatherFit", "market", "model", "source"].map((key) => {
      const partRows = rows.flatMap((row) => row.parts || []).filter((part) => part.key === key);
      const score = Math.round(avg(partRows.map((part) => part.score)) || 0);
      const status = featureAuditStatus(score, ["profile", "skill", "recentForm", "difficultyFit", "model", "source"].includes(key));
      const label = (MODEL_FEATURES.find((feature) => feature.key === key) || {
        profile: { label: "Profile" },
        market: { label: "Market" },
        model: { label: "Model Output" },
        source: { label: "Source Proof" }
      }[key] || { label: key }).label;
      return {
        key,
        label,
        score,
        status: status.key,
        statusLabel: status.label,
        readyPlayers: partRows.filter((part) => part.status === "ready").length,
        playerCount: rows.length
      };
    });
    const blockerRows = rows.filter((row) => row.blockers.length);
    const score = Math.round(avg(rows.map((row) => row.score)) || 0);
    const blockers = [
      !fieldRows.length ? "Field rows missing" : "",
      !rows.length ? "Feature rows missing" : "",
      blockerRows.length ? `${blockerRows.length} players blocked` : "",
      gates.some((gate) => gate.key === "model" && gate.status === "blocked") ? "Model output missing" : "",
      gates.some((gate) => gate.key === "source" && gate.status === "blocked") ? "Source proof missing" : ""
    ].filter(Boolean);
    return {
      generatedAt: now,
      event: {
        id: event.id,
        name: event.name || event.id,
        startDate: event.startDate,
        courseName: event.courseName,
        tour: event.tour
      },
      course: {
        id: course.id,
        name: course.name || event.courseName,
        difficulty: GolfLab.classifyCourseDifficulty(course)
      },
      weather: eventWeather,
      weatherScenario,
      marketFilter,
      readiness: featureAuditReadiness(score, blockers.length),
      score,
      summary: {
        players: rows.length,
        rows: rows.length,
        fieldRows: fieldRows.length,
        readyPlayers: rows.filter((row) => row.readiness === "premium-ready" || row.readiness === "model-ready").length,
        modelReadyPlayers: rows.filter((row) => row.parts.some((part) => part.key === "model" && part.status === "ready")).length,
        blockedPlayers: blockerRows.length,
        avgFeatureScore: score,
        blockers: blockers.length,
        weatherBucket: weatherBucket(eventWeather)
      },
      gates,
      blockers,
      rows
    };
  }

  function buildPredictionPrepBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const event = selectModelEvent(lab, options);
    const marketFilter = cleanString(options.market || options.marketFilter || "all");
    const minEdge = Number.isFinite(Number(options.minEdge)) ? Number(options.minEdge) : 0.01;
    const now = cleanString(options.now || options.createdAt) || new Date().toISOString();
    if (!event) {
      const setupGates = [
        prepGate("event", "Tournament", 0, "No tournament event is available.", "Import or create a tournament schedule row.", { critical: true })
      ];
      const setupSummary = {
        fieldCount: 0,
        matchedProfiles: 0,
        modelReadyPlayers: 0,
        weatherRows: 0,
        oddsRows: 0,
        totalPredictions: 0,
        pricedPredictions: 0,
        thresholdEdges: 0,
        blockers: 1,
        criticalBlockers: 1
      };
      const setupStatus = { key: "setup", label: "Needs event" };
      return {
        generatedAt: now,
        event: null,
        marketFilter,
        minEdge,
        status: setupStatus.key,
        statusLabel: setupStatus.label,
        score: 0,
        summary: {
          ...setupSummary,
          weatherRows: 0,
          oddsRows: 0,
        },
        gates: setupGates,
        nextActions: [],
        topSignals: {},
        runBrief: buildPredictionPrepRunBrief(null, null, weatherScenarioFromOptions(options), setupGates, setupSummary, setupStatus, { ...options, marketFilter, minEdge }),
        runAudit: null,
        fieldReadiness: null
      };
    }

    const fieldRows = eventFieldPlayers(lab, event, options);
    const minFieldSize = Number.isFinite(Number(options.minFieldSize)) ? Math.max(1, Number(options.minFieldSize)) : 20;
    const playerLookup = new Map();
    lab.players.forEach((player) => {
      playerAliases(player).forEach((alias) => playerLookup.set(alias.toLowerCase(), player));
    });
    const eventIds = [event.id, event.eventId].map(cleanString).filter(Boolean);
    const course = courseForEvent(lab, event);
    const courseImported = lab.courses.some((row) =>
      row.id === event.courseId ||
      row.name === event.courseName ||
      row.id === course.id ||
      row.name === course.name
    );
    const setupRows = lab.courseSetups.filter((row) =>
      eventIds.includes(cleanString(row.eventId)) ||
      (course && (row.courseId === course.id || row.courseId === event.courseId))
    );
    const weatherRows = lab.weatherSnapshots.filter((row) => eventIds.includes(cleanString(row.eventId)));
    const oddsRows = lab.oddsSnapshots.filter((row) =>
      eventIds.includes(cleanString(row.eventId)) &&
      marketMatchesFilter(row.market, marketFilter)
    );
    const predictions = [...lab.predictionLedger, ...lab.modelPredictions].filter((row) =>
      eventIds.includes(cleanString(row.eventId)) &&
      marketMatchesFilter(row.market, marketFilter)
    );
    const predictionMap = new Map();
    predictions.forEach((row, index) => {
      const key = cleanString(row.id) || [row.eventId, row.playerId, row.market, row.createdAt, index].map(cleanString).join("|");
      predictionMap.set(key, row);
    });
    const uniquePredictions = [...predictionMap.values()];
    const pricedPredictions = uniquePredictions.filter((row) => Number.isFinite(numberOrNull(row.marketOddsAmerican)));
    const positiveEdges = uniquePredictions.filter((row) => {
      const edge = numberOrNull(row.edge);
      return Number.isFinite(edge) && edge > 0;
    });
    const thresholdEdges = uniquePredictions.filter((row) => {
      const edge = numberOrNull(row.edge);
      return Number.isFinite(edge) && edge >= minEdge;
    });
    const topEdge = thresholdEdges.length
      ? [...thresholdEdges].sort((a, b) => (numberOrNull(b.edge) || 0) - (numberOrNull(a.edge) || 0))[0]
      : positiveEdges.length
        ? [...positiveEdges].sort((a, b) => (numberOrNull(b.edge) || 0) - (numberOrNull(a.edge) || 0))[0]
        : null;
    const topEdgePlayer = topEdge
      ? playerLookup.get(cleanString(topEdge.playerId).toLowerCase()) || null
      : null;

    const fieldReadiness = typeof GolfLab.buildFieldReadinessBoard === "function"
      ? GolfLab.buildFieldReadinessBoard(lab, { eventId: event.id, market: marketFilter, limit: fieldRows.length || 1 })
      : null;
    const runAudit = buildPredictionRunAuditBoard(lab, { ...options, eventId: event.id, market: marketFilter, minEdge, now });
    const fitBoard = buildEventFitBoard(lab, { ...options, eventId: event.id, market: marketFilter, minEdge, createdAt: now });
    const courseCompBoard = typeof GolfLab.buildCourseCompBoard === "function"
      ? GolfLab.buildCourseCompBoard(lab, { eventId: event.id, courseLimit: 5, playerLimit: 5 })
      : null;
    const sourceRows = eventSourceFetchRows(lab, event);

    const fieldScore = Math.min(100, Math.round((fieldRows.length / minFieldSize) * 100));
    const readinessSummary = fieldReadiness && fieldReadiness.summary ? fieldReadiness.summary : {};
    const readinessRows = fieldReadiness && Array.isArray(fieldReadiness.allRows) ? fieldReadiness.allRows : [];
    const players = Number(readinessSummary.players) || fieldRows.length || 0;
    const matchedProfiles = Number(readinessSummary.matchedProfiles) || 0;
    const modelReadyPlayers = readinessRows.length
      ? readinessRows.filter((row) => {
        const counts = row && row.counts ? row.counts : {};
        const parts = row && row.parts ? row.parts : {};
        return (Number(counts.rounds) > 0 || Number(counts.strokesGainedRows) > 0) && Number(parts.form) >= 35;
      }).length
      : 0;
    const marketReadyPlayers = Number(readinessSummary.marketReady) || 0;
    const profileScore = players ? Math.round((matchedProfiles / players) * 100) : 0;
    const historyScore = players ? Math.round((modelReadyPlayers / players) * 100) : 0;
    const marketCoverageScore = uniquePredictions.length
      ? Math.round((pricedPredictions.length / uniquePredictions.length) * 100)
      : oddsRows.length && fieldRows.length
        ? Math.round((Math.min(oddsRows.length, fieldRows.length) / fieldRows.length) * 100)
        : 0;
    const modelCoverageScore = runAudit && runAudit.summary ? runAudit.summary.fieldCoveragePct || 0 : 0;
    const courseScore = (courseImported ? 55 : 0) +
      (setupRows.length ? 15 : 0) +
      (courseCompBoard && courseCompBoard.summary && courseCompBoard.summary.compRounds > 0 ? 30 : 0);
    const weatherScore = weatherRows.length ? 100 : 0;
    const sourceScore = sourceRows.length ? 100 : 0;
    const edgeScore = thresholdEdges.length ? 100 : positiveEdges.length ? 72 : pricedPredictions.length ? 50 : uniquePredictions.length ? 30 : 0;

    const gates = [
      prepGate("field", "Field", fieldScore, `${fieldRows.length}/${minFieldSize} active field rows`, "Import or refresh the official field list.", { critical: true, meta: { fieldCount: fieldRows.length, minFieldSize } }),
      prepGate("profiles", "Player Profiles", profileScore, `${matchedProfiles}/${players} field players matched`, "Fill profile IDs, names, countries, tours, and ranking metadata.", { critical: true, meta: { matchedProfiles, players } }),
      prepGate("history", "Player History", historyScore, `${modelReadyPlayers}/${players} model-ready players`, "Backfill rounds and strokes-gained history for field players.", { critical: true, meta: { modelReadyPlayers, players } }),
      prepGate("course", "Course Fit", courseScore, courseImported ? `${course.name || event.courseName || "Course"} imported` : "Course profile missing", "Import course profile, setup notes, and comp-course history.", { critical: true, meta: { courseImported, setupRows: setupRows.length, compRounds: courseCompBoard && courseCompBoard.summary ? courseCompBoard.summary.compRounds || 0 : 0 } }),
      prepGate("weather", "Weather", weatherScore, weatherRows.length ? `${weatherRows.length} event weather snapshots` : "No event weather snapshots", "Import forecast or observed weather snapshots before final model runs.", { meta: { weatherRows: weatherRows.length } }),
      prepGate("markets", "Markets", marketCoverageScore, `${pricedPredictions.length}/${uniquePredictions.length || fieldRows.length || 1} priced model rows`, "Import current odds for winner, placement, and make-cut markets.", { meta: { oddsRows: oddsRows.length, marketReadyPlayers } }),
      prepGate("model", "Model Run", modelCoverageScore, `${runAudit.summary.modeledFieldPlayers || 0}/${runAudit.summary.activeFieldCount || fieldRows.length || 0} field players modeled`, "Run the owned model after source-critical rows are filled.", { meta: { predictions: uniquePredictions.length, fieldCoveragePct: modelCoverageScore } }),
      prepGate("edge", "Bet Slate", edgeScore, thresholdEdges.length ? `${thresholdEdges.length} playable edges` : positiveEdges.length ? `${positiveEdges.length} positive edges below threshold` : "No playable edges yet", "Review best prices, stake caps, and model explainer before placing bets.", { meta: { positiveEdges: positiveEdges.length, thresholdEdges: thresholdEdges.length } }),
      prepGate("proof", "Source Proof", sourceScore, sourceRows.length ? `${sourceRows.length} event source ledger rows` : "No event source proof rows", "Add source_fetches rows with provider, fetchedAt, rowCount, and sourceUrl.", { critical: true, meta: { sourceRows: sourceRows.length } })
    ];
    const score = Math.round(avg(gates.map((gate) => gate.score)) || 0);
    const summary = {
      fieldCount: fieldRows.length,
      matchedProfiles,
      modelReadyPlayers,
      marketReadyPlayers,
      weatherRows: weatherRows.length,
      oddsRows: oddsRows.length,
      totalPredictions: uniquePredictions.length,
      pricedPredictions: pricedPredictions.length,
      positiveEdges: positiveEdges.length,
      thresholdEdges: thresholdEdges.length,
      blockers: gates.filter((gate) => gate.status === "blocked").length,
      criticalBlockers: gates.filter((gate) => gate.critical && gate.status === "blocked").length,
      readyGates: gates.filter((gate) => gate.status === "ready").length,
      gates: gates.length,
      fieldCoveragePct: modelCoverageScore,
      marketCoveragePct: marketCoverageScore,
      latestPredictionAt: runAudit.summary.latestPredictionAt || "",
      latestOddsAt: runAudit.summary.latestOddsAt || ""
    };
    const status = predictionPrepStatus(gates, summary, event);
    const runBrief = buildPredictionPrepRunBrief(event, course, weatherScenarioFromOptions(options), gates, summary, status, { ...options, marketFilter, minEdge });
    const nextActions = gates
      .filter((gate) => gate.status !== "ready")
      .sort((a, b) =>
        Number(b.critical) - Number(a.critical) ||
        a.score - b.score ||
        cleanString(a.label).localeCompare(cleanString(b.label))
      )
      .slice(0, 5);
    const bestMarket = runAudit.marketRows
      .filter((row) => row.predictedPlayers || row.oddsRows)
      .sort((a, b) =>
        b.thresholdEdges - a.thresholdEdges ||
        b.positiveEdges - a.positiveEdges ||
        b.pricedPct - a.pricedPct
      )[0] || null;
    return {
      generatedAt: now,
      event,
      course,
      marketFilter,
      minEdge,
      status: status.key,
      statusLabel: status.label,
      score,
      summary,
      gates,
      nextActions,
      runBrief,
      topSignals: {
        topFit: fitBoard.summary ? fitBoard.summary.topFit || null : null,
        topEdge: topEdge ? {
          playerId: topEdge.playerId,
          playerName: topEdgePlayer ? topEdgePlayer.name : cleanString(topEdge.playerName || topEdge.playerId),
          market: topEdge.market,
          edge: numberOrNull(topEdge.edge),
          probability: numberOrNull(topEdge.probability),
          marketOddsAmerican: numberOrNull(topEdge.marketOddsAmerican)
        } : null,
        bestMarket,
        topGap: nextActions[0] || null,
        strongestComp: courseCompBoard && courseCompBoard.summary ? courseCompBoard.summary.strongestComp || null : null
      },
      runAudit,
      fieldReadiness,
      courseCompBoard,
      fitBoard
    };
  }

  function calibrationBucket(row) {
    const probability = numberOrNull(row.probability);
    const pct = Number.isFinite(probability) ? probability * 100 : -1;
    if (pct < 0) return { key: "unknown", label: "No probability", order: 99 };
    if (pct < 10) return { key: "p00-p10", label: "0-10%", order: 0 };
    if (pct < 20) return { key: "p10-p20", label: "10-20%", order: 1 };
    if (pct < 40) return { key: "p20-p40", label: "20-40%", order: 2 };
    if (pct < 60) return { key: "p40-p60", label: "40-60%", order: 3 };
    if (pct < 80) return { key: "p60-p80", label: "60-80%", order: 4 };
    return { key: "p80-plus", label: "80%+", order: 5 };
  }

  function calibrationStatus(total, calibrationDelta, minSamples) {
    if (!total) return { key: "empty", label: "No results" };
    if (total < minSamples) return { key: "thin", label: "Thin" };
    if (!Number.isFinite(calibrationDelta)) return { key: "unknown", label: "Unknown" };
    if (Math.abs(calibrationDelta) <= 0.05) return { key: "calibrated", label: "Calibrated" };
    if (calibrationDelta > 0) return { key: "undercalled", label: "Undercalled" };
    return { key: "overcalled", label: "Overcalled" };
  }

  function summarizeCalibrationRows(rows, minSamples) {
    const settledRows = rows.filter((row) =>
      row &&
      row.settled &&
      typeof row.hit === "boolean" &&
      Number.isFinite(numberOrNull(row.probability))
    );
    const total = settledRows.length;
    const hits = settledRows.filter((row) => row.hit).length;
    const expectedHits = settledRows.reduce((sum, row) => sum + (numberOrNull(row.probability) || 0), 0);
    const avgProbability = total ? expectedHits / total : null;
    const hitRate = total ? hits / total : null;
    const calibrationDelta = Number.isFinite(hitRate) && Number.isFinite(avgProbability) ? hitRate - avgProbability : null;
    const brierScore = total
      ? avg(settledRows.map((row) => {
        const actual = row.hit ? 1 : 0;
        const probability = numberOrNull(row.probability) || 0;
        return (actual - probability) ** 2;
      }))
      : null;
    const betRows = settledRows.filter((row) => Number.isFinite(row.profitUnits));
    const profitUnits = betRows.reduce((sum, row) => sum + row.profitUnits, 0);
    const status = calibrationStatus(total, calibrationDelta, minSamples);
    return {
      total,
      hits,
      misses: total - hits,
      expectedHits,
      avgProbability,
      hitRate,
      calibrationDelta,
      calibrationError: Number.isFinite(calibrationDelta) ? Math.abs(calibrationDelta) : null,
      brierScore,
      bets: betRows.length,
      profitUnits,
      roi: betRows.length ? profitUnits / betRows.length : null,
      status: status.key,
      statusLabel: status.label
    };
  }

  function groupCalibrationRows(rows, keyFn, minSamples) {
    const groups = new Map();
    rows.forEach((row) => {
      const group = keyFn(row);
      const key = cleanString(group.key) || "unknown";
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: cleanString(group.label) || key,
          order: Number.isFinite(Number(group.order)) ? Number(group.order) : 99,
          rows: []
        });
      }
      groups.get(key).rows.push(row);
    });
    return [...groups.values()]
      .map((group) => ({ ...group, ...summarizeCalibrationRows(group.rows, minSamples) }))
      .sort((a, b) =>
        a.order - b.order ||
        b.total - a.total ||
        cleanString(a.label).localeCompare(cleanString(b.label))
      );
  }

  function buildModelCalibrationBoard(input, options = {}) {
    const minEdge = Number.isFinite(Number(options.minEdge)) ? Number(options.minEdge) : 0;
    const marketFilter = cleanString(options.market || options.marketFilter || "all");
    const minSamples = Number.isFinite(Number(options.minSamples)) ? Number(options.minSamples) : 5;
    const backtest = buildPredictionBacktest(input, { ...options, minEdge });
    const filtered = backtest.graded.filter((row) => marketMatchesFilter(row.market, marketFilter));
    const settled = filtered.filter((row) =>
      row.settled &&
      typeof row.hit === "boolean" &&
      Number.isFinite(numberOrNull(row.probability))
    );
    const summary = summarizeCalibrationRows(settled, minSamples);
    const probabilityBuckets = groupCalibrationRows(settled, calibrationBucket, minSamples);
    const marketRows = groupCalibrationRows(settled, (row) => ({
      key: normalizeMarketKey(row.market) || "market",
      label: marketDisplayLabel(row.market),
      order: { winner: 0, top10: 1, top20: 2, makecut: 3 }[normalizeMarketKey(row.market)] ?? 99
    }), minSamples);
    const edgeBuckets = groupCalibrationRows(settled, (row) => {
      const bucket = edgeBucket(row);
      const order = {
        "edge-5-plus": 0,
        "edge-2-5": 1,
        "edge-0-2": 2,
        negative: 3,
        unpriced: 4
      }[bucket.key] ?? 99;
      return { ...bucket, order };
    }, minSamples);
    const pending = filtered.length - settled.length;
    const alerts = [];
    if (!settled.length) {
      alerts.push({
        severity: "blocker",
        label: "Grade results",
        detail: "No settled predictions are available for calibration."
      });
    }
    if (pending > 0) {
      alerts.push({
        severity: "info",
        label: "Pending slate",
        detail: `${pending} prediction${pending === 1 ? "" : "s"} still need tournament results.`
      });
    }
    if (Number.isFinite(summary.calibrationError) && summary.calibrationError > 0.08) {
      alerts.push({
        severity: "warning",
        label: "Calibration drift",
        detail: `Actual hit rate is ${(summary.calibrationDelta || 0) > 0 ? "above" : "below"} model probability by ${Math.round(summary.calibrationError * 100)} points.`
      });
    }
    if (Number.isFinite(summary.brierScore) && summary.brierScore > 0.22) {
      alerts.push({
        severity: "warning",
        label: "Brier watch",
        detail: "Prediction errors are running high for the settled sample."
      });
    }
    return {
      marketFilter,
      minEdge,
      minSamples,
      summary: {
        ...summary,
        totalPredictions: filtered.length,
        settled: settled.length,
        pending
      },
      probabilityBuckets,
      marketRows,
      edgeBuckets,
      alerts,
      settledRows: settled
    };
  }

  function buildPredictionEdgeBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const minEdge = Number.isFinite(Number(options.minEdge)) ? Number(options.minEdge) : 0.01;
    const maxRows = Number.isFinite(Number(options.maxRows)) ? Number(options.maxRows) : 12;
    const marketFilter = cleanString(options.market || options.marketFilter || "all");
    const playerLookup = new Map();
    lab.players.forEach((player) => {
      playerAliases(player).forEach((alias) => playerLookup.set(alias.toLowerCase(), player));
    });
    const eventLookup = new Map(lab.events.map((event) => [event.id, event]));
    const predictionMap = new Map();
    [...lab.predictionLedger, ...lab.modelPredictions].forEach((prediction) => {
      if (!prediction || !prediction.id) return;
      predictionMap.set(prediction.id, prediction);
    });
    const candidates = [...predictionMap.values()]
      .filter((prediction) => marketMatchesFilter(prediction.market, marketFilter))
      .map((prediction) => {
      const probability = numberOrNull(prediction.probability);
      const edge = numberOrNull(prediction.edge);
      const odds = numberOrNull(prediction.marketOddsAmerican);
      const payout = profitForOdds(odds);
      if (!Number.isFinite(probability) || !Number.isFinite(edge) || !Number.isFinite(odds) || !Number.isFinite(payout)) return null;
      const stakeUnits = fractionalKellyUnits(probability, odds, prediction.confidence, options);
      const player = playerLookup.get(cleanString(prediction.playerId).toLowerCase()) || null;
      const event = eventLookup.get(prediction.eventId) || null;
      const valueScore = (edge * 100) + (numberOrNull(prediction.score) || 0) * 0.08 + confidenceMultiplier(prediction.confidence);
      return {
        ...prediction,
        eventName: event ? event.name || event.id : prediction.eventId,
        playerName: player ? player.name : prediction.playerId,
        impliedProbability: impliedProbability({ oddsAmerican: odds }),
        payout,
        stakeUnits,
        valueScore,
        playable: edge >= minEdge && Number.isFinite(stakeUnits) && stakeUnits > 0
      };
    }).filter(Boolean);
    const playable = candidates
      .filter((row) => row.playable)
      .sort((a, b) =>
        b.valueScore - a.valueScore ||
        b.edge - a.edge ||
        (a.rank || 999) - (b.rank || 999)
      )
      .slice(0, maxRows);
    const markets = playable.reduce((acc, row) => {
      const key = cleanString(row.market) || "market";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      candidates,
      playable,
      summary: {
        totalCandidates: candidates.length,
        playable: playable.length,
        totalStakeUnits: playable.reduce((sum, row) => sum + (numberOrNull(row.stakeUnits) || 0), 0),
        avgEdge: avg(playable.map((row) => numberOrNull(row.edge))),
        markets,
        marketFilter: marketFilter || "all",
        minEdge
      }
    };
  }

  function predictionVerdict(row, minEdge) {
    const edge = numberOrNull(row.edge);
    const marketOdds = numberOrNull(row.marketOddsAmerican);
    if (!Number.isFinite(marketOdds)) return "model-only";
    if (Number.isFinite(edge) && edge >= minEdge) return "play";
    if (Number.isFinite(edge) && edge > 0) return "lean";
    return "pass";
  }

  function expectedUnitReturn(probability, oddsAmerican) {
    const payout = profitForOdds(oddsAmerican);
    const p = numberOrNull(probability);
    if (!Number.isFinite(payout) || !Number.isFinite(p)) return null;
    return (p * payout) - (1 - p);
  }

  function portfolioExposureGroups(rows, keyFn) {
    const groups = new Map();
    rows.forEach((row) => {
      const group = keyFn(row);
      const key = cleanString(group.key) || "unknown";
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: cleanString(group.label) || key,
          rows: []
        });
      }
      groups.get(key).rows.push(row);
    });
    return [...groups.values()]
      .map((group) => {
        const stakeUnits = group.rows.reduce((sum, row) => sum + (numberOrNull(row.recommendedUnits) || 0), 0);
        const expectedProfitUnits = group.rows.reduce((sum, row) => sum + (numberOrNull(row.expectedProfitUnits) || 0), 0);
        return {
          ...group,
          bets: group.rows.length,
          stakeUnits,
          expectedProfitUnits,
          avgEdge: avg(group.rows.map((row) => numberOrNull(row.edge))),
          avgExpectedUnitReturn: avg(group.rows.map((row) => numberOrNull(row.expectedUnitReturn)))
        };
      })
      .sort((a, b) =>
        b.stakeUnits - a.stakeUnits ||
        b.expectedProfitUnits - a.expectedProfitUnits ||
        cleanString(a.label).localeCompare(cleanString(b.label))
      );
  }

  function buildBetPortfolioBoard(input, options = {}) {
    const minEdge = Number.isFinite(Number(options.minEdge)) ? Number(options.minEdge) : 0.01;
    const maxRows = Number.isFinite(Number(options.maxRows)) ? Number(options.maxRows) : 12;
    const candidateRows = Number.isFinite(Number(options.candidateRows)) ? Number(options.candidateRows) : 50;
    const maxTotalUnits = Number.isFinite(Number(options.maxTotalUnits)) ? Number(options.maxTotalUnits) : 8;
    const maxPlayerUnits = Number.isFinite(Number(options.maxPlayerUnits)) ? Number(options.maxPlayerUnits) : 2.5;
    const maxMarketUnits = Number.isFinite(Number(options.maxMarketUnits)) ? Number(options.maxMarketUnits) : 4;
    const maxEventUnits = Number.isFinite(Number(options.maxEventUnits)) ? Number(options.maxEventUnits) : 6;
    const minStakeUnits = Number.isFinite(Number(options.minStakeUnits)) ? Number(options.minStakeUnits) : 0.25;
    const edgeBoard = buildPredictionEdgeBoard(input, {
      ...options,
      minEdge,
      maxRows: candidateRows
    });
    const exposure = {
      total: 0,
      players: new Map(),
      markets: new Map(),
      events: new Map()
    };
    function room(map, key, cap) {
      return Math.max(0, cap - (map.get(key) || 0));
    }
    function add(map, key, units) {
      map.set(key, (map.get(key) || 0) + units);
    }
    const rows = edgeBoard.playable.slice(0, maxRows).map((row) => {
      const requestedUnits = numberOrNull(row.stakeUnits) || 0;
      const playerKey = cleanString(row.playerId || row.playerName) || "player";
      const marketKey = normalizeMarketKey(row.market) || "market";
      const eventKey = cleanString(row.eventId || row.eventName) || "event";
      const capRoom = Math.min(
        Math.max(0, maxTotalUnits - exposure.total),
        room(exposure.players, playerKey, maxPlayerUnits),
        room(exposure.markets, marketKey, maxMarketUnits),
        room(exposure.events, eventKey, maxEventUnits)
      );
      const rawUnits = Math.min(requestedUnits, capRoom);
      const recommendedUnits = rawUnits >= minStakeUnits ? Math.round(rawUnits * 100) / 100 : 0;
      const status = recommendedUnits <= 0
        ? "capped"
        : recommendedUnits + 0.01 < requestedUnits ? "trimmed" : "included";
      const expectedReturn = expectedUnitReturn(row.probability, row.marketOddsAmerican);
      const expectedProfit = Number.isFinite(expectedReturn) ? recommendedUnits * expectedReturn : null;
      const potentialProfit = Number.isFinite(row.payout) ? recommendedUnits * row.payout : null;
      if (recommendedUnits > 0) {
        exposure.total += recommendedUnits;
        add(exposure.players, playerKey, recommendedUnits);
        add(exposure.markets, marketKey, recommendedUnits);
        add(exposure.events, eventKey, recommendedUnits);
      }
      return {
        ...row,
        requestedUnits,
        recommendedUnits,
        status,
        statusLabel: status === "included" ? "Included" : status === "trimmed" ? "Trimmed" : "Capped",
        expectedUnitReturn: expectedReturn,
        expectedProfitUnits: expectedProfit,
        potentialProfitUnits: potentialProfit,
        capRoomBefore: capRoom
      };
    });
    const included = rows.filter((row) => row.recommendedUnits > 0);
    const warnings = [];
    if (!edgeBoard.candidates.length) {
      warnings.push({
        severity: "blocker",
        label: "Import odds",
        detail: "No priced model candidates are available for portfolio construction."
      });
    } else if (!edgeBoard.playable.length) {
      warnings.push({
        severity: "warning",
        label: "No plays",
        detail: "No edges clear the current threshold and staking rules."
      });
    }
    const capped = rows.filter((row) => row.status === "capped").length;
    const trimmed = rows.filter((row) => row.status === "trimmed").length;
    if (capped || trimmed) {
      warnings.push({
        severity: "info",
        label: "Risk caps",
        detail: `${trimmed} trimmed and ${capped} capped by unit limits.`
      });
    }
    if (exposure.total >= maxTotalUnits * 0.95 && maxTotalUnits > 0) {
      warnings.push({
        severity: "warning",
        label: "Budget full",
        detail: "The slate is using nearly all available portfolio units."
      });
    }
    const expectedProfitUnits = included.reduce((sum, row) => sum + (numberOrNull(row.expectedProfitUnits) || 0), 0);
    return {
      minEdge,
      marketFilter: edgeBoard.summary.marketFilter,
      caps: {
        maxTotalUnits,
        maxPlayerUnits,
        maxMarketUnits,
        maxEventUnits,
        minStakeUnits
      },
      summary: {
        candidates: edgeBoard.candidates.length,
        playable: edgeBoard.playable.length,
        included: included.length,
        trimmed,
        capped,
        requestedStakeUnits: rows.reduce((sum, row) => sum + (numberOrNull(row.requestedUnits) || 0), 0),
        totalStakeUnits: exposure.total,
        expectedProfitUnits,
        avgEdge: avg(included.map((row) => numberOrNull(row.edge))),
        avgExpectedUnitReturn: avg(included.map((row) => numberOrNull(row.expectedUnitReturn))),
        budgetUsedPct: maxTotalUnits ? exposure.total / maxTotalUnits : null
      },
      rows,
      included,
      warnings,
      groups: {
        markets: portfolioExposureGroups(included, (row) => ({ key: normalizeMarketKey(row.market), label: marketDisplayLabel(row.market) })),
        events: portfolioExposureGroups(included, (row) => ({ key: row.eventId || row.eventName, label: row.eventName || row.eventId })),
        confidence: portfolioExposureGroups(included, (row) => ({ key: marketSlug(row.confidence || "unlabeled"), label: cleanString(row.confidence) || "Unlabeled" }))
      },
      edgeBoard
    };
  }

  function featureContributions(row, weights) {
    return featureBreakdown(row).map((feature) => {
      const weight = numberOrNull(weights[feature.key]) || 0;
      const contribution = feature.value * weight;
      return {
        ...feature,
        weight,
        contribution,
        impact: contribution > 0 ? "positive" : contribution < 0 ? "negative" : "neutral"
      };
    });
  }

  function buildPredictionExplainerBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const minEdge = Number.isFinite(Number(options.minEdge)) ? Number(options.minEdge) : 0.01;
    const maxRows = Number.isFinite(Number(options.maxRows)) ? Number(options.maxRows) : 8;
    const marketFilter = cleanString(options.market || options.marketFilter || "all");
    const weights = normalizeWeights(options.weights);
    const playerLookup = new Map();
    lab.players.forEach((player) => {
      playerAliases(player).forEach((alias) => playerLookup.set(alias.toLowerCase(), player));
    });
    const eventLookup = new Map(lab.events.map((event) => [event.id, event]));
    const predictionMap = new Map();
    [...lab.predictionLedger, ...lab.modelPredictions].forEach((prediction) => {
      if (!prediction || !prediction.id) return;
      predictionMap.set(prediction.id, prediction);
    });
    const rows = [...predictionMap.values()]
      .filter((prediction) => marketMatchesFilter(prediction.market, marketFilter))
      .map((prediction) => {
        const player = playerLookup.get(cleanString(prediction.playerId).toLowerCase()) || null;
        const event = eventLookup.get(prediction.eventId) || null;
        const contributions = featureContributions(prediction, weights);
        const strengths = [...contributions]
          .filter((feature) => feature.contribution > 0)
          .sort((a, b) => b.contribution - a.contribution)
          .slice(0, 3);
        const concerns = [...contributions]
          .filter((feature) => feature.contribution < 0)
          .sort((a, b) => a.contribution - b.contribution)
          .slice(0, 2);
        const edge = numberOrNull(prediction.edge);
        const probability = numberOrNull(prediction.probability);
        const marketOddsAmerican = numberOrNull(prediction.marketOddsAmerican);
        const verdict = predictionVerdict(prediction, minEdge);
        return {
          ...prediction,
          playerName: player ? player.name : prediction.playerId,
          eventName: event ? event.name || event.id : prediction.eventId,
          eventStartDate: event ? event.startDate : "",
          probability,
          edge,
          marketOddsAmerican: Number.isFinite(marketOddsAmerican) ? marketOddsAmerican : null,
          verdict,
          expectedUnitReturn: expectedUnitReturn(probability, marketOddsAmerican),
          contributions,
          strengths,
          concerns,
          explanationScore: contributions.reduce((sum, feature) => sum + feature.contribution, 0),
          priced: Number.isFinite(marketOddsAmerican),
          thinSample: (numberOrNull(prediction.sampleRounds) || 0) < 8
        };
      })
      .sort((a, b) => {
        const verdictRank = { play: 0, lean: 1, "model-only": 2, pass: 3 };
        const byVerdict = (verdictRank[a.verdict] ?? 9) - (verdictRank[b.verdict] ?? 9);
        if (byVerdict) return byVerdict;
        const aEdge = Number.isFinite(a.edge) ? a.edge : -99;
        const bEdge = Number.isFinite(b.edge) ? b.edge : -99;
        return bEdge - aEdge || (a.rank || 999) - (b.rank || 999) || b.explanationScore - a.explanationScore;
      });
    return {
      minEdge,
      marketFilter,
      weights,
      summary: {
        predictions: rows.length,
        priced: rows.filter((row) => row.priced).length,
        plays: rows.filter((row) => row.verdict === "play").length,
        leans: rows.filter((row) => row.verdict === "lean").length,
        modelOnly: rows.filter((row) => row.verdict === "model-only").length,
        thinSamples: rows.filter((row) => row.thinSample).length,
        highConfidence: rows.filter((row) => cleanString(row.confidence).toLowerCase() === "high").length,
        topPlay: rows.find((row) => row.verdict === "play") || null,
        topModel: rows[0] || null,
        avgEdge: avg(rows.map((row) => row.edge)),
        avgExpectedUnitReturn: avg(rows.map((row) => row.expectedUnitReturn))
      },
      rows: rows.slice(0, maxRows),
      allRows: rows
    };
  }

  function featureBreakdown(row) {
    return MODEL_FEATURES.map((feature) => ({
      ...feature,
      value: numberOrNull(row[feature.key]) || 0
    }));
  }

  function latestModelRunForEvent(predictions, eventId) {
    const grouped = predictions.reduce((groups, prediction) => {
      if (!prediction || prediction.eventId !== eventId) return groups;
      const runId = predictionRunId(prediction);
      if (!groups.has(runId)) {
        groups.set(runId, {
          modelRunId: runId,
          rows: [],
          latestAt: "",
          createdAt: cleanString(prediction.createdAt || prediction.sourceUpdatedAt)
        });
      }
      const group = groups.get(runId);
      group.rows.push(prediction);
      group.latestAt = latestString([group.latestAt, prediction.createdAt, prediction.sourceUpdatedAt, prediction.fetchedAt]);
      return groups;
    }, new Map());
    return [...grouped.values()].sort((a, b) =>
      cleanString(b.latestAt || b.createdAt).localeCompare(cleanString(a.latestAt || a.createdAt)) ||
      cleanString(b.modelRunId).localeCompare(cleanString(a.modelRunId))
    )[0] || null;
  }

  function formatProjectedPosition(position) {
    const numeric = Number(position);
    if (!Number.isFinite(numeric)) return "--";
    return numeric === 1 ? "1" : `T${Math.max(1, Math.round(numeric))}`;
  }

  function projectedConfidenceLabel(row) {
    const sample = numberOrNull(row.sampleRounds) || 0;
    const confidence = cleanString(row.confidence).toLowerCase();
    if (confidence === "thin sample" || sample < 8) return { key: "thin", label: "Thin" };
    if (confidence === "medium" || sample < 20) return { key: "medium", label: "Medium" };
    return { key: "high", label: "High" };
  }

  function featurePlainText(feature) {
    const value = numberOrNull(feature.value) || 0;
    const label = cleanString(feature.label);
    if (feature.key === "skill") return value >= 0 ? "overall skill profile is a plus" : "baseline skill profile is dragging";
    if (feature.key === "recentForm") return value >= 0 ? "recent scoring form is helping" : "recent form is a concern";
    if (feature.key === "courseFit") return value >= 0 ? "course fit grades positively" : "course history is not a clean fit";
    if (feature.key === "difficultyFit") return value >= 0 ? "tough-course history travels" : "hard-course results are a risk";
    if (feature.key === "weatherFit") return value >= 0 ? "weather fit is favorable" : "weather history is a concern";
    if (feature.key === "liveState") return value >= 0 ? "live leaderboard position is carrying weight" : "current position leaves work to do";
    return value >= 0 ? `${label} is positive` : `${label} is negative`;
  }

  function projectedReasoning(row, weights) {
    const contributions = featureContributions(row, weights);
    const positives = contributions
      .filter((feature) => feature.contribution > 0.02)
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3);
    const negatives = contributions
      .filter((feature) => feature.contribution < -0.02)
      .sort((a, b) => a.contribution - b.contribution)
      .slice(0, 2);
    const why = [];
    if (Number.isFinite(numberOrNull(row.livePosition))) {
      const strokesBack = numberOrNull(row.liveStrokesBack);
      if (Number.isFinite(strokesBack) && strokesBack <= 0) {
        why.push(`Starts from the lead at ${numberOrNull(row.liveToPar) || 0} to par.`);
      } else if (Number.isFinite(strokesBack) && strokesBack <= 4) {
        why.push(`Already within ${strokesBack} of the lead, so the model does not need a huge chase.`);
      } else {
        why.push(`Current leaderboard position creates a ${Number.isFinite(strokesBack) ? `${strokesBack}-shot` : "meaningful"} chase.`);
      }
    }
    positives.forEach((feature) => {
      why.push(`The ${feature.label.toLowerCase()} input helps because ${featurePlainText(feature)}.`);
    });
    if (!why.length) {
      why.push("Projection is mostly model-rank driven because no single feature is dominating.");
    }
    const risks = [];
    negatives.forEach((feature) => {
      risks.push(`The ${feature.label.toLowerCase()} input is the main caution because ${featurePlainText(feature)}.`);
    });
    if ((numberOrNull(row.sampleRounds) || 0) < 8) {
      risks.push("The player sample is thin, so this needs extra humility.");
    }
    if (!risks.length && !Number.isFinite(numberOrNull(row.marketOddsAmerican))) {
      risks.push("No current market price is attached, so treat this as a pure projection.");
    }
    if (!risks.length) {
      risks.push("No major feature flag is fighting the projection.");
    }
    return {
      why: why.slice(0, 3),
      risks: risks.slice(0, 2),
      contributions
    };
  }

  function buildProjectedStandingsBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const event = selectModelEvent(lab, options);
    const maxRows = Number.isFinite(Number(options.maxRows)) ? Number(options.maxRows) : 20;
    const weights = normalizeWeights(options.weights);
    const emptySummary = {
      players: 0,
      projectedCutLine: null,
      liveRounds: 0,
      liveLeaderToPar: null,
      pricedRows: 0,
      modelRunId: "",
      generatedAt: ""
    };
    if (!event) {
      return {
        event: null,
        selectedEvent: null,
        modelRunId: "",
        weights,
        summary: emptySummary,
        rows: [],
        allRows: [],
        warnings: ["Import or select a tournament before building projected standings."]
      };
    }
    const eventId = cleanString(event.id || event.eventId);
    const predictionMap = new Map();
    [...lab.predictionLedger, ...lab.modelPredictions].forEach((prediction, index) => {
      if (!prediction || cleanString(prediction.eventId) !== eventId) return;
      const key = cleanString(prediction.id) || [
        prediction.eventId,
        prediction.playerId,
        prediction.market,
        prediction.modelRunId,
        prediction.createdAt,
        index
      ].map(cleanString).join("|");
      predictionMap.set(key, prediction);
    });
    const run = latestModelRunForEvent([...predictionMap.values()], eventId);
    if (!run) {
      return {
        event,
        selectedEvent: event,
        modelRunId: "",
        weights,
        summary: emptySummary,
        rows: [],
        allRows: [],
        warnings: ["Run the owned model before building projected standings."]
      };
    }

    const playerLookup = new Map();
    lab.players.forEach((player) => {
      playerAliases(player).forEach((alias) => playerLookup.set(alias.toLowerCase(), player));
    });
    const winnerRows = run.rows
      .filter((row) => normalizeMarketKey(row.market) === "winner")
      .map((row) => ({ ...row }))
      .filter((row) => cleanString(row.playerId));
    const scores = winnerRows.map((row) => numberOrNull(row.score)).filter(Number.isFinite);
    const meanScore = avg(scores) || 0;
    const variance = scores.length
      ? scores.reduce((sum, value) => sum + ((value - meanScore) ** 2), 0) / scores.length
      : 1;
    const stdScore = Math.sqrt(variance) || 1;
    const liveRounds = Math.max(0, ...winnerRows.map((row) => numberOrNull(row.liveRounds) || 0));
    const liveLeaderToPar = winnerRows
      .map((row) => numberOrNull(row.liveToPar))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    const hasLive = Number.isFinite(liveLeaderToPar) && liveRounds > 0;
    const remainingRounds = Math.max(0, 4 - liveRounds);
    const allRows = winnerRows.map((row) => {
      const score = numberOrNull(row.score) || 0;
      const zScore = (score - meanScore) / stdScore;
      const liveToPar = numberOrNull(row.liveToPar);
      const livePosition = numberOrNull(row.livePosition);
      const liveStrokesBack = numberOrNull(row.liveStrokesBack);
      const baseToPar = hasLive && Number.isFinite(liveToPar)
        ? liveToPar
        : Number.isFinite(liveStrokesBack) && Number.isFinite(liveLeaderToPar)
          ? liveLeaderToPar + liveStrokesBack
          : null;
      const projectedMove = hasLive
        ? -(zScore * remainingRounds * 0.95)
        : -(zScore * 3.2);
      const projectedToPar = Number.isFinite(baseToPar)
        ? Number((baseToPar + projectedMove).toFixed(1))
        : null;
      const confidence = projectedConfidenceLabel(row);
      const player = playerLookup.get(cleanString(row.playerId).toLowerCase()) || null;
      const reasoning = projectedReasoning(row, weights);
      return {
        ...row,
        playerName: player ? player.name : cleanString(row.playerName || row.playerId),
        country: player ? player.country || "" : "",
        projectedToPar,
        projectedMove: Number(projectedMove.toFixed(1)),
        projectedScore: Number((hasLive && Number.isFinite(projectedToPar) ? -projectedToPar : score).toFixed(3)),
        livePosition: Number.isFinite(livePosition) ? livePosition : null,
        liveToPar: Number.isFinite(liveToPar) ? liveToPar : null,
        liveStrokesBack: Number.isFinite(liveStrokesBack) ? liveStrokesBack : null,
        probability: numberOrNull(row.probability),
        fairOddsAmerican: numberOrNull(row.fairOddsAmerican),
        marketOddsAmerican: numberOrNull(row.marketOddsAmerican),
        edge: numberOrNull(row.edge),
        sampleRounds: numberOrNull(row.sampleRounds) || 0,
        confidenceKey: confidence.key,
        confidenceLabel: confidence.label,
        plainEnglish: reasoning.why,
        riskFlags: reasoning.risks,
        contributions: reasoning.contributions
      };
    }).sort((a, b) => {
      if (Number.isFinite(a.projectedToPar) && Number.isFinite(b.projectedToPar)) {
        return a.projectedToPar - b.projectedToPar || (a.rank || 999) - (b.rank || 999);
      }
      return (a.rank || 999) - (b.rank || 999);
    });
    let lastValue = null;
    let lastPosition = 0;
    allRows.forEach((row, index) => {
      const value = Number.isFinite(row.projectedToPar) ? row.projectedToPar : row.rank;
      if (lastValue === null || value !== lastValue) {
        lastValue = value;
        lastPosition = index + 1;
      }
      row.projectedPosition = lastPosition;
      row.projectedPositionLabel = formatProjectedPosition(lastPosition);
    });
    const cutCandidates = allRows
      .filter((row) => Number.isFinite(row.projectedToPar))
      .slice(0, Math.min(65, allRows.length));
    const projectedCutLine = cutCandidates.length ? cutCandidates[cutCandidates.length - 1].projectedToPar : null;
    return {
      event,
      selectedEvent: event,
      modelRunId: run.modelRunId,
      weights,
      summary: {
        players: allRows.length,
        projectedCutLine,
        liveRounds,
        liveLeaderToPar: Number.isFinite(liveLeaderToPar) ? liveLeaderToPar : null,
        pricedRows: allRows.filter((row) => Number.isFinite(row.marketOddsAmerican)).length,
        modelRunId: run.modelRunId,
        generatedAt: run.latestAt || run.createdAt || ""
      },
      rows: allRows.slice(0, maxRows),
      allRows,
      warnings: []
    };
  }

  function formatResultPosition(position) {
    const numeric = Number(position);
    if (!Number.isFinite(numeric)) return "--";
    return numeric === 1 ? "1" : `T${Math.max(1, Math.round(numeric))}`;
  }

  function formatResultScore(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "";
    if (numeric === 0) return "even par";
    return numeric < 0 ? `${Math.abs(numeric)} under` : `${numeric} over`;
  }

  function predictionResultMarketOutcome(prediction, standing, eventComplete, minEdge) {
    const hit = standing && eventComplete ? predictionHit(prediction, standing) : null;
    const edge = numberOrNull(prediction.edge);
    const odds = numberOrNull(prediction.marketOddsAmerican);
    const payout = profitForOdds(odds);
    const qualifies = !Number.isFinite(minEdge) || !Number.isFinite(edge) || edge >= minEdge;
    const profitUnits = hit === null || !qualifies || !Number.isFinite(payout)
      ? null
      : hit ? payout : -1;
    return {
      market: prediction.market,
      marketLabel: marketDisplayLabel(prediction.market),
      probability: numberOrNull(prediction.probability),
      edge,
      marketOddsAmerican: Number.isFinite(odds) ? odds : null,
      hit,
      status: hit === null ? "pending" : hit ? "hit" : "miss",
      statusLabel: hit === null ? "Pending" : hit ? "Hit" : "Miss",
      profitUnits
    };
  }

  function predictionResultOutcome(primary, standing, eventComplete, marketOutcomes) {
    if (!standing) return { key: "pending", label: "Needs Result" };
    if (!eventComplete) return { key: "live", label: "Live Read" };
    const modelRank = numberOrNull(primary.rank);
    const actualPosition = numberOrNull(standing.position);
    if (!Number.isFinite(modelRank) || !Number.isFinite(actualPosition)) {
      return { key: "settled", label: "Settled" };
    }
    const rankDelta = actualPosition - modelRank;
    const settledMarkets = marketOutcomes.filter((row) => row.hit === true || row.hit === false);
    const hitMarkets = settledMarkets.filter((row) => row.hit).length;
    if (actualPosition === 1 && modelRank === 1) return { key: "nailed", label: "Nailed" };
    if ((modelRank > 20 && actualPosition <= 10) || (modelRank > 35 && actualPosition <= 20)) {
      return { key: "undercalled", label: "Undercalled" };
    }
    if ((modelRank <= 10 && actualPosition <= 10) || (modelRank <= 20 && actualPosition <= 20) || Math.abs(rankDelta) <= 5) {
      return { key: "worked", label: "Worked" };
    }
    if ((hitMarkets && Math.abs(rankDelta) <= 14) || Math.abs(rankDelta) <= 12) {
      return { key: "partial", label: "Mostly Right" };
    }
    return { key: "missed", label: "Missed" };
  }

  function predictionResultAccuracy(primary, standing, eventComplete, marketOutcomes) {
    if (!standing || !eventComplete) return null;
    const modelRank = numberOrNull(primary.rank);
    const actualPosition = numberOrNull(standing.position);
    if (!Number.isFinite(modelRank) || !Number.isFinite(actualPosition)) return null;
    const rankError = Math.abs(actualPosition - modelRank);
    const settledMarkets = marketOutcomes.filter((row) => row.hit === true || row.hit === false);
    const marketBonus = settledMarkets.reduce((sum, row) => sum + (row.hit ? 4 : -2), 0);
    return Math.round(clamp(100 - (rankError * 3) + marketBonus, 0, 100));
  }

  function predictionResultPlainEnglish(row, standing, eventComplete, outcome, marketOutcomes, contributions) {
    const modelRank = numberOrNull(row.rank);
    const actualPosition = standing ? numberOrNull(standing.position) : null;
    const rankDelta = Number.isFinite(modelRank) && Number.isFinite(actualPosition) ? actualPosition - modelRank : null;
    const finishLabel = standing
      ? `${formatResultPosition(standing.position)}${formatResultScore(standing.total) ? ` at ${formatResultScore(standing.total)}` : ""}`
      : "no imported finish";
    const positive = [...contributions]
      .filter((feature) => feature.contribution > 0.02)
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 2);
    const negative = [...contributions]
      .filter((feature) => feature.contribution < -0.02)
      .sort((a, b) => a.contribution - b.contribution)
      .slice(0, 2);
    const hitMarkets = marketOutcomes.filter((market) => market.hit).map((market) => market.marketLabel);
    const missedMarkets = marketOutcomes.filter((market) => market.hit === false).map((market) => market.marketLabel);
    const why = [];
    const lesson = [];
    if (!standing) {
      why.push("No tournament result is attached yet, so this player stays ungraded.");
      lesson.push("Import final scoring before judging the model read.");
    } else if (!eventComplete) {
      why.push(`This is a live read: the model ranked him No. ${Number.isFinite(modelRank) ? Math.round(modelRank) : "--"} and he is currently ${finishLabel}.`);
      lesson.push("Wait for the final round before treating this as a win or miss.");
    } else if (outcome.key === "nailed") {
      why.push(`The model called the winner correctly: ranked No. 1 and finished ${finishLabel}.`);
      if (positive.length) why.push(`The strongest support was ${positive.map((feature) => feature.label.toLowerCase()).join(" and ")}.`);
      lesson.push("This is the kind of result to preserve when tuning the model weights.");
    } else if (outcome.key === "worked") {
      why.push(`The model direction was right: ranked No. ${Math.round(modelRank)} and finished ${finishLabel}.`);
      if (hitMarkets.length) why.push(`${hitMarkets.slice(0, 2).join(" and ")} also graded as a hit.`);
      if (positive.length) why.push(`The main drivers were ${positive.map((feature) => featurePlainText(feature)).join(" and ")}.`);
      lesson.push(`Keep trusting the ${positive[0] ? positive[0].label.toLowerCase() : "core"} signal in similar tournament setups.`);
    } else if (outcome.key === "partial") {
      why.push(`The result was in the neighborhood: ranked No. ${Math.round(modelRank)} and finished ${finishLabel}.`);
      if (hitMarkets.length) why.push(`${hitMarkets.slice(0, 2).join(" and ")} still landed, even if the exact finish was not perfect.`);
      lesson.push("Treat this as useful directionally, but keep refining finish-position precision.");
    } else if (outcome.key === "undercalled") {
      why.push(`He beat the model by ${Math.abs(Math.round(rankDelta || 0))} spots, finishing ${finishLabel} after a No. ${Math.round(modelRank)} model rank.`);
      if (negative.length) why.push(`The model was probably too cautious on ${negative.map((feature) => feature.label.toLowerCase()).join(" and ")}.`);
      if (positive.length && !negative.length) why.push(`There were positives in ${positive.map((feature) => feature.label.toLowerCase()).join(" and ")}, but not enough weight to push him up the board.`);
      lesson.push("Review whether the model is suppressing this player type too aggressively.");
    } else if (outcome.key === "missed") {
      why.push(`The model missed high: ranked No. ${Math.round(modelRank)} but finished ${finishLabel}.`);
      if (missedMarkets.length) why.push(`${missedMarkets.slice(0, 2).join(" and ")} failed from this forecast.`);
      if (positive.length) why.push(`The model trusted ${positive.map((feature) => feature.label.toLowerCase()).join(" and ")}, but those signals did not turn into scoring.`);
      if (negative.length) lesson.push(`The warning signs in ${negative.map((feature) => feature.label.toLowerCase()).join(" and ")} deserve more attention next time.`);
      if (!negative.length) lesson.push("This is a cleaner model miss, so it belongs in the tuning sample.");
    } else {
      why.push(`The player finished ${finishLabel} from a No. ${Number.isFinite(modelRank) ? Math.round(modelRank) : "--"} model rank.`);
      lesson.push("Result is settled, but the model signal was not decisive enough for a stronger label.");
    }
    if ((numberOrNull(row.sampleRounds) || 0) < 8) {
      lesson.push("Sample size was thin, so keep the read humble.");
    }
    return {
      why: why.slice(0, 3),
      lessons: lesson.slice(0, 2)
    };
  }

  function buildPredictionResultsSummaryBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const event = selectModelEvent(lab, options);
    const maxRows = Number.isFinite(Number(options.maxRows)) ? Number(options.maxRows) : 16;
    const weights = normalizeWeights(options.weights);
    const minEdge = Number.isFinite(Number(options.minEdge)) ? Number(options.minEdge) : null;
    if (!event) {
      return {
        event: null,
        selectedEvent: null,
        modelRunId: "",
        rows: [],
        allRows: [],
        summary: {
          players: 0,
          settledPlayers: 0,
          livePlayers: 0,
          rightReads: 0,
          misses: 0,
          undercalled: 0,
          avgRankError: null,
          avgAccuracyScore: null,
          profitUnits: 0,
          topResult: null,
          biggestMiss: null
        },
        warnings: ["Select or import a tournament before building a results summary."]
      };
    }
    const eventId = cleanString(event.id || event.eventId);
    const predictionMap = new Map();
    [...lab.predictionLedger, ...lab.modelPredictions].forEach((prediction, index) => {
      if (!prediction || cleanString(prediction.eventId) !== eventId) return;
      const key = cleanString(prediction.id) || [
        prediction.eventId,
        prediction.playerId,
        prediction.market,
        prediction.modelRunId,
        prediction.createdAt,
        index
      ].map(cleanString).join("|");
      predictionMap.set(key, prediction);
    });
    const run = latestModelRunForEvent([...predictionMap.values()], eventId);
    if (!run) {
      return {
        event,
        selectedEvent: event,
        modelRunId: "",
        rows: [],
        allRows: [],
        summary: {
          players: 0,
          settledPlayers: 0,
          livePlayers: 0,
          rightReads: 0,
          misses: 0,
          undercalled: 0,
          avgRankError: null,
          avgAccuracyScore: null,
          profitUnits: 0,
          topResult: null,
          biggestMiss: null
        },
        warnings: ["Run the owned model before reviewing results."]
      };
    }
    const standings = buildEventStandings(lab, eventId);
    const maxCompletedRounds = standings.reduce((max, row) => Math.max(max, numberOrNull(row.rounds) || 0), 0);
    const finalRoundCount = Number.isFinite(Number(options.finalRoundCount)) ? Number(options.finalRoundCount) : 4;
    const eventComplete = maxCompletedRounds >= finalRoundCount;
    const standingsByPlayer = new Map();
    standings.forEach((standing) => {
      [standing.playerId, standing.playerName].map(cleanString).filter(Boolean).forEach((key) => {
        standingsByPlayer.set(key.toLowerCase(), standing);
      });
    });
    const playerLookup = new Map();
    lab.players.forEach((player) => {
      playerAliases(player).forEach((alias) => playerLookup.set(alias.toLowerCase(), player));
    });
    const grouped = new Map();
    run.rows.forEach((prediction) => {
      const playerId = cleanString(prediction.playerId);
      if (!playerId) return;
      if (!grouped.has(playerId)) grouped.set(playerId, []);
      grouped.get(playerId).push(prediction);
    });
    const allRows = [...grouped.entries()].map(([playerId, predictions]) => {
      const primary = predictions.find((prediction) => normalizeMarketKey(prediction.market) === "winner") || predictions[0] || {};
      const player = playerLookup.get(playerId.toLowerCase()) || playerLookup.get(cleanString(primary.playerName).toLowerCase()) || null;
      const aliases = player ? playerAliases(player) : [playerId, primary.playerName];
      const standing = aliases
        .map((alias) => standingsByPlayer.get(cleanString(alias).toLowerCase()))
        .find(Boolean) || null;
      const marketOutcomes = predictions
        .sort((a, b) => {
          const order = { winner: 0, top10: 1, top20: 2, makecut: 3 };
          return (order[normalizeMarketKey(a.market)] ?? 9) - (order[normalizeMarketKey(b.market)] ?? 9);
        })
        .map((prediction) => predictionResultMarketOutcome(prediction, standing, eventComplete, minEdge));
      const outcome = predictionResultOutcome(primary, standing, eventComplete, marketOutcomes);
      const contributions = featureContributions(primary, weights);
      const plain = predictionResultPlainEnglish(primary, standing, eventComplete, outcome, marketOutcomes, contributions);
      const actualPosition = standing ? numberOrNull(standing.position) : null;
      const modelRank = numberOrNull(primary.rank);
      const rankDelta = Number.isFinite(modelRank) && Number.isFinite(actualPosition) ? actualPosition - modelRank : null;
      const accuracyScore = predictionResultAccuracy(primary, standing, eventComplete, marketOutcomes);
      const profitUnits = marketOutcomes
        .filter((market) => Number.isFinite(market.profitUnits))
        .reduce((sum, market) => sum + market.profitUnits, 0);
      return {
        playerId,
        playerName: player ? player.name : cleanString(primary.playerName || playerId),
        country: player ? player.country || "" : "",
        eventId,
        eventName: event.name || eventId,
        courseName: event.courseName || "",
        modelRunId: run.modelRunId,
        modelRank: Number.isFinite(modelRank) ? modelRank : null,
        winProbability: numberOrNull(primary.probability),
        marketOddsAmerican: numberOrNull(primary.marketOddsAmerican),
        edge: numberOrNull(primary.edge),
        score: numberOrNull(primary.score),
        sampleRounds: numberOrNull(primary.sampleRounds) || 0,
        confidence: cleanString(primary.confidence),
        actualPosition: Number.isFinite(actualPosition) ? actualPosition : null,
        actualPositionLabel: standing ? formatResultPosition(standing.position) : "--",
        actualToPar: standing ? numberOrNull(standing.total) : null,
        roundsCompleted: standing ? numberOrNull(standing.rounds) || 0 : 0,
        eventComplete,
        rankDelta: Number.isFinite(rankDelta) ? rankDelta : null,
        rankError: Number.isFinite(rankDelta) ? Math.abs(rankDelta) : null,
        outcome: outcome.key,
        outcomeLabel: outcome.label,
        accuracyScore,
        marketOutcomes,
        marketHits: marketOutcomes.filter((market) => market.hit).length,
        marketMisses: marketOutcomes.filter((market) => market.hit === false).length,
        profitUnits,
        plainEnglish: plain.why,
        lessons: plain.lessons,
        contributions
      };
    });
    const outcomeOrder = { missed: 0, undercalled: 1, nailed: 2, worked: 3, partial: 4, live: 5, pending: 6, settled: 7 };
    allRows.sort((a, b) =>
      (outcomeOrder[a.outcome] ?? 9) - (outcomeOrder[b.outcome] ?? 9) ||
      (Number.isFinite(b.rankError) ? b.rankError : -1) - (Number.isFinite(a.rankError) ? a.rankError : -1) ||
      (a.modelRank || 999) - (b.modelRank || 999) ||
      cleanString(a.playerName).localeCompare(cleanString(b.playerName))
    );
    const settledRows = allRows.filter((row) => row.eventComplete && Number.isFinite(row.actualPosition));
    const rightRows = settledRows.filter((row) => row.outcome === "nailed" || row.outcome === "worked" || row.outcome === "partial");
    const missRows = settledRows.filter((row) => row.outcome === "missed");
    const undercalledRows = settledRows.filter((row) => row.outcome === "undercalled");
    const accuracyScores = settledRows.map((row) => row.accuracyScore).filter(Number.isFinite);
    const rankErrors = settledRows.map((row) => row.rankError).filter(Number.isFinite);
    const topResult = [...settledRows]
      .filter((row) => row.outcome === "nailed" || row.outcome === "worked")
      .sort((a, b) =>
        (Number.isFinite(b.accuracyScore) ? b.accuracyScore : -1) - (Number.isFinite(a.accuracyScore) ? a.accuracyScore : -1) ||
        (a.modelRank || 999) - (b.modelRank || 999)
      )[0] || null;
    const biggestMiss = [...settledRows]
      .filter((row) => row.outcome === "missed" || row.outcome === "undercalled")
      .sort((a, b) =>
        (Number.isFinite(b.rankError) ? b.rankError : -1) - (Number.isFinite(a.rankError) ? a.rankError : -1) ||
        (a.modelRank || 999) - (b.modelRank || 999)
      )[0] || null;
    return {
      event,
      selectedEvent: event,
      modelRunId: run.modelRunId,
      eventComplete,
      weights,
      rows: allRows.slice(0, maxRows),
      allRows,
      summary: {
        players: allRows.length,
        settledPlayers: settledRows.length,
        livePlayers: allRows.filter((row) => !row.eventComplete && Number.isFinite(row.actualPosition)).length,
        pendingPlayers: allRows.filter((row) => !Number.isFinite(row.actualPosition)).length,
        rightReads: rightRows.length,
        misses: missRows.length,
        undercalled: undercalledRows.length,
        avgRankError: avg(rankErrors),
        avgAccuracyScore: avg(accuracyScores),
        profitUnits: allRows.reduce((sum, row) => sum + (Number.isFinite(row.profitUnits) ? row.profitUnits : 0), 0),
        hitRate: settledRows.length ? rightRows.length / settledRows.length : null,
        completedRounds: maxCompletedRounds,
        modelRunId: run.modelRunId,
        topResult,
        biggestMiss
      },
      warnings: standings.length ? [] : ["Import tournament scoring before reviewing model results."]
    };
  }

  function modelFitReasons(row) {
    const features = featureBreakdown(row);
    const positives = features
      .filter((feature) => feature.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3);
    const concerns = features
      .filter((feature) => feature.value < 0)
      .sort((a, b) => a.value - b.value)
      .slice(0, 2);
    return {
      strengths: positives.length ? positives : features.sort((a, b) => b.value - a.value).slice(0, 2),
      concerns
    };
  }

  function normalizeConsensusProfiles(options = {}) {
    const rawProfiles = Array.isArray(options.profiles) && options.profiles.length
      ? options.profiles
      : DEFAULT_CONSENSUS_PROFILES;
    const seen = new Set();
    return rawProfiles.map((profile, index) => {
      const raw = typeof profile === "string" ? { key: profile, label: profile } : (profile || {});
      const key = marketSlug(raw.key || raw.value || raw.id || raw.label || raw.name || `profile-${index + 1}`) || `profile-${index + 1}`;
      const label = cleanString(raw.label || raw.name || raw.value || raw.key || `Profile ${index + 1}`) || `Profile ${index + 1}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        key,
        label,
        note: cleanString(raw.note),
        weights: normalizeWeights(raw.weights)
      };
    }).filter(Boolean);
  }

  function consensusVerdict(row) {
    if (row.contenderProfiles >= Math.max(2, Math.ceil(row.profileCount * 0.8)) && row.rankRange <= 5) {
      return { key: "core", label: "Consensus core" };
    }
    if (row.contenderProfiles >= Math.max(2, Math.ceil(row.profileCount * 0.6)) && row.rankRange <= 8) {
      return { key: "stable", label: "Stable lean" };
    }
    if (row.bestRank <= 3 && (row.rankRange >= 10 || row.probabilityRange >= 0.05)) {
      return { key: "sensitive", label: "Profile sensitive" };
    }
    if (row.pricedProfiles > 0 && row.positiveEdgeProfiles >= Math.ceil(row.pricedProfiles * 0.75) && row.avgEdge > 0) {
      return { key: "market", label: "Market agreement" };
    }
    return { key: "watch", label: "Watch list" };
  }

  function buildModelConsensusBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const profiles = normalizeConsensusProfiles(options);
    const marketFilter = cleanString(options.market || options.marketFilter || "winner") || "winner";
    const maxRows = Number.isFinite(Number(options.maxRows || options.limit)) ? Number(options.maxRows || options.limit) : 10;
    const contenderCutoff = Number.isFinite(Number(options.contenderCutoff || options.topRankCutoff))
      ? Math.max(1, Number(options.contenderCutoff || options.topRankCutoff))
      : 10;
    const snapshots = profiles.map((profile) => buildOwnedModelSnapshot(lab, {
      ...options,
      weights: profile.weights,
      modelProfile: profile.label,
      createdAt: cleanString(options.createdAt) || `consensus-${profile.key}`
    }));
    const firstSnapshot = snapshots.find((snapshot) => snapshot.event) || snapshots[0] || null;
    if (!firstSnapshot || !firstSnapshot.event) {
      return {
        event: null,
        course: null,
        weather: null,
        weatherScenario: weatherScenarioFromOptions(options),
        marketFilter,
        profiles,
        rows: [],
        allRows: [],
        warnings: firstSnapshot ? firstSnapshot.warnings : ["No model profiles available."],
        summary: {
          profiles: profiles.length,
          players: 0,
          markets: 0,
          contenderCutoff,
          consensusCores: 0,
          profileSensitive: 0,
          pricedRows: 0,
          topConsensus: null
        }
      };
    }

    const playerById = new Map(lab.players.map((player) => [cleanString(player.id), player]));
    const groups = new Map();
    snapshots.forEach((snapshot, index) => {
      const profile = profiles[index];
      if (!snapshot || !snapshot.event || !profile) return;
      snapshot.predictions
        .filter((prediction) => marketMatchesFilter(prediction.market, marketFilter))
        .forEach((prediction) => {
          const marketKey = normalizeMarketKey(prediction.market);
          const playerId = cleanString(prediction.playerId);
          const key = `${marketKey}:${playerId}`;
          if (!groups.has(key)) {
            const player = playerById.get(playerId) || {};
            groups.set(key, {
              key,
              eventId: prediction.eventId,
              playerId,
              playerName: cleanString(player.name) || cleanString(prediction.playerName) || playerId,
              market: prediction.market,
              marketKey,
              entries: []
            });
          }
          groups.get(key).entries.push({
            profileKey: profile.key,
            profileLabel: profile.label,
            rank: numberOrNull(prediction.rank),
            probability: numberOrNull(prediction.probability),
            score: numberOrNull(prediction.score),
            edge: numberOrNull(prediction.edge),
            marketOddsAmerican: numberOrNull(prediction.marketOddsAmerican),
            fairOddsAmerican: numberOrNull(prediction.fairOddsAmerican),
            confidence: cleanString(prediction.confidence)
          });
        });
    });

    const rows = [...groups.values()].map((group) => {
      const profileRows = profiles.map((profile) => {
        const entry = group.entries.find((candidate) => candidate.profileKey === profile.key);
        return entry ? { ...entry } : {
          profileKey: profile.key,
          profileLabel: profile.label,
          rank: null,
          probability: null,
          score: null,
          edge: null,
          marketOddsAmerican: null,
          fairOddsAmerican: null,
          confidence: ""
        };
      });
      const available = profileRows.filter((row) => Number.isFinite(row.rank));
      const ranks = available.map((row) => row.rank);
      const probabilities = available.map((row) => row.probability).filter(Number.isFinite);
      const scores = available.map((row) => row.score).filter(Number.isFinite);
      const edges = available.map((row) => row.edge).filter(Number.isFinite);
      const bestRank = ranks.length ? Math.min(...ranks) : null;
      const worstRank = ranks.length ? Math.max(...ranks) : null;
      const bestProbability = probabilities.length ? Math.max(...probabilities) : null;
      const worstProbability = probabilities.length ? Math.min(...probabilities) : null;
      const contenderProfiles = available.filter((row) => row.rank <= contenderCutoff).length;
      const pricedProfiles = available.filter((row) => Number.isFinite(row.marketOddsAmerican)).length;
      const positiveEdgeProfiles = available.filter((row) => Number.isFinite(row.edge) && row.edge > 0).length;
      const row = {
        eventId: group.eventId,
        playerId: group.playerId,
        playerName: group.playerName,
        market: group.market,
        marketKey: group.marketKey,
        marketLabel: marketDisplayLabel(group.market),
        profileCount: profiles.length,
        modeledProfiles: available.length,
        contenderProfiles,
        consensusPct: profiles.length ? contenderProfiles / profiles.length : 0,
        pricedProfiles,
        positiveEdgeProfiles,
        edgeAgreementPct: pricedProfiles ? positiveEdgeProfiles / pricedProfiles : null,
        bestRank,
        worstRank,
        rankRange: Number.isFinite(bestRank) && Number.isFinite(worstRank) ? worstRank - bestRank : null,
        avgRank: avg(ranks),
        bestProbability,
        worstProbability,
        probabilityRange: Number.isFinite(bestProbability) && Number.isFinite(worstProbability) ? bestProbability - worstProbability : null,
        avgProbability: avg(probabilities),
        avgScore: avg(scores),
        avgEdge: avg(edges),
        topProfiles: available
          .filter((entry) => entry.rank <= contenderCutoff)
          .sort((a, b) => a.rank - b.rank)
          .map((entry) => entry.profileLabel),
        profileRows
      };
      const verdict = consensusVerdict(row);
      return {
        ...row,
        verdict: verdict.key,
        verdictLabel: verdict.label
      };
    }).sort((a, b) =>
      b.contenderProfiles - a.contenderProfiles ||
      (a.avgRank || 999) - (b.avgRank || 999) ||
      (b.avgProbability || 0) - (a.avgProbability || 0) ||
      (b.avgEdge || -999) - (a.avgEdge || -999) ||
      cleanString(a.playerName).localeCompare(cleanString(b.playerName))
    );

    const marketCount = new Set(rows.map((row) => row.marketKey)).size;
    return {
      event: firstSnapshot.event,
      course: firstSnapshot.course,
      weather: firstSnapshot.weather,
      weatherScenario: firstSnapshot.weatherScenario,
      marketFilter,
      profiles,
      rows: rows.slice(0, maxRows),
      allRows: rows,
      warnings: snapshots.flatMap((snapshot) => snapshot.warnings || []),
      summary: {
        profiles: profiles.length,
        players: new Set(rows.map((row) => row.playerId)).size,
        markets: marketCount,
        contenderCutoff,
        consensusCores: rows.filter((row) => row.verdict === "core").length,
        profileSensitive: rows.filter((row) => row.verdict === "sensitive").length,
        pricedRows: rows.filter((row) => row.pricedProfiles > 0).length,
        marketAgreement: rows.filter((row) => row.verdict === "market").length,
        topConsensus: rows[0] || null
      }
    };
  }

  function sensitivityVerdict(row) {
    if (row.maxRankLoss >= 8 || row.maxProbabilityLoss >= 0.05) {
      return { key: "fragile", label: "Feature fragile" };
    }
    if (row.maxRankLoss >= 4 || row.maxProbabilityLoss >= 0.025) {
      return { key: "dependent", label: "Feature dependent" };
    }
    if (row.maxRankLoss <= 1 && row.maxProbabilityLoss <= 0.01) {
      return { key: "robust", label: "Robust pick" };
    }
    return { key: "balanced", label: "Balanced signal" };
  }

  function buildFeatureSensitivityBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const weights = normalizeWeights(options.weights);
    const marketFilter = cleanString(options.market || options.marketFilter || "winner") || "winner";
    const maxRows = Number.isFinite(Number(options.maxRows || options.limit)) ? Number(options.maxRows || options.limit) : 10;
    const modelProfile = cleanString(options.modelProfile || options.profile || options.preset || "Feature Sensitivity");
    const dimensions = MODEL_FEATURES
      .map((feature) => ({ ...feature, weight: weights[feature.key] || 0 }))
      .filter((feature) => feature.weight > 0 || options.includeZeroWeightFeatures);
    const baseline = buildOwnedModelSnapshot(lab, {
      ...options,
      weights,
      modelProfile,
      createdAt: cleanString(options.createdAt) || "feature-sensitivity-baseline"
    });
    if (!baseline.event) {
      return {
        event: null,
        course: null,
        weather: null,
        weatherScenario: weatherScenarioFromOptions(options),
        marketFilter,
        modelProfile,
        weights,
        dimensions,
        rows: [],
        allRows: [],
        warnings: baseline.warnings,
        summary: {
          players: 0,
          markets: 0,
          dimensions: dimensions.length,
          fragile: 0,
          robust: 0,
          topDependency: null,
          topRobust: null
        }
      };
    }

    const scenarioSnapshots = dimensions.map((dimension) => {
      const scenarioWeights = { ...weights, [dimension.key]: 0 };
      return {
        ...dimension,
        snapshot: buildOwnedModelSnapshot(lab, {
          ...options,
          weights: scenarioWeights,
          modelProfile: `${modelProfile} - no ${dimension.label}`,
          createdAt: cleanString(options.createdAt) || `feature-sensitivity-${dimension.key}`
        })
      };
    });
    const playerById = new Map(lab.players.map((player) => [cleanString(player.id), player]));
    const scenarioPredictions = new Map();
    scenarioSnapshots.forEach((scenario) => {
      const predictions = new Map();
      scenario.snapshot.predictions
        .filter((prediction) => marketMatchesFilter(prediction.market, marketFilter))
        .forEach((prediction) => {
          predictions.set(`${normalizeMarketKey(prediction.market)}:${cleanString(prediction.playerId)}`, prediction);
        });
      scenarioPredictions.set(scenario.key, predictions);
    });

    const rows = baseline.predictions
      .filter((prediction) => marketMatchesFilter(prediction.market, marketFilter))
      .map((prediction) => {
        const playerId = cleanString(prediction.playerId);
        const player = playerById.get(playerId) || {};
        const lookupKey = `${normalizeMarketKey(prediction.market)}:${playerId}`;
        const baselineRank = numberOrNull(prediction.rank);
        const baselineProbability = numberOrNull(prediction.probability);
        const baselineScore = numberOrNull(prediction.score);
        const sensitivityRows = dimensions.map((dimension) => {
          const scenarioPrediction = scenarioPredictions.get(dimension.key).get(lookupKey) || {};
          const rank = numberOrNull(scenarioPrediction.rank);
          const probability = numberOrNull(scenarioPrediction.probability);
          const score = numberOrNull(scenarioPrediction.score);
          return {
            key: dimension.key,
            label: dimension.label,
            weight: dimension.weight,
            rank,
            probability,
            score,
            rankImpact: Number.isFinite(rank) && Number.isFinite(baselineRank) ? rank - baselineRank : null,
            probabilityImpact: Number.isFinite(probability) && Number.isFinite(baselineProbability) ? baselineProbability - probability : null,
            scoreImpact: Number.isFinite(score) && Number.isFinite(baselineScore) ? baselineScore - score : null
          };
        });
        const rankLosses = sensitivityRows.map((row) => numberOrNull(row.rankImpact)).filter((value) => Number.isFinite(value) && value > 0);
        const probabilityLosses = sensitivityRows.map((row) => numberOrNull(row.probabilityImpact)).filter((value) => Number.isFinite(value) && value > 0);
        const strongestDependency = [...sensitivityRows]
          .filter((row) => Number.isFinite(row.rankImpact) || Number.isFinite(row.probabilityImpact))
          .sort((a, b) =>
            (numberOrNull(b.rankImpact) || 0) - (numberOrNull(a.rankImpact) || 0) ||
            (numberOrNull(b.probabilityImpact) || 0) - (numberOrNull(a.probabilityImpact) || 0) ||
            (numberOrNull(b.weight) || 0) - (numberOrNull(a.weight) || 0)
          )[0] || null;
        const row = {
          eventId: prediction.eventId,
          playerId,
          playerName: cleanString(player.name) || cleanString(prediction.playerName) || playerId,
          market: prediction.market,
          marketKey: normalizeMarketKey(prediction.market),
          marketLabel: marketDisplayLabel(prediction.market),
          baselineRank,
          baselineProbability,
          baselineScore,
          fairOddsAmerican: numberOrNull(prediction.fairOddsAmerican),
          marketOddsAmerican: numberOrNull(prediction.marketOddsAmerican),
          edge: numberOrNull(prediction.edge),
          confidence: cleanString(prediction.confidence),
          maxRankLoss: rankLosses.length ? Math.max(...rankLosses) : 0,
          maxProbabilityLoss: probabilityLosses.length ? Math.max(...probabilityLosses) : 0,
          strongestDependency,
          sensitivityRows
        };
        const verdict = sensitivityVerdict(row);
        return {
          ...row,
          verdict: verdict.key,
          verdictLabel: verdict.label
        };
      })
      .sort((a, b) =>
        (a.baselineRank || 999) - (b.baselineRank || 999) ||
        b.maxRankLoss - a.maxRankLoss ||
        b.maxProbabilityLoss - a.maxProbabilityLoss ||
        cleanString(a.playerName).localeCompare(cleanString(b.playerName))
      );

    return {
      event: baseline.event,
      course: baseline.course,
      weather: baseline.weather,
      weatherScenario: baseline.weatherScenario,
      marketFilter,
      modelProfile,
      weights,
      dimensions,
      rows: rows.slice(0, maxRows),
      allRows: rows,
      warnings: [
        ...(baseline.warnings || []),
        ...scenarioSnapshots.flatMap((scenario) => scenario.snapshot.warnings || [])
      ],
      summary: {
        players: new Set(rows.map((row) => row.playerId)).size,
        markets: new Set(rows.map((row) => row.marketKey)).size,
        dimensions: dimensions.length,
        fragile: rows.filter((row) => row.verdict === "fragile" || row.verdict === "dependent").length,
        robust: rows.filter((row) => row.verdict === "robust").length,
        topDependency: [...rows].sort((a, b) =>
          b.maxRankLoss - a.maxRankLoss ||
          b.maxProbabilityLoss - a.maxProbabilityLoss ||
          (a.baselineRank || 999) - (b.baselineRank || 999)
        )[0] || null,
        topRobust: rows.find((row) => row.verdict === "robust") || null
      }
    };
  }

  function buildEventFitBoard(input, options = {}) {
    const snapshot = buildOwnedModelSnapshot(input, {
      ...options,
      modelProfile: cleanString(options.modelProfile || options.profile || options.preset || "Fit Board"),
      createdAt: cleanString(options.createdAt) || "fit-board-preview"
    });
    if (!snapshot.event) {
      return {
        event: null,
        course: null,
        weather: null,
        modelProfile: cleanString(options.modelProfile || options.profile || options.preset || "Fit Board"),
        weatherScenario: weatherScenarioFromOptions(options),
        rows: [],
        warnings: snapshot.warnings,
        summary: {
          players: 0,
          highConfidence: 0,
          averageSampleRounds: null,
          topFit: null
        }
      };
    }
    const winnerPredictions = new Map(snapshot.predictions
      .filter((prediction) => prediction.market === "winner")
      .map((prediction) => [prediction.playerId, prediction]));
    const rows = snapshot.features.map((feature) => {
      const prediction = winnerPredictions.get(feature.playerId) || {};
      const reasons = modelFitReasons(feature);
      return {
        eventId: snapshot.event.id,
        playerId: feature.playerId,
        playerName: feature.playerName,
        rank: feature.rank,
        fitScore: feature.score,
        winProbability: prediction.probability ?? feature.probability,
        fairOddsAmerican: prediction.fairOddsAmerican || null,
        sampleRounds: feature.sampleRounds,
        confidence: prediction.confidence || (feature.sampleRounds >= 20 ? "high" : feature.sampleRounds >= 8 ? "medium" : "thin sample"),
        modelProfile: prediction.modelProfile || cleanString(options.modelProfile || options.profile || options.preset || "Fit Board"),
        strengths: reasons.strengths,
        concerns: reasons.concerns,
        features: {
          skill: feature.skill,
          recentForm: feature.recentForm,
          courseFit: feature.courseFit,
          difficultyFit: feature.difficultyFit,
          weatherFit: feature.weatherFit,
          liveState: feature.liveState
        },
        livePosition: feature.livePosition,
        liveToPar: feature.liveToPar,
        liveRounds: feature.liveRounds,
        liveStrokesBack: feature.liveStrokesBack
      };
    });
    return {
      event: snapshot.event,
      course: snapshot.course,
      weather: snapshot.weather,
      modelProfile: rows[0] ? rows[0].modelProfile : cleanString(options.modelProfile || options.profile || options.preset || "Fit Board"),
      weatherScenario: snapshot.weatherScenario,
      weights: normalizeWeights(options.weights),
      rows,
      warnings: snapshot.warnings,
      summary: {
        players: rows.length,
        highConfidence: rows.filter((row) => row.confidence === "high").length,
        averageSampleRounds: avg(rows.map((row) => numberOrNull(row.sampleRounds))),
        topFit: rows[0] || null
      }
    };
  }

  function buildFieldIntelligenceBoard(input, options = {}) {
    const rawMarket = cleanString(options.market || options.marketFilter || "winner");
    const marketKey = normalizeMarketKey(rawMarket);
    const targetMarket = !marketKey || marketKey === "all" || marketKey === "allmarkets" ? "winner" : rawMarket;
    const minEdge = Number.isFinite(Number(options.minEdge)) ? Number(options.minEdge) : 0.01;
    const snapshot = buildOwnedModelSnapshot(input, {
      ...options,
      modelProfile: cleanString(options.modelProfile || options.profile || options.preset || "Field Intelligence"),
      createdAt: cleanString(options.createdAt) || "field-intelligence-preview"
    });
    if (!snapshot.event) {
      return {
        event: null,
        course: null,
        weather: null,
        market: targetMarket,
        modelProfile: cleanString(options.modelProfile || options.profile || options.preset || "Field Intelligence"),
        weatherScenario: weatherScenarioFromOptions(options),
        rows: [],
        specialists: {},
        warnings: snapshot.warnings,
        summary: {
          players: 0,
          priced: 0,
          positiveEdges: 0,
          thinSamples: 0,
          highConfidence: 0,
          averageFitScore: null,
          topFit: null
        }
      };
    }
    const predictionByPlayer = new Map(snapshot.predictions
      .filter((prediction) => marketMatchesFilter(prediction.market, targetMarket))
      .map((prediction) => [prediction.playerId, prediction]));
    const rows = snapshot.features.map((feature) => {
      const prediction = predictionByPlayer.get(feature.playerId) || {};
      const reasons = modelFitReasons(feature);
      const marketOdds = numberOrNull(prediction.marketOddsAmerican);
      const edge = numberOrNull(prediction.edge);
      const confidence = prediction.confidence || (feature.sampleRounds >= 20 ? "high" : feature.sampleRounds >= 8 ? "medium" : "thin sample");
      const priceStatus = !Number.isFinite(marketOdds)
        ? "unpriced"
        : edge >= minEdge
          ? "edge"
          : edge > 0
            ? "lean"
            : "pass";
      return {
        eventId: snapshot.event.id,
        playerId: feature.playerId,
        playerName: feature.playerName,
        rank: feature.rank,
        fitScore: feature.score,
        market: prediction.market || targetMarket,
        probability: prediction.probability ?? feature.probability,
        fairOddsAmerican: prediction.fairOddsAmerican || americanFromProbability(prediction.probability ?? feature.probability),
        marketOddsAmerican: Number.isFinite(marketOdds) ? marketOdds : null,
        edge: Number.isFinite(edge) ? edge : null,
        priceStatus,
        sampleRounds: feature.sampleRounds,
        confidence,
        modelProfile: prediction.modelProfile || cleanString(options.modelProfile || options.profile || options.preset || "Field Intelligence"),
        strengths: reasons.strengths,
        concerns: reasons.concerns,
        primaryFit: reasons.strengths[0] ? reasons.strengths[0].label : "Fit",
        features: {
          skill: feature.skill,
          recentForm: feature.recentForm,
          courseFit: feature.courseFit,
          difficultyFit: feature.difficultyFit,
          weatherFit: feature.weatherFit,
          liveState: feature.liveState
        },
        livePosition: feature.livePosition,
        liveToPar: feature.liveToPar,
        liveRounds: feature.liveRounds,
        liveStrokesBack: feature.liveStrokesBack
      };
    });
    function topByFeature(key) {
      return [...rows]
        .filter((row) => Number.isFinite(numberOrNull(row.features[key])))
        .sort((a, b) => (numberOrNull(b.features[key]) || 0) - (numberOrNull(a.features[key]) || 0) || a.rank - b.rank)[0] || null;
    }
    return {
      event: snapshot.event,
      course: snapshot.course,
      weather: snapshot.weather,
      market: targetMarket,
      modelProfile: rows[0] ? rows[0].modelProfile : cleanString(options.modelProfile || options.profile || options.preset || "Field Intelligence"),
      weatherScenario: snapshot.weatherScenario,
      weights: normalizeWeights(options.weights),
      rows,
      specialists: {
        course: topByFeature("courseFit"),
        difficulty: topByFeature("difficultyFit"),
        weather: topByFeature("weatherFit"),
        form: topByFeature("recentForm"),
        live: topByFeature("liveState")
      },
      warnings: snapshot.warnings,
      summary: {
        players: rows.length,
        priced: rows.filter((row) => Number.isFinite(row.marketOddsAmerican)).length,
        positiveEdges: rows.filter((row) => Number.isFinite(row.edge) && row.edge > 0).length,
        thresholdEdges: rows.filter((row) => Number.isFinite(row.edge) && row.edge >= minEdge).length,
        thinSamples: rows.filter((row) => row.confidence === "thin sample").length,
        highConfidence: rows.filter((row) => row.confidence === "high").length,
        averageFitScore: avg(rows.map((row) => numberOrNull(row.fitScore))),
        topFit: rows[0] || null
      }
    };
  }

  function scenarioListFromOptions(options = {}) {
    const raw = Array.isArray(options.weatherScenarios) && options.weatherScenarios.length
      ? options.weatherScenarios
      : ["baseline", "calm", "wind", "rain", "cold", "heat"];
    const seen = new Set();
    return raw.map((value) => weatherScenarioFromOptions({ weatherScenario: value }))
      .filter((scenario) => {
        if (!scenario || seen.has(scenario.key)) return false;
        seen.add(scenario.key);
        return true;
      });
  }

  function buildWeatherScenarioBoard(input, options = {}) {
    const scenarios = scenarioListFromOptions(options);
    const boards = scenarios.map((scenario) => buildEventFitBoard(input, {
      ...options,
      weatherScenario: scenario.key,
      modelProfile: cleanString(options.modelProfile || options.profile || options.preset || "Scenario Board")
    }));
    const firstBoard = boards.find((board) => board.event) || boards[0] || null;
    const baseline = boards.find((board) => board.weatherScenario && board.weatherScenario.key === "baseline") || firstBoard;
    if (!firstBoard || !firstBoard.event) {
      return {
        event: null,
        course: null,
        modelProfile: cleanString(options.modelProfile || options.profile || options.preset || "Scenario Board"),
        scenarios: [],
        movers: [],
        summary: {
          scenarios: 0,
          players: 0,
          topMover: null,
          baselineTopFit: null
        }
      };
    }
    const maxRows = Number.isFinite(Number(options.maxRows)) ? Number(options.maxRows) : 4;
    const baselineRankByPlayer = new Map((baseline.rows || []).map((row) => [row.playerId, row.rank]));
    const scenarioRows = boards
      .filter((board) => board.event)
      .map((board) => {
        const rows = board.rows.slice(0, maxRows).map((row) => {
          const baselineRank = baselineRankByPlayer.get(row.playerId) || null;
          const rankChange = baselineRank ? baselineRank - row.rank : null;
          return {
            ...row,
            baselineRank,
            rankChange
          };
        });
        const movers = board.rows
          .map((row) => {
            const baselineRank = baselineRankByPlayer.get(row.playerId) || null;
            const rankChange = baselineRank ? baselineRank - row.rank : null;
            return {
              playerId: row.playerId,
              playerName: row.playerName,
              rank: row.rank,
              baselineRank,
              rankChange,
              winProbability: row.winProbability,
              scenarioKey: board.weatherScenario ? board.weatherScenario.key : "",
              scenarioLabel: board.weatherScenario ? board.weatherScenario.label : ""
            };
          })
          .filter((row) => Number.isFinite(row.rankChange) && row.rankChange !== 0)
          .sort((a, b) => Math.abs(b.rankChange) - Math.abs(a.rankChange) || b.rankChange - a.rankChange)
          .slice(0, 3);
        return {
          key: board.weatherScenario ? board.weatherScenario.key : "",
          label: board.weatherScenario ? board.weatherScenario.label : "",
          topFit: board.summary.topFit || null,
          rows,
          movers
        };
      });
    const movers = scenarioRows
      .flatMap((scenario) => scenario.movers)
      .sort((a, b) => Math.abs(b.rankChange) - Math.abs(a.rankChange) || b.rankChange - a.rankChange)
      .slice(0, 8);
    return {
      event: firstBoard.event,
      course: firstBoard.course,
      modelProfile: firstBoard.modelProfile,
      scenarios: scenarioRows,
      movers,
      summary: {
        scenarios: scenarioRows.length,
        players: firstBoard.rows.length,
        topMover: movers[0] || null,
        baselineTopFit: baseline.summary.topFit || null
      }
    };
  }

  function buildOwnedModelSnapshot(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const event = selectModelEvent(lab, options);
    const createdAt = cleanString(options.createdAt) || new Date().toISOString();
    if (!event) {
      return {
        event: null,
        predictions: [],
        features: [],
        warnings: ["No events available for modeling."],
        golfLab: GolfLab.blankGolfLabState()
      };
    }
    const course = courseForEvent(lab, event);
    const { weather: eventWeather, scenario: weatherScenario } = eventWeatherForOptions(lab, event, options);
    const modelProfile = cleanString(options.modelProfile || options.profile || options.preset || "Balanced");
    const requireOfficialField = Boolean(options.requireOfficialField || options.requireField);
    const explicitFieldRows = explicitEventFieldPlayers(lab, event, options);
    if (requireOfficialField && !explicitFieldRows.length) {
      return {
        event,
        course,
        weather: eventWeather,
        weatherScenario,
        predictions: [],
        features: [],
        warnings: ["Official field rows are required before saving model predictions."],
        golfLab: GolfLab.blankGolfLabState()
      };
    }
    const fieldRows = eventFieldPlayers(lab, event, options);
    const liveContext = liveStateContext(lab, event, fieldRows);
    const weights = modelWeightsForRun(options, liveContext);
    const modelRunId = buildModelRunId(event, modelProfile, weatherScenario, createdAt);
    const playersById = new Map(lab.players.flatMap((player) => playerAliases(player).map((alias) => [alias, player])));
    const scored = fieldRows.map((field) => {
      const player = playersById.get(cleanString(field.playerId)) || playersById.get(cleanString(field.playerName));
      if (!player) return null;
      const aliases = playerAliases(player);
      const playerRounds = lab.rounds.filter((round) => roundPlayerMatches(round, aliases));
      const liveStanding = liveStandingForPlayer(liveContext, aliases);
      const card = GolfLab.buildPlayerScorecard(lab, player.id);
      const features = {
        skill: skillScore(card),
        recentForm: recentFormScore(playerRounds),
        courseFit: courseFitScore(card, course),
        difficultyFit: difficultyFitScore(lab, playerRounds, course),
        weatherFit: weatherFitScore(lab, playerRounds, eventWeather),
        liveState: liveStateScore(liveStanding, liveContext)
      };
      const score = Object.entries(features).reduce((sum, [key, value]) => sum + (weights[key] || 0) * value, 0);
      return { player, field, features, score, sampleRounds: playerRounds.length, liveStanding };
    }).filter(Boolean);
    if (requireOfficialField && !scored.length) {
      return {
        event,
        course,
        weather: eventWeather,
        weatherScenario,
        predictions: [],
        features: [],
        warnings: ["No official field players matched imported player profiles."],
        golfLab: GolfLab.blankGolfLabState()
      };
    }
    const probabilityRows = softmax(scored).sort((a, b) => b.probability - a.probability);
    const predictions = probabilityRows.flatMap((row, index) => {
      const rankedRow = { ...row, rank: index + 1 };
      return ["winner", "top 10", "top 20", "make cut"].map((market) => {
        const probability = marketProbabilityForRow(rankedRow, market, probabilityRows.length);
        const marketOdds = marketForPlayer(lab, event, row.player.id, market);
        const marketProbability = marketOdds ? impliedProbability(marketOdds) : null;
        const edge = Number.isFinite(marketProbability) ? probability - marketProbability : null;
        return {
          id: `${modelRunId}-${row.player.id}-${marketSlug(market)}`,
          eventId: event.id,
          playerId: row.player.id,
          market,
          modelVersion: MODEL_VERSION,
          modelRunId,
          modelProfile,
          modelWeatherScenario: weatherScenario.key,
          modelWeatherLabel: weatherScenario.label,
          probability,
          fairOddsAmerican: americanFromProbability(probability),
          marketOddsAmerican: marketOdds ? numberOrNull(marketOdds.oddsAmerican) : null,
          edge,
          rank: index + 1,
          score: row.score,
          skill: row.features.skill,
          recentForm: row.features.recentForm,
          courseFit: row.features.courseFit,
          difficultyFit: row.features.difficultyFit,
          weatherFit: row.features.weatherFit,
          liveState: row.features.liveState,
          livePosition: row.liveStanding ? row.liveStanding.position : null,
          liveToPar: row.liveStanding ? row.liveStanding.total : null,
          liveRounds: row.liveStanding ? row.liveStanding.rounds : null,
          liveStrokesBack: row.liveStanding && Number.isFinite(numberOrNull(liveContext.leaderTotal))
            ? row.liveStanding.total - liveContext.leaderTotal
            : null,
          sampleRounds: row.sampleRounds,
          confidence: row.sampleRounds >= 20 ? "high" : row.sampleRounds >= 8 ? "medium" : "thin sample",
          createdAt,
          result: index === 0 && market === "winner" ? "top model lean" : "",
          sourceProvider: "Golf Lab Owned Model",
          sourceUpdatedAt: createdAt
        };
      });
    });
    const features = probabilityRows.map((row, index) => ({
      playerId: row.player.id,
      playerName: row.player.name,
      rank: index + 1,
      score: row.score,
      probability: row.probability,
      sampleRounds: row.sampleRounds,
      livePosition: row.liveStanding ? row.liveStanding.position : null,
      liveToPar: row.liveStanding ? row.liveStanding.total : null,
      liveRounds: row.liveStanding ? row.liveStanding.rounds : null,
      liveStrokesBack: row.liveStanding && Number.isFinite(numberOrNull(liveContext.leaderTotal))
        ? row.liveStanding.total - liveContext.leaderTotal
        : null,
      ...row.features
    }));
    const warnings = fieldRows.length ? [] : ["No field rows were available; modeled all imported players."];
    const manifest = buildModelRunManifest({
      lab,
      event,
      course,
      weather: eventWeather,
      weatherScenario,
      createdAt,
      weights,
      modelProfile,
      fieldRows,
      explicitFieldRows,
      scoredRows: scored,
      predictions,
      features,
      warnings,
      activationPlan: options.activationPlan,
      liveContext
    });
    return {
      event,
      course,
      weather: eventWeather,
      weatherScenario,
      manifest,
      predictions,
      features,
      warnings,
      golfLab: GolfLab.normalizeGolfLabState({
        modelPredictions: predictions,
        predictionLedger: predictions,
        sourceFetches: [{
          id: `${modelRunId}-source`,
          provider: "Golf Lab Owned Model",
          endpoint: `owned-model/${MODEL_VERSION}/${event.id}/${marketSlug(modelProfile) || "balanced"}/${weatherScenario.key || "baseline"}/${modelRunId}`,
          eventId: event.id,
          modelRunId,
          modelVersion: MODEL_VERSION,
          modelProfile,
          modelWeatherScenario: weatherScenario.key,
          modelWeatherLabel: weatherScenario.label,
          fetchedAt: createdAt,
          status: "ok",
          rowCount: predictions.length,
          manifestJson: safeJsonStringify(manifest),
          sourceProvider: "Golf Lab Owned Model",
          sourceUpdatedAt: createdAt
        }]
      })
    };
  }

  function trainingLabBeforeEvent(lab, event) {
    const eventDate = cleanString(event.startDate);
    const priorRounds = lab.rounds.filter((round) => {
      if (round.eventId === event.id) return false;
      const roundDate = cleanString(round.date || round.roundDate || round.startDate);
      return !eventDate || !roundDate || roundDate < eventDate;
    });
    return GolfLab.normalizeGolfLabState({
      ...lab,
      rounds: priorRounds,
      strokesGained: lab.strokesGained.filter((row) => row.eventId !== event.id)
    });
  }

  function buildModelTrainingDataset(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const eventLimit = Number.isFinite(Number(options.eventLimit)) ? Math.max(1, Number(options.eventLimit)) : lab.events.length || 1;
    const rowLimit = Number.isFinite(Number(options.rowLimit)) ? Math.max(1, Number(options.rowLimit)) : Infinity;
    const warnings = [];
    const eventRows = [];
    const rows = [];
    const events = [...lab.events]
      .filter((event) => buildEventStandings(lab, event.id).length)
      .sort((a, b) => cleanString(b.startDate).localeCompare(cleanString(a.startDate)))
      .slice(0, eventLimit);
    events.forEach((event) => {
      const standings = buildEventStandings(lab, event.id);
      if (!standings.length) {
        warnings.push(`${event.name || event.id} skipped: no result rounds.`);
        return;
      }
      const trainingLab = trainingLabBeforeEvent(lab, event);
      const snapshot = buildOwnedModelSnapshot(trainingLab, {
        ...options,
        eventId: event.id,
        createdAt: options.createdAt || new Date().toISOString()
      });
      const featuresByPlayer = new Map(snapshot.features.map((row) => [row.playerId, row]));
      const winnerPredictions = snapshot.predictions.filter((row) => row.market === "winner");
      const winnerByPlayer = new Map(winnerPredictions.map((row) => [row.playerId, row]));
      let eventExampleCount = 0;
      standings.forEach((standing) => {
        const feature = featuresByPlayer.get(standing.playerId);
        if (!feature) return;
        const prediction = winnerByPlayer.get(standing.playerId) || {};
        const row = {
          eventId: event.id,
          eventName: event.name || event.id,
          eventStartDate: event.startDate || "",
          tour: event.tour || "",
          season: event.season || "",
          courseId: event.courseId || "",
          courseName: event.courseName || "",
          playerId: standing.playerId,
          playerName: standing.playerName,
          finishPosition: standing.position,
          totalToPar: standing.total,
          roundsCompleted: standing.rounds,
          winner: standing.position === 1,
          top10: standing.position <= 10,
          top20: standing.position <= 20,
          madeCut: standing.rounds >= 3,
          modelRank: feature.rank,
          winProbability: feature.probability,
          fairOddsAmerican: prediction.fairOddsAmerican || null,
          marketOddsAmerican: prediction.marketOddsAmerican || null,
          edge: prediction.edge,
          sampleRounds: feature.sampleRounds,
          skill: feature.skill,
          recentForm: feature.recentForm,
          courseFit: feature.courseFit,
          difficultyFit: feature.difficultyFit,
          weatherFit: feature.weatherFit,
          featureComplete: feature.sampleRounds > 0 && MODEL_FEATURES.every((item) => Number.isFinite(feature[item.key])),
          sourceProvider: "Golf Lab Training Dataset",
          sourceUpdatedAt: options.createdAt || new Date().toISOString()
        };
        rows.push(row);
        eventExampleCount += 1;
      });
      eventRows.push({
        eventId: event.id,
        eventName: event.name || event.id,
        startDate: event.startDate || "",
        courseName: event.courseName || "",
        examples: eventExampleCount,
        standings: standings.length,
        fieldSize: snapshot.features.length,
        featureCoverage: eventExampleCount ? Math.round((rows.slice(-eventExampleCount).filter((row) => row.featureComplete).length / eventExampleCount) * 100) : 0,
        winner: standings.find((row) => row.position === 1) || null
      });
    });
    const limitedRows = rows.slice(0, rowLimit);
    const uniquePlayers = new Set(limitedRows.map((row) => row.playerId).filter(Boolean));
    const completeRows = limitedRows.filter((row) => row.featureComplete).length;
    return {
      version: MODEL_VERSION,
      generatedAt: options.createdAt || new Date().toISOString(),
      summary: {
        events: eventRows.length,
        rows: limitedRows.length,
        players: uniquePlayers.size,
        winners: limitedRows.filter((row) => row.winner).length,
        madeCuts: limitedRows.filter((row) => row.madeCut).length,
        featureCoverage: limitedRows.length ? Math.round((completeRows / limitedRows.length) * 100) : 0,
        avgSampleRounds: avg(limitedRows.map((row) => row.sampleRounds)) || 0
      },
      eventRows,
      rows: limitedRows,
      warnings
    };
  }

  return {
    MODEL_VERSION,
    DEFAULT_WEIGHTS,
    MODEL_FEATURES,
    DEFAULT_CONSENSUS_PROFILES,
    WEATHER_SCENARIOS,
    buildOwnedModelSnapshot,
    buildModelRunHistoryBoard,
    buildModelTrainingDataset,
    buildPredictionBacktest,
    buildPredictionSettlementBoard,
    buildModelPerformanceBoard,
    buildModelTuningBoard,
    buildPredictionRunAuditBoard,
    buildPredictionPrepBoard,
    buildFeatureStoreAuditBoard,
    buildModelCalibrationBoard,
    buildPredictionEdgeBoard,
    buildBetPortfolioBoard,
    buildProjectedStandingsBoard,
    buildPredictionResultsSummaryBoard,
    buildPredictionExplainerBoard,
    buildEventFitBoard,
    buildFieldIntelligenceBoard,
    buildModelConsensusBoard,
    buildFeatureSensitivityBoard,
    buildWeatherScenarioBoard,
    buildEventStandings,
    weatherBucket,
    weatherScenarioFromOptions,
    americanFromProbability
  };
});
