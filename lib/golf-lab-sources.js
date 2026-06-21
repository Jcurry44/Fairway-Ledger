/*
 * Fairway Ledger - Golf Lab source playbook.
 *
 * Turns warehouse gaps into event-specific source tasks and exportable
 * research packets so the owned database can be populated consistently.
 */
(function (root, factory) {
  "use strict";
  let golfLab = root.GolfLab;
  let warehouse = root.GolfLabWarehouse;
  if (typeof module === "object" && module.exports) {
    golfLab = require("./golf-lab.js");
    warehouse = require("./golf-lab-warehouse.js");
    module.exports = factory(golfLab, warehouse);
  } else {
    root.GolfLabSources = factory(golfLab, warehouse);
  }
})(typeof self !== "undefined" ? self : this, function (GolfLab, Warehouse) {
  "use strict";

  if (!GolfLab) throw new Error("GolfLabSources requires GolfLab.");
  if (!Warehouse) throw new Error("GolfLabSources requires GolfLabWarehouse.");

  const SOURCE_PLAN_VERSION = "sources-v0.1";

  const SOURCE_PLAYBOOK = Object.freeze([
    {
      id: "event-schedule",
      label: "Tournament Schedule",
      collectionKeys: ["events"],
      fileName: "events.csv",
      priority: "critical",
      sourceType: "official tour schedule",
      detail: "Anchor the tournament name, dates, tour, course, and status from an official schedule."
    },
    {
      id: "player-profiles",
      label: "Player Profiles",
      collectionKeys: ["players"],
      fileName: "players.csv",
      priority: "critical",
      sourceType: "official profiles / OWGR",
      detail: "Create stable player IDs, names, tours, countries, rankings, and profile URLs."
    },
    {
      id: "field-list",
      label: "Field List",
      collectionKeys: ["fields"],
      fileName: "fields.csv",
      priority: "high",
      sourceType: "official field page",
      detail: "Attach players to the event, including status and tee-time details when available."
    },
    {
      id: "course-profile",
      label: "Course Profile",
      collectionKeys: ["courses", "courseSetups"],
      fileName: "courses.csv / course_setups.csv",
      priority: "high",
      sourceType: "course scorecard / tournament setup notes",
      detail: "Capture course identity, par, yardage, difficulty, style, rough, firmness, and green speed."
    },
    {
      id: "round-results",
      label: "Round Results",
      collectionKeys: ["rounds", "strokesGained"],
      fileName: "rounds.csv / strokes_gained.csv",
      priority: "high",
      sourceType: "official leaderboard / stat pages",
      detail: "Import round scoring, to-par, adjusted scoring, and strokes-gained components for historical proof."
    },
    {
      id: "weather",
      label: "Weather Snapshots",
      collectionKeys: ["weatherSnapshots"],
      fileName: "weather_snapshots.csv",
      priority: "medium",
      sourceType: "weather observations / forecast archive",
      detail: "Add wind, gust, temperature, rain, and wave context for rounds and tournament forecasts."
    },
    {
      id: "markets",
      label: "Market Odds",
      collectionKeys: ["oddsSnapshots"],
      fileName: "odds.csv",
      priority: "medium",
      sourceType: "sportsbook odds history",
      detail: "Capture winner, top-10, top-20, and make-cut prices with book, market, timestamp, and implied probability."
    },
    {
      id: "enrichment",
      label: "Player Enrichment",
      collectionKeys: ["equipmentSnapshots", "accomplishments"],
      fileName: "equipment.csv / accomplishments.csv",
      priority: "low",
      sourceType: "WITB / profile / results pages",
      detail: "Add bag snapshots, wins, major results, and accomplishments for premium scouting cards."
    }
  ]);

  const SOURCE_ADAPTER_TYPES = Object.freeze({
    "event-schedule": "schedule",
    "player-profiles": "profile",
    "field-list": "field",
    "course-profile": "course",
    "round-results": "leaderboard",
    weather: "weather",
    markets: "odds",
    enrichment: "enrichment"
  });

  const SOURCE_ADAPTER_HEADERS = Object.freeze({
    schedule: ["Event Name", "Start Date", "End Date", "Course Name", "Tour"],
    profile: ["Player Name", "Country", "Tour", "OWGR", "DataGolf ID", "PGA Tour ID", "Profile URL", "College", "Turned Pro"],
    field: ["Player Name", "Country", "OWGR", "Tee Time", "Status"],
    course: ["Course Name", "Location", "Par", "Yards", "Rating", "Slope", "Style", "Rough", "Green Speed", "Firmness"],
    leaderboard: ["Player Name", "Round", "Score", "To Par", "SG Total", "SG OTT", "SG APP"],
    odds: ["Player Name", "Market", "Book", "Odds", "Implied Probability", "Captured At"],
    weather: ["Course Name", "Round", "Date", "Temperature", "Wind", "Gust", "Wave"],
    enrichment: ["Player Name", "Captured Date", "Driver", "Fairway Woods", "Irons", "Wedges", "Putter", "Ball", "Accomplishment", "Type", "Event Name", "Season", "Date"]
  });

  const SOURCE_ACQUISITION_RECIPES = Object.freeze({
    "event-schedule": {
      publicLane: "free",
      confidence: "official-first",
      primarySource: "Official tour schedule or tournament site",
      fallbackSource: "Tournament media guide or official tournament archive",
      searchQuery: "{eventName} {season} official schedule course dates",
      captureSteps: [
        "Capture event name, dates, tour, course, and tournament status from the official listing.",
        "Save one schedule CSV in the batch raw folder with schedule in the file name.",
        "Record the exact source URL and fetchedAt timestamp in source_fetches.csv."
      ],
      qualityGates: [
        "Event dates and course match the official tournament page.",
        "Event ID is stable and reused across field, round, weather, odds, and model rows."
      ],
      proofRule: "One official source row with provider, endpoint, fetchedAt, rowCount, and sourceUrl is enough to unlock the schedule lane.",
      premiumSignal: "Locks the tournament command center to the right course and timing."
    },
    "player-profiles": {
      publicLane: "free",
      confidence: "profile-backed",
      primarySource: "Official tour profiles plus OWGR-style ranking exports",
      fallbackSource: "Major championship profile pages and player official sites",
      searchQuery: "{tour} player profile OWGR ranking country profile URL",
      captureSteps: [
        "Capture player name, country, tour, rankings, known public IDs, profile URL, college, and turned-pro year.",
        "Prefer stable public IDs when available, but keep Golf Lab's slugged player ID consistent.",
        "Save one profiles CSV in the batch raw folder with profiles in the file name."
      ],
      qualityGates: [
        "No duplicate player IDs after normalized-name matching.",
        "Field, leaderboard, odds, equipment, and accomplishment rows resolve to the same player record."
      ],
      proofRule: "Profiles are trustworthy when each imported profile has a provider or URL and identity audit shows no unresolved critical rows.",
      premiumSignal: "Adds the Blue Line-style player bio, archetype, rankings, and source coverage."
    },
    "field-list": {
      publicLane: "free",
      confidence: "official-first",
      primarySource: "Official tournament field page",
      fallbackSource: "Tournament tee sheet, major championship field page, or official qualifying list",
      searchQuery: "{eventName} {season} official field list tee times",
      captureSteps: [
        "Capture every active, alternate, withdrawn, or cut player with field status and tee time/wave when available.",
        "Save one field CSV in the batch raw folder with field in the file name.",
        "Run the Player Identity board before trusting downstream scoring or markets."
      ],
      qualityGates: [
        "Field count matches the official field page for the captured timestamp.",
        "Every active field row resolves to one player ID or is flagged in the identity board."
      ],
      proofRule: "Field proof should include rowCount equal to the official field size and a source URL for the exact captured page.",
      premiumSignal: "Turns the model from global player rankings into an event-specific slate."
    },
    "course-profile": {
      publicLane: "free",
      confidence: "setup-backed",
      primarySource: "Official course scorecard and tournament setup notes",
      fallbackSource: "Course website, major media guide, or trusted scorecard archive",
      searchQuery: "{courseName} {eventName} scorecard yardage par rough green speed",
      captureSteps: [
        "Capture course identity, location, par, yardage, rating/slope when available, style, rough, firmness, and green speed.",
        "Save one course CSV in the batch raw folder with course in the file name.",
        "Add tournament-specific setup fields when the event plays different than the public scorecard."
      ],
      qualityGates: [
        "Course ID is stable across event, round, weather, and course setup rows.",
        "Yardage, par, rough, firmness, and green speed reflect the tournament setup when known."
      ],
      proofRule: "Course proof is ready when course and setup rows point back to the scorecard or official setup note.",
      premiumSignal: "Feeds course difficulty, comp-course matching, and setup pressure."
    },
    "round-results": {
      publicLane: "free",
      confidence: "official-first",
      primarySource: "Official leaderboard and official stat pages",
      fallbackSource: "Tournament results PDF, official round recap, or archived scoring page",
      searchQuery: "{eventName} {season} official leaderboard round scores strokes gained",
      captureSteps: [
        "Capture every round score, to-par, finishing result, and strokes-gained components when public.",
        "Save one leaderboard CSV in the batch raw folder with leaderboard in the file name.",
        "Backfill all four rounds for completed events before using them as training rows."
      ],
      qualityGates: [
        "Round numbers, scores, and cut/WD statuses reconcile to the official leaderboard.",
        "Strokes-gained values are tagged with provider proof or left blank instead of estimated."
      ],
      proofRule: "Round-result proof is premium-ready when the source ledger covers every scoring/stat page used for the event.",
      premiumSignal: "Creates tough-course, easy-course, course-history, and training-result truth."
    },
    weather: {
      publicLane: "free",
      confidence: "observed-or-forecast",
      primarySource: "NOAA/NCEI-style observations, official forecast, or station archive",
      fallbackSource: "Tournament weather reports, airport METAR archive, or saved forecast page",
      searchQuery: "{courseName} {eventName} round weather wind gust temperature precipitation",
      captureSteps: [
        "Capture round, date, temperature, wind, gust, precipitation/rain flag, and wave label when available.",
        "Save one weather CSV in the batch raw folder with weather in the file name.",
        "Use observed weather for historical training and clearly label forecast rows for upcoming tournaments."
      ],
      qualityGates: [
        "Weather timestamp is aligned to round date or tee-time wave.",
        "Forecast rows are refreshed inside the event window before prediction prep is trusted."
      ],
      proofRule: "Weather proof should distinguish observed history from forecast context and include source timestamp.",
      premiumSignal: "Unlocks wind/rain/heat/cold splits, tee-time waves, and weather-scenario modeling."
    },
    markets: {
      publicLane: "mixed",
      confidence: "snapshot-backed",
      primarySource: "Sportsbook odds board manually captured from permitted sources",
      fallbackSource: "Personal line-history sheet, screenshots converted to CSV, or licensed odds feed",
      searchQuery: "{eventName} {season} golf odds winner top 10 top 20 make cut",
      captureSteps: [
        "Capture market, book, American odds, implied probability when available, and capturedAt timestamp.",
        "Save one odds CSV in the batch raw folder with odds in the file name.",
        "Keep raw odds snapshots time-stamped so movement, shopping, and settlement stay auditable."
      ],
      qualityGates: [
        "Every modeled market has at least one current price for playable edge work.",
        "CapturedAt is present so stale odds cannot masquerade as current prices."
      ],
      proofRule: "Market proof is ready when each odds snapshot has book, market, timestamp, and source note or URL.",
      premiumSignal: "Turns model probability into fair odds, edge, line shopping, and portfolio sizing."
    },
    enrichment: {
      publicLane: "free",
      confidence: "profile-backed",
      primarySource: "Public WITB pages, player profiles, official results pages, and equipment pages",
      fallbackSource: "Player site, manufacturer news release, or tournament notes",
      searchQuery: "{playerName} WITB accomplishments wins majors golf profile",
      captureSteps: [
        "Capture bag snapshot details, accomplishments, wins, majors, season, and source URL.",
        "Save one enrichment CSV in the batch raw folder with enrichment in the file name.",
        "Prefer dated snapshots so old equipment does not overwrite current bag context."
      ],
      qualityGates: [
        "Equipment rows include capturedDate and source URL when possible.",
        "Accomplishments are typed and dated enough to show in player scorecards without ambiguity."
      ],
      proofRule: "Enrichment is optional for modeling, but premium scorecards should show dated source-backed rows.",
      premiumSignal: "Adds the polished scouting-card texture: bag, accomplishments, risks, and profile context."
    }
  });

  function cleanString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function slug(value) {
    return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function chooseEvent(lab, eventId) {
    const explicit = cleanString(eventId);
    if (explicit) {
      return lab.events.find((event) => event.id === explicit || event.name === explicit) || null;
    }
    const today = new Date().toISOString().slice(0, 10);
    return [...lab.events]
      .filter((event) => !event.startDate || event.startDate >= today)
      .sort((a, b) => cleanString(a.startDate).localeCompare(cleanString(b.startDate)))[0]
      || [...lab.events].sort((a, b) => cleanString(b.startDate).localeCompare(cleanString(a.startDate)))[0]
      || null;
  }

  function courseForEvent(lab, event) {
    if (!event) return null;
    return lab.courses.find((course) =>
      course.id === event.courseId ||
      course.name === event.courseName ||
      course.dataGolfCourseId === event.courseId
    ) || null;
  }

  function sourceRowsForTask(lab, event, task) {
    if (!event && task.id !== "event-schedule" && task.id !== "player-profiles") return [];
    if (task.id === "event-schedule") return event ? [event] : [];
    if (task.id === "player-profiles") return lab.players;
    if (task.id === "field-list") return lab.fields.filter((row) => row.eventId === event.id);
    if (task.id === "course-profile") {
      const course = courseForEvent(lab, event);
      const setups = lab.courseSetups.filter((row) => row.eventId === event.id || row.courseId === event.courseId);
      return [course, ...setups].filter(Boolean);
    }
    if (task.id === "round-results") {
      return [
        ...lab.rounds.filter((row) => row.eventId === event.id),
        ...lab.strokesGained.filter((row) => row.eventId === event.id)
      ];
    }
    if (task.id === "weather") return lab.weatherSnapshots.filter((row) => row.eventId === event.id);
    if (task.id === "markets") return lab.oddsSnapshots.filter((row) => row.eventId === event.id);
    if (task.id === "enrichment") {
      const fieldIds = new Set(lab.fields.filter((row) => row.eventId === event.id).map((row) => row.playerId).filter(Boolean));
      return [
        ...lab.equipmentSnapshots.filter((row) => fieldIds.has(row.playerId)),
        ...lab.accomplishments.filter((row) => fieldIds.has(row.playerId))
      ];
    }
    return [];
  }

  function taskThreshold(task, lab, event) {
    if (task.id === "player-profiles") return lab.players.length ? 1 : 0;
    if (task.id === "event-schedule") return event ? 1 : 0;
    if (!event) return 1;
    if (task.id === "field-list") return 20;
    if (task.id === "course-profile") return 1;
    if (task.id === "round-results") return 12;
    if (task.id === "weather") return 1;
    if (task.id === "markets") return 1;
    return 1;
  }

  function taskStatus(task, count, threshold) {
    if (count >= threshold && threshold > 0) return "ready";
    if (count > 0) return "partial";
    return task.priority === "critical" ? "missing" : "needed";
  }

  function priorityRank(priority) {
    return { critical: 0, high: 1, medium: 2, low: 3 }[priority] ?? 4;
  }

  function parseDateValue(value) {
    const raw = cleanString(value);
    if (!raw) return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function latestDate(values) {
    return values
      .map(parseDateValue)
      .filter(Boolean)
      .sort((a, b) => b.getTime() - a.getTime())[0] || null;
  }

  function taskSourceNeedles(task) {
    return [
      task.id,
      task.label,
      task.sourceType,
      task.fileName,
      task.fileName && task.fileName.split(" / ")[0],
      ...(task.collectionKeys || [])
    ]
      .flatMap((value) => [value, slug(value)])
      .map(cleanString)
      .filter(Boolean)
      .map((value) => value.toLowerCase());
  }

  function sourceFetchRowsForTask(lab, event, task) {
    const needles = taskSourceNeedles(task);
    const eventNeedles = event
      ? [event.id, event.name, slug(event.id), slug(event.name)].map(cleanString).filter(Boolean).map((value) => value.toLowerCase())
      : [];
    return lab.sourceFetches.filter((row) => {
      const haystack = [
        row.id,
        row.provider,
        row.endpoint,
        row.sourceUrl,
        row.status
      ].map(cleanString).join(" ").toLowerCase();
      const taskMatch = needles.some((needle) => haystack.includes(needle));
      if (!taskMatch) return false;
      if (!eventNeedles.length) return true;
      return eventNeedles.some((needle) => haystack.includes(needle)) || !haystack.includes("event-");
    });
  }

  function sourceProofStatus(rows) {
    if (!rows.length) return "missing";
    const statuses = rows.map((row) => cleanString(row.status).toLowerCase());
    if (statuses.some((status) => ["planned", "todo", "queued", "researching"].includes(status))) return "planned";
    if (statuses.some((status) => status && !["ok", "success", "complete", "completed", "ready"].includes(status))) return "review";
    const hasFetched = rows.some((row) => cleanString(row.fetchedAt || row.sourceUpdatedAt));
    const hasSourceUrl = rows.some((row) => cleanString(row.sourceUrl));
    return hasFetched || hasSourceUrl ? "ready" : "partial";
  }

  function buildSourceProof(lab, event, task) {
    const rows = sourceFetchRowsForTask(lab, event, task);
    const latest = latestDate(rows.map((row) => row.fetchedAt || row.sourceUpdatedAt));
    const providers = [...new Set(rows.map((row) => cleanString(row.provider || row.sourceProvider)).filter(Boolean))].sort();
    const urls = [...new Set(rows.map((row) => cleanString(row.sourceUrl)).filter(Boolean))];
    const rowCount = rows.reduce((sum, row) => sum + (Number.isFinite(Number(row.rowCount)) ? Number(row.rowCount) : 0), 0);
    return {
      status: sourceProofStatus(rows),
      ledgerRows: rows.length,
      rowCount,
      providers,
      latestAt: latest ? latest.toISOString() : "",
      sourceUrls: urls,
      primarySourceUrl: urls[0] || "",
      label: rows.length
        ? `${providers[0] || "Source"}${rows.length > 1 ? ` +${rows.length - 1}` : ""}`
        : "No source ledger"
    };
  }

  function statusRank(status) {
    return { missing: 0, needed: 1, partial: 2, ready: 3 }[status] ?? 4;
  }

  function sourceOpsStatusRank(status) {
    return { blocked: 0, review: 1, stale: 2, watch: 3, planned: 4, fresh: 5, complete: 6 }[status] ?? 7;
  }

  function sourceOpsCadenceDays(task) {
    if (!task) return 10;
    if (task.id === "markets" || task.id === "weather") return 2;
    if (task.id === "field-list") return 4;
    if (task.id === "round-results") return 14;
    if (task.id === "enrichment") return 30;
    return task.priority === "critical" ? 7 : 10;
  }

  function ageDays(value, nowValue) {
    const date = parseDateValue(value);
    if (!date) return null;
    const now = parseDateValue(nowValue) || new Date();
    return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86400000));
  }

  function sourceOpsStatus(task, nowValue) {
    const proof = task.sourceProof || {};
    const proofStatus = cleanString(proof.status).toLowerCase();
    if (task.status === "missing" || task.status === "needed") return "blocked";
    if (proofStatus === "planned") return "planned";
    if (proofStatus === "review" || proofStatus === "partial" || proofStatus === "missing") return "review";
    const age = ageDays(proof.latestAt, nowValue);
    if (!Number.isFinite(age)) return "review";
    const cadence = sourceOpsCadenceDays(task);
    if (age > cadence * 2) return "stale";
    if (age > cadence) return "watch";
    return "fresh";
  }

  function sourceOpsAlert(task, status, nowValue) {
    const proof = task.sourceProof || {};
    const age = ageDays(proof.latestAt, nowValue);
    const ageText = Number.isFinite(age) ? `${age}d old` : "no timestamp";
    if (status === "blocked") {
      return {
        severity: task.priority === "critical" ? "blocker" : "warning",
        label: task.label,
        detail: `${task.status} rows for ${task.sourceType}`
      };
    }
    if (status === "review") {
      return {
        severity: task.priority === "critical" || task.priority === "high" ? "warning" : "info",
        label: task.label,
        detail: `${proof.status || "unverified"} source proof`
      };
    }
    if (status === "stale" || status === "watch") {
      return {
        severity: status === "stale" ? "warning" : "info",
        label: task.label,
        detail: `${proof.label || "Source"} is ${ageText}`
      };
    }
    if (status === "planned") {
      return {
        severity: "info",
        label: task.label,
        detail: "Source ledger is planned but not fetched"
      };
    }
    return null;
  }

  function sourceCatalogStatus(task, opsStatus) {
    const proof = task.sourceProof || {};
    if (task.status === "ready" && proof.status === "ready") return "ready";
    if (opsStatus === "stale") return "stale";
    if (task.status === "missing" || proof.status === "missing") return "missing";
    if (task.status === "needed") return "needed";
    if (proof.status === "planned") return "planned";
    if (proof.status === "partial" || task.status === "partial") return "partial";
    if (proof.status === "review" || opsStatus === "review") return "review";
    return task.status || opsStatus || "planned";
  }

  function sourceCatalogAction(task, status) {
    const proof = task.sourceProof || {};
    if (status === "ready") return "Monitor cadence and keep source ledger current.";
    if (status === "stale") return "Refresh source proof before trusting a new model run.";
    if (task.status === "missing") return `Fill ${task.fileName} with source-backed rows.`;
    if (task.status === "needed") return `Finish ${task.fileName} until the row target is met.`;
    if (proof.status === "planned") return "Replace planned ledger row with fetchedAt, rowCount, and sourceUrl.";
    if (proof.status === "partial") return "Add missing provider, URL, row count, or fetchedAt proof.";
    if (proof.status === "review") return "Review source status before using this lane.";
    return "Add source proof and keep the collection current.";
  }

  function quoteCliArg(value) {
    const text = value === null || value === undefined ? "" : String(value).trim();
    if (!text) return "";
    return /[\s"&|<>]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
  }

  function commandPartsToString(parts) {
    return parts.map(quoteCliArg).filter(Boolean).join(" ");
  }

  function adapterInputName(event, adapterType) {
    const eventSlug = slug(event && (event.name || event.id)) || "tournament";
    return `downloads/${eventSlug}-${adapterType}.csv`;
  }

  function adapterOutputDir(event) {
    const eventSlug = slug(event && (event.name || event.id)) || "tournament";
    return `data/golf-lab/${eventSlug}`;
  }

  function adapterBatchInputDir(event) {
    const eventSlug = slug(event && (event.name || event.id)) || "tournament";
    return `downloads/${eventSlug}-raw`;
  }

  function adapterBatchCommand(event, course) {
    const parts = [
      "node",
      "scripts/golf-lab-adapt.js",
      "--batch",
      adapterBatchInputDir(event),
      "--out",
      adapterOutputDir(event)
    ];
    if (event && event.id) parts.push("--event-id", event.id);
    if (event && event.name) parts.push("--event-name", event.name);
    if (event && event.courseId) parts.push("--course-id", event.courseId);
    if (course && course.name) parts.push("--course-name", course.name);
    else if (event && event.courseName) parts.push("--course-name", event.courseName);
    if (event && event.tour) parts.push("--tour", event.tour);
    if (event && event.season) parts.push("--season", event.season);
    parts.push("--provider", "Owned Research", "--source-url", "SOURCE_URL");
    return commandPartsToString(parts);
  }

  function adapterCommand(task, event, course) {
    const adapterType = SOURCE_ADAPTER_TYPES[task.id];
    if (!adapterType) return "";
    const parts = [
      "node",
      "scripts/golf-lab-adapt.js",
      "--type",
      adapterType,
      "--in",
      adapterInputName(event, adapterType),
      "--out",
      adapterOutputDir(event)
    ];
    if (event && event.id) parts.push("--event-id", event.id);
    if (event && event.name) parts.push("--event-name", event.name);
    if (event && event.courseId) parts.push("--course-id", event.courseId);
    if (course && course.name) parts.push("--course-name", course.name);
    else if (event && event.courseName) parts.push("--course-name", event.courseName);
    if (event && event.tour) parts.push("--tour", event.tour);
    if (event && event.season) parts.push("--season", event.season);
    parts.push("--provider", task.sourceType, "--source-url", "SOURCE_URL");
    return commandPartsToString(parts);
  }

  function adapterTargetFiles(task) {
    const files = new Set();
    (task.collectionKeys || []).forEach((key) => {
      const fileName = `${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}.csv`;
      files.add(key === "oddsSnapshots" ? "odds_snapshots.csv" : fileName);
    });
    files.add("source_fetches.csv");
    return [...files];
  }

  function recipeTokens(event, course) {
    return {
      eventName: cleanString(event && event.name) || "tournament",
      eventId: cleanString(event && event.id) || "event-id",
      courseName: cleanString((course && course.name) || (event && event.courseName)) || "course",
      tour: cleanString(event && event.tour) || "tour",
      season: cleanString(event && event.season) || cleanString(event && event.startDate).slice(0, 4) || "season",
      playerName: "player name"
    };
  }

  function applyRecipeTokens(value, tokens) {
    if (Array.isArray(value)) return value.map((item) => applyRecipeTokens(item, tokens));
    if (value && typeof value === "object") {
      return Object.keys(value).reduce((acc, key) => {
        acc[key] = applyRecipeTokens(value[key], tokens);
        return acc;
      }, {});
    }
    return cleanString(value).replace(/\{([a-zA-Z0-9]+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : match
    );
  }

  function sourceAcquisitionRecipe(task, event, course) {
    const adapterType = SOURCE_ADAPTER_TYPES[task.id] || "";
    const fallback = {
      publicLane: "manual",
      confidence: "source-backed",
      primarySource: task.sourceType || "Public source",
      fallbackSource: "Operator research",
      searchQuery: `${task.label || task.id} {eventName} source data`,
      captureSteps: [`Capture ${task.label || task.id} rows from a traceable source.`],
      qualityGates: ["Rows include enough source proof to be audited later."],
      proofRule: "Add provider, endpoint, fetchedAt, rowCount, and sourceUrl in source_fetches.csv.",
      premiumSignal: task.detail || "Adds source-backed context to Golf Lab."
    };
    const recipe = {
      ...fallback,
      ...(SOURCE_ACQUISITION_RECIPES[task.id] || {})
    };
    const tokens = recipeTokens(event, course);
    const hydrated = applyRecipeTokens(recipe, tokens);
    return {
      ...hydrated,
      rawFileName: adapterType ? adapterInputName(event, adapterType) : (task.suggestedFileName || task.fileName || ""),
      batchInputDir: adapterBatchInputDir(event),
      adapterType,
      proofFields: ["provider", "endpoint", "fetchedAt", "status", "rowCount", "sourceUrl"],
      expectedHeaders: adapterType ? SOURCE_ADAPTER_HEADERS[adapterType] || [] : []
    };
  }

  function intakeMode(task) {
    return SOURCE_ADAPTER_TYPES[task.id] ? "adapter" : "manual";
  }

  function intakeAction(row) {
    if (row.status === "ready" && row.sourceProofStatus === "ready") return "Keep this lane refreshed on cadence.";
    if (row.mode === "adapter") return `Export ${row.sourceType}, run the adapter, then import the generated CSVs.`;
    if (row.id === "player-profiles") return "Fill player profiles from official profile pages or OWGR exports.";
    if (row.id === "course-profile") return "Fill course and setup rows from scorecards, setup notes, and tournament pages.";
    return "Fill the target collection manually, then add provenance in source_fetches.csv.";
  }

  function numericScore(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, Math.round(number)));
  }

  function activationLaneStatus(score, critical = false) {
    const value = numericScore(score);
    if (value >= 85) return { key: "ready", label: "Ready" };
    if (value >= 65) return { key: "watch", label: "Watch" };
    if (value >= 35) return { key: "building", label: "Building" };
    return critical ? { key: "blocked", label: "Blocked" } : { key: "missing", label: "Missing" };
  }

  function activationScoreForTask(task) {
    const rowScore = task.threshold > 0 ? Math.min(100, Math.round((task.rowCount / task.threshold) * 100)) : 0;
    const proofScore = task.sourceProof && task.sourceProof.status === "ready"
      ? 100
      : task.sourceProof && task.sourceProof.status === "planned"
        ? 45
        : task.sourceProof && task.sourceProof.status === "partial"
          ? 65
          : 0;
    return numericScore((rowScore * 0.68) + (proofScore * 0.32));
  }

  function activeFieldRows(lab, event) {
    if (!event) return [];
    return lab.fields.filter((row) => row.eventId === event.id && cleanString(row.status || "active").toLowerCase() !== "withdrawn");
  }

  function eventPredictionRows(lab, event) {
    if (!event) return [];
    return [...lab.predictionLedger, ...lab.modelPredictions].filter((row) => row.eventId === event.id);
  }

  function activationStatus(score, lanes) {
    const criticalBlockers = lanes.filter((lane) => lane.critical && lane.status === "blocked").length;
    const modelLane = lanes.find((lane) => lane.id === "model-output");
    if (criticalBlockers > 1) return { key: "blocked", label: "Blocked" };
    if (criticalBlockers) return { key: "source-blocked", label: "Source Blocked" };
    if (modelLane && modelLane.status !== "ready") return { key: "ready-to-model", label: "Ready To Model" };
    if (score >= 85) return { key: "premium-ready", label: "Premium Ready" };
    if (score >= 65) return { key: "building", label: "Building" };
    return { key: "thin", label: "Thin" };
  }

  function activationNextAction(lane) {
    if (!lane) return "";
    if (lane.status === "ready") return `Keep ${lane.label} refreshed.`;
    if (lane.task && lane.task.nextAction) return lane.task.nextAction;
    if (lane.command) return `Run ${lane.command}`;
    return lane.nextAction || `Resolve ${lane.label}.`;
  }

  function buildTournamentActivationPlan(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const now = cleanString(options.now || options.createdAt) || new Date().toISOString();
    const plan = buildEventSourcePlan(lab, options);
    const event = plan.event;
    const course = courseForEvent(lab, event);
    const opsBoard = buildSourceOpsBoard(lab, { ...options, now });
    const dataIntakeBoard = buildDataIntakeBoard(lab, { ...options, now });
    const warehouseReport = Warehouse.buildWarehouseReport(lab, { now });
    const lineageBoard = Warehouse.buildSourceLineageBoard(lab, {
      eventId: event ? event.id : "",
      now
    });
    const fieldRows = activeFieldRows(lab, event);
    const fieldIds = new Set(fieldRows.map((row) => cleanString(row.playerId || row.playerName).toLowerCase()).filter(Boolean));
    const matchedFieldPlayers = fieldRows.filter((field) => {
      const id = cleanString(field.playerId || field.playerName).toLowerCase();
      const name = cleanString(field.playerName).toLowerCase();
      return lab.players.some((player) =>
        cleanString(player.id).toLowerCase() === id ||
        cleanString(player.name).toLowerCase() === id ||
        (name && cleanString(player.name).toLowerCase() === name)
      );
    }).length;
    const roundRows = event ? lab.rounds.filter((row) => row.eventId === event.id) : [];
    const sgRows = event ? lab.strokesGained.filter((row) => row.eventId === event.id) : [];
    const weatherRows = event ? lab.weatherSnapshots.filter((row) => row.eventId === event.id) : [];
    const marketRows = event ? lab.oddsSnapshots.filter((row) => row.eventId === event.id) : [];
    const predictionRows = eventPredictionRows(lab, event);
    const sourceRows = eventSourceLedgerRows(lab, event);
    const sourceTasksById = new Map(plan.tasks.map((task) => [task.id, task]));
    const intakeRowsById = new Map(dataIntakeBoard.rows.map((row) => [row.id, row]));
    const laneFromTask = (id, label, critical = false) => {
      const task = sourceTasksById.get(id) || {};
      const intake = intakeRowsById.get(id) || {};
      const score = activationScoreForTask(task);
      const status = activationLaneStatus(score, critical);
      return {
        id,
        label,
        group: "source",
        critical,
        score,
        status: status.key,
        statusLabel: status.label,
        detail: `${task.rowCount || 0}/${task.threshold || 0} rows | ${(task.sourceProof && task.sourceProof.status) || "missing"} proof`,
        nextAction: intake.nextAction || sourceCatalogAction(task, sourceCatalogStatus(task, sourceOpsStatus(task, now))),
        command: intake.command || "",
        targetFiles: intake.targetFiles || [],
        task
      };
    };
    const fieldCoverageScore = fieldRows.length ? Math.round((matchedFieldPlayers / fieldRows.length) * 100) : 0;
    const featureHistoryScore = Math.min(100, Math.round(((roundRows.length + sgRows.length) / 24) * 100));
    const modelScore = fieldRows.length
      ? Math.round(Math.min(1, predictionRows.length / fieldRows.length) * 100)
      : predictionRows.length ? 100 : 0;
    const lanes = [
      laneFromTask("event-schedule", "Tournament Anchor", true),
      laneFromTask("player-profiles", "Player Profiles", true),
      laneFromTask("field-list", "Official Field", true),
      laneFromTask("course-profile", "Course + Setup", true),
      laneFromTask("round-results", "Round + SG History", true),
      laneFromTask("weather", "Weather", false),
      laneFromTask("markets", "Markets", false),
      laneFromTask("enrichment", "Enrichment", false),
      {
        id: "field-matching",
        label: "Field Matching",
        group: "model",
        critical: true,
        score: fieldCoverageScore,
        status: activationLaneStatus(fieldCoverageScore, true).key,
        statusLabel: activationLaneStatus(fieldCoverageScore, true).label,
        detail: `${matchedFieldPlayers}/${fieldRows.length} field players matched`,
        nextAction: "Normalize field player IDs against players.csv.",
        command: "",
        targetFiles: ["players.csv", "fields.csv"]
      },
      {
        id: "feature-history",
        label: "Feature History",
        group: "model",
        critical: true,
        score: featureHistoryScore,
        status: activationLaneStatus(featureHistoryScore, true).key,
        statusLabel: activationLaneStatus(featureHistoryScore, true).label,
        detail: `${roundRows.length} rounds | ${sgRows.length} SG rows`,
        nextAction: "Import leaderboard and strokes-gained history for the field.",
        command: (intakeRowsById.get("round-results") || {}).command || "",
        targetFiles: ["rounds.csv", "strokes_gained.csv"]
      },
      {
        id: "model-output",
        label: "Model Output",
        group: "model",
        critical: false,
        score: modelScore,
        status: activationLaneStatus(modelScore, false).key,
        statusLabel: activationLaneStatus(modelScore, false).label,
        detail: `${predictionRows.length}/${fieldRows.length || predictionRows.length || 1} modeled rows`,
        nextAction: "Run the owned model after critical source lanes clear.",
        command: "",
        targetFiles: ["model_predictions.csv", "prediction_ledger.csv"]
      }
    ];
    const phaseRows = [
      {
        id: "source",
        label: "Source Proof",
        score: numericScore((plan.score * 0.55) + (opsBoard.proofScore * 0.45)),
        detail: `${plan.readyCount}/${plan.totalTasks} source lanes ready | ${opsBoard.summary.proofReady} proof-ready`
      },
      {
        id: "intake",
        label: "Data Intake",
        score: dataIntakeBoard.score,
        detail: `${dataIntakeBoard.summary.commandsReady} adapter commands | ${dataIntakeBoard.summary.missing} missing lanes`
      },
      {
        id: "warehouse",
        label: "Warehouse",
        score: warehouseReport.score,
        detail: `${warehouseReport.totalRecords} records | ${warehouseReport.grade}`
      },
      {
        id: "model",
        label: "Model Activation",
        score: numericScore((fieldCoverageScore * 0.34) + (featureHistoryScore * 0.33) + (modelScore * 0.33)),
        detail: `${matchedFieldPlayers}/${fieldRows.length} matched | ${predictionRows.length} predictions`
      }
    ].map((phase) => {
      const status = activationLaneStatus(phase.score, phase.id !== "model");
      return {
        ...phase,
        status: status.key,
        statusLabel: status.label
      };
    });
    const score = numericScore((phaseRows.reduce((sum, row) => sum + row.score, 0) / Math.max(1, phaseRows.length)));
    const status = activationStatus(score, lanes);
    const unresolvedLanes = lanes
      .filter((lane) => lane.status !== "ready")
      .sort((a, b) =>
        Number(b.critical) - Number(a.critical) ||
        a.score - b.score ||
        cleanString(a.label).localeCompare(cleanString(b.label))
      );
    const commands = dataIntakeBoard.rows
      .filter((row) => row.command && row.status !== "ready")
      .slice(0, 5)
      .map((row) => ({
        id: row.id,
        label: row.label,
        adapterType: row.adapterType,
        command: row.command,
        targetFiles: row.targetFiles,
        nextAction: row.nextAction
      }));
    const nextActions = unresolvedLanes.slice(0, 6).map((lane) => ({
      id: lane.id,
      label: lane.label,
      priority: lane.critical ? "critical" : "standard",
      status: lane.status,
      score: lane.score,
      detail: lane.detail,
      nextAction: activationNextAction(lane),
      command: lane.command || ""
    }));
    return {
      version: SOURCE_PLAN_VERSION,
      generatedAt: now,
      event,
      course,
      status: status.key,
      statusLabel: status.label,
      score,
      summary: {
        phases: phaseRows.length,
        lanes: lanes.length,
        readyLanes: lanes.filter((lane) => lane.status === "ready").length,
        criticalBlockers: lanes.filter((lane) => lane.critical && lane.status === "blocked").length,
        sourceScore: plan.score,
        opsScore: opsBoard.opsScore,
        dataIntakeScore: dataIntakeBoard.score,
        warehouseScore: warehouseReport.score,
        lineageScore: lineageBoard.summary ? lineageBoard.summary.proofScore || 0 : 0,
        fieldRows: fieldRows.length,
        matchedFieldPlayers,
        uniqueFieldPlayers: fieldIds.size,
        roundRows: roundRows.length,
        strokesGainedRows: sgRows.length,
        weatherRows: weatherRows.length,
        marketRows: marketRows.length,
        predictionRows: predictionRows.length,
        sourceLedgerRows: sourceRows.length,
        adapterCommands: commands.length
      },
      phases: phaseRows,
      lanes,
      nextActions,
      commands,
      targetFiles: [...new Set(dataIntakeBoard.rows.flatMap((row) => row.targetFiles || []))],
      blockers: nextActions.filter((row) => row.priority === "critical").map((row) => row.label)
    };
  }

  function buildAcquisitionRunbook(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const now = cleanString(options.now || options.createdAt) || new Date().toISOString();
    const plan = buildEventSourcePlan(lab, options);
    const event = plan.event;
    const course = courseForEvent(lab, event);
    const rows = plan.tasks.map((task) => {
      const adapterType = SOURCE_ADAPTER_TYPES[task.id] || "";
      const mode = intakeMode(task);
      const opsStatus = sourceOpsStatus(task, now);
      const status = sourceCatalogStatus(task, opsStatus);
      const recipe = sourceAcquisitionRecipe(task, event, course);
      const proof = task.sourceProof || {};
      return {
        id: task.id,
        label: task.label,
        priority: task.priority,
        mode,
        adapterType,
        status,
        taskStatus: task.status,
        sourceProofStatus: proof.status || "missing",
        publicLane: recipe.publicLane,
        confidence: recipe.confidence,
        primarySource: recipe.primarySource,
        fallbackSource: recipe.fallbackSource,
        searchQuery: recipe.searchQuery,
        rawFileName: recipe.rawFileName,
        batchInputDir: recipe.batchInputDir,
        proofRule: recipe.proofRule,
        proofFields: recipe.proofFields,
        qualityGates: recipe.qualityGates,
        captureSteps: recipe.captureSteps,
        premiumSignal: recipe.premiumSignal,
        command: adapterCommand(task, event, course),
        targetFiles: adapterTargetFiles(task),
        nextAction: intakeAction({
          ...task,
          mode,
          status,
          sourceProofStatus: proof.status || "missing",
          sourceType: task.sourceType
        })
      };
    }).sort((a, b) =>
      statusRank(a.taskStatus) - statusRank(b.taskStatus) ||
      priorityRank(a.priority) - priorityRank(b.priority) ||
      cleanString(a.label).localeCompare(cleanString(b.label))
    );
    const publicFirstRows = rows.filter((row) => row.publicLane === "free").length;
    const officialFirstRows = rows.filter((row) => cleanString(row.confidence).includes("official")).length;
    const proofReadyRows = rows.filter((row) => row.sourceProofStatus === "ready").length;
    return {
      version: SOURCE_PLAN_VERSION,
      generatedAt: now,
      event,
      course,
      batchInputDir: adapterBatchInputDir(event),
      batchCommand: adapterBatchCommand(event, course),
      summary: {
        lanes: rows.length,
        publicFirst: publicFirstRows,
        mixedCost: rows.filter((row) => row.publicLane === "mixed").length,
        officialFirst: officialFirstRows,
        proofReady: proofReadyRows,
        needsProof: rows.length - proofReadyRows,
        adapterLanes: rows.filter((row) => row.mode === "adapter").length,
        priorityLanes: rows.filter((row) => row.status !== "ready").length
      },
      rows,
      nextActions: rows.filter((row) => row.status !== "ready").slice(0, 5)
    };
  }

  function buildDataIntakeBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const now = cleanString(options.now || options.createdAt) || new Date().toISOString();
    const plan = buildEventSourcePlan(lab, options);
    const event = plan.event;
    const course = courseForEvent(lab, event);
    const rows = plan.tasks.map((task) => {
      const adapterType = SOURCE_ADAPTER_TYPES[task.id] || "";
      const mode = intakeMode(task);
      const proof = task.sourceProof || {};
      const command = adapterCommand(task, event, course);
      const headers = adapterType ? SOURCE_ADAPTER_HEADERS[adapterType] || [] : [];
      const status = sourceCatalogStatus(task, sourceOpsStatus(task, now));
      const recipe = sourceAcquisitionRecipe(task, event, course);
      return {
        id: task.id,
        label: task.label,
        priority: task.priority,
        mode,
        adapterType,
        status,
        taskStatus: task.status,
        sourceProofStatus: proof.status || "missing",
        sourceType: task.sourceType,
        command,
        sampleInputFile: adapterType ? adapterInputName(event, adapterType) : "",
        rawFileName: recipe.rawFileName,
        outputDir: adapterOutputDir(event),
        targetFiles: adapterTargetFiles(task),
        collectionFiles: task.fileName,
        suggestedFileName: task.suggestedFileName,
        requiredHeaders: headers,
        sourceRecipe: {
          publicLane: recipe.publicLane,
          confidence: recipe.confidence,
          primarySource: recipe.primarySource,
          fallbackSource: recipe.fallbackSource,
          searchQuery: recipe.searchQuery,
          proofRule: recipe.proofRule,
          qualityGates: recipe.qualityGates,
          premiumSignal: recipe.premiumSignal
        },
        cadenceDays: sourceOpsCadenceDays(task),
        rowCount: task.rowCount,
        threshold: task.threshold,
        sourceRows: proof.rowCount || 0,
        ledgerRows: proof.ledgerRows || 0,
        sourceUrl: proof.primarySourceUrl || "",
        nextAction: intakeAction({
          ...task,
          mode,
          status,
          sourceProofStatus: proof.status || "missing",
          sourceType: task.sourceType
        })
      };
    }).sort((a, b) =>
      (a.mode === "adapter" ? 0 : 1) - (b.mode === "adapter" ? 0 : 1) ||
      priorityRank(a.priority) - priorityRank(b.priority) ||
      statusRank(a.taskStatus) - statusRank(b.taskStatus) ||
      cleanString(a.label).localeCompare(cleanString(b.label))
    );
    const adapterRows = rows.filter((row) => row.mode === "adapter");
    const readyRows = rows.filter((row) => row.status === "ready").length;
    const proofReadyRows = rows.filter((row) => row.sourceProofStatus === "ready").length;
    const commandsReady = adapterRows.filter((row) => row.command).length;
    return {
      version: SOURCE_PLAN_VERSION,
      generatedAt: now,
      event,
      course,
      outputDir: adapterOutputDir(event),
      batchInputDir: adapterBatchInputDir(event),
      batchCommand: adapterBatchCommand(event, course),
      batchFileHints: ["schedule", "profiles", "field", "course", "leaderboard", "odds", "weather", "enrichment"],
      score: Math.round((plan.score * 0.45) + (rows.length ? (proofReadyRows / rows.length) * 35 : 0) + (adapterRows.length ? (commandsReady / adapterRows.length) * 20 : 0)),
      summary: {
        lanes: rows.length,
        adapterLanes: adapterRows.length,
        manualLanes: rows.length - adapterRows.length,
        commandsReady,
        ready: readyRows,
        proofReady: proofReadyRows,
        missing: rows.filter((row) => row.status === "missing" || row.status === "needed").length
      },
      rows,
      priorityRows: rows.filter((row) => row.status !== "ready").slice(0, 5)
    };
  }

  function rawTemplateCsv(headers) {
    return `${(headers || []).map((header) => `"${String(header || "").replace(/"/g, '""')}"`).join(",")}\n`;
  }

  function buildDataIntakePacket(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const createdAt = cleanString(options.createdAt || options.now) || new Date().toISOString();
    const board = buildDataIntakeBoard(lab, { ...options, now: createdAt });
    const acquisitionRunbook = buildAcquisitionRunbook(lab, { ...options, now: createdAt });
    const warehouseReport = Warehouse.buildWarehouseReport(lab, { now: createdAt });
    const adapterRows = board.rows.filter((row) => row.mode === "adapter");
    const manualRows = board.rows.filter((row) => row.mode !== "adapter");
    return {
      meta: {
        template: "Golf Lab data intake packet",
        version: SOURCE_PLAN_VERSION,
        createdAt,
        eventId: board.event ? board.event.id || "" : "",
        eventName: board.event ? board.event.name || "" : "",
        outputDir: board.outputDir,
        batchInputDir: board.batchInputDir,
        batchCommand: board.batchCommand,
        note: "Use batchCommand for a one-pass event ingest, or adapterCommands and rawTemplates for lane-by-lane control. Replace SOURCE_URL with the actual source URL before running commands."
      },
      event: board.event,
      course: board.course,
      dataIntakeBoard: board,
      acquisitionRunbook,
      adapterCommands: adapterRows.map((row) => ({
        id: row.id,
        label: row.label,
        adapterType: row.adapterType,
        command: row.command,
        sampleInputFile: row.sampleInputFile,
        rawFileName: row.rawFileName,
        outputDir: row.outputDir,
        sourceType: row.sourceType,
        primarySource: row.sourceRecipe ? row.sourceRecipe.primarySource : "",
        proofRule: row.sourceRecipe ? row.sourceRecipe.proofRule : "",
        targetFiles: row.targetFiles,
        requiredHeaders: row.requiredHeaders,
        nextAction: row.nextAction
      })),
      rawTemplates: adapterRows.map((row) => ({
        id: row.id,
        label: row.label,
        adapterType: row.adapterType,
        fileName: row.sampleInputFile,
        sourceRecipe: row.sourceRecipe,
        headers: row.requiredHeaders,
        csv: rawTemplateCsv(row.requiredHeaders),
        targetFiles: row.targetFiles
      })),
      manualTemplates: manualRows.map((row) => ({
        id: row.id,
        label: row.label,
        sourceType: row.sourceType,
        collectionFiles: row.collectionFiles,
        sourceRecipe: row.sourceRecipe,
        targetFiles: row.targetFiles,
        collectionColumns: row.targetFiles.reduce((acc, fileName) => {
          const collectionKey = Warehouse.collectionKeyFromFileName(fileName);
          if (collectionKey) acc[collectionKey] = Warehouse.COLLECTION_COLUMNS[collectionKey] || [];
          return acc;
        }, {}),
        nextAction: row.nextAction
      })),
      sourceProofChecklist: board.rows.map((row) => ({
        id: row.id,
        label: row.label,
        status: row.status,
        sourceProofStatus: row.sourceProofStatus,
        sourceType: row.sourceType,
        primarySource: row.sourceRecipe ? row.sourceRecipe.primarySource : "",
        proofRule: row.sourceRecipe ? row.sourceRecipe.proofRule : "",
        qualityGates: row.sourceRecipe ? row.sourceRecipe.qualityGates : [],
        requiredFields: ["provider", "endpoint", "fetchedAt", "status", "rowCount", "sourceUrl"],
        ledgerFile: "source_fetches.csv",
        nextAction: row.nextAction
      })),
      importChecklist: [
        "Save raw source exports in the batchInputDir with file names containing schedule, profiles, field, course, leaderboard, odds, weather, or enrichment.",
        "Use acquisitionRunbook rows to pick the primary public source, capture steps, proof rule, and quality gates for each lane.",
        "Run batchCommand for a one-pass ingest, or save each raw source export as the packet fileName for lane-by-lane commands.",
        "Replace SOURCE_URL in adapter commands with the actual source URL.",
        "Run adapter commands from the project root.",
        "Import the generated collection CSV files in Golf Lab or build a JSON bundle with golf-lab-build.js.",
        "Confirm Source Audit and Warehouse Workbench scores before trusting predictions."
      ],
      warehouseHealth: {
        score: warehouseReport.score,
        grade: warehouseReport.grade,
        totalRecords: warehouseReport.totalRecords,
        latestSourceAt: warehouseReport.latestSourceAt,
        gaps: warehouseReport.gaps,
        validation: warehouseReport.validation,
        sourceFreshness: warehouseReport.sourceFreshness
      }
    };
  }

  function buildSourceTask(task, lab, event) {
    const rows = sourceRowsForTask(lab, event, task);
    const threshold = taskThreshold(task, lab, event);
    const status = taskStatus(task, rows.length, threshold);
    const sourceProof = buildSourceProof(lab, event, task);
    const columns = task.collectionKeys.reduce((acc, key) => {
      acc[key] = Warehouse.COLLECTION_COLUMNS[key] || [];
      return acc;
    }, {});
    return {
      ...task,
      status,
      rowCount: rows.length,
      threshold,
      columns,
      sourceProof,
      suggestedFileName: event ? `${slug(event.name || event.id)}-${task.fileName.split(" / ")[0]}` : task.fileName.split(" / ")[0]
    };
  }

  function buildEventSourcePlan(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const event = chooseEvent(lab, options.eventId);
    const tasks = SOURCE_PLAYBOOK.map((task) => buildSourceTask(task, lab, event))
      .sort((a, b) =>
        statusRank(a.status) - statusRank(b.status) ||
        priorityRank(a.priority) - priorityRank(b.priority) ||
        cleanString(a.label).localeCompare(cleanString(b.label))
      );
    const readyCount = tasks.filter((task) => task.status === "ready").length;
    const sourceReadyCount = tasks.filter((task) => task.sourceProof.status === "ready").length;
    return {
      version: SOURCE_PLAN_VERSION,
      event,
      score: Math.round((readyCount / tasks.length) * 100),
      readyCount,
      sourceReadyCount,
      totalTasks: tasks.length,
      tasks,
      nextActions: tasks.filter((task) => task.status !== "ready").slice(0, 4)
    };
  }

  function buildSourceOpsBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const now = cleanString(options.now || options.createdAt) || new Date().toISOString();
    const plan = buildEventSourcePlan(lab, options);
    const warehouseReport = Warehouse.buildWarehouseReport(lab, { now });
    const freshness = warehouseReport.sourceFreshness || {};
    const taskRows = plan.tasks.map((task) => {
      const status = sourceOpsStatus(task, now);
      const cadenceDays = sourceOpsCadenceDays(task);
      const latestAgeDays = ageDays(task.sourceProof && task.sourceProof.latestAt, now);
      return {
        id: task.id,
        label: task.label,
        priority: task.priority,
        sourceType: task.sourceType,
        status,
        taskStatus: task.status,
        cadenceDays,
        latestAgeDays,
        rowCount: task.rowCount,
        threshold: task.threshold,
        sourceProof: task.sourceProof,
        suggestedFileName: task.suggestedFileName,
        alert: sourceOpsAlert(task, status, now)
      };
    }).sort((a, b) =>
      sourceOpsStatusRank(a.status) - sourceOpsStatusRank(b.status) ||
      priorityRank(a.priority) - priorityRank(b.priority) ||
      cleanString(a.label).localeCompare(cleanString(b.label))
    );
    const alerts = [
      ...taskRows.map((task) => task.alert).filter(Boolean),
      ...(freshness.providers || [])
        .filter((provider) => provider.freshness === "stale" || provider.status === "review")
        .map((provider) => ({
          severity: provider.freshness === "stale" ? "warning" : "info",
          label: provider.provider,
          detail: `${provider.status || provider.freshness} provider | ${provider.rowCount || 0} rows`
        })),
      freshness.provenanceCoverage < 50 && freshness.auditedRowCount ? {
        severity: "warning",
        label: "Collection provenance",
        detail: `${freshness.provenanceCoverage}% sourced rows`
      } : null
    ].filter(Boolean).sort((a, b) => {
      const order = { blocker: 0, warning: 1, info: 2 };
      return (order[a.severity] ?? 3) - (order[b.severity] ?? 3) ||
        cleanString(a.label).localeCompare(cleanString(b.label));
    });
    const recentFetches = [...lab.sourceFetches]
      .sort((a, b) => cleanString(b.fetchedAt || b.sourceUpdatedAt).localeCompare(cleanString(a.fetchedAt || a.sourceUpdatedAt)))
      .slice(0, Number.isFinite(Number(options.recentRows)) ? Number(options.recentRows) : 8)
      .map((row) => ({
        provider: cleanString(row.provider || row.sourceProvider || "Unknown"),
        endpoint: cleanString(row.endpoint),
        fetchedAt: cleanString(row.fetchedAt || row.sourceUpdatedAt),
        ageDays: ageDays(row.fetchedAt || row.sourceUpdatedAt, now),
        status: cleanString(row.status || "ok") || "ok",
        rowCount: Number.isFinite(Number(row.rowCount)) ? Number(row.rowCount) : 0,
        sourceUrl: cleanString(row.sourceUrl)
      }));
    const proofReadyCount = taskRows.filter((task) => task.sourceProof.status === "ready").length;
    const blockedCount = taskRows.filter((task) => task.status === "blocked").length;
    const watchCount = taskRows.filter((task) => task.status === "watch" || task.status === "planned" || task.status === "review").length;
    const staleCount = taskRows.filter((task) => task.status === "stale").length;
    const proofScore = plan.totalTasks ? Math.round((proofReadyCount / plan.totalTasks) * 100) : 0;
    const sourceQuality = Number.isFinite(Number(freshness.qualityScore)) ? Number(freshness.qualityScore) : 0;
    const opsScore = Math.round((plan.score * 0.4) + (sourceQuality * 0.35) + (proofScore * 0.25));
    return {
      version: SOURCE_PLAN_VERSION,
      generatedAt: now,
      event: plan.event,
      planScore: plan.score,
      sourceQuality,
      proofScore,
      opsScore,
      warehouseReport: {
        score: warehouseReport.score,
        grade: warehouseReport.grade,
        latestSourceAt: warehouseReport.latestSourceAt
      },
      summary: {
        tasks: taskRows.length,
        readyTasks: plan.readyCount,
        proofReady: proofReadyCount,
        blocked: blockedCount,
        watch: watchCount,
        stale: staleCount,
        alerts: alerts.length,
        latestSourceAt: freshness.latestSourceAt || "",
        provenanceCoverage: freshness.provenanceCoverage || 0,
        providerCount: freshness.providerCount || 0
      },
      tasks: taskRows,
      alerts,
      providers: (freshness.providers || []).slice(0, 8),
      collections: (freshness.collections || []).filter((row) => row.rowCount > 0).slice(0, 10),
      recentFetches,
      sourcePlan: plan
    };
  }

  function buildSourceCatalogBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const now = cleanString(options.now || options.createdAt) || new Date().toISOString();
    const plan = buildEventSourcePlan(lab, options);
    const rows = plan.tasks.map((task) => {
      const proof = task.sourceProof || {};
      const opsStatus = sourceOpsStatus(task, now);
      const status = sourceCatalogStatus(task, opsStatus);
      const targetCollections = task.collectionKeys.map((key) => ({
        key,
        label: key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase())
      }));
      return {
        id: task.id,
        label: task.label,
        priority: task.priority,
        status,
        taskStatus: task.status,
        opsStatus,
        sourceProofStatus: proof.status || "missing",
        sourceType: task.sourceType,
        cadenceDays: sourceOpsCadenceDays(task),
        targetCollections,
        collectionFiles: task.fileName,
        suggestedFileName: task.suggestedFileName,
        rowCount: task.rowCount,
        threshold: task.threshold,
        progress: task.threshold > 0 ? Math.min(100, Math.round((task.rowCount / task.threshold) * 100)) : 0,
        sourceUrl: cleanString(proof.primarySourceUrl),
        providers: proof.providers || [],
        latestAt: cleanString(proof.latestAt),
        latestAgeDays: ageDays(proof.latestAt, now),
        ledgerRows: proof.ledgerRows || 0,
        sourceRows: proof.rowCount || 0,
        notes: task.detail,
        nextAction: sourceCatalogAction(task, status)
      };
    }).sort((a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      statusRank(a.taskStatus) - statusRank(b.taskStatus) ||
      cleanString(a.label).localeCompare(cleanString(b.label))
    );
    const readyRows = rows.filter((row) => row.status === "ready").length;
    const proofReadyRows = rows.filter((row) => row.sourceProofStatus === "ready").length;
    const targetFileCount = new Set(rows.flatMap((row) =>
      cleanString(row.collectionFiles).split("/").map((file) => cleanString(file)).filter(Boolean)
    )).size;
    return {
      version: SOURCE_PLAN_VERSION,
      generatedAt: now,
      event: plan.event,
      score: Math.round((plan.score * 0.55) + (rows.length ? (proofReadyRows / rows.length) * 45 : 0)),
      summary: {
        tasks: rows.length,
        ready: readyRows,
        proofReady: proofReadyRows,
        sourceUrls: rows.filter((row) => row.sourceUrl).length,
        targetFiles: targetFileCount,
        critical: rows.filter((row) => row.priority === "critical").length,
        high: rows.filter((row) => row.priority === "high").length,
        planned: rows.filter((row) => row.status === "planned").length,
        missing: rows.filter((row) => row.status === "missing" || row.status === "needed").length
      },
      rows,
      nextActions: rows.filter((row) => row.status !== "ready").slice(0, 5)
    };
  }

  function eventStage(event, nowValue) {
    const start = parseDateValue(event && event.startDate);
    const now = parseDateValue(nowValue) || new Date();
    if (!start) return "unscheduled";
    const daysUntil = Math.ceil((start.getTime() - now.getTime()) / 86400000);
    if (daysUntil < -7) return "historical";
    if (daysUntil <= 7) return "active-window";
    return "upcoming";
  }

  function backfillTaskWeight(task) {
    const base = { critical: 18, high: 15, medium: 9, low: 5 }[task.priority] || 6;
    const multiplier = { missing: 1, needed: 0.85, partial: 0.55, ready: 0 }[task.status] ?? 0.5;
    return base * multiplier;
  }

  function backfillAction(task) {
    const proof = task.sourceProof || {};
    if (task.status !== "ready") return `Backfill ${task.label} into ${task.fileName}.`;
    if (proof.status !== "ready") return `Add source proof for ${task.label}.`;
    return `Maintain ${task.label} cadence.`;
  }

  function eventSourceLedgerRows(lab, event) {
    if (!event) return [];
    const eventId = cleanString(event.id);
    const eventName = cleanString(event.name).toLowerCase();
    return lab.sourceFetches.filter((row) => {
      const haystack = [
        row.id,
        row.endpoint,
        row.sourceUrl,
        row.notes
      ].map((value) => cleanString(value).toLowerCase()).join(" ");
      return (eventId && haystack.includes(eventId.toLowerCase())) || (eventName && haystack.includes(eventName));
    });
  }

  function buildHistoricalBackfillBoard(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const now = cleanString(options.now || options.createdAt) || new Date().toISOString();
    const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 8;
    const allRows = lab.events.map((event) => {
      const tasks = SOURCE_PLAYBOOK.map((task) => buildSourceTask(task, lab, event));
      const missingTasks = tasks.filter((task) => task.status !== "ready");
      const proofMissingTasks = tasks.filter((task) => task.sourceProof.status !== "ready");
      const readyCount = tasks.length - missingTasks.length;
      const proofReadyCount = tasks.length - proofMissingTasks.length;
      const stage = eventStage(event, now);
      const fieldRows = lab.fields.filter((row) => row.eventId === event.id);
      const roundRows = lab.rounds.filter((row) => row.eventId === event.id);
      const sgRows = lab.strokesGained.filter((row) => row.eventId === event.id);
      const weatherRows = lab.weatherSnapshots.filter((row) => row.eventId === event.id);
      const marketRows = lab.oddsSnapshots.filter((row) => row.eventId === event.id);
      const sourceRows = eventSourceLedgerRows(lab, event);
      const course = courseForEvent(lab, event);
      const score = Math.min(100, Math.round(
        missingTasks.reduce((sum, task) => sum + backfillTaskWeight(task), 0) +
        (proofMissingTasks.length * 3) +
        (stage === "historical" ? 8 : 0)
      ));
      const nextTask = missingTasks[0] || proofMissingTasks[0] || tasks[0];
      const missingAdapterTypes = [...new Set(missingTasks.map((task) => SOURCE_ADAPTER_TYPES[task.id]).filter(Boolean))];
      const targetFiles = [...new Set(missingTasks.flatMap((task) => adapterTargetFiles(task)))];
      return {
        eventId: event.id,
        eventName: event.name || event.id || "Tournament",
        tour: event.tour || "",
        season: event.season || "",
        startDate: event.startDate || "",
        courseId: event.courseId || "",
        courseName: event.courseName || "",
        stage,
        priorityScore: score,
        readinessScore: tasks.length ? Math.round((readyCount / tasks.length) * 100) : 0,
        proofScore: tasks.length ? Math.round((proofReadyCount / tasks.length) * 100) : 0,
        counts: {
          field: fieldRows.length,
          rounds: roundRows.length,
          strokesGained: sgRows.length,
          weather: weatherRows.length,
          markets: marketRows.length,
          sourceLedger: sourceRows.length
        },
        batchInputDir: adapterBatchInputDir(event),
        outputDir: adapterOutputDir(event),
        batchCommand: adapterBatchCommand(event, course),
        batchFileHints: ["schedule", "profiles", "field", "course", "leaderboard", "odds", "weather", "enrichment"],
        missingAdapterTypes,
        targetFiles,
        missingLanes: missingTasks.slice(0, 5).map((task) => ({
          id: task.id,
          label: task.label,
          priority: task.priority,
          status: task.status,
          fileName: task.fileName
        })),
        proofGaps: proofMissingTasks.slice(0, 5).map((task) => ({
          id: task.id,
          label: task.label,
          status: task.sourceProof.status
        })),
        nextAction: nextTask ? backfillAction(nextTask) : "Maintain event source cadence."
      };
    }).sort((a, b) =>
      b.priorityScore - a.priorityScore ||
      (a.stage === "historical" ? -1 : 0) - (b.stage === "historical" ? -1 : 0) ||
      cleanString(b.startDate).localeCompare(cleanString(a.startDate))
    );
    const modelReadyEvents = allRows.filter((row) =>
      row.counts.field > 0 &&
      row.counts.rounds > 0 &&
      row.counts.strokesGained > 0 &&
      row.counts.weather > 0
    ).length;
    const proofReadyEvents = allRows.filter((row) => row.proofScore === 100).length;
    return {
      version: SOURCE_PLAN_VERSION,
      generatedAt: now,
      summary: {
        events: allRows.length,
        historicalEvents: allRows.filter((row) => row.stage === "historical").length,
        modelReadyEvents,
        proofReadyEvents,
        priorityEvents: allRows.filter((row) => row.priorityScore >= 60).length,
        missingRoundResults: allRows.filter((row) => row.counts.rounds === 0 || row.counts.strokesGained === 0).length,
        missingWeather: allRows.filter((row) => row.counts.weather === 0).length,
        missingMarkets: allRows.filter((row) => row.counts.markets === 0).length,
        batchCommands: allRows.filter((row) => row.priorityScore > 0 && row.batchCommand).length
      },
      rows: allRows.slice(0, limit),
      nextActions: allRows.filter((row) => row.priorityScore > 0).slice(0, 5)
    };
  }

  function buildEventResearchPacket(input, options = {}) {
    const lab = GolfLab.normalizeGolfLabState(input);
    const plan = buildEventSourcePlan(lab, options);
    const acquisitionRunbook = buildAcquisitionRunbook(lab, options);
    const warehouseReport = Warehouse.buildWarehouseReport(lab, {
      now: cleanString(options.createdAt) || undefined
    });
    const event = plan.event;
    const packetLab = GolfLab.blankGolfLabState();
    if (event) packetLab.events = [event];
    const course = event ? courseForEvent(lab, event) : null;
    if (course) packetLab.courses = [course];
    return {
      meta: {
        template: "Golf Lab event research packet",
        version: SOURCE_PLAN_VERSION,
        createdAt: cleanString(options.createdAt) || new Date().toISOString(),
        eventId: event ? event.id : "",
        eventName: event ? event.name : "",
        note: "Use the sourcePlan tasks and collectionColumns to gather source-backed rows. Import completed CSV/JSON files back into Golf Lab."
      },
      sourcePlan: plan,
      acquisitionRunbook,
      warehouseHealth: {
        score: warehouseReport.score,
        grade: warehouseReport.grade,
        latestSourceAt: warehouseReport.latestSourceAt,
        gaps: warehouseReport.gaps,
        sourceFreshness: warehouseReport.sourceFreshness,
        validation: warehouseReport.validation
      },
      collectionColumns: Warehouse.COLLECTION_COLUMNS,
      golfLab: packetLab
    };
  }

  return {
    SOURCE_PLAN_VERSION,
    SOURCE_PLAYBOOK,
    SOURCE_ACQUISITION_RECIPES,
    buildEventSourcePlan,
    buildSourceOpsBoard,
    buildSourceCatalogBoard,
    buildTournamentActivationPlan,
    buildAcquisitionRunbook,
    buildDataIntakeBoard,
    buildDataIntakePacket,
    buildHistoricalBackfillBoard,
    buildEventResearchPacket
  };
});
