// ============================================================================
// Fairway Ledger — main app IIFE.
//
// This file is the single entry point for everything that isn't pure math. It
// is intentionally one big closure (`(function () { ... })()`) so internal
// state stays private — no globals leak except the small `window.GolfMath`
// and `window.GolfShapes` namespaces that the lib/ modules expose for it.
//
// Pure math + shape helpers already live in lib/ (loaded as plain <script>s
// before this one and unit-tested in Node):
//   • lib/golf-math.js  → strokes-gained, hole math, handicap, physicalHoleId
//   • lib/shapes.js     → canonical Round/Hole builders + normalizers
//
// MAP OF THIS FILE (approximate line ranges — search by section header to
// jump). The `// ---- Title --------` comments below mark real seams used
// for the future modular split (see ARCHITECTURE.md):
//
//   ~70   Per-hole pending state + small in-progress getters
//   ~109  Optional post-round survey
//   ~210  Notes
//   ~225  Clubs hit (selector, multi-use logic, penalty-aware filtering)
//   ~400  Penalty clubs (multi-penalty, OB sub-chip)
//   ~976  Snapshot system: rolling localStorage backups
//   ~1532 Physical course grouping (pooling tee variants)
//   ~1602 Chip-style form selectors (generic UI helper)
//   ~1691 Start Round flow (course pick, hole-count switch, Deerwood logic)
//   ~3913 Par-type drill-down sheet + scoring summary tiles
//   ~4179 Heatmap (Holes tab)
//   ~4598 Drill-down sheet (stat → holes)
//   ~5042 Scoring distribution + bucket sheet (multi-dim summary)
//   ~5781 Narrative builders (par-type, headline, best-stretch, story)
//   ~6209 Optional reflection survey paragraph
//   ~6503 Trophy Room (records)
//   ~6682 Stats Explorer (currently hidden from Home)
//   ~7525 Destructive-action typed-confirmation modal
//   ~7618 Snapshot restore panel (Profile)
//   ~7707 Round detail sheet
//
// Adding a new feature? Find the seam closest to what you're touching and
// keep the new code there — that's what makes ARCHITECTURE.md's eventual
// per-seam extraction safe.
// ============================================================================

(function () {
  "use strict";

  // Pure golf math lives in lib/golf-math.js (loaded as a plain script before
  // this one) so it can be unit-tested in Node. Bind the functions into scope
  // here; every existing call site keeps working unchanged.
  const {
    average,
    percentage,
    formatSigned,
    tourExpectedStrokes,
    holeStrokesGained,
    roundStrokesGained,
    roundTotals,
    scoreMarkClass,
    derivedGir,
    isDeerwoodCourseId,
    physicalHoleId,
    expectedNineHoleDifferential,
    handicapRuleForCount,
    estimateRoundDifferential: estimateRoundDifferentialPure,
    calculateHandicapEstimate: calculateHandicapEstimatePure
  } = window.GolfMath;

  // Canonical Round + Hole shapes live in lib/shapes.js. Use makeHole/makeRound
  // when constructing new objects so every site gets the same field set, and
  // normalizeRound when ingesting saved/imported data so old shapes pick up
  // any new fields with their defaults. Adding a new per-hole or per-round
  // field is a one-line change in lib/shapes.js.
  const {
    makeHole,
    makeRound,
    normalizeRound
  } = window.GolfShapes;

  const {
    blankGolfLabState,
    normalizeGolfLabState,
    mergeGolfLabStates,
    summarizeGolfLabState,
    hasGolfLabData,
    buildPlayerScorecard,
    buildPlayerIndexBoard,
    buildPlayerIdentityBoard,
    buildPlayerSplitLab,
    buildPlayerSplitLeaderboards,
    buildWeatherMatrixBoard,
    buildTeeTimeWaveBoard,
    buildFieldReadinessBoard,
    buildEventDossier,
    buildCourseScorecard,
    buildCourseDifficultyBoard,
    buildCourseSetupBoard,
    buildCourseCompBoard
  } = window.GolfLab;

  const {
    buildOwnedModelSnapshot,
    buildModelTrainingDataset,
    buildPredictionBacktest,
    buildPredictionSettlementBoard,
    buildModelPerformanceBoard,
    buildModelTuningBoard,
    buildPredictionRunAuditBoard,
    buildModelRunHistoryBoard,
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
    DEFAULT_WEIGHTS: GOLF_LAB_DEFAULT_WEIGHTS,
    WEATHER_SCENARIOS: GOLF_LAB_MODEL_WEATHER_SCENARIOS
  } = window.GolfLabModel || {};

  const {
    buildGolfLabImportSnapshot,
    buildGolfLabTemplate,
    buildMarketCoverageBoard,
    buildOddsMovementBoard,
    buildOddsShoppingBoard,
    buildWarehouseCoverageMap,
    buildWarehouseReport,
    buildSourceLineageBoard,
    buildGolfLabImportPreview,
    collectionKeyFromFileName,
    parseGolfLabCsv
  } = window.GolfLabWarehouse || {};

  const {
    buildEventSourcePlan,
    buildSourceOpsBoard,
    buildSourceCatalogBoard,
    buildTournamentActivationPlan,
    buildAcquisitionRunbook,
    buildDataIntakeBoard,
    buildDataIntakePacket,
    buildHistoricalBackfillBoard,
    buildEventResearchPacket
  } = window.GolfLabSources || {};

  const STORAGE_KEY = "fairwayLedger.v1";
  const ACTIVE_TAB_KEY = "fairwayLedger.activeTab";
  const BACKUP_META_KEY = "fairwayLedger.backupMeta.v1";
  const BRIEF_COLLAPSED_KEY = "fairwayLedger.briefCollapsed.v1";
  const VIEW_MODE_KEY = "fairwayLedger.viewMode.v1";
  const IN_PROGRESS_KEY = "fairwayLedger.inProgressRound.v1";
  const GOLF_LAB_MODEL_SETTINGS_KEY = "fairwayLedger.golfLabModelSettings.v1";
  // Card scorecard sectioning preference. "narrative" reorders the per-hole
  // inputs to match how you experience the hole (tee → approach → green →
  // score). "default" is the original outcome-first layout. As of the
  // 2026-05-26 flip, narrative is the default for any user who hasn't
  // explicitly chosen — but if they DID toggle to "default" in Profile,
  // that pick survives the flip.
  const CARD_FLOW_KEY = "fairwayLedger.cardFlow.v1";
  let cardFlowMode = (() => {
    try {
      const saved = localStorage.getItem(CARD_FLOW_KEY);
      if (saved === "default") return "default";
      if (saved === "narrative") return "narrative";
      return "narrative";
    } catch { return "narrative"; }
  })();

  // Per-installation default for round entry mode. "detailed" surfaces every
  // per-hole input (clubs, FIR, GIR, putts, penalties, note). "speed" hides
  // them all and leaves only the score input — useful for players who just
  // want a final gross without the data-entry overhead (Jeff's wife, higher
  // handicap rounds, casual play). Per-round override lives in the round
  // setup banner. Default to "detailed" so anyone who already had the app
  // before this feature sees no behavior change.
  const ENTRY_MODE_DEFAULT_KEY = "fairwayLedger.entryModeDefault.v1";
  let entryModeDefault = (() => {
    try {
      const saved = localStorage.getItem(ENTRY_MODE_DEFAULT_KEY);
      if (saved === "speed") return "speed";
      return "detailed";
    } catch { return "detailed"; }
  })();
  // Entry mode for the round currently being entered / edited. Seeded from
  // the per-installation default on start, swappable in the setup banner
  // mid-round, persisted onto the round on save (round.entryMode).
  let currentEntryMode = entryModeDefault;
  const IN_PROGRESS_DEBOUNCE_MS = 500;
  const BACKUP_NAG_THRESHOLD = 3;
  // Auto-export an off-device JSON backup once you've added this many rounds
  // since your last export (manual or auto). Triggered from the round-save
  // submit handler so the browser counts it as a user gesture (required on
  // iOS Safari to allow a programmatic download).
  const AUTO_BACKUP_ROUND_THRESHOLD = 5;
  const today = new Date().toISOString().slice(0, 10);
  const GOLF_LAB_MODEL_PRESETS = Object.freeze({
    balanced: {
      label: "Balanced",
      note: "Best all-around baseline",
      weights: GOLF_LAB_DEFAULT_WEIGHTS || {
        skill: 0.52,
        recentForm: 0.22,
        courseFit: 0.12,
        difficultyFit: 0.08,
        weatherFit: 0.06
      }
    },
    form: {
      label: "Hot Hand",
      note: "Leans into recent ball-striking and form",
      weights: {
        skill: 0.38,
        recentForm: 0.36,
        courseFit: 0.10,
        difficultyFit: 0.08,
        weatherFit: 0.08
      }
    },
    course: {
      label: "Course Horse",
      note: "Emphasizes player-course and setup fit",
      weights: {
        skill: 0.34,
        recentForm: 0.14,
        courseFit: 0.30,
        difficultyFit: 0.14,
        weatherFit: 0.08
      }
    },
    tough: {
      label: "Major Test",
      note: "Rewards brutal-course and difficulty splits",
      weights: {
        skill: 0.36,
        recentForm: 0.16,
        courseFit: 0.18,
        difficultyFit: 0.22,
        weatherFit: 0.08
      }
    },
    weather: {
      label: "Weather Desk",
      note: "Pushes wind/rain/temperature specialists",
      weights: {
        skill: 0.34,
        recentForm: 0.16,
        courseFit: 0.12,
        difficultyFit: 0.10,
        weatherFit: 0.28
      }
    }
  });
  const GOLF_LAB_MARKET_FILTERS = Object.freeze([
    { value: "all", label: "All markets" },
    { value: "winner", label: "Winner" },
    { value: "top 10", label: "Top 10" },
    { value: "top 20", label: "Top 20" },
    { value: "make cut", label: "Make cut" }
  ]);
  const GOLF_LAB_WEATHER_SCENARIOS = Object.freeze(Object.entries(GOLF_LAB_MODEL_WEATHER_SCENARIOS || {
    baseline: { label: "Imported forecast" },
    calm: { label: "Calm scoring" },
    wind: { label: "Wind test" },
    rain: { label: "Rain draw" },
    cold: { label: "Cold setup" },
    heat: { label: "Heat setup" }
  }).map(([value, scenario]) => ({
    value,
    label: scenario.label || value
  })));

  let sampleCourses = [];
  let selectedCourseDetailId = null;
  let selectedGolfLabPlayerId = null;
  let selectedGolfLabCourseId = null;
  let golfLabModelSettings = readInitialGolfLabModelSettings();
  let golfLabModelInFlight = false;
  let editingRoundId = null;
  let viewMode = readInitialViewMode();

  // ---- Per-hole pending state (in-progress round data) -------------------
  //
  // One map of hole-number -> { note, clubs, penaltyClub } holds every per-
  // hole input that isn't a DOM field. Adding a new per-hole field means
  // extending this shape + one getter/setter pair — NOT a new top-level map
  // and a new entry in every reset call site.
  //
  // The serialized in-progress draft still uses the older flat layout
  // (holeNotes, holeClubs, holePenaltyClubs) so existing saved drafts
  // continue to restore unchanged. captureInProgressRound translates on
  // write; restoreInProgressRound uses the same setters that pre-existed.

  let pendingHoles = {};

  function resetPendingHoles() {
    pendingHoles = {};
  }

  // Internal accessor — lazily creates the per-hole entry.
  function getOrCreatePendingHole(holeNumber) {
    const key = String(holeNumber);
    if (!pendingHoles[key]) pendingHoles[key] = {};
    return pendingHoles[key];
  }

  // Drop the per-hole entry if every field is now empty/missing, so iterating
  // pendingHoles (e.g. in refreshRoundPreservingHoles) doesn't see ghosts.
  function compactPendingHole(holeNumber) {
    const key = String(holeNumber);
    const entry = pendingHoles[key];
    if (!entry) return;
    const empty = !entry.note
      && !(entry.clubs && entry.clubs.length)
      && !entry.penaltyClub
      && !(entry.penaltyClubs && entry.penaltyClubs.length);
    if (empty) delete pendingHoles[key];
  }

  // ---- Optional post-round survey ---------------------------------------
  //
  // pendingSurvey holds the draft answers to the round-reflection survey.
  // Round-level (not per-hole) so a single object is enough. The shape
  // mirrors the canonical survey shape in lib/shapes.js; on save we hand
  // this straight to makeRound which clones it through makeSurvey.

  function makeEmptyPendingSurvey() {
    return {
      feel: "",
      confidence: "",
      ratings: { driver: null, irons: null, wedges: null, putter: null },
      swingThoughts: "",
      wentWell: "",
      workOn: ""
    };
  }

  let pendingSurvey = makeEmptyPendingSurvey();

  function resetPendingSurvey() {
    pendingSurvey = makeEmptyPendingSurvey();
  }

  function getPendingSurvey() {
    // Return a defensive clone so callers can't accidentally mutate state.
    return {
      feel: pendingSurvey.feel,
      confidence: pendingSurvey.confidence,
      ratings: { ...pendingSurvey.ratings },
      swingThoughts: pendingSurvey.swingThoughts,
      wentWell: pendingSurvey.wentWell,
      workOn: pendingSurvey.workOn
    };
  }

  function setSurveyField(field, value) {
    if (!(field in pendingSurvey) || field === "ratings") return;
    pendingSurvey[field] = value || "";
  }

  function setSurveyRating(club, value) {
    if (!(club in pendingSurvey.ratings)) return;
    const num = Number(value);
    pendingSurvey.ratings[club] = Number.isFinite(num) && num >= 1 && num <= 5 ? num : null;
  }

  // True if the user touched ANY survey field. Used to decide whether to
  // bother storing the survey or include it in the narrative.
  function surveyHasContent(s) {
    if (!s) return false;
    if (s.feel || s.confidence) return true;
    if (s.swingThoughts && s.swingThoughts.trim()) return true;
    if (s.wentWell && s.wentWell.trim()) return true;
    if (s.workOn && s.workOn.trim()) return true;
    if (s.ratings && Object.values(s.ratings).some((v) => Number.isFinite(v))) return true;
    return false;
  }

  // Paint the chip "active" state from pendingSurvey, and refresh the three
  // textareas. Called on render, on resume, on edit-load, and on reset.
  function syncSurveyUiFromState() {
    document.querySelectorAll("[data-survey-chip-row]").forEach((row) => {
      const key = row.dataset.surveyChipRow;
      let activeValue = "";
      if (key === "feel") activeValue = pendingSurvey.feel || "";
      else if (key === "confidence") activeValue = pendingSurvey.confidence || "";
      else if (key.startsWith("rating-")) {
        const club = key.slice("rating-".length);
        const v = pendingSurvey.ratings[club];
        activeValue = Number.isFinite(v) ? String(v) : "";
      }
      row.querySelectorAll("[data-survey-value]").forEach((chip) => {
        chip.classList.toggle("is-active", chip.dataset.surveyValue === activeValue);
      });
    });
    if (els.surveySwingThoughts) els.surveySwingThoughts.value = pendingSurvey.swingThoughts || "";
    if (els.surveyWentWell) els.surveyWentWell.value = pendingSurvey.wentWell || "";
    if (els.surveyWorkOn) els.surveyWorkOn.value = pendingSurvey.workOn || "";
  }

  // Tapping any survey chip updates state, repaints, and triggers an
  // in-progress save so a refresh mid-fillout doesn't lose work.
  function handleSurveyChipClick(button) {
    const row = button.closest("[data-survey-chip-row]");
    if (!row) return;
    const key = row.dataset.surveyChipRow;
    const value = button.dataset.surveyValue || "";
    // Re-clicking the active chip clears it (acts as a toggle).
    let nextValue = value;
    if (button.classList.contains("is-active")) nextValue = "";
    if (key === "feel") setSurveyField("feel", nextValue);
    else if (key === "confidence") setSurveyField("confidence", nextValue);
    else if (key.startsWith("rating-")) {
      const club = key.slice("rating-".length);
      setSurveyRating(club, nextValue || null);
    }
    syncSurveyUiFromState();
    scheduleInProgressSave();
  }

  // ---- Notes -------------------------------------------------------------

  function getHoleNote(holeNumber) {
    const entry = pendingHoles[String(holeNumber)];
    return (entry && entry.note) || "";
  }

  function setHoleNote(holeNumber, value) {
    const trimmed = String(value || "").trim();
    const entry = getOrCreatePendingHole(holeNumber);
    if (trimmed) entry.note = trimmed;
    else delete entry.note;
    compactPendingHole(holeNumber);
  }

  // ---- Clubs hit ---------------------------------------------------------

  function getHoleClubs(holeNumber) {
    const entry = pendingHoles[String(holeNumber)];
    return (entry && entry.clubs) || [];
  }

  // The tee club is whatever sits at index 0. Putter is never a tee shot, so
  // keep every Putter instance after the non-Putter clubs — that way removing
  // a pre-seeded Driver and tapping the real tee club just works, even when
  // multi-use (e.g. ["Putter", "PW", "Putter"]) is in play.
  function normalizeClubOrder(clubs) {
    const putters = clubs.filter((c) => c === "Putter");
    const others = clubs.filter((c) => c !== "Putter");
    if (others.length && putters.length) return [...others, ...putters];
    return clubs;
  }

  // Cap how many times the same club can be tapped on one hole. Five covers
  // realistic scenarios (a triple on a par 5 with two wedge approaches and a
  // chip is ~3 wedges). Tap past the cap loops back to 0.
  const MAX_CLUB_USES = 5;

  function setHoleClubs(holeNumber, clubs) {
    const entry = getOrCreatePendingHole(holeNumber);
    if (Array.isArray(clubs) && clubs.length) {
      entry.clubs = normalizeClubOrder([...clubs]);
    } else {
      delete entry.clubs;
    }
    compactPendingHole(holeNumber);
  }

  // What's the user's most-frequently-used tee club at this physical hole,
  // across every round (any tee variant)? Used as the pre-seed for the
  // "Clubs hit" pill row so Fawn 2 lands ready with the 6i if that's what
  // they actually hit most days, instead of a default Driver they then
  // have to undo. Returns null when there isn't enough history yet — the
  // caller falls back to the par-based default.
  function mostUsedTeeClubForHole(courseId, hole, rounds, minPlays) {
    if (!hole) return null;
    const threshold = Number.isFinite(minPlays) ? minPlays : 3;
    const physId = physicalHoleId(courseId, hole);
    const usage = new Map(); // club -> { count, lastDate }
    let totalPlays = 0;
    // Iterate newest-first so the first time we encounter each club is the
    // most recent — used to break ties in favor of "what they've been
    // doing lately" rather than ancient history.
    const ordered = [...rounds].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    for (const round of ordered) {
      if (!round || !Array.isArray(round.holes)) continue;
      for (const h of round.holes) {
        if (physicalHoleId(round.courseId, h) !== physId) continue;
        if (!Number.isFinite(h.score) || h.score <= 0) continue;
        if (!Array.isArray(h.clubsHit) || !h.clubsHit.length) continue;
        // Putter is never a tee shot; skip Putter-only entries entirely.
        const tee = h.clubsHit.find((c) => c !== "Putter");
        if (!tee) continue;
        totalPlays++;
        if (!usage.has(tee)) usage.set(tee, { count: 0, lastDate: round.date || "" });
        usage.get(tee).count += 1;
      }
    }
    if (totalPlays < threshold) return null;
    let best = null;
    for (const [club, info] of usage) {
      if (!best
          || info.count > best.count
          || (info.count === best.count && info.lastDate > best.lastDate)) {
        best = { club, count: info.count, lastDate: info.lastDate };
      }
    }
    return best ? best.club : null;
  }

  // Per Rob via the user: on a hole where multiple clubs have been used, can
  // the app tell them which one they actually score best with? Returns
  //   { best: { club, avgToPar, plays }, baseline: { club, avgToPar, plays } }
  // when:
  //   - at least 2 different non-Putter tee clubs have been hit
  //   - each candidate club has ≥ minPlaysPerClub plays of history
  //   - the gap between "best avg" and the user's most-used club is ≥ minGap
  //   - the most-used club isn't already the best (no point telling them)
  // Otherwise null. The baseline is the user's MOST-USED club (their
  // mental default), not the second-best — that's the comparison the user
  // actually feels.
  function getBestScoringTeeClubForHole(courseId, hole, rounds, opts) {
    if (!hole) return null;
    const { minPlaysPerClub = 3, minGap = 0.4 } = opts || {};
    const physId = physicalHoleId(courseId, hole);
    const groups = new Map(); // club -> [score-to-par, ...]
    for (const round of rounds) {
      if (!round || !Array.isArray(round.holes)) continue;
      for (const h of round.holes) {
        if (physicalHoleId(round.courseId, h) !== physId) continue;
        if (!Number.isFinite(h.score) || h.score <= 0) continue;
        if (!Number.isFinite(h.par) || h.par <= 0) continue;
        if (!Array.isArray(h.clubsHit) || !h.clubsHit.length) continue;
        const tee = h.clubsHit.find((c) => c !== "Putter");
        if (!tee) continue;
        if (!groups.has(tee)) groups.set(tee, []);
        groups.get(tee).push(h.score - h.par);
      }
    }
    const eligible = [];
    for (const [club, scores] of groups) {
      if (scores.length < minPlaysPerClub) continue;
      const avgToPar = scores.reduce((s, v) => s + v, 0) / scores.length;
      eligible.push({ club, avgToPar, plays: scores.length });
    }
    if (eligible.length < 2) return null;
    const best = [...eligible].sort((a, b) => a.avgToPar - b.avgToPar)[0];
    const baseline = [...eligible].sort((a, b) => b.plays - a.plays)[0];
    if (best.club === baseline.club) return null;
    if (baseline.avgToPar - best.avgToPar < minGap) return null;
    return { best, baseline };
  }

  // Pre-select the tee club on every hole so the card opens ready. Order
  // of preference on par 4/5/6:
  //   1. Most-frequently-used at this physical hole (≥3 plays of history)
  //   2. Driver (the catalog default)
  // Par 3s with consistent club history pre-seed that club; otherwise
  // we leave the row empty and let the user pick when they hit the tee.
  // (Putter is no longer pre-seeded — the Putts row already tracks
  // putter use; a Putter pill in the clubs row was duplicative.)
  // Skipped in edit mode so saved rounds keep their captured selections.
  function seedDefaultClubs(course) {
    if (editingRoundId || !course || !Array.isArray(course.holes)) return;
    course.holes.forEach((hole) => {
      if (getHoleClubs(hole.number).length > 0) return;
      const learned = mostUsedTeeClubForHole(course.id, hole, state.rounds);
      let desired;
      if (hole.par === 3) {
        desired = learned && isInBag(learned) ? [learned] : [];
      } else {
        const tee = learned && isInBag(learned) ? learned : "Driver";
        desired = [tee];
      }
      const filtered = desired.filter(isInBag);
      if (filtered.length) setHoleClubs(hole.number, filtered);
    });
  }

  // Tap-to-add (post-2026-05-26-r model): every tap logs one more hit of
  // the club, capped at MAX_CLUB_USES. This matches how golfers naturally
  // think about it — "I hit my 58° twice" = tap 58° twice. The earlier
  // tap-to-toggle model required hunting for a tiny + badge which Rob
  // (via Jeff) found unworkable on mobile. Clearing happens via a
  // separate visible × button on active pills (see clearHoleClub).
  function toggleHoleClub(holeNumber, club) {
    const current = getHoleClubs(holeNumber);
    const count = current.filter((c) => c === club).length;
    if (count >= MAX_CLUB_USES) return current;  // tap at cap is a no-op
    const next = [...current, club];
    setHoleClubs(holeNumber, next);
    return next;
  }

  // Remove every instance of `club` from the hole. Wired to the visible ×
  // badge on active pills — explicit "undo this club" affordance.
  function clearHoleClub(holeNumber, club) {
    const current = getHoleClubs(holeNumber);
    if (!current.includes(club)) return current;
    const next = current.filter((c) => c !== club);
    setHoleClubs(holeNumber, next);
    return next;
  }

  // Kept for back-compat with any caller (none currently outside the
  // click handler). Same semantics as toggleHoleClub now.
  function bumpHoleClub(holeNumber, club) {
    return toggleHoleClub(holeNumber, club);
  }

  // ---- Penalty clubs ----------------------------------------------------
  //
  // One entry per penalty stroke on a hole, in order. Two penalties from
  // two different clubs (drove OB on the tee → Driver, then chunked a
  // wedge OB → PW) are recorded as ["Driver", "PW"]. The first entry
  // doubles as the "primary" penalty club for back-compat readers.
  //
  // Legacy callers (getHolePenaltyClub / setHolePenaltyClub, singular)
  // operate on penaltyClubs[0] so existing code paths keep working
  // without per-call updates.

  function getHolePenaltyClubs(holeNumber) {
    const entry = pendingHoles[String(holeNumber)];
    if (!entry) return [];
    if (Array.isArray(entry.penaltyClubs)) return entry.penaltyClubs;
    if (entry.penaltyClub) return [entry.penaltyClub];
    return [];
  }

  function setHolePenaltyClubs(holeNumber, clubs) {
    const entry = getOrCreatePendingHole(holeNumber);
    const cleaned = Array.isArray(clubs) ? clubs.filter((c) => typeof c === "string" && c) : [];
    if (cleaned.length) {
      entry.penaltyClubs = cleaned;
      // Keep singular field in sync for any legacy reader.
      entry.penaltyClub = cleaned[0];
    } else {
      delete entry.penaltyClubs;
      delete entry.penaltyClub;
    }
    compactPendingHole(holeNumber);
  }

  function setHolePenaltyClubAt(holeNumber, index, club) {
    const current = [...getHolePenaltyClubs(holeNumber)];
    current[index] = club || "";
    // Trim trailing empty entries so a cleared last picker doesn't
    // leave a phantom slot in storage.
    while (current.length && !current[current.length - 1]) current.pop();
    setHolePenaltyClubs(holeNumber, current);
  }

  function getHolePenaltyClub(holeNumber) {
    return getHolePenaltyClubs(holeNumber)[0] || "";
  }

  function setHolePenaltyClub(holeNumber, club) {
    setHolePenaltyClubs(holeNumber, club ? [club] : []);
  }

  function readInitialViewMode() {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem(VIEW_MODE_KEY) : null;
    if (stored === "card" || stored === "grid") return stored;
    if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(max-width: 640px)").matches) {
      return "card";
    }
    return "grid";
  }

  const DEERWOOD_COURSE_ID = "deerwood";
  const DEERWOOD_TEE_OPTIONS = ["Red", "White", "Blue"];
  // 9-hole rounds pick a single nine. 18-hole rounds pick Front 9 + Back 9
  // independently (all 6 permutations), so 18-hole layouts are computed in
  // getDeerwoodLayout rather than enumerated here.
  const deerwoodLayoutOptions = {
    "9": [
      { id: "buck", label: "Buck", nines: ["buck"] },
      { id: "doe", label: "Doe", nines: ["doe"] },
      { id: "fawn", label: "Fawn", nines: ["fawn"] }
    ]
  };
  const deerwoodNineLabels = {
    buck: "Buck",
    doe: "Doe",
    fawn: "Fawn"
  };

  let sampleRounds = [];
  let state = { courses: [], rounds: [], profile: { bag: [] }, golfLab: blankGolfLabState() };

  const els = {
    metricRounds: document.getElementById("metricRounds"),
    metricAverageScore: document.getElementById("metricAverageScore"),
    metricAverageScoreNote: document.getElementById("metricAverageScoreNote"),
    metricAveragePar: document.getElementById("metricAveragePar"),
    metricBestRound: document.getElementById("metricBestRound"),
    metricBestRoundCard: document.getElementById("metricBestRoundCard"),
    metricGir: document.getElementById("metricGir"),
    metricSg: document.getElementById("metricSg"),
    metricHandicap: document.getElementById("metricHandicap"),
    homeInsights: document.getElementById("homeInsights"),
    filterCourse: document.getElementById("filterCourse"),
    filterTee: document.getElementById("filterTee"),
    filterWindow: document.getElementById("filterWindow"),
    roundDate: document.getElementById("roundDate"),
    roundCourse: document.getElementById("roundCourse"),
    roundHoleCount: document.getElementById("roundHoleCount"),
    roundHoleCountField: document.getElementById("roundHoleCountField"),
    roundLayout: document.getElementById("roundLayout"),
    roundLayoutField: document.getElementById("roundLayoutField"),
    roundFrontNine: document.getElementById("roundFrontNine"),
    roundFrontNineField: document.getElementById("roundFrontNineField"),
    roundBackNine: document.getElementById("roundBackNine"),
    roundBackNineField: document.getElementById("roundBackNineField"),
    roundTee: document.getElementById("roundTee"),
    roundTeeField: document.getElementById("roundTeeField"),
    roundWind: document.getElementById("roundWind"),
    roundTag: document.getElementById("roundTag"),
    roundTagField: document.getElementById("roundTagField"),
    roundEntryMode: document.getElementById("roundEntryMode"),
    roundEntryModeField: document.getElementById("roundEntryModeField"),
    entryModeDetailedDefault: document.getElementById("entryModeDetailedDefault"),
    entryModeSpeedDefault: document.getElementById("entryModeSpeedDefault"),
    filterTag: document.getElementById("filterTag"),
    roundSetup: document.getElementById("roundSetup"),
    roundSetupBanner: document.getElementById("roundSetupBanner"),
    roundNote: document.getElementById("roundNote"),
    surveyDetails: document.getElementById("surveyDetails"),
    surveySwingThoughts: document.getElementById("surveySwingThoughts"),
    surveyWentWell: document.getElementById("surveyWentWell"),
    surveyWorkOn: document.getElementById("surveyWorkOn"),
    roundCourseMeta: document.getElementById("roundCourseMeta"),
    roundBrief: document.getElementById("roundBrief"),
    roundLiveSummary: document.getElementById("roundLiveSummary"),
    completionCheck: document.getElementById("completionCheck"),
    reviewSection: document.getElementById("reviewSection"),
    reviewPreview: document.getElementById("reviewPreview"),
    gamesRoot: document.getElementById("gamesRoot"),
    golfLabStatus: document.getElementById("golfLabStatus"),
    golfLabLanes: document.getElementById("golfLabLanes"),
    golfLabModelEventSelect: document.getElementById("golfLabModelEventSelect"),
    golfLabModelPreset: document.getElementById("golfLabModelPreset"),
    golfLabMarketFilter: document.getElementById("golfLabMarketFilter"),
    golfLabWeatherScenario: document.getElementById("golfLabWeatherScenario"),
    golfLabEdgeThreshold: document.getElementById("golfLabEdgeThreshold"),
    golfLabEdgeThresholdValue: document.getElementById("golfLabEdgeThresholdValue"),
    golfLabModelWeights: document.getElementById("golfLabModelWeights"),
    golfLabRunModel: document.getElementById("golfLabRunModel"),
    golfLabModelStatus: document.getElementById("golfLabModelStatus"),
    golfLabSourceStatus: document.getElementById("golfLabSourceStatus"),
    golfLabImportInput: document.getElementById("golfLabImportInput"),
    golfLabExportButton: document.getElementById("golfLabExportButton"),
    golfLabTemplateButton: document.getElementById("golfLabTemplateButton"),
    golfLabCommandCenterBoard: document.getElementById("golfLabCommandCenterBoard"),
    golfLabActivationPacketButton: document.getElementById("golfLabActivationPacketButton"),
    golfLabActivationPlanBoard: document.getElementById("golfLabActivationPlanBoard"),
    golfLabWarehouseWorkbench: document.getElementById("golfLabWarehouseWorkbench"),
    golfLabCoverageMapBoard: document.getElementById("golfLabCoverageMapBoard"),
    golfLabResearchPacketButton: document.getElementById("golfLabResearchPacketButton"),
    golfLabSourceAuditBoard: document.getElementById("golfLabSourceAuditBoard"),
    golfLabSourceLineageBoard: document.getElementById("golfLabSourceLineageBoard"),
    golfLabSourceOpsBoard: document.getElementById("golfLabSourceOpsBoard"),
    golfLabDataIntakePacketButton: document.getElementById("golfLabDataIntakePacketButton"),
    golfLabDataIntakeBoard: document.getElementById("golfLabDataIntakeBoard"),
    golfLabSourceCatalogBoard: document.getElementById("golfLabSourceCatalogBoard"),
    golfLabHistoricalBackfillBoard: document.getElementById("golfLabHistoricalBackfillBoard"),
    golfLabBackfillPacketButton: document.getElementById("golfLabBackfillPacketButton"),
    golfLabSourcePlan: document.getElementById("golfLabSourcePlan"),
    golfLabPlayerIdentityBoard: document.getElementById("golfLabPlayerIdentityBoard"),
    golfLabPlayerSplitLabBoard: document.getElementById("golfLabPlayerSplitLabBoard"),
    golfLabPlayerIndexBoard: document.getElementById("golfLabPlayerIndexBoard"),
    golfLabPlayerSelect: document.getElementById("golfLabPlayerSelect"),
    golfLabPlayerScorecard: document.getElementById("golfLabPlayerScorecard"),
    golfLabCourseSelect: document.getElementById("golfLabCourseSelect"),
    golfLabCourseScorecard: document.getElementById("golfLabCourseScorecard"),
    golfLabCourseDifficultyBoard: document.getElementById("golfLabCourseDifficultyBoard"),
    golfLabCourseSetupBoard: document.getElementById("golfLabCourseSetupBoard"),
    golfLabCourseCompBoard: document.getElementById("golfLabCourseCompBoard"),
    golfLabSplitLeaders: document.getElementById("golfLabSplitLeaders"),
    golfLabTournamentBoard: document.getElementById("golfLabTournamentBoard"),
    golfLabFitBoard: document.getElementById("golfLabFitBoard"),
    golfLabFieldReadinessBoard: document.getElementById("golfLabFieldReadinessBoard"),
    golfLabFieldIntelligenceBoard: document.getElementById("golfLabFieldIntelligenceBoard"),
    golfLabConsensusBoard: document.getElementById("golfLabConsensusBoard"),
    golfLabFeatureSensitivityBoard: document.getElementById("golfLabFeatureSensitivityBoard"),
    golfLabScenarioBoard: document.getElementById("golfLabScenarioBoard"),
    golfLabWeatherMatrixBoard: document.getElementById("golfLabWeatherMatrixBoard"),
    golfLabWeatherDrawBoard: document.getElementById("golfLabWeatherDrawBoard"),
    golfLabPredictionLedger: document.getElementById("golfLabPredictionLedger"),
    golfLabFeatureStoreBoard: document.getElementById("golfLabFeatureStoreBoard"),
    golfLabPredictionPrepBoard: document.getElementById("golfLabPredictionPrepBoard"),
    golfLabPredictionRunAuditBoard: document.getElementById("golfLabPredictionRunAuditBoard"),
    golfLabModelRunHistoryBoard: document.getElementById("golfLabModelRunHistoryBoard"),
    golfLabMarketCoverageBoard: document.getElementById("golfLabMarketCoverageBoard"),
    golfLabOddsMovementBoard: document.getElementById("golfLabOddsMovementBoard"),
    golfLabOddsShoppingBoard: document.getElementById("golfLabOddsShoppingBoard"),
    golfLabEdgeBoard: document.getElementById("golfLabEdgeBoard"),
    golfLabBetPortfolioBoard: document.getElementById("golfLabBetPortfolioBoard"),
    golfLabProjectedStandingsBoard: document.getElementById("golfLabProjectedStandingsBoard"),
    golfLabResultsSummaryBoard: document.getElementById("golfLabResultsSummaryBoard"),
    golfLabModelExplainerBoard: document.getElementById("golfLabModelExplainerBoard"),
    golfLabSettlementBoard: document.getElementById("golfLabSettlementBoard"),
    golfLabTrainingDatasetBoard: document.getElementById("golfLabTrainingDatasetBoard"),
    golfLabModelCalibrationBoard: document.getElementById("golfLabModelCalibrationBoard"),
    golfLabModelTuningBoard: document.getElementById("golfLabModelTuningBoard"),
    golfLabGradePredictions: document.getElementById("golfLabGradePredictions"),
    golfLabBacktestPanel: document.getElementById("golfLabBacktestPanel"),
    roundForm: document.getElementById("roundForm"),
    resetRoundButton: document.getElementById("resetRoundButton"),
    viewToggleButton: document.getElementById("viewToggleButton"),
    roundEntryTitle: document.getElementById("roundEntryTitle"),
    roundSubmitButton: document.getElementById("roundSubmitButton"),
    scorecardGrid: document.getElementById("scorecardGrid"),
    startRoundContainer: document.getElementById("startRoundContainer"),
    startRoundButton: document.getElementById("startRoundButton"),
    startRoundHint: document.getElementById("startRoundHint"),
    roundPreview: document.getElementById("roundPreview"),
    trendChart: document.getElementById("trendChart"),
    handicapPanel: document.getElementById("handicapPanel"),
    courseStats: document.getElementById("courseStats"),
    parStats: document.getElementById("parStats"),
    recentRounds: document.getElementById("recentRounds"),
    strokesGainedPanel: document.getElementById("strokesGainedPanel"),
    puttingPanel: document.getElementById("puttingPanel"),
    scoringDistribution: document.getElementById("scoringDistribution"),
    heatmapCourseChips: document.getElementById("heatmapCourseChips"),
    heatmapNineChips: document.getElementById("heatmapNineChips"),
    heatmapSummary: document.getElementById("heatmapSummary"),
    heatmapGrid: document.getElementById("heatmapGrid"),
    heatmapLegend: document.getElementById("heatmapLegend"),
    heatmapNote: document.getElementById("heatmapNote"),
    heatmapDrilldownOverlay: document.getElementById("heatmapDrilldownOverlay"),
    heatmapDrilldownBackdrop: document.getElementById("heatmapDrilldownBackdrop"),
    heatmapDrilldownClose: document.getElementById("heatmapDrilldownClose"),
    heatmapDrilldownTitle: document.getElementById("heatmapDrilldownTitle"),
    heatmapDrilldownBody: document.getElementById("heatmapDrilldownBody"),
    welcomeCallout: document.getElementById("welcomeCallout"),
    welcomeSampleButton: document.getElementById("welcomeSampleButton"),
    teeClubPanel: document.getElementById("teeClubPanel"),
    scramblingPanel: document.getElementById("scramblingPanel"),
    deerwoodByNinePanel: document.getElementById("deerwoodByNinePanel"),
    deerwoodByNineCard: document.getElementById("deerwoodByNineCard"),
    profileBagGrid: document.getElementById("profileBagGrid"),
    profileBagSummary: document.getElementById("profileBagSummary"),
    bagResetButton: document.getElementById("bagResetButton"),
    trophyRoomGrid: document.getElementById("trophyRoomGrid"),
    trophyRoomNote: document.getElementById("trophyRoomNote"),
    roundDetailOverlay: document.getElementById("roundDetailOverlay"),
    roundDetailBackdrop: document.getElementById("roundDetailBackdrop"),
    roundDetailClose: document.getElementById("roundDetailClose"),
    roundDetailTitle: document.getElementById("roundDetailTitle"),
    roundDetailSubtitle: document.getElementById("roundDetailSubtitle"),
    roundDetailBody: document.getElementById("roundDetailBody"),
    roundDetailEditButton: document.getElementById("roundDetailEditButton"),
    statsExplorerGrid: document.getElementById("statsExplorerGrid"),
    statsExplorerNote: document.getElementById("statsExplorerNote"),
    cardFlowDefault: document.getElementById("cardFlowDefault"),
    cardFlowNarrative: document.getElementById("cardFlowNarrative"),
    homeFiltersButton: document.getElementById("homeFiltersButton"),
    filtersSheetOverlay: document.getElementById("filtersSheetOverlay"),
    filtersSheetBackdrop: document.getElementById("filtersSheetBackdrop"),
    filtersSheetClose: document.getElementById("filtersSheetClose"),
    filtersResetButton: document.getElementById("filtersResetButton"),
    floatingNavPrev: document.getElementById("floatingNavPrev"),
    floatingNavNext: document.getElementById("floatingNavNext"),
    bucketSheetOverlay: document.getElementById("bucketSheetOverlay"),
    bucketSheetBackdrop: document.getElementById("bucketSheetBackdrop"),
    bucketSheetClose: document.getElementById("bucketSheetClose"),
    bucketSheetTitle: document.getElementById("bucketSheetTitle"),
    bucketSheetList: document.getElementById("bucketSheetList"),
    parTypeSheetOverlay: document.getElementById("parTypeSheetOverlay"),
    parTypeSheetBackdrop: document.getElementById("parTypeSheetBackdrop"),
    parTypeSheetClose: document.getElementById("parTypeSheetClose"),
    parTypeSheetTitle: document.getElementById("parTypeSheetTitle"),
    parTypeSheetBody: document.getElementById("parTypeSheetBody"),
    courseLookupForm: document.getElementById("courseLookupForm"),
    courseLookupQuery: document.getElementById("courseLookupQuery"),
    courseLookupResults: document.getElementById("courseLookupResults"),
    courseApiPanel: document.getElementById("courseApiPanel"),
    courseApiKeyInput: document.getElementById("courseApiKeyInput"),
    courseApiKeySave: document.getElementById("courseApiKeySave"),
    courseApiKeyStatus: document.getElementById("courseApiKeyStatus"),
    courseList: document.getElementById("courseList"),
    courseDetail: document.getElementById("courseDetail"),
    loadSampleButton: document.getElementById("loadSampleButton"),
    exportButton: document.getElementById("exportButton"),
    exportBadge: document.getElementById("exportBadge"),
    importInput: document.getElementById("importInput"),
    clearButton: document.getElementById("clearButton"),
    headerActions: document.getElementById("headerActions"),
    headerActionsToggle: document.getElementById("headerActionsToggle"),
    headerActionsList: document.getElementById("headerActionsList"),
    holePickerOverlay: document.getElementById("holePickerOverlay"),
    holePickerBackdrop: document.getElementById("holePickerBackdrop"),
    holePickerClose: document.getElementById("holePickerClose"),
    holePickerList: document.getElementById("holePickerList"),
    destructiveConfirmOverlay: document.getElementById("destructiveConfirmOverlay"),
    destructiveConfirmBackdrop: document.getElementById("destructiveConfirmBackdrop"),
    destructiveConfirmClose: document.getElementById("destructiveConfirmClose"),
    destructiveConfirmTitle: document.getElementById("destructiveConfirmTitle"),
    destructiveConfirmMessage: document.getElementById("destructiveConfirmMessage"),
    destructiveConfirmFacts: document.getElementById("destructiveConfirmFacts"),
    destructiveConfirmBackupHint: document.getElementById("destructiveConfirmBackupHint"),
    destructiveConfirmTypeLabel: document.getElementById("destructiveConfirmTypeLabel"),
    destructiveConfirmExpected: document.getElementById("destructiveConfirmExpected"),
    destructiveConfirmInput: document.getElementById("destructiveConfirmInput"),
    destructiveConfirmCancel: document.getElementById("destructiveConfirmCancel"),
    destructiveConfirmGo: document.getElementById("destructiveConfirmGo"),
    snapshotList: document.getElementById("snapshotList"),
    snapshotBackupStatus: document.getElementById("snapshotBackupStatus"),
    snapshotTakeButton: document.getElementById("snapshotTakeButton"),
    snapshotCap: document.getElementById("snapshotCap"),
    dangerZoneToggle: document.getElementById("dangerZoneToggle"),
    dangerZoneBody: document.getElementById("dangerZoneBody"),
    toast: document.getElementById("toast")
  };

  function toHole(item) {
    if (Array.isArray(item)) {
      return { number: item[0], par: item[1], yards: item[2], hcp: item[3] || null, hazards: [] };
    }
    return {
      number: Number(item.number),
      label: item.label || String(item.number),
      par: Number(item.par),
      yards: Number(item.yards || 0),
      hcp: item.hcp ? Number(item.hcp) : null,
      hazards: Array.isArray(item.hazards) ? item.hazards.map(normalizeHazard).filter(Boolean) : []
    };
  }

  const HAZARD_TYPES = [
    { value: "water", label: "Water", icon: "💧" },
    { value: "bunker", label: "Bunker", icon: "🪨" },
    { value: "ob", label: "OB", icon: "🚫" },
    { value: "trees", label: "Trees", icon: "🌲" },
    { value: "hill", label: "Hill", icon: "📈" },
    { value: "other", label: "Other", icon: "⚠️" }
  ];

  const HAZARD_SIDES = [
    { value: "left", label: "Left" },
    { value: "right", label: "Right" },
    { value: "center", label: "Center" },
    { value: "long", label: "Long" },
    { value: "short", label: "Short" }
  ];

  function hazardTypeMeta(type) {
    return HAZARD_TYPES.find((entry) => entry.value === type) || HAZARD_TYPES[HAZARD_TYPES.length - 1];
  }

  function hazardSideMeta(side) {
    return HAZARD_SIDES.find((entry) => entry.value === side) || null;
  }

  function normalizeHazard(raw) {
    if (!raw || typeof raw !== "object") return null;
    const type = HAZARD_TYPES.some((t) => t.value === raw.type) ? raw.type : "other";
    const side = HAZARD_SIDES.some((s) => s.value === raw.side) ? raw.side : null;
    const carryYards = Number.isFinite(Number(raw.carryYards)) ? Number(raw.carryYards) : null;
    const startYards = Number.isFinite(Number(raw.startYards)) ? Number(raw.startYards) : null;
    const note = typeof raw.note === "string" ? raw.note.trim() : "";
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : makeId("haz"),
      type,
      side,
      carryYards,
      startYards,
      note
    };
  }

  function renderHazardChip(hazard, { editable = false } = {}) {
    const meta = hazardTypeMeta(hazard.type);
    const sideMeta = hazardSideMeta(hazard.side);
    const detailsParts = [];
    if (sideMeta) detailsParts.push(sideMeta.label);
    if (Number.isFinite(hazard.carryYards)) detailsParts.push(`${hazard.carryYards}y`);
    const details = detailsParts.length ? `<span class="hazard-chip-details">${escapeHtml(detailsParts.join(" · "))}</span>` : "";
    const noteHtml = hazard.note ? `<span class="hazard-chip-note">${escapeHtml(hazard.note)}</span>` : "";
    const deleteBtn = editable ? `<button type="button" class="hazard-chip-delete" data-delete-hazard="${escapeHtml(hazard.id)}" aria-label="Delete hazard">×</button>` : "";
    return `
      <li class="hazard-chip hazard-chip-${meta.value}">
        <span class="hazard-chip-icon" aria-hidden="true">${meta.icon}</span>
        <span class="hazard-chip-body">
          <span class="hazard-chip-type">${meta.label}</span>
          ${details}
          ${noteHtml}
        </span>
        ${deleteBtn}
      </li>`;
  }

  function describeHazard(hazard) {
    const parts = [];
    const sideMeta = hazardSideMeta(hazard.side);
    if (sideMeta) parts.push(sideMeta.label);
    if (Number.isFinite(hazard.startYards) && Number.isFinite(hazard.carryYards)) {
      parts.push(`${hazard.startYards}-${hazard.carryYards}y carry`);
    } else if (Number.isFinite(hazard.carryYards)) {
      parts.push(`${hazard.carryYards}y carry`);
    } else if (Number.isFinite(hazard.startYards)) {
      parts.push(`from ${hazard.startYards}y`);
    }
    return parts.join(" · ");
  }

  // The Deerwood catalog entries ship without per-hole `label` fields
  // (intentionally, to keep that data file compact). Without a label like
  // "Buck 3" / "Doe 5" / "Fawn 2", physicalHoleId() can't pool plays
  // across tee variants — every Buck 3 from Blue vs White vs Red looks
  // like its own physical hole and the heatmap fails to aggregate. Derive
  // the nine from the course id and inject the canonical label here.
  function deerwoodNineFromCourseId(courseId) {
    if (!courseId || !isDeerwoodCourseId(courseId)) return null;
    if (/-buck-/.test(courseId)) return "Buck";
    if (/-doe-/.test(courseId)) return "Doe";
    if (/-fawn-/.test(courseId)) return "Fawn";
    return null;
  }

  function normalizeCourse(course) {
    const holes = Array.isArray(course.holes) ? course.holes.map(toHole) : [];
    const nine = deerwoodNineFromCourseId(course.id);
    if (nine) {
      holes.forEach((h) => {
        const ok = typeof h.label === "string" && /^(buck|doe|fawn)\s+\d+$/i.test(h.label);
        if (!ok) h.label = `${nine} ${h.number}`;
      });
    }
    return {
      ...course,
      rating: Number.isFinite(Number(course.rating)) ? Number(course.rating) : null,
      slope: Number.isFinite(Number(course.slope)) ? Number(course.slope) : null,
      holes
    };
  }

  // Migrate already-saved Deerwood rounds whose holes were stored with
  // numeric labels (1, 2, 3 ...) instead of "Buck 1" / "Doe 5" / "Fawn 2".
  // Purely additive — only overwrites labels that fail the regex. Idempotent
  // and safe to call on every load. Without this, snapshots/imports from
  // before this fix would still mis-pool in the heatmap.
  function ensureDeerwoodRoundLabels(stateValue) {
    if (!stateValue || !Array.isArray(stateValue.rounds)) return stateValue;
    stateValue.rounds.forEach((round) => {
      const nine = deerwoodNineFromCourseId(round.courseId);
      if (!nine || !Array.isArray(round.holes)) return;
      round.holes.forEach((hole) => {
        if (!hole || !Number.isFinite(hole.number)) return;
        const ok = typeof hole.label === "string" && /^(buck|doe|fawn)\s+\d+$/i.test(hole.label);
        if (!ok) hole.label = `${nine} ${hole.number}`;
      });
    });
    return stateValue;
  }

  function loadCourseCatalog() {
    const courses = window.__golfCourseCatalog;
    if (!Array.isArray(courses)) {
      console.error("Course catalog is missing. Make sure data/courses.js loads before app.js.");
      els.courseList.innerHTML = emptyState("Course catalog could not load. Make sure data/courses.js is present alongside app.js.");
      return [];
    }
    return courses.map(normalizeCourse);
  }

  function buildSampleRounds() {
    if (!sampleCourses.length) return [];
    return [
      makeSampleRound("2026-04-18", "ridgeview-blue", [5, 5, 4, 6, 5, 4, 3, 7, 5, 5, 4, 5, 6, 6, 4, 4, 6, 6], "First round tracked"),
      makeSampleRound("2026-04-25", "lake-county-white", [6, 5, 4, 4, 6, 6, 5, 4, 5, 5, 6, 3, 5, 5, 4, 6, 5, 5], "Better putting day"),
      makeSampleRound("2026-05-02", "ridgeview-blue", [4, 5, 3, 6, 5, 5, 4, 6, 4, 5, 5, 4, 7, 5, 4, 5, 6, 5], "Driver missed right"),
      makeSampleRound("2026-05-09", "ridgeview-blue", [5, 4, 4, 5, 4, 5, 3, 6, 5, 4, 4, 4, 6, 5, 5, 4, 5, 5], "Clean back nine"),
      makeSampleRound("2026-05-12", "lake-county-white", [5, 5, 5, 3, 5, 7, 4, 4, 5, 4, 6, 4, 6, 4, 5, 6, 5, 4], "Penalty on 6"),
      makeSampleRound("2026-05-15", "ridgeview-blue", [4, 4, 4, 5, 5, 4, 3, 6, 4, 5, 4, 3, 6, 5, 4, 4, 5, 5], "Best tee day")
    ];
  }

  // Sample-data fixture builder. Distinct from the lib's makeRound (which is
  // the generic Round constructor) — this one fabricates plausible fairway/
  // gir/putts/penalty values from a score-only input so the demo data feels
  // real without making us hand-roll every field. Routes through the lib
  // builders so sample rounds carry the full canonical shape.
  function makeSampleRound(date, courseId, scores, note) {
    const course = sampleCourses.find((candidate) => candidate.id === courseId);
    return makeRound({
      id: makeId("round"),
      date,
      courseId,
      tee: course.tee,
      note,
      holes: course.holes.map((hole, index) => {
        const score = scores[index];
        const over = score - hole.par;
        return makeHole({
          number: hole.number,
          label: hole.label || String(hole.number),
          par: hole.par,
          yards: hole.yards,
          hcp: hole.hcp || null,
          score,
          putts: over <= 0 ? 1 : over >= 2 ? 3 : 2,
          fairway: hole.par === 3 ? "na" : index % 5 === 0 ? "right" : index % 4 === 0 ? "left" : "hit",
          gir: score <= hole.par + 1 && index % 4 !== 1,
          penalties: over >= 2 && index % 3 === 0 ? 1 : 0
        });
      })
    });
  }

  function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.courses) && Array.isArray(saved.rounds)) {
        // Pass every saved round through the canonical Round shape so older
        // saves (missing wind, narrative, firstPuttDistance, etc.) pick up
        // the new fields with their defaults. Unknown fields are preserved.
        saved.rounds = saved.rounds.map(normalizeRound);
        return ensureGolfLabShape(ensureDeerwoodRoundLabels(ensureProfileShape(ensureCourseDataShape(mergeNewDefaultCourses(saved)))));
      }
    } catch (error) {
      console.warn("Could not load saved golf data", error);
    }
    // First launch: ship with the course catalog but no sample rounds.
    // The header's "Sample data" button still loads the sample rounds for
    // anyone who wants to poke at populated UI without playing a round.
    // Showing strangers Jeff's test scores on first open is the previous
    // behavior we deliberately ditched.
    return ensureGolfLabShape(ensureProfileShape(ensureCourseDataShape({
      courses: structuredClone(sampleCourses),
      rounds: [],
      golfLab: blankGolfLabState()
    })));
  }

  function ensureGolfLabShape(stateValue) {
    if (!stateValue) return stateValue;
    stateValue.golfLab = normalizeGolfLabState(stateValue.golfLab);
    return stateValue;
  }

  // Profile is new (#56-era) — older saved states won't have it. Default the
  // bag to every known club so existing behavior is unchanged until the user
  // trims it on the Profile tab.
  function ensureProfileShape(stateValue) {
    if (!stateValue) return stateValue;
    if (!stateValue.profile || typeof stateValue.profile !== "object") {
      stateValue.profile = {};
    }
    if (!Array.isArray(stateValue.profile.bag) || !stateValue.profile.bag.length) {
      stateValue.profile.bag = [...CLUB_OPTIONS];
    } else {
      // Strip any clubs that aren't part of our known set (defensive against
      // hand-edited JSON imports).
      const known = new Set(CLUB_OPTIONS);
      stateValue.profile.bag = stateValue.profile.bag.filter((club) => known.has(club));
      if (!stateValue.profile.bag.length) stateValue.profile.bag = [...CLUB_OPTIONS];
    }
    return stateValue;
  }

  function ensureCourseDataShape(stateValue) {
    if (!stateValue || !Array.isArray(stateValue.courses)) return stateValue;
    stateValue.courses.forEach((course) => {
      if (!Array.isArray(course.holes)) return;
      course.holes.forEach((hole) => {
        if (!Array.isArray(hole.hazards)) hole.hazards = [];
        hole.hazards = hole.hazards.map(normalizeHazard).filter(Boolean);
      });
    });
    mirrorHazardsAcrossSiblings(stateValue.courses);
    return stateValue;
  }

  // Two course entries are "siblings" when they represent the same physical
  // layout played from different tees (e.g. Deerwood Buck White & Buck Blue).
  // Hazards live on the ground, not on the tee box, so they should be shared.
  function getSiblingCourses(courseId, courses = state.courses) {
    const target = courses.find((c) => c.id === courseId);
    if (!target) return [];
    return courses.filter((c) => c.id !== courseId && c.name === target.name);
  }

  function mirrorHazardsAcrossSiblings(courses) {
    if (!Array.isArray(courses)) return;
    const byName = new Map();
    courses.forEach((course) => {
      if (!course.name) return;
      const group = byName.get(course.name) || [];
      group.push(course);
      byName.set(course.name, group);
    });
    byName.forEach((group) => {
      if (group.length < 2) return;
      // Build a merged hazard list per hole number across the group.
      const mergedByHole = new Map();
      group.forEach((course) => {
        if (!Array.isArray(course.holes)) return;
        course.holes.forEach((hole) => {
          if (!Array.isArray(hole.hazards)) return;
          const existing = mergedByHole.get(hole.number) || new Map();
          hole.hazards.forEach((haz) => {
            if (haz && haz.id && !existing.has(haz.id)) existing.set(haz.id, haz);
          });
          mergedByHole.set(hole.number, existing);
        });
      });
      // Write the merged list back to every course in the group.
      group.forEach((course) => {
        if (!Array.isArray(course.holes)) return;
        course.holes.forEach((hole) => {
          const merged = mergedByHole.get(hole.number);
          if (merged && merged.size) hole.hazards = [...merged.values()];
        });
      });
    });
  }

  function mergeNewDefaultCourses(saved) {
    // For Deerwood courses, refresh from the latest sample data so layout/
    // par/yardage updates land on returning users — but preserve any user-
    // entered hazards on those holes.
    const defaultDeerwoodCourses = sampleCourses.filter((course) => isDeerwoodCourseId(course.id));
    const defaultDeerwoodById = new Map(defaultDeerwoodCourses.map((course) => [course.id, course]));
    const updatedCourses = saved.courses.map((course) => {
      if (!defaultDeerwoodById.has(course.id)) return course;
      const fresh = structuredClone(defaultDeerwoodById.get(course.id));
      // Preserve any user-entered hazards from the existing course copy.
      fresh.holes = fresh.holes.map((hole) => {
        const existing = (course.holes || []).find((h) => h.number === hole.number);
        const userHazards = existing && Array.isArray(existing.hazards) ? existing.hazards : null;
        return {
          ...hole,
          hazards: userHazards && userHazards.length ? userHazards : (hole.hazards || [])
        };
      });
      return fresh;
    });
    // Add ANY default catalog course the user doesn't have yet — Deerwood
    // and every other shipped course (Ridgeview, Lake County, the WNY
    // additions and their tee variants). Previously this was restricted to
    // Deerwood-prefixed ids, which meant new courses added in later deploys
    // silently never appeared for returning users (they only showed up on a
    // fresh install). That was a real bug — fixed by widening the filter.
    const existingCourseIds = new Set(updatedCourses.map((course) => course.id));
    const missingDefaultCourses = sampleCourses.filter(
      (course) => !existingCourseIds.has(course.id)
    );

    const migrated = {
      ...saved,
      courses: [...updatedCourses, ...structuredClone(missingDefaultCourses)]
    };
    if (!missingDefaultCourses.length && JSON.stringify(updatedCourses) === JSON.stringify(saved.courses)) return saved;

    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  }

  function saveState() {
    const json = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, json);
    // Best-effort autosave snapshot. Throttled + deduped inside takeSnapshot
    // so this stays cheap even on a per-keystroke save path.
    takeSnapshot("autosave", { json });
  }

  // ---- Snapshot system: rolling backups in localStorage ------------------
  //
  // Every saveState (throttled + deduped) and every destructive action
  // (Clear, Sample Data replace, Import) writes a copy of state under a
  // timestamped key. The Profile tab surfaces these as one-tap restore
  // points. This is the user's safety net against fat-finger Clears, bad
  // imports, and browser cache eviction — *as long as* localStorage itself
  // survives. Pair with the Export button for off-device durability.

  const SNAPSHOT_KEY_PREFIX = "fairwayLedger.snapshot.v1.";
  const SNAPSHOT_MAX = 20;
  // Autosave snapshots are deduped by JSON and gated to one per this
  // interval, so saving 30 rounds in a row doesn't burn through the cap.
  const SNAPSHOT_AUTO_MIN_INTERVAL_MS = 10 * 60 * 1000;

  const SNAPSHOT_REASON_LABELS = {
    autosave: "Autosave",
    manual: "Manual",
    "before-clear": "Before Clear",
    "before-sample": "Before Sample Data",
    "before-import": "Before Import",
    "pre-restore": "Before Restore"
  };

  let lastSnapshotJson = null;
  let lastSnapshotAt = 0;

  function listSnapshots() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(SNAPSHOT_KEY_PREFIX)) continue;
        try {
          const raw = JSON.parse(localStorage.getItem(key));
          if (!raw || !raw.state) continue;
          out.push({
            key,
            takenAt: raw.takenAt || null,
            reason: raw.reason || "autosave",
            roundCount: Number.isFinite(raw.roundCount)
              ? raw.roundCount
              : (Array.isArray(raw.state.rounds) ? raw.state.rounds.length : 0),
            courseCount: Number.isFinite(raw.courseCount)
              ? raw.courseCount
              : (Array.isArray(raw.state.courses) ? raw.state.courses.length : 0),
            bytes: (localStorage.getItem(key) || "").length
          });
        } catch {}
      }
    } catch {}
    out.sort((a, b) => (b.takenAt || "").localeCompare(a.takenAt || ""));
    return out;
  }

  function pruneSnapshots(extraDrop = 0) {
    const snaps = listSnapshots();
    const keepCount = Math.max(0, SNAPSHOT_MAX - extraDrop);
    if (snaps.length <= keepCount) return;
    snaps.slice(keepCount).forEach((s) => {
      try { localStorage.removeItem(s.key); } catch {}
    });
  }

  function takeSnapshot(reason = "autosave", opts = {}) {
    const force = opts.force === true;
    const providedJson = typeof opts.json === "string" ? opts.json : null;
    try {
      const stateJson = providedJson != null ? providedJson : JSON.stringify(state);
      const now = Date.now();
      if (!force && reason === "autosave") {
        // Skip if state hasn't changed since the last snapshot, OR if we
        // already snapped recently. Avoids 20 near-identical autosaves
        // pushing out the meaningful pre-destructive ones.
        if (stateJson === lastSnapshotJson) return null;
        if (now - lastSnapshotAt < SNAPSHOT_AUTO_MIN_INTERVAL_MS) return null;
      }
      const takenAt = new Date(now).toISOString();
      const key = SNAPSHOT_KEY_PREFIX + takenAt.replace(/[:.]/g, "-");
      const payload = {
        takenAt,
        reason,
        roundCount: Array.isArray(state.rounds) ? state.rounds.length : 0,
        courseCount: Array.isArray(state.courses) ? state.courses.length : 0,
        state: JSON.parse(stateJson)
      };
      const serialized = JSON.stringify(payload);
      try {
        localStorage.setItem(key, serialized);
      } catch (quotaErr) {
        // Quota exceeded — drop oldest snapshots and retry once. The
        // committed state in STORAGE_KEY is untouched either way.
        pruneSnapshots(3);
        try { localStorage.setItem(key, serialized); }
        catch { return null; }
      }
      lastSnapshotJson = stateJson;
      lastSnapshotAt = now;
      pruneSnapshots();
      return key;
    } catch {
      return null;
    }
  }

  function restoreSnapshot(snapshotKey) {
    let payload = null;
    try {
      payload = JSON.parse(localStorage.getItem(snapshotKey));
    } catch {}
    if (!payload || !payload.state) return false;
    const incoming = payload.state;
    if (!Array.isArray(incoming.courses) || !Array.isArray(incoming.rounds)) return false;
    // Snap the CURRENT state first, so a restore can itself be undone.
    takeSnapshot("pre-restore", { force: true });
    const normalized = {
      ...incoming,
      rounds: incoming.rounds.map(normalizeRound)
    };
    state = ensureDeerwoodRoundLabels(ensureProfileShape(ensureCourseDataShape(mergeNewDefaultCourses(normalized))));
    clearEditState({ rerender: false });
    saveState();
    return true;
  }

  function deleteSnapshot(snapshotKey) {
    try { localStorage.removeItem(snapshotKey); return true; }
    catch { return false; }
  }

  // In-progress round auto-save. Captures the user's mid-entry form state to
  // a separate localStorage key on every input (debounced ~500ms) so that a
  // page reload, app crash, or accidental tab close doesn't lose hours of
  // on-course data entry. Distinct from saveState() which persists committed
  // rounds; this is the "draft" layer that lives between input and Save round.

  let inProgressSaveTimer = null;
  // True once the user has genuinely engaged with the round (entered a value,
  // tapped a pill, navigated holes). Pre-filled par/club defaults don't set
  // it — so just opening Add Round and looking around never writes a draft
  // or triggers a spurious "resume round in progress?" prompt next time.
  let roundTouched = false;

  // Add Round flow has two phases:
  //   - setup    : the user has just opened Add Round; no chips are
  //                pre-selected (blank by design), scorecard is hidden,
  //                "Start Round" CTA is the only path forward.
  //   - playing  : after the user picks course + tee and taps Start
  //                Round; scorecard is live, setup banner auto-collapses.
  // The flag flips back to "setup" on save / reset / clear so the next
  // round starts fresh again.
  //
  // Edit + resume-in-progress paths set roundStarted = true directly so
  // they skip the Start Round step entirely.
  let roundStarted = false;
  // Track which chip rows the user has explicitly tapped this setup. Chips
  // in untapped rows render with no active chip, even if the underlying
  // <select> has a value, so the form really does feel blank on entry.
  let setupChipRowsTapped = new Set();

  function resetRoundSetupState() {
    roundStarted = false;
    setupChipRowsTapped = new Set();
    courseChipsExpanded = false;
    applyRoundStartedUi();
  }
  function captureInProgressRound() {
    const snapshot = captureScorecardSnapshot();
    const holes = [];
    snapshot.forEach((values, holeNumber) => {
      holes.push({ number: holeNumber, ...values });
    });
    // For Deerwood 18-hole rounds the layout is NOT stored in roundLayout —
    // it's composed from roundFrontNine + roundBackNine ("doe-buck", etc).
    // Saving the bare roundLayout.value here meant 18-hole Deerwood drafts
    // serialized an empty/stale layoutId, and on resume the restore block
    // saw no layoutId → kept the default Buck-Doe order → the user's saved
    // hole scores reattached to the wrong physical holes. Always go through
    // getSelectedRoundLayoutId() so 9-hole and 18-hole both serialize the
    // canonical id that restore expects ("buck", "doe-buck", etc).
    const isDeerwood = els.roundCourse && els.roundCourse.value === DEERWOOD_COURSE_ID;
    const layoutId = isDeerwood ? getSelectedRoundLayoutId() : (els.roundLayout ? els.roundLayout.value || "" : "");
    return {
      v: 1,
      savedAt: Date.now(),
      date: els.roundDate ? els.roundDate.value || "" : "",
      course: els.roundCourse ? els.roundCourse.value || "" : "",
      holeCount: els.roundHoleCount ? els.roundHoleCount.value || "" : "",
      layoutId,
      tee: els.roundTee ? els.roundTee.value || "" : "",
      wind: els.roundWind ? els.roundWind.value || "" : "",
      note: els.roundNote ? els.roundNote.value || "" : "",
      // Stash the optional reflection survey — captures only if the user
      // touched at least one field, so an empty draft stays lean.
      survey: surveyHasContent(pendingSurvey) ? getPendingSurvey() : null,
      holes,
      // Wire format mirrors the older flat-map layout so existing in-progress
      // drafts continue to restore — translate from unified pendingHoles.
      ...(() => {
        const holeNotes = {};
        const holeClubs = {};
        const holePenaltyClubs = {};
        Object.entries(pendingHoles).forEach(([key, data]) => {
          if (data.note) holeNotes[key] = data.note;
          if (data.clubs && data.clubs.length) holeClubs[key] = [...data.clubs];
          // Write the canonical array form. Legacy drafts wrote a single
          // string under the same key — restore handles both shapes.
          if (Array.isArray(data.penaltyClubs) && data.penaltyClubs.length) {
            holePenaltyClubs[key] = data.penaltyClubs.slice();
          } else if (data.penaltyClub) {
            holePenaltyClubs[key] = [data.penaltyClub];
          }
        });
        return { holeNotes, holeClubs, holePenaltyClubs };
      })()
    };
  }

  function scheduleInProgressSave() {
    // Never auto-save while the user is editing a previously-saved round —
    // that path uses the real state.rounds[i] and its own lifecycle.
    if (editingRoundId) return;
    // Don't write a draft until the user has actually engaged — pre-filled
    // par/club defaults alone are not "a round in progress".
    if (!roundTouched) return;
    if (inProgressSaveTimer) clearTimeout(inProgressSaveTimer);
    inProgressSaveTimer = setTimeout(() => {
      const draft = captureInProgressRound();
      const hasScores = draft.holes.some((h) => {
        const score = Number(h.score);
        return Number.isFinite(score) && score > 0;
      });
      const hasNotes = Object.keys(draft.holeNotes || {}).length > 0;
      // Note: clubs are intentionally NOT a "started a round" signal — they're
      // pre-seeded with Driver/Putter defaults, so counting them would flag a
      // round in progress before the user has actually entered anything.
      if (!hasScores && !hasNotes) {
        // Empty draft — don't pollute storage with placeholder rows.
        clearInProgressRound();
        return;
      }
      try { localStorage.setItem(IN_PROGRESS_KEY, JSON.stringify(draft)); } catch {}
    }, IN_PROGRESS_DEBOUNCE_MS);
  }

  function clearInProgressRound() {
    if (inProgressSaveTimer) {
      clearTimeout(inProgressSaveTimer);
      inProgressSaveTimer = null;
    }
    try { localStorage.removeItem(IN_PROGRESS_KEY); } catch {}
  }

  function loadInProgressRound() {
    try {
      const raw = localStorage.getItem(IN_PROGRESS_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data && data.v === 1 ? data : null;
    } catch {
      return null;
    }
  }

  function restoreInProgressRound(data) {
    if (!data) return;
    // Resuming an in-progress round means the user already passed the
    // Start Round step — flip the flag so chips render their selection
    // and the scorecard is live (not the setup placeholder).
    roundStarted = true;
    SETUP_CHIP_ROW_IDS.forEach((id) => setupChipRowsTapped.add(id));
    if (data.date) els.roundDate.value = data.date;
    if (data.course) els.roundCourse.value = data.course;
    if (data.note) els.roundNote.value = data.note;
    if (els.roundWind) els.roundWind.value = data.wind || "";
    // Re-render Deerwood option visibility based on the chosen course,
    // then set holeCount/layout/tee in the correct order so the layout
    // dropdown's options match the hole count before we assign a value.
    renderRoundSetupOptions();
    if (data.holeCount) {
      els.roundHoleCount.value = data.holeCount;
      renderRoundSetupOptions();
    }
    if (data.tee) els.roundTee.value = data.tee;
    if (data.layoutId) {
      if (data.holeCount === "9") {
        els.roundLayout.value = data.layoutId;
      } else {
        const [front, back] = String(data.layoutId).split("-");
        if (DEERWOOD_NINE_IDS.includes(front)) els.roundFrontNine.value = front;
        if (DEERWOOD_NINE_IDS.includes(back)) els.roundBackNine.value = back;
      }
      renderRoundSetupOptions();
    }
    resetPendingHoles(); resetReviewState();
    // Restore the optional survey draft if one was saved. resetPendingSurvey
    // first so a stale prior session doesn't bleed through.
    resetPendingSurvey();
    if (data.survey && typeof data.survey === "object") {
      if (data.survey.feel) setSurveyField("feel", data.survey.feel);
      if (data.survey.confidence) setSurveyField("confidence", data.survey.confidence);
      if (data.survey.swingThoughts) setSurveyField("swingThoughts", data.survey.swingThoughts);
      if (data.survey.wentWell) setSurveyField("wentWell", data.survey.wentWell);
      if (data.survey.workOn) setSurveyField("workOn", data.survey.workOn);
      if (data.survey.ratings && typeof data.survey.ratings === "object") {
        ["driver", "irons", "wedges", "putter"].forEach((club) => {
          if (Number.isFinite(data.survey.ratings[club])) setSurveyRating(club, data.survey.ratings[club]);
        });
      }
    }
    syncSurveyUiFromState();
    Object.entries(data.holeNotes || {}).forEach(([num, note]) => setHoleNote(num, note));
    Object.entries(data.holeClubs || {}).forEach(([num, clubs]) => {
      if (Array.isArray(clubs) && clubs.length) setHoleClubs(Number(num), clubs);
    });
    Object.entries(data.holePenaltyClubs || {}).forEach(([num, value]) => {
      // Back-compat: legacy drafts stored a single string; new drafts
      // store an array. Accept both.
      if (Array.isArray(value) && value.length) {
        setHolePenaltyClubs(Number(num), value);
      } else if (typeof value === "string" && value) {
        setHolePenaltyClub(Number(num), value);
      }
    });
    renderScorecard(getSelectedRoundCourse());
    renderCourseBrief();
    const snapshotMap = new Map();
    (data.holes || []).forEach((h) => {
      if (h && h.number != null) snapshotMap.set(Number(h.number), h);
    });
    applyScorecardSnapshot(snapshotMap);
    // A resumed round is genuinely in progress — keep autosaving its edits.
    roundTouched = true;
    updateRoundPreview();
    setActiveTab("rounds");
  }

  function maybeResumeInProgressRound() {
    if (editingRoundId) return; // edit mode owns the form
    const data = loadInProgressRound();
    if (!data) return;
    const scoreCount = (data.holes || []).filter((h) => {
      const score = Number(h.score);
      return Number.isFinite(score) && score > 0;
    }).length;
    const noteCount = Object.keys(data.holeNotes || {}).length;
    if (!scoreCount && !noteCount) {
      clearInProgressRound();
      return;
    }
    const parts = [];
    if (scoreCount) parts.push(`${scoreCount} hole${scoreCount === 1 ? "" : "s"} scored`);
    if (noteCount) parts.push(`${noteCount} note${noteCount === 1 ? "" : "s"}`);
    let ageLabel = "";
    if (data.savedAt) {
      const ageMinutes = Math.floor((Date.now() - data.savedAt) / 60000);
      if (ageMinutes < 1) ageLabel = " (saved just now)";
      else if (ageMinutes < 60) ageLabel = ` (saved ${ageMinutes} min ago)`;
      else if (ageMinutes < 1440) ageLabel = ` (saved ${Math.floor(ageMinutes / 60)} hr ago)`;
      else ageLabel = ` (saved ${Math.floor(ageMinutes / 1440)} day${Math.floor(ageMinutes / 1440) === 1 ? "" : "s"} ago)`;
    }
    const summary = parts.join(", ");
    const ok = window.confirm(
      `Resume round in progress?\n\n${summary}${ageLabel}.\n\nOK to resume, Cancel to discard.`
    );
    if (ok) {
      restoreInProgressRound(data);
      showToast("Resumed round in progress.");
    } else {
      clearInProgressRound();
      showToast("Discarded in-progress round.");
    }
  }

  function readBackupMeta() {
    try {
      const raw = localStorage.getItem(BACKUP_META_KEY);
      if (!raw) return { lastExportAt: null, lastExportRoundCount: 0 };
      const parsed = JSON.parse(raw);
      return {
        lastExportAt: typeof parsed.lastExportAt === "string" ? parsed.lastExportAt : null,
        lastExportRoundCount: Number.isFinite(parsed.lastExportRoundCount) ? parsed.lastExportRoundCount : 0
      };
    } catch {
      return { lastExportAt: null, lastExportRoundCount: 0 };
    }
  }

  function writeBackupMeta(meta) {
    localStorage.setItem(BACKUP_META_KEY, JSON.stringify(meta));
  }

  function unbackedRoundCount() {
    const meta = readBackupMeta();
    return Math.max(0, state.rounds.length - meta.lastExportRoundCount);
  }

  function describeLastBackup() {
    const meta = readBackupMeta();
    if (!meta.lastExportAt) return "Last backup: never";
    const exportDate = new Date(meta.lastExportAt);
    if (Number.isNaN(exportDate.getTime())) return "Last backup: unknown";
    const today = new Date();
    const days = Math.floor((today - exportDate) / (24 * 60 * 60 * 1000));
    if (days <= 0) return `Last backup: today (${exportDate.toLocaleDateString()})`;
    if (days === 1) return `Last backup: yesterday (${exportDate.toLocaleDateString()})`;
    return `Last backup: ${days} days ago (${exportDate.toLocaleDateString()})`;
  }

  function updateBackupBadge() {
    if (!els.exportBadge || !els.exportButton) return;
    const unbacked = unbackedRoundCount();
    const stale = unbacked >= BACKUP_NAG_THRESHOLD;
    if (stale) {
      els.exportBadge.textContent = String(unbacked);
      els.exportBadge.hidden = false;
      els.exportButton.classList.add("export-stale");
    } else {
      els.exportBadge.textContent = "";
      els.exportBadge.hidden = true;
      els.exportButton.classList.remove("export-stale");
    }
    els.exportButton.title = `${describeLastBackup()}${unbacked ? ` | ${unbacked} round${unbacked === 1 ? "" : "s"} since last export` : ""}`;
  }

  function getCourse(courseId) {
    if (isDeerwoodCourseId(courseId)) {
      return buildDeerwoodCourseFromId(courseId) || state.courses.find((course) => course.id === courseId);
    }
    return state.courses.find((course) => course.id === courseId);
  }

  function deerwoodCourseId(layoutId, tee) {
    return `deerwood-${layoutId}-${tee.toLowerCase()}`;
  }

  function getDeerwoodNineCourse(nineId, tee) {
    const courseId = deerwoodCourseId(nineId, tee);
    // Prefer state (user-owned data — has hazards) over the catalog
    // (read-only seed data). Falls back to catalog if the user has
    // somehow cleared a Deerwood entry from state.
    return state.courses.find((course) => course.id === courseId)
      || sampleCourses.find((course) => course.id === courseId);
  }

  const DEERWOOD_NINE_IDS = ["buck", "doe", "fawn"];

  function getDeerwoodLayout(holeCount, layoutId) {
    if (String(holeCount) === "9") {
      const nine = deerwoodLayoutOptions["9"].find((layout) => layout.id === layoutId);
      return nine || deerwoodLayoutOptions["9"][0];
    }
    // 18-hole: layoutId is "{front}-{back}" — any of the 6 permutations.
    const parts = String(layoutId).split("-");
    const front = DEERWOOD_NINE_IDS.includes(parts[0]) ? parts[0] : "buck";
    const back = DEERWOOD_NINE_IDS.includes(parts[1]) ? parts[1] : "doe";
    return {
      id: `${front}-${back}`,
      label: `${deerwoodNineLabels[front]} / ${deerwoodNineLabels[back]}`,
      nines: [front, back]
    };
  }

  function buildDeerwoodCourse(holeCount, layoutId, tee) {
    const selectedTee = DEERWOOD_TEE_OPTIONS.includes(tee) ? tee : "White";
    const layout = getDeerwoodLayout(holeCount, layoutId);
    let nextHoleNumber = 1;
    const holes = layout.nines.flatMap((nineId) => {
      const nineCourse = getDeerwoodNineCourse(nineId, selectedTee);
      if (!nineCourse) return [];
      return nineCourse.holes.map((hole) => ({
        ...hole,
        number: nextHoleNumber++,
        label: `${deerwoodNineLabels[nineId]} ${hole.number}`
      }));
    });
    const nines = layout.nines.map((nineId) => getDeerwoodNineCourse(nineId, selectedTee)).filter(Boolean);
    const rating = nines.reduce((sum, course) => sum + Number(course.rating || 0), 0);
    const slope = Math.round(average(nines.map((course) => Number(course.slope || 0))));

    return {
      id: deerwoodCourseId(layout.id, selectedTee),
      name: `Deerwood Golf Course - ${layout.label}`,
      tee: selectedTee,
      rating: Number(rating.toFixed(1)),
      slope,
      builtIn: true,
      holes
    };
  }

  function buildDeerwoodCourseFromId(courseId) {
    if (!isDeerwoodCourseId(courseId)) return undefined;
    const parts = String(courseId).replace("deerwood-", "").split("-");
    const teePart = parts.pop();
    const tee = DEERWOOD_TEE_OPTIONS.find((option) => option.toLowerCase() === teePart);
    const layoutId = parts.join("-");
    if (!tee || !layoutId) return undefined;
    const holeCount = layoutId.includes("-") ? "18" : "9";
    return buildDeerwoodCourse(holeCount, layoutId, tee);
  }

  function getSelectedRoundLayoutId() {
    if (els.roundHoleCount.value === "9") return els.roundLayout.value;
    const front = DEERWOOD_NINE_IDS.includes(els.roundFrontNine.value) ? els.roundFrontNine.value : "buck";
    const back = DEERWOOD_NINE_IDS.includes(els.roundBackNine.value) ? els.roundBackNine.value : "doe";
    return `${front}-${back}`;
  }

  function getSelectedRoundCourse() {
    if (els.roundCourse.value === DEERWOOD_COURSE_ID) {
      return buildDeerwoodCourse(els.roundHoleCount.value, getSelectedRoundLayoutId(), els.roundTee.value);
    }
    const base = getCourse(els.roundCourse.value);
    if (!base || els.roundHoleCount.value !== "9") return base;
    // Non-Deerwood 9-hole round: slice the catalog course to the chosen
    // half. Hole numbers are preserved (Back 9 keeps holes 10..18) so
    // physicalHoleId("course:arrowhead-white:12") pools correctly with
    // hole 12 of any 18-hole round at the same course.
    const half = els.roundLayout.value === "back" ? "back" : "front";
    const all = Array.isArray(base.holes) ? base.holes : [];
    const sliced = half === "back"
      ? all.slice(Math.max(0, all.length - 9))  // last 9 (or fewer if odd catalog)
      : all.slice(0, 9);                         // first 9
    return { ...base, holes: sliced };
  }

  function ensureSavedCourse(course) {
    if (!course || state.courses.some((candidate) => candidate.id === course.id)) return;
    state.courses.push(course);
  }

  function getFilteredRounds() {
    const courseValue = els.filterCourse.value || "all";
    const teeValue = els.filterTee.value || "all";
    const tagValue = els.filterTag ? (els.filterTag.value || "all") : "all";
    let rounds = [...state.rounds];

    if (courseValue === DEERWOOD_COURSE_ID) {
      rounds = rounds.filter((round) => isDeerwoodCourseId(round.courseId));
    } else if (courseValue !== "all") {
      rounds = rounds.filter((round) => round.courseId === courseValue);
    }

    if (teeValue !== "all") {
      rounds = rounds.filter((round) => round.tee === teeValue);
    }

    if (tagValue === "untagged") {
      rounds = rounds.filter((round) => !round.tag);
    } else if (tagValue !== "all") {
      rounds = rounds.filter((round) => round.tag === tagValue);
    }

    rounds.sort((a, b) => b.date.localeCompare(a.date));

    if (els.filterWindow.value === "last5") rounds = rounds.slice(0, 5);
    if (els.filterWindow.value === "last10") rounds = rounds.slice(0, 10);
    if (els.filterWindow.value === "last20") rounds = rounds.slice(0, 20);
    if (els.filterWindow.value === "year") {
      const year = String(new Date().getFullYear());
      rounds = rounds.filter((round) => round.date.startsWith(year));
    }

    return rounds;
  }

  // ---- Physical course grouping -----------------------------------------
  //
  // The catalog stores one entry per course-tee combination (so Diamond Hawk
  // has 5 entries for Black/Gold/Green/Silver/Burgundy). For the UI we
  // collapse those down to one "physical" course chip, with the tee picked
  // separately — exactly like Deerwood already works. Internal code that
  // looks up rating/slope/yardage continues to use the specific catalog id.

  const PREFERRED_TEE_KEY = "fairwayLedger.preferredTee.v1";

  // The user-facing name for whatever physical course a courseId refers to.
  // Deerwood's six per-nine entries all collapse to "Deerwood Golf Course";
  // every other course's tee variants share their course.name.
  function physicalCourseName(courseId) {
    if (isDeerwoodCourseId(courseId) || courseId === DEERWOOD_COURSE_ID) {
      return "Deerwood Golf Course";
    }
    const course = getCourse(courseId);
    return course ? course.name : courseId;
  }

  // All physical course names available in the catalog, Deerwood first.
  function getPhysicalCourseNames() {
    const seen = new Set();
    const names = [];
    state.courses.forEach((course) => {
      const name = physicalCourseName(course.id);
      if (seen.has(name)) return;
      seen.add(name);
      names.push(name);
    });
    names.sort((a, b) => {
      if (a === "Deerwood Golf Course") return -1;
      if (b === "Deerwood Golf Course") return 1;
      return a.localeCompare(b);
    });
    return names;
  }

  // All catalog entries matching a physical course name (one per tee).
  // Deerwood collapses every nine+tee entry to a single bucket.
  function getCatalogEntriesForCourseName(name) {
    if (name === "Deerwood Golf Course") {
      return state.courses.filter((c) => isDeerwoodCourseId(c.id));
    }
    return state.courses.filter((c) => c.name === name);
  }

  // Distinct tees available at a physical course — alphabetical, no dupes.
  function getTeesForCourseName(name) {
    return [...new Set(getCatalogEntriesForCourseName(name).map((c) => c.tee))].sort();
  }

  function getPreferredTee(courseName) {
    try {
      const raw = localStorage.getItem(PREFERRED_TEE_KEY);
      const map = raw ? JSON.parse(raw) : {};
      return map[courseName] || null;
    } catch { return null; }
  }

  function setPreferredTee(courseName, tee) {
    try {
      const raw = localStorage.getItem(PREFERRED_TEE_KEY);
      const map = raw ? JSON.parse(raw) : {};
      map[courseName] = tee;
      localStorage.setItem(PREFERRED_TEE_KEY, JSON.stringify(map));
    } catch {}
  }

  // ---- Chip-style form selectors ----------------------------------------
  //
  // Selects marked with [data-use-chips="true"] are hidden in CSS and mirrored
  // as a row of tap-friendly chip buttons. The native <select> remains the
  // source of truth — chips set its value + dispatch a synthetic 'change',
  // so every existing reader/listener keeps working. After any code that
  // rebuilds a select's options, call syncAllChipsToSelects() (already
  // wired into renderAll + the setup change handlers).

  function initSelectChips() {
    document.querySelectorAll('select[data-use-chips="true"]').forEach((select) => {
      if (select.dataset.chipsInit === "true") return;
      const row = document.createElement("div");
      row.className = "select-chips";
      row.dataset.chipsFor = select.id;
      select.parentNode.insertBefore(row, select.nextSibling);
      select.dataset.chipsInit = "true";
      row.addEventListener("click", (event) => {
        // "More courses ▾" expander on the Course row — show/hide the
        // courses the user hasn't played yet.
        const toggleChip = event.target.closest('[data-chip-action="toggle-courses"]');
        if (toggleChip) {
          courseChipsExpanded = !courseChipsExpanded;
          syncChipsForSelect(select);
          return;
        }
        // Course-name chips (round-setup roundCourse only) — collapse all
        // tee variants under one chip and pick a sensible default tee.
        const courseChip = event.target.closest("[data-chip-course-name]");
        if (courseChip) {
          markSetupChipRowTapped(select.id);
          handleCourseNameChipClick(select, courseChip.dataset.chipCourseName);
          return;
        }
        const chip = event.target.closest("[data-chip-value]");
        if (!chip) return;
        const value = chip.dataset.chipValue;
        markSetupChipRowTapped(select.id);
        // Tee chip for non-Deerwood courses: changing tee should also swap
        // roundCourse.value to the catalog entry matching {course, tee}.
        if (select.id === "roundTee"
            && els.roundCourse
            && els.roundCourse.value !== DEERWOOD_COURSE_ID
            && !isDeerwoodCourseId(els.roundCourse.value)) {
          handleNonDeerwoodTeeChange(value);
          return;
        }
        if (select.value === value) return;
        select.value = value;
        // Re-render this chip row immediately so the new active chip shows
        // even when no downstream change listener re-syncs (e.g. wind).
        syncChipsForSelect(select);
        // Bubbles so any listener on form / parent picks it up.
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
    syncAllChipsToSelects();
  }

  // Click handler for the grouped Course chips. Picks the catalog entry for
  // the user's preferred tee at that course (or the first available).
  function handleCourseNameChipClick(select, courseName) {
    let targetValue;
    if (courseName === "Deerwood Golf Course") {
      targetValue = DEERWOOD_COURSE_ID;
    } else {
      const entries = getCatalogEntriesForCourseName(courseName);
      if (!entries.length) return;
      const preferredTee = getPreferredTee(courseName);
      const preferred = entries.find((e) => e.tee === preferredTee);
      targetValue = preferred ? preferred.id : entries[0].id;
    }
    if (select.value === targetValue) return;
    select.value = targetValue;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Click handler for the Tee chips when a non-Deerwood course is selected.
  // Updates roundCourse.value to the catalog entry matching {course, newTee}
  // and remembers the new tee as the user's preference for that course.
  function handleNonDeerwoodTeeChange(newTee) {
    const physicalName = physicalCourseName(els.roundCourse.value);
    const matching = state.courses.find(
      (c) => c.name === physicalName && c.tee === newTee
    );
    if (!matching) return;
    setPreferredTee(physicalName, newTee);
    if (els.roundTee) els.roundTee.value = newTee;
    if (els.roundCourse.value !== matching.id) {
      els.roundCourse.value = matching.id;
      els.roundCourse.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // Same entry — still refresh chip active state.
      syncAllChipsToSelects();
    }
  }

  // ---- Start Round flow --------------------------------------------------
  //
  // The Add Round form opens "blank" — no chip is shown as active until the
  // user explicitly taps within that row. Once the required rows are tapped
  // (course + tee, plus Deerwood-specific rows for Deerwood), the Start
  // Round button enables. Tapping it flips into "playing" mode and the
  // scorecard renders.

  // Round-setup chip rows whose tapped-state we track for the "blank by
  // default" feel. roundWind is intentionally NOT in this list — wind is
  // an optional field, not a gate for starting the round.
  const SETUP_CHIP_ROW_IDS = new Set([
    "roundCourse",
    "roundTee",
    "roundHoleCount",
    "roundLayout",
    "roundFrontNine",
    "roundBackNine",
  ]);

  function markSetupChipRowTapped(rowId) {
    if (!SETUP_CHIP_ROW_IDS.has(rowId)) return;
    if (setupChipRowsTapped.has(rowId)) return;
    setupChipRowsTapped.add(rowId);
    // The tap may have just satisfied the Start Round requirements — refresh.
    applyRoundStartedUi();
  }

  function isSetupChipRowActiveForRender(rowId) {
    // When the round is in progress (or being edited), chip rows always
    // show their selection. Only the pre-Start-Round phase needs the
    // "blank until tapped" behavior.
    if (roundStarted || editingRoundId) return true;
    if (!SETUP_CHIP_ROW_IDS.has(rowId)) return true;
    return setupChipRowsTapped.has(rowId);
  }

  function isCourseDeerwoodSelected() {
    return els.roundCourse && els.roundCourse.value === DEERWOOD_COURSE_ID;
  }

  function hasSetupRowSelection(rowId, validValues) {
    if (setupChipRowsTapped.has(rowId)) return true;
    const select = document.getElementById(rowId);
    if (!select) return false;
    const value = select.value;
    return Array.isArray(validValues)
      ? validValues.includes(value)
      : value !== "";
  }

  // Conditions that must be met before Start Round enables. Returns an
  // explanatory hint string when not ready, or "" when ready to start.
  function getStartRoundBlocker() {
    if (!setupChipRowsTapped.has("roundCourse")) {
      return "Pick a course to begin.";
    }
    if (isCourseDeerwoodSelected()) {
      if (!setupChipRowsTapped.has("roundHoleCount")) return "Pick 9 or 18 holes.";
      if (!hasSetupRowSelection("roundTee", DEERWOOD_TEE_OPTIONS)) return "Pick your tee box.";
      const isNineHole = els.roundHoleCount.value === "9";
      if (isNineHole) {
        if (!hasSetupRowSelection("roundLayout", DEERWOOD_NINE_IDS)) return "Pick which nine you're playing.";
      } else {
        if (!hasSetupRowSelection("roundFrontNine", DEERWOOD_NINE_IDS)) return "Pick your front 9.";
        if (!hasSetupRowSelection("roundBackNine", DEERWOOD_NINE_IDS)) return "Pick your back 9.";
      }
      return "";
    }
    // Non-Deerwood: tee row may auto-resolve when the course has only one tee.
    const physicalName = physicalCourseName(els.roundCourse.value);
    const tees = getTeesForCourseName(physicalName);
    if (tees.length > 1 && !setupChipRowsTapped.has("roundTee")) {
      return "Pick your tee box.";
    }
    return "";
  }

  function applyRoundStartedUi() {
    if (!els.startRoundContainer || !els.startRoundButton) return;
    // Edit and resumed-in-progress rounds skip the Start Round step entirely.
    const showStart = !roundStarted && !editingRoundId;
    els.startRoundContainer.hidden = !showStart;
    if (showStart) {
      const blocker = getStartRoundBlocker();
      els.startRoundButton.disabled = !!blocker;
      if (els.startRoundHint) {
        els.startRoundHint.textContent = blocker || "Looks good — tap below to start scoring.";
      }
    }
    // Chip rows need re-sync so newly-tapped / un-tapped rows show right.
    syncAllChipsToSelects();
  }

  function startRound() {
    const blocker = getStartRoundBlocker();
    if (blocker) {
      showToast(blocker);
      return;
    }
    roundStarted = true;
    roundChromeAutoCollapsed = false; // let renderRoundSetupChrome collapse it again now that the round is "live"
    applyRoundStartedUi();
    // Re-render the scorecard now that we're in "playing" mode.
    renderScorecard(getSelectedRoundCourse());
    // Auto-collapse the setup section so the scorecard gets the screen.
    if (typeof renderRoundSetupChrome === "function") renderRoundSetupChrome();
  }

  function syncAllChipsToSelects() {
    document.querySelectorAll('select[data-use-chips="true"]').forEach(syncChipsForSelect);
  }

  function syncChipsForSelect(select) {
    const row = document.querySelector(`[data-chips-for="${select.id}"]`);
    if (!row) return;
    // The Course chip row is special — one chip per physical course name
    // instead of one per catalog id, so Diamond Hawk's 5 tee entries
    // collapse to a single tappable chip.
    if (select.id === "roundCourse") {
      return syncRoundCourseChips(select, row);
    }
    // For setup rows in the "blank by default" pre-Start-Round phase,
    // suppress the active class until the user has tapped a chip here.
    const showActive = isSetupChipRowActiveForRender(select.id);
    const currentValue = select.value;
    // Skip placeholder options whose value is "" (e.g. the leading "Wind…").
    // The unselected state is communicated by no chip being active.
    const opts = [...select.options].filter((opt) => opt.value !== "");
    row.innerHTML = opts.map((opt) => `
      <button type="button"
              class="select-chip${showActive && opt.value === currentValue ? " active" : ""}"
              data-chip-value="${escapeHtml(opt.value)}">
        ${escapeHtml(opt.text || opt.value)}
      </button>
    `).join("");
  }

  // Chip labels drop the "Golf Course / Golf Club / Golf Links" suffix —
  // on a phone, "Seneca Hickory Stick Golf Course" forces one chip per
  // line and the Course row becomes a 400px wall. Full names stay
  // everywhere else (selects, analytics, round detail).
  function shortCourseChipLabel(name) {
    return String(name).replace(/\s+(Golf\s+(Course|Club|Links)|Country\s+Club)$/i, "");
  }

  // Courses the user has actually played, most recent first. Drives the
  // played-first Course chip row: your usual tracks up top, everything
  // else behind "More courses".
  function getPlayedPhysicalCourseNames() {
    const seen = new Set();
    const names = [];
    [...state.rounds]
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .forEach((round) => {
        const name = physicalCourseName(round.courseId);
        if (!name || seen.has(name)) return;
        seen.add(name);
        names.push(name);
      });
    return names;
  }

  let courseChipsExpanded = false;

  function syncRoundCourseChips(select, row) {
    const names = getPhysicalCourseNames();
    const showActive = isSetupChipRowActiveForRender("roundCourse");
    const currentName = physicalCourseName(select.value);
    const played = getPlayedPhysicalCourseNames().filter((n) => names.includes(n));
    const rest = names.filter((n) => !played.includes(n));
    // No history yet (or everything played): plain full list, no toggle.
    const collapsible = played.length > 0 && rest.length > 0;
    // The currently-selected course always shows even if it's in the
    // collapsed group — otherwise picking from "More" then collapsing
    // would hide the active chip.
    const visible = collapsible && !courseChipsExpanded
      ? [...played, ...(currentName && rest.includes(currentName) ? [currentName] : [])]
      : [...played, ...rest];
    const chip = (name) => `
      <button type="button"
              class="select-chip${showActive && name === currentName ? " active" : ""}"
              data-chip-course-name="${escapeHtml(name)}">
        ${escapeHtml(shortCourseChipLabel(name))}
      </button>`;
    const toggle = collapsible ? `
      <button type="button" class="select-chip select-chip-more" data-chip-action="toggle-courses">
        ${courseChipsExpanded ? "Fewer ▴" : `More courses (${rest.length}) ▾`}
      </button>` : "";
    row.innerHTML = visible.map(chip).join("") + toggle;
  }

  function renderSelectOptions() {
    const nonDeerwoodCourses = state.courses.filter((course) => !isDeerwoodCourseId(course.id));
    const deerwoodRoundCourses = [...new Set(state.rounds
      .filter((round) => isDeerwoodCourseId(round.courseId))
      .map((round) => round.courseId))]
      .map(getCourse)
      .filter(Boolean);
    const courseOptions = [
      `<option value="all">All courses</option>`,
      `<option value="${DEERWOOD_COURSE_ID}">Deerwood Golf Course</option>`,
      ...nonDeerwoodCourses.map((course) => `<option value="${course.id}">${escapeHtml(course.name)} (${escapeHtml(course.tee)})</option>`)
    ].join("");

    const roundOptions = [
      `<option value="${DEERWOOD_COURSE_ID}">Deerwood Golf Course</option>`,
      ...nonDeerwoodCourses
      .map((course) => `<option value="${course.id}">${escapeHtml(course.name)} (${escapeHtml(course.tee)})</option>`)
    ].join("");

    const currentRoundCourse = els.roundCourse.value;
    const currentFilterCourse = els.filterCourse.value;

    els.filterCourse.innerHTML = courseOptions;
    els.roundCourse.innerHTML = roundOptions;

    if (currentFilterCourse === DEERWOOD_COURSE_ID || nonDeerwoodCourses.some((course) => course.id === currentFilterCourse)) {
      els.filterCourse.value = currentFilterCourse;
    } else if (isDeerwoodCourseId(currentFilterCourse)) {
      els.filterCourse.value = DEERWOOD_COURSE_ID;
    }

    if (currentRoundCourse === DEERWOOD_COURSE_ID || nonDeerwoodCourses.some((course) => course.id === currentRoundCourse)) {
      els.roundCourse.value = currentRoundCourse;
    } else {
      els.roundCourse.value = DEERWOOD_COURSE_ID;
    }

    const tees = [...new Set(state.rounds.map((round) => round.tee).filter(Boolean))].sort();
    const currentTee = els.filterTee.value;
    els.filterTee.innerHTML = [
      `<option value="all">All tees</option>`,
      ...tees.map((tee) => `<option value="${escapeHtml(tee)}">${escapeHtml(tee)}</option>`)
    ].join("");
    if (tees.includes(currentTee)) els.filterTee.value = currentTee;

    renderRoundSetupOptions();
  }

  function renderRoundSetupOptions() {
    const isDeerwood = els.roundCourse.value === DEERWOOD_COURSE_ID;
    // 9/18 picker visible for every course — Jeff's buddy plays a 9-hole
    // league at Arrowhead; nothing about that is Deerwood-specific.
    els.roundHoleCountField.hidden = false;

    if (!isDeerwood) {
      // Non-Deerwood: populate the Tee dropdown with the available tees for
      // the selected physical course, and show the tee field only when there
      // is an actual choice to make (2+ tees).
      const physicalName = physicalCourseName(els.roundCourse.value);
      const entries = getCatalogEntriesForCourseName(physicalName);
      const currentEntry = entries.find((e) => e.id === els.roundCourse.value)
        || entries[0];
      const currentTee = currentEntry ? currentEntry.tee : "";
      const tees = getTeesForCourseName(physicalName);
      els.roundTee.innerHTML = tees
        .map((tee) => `<option value="${escapeHtml(tee)}">${escapeHtml(tee)}</option>`)
        .join("");
      if (tees.includes(currentTee)) els.roundTee.value = currentTee;
      els.roundTeeField.hidden = tees.length < 2;

      // Default hole-count to 18 if not set.
      if (!els.roundHoleCount.value) els.roundHoleCount.value = "18";
      const isNineHole = els.roundHoleCount.value === "9";
      // For non-Deerwood 9-hole rounds, repurpose the layout picker as a
      // Front-9 / Back-9 chooser. Slicing happens in getSelectedRoundCourse.
      els.roundLayoutField.hidden = !isNineHole;
      els.roundFrontNineField.hidden = true;   // Deerwood-only
      els.roundBackNineField.hidden = true;    // Deerwood-only

      if (isNineHole) {
        const halves = [
          { id: "front", label: "Front 9 (1-9)" },
          { id: "back",  label: "Back 9 (10-18)" }
        ];
        // Capture the value BEFORE replacing innerHTML — setting innerHTML
        // resets <select>.value to the first option as a side-effect, so
        // restoring it afterward is the only way to honor a prior pick.
        // (The Deerwood-side rebuild does the same dance for the same reason.)
        const previousLayout = els.roundLayout.value;
        els.roundLayout.innerHTML = halves
          .map((h) => `<option value="${h.id}">${h.label}</option>`)
          .join("");
        els.roundLayout.value = halves.some((h) => h.id === previousLayout)
          ? previousLayout
          : "front";
      }
      syncAllChipsToSelects();
      return;
    }

    // Deerwood: tee options are White / Blue, never anything else.
    els.roundTeeField.hidden = false;
    const teeOptionValues = [...els.roundTee.options].map((o) => o.value);
    if (!DEERWOOD_TEE_OPTIONS.every((t) => teeOptionValues.includes(t))
        || teeOptionValues.some((v) => !DEERWOOD_TEE_OPTIONS.includes(v))) {
      els.roundTee.innerHTML = DEERWOOD_TEE_OPTIONS
        .map((tee) => `<option value="${tee}">${tee}</option>`)
        .join("");
    }
    if (!els.roundHoleCount.value) els.roundHoleCount.value = "18";
    if (!DEERWOOD_TEE_OPTIONS.includes(els.roundTee.value)) els.roundTee.value = "White";

    const isNineHole = els.roundHoleCount.value === "9";
    // 9-hole: single nine picker. 18-hole: independent Front 9 / Back 9.
    els.roundLayoutField.hidden = !isNineHole;
    els.roundFrontNineField.hidden = isNineHole;
    els.roundBackNineField.hidden = isNineHole;

    if (isNineHole) {
      const nines = deerwoodLayoutOptions["9"];
      // Capture before innerHTML rebuild — both the explicit 9-hole pick
      // (if previously set) AND the front-9 of the prior 18-hole layout.
      // Switching 18 → 9 should default the single-nine pick to whichever
      // nine you had as the front, so the holes 1-9 worth of data you
      // entered map to the SAME physical holes after the switch (instead
      // of silently shifting Doe scores onto Buck holes).
      const previousLayout = els.roundLayout.value;
      const previousFrontNine = els.roundFrontNine.value;
      els.roundLayout.innerHTML = nines
        .map((nine) => `<option value="${nine.id}">${nine.label}</option>`)
        .join("");
      let resolvedNine;
      if (nines.some((n) => n.id === previousLayout)) {
        resolvedNine = previousLayout;
      } else if (nines.some((n) => n.id === previousFrontNine)) {
        resolvedNine = previousFrontNine;
      } else {
        resolvedNine = nines[0].id;
      }
      els.roundLayout.value = resolvedNine;
    } else {
      if (!DEERWOOD_NINE_IDS.includes(els.roundFrontNine.value)) els.roundFrontNine.value = "buck";
      if (!DEERWOOD_NINE_IDS.includes(els.roundBackNine.value)) els.roundBackNine.value = "doe";
    }
    // Refresh chip rows after any setup-option rebuild — courses changed,
    // hole count flipped, layout options swapped, etc.
    syncAllChipsToSelects();
  }

  function renderScorecard(courseOrId) {
    const course = typeof courseOrId === "string" ? getCourse(courseOrId) : courseOrId;
    // Pre-Start-Round phase — show a friendly placeholder instead of the
    // scorecard so the user's eye lands on the setup form + Start Round CTA.
    if (!roundStarted && !editingRoundId) {
      els.roundCourseMeta.innerHTML = "";
      els.scorecardGrid.innerHTML = `
        <div class="scorecard-placeholder">
          <strong>Set up your round above</strong>
          <span>Tap a course, pick your tee, then tap Start Round to begin scoring.</span>
        </div>`;
      els.roundPreview.textContent = "--";
      updateViewToggleLabel();
      return;
    }
    if (!course) {
      els.roundCourseMeta.innerHTML = "";
      els.scorecardGrid.innerHTML = `<div class="empty-state">Add a course to start logging rounds.</div>`;
      els.roundPreview.textContent = "--";
      updateViewToggleLabel();
      return;
    }
    const coursePar = course.holes.reduce((sum, hole) => sum + hole.par, 0);
    const courseYards = course.holes.reduce((sum, hole) => sum + Number(hole.yards || 0), 0);
    els.roundCourseMeta.innerHTML = `
      <span>${course.holes.length} holes</span>
      <span>Par ${coursePar}</span>
      <span>${courseYards || "--"} yds</span>
      <span>Rating ${course.rating ? course.rating.toFixed(1) : "--"}</span>
      <span>Slope ${course.slope || "--"}</span>
    `;

    seedDefaultClubs(course);
    els.scorecardGrid.className = `scorecard mode-${viewMode}`;
    els.scorecardGrid.dataset.entryMode = currentEntryMode;
    els.scorecardGrid.innerHTML = viewMode === "card"
      ? renderScorecardCardMode(course)
      : renderScorecardGridMode(course);

    els.scorecardGrid.querySelectorAll("input, select").forEach((input) => {
      const onEntry = (event) => {
        // Only a genuine user gesture counts — programmatic events (par/club
        // pre-fill) have isTrusted === false.
        if (event && event.isTrusted) roundTouched = true;
        // Re-derive GIR + auto-add Putter for the hole this input belongs to.
        const target = event && event.target;
        if (target && target.dataset && target.dataset.hole) {
          syncDerivedHoleFlags(target.dataset.hole);
        }
        updateRoundPreview();
        scheduleInProgressSave();
        if (viewMode === "card") syncAllPillActiveStates();
      };
      input.addEventListener("input", onEntry);
      input.addEventListener("change", onEntry);
    });
    els.scorecardGrid.querySelectorAll(".card-note-input").forEach((textarea) => {
      textarea.addEventListener("input", () => {
        roundTouched = true;
        setHoleNote(textarea.dataset.hole, textarea.value);
        scheduleInProgressSave();
      });
    });
    if (viewMode === "card") wireCardModeBehavior();
    updateViewToggleLabel();
    updateRoundPreview();
    if (viewMode === "card") syncAllPillActiveStates();
    if (viewMode === "card") prefillActiveCardPar();
    // Initial GIR auto-derive + Putter auto-add for whatever values just landed.
    syncAllDerivedFlags();
    refreshReviewVisibility();
    updateFloatingNavVisibility();
  }

  function refreshReviewVisibility() {
    if (!els.reviewSection) return;
    // Grid mode: always visible — desktop users see everything at once.
    // Card mode: hidden until the user taps "Review & save round" on a
    // card. Keeps each card focused on per-hole entry.
    if (viewMode === "grid") {
      els.reviewSection.hidden = false;
    } else {
      // Don't auto-hide if it's already been opened during this entry session.
      // The setActiveTab + course-change paths reset things explicitly elsewhere.
      if (!els.reviewSection.dataset.userOpened) {
        els.reviewSection.hidden = true;
      }
    }
  }

  function openReviewSection() {
    if (!els.reviewSection) return;
    els.reviewSection.hidden = false;
    els.reviewSection.dataset.userOpened = "true";
    requestAnimationFrame(() => {
      els.reviewSection.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    updateFloatingNavVisibility();
  }

  function closeReviewSection() {
    if (!els.reviewSection) return;
    if (viewMode === "card") {
      els.reviewSection.hidden = true;
      delete els.reviewSection.dataset.userOpened;
      // Scroll back up to the active card so the user knows where they are.
      const activeCard = els.scorecardGrid.querySelector(".scorecard-card.active");
      if (activeCard) {
        requestAnimationFrame(() => {
          activeCard.scrollIntoView({ block: "start", behavior: "smooth" });
        });
      }
    }
    updateFloatingNavVisibility();
  }

  function resetReviewState() {
    if (els.reviewSection) delete els.reviewSection.dataset.userOpened;
  }

  function renderScorecardGridMode(course) {
    return getScorecardSections(course.holes).map((section) => {
      const holes = section.holes;
      const labelCells = holes.map((hole) => `<div class="scorecard-hole-number">${escapeHtml(hole.label || hole.number)}</div>`).join("");
      const parCells = holes.map((hole) => `<div class="scorecard-static">${hole.par}</div>`).join("");
      const yardCells = holes.map((hole) => `<div class="scorecard-static">${hole.yards || "--"}</div>`).join("");
      const hcpCells = holes.map((hole) => `<div class="scorecard-static">${hole.hcp || "--"}</div>`).join("");
      const scoreCells = holes.map((hole) => scoreInputCell(hole)).join("");
      const puttCells = holes.map(puttsInputCell).join("");
      const fairwayCells = holes.map(fairwayInputCell).join("");
      const bunkerCells = holes.map(bunkerInputCell).join("");
      const girCells = holes.map(girInputCell).join("");
      const penaltyCells = holes.map(penaltyInputCell).join("");
      const firstPuttCells = holes.map(firstPuttInputCell).join("");

      return `
        <section class="scorecard-section">
          <div class="scorecard-section-heading">
            <strong>${escapeHtml(section.label)}</strong>
            <span>Par ${section.par} | ${section.yards || "--"} yds</span>
          </div>
          <div class="scorecard-matrix" style="--hole-count:${holes.length}">
            <div class="scorecard-label">Hole</div>${labelCells}
            <div class="scorecard-label">Par</div>${parCells}
            <div class="scorecard-label">Yards</div>${yardCells}
            <div class="scorecard-label">HCP</div>${hcpCells}
            <div class="scorecard-label">Score</div>${scoreCells}
            <div class="scorecard-label">Putts</div>${puttCells}
            <div class="scorecard-label">1st putt ft</div>${firstPuttCells}
            <div class="scorecard-label">Fairway</div>${fairwayCells}
            <div class="scorecard-label">Bunker</div>${bunkerCells}
            <div class="scorecard-label">GIR</div>${girCells}
            <div class="scorecard-label">Pen</div>${penaltyCells}
          </div>
        </section>`;
    }).join("");
  }

  function puttsInputCell(hole) {
    return `<input class="putts-input compact-input" data-hole="${hole.number}" type="number" min="0" max="8" inputmode="numeric" value="2" aria-label="${escapeHtml(hole.label || `Hole ${hole.number}`)} putts">`;
  }

  function girInputCell(hole) {
    // GIR is auto-derived from score + putts (see syncDerivedHoleFlags), so
    // the checkbox is rendered disabled — it's a readout, not an input.
    return `<label class="gir-toggle compact-toggle"><input class="gir-input" data-hole="${hole.number}" type="checkbox" disabled aria-label="${escapeHtml(hole.label || `Hole ${hole.number}`)} GIR (auto)"><span></span></label>`;
  }

  function penaltyInputCell(hole) {
    return `<input class="penalty-input compact-input" data-hole="${hole.number}" type="number" min="0" max="8" inputmode="numeric" value="0" aria-label="${escapeHtml(hole.label || `Hole ${hole.number}`)} penalties">`;
  }

  function firstPuttInputCell(hole) {
    return `<input class="first-putt-input compact-input" data-hole="${hole.number}" type="number" min="0" max="120" inputmode="numeric" placeholder="ft" aria-label="${escapeHtml(hole.label || `Hole ${hole.number}`)} first putt distance in feet">`;
  }

  function fringePuttsInputCell(hole) {
    return `<input class="fringe-putts-input compact-input" data-hole="${hole.number}" type="number" min="0" max="3" inputmode="numeric" value="0" aria-label="${escapeHtml(hole.label || `Hole ${hole.number}`)} fringe putts">`;
  }

  // Pills for fast on-course tap entry. Each pill row writes to the hidden
  // typed input (which preserves all existing read/save logic) plus offers
  // a small custom input as an escape hatch for values outside the pill set.
  function renderPillsRow({ label, holeNumber, inputClass, values, customMin, customMax, customPlaceholder = "…", parValue, scoreTiers = false }) {
    // values can be bare numbers OR { value, label } objects so a chip can
    // display "Tap-in" while still saving 1 as the underlying value.
    const pills = values.map((entry) => {
      const v = (entry && typeof entry === "object") ? entry.value : entry;
      const displayLabel = (entry && typeof entry === "object" && entry.label != null)
        ? entry.label
        : String(v);
      const isPar = parValue !== undefined && Number(v) === Number(parValue);
      let tierCls = "";
      // Score pills carry their scoring-tier shape (circle birdie / box bogey).
      if (scoreTiers && parValue !== undefined) {
        const variant = scoreMarkClass(Number(v), Number(parValue));
        if (variant) tierCls = ` pill-${variant.replace("score-mark-", "tier-")}`;
      }
      return `<button type="button" class="pill${isPar ? " pill-par" : ""}${tierCls}" data-pill-value="${v}">${escapeHtml(displayLabel)}</button>`;
    }).join("");
    return `
      <div class="card-pill-row" data-pill-group="${inputClass}" data-hole="${holeNumber}">
        <span class="card-pill-label">${escapeHtml(label)}</span>
        <div class="card-pill-options">
          ${pills}
          <input type="number" class="card-pill-custom" data-pill-custom-for="${inputClass}" data-hole="${holeNumber}" min="${customMin}" max="${customMax}" inputmode="numeric" placeholder="${escapeHtml(customPlaceholder)}" aria-label="Custom ${escapeHtml(label)} value">
        </div>
      </div>`;
  }

  function renderScorePills(hole) {
    const par = hole.par;
    const values = [];
    for (let v = Math.max(1, par - 2); v <= par + 3; v += 1) values.push(v);
    return renderPillsRow({
      label: "Score",
      holeNumber: hole.number,
      inputClass: "score-input",
      values,
      parValue: par,
      scoreTiers: true,
      customMin: 1,
      customMax: 15,
      customPlaceholder: String(par)
    });
  }

  function renderPuttsPills(hole) {
    // Inline "Fringe" toggle appended to the Putts row. Tap cycles
    // fringePutts 0 → 1 → 2 → 0. Putts (the count chip) stays semantically
    // "on-green strokes only" — Score auto-calc and GIR derivation depend
    // on that. The fringe count adds to the total stroke count separately.
    const valuesHtml = [0, 1, 2, 3, 4, 5].map((v) =>
      `<button type="button" class="pill" data-pill-value="${v}">${v}</button>`
    ).join("");
    return `
      <div class="card-pill-row" data-pill-group="putts-input" data-hole="${hole.number}">
        <span class="card-pill-label">Putts</span>
        <div class="card-pill-options">
          ${valuesHtml}
          <input type="number" class="card-pill-custom" data-pill-custom-for="putts-input" data-hole="${hole.number}" min="0" max="8" inputmode="numeric" placeholder="…" aria-label="Custom Putts value">
          <button type="button" class="pill pill-fringe-toggle" data-fringe-toggle="${hole.number}" aria-label="Toggle fringe putt count for this hole">Fringe</button>
        </div>
      </div>`;
  }

  function renderPenPills(hole) {
    // Inline "OB" toggle appended to the Pen row. Tap = +1 to penalties
    // AND +1 instance of the tee club to clubsHit (the implicit re-tee
    // swing) = +2 strokes auto-added. Tap again to undo (removes both).
    // Modeled on the Fringe toggle pattern on the Putts row, with
    // red tinting so the user reads it as a "this hurt" affordance.
    const valuesHtml = [0, 1, 2, 3].map((v) =>
      `<button type="button" class="pill" data-pill-value="${v}">${v}</button>`
    ).join("");
    return `
      <div class="card-pill-row" data-pill-group="penalty-input" data-hole="${hole.number}">
        <span class="card-pill-label">Pen</span>
        <div class="card-pill-options">
          ${valuesHtml}
          <input type="number" class="card-pill-custom" data-pill-custom-for="penalty-input" data-hole="${hole.number}" min="0" max="8" inputmode="numeric" placeholder="…" aria-label="Custom Penalty value">
          <button type="button" class="pill pill-ob-toggle" data-ob-toggle="${hole.number}" aria-label="OB / lost ball — adds 2 strokes (penalty + re-tee swing)">OB</button>
        </div>
      </div>`;
  }

  function renderFirstPuttPills(hole) {
    return renderPillsRow({
      label: "1st putt (ft)",
      holeNumber: hole.number,
      inputClass: "first-putt-input",
      // Tap-in saves as 1 ft so it still falls in the "Inside 3 ft" bucket
      // for Putting by Distance analytics. 35/40 fill in the gap between
      // 30 and 50 that always required the custom input.
      values: [
        { value: 1, label: "Tap-in" },
        3, 6, 10, 15, 20, 30, 35, 40, 50
      ],
      customMin: 0,
      customMax: 120,
      customPlaceholder: "ft"
    });
  }

  // "Did you putt from the fringe?" — captures putter-from-off-green
  // strokes so the on-green Putts row stays semantically clean. Stored as
  // a count (0/1/2) for the rare double-fringe case, but defaults to 0
  // and the pills are minimal.
  function renderFringePuttsPills(hole) {
    return renderPillsRow({
      label: "Fringe putts",
      holeNumber: hole.number,
      inputClass: "fringe-putts-input",
      values: [0, 1, 2],
      customMin: 0,
      customMax: 3
    });
  }

  function renderFairwayPills(hole) {
    // No fairway exists on a par 3 — skip the row entirely instead of
    // rendering "N/A (par 3)" filler. Keeps the card tighter without
    // hiding any actually-captured data.
    if (hole.par === 3) return "";
    // Hit / Left / Right / Short / Long cover every direction you can miss
    // the fairway. A bare "Miss" option was just ambiguity — every miss has
    // a direction, capture it.
    const options = [
      { value: "hit", label: "Hit" },
      { value: "left", label: "Left" },
      { value: "right", label: "Right" },
      { value: "short", label: "Short" },
      { value: "long", label: "Long" }
    ];
    const pills = options.map((opt) => `<button type="button" class="pill" data-pill-value="${opt.value}">${escapeHtml(opt.label)}</button>`).join("");
    return `
      <div class="card-pill-row" data-pill-group="fairway-input" data-hole="${hole.number}">
        <span class="card-pill-label">Fairway</span>
        <div class="card-pill-options card-pill-options-no-custom">${pills}</div>
      </div>`;
  }

  function renderBunkerPills(hole) {
    // Did you end up in sand on this hole, and where? Greenside bunker
    // matters for sand-save analytics; fairway bunker matters for tee-shot
    // tendencies and approach difficulty. "Both" handles the rare hole
    // where you find sand twice in different spots.
    const options = [
      { value: "none", label: "No" },
      { value: "fairway", label: "Fairway" },
      { value: "greenside", label: "Greenside" },
      { value: "both", label: "Both" }
    ];
    const pills = options.map((opt) => `<button type="button" class="pill" data-pill-value="${opt.value}">${escapeHtml(opt.label)}</button>`).join("");
    return `
      <div class="card-pill-row" data-pill-group="bunker-input" data-hole="${hole.number}">
        <span class="card-pill-label">Bunker</span>
        <div class="card-pill-options card-pill-options-no-custom">${pills}</div>
      </div>`;
  }

  function renderClubsHitPills(hole) {
    const selected = getHoleClubs(hole.number); // ordered array — index 0 is tee club
    const counts = selected.reduce((acc, c) => { acc[c] = (acc[c] || 0) + 1; return acc; }, {});
    // Putter is never a tee shot. If only Putter is selected (e.g. a freshly
    // seeded par 3) suppress the TEE badge until a real tee club joins.
    const firstNonPutter = selected.find((c) => c !== "Putter");
    const teeClub = firstNonPutter
      || (selected[0] && selected[0] !== "Putter" ? selected[0] : null);
    // Only render pills for clubs in the user's bag (plus any already
    // selected on this hole, even if they're no longer in the bag).
    // Putter is excluded — putter use is captured by the Putts row
    // directly, so a Putter pill would be duplicative noise.
    const available = clubsForHole(hole.number).filter((c) => c !== "Putter");
    const pills = available.map((club) => {
      const count = counts[club] || 0;
      const isActive = count > 0;
      const isTee = club === teeClub;
      const cls = `pill pill-club${isActive ? " active" : ""}${isTee ? " pill-club-tee" : ""}`;
      const teeBadge = isTee ? `<span class="pill-tee-badge" aria-label="tee shot">TEE</span>` : "";
      const countBadge = count >= 2 ? `<span class="pill-count" aria-label="hit ${count} times">×${count}</span>` : "";
      // Visible × clear badge on every active pill — explicit "undo this
      // club" affordance now that tap-to-add is the primary gesture.
      const clearBadge = isActive
        ? `<span class="pill-clear" data-pill-clear="${escapeHtml(club)}" data-hole="${hole.number}" role="button" tabindex="0" aria-label="Remove ${escapeHtml(club)} from this hole">×</span>`
        : "";
      return `<button type="button" class="${cls}" data-toggle-club="${escapeHtml(club)}" data-hole="${hole.number}">${escapeHtml(club)}${countBadge}${teeBadge}${clearBadge}</button>`;
    }).join("");
    // Best-scoring-club recommendation — only on fresh round flows (editing
    // would be circular against the round being edited) and only when the
    // recommendation differs from whatever the user has currently picked.
    let recHtml = "";
    if (!editingRoundId) {
      const course = getSelectedRoundCourse();
      const rec = course ? getBestScoringTeeClubForHole(course.id, hole, state.rounds) : null;
      if (rec) {
        const currentTee = selected.find((c) => c !== "Putter");
        if (currentTee !== rec.best.club) {
          const fmt = (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
          recHtml = `<div class="club-hint" role="note"><span class="club-hint-icon" aria-hidden="true">💡</span> You've scored best with <strong>${escapeHtml(rec.best.club)}</strong> here (${fmt(rec.best.avgToPar)} avg, ${rec.best.plays} plays) vs your usual <strong>${escapeHtml(rec.baseline.club)}</strong> (${fmt(rec.baseline.avgToPar)} avg, ${rec.baseline.plays} plays).</div>`;
        }
      }
    }
    return `
      <div class="card-clubs-row" data-hole="${hole.number}">
        <span class="card-pill-label">Clubs hit <span class="card-pill-sublabel">(first tap = tee shot · tap again to add another hit · tap × to remove)</span></span>
        ${recHtml}
        <div class="card-clubs-grid">${pills}</div>
      </div>`;
  }

  // Wedges intentionally cover both naming conventions — degree-labeled
  // (50° / 52° / 54° / 56° / 58° / 60°) AND the older GW / SW / LW labels.
  // Plenty of players carry GW / SW / LW marked clubs and never think in
  // degrees; offering both lets bag setup match the labels printed on the
  // clubheads.
  const CLUB_OPTIONS = [
    "Driver", "3W", "5W", "7W", "Hybrid",
    "3i", "4i", "5i", "6i", "7i", "8i", "9i",
    "PW", "GW", "50°", "52°", "54°", "SW", "56°", "58°", "60°", "LW",
    "Putter", "Other"
  ];

  // The user's bag (their selected subset of CLUB_OPTIONS) drives every
  // club picker in the app. Saved rounds can still reference clubs that
  // aren't in the current bag — clubsForHole keeps them visible on edit
  // so no historical data is hidden.
  function getBag() {
    const bag = state.profile && Array.isArray(state.profile.bag) ? state.profile.bag : null;
    if (bag && bag.length) return bag;
    return [...CLUB_OPTIONS];
  }

  function isInBag(club) {
    return getBag().includes(club);
  }

  // Clubs available to render for a given hole's pickers: the bag, plus any
  // clubs already saved on this hole (so a hole that used a 60° back when
  // you carried one still shows the 60° pill, active, ready to toggle off).
  function clubsForHole(holeNumber) {
    const bag = getBag();
    const onHole = getHoleClubs(holeNumber);
    const penaltyClubs = getHolePenaltyClubs(holeNumber);
    const extras = [];
    onHole.forEach((club) => {
      if (!bag.includes(club) && !extras.includes(club)) extras.push(club);
    });
    penaltyClubs.forEach((club) => {
      if (club && !bag.includes(club) && !extras.includes(club)) extras.push(club);
    });
    // Preserve canonical CLUB_OPTIONS order: bag clubs first (in canon order),
    // then any extras (in canon order).
    return CLUB_OPTIONS.filter((c) => bag.includes(c) || extras.includes(c));
  }

  // Shown only when a hole has a penalty logged — captures which club caused
  // it. syncPenaltyClubRows() toggles visibility and defaults to the tee club.
  // Shell only — the actual N selects are rebuilt dynamically by
  // syncPenaltyClubRows() based on the current penalties count, so the
  // user can blame a different club for each penalty stroke on the same
  // hole.
  function renderPenaltyClubRow(hole) {
    return `
      <div class="card-penalty-club-row" data-hole="${hole.number}" hidden>
        <span class="card-pill-label">Penalty club</span>
        <div class="penalty-club-selects" data-hole="${hole.number}"></div>
      </div>`;
  }

  function renderScorecardCardMode(course) {
    const sections = getScorecardSections(course.holes);
    const sectionByHoleNumber = new Map();
    sections.forEach((section) => {
      section.holes.forEach((hole) => sectionByHoleNumber.set(hole.number, section.label));
    });
    const totalHoles = course.holes.length;

    const cards = course.holes.map((hole, index) => {
      const sectionLabel = sectionByHoleNumber.get(hole.number) || "";
      const positionText = totalHoles > 1
        ? `Hole ${index + 1} of ${totalHoles}${sectionLabel ? ` · ${escapeHtml(sectionLabel)}` : ""}`
        : `Hole ${index + 1}`;
      return `
        <article class="scorecard-card${index === 0 ? " active" : ""}" data-card-index="${index}" data-hole-number="${hole.number}">
          <div class="card-top">
            <button type="button" class="card-step" data-card-nav="prev" aria-label="Previous hole">‹</button>
            <button type="button" class="card-position" data-open-hole-picker aria-label="${positionText} — tap to jump to another hole">${positionText} <span class="card-position-caret" aria-hidden="true">▾</span></button>
            <button type="button" class="card-step" data-card-nav="next" aria-label="Next hole">›</button>
          </div>
          <div class="card-headline">
            <span class="card-hole-mark" data-hole="${hole.number}" hidden></span>
            <h3 class="card-hole-label">${escapeHtml(hole.label || `Hole ${hole.number}`)}</h3>
            <div class="card-hole-meta">
              <span>Par ${hole.par}</span>
              <span>${hole.yards ? `${hole.yards} yds` : "no yardage"}</span>
              <span>HCP ${hole.hcp || "--"}</span>
            </div>
            ${Array.isArray(hole.hazards) && hole.hazards.length ? `<ul class="hazard-chip-list hazard-chip-list-compact">${hole.hazards.map((h) => renderHazardChip(h)).join("")}</ul>` : ""}
          </div>
          <div class="card-hidden-inputs" hidden>
            ${scoreInputCell(hole)}
            ${puttsInputCell(hole)}
            ${firstPuttInputCell(hole)}
            ${fringePuttsInputCell(hole)}
            ${fairwayInputCell(hole)}
            ${bunkerInputCell(hole)}
            ${penaltyInputCell(hole)}
            ${girInputCell(hole)}
          </div>
          ${cardFlowMode === "narrative" ? "" : `${renderScorePills(hole)}${renderPuttsPills(hole)}`}
          <div class="card-extra">
            ${cardFlowMode === "narrative" ? `
              ${renderClubsHitPills(hole)}
              ${renderFairwayPills(hole)}
              ${renderPuttsPills(hole)}
              ${renderFirstPuttPills(hole)}
              ${renderPenPills(hole)}
              ${renderPenaltyClubRow(hole)}
              ${renderBunkerPills(hole)}
              <label class="card-note-field">
                <span>What happened on this hole?</span>
                <textarea class="card-note-input" data-hole="${hole.number}" rows="2" placeholder="Drove left, chipped twice, 2-putt from 12ft… (tap the mic on your keyboard for voice)">${escapeHtml(getHoleNote(hole.number))}</textarea>
              </label>
              ${renderScorePills(hole)}
            ` : `
              ${renderFirstPuttPills(hole)}
              ${renderFairwayPills(hole)}
              ${renderClubsHitPills(hole)}
              ${renderPenPills(hole)}
              ${renderPenaltyClubRow(hole)}
              ${renderBunkerPills(hole)}
              <label class="card-note-field">
                <span>What happened on this hole?</span>
                <textarea class="card-note-input" data-hole="${hole.number}" rows="2" placeholder="Drove left, chipped twice, 2-putt from 12ft… (tap the mic on your keyboard for voice)">${escapeHtml(getHoleNote(hole.number))}</textarea>
              </label>
            `}
          </div>
        </article>`;
    }).join("");

    return `
      <div class="scorecard-cards" data-active-index="0" data-entry-mode="${escapeHtml(currentEntryMode)}">${cards}</div>
      <div class="scorecard-card-nav">
        <button type="button" class="card-nav-button" data-card-nav="prev">← Prev</button>
        <button type="button" class="card-nav-button card-nav-button-primary" data-card-nav="next">Next →</button>
      </div>
      <div class="scorecard-review-cta">
        <button type="button" class="card-review-button" data-action="show-review">Review &amp; save round →</button>
      </div>`;
  }

  // Smart default: when a hole becomes the active card, pre-select par in the
  // Score row (if untouched) so walking the course is mostly tapping the
  // forward arrow — you only stop to change the holes that weren't par.
  // Holes you never navigate to stay genuinely empty, so the completion
  // check still catches skipped holes. Disabled in edit mode, where exact
  // fidelity to the saved round matters.
  function prefillActiveCardPar() {
    if (editingRoundId || viewMode !== "card") return;
    const activeCard = els.scorecardGrid.querySelector(".scorecard-card.active");
    if (!activeCard) return;
    const scoreInput = activeCard.querySelector(".score-input");
    if (!(scoreInput instanceof HTMLInputElement) || scoreInput.value.trim() !== "") return;
    const par = Number(scoreInput.dataset.par) || 4;
    scoreInput.value = String(par);
    // Mark the prefilled value as auto-set so recalculateScoreForHole
    // can override it once the user starts logging real strokes.
    // Without this, the par value sat as a "manual" entry that blocked
    // every subsequent auto-calc.
    scoreInput.dataset.autoScore = String(par);
    // Programmatic event (isTrusted = false) — drives the pills/preview but
    // does NOT count as the user touching the round.
    scoreInput.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Are the floating mid-screen prev/next tabs eligible to show right now?
  // Visible only on Add Round, in card view, with cards rendered and the
  // review section closed. Called from anywhere those conditions change.
  function updateFloatingNavVisibility() {
    if (!els.floatingNavPrev || !els.floatingNavNext) return;
    const onRoundsTab = !!document.querySelector('.tab-panel[data-tab-panel="rounds"].active');
    const inCardMode = viewMode === "card";
    const hasCards = !!(els.scorecardGrid && els.scorecardGrid.querySelector(".scorecard-card"));
    const reviewOpen = !!(els.reviewSection && !els.reviewSection.hidden);
    const visible = onRoundsTab && inCardMode && hasCards && !reviewOpen;
    document.body.classList.toggle("floating-card-nav-visible", visible);
    if (visible) {
      const activeIndex = getActiveCardIndex();
      const last = getCardCount() - 1;
      els.floatingNavPrev.disabled = activeIndex <= 0;
      els.floatingNavNext.disabled = activeIndex >= last;
    }
  }

  function setActiveCardIndex(index) {
    const stack = els.scorecardGrid.querySelector(".scorecard-cards");
    if (!stack) return;
    const cards = [...stack.querySelectorAll(".scorecard-card")];
    if (!cards.length) return;
    const clamped = Math.max(0, Math.min(cards.length - 1, index));
    roundTouched = true;
    cards.forEach((card, i) => card.classList.toggle("active", i === clamped));
    stack.dataset.activeIndex = String(clamped);
    const activeCard = cards[clamped];
    if (!activeCard) return;
    // Pre-select par on the hole we just landed on.
    prefillActiveCardPar();
    // Scroll the card to the top so the Score row is right where the user
    // needs it — no hunting after tapping the forward arrow.
    requestAnimationFrame(() => {
      activeCard.scrollIntoView({ block: "start" });
    });
    const scoreInput = activeCard.querySelector(".score-input");
    if (scoreInput instanceof HTMLInputElement) {
      scoreInput.focus({ preventScroll: true });
      scoreInput.select();
    }
    // Refresh the floating-nav arrow disabled-at-ends state.
    updateFloatingNavVisibility();
    // Live-summary "committed" set depends on which card is active —
    // advancing past the hole the user just scored commits it into the
    // totals, so the summary needs a refresh now that the active card
    // has changed. (prefillActiveCardPar already fires an input event for
    // a fresh hole; this catches the case where the new card already had
    // a score from a prior visit.)
    updateRoundPreview();
  }

  function getCardCount() {
    return els.scorecardGrid.querySelectorAll(".scorecard-card").length;
  }

  function getActiveCardIndex() {
    const stack = els.scorecardGrid.querySelector(".scorecard-cards");
    return stack ? Number(stack.dataset.activeIndex || "0") : 0;
  }

  function wireCardModeBehavior() {
    const stack = els.scorecardGrid.querySelector(".scorecard-cards");
    if (!stack) return;
    // Prev/Next nav is handled by a single delegated listener on the stable
    // scorecardGrid element (see init) so both the header arrows and the
    // bottom buttons work without re-binding on every render.

    stack.addEventListener("focusin", (event) => {
      const card = event.target.closest(".scorecard-card");
      if (!card) return;
      const index = Number(card.dataset.cardIndex);
      if (Number.isFinite(index) && index !== getActiveCardIndex()) setActiveCardIndex(index);
    });

    stack.addEventListener("click", (event) => {
      roundTouched = true;
      const positionButton = event.target.closest("[data-open-hole-picker]");
      if (positionButton) {
        event.preventDefault();
        openHolePicker();
        return;
      }
      // Inline "Fringe" toggle on the Putts row — cycles fringePutts
      // 0 → 1 → 2 → 0 via repeated taps. Handled here before the generic
      // pill handler because the chip is a .pill element without a
      // data-pill-value (the value lives on a separate hidden input).
      const fringeToggle = event.target.closest("[data-fringe-toggle]");
      if (fringeToggle) {
        event.preventDefault();
        const holeNumber = fringeToggle.dataset.fringeToggle;
        const fringeInput = stack.querySelector(`.fringe-putts-input[data-hole="${holeNumber}"]`);
        if (fringeInput) {
          const current = Number(fringeInput.value || 0);
          const next = (current + 1) % 3; // 0 → 1 → 2 → 0
          fringeInput.value = String(next);
          fringeInput.dispatchEvent(new Event("input", { bubbles: true }));
          fringeInput.dispatchEvent(new Event("change", { bubbles: true }));
          // Visual state: chip is "active" when count > 0; suffix shows ×N.
          syncFringeToggleVisual(fringeToggle, next);
          recalculateScoreForHole(holeNumber);
          scheduleInProgressSave();
        }
        return;
      }
      // OB sub-chip on the Pen row. Each tap adds (or undoes) +1 penalty
      // stroke AND +1 instance of the tee club to clubsHit — modeling
      // OB / lost-ball as "stroke + distance" so the user logs both in
      // one tap. dataset.addedClub remembers what we added so a second
      // tap can cleanly undo.
      const obToggle = event.target.closest("[data-ob-toggle]");
      if (obToggle) {
        event.preventDefault();
        const holeNumber = obToggle.dataset.obToggle;
        const penaltyInput = stack.querySelector(`.penalty-input[data-hole="${holeNumber}"]`);
        const currentPen = penaltyInput && penaltyInput.value !== ""
          ? Number(penaltyInput.value)
          : 0;
        const isActive = obToggle.classList.contains("active");

        if (isActive) {
          // Undo: remove the previously-added club instance + decrement penalty.
          const addedClub = obToggle.dataset.addedClub || "";
          if (addedClub) {
            const current = getHoleClubs(holeNumber);
            const idx = current.lastIndexOf(addedClub);
            if (idx >= 0) {
              const next = [...current.slice(0, idx), ...current.slice(idx + 1)];
              setHoleClubs(holeNumber, next);
            }
          }
          if (penaltyInput) {
            penaltyInput.value = String(Math.max(0, currentPen - 1));
            penaltyInput.dispatchEvent(new Event("input", { bubbles: true }));
            penaltyInput.dispatchEvent(new Event("change", { bubbles: true }));
          }
          delete obToggle.dataset.addedClub;
          obToggle.classList.remove("active");
          obToggle.textContent = "OB";
        } else {
          // Apply: re-add the LAST non-Putter club logged on the hole —
          // that's the swing that went OB, and the re-shot from where you
          // hit it is almost always with the same club. Handles both the
          // "drive OB" case (last club = the only club = Driver) and the
          // "drove in play, then 7i OB" case (last club = 7i). Fallback to
          // Driver if no clubs logged yet (user tapping OB before any
          // club, which still implies a tee swing).
          const onHole = getHoleClubs(holeNumber);
          const lastNonPutter = [...onHole].reverse().find((c) => c !== "Putter");
          const bag = getBag();
          const clubToRepeat = lastNonPutter
            || (bag.includes("Driver") ? "Driver" : (bag.find((c) => c !== "Putter") || "Driver"));
          if (clubToRepeat && isInBag(clubToRepeat)) {
            setHoleClubs(holeNumber, [...onHole, clubToRepeat]);
          }
          if (penaltyInput) {
            penaltyInput.value = String(currentPen + 1);
            penaltyInput.dispatchEvent(new Event("input", { bubbles: true }));
            penaltyInput.dispatchEvent(new Event("change", { bubbles: true }));
          }
          obToggle.dataset.addedClub = clubToRepeat;
          obToggle.classList.add("active");
          obToggle.textContent = "OB ✓";
        }

        // Re-render the clubs row so the new/removed instance shows up
        // visually (count badge, × clear button, tee badge re-positioning).
        const clubsRow = els.scorecardGrid.querySelector(`.card-clubs-row[data-hole="${holeNumber}"]`);
        if (clubsRow) clubsRow.outerHTML = renderClubsHitPills({ number: Number(holeNumber) });
        // Re-sync the Pen row's active chip to match the new penalty value.
        const penRow = penaltyInput ? penaltyInput.closest(".card-pill-row")
          || els.scorecardGrid.querySelector(`.card-pill-row[data-pill-group="penalty-input"][data-hole="${holeNumber}"]`)
          : null;
        if (penRow) syncPillActiveStateForRow(penRow);

        recalculateScoreForHole(holeNumber);
        scheduleInProgressSave();
        return;
      }
      const pill = event.target.closest(".pill[data-pill-value]");
      if (pill) {
        event.preventDefault();
        const row = pill.closest(".card-pill-row");
        if (!row) return;
        const inputClass = row.dataset.pillGroup;
        const holeNumber = row.dataset.hole;
        const value = pill.dataset.pillValue;
        const input = stack.querySelector(`.${inputClass}[data-hole="${holeNumber}"]`);
        if (input) {
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        // Clear any value typed in the custom field for this row
        const customField = row.querySelector(".card-pill-custom");
        if (customField) customField.value = "";
        syncPillActiveStateForRow(row);
        // The Score row's active pill is driven by the score input value;
        // for OTHER pill rows, an entry implies a stroke total update.
        if (inputClass !== "score-input") {
          recalculateScoreForHole(holeNumber);
        } else {
          // User manually picked a score — mark as overridden so
          // subsequent auto-recalcs don't blow it away.
          const scoreInput = stack.querySelector(`.score-input[data-hole="${holeNumber}"]`);
          if (scoreInput) delete scoreInput.dataset.autoScore;
        }
        return;
      }
      // × clear badge: check FIRST because it's nested inside the
      // clubPill button. The pill body itself ADDS another instance;
      // the × badge removes all instances of that club.
      const clearBadge = event.target.closest("[data-pill-clear]");
      if (clearBadge) {
        event.preventDefault();
        event.stopPropagation();
        const holeNumber = clearBadge.dataset.hole;
        const club = clearBadge.dataset.pillClear;
        // Recalc score after the next click clears the club (the call
        // below already triggers a re-render of the clubs row).
        clearHoleClub(holeNumber, club);
        const row = clearBadge.closest(".card-clubs-row");
        if (row) {
          row.outerHTML = renderClubsHitPills({ number: Number(holeNumber) });
        }
        scheduleInProgressSave();
        recalculateScoreForHole(holeNumber);
        return;
      }
      const clubPill = event.target.closest("[data-toggle-club]");
      if (clubPill) {
        event.preventDefault();
        const holeNumber = clubPill.dataset.hole;
        const club = clubPill.dataset.toggleClub;
        toggleHoleClub(holeNumber, club);
        // Re-render the whole clubs row so the TEE badge moves to whatever
        // is currently first in the clubsHit array. classList.toggle alone
        // doesn't handle the tee-club position change.
        const row = clubPill.closest(".card-clubs-row");
        if (row) {
          row.outerHTML = renderClubsHitPills({ number: Number(holeNumber) });
        }
        scheduleInProgressSave();
        recalculateScoreForHole(holeNumber);
        return;
      }
      const shortcut = event.target.closest(".card-score-shortcut");
      if (!shortcut) return;
      const card = shortcut.closest(".scorecard-card");
      if (!card) return;
      const scoreInput = card.querySelector(".score-input");
      if (!(scoreInput instanceof HTMLInputElement)) return;
      const delta = Number(shortcut.dataset.scoreDelta) || 0;
      const current = Number(scoreInput.value);
      const par = Number(scoreInput.dataset.par) || 4;
      const base = Number.isFinite(current) && current > 0 ? current : par;
      const next = Math.max(1, Math.min(15, base + delta));
      scoreInput.value = String(next);
      scoreInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    stack.addEventListener("change", (event) => {
      const penClubSelect = event.target.closest(".penalty-club-input");
      if (penClubSelect) {
        const idx = Number(penClubSelect.dataset.penaltyIndex) || 0;
        setHolePenaltyClubAt(penClubSelect.dataset.hole, idx, penClubSelect.value);
        scheduleInProgressSave();
        return;
      }
    });

    // Custom typed fallback for pill rows: when the user types in the small
    // "…" input next to the pills, mirror that value into the real hidden
    // input so all existing read/save logic continues to work.
    stack.addEventListener("input", (event) => {
      const custom = event.target.closest("[data-pill-custom-for]");
      if (!custom) return;
      const inputClass = custom.dataset.pillCustomFor;
      const holeNumber = custom.dataset.hole;
      const input = stack.querySelector(`.${inputClass}[data-hole="${holeNumber}"]`);
      if (input) {
        input.value = custom.value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
  }

  function syncPillActiveStateForRow(row) {
    const inputClass = row.dataset.pillGroup;
    const holeNumber = row.dataset.hole;
    const input = els.scorecardGrid.querySelector(`.${inputClass}[data-hole="${holeNumber}"]`);
    if (!input) return;
    const value = input.value;
    row.querySelectorAll(".pill[data-pill-value]").forEach((p) => {
      p.classList.toggle("active", p.dataset.pillValue !== undefined && String(p.dataset.pillValue) === String(value));
    });
    // Fringe toggle (special-case chip on the Putts row): syncs from the
    // separate fringe-putts-input.
    const fringeToggle = row.querySelector("[data-fringe-toggle]");
    if (fringeToggle) {
      const fringeInput = els.scorecardGrid.querySelector(`.fringe-putts-input[data-hole="${holeNumber}"]`);
      const fringeCount = fringeInput ? Number(fringeInput.value || 0) : 0;
      syncFringeToggleVisual(fringeToggle, fringeCount);
    }
  }

  function syncFringeToggleVisual(toggle, count) {
    if (!toggle) return;
    const safeCount = Number.isFinite(count) && count > 0 ? count : 0;
    toggle.classList.toggle("active", safeCount > 0);
    toggle.textContent = safeCount === 0
      ? "Fringe"
      : safeCount === 1 ? "Fringe ✓"
      : `Fringe ×${safeCount}`;
  }

  // Strokes implied by the per-hole inputs. Drives auto-fill of the
  // Score row so the user doesn't have to re-add it manually after
  // entering every other stat. Manual override via tapping a score pill
  // sets a "user picked this" flag (we clear data-autoScore) and that
  // value sticks until the user clears it.
  function recalculateScoreForHole(holeKey) {
    if (!els.scorecardGrid) return;
    const scoreInput = els.scorecardGrid.querySelector(`.score-input[data-hole="${holeKey}"]`);
    if (!scoreInput) return;

    const clubsCount = getHoleClubs(holeKey).length;
    const puttsInput = els.scorecardGrid.querySelector(`.putts-input[data-hole="${holeKey}"]`);
    const fringeInput = els.scorecardGrid.querySelector(`.fringe-putts-input[data-hole="${holeKey}"]`);
    const penaltyInput = els.scorecardGrid.querySelector(`.penalty-input[data-hole="${holeKey}"]`);

    const puttsValue = puttsInput && puttsInput.value !== "" ? Number(puttsInput.value) : 0;
    const fringeValue = fringeInput && fringeInput.value !== "" ? Number(fringeInput.value) : 0;
    const penaltyValue = penaltyInput && penaltyInput.value !== "" ? Number(penaltyInput.value) : 0;

    const total =
      (Number.isFinite(clubsCount) ? clubsCount : 0)
      + (Number.isFinite(puttsValue) ? puttsValue : 0)
      + (Number.isFinite(fringeValue) ? fringeValue : 0)
      + (Number.isFinite(penaltyValue) ? penaltyValue : 0);

    // Nothing real to compute yet — wait for the user to log something.
    if (total <= 0) return;

    const currentValue = scoreInput.value;
    const lastAuto = scoreInput.dataset.autoScore || "";

    // Only auto-update when the user hasn't manually overridden. Empty
    // input or value matching the previously-auto-filled total both
    // count as "still being driven by auto-calc."
    if (currentValue === "" || currentValue === lastAuto) {
      const next = String(total);
      if (currentValue !== next) {
        scoreInput.value = next;
        scoreInput.dataset.autoScore = next;
        scoreInput.dispatchEvent(new Event("input", { bubbles: true }));
        scoreInput.dispatchEvent(new Event("change", { bubbles: true }));
        // Sync the visible Score pill row's active chip.
        const scoreRow = els.scorecardGrid.querySelector(`.card-pill-row[data-pill-group="score-input"][data-hole="${holeKey}"]`);
        if (scoreRow) syncPillActiveStateForRow(scoreRow);
        syncCardScoreMarks();
        updateRoundPreview();
      } else {
        // Value already correct — still keep dataset.autoScore in sync.
        scoreInput.dataset.autoScore = next;
      }
    }
  }

  function syncAllPillActiveStates() {
    els.scorecardGrid.querySelectorAll(".card-pill-row").forEach(syncPillActiveStateForRow);
    syncCardScoreMarks();
    syncPenaltyClubRows();
  }

  // Reveal the penalty-club picker only on holes with a penalty logged.
  // Render exactly N picker selects when penalties = N — one per stroke —
  // so the user can attribute each to a different club. Each picker
  // defaults to the hole's tee club the first time it appears.
  function syncPenaltyClubRows() {
    els.scorecardGrid.querySelectorAll(".card-penalty-club-row[data-hole]").forEach((row) => {
      const hole = row.dataset.hole;
      const penInput = els.scorecardGrid.querySelector(`.penalty-input[data-hole="${hole}"]`);
      const pen = penInput ? Number(penInput.value) : 0;
      const show = Number.isFinite(pen) && pen > 0;
      row.hidden = !show;
      if (!show) return;

      const container = row.querySelector(".penalty-club-selects");
      if (!container) return;

      const currentClubs = getHolePenaltyClubs(hole);
      const bag = getBag();
      // Default to the first non-Putter club on the hole (the real tee
      // shot) — clubsHit[0] alone can be Putter if no tee club was logged
      // and putts auto-added Putter, which would weirdly suggest blaming
      // the putter for a penalty.
      const tee = getHoleClubs(hole).find((c) => c !== "Putter");
      const fallback = bag.includes("Driver") ? "Driver" : (bag.find((c) => c !== "Putter") || "");
      const defaultClub = tee || fallback;
      const optionsHtml = clubsForHole(hole)
        .map((club) => `<option value="${escapeHtml(club)}">${escapeHtml(club)}</option>`)
        .join("");

      // Rebuild only when the slot count actually changes — otherwise
      // we'd blow away the user's typed selections on every score keystroke.
      const existingCount = container.querySelectorAll(".penalty-club-input").length;
      if (existingCount !== pen) {
        let html = "";
        for (let i = 0; i < pen; i++) {
          const indexLabel = pen > 1
            ? `<span class="penalty-club-index">Pen ${i + 1}</span>`
            : "";
          html += `
            <div class="penalty-club-select-row">
              ${indexLabel}
              <select class="penalty-club-input compact-select" data-hole="${hole}" data-penalty-index="${i}" aria-label="Club that caused penalty ${i + 1}">
                <option value="">— club —</option>
                ${optionsHtml}
              </select>
            </div>`;
        }
        container.innerHTML = html;
      }

      // Apply saved values; for any slot with no saved value, default to
      // the tee club and persist the default into state so the saved round
      // captures it on next save.
      let mutatedState = false;
      const nextClubs = [...currentClubs];
      container.querySelectorAll(".penalty-club-input").forEach((select) => {
        const idx = Number(select.dataset.penaltyIndex);
        const saved = nextClubs[idx];
        if (saved && [...select.options].some((opt) => opt.value === saved)) {
          select.value = saved;
          return;
        }
        // No saved value — default to tee/fallback if it's a valid option.
        if (defaultClub && [...select.options].some((opt) => opt.value === defaultClub)) {
          select.value = defaultClub;
          nextClubs[idx] = defaultClub;
          mutatedState = true;
        }
      });
      // Trim to penalty count (drop slots beyond pen).
      if (nextClubs.length > pen) {
        nextClubs.length = pen;
        mutatedState = true;
      }
      if (mutatedState) setHolePenaltyClubs(hole, nextClubs);
    });
  }

  // GIR is purely a function of score + putts + par, so the user never needs
  // to tick it. Recompute on every score/putts change and update the hidden
  // checkbox so save/readScorecard see the right value.
  //
  // (We used to auto-add Putter to clubsHit when putts > 0, but the Putts
  // pill row already captures putter use exactly. Tracking Putter twice
  // was duplicative, and showing a Putter pill the user could tap was
  // a source of confusion. Putter is no longer in the clubs-hit grid;
  // see renderClubsHitPills for the filter.)
  function syncDerivedHoleFlags(holeNumber) {
    const hole = Number(holeNumber);
    if (!Number.isFinite(hole)) return;
    const scoreInput = els.scorecardGrid.querySelector(`.score-input[data-hole="${hole}"]`);
    if (!scoreInput) return;
    const puttsInput = els.scorecardGrid.querySelector(`.putts-input[data-hole="${hole}"]`);
    const girInput = els.scorecardGrid.querySelector(`.gir-input[data-hole="${hole}"]`);
    const par = Number(scoreInput.dataset.par);
    const score = scoreInput.value === "" ? NaN : Number(scoreInput.value);
    const putts = puttsInput && puttsInput.value !== "" ? Number(puttsInput.value) : NaN;
    if (girInput) {
      girInput.checked = derivedGir(score, putts, par);
    }
  }

  function syncAllDerivedFlags() {
    els.scorecardGrid.querySelectorAll(".score-input[data-hole]").forEach((input) => {
      syncDerivedHoleFlags(input.dataset.hole);
    });
  }

  // Show a traditional birdie-circle / bogey-box mark in each card's headline
  // once a score is entered, so the card reads back the result at a glance.
  function syncCardScoreMarks() {
    els.scorecardGrid.querySelectorAll(".card-hole-mark[data-hole]").forEach((el) => {
      const hole = el.dataset.hole;
      const scoreInput = els.scorecardGrid.querySelector(`.score-input[data-hole="${hole}"]`);
      const par = scoreInput ? Number(scoreInput.dataset.par) : NaN;
      const score = scoreInput && scoreInput.value ? Number(scoreInput.value) : NaN;
      if (Number.isFinite(score) && score > 0) {
        el.innerHTML = renderScoreMark(score, par);
        el.hidden = false;
      } else {
        el.innerHTML = "";
        el.hidden = true;
      }
    });
  }

  function openHolePicker() {
    const cards = [...els.scorecardGrid.querySelectorAll(".scorecard-card")];
    if (!cards.length || !els.holePickerOverlay || !els.holePickerList) return;
    const activeIndex = getActiveCardIndex();
    els.holePickerList.innerHTML = cards.map((card, index) => {
      const labelEl = card.querySelector(".card-hole-label");
      const metaEl = card.querySelector(".card-hole-meta");
      const scoreInput = card.querySelector(".score-input");
      const par = scoreInput ? Number(scoreInput.dataset.par) : null;
      const label = labelEl ? labelEl.textContent.trim() : `Hole ${index + 1}`;
      const metaParts = metaEl ? [...metaEl.querySelectorAll("span")].map((span) => span.textContent.trim()).filter(Boolean) : [];
      const meta = metaParts.join(" · ");
      const scoreValue = scoreInput && scoreInput.value ? Number(scoreInput.value) : null;
      const needsEntry = !(Number.isFinite(scoreValue) && scoreValue > 0);
      return `
        <li>
          <button type="button" class="hp-row${index === activeIndex ? " active" : ""}${needsEntry ? " hp-row-needs-entry" : ""}" data-jump-hole="${index}">
            <span class="hp-row-index">${index + 1}</span>
            <span class="hp-row-label"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(meta)}</small></span>
            <span class="hp-row-score">${renderScoreMark(scoreValue, par)}</span>
          </button>
        </li>`;
    }).join("");
    els.holePickerOverlay.hidden = false;
    document.body.classList.add("hole-picker-open");
    if (els.holePickerClose) els.holePickerClose.focus();
  }

  function closeHolePicker() {
    if (!els.holePickerOverlay) return;
    els.holePickerOverlay.hidden = true;
    document.body.classList.remove("hole-picker-open");
  }

  // Build a Round-shaped object from the in-progress scorecard state so the
  // review panel can preview what the saved round will look like. Uses the
  // canonical makeRound / makeHole builders so future-added fields don't
  // silently fall through. The id is a stable but recognizable sentinel —
  // it has to be unique so generateRoundNarrative's "vs your other rounds"
  // filter doesn't see the round comparing against itself.
  function buildInProgressRoundShape(allHoles) {
    const holes = allHoles.map((h) => makeHole({
      number: h.number,
      label: h.label,
      par: h.par,
      yards: h.yards,
      score: h.score,
      putts: h.putts,
      firstPuttDistance: h.firstPuttDistance,
      fringePutts: h.fringePutts,
      fairwayHit: h.fairwayHit,
      greenInRegulation: h.greenInRegulation,
      clubsHit: h.clubsHit,
      penaltyClubs: h.penaltyClubs,
      penalties: h.penalties,
      bunker: h.bunker,
      note: h.note
    }));
    return makeRound({
      id: "__in_progress_review_preview__",
      courseId: els.roundCourse ? els.roundCourse.value : "",
      date: els.roundDate ? els.roundDate.value : today,
      holes,
      wind: els.roundWind ? els.roundWind.value : "",
      tag: els.roundTag ? els.roundTag.value : "",
      note: els.roundNote ? els.roundNote.value : ""
    });
  }

  // Render Summary + Scorecard previews inside the Review & Save panel so
  // the user can see what they're about to save without leaving the entry
  // flow. Both blocks are <details> collapsed by default — Jeff didn't
  // want them to crowd the reflection inputs.
  function renderReviewPreview(allHoles) {
    if (!els.reviewPreview) return;
    const scored = allHoles.filter((h) => Number.isFinite(h.score) && h.score > 0);
    // Nothing entered yet → hide the section entirely; the completion check
    // will say "missing scores" and that's enough on its own.
    if (!scored.length) {
      els.reviewPreview.innerHTML = "";
      els.reviewPreview.hidden = true;
      return;
    }
    const previewRound = buildInProgressRoundShape(allHoles);
    // Narrative uses `state.rounds` to compute "vs your typical" baselines
    // and personal-best detection. The in-progress round's sentinel id keeps
    // it from comparing against itself.
    let narrativeHtml = "";
    try {
      const narrative = generateRoundNarrative(previewRound, state.rounds);
      if (narrative) {
        const paragraphs = narrative.split("\n\n")
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join("");
        narrativeHtml = `
          <details class="review-preview-block">
            <summary>Summary</summary>
            <div class="review-preview-body">${paragraphs}</div>
          </details>`;
      }
    } catch (err) {
      // Defensive: a partially-filled round shouldn't crash the review panel.
      // If narrative generation throws, just skip it and still show the
      // scorecard.
      console.warn("review preview narrative failed", err);
    }
    const scorecardHtml = `
      <details class="review-preview-block">
        <summary>Scorecard</summary>
        <div class="review-preview-body">${renderRoundScorecard(previewRound)}</div>
      </details>`;
    els.reviewPreview.innerHTML = narrativeHtml + scorecardHtml;
    els.reviewPreview.hidden = false;
  }

  function renderCompletionCheck(allHoles, enteredHoles) {
    if (!els.completionCheck) return;
    if (!allHoles.length) {
      els.completionCheck.innerHTML = "";
      els.completionCheck.hidden = true;
      return;
    }
    // Identify what's missing: score is required; flag empty putts (user
    // cleared) or empty first-putt-distance (truly null) as soft warnings.
    // In speed mode, the only required field is score — the putts row is
    // hidden, so it makes no sense to flag every hole as "missing putts."
    const speedMode = currentEntryMode === "speed";
    const missingScore = [];
    const missingPutts = [];
    const missingFirstPutt = [];
    allHoles.forEach((hole) => {
      const hasScore = Number.isFinite(hole.score) && hole.score > 0;
      if (!hasScore) {
        missingScore.push(hole);
        return; // Other fields aren't worth flagging on a hole with no score
      }
      if (speedMode) return; // Score is the only required field
      const puttsInput = els.scorecardGrid.querySelector(`.putts-input[data-hole="${hole.number}"]`);
      if (puttsInput && puttsInput.value.trim() === "") missingPutts.push(hole);
      if (hole.firstPuttDistance === null || hole.firstPuttDistance === undefined) {
        missingFirstPutt.push(hole);
      }
    });

    els.completionCheck.hidden = false;

    if (!missingScore.length && !missingPutts.length) {
      els.completionCheck.innerHTML = `
        <div class="completion-banner completion-ok">
          <span class="completion-icon" aria-hidden="true">✓</span>
          <div>
            <strong>All ${allHoles.length} holes complete.</strong>
            <span>Ready to save${missingFirstPutt.length ? ` (${missingFirstPutt.length} hole${missingFirstPutt.length === 1 ? "" : "s"} without first-putt distance)` : ""}.</span>
          </div>
        </div>`;
      return;
    }

    const chipFor = (hole, reason) => `<button type="button" class="completion-chip" data-jump-hole-number="${hole.number}" title="${escapeHtml(reason)}">${escapeHtml(hole.label || `#${hole.number}`)}</button>`;
    const sections = [];
    if (missingScore.length) {
      sections.push(`<div class="completion-section"><span class="completion-section-label">Missing score:</span> ${missingScore.map((h) => chipFor(h, "Missing score")).join(" ")}</div>`);
    }
    if (missingPutts.length) {
      sections.push(`<div class="completion-section"><span class="completion-section-label">Empty putts:</span> ${missingPutts.map((h) => chipFor(h, "Empty putts")).join(" ")}</div>`);
    }
    els.completionCheck.innerHTML = `
      <div class="completion-banner completion-warn">
        <span class="completion-icon" aria-hidden="true">⚠</span>
        <div class="completion-body">
          <strong>${missingScore.length + missingPutts.length} item${missingScore.length + missingPutts.length === 1 ? "" : "s"} to fill in</strong>
          ${sections.join("")}
          <span class="completion-hint">Tap a hole to jump to it.</span>
        </div>
      </div>`;

    els.completionCheck.querySelectorAll("[data-jump-hole-number]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const targetNumber = Number(chip.dataset.jumpHoleNumber);
        if (viewMode === "card") {
          const cards = [...els.scorecardGrid.querySelectorAll(".scorecard-card")];
          const index = cards.findIndex((c) => Number(c.dataset.holeNumber) === targetNumber);
          if (index >= 0) {
            setActiveCardIndex(index);
            const card = cards[index];
            if (card) card.scrollIntoView({ block: "start", behavior: "smooth" });
          }
        } else {
          const input = els.scorecardGrid.querySelector(`.score-input[data-hole="${targetNumber}"]`);
          if (input) {
            input.focus();
            input.scrollIntoView({ block: "center", behavior: "smooth" });
          }
        }
      });
    });
  }

  function updateViewToggleLabel() {
    if (!els.viewToggleButton) return;
    els.viewToggleButton.textContent = viewMode === "card" ? "Grid view" : "Card view";
    els.viewToggleButton.setAttribute("aria-pressed", viewMode === "card" ? "true" : "false");
  }

  function setViewMode(mode) {
    const next = mode === "card" ? "card" : "grid";
    if (next === viewMode) return;
    const snapshot = captureScorecardSnapshot();
    viewMode = next;
    try {
      localStorage.setItem(VIEW_MODE_KEY, viewMode);
    } catch {
      // localStorage unavailable; mode is still applied for the session.
    }
    renderScorecard(getSelectedRoundCourse());
    applyScorecardSnapshot(snapshot);
    updateRoundPreview();
  }

  function captureScorecardSnapshot() {
    const map = new Map();
    els.scorecardGrid.querySelectorAll(".score-input[data-hole]").forEach((scoreInput) => {
      const hole = scoreInput.dataset.hole;
      const puttsInput = els.scorecardGrid.querySelector(`.putts-input[data-hole="${hole}"]`);
      const fairwayInput = els.scorecardGrid.querySelector(`.fairway-input[data-hole="${hole}"]`);
      const bunkerInput = els.scorecardGrid.querySelector(`.bunker-input[data-hole="${hole}"]`);
      const girInput = els.scorecardGrid.querySelector(`.gir-input[data-hole="${hole}"]`);
      const penaltyInput = els.scorecardGrid.querySelector(`.penalty-input[data-hole="${hole}"]`);
      const firstPuttInput = els.scorecardGrid.querySelector(`.first-putt-input[data-hole="${hole}"]`);
      const fringePuttsInput = els.scorecardGrid.querySelector(`.fringe-putts-input[data-hole="${hole}"]`);
      map.set(Number(hole), {
        score: scoreInput.value,
        putts: puttsInput ? puttsInput.value : "",
        fairway: fairwayInput ? fairwayInput.value : "",
        bunker: bunkerInput ? bunkerInput.value : "",
        gir: girInput ? girInput.checked : false,
        penalty: penaltyInput ? penaltyInput.value : "",
        firstPutt: firstPuttInput ? firstPuttInput.value : "",
        fringePutts: fringePuttsInput ? fringePuttsInput.value : ""
      });
    });
    return map;
  }

  function applyScorecardSnapshot(snapshot) {
    if (!snapshot || !snapshot.size) return;
    snapshot.forEach((values, holeNumber) => {
      const hole = String(holeNumber);
      const scoreInput = els.scorecardGrid.querySelector(`.score-input[data-hole="${hole}"]`);
      const puttsInput = els.scorecardGrid.querySelector(`.putts-input[data-hole="${hole}"]`);
      const fairwayInput = els.scorecardGrid.querySelector(`.fairway-input[data-hole="${hole}"]`);
      const bunkerInput = els.scorecardGrid.querySelector(`.bunker-input[data-hole="${hole}"]`);
      const girInput = els.scorecardGrid.querySelector(`.gir-input[data-hole="${hole}"]`);
      const penaltyInput = els.scorecardGrid.querySelector(`.penalty-input[data-hole="${hole}"]`);
      const firstPuttInput = els.scorecardGrid.querySelector(`.first-putt-input[data-hole="${hole}"]`);
      const fringePuttsInput = els.scorecardGrid.querySelector(`.fringe-putts-input[data-hole="${hole}"]`);
      if (scoreInput && values.score !== "") {
        scoreInput.value = values.score;
        // Stamp dataset.autoScore so recalculateScoreForHole treats the
        // loaded value as "still being driven by auto-calc" rather than a
        // manual override. Without this, editing a saved round and then
        // changing any input (clubs / putts / penalties) leaves the score
        // frozen on its loaded value because the recalc bail-out
        // (currentValue !== lastAuto) fires every time. A real manual
        // override gets re-asserted as soon as the user taps a score pill
        // — the pill handler clears dataset.autoScore. This is the
        // "least-surprise" choice in edit mode: tweaking clubs after the
        // fact updates the score; explicit score taps win.
        scoreInput.dataset.autoScore = String(values.score);
      }
      if (puttsInput && values.putts !== "") puttsInput.value = values.putts;
      if (fairwayInput && values.fairway && [...fairwayInput.options].some((option) => option.value === values.fairway)) {
        fairwayInput.value = values.fairway;
      }
      if (bunkerInput && values.bunker && [...bunkerInput.options].some((option) => option.value === values.bunker)) {
        bunkerInput.value = values.bunker;
      }
      if (girInput) girInput.checked = Boolean(values.gir);
      if (penaltyInput && values.penalty !== "") penaltyInput.value = values.penalty;
      if (firstPuttInput && values.firstPutt !== "") firstPuttInput.value = values.firstPutt;
      if (fringePuttsInput && values.fringePutts !== undefined && values.fringePutts !== "") fringePuttsInput.value = values.fringePutts;
    });
  }

  function advanceScorecardOnEnter(event) {
    if (event.key !== "Enter") return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const advanceClasses = ["score-input", "putts-input", "penalty-input"];
    const matching = advanceClasses.find((name) => target.classList.contains(name));
    if (!matching) return;
    event.preventDefault();
    const peers = [...els.scorecardGrid.querySelectorAll(`.${matching}`)];
    const index = peers.indexOf(target);
    const next = peers[index + 1] || peers[0];
    if (next instanceof HTMLInputElement) {
      next.focus();
      next.select();
    }
  }

  function getScorecardSections(holes) {
    if (holes.length <= 9) {
      return [scorecardSection("Round", holes)];
    }
    const grouped = [];
    holes.forEach((hole) => {
      const label = String(hole.label || "");
      const groupLabel = label.includes(" ") ? `${label.split(" ")[0]} nine` : hole.number <= 9 ? "Front nine" : "Back nine";
      let group = grouped.find((candidate) => candidate.label === groupLabel);
      if (!group) {
        group = { label: groupLabel, holes: [] };
        grouped.push(group);
      }
      group.holes.push(hole);
    });
    return grouped.map((group) => scorecardSection(group.label, group.holes));
  }

  function scorecardSection(label, holes) {
    return {
      label,
      holes,
      par: holes.reduce((sum, hole) => sum + hole.par, 0),
      yards: holes.reduce((sum, hole) => sum + Number(hole.yards || 0), 0)
    };
  }

  function scoreInputCell(hole) {
    return `
      <input
        class="score-input compact-input"
        data-hole="${hole.number}"
        data-label="${escapeHtml(hole.label || hole.number)}"
        data-par="${hole.par}"
        data-yards="${hole.yards || ""}"
        data-hcp="${hole.hcp || ""}"
        type="number"
        min="1"
        max="15"
        inputmode="numeric"
        placeholder="${hole.par}"
        aria-label="${escapeHtml(hole.label || `Hole ${hole.number}`)} score"
      >`;
  }

  function fairwayInputCell(hole) {
    if (hole.par === 3) {
      return `<select class="fairway-input compact-select" data-hole="${hole.number}" disabled aria-label="${escapeHtml(hole.label || `Hole ${hole.number}`)} fairway"><option value="na">N/A</option></select>`;
    }
    const options = [
      `<option value="" selected>—</option>`,
      `<option value="hit">Hit</option>`,
      `<option value="left">Left</option>`,
      `<option value="right">Right</option>`,
      `<option value="short">Short</option>`,
      `<option value="long">Long</option>`,
      `<option value="miss">Miss</option>`
    ].join("");
    return `<select class="fairway-input compact-select" data-hole="${hole.number}" aria-label="${escapeHtml(hole.label || `Hole ${hole.number}`)} fairway">${options}</select>`;
  }

  function bunkerInputCell(hole) {
    // Default to "none" — most holes have no bunker, so pre-selecting it
    // means the user only flips this on the holes where sand was actually
    // a factor. Mirrors the Penalty input which defaults to 0 for the
    // same reason.
    const options = [
      `<option value="none" selected>No</option>`,
      `<option value="fairway">Fairway</option>`,
      `<option value="greenside">Greenside</option>`,
      `<option value="both">Both</option>`
    ].join("");
    return `<select class="bunker-input compact-select" data-hole="${hole.number}" aria-label="${escapeHtml(hole.label || `Hole ${hole.number}`)} bunker">${options}</select>`;
  }

  // In-round chrome: once a round is underway the setup fields (course, tee,
  // wind, rating/slope) collapse into a one-line banner so the screen is just
  // the scorecard. Tapping the banner re-opens the fields to change something.
  let roundSetupOpen = true;
  let roundChromeAutoCollapsed = false;

  function resetRoundChrome() {
    roundSetupOpen = true;
    roundChromeAutoCollapsed = false;
    // A fresh round hasn't been touched yet — pre-filled defaults don't count.
    roundTouched = false;
    renderRoundSetupChrome();
  }

  function roundSetupSummary() {
    const selected = getSelectedRoundCourse();
    const parts = [selected ? selected.name : "Round setup"];
    if (els.roundTeeField && !els.roundTeeField.hidden && els.roundTee.value) {
      parts.push(`${els.roundTee.value} tee`);
    }
    if (els.roundWind && els.roundWind.value) {
      parts.push(formatWind(els.roundWind.value));
    }
    return parts.join("  ·  ");
  }

  function renderRoundSetupChrome() {
    if (!els.roundSetupBanner || !els.roundSetup) return;
    if (!els.roundCourse.value) {
      els.roundSetupBanner.hidden = true;
      els.roundSetup.hidden = false;
      return;
    }
    els.roundSetupBanner.hidden = false;
    els.roundSetup.hidden = !roundSetupOpen;
    els.roundSetupBanner.classList.toggle("is-open", roundSetupOpen);
    els.roundSetupBanner.setAttribute("aria-expanded", String(roundSetupOpen));
    els.roundSetupBanner.innerHTML = roundSetupOpen
      ? `<span class="rcb-text">Round setup</span><span class="rcb-action">Hide ▴</span>`
      : `<span class="rcb-text">${escapeHtml(roundSetupSummary())}</span><span class="rcb-action">Edit ▾</span>`;
  }

  function updateRoundPreview() {
    const allHoles = readScorecard(false);
    const entered = allHoles.filter((hole) => Number.isFinite(hole.score) && hole.score > 0);
    renderCompletionCheck(allHoles, entered);
    renderReviewPreview(allHoles);
    // Collapse the setup section the first time a score lands — the round is
    // underway, so get the fields out of the way and focus on the scorecard.
    if (entered.length >= 1 && !roundChromeAutoCollapsed) {
      roundChromeAutoCollapsed = true;
      roundSetupOpen = false;
      requestAnimationFrame(() => {
        const activeCard = els.scorecardGrid.querySelector(".scorecard-card.active");
        if (activeCard && typeof activeCard.scrollIntoView === "function") {
          activeCard.scrollIntoView({ block: "start" });
        }
      });
    }
    renderRoundSetupChrome();

    // No course selected → no scorecard, so hide the live summary entirely
    // (otherwise a row of "--" placeholders would float above the "Add a
    // course" empty state, which is just confusing).
    if (!allHoles.length) {
      els.roundPreview.textContent = "--";
      els.roundLiveSummary.innerHTML = "";
      return;
    }

    // Always render the live summary skeleton so its height is stable. When
    // empty it shows "--" placeholders; when populated the same cards just
    // fill in. Stable height = no scroll jump above the user's viewport
    // when they tap their first score pill.

    // "committed" = holes the user has effectively finished with. In card
    // view (and not editing a saved round), exclude the currently-active
    // card from the live summary totals so gross/putts/etc don't jitter
    // as the user adjusts scores mid-hole. The numbers commit when they
    // advance to the next hole. Exception: when every hole already has a
    // score, include everything — the user has effectively finished the
    // round and shouldn't be stuck "missing" the last hole in the summary.
    let committed = entered;
    if (viewMode === "card"
        && !editingRoundId
        && entered.length < allHoles.length) {
      const activeCard = els.scorecardGrid.querySelector(".scorecard-card.active");
      const activeHoleNumber = activeCard ? Number(activeCard.dataset.holeNumber) : null;
      if (Number.isFinite(activeHoleNumber)) {
        committed = entered.filter((hole) => hole.number !== activeHoleNumber);
      }
    }

    const complete = entered.length === allHoles.length;
    const gross = committed.reduce((sum, hole) => sum + hole.score, 0);
    const par = committed.reduce((sum, hole) => sum + hole.par, 0);
    const putts = committed.reduce((sum, hole) => sum + hole.putts, 0);
    const penalties = committed.reduce((sum, hole) => sum + hole.penalties, 0);
    const girMade = committed.filter((hole) => hole.gir).length;
    const fairwayHoles = committed.filter((hole) => hole.fairway && hole.fairway !== "na");
    const fairwaysHit = fairwayHoles.filter((hole) => hole.fairway === "hit").length;
    // Differential is a round-level number that only makes sense once every
    // hole is in — keep gating on `entered` so it appears the moment the
    // last score lands, even before the user advances away from it.
    const differential = (entered.length && complete) ? estimateRoundDifferential(getSelectedRoundCourse(), entered) : null;
    const sgTotal = committed.length ? committed.reduce((sum, hole) => sum + (holeStrokesGained(hole) || 0), 0) : null;
    const throughSuffix = committed.length ? (complete ? "" : ` | thru ${committed.length}/${allHoles.length}`) : "";

    els.roundPreview.textContent = committed.length
      ? `${gross} (${formatSigned(gross - par, 0)}) | ${putts} putts${throughSuffix}`
      : "--";

    const grossLabel = !committed.length ? "Gross" : complete ? "Gross" : `Gross (thru ${committed.length})`;
    const grossValue = committed.length ? gross : "--";
    const toParValue = committed.length ? formatSigned(gross - par, 0) : "--";
    const puttsValue = committed.length ? putts : "--";
    const firValue = fairwayHoles.length ? percentage(fairwaysHit, fairwayHoles.length) : "--";
    const girValue = girMade ? percentage(girMade, committed.length) : "--";
    const penValue = committed.length ? penalties : "--";
    const sgValue = sgTotal === null ? "--" : formatSigned(sgTotal);
    const diffValue = differential === null ? "--" : differential.toFixed(1);

    els.roundLiveSummary.innerHTML = `
      <div class="live-summary-card"><span>${grossLabel}</span><strong>${grossValue}</strong></div>
      <div class="live-summary-card"><span>To par</span><strong>${toParValue}</strong></div>
      <div class="live-summary-card"><span>Putts</span><strong>${puttsValue}</strong></div>
      <div class="live-summary-card live-summary-card-drill" data-stat-drill="fir" role="button" tabindex="0" aria-label="Fairways in regulation — tap to see which holes"><span>FIR</span><strong>${firValue}</strong></div>
      <div class="live-summary-card live-summary-card-drill" data-stat-drill="gir" role="button" tabindex="0" aria-label="Greens in regulation — tap to see which holes"><span>GIR</span><strong>${girValue}</strong></div>
      <div class="live-summary-card"><span>Pen</span><strong>${penValue}</strong></div>
      <div class="live-summary-card"><span>SG vs Tour</span><strong>${sgValue}</strong></div>
      <div class="live-summary-card accent"><span>Diff est.</span><strong>${diffValue}</strong></div>
    `;
  }

  function readScorecard(requireComplete) {
    const scoreInputs = [...els.scorecardGrid.querySelectorAll(".score-input[data-hole]")];
    return scoreInputs.map((scoreInput) => {
      const holeNumber = scoreInput.dataset.hole;
      const puttsInput = els.scorecardGrid.querySelector(`.putts-input[data-hole="${holeNumber}"]`);
      const fairwayInput = els.scorecardGrid.querySelector(`.fairway-input[data-hole="${holeNumber}"]`);
      const bunkerInput = els.scorecardGrid.querySelector(`.bunker-input[data-hole="${holeNumber}"]`);
      const girInput = els.scorecardGrid.querySelector(`.gir-input[data-hole="${holeNumber}"]`);
      const penaltyInput = els.scorecardGrid.querySelector(`.penalty-input[data-hole="${holeNumber}"]`);
      const firstPuttInput = els.scorecardGrid.querySelector(`.first-putt-input[data-hole="${holeNumber}"]`);
      const fringePuttsInput = els.scorecardGrid.querySelector(`.fringe-putts-input[data-hole="${holeNumber}"]`);
      const scoreRaw = scoreInput.value.trim();
      const scoreValue = scoreRaw === "" ? null : Number(scoreRaw);
      const puttsValue = Number(puttsInput.value);
      const penaltyValue = Number(penaltyInput.value);
      const firstPuttRaw = firstPuttInput ? firstPuttInput.value.trim() : "";
      const firstPuttValue = firstPuttRaw === "" ? null : Number(firstPuttRaw);
      const fringePuttsValue = fringePuttsInput ? Number(fringePuttsInput.value || 0) : 0;
      if (requireComplete) {
        if (!scoreValue || scoreValue < 1) {
          throw new Error(`Enter a score on ${scoreInput.dataset.label || `hole ${holeNumber}`} before saving.`);
        }
        if (puttsValue < 0 || penaltyValue < 0) {
          throw new Error("Putts and penalties must be 0 or higher.");
        }
      }
      return makeHole({
        number: Number(holeNumber),
        label: scoreInput.dataset.label || holeNumber,
        par: Number(scoreInput.dataset.par),
        yards: Number(scoreInput.dataset.yards || 0),
        hcp: Number(scoreInput.dataset.hcp || 0) || null,
        score: scoreValue,
        putts: Number.isFinite(puttsValue) ? puttsValue : 0,
        fairway: fairwayInput.value,
        gir: girInput.checked,
        penalties: Number.isFinite(penaltyValue) ? penaltyValue : 0,
        penaltyClubs: (Number.isFinite(penaltyValue) && penaltyValue > 0)
          ? getHolePenaltyClubs(holeNumber).slice(0, penaltyValue)
          : [],
        firstPuttDistance: Number.isFinite(firstPuttValue) && firstPuttValue >= 0 ? firstPuttValue : null,
        fringePutts: Number.isFinite(fringePuttsValue) && fringePuttsValue > 0 ? fringePuttsValue : 0,
        bunker: bunkerInput ? bunkerInput.value : "",
        note: getHoleNote(holeNumber),
        clubsHit: getHoleClubs(holeNumber)
      });
    });
  }

  // Thin app-bound wrappers around the pure lib versions: they inject
  // getCourse as the lookupCourse dependency and pull state.rounds when no
  // round set is passed explicitly. All the math lives in lib/golf-math.js
  // (and is unit-tested there).
  function calculateHandicapEstimate(rounds) {
    return calculateHandicapEstimatePure(rounds, getCourse);
  }

  function estimateRoundDifferential(course, holes) {
    const currentIndex = calculateHandicapEstimate(state.rounds).index;
    return estimateRoundDifferentialPure(course, holes, currentIndex);
  }

  function renderMetrics(rounds) {
    const totals = rounds.map(roundTotals);
    const girMade = totals.reduce((sum, item) => sum + item.girMade, 0);
    const girTotal = totals.reduce((sum, item) => sum + item.girTotal, 0);
    const handicap = calculateHandicapEstimate(state.rounds);
    // Average score / to-par / best round are only meaningful when the
    // rounds are the same shape — averaging a 9-hole 38 with an 18-hole 78
    // produces nonsense. Restrict the headline numbers to 18-hole rounds.
    // The 9-hole story shows up in the per-nine Deerwood panel below.
    const eighteenHoleRounds = rounds.filter((r) => Array.isArray(r.holes) && r.holes.length === 18);
    const fullTotals = eighteenHoleRounds.map(roundTotals);
    const best = [...eighteenHoleRounds].sort((a, b) => {
      const aTotals = roundTotals(a);
      const bTotals = roundTotals(b);
      return aTotals.toPar - bTotals.toPar || aTotals.gross - bTotals.gross;
    })[0];
    const sgRounds = rounds.map(roundStrokesGained).filter(Boolean);
    const avgSg = sgRounds.length ? average(sgRounds.map((item) => item.total)) : NaN;
    const excludedNineCount = rounds.length - eighteenHoleRounds.length;
    const fullAvg = average(fullTotals.map((item) => item.gross));
    const fullToPar = average(fullTotals.map((item) => item.toPar));

    renderHeroStat(rounds, handicap, eighteenHoleRounds);
    els.metricRounds.textContent = String(rounds.length);
    els.metricAverageScore.textContent = Number.isFinite(fullAvg) ? fullAvg.toFixed(1) : "--";
    els.metricAveragePar.textContent = formatSigned(fullToPar);
    els.metricBestRound.textContent = best ? `${roundTotals(best).gross} (${formatSigned(roundTotals(best).toPar, 0)})` : "--";
    // The Best round tile is tappable — stash the round id so the click
    // handler can open that round's scorecard sheet. No best round (no
    // 18-hole rounds yet) → tile renders but does nothing on tap.
    if (els.metricBestRoundCard) {
      if (best) {
        els.metricBestRoundCard.dataset.roundId = best.id;
        els.metricBestRoundCard.classList.add("has-round");
      } else {
        delete els.metricBestRoundCard.dataset.roundId;
        els.metricBestRoundCard.classList.remove("has-round");
      }
    }
    els.metricGir.textContent = percentage(girMade, girTotal);
    els.metricSg.textContent = Number.isFinite(avgSg) ? formatSigned(avgSg) : "--";
    // Handicap tile moved into the hero stat — the element no longer exists
    // in the metrics grid, but keep the guard in case a future layout
    // brings it back.
    if (els.metricHandicap) {
      els.metricHandicap.textContent = handicap.index === null ? "--" : handicap.index.toFixed(1);
    }
    // Tell the user when 9-hole rounds are excluded from the headline so the
    // numbers don't quietly under- or over-state things.
    if (els.metricAverageScoreNote) {
      const note = excludedNineCount > 0
        ? `${eighteenHoleRounds.length} of ${rounds.length} rounds (9-hole excluded)`
        : "";
      els.metricAverageScoreNote.textContent = note;
      els.metricAverageScoreNote.hidden = !note;
    }
  }

  // The Home hero: ONE number, huge, on deep clubhouse green, with the
  // 18-hole gross sparkline built into the same moment. Composition answer
  // to "seven equal tiles = zero important things." Handicap leads when we
  // have one; otherwise the latest round's gross takes the spot so new
  // users still get a hero from round one.
  function renderHeroStat(rounds, handicap, eighteenHoleRounds) {
    const hero = document.getElementById("homeHeroStat");
    if (!hero) return;
    if (!rounds.length) {
      hero.hidden = true;
      hero.innerHTML = "";
      return;
    }
    const lastRound = [...rounds].sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
    const lastTotals = lastRound ? roundTotals(lastRound) : null;
    const hasIndex = handicap && handicap.index !== null && Number.isFinite(handicap.index);

    const eyebrow = hasIndex ? "Handicap index · estimate" : "Latest round";
    const number = hasIndex
      ? handicap.index.toFixed(1)
      : `${lastTotals.gross}`;
    const numberSuffix = hasIndex ? "" : ` <span class="hero-number-sub">(${formatSigned(lastTotals.toPar, 0)})</span>`;

    const subline = hasIndex && lastRound
      ? `<button type="button" class="hero-last-round" data-hero-round="${escapeHtml(lastRound.id)}">
          Last round: ${lastTotals.gross} (${formatSigned(lastTotals.toPar, 0)}) · ${escapeHtml(physicalCourseName(lastRound.courseId))} <span aria-hidden="true">›</span>
        </button>`
      : lastRound
        ? `<button type="button" class="hero-last-round" data-hero-round="${escapeHtml(lastRound.id)}">
            ${escapeHtml(physicalCourseName(lastRound.courseId))} · ${escapeHtml(lastRound.date || "")} <span aria-hidden="true">›</span>
          </button>`
        : "";

    // Sparkline: last 10 18-hole gross scores. Area gradient + a gold dot
    // on the most recent point. Skipped below 2 points.
    const series = [...eighteenHoleRounds]
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
      .slice(-10)
      .map((r) => roundTotals(r).gross);
    let spark = "";
    if (series.length >= 2) {
      const w = 220, h = 56, pad = 6;
      const min = Math.min(...series), max = Math.max(...series);
      const span = Math.max(1, max - min);
      const x = (i) => pad + (i * (w - pad * 2)) / (series.length - 1);
      const y = (v) => pad + ((max - v) * (h - pad * 2)) / span;
      const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      const lastX = x(series.length - 1).toFixed(1);
      const lastY = y(series[series.length - 1]).toFixed(1);
      spark = `
        <svg class="hero-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="heroSparkFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#d9c08a" stop-opacity="0.45"/>
              <stop offset="100%" stop-color="#d9c08a" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <path d="M${pts[0]} L${pts.join(" L")} L${lastX},${h - 1} L${pts[0].split(",")[0]},${h - 1} Z" fill="url(#heroSparkFill)"/>
          <polyline points="${pts.join(" ")}" fill="none" stroke="#f2ead3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="${lastX}" cy="${lastY}" r="3.4" fill="#d9c08a"/>
        </svg>
        <div class="hero-spark-caption">Last ${series.length} rounds · ${series[series.length - 1]} latest</div>`;
    }

    hero.hidden = false;
    hero.innerHTML = `
      <div class="hero-stat-main">
        <p class="hero-eyebrow">${eyebrow}</p>
        <div class="hero-number">${number}${numberSuffix}</div>
        ${subline}
      </div>
      <div class="hero-stat-side${spark ? "" : " empty"}">${spark}</div>`;
    const lastBtn = hero.querySelector("[data-hero-round]");
    if (lastBtn) {
      lastBtn.addEventListener("click", () => {
        const round = state.rounds.find((r) => r.id === lastBtn.dataset.heroRound);
        if (round) showRoundDetail(round);
      });
    }
  }

  function renderHomeInsights(rounds) {
    if (!rounds.length) {
      els.homeInsights.innerHTML = "";
      return;
    }
    const ordered = [...rounds].sort((a, b) => b.date.localeCompare(a.date));
    const recent = ordered.slice(0, 5).map(roundTotals);
    const previous = ordered.slice(5, 10).map(roundTotals);
    const recentAvg = average(recent.map((item) => item.toPar));
    const previousAvg = average(previous.map((item) => item.toPar));
    const formDelta = Number.isFinite(previousAvg) ? recentAvg - previousAvg : NaN;

    const courseGroups = Object.entries(groupBy(rounds, (round) => round.courseId)).map(([courseId, courseRounds]) => {
      const course = getCourse(courseId);
      const avgToPar = average(courseRounds.map((round) => roundTotals(round).toPar));
      return { course, avgToPar, rounds: courseRounds.length };
    }).sort((a, b) => a.avgToPar - b.avgToPar);
    const bestCourse = courseGroups[0];

    const parGroups = groupBy(rounds.flatMap((round) => round.holes), (hole) => String(hole.par));
    const weakestPar = Object.entries(parGroups).map(([par, holes]) => ({
      par,
      avgToPar: average(holes.map((hole) => hole.score - hole.par)),
      count: holes.length
    })).sort((a, b) => b.avgToPar - a.avgToPar)[0];

    const handicap = calculateHandicapEstimate(state.rounds);
    els.homeInsights.innerHTML = `
      <article class="insight-card">
        <span>Current form</span>
        <strong>${formatSigned(recentAvg)}</strong>
        <small>${Number.isFinite(formDelta) ? `${formatSigned(formDelta)} vs prior 5` : "Last 5 rounds"}</small>
      </article>
      <article class="insight-card">
        <span>Best course fit</span>
        <strong>${escapeHtml(bestCourse && bestCourse.course ? bestCourse.course.name.replace("Deerwood Golf Course - ", "") : "--")}</strong>
        <small>${bestCourse ? `${formatSigned(bestCourse.avgToPar)} avg to par | ${bestCourse.rounds} rounds` : "--"}</small>
      </article>
      <article class="insight-card">
        <span>Biggest leak</span>
        <strong>${weakestPar ? `Par ${weakestPar.par}` : "--"}</strong>
        <small>${weakestPar ? `${formatSigned(weakestPar.avgToPar)} per hole | ${weakestPar.count} holes` : "--"}</small>
      </article>
      <article class="insight-card dark">
        <span>Handicap signal</span>
        <strong>${handicap.index === null ? "--" : handicap.index.toFixed(1)}</strong>
        <small>${handicap.approximateNineCount || 0} nine-hole estimates included</small>
      </article>
    `;
  }

  // How many of the user's rounds DON'T produce a differential because the
  // course has no rating/slope on file. Drives the "here's why rounds are
  // missing" line in the handicap explainer.
  function countUnratedRounds() {
    return state.rounds.filter((round) => {
      const course = getCourse(round.courseId);
      return !course || !course.rating || !course.slope;
    }).length;
  }

  function renderHandicapPanel() {
    const estimate = calculateHandicapEstimate(state.rounds);
    const unrated = countUnratedRounds();
    const unratedLine = unrated > 0 ? `
      <p class="handicap-explain-step">
        <strong>${unrated} of your rounds ${unrated === 1 ? "doesn't" : "don't"} count yet</strong>
        because ${unrated === 1 ? "its course has" : "their courses have"} no
        rating &amp; slope on file. Add the official numbers via the Courses
        tab search (online results include them) and those rounds join the
        math automatically.
      </p>` : "";

    if (estimate.index === null) {
      els.handicapPanel.innerHTML = `
        <div class="handicap-index-box">
          <span>Estimated index</span>
          <strong>--</strong>
          <small>${estimate.eligible.length} rated score differential${estimate.eligible.length === 1 ? "" : "s"} so far — need 3</small>
        </div>
        <div class="handicap-explain">
          <h4 class="handicap-explain-h">Why there's no number yet</h4>
          <p class="handicap-explain-step">
            A handicap is built from <strong>differentials</strong> — one per
            round, measuring how you played against the course's difficulty:
            <em>(score − course rating) × 113 ÷ slope</em>. It takes at least
            <strong>3 rounds at rated courses</strong> to estimate an index.
          </p>
          ${unratedLine}
        </div>
        <p class="handicap-note">${estimate.note}</p>
      `;
      return;
    }

    const nextCourse = getSelectedRoundCourse();
    const par = nextCourse ? nextCourse.holes.reduce((sum, hole) => sum + hole.par, 0) : NaN;
    const courseHandicap = nextCourse && nextCourse.rating && nextCourse.slope
      ? Math.round(estimate.index * (nextCourse.slope / 113) + (nextCourse.rating - par))
      : null;
    // Plain-English walk-through with the user's real numbers. estimate.rule
    // is the WHS best-N-of-M table row; estimate.used are the rounds that
    // actually made the cut.
    const rule = estimate.rule;
    const adjText = rule && rule.adjustment
      ? `, then subtract ${Math.abs(rule.adjustment)} (small-sample safety margin)`
      : "";
    const usedIds = new Set(estimate.used.map((item) => item.round.id));
    const usedAvg = average(estimate.used.map((item) => item.differential));
    const usedExample = estimate.used.slice(0, 3).map((item) =>
      `${item.gross} at ${escapeHtml(physicalCourseName(item.round.courseId))} → ${item.differential.toFixed(1)}`
    ).join(" · ");
    const worstUsed = estimate.used.length
      ? Math.max(...estimate.used.map((i) => i.differential)).toFixed(1)
      : "—";

    // Every eligible round, best first; the counted ones get the brass badge.
    const rows = [...estimate.eligible]
      .sort((a, b) => a.differential - b.differential)
      .map((item) => `
        <li class="handicap-round-row${usedIds.has(item.round.id) ? " counted" : ""}">
          <span class="handicap-round-main">
            <strong>${item.gross}</strong>
            <button type="button" class="link-course" data-open-course-name="${escapeHtml(physicalCourseName(item.round.courseId))}">${escapeHtml(physicalCourseName(item.round.courseId))}</button>
            <small>${escapeHtml(item.round.date || "")}${item.approximate ? " · 9-hole est." : ""}</small>
          </span>
          <span class="handicap-round-diff">${item.differential.toFixed(1)}${usedIds.has(item.round.id) ? `<em class="counted-badge">counted</em>` : ""}</span>
        </li>`).join("");

    els.handicapPanel.innerHTML = `
      <div class="handicap-index-box">
        <span>Estimated index</span>
        <strong>${estimate.index.toFixed(1)}</strong>
        <small>${estimate.eligible.length} rated differentials · best ${estimate.used.length} counted</small>
      </div>
      <div class="handicap-explain">
        <h4 class="handicap-explain-h">How this number was built</h4>
        <p class="handicap-explain-step">
          <strong>1 · Every rated round gets a differential</strong> — how you
          played against that course's difficulty, scaled so easy and hard
          courses compare fairly: <em>(score − course rating) × 113 ÷ slope</em>.
        </p>
        <p class="handicap-explain-step">
          <strong>2 · Only your best rounds count.</strong> With ${estimate.eligible.length}
          rated rounds, the World Handicap System table says: average your best
          ${estimate.used.length}${adjText}.
        </p>
        <p class="handicap-explain-step">
          <strong>3 · Your best:</strong> ${usedExample}.
          Average ${usedAvg.toFixed(1)}${rule && rule.adjustment ? ` − ${Math.abs(rule.adjustment)}` : ""}
          → <strong>index ${estimate.index.toFixed(1)}</strong>.
          Beat a ${worstUsed} differential in a future round and the index drops.
        </p>
        ${unratedLine}
      </div>
      <ul class="handicap-round-list">${rows}</ul>
      <div class="handicap-details">
        <div class="handicap-detail-row"><span>Next course handicap</span><strong>${courseHandicap === null ? "--" : courseHandicap}</strong></div>
        <div class="handicap-detail-row"><span>9-hole estimates</span><strong>${estimate.approximateNineCount}</strong></div>
      </div>
      <p class="handicap-note">${estimate.note}</p>
    `;
  }

  function renderCourseStats(rounds) {
    // Group by (physical course name + hole count). Averaging a 9-hole 38
    // with an 18-hole 78 at the same course gives a meaningless ~58, so 9-
    // and 18-hole rounds get their own rows. Tee variants STILL pool within
    // a row (Diamond Hawk Black + Gold + Green stays one row per hole count).
    const groups = new Map();
    rounds.forEach((round) => {
      const name = physicalCourseName(round.courseId);
      const holeCount = Array.isArray(round.holes) ? round.holes.length : 0;
      if (!holeCount) return;
      const key = `${name}|${holeCount}`;
      if (!groups.has(key)) groups.set(key, { name, holeCount, rounds: [] });
      groups.get(key).rounds.push(round);
    });
    // Sort: alphabetically by course name, with the larger hole count first
    // within each course (the "real" round comes before the 9-hole row).
    const sorted = [...groups.values()].sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      return byName !== 0 ? byName : b.holeCount - a.holeCount;
    });
    const rows = sorted.map(({ name, holeCount, rounds: courseRounds }) => {
      // Tee mix at this (course, hole-count) bucket.
      const teeCounts = new Map();
      courseRounds.forEach((r) => {
        const tee = r.tee || "—";
        teeCounts.set(tee, (teeCounts.get(tee) || 0) + 1);
      });
      const teeSummary = [...teeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([tee, count]) => courseRounds.length === count ? tee : `${tee} (${count})`)
        .join(" · ");
      const totals = courseRounds.map(roundTotals);
      const best = Math.min(...totals.map((item) => item.gross));
      const holeBadge = `<span class="course-stat-holes-badge">${holeCount} holes</span>`;
      return `
        <div class="course-stat-row">
          <div>
            <strong>${escapeHtml(name)} ${holeBadge}</strong>
            <span class="subtext">${escapeHtml(teeSummary)}</span>
          </div>
          <div class="course-stat-metrics">
            <span><b>${courseRounds.length}</b> rounds</span>
            <span><b>${average(totals.map((item) => item.gross)).toFixed(1)}</b> avg</span>
            <span><b>${formatSigned(average(totals.map((item) => item.toPar)))}</b> to par</span>
            <span><b>${best}</b> best</span>
          </div>
        </div>`;
    }).join("");

    els.courseStats.innerHTML = rows
      ? `<div class="course-stat-list">${rows}</div>`
      : emptyState("Save a round to see scoring broken down by course.", { action: "rounds" });
  }

  // For Deerwood, the same physical hole (e.g. Buck 1) shows up under
  // different routing numbers — it's #1 if Buck is the front nine, #10 if
  // Buck is the back nine, and #1 again in a Buck-only 9-hole round. The
  // hole label ("Buck 1") IS the physical identity, so use it for display
  // and aggregation so triples / bests / by-course rollups don't fragment
  // the same hole into 2-3 phantom holes.
  function holeDisplayId(courseId, holeLabel, holeNumber) {
    if (isDeerwoodCourseId(courseId) && holeLabel) return holeLabel;
    return `#${holeNumber}`;
  }

  // Compute every interesting per-hole metric for one par tier (3 / 4 / 5).
  // Returns null if there are no scored holes of that par. The richness lives
  // here so both the inline card and the drill-down sheet can pull from one
  // source of truth and stay consistent.
  function computeParTypeStats(rounds, par) {
    const items = [];
    rounds.forEach((round) => {
      if (!Array.isArray(round.holes)) return;
      // physicalCourseName collapses all Deerwood routings (and the various
      // courseId-per-tee variants in the catalog) under one display name,
      // so the by-course rollup doesn't shard the same physical course
      // into Buck/Doe vs Buck/Fawn vs 9-hole Buck buckets.
      const courseName = physicalCourseName(round.courseId);
      round.holes.forEach((hole) => {
        if (hole.par !== par) return;
        if (!Number.isFinite(hole.score) || hole.score <= 0) return;
        items.push({
          score: hole.score,
          par: hole.par,
          toPar: hole.score - hole.par,
          putts: Number.isFinite(hole.putts) ? hole.putts : null,
          gir: !!hole.gir,
          fairway: hole.fairway || "na",
          penalties: Number(hole.penalties) || 0,
          bunker: hole.bunker || "",
          clubsHit: Array.isArray(hole.clubsHit) ? hole.clubsHit : [],
          teeClub: Array.isArray(hole.clubsHit) && hole.clubsHit.length ? hole.clubsHit[0] : null,
          sg: holeStrokesGained(hole),
          holeNumber: hole.number,
          holeLabel: hole.label || "",
          // Pre-computed display + grouping keys so renderers stay simple.
          // physicalHoleId() (from golf-math) already handles the Deerwood
          // nine-aware identity, so we lean on it instead of re-deriving.
          holeDisplayId: holeDisplayId(round.courseId, hole.label, hole.number),
          holePhysicalKey: physicalHoleId(round.courseId, hole),
          courseId: round.courseId,
          courseName,
          courseKey: courseName, // physical-course rollup key
          date: round.date,
          roundId: round.id
        });
      });
    });
    if (!items.length) return null;

    const count = items.length;
    const avgScore = average(items.map((h) => h.score));
    const avgToPar = average(items.map((h) => h.toPar));

    // Scoring distribution buckets. Eagle-or-better lumps albatrosses in
    // with eagles (par 3s can't have eagles, but the code stays uniform).
    let eagleOrBetter = 0, birdies = 0, parsCount = 0, bogeys = 0, doubles = 0, worse = 0;
    items.forEach((h) => {
      if (h.toPar <= -2) eagleOrBetter += 1;
      else if (h.toPar === -1) birdies += 1;
      else if (h.toPar === 0) parsCount += 1;
      else if (h.toPar === 1) bogeys += 1;
      else if (h.toPar === 2) doubles += 1;
      else worse += 1;
    });
    const parsOrBetter = eagleOrBetter + birdies + parsCount;

    const girCount = items.filter((h) => h.gir).length;
    // FIR only meaningful for par 4 / 5. Par 3s have no fairway (na).
    const firEligible = items.filter((h) => h.fairway && h.fairway !== "na");
    const firHit = firEligible.filter((h) => h.fairway === "hit").length;

    const puttHoles = items.filter((h) => h.putts !== null && h.putts > 0);
    const avgPutts = puttHoles.length ? average(puttHoles.map((h) => h.putts)) : NaN;

    const totalPenalties = items.reduce((s, h) => s + h.penalties, 0);
    const holesWithPen = items.filter((h) => h.penalties > 0).length;

    const sgValues = items.map((h) => h.sg).filter((v) => v !== null);
    const avgSg = sgValues.length ? average(sgValues) : NaN;

    const bunkerHoles = items.filter((h) => h.bunker && h.bunker !== "" && h.bunker !== "none").length;
    const greensideBunker = items.filter((h) => h.bunker === "greenside" || h.bunker === "both").length;
    const sandSaves = items.filter((h) => (h.bunker === "greenside" || h.bunker === "both") && !h.gir && h.toPar <= 0).length;
    const sandSaveAttempts = items.filter((h) => (h.bunker === "greenside" || h.bunker === "both") && !h.gir).length;

    // Scrambling for THIS par type: missed GIR holes saved to par-or-better.
    const missedGir = items.filter((h) => !h.gir).length;
    const scrambleSaves = items.filter((h) => !h.gir && h.toPar <= 0).length;

    const bestToPar = Math.min(...items.map((h) => h.toPar));
    const worstToPar = Math.max(...items.map((h) => h.toPar));
    const bestHole = items.find((h) => h.toPar === bestToPar);
    const worstHole = items.find((h) => h.toPar === worstToPar);

    return {
      par, count, items, avgScore, avgToPar,
      eagleOrBetter, birdies, pars: parsCount, bogeys, doubles, worse,
      parsOrBetter, parsOrBetterPct: parsOrBetter / count,
      birdieOrBetterPct: (eagleOrBetter + birdies) / count,
      doubleOrWorsePct: (doubles + worse) / count,
      girCount, girPct: girCount / count,
      firEligibleCount: firEligible.length,
      firHit, firPct: firEligible.length ? firHit / firEligible.length : NaN,
      puttHolesCount: puttHoles.length, avgPutts,
      totalPenalties, holesWithPen,
      penPerHole: totalPenalties / count,
      avgSg,
      bestToPar, worstToPar, bestHole, worstHole,
      bunkerHoles, bunkerPct: bunkerHoles / count,
      greensideBunker, sandSaves, sandSaveAttempts,
      sandSavePct: sandSaveAttempts ? sandSaves / sandSaveAttempts : NaN,
      missedGir, scrambleSaves,
      scramblingPct: missedGir ? scrambleSaves / missedGir : NaN
    };
  }

  // Tier the avg-to-par into one of the scoring-* color buckets so the
  // headline number on a par-type card gets a meaningful background. These
  // breakpoints are absolute (not relative to baseline like the heatmap)
  // because at the par-tier level we want "how close to par" semantics.
  function parTypeTier(avgToPar) {
    if (!Number.isFinite(avgToPar)) return "tier-empty";
    if (avgToPar <= -0.5) return "scoring-birdie";
    if (avgToPar < 0.25) return "scoring-par";
    if (avgToPar < 0.75) return "scoring-bogey";
    return "scoring-double";
  }

  // Per-par-tier card layout. Tappable to open a drill-down sheet with even
  // more breakdowns. See computeParTypeStats() for what's available.
  function renderParTypeCard(stats) {
    if (!stats) return "";
    const { par, count } = stats;
    const total = count;
    // Scoring distribution mini-bar — stacked segments for birdie/par/bogey/dbl+
    const bbCount = stats.eagleOrBetter + stats.birdies;
    const parCount = stats.pars;
    const bogeyCount = stats.bogeys;
    const dblPlusCount = stats.doubles + stats.worse;
    const pct = (n) => total ? (n / total) * 100 : 0;
    const segs = [];
    if (bbCount) segs.push({ cls: "scoring-birdie", w: pct(bbCount), n: bbCount, label: "Birdie+" });
    if (parCount) segs.push({ cls: "scoring-par", w: pct(parCount), n: parCount, label: "Par" });
    if (bogeyCount) segs.push({ cls: "scoring-bogey", w: pct(bogeyCount), n: bogeyCount, label: "Bogey" });
    if (dblPlusCount) segs.push({ cls: "scoring-double", w: pct(dblPlusCount), n: dblPlusCount, label: "Dbl+" });
    const distBar = segs.map((s) => `<span class="par-card-dist-seg ${s.cls}" style="width:${s.w}%" title="${s.label}: ${s.n}"></span>`).join("");
    const distLegend = segs.map((s) => `<span class="par-card-dist-key ${s.cls}">${s.label} ${s.n}</span>`).join("");

    // FIR only matters for par 4 / 5.
    const firCell = par === 3
      ? `<div class="par-card-stat"><small>FIR</small><strong>—</strong></div>`
      : `<div class="par-card-stat"><small>FIR</small><strong>${Number.isFinite(stats.firPct) ? Math.round(stats.firPct * 100) + "%" : "—"}</strong></div>`;

    const sgText = Number.isFinite(stats.avgSg) ? formatSigned(stats.avgSg, 2) : "—";
    const tier = parTypeTier(stats.avgToPar);

    const bestLine = stats.bestHole
      ? `Best ${formatSigned(stats.bestToPar)} · ${escapeHtml(stats.bestHole.courseName)} ${escapeHtml(stats.bestHole.holeDisplayId)}`
      : "";

    return `
      <button type="button" class="par-card" data-par-detail="${par}" aria-label="Par ${par} detail">
        <div class="par-card-head">
          <div class="par-card-head-main">
            <strong>Par ${par}</strong>
            <span class="par-card-count">${count} hole${count === 1 ? "" : "s"}</span>
          </div>
          <span class="par-card-chevron" aria-hidden="true">›</span>
        </div>
        <div class="par-card-headline">
          <span class="par-card-headline-main ${tier}">${formatSigned(stats.avgToPar)}</span>
          <span class="par-card-headline-sub">${stats.avgScore.toFixed(2)} avg</span>
          <span class="par-card-headline-sg" title="Strokes gained per hole">SG ${sgText}</span>
        </div>
        <div class="par-card-dist" role="img" aria-label="Scoring distribution">${distBar}</div>
        <div class="par-card-dist-legend">${distLegend}</div>
        <div class="par-card-stats">
          <div class="par-card-stat"><small>GIR</small><strong>${Math.round(stats.girPct * 100)}%</strong></div>
          ${firCell}
          <div class="par-card-stat"><small>Putts</small><strong>${Number.isFinite(stats.avgPutts) ? stats.avgPutts.toFixed(2) : "—"}</strong></div>
          <div class="par-card-stat"><small>Pen/hole</small><strong>${stats.penPerHole.toFixed(2)}</strong></div>
        </div>
        ${bestLine ? `<div class="par-card-foot">${bestLine}</div>` : ""}
      </button>`;
  }

  function renderParStats(rounds) {
    if (!els.parStats) return;
    const parOrder = [3, 4, 5];
    const statsByPar = parOrder.map((par) => computeParTypeStats(rounds, par));
    const hasAny = statsByPar.some((s) => s && s.count > 0);
    if (!hasAny) {
      els.parStats.innerHTML = emptyState("Save a round to see how you score on par 3s, 4s, and 5s.", { action: "rounds" });
      return;
    }
    const cards = parOrder.map((par, i) => {
      const stats = statsByPar[i];
      if (!stats) {
        return `
          <div class="par-card par-card-empty">
            <div class="par-card-head">
              <div class="par-card-head-main"><strong>Par ${par}</strong></div>
            </div>
            <p class="par-card-empty-msg">No scored par-${par} holes yet.</p>
          </div>`;
      }
      return renderParTypeCard(stats);
    }).join("");
    els.parStats.innerHTML = `<div class="par-card-grid">${cards}</div>`;
  }

  // ---- Par-type drill-down sheet -----------------------------------------
  //
  // Reuses the bottom-sheet shell (hole-picker-overlay). The body lives in
  // #parTypeSheetBody so we have a free-form container, not the rigid
  // <ul> the bucket sheet uses.

  function openParTypeDetail(par) {
    if (!els.parTypeSheetOverlay || !els.parTypeSheetBody) return;
    const rounds = getFilteredRounds();
    const stats = computeParTypeStats(rounds, par);
    if (els.parTypeSheetTitle) els.parTypeSheetTitle.textContent = `Par ${par}s detail`;
    if (!stats) {
      els.parTypeSheetBody.innerHTML = `<p class="par-detail-empty">No scored par-${par} holes in the current filter.</p>`;
      els.parTypeSheetOverlay.hidden = false;
      document.body.classList.add("hole-picker-open");
      if (els.parTypeSheetClose) els.parTypeSheetClose.focus();
      return;
    }
    els.parTypeSheetBody.innerHTML = buildParTypeDetailBody(stats);
    els.parTypeSheetOverlay.hidden = false;
    document.body.classList.add("hole-picker-open");
    if (els.parTypeSheetClose) els.parTypeSheetClose.focus();
  }

  function closeParTypeDetail() {
    if (!els.parTypeSheetOverlay) return;
    els.parTypeSheetOverlay.hidden = true;
    document.body.classList.remove("hole-picker-open");
  }

  function buildParTypeDetailBody(stats) {
    const { par, count, items } = stats;
    const sgText = Number.isFinite(stats.avgSg) ? formatSigned(stats.avgSg, 2) : "—";
    const fmtPct = (v) => Number.isFinite(v) ? `${Math.round(v * 100)}%` : "—";

    // --- Summary tiles -----------------------------------------------------
    const summary = `
      <div class="par-detail-summary">
        <div class="par-detail-tile"><small>Avg</small><strong>${stats.avgScore.toFixed(2)}</strong></div>
        <div class="par-detail-tile"><small>To par</small><strong>${formatSigned(stats.avgToPar)}</strong></div>
        <div class="par-detail-tile"><small>SG/hole</small><strong>${sgText}</strong></div>
        <div class="par-detail-tile"><small>Best</small><strong>${formatSigned(stats.bestToPar)}</strong></div>
        <div class="par-detail-tile"><small>Worst</small><strong>+${stats.worstToPar}</strong></div>
      </div>`;

    // --- Distribution table (each bucket expands to show the actual holes) -
    // The predicate filters stats.items down to the matching holes for the
    // bucket. Each row is a <details>/<summary> so the toggle behavior is
    // native — no JS state to manage — and a11y-friendly out of the box.
    const distBuckets = [
      { cls: "scoring-birdie", label: "Birdie or better", count: stats.eagleOrBetter + stats.birdies,
        pred: (h) => h.toPar <= -1 },
      { cls: "scoring-par", label: "Par", count: stats.pars,
        pred: (h) => h.toPar === 0 },
      { cls: "scoring-bogey", label: "Bogey", count: stats.bogeys,
        pred: (h) => h.toPar === 1 },
      { cls: "scoring-double", label: "Double", count: stats.doubles,
        pred: (h) => h.toPar === 2 },
      { cls: "scoring-worse", label: "Triple+", count: stats.worse,
        pred: (h) => h.toPar >= 3 }
    ].filter((b) => b.count > 0);

    function bucketRowsHtml(items, pred) {
      const matches = items.filter(pred).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      if (!matches.length) return "";
      return `<ul class="par-detail-bucket-holes">
        ${matches.map((h) => `
          <li>
            <span class="par-detail-bucket-when">${escapeHtml(h.date || "")}</span>
            <span class="par-detail-bucket-where">${escapeHtml(h.courseName)} <small>${escapeHtml(h.holeDisplayId)}</small></span>
            <strong class="par-detail-bucket-score ${parTypeTier(h.toPar)}">${h.score} <small>(${formatSigned(h.toPar)})</small></strong>
          </li>`).join("")}
      </ul>`;
    }

    const distHtml = `
      <section class="par-detail-section">
        <h4 class="par-detail-h">Scoring breakdown <span class="par-detail-h-hint">(tap a row to see the holes)</span></h4>
        <ul class="par-detail-dist-list">
          ${distBuckets.map((b) => `
            <li class="par-detail-dist-row-wrap">
              <details class="par-detail-dist-details">
                <summary class="par-detail-dist-row ${b.cls}">
                  <span class="par-detail-dist-label">${escapeHtml(b.label)}</span>
                  <span class="par-detail-dist-val"><strong>${b.count}</strong> <small>(${Math.round((b.count / count) * 100)}%)</small></span>
                  <span class="par-detail-dist-caret" aria-hidden="true">›</span>
                </summary>
                ${bucketRowsHtml(stats.items, b.pred)}
              </details>
            </li>`).join("")}
        </ul>
      </section>`;

    // --- Ball-striking + short-game --------------------------------------
    const skillsRows = [];
    skillsRows.push(`<li><span>GIR</span><strong>${fmtPct(stats.girPct)}</strong><small>${stats.girCount}/${count} holes</small></li>`);
    if (par !== 3) {
      skillsRows.push(`<li><span>Fairways hit</span><strong>${fmtPct(stats.firPct)}</strong><small>${stats.firHit}/${stats.firEligibleCount} eligible</small></li>`);
    }
    if (Number.isFinite(stats.avgPutts)) {
      skillsRows.push(`<li><span>Avg putts</span><strong>${stats.avgPutts.toFixed(2)}</strong><small>over ${stats.puttHolesCount} holes</small></li>`);
    }
    skillsRows.push(`<li><span>Scrambling</span><strong>${fmtPct(stats.scramblingPct)}</strong><small>${stats.scrambleSaves}/${stats.missedGir} missed-GIR saves</small></li>`);
    if (stats.greensideBunker > 0 && stats.sandSaveAttempts > 0) {
      skillsRows.push(`<li><span>Sand save</span><strong>${fmtPct(stats.sandSavePct)}</strong><small>${stats.sandSaves}/${stats.sandSaveAttempts}</small></li>`);
    }
    if (stats.totalPenalties > 0) {
      skillsRows.push(`<li><span>Penalties</span><strong>${stats.totalPenalties}</strong><small>on ${stats.holesWithPen} hole${stats.holesWithPen === 1 ? "" : "s"}</small></li>`);
    }
    const skillsHtml = `
      <section class="par-detail-section">
        <h4 class="par-detail-h">Ball-striking &amp; short game</h4>
        <ul class="par-detail-skill-list">${skillsRows.join("")}</ul>
      </section>`;

    // --- By course --------------------------------------------------------
    // Key on the physical course name (already normalized in computeParTypeStats)
    // so Deerwood Buck/Doe vs Buck/Fawn vs Buck-only-9 all roll up to a
    // single "Deerwood Golf Course" entry.
    const byCourse = new Map();
    items.forEach((h) => {
      if (!byCourse.has(h.courseKey)) byCourse.set(h.courseKey, { name: h.courseName, n: 0, sumToPar: 0 });
      const e = byCourse.get(h.courseKey);
      e.n += 1;
      e.sumToPar += h.toPar;
    });
    const courseRows = [...byCourse.values()]
      .map((e) => ({ ...e, avgToPar: e.sumToPar / e.n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 6);
    const courseHtml = courseRows.length > 1 ? `
      <section class="par-detail-section">
        <h4 class="par-detail-h">By course</h4>
        <ul class="par-detail-course-list">
          ${courseRows.map((c) => `
            <li>
              <button type="button" class="link-course" data-open-course-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</button>
              <span class="par-detail-course-meta">${c.n} hole${c.n === 1 ? "" : "s"}</span>
              <strong class="par-detail-course-val ${parTypeTier(c.avgToPar)}">${formatSigned(c.avgToPar)}</strong>
            </li>`).join("")}
        </ul>
      </section>` : "";

    // --- Top tee clubs ----------------------------------------------------
    const byClub = new Map();
    items.forEach((h) => {
      if (!h.teeClub) return;
      if (!byClub.has(h.teeClub)) byClub.set(h.teeClub, { club: h.teeClub, n: 0, sumToPar: 0 });
      const e = byClub.get(h.teeClub);
      e.n += 1;
      e.sumToPar += h.toPar;
    });
    const clubRows = [...byClub.values()]
      .map((e) => ({ ...e, avgToPar: e.sumToPar / e.n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 6);
    const clubHtml = clubRows.length ? `
      <section class="par-detail-section">
        <h4 class="par-detail-h">Top tee clubs</h4>
        <ul class="par-detail-club-list">
          ${clubRows.map((c) => `
            <li>
              <span class="par-detail-club-name">${escapeHtml(c.club)}</span>
              <span class="par-detail-club-meta">${c.n} tee shot${c.n === 1 ? "" : "s"}</span>
              <strong class="par-detail-club-val ${parTypeTier(c.avgToPar)}">${formatSigned(c.avgToPar)}</strong>
            </li>`).join("")}
        </ul>
      </section>` : "";

    // --- Recent 10 holes --------------------------------------------------
    const recent = [...items]
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .slice(0, 10);
    const recentHtml = recent.length ? `
      <section class="par-detail-section">
        <h4 class="par-detail-h">Recent ${recent.length} hole${recent.length === 1 ? "" : "s"}</h4>
        <ul class="par-detail-recent-list">
          ${recent.map((h) => `
            <li>
              <span class="par-detail-recent-when">${escapeHtml(h.date || "")}</span>
              <span class="par-detail-recent-where">${escapeHtml(h.courseName)} <small>${escapeHtml(h.holeDisplayId)}</small></span>
              <strong class="par-detail-recent-score ${parTypeTier(h.toPar)}">${h.score} <small>(${formatSigned(h.toPar)})</small></strong>
            </li>`).join("")}
        </ul>
      </section>` : "";

    return `
      <p class="par-detail-lead">${count} scored hole${count === 1 ? "" : "s"} across your filtered rounds.</p>
      ${summary}
      ${distHtml}
      ${skillsHtml}
      ${courseHtml}
      ${clubHtml}
      ${recentHtml}`;
  }

  // Wind is stored as the raw selector value: "", "calm", "5".."25", "30+".
  function formatWind(wind) {
    if (!wind) return "";
    if (wind === "calm") return "Calm";
    return `${wind} mph wind`;
  }

  function formatRoundTag(tag) {
    if (!tag) return "";
    return tag.charAt(0).toUpperCase() + tag.slice(1);
  }

  function renderScoreMark(score, par, emptyText = "—") {
    const variant = scoreMarkClass(score, par);
    if (!variant) return `<span class="score-mark score-mark-empty">${escapeHtml(emptyText)}</span>`;
    return `<span class="score-mark ${variant}">${score}</span>`;
  }

  function getHoleGroups(rounds) {
    const map = new Map();
    rounds.forEach((round) => {
      const deerwood = isDeerwoodCourseId(round.courseId);
      const course = getCourse(round.courseId);
      round.holes.forEach((hole) => {
        if (!Number.isFinite(hole.score) || hole.score <= 0) return;
        const key = physicalHoleId(round.courseId, hole);
        if (!map.has(key)) {
          map.set(key, {
            key,
            physicalId: key,
            courseId: round.courseId,
            courseName: deerwood ? "Deerwood Golf Course" : (course ? course.name : "Unknown"),
            tee: round.tee,
            number: hole.number,
            label: hole.label || `#${hole.number}`,
            par: hole.par,
            yards: Number(hole.yards || 0),
            repDate: round.date,
            scores: [],
            dates: []
          });
        }
        const group = map.get(key);
        // Keep the representative courseId/number pointing at the most recent
        // round so a click-through jumps somewhere the dropdown still lists.
        if (round.date >= group.repDate) {
          group.repDate = round.date;
          group.courseId = round.courseId;
          group.number = hole.number;
          group.tee = round.tee;
          if (Number(hole.yards)) group.yards = Number(hole.yards);
        }
        group.scores.push(hole.score);
        group.dates.push(round.date);
      });
    });

    return [...map.values()].map((group) => {
      const avgScore = average(group.scores);
      return {
        ...group,
        avgScore,
        avgToPar: avgScore - group.par,
        best: Math.min(...group.scores),
        worst: Math.max(...group.scores),
        rounds: group.scores.length
      };
    });
  }

  // ---- Heatmap -----------------------------------------------------------
  //
  // Replaces the static Spotlight + Best Holes + Worst Holes lists with a
  // visual scorecard: each physical hole is a color-coded cell whose color
  // encodes how the user performs there vs par on average. Green = under,
  // red = over. Future commits add tap-to-drill-down and a metric toggle.
  //
  // Heatmap "scope" = which slice of holes to show. For non-Deerwood courses,
  // scope is just the courseId (typically 18 holes). For Deerwood, scope is
  // courseId + a specific nine (Buck / Doe / Fawn), because Deerwood holes
  // are pooled by physical identity but the three nines are physically
  // distinct layouts that shouldn't be jammed onto one grid.

  const HEATMAP_SCOPE_KEY = "fairwayLedger.heatmapScope.v1";
  const HEATMAP_NINES = ["buck", "doe", "fawn"];

  // The user's last-viewed scope, restored from localStorage on init.
  // Shape: { courseId: string, nine?: "buck"|"doe"|"fawn" }.
  let heatmapScope = (() => {
    try {
      const raw = localStorage.getItem(HEATMAP_SCOPE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === "object") ? parsed : null;
    } catch { return null; }
  })();

  // Find the scope the user should land on by default — whichever physical
  // course (and for Deerwood, whichever nine) they've played the most.
  function defaultHeatmapScope(rounds) {
    if (!rounds || !rounds.length) return null;
    const counts = new Map();
    rounds.forEach((round) => {
      if (!round || !Array.isArray(round.holes)) return;
      if (isDeerwoodCourseId(round.courseId)) {
        // Bucket by nine — one round can contribute to up to 2 nines for an
        // 18-hole Deerwood routing. We count per-nine appearances.
        const ninesInRound = new Set();
        round.holes.forEach((hole) => {
          const id = physicalHoleId(round.courseId, hole);
          const m = id.match(/^deerwood:(buck|doe|fawn):/);
          if (m) ninesInRound.add(m[1]);
        });
        ninesInRound.forEach((nine) => {
          const key = `deerwood:${nine}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        });
      } else {
        const key = `course:${round.courseId}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    });
    if (!counts.size) return null;
    // Pick the most-played, with deterministic tie-break by key for stability.
    const top = [...counts.entries()].sort((a, b) =>
      b[1] - a[1] || a[0].localeCompare(b[0])
    )[0][0];
    if (top.startsWith("deerwood:")) {
      const nine = top.split(":")[1];
      // Synthesize a representative Deerwood courseId for that nine — any
      // course id whose physical-hole ids start with "deerwood:<nine>:" works.
      const repCourseId = findDeerwoodCourseIdForNine(nine, rounds) || DEERWOOD_COURSE_ID;
      return { courseId: repCourseId, nine };
    }
    return { courseId: top.split(":").slice(1).join(":") };
  }

  // Find a Deerwood course id whose holes are tagged with the requested nine.
  // For an 18-hole Deerwood routing the same round produces hole labels like
  // "Buck 1...Buck 9, Doe 1...Doe 9", and either parent courseId is fine for
  // display purposes; we just want one that actually exists in state.courses.
  function findDeerwoodCourseIdForNine(nine, rounds) {
    for (const round of rounds) {
      if (!isDeerwoodCourseId(round.courseId)) continue;
      const matches = round.holes.some((hole) => {
        const id = physicalHoleId(round.courseId, hole);
        return id === `deerwood:${nine}:1` || id.startsWith(`deerwood:${nine}:`);
      });
      if (matches) return round.courseId;
    }
    return null;
  }

  // Build the per-cell data for a given scope. Pools across every routing
  // that touched the relevant physical holes — for Deerwood that means
  // 9-hole rounds and 18-hole rounds both contribute to each Buck/Doe/Fawn
  // hole's history.
  function getHeatmapData(scope, rounds) {
    if (!scope) return { cells: [], roundsCount: 0 };
    const groups = getHoleGroups(rounds);
    const deerwood = isDeerwoodCourseId(scope.courseId);

    let cells;
    if (deerwood && scope.nine) {
      // Filter to physical holes on the requested nine, then sort 1..9.
      cells = groups
        .filter((g) => g.physicalId.startsWith(`deerwood:${scope.nine}:`))
        .sort((a, b) => {
          const an = Number(a.physicalId.split(":")[2]);
          const bn = Number(b.physicalId.split(":")[2]);
          return an - bn;
        });
    } else {
      // Non-Deerwood: filter to physical holes belonging to this course,
      // ordered by hole number. Use the rep number from getHoleGroups.
      cells = groups
        .filter((g) => g.physicalId.startsWith(`course:${scope.courseId}:`))
        .sort((a, b) => a.number - b.number);
    }
    return { cells, roundsCount: cells.reduce((s, g) => s + g.rounds, 0) };
  }

  // Round-level summary across the scope — average gross score for that
  // nine (or full course), avg vs par, best, rounds count. Only counts
  // rounds where the full slice was played (e.g. for Deerwood:Buck only
  // rounds with all 9 Buck holes scored), otherwise the average would
  // mix partial and full nines and become misleading.
  function getHeatmapSummary(scope, rounds) {
    if (!scope) return null;
    const deerwood = isDeerwoodCourseId(scope.courseId);
    const matchesScope = (round, hole) => {
      const id = physicalHoleId(round.courseId, hole);
      if (deerwood && scope.nine) return id.startsWith(`deerwood:${scope.nine}:`);
      return id.startsWith(`course:${scope.courseId}:`);
    };
    // Expected hole-slice size to qualify as a "complete" round for the scope.
    // Non-Deerwood: take whatever the course's hole count is from any round.
    // Deerwood:nine: 9.
    const expectedSize = deerwood && scope.nine ? 9 : null;

    const entries = [];
    rounds.forEach((round) => {
      if (!Array.isArray(round.holes)) return;
      const inScope = round.holes.filter((h) =>
        matchesScope(round, h) && Number.isFinite(h.score) && h.score > 0
      );
      if (!inScope.length) return;
      // For Deerwood nines: only count full-nine rounds so the gross average
      // is apples-to-apples. For non-Deerwood: assume the whole round was at
      // that course (which is always true today).
      if (expectedSize !== null && inScope.length !== expectedSize) return;
      const gross = inScope.reduce((s, h) => s + h.score, 0);
      const par = inScope.reduce((s, h) => s + h.par, 0);
      entries.push({ date: round.date, gross, par });
    });
    if (!entries.length) return null;
    const avgGross = average(entries.map((e) => e.gross));
    const avgPar = average(entries.map((e) => e.par));
    const best = entries.reduce((b, e) => (e.gross < b.gross ? e : b), entries[0]);
    return {
      avgGross,
      avgPar,
      avgVsPar: avgGross - avgPar,
      rounds: entries.length,
      best: best.gross,
      bestDate: best.date,
    };
  }

  function heatmapVsParClass(v) {
    if (!Number.isFinite(v)) return "even";
    if (v <= -0.5) return "under";
    if (v < 0.5) return "even";
    if (v < 4) return "over";
    return "way-over";
  }

  function scopeLabel(scope) {
    if (!scope) return "";
    if (isDeerwoodCourseId(scope.courseId) && scope.nine) {
      return `${scope.nine.charAt(0).toUpperCase() + scope.nine.slice(1)} Nine`;
    }
    const course = getCourse(scope.courseId);
    return course ? course.name : scope.courseId;
  }

  // Map a hole's avg-vs-par to a CSS tier class, RELATIVE to the user's
  // own baseline for the current scope. Amateurs rarely average under par
  // on any hole, so coloring by absolute vs-par leaves the heatmap looking
  // all-red — useless. Coloring by (this hole's avg-vs-par) minus (your
  // average vs-par across all holes in this scope) puts the meaning back:
  // your easiest holes go green, your toughest red, regardless of where
  // your absolute average sits.
  //
  // The displayed delta number on each cell still shows vs-par (so the
  // absolute info is preserved); only the color encoding is relative.
  function heatmapTier(avgToPar, baselineVsPar) {
    if (!Number.isFinite(avgToPar)) return "tier-empty";
    // No baseline available (e.g. only one hole has data): fall back to a
    // neutral color rather than guessing.
    if (!Number.isFinite(baselineVsPar)) return "tier-par";
    // delta < 0 means this hole plays easier than your average for this view.
    const delta = avgToPar - baselineVsPar;
    if (delta <= -0.7) return "tier-eagle";
    if (delta <= -0.35) return "tier-birdie";
    if (delta < -0.1) return "tier-under";
    if (delta < 0.1) return "tier-par";
    if (delta < 0.4) return "tier-bogey";
    if (delta < 0.8) return "tier-double";
    return "tier-triple";
  }

  function formatDelta(v) {
    if (!Number.isFinite(v)) return "—";
    if (Math.abs(v) < 0.05) return "E";
    const sign = v > 0 ? "+" : "";
    return `${sign}${v.toFixed(1)}`;
  }

  function renderHeatmap(rounds) {
    if (!els.heatmapGrid) return;

    // Validate the saved scope against the current rounds — if the user
    // cleared data or imported a different set, fall back to the default.
    let scope = heatmapScope;
    const tentative = scope ? getHeatmapData(scope, rounds) : null;
    if (!tentative || !tentative.cells.length) {
      scope = defaultHeatmapScope(rounds);
      heatmapScope = scope;
      persistHeatmapScope();
    }

    renderHeatmapCourseChips(rounds, scope);
    renderHeatmapNineChips(scope);

    if (!scope) {
      els.heatmapGrid.innerHTML = emptyState("Save a round to see a color-coded view of every hole you've played.", { action: "rounds" });
      if (els.heatmapSummary) els.heatmapSummary.innerHTML = "";
      if (els.heatmapLegend) els.heatmapLegend.innerHTML = "";
      if (els.heatmapNote) els.heatmapNote.textContent = "average vs par per hole";
      return;
    }

    const { cells } = getHeatmapData(scope, rounds);
    if (!cells.length) {
      els.heatmapGrid.innerHTML = emptyState("No rounds at this course yet — switch courses above or save a round.", { action: "rounds" });
      if (els.heatmapSummary) els.heatmapSummary.innerHTML = "";
      if (els.heatmapLegend) els.heatmapLegend.innerHTML = "";
      return;
    }

    renderHeatmapSummary(scope, rounds);

    // Compute the user's own per-hole baseline across this scope. The cell
    // colors are RELATIVE to this baseline — your easiest holes pop green
    // and your hardest go red regardless of where your absolute average is.
    // Cells with no rounds are skipped so they don't drag the baseline.
    const baselineVsPar = average(
      cells
        .filter((c) => Number.isFinite(c.avgToPar) && c.rounds > 0)
        .map((c) => c.avgToPar)
    );

    els.heatmapGrid.innerHTML = cells.map((cell) => {
      const tier = heatmapTier(cell.avgToPar, baselineVsPar);
      const delta = formatDelta(cell.avgToPar);
      const labelText = (() => {
        if (isDeerwoodCourseId(scope.courseId) && scope.nine) {
          const n = cell.physicalId.split(":")[2];
          return `${scope.nine.charAt(0).toUpperCase() + scope.nine.slice(1)} ${n}`;
        }
        return cell.label || `#${cell.number}`;
      })();
      return `
        <button type="button"
                class="heatmap-cell ${tier}"
                data-physical-id="${escapeHtml(cell.physicalId)}"
                aria-label="${escapeHtml(labelText)}, par ${cell.par}, average ${cell.avgScore.toFixed(2)}, ${cell.rounds} round${cell.rounds === 1 ? "" : "s"}">
          <span class="heatmap-cell-num">${escapeHtml(labelText)}</span>
          <span class="heatmap-cell-delta">${delta}</span>
          <span class="heatmap-cell-par">par ${cell.par}</span>
          <span class="heatmap-cell-rounds">${cell.rounds} rd${cell.rounds === 1 ? "" : "s"}</span>
        </button>
      `;
    }).join("");

    // Legend (small, one row). Communicates the color scale without taking
    // a whole row per tier.
    if (els.heatmapLegend) {
      els.heatmapLegend.innerHTML = `
        <span class="heatmap-legend-item"><span class="heatmap-legend-swatch" style="background:#1f7a59"></span>Your strongest</span>
        <span class="heatmap-legend-item"><span class="heatmap-legend-swatch" style="background:#f1f2ec"></span>Around your avg</span>
        <span class="heatmap-legend-item"><span class="heatmap-legend-swatch" style="background:#f1d39b"></span>Tougher than usual</span>
        <span class="heatmap-legend-item"><span class="heatmap-legend-swatch" style="background:#d97a6a"></span>Your toughest</span>
      `;
    }

    if (els.heatmapNote) {
      const total = cells.reduce((s, c) => s + c.rounds, 0);
      els.heatmapNote.textContent = `${cells.length} hole${cells.length === 1 ? "" : "s"} | ${total} round${total === 1 ? "" : "s"} pooled`;
    }
  }

  function renderHeatmapCourseChips(rounds, scope) {
    if (!els.heatmapCourseChips) return;
    // One chip per *physical* course the user has played. Deerwood collapses
    // to a single "Deerwood" chip; non-Deerwood tee variants collapse to one
    // chip per course name (so Diamond Hawk Black/Gold/Green/etc. show as a
    // single "Diamond Hawk Golf Course" chip).
    const seen = new Set();
    const chips = [];
    rounds.forEach((round) => {
      if (isDeerwoodCourseId(round.courseId)) {
        if (seen.has("deerwood")) return;
        seen.add("deerwood");
        chips.push({ key: "deerwood", label: "Deerwood", representativeId: round.courseId });
      } else {
        const course = getCourse(round.courseId);
        const physicalName = course ? course.name : round.courseId;
        if (seen.has(physicalName)) return;
        seen.add(physicalName);
        chips.push({ key: physicalName, label: physicalName, representativeId: round.courseId });
      }
    });

    if (!chips.length) {
      els.heatmapCourseChips.innerHTML = "";
      return;
    }

    const activeKey = scope
      ? (isDeerwoodCourseId(scope.courseId) ? "deerwood" : scope.courseId)
      : null;

    els.heatmapCourseChips.innerHTML = chips.map((chip) => `
      <button type="button"
              class="heatmap-chip${chip.key === activeKey ? " active" : ""}"
              data-course-key="${escapeHtml(chip.key)}"
              data-rep-id="${escapeHtml(chip.representativeId)}">
        ${escapeHtml(chip.label)}
      </button>
    `).join("");
  }

  function renderHeatmapNineChips(scope) {
    if (!els.heatmapNineChips) return;
    const isDeerwood = !!(scope && isDeerwoodCourseId(scope.courseId));
    els.heatmapNineChips.hidden = !isDeerwood;
    if (!isDeerwood) {
      els.heatmapNineChips.innerHTML = "";
      return;
    }
    els.heatmapNineChips.innerHTML = HEATMAP_NINES.map((nine) => `
      <button type="button"
              class="heatmap-chip${scope.nine === nine ? " active" : ""}"
              data-nine="${nine}">
        ${nine.charAt(0).toUpperCase() + nine.slice(1)}
      </button>
    `).join("");
  }

  // The summary band above the grid — headline numbers for the active scope.
  // Always renders something when we have at least one qualifying round;
  // hides itself silently when there's nothing to summarize.
  function renderHeatmapSummary(scope, rounds) {
    if (!els.heatmapSummary) return;
    const summary = getHeatmapSummary(scope, rounds);
    if (!summary) {
      els.heatmapSummary.innerHTML = "";
      return;
    }
    const vsParClass = heatmapVsParClass(summary.avgVsPar);
    const vsParText = formatDelta(summary.avgVsPar);
    const label = scopeLabel(scope);
    // par tends to be a constant for a given nine (36 for Buck, 72 for an
    // 18-hole non-Deerwood course). Round to int for display since fractional
    // par would only happen if the user changed course par mid-history.
    const parDisplay = Math.round(summary.avgPar);
    els.heatmapSummary.innerHTML = `
      <div class="heatmap-summary-label">${escapeHtml(label)}</div>
      <div class="heatmap-summary-main">
        <span class="heatmap-summary-gross">${summary.avgGross.toFixed(1)}<span class="heatmap-summary-gross-unit">avg</span></span>
        <span class="heatmap-summary-vspar ${vsParClass}">${vsParText} vs par</span>
      </div>
      <div class="heatmap-summary-meta">
        <span>Par <strong>${parDisplay}</strong></span>
        <span><strong>${summary.rounds}</strong> round${summary.rounds === 1 ? "" : "s"}</span>
        <span>Best <strong>${summary.best}</strong>${summary.bestDate ? ` (${escapeHtml(summary.bestDate)})` : ""}</span>
      </div>
    `;
  }

  function persistHeatmapScope() {
    try {
      if (heatmapScope) localStorage.setItem(HEATMAP_SCOPE_KEY, JSON.stringify(heatmapScope));
      else localStorage.removeItem(HEATMAP_SCOPE_KEY);
    } catch {}
  }

  function setHeatmapCourse(courseKey, representativeId, rounds) {
    if (courseKey === "deerwood") {
      // Preserve the user's nine selection if they had one; otherwise pick the
      // most-played nine.
      let nine = heatmapScope && isDeerwoodCourseId(heatmapScope.courseId)
        ? heatmapScope.nine
        : null;
      if (!nine) {
        const dflt = defaultHeatmapScope(rounds);
        if (dflt && isDeerwoodCourseId(dflt.courseId)) nine = dflt.nine;
      }
      if (!nine) nine = "buck";
      heatmapScope = { courseId: representativeId, nine };
    } else {
      // Non-Deerwood courseKey is now the physical course name. Use the
      // representative courseId (any catalog entry for that physical course
      // works for heatmap aggregation since getHoleGroups pools by physical
      // hole identity, not by tee).
      heatmapScope = { courseId: representativeId };
    }
    persistHeatmapScope();
    renderHeatmap(rounds);
  }

  function setHeatmapNine(nine, rounds) {
    if (!heatmapScope || !isDeerwoodCourseId(heatmapScope.courseId)) return;
    heatmapScope = { ...heatmapScope, nine };
    persistHeatmapScope();
    renderHeatmap(rounds);
  }

  // ---- Drill-down sheet --------------------------------------------------
  //
  // When the user taps a heatmap cell, a bottom sheet slides up showing the
  // full history for that one physical hole: summary numbers, scoring
  // distribution, per-round history, and any per-hole notes ever written.
  // Replaces the Spotlight panel's job — without dropdowns, without forms,
  // and accessible from anywhere the same physical hole is referenced.

  // Tracks which physical hole the sheet is currently showing, so a re-render
  // (e.g. after a round was just saved) can rebuild the sheet in place.
  let activeDrilldownPhysicalId = null;

  // Classify score - par into a tier label used by the distribution chips
  // and the score-num color swatch in the rounds list.
  function scoreTier(score, par) {
    if (!Number.isFinite(score) || !Number.isFinite(par)) return null;
    const d = score - par;
    if (d <= -2) return "eagle";
    if (d === -1) return "birdie";
    if (d === 0) return "par";
    if (d === 1) return "bogey";
    if (d === 2) return "double";
    return "triple";
  }

  // Per-hole tee-club scoring breakdown. For each unique tee club tagged on
  // this physical hole, compute how many rounds it was used and what the
  // average score was. The "first club tapped" convention from the Add Round
  // flow means hole.clubsHit[0] is the tee shot — no separate field needed.
  // Sorted most-used first so the column the user gravitates to leads.
  function getHoleTeeClubBreakdown(physicalId, rounds) {
    if (!physicalId) return [];
    const grouped = new Map();
    rounds.forEach((round) => {
      if (!Array.isArray(round.holes)) return;
      round.holes.forEach((hole) => {
        if (physicalHoleId(round.courseId, hole) !== physicalId) return;
        if (!Number.isFinite(hole.score) || hole.score <= 0) return;
        const teeClub = Array.isArray(hole.clubsHit) && hole.clubsHit.length
          ? hole.clubsHit[0]
          : null;
        if (!teeClub) return;
        if (!grouped.has(teeClub)) grouped.set(teeClub, { club: teeClub, scores: [], pars: [] });
        const entry = grouped.get(teeClub);
        entry.scores.push(hole.score);
        entry.pars.push(hole.par);
      });
    });
    const rows = [...grouped.values()].map((entry) => {
      const avgScore = average(entry.scores);
      const avgPar = average(entry.pars);
      return {
        club: entry.club,
        count: entry.scores.length,
        avgScore,
        avgVsPar: avgScore - avgPar,
        best: Math.min(...entry.scores),
      };
    });
    // Sort by usage descending; tie-break by lower avg vs par so the more
    // useful club leads when counts are equal.
    rows.sort((a, b) => b.count - a.count || a.avgVsPar - b.avgVsPar);
    return rows;
  }

  // Pure-ish: walk every round once and pull everything that touches this
  // physical hole. Returns null if the hole has no history at all.
  function getHoleDetailData(physicalId, rounds) {
    if (!physicalId) return null;
    const entries = [];
    let par = null, label = null, yards = null, hcp = null;
    rounds.forEach((round) => {
      if (!Array.isArray(round.holes)) return;
      round.holes.forEach((hole) => {
        if (physicalHoleId(round.courseId, hole) !== physicalId) return;
        if (!Number.isFinite(hole.score) || hole.score <= 0) return;
        entries.push({
          date: round.date,
          score: hole.score,
          par: hole.par,
          putts: Number.isFinite(hole.putts) ? hole.putts : null,
          gir: !!hole.gir,
          fairway: hole.fairway || "",
          penalties: Number.isFinite(hole.penalties) ? hole.penalties : 0,
          note: hole.note ? String(hole.note).trim() : "",
          courseId: round.courseId,
        });
        // Track the most recent par/label/yards as the canonical display
        // (par is a physical-hole property and shouldn't change, but yards
        // legitimately vary by tee).
        if (!label || round.date >= entries[entries.length - 1].date) {
          par = hole.par;
          label = hole.label || `#${hole.number}`;
          if (Number.isFinite(hole.yards) && hole.yards > 0) yards = hole.yards;
          if (Number.isFinite(hole.hcp) && hole.hcp > 0) hcp = hole.hcp;
        }
      });
    });
    if (!entries.length) return null;
    // Sort newest-first for the rounds list.
    entries.sort((a, b) => b.date.localeCompare(a.date));

    const scores = entries.map((e) => e.score);
    const putts = entries.map((e) => e.putts).filter((p) => Number.isFinite(p));
    const buckets = { eagle: 0, birdie: 0, par: 0, bogey: 0, double: 0, triple: 0 };
    entries.forEach((e) => {
      const t = scoreTier(e.score, e.par);
      if (t && buckets[t] !== undefined) buckets[t]++;
    });
    const girCount = entries.filter((e) => e.gir).length;
    const notes = entries.filter((e) => e.note).map((e) => ({ date: e.date, note: e.note }));

    return {
      physicalId,
      label,
      par,
      yards,
      hcp,
      count: entries.length,
      avgScore: average(scores),
      avgVsPar: average(scores) - par,
      best: Math.min(...scores),
      worst: Math.max(...scores),
      avgPutts: putts.length ? average(putts) : NaN,
      girCount,
      girPct: entries.length ? girCount / entries.length : 0,
      buckets,
      notes,
      entries,
    };
  }

  function openHeatmapDrilldown(physicalId) {
    if (!els.heatmapDrilldownOverlay) return;
    activeDrilldownPhysicalId = physicalId;
    renderHeatmapDrilldown();
    els.heatmapDrilldownOverlay.hidden = false;
    document.body.classList.add("hole-picker-open");
  }

  function closeHeatmapDrilldown() {
    if (!els.heatmapDrilldownOverlay) return;
    els.heatmapDrilldownOverlay.hidden = true;
    activeDrilldownPhysicalId = null;
    document.body.classList.remove("hole-picker-open");
  }

  function renderHeatmapDrilldown() {
    if (!els.heatmapDrilldownBody || !activeDrilldownPhysicalId) return;
    const rounds = getFilteredRounds();
    const data = getHoleDetailData(activeDrilldownPhysicalId, rounds);
    if (!data) {
      els.heatmapDrilldownBody.innerHTML = `<div class="hd-empty">No history for this hole yet.</div>`;
      if (els.heatmapDrilldownTitle) els.heatmapDrilldownTitle.textContent = "Hole detail";
      return;
    }

    if (els.heatmapDrilldownTitle) els.heatmapDrilldownTitle.textContent = data.label;

    const vsClass = heatmapVsParClass(data.avgVsPar);
    const distOrder = ["eagle", "birdie", "par", "bogey", "double", "triple"];
    const distLabel = { eagle: "Eagle+", birdie: "Birdie", par: "Par", bogey: "Bogey", double: "Double", triple: "Triple+" };

    const distChips = distOrder.map((tier) => {
      const count = data.buckets[tier] || 0;
      const cls = count === 0 ? "zero" : tier;
      return `<span class="hd-dist-chip ${cls}"><span class="hd-dist-count">${count}</span><span class="hd-dist-label">${distLabel[tier]}</span></span>`;
    }).join("");

    // Tee club breakdown. Only flag a "best avg" when there's an actual
    // comparison — at least two clubs with 2+ rounds each. Otherwise a single
    // dominant club would get flagged as "best" against alternatives we don't
    // have enough data on, which would mislead more than help.
    const teeClubRows = getHoleTeeClubBreakdown(activeDrilldownPhysicalId, rounds);
    const eligibleForBest = teeClubRows.filter((r) => r.count >= 2);
    const bestClub = eligibleForBest.length >= 2
      ? eligibleForBest.reduce((best, r) => (r.avgVsPar < best.avgVsPar ? r : best))
      : null;
    const teeClubHtml = teeClubRows.length
      ? `
        <h4 class="hd-section-title">Tee club on this hole</h4>
        <ul class="hd-tc-list">
          ${teeClubRows.map((r) => {
            const tier = heatmapTier(r.avgVsPar);
            const isBest = bestClub && r.club === bestClub.club && teeClubRows.length > 1;
            return `
              <li class="hd-tc-row${isBest ? " is-best" : ""}">
                <span class="hd-tc-club">${escapeHtml(r.club)}${isBest ? `<span class="hd-tc-best-flag">best avg</span>` : ""}</span>
                <span class="hd-tc-count">${r.count} rd${r.count === 1 ? "" : "s"}</span>
                <span class="hd-tc-avg ${tier}">${r.avgScore.toFixed(1)}<small>${formatDelta(r.avgVsPar)}</small></span>
              </li>
            `;
          }).join("")}
        </ul>
      `
      : "";

    const roundsList = data.entries.slice(0, 12).map((e) => {
      const tier = scoreTier(e.score, e.par) || "par";
      const metaParts = [];
      if (Number.isFinite(e.putts)) metaParts.push(`${e.putts} putt${e.putts === 1 ? "" : "s"}`);
      if (e.gir) metaParts.push("GIR");
      if (e.fairway === "hit") metaParts.push("FW");
      else if (e.fairway === "left") metaParts.push("L");
      else if (e.fairway === "right") metaParts.push("R");
      if (e.penalties > 0) metaParts.push(`${e.penalties} pen`);
      return `
        <li class="hd-round-row">
          <span class="hd-round-date">${escapeHtml(e.date)}</span>
          <span class="hd-round-score">
            <span class="hd-round-score-num ${tier}">${e.score}</span>
            <span class="hd-round-meta">${metaParts.map((p) => `<span>${escapeHtml(p)}</span>`).join("")}</span>
          </span>
        </li>
      `;
    }).join("");

    const notesList = data.notes.length
      ? data.notes.slice(0, 8).map((n) => `
          <li class="hd-note-row">
            <div class="hd-note-date">${escapeHtml(n.date)}</div>
            <div class="hd-note-text">${escapeHtml(n.note)}</div>
          </li>
        `).join("")
      : `<li class="hd-empty">No notes written on this hole yet.</li>`;

    const yardsText = Number.isFinite(data.yards) && data.yards > 0 ? `${data.yards} yds` : "";
    const hcpText = Number.isFinite(data.hcp) && data.hcp > 0 ? `hcp ${data.hcp}` : "";
    const metaBits = [`par <strong>${data.par}</strong>`, yardsText, hcpText, `<strong>${data.count}</strong> round${data.count === 1 ? "" : "s"}`].filter(Boolean).join(" &middot; ");

    els.heatmapDrilldownBody.innerHTML = `
      <p class="hd-meta">${metaBits}</p>

      <div class="hd-stat-grid">
        <div class="hd-stat">
          <span class="hd-stat-num">${data.avgScore.toFixed(2)}</span>
          <span class="hd-stat-label">Avg</span>
        </div>
        <div class="hd-stat">
          <span class="hd-stat-num ${vsClass}">${formatDelta(data.avgVsPar)}</span>
          <span class="hd-stat-label">vs par</span>
        </div>
        <div class="hd-stat">
          <span class="hd-stat-num">${data.best}</span>
          <span class="hd-stat-label">Best</span>
        </div>
        <div class="hd-stat">
          <span class="hd-stat-num">${data.worst}</span>
          <span class="hd-stat-label">Worst</span>
        </div>
        <div class="hd-stat">
          <span class="hd-stat-num">${(data.girPct * 100).toFixed(0)}%</span>
          <span class="hd-stat-label">GIR</span>
        </div>
        <div class="hd-stat">
          <span class="hd-stat-num">${Number.isFinite(data.avgPutts) ? data.avgPutts.toFixed(2) : "—"}</span>
          <span class="hd-stat-label">Avg putts</span>
        </div>
      </div>

      <h4 class="hd-section-title">Scoring distribution</h4>
      <div class="hd-distribution">${distChips}</div>

      ${teeClubHtml}

      <h4 class="hd-section-title">Recent rounds</h4>
      <ul class="hd-rounds-list">${roundsList}</ul>

      <h4 class="hd-section-title">Notes</h4>
      <ul class="hd-notes-list">${notesList}</ul>
    `;
  }

  const PUTT_DISTANCE_BUCKETS = [
    { label: "Inside 3 ft", min: 0, max: 3 },
    { label: "3-6 ft", min: 3, max: 6 },
    { label: "6-10 ft", min: 6, max: 10 },
    { label: "10-20 ft", min: 10, max: 20 },
    { label: "20+ ft", min: 20, max: Infinity }
  ];

  function bucketForPuttDistance(distance) {
    if (!Number.isFinite(distance) || distance < 0) return null;
    return PUTT_DISTANCE_BUCKETS.find((bucket) => distance >= bucket.min && distance < bucket.max) || null;
  }

  function computePuttingStats(rounds) {
    const buckets = PUTT_DISTANCE_BUCKETS.map((bucket) => ({
      ...bucket,
      attempts: 0,
      makes: 0,
      threeJacks: 0
    }));
    rounds.forEach((round) => {
      round.holes.forEach((hole) => {
        if (!Number.isFinite(hole.firstPuttDistance) || hole.firstPuttDistance < 0) return;
        if (!Number.isFinite(hole.putts)) return;
        const bucket = buckets.find((b) => hole.firstPuttDistance >= b.min && hole.firstPuttDistance < b.max);
        if (!bucket) return;
        bucket.attempts += 1;
        if (Number(hole.putts) === 1) bucket.makes += 1;
        if (Number(hole.putts) >= 3) bucket.threeJacks += 1;
      });
    });
    const totalAttempts = buckets.reduce((sum, b) => sum + b.attempts, 0);
    return { buckets, totalAttempts };
  }

  function renderPuttingPanel(rounds) {
    if (!els.puttingPanel) return;
    const { buckets, totalAttempts } = computePuttingStats(rounds);
    if (!totalAttempts) {
      els.puttingPanel.innerHTML = emptyState("No first-putt distances logged yet. Add them in the Add Round form to unlock make% by distance.");
      return;
    }
    const headlineMakes = buckets.reduce((sum, b) => sum + b.makes, 0);
    const totalThreeJacks = buckets.reduce((sum, b) => sum + b.threeJacks, 0);
    const headlineRate = headlineMakes / totalAttempts;
    const headline = `
      <div class="putting-headline">
        <div class="putting-kpi"><span>Total tracked greens</span><strong>${totalAttempts}</strong></div>
        <div class="putting-kpi"><span>Overall make rate</span><strong>${(headlineRate * 100).toFixed(0)}%</strong></div>
        <div class="putting-kpi"><span>Three-jacks</span><strong>${totalThreeJacks}</strong></div>
      </div>`;
    const rows = buckets.map((bucket) => {
      const rate = bucket.attempts ? bucket.makes / bucket.attempts : 0;
      const widthPct = bucket.attempts ? Math.max(4, rate * 100) : 0;
      const meta = bucket.attempts
        ? `${bucket.makes}/${bucket.attempts} made${bucket.threeJacks ? ` · ${bucket.threeJacks} three-jack${bucket.threeJacks === 1 ? "" : "s"}` : ""}`
        : "No greens logged in this range yet.";
      return `
        <div class="putting-row${bucket.attempts === 0 ? " putting-row-empty" : ""}">
          <div class="putting-row-top">
            <span class="putting-row-label">${escapeHtml(bucket.label)}</span>
            <strong class="putting-row-rate">${bucket.attempts ? `${(rate * 100).toFixed(0)}%` : "—"}</strong>
          </div>
          <div class="putting-row-track"><div class="putting-row-fill" style="width:${widthPct}%"></div></div>
          <div class="putting-row-meta">${escapeHtml(meta)}</div>
        </div>`;
    }).join("");
    els.puttingPanel.innerHTML = headline + `<div class="putting-rows">${rows}</div>`;
  }

  // Scrambling = saves from off the green (missed GIR, but scored par or
  // better — meaning you got up-and-down). Sand save = scrambling
  // specifically from a greenside bunker. "Both" (fairway + greenside on
  // the same hole) counts toward greenside since the save attempt is from
  // the greenside bunker. Holes with no GIR data (rare — GIR is auto-
  // derived) are skipped.
  function computeScramblingStats(rounds) {
    let totalHoles = 0;
    let missedGirHoles = 0;
    let scrambleSaves = 0;
    let fairwayBunkerHoles = 0;
    let greensideBunkerHoles = 0;
    let bothBunkerHoles = 0;
    let sandSaveAttempts = 0;
    let sandSaves = 0;
    rounds.forEach((round) => {
      if (!Array.isArray(round.holes)) return;
      round.holes.forEach((hole) => {
        if (!Number.isFinite(hole.score) || hole.score <= 0) return;
        totalHoles += 1;
        const toPar = hole.score - hole.par;
        const isGreensideBunker = hole.bunker === "greenside" || hole.bunker === "both";
        if (hole.bunker === "fairway") fairwayBunkerHoles += 1;
        if (hole.bunker === "greenside") greensideBunkerHoles += 1;
        if (hole.bunker === "both") bothBunkerHoles += 1;
        if (!hole.gir) {
          missedGirHoles += 1;
          if (toPar <= 0) scrambleSaves += 1;
          if (isGreensideBunker) {
            sandSaveAttempts += 1;
            if (toPar <= 0) sandSaves += 1;
          }
        }
      });
    });
    const anyBunkerHoles = fairwayBunkerHoles + greensideBunkerHoles + bothBunkerHoles;
    return {
      totalHoles,
      missedGirHoles,
      scrambleSaves,
      scramblingPct: missedGirHoles ? scrambleSaves / missedGirHoles : 0,
      fairwayBunkerHoles,
      greensideBunkerHoles,
      bothBunkerHoles,
      anyBunkerHoles,
      bunkerFreqPct: totalHoles ? anyBunkerHoles / totalHoles : 0,
      sandSaveAttempts,
      sandSaves,
      sandSavePct: sandSaveAttempts ? sandSaves / sandSaveAttempts : 0,
    };
  }

  function renderScramblingPanel(rounds) {
    if (!els.scramblingPanel) return;
    const stats = computeScramblingStats(rounds);
    if (!stats.totalHoles) {
      els.scramblingPanel.innerHTML = emptyState(
        "Save a round to unlock scrambling and sand-save stats.",
        { action: "rounds" }
      );
      return;
    }
    const fmtPct = (v) => `${Math.round(v * 100)}%`;
    // Scrambling row — always available since GIR + score is enough. Sand
    // save row only meaningful once the user has logged bunker data.
    const sandSaveLine = stats.sandSaveAttempts > 0
      ? `<strong>${fmtPct(stats.sandSavePct)}</strong><span>${stats.sandSaves} of ${stats.sandSaveAttempts} greenside-bunker holes saved par or better</span>`
      : `<strong class="scrambling-muted">—</strong><span>Log Bunker on Add Round to unlock sand-save %.</span>`;
    const bunkerLine = stats.anyBunkerHoles > 0
      ? `<strong>${fmtPct(stats.bunkerFreqPct)}</strong><span>${stats.anyBunkerHoles} of ${stats.totalHoles} holes found sand · ${stats.fairwayBunkerHoles} fairway, ${stats.greensideBunkerHoles} greenside${stats.bothBunkerHoles ? `, ${stats.bothBunkerHoles} both` : ""}</span>`
      : `<strong class="scrambling-muted">—</strong><span>No bunker data logged yet.</span>`;
    els.scramblingPanel.innerHTML = `
      <div class="scrambling-rows">
        <div class="scrambling-row">
          <div class="scrambling-row-label">Scrambling</div>
          <div class="scrambling-row-value">
            <strong>${fmtPct(stats.scramblingPct)}</strong>
            <span>${stats.scrambleSaves} of ${stats.missedGirHoles} missed-GIR holes saved par or better</span>
          </div>
        </div>
        <div class="scrambling-row">
          <div class="scrambling-row-label">Sand save</div>
          <div class="scrambling-row-value">${sandSaveLine}</div>
        </div>
        <div class="scrambling-row">
          <div class="scrambling-row-label">Bunker frequency</div>
          <div class="scrambling-row-value">${bunkerLine}</div>
        </div>
      </div>`;
  }

  const SCORING_BUCKETS = [
    { id: "eagle", label: "Eagle+", chipClass: "scoring-eagle", match: (toPar) => toPar <= -2 },
    { id: "birdie", label: "Birdie", chipClass: "scoring-birdie", match: (toPar) => toPar === -1 },
    { id: "par", label: "Par", chipClass: "scoring-par", match: (toPar) => toPar === 0 },
    { id: "bogey", label: "Bogey", chipClass: "scoring-bogey", match: (toPar) => toPar === 1 },
    { id: "double", label: "Double", chipClass: "scoring-double", match: (toPar) => toPar === 2 },
    { id: "triple", label: "Triple", chipClass: "scoring-triple", match: (toPar) => toPar === 3 },
    { id: "worse", label: "Worse", chipClass: "scoring-worse", match: (toPar) => toPar >= 4 }
  ];

  function computeScoringDistribution(rounds) {
    const buckets = SCORING_BUCKETS.map((b) => ({ ...b, count: 0, holes: [] }));
    rounds.forEach((round) => {
      const course = getCourse(round.courseId);
      round.holes.forEach((hole) => {
        if (!Number.isFinite(hole.score) || hole.score <= 0) return;
        const toPar = hole.score - hole.par;
        const bucket = buckets.find((b) => b.match(toPar));
        if (!bucket) return;
        bucket.count += 1;
        bucket.holes.push({
          date: round.date,
          courseId: round.courseId,
          courseName: course ? course.name : "Unknown",
          holeNumber: hole.number,
          label: hole.label || `#${hole.number}`,
          par: hole.par,
          score: hole.score,
          toPar
        });
      });
    });
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    return { buckets, total };
  }

  function renderScoringDistribution(rounds) {
    if (!els.scoringDistribution) return;
    const { buckets, total } = computeScoringDistribution(rounds);
    if (!total) {
      els.scoringDistribution.innerHTML = emptyState("Save your first round to see scoring distribution.");
      return;
    }
    const bucketCards = buckets.map((bucket) => {
      const pct = total ? Math.round((bucket.count / total) * 100) : 0;
      const disabled = bucket.count === 0 ? " disabled" : "";
      return `
        <button type="button" class="scoring-bucket ${bucket.chipClass}" data-scoring-bucket="${bucket.id}"${disabled}>
          <span class="scoring-bucket-label">${escapeHtml(bucket.label)}</span>
          <strong class="scoring-bucket-count">${bucket.count}</strong>
          <small class="scoring-bucket-pct">${pct}%</small>
        </button>`;
    }).join("");
    els.scoringDistribution.innerHTML = `
      <p class="scoring-distribution-total">${total} hole${total === 1 ? "" : "s"} tracked. Tap any tier to see the holes.</p>
      <div class="scoring-distribution-grid">${bucketCards}</div>`;
  }

  // Compute total plays per physical hole across the given rounds. Returns
  // a Map<physicalId, { count, label, courseName, par }>. Used to ground
  // "most-tier'd holes" rates ("3 birdies in 11 plays") so a hole the user
  // has played twice doesn't look as impressive as one they've played 11
  // times.
  function computePlayCountByPhysicalHole(rounds) {
    const out = new Map();
    rounds.forEach((round) => {
      const course = getCourse(round.courseId);
      const courseName = course ? course.name : "Unknown";
      (round.holes || []).forEach((hole) => {
        if (!Number.isFinite(hole.score) || hole.score <= 0) return;
        const physId = physicalHoleId(round.courseId, hole);
        const existing = out.get(physId);
        if (!existing) {
          out.set(physId, {
            count: 1,
            label: hole.label || `#${hole.number}`,
            courseName,
            par: hole.par,
            number: hole.number
          });
        } else {
          existing.count += 1;
        }
      });
    });
    return out;
  }

  // Group bucket.holes into the dimensions the user actually cares about
  // when they tap "Birdies": by par type, by physical course, by physical
  // hole (with play counts for context), and as a recent-trend split.
  function computeBucketBreakdown(bucketHoles, allRounds) {
    const byPar = { 3: 0, 4: 0, 5: 0, other: 0 };
    const parHoleCount = { 3: new Set(), 4: new Set(), 5: new Set(), other: new Set() };
    const byCourse = new Map();
    const byHole = new Map();
    bucketHoles.forEach((h) => {
      const physId = physicalHoleId(h.courseId, { label: h.label, number: h.holeNumber });
      const physCourse = physicalCourseName(h.courseId);
      const parKey = (h.par === 3 || h.par === 4 || h.par === 5) ? h.par : "other";
      byPar[parKey] += 1;
      parHoleCount[parKey].add(physId);
      const cEntry = byCourse.get(physCourse) || { count: 0, holes: new Set() };
      cEntry.count += 1;
      cEntry.holes.add(physId);
      byCourse.set(physCourse, cEntry);
      const hEntry = byHole.get(physId) || {
        count: 0, label: h.label, par: h.par,
        courseName: physCourse, holeNumber: h.holeNumber, physId
      };
      hEntry.count += 1;
      byHole.set(physId, hEntry);
    });

    // Most-tier'd holes: rank by count, then by RATE (count / total plays)
    // when total plays are known. Top 5.
    const playCounts = computePlayCountByPhysicalHole(allRounds);
    const topHoles = [...byHole.values()]
      .map((h) => {
        const totalPlays = playCounts.get(h.physId)?.count || h.count;
        return { ...h, totalPlays, rate: h.count / Math.max(1, totalPlays) };
      })
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return b.rate - a.rate;
      })
      .slice(0, 5);

    // Recent trend: split bucket.holes into "last 5 rounds" vs "previous 5
    // rounds" by round date. Useful for "are you trending into more birdies?"
    const sortedByDate = [...bucketHoles].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const recentRoundDates = new Set();
    const previousRoundDates = new Set();
    // Group bucket.holes by their round (date approximation — same date is
    // very likely the same round; sample data uses one round per date).
    const allDatesSorted = [...new Set(allRounds.map((r) => r.date).filter(Boolean))]
      .sort((a, b) => b.localeCompare(a));
    allDatesSorted.slice(0, 5).forEach((d) => recentRoundDates.add(d));
    allDatesSorted.slice(5, 10).forEach((d) => previousRoundDates.add(d));
    const recentCount = sortedByDate.filter((h) => recentRoundDates.has(h.date)).length;
    const previousCount = sortedByDate.filter((h) => previousRoundDates.has(h.date)).length;

    return {
      byPar,
      parHoleCount,
      byCourse: [...byCourse.entries()].map(([name, v]) => ({
        name, count: v.count, holeCount: v.holes.size
      })).sort((a, b) => b.count - a.count),
      topHoles,
      recentTrend: { recent: recentCount, previous: previousCount },
      total: bucketHoles.length
    };
  }

  function openScoringBucketSheet(bucketId) {
    if (!els.bucketSheetOverlay || !els.bucketSheetList) return;
    const filtered = getFilteredRounds();
    const { buckets } = computeScoringDistribution(filtered);
    const bucket = buckets.find((b) => b.id === bucketId);
    if (!bucket) return;
    els.bucketSheetTitle.textContent = `${bucket.label} · ${bucket.count} hole${bucket.count === 1 ? "" : "s"}`;
    if (!bucket.holes.length) {
      els.bucketSheetList.innerHTML = `<li class="bucket-empty">No holes in this tier yet.</li>`;
    } else {
      const breakdown = computeBucketBreakdown(bucket.holes, filtered);
      els.bucketSheetList.innerHTML = renderBucketBreakdown(bucket, breakdown);
    }
    els.bucketSheetOverlay.hidden = false;
    document.body.classList.add("hole-picker-open");
    if (els.bucketSheetClose) els.bucketSheetClose.focus();
  }

  // Pluralize a scoring-tier label for use as a noun ("Birdie" → "birdies",
  // "Par" → "pars", "Eagle+" → "eagles", "Triple+" → "triples"). Strip any
  // trailing "+" — it's a UI ornament, not part of the word.
  function pluralizeTierLabel(label) {
    const stripped = (label || "").replace(/\+$/, "").trim();
    if (!stripped) return "holes";
    return stripped.toLowerCase() + "s";
  }

  // Singular verb form for "Holes you ___ the most" — strip the trailing s
  // off the pluralized noun. "birdies" → "birdie", "pars" → "par".
  function singularTierVerb(pluralLabel) {
    return (pluralLabel || "holes").replace(/s$/, "");
  }

  function renderBucketBreakdown(bucket, breakdown) {
    const lowerLabel = pluralizeTierLabel(bucket.label);
    const totalHolesPlayed = computeTotalHolesPlayedAcrossRounds();
    const pctOverall = totalHolesPlayed > 0
      ? ((breakdown.total / totalHolesPlayed) * 100).toFixed(1)
      : null;
    const overall = pctOverall
      ? `${breakdown.total} ${lowerLabel} across ${totalHolesPlayed} tracked holes (${pctOverall}%).`
      : `${breakdown.total} ${lowerLabel}.`;

    const parSection = (() => {
      const lines = [3, 4, 5].map((par) => {
        const count = breakdown.byPar[par];
        if (!count) return null;
        const holesAtPar = breakdown.parHoleCount[par].size;
        return `<li class="bucket-breakdown-line">
          <span class="bucket-breakdown-label">Par ${par}</span>
          <span class="bucket-breakdown-value">${count} ${lowerLabel} <span class="bucket-breakdown-sub">on ${holesAtPar} different hole${holesAtPar === 1 ? "" : "s"}</span></span>
        </li>`;
      }).filter(Boolean);
      if (!lines.length) return "";
      return `
        <li class="bucket-breakdown-section">
          <h4 class="bucket-breakdown-header">By par type</h4>
          <ul class="bucket-breakdown-list">${lines.join("")}</ul>
        </li>`;
    })();

    const courseSection = (() => {
      if (!breakdown.byCourse.length) return "";
      const lines = breakdown.byCourse.slice(0, 6).map((c) => `
        <li class="bucket-breakdown-line">
          <button type="button" class="link-course bucket-breakdown-label" data-open-course-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</button>
          <span class="bucket-breakdown-value">${c.count} ${lowerLabel} <span class="bucket-breakdown-sub">on ${c.holeCount} hole${c.holeCount === 1 ? "" : "s"}</span></span>
        </li>`).join("");
      return `
        <li class="bucket-breakdown-section">
          <h4 class="bucket-breakdown-header">By course</h4>
          <ul class="bucket-breakdown-list">${lines}</ul>
        </li>`;
    })();

    const topHolesSection = (() => {
      if (!breakdown.topHoles.length) return "";
      // Only worth showing if at least one hole has ≥2 entries — single-shot
      // birdie holes don't tell a story.
      const showable = breakdown.topHoles.filter((h) => h.count >= 2);
      if (!showable.length) return "";
      const lines = showable.map((h) => {
        const rateBit = h.totalPlays > h.count
          ? `in ${h.totalPlays} plays`
          : "";
        return `
          <li class="bucket-breakdown-line">
            <span class="bucket-breakdown-label">${escapeHtml(h.courseName)} · ${escapeHtml(h.label)}<span class="bucket-breakdown-sub"> · Par ${h.par}</span></span>
            <span class="bucket-breakdown-value">${h.count} ${lowerLabel}${rateBit ? ` <span class="bucket-breakdown-sub">${rateBit}</span>` : ""}</span>
          </li>`;
      }).join("");
      return `
        <li class="bucket-breakdown-section">
          <h4 class="bucket-breakdown-header">Holes you ${singularTierVerb(lowerLabel)} the most</h4>
          <ul class="bucket-breakdown-list">${lines}</ul>
        </li>`;
    })();

    const trendSection = (() => {
      const { recent, previous } = breakdown.recentTrend;
      if (recent === 0 && previous === 0) return "";
      const arrow = recent > previous ? "↗"
        : recent < previous ? "↘"
        : "→";
      return `
        <li class="bucket-breakdown-section">
          <h4 class="bucket-breakdown-header">Recent trend</h4>
          <ul class="bucket-breakdown-list">
            <li class="bucket-breakdown-line">
              <span class="bucket-breakdown-label">Last 5 rounds</span>
              <span class="bucket-breakdown-value">${recent} ${lowerLabel}</span>
            </li>
            <li class="bucket-breakdown-line">
              <span class="bucket-breakdown-label">Previous 5 rounds</span>
              <span class="bucket-breakdown-value">${previous} ${lowerLabel} <span class="bucket-breakdown-sub">${arrow}</span></span>
            </li>
          </ul>
        </li>`;
    })();

    // Flat list (every hole at this tier) — collapsed by default behind a
    // disclosure. Keeps the sheet from being a wall of rows but still lets
    // the user drill into the raw data.
    const sortedHoles = [...bucket.holes].sort((a, b) => b.date.localeCompare(a.date));
    const rawListSection = `
      <li class="bucket-breakdown-section">
        <details class="bucket-breakdown-details">
          <summary class="bucket-breakdown-header bucket-breakdown-summary">All ${bucket.holes.length} ${lowerLabel} ▾</summary>
          <ul class="bucket-row-list">${sortedHoles.map((h) => `
            <li class="bucket-row">
              <div class="bucket-row-main">
                <strong>${escapeHtml(h.label)}</strong>
                <span class="subtext">${escapeHtml(h.courseName)} · Par ${h.par}</span>
              </div>
              <div class="bucket-row-meta">
                <span class="bucket-row-score">${h.score}</span>
                <span class="bucket-row-date">${escapeHtml(h.date)}</span>
              </div>
            </li>`).join("")}</ul>
        </details>
      </li>`;

    return `
      <li class="bucket-breakdown-overall">${overall}</li>
      ${parSection}
      ${courseSection}
      ${topHolesSection}
      ${trendSection}
      ${rawListSection}
    `;
  }

  function computeTotalHolesPlayedAcrossRounds() {
    const filtered = getFilteredRounds();
    let total = 0;
    filtered.forEach((round) => {
      (round.holes || []).forEach((hole) => {
        if (Number.isFinite(hole.score) && hole.score > 0) total += 1;
      });
    });
    return total;
  }

  function closeScoringBucketSheet() {
    if (!els.bucketSheetOverlay) return;
    els.bucketSheetOverlay.hidden = true;
    document.body.classList.remove("hole-picker-open");
  }

  // Tap the live GIR / FIR stat mid-round to see exactly which holes were
  // hit and missed so far. Reuses the scoring-bucket bottom sheet.
  const FAIRWAY_RESULT_LABELS = {
    hit: "Fairway ✓", left: "Missed left", right: "Missed right",
    short: "Short", long: "Long", miss: "Missed"
  };

  function openStatDrillSheet(kind) {
    if (!els.bucketSheetOverlay || !els.bucketSheetList) return;
    const holes = readScorecard(false).filter((h) => Number.isFinite(h.score) && h.score > 0);
    let title;
    let rows;
    if (kind === "fir") {
      const drivable = holes.filter((h) => h.par !== 3);
      const hitCount = drivable.filter((h) => h.fairway === "hit").length;
      title = `Fairways hit · ${hitCount}/${drivable.length}`;
      rows = holes.map((h) => {
        let flag = "none";
        let text = "—";
        if (h.par === 3) {
          text = "Par 3";
        } else if (h.fairway && FAIRWAY_RESULT_LABELS[h.fairway]) {
          text = FAIRWAY_RESULT_LABELS[h.fairway];
          flag = h.fairway === "hit" ? "hit" : "miss";
        }
        return { label: h.label, number: h.number, par: h.par, flag, text };
      });
    } else {
      const made = holes.filter((h) => h.gir).length;
      title = `Greens in regulation · ${made}/${holes.length}`;
      rows = holes.map((h) => ({
        label: h.label, number: h.number, par: h.par,
        flag: h.gir ? "hit" : "miss",
        text: h.gir ? "GIR ✓" : "Missed green"
      }));
    }
    els.bucketSheetTitle.textContent = title;
    els.bucketSheetList.innerHTML = holes.length
      ? rows.map((r) => `
        <li class="bucket-row">
          <div class="bucket-row-main">
            <strong>${escapeHtml(r.label || `#${r.number}`)}</strong>
            <span class="subtext">Par ${r.par}</span>
          </div>
          <span class="stat-drill-flag stat-drill-${r.flag}">${escapeHtml(r.text)}</span>
        </li>`).join("")
      : `<li class="bucket-empty">Enter some hole scores first.</li>`;
    els.bucketSheetOverlay.hidden = false;
    document.body.classList.add("hole-picker-open");
    if (els.bucketSheetClose) els.bucketSheetClose.focus();
  }

  // parFilter: pass 3 / 4 / 5 to restrict the aggregation to a single par
  // tier. null (default) aggregates across all par types. Splitting by par
  // is the real signal — a driver on par 5s is a totally different question
  // than a driver on par 4s, and lumping them together hides that.
  function computeTeeClubPerformance(rounds, parFilter = null) {
    const grouped = new Map();
    rounds.forEach((round) => {
      round.holes.forEach((hole) => {
        if (!Number.isFinite(hole.score) || hole.score <= 0) return;
        if (parFilter !== null && hole.par !== parFilter) return;
        const teeClub = Array.isArray(hole.clubsHit) && hole.clubsHit.length ? hole.clubsHit[0] : null;
        if (!teeClub) return;
        if (!grouped.has(teeClub)) {
          grouped.set(teeClub, {
            club: teeClub,
            count: 0,
            par3: 0,
            par4: 0,
            par5: 0,
            par6: 0,
            toParTotal: 0,
            sgValues: []
          });
        }
        const entry = grouped.get(teeClub);
        entry.count += 1;
        entry.toParTotal += hole.score - hole.par;
        if (hole.par === 3) entry.par3 += 1;
        else if (hole.par === 4) entry.par4 += 1;
        else if (hole.par === 5) entry.par5 += 1;
        else if (hole.par === 6) entry.par6 += 1;
        const sg = holeStrokesGained(hole);
        if (sg !== null) entry.sgValues.push(sg);
      });
    });
    return [...grouped.values()]
      .map((entry) => ({
        ...entry,
        avgToPar: entry.count ? entry.toParTotal / entry.count : 0,
        avgSg: entry.sgValues.length ? average(entry.sgValues) : NaN
      }))
      .sort((a, b) => b.count - a.count);
  }

  // Tally penalty strokes by the club blamed for them — surfaces which club
  // is quietly costing you shots (usually the driver, sometimes a wedge).
  // Iterates per-penalty so a hole with [Driver, 7i] attributes 1 stroke
  // to each, not 2 strokes to "the" club.
  function computePenaltyClubs(rounds) {
    const map = new Map();
    let totalStrokes = 0;
    rounds.forEach((round) => {
      round.holes.forEach((hole) => {
        const pen = Number(hole.penalties);
        if (!Number.isFinite(pen) || pen <= 0) return;
        const clubs = Array.isArray(hole.penaltyClubs) && hole.penaltyClubs.length
          ? hole.penaltyClubs
          : (hole.penaltyClub ? Array(pen).fill(hole.penaltyClub) : []);
        if (!clubs.length) return;
        // Track which clubs already counted this hole — same club hit
        // twice on the same hole shouldn't inflate the per-club hole count.
        const seenThisHole = new Set();
        clubs.forEach((club) => {
          if (!club) return;
          totalStrokes += 1;
          if (!map.has(club)) map.set(club, { club, strokes: 0, holes: 0 });
          const entry = map.get(club);
          entry.strokes += 1;
          if (!seenThisHole.has(club)) {
            entry.holes += 1;
            seenThisHole.add(club);
          }
        });
      });
    });
    return {
      rows: [...map.values()].sort((a, b) => b.strokes - a.strokes),
      totalStrokes
    };
  }

  function renderPenaltyClubsSection(data) {
    if (!data.rows.length) return "";
    const rows = data.rows.map((entry) => `
      <li class="penalty-club-row">
        <strong>${escapeHtml(entry.club)}</strong>
        <span class="subtext">${entry.holes} hole${entry.holes === 1 ? "" : "s"}</span>
        <span class="penalty-club-count">${entry.strokes} pen</span>
      </li>`).join("");
    return `
      <div class="penalty-club-section">
        <p class="penalty-club-title">Penalty strokes by club · ${data.totalStrokes} total</p>
        <ul class="penalty-club-list">${rows}</ul>
      </div>`;
  }

  // For each Deerwood nine (Buck / Doe / Fawn) pool every appearance — front
  // of an 18-hole round, back of an 18-hole round, or a standalone 9-hole
  // round — so the per-nine average is built on the maximum sample.
  function computeDeerwoodByNine(rounds) {
    const ninesOrder = ["buck", "doe", "fawn"];
    const labels = { buck: "Buck", doe: "Doe", fawn: "Fawn" };
    const map = {};
    ninesOrder.forEach((n) => { map[n] = { nine: n, label: labels[n], grosses: [], pars: [] }; });
    rounds.forEach((round) => {
      if (!isDeerwoodCourseId(round.courseId) || !Array.isArray(round.holes)) return;
      const byNine = { buck: [], doe: [], fawn: [] };
      round.holes.forEach((hole) => {
        const m = String(hole.label || "").trim().match(/^(buck|doe|fawn)\s+(\d+)$/i);
        if (!m) return;
        const nine = m[1].toLowerCase();
        if (byNine[nine]) byNine[nine].push(hole);
      });
      ninesOrder.forEach((nine) => {
        const holes = byNine[nine];
        if (holes.length !== 9) return; // require a complete nine to count it
        const scored = holes.filter((h) => Number.isFinite(h.score) && h.score > 0);
        if (scored.length !== 9) return;
        const gross = scored.reduce((s, h) => s + h.score, 0);
        const par = scored.reduce((s, h) => s + Number(h.par || 0), 0);
        map[nine].grosses.push(gross);
        map[nine].pars.push(par);
      });
    });
    return ninesOrder.map((n) => {
      const e = map[n];
      const count = e.grosses.length;
      return {
        nine: n,
        label: e.label,
        rounds: count,
        avgGross: count ? average(e.grosses) : NaN,
        avgToPar: count ? average(e.grosses.map((g, i) => g - e.pars[i])) : NaN,
        bestGross: count ? Math.min(...e.grosses) : NaN
      };
    });
  }

  function renderDeerwoodByNine(rounds) {
    if (!els.deerwoodByNinePanel || !els.deerwoodByNineCard) return;
    const data = computeDeerwoodByNine(rounds);
    const hasAny = data.some((d) => d.rounds > 0);
    els.deerwoodByNineCard.hidden = !hasAny;
    if (!hasAny) return;
    const rows = data.map((d) => {
      if (!d.rounds) {
        return `
          <li class="dwbn-row dwbn-row-empty">
            <div class="dwbn-row-main">
              <strong>${escapeHtml(d.label)} nine</strong>
              <span class="subtext">no rounds yet</span>
            </div>
          </li>`;
      }
      return `
        <li class="dwbn-row">
          <div class="dwbn-row-main">
            <strong>${escapeHtml(d.label)} nine</strong>
            <span class="subtext">${d.rounds} nine${d.rounds === 1 ? "" : "s"} played · best ${d.bestGross}</span>
          </div>
          <div class="dwbn-row-stats">
            <span class="dwbn-stat"><small>Avg</small><strong>${d.avgGross.toFixed(1)}</strong></span>
            <span class="dwbn-stat"><small>To par</small><strong>${formatSigned(d.avgToPar)}</strong></span>
          </div>
        </li>`;
    }).join("");
    els.deerwoodByNinePanel.innerHTML = `<ul class="dwbn-list">${rows}</ul>`;
  }

  function renderTeeClubPerformance(rounds) {
    if (!els.teeClubPanel) return;
    const allData = computeTeeClubPerformance(rounds);
    const penaltyHtml = renderPenaltyClubsSection(computePenaltyClubs(rounds));
    if (!allData.length) {
      els.teeClubPanel.innerHTML = emptyState("Tag your tee shots in Clubs Hit (first club tapped = tee shot) to unlock tee-club performance.") + penaltyHtml;
      return;
    }
    const total = allData.reduce((sum, entry) => sum + entry.count, 0);

    // Build one section per par tier. Splitting like this is the whole
    // reason for this panel's existence — a 7-iron on a 175-yard par 3
    // and a 7-iron lay-up on a par 5 are completely different shots, and
    // averaging them together hides the signal.
    function sectionHtml(label, data) {
      if (!data.length) {
        return `
          <section class="tee-club-section tee-club-section-empty">
            <h3 class="tee-club-section-title">${escapeHtml(label)}</h3>
            <p class="tee-club-section-msg">No tagged tee shots yet for ${escapeHtml(label.toLowerCase())}.</p>
          </section>`;
      }
      // Smaller "best club" threshold (3+ shots) than the all-pars version,
      // since each par tier has fewer samples.
      const eligibleForBest = data.filter((d) => d.count >= 3);
      const bestClub = eligibleForBest.length >= 2
        ? eligibleForBest.reduce((best, d) => (d.avgToPar < best.avgToPar ? d : best))
        : null;
      const rows = data.map((entry) => {
        const tier = heatmapTier(entry.avgToPar);
        const isBest = bestClub && entry.club === bestClub.club && data.length > 1;
        const sgText = Number.isFinite(entry.avgSg) ? formatSigned(entry.avgSg, 2) : "—";
        return `
          <li class="tee-club-row${isBest ? " is-best" : ""}">
            <div class="tee-club-row-main">
              <strong>${escapeHtml(entry.club)}${isBest ? `<span class="hd-tc-best-flag">best avg</span>` : ""}</strong>
              <span class="subtext">${entry.count} tee shot${entry.count === 1 ? "" : "s"}</span>
            </div>
            <div class="tee-club-row-stats">
              <span class="hd-tc-avg ${tier}" title="Avg score-to-par">${formatSigned(entry.avgToPar, 2)}</span>
              <span class="tee-club-sg" title="Strokes gained per tee shot">SG ${sgText}</span>
            </div>
          </li>`;
      }).join("");
      const sectionTotal = data.reduce((s, e) => s + e.count, 0);
      return `
        <section class="tee-club-section">
          <h3 class="tee-club-section-title">${escapeHtml(label)} <span class="tee-club-section-count">${sectionTotal} tee shot${sectionTotal === 1 ? "" : "s"}</span></h3>
          <ul class="tee-club-list">${rows}</ul>
        </section>`;
    }

    const par3Data = computeTeeClubPerformance(rounds, 3);
    const par4Data = computeTeeClubPerformance(rounds, 4);
    const par5Data = computeTeeClubPerformance(rounds, 5);

    els.teeClubPanel.innerHTML = `
      <p class="tee-club-total">${total} tee shot${total === 1 ? "" : "s"} tagged across ${allData.length} club${allData.length === 1 ? "" : "s"}.</p>
      ${sectionHtml("Par 3s", par3Data)}
      ${sectionHtml("Par 4s", par4Data)}
      ${sectionHtml("Par 5s", par5Data)}
      ${penaltyHtml}`;
  }

  function renderStrokesGained(rounds) {
    const sgRounds = rounds
      .map((round) => {
        const sg = roundStrokesGained(round);
        return sg ? { round, ...sg } : null;
      })
      .filter(Boolean);

    if (!sgRounds.length) {
      els.strokesGainedPanel.innerHTML = emptyState("Strokes Gained needs at least one saved round with hole yardages.");
      return;
    }

    const avgPerRound = average(sgRounds.map((item) => item.total));
    const avgPerHole = average(sgRounds.map((item) => item.total / item.holes));
    const recent = [...sgRounds].sort((a, b) => b.round.date.localeCompare(a.round.date)).slice(0, 5);
    const previous = [...sgRounds].sort((a, b) => b.round.date.localeCompare(a.round.date)).slice(5, 10);
    const recentAvg = average(recent.map((item) => item.total));
    const previousAvg = previous.length ? average(previous.map((item) => item.total)) : NaN;
    const delta = Number.isFinite(previousAvg) ? recentAvg - previousAvg : NaN;

    const allHoles = rounds.flatMap((round) => round.holes);
    const sgByPar = [3, 4, 5, 6].map((par) => {
      const sgs = allHoles
        .filter((hole) => hole.par === par)
        .map(holeStrokesGained)
        .filter((value) => value !== null);
      return { par, count: sgs.length, avg: sgs.length ? average(sgs) : NaN };
    }).filter((entry) => entry.count > 0);

    const holeGroups = getHoleGroups(rounds).filter((group) => group.rounds >= 2);
    const holeGroupsWithSg = holeGroups.map((group) => {
      const expected = tourExpectedStrokes(group.par, Number(group.yards || 0));
      return { ...group, sgPerHole: expected - group.avgScore };
    });
    const bestSg = [...holeGroupsWithSg].sort((a, b) => b.sgPerHole - a.sgPerHole).slice(0, 3);
    const worstSg = [...holeGroupsWithSg].sort((a, b) => a.sgPerHole - b.sgPerHole).slice(0, 3);

    const headlineHtml = `
      <div class="sg-headline">
        <div class="sg-kpi"><span>Avg per round</span><strong>${formatSigned(avgPerRound)}</strong></div>
        <div class="sg-kpi"><span>Avg per hole</span><strong>${formatSigned(avgPerHole, 2)}</strong></div>
        <div class="sg-kpi"><span>Last 5</span><strong>${formatSigned(recentAvg)}</strong><small>${Number.isFinite(delta) ? `${formatSigned(delta)} vs prior 5` : `${recent.length} rounds`}</small></div>
        <div class="sg-kpi"><span>Sample</span><strong>${sgRounds.length}</strong><small>rounds scored</small></div>
      </div>`;

    const parBreakdownHtml = sgByPar.length ? `
      <div class="sg-section">
        <p class="sg-section-title">By par type</p>
        <div class="sg-par-grid">
          ${sgByPar.map((entry) => `
            <div class="sg-par-row">
              <span>Par ${entry.par}</span>
              <strong>${formatSigned(entry.avg, 2)}</strong>
              <small>${entry.count} holes</small>
            </div>`).join("")}
        </div>
      </div>` : "";

    const holeListHtml = holeGroupsWithSg.length ? `
      <div class="sg-section sg-hole-section">
        <div class="sg-hole-column">
          <p class="sg-section-title">Best SG holes</p>
          ${bestSg.map((group) => `
            <div class="sg-hole-row">
              <div>
                <strong>${escapeHtml(group.courseName)} ${escapeHtml(group.label)}</strong>
                <span class="subtext">Par ${group.par} | ${group.rounds} rounds</span>
              </div>
              <span class="score-chip">${formatSigned(group.sgPerHole, 2)}</span>
            </div>`).join("")}
        </div>
        <div class="sg-hole-column">
          <p class="sg-section-title">Worst SG holes</p>
          ${worstSg.map((group) => `
            <div class="sg-hole-row">
              <div>
                <strong>${escapeHtml(group.courseName)} ${escapeHtml(group.label)}</strong>
                <span class="subtext">Par ${group.par} | ${group.rounds} rounds</span>
              </div>
              <span class="score-chip bad">${formatSigned(group.sgPerHole, 2)}</span>
            </div>`).join("")}
        </div>
      </div>` : "";

    const trendData = [...sgRounds].sort((a, b) => a.round.date.localeCompare(b.round.date));
    const trendHtml = trendData.length >= 2 ? `
      <div class="sg-section">
        <p class="sg-section-title">SG trend</p>
        ${sgTrendChart(trendData)}
      </div>` : "";

    els.strokesGainedPanel.innerHTML = headlineHtml + parBreakdownHtml + holeListHtml + trendHtml;
  }

  function sgTrendChart(items) {
    const width = 720;
    const height = 140;
    const values = items.map((item) => item.total);
    const max = Math.max(0.5, ...values);
    const min = Math.min(-0.5, ...values);
    const range = Math.max(1, max - min);
    const points = items.map((item, index) => {
      const x = items.length === 1 ? width / 2 : 30 + index * ((width - 60) / (items.length - 1));
      const y = 20 + ((max - item.total) / range) * 95;
      return { x, y, value: item.total, date: item.round.date };
    });
    const zeroY = 20 + ((max - 0) / range) * 95;
    const path = points.map((point) => `${point.x},${point.y}`).join(" ");
    const circles = points.map((point) => {
      const color = point.value >= 0 ? "#217a57" : "#c0524a";
      return `<circle cx="${point.x}" cy="${point.y}" r="4" fill="${color}"></circle>`;
    }).join("");

    return `
      <svg class="sg-trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Strokes Gained trend">
        <rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#fbfcfa"></rect>
        <line x1="20" y1="${zeroY}" x2="${width - 20}" y2="${zeroY}" stroke="#cfd9d2" stroke-width="1" stroke-dasharray="4 4"></line>
        <text x="${width - 20}" y="${zeroY - 4}" text-anchor="end" font-size="10" font-weight="700" fill="#7a8780">tour baseline</text>
        <polyline points="${path}" fill="none" stroke="#2f6f9f" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></polyline>
        ${circles}
      </svg>`;
  }

  // The round narrative is intentionally NOT cached on the round itself —
  // it depends on all your *other* rounds (recent-form comparison), so every
  // time you add a new round, every old summary's "vs your recent average"
  // shifts. Always regenerating on render keeps every summary fresh and
  // means we don't have to invalidate a cache.
  //
  // Output is a multi-paragraph string, paragraphs separated by "\n\n".
  // The renderer splits and wraps each in <p>. Each paragraph is built by
  // a small helper that can return "" — paragraphs that have nothing
  // interesting to say (e.g. no per-hole notes were entered) are dropped.
  function generateRoundNarrative(round, allRounds) {
    if (!round || !Array.isArray(round.holes) || !round.holes.length) return "";
    const valid = round.holes.filter((h) => Number.isFinite(h.score) && h.score > 0);
    if (!valid.length) return "";
    const paragraphs = [
      buildNarrativeHeadline(round, valid, allRounds),
      buildNarrativeParTypes(round, valid, allRounds),
      buildNarrativeStory(round, valid, allRounds),
      buildNarrativeBestStretch(round, valid, allRounds),
      buildNarrativeCost(round, valid),
      buildNarrativeHighlights(round, valid),
      buildNarrativeNotes(round, valid),
      buildNarrativeSurvey(round, valid),
      buildNarrativeRoundNote(round)
    ].filter(Boolean);
    return paragraphs.join("\n\n");
  }

  // Compute the user's typical to-par per par type, across same-length rounds
  // (so 9-hole and 18-hole averages don't poison each other). Returns a map
  // {3: <avg toPar per par-3 hole>, 4: ..., 5: ...} along with the sample
  // sizes. Empty map if there aren't enough rounds to make a baseline.
  function computeTypicalParTypeScoring(currentRound, allRounds) {
    const others = allRounds.filter((r) =>
      r && r.id !== currentRound.id
      && Array.isArray(r.holes)
      && r.holes.length === currentRound.holes.length
      && r.holes.some((h) => Number.isFinite(h.score) && h.score > 0)
    );
    // Need ≥3 prior rounds for a stable baseline; otherwise the "typical"
    // value is just one round's noise.
    if (others.length < 3) return null;
    const buckets = { 3: [], 4: [], 5: [] };
    others.forEach((r) => {
      r.holes.forEach((h) => {
        if (!Number.isFinite(h.score) || h.score <= 0) return;
        if (!Number.isFinite(h.par) || h.par < 3 || h.par > 5) return;
        buckets[h.par].push(h.score - h.par);
      });
    });
    const result = {};
    [3, 4, 5].forEach((par) => {
      const arr = buckets[par];
      if (arr.length >= 6) {
        result[par] = { avg: average(arr), n: arr.length, roundCount: others.length };
      }
    });
    return Object.keys(result).length ? result : null;
  }

  // Paragraph 2 (NEW) — Par-type breakdown. The thing Jeff called out:
  // when the par 5s went -3 in a round, the narrative should LEAD with that,
  // not bury it. Compares each par type's to-par this round against the
  // user's typical, only surfacing observations that beat (or trail) typical
  // by enough strokes to matter. Up to two highlights (best + worst) per
  // paragraph, ranked by absolute delta.
  function buildNarrativeParTypes(round, valid, allRounds) {
    const buckets = { 3: [], 4: [], 5: [] };
    valid.forEach((h) => {
      if (!Number.isFinite(h.par) || h.par < 3 || h.par > 5) return;
      buckets[h.par].push(h.score - h.par);
    });
    const typical = computeTypicalParTypeScoring(round, allRounds);
    const entries = [];
    [3, 4, 5].forEach((par) => {
      const holes = buckets[par];
      if (!holes.length) return;
      const total = holes.reduce((s, v) => s + v, 0);
      const avgPerHole = total / holes.length;
      const typ = typical && typical[par];
      // Significance threshold scales by sample count — a single par-3
      // birdie matters less than a four-hole sweep of par 5s.
      const totalDelta = typ ? (avgPerHole - typ.avg) * holes.length : null;
      entries.push({
        par,
        holes: holes.length,
        total,
        avgPerHole,
        typicalAvg: typ ? typ.avg : null,
        totalDelta // negative means better than typical
      });
    });
    if (!entries.length) return "";

    const named = { 3: "par 3s", 4: "par 4s", 5: "par 5s" };
    const phrases = [];

    // Absolute first: surface any par type with a strong total (≥3 strokes
    // under par across the round) — that's "your par 5s went -3" energy.
    entries.forEach((e) => {
      if (e.total <= -3 && e.holes >= 2) {
        phrases.push({
          priority: 4 - e.total, // -3 → 7, -5 → 9, etc
          text: `Par 5s` === named[e.par] ? "" : "",
          phrase: `${named[e.par]} carried the round — ${formatSigned(e.total, 0)} across the ${e.holes}`,
          kind: "good"
        });
      }
    });

    // Relative-to-typical highlights. Up to 1 best and 1 worst by delta.
    if (typical) {
      const ranked = [...entries]
        .filter((e) => Number.isFinite(e.totalDelta) && e.holes >= 2)
        .sort((a, b) => Math.abs(b.totalDelta) - Math.abs(a.totalDelta));
      const best = ranked.find((e) => e.totalDelta <= -1.5);
      const worst = ranked.find((e) => e.totalDelta >= 2);
      if (best && !phrases.some((p) => p.phrase.startsWith(named[best.par]))) {
        const typTotal = (best.typicalAvg * best.holes);
        phrases.push({
          priority: 3 + Math.abs(best.totalDelta),
          phrase: `${named[best.par]} were ${Math.abs(best.totalDelta).toFixed(1)} strokes better than your typical (${formatSigned(best.total, 0)} vs ${formatSigned(typTotal, 1)})`,
          kind: "good"
        });
      }
      if (worst) {
        phrases.push({
          priority: 2 + worst.totalDelta,
          phrase: `${named[worst.par]} cost you — ${formatSigned(worst.total, 0)} across ${worst.holes} (you usually score ${formatSigned(worst.typicalAvg * worst.holes, 1)} on the par ${worst.par}s here)`,
          kind: "bad"
        });
      }
    }

    if (!phrases.length) return "";
    // Take up to 2 phrases, highest-priority first. Format as sentences.
    const top = phrases.sort((a, b) => b.priority - a.priority).slice(0, 2);
    return top.map((p) => p.phrase.charAt(0).toUpperCase() + p.phrase.slice(1) + ".").join(" ");
  }

  // Paragraph 1 — Headline. Score + course + how it compares to your recent
  // form + (for 18-hole rounds) front/back split + scoring shape.
  function buildNarrativeHeadline(round, valid, allRounds) {
    const courseName = physicalCourseName(round.courseId);
    const totals = roundTotals(round);
    const parts = [`Shot ${totals.gross} (${formatSigned(totals.toPar, 0)}) at ${courseName}`];

    // Course-specific context wins over generic recent-form when we have it.
    // Compare against same-length rounds AT THIS PHYSICAL COURSE (pooling
    // tee variants — your Ridgeview Blue 87 and Ridgeview White 89 both
    // count toward "your Ridgeview average"). Falls through to the generic
    // recent-form comparison when course history is too thin.
    const sameCourseSameLen = allRounds.filter((r) =>
      r.id !== round.id
      && r.holes.length === round.holes.length
      && physicalCourseName(r.courseId) === courseName
      && r.holes.some((h) => Number.isFinite(h.score) && h.score > 0)
    );
    const recentSameLen = allRounds
      .filter((r) => r.id !== round.id && r.holes.length === round.holes.length)
      .filter((r) => r.holes.some((h) => Number.isFinite(h.score) && h.score > 0))
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .slice(0, 5)
      .map(roundTotals);

    let comparedToCourse = false;
    if (sameCourseSameLen.length >= 3) {
      const courseTotals = sameCourseSameLen.map(roundTotals);
      const courseAvgToPar = average(courseTotals.map((t) => t.toPar));
      const delta = totals.toPar - courseAvgToPar;
      if (delta <= -4) {
        // Check if this is the best-ever at this course.
        const bestSoFar = courseTotals.reduce((b, t) => t.gross < b ? t.gross : b, Infinity);
        const isBest = totals.gross < bestSoFar;
        parts.push(isBest
          ? `your best ever at ${courseName} (previous best ${bestSoFar})`
          : `${Math.abs(delta).toFixed(1)} better than your ${courseName} average (${formatSigned(courseAvgToPar, 1)})`);
        comparedToCourse = true;
      } else if (delta <= -1.5) {
        parts.push(`${Math.abs(delta).toFixed(1)} better than your ${courseName} average (${formatSigned(courseAvgToPar, 1)})`);
        comparedToCourse = true;
      } else if (delta >= 4) {
        parts.push(`a tough one for you here (${courseName} avg ${formatSigned(courseAvgToPar, 1)})`);
        comparedToCourse = true;
      } else if (delta >= 1.5) {
        parts.push(`a tick above your ${courseName} average (${formatSigned(courseAvgToPar, 1)})`);
        comparedToCourse = true;
      } else {
        parts.push(`right around your ${courseName} average`);
        comparedToCourse = true;
      }
    }

    // Generic recent-form comparison only when we DIDN'T already say
    // course-specific (avoid double comparison).
    if (!comparedToCourse && recentSameLen.length >= 2) {
      const recentAvg = average(recentSameLen.map((t) => t.toPar));
      const delta = totals.toPar - recentAvg;
      if (delta <= -4) parts.push(`well below your recent ${recentSameLen.length}-round average (${formatSigned(recentAvg, 1)})`);
      else if (delta <= -1.5) parts.push(`better than your recent average (${formatSigned(recentAvg, 1)})`);
      else if (delta >= 4) parts.push(`a tougher day than usual (recent avg ${formatSigned(recentAvg, 1)})`);
      else if (delta >= 1.5) parts.push(`a touch above your recent average (${formatSigned(recentAvg, 1)})`);
      else parts.push(`right around your recent average`);
    }
    let sentence = parts.join(" — ") + ".";

    // Front 9 / back 9 split — only for complete 18-hole rounds.
    const fbBit = formatFrontBackSplit(round, valid);
    if (fbBit) sentence += " " + fbBit;

    // Scoring shape: only inline if we have enough holes to make the
    // distribution meaningful (≥9). Always-shows for full rounds.
    if (valid.length >= 9) {
      const shape = formatScoringShape(valid);
      if (shape) sentence += " " + shape;
    }

    // Wind tag if recorded.
    if (round.wind) sentence += ` Conditions: ${formatWind(round.wind).toLowerCase()}.`;

    return sentence;
  }

  function formatFrontBackSplit(round, valid) {
    if (round.holes.length !== 18 || valid.length < 18) return "";
    const front = round.holes.slice(0, 9);
    const back = round.holes.slice(9, 18);
    if (!front.every((h) => Number.isFinite(h.score) && h.score > 0)) return "";
    if (!back.every((h) => Number.isFinite(h.score) && h.score > 0)) return "";
    const fG = front.reduce((s, h) => s + h.score, 0);
    const bG = back.reduce((s, h) => s + h.score, 0);
    const fP = front.reduce((s, h) => s + h.par, 0);
    const bP = back.reduce((s, h) => s + h.par, 0);
    const fT = fG - fP;
    const bT = bG - bP;
    const diff = bT - fT;
    const split = `Front ${fG} (${formatSigned(fT, 0)}) / back ${bG} (${formatSigned(bT, 0)})`;
    if (diff >= 4) return `${split} — finished rough.`;
    if (diff <= -4) return `${split} — turned it around on the back.`;
    if (diff >= 2) return `${split} — slipped a bit coming in.`;
    if (diff <= -2) return `${split} — tightened up on the back.`;
    return `${split}.`;
  }

  function formatScoringShape(valid) {
    let eagles = 0, birds = 0, parsCount = 0, bogeys = 0, doubles = 0, worse = 0;
    valid.forEach((h) => {
      const d = h.score - h.par;
      if (d <= -2) eagles += 1;
      else if (d === -1) birds += 1;
      else if (d === 0) parsCount += 1;
      else if (d === 1) bogeys += 1;
      else if (d === 2) doubles += 1;
      else worse += 1;
    });
    const bits = [];
    if (eagles) bits.push(`${eagles} eagle${eagles === 1 ? "" : "s"}`);
    if (birds) bits.push(`${birds} birdie${birds === 1 ? "" : "s"}`);
    if (parsCount) bits.push(`${parsCount} par${parsCount === 1 ? "" : "s"}`);
    if (bogeys) bits.push(`${bogeys} bogey${bogeys === 1 ? "" : "s"}`);
    if (doubles) bits.push(`${doubles} double${doubles === 1 ? "" : "s"}`);
    if (worse) bits.push(`${worse} triple+`);
    if (!bits.length) return "";
    return bits.join(", ") + ".";
  }

  // Best 3-hole stretch (and worst, if it's dramatic). Surfaces "your
  // hottest run of the round" so the user sees the moment that worked.
  // Skips if no stretch is meaningfully under par.
  function buildNarrativeBestStretch(round, valid, allRounds) {
    if (valid.length < 5) return "";
    // Walk valid holes in saved order. For each window of 3, compute
    // cumulative to-par. We need the holes to be CONSECUTIVE in the
    // original card — so go off round.holes, but require all 3 to be
    // scored.
    let bestStart = -1, bestSum = 99;
    let worstStart = -1, worstSum = -99;
    for (let i = 0; i <= round.holes.length - 3; i++) {
      const window = round.holes.slice(i, i + 3);
      if (!window.every((h) => Number.isFinite(h.score) && h.score > 0 && Number.isFinite(h.par))) continue;
      const sum = window.reduce((s, h) => s + (h.score - h.par), 0);
      if (sum < bestSum) { bestSum = sum; bestStart = i; }
      if (sum > worstSum) { worstSum = sum; worstStart = i; }
    }
    const phrases = [];
    if (bestStart >= 0 && bestSum <= -2) {
      const holes = round.holes.slice(bestStart, bestStart + 3);
      const startLabel = holeDisplayId(round.courseId, holes[0].label, holes[0].number);
      const endLabel = holeDisplayId(round.courseId, holes[2].label, holes[2].number);
      phrases.push(`Hottest stretch: ${startLabel}–${endLabel} went ${formatSigned(bestSum, 0)}`);
    }
    if (worstStart >= 0 && worstSum >= 5) {
      const holes = round.holes.slice(worstStart, worstStart + 3);
      const startLabel = holeDisplayId(round.courseId, holes[0].label, holes[0].number);
      const endLabel = holeDisplayId(round.courseId, holes[2].label, holes[2].number);
      phrases.push(`Tough patch: ${startLabel}–${endLabel} cost ${formatSigned(worstSum, 0)}`);
    }
    return phrases.length ? phrases.join(". ") + "." : "";
  }

  // Paragraph 2 — Story. The "what worked / what didn't" paragraph. We
  // generate every observation that meets a threshold, then take the top 3
  // most interesting (extremes first — really good or really bad) so the
  // paragraph stays a tight 2-3 sentences.
  function buildNarrativeStory(round, valid, allRounds) {
    const lines = [];

    // Tee game — fairway rate.
    const fairwayHoles = valid.filter((h) => h.fairway && h.fairway !== "na");
    if (fairwayHoles.length >= 4) {
      const hit = fairwayHoles.filter((h) => h.fairway === "hit").length;
      const rate = hit / fairwayHoles.length;
      if (rate >= 0.7) lines.push({ priority: rate, text: `Tee ball was on point — ${hit}/${fairwayHoles.length} fairways found` });
      else if (rate <= 0.35) lines.push({ priority: 1 - rate, text: `Driver wandered — only ${hit}/${fairwayHoles.length} fairways hit` });
    }

    // Tee club mix — compare driver vs non-driver scoring if both have meaningful samples.
    const teeHoles = valid.filter((h) => h.par > 3 && Array.isArray(h.clubsHit) && h.clubsHit.length);
    const driverHoles = teeHoles.filter((h) => h.clubsHit[0] === "Driver");
    const nonDriverHoles = teeHoles.filter((h) => h.clubsHit[0] !== "Driver");
    if (driverHoles.length >= 3 && nonDriverHoles.length >= 3) {
      const dAvg = average(driverHoles.map((h) => h.score - h.par));
      const oAvg = average(nonDriverHoles.map((h) => h.score - h.par));
      const gap = dAvg - oAvg;
      if (gap >= 0.7) lines.push({ priority: gap, text: `On non-driver tee shots you played to ${formatSigned(oAvg, 1)} vs ${formatSigned(dAvg, 1)} with driver — something to think about` });
      else if (gap <= -0.7) lines.push({ priority: -gap, text: `Driver was your best tee club today (${formatSigned(dAvg, 1)} vs ${formatSigned(oAvg, 1)} without it)` });
    }

    // GIR — iron play.
    const girRate = valid.filter((h) => h.gir).length / valid.length;
    const girMade = valid.filter((h) => h.gir).length;
    if (girRate >= 0.45) lines.push({ priority: girRate, text: `Iron play held up — ${girMade}/${valid.length} greens in regulation` });
    else if (girRate <= 0.15 && valid.length >= 9) lines.push({ priority: 1 - girRate, text: `Approach play was thin (${girMade}/${valid.length} GIRs)` });

    // Scrambling.
    const missedGir = valid.filter((h) => !h.gir);
    if (missedGir.length >= 5) {
      const saves = missedGir.filter((h) => h.score - h.par <= 0).length;
      const sRate = saves / missedGir.length;
      if (sRate >= 0.5) lines.push({ priority: sRate + 0.5, text: `Short game bailed you out — ${saves}/${missedGir.length} up-and-downs after missed greens` });
      else if (sRate <= 0.1 && missedGir.length >= 8) lines.push({ priority: 1 - sRate, text: `Scrambling wouldn't fall (${saves}/${missedGir.length} after missed greens)` });
    }

    // Sand saves — only if greenside bunker came into play meaningfully.
    const gsBunker = valid.filter((h) => h.bunker === "greenside" || h.bunker === "both");
    const sandAttempts = gsBunker.filter((h) => !h.gir);
    if (sandAttempts.length >= 2) {
      const saves = sandAttempts.filter((h) => h.score - h.par <= 0).length;
      if (saves === sandAttempts.length) lines.push({ priority: 1.5, text: `Saved sand every time (${saves}/${sandAttempts.length})` });
      else if (saves === 0) lines.push({ priority: 1.2, text: `Sand was rough (0/${sandAttempts.length} saves)` });
    }

    // Putting.
    const puttHoles = valid.filter((h) => Number.isFinite(h.putts) && h.putts > 0);
    if (puttHoles.length >= 9) {
      const totalPutts = puttHoles.reduce((s, h) => s + h.putts, 0);
      const avg = totalPutts / puttHoles.length;
      const three = puttHoles.filter((h) => h.putts >= 3).length;
      const one = puttHoles.filter((h) => h.putts === 1).length;
      if (three >= 3) lines.push({ priority: 0.5 + three * 0.2, text: `${three} three-putts dragged the putter (${avg.toFixed(2)}/hole)` });
      else if (avg <= 1.7) lines.push({ priority: 1.2, text: `Putter ran hot — ${avg.toFixed(2)} putts/hole with ${one} one-putt${one === 1 ? "" : "s"}` });
      else if (avg >= 2.1 && three >= 1) lines.push({ priority: 0.8, text: `Putting was loose (${avg.toFixed(2)}/hole, ${three} three-putt${three === 1 ? "" : "s"})` });
    }

    if (!lines.length) return "";
    // Top 3 observations, sorted by interest priority (extremes first).
    const top = [...lines].sort((a, b) => b.priority - a.priority).slice(0, 3).map((l) => l.text);
    return top.join(". ") + ".";
  }

  // Paragraph 3 — Cost. Penalties (with the clubs blamed) and the
  // counterfactual swing if you removed the 3 worst holes.
  function buildNarrativeCost(round, valid) {
    const lines = [];

    const penaltyHoles = valid.filter((h) => Number(h.penalties) > 0);
    const totalPen = penaltyHoles.reduce((s, h) => s + Number(h.penalties), 0);
    if (totalPen >= 1 && penaltyHoles.length >= 1) {
      const byClub = new Map();
      penaltyHoles.forEach((h) => {
        const pen = Number(h.penalties) || 0;
        // Iterate per-stroke so a hole with mixed-club penalties attributes
        // each stroke to the right club, not all to one "primary" club.
        const clubs = Array.isArray(h.penaltyClubs) && h.penaltyClubs.length
          ? h.penaltyClubs
          : (h.penaltyClub ? Array(pen).fill(h.penaltyClub) : Array(pen).fill("uncertain club"));
        clubs.slice(0, pen).forEach((rawClub) => {
          const club = rawClub || "uncertain club";
          byClub.set(club, (byClub.get(club) || 0) + 1);
        });
      });
      const clubBits = [...byClub.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([club, n]) => `${n} on the ${club.toLowerCase()}`);
      lines.push(`${totalPen} penalty stroke${totalPen === 1 ? "" : "s"} on ${penaltyHoles.length} hole${penaltyHoles.length === 1 ? "" : "s"} — ${clubBits.join(", ")}`);
    }

    // Counterfactual: drop the 3 worst over-par holes.
    const totals = roundTotals(round);
    const holesWithLoss = valid
      .map((h) => ({ ...h, loss: h.score - h.par }))
      .filter((h) => h.loss > 0)
      .sort((a, b) => b.loss - a.loss);
    const worstThree = holesWithLoss.slice(0, 3);
    const savings = worstThree.reduce((s, h) => s + h.loss, 0);
    if (savings >= 4 && worstThree.length >= 2) {
      const labels = worstThree.map((h) => holeDisplayId(round.courseId, h.label, h.number)).join(", ");
      const adjusted = totals.gross - savings;
      lines.push(`Take away your three worst (${labels}) and the card reads ${adjusted} — a ${savings}-stroke swing`);
    }

    return lines.length ? lines.join(". ") + "." : "";
  }

  // Paragraph 4 — Highlights. Pull out the best hole with the most context
  // we have (tee club, GIR, putts), since that's the part people want to
  // remember.
  function buildNarrativeHighlights(round, valid) {
    const holesWithLoss = valid.map((h) => ({ ...h, loss: h.score - h.par }));
    const bestHole = [...holesWithLoss].sort((a, b) => a.loss - b.loss)[0];
    if (!bestHole || bestHole.loss > -1) return "";

    const where = holeDisplayId(round.courseId, bestHole.label, bestHole.number);
    const tag = bestHole.loss === -1 ? "Birdie"
              : bestHole.loss === -2 ? "Eagle"
              : `${Math.abs(bestHole.loss)} under`;

    const bits = [];
    const tee = Array.isArray(bestHole.clubsHit) && bestHole.clubsHit[0] ? bestHole.clubsHit[0] : null;
    if (tee) bits.push(`${tee} off the tee`);
    if (bestHole.gir) bits.push(`green in reg`);
    if (Number.isFinite(bestHole.putts)) {
      if (bestHole.putts === 1) bits.push("one-putt");
      else if (bestHole.putts === 2) bits.push("two-putt");
    }
    const detail = bits.length ? ` — ${bits.join(", ")}` : "";
    return `Standout hole: ${tag} on ${where}${detail}.`;
  }

  // Paragraph 5 — Per-hole notes (verbatim, the user's voice). The thing the
  // user explicitly called out: they want their own writing surfaced in the
  // summary, not just the numbers.
  function buildNarrativeNotes(round, valid) {
    const noteHoles = valid.filter((h) => h.note && h.note.trim());
    if (!noteHoles.length) return "";
    const bits = noteHoles.slice(0, 6).map((h) => {
      const where = holeDisplayId(round.courseId, h.label, h.number);
      return `${where}: "${h.note.trim()}"`;
    });
    return `From your notes — ${bits.join("; ")}.`;
  }

  // Paragraph 6 — Round note. The post-round reflection the user wrote
  // (separate from per-hole notes). Quoted verbatim as the closing line.
  function buildNarrativeRoundNote(round) {
    const note = round.note && round.note.trim();
    if (!note) return "";
    return `Your round note: "${note}"`;
  }

  // --- Optional reflection survey paragraph -------------------------------
  //
  // If the user filled in any part of the post-round survey, weave the
  // answers into a self-rated paragraph. Each piece is independently
  // optional — empty answers just don't appear.
  const SURVEY_FEEL_LABELS = { great: "great", good: "good", okay: "okay", tough: "tough" };
  const SURVEY_CONFIDENCE_LABELS = {
    shaky: "shaky", building: "building", solid: "solid", locked: "locked in"
  };
  const SURVEY_RATING_LABELS = {
    driver: "driver", irons: "irons", wedges: "wedges", putter: "putter"
  };

  function buildNarrativeSurvey(round /*, valid */) {
    const s = round && round.survey;
    if (!s || !surveyHasContent(s)) return "";

    const bits = [];

    // Feel + confidence merge into one opening line if both present.
    if (s.feel && s.confidence) {
      bits.push(`You felt ${SURVEY_FEEL_LABELS[s.feel] || s.feel} about the round with ${SURVEY_CONFIDENCE_LABELS[s.confidence] || s.confidence} confidence`);
    } else if (s.feel) {
      bits.push(`You felt ${SURVEY_FEEL_LABELS[s.feel] || s.feel} about the round`);
    } else if (s.confidence) {
      bits.push(`Confidence was ${SURVEY_CONFIDENCE_LABELS[s.confidence] || s.confidence}`);
    }

    // Self-ratings: surface the highest and lowest when ≥2 are filled.
    const ratings = s.ratings || {};
    const filledRatings = Object.entries(ratings)
      .filter(([, v]) => Number.isFinite(v))
      .map(([club, v]) => ({ club, value: v }));
    if (filledRatings.length >= 2) {
      const sorted = [...filledRatings].sort((a, b) => b.value - a.value);
      const top = sorted[0];
      const bot = sorted[sorted.length - 1];
      if (top.value === bot.value) {
        // All ratings the same — flat day across the bag.
        bits.push(`You rated yourself ${top.value}/5 across the bag`);
      } else {
        bits.push(`Your ${SURVEY_RATING_LABELS[top.club]} felt sharpest (${top.value}/5); your ${SURVEY_RATING_LABELS[bot.club]} let you down (${bot.value}/5)`);
      }
    } else if (filledRatings.length === 1) {
      const r = filledRatings[0];
      bits.push(`You rated your ${SURVEY_RATING_LABELS[r.club]} at ${r.value}/5`);
    }

    let paragraph = bits.length ? bits.join(". ") + "." : "";

    // Swing thoughts — quote verbatim.
    if (s.swingThoughts && s.swingThoughts.trim()) {
      paragraph += ` Swing thoughts: "${s.swingThoughts.trim()}".`;
    }
    // What went well — quote verbatim.
    if (s.wentWell && s.wentWell.trim()) {
      paragraph += ` What worked: "${s.wentWell.trim()}".`;
    }
    // What to work on — quote verbatim, ends with a coaching framing.
    if (s.workOn && s.workOn.trim()) {
      paragraph += ` Next time, focus on: "${s.workOn.trim()}".`;
    }

    return paragraph.trim();
  }

  function escapeForText(value) {
    // Strings going into the narrative don't get HTML-escaped here because
    // the renderer uses textContent. Returned as-is.
    return String(value);
  }

  function buildCourseBrief(courseId) {
    if (!courseId || courseId === DEERWOOD_COURSE_ID) return null;
    const course = getCourse(courseId);
    if (!course) return null;

    const deerwood = isDeerwoodCourseId(courseId);
    const holeCount = course.holes.length;
    // Round-level stats need rounds of the same shape — mixing 9- and 18-hole
    // grosses would corrupt the averages. For Deerwood that means every
    // same-hole-count Deerwood round, regardless of routing. For non-Deerwood
    // courses, pool ALL rounds at the same physical course (any tee) so
    // selecting Diamond Hawk Gold today shows stats from your Black + Gold +
    // Green rounds combined — the brief is about "how do you play this course",
    // not "how do you play this exact tee box".
    const physicalName = course.name;
    const courseRounds = state.rounds
      .filter((round) => {
        if (deerwood) {
          return isDeerwoodCourseId(round.courseId) && round.holes.length === holeCount;
        }
        // Non-Deerwood: match any tee variant of the same physical course.
        const roundCourse = getCourse(round.courseId);
        return roundCourse && roundCourse.name === physicalName;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
    if (courseRounds.length < 2) return null;
    // Per-hole stats are hole-count-agnostic, so pool every Deerwood round
    // (9- and 18-hole alike) — a physical hole keeps one combined history.
    const holePoolRounds = deerwood
      ? state.rounds.filter((round) => isDeerwoodCourseId(round.courseId))
      : courseRounds;

    const totals = courseRounds.map(roundTotals);
    const avgGross = average(totals.map((entry) => entry.gross));
    const avgToPar = average(totals.map((entry) => entry.toPar));
    const avgPutts = average(totals.map((entry) => entry.putts));

    const allTotals = state.rounds.map(roundTotals);
    const overallAvgToPar = average(allTotals.map((entry) => entry.toPar));
    const courseDelta = Number.isFinite(overallAvgToPar) ? avgToPar - overallAvgToPar : NaN;

    const recent = courseRounds.slice(0, 5).map((round) => {
      const sg = roundStrokesGained(round);
      const roundTotalsValue = roundTotals(round);
      return {
        date: round.date,
        gross: roundTotalsValue.gross,
        toPar: roundTotalsValue.toPar,
        sg: sg ? sg.total : null,
        note: round.note || ""
      };
    });

    // Walk the holes of the routing you're about to play; for each one pool
    // every round (any routing/tee) where that same physical hole was played.
    const holeStats = course.holes.map((courseHole) => {
      const physId = physicalHoleId(courseId, courseHole);
      const entry = {
        number: courseHole.number,
        label: courseHole.label || `#${courseHole.number}`,
        par: courseHole.par,
        yards: courseHole.yards,
        scores: [],
        sgs: [],
        notes: [],
        hazards: Array.isArray(courseHole.hazards) ? courseHole.hazards : []
      };
      holePoolRounds.forEach((round) => {
        round.holes.forEach((hole) => {
          if (physicalHoleId(round.courseId, hole) !== physId) return;
          if (!Number.isFinite(hole.score) || hole.score <= 0) return;
          entry.scores.push(hole.score);
          const sg = holeStrokesGained(hole);
          if (sg !== null) entry.sgs.push(sg);
          if (hole.note && String(hole.note).trim()) {
            entry.notes.push({ date: round.date, note: String(hole.note).trim() });
          }
        });
      });
      const avgScore = average(entry.scores);
      const sortedNotes = [...entry.notes].sort((a, b) => b.date.localeCompare(a.date));
      return {
        ...entry,
        avgScore,
        avgToPar: avgScore - entry.par,
        avgSg: entry.sgs.length ? average(entry.sgs) : NaN,
        rounds: entry.scores.length,
        latestNote: sortedNotes[0] || null
      };
    }).filter((entry) => entry.scores.length > 0);

    const sgRanked = holeStats.filter((entry) => Number.isFinite(entry.avgSg));
    const leaks = [...sgRanked].sort((a, b) => a.avgSg - b.avgSg).slice(0, 3);
    const strengths = [...sgRanked].sort((a, b) => b.avgSg - a.avgSg).slice(0, 3);

    const lastRound = courseRounds[0];
    const lastTotals = roundTotals(lastRound);
    const worstThree = [...lastRound.holes]
      .filter((hole) => Number.isFinite(hole.score) && hole.score > 0)
      .map((hole) => ({ ...hole, loss: hole.score - hole.par }))
      .sort((a, b) => b.loss - a.loss)
      .slice(0, 3);
    const savings = worstThree.reduce((sum, hole) => sum + Math.max(0, hole.loss), 0);
    const counterfactualScore = lastTotals.gross - savings;

    return {
      course,
      roundCount: courseRounds.length,
      avgGross,
      avgToPar,
      avgPutts,
      courseDelta,
      recent,
      leaks,
      strengths,
      counterfactual: {
        lastDate: lastRound.date,
        actualScore: lastTotals.gross,
        actualToPar: lastTotals.toPar,
        worstThree,
        savings,
        adjustedScore: counterfactualScore
      },
      lastNote: lastRound.note || ""
    };
  }

  // A read-only, traditional marked-up scorecard for a saved round: holes
  // split by nine, each score shown with its birdie-circle / bogey-box mark.
  function renderRoundScorecard(round) {
    if (!round || !Array.isArray(round.holes) || !round.holes.length) return "";
    const sectionsHtml = getScorecardSections(round.holes).map((section) => {
      const scored = section.holes.filter((hole) => Number.isFinite(hole.score) && hole.score > 0);
      const scoreSum = scored.reduce((sum, hole) => sum + hole.score, 0);
      const cells = section.holes.map((hole) => `
        <div class="rsc-cell">
          <span class="rsc-cell-label">${escapeHtml(hole.label || `#${hole.number}`)}</span>
          ${renderScoreMark(hole.score, hole.par)}
          <span class="rsc-cell-par">Par ${hole.par}</span>
        </div>`).join("");
      return `
        <div class="rsc-nine">
          <div class="rsc-nine-head">
            <strong>${escapeHtml(section.label)}</strong>
            <span>${scored.length ? `${scoreSum} (${formatSigned(scoreSum - section.par, 0)})` : "--"} · Par ${section.par}</span>
          </div>
          <div class="rsc-holes">${cells}</div>
        </div>`;
    }).join("");
    const totals = roundTotals(round);
    return `
      <div class="round-scorecard">
        ${sectionsHtml}
        <div class="rsc-total"><span>Total</span><strong>${totals.gross} (${formatSigned(totals.toPar, 0)})</strong></div>
      </div>`;
  }

  function renderRecentRounds() {
    const rows = [...state.rounds]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 7)
      .map((round) => {
        const course = getCourse(round.courseId);
        const totals = roundTotals(round);
        const sg = roundStrokesGained(round);
        const sgLabel = sg ? ` | SG ${formatSigned(sg.total)}` : "";
        const windLabel = round.wind ? ` | ${escapeHtml(formatWind(round.wind))}` : "";
        const tagBadge = round.tag ? ` <span class="round-tag-badge round-tag-${escapeHtml(round.tag)}">${escapeHtml(formatRoundTag(round.tag))}</span>` : "";
        const editingBadge = editingRoundId === round.id ? ' <span class="editing-pill">editing</span>' : "";
        // Always regenerate the narrative — it depends on every other round
        // ("vs your recent average" shifts as you add rounds), so a stored
        // string would go stale. The narrative.split / wrap-in-<p> dance
        // turns the multi-paragraph string into proper HTML paragraphs.
        const hasScores = round.holes && round.holes.some((h) => Number.isFinite(h.score) && h.score > 0);
        const narrative = hasScores ? generateRoundNarrative(round, state.rounds) : "";
        const narrativeHtml = narrative
          ? `<details class="round-row-summary"><summary>Summary</summary><div class="round-row-summary-body">${narrative.split("\n\n").map((p) => `<p>${escapeHtml(p)}</p>`).join("")}</div></details>`
          : "";
        const scorecardHtml = `<details class="round-row-scorecard"><summary>Scorecard</summary>${renderRoundScorecard(round)}</details>`;
        return `
          <div class="round-row${editingRoundId === round.id ? " editing" : ""}">
            <div class="round-row-main">
              <strong>${totals.gross} (${formatSigned(totals.toPar, 0)})${editingBadge}${tagBadge}</strong>
              <span class="subtext">${round.date} | <button type="button" class="link-course" data-open-course-name="${escapeHtml(physicalCourseName(round.courseId))}">${escapeHtml(course ? course.name : "Unknown")}</button>${windLabel}${sgLabel}</span>
              ${narrativeHtml}
              ${scorecardHtml}
            </div>
            <div class="row-actions">
              <button type="button" data-view-round="${round.id}">View</button>
              <button type="button" data-delete-round="${round.id}">Delete</button>
            </div>
          </div>`;
      }).join("");

    els.recentRounds.innerHTML = rows || emptyState("Your scorecards will appear here once you save a round.", { action: "rounds" });
    // Tap "View" → opens the same read-only scorecard sheet that Trophy
    // Room cards use. Edit is the secondary action inside the sheet so the
    // default action everywhere is "look at the round", not "jump straight
    // into editing it." Consistent with Jeff's feedback after the autonomous
    // batch shipped.
    els.recentRounds.querySelectorAll("[data-view-round]").forEach((button) => {
      button.addEventListener("click", () => {
        const round = state.rounds.find((candidate) => candidate.id === button.dataset.viewRound);
        if (!round) {
          showToast("Round not found.");
          return;
        }
        showRoundDetail(round);
      });
    });
    els.recentRounds.querySelectorAll("[data-delete-round]").forEach((button) => {
      button.addEventListener("click", () => {
        const targetId = button.dataset.deleteRound;
        state.rounds = state.rounds.filter((round) => round.id !== targetId);
        if (editingRoundId === targetId) clearEditState({ rerender: true });
        saveState();
        renderAll();
        showToast("Round deleted.");
      });
    });
  }

  // ---- Trophy Room (Home → Records) -------------------------------------
  //
  // Computes lifetime personal-best records from EVERY saved round (not the
  // filtered set — the user's expectation here is "what's my all-time
  // best?", which shouldn't shift with the Last-5 filter on). Each trophy
  // anchors back to the round that set it; tapping the card loads that
  // round for editing/inspection.

  function computeTrophies(rounds) {
    const out = [];
    if (!Array.isArray(rounds) || !rounds.length) return out;
    const scored = rounds.filter((r) =>
      r && Array.isArray(r.holes) && r.holes.some((h) => Number.isFinite(h.score) && h.score > 0)
    );
    if (!scored.length) return out;

    const fmtDate = (d) => {
      try {
        const date = new Date(d);
        if (Number.isNaN(date.getTime())) return d;
        return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      } catch { return d; }
    };
    const courseLabel = (cId) => {
      const c = getCourse(cId);
      return c ? (c.name + (c.tee ? ` (${c.tee})` : "")) : "Unknown course";
    };
    const fmtSigned = (n) => (n > 0 ? `+${n}` : n === 0 ? "E" : String(n));
    const trophy = (id, label, value, round, sub) => {
      out.push({
        id, label, value,
        context: round ? `${fmtDate(round.date)} · ${courseLabel(round.courseId)}` : "",
        sub: sub || "",
        roundId: round ? round.id : null
      });
    };

    const has18 = scored.filter((r) => r.holes.length === 18);
    const has9 = scored.filter((r) => r.holes.length === 9);

    function pickBest(arr, valueOf, direction) {
      let best = null;
      arr.forEach((r) => {
        const v = valueOf(r);
        if (v === null || !Number.isFinite(v)) return;
        if (best === null) best = { round: r, value: v };
        else if (direction === "min" && v < best.value) best = { round: r, value: v };
        else if (direction === "max" && v > best.value) best = { round: r, value: v };
      });
      return best;
    }

    let b;
    b = pickBest(has18, (r) => roundTotals(r).gross, "min");
    if (b) trophy("low-18-gross", "Lowest 18-hole gross", String(b.value), b.round);
    b = pickBest(has18, (r) => roundTotals(r).toPar, "min");
    if (b) trophy("low-18-topar", "Lowest 18 vs par", fmtSigned(b.value), b.round);
    b = pickBest(has9, (r) => roundTotals(r).gross, "min");
    if (b) trophy("low-9-gross", "Lowest 9-hole gross", String(b.value), b.round);
    b = pickBest(has9, (r) => roundTotals(r).toPar, "min");
    if (b) trophy("low-9-topar", "Lowest 9 vs par", fmtSigned(b.value), b.round);

    // Per-round counts: restrict to 18-hole rounds. A 9-hole round
    // genuinely can't compete with an 18-hole round on "most birdies",
    // "most pars", etc — the comparison is apples-to-oranges and the
    // 18-hole round always wins on raw counts. Mixing them silently
    // misrepresents records.
    b = pickBest(has18, (r) => r.holes.filter((h) =>
      Number.isFinite(h.score) && Number.isFinite(h.par) && h.score <= h.par - 1
    ).length, "max");
    if (b && b.value > 0) trophy("most-birdies", "Most birdies-or-better (18-hole round)", String(b.value), b.round);

    b = pickBest(has18, (r) => r.holes.filter((h) =>
      Number.isFinite(h.score) && Number.isFinite(h.par) && h.score <= h.par
    ).length, "max");
    if (b && b.value > 0) trophy("most-pars", "Most pars-or-better (18-hole round)", String(b.value), b.round);

    b = pickBest(has18, (r) => { const t = roundTotals(r); return t.putts > 0 ? t.putts : null; }, "min");
    if (b) trophy("low-putts", "Lowest putts (18 holes)", String(b.value), b.round);

    b = pickBest(has18, (r) => { const t = roundTotals(r); return t.firTotal > 0 ? t.firMade : null; }, "max");
    if (b && b.value > 0) {
      const t = roundTotals(b.round);
      trophy("most-firs", "Most fairways (18-hole round)", `${b.value} / ${t.firTotal}`, b.round);
    }

    b = pickBest(has18, (r) => r.holes.filter((h) => h.gir).length, "max");
    if (b && b.value > 0) trophy("most-girs", "Most GIR (18-hole round)", `${b.value} / ${b.round.holes.length}`, b.round);

    // Best 3-hole stretch is hole-level, fine to mix 9 and 18.
    // Best 9-hole stretch only makes sense for 18-hole rounds — for a
    // 9-hole round the "stretch" IS the whole round, which is already
    // covered by the Lowest 9-hole gross/topar trophies above.
    function bestStretch(n, id, label, fromArr) {
      const pool = fromArr || scored;
      let best = null;
      pool.forEach((r) => {
        const holes = r.holes;
        if (!holes || holes.length < n) return;
        for (let i = 0; i <= holes.length - n; i++) {
          let toPar = 0;
          let valid = true;
          for (let j = 0; j < n; j++) {
            const h = holes[i + j];
            if (!Number.isFinite(h.score) || h.score <= 0 || !Number.isFinite(h.par)) {
              valid = false; break;
            }
            toPar += h.score - h.par;
          }
          if (!valid) continue;
          if (best === null || toPar < best.value) {
            best = { value: toPar, round: r, startHole: holes[i].number, endHole: holes[i + n - 1].number };
          }
        }
      });
      if (best) trophy(id, label, fmtSigned(best.value), best.round, `Holes ${best.startHole}–${best.endHole}`);
    }
    bestStretch(3, "best-3stretch", "Best 3-hole stretch");
    bestStretch(9, "best-9stretch", "Best 9-hole stretch (in an 18-hole round)", has18);

    // Chronological hole stream — for streaks that span rounds (longest
    // pars-in-a-row, longest no-3-putt, etc.).
    const chrono = [...scored].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const events = [];
    chrono.forEach((r) => r.holes.forEach((h) => {
      if (!Number.isFinite(h.score) || h.score <= 0) return;
      events.push({
        round: r,
        hole: h,
        isPar: Number.isFinite(h.par) && h.score <= h.par,
        isBirdie: Number.isFinite(h.par) && h.score <= h.par - 1,
        isNo3Putt: !(Number.isFinite(h.putts) && h.putts >= 3)
      });
    }));

    function longestRun(predicate, id, label) {
      let bestRun = 0;
      let bestEnd = null;
      let curr = 0;
      events.forEach((e, idx) => {
        if (predicate(e)) {
          curr++;
          if (curr > bestRun) { bestRun = curr; bestEnd = idx; }
        } else { curr = 0; }
      });
      if (bestRun >= 2 && bestEnd != null) {
        const endRound = events[bestEnd].round;
        trophy(id, label, `${bestRun}`, endRound, `ended ${fmtDate(endRound.date)}`);
      }
    }
    longestRun((e) => e.isPar, "streak-pars", "Longest pars-or-better streak");
    longestRun((e) => e.isBirdie, "streak-birdies", "Longest birdies streak");
    longestRun((e) => e.isNo3Putt, "streak-no3putt", "Longest no-3-putt streak");

    let aceCount = 0;
    let lastAceRound = null;
    events.forEach((e) => {
      if (e.hole.par === 3 && e.hole.score === 1) {
        aceCount++;
        lastAceRound = e.round;
      }
    });
    if (aceCount > 0) {
      trophy("aces", "Holes-in-one", String(aceCount), lastAceRound,
        aceCount === 1 ? "your first ace" : `${aceCount} all-time`);
    }

    [90, 85, 80, 75, 70].forEach((threshold) => {
      const firstUnder = [...has18]
        .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
        .find((r) => roundTotals(r).gross < threshold);
      if (firstUnder) {
        trophy(`broke-${threshold}`, `First time broke ${threshold}`, String(roundTotals(firstUnder).gross), firstUnder);
      }
    });

    return out;
  }

  // ---- Stats Explorer (Home → Explorer) ---------------------------------
  //
  // Phase 1: pre-built queries. Each computeStat* function returns a card
  // descriptor { id, label, value, sub, context } or null when there's not
  // enough data to answer. The Explorer panel renders them as a card grid
  // — same visual model as Trophy Room but the framing is "questions about
  // your game" rather than "achievements". Phase 2 (NLP queries) deferred
  // until the user wires up an API key.

  function computeStatsExplorer(rounds) {
    const out = [];
    if (!Array.isArray(rounds) || !rounds.length) return out;
    const scored = rounds.filter((r) =>
      r && Array.isArray(r.holes) && r.holes.some((h) => Number.isFinite(h.score) && h.score > 0)
    );
    if (!scored.length) return out;

    const fmtSigned = (n) => (n > 0 ? `+${n.toFixed(1)}` : n === 0 ? "E" : n.toFixed(1));
    const fmt1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : "--");
    const avg = (xs) => xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;

    // Every "avg gross" comparison MUST restrict to 18-hole rounds.
    // Mixing 9-hole and 18-hole gross silently misrepresents results — a
    // 45 9-hole round and a 90 18-hole round both average to "67.5"
    // which is meaningless. has18 is the apples-to-apples pool for any
    // gross-score math. Hole-level counts (streaks, etc) live separately
    // in Trophy Room and can mix safely.
    const has18 = scored.filter((r) => r.holes.length === 18);
    const overallGross = avg(has18.map((r) => roundTotals(r).gross));
    const overallToPar = avg(has18.map((r) => roundTotals(r).toPar));
    // Most cards only have meaning with ≥4 18-hole rounds.
    const enoughFor18 = has18.length >= 4;

    function card(id, label, value, sub, context) {
      out.push({ id, label, value, sub: sub || "", context: context || "" });
    }

    function compareSubset(predicate, opts) {
      if (!enoughFor18) return null;
      const subset = has18.filter(predicate);
      if (subset.length < (opts && opts.minCount ? opts.minCount : 2)) return null;
      const subsetAvg = avg(subset.map((r) => roundTotals(r).gross));
      const delta = overallGross != null ? subsetAvg - overallGross : null;
      const sub = delta != null
        ? `${delta < 0 ? "−" : "+"}${Math.abs(delta).toFixed(1)} vs your 18-hole avg`
        : "";
      const value = `${fmt1(subsetAvg)} avg gross`;
      const context = `${subset.length} of ${has18.length} 18-hole rounds`;
      return { value, sub, context };
    }

    // All subset comparisons restrict to 18-hole rounds via compareSubset.

    (() => {
      const r = compareSubset((r) =>
        r.holes.filter((h) => Number.isFinite(h.score) && Number.isFinite(h.par) && h.score <= h.par).length >= 8
      );
      if (r) card("pars-8plus", "Rounds with ≥8 pars", r.value, r.sub, r.context);
    })();

    (() => {
      const r = compareSubset((r) =>
        r.holes.every((h) => !Number.isFinite(h.score) || h.score <= 0 || !Number.isFinite(h.par) || h.score - h.par < 3)
      );
      if (r) card("no-triples", "Rounds with no triple+ bogeys", r.value, r.sub, r.context);
    })();

    (() => {
      const r = compareSubset((r) =>
        r.holes.every((h) => !Number.isFinite(h.penalties) || h.penalties === 0)
      );
      if (r) card("no-pen", "Penalty-free rounds", r.value, r.sub, r.context);
    })();

    (() => {
      const r = compareSubset((r) =>
        r.holes.filter((h) => Number.isFinite(h.score) && Number.isFinite(h.par) && h.score <= h.par - 1).length >= 3
      );
      if (r) card("birdies-3plus", "Rounds with ≥3 birdies", r.value, r.sub, r.context);
    })();

    (() => {
      const r = compareSubset((r) =>
        r.holes.every((h) => !Number.isFinite(h.putts) || h.putts < 3)
      );
      if (r) card("no-3putt", "No-3-putt rounds", r.value, r.sub, r.context);
    })();

    // Average gross by month — 18-hole rounds only (see overallGross note).
    (() => {
      if (!enoughFor18) return;
      const byMonth = new Map();
      has18.forEach((r) => {
        if (!r.date) return;
        const m = r.date.slice(0, 7); // YYYY-MM
        if (!byMonth.has(m)) byMonth.set(m, []);
        byMonth.get(m).push(roundTotals(r).gross);
      });
      if (!byMonth.size) return;
      const months = [...byMonth.entries()]
        .map(([m, scores]) => ({ m, avg: avg(scores), count: scores.length }))
        .filter((x) => x.count >= 2);
      if (months.length < 2) return;
      months.sort((a, b) => a.avg - b.avg);
      const best = months[0];
      const worst = months[months.length - 1];
      const monthName = (m) => {
        try {
          const date = new Date(m + "-01T00:00:00");
          return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
        } catch { return m; }
      };
      card("best-month", "Best scoring month (18-hole)",
        `${fmt1(best.avg)} avg gross`,
        `${best.count} round${best.count === 1 ? "" : "s"}`,
        monthName(best.m));
      if (best.m !== worst.m) {
        card("worst-month", "Toughest scoring month (18-hole)",
          `${fmt1(worst.avg)} avg gross`,
          `${worst.count} round${worst.count === 1 ? "" : "s"}`,
          monthName(worst.m));
      }
    })();

    // Average gross by wind condition — 18-hole rounds only.
    (() => {
      if (!enoughFor18) return;
      const byWind = new Map();
      has18.forEach((r) => {
        const w = r.wind || "(no wind logged)";
        if (!byWind.has(w)) byWind.set(w, []);
        byWind.get(w).push(roundTotals(r).gross);
      });
      const entries = [...byWind.entries()].filter(([, scores]) => scores.length >= 2);
      if (entries.length < 2) return;
      entries.sort((a, b) => avg(a[1]) - avg(b[1]));
      const best = entries[0];
      card("wind-best", "You score best when wind is",
        `${fmt1(avg(best[1]))} avg gross`,
        `${best[1].length} 18-hole round${best[1].length === 1 ? "" : "s"}`,
        best[0] === "(no wind logged)" ? "wind unlogged" : formatWind(best[0]));
    })();

    // Same-course progression — 18-hole only. For any physical course with
    // ≥10 18-hole rounds, compare avg of first 5 vs last 5 to surface
    // "are you getting better?".
    (() => {
      const byPhysical = new Map();
      has18.forEach((r) => {
        const c = getCourse(r.courseId);
        if (!c) return;
        const key = c.name;
        if (!byPhysical.has(key)) byPhysical.set(key, []);
        byPhysical.get(key).push(r);
      });
      let bestProgress = null;
      byPhysical.forEach((rs, name) => {
        if (rs.length < 10) return;
        const chrono = [...rs].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
        const first5 = chrono.slice(0, 5);
        const last5 = chrono.slice(-5);
        const firstAvg = avg(first5.map((r) => roundTotals(r).gross));
        const lastAvg = avg(last5.map((r) => roundTotals(r).gross));
        const improvement = firstAvg - lastAvg; // positive = improved
        if (bestProgress == null || Math.abs(improvement) > Math.abs(bestProgress.improvement)) {
          bestProgress = { name, firstAvg, lastAvg, improvement, total: chrono.length };
        }
      });
      if (bestProgress) {
        const dir = bestProgress.improvement > 0 ? "better" : "worse";
        card("course-progression",
          `Same-course progression: ${bestProgress.name}`,
          `${dir === "better" ? "−" : "+"}${Math.abs(bestProgress.improvement).toFixed(1)} ${dir}`,
          `first 5: ${fmt1(bestProgress.firstAvg)} · last 5: ${fmt1(bestProgress.lastAvg)}`,
          `${bestProgress.total} 18-hole rounds here`);
      }
    })();

    // Top tagged-play comparison (only if tags exist) — 18-hole only.
    (() => {
      if (!enoughFor18) return;
      const tagged = has18.filter((r) => r.tag);
      const untagged = has18.filter((r) => !r.tag);
      if (!tagged.length) return;
      const byTag = new Map();
      tagged.forEach((r) => {
        if (!byTag.has(r.tag)) byTag.set(r.tag, []);
        byTag.get(r.tag).push(roundTotals(r).gross);
      });
      const entries = [...byTag.entries()].filter(([, xs]) => xs.length >= 2);
      if (!entries.length) return;
      entries.sort((a, b) => avg(a[1]) - avg(b[1]));
      const best = entries[0];
      const ref = untagged.length >= 2 ? avg(untagged.map((r) => roundTotals(r).gross)) : overallGross;
      const refLabel = untagged.length >= 2 ? "vs untagged" : "vs overall";
      const delta = avg(best[1]) - ref;
      const deltaText = `${delta < 0 ? "−" : "+"}${Math.abs(delta).toFixed(1)} ${refLabel}`;
      card("tag-best", `Best play type: ${formatRoundTag(best[0])}`,
        `${fmt1(avg(best[1]))} avg gross`, deltaText,
        `${best[1].length} 18-hole round${best[1].length === 1 ? "" : "s"}`);
    })();

    // Headline: 18-hole avg as a sanity check on the rest of the cards.
    if (overallGross != null) {
      card("overall-avg", "Overall average (18-hole)",
        `${fmt1(overallGross)} avg gross`,
        `${overallToPar != null ? fmtSigned(overallToPar) + " vs par" : ""}`,
        `${has18.length} 18-hole round${has18.length === 1 ? "" : "s"}`);
    }

    return out;
  }

  function renderStatsExplorer() {
    if (!els.statsExplorerGrid) return;
    const cards = computeStatsExplorer(state.rounds);
    if (els.statsExplorerNote) {
      els.statsExplorerNote.textContent = cards.length
        ? `${cards.length} insight${cards.length === 1 ? "" : "s"} from ${state.rounds.length} round${state.rounds.length === 1 ? "" : "s"}`
        : "";
    }
    if (!cards.length) {
      els.statsExplorerGrid.innerHTML = emptyState("Save more rounds and the explorer will fill in.");
      return;
    }
    els.statsExplorerGrid.innerHTML = cards.map((c) => `
      <article class="stats-card">
        <span class="stats-card-label">${escapeHtml(c.label)}</span>
        <strong class="stats-card-value">${escapeHtml(c.value)}</strong>
        ${c.sub ? `<span class="stats-card-sub">${escapeHtml(c.sub)}</span>` : ""}
        ${c.context ? `<span class="stats-card-context">${escapeHtml(c.context)}</span>` : ""}
      </article>`).join("");
  }

  function renderTrophyRoom() {
    if (!els.trophyRoomGrid) return;
    const trophies = computeTrophies(state.rounds);
    if (els.trophyRoomNote) {
      els.trophyRoomNote.textContent = trophies.length
        ? `${trophies.length} record${trophies.length === 1 ? "" : "s"} across ${state.rounds.length} round${state.rounds.length === 1 ? "" : "s"}`
        : "";
    }
    if (!trophies.length) {
      els.trophyRoomGrid.innerHTML = emptyState("Save a few rounds and your personal bests will show up here.");
      return;
    }
    els.trophyRoomGrid.innerHTML = trophies.map((t) => `
      <article class="trophy-card${t.roundId ? " trophy-card-tap" : ""}"${t.roundId ? ` data-trophy-round="${escapeHtml(t.roundId)}"` : ""}>
        <span class="trophy-card-label">${escapeHtml(t.label)}</span>
        <strong class="trophy-card-value">${escapeHtml(t.value)}</strong>
        ${t.sub ? `<span class="trophy-card-sub">${escapeHtml(t.sub)}</span>` : ""}
        ${t.context ? `<span class="trophy-card-context">${escapeHtml(t.context)}</span>` : ""}
      </article>`).join("");
    els.trophyRoomGrid.querySelectorAll("[data-trophy-round]").forEach((card) => {
      card.addEventListener("click", () => {
        const round = state.rounds.find((r) => r.id === card.dataset.trophyRound);
        if (!round) {
          showToast("Round not found.");
          return;
        }
        showRoundDetail(round);
      });
    });
  }

  // Profile tab — bag editor. Each known club is a toggleable pill; the
  // active set is state.profile.bag. Other surfaces (in-round pickers,
  // seeded defaults) consult getBag()/clubsForHole() so changes here
  // propagate without their own state.
  function renderProfileBag() {
    if (!els.profileBagGrid) return;
    const bag = new Set(getBag());
    els.profileBagGrid.innerHTML = CLUB_OPTIONS.map((club) => {
      const active = bag.has(club);
      return `<button type="button" class="pill pill-club${active ? " active" : ""}" data-bag-toggle="${escapeHtml(club)}" aria-pressed="${active}">${escapeHtml(club)}</button>`;
    }).join("");
    if (els.profileBagSummary) {
      els.profileBagSummary.textContent = `${bag.size} of ${CLUB_OPTIONS.length} clubs in your bag.`;
    }
  }

  // Re-render every club picker that's currently in the DOM so a bag change
  // is reflected immediately if the user is mid-round.
  function refreshBagDependentUi() {
    if (!els.scorecardGrid) return;
    els.scorecardGrid.querySelectorAll(".card-clubs-row[data-hole]").forEach((row) => {
      const holeNumber = Number(row.dataset.hole);
      row.outerHTML = renderClubsHitPills({ number: holeNumber });
    });
    els.scorecardGrid.querySelectorAll(".card-penalty-club-row[data-hole]").forEach((row) => {
      const holeNumber = Number(row.dataset.hole);
      row.outerHTML = renderPenaltyClubRow({ number: holeNumber });
    });
    syncPenaltyClubRows();
  }

  function toggleClubInBag(club) {
    if (!CLUB_OPTIONS.includes(club)) return;
    const bag = getBag().slice();
    const idx = bag.indexOf(club);
    if (idx >= 0) {
      // Refuse to remove the last club — empty bag has no useful behaviour.
      if (bag.length <= 1) {
        showToast("Your bag needs at least one club.");
        return;
      }
      bag.splice(idx, 1);
    } else {
      bag.push(club);
    }
    state.profile.bag = bag;
    saveState();
    renderProfileBag();
    refreshBagDependentUi();
  }

  function resetBagToAll() {
    state.profile.bag = [...CLUB_OPTIONS];
    saveState();
    renderProfileBag();
    refreshBagDependentUi();
    showToast("Bag reset to all clubs.");
  }

  // Home-tab structure: a chip strip at the top swaps between four thematic
  // sections — Overview / Trends / Holes / Clubs. Each panel is tagged with
  // a data-home-section matching one of those, and a CSS rule hides panels
  // outside the active section. The active chip persists per user.
  const HOME_SECTION_BY_PANEL_ID = {
    "recent-scorecards": "overview",
    "recent-rounds": "trends",
    "handicap-calculator": "trends",
    "strokes-gained": "trends",
    "heatmap": "holes",
    "scoring-distribution": "holes",
    "par-3-4-5": "holes",
    "scoring-by-course": "holes",
    "scoring-by-nine": "holes",
    "tee-club-performance": "clubs",
    "putting-by-distance": "clubs",
    "scrambling": "clubs",
    "trophy-room": "records"
    // "stats-explorer": "explorer" — Explorer chip + panel temporarily
    // removed from Home (Jeff: "don't really like it right now"). The
    // computeStatsExplorer / renderStatsExplorer functions stay as dead
    // code so it's a one-line revival when we revisit.
  };
  const HOME_SECTIONS = ["overview", "trends", "holes", "clubs", "records"];
  const HOME_SECTION_KEY = "fairwayLedger.homeSection.v1";
  const HOME_SUBSECTIONS_KEY = "fairwayLedger.homeSubsections.v1";
  // First sub-chip the user lands on when entering a section with no prior
  // preference. Overview deliberately has no subsections (KPIs + Recent
  // Scorecards form a single combined view).
  const SUBSECTION_DEFAULTS = {
    trends: "recent-rounds",
    holes: "heatmap",
    clubs: "tee-club-performance"
  };

  let activeHomeSection = (() => {
    try {
      const saved = localStorage.getItem(HOME_SECTION_KEY);
      return HOME_SECTIONS.includes(saved) ? saved : "overview";
    } catch { return "overview"; }
  })();

  let activeHomeSubsections = (() => {
    try {
      const raw = localStorage.getItem(HOME_SUBSECTIONS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch { return {}; }
  })();

  function getActiveSubsection(section) {
    if (!SUBSECTION_DEFAULTS[section]) return null;
    return activeHomeSubsections[section] || SUBSECTION_DEFAULTS[section];
  }

  function setActiveSubsection(section, subsection) {
    activeHomeSubsections[section] = subsection;
    try { localStorage.setItem(HOME_SUBSECTIONS_KEY, JSON.stringify(activeHomeSubsections)); } catch {}
    applyHomeSectionUi();
  }

  function tagHomePanelsWithSections() {
    document.querySelectorAll('.tab-panel[data-tab-panel="home"] .panel').forEach((panel) => {
      const id = getPanelId(panel);
      if (!id) return;
      const section = HOME_SECTION_BY_PANEL_ID[id];
      if (section) panel.dataset.homeSection = section;
      // Within Trends/Holes/Clubs, each panel's panel-id is its subsection
      // identifier. Sub-chip targets match these.
      panel.dataset.homeSubsection = id;
    });
  }

  function applyHomeSectionUi() {
    const homeTab = document.querySelector('[data-tab-panel="home"]');
    const activeSub = getActiveSubsection(activeHomeSection);
    if (homeTab) {
      homeTab.dataset.activeSection = activeHomeSection;
      if (activeSub) homeTab.dataset.activeSubsection = activeSub;
      else delete homeTab.dataset.activeSubsection;
    }
    // Top chips
    document.querySelectorAll(".home-chip").forEach((chip) => {
      const active = chip.dataset.homeSectionTarget === activeHomeSection;
      chip.classList.toggle("active", active);
      chip.setAttribute("aria-selected", String(active));
    });
    // Sub-chips: mark the active one (only visible when its parent nav's
    // data-home-section matches activeHomeSection — handled by the same
    // CSS rule that hides non-matching data-home-section elements).
    document.querySelectorAll(".home-subchip").forEach((chip) => {
      const isActive = !!activeSub && chip.dataset.homeSubsectionTarget === activeSub;
      chip.classList.toggle("active", isActive);
      chip.setAttribute("aria-selected", String(isActive));
    });
    // Hide every subsection-tagged element that doesn't match the active
    // sub-chip. Elements without data-home-subsection (like the toolbar)
    // stay visible.
    document.querySelectorAll("[data-home-subsection]").forEach((el) => {
      el.classList.toggle("subsection-hidden", !!activeSub && el.dataset.homeSubsection !== activeSub);
    });
  }

  function setActiveHomeSection(section) {
    if (!HOME_SECTIONS.includes(section)) section = "overview";
    activeHomeSection = section;
    try { localStorage.setItem(HOME_SECTION_KEY, section); } catch {}
    applyHomeSectionUi();
  }

  // Filters live in a bottom sheet, opened from a small icon button in the
  // chip strip. A gold dot on the icon shows when any filter is non-default.
  function openFiltersSheet() {
    if (!els.filtersSheetOverlay) return;
    els.filtersSheetOverlay.hidden = false;
    document.body.classList.add("hole-picker-open");
    if (els.filtersSheetClose) els.filtersSheetClose.focus();
  }

  function closeFiltersSheet() {
    if (!els.filtersSheetOverlay) return;
    els.filtersSheetOverlay.hidden = true;
    document.body.classList.remove("hole-picker-open");
  }

  function updateFiltersButtonState() {
    if (!els.homeFiltersButton) return;
    const courseVal = els.filterCourse ? els.filterCourse.value : "all";
    const teeVal = els.filterTee ? els.filterTee.value : "all";
    const windowVal = els.filterWindow ? els.filterWindow.value : "all";
    const tagVal = els.filterTag ? els.filterTag.value : "all";
    const hasActive = (courseVal && courseVal !== "all")
      || (teeVal && teeVal !== "all")
      || (windowVal && windowVal !== "all")
      || (tagVal && tagVal !== "all");
    els.homeFiltersButton.classList.toggle("has-active-filter", hasActive);
  }

  function resetAllFilters() {
    if (els.filterCourse) els.filterCourse.value = "all";
    if (els.filterTee) els.filterTee.value = "all";
    if (els.filterWindow) els.filterWindow.value = "all";
    if (els.filterTag) els.filterTag.value = "all";
    // Fire a single change event — the existing handler re-reads all of them.
    if (els.filterCourse) els.filterCourse.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Derive a stable panel identifier from its h2 text — used by both the
  // chip nav (to assign panels to sections) and any future per-panel feature.
  function getPanelId(panel) {
    if (panel.dataset.panelId) return panel.dataset.panelId;
    const h2 = panel.querySelector(".panel-heading h2");
    if (!h2) return null;
    const id = h2.textContent.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    panel.dataset.panelId = id;
    return id;
  }

  function renderCourseList() {
    // Sort so courses you've actually played show first, but every course is
    // visible (including Deerwood layouts you haven't logged a round on) so
    // hazards can be edited for any of them.
    const visibleCourses = [...state.courses].sort((a, b) => {
      const aRounds = state.rounds.filter((r) => r.courseId === a.id).length;
      const bRounds = state.rounds.filter((r) => r.courseId === b.id).length;
      if (aRounds !== bRounds) return bRounds - aRounds;
      return a.name.localeCompare(b.name);
    });
    if (!selectedCourseDetailId && visibleCourses[0]) selectedCourseDetailId = visibleCourses[0].id;

    const rows = visibleCourses.map((course) => {
      const par = course.holes.reduce((sum, hole) => sum + hole.par, 0);
      const yards = course.holes.reduce((sum, hole) => sum + Number(hole.yards || 0), 0);
      const rounds = state.rounds.filter((round) => round.courseId === course.id).length;
      const ratingSlope = course.rating && course.slope ? `rating ${course.rating.toFixed(1)} | slope ${course.slope}` : "rating/slope needed";
      return `
        <div class="course-row ${selectedCourseDetailId === course.id ? "selected" : ""}">
          <div>
            <strong>${escapeHtml(course.name)} (${escapeHtml(course.tee)})</strong>
            <span class="subtext">${course.holes.length} holes | par ${par} | ${yards || "--"} yds | ${ratingSlope} | ${rounds} rounds</span>
          </div>
          <div class="row-actions">
            <button type="button" data-view-course="${course.id}">View</button>
            <button type="button" data-delete-course="${course.id}">Delete</button>
          </div>
        </div>`;
    }).join("");

    els.courseList.innerHTML = rows || emptyState("No saved courses yet. Add one from the course catalog or look one up.");
    els.courseList.querySelectorAll("[data-view-course]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedCourseDetailId = button.dataset.viewCourse;
        renderCourseList();
        renderCourseDetail();
      });
    });
    els.courseList.querySelectorAll("[data-delete-course]").forEach((button) => {
      button.addEventListener("click", () => {
        const courseId = button.dataset.deleteCourse;
        const hasRounds = state.rounds.some((round) => round.courseId === courseId);
        if (hasRounds && !window.confirm("Delete this course and its rounds?")) return;
        state.courses = state.courses.filter((course) => course.id !== courseId);
        state.rounds = state.rounds.filter((round) => round.courseId !== courseId);
        saveState();
        renderAll();
        showToast("Course deleted.");
      });
    });
    renderCourseDetail();
  }

  function renderCourseDetail() {
    const course = getCourse(selectedCourseDetailId) || state.courses[0];
    if (!course) {
      els.courseDetail.innerHTML = emptyState("Select a course to view details.");
      return;
    }
    selectedCourseDetailId = course.id;
    const rounds = state.rounds.filter((round) => round.courseId === course.id);
    const par = course.holes.reduce((sum, hole) => sum + hole.par, 0);
    const yards = course.holes.reduce((sum, hole) => sum + Number(hole.yards || 0), 0);
    const totals = rounds.map(roundTotals);
    const holeGroups = getHoleGroups(rounds);
    const holeRows = course.holes.map((hole) => {
      const stats = holeGroups.find((group) => group.number === hole.number);
      const hazards = Array.isArray(hole.hazards) ? hole.hazards : [];
      const hazardCountLabel = hazards.length
        ? `<span class="hazard-count">${hazards.length} hazard${hazards.length === 1 ? "" : "s"}</span>`
        : `<span class="hazard-count hazard-count-empty">+ add hazard</span>`;
      const chipsHtml = hazards.length
        ? `<ul class="hazard-chip-list">${hazards.map((hazard) => renderHazardChip(hazard, { editable: true })).join("")}</ul>`
        : `<p class="hazard-empty">No hazards recorded yet. Add water, bunkers, OB, or strategy notes that you want to see every time you play this hole.</p>`;
      return `
        <details class="course-hole-block" data-hole-number="${hole.number}">
          <summary class="course-hole-row">
            <strong>${escapeHtml(hole.label || `#${hole.number}`)}</strong>
            <span>Par ${hole.par}</span>
            <span>${hole.yards || "--"} yds</span>
            <span>HCP ${hole.hcp || "--"}</span>
            <span>${stats ? `${stats.avgScore.toFixed(2)} avg` : "-- avg"}</span>
            <span>${stats ? `${formatSigned(stats.avgToPar)} to par` : "--"}</span>
            ${hazardCountLabel}
          </summary>
          <div class="course-hole-hazards">
            ${chipsHtml}
            <form class="hazard-form" data-add-hazard data-hole-number="${hole.number}">
              <select class="hazard-form-type" name="type" aria-label="Hazard type" required>
                ${HAZARD_TYPES.map((t) => `<option value="${t.value}">${t.icon} ${t.label}</option>`).join("")}
              </select>
              <select class="hazard-form-side" name="side" aria-label="Side">
                <option value="">Side…</option>
                ${HAZARD_SIDES.map((s) => `<option value="${s.value}">${s.label}</option>`).join("")}
              </select>
              <input class="hazard-form-carry" name="carryYards" type="number" inputmode="numeric" min="0" max="700" placeholder="Carry yds">
              <input class="hazard-form-note" name="note" type="text" maxlength="80" placeholder="Note (optional)">
              <button class="hazard-form-add" type="submit">Add</button>
            </form>
          </div>
        </details>`;
    }).join("");

    els.courseDetail.innerHTML = `
      <div class="course-profile-hero">
        <div>
          <p class="eyebrow">${escapeHtml(course.tee)} tees</p>
          <h3>${escapeHtml(course.name)}</h3>
        </div>
        <div class="course-profile-score">${rounds.length}<span>rounds</span></div>
      </div>
      <div class="course-profile-grid">
        <div><span>Par</span><strong>${par}</strong></div>
        <div><span>Yards</span><strong>${yards || "--"}</strong></div>
        <div><span>Rating</span><strong>${course.rating ? course.rating.toFixed(1) : "--"}</strong></div>
        <div><span>Slope</span><strong>${course.slope || "--"}</strong></div>
        <div><span>Avg</span><strong>${totals.length ? average(totals.map((item) => item.gross)).toFixed(1) : "--"}</strong></div>
        <div><span>Best</span><strong>${totals.length ? Math.min(...totals.map((item) => item.gross)) : "--"}</strong></div>
      </div>
      <div class="course-hole-table">${holeRows}</div>
    `;
  }

  // ---- Online course search (GolfCourseAPI) -------------------------------
  //
  // Searches ~30k real courses with full per-tee scorecards (par, yardage,
  // handicap, rating, slope) via golfcourseapi.com. Free tier is 50
  // requests/day with an email-only signup; the key lives in localStorage
  // and every request goes straight from the browser to the API — no
  // backend, consistent with the rest of the app.

  const COURSE_API_KEY_STORAGE = "fairwayLedger.courseApiKey.v1";
  const COURSE_API_BASE = "https://api.golfcourseapi.com";

  function getCourseApiKey() {
    try { return localStorage.getItem(COURSE_API_KEY_STORAGE) || ""; } catch { return ""; }
  }

  function setCourseApiKey(key) {
    try {
      if (key) localStorage.setItem(COURSE_API_KEY_STORAGE, key);
      else localStorage.removeItem(COURSE_API_KEY_STORAGE);
    } catch {}
  }

  function courseSlug(text) {
    return String(text).toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  // Map one GolfCourseAPI course → one catalog entry per tee set (matches
  // how the built-in catalog models tee variants: Harvest Hill has five
  // entries sharing a name). Female tee sets get the tee name suffixed so
  // "White" men's and "White" women's don't collide.
  function normalizeApiCourse(api) {
    const clubName = (api.club_name || "").trim();
    const courseName = (api.course_name || "").trim();
    const displayName = !courseName || courseName === clubName
      ? clubName
      : `${clubName} — ${courseName}`;
    if (!displayName) return null;
    const location = [api.location && api.location.city, api.location && api.location.state]
      .filter(Boolean).join(", ");
    const entries = [];
    const buildEntries = (sets, suffix) => {
      (Array.isArray(sets) ? sets : []).forEach((tee) => {
        if (!tee || !Array.isArray(tee.holes) || !tee.holes.length) return;
        const teeName = `${tee.tee_name || "Standard"}${suffix}`;
        entries.push({
          id: `${courseSlug(displayName)}-${courseSlug(teeName)}`,
          name: displayName,
          tee: teeName,
          rating: Number.isFinite(tee.course_rating) ? tee.course_rating : null,
          slope: Number.isFinite(tee.slope_rating) ? tee.slope_rating : null,
          holes: tee.holes.map((hole, index) => ({
            number: index + 1,
            par: Number.isFinite(hole.par) ? hole.par : 4,
            yards: Number.isFinite(hole.yardage) ? hole.yardage : 0,
            hcp: Number.isFinite(hole.handicap) ? hole.handicap : null
          }))
        });
      });
    };
    buildEntries(api.tees && api.tees.male, "");
    buildEntries(api.tees && api.tees.female, " (W)");
    if (!entries.length) return null;
    const first = entries[0];
    const par = first.holes.reduce((sum, hole) => sum + hole.par, 0);
    const yards = first.holes.reduce((sum, hole) => sum + Number(hole.yards || 0), 0);
    return {
      id: `api-${api.id}`,
      name: displayName,
      location,
      summary: `${first.holes.length} holes · par ${par}${yards ? ` · ${yards} yds` : ""} · ${entries.length} tee set${entries.length === 1 ? "" : "s"}`,
      kind: "api",
      courses: entries
    };
  }

  // findCourses returns { results, notice } — notice is a user-readable
  // string explaining why online results may be missing (no key, bad key,
  // rate limit, network). Catalog matches always append.
  async function findCourses(query) {
    const { results: apiResults, notice } = await findCoursesFromApi(query);
    const catalogResults = findCoursesFromCatalog(query);
    // Drop catalog hits that duplicate an API hit by name.
    const apiNames = new Set(apiResults.map((r) => r.name.toLowerCase()));
    const merged = [
      ...apiResults,
      ...catalogResults.filter((r) => !apiNames.has((r.name || "").toLowerCase()))
    ];
    return { results: merged, notice };
  }

  async function findCoursesFromApi(query) {
    const key = getCourseApiKey();
    if (!key) {
      return {
        results: [],
        notice: "needs-key"
      };
    }
    try {
      const response = await fetch(`${COURSE_API_BASE}/v1/search?search_query=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Key ${key}` }
      });
      if (response.status === 401 || response.status === 403) {
        return { results: [], notice: "That API key was rejected — double-check it in Profile → Course search." };
      }
      if (response.status === 429) {
        return { results: [], notice: "Daily search limit reached (50/day on the free plan). Try again tomorrow." };
      }
      if (!response.ok) {
        return { results: [], notice: `Course service error (${response.status}). Try again in a minute.` };
      }
      const payload = await response.json();
      const list = payload && Array.isArray(payload.courses) ? payload.courses : [];
      return { results: list.map(normalizeApiCourse).filter(Boolean).slice(0, 12), notice: null };
    } catch (error) {
      return {
        results: [],
        notice: "Couldn't reach the course service — check your connection. Saved-course search still works below."
      };
    }
  }

  function findCoursesFromCatalog(query) {
    const haystack = query.toLowerCase();
    const results = [];
    if (["deerwood", "north tonawanda", "tonawanda", "sweeney"].some((term) => haystack.includes(term))) {
      results.push({
        id: DEERWOOD_COURSE_ID,
        name: "Deerwood Golf Course",
        location: "North Tonawanda, NY",
        summary: "Buck, Doe, and Fawn layouts | White and Blue tees",
        kind: "deerwood"
      });
    }

    state.courses
      .filter((course) => !isDeerwoodCourseId(course.id))
      .filter((course) => `${course.name} ${course.tee}`.toLowerCase().includes(haystack))
      .forEach((course) => {
        results.push({
          id: course.id,
          name: course.name,
          location: course.tee,
          summary: `${course.holes.length} holes | par ${course.holes.reduce((sum, hole) => sum + hole.par, 0)}`,
          kind: "saved",
          courses: [course]
        });
      });

    return results;
  }

  function normalizeLookupResult(result) {
    if (!result || !result.name) return undefined;
    if (result.id === DEERWOOD_COURSE_ID || result.kind === "deerwood") {
      return {
        id: DEERWOOD_COURSE_ID,
        name: "Deerwood Golf Course",
        location: result.location || "North Tonawanda, NY",
        summary: result.summary || "Buck, Doe, and Fawn layouts | White and Blue tees",
        kind: "deerwood"
      };
    }
    if (!Array.isArray(result.courses)) return undefined;
    const courses = result.courses.filter((course) => {
      return course.id && course.name && course.tee && Array.isArray(course.holes);
    });
    if (!courses.length) return undefined;
    return {
      id: result.id || courses[0].id,
      name: result.name,
      location: result.location || courses[0].tee,
      summary: result.summary || `${courses.length} tee option${courses.length === 1 ? "" : "s"}`,
      kind: "course",
      courses
    };
  }

  function renderCourseLookupResults(results, query, notice) {
    // "needs-key" is the one-time setup callout; anything else is a plain
    // status line (rate limit, bad key, offline).
    const noticeHtml = notice === "needs-key"
      ? `<div class="lookup-notice">
          <strong>Search 30,000 real courses with full scorecards.</strong>
          <span>One-time setup: grab a free API key (email only, ~30 seconds) at
          <a href="https://golfcourseapi.com" target="_blank" rel="noopener">golfcourseapi.com</a>,
          then paste it in <button type="button" class="link-course" data-go-course-key="1">Profile → Course search</button>.
          Until then, search covers your saved courses only.</span>
        </div>`
      : notice
        ? `<div class="lookup-notice"><span>${escapeHtml(notice)}</span></div>`
        : "";

    if (!results.length) {
      els.courseLookupResults.innerHTML = noticeHtml + emptyState(`No scorecard match for "${escapeHtml(query)}".`);
      return;
    }

    els.courseLookupResults.innerHTML = noticeHtml + results.map((result) => `
      <div class="lookup-row">
        <div>
          <strong>${escapeHtml(result.name)}</strong>
          <span class="subtext">${escapeHtml([result.location, result.summary].filter(Boolean).join(" | "))}</span>
        </div>
        <button type="button" data-lookup-course="${escapeHtml(result.id)}">${result.kind === "api" ? "Add" : "Use"}</button>
      </div>
    `).join("");

    els.courseLookupResults.querySelectorAll("[data-lookup-course]").forEach((button) => {
      button.addEventListener("click", () => {
        const result = results.find((candidate) => candidate.id === button.dataset.lookupCourse);
        if (!result) return;
        useLookupResult(result);
      });
    });
  }

  function useLookupResult(result) {
    if (result.kind === "deerwood") {
      els.roundCourse.value = DEERWOOD_COURSE_ID;
      els.roundHoleCount.value = "18";
      els.roundTee.value = "White";
      renderRoundSetupOptions();
      renderScorecard(getSelectedRoundCourse());
      setActiveTab("rounds");
      showToast("Deerwood selected.");
      return;
    }

    result.courses.forEach(ensureSavedCourse);
    saveState();
    renderAll();
    els.roundCourse.value = result.courses[0].id;
    renderRoundSetupOptions();
    renderScorecard(getSelectedRoundCourse());
    setActiveTab("rounds");
    showToast("Course added from lookup.");
  }

  function renderTrend(rounds) {
    const ordered = [...rounds].sort((a, b) => a.date.localeCompare(b.date)).slice(-12);
    if (!ordered.length) {
      els.trendChart.innerHTML = emptyState("Need at least 2 rounds to plot a trend.", { action: "rounds" });
      return;
    }

    const values = ordered.map((round) => roundTotals(round).toPar);
    const maxAbs = Math.max(4, ...values.map((value) => Math.abs(value)));
    const bars = ordered.map((round, index) => {
      const total = roundTotals(round);
      const height = Math.max(4, Math.round((Math.abs(total.toPar) / maxAbs) * 124));
      const goodClass = total.toPar <= 0 ? "good" : "";
      // The most recent round is THE bar the user came to see — give it
      // the emphasis treatment (gold cap + bolder label via CSS).
      const latestClass = index === ordered.length - 1 ? " is-latest" : "";
      return `
        <div class="trend-item${latestClass}">
          <div class="trend-value">${formatSigned(total.toPar, 0)}</div>
          <div class="trend-column"><div class="trend-bar ${goodClass}" style="height:${height}px"></div></div>
          <div class="trend-date">${round.date.slice(5)}<br>${total.gross}</div>
        </div>`;
    }).join("");

    els.trendChart.innerHTML = `<div class="trend-bars" aria-label="Recent scoring trend">${bars}</div>`;
  }

  function renderAll() {
    renderSelectOptions();
    if (!els.roundDate.value) els.roundDate.value = today;
    // Note: roundCourse is intentionally NOT auto-defaulted to Deerwood.
    // Pre-Start-Round, the chips render blank by design; the underlying
    // select might still have a stale value, but the chip-row sync uses
    // setupChipRowsTapped to suppress "active" rendering.
    renderScorecard(getSelectedRoundCourse());
    applyRoundStartedUi();
    renderCourseBrief();
    const rounds = getFilteredRounds();
    renderMetrics(rounds);
    renderHomeInsights(rounds);
    renderHandicapPanel();
    renderTrend(rounds);
    renderCourseStats(rounds);
    renderDeerwoodByNine(rounds);
    renderParStats(rounds);
    renderHeatmap(rounds);
    renderStrokesGained(rounds);
    renderPuttingPanel(rounds);
    renderScoringDistribution(rounds);
    renderTeeClubPerformance(rounds);
    renderScramblingPanel(rounds);
    renderRecentRounds();
    updateBackupBadge();
    renderCourseList();
    renderGolfLab();
    renderProfileBag();
    renderTrophyRoom();
    renderStatsExplorer();
    renderSnapshotPanel();
    tagHomePanelsWithSections();
    applyHomeSectionUi();
    updateFiltersButtonState();
    // Show the welcome callout only when there are no rounds at all. Once
    // the user has logged a single round, the regular KPI tiles take over.
    if (els.welcomeCallout) {
      els.welcomeCallout.hidden = state.rounds.length > 0;
    }
    // Re-sync chip mirrors against any selects whose options or values
    // changed during this render pass (course list rebuild, layout swap,
    // tee re-pin, etc.).
    syncAllChipsToSelects();
    // If the drill-down sheet is open, refresh its contents against the
    // freshly-rendered data (e.g. after saving a new round).
    if (activeDrilldownPhysicalId && els.heatmapDrilldownOverlay && !els.heatmapDrilldownOverlay.hidden) {
      renderHeatmapDrilldown();
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function groupBy(items, getKey) {
    return items.reduce((groups, item) => {
      const key = getKey(item);
      groups[key] = groups[key] || [];
      groups[key].push(item);
      return groups;
    }, {});
  }

  // Empty state for a panel with nothing to show. Pass options.action with
  // a tab id ("rounds" / "courses" / "profile") to render a CTA button that
  // navigates there — the existing [data-tab-target] click delegation
  // handles the actual switch.
  function emptyState(message, options) {
    const action = options && options.action;
    const cta = action
      ? `<button type="button" class="empty-state-cta" data-tab-target="${escapeHtml(action)}">${escapeHtml(options.actionLabel || "Add a round")} &rarr;</button>`
      : "";
    return `<div class="empty-state">
      <div class="empty-state-message">${message}</div>
      ${cta}
    </div>`;
  }

  // ---- Golf Lab ----------------------------------------------------------
  //
  // Professional golf analytics live in state.golfLab and route through
  // lib/golf-lab.js. The UI below renders source-backed owned data only; no
  // sample pro players, fake tournaments, or placeholder betting cards.

  function normalizeGolfLabMarketKey(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  function golfLabMarketMatchesFilter(market, filter) {
    const target = normalizeGolfLabMarketKey(filter);
    if (!target || target === "all" || target === "allmarkets") return true;
    return normalizeGolfLabMarketKey(market) === target;
  }

  function golfLabMarketFilterLabel(value) {
    const target = normalizeGolfLabMarketKey(value);
    const option = GOLF_LAB_MARKET_FILTERS.find((item) => normalizeGolfLabMarketKey(item.value) === target);
    return option ? option.label : "All markets";
  }

  function golfLabMarketFilterNoun(value) {
    const target = normalizeGolfLabMarketKey(value);
    return !target || target === "all" || target === "allmarkets"
      ? "model"
      : golfLabMarketFilterLabel(value).toLowerCase();
  }

  function golfLabMarketOddsLabel(value) {
    const target = normalizeGolfLabMarketKey(value);
    return !target || target === "all" || target === "allmarkets"
      ? "market"
      : golfLabMarketFilterLabel(value).toLowerCase();
  }

  function clampGolfLabEdgeThreshold(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 1;
    return Math.max(0, Math.min(8, Math.round(numeric * 2) / 2));
  }

  function normalizeGolfLabModelSettings(raw = {}) {
    const preset = GOLF_LAB_MODEL_PRESETS[raw.preset] ? raw.preset : "balanced";
    const marketFilter = GOLF_LAB_MARKET_FILTERS.some((item) => item.value === raw.marketFilter)
      ? raw.marketFilter
      : "all";
    const weatherScenario = GOLF_LAB_WEATHER_SCENARIOS.some((item) => item.value === raw.weatherScenario)
      ? raw.weatherScenario
      : "baseline";
    return {
      preset,
      marketFilter,
      weatherScenario,
      edgeThreshold: clampGolfLabEdgeThreshold(raw.edgeThreshold)
    };
  }

  function readInitialGolfLabModelSettings() {
    try {
      return normalizeGolfLabModelSettings(JSON.parse(localStorage.getItem(GOLF_LAB_MODEL_SETTINGS_KEY) || "{}"));
    } catch {
      return normalizeGolfLabModelSettings();
    }
  }

  function saveGolfLabModelSettings() {
    try {
      localStorage.setItem(GOLF_LAB_MODEL_SETTINGS_KEY, JSON.stringify(golfLabModelSettings));
    } catch {}
  }

  function getGolfLabModelPreset() {
    return GOLF_LAB_MODEL_PRESETS[golfLabModelSettings.preset] || GOLF_LAB_MODEL_PRESETS.balanced;
  }

  function getGolfLabModelWeights() {
    return { ...getGolfLabModelPreset().weights };
  }

  function getGolfLabConsensusProfiles() {
    return Object.entries(GOLF_LAB_MODEL_PRESETS).map(([key, preset]) => ({
      key,
      label: preset.label,
      note: preset.note,
      weights: { ...preset.weights }
    }));
  }

  function getGolfLabWeatherScenarioLabel() {
    const scenario = GOLF_LAB_WEATHER_SCENARIOS.find((item) => item.value === golfLabModelSettings.weatherScenario);
    return scenario ? scenario.label : "Imported forecast";
  }

  function getGolfLabEdgeThresholdProbability() {
    return golfLabModelSettings.edgeThreshold / 100;
  }

  function formatGolfLabWeight(value) {
    return `${Math.round((Number(value) || 0) * 100)}%`;
  }

  function renderGolfLabWeightPreview() {
    const preset = getGolfLabModelPreset();
    const weights = getGolfLabModelWeights();
    const parts = [
      ["Skill", weights.skill],
      ["Form", weights.recentForm],
      ["Course", weights.courseFit],
      ["Difficulty", weights.difficultyFit],
      ["Weather", weights.weatherFit]
    ];
    return `${preset.note}: ${parts.map(([label, value]) => `${label} ${formatGolfLabWeight(value)}`).join(" | ")} | Scenario ${getGolfLabWeatherScenarioLabel()}`;
  }

  function syncGolfLabModelSettingsControls() {
    if (els.golfLabModelPreset) {
      els.golfLabModelPreset.innerHTML = Object.entries(GOLF_LAB_MODEL_PRESETS).map(([value, preset]) => `
        <option value="${escapeHtml(value)}"${value === golfLabModelSettings.preset ? " selected" : ""}>${escapeHtml(preset.label)}</option>
      `).join("");
    }
    if (els.golfLabMarketFilter) {
      els.golfLabMarketFilter.innerHTML = GOLF_LAB_MARKET_FILTERS.map((option) => `
        <option value="${escapeHtml(option.value)}"${option.value === golfLabModelSettings.marketFilter ? " selected" : ""}>${escapeHtml(option.label)}</option>
      `).join("");
    }
    if (els.golfLabWeatherScenario) {
      els.golfLabWeatherScenario.innerHTML = GOLF_LAB_WEATHER_SCENARIOS.map((option) => `
        <option value="${escapeHtml(option.value)}"${option.value === golfLabModelSettings.weatherScenario ? " selected" : ""}>${escapeHtml(option.label)}</option>
      `).join("");
    }
    if (els.golfLabEdgeThreshold) {
      els.golfLabEdgeThreshold.value = String(golfLabModelSettings.edgeThreshold);
    }
    if (els.golfLabEdgeThresholdValue) {
      els.golfLabEdgeThresholdValue.textContent = `${formatLabNumber(golfLabModelSettings.edgeThreshold, 1)} pp`;
    }
    if (els.golfLabModelWeights) {
      els.golfLabModelWeights.textContent = renderGolfLabWeightPreview();
    }
  }

  function updateGolfLabModelSettings(partial) {
    golfLabModelSettings = normalizeGolfLabModelSettings({ ...golfLabModelSettings, ...partial });
    saveGolfLabModelSettings();
    syncGolfLabModelSettingsControls();
    const lab = normalizeGolfLabState(state.golfLab);
    const warehouseReport = typeof buildWarehouseReport === "function" ? buildWarehouseReport(lab) : null;
    renderGolfLabCommandCenter(lab, warehouseReport);
    renderGolfLabActivationPlan(lab);
    renderGolfLabCoverageMap(lab);
    renderGolfLabSourceLineageBoard(lab);
    renderGolfLabSourceOpsBoard(lab);
    renderGolfLabDataIntakeBoard(lab);
    renderGolfLabSourceCatalogBoard(lab);
    renderGolfLabPlayerIdentityBoard(lab);
    renderGolfLabCourseSetupBoard(lab);
    renderGolfLabPlayerSplitLab(lab);
    renderGolfLabFeatureStoreBoard(lab);
    renderGolfLabFitBoard(lab);
    renderGolfLabFieldReadinessBoard(lab);
    renderGolfLabFieldIntelligenceBoard(lab);
    renderGolfLabConsensusBoard(lab);
    renderGolfLabFeatureSensitivityBoard(lab);
    renderGolfLabScenarioBoard(lab);
    renderGolfLabWeatherMatrixBoard(lab);
    renderGolfLabWeatherDrawBoard(lab);
    renderGolfLabPredictionLedger(lab);
    renderGolfLabPredictionPrepBoard(lab);
    renderGolfLabPredictionRunAuditBoard(lab);
    renderGolfLabModelRunHistoryBoard(lab);
    renderGolfLabMarketCoverageBoard(lab);
    renderGolfLabOddsMovementBoard(lab);
    renderGolfLabOddsShoppingBoard(lab);
    renderGolfLabEdgeBoard(lab);
    renderGolfLabBetPortfolioBoard(lab);
    renderGolfLabProjectedStandingsBoard(lab);
    renderGolfLabResultsSummaryBoard(lab);
    renderGolfLabModelExplainerBoard(lab);
    renderGolfLabSettlementBoard(lab);
    renderGolfLabBacktestPanel(lab);
    renderGolfLabTrainingDatasetBoard(lab);
    renderGolfLabModelCalibrationBoard(lab);
    renderGolfLabModelTuningBoard(lab);
  }

  function setGolfLabModelStatus(message) {
    if (!els.golfLabModelStatus) return;
    els.golfLabModelStatus.textContent = message;
  }

  function setGolfLabModelBusy(isBusy) {
    golfLabModelInFlight = isBusy;
    if (els.golfLabRunModel) {
      els.golfLabRunModel.disabled = isBusy;
      els.golfLabRunModel.textContent = isBusy ? "Modeling..." : "Run Owned Model";
    }
  }

  function golfLabModelLaunchBlocker(plan) {
    if (!plan || !plan.event) return null;
    const critical = (plan.nextActions || []).filter((row) => row.priority === "critical" && row.status === "blocked");
    if (!critical.length && !(plan.summary && plan.summary.criticalBlockers > 0)) return null;
    const labels = critical.map((row) => row.label).slice(0, 3);
    const next = critical[0] || (plan.nextActions || [])[0];
    return {
      labels,
      message: `Activation required before model run: ${labels.join(", ") || "critical source lanes"}.`,
      nextAction: next ? next.nextAction : ""
    };
  }

  function syncGolfLabModelLaunchState(plan) {
    if (!els.golfLabRunModel || golfLabModelInFlight) return;
    const blocker = golfLabModelLaunchBlocker(plan);
    if (blocker) {
      els.golfLabRunModel.disabled = true;
      setGolfLabModelStatus(`${blocker.message}${blocker.nextAction ? ` Next: ${blocker.nextAction}` : ""}`);
      return;
    }
    if (plan && plan.event) {
      els.golfLabRunModel.disabled = false;
      if (plan.status === "ready-to-model") {
        setGolfLabModelStatus(`Ready to run owned model for ${plan.event.name || plan.event.id}.`);
      } else if (plan.status === "premium-ready") {
        setGolfLabModelStatus(`Premium-ready model slate for ${plan.event.name || plan.event.id}.`);
      }
    }
  }

  function renderGolfLabSourceStatus(summary) {
    if (!els.golfLabSourceStatus) return;
    if (!summary || !summary.hasData) {
      els.golfLabSourceStatus.textContent = "Owned warehouse empty";
      return;
    }
    const sourceCount = summary.counts.sourceFetches || 0;
    const weatherCount = summary.counts.weatherSnapshots || 0;
    const sourceText = sourceCount === 1 ? "1 source row" : `${sourceCount} source rows`;
    const weatherText = weatherCount === 1 ? "1 weather snapshot" : `${weatherCount} weather snapshots`;
    els.golfLabSourceStatus.textContent = `${sourceText} | ${weatherText}`;
  }

  function renderGolfLabModelEventSelect(lab) {
    if (!els.golfLabModelEventSelect) return;
    const todayIso = new Date().toISOString().slice(0, 10);
    const events = [...lab.events].sort((a, b) => {
      const aDate = a.startDate || "9999-12-31";
      const bDate = b.startDate || "9999-12-31";
      return aDate.localeCompare(bDate) || (a.name || a.id).localeCompare(b.name || b.id);
    });
    if (!events.length) {
      els.golfLabModelEventSelect.innerHTML = `<option value="">No events imported</option>`;
      els.golfLabModelEventSelect.disabled = true;
      if (els.golfLabRunModel) els.golfLabRunModel.disabled = true;
      return;
    }
    els.golfLabModelEventSelect.disabled = false;
    if (els.golfLabRunModel && !golfLabModelInFlight) els.golfLabRunModel.disabled = false;
    const currentValue = els.golfLabModelEventSelect.value;
    const nextEvent = events.find((event) => !event.startDate || event.startDate >= todayIso) || events[0];
    const selectedValue = currentValue && events.some((event) => event.id === currentValue) ? currentValue : nextEvent.id;
    els.golfLabModelEventSelect.innerHTML = events.map((event) => {
      const label = [event.name || event.id, event.startDate, event.courseName].filter(Boolean).join(" | ");
      return `<option value="${escapeHtml(event.id)}"${event.id === selectedValue ? " selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
  }

  function applyGolfLabDataMerge(incomingLab, toastMessage) {
    const normalized = normalizeGolfLabState(incomingLab);
    if (!hasGolfLabData(normalized)) {
      throw new Error("No Golf Lab records were found.");
    }
    state.golfLab = mergeGolfLabStates(state.golfLab, normalized);
    const firstPlayer = state.golfLab.players[0];
    if (!selectedGolfLabPlayerId && firstPlayer) selectedGolfLabPlayerId = firstPlayer.id;
    saveState();
    renderGolfLab();
    showToast(toastMessage || "Golf Lab data updated.");
  }

  async function runGolfLabOwnedModel() {
    if (golfLabModelInFlight) return;
    if (typeof buildOwnedModelSnapshot !== "function") {
      showToast("Golf Lab model is not available.");
      return;
    }
    const eventId = els.golfLabModelEventSelect ? els.golfLabModelEventSelect.value : "";
    let launchPlan = null;
    if (typeof buildTournamentActivationPlan === "function") {
      launchPlan = buildTournamentActivationPlan(state.golfLab, {
        eventId,
        now: new Date().toISOString()
      });
      const blocker = golfLabModelLaunchBlocker(launchPlan);
      if (blocker) {
        const message = `${blocker.message}${blocker.nextAction ? ` Next: ${blocker.nextAction}` : ""}`;
        setGolfLabModelStatus(message);
        showToast(blocker.message);
        renderGolfLabActivationPlan(normalizeGolfLabState(state.golfLab));
        return;
      }
    }
    setGolfLabModelBusy(true);
    setGolfLabModelStatus("Running owned model...");
    try {
      const snapshot = buildOwnedModelSnapshot(state.golfLab, {
        eventId,
        createdAt: new Date().toISOString(),
        weights: getGolfLabModelWeights(),
        modelProfile: getGolfLabModelPreset().label,
        weatherScenario: golfLabModelSettings.weatherScenario,
        requireOfficialField: true,
        activationPlan: launchPlan
      });
      if (!snapshot.predictions.length) {
        throw new Error((snapshot.warnings && snapshot.warnings[0]) || "Import event, field, player, and round data before modeling.");
      }
      applyGolfLabDataMerge(snapshot.golfLab, "Owned model run saved.");
      const eventName = snapshot.event ? snapshot.event.name || snapshot.event.id : "event";
      setGolfLabModelStatus(`Modeled ${eventName} with ${getGolfLabModelPreset().label} / ${getGolfLabWeatherScenarioLabel()}: ${snapshot.predictions.length} predictions.`);
    } catch (error) {
      setGolfLabModelStatus(error.message || "Owned model failed.");
      showToast(error.message || "Owned model failed.");
    } finally {
      setGolfLabModelBusy(false);
    }
  }

  function formatLabNumber(value, digits = 1, signed = false) {
    if (!Number.isFinite(value)) return "--";
    if (signed) return formatSigned(value, digits);
    return Number(value).toFixed(digits).replace(/\.0$/, "");
  }

  function formatLabPercent(value) {
    if (!Number.isFinite(value)) return "--";
    const pct = value <= 1 ? value * 100 : value;
    return `${Math.round(pct)}%`;
  }

  function formatLabEdge(value) {
    if (!Number.isFinite(value)) return "--";
    return `${formatSigned(value * 100, 1)} pp`;
  }

  function formatGolfLabOdds(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "--";
    const rounded = Math.round(numeric);
    return rounded > 0 ? `+${rounded}` : String(rounded);
  }

  function buildGolfLabCommandCenter(lab, warehouseReport) {
    const eventId = getSelectedGolfLabEventId();
    const dossier = typeof buildEventDossier === "function" ? buildEventDossier(lab, eventId) : null;
    if (!dossier || !dossier.event) return null;
    const fitBoard = typeof buildEventFitBoard === "function"
      ? buildEventFitBoard(lab, {
        eventId,
        weights: getGolfLabModelWeights(),
        modelProfile: getGolfLabModelPreset().label,
        weatherScenario: golfLabModelSettings.weatherScenario
      })
      : null;
    const consensusBoard = typeof buildModelConsensusBoard === "function"
      ? buildModelConsensusBoard(lab, {
        eventId,
        profiles: getGolfLabConsensusProfiles(),
        weatherScenario: golfLabModelSettings.weatherScenario,
        market: golfLabModelSettings.marketFilter,
        maxRows: 5
      })
      : null;
    const sensitivityBoard = typeof buildFeatureSensitivityBoard === "function"
      ? buildFeatureSensitivityBoard(lab, {
        eventId,
        weights: getGolfLabModelWeights(),
        modelProfile: getGolfLabModelPreset().label,
        weatherScenario: golfLabModelSettings.weatherScenario,
        market: golfLabModelSettings.marketFilter,
        maxRows: 5
      })
      : null;
    const runAuditBoard = typeof buildPredictionRunAuditBoard === "function"
      ? buildPredictionRunAuditBoard(lab, {
        eventId,
        market: golfLabModelSettings.marketFilter,
        minEdge: getGolfLabEdgeThresholdProbability()
      })
      : null;
    const edgeBoard = typeof buildPredictionEdgeBoard === "function"
      ? buildPredictionEdgeBoard(lab, {
        eventId,
        market: golfLabModelSettings.marketFilter,
        minEdge: getGolfLabEdgeThresholdProbability(),
        maxRows: 8
      })
      : null;
    const portfolioBoard = typeof buildBetPortfolioBoard === "function"
      ? buildBetPortfolioBoard(lab, {
        market: golfLabModelSettings.marketFilter,
        minEdge: getGolfLabEdgeThresholdProbability(),
        maxRows: 8,
        candidateRows: 20,
        maxTotalUnits: 8,
        maxPlayerUnits: 2.5,
        maxMarketUnits: 4,
        maxEventUnits: 6,
        minStakeUnits: 0.25
      })
      : null;
    return {
      event: dossier.event,
      course: dossier.course,
      readiness: dossier.readiness,
      readinessScore: dossier.readinessScore,
      blockers: dossier.blockers || [],
      counts: dossier.counts || {},
      weather: dossier.weather || {},
      sourceScore: warehouseReport ? warehouseReport.score : null,
      topFit: fitBoard && fitBoard.summary ? fitBoard.summary.topFit : null,
      topConsensus: consensusBoard && consensusBoard.summary ? consensusBoard.summary.topConsensus : null,
      consensusCores: consensusBoard && consensusBoard.summary ? consensusBoard.summary.consensusCores : 0,
      fragilePicks: sensitivityBoard && sensitivityBoard.summary ? sensitivityBoard.summary.fragile : 0,
      robustPicks: sensitivityBoard && sensitivityBoard.summary ? sensitivityBoard.summary.robust : 0,
      topDependency: sensitivityBoard && sensitivityBoard.summary ? sensitivityBoard.summary.topDependency : null,
      runAudit: runAuditBoard ? runAuditBoard.summary : null,
      topEdge: edgeBoard && edgeBoard.playable && edgeBoard.playable.length
        ? edgeBoard.playable[0]
        : edgeBoard && edgeBoard.candidates ? edgeBoard.candidates[0] : null,
      portfolio: portfolioBoard ? portfolioBoard.summary : null,
      market: golfLabModelSettings.marketFilter,
      profile: getGolfLabModelPreset().label,
      weatherScenario: getGolfLabWeatherScenarioLabel()
    };
  }

  function renderGolfLabCommandCenter(lab, warehouseReport) {
    if (!els.golfLabCommandCenterBoard) return;
    const center = buildGolfLabCommandCenter(lab, warehouseReport);
    if (!center) {
      els.golfLabCommandCenterBoard.innerHTML = emptyState("Import or select a tournament to unlock the command center.");
      return;
    }
    const blockers = center.blockers.slice(0, 4).map((blocker) =>
      `<span>${escapeHtml(blocker)}</span>`
    ).join("") || `<span>Model foundation ready</span>`;
    const runAudit = center.runAudit || {};
    const portfolio = center.portfolio || {};
    const topDependency = center.topDependency && center.topDependency.strongestDependency
      ? center.topDependency.strongestDependency
      : null;
    const signals = [
      {
        label: "Top Fit",
        value: center.topFit ? center.topFit.playerName : "--",
        note: center.topFit ? `${formatLabPercent(center.topFit.winProbability)} win | ${center.topFit.confidence || "model"}` : "needs field"
      },
      {
        label: "Consensus",
        value: center.topConsensus ? center.topConsensus.playerName : "--",
        note: `${center.consensusCores} core | ${golfLabMarketFilterLabel(center.market)}`
      },
      {
        label: "Fragility",
        value: String(center.fragilePicks),
        note: topDependency ? `${center.topDependency.playerName}: no ${topDependency.label}` : `${center.robustPicks} robust`
      },
      {
        label: "Best Edge",
        value: center.topEdge ? center.topEdge.playerName : "--",
        note: center.topEdge ? `${center.topEdge.market || golfLabMarketFilterLabel(center.market)} | ${formatLabEdge(center.topEdge.edge)}` : "needs odds"
      },
      {
        label: "Run Audit",
        value: runAudit.markets ? `${runAudit.readyMarkets}/${runAudit.markets}` : "--",
        note: runAudit.fieldCoveragePct != null ? `${runAudit.fieldCoveragePct}% field modeled` : "not run"
      },
      {
        label: "Portfolio",
        value: portfolio.included != null ? `${portfolio.included}/${portfolio.playable}` : "--",
        note: portfolio.totalStakeUnits != null ? `${formatLabNumber(portfolio.totalStakeUnits, 2)}u staked` : "no slate"
      }
    ].map((signal) => `
      <div class="golf-lab-command-signal">
        <span>${escapeHtml(signal.label)}</span>
        <strong>${escapeHtml(signal.value)}</strong>
        <em>${escapeHtml(signal.note)}</em>
      </div>
    `).join("");
    const eventLine = [
      center.event.name || center.event.id,
      center.course ? center.course.name : center.event.courseName,
      center.event.startDate,
      center.profile,
      center.weatherScenario
    ].filter(Boolean).join(" | ");
    els.golfLabCommandCenterBoard.innerHTML = `
      <section class="golf-lab-command">
        <div class="golf-lab-command-hero golf-lab-command-${escapeHtml(center.readiness)}">
          <div>
            <span>Command Center</span>
            <strong>${escapeHtml(center.event.name || center.event.id)}</strong>
            <em>${escapeHtml(eventLine || "Selected event")}</em>
          </div>
          <div>
            <b>${center.readinessScore}</b>
            <small>${escapeHtml(String(center.readiness || "not-ready").replace(/-/g, " "))}</small>
          </div>
        </div>
        <div class="golf-lab-command-kpis">
          ${renderGolfLabKpi("Source Score", center.sourceScore == null ? "--" : `${center.sourceScore}%`, `${center.counts.rounds || 0} rounds`)}
          ${renderGolfLabKpi("Field", String(center.counts.field || 0), `${center.counts.matchedFields || 0} matched`)}
          ${renderGolfLabKpi("Weather", center.weather.label || "--", `${formatLabNumber(center.weather.windMph, 0)} mph`)}
          ${renderGolfLabKpi("Markets", String(center.counts.oddsSnapshots || 0), `${center.counts.predictions || 0} predictions`)}
        </div>
        <div class="golf-lab-command-signals">${signals}</div>
        <div class="golf-lab-command-blockers">${blockers}</div>
      </section>
    `;
  }

  function renderGolfLabActivationPlan(lab) {
    if (!els.golfLabActivationPlanBoard) return;
    if (typeof buildTournamentActivationPlan !== "function") {
      els.golfLabActivationPlanBoard.innerHTML = emptyState("Tournament activation planning is not available.");
      return;
    }
    if (!lab.events.length) {
      els.golfLabActivationPlanBoard.innerHTML = emptyState("Import a tournament schedule row to build an activation plan.");
      return;
    }
    const board = buildTournamentActivationPlan(lab, {
      eventId: getSelectedGolfLabEventId(),
      now: new Date().toISOString()
    });
    if (!board || !board.event) {
      els.golfLabActivationPlanBoard.innerHTML = emptyState("Select a tournament to activate source, warehouse, and model workflows.");
      return;
    }
    syncGolfLabModelLaunchState(board);
    const statusKey = String(board.status || "thin").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "thin";
    const eventLine = [
      board.event.name || board.event.id,
      board.course ? board.course.name : board.event.courseName,
      board.event.startDate
    ].filter(Boolean).join(" | ");
    const phases = board.phases.map((phase) => `
      <article class="golf-lab-activation-phase golf-lab-activation-phase-${escapeHtml(phase.status)}">
        <div>
          <strong>${escapeHtml(phase.label)}</strong>
          <span>${escapeHtml(phase.detail)}</span>
        </div>
        <b>${phase.score}%</b>
      </article>
    `).join("");
    const actions = board.nextActions.slice(0, 6).map((row) => `
      <article class="golf-lab-activation-action golf-lab-activation-action-${escapeHtml(row.status)}">
        <div>
          <strong>${escapeHtml(row.label)}</strong>
          <span>${escapeHtml(row.detail)}</span>
          <em>${escapeHtml(row.nextAction)}</em>
        </div>
        <b>${row.score}%</b>
      </article>
    `).join("") || emptyState("Activation lanes are clear.");
    const commands = board.commands.slice(0, 3).map((row) => `
      <article class="golf-lab-activation-command">
        <div>
          <strong>${escapeHtml(row.label)}</strong>
          <code>${escapeHtml(row.command)}</code>
          <span>${escapeHtml((row.targetFiles || []).slice(0, 4).join(" | "))}</span>
        </div>
      </article>
    `).join("") || `<article class="golf-lab-activation-command golf-lab-activation-command-clear"><strong>No adapter commands blocking activation</strong></article>`;
    const lanes = board.lanes.slice(0, 8).map((lane) => `
      <span class="golf-lab-activation-lane golf-lab-activation-lane-${escapeHtml(lane.status)}">
        <b>${escapeHtml(lane.label)}</b>
        <em>${lane.score}%</em>
      </span>
    `).join("");
    els.golfLabActivationPlanBoard.innerHTML = `
      <section class="golf-lab-activation golf-lab-activation-${escapeHtml(statusKey)}">
        <div class="golf-lab-activation-hero">
          <div>
            <p class="eyebrow">${escapeHtml(eventLine || "Selected event")}</p>
            <h3>${escapeHtml(board.statusLabel || "Activation Plan")}</h3>
            <p>${board.summary.readyLanes}/${board.summary.lanes} lanes ready | ${board.summary.criticalBlockers} critical blockers</p>
          </div>
          <div class="golf-lab-activation-verdict">
            ${renderGolfLabSourceBadge(board.status)}
            <strong>${board.score}%</strong>
            <span>activation score</span>
          </div>
        </div>
        <div class="golf-lab-kpi-grid golf-lab-activation-kpis">
          ${renderGolfLabKpi("Source", `${board.summary.sourceScore}%`, `${board.summary.sourceLedgerRows} ledger rows`)}
          ${renderGolfLabKpi("Warehouse", `${board.summary.warehouseScore}%`, `${board.summary.roundRows} rounds`) }
          ${renderGolfLabKpi("Field Match", `${board.summary.matchedFieldPlayers}/${board.summary.fieldRows}`, `${board.summary.uniqueFieldPlayers} field IDs`)}
          ${renderGolfLabKpi("Commands", String(board.summary.adapterCommands), `${board.targetFiles.length} target files`)}
        </div>
        <div class="golf-lab-activation-phases">${phases}</div>
        <div class="golf-lab-activation-layout">
          <section>
            <h4>Next Actions</h4>
            <div class="golf-lab-activation-actions">${actions}</div>
          </section>
          <section>
            <h4>Adapter Commands</h4>
            <div class="golf-lab-activation-commands">${commands}</div>
          </section>
        </div>
        <div class="golf-lab-activation-lanes">${lanes}</div>
      </section>
    `;
  }

  function renderGolfLab() {
    const lab = normalizeGolfLabState(state.golfLab);
    state.golfLab = lab;
    const summary = summarizeGolfLabState(lab);
    const warehouseReport = typeof buildWarehouseReport === "function" ? buildWarehouseReport(lab) : null;
    renderGolfLabSourceStatus(summary);
    renderGolfLabModelEventSelect(lab);
    syncGolfLabModelSettingsControls();

    if (els.golfLabStatus) {
      if (summary.hasData) {
        const fetchText = summary.latestFetch ? ` Last refresh ${summary.latestFetch}.` : "";
        els.golfLabStatus.textContent = `${summary.counts.players} players, ${summary.counts.events} events, ${summary.counts.rounds} pro rounds loaded.${fetchText}`;
      } else {
        els.golfLabStatus.textContent = "No professional golf data loaded.";
      }
    }

    renderGolfLabLanes(summary);
    renderGolfLabCommandCenter(lab, warehouseReport);
    renderGolfLabActivationPlan(lab);
    renderGolfLabWarehouseWorkbench(lab, warehouseReport);
    renderGolfLabCoverageMap(lab);
    renderGolfLabSourceAuditBoard(lab, warehouseReport);
    renderGolfLabSourceLineageBoard(lab);
    renderGolfLabSourceOpsBoard(lab);
    renderGolfLabDataIntakeBoard(lab);
    renderGolfLabSourceCatalogBoard(lab);
    renderGolfLabHistoricalBackfillBoard(lab);
    renderGolfLabSourcePlan(lab);
    renderGolfLabPlayerIdentityBoard(lab);
    renderGolfLabPlayerIndexBoard(lab);
    renderGolfLabPlayerSelect(lab);
    renderGolfLabCourseSelect(lab);
    renderGolfLabCourseDifficultyBoard(lab);
    renderGolfLabCourseSetupBoard(lab);
    renderGolfLabPlayerSplitLab(lab);
    renderGolfLabFeatureStoreBoard(lab);
    renderGolfLabCourseCompBoard(lab);
    renderGolfLabSplitLeaders(lab);
    renderGolfLabTournamentBoard(lab);
    renderGolfLabFitBoard(lab);
    renderGolfLabFieldReadinessBoard(lab);
    renderGolfLabFieldIntelligenceBoard(lab);
    renderGolfLabConsensusBoard(lab);
    renderGolfLabFeatureSensitivityBoard(lab);
    renderGolfLabScenarioBoard(lab);
    renderGolfLabWeatherMatrixBoard(lab);
    renderGolfLabWeatherDrawBoard(lab);
    renderGolfLabPredictionLedger(lab);
    renderGolfLabPredictionPrepBoard(lab);
    renderGolfLabPredictionRunAuditBoard(lab);
    renderGolfLabModelRunHistoryBoard(lab);
    renderGolfLabMarketCoverageBoard(lab);
    renderGolfLabOddsMovementBoard(lab);
    renderGolfLabOddsShoppingBoard(lab);
    renderGolfLabEdgeBoard(lab);
    renderGolfLabBetPortfolioBoard(lab);
    renderGolfLabProjectedStandingsBoard(lab);
    renderGolfLabResultsSummaryBoard(lab);
    renderGolfLabModelExplainerBoard(lab);
    renderGolfLabSettlementBoard(lab);
    renderGolfLabBacktestPanel(lab);
    renderGolfLabTrainingDatasetBoard(lab);
    renderGolfLabModelCalibrationBoard(lab);
    renderGolfLabModelTuningBoard(lab);
  }

  function renderGolfLabLanes(summary) {
    if (!els.golfLabLanes) return;
    els.golfLabLanes.innerHTML = summary.lanes.map((lane) => `
      <article class="golf-lab-lane golf-lab-lane-${escapeHtml(lane.accent)}">
        <span>${escapeHtml(lane.label)}</span>
        <strong>${lane.count}</strong>
      </article>
    `).join("");
  }

  function renderGolfLabScorePart(label, value) {
    const numeric = Number(value);
    const safe = Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
    return `<div class="golf-lab-quality-part">
      <span>${escapeHtml(label)}</span>
      <strong>${safe}%</strong>
      <em style="--quality:${safe}%"></em>
    </div>`;
  }

  function formatGolfLabSourceAge(days) {
    const numeric = Number(days);
    if (!Number.isFinite(numeric)) return "Unknown age";
    if (numeric <= 0) return "Today";
    if (numeric === 1) return "1 day old";
    return `${Math.round(numeric)} days old`;
  }

  function renderGolfLabSourceBadge(status) {
    const key = String(status || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "unknown";
    const labels = {
      fresh: "Fresh",
      watch: "Watch",
      stale: "Stale",
      unknown: "Unknown",
      review: "Review",
      partial: "Partial",
      verified: "Verified",
      linked: "Linked",
      resolved: "Resolved",
      suggested: "Suggested",
      ambiguous: "Ambiguous",
      unmatched: "Unmatched",
      unverified: "Unverified",
      thin: "Thin",
      setup: "Setup",
      blocked: "Blocked",
      empty: "Empty",
      "source-blocked": "Source Blocked",
      "ready-to-model": "Ready To Model",
      "premium-ready": "Premium Ready",
      building: "Building",
      ready: "Ready",
      missing: "Missing"
    };
    return `<span class="golf-lab-source-audit-badge golf-lab-source-audit-badge-${escapeHtml(key)}">${escapeHtml(labels[key] || key)}</span>`;
  }

  function renderGolfLabWarehouseWorkbench(lab, report) {
    if (!els.golfLabWarehouseWorkbench) return;
    if (!report || !hasGolfLabData(lab)) {
      els.golfLabWarehouseWorkbench.innerHTML = emptyState("Import source-backed collections to start the owned warehouse.");
      return;
    }
    const collectionKeys = ["players", "events", "courses", "fields", "rounds", "strokesGained", "weatherSnapshots", "oddsSnapshots", "sourceFetches"];
    const maxCount = Math.max(1, ...collectionKeys.map((key) => report.counts[key] || 0));
    const collections = collectionKeys.map((key) => {
      const value = report.counts[key] || 0;
      const pct = Math.round((value / maxCount) * 100);
      return `<div class="golf-lab-collection-row">
        <span>${escapeHtml(key.replace(/([A-Z])/g, " $1"))}</span>
        <strong>${value}</strong>
        <em style="--fill:${pct}%"></em>
      </div>`;
    }).join("");
    const events = report.events.slice(0, 5).map((event) => `
      <div class="golf-lab-readiness-row golf-lab-readiness-${escapeHtml(event.readiness.replace(/\s+/g, "-"))}">
        <div>
          <strong>${escapeHtml(event.name)}</strong>
          <span>${escapeHtml([event.startDate, event.courseName].filter(Boolean).join(" | "))}</span>
        </div>
        <em>${event.readinessScore}%</em>
      </div>
    `).join("") || emptyState("No event rows imported yet.");
    const gaps = report.gaps.slice(0, 5).map((gap) => `
      <div class="golf-lab-gap-row golf-lab-gap-${escapeHtml(gap.severity)}">
        <strong>${escapeHtml(gap.label)}</strong>
        <span>${escapeHtml(gap.detail)}</span>
      </div>
    `).join("") || `<div class="golf-lab-gap-row golf-lab-gap-clean"><strong>Warehouse clean</strong><span>No major gaps detected.</span></div>`;
    const validationRows = ((report.validation && report.validation.issues) || []).slice(0, 5).map((issue) => `
      <div class="golf-lab-gap-row golf-lab-gap-${escapeHtml(issue.severity)}">
        <strong>${escapeHtml(issue.label)}</strong>
        <span>${escapeHtml(issue.detail)}</span>
      </div>
    `).join("") || `<div class="golf-lab-gap-row golf-lab-gap-clean"><strong>Rows validated</strong><span>No required-field or duplicate-ID issues detected.</span></div>`;
    const scoreParts = [
      ["Core", report.scoreParts.core],
      ["Matching", report.scoreParts.matching],
      ["Scoring", report.scoreParts.scoring],
      ["Weather", report.scoreParts.weather],
      ["Market", report.scoreParts.market],
      ["Sources", report.scoreParts.sources]
    ].map(([label, value]) => renderGolfLabScorePart(label, value)).join("");
    els.golfLabWarehouseWorkbench.innerHTML = `
      <section class="golf-lab-workbench">
        <div class="golf-lab-quality-hero golf-lab-grade-${escapeHtml(report.grade)}">
          <div>
            <span>Warehouse Score</span>
            <strong>${report.score}</strong>
            <em>${escapeHtml(report.grade)} | ${report.totalRecords} records</em>
          </div>
          <div class="golf-lab-quality-parts">${scoreParts}</div>
        </div>
        <div class="golf-lab-workbench-grid">
          <section class="golf-lab-workbench-block">
            <h4>Collection Depth</h4>
            <div class="golf-lab-collection-list">${collections}</div>
          </section>
          <section class="golf-lab-workbench-block">
            <h4>Event Readiness</h4>
            <div class="golf-lab-readiness-list">${events}</div>
          </section>
          <section class="golf-lab-workbench-block">
            <h4>Priority Gaps</h4>
            <div class="golf-lab-gap-list">${gaps}</div>
          </section>
          <section class="golf-lab-workbench-block">
            <h4>Validation</h4>
            <div class="golf-lab-gap-list">${validationRows}</div>
          </section>
        </div>
      </section>
    `;
  }

  function renderGolfLabCoverageBadge(status, label) {
    const key = String(status || "building").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "building";
    return `<span class="golf-lab-coverage-badge golf-lab-coverage-badge-${escapeHtml(key)}">${escapeHtml(label || status || "Building")}</span>`;
  }

  function renderGolfLabCoverageMap(lab) {
    if (!els.golfLabCoverageMapBoard) return;
    if (typeof buildWarehouseCoverageMap !== "function") {
      els.golfLabCoverageMapBoard.innerHTML = emptyState("Warehouse coverage mapping is not available.");
      return;
    }
    if (!hasGolfLabData(lab)) {
      els.golfLabCoverageMapBoard.innerHTML = emptyState("Import source-backed rows to map database coverage.");
      return;
    }
    const board = buildWarehouseCoverageMap(lab, {
      eventLimit: 5,
      playerLimit: 6,
      courseLimit: 5
    });
    const collectionRows = board.collectionRows.slice(0, 10).map((row) => `
      <article class="golf-lab-coverage-collection golf-lab-coverage-collection-${escapeHtml(row.status)}">
        <div>
          <strong>${escapeHtml(row.label)}</strong>
          <span>${escapeHtml(row.role)} | ${row.rowCount} rows | ${row.sourceCoverage}% sourced</span>
        </div>
        <div>
          ${renderGolfLabCoverageBadge(row.status, row.statusLabel)}
          <em>${row.score}%</em>
        </div>
        <i style="--coverage:${row.score}%"></i>
      </article>
    `).join("");
    const nextActions = board.nextActions.slice(0, 4).map((row) => `
      <span class="golf-lab-coverage-action golf-lab-coverage-action-${escapeHtml(row.severity || "medium")}">
        <b>${escapeHtml(row.label)}</b>
        <em>${escapeHtml(row.detail)}</em>
      </span>
    `).join("") || `<span class="golf-lab-coverage-action golf-lab-coverage-action-clean"><b>Coverage clean</b><em>No major database blockers detected.</em></span>`;
    const eventRows = board.eventRows.slice(0, 4).map((row) => `
      <div class="golf-lab-coverage-entity golf-lab-coverage-entity-${escapeHtml(row.status)}">
        <div>
          <strong>${escapeHtml(row.name)}</strong>
          <span>${escapeHtml([row.startDate, row.courseName].filter(Boolean).join(" | "))}</span>
          <small>${escapeHtml(row.gaps.slice(0, 3).join(", ") || "event covered")}</small>
        </div>
        <b>${row.readinessScore}%</b>
      </div>
    `).join("") || emptyState("No events imported yet.");
    const playerRows = board.playerRows.slice(0, 5).map((row) => `
      <div class="golf-lab-coverage-entity golf-lab-coverage-entity-${escapeHtml(row.status)}">
        <div>
          <strong>${escapeHtml(row.playerName)}</strong>
          <span>${row.counts.rounds} rounds | ${row.counts.strokesGainedRows} SG | ${row.sourceProofPct}% sourced</span>
          <small>${escapeHtml(row.gaps.slice(0, 3).join(", ") || "player covered")}</small>
        </div>
        <b>${row.score}%</b>
      </div>
    `).join("") || emptyState("No player rows imported yet.");
    const courseRows = board.courseRows.slice(0, 4).map((row) => `
      <div class="golf-lab-coverage-entity golf-lab-coverage-entity-${escapeHtml(row.status)}">
        <div>
          <strong>${escapeHtml(row.courseName)}</strong>
          <span>${row.counts.rounds} rounds | ${row.counts.weatherSnapshots} weather | ${row.sourceProofPct}% sourced</span>
          <small>${escapeHtml(row.gaps.slice(0, 3).join(", ") || "course covered")}</small>
        </div>
        <b>${row.score}%</b>
      </div>
    `).join("") || emptyState("No course rows imported yet.");
    els.golfLabCoverageMapBoard.innerHTML = `
      <section class="golf-lab-coverage-map">
        <div class="golf-lab-kpi-grid golf-lab-coverage-kpis">
          ${renderGolfLabKpi("Warehouse", `${board.score}%`, `${escapeHtml(board.grade)} | ${board.totalRecords} records`)}
          ${renderGolfLabKpi("Collections", `${board.summary.readyCollections}/${board.summary.populatedCollections}`, `${board.summary.provenanceCoverage}% provenance`)}
          ${renderGolfLabKpi("Players", `${board.summary.modelReadyPlayers}/${board.summary.playerCount}`, `${board.summary.premiumPlayers} premium ready`)}
          ${renderGolfLabKpi("Blockers", String(board.summary.blockers), `${board.summary.validationIssues} validation issues`)}
        </div>
        <div class="golf-lab-coverage-actions">${nextActions}</div>
        <div class="golf-lab-coverage-grid">
          <section class="golf-lab-coverage-block golf-lab-coverage-block-collections">
            <h4>Collection Heat Map</h4>
            <div class="golf-lab-coverage-collections">${collectionRows}</div>
          </section>
          <section class="golf-lab-coverage-block">
            <h4>Event Coverage</h4>
            <div class="golf-lab-coverage-list">${eventRows}</div>
          </section>
          <section class="golf-lab-coverage-block">
            <h4>Player Depth Watchlist</h4>
            <div class="golf-lab-coverage-list">${playerRows}</div>
          </section>
          <section class="golf-lab-coverage-block">
            <h4>Course Depth Watchlist</h4>
            <div class="golf-lab-coverage-list">${courseRows}</div>
          </section>
        </div>
      </section>
    `;
  }

  function renderGolfLabSourceAuditBoard(lab, report) {
    if (!els.golfLabSourceAuditBoard) return;
    const freshness = report && report.sourceFreshness;
    if (!report || !freshness || !hasGolfLabData(lab)) {
      els.golfLabSourceAuditBoard.innerHTML = emptyState("Import source-backed rows to audit freshness and provenance.");
      return;
    }

    const staleSignals = (freshness.staleProviderCount || 0) + (freshness.staleCollectionCount || 0) + (freshness.unverifiedCollectionCount || 0);
    const providerRows = freshness.providers.slice(0, 6).map((provider) => {
      const endpointText = provider.endpoints && provider.endpoints.length ? provider.endpoints.join(", ") : "manual-import";
      const ageText = formatGolfLabSourceAge(provider.latestAgeDays);
      return `<div class="golf-lab-source-audit-row">
        <div>
          <strong>${escapeHtml(provider.provider)}</strong>
          <span>${escapeHtml(endpointText)}</span>
        </div>
        <div class="golf-lab-source-audit-meta">
          ${renderGolfLabSourceBadge(provider.status || provider.freshness)}
          <em>${escapeHtml(ageText)} | ${provider.rowCount || 0} rows</em>
        </div>
      </div>`;
    }).join("") || emptyState("No provider fetch rows imported yet.");

    const collectionRows = freshness.collections
      .filter((row) => row.rowCount > 0)
      .slice(0, 8)
      .map((row) => `<div class="golf-lab-provenance-row">
        <div>
          <strong>${escapeHtml(row.label)}</strong>
          <span>${row.sourcedRows}/${row.rowCount} rows sourced${row.latestAt ? ` | ${escapeHtml(row.latestAt)}` : ""}</span>
        </div>
        <div class="golf-lab-provenance-meter">
          ${renderGolfLabSourceBadge(row.status)}
          <i style="--provenance:${row.coverage}%"></i>
          <em>${row.coverage}%</em>
        </div>
      </div>`).join("") || emptyState("No populated collections yet.");

    els.golfLabSourceAuditBoard.innerHTML = `
      <section class="golf-lab-source-audit">
        <div class="golf-lab-kpi-grid golf-lab-source-audit-kpis">
          ${renderGolfLabKpi("Latest Refresh", freshness.latestSourceAt ? formatGolfLabSourceAge(freshness.latestSourceAgeDays) : "None", freshness.latestSourceAt || "no timestamp")}
          ${renderGolfLabKpi("Provenance", `${freshness.provenanceCoverage}%`, `${freshness.sourcedRowCount}/${freshness.auditedRowCount} rows`)}
          ${renderGolfLabKpi("Providers", String(freshness.providerCount), `${freshness.reviewProviderCount || 0} need review`)}
          ${renderGolfLabKpi("Trust Flags", String(staleSignals), `${freshness.qualityScore}% source score`)}
        </div>
        <div class="golf-lab-source-audit-grid">
          <section class="golf-lab-source-audit-block">
            <h4>Provider Freshness</h4>
            <div>${providerRows}</div>
          </section>
          <section class="golf-lab-source-audit-block">
            <h4>Collection Provenance</h4>
            <div>${collectionRows}</div>
          </section>
        </div>
      </section>
    `;
  }

  function renderGolfLabSourceLineageBoard(lab) {
    if (!els.golfLabSourceLineageBoard) return;
    if (typeof buildSourceLineageBoard !== "function") {
      els.golfLabSourceLineageBoard.innerHTML = emptyState("Source lineage is not available.");
      return;
    }
    if (!hasGolfLabData(lab)) {
      els.golfLabSourceLineageBoard.innerHTML = emptyState("Import source-backed rows to trace provider, collection, and event lineage.");
      return;
    }
    const board = buildSourceLineageBoard(lab, { eventId: getSelectedGolfLabEventId() });
    const selected = board.selectedEvent;
    const latestText = board.summary.latestSourceAt
      ? formatGolfLabSourceAge(board.summary.latestSourceAgeDays)
      : "No source ledger";
    const blockers = board.blockers.slice(0, 4).map((blocker) => `
      <span class="golf-lab-lineage-blocker golf-lab-lineage-blocker-${escapeHtml(blocker.severity || "medium")}">
        <b>${escapeHtml(blocker.label)}</b>
        <em>${escapeHtml(blocker.detail)}</em>
      </span>
    `).join("") || `<span class="golf-lab-lineage-blocker golf-lab-lineage-blocker-clear"><b>Lineage clean</b><em>Provider, collection, and event chains are traceable.</em></span>`;
    const eventContext = selected
      ? [selected.startDate, selected.courseName].filter(Boolean).join(" | ")
      : "Select or import a tournament";
    const selectedGaps = selected && selected.gaps.length
      ? selected.gaps.slice(0, 3).join(", ")
      : "Event proof chain ready";
    const eventCard = `
      <div class="golf-lab-lineage-event golf-lab-lineage-event-${escapeHtml(selected ? selected.status : "setup")}">
        <div>
          <span>Selected Event</span>
          <strong>${escapeHtml(selected ? selected.eventName : "No event selected")}</strong>
          <em>${escapeHtml(eventContext)}</em>
        </div>
        <div>
          ${renderGolfLabSourceBadge(selected ? selected.status : "setup")}
          <b>${selected ? selected.proofScore : 0}%</b>
          <small>${escapeHtml(selectedGaps)}</small>
        </div>
      </div>`;
    const providerRows = board.providerRows.slice(0, 5).map((row) => {
      const collections = row.collections.length
        ? row.collections.slice(0, 5).map(prettyGolfLabCollection).join(" + ")
        : "No collection link";
      const eventText = row.events.length
        ? `${row.events.length} linked event${row.events.length === 1 ? "" : "s"}`
        : "No event link";
      const endpointText = row.endpoints && row.endpoints.length ? row.endpoints.slice(0, 2).join(", ") : row.sourceUrl || "manual import";
      return `
        <article class="golf-lab-lineage-row golf-lab-lineage-row-${escapeHtml(row.status || row.freshness || "unknown")}">
          <div>
            <strong>${escapeHtml(row.provider)}</strong>
            <span>${escapeHtml(collections)} | ${escapeHtml(eventText)}</span>
            <small>${escapeHtml(endpointText)}</small>
          </div>
          <div>
            ${renderGolfLabSourceBadge(row.status || row.freshness)}
            <em>${escapeHtml(row.latestAt ? formatGolfLabSourceAge(row.latestAgeDays) : "no timestamp")} | ${row.rowCount || 0} rows</em>
          </div>
        </article>
      `;
    }).join("") || emptyState("No provider lineage rows imported yet.");
    const collectionRows = board.collectionRows
      .filter((row) => row.rowCount > 0)
      .sort((a, b) => a.proofScore - b.proofScore || b.rowCount - a.rowCount)
      .slice(0, 8)
      .map((row) => {
        const providerText = row.topProvider
          ? `${row.topProvider.provider} | ${row.topProvider.rows} rows`
          : "No provider linked";
        const gaps = row.gaps.length ? row.gaps.slice(0, 2).join(", ") : "collection traced";
        return `
          <article class="golf-lab-lineage-row golf-lab-lineage-row-${escapeHtml(row.status)}">
            <div>
              <strong>${escapeHtml(row.label)}</strong>
              <span>${escapeHtml(row.role)} | ${row.sourcedRows}/${row.rowCount} rows sourced | ${row.sourceFetches} ledger rows</span>
              <small>${escapeHtml(providerText)} | ${escapeHtml(gaps)}</small>
            </div>
            <div>
              ${renderGolfLabSourceBadge(row.status)}
              <em>${row.proofScore}% proof</em>
              <i style="--lineage:${row.proofScore}%"></i>
            </div>
          </article>
        `;
      }).join("") || emptyState("No populated collections to trace yet.");
    const eventRows = board.eventRows.slice(0, 5).map((row) => {
      const providerText = row.providers.length ? row.providers.slice(0, 3).join(" / ") : "No providers";
      const gaps = row.gaps.length ? row.gaps.slice(0, 2).join(", ") : "event traced";
      return `
        <article class="golf-lab-lineage-row golf-lab-lineage-row-${escapeHtml(row.status)}">
          <div>
            <strong>${escapeHtml(row.eventName)}</strong>
            <span>${escapeHtml([row.startDate, row.courseName].filter(Boolean).join(" | "))}</span>
            <small>${row.linkedRows} linked rows | ${row.sourceFetches} source fetches | ${escapeHtml(providerText)} | ${escapeHtml(gaps)}</small>
          </div>
          <div>
            ${renderGolfLabSourceBadge(row.status)}
            <em>${row.proofScore}% proof</em>
            <i style="--lineage:${row.proofScore}%"></i>
          </div>
        </article>
      `;
    }).join("") || emptyState("No event lineage rows imported yet.");

    els.golfLabSourceLineageBoard.innerHTML = `
      <section class="golf-lab-lineage">
        <div class="golf-lab-kpi-grid golf-lab-lineage-kpis">
          ${renderGolfLabKpi("Lineage Score", `${board.summary.proofScore}%`, board.summary.status)}
          ${renderGolfLabKpi("Providers", String(board.summary.providers), `${board.summary.sourceFetches} source fetches`)}
          ${renderGolfLabKpi("Collections", `${board.summary.verifiedCollections}/${board.summary.populatedCollections}`, `${board.summary.provenanceCoverage}% row provenance`)}
          ${renderGolfLabKpi("Latest Proof", latestText, `${board.summary.linkedEvents}/${board.summary.eventCount} events linked`)}
        </div>
        ${eventCard}
        <div class="golf-lab-lineage-blockers">${blockers}</div>
        <div class="golf-lab-lineage-grid">
          <section class="golf-lab-lineage-block">
            <h4>Provider Chains</h4>
            <div class="golf-lab-lineage-list">${providerRows}</div>
          </section>
          <section class="golf-lab-lineage-block">
            <h4>Collection Proof</h4>
            <div class="golf-lab-lineage-list">${collectionRows}</div>
          </section>
          <section class="golf-lab-lineage-block golf-lab-lineage-block-events">
            <h4>Event Chains</h4>
            <div class="golf-lab-lineage-list">${eventRows}</div>
          </section>
        </div>
      </section>
    `;
  }

  function renderGolfLabSourceOpsBoard(lab) {
    if (!els.golfLabSourceOpsBoard) return;
    if (typeof buildSourceOpsBoard !== "function") {
      els.golfLabSourceOpsBoard.innerHTML = emptyState("Source ops is not available.");
      return;
    }
    const board = buildSourceOpsBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      recentRows: 6
    });
    if (!board.event) {
      els.golfLabSourceOpsBoard.innerHTML = emptyState("Import or select a tournament to run source ops.");
      return;
    }
    const alertRows = board.alerts.slice(0, 5).map((alert) => `
      <span class="golf-lab-source-ops-alert golf-lab-source-ops-alert-${escapeHtml(alert.severity || "info")}">
        <b>${escapeHtml(alert.label)}</b>
        <em>${escapeHtml(alert.detail)}</em>
      </span>
    `).join("") || `<span class="golf-lab-source-ops-alert golf-lab-source-ops-alert-clear"><b>Source desk clear</b><em>No urgent source refreshes.</em></span>`;
    const taskRows = board.tasks.slice(0, 8).map((task) => {
      const proof = task.sourceProof || {};
      const ageText = Number.isFinite(task.latestAgeDays) ? formatGolfLabSourceAge(task.latestAgeDays) : "no timestamp";
      const fill = task.threshold > 0 ? Math.min(100, Math.round((task.rowCount / task.threshold) * 100)) : 0;
      return `
        <article class="golf-lab-source-ops-task golf-lab-source-ops-task-${escapeHtml(task.status)}">
          <div>
            <strong>${escapeHtml(task.label)}</strong>
            <span>${escapeHtml(task.sourceType)} | ${escapeHtml(proof.label || "No source ledger")} | ${escapeHtml(ageText)}</span>
          </div>
          <div>
            ${renderGolfLabSourceBadge(task.status)}
            <em>${task.rowCount}/${task.threshold || task.rowCount || 1}</em>
          </div>
          <i style="--source-ops-fill:${fill}%"></i>
        </article>
      `;
    }).join("");
    const fetchRows = board.recentFetches.map((row) => `
      <div class="golf-lab-source-ops-fetch">
        <div>
          <strong>${escapeHtml(row.provider)}</strong>
          <span>${escapeHtml(row.endpoint || row.sourceUrl || "manual import")}</span>
        </div>
        <em>${escapeHtml(row.fetchedAt ? formatGolfLabSourceAge(row.ageDays) : "no timestamp")} | ${escapeHtml(row.status)} | ${row.rowCount || 0} rows</em>
      </div>
    `).join("") || emptyState("No source ledger rows imported yet.");
    els.golfLabSourceOpsBoard.innerHTML = `
      <section class="golf-lab-source-ops">
        <div class="golf-lab-kpi-grid golf-lab-source-ops-kpis">
          ${renderGolfLabKpi("Ops Score", `${board.opsScore}%`, `${board.planScore}% plan`)}
          ${renderGolfLabKpi("Proof", `${board.summary.proofReady}/${board.summary.tasks}`, `${board.proofScore}% proof score`)}
          ${renderGolfLabKpi("Alerts", String(board.summary.alerts), `${board.summary.blocked} blocked | ${board.summary.stale} stale`)}
          ${renderGolfLabKpi("Latest", board.summary.latestSourceAt ? formatGolfLabSourceAge(golfLabAgeDaysFromIso(board.summary.latestSourceAt)) : "None", `${board.summary.providerCount} providers`)}
        </div>
        <div class="golf-lab-source-ops-alerts">${alertRows}</div>
        <div class="golf-lab-source-ops-grid">
          <section>
            <h4>Refresh Queue</h4>
            <div class="golf-lab-source-ops-list">${taskRows}</div>
          </section>
          <section>
            <h4>Recent Source Ledger</h4>
            <div class="golf-lab-source-ops-list">${fetchRows}</div>
          </section>
        </div>
      </section>
    `;
  }

  function renderGolfLabSourceCatalogBadge(status) {
    const key = String(status || "planned").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "planned";
    const labels = {
      ready: "Ready",
      stale: "Stale",
      missing: "Missing",
      needed: "Needed",
      planned: "Planned",
      partial: "Partial",
      review: "Review"
    };
    return `<span class="golf-lab-source-catalog-badge golf-lab-source-catalog-badge-${escapeHtml(key)}">${escapeHtml(labels[key] || key)}</span>`;
  }

  function renderGolfLabDataIntakeMode(row) {
    const mode = String(row && row.mode || "manual").toLowerCase();
    const label = mode === "adapter" ? row.adapterType || "adapter" : "manual";
    return `<span class="golf-lab-intake-mode golf-lab-intake-mode-${escapeHtml(mode)}">${escapeHtml(label)}</span>`;
  }

  function renderGolfLabDataIntakeBoard(lab) {
    if (!els.golfLabDataIntakeBoard) return;
    if (typeof buildDataIntakeBoard !== "function") {
      els.golfLabDataIntakeBoard.innerHTML = emptyState("Data intake planner is not available.");
      return;
    }
    const board = buildDataIntakeBoard(lab, { eventId: getSelectedGolfLabEventId() });
    const eventLabel = board.event
      ? [board.event.name || board.event.id, board.event.startDate, board.event.courseName].filter(Boolean).join(" | ")
      : "Select or import a tournament";
    const actions = board.priorityRows.slice(0, 5).map((row) => `
      <span class="golf-lab-intake-action golf-lab-intake-action-${escapeHtml(row.priority)}">
        <b>${escapeHtml(row.label)}</b>
        <em>${escapeHtml(row.nextAction)}</em>
      </span>
    `).join("") || `<span class="golf-lab-intake-action golf-lab-intake-action-ready"><b>Intake clear</b><em>Every lane is filled and source-proofed.</em></span>`;
    const batchHints = (board.batchFileHints || []).slice(0, 8).map((hint) => `<span>${escapeHtml(hint)}</span>`).join("");
    const batchCommand = board.batchCommand ? `
      <div class="golf-lab-intake-batch">
        <div>
          <strong>Batch Ingest</strong>
          <span>${escapeHtml(board.batchInputDir || "downloads/tournament-raw")}</span>
        </div>
        <code>${escapeHtml(board.batchCommand)}</code>
        <p>${batchHints}</p>
      </div>
    ` : "";
    const rows = board.rows.slice(0, 8).map((row) => {
      const targets = row.targetFiles.slice(0, 4).map((file) => `<span>${escapeHtml(file)}</span>`).join("");
      const headers = row.requiredHeaders.length
        ? row.requiredHeaders.slice(0, 6).map((header) => `<span>${escapeHtml(header)}</span>`).join("")
        : `<span>${escapeHtml(row.collectionFiles)}</span>`;
      const command = row.command || `Fill ${row.collectionFiles} manually, then import the CSV files.`;
      const recipe = row.sourceRecipe || {};
      const gateText = recipe.qualityGates && recipe.qualityGates.length
        ? recipe.qualityGates[0]
        : recipe.proofRule || "Add provider, URL, timestamp, row count, and source status.";
      return `
        <article class="golf-lab-intake-row golf-lab-intake-row-${escapeHtml(row.status)} golf-lab-intake-row-${escapeHtml(row.mode)}">
          <div class="golf-lab-intake-head">
            <div>
              <strong>${escapeHtml(row.label)}</strong>
              <span>${escapeHtml(row.sourceType)} | ${row.rowCount}/${row.threshold || row.rowCount || 1} rows</span>
            </div>
            <div>
              ${renderGolfLabDataIntakeMode(row)}
              ${renderGolfLabSourceCatalogBadge(row.status)}
            </div>
          </div>
          <code>${escapeHtml(command)}</code>
          <div class="golf-lab-intake-recipe">
            <span><b>Source</b><em>${escapeHtml(recipe.primarySource || row.sourceType || "Traceable public source")}</em></span>
            <span><b>Raw</b><em>${escapeHtml(row.rawFileName || row.sampleInputFile || row.suggestedFileName || "source export")}</em></span>
            <span><b>Gate</b><em>${escapeHtml(gateText)}</em></span>
          </div>
          <div class="golf-lab-intake-chip-grid">
            <div>
              <b>Headers</b>
              <p>${headers}</p>
            </div>
            <div>
              <b>Writes</b>
              <p>${targets}</p>
            </div>
          </div>
          <small>${escapeHtml(row.nextAction)}</small>
        </article>
      `;
    }).join("");
    els.golfLabDataIntakeBoard.innerHTML = `
      <section class="golf-lab-intake">
        <div class="golf-lab-kpi-grid golf-lab-intake-kpis">
          ${renderGolfLabKpi("Intake Score", `${board.score}%`, `${board.summary.ready}/${board.summary.lanes} lanes ready`)}
          ${renderGolfLabKpi("Adapters", `${board.summary.commandsReady}/${board.summary.adapterLanes}`, `${board.summary.manualLanes} manual lanes`)}
          ${renderGolfLabKpi("Proof", `${board.summary.proofReady}/${board.summary.lanes}`, `${board.summary.missing} needs work`)}
          ${renderGolfLabKpi("Output", board.outputDir, eventLabel)}
        </div>
        ${batchCommand}
        <div class="golf-lab-intake-actions">${actions}</div>
        <div class="golf-lab-intake-grid">${rows}</div>
      </section>
    `;
  }

  function renderGolfLabSourceCatalogBoard(lab) {
    if (!els.golfLabSourceCatalogBoard) return;
    if (typeof buildSourceCatalogBoard !== "function") {
      els.golfLabSourceCatalogBoard.innerHTML = emptyState("Source catalog is not available.");
      return;
    }
    const board = buildSourceCatalogBoard(lab, { eventId: getSelectedGolfLabEventId() });
    const eventLabel = board.event
      ? [board.event.name || board.event.id, board.event.startDate, board.event.courseName].filter(Boolean).join(" | ")
      : "No tournament selected";
    const nextRows = board.nextActions.slice(0, 5).map((row) => `
      <span class="golf-lab-source-catalog-action golf-lab-source-catalog-action-${escapeHtml(row.priority)}">
        <b>${escapeHtml(row.label)}</b>
        <em>${escapeHtml(row.nextAction)}</em>
      </span>
    `).join("") || `<span class="golf-lab-source-catalog-action golf-lab-source-catalog-action-ready"><b>Catalog clear</b><em>Every source lane is ready and proofed.</em></span>`;
    const rows = board.rows.slice(0, 8).map((row) => {
      const collections = row.targetCollections.map((collection) => collection.label).join(" + ");
      const providerText = row.providers.length ? row.providers.join(" / ") : row.sourceType;
      const proofAge = Number.isFinite(row.latestAgeDays) ? formatGolfLabSourceAge(row.latestAgeDays) : "no timestamp";
      const sourceLine = row.sourceUrl
        ? row.sourceUrl
        : `${row.ledgerRows || 0} ledger rows | ${row.sourceRows || 0} source rows | ${proofAge}`;
      return `
        <article class="golf-lab-source-catalog-row golf-lab-source-catalog-row-${escapeHtml(row.status)}">
          <div class="golf-lab-source-catalog-head">
            <div>
              <strong>${escapeHtml(row.label)}</strong>
              <span>${escapeHtml(collections)} | ${escapeHtml(row.collectionFiles)}</span>
            </div>
            ${renderGolfLabSourceCatalogBadge(row.status)}
          </div>
          <div class="golf-lab-source-catalog-meta">
            <span><b>${escapeHtml(row.priority)}</b><em>${row.cadenceDays}d cadence</em></span>
            <span><b>${row.rowCount}/${row.threshold || row.rowCount || 1}</b><em>rows</em></span>
            <span><b>${escapeHtml(row.sourceProofStatus)}</b><em>proof</em></span>
          </div>
          <p>${escapeHtml(row.notes)}</p>
          <small>${escapeHtml(providerText)} | ${escapeHtml(sourceLine)}</small>
          <i style="--source-catalog-fill:${row.progress}%"></i>
        </article>
      `;
    }).join("");
    els.golfLabSourceCatalogBoard.innerHTML = `
      <section class="golf-lab-source-catalog">
        <div class="golf-lab-kpi-grid golf-lab-source-catalog-kpis">
          ${renderGolfLabKpi("Catalog Score", `${board.score}%`, `${board.summary.ready}/${board.summary.tasks} ready`)}
          ${renderGolfLabKpi("Proofed", `${board.summary.proofReady}/${board.summary.tasks}`, `${board.summary.sourceUrls} source URLs`)}
          ${renderGolfLabKpi("Target Files", String(board.summary.targetFiles), `${board.summary.critical} critical | ${board.summary.high} high`)}
          ${renderGolfLabKpi("Needs Work", String(board.summary.missing + board.summary.planned), eventLabel)}
        </div>
        <div class="golf-lab-source-catalog-actions">${nextRows}</div>
        <div class="golf-lab-source-catalog-grid">${rows}</div>
      </section>
    `;
  }

  function renderGolfLabBackfillLane(lane) {
    const key = String(lane.priority || "medium").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "medium";
    return `<span class="golf-lab-backfill-lane golf-lab-backfill-lane-${escapeHtml(key)}">${escapeHtml(lane.label)}</span>`;
  }

  function renderGolfLabHistoricalBackfillBoard(lab) {
    if (!els.golfLabHistoricalBackfillBoard) return;
    if (typeof buildHistoricalBackfillBoard !== "function") {
      els.golfLabHistoricalBackfillBoard.innerHTML = emptyState("Historical backfill planner is not available.");
      return;
    }
    const board = buildHistoricalBackfillBoard(lab, { limit: 8 });
    if (!board.rows.length) {
      els.golfLabHistoricalBackfillBoard.innerHTML = emptyState("Import a source-backed event schedule to start historical backfill planning.");
      return;
    }
    const actionRows = board.nextActions.slice(0, 5).map((row) => `
      <span class="golf-lab-backfill-action golf-lab-backfill-action-${escapeHtml(row.stage)}">
        <b>${escapeHtml(row.eventName)}</b>
        <em>${escapeHtml(row.nextAction)}</em>
      </span>
    `).join("") || `<span class="golf-lab-backfill-action golf-lab-backfill-action-ready"><b>Backfill clear</b><em>Historical events are model-ready.</em></span>`;
    const rows = board.rows.map((row) => {
      const missing = row.missingLanes.length
        ? row.missingLanes.map(renderGolfLabBackfillLane).join("")
        : `<span class="golf-lab-backfill-lane golf-lab-backfill-lane-ready">Model-ready rows</span>`;
      const adapterTypes = (row.missingAdapterTypes || []).length
        ? row.missingAdapterTypes.slice(0, 8).map((type) => `<span>${escapeHtml(type)}</span>`).join("")
        : `<span>refresh</span>`;
      const targetFiles = (row.targetFiles || []).length
        ? row.targetFiles.slice(0, 5).map((file) => `<span>${escapeHtml(file)}</span>`).join("")
        : `<span>source_fetches.csv</span>`;
      const context = [
        row.tour,
        row.season,
        row.startDate,
        row.courseName
      ].filter(Boolean).join(" | ");
      return `
        <article class="golf-lab-backfill-row golf-lab-backfill-row-${escapeHtml(row.stage)}">
          <div class="golf-lab-backfill-head">
            <div>
              <strong>${escapeHtml(row.eventName)}</strong>
              <span>${escapeHtml(context || "Imported tournament")}</span>
            </div>
            <b>${row.priorityScore}</b>
          </div>
          <div class="golf-lab-backfill-bars">
            <span><b>${row.readinessScore}%</b><em>data ready</em></span>
            <span><b>${row.proofScore}%</b><em>proof ready</em></span>
            <span><b>${escapeHtml(row.stage)}</b><em>stage</em></span>
          </div>
          <div class="golf-lab-backfill-counts">
            <span>${row.counts.field} field</span>
            <span>${row.counts.rounds} rounds</span>
            <span>${row.counts.strokesGained} SG</span>
            <span>${row.counts.weather} weather</span>
            <span>${row.counts.markets} odds</span>
          </div>
          <div class="golf-lab-backfill-command">
            <code>${escapeHtml(row.batchCommand || "Run event research packet first.")}</code>
            <div><b>Adapters</b>${adapterTypes}</div>
            <div><b>Writes</b>${targetFiles}</div>
          </div>
          <div class="golf-lab-backfill-lanes">${missing}</div>
          <small>${escapeHtml(row.nextAction)}</small>
        </article>
      `;
    }).join("");
    els.golfLabHistoricalBackfillBoard.innerHTML = `
      <section class="golf-lab-backfill">
        <div class="golf-lab-kpi-grid golf-lab-backfill-kpis">
          ${renderGolfLabKpi("Events", String(board.summary.events), `${board.summary.historicalEvents} historical`)}
          ${renderGolfLabKpi("Model Ready", String(board.summary.modelReadyEvents), `${board.summary.proofReadyEvents} proof-ready`)}
          ${renderGolfLabKpi("Priority", String(board.summary.priorityEvents), "events above backfill threshold")}
          ${renderGolfLabKpi("Batch Commands", String(board.summary.batchCommands || 0), `${board.summary.missingWeather} weather | ${board.summary.missingMarkets} odds`)}
        </div>
        <div class="golf-lab-backfill-actions">${actionRows}</div>
        <div class="golf-lab-backfill-grid">${rows}</div>
      </section>
    `;
  }

  function getSelectedGolfLabEventId() {
    return els.golfLabModelEventSelect && !els.golfLabModelEventSelect.disabled
      ? els.golfLabModelEventSelect.value
      : "";
  }

  function prettyGolfLabCollection(key) {
    return String(key || "")
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (char) => char.toUpperCase());
  }

  function golfLabAgeDaysFromIso(value) {
    const time = Date.parse(value || "");
    if (!Number.isFinite(time)) return null;
    return Math.max(0, (Date.now() - time) / 86400000);
  }

  function renderGolfLabSourceProof(task) {
    const proof = task.sourceProof || {};
    const status = String(proof.status || "missing").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "missing";
    const labelMap = {
      ready: "Proof ready",
      planned: "Planned",
      partial: "Partial proof",
      review: "Review",
      missing: "No proof"
    };
    const ageText = proof.latestAt ? formatGolfLabSourceAge(golfLabAgeDaysFromIso(proof.latestAt)) : "";
    const sourceLine = [
      proof.label || "",
      proof.ledgerRows ? `${proof.ledgerRows} ledger row${proof.ledgerRows === 1 ? "" : "s"}` : "",
      proof.rowCount ? `${proof.rowCount} source rows` : "",
      ageText
    ].filter(Boolean).join(" | ");
    const urlLine = proof.primarySourceUrl ? `Source: ${proof.primarySourceUrl}` : "";
    return `
      <div class="golf-lab-source-proof golf-lab-source-proof-${escapeHtml(status)}">
        <b>${escapeHtml(labelMap[status] || status)}</b>
        <span>${escapeHtml(sourceLine || "Add provider, URL, row count, and fetchedAt in source_fetches.csv.")}</span>
        ${urlLine ? `<small>${escapeHtml(urlLine)}</small>` : ""}
      </div>
    `;
  }

  function renderGolfLabSourcePlan(lab) {
    if (!els.golfLabSourcePlan) return;
    if (typeof buildEventSourcePlan !== "function") {
      els.golfLabSourcePlan.innerHTML = emptyState("Source planner is not available.");
      return;
    }
    const plan = buildEventSourcePlan(lab, { eventId: getSelectedGolfLabEventId() });
    const eventLabel = plan.event
      ? [plan.event.name || plan.event.id, plan.event.startDate, plan.event.courseName].filter(Boolean).join(" | ")
      : "No event selected";
    const nextActions = plan.nextActions.map((task) => `
      <span class="golf-lab-source-chip golf-lab-source-chip-${escapeHtml(task.priority)}">${escapeHtml(task.label)}</span>
    `).join("") || `<span class="golf-lab-source-chip golf-lab-source-chip-ready">Research complete</span>`;
    const taskRows = plan.tasks.map((task) => {
      const fill = task.threshold > 0 ? Math.min(100, Math.round((task.rowCount / task.threshold) * 100)) : 0;
      const count = task.threshold > 0 ? `${task.rowCount}/${task.threshold}` : `${task.rowCount}`;
      const collections = task.collectionKeys.map(prettyGolfLabCollection).join(" + ");
      return `<div class="golf-lab-source-task golf-lab-source-task-${escapeHtml(task.status)}">
        <div>
          <strong>${escapeHtml(task.label)}</strong>
          <span>${escapeHtml(collections)} | ${escapeHtml(task.sourceType)}</span>
        </div>
        <div class="golf-lab-source-task-meta">
          <em>${escapeHtml(task.status)}</em>
          <b>${escapeHtml(count)}</b>
        </div>
        ${renderGolfLabSourceProof(task)}
        <small>${escapeHtml(task.suggestedFileName)}</small>
        <i style="--source-fill:${fill}%"></i>
      </div>`;
    }).join("");

    els.golfLabSourcePlan.innerHTML = `
      <section class="golf-lab-source-plan">
        <div class="golf-lab-source-summary">
          <div class="golf-lab-source-score">
            <span>Research Score</span>
            <strong>${plan.score}</strong>
            <em>${plan.readyCount}/${plan.totalTasks} ready | ${plan.sourceReadyCount || 0} proofed</em>
          </div>
          <div class="golf-lab-source-next">
            <h4>${escapeHtml(eventLabel)}</h4>
            <div>${nextActions}</div>
          </div>
        </div>
        <div class="golf-lab-source-task-grid">${taskRows}</div>
      </section>
    `;
  }

  function renderGolfLabPlayerIdentityBoard(lab) {
    if (!els.golfLabPlayerIdentityBoard) return;
    if (typeof buildPlayerIdentityBoard !== "function") {
      els.golfLabPlayerIdentityBoard.innerHTML = emptyState("Player identity resolution is not available.");
      return;
    }
    if (!hasGolfLabData(lab)) {
      els.golfLabPlayerIdentityBoard.innerHTML = emptyState("Import source-backed player and tournament rows to audit identity matching.");
      return;
    }
    const board = buildPlayerIdentityBoard(lab, { eventId: getSelectedGolfLabEventId() });
    const eventLine = board.selectedEvent
      ? [board.selectedEvent.name, board.selectedEvent.startDate, board.selectedEvent.courseName].filter(Boolean).join(" | ")
      : "No selected event";
    const blockers = board.blockers.slice(0, 4).map((blocker) => `
      <span class="golf-lab-identity-blocker golf-lab-identity-blocker-${escapeHtml(blocker.severity || "medium")}">
        <b>${escapeHtml(blocker.label)}</b>
        <em>${escapeHtml(blocker.detail)}</em>
      </span>
    `).join("") || `<span class="golf-lab-identity-blocker golf-lab-identity-blocker-clear"><b>Identity desk clear</b><em>Player rows are matched across source lanes.</em></span>`;
    const collectionRows = board.collectionRows
      .filter((row) => row.rowCount > 0)
      .sort((a, b) => a.matchRate - b.matchRate || b.unresolvedRows - a.unresolvedRows || String(a.label || "").localeCompare(String(b.label || "")))
      .slice(0, 8)
      .map((row) => {
        const gaps = row.gaps.length ? row.gaps.slice(0, 2).join(", ") : "resolved";
        return `
          <article class="golf-lab-identity-row golf-lab-identity-row-${escapeHtml(row.status)}">
            <div>
              <strong>${escapeHtml(row.label)}</strong>
              <span>${row.matchedRows}/${row.rowCount} matched | ${row.normalizedRows} normalized aliases | ${row.eventUnresolvedRows} event gaps</span>
              <small>${escapeHtml(gaps)}</small>
            </div>
            <div>
              ${renderGolfLabSourceBadge(row.status)}
              <em>${row.matchRate}%</em>
              <i style="--identity:${row.matchRate}%"></i>
            </div>
          </article>
        `;
      }).join("") || emptyState("No player-linked collections imported yet.");
    const unresolvedRows = board.unresolvedRows.slice(0, 7).map((row) => {
      const rawName = [row.playerName, row.playerId].filter(Boolean).join(" | ") || row.rowId;
      const suggestion = row.suggestedPlayerName
        ? `Suggested: ${row.suggestedPlayerName}${Number.isFinite(row.suggestionScore) ? ` (${row.suggestionScore}%)` : ""}`
        : row.ambiguousPlayers.length
          ? `Ambiguous: ${row.ambiguousPlayers.map((player) => player.playerName).slice(0, 3).join(" / ")}`
          : "No profile candidate";
      return `
        <article class="golf-lab-identity-review golf-lab-identity-review-${escapeHtml(row.status)}">
          <div>
            <strong>${escapeHtml(rawName)}</strong>
            <span>${escapeHtml(row.collectionLabel)}${row.eventId ? ` | ${escapeHtml(row.eventId)}` : ""}</span>
            <small>${escapeHtml([row.sourceProvider, suggestion].filter(Boolean).join(" | "))}</small>
          </div>
          ${renderGolfLabSourceBadge(row.status)}
        </article>
      `;
    }).join("") || emptyState("No unresolved player identities.");
    const duplicateRows = board.duplicateProfiles.slice(0, 4).map((row) => `
      <div class="golf-lab-identity-duplicate">
        <strong>${escapeHtml(row.alias)}</strong>
        <span>${escapeHtml(row.players.map((player) => player.playerName).join(" / "))}</span>
      </div>
    `).join("") || emptyState("No duplicate profile signals.");

    els.golfLabPlayerIdentityBoard.innerHTML = `
      <section class="golf-lab-identity">
        <div class="golf-lab-kpi-grid golf-lab-identity-kpis">
          ${renderGolfLabKpi("Identity Score", `${board.summary.matchRate}%`, board.summary.status)}
          ${renderGolfLabKpi("Matched Rows", `${board.summary.matchedRows}/${board.summary.identityRows}`, `${board.summary.normalizedRows} normalized`)}
          ${renderGolfLabKpi("Unresolved", String(board.summary.unresolvedRows), `${board.summary.selectedEventUnresolved} selected event`)}
          ${renderGolfLabKpi("Profile Risk", String(board.summary.duplicateProfiles + board.summary.aliasConflicts), eventLine)}
        </div>
        <div class="golf-lab-identity-blockers">${blockers}</div>
        <div class="golf-lab-identity-grid">
          <section class="golf-lab-identity-block golf-lab-identity-block-collections">
            <h4>Collection Matching</h4>
            <div class="golf-lab-identity-list">${collectionRows}</div>
          </section>
          <section class="golf-lab-identity-block">
            <h4>Resolution Queue</h4>
            <div class="golf-lab-identity-list">${unresolvedRows}</div>
          </section>
          <section class="golf-lab-identity-block">
            <h4>Duplicate Profile Signals</h4>
            <div class="golf-lab-identity-list">${duplicateRows}</div>
          </section>
        </div>
      </section>
    `;
  }

  function formatGolfLabPerformanceValue(row) {
    if (!row) return "--";
    if (Number.isFinite(row.avgSg)) return `${formatLabNumber(row.avgSg, 2, true)} SG`;
    if (Number.isFinite(row.avgToPar)) return `${formatLabNumber(row.avgToPar, 1, true)} to par`;
    return "--";
  }

  function renderGolfLabPlayerIndexLeader(label, row, valueText) {
    return `<div class="golf-lab-player-index-leader">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(row ? row.playerName : "--")}</strong>
      <em>${escapeHtml(valueText || "--")}</em>
    </div>`;
  }

  function renderGolfLabPlayerIndexBoard(lab) {
    if (!els.golfLabPlayerIndexBoard) return;
    if (typeof buildPlayerIndexBoard !== "function" || !lab.players.length) {
      els.golfLabPlayerIndexBoard.innerHTML = emptyState("Import source-backed pro player, scoring, and skill rows to build the player index.");
      return;
    }
    const board = buildPlayerIndexBoard(lab, { limit: 8, eventId: getSelectedGolfLabEventId() });
    if (!board.rows.length) {
      els.golfLabPlayerIndexBoard.innerHTML = emptyState("Import source-backed pro player, scoring, and skill rows to build the player index.");
      return;
    }
    const summary = board.summary;
    const leaders = `
      <div class="golf-lab-player-index-leaders">
        ${renderGolfLabPlayerIndexLeader("SG Leader", summary.sgLeader, summary.sgLeader ? formatLabNumber(summary.sgLeader.skills.sgTotal, 2, true) : "--")}
        ${renderGolfLabPlayerIndexLeader("Distance", summary.distanceLeader, summary.distanceLeader ? `${formatLabNumber(summary.distanceLeader.skills.drivingDistance, 0)} yds` : "--")}
        ${renderGolfLabPlayerIndexLeader("Accuracy", summary.accuracyLeader, summary.accuracyLeader ? formatLabPercent(summary.accuracyLeader.skills.accuracy) : "--")}
        ${renderGolfLabPlayerIndexLeader("Tough Tests", summary.toughCourseLeader, summary.toughCourseLeader ? formatGolfLabPerformanceValue(summary.toughCourseLeader.splits.tough) : "--")}
        ${renderGolfLabPlayerIndexLeader("Wind", summary.windLeader, summary.windLeader ? formatGolfLabPerformanceValue(summary.windLeader.splits.wind) : "--")}
        ${renderGolfLabPlayerIndexLeader("Event Fit", summary.eventFitLeader, summary.eventFitLeader && summary.eventFitLeader.eventFit ? `${summary.eventFitLeader.eventFit.score}%` : "--")}
      </div>`;
    const rows = board.rows.map((row) => {
      const player = row.player || {};
      const rankBits = [
        Number.isFinite(player.owgrRank) ? `OWGR ${player.owgrRank}` : "",
        player.tour,
        player.country
      ].filter(Boolean).join(" | ");
      const tags = row.tags.length
        ? row.tags.slice(0, 5).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")
        : `<span>Profile building</span>`;
      const bestCourse = row.bestCourse
        ? `${row.bestCourse.courseName} | ${formatGolfLabPerformanceValue(row.bestCourse)}`
        : "No best-course sample";
      const worstCourse = row.worstCourse
        ? `${row.worstCourse.courseName} | ${formatGolfLabPerformanceValue(row.worstCourse)}`
        : "No stress-course sample";
      const avatar = player.photoUrl
        ? `<img src="${escapeHtml(player.photoUrl)}" alt="">`
        : `<span>${escapeHtml((row.playerName || "?").slice(0, 2).toUpperCase())}</span>`;
      const eventFitText = row.eventFit
        ? `${row.eventFit.score}% | ${row.eventFit.label}`
        : "No selected event";
      const sourceText = row.sourceCoverage
        ? `${row.sourceCoverage.score}% ${row.sourceCoverage.statusLabel}`
        : "Source thin";
      return `
        <button type="button" class="golf-lab-player-index-row" data-golf-lab-player-index-id="${escapeHtml(row.playerId)}">
          <div class="golf-lab-player-index-avatar">${avatar}</div>
          <div class="golf-lab-player-index-main">
            <div class="golf-lab-player-index-title">
              <strong>${escapeHtml(row.playerName)}</strong>
              <span>${escapeHtml(rankBits || "Imported player")}</span>
            </div>
            <div class="golf-lab-player-index-tags">${tags}</div>
            <div class="golf-lab-player-index-courses">
              <span>Best: ${escapeHtml(bestCourse)}</span>
              <span>Stress: ${escapeHtml(worstCourse)}</span>
            </div>
          </div>
          <div class="golf-lab-player-index-metrics">
            ${renderGolfLabKpi("SG", formatLabNumber(row.skills.sgTotal, 2, true), `${row.sample.rounds} rounds`)}
            ${renderGolfLabKpi("Distance", Number.isFinite(row.skills.drivingDistance) ? `${formatLabNumber(row.skills.drivingDistance, 0)} yds` : "--", "driver")}
            ${renderGolfLabKpi("Accuracy", formatLabPercent(row.skills.accuracy), "fairways")}
            ${renderGolfLabKpi("Event Fit", row.eventFit ? `${row.eventFit.score}%` : "--", row.eventFit ? row.eventFit.label : "no event")}
          </div>
          <div class="golf-lab-player-index-depth">
            <span>${escapeHtml(row.profile ? row.profile.archetype : "Profile building")}</span>
            <span>${row.sample.courses} courses</span>
            <span>${escapeHtml(sourceText)}</span>
            <span>${escapeHtml(eventFitText)}</span>
            <strong>${formatLabNumber(row.indexScore, 1)} index</strong>
          </div>
        </button>
      `;
    }).join("");
    els.golfLabPlayerIndexBoard.innerHTML = `
      <section class="golf-lab-player-index">
        <div class="golf-lab-kpi-grid golf-lab-player-index-kpis">
          ${renderGolfLabKpi("Players", String(summary.players), `${summary.playersWithRounds} with rounds`)}
          ${renderGolfLabKpi("Source", Number.isFinite(summary.avgSourceScore) ? `${formatLabNumber(summary.avgSourceScore, 0)}%` : "--", `${summary.playersWithEquipment} bags`)}
          ${renderGolfLabKpi("Accomplishments", String(summary.playersWithAccomplishments), "profile depth")}
          ${renderGolfLabKpi("Event Fits", String(summary.strongEventFits || 0), board.rows[0] ? `top ${formatLabNumber(board.rows[0].indexScore, 1)}` : "--")}
        </div>
        ${leaders}
        <div class="golf-lab-player-index-list">${rows}</div>
      </section>
    `;
  }

  function renderGolfLabPlayerSelect(lab) {
    if (!els.golfLabPlayerSelect || !els.golfLabPlayerScorecard) return;
    const players = [...lab.players].sort((a, b) => a.name.localeCompare(b.name));
    if (!players.length) {
      els.golfLabPlayerSelect.hidden = true;
      els.golfLabPlayerSelect.innerHTML = "";
      els.golfLabPlayerScorecard.innerHTML = emptyState("Import source-backed pro data to populate player scorecards.");
      return;
    }
    els.golfLabPlayerSelect.hidden = false;
    if (!selectedGolfLabPlayerId || !players.some((player) => player.id === selectedGolfLabPlayerId)) {
      selectedGolfLabPlayerId = players[0].id;
    }
    els.golfLabPlayerSelect.innerHTML = players.map((player) => `
      <option value="${escapeHtml(player.id)}"${player.id === selectedGolfLabPlayerId ? " selected" : ""}>${escapeHtml(player.name || player.id)}</option>
    `).join("");
    renderGolfLabPlayerScorecard(lab, selectedGolfLabPlayerId);
  }

  function renderGolfLabPlayerScorecard(lab, playerId) {
    const card = buildPlayerScorecard(lab, playerId, { eventId: getSelectedGolfLabEventId() });
    if (!card) {
      els.golfLabPlayerScorecard.innerHTML = emptyState("Select a player with imported scorecard data.");
      return;
    }
    const { player, skills, sample, bestCourses, worstCourses, multiCourseEvents, difficultySplits, weatherSplits, weatherDna, equipment, accomplishments, profile, sourceCoverage, eventFit, snapshot } = card;
    const rankBits = [
      Number.isFinite(player.owgrRank) ? `OWGR ${player.owgrRank}` : "",
      Number.isFinite(player.dataGolfRank) ? `Data rank ${player.dataGolfRank}` : "",
      player.tour
    ].filter(Boolean).join(" | ");
    els.golfLabPlayerScorecard.innerHTML = `
      <section class="golf-lab-player-card">
        <div class="golf-lab-player-hero">
          <div class="golf-lab-player-avatar">
            ${player.photoUrl ? `<img src="${escapeHtml(player.photoUrl)}" alt="">` : `<span>${escapeHtml((player.name || "?").slice(0, 2).toUpperCase())}</span>`}
          </div>
          <div>
            <p class="eyebrow">${escapeHtml(rankBits || "Imported player")}</p>
            <h3>${escapeHtml(player.name || player.id)}</h3>
            <p>${escapeHtml([player.country, player.college, player.turnedPro ? `Pro ${player.turnedPro}` : ""].filter(Boolean).join(" | "))}</p>
          </div>
        </div>
        <div class="golf-lab-kpi-grid">
          ${renderGolfLabKpi("SG Total", formatLabNumber(skills.sgTotal, 2, true), `${sample.rounds} rounds`)}
          ${renderGolfLabKpi("Tee to Green", formatLabNumber(skills.sgT2g, 2, true), "profile")}
          ${renderGolfLabKpi("Distance", Number.isFinite(skills.drivingDistance) ? `${formatLabNumber(skills.drivingDistance, 0)} yds` : "--", "driving")}
          ${renderGolfLabKpi("Accuracy", formatLabPercent(skills.accuracy), "fairways")}
        </div>
        ${renderGolfLabPlayerSnapshot(snapshot)}
        ${renderGolfLabPlayerProfile(profile, sourceCoverage, eventFit)}
        <div class="golf-lab-scorecard-grid">
          ${renderGolfLabSkillDNA(skills)}
          ${renderGolfLabDifficultySplits(difficultySplits)}
          ${renderGolfLabWeatherDna(weatherDna)}
          ${renderGolfLabWeatherSplits(weatherSplits)}
          ${renderGolfLabCourseTable("Best Courses", bestCourses, "best")}
          ${renderGolfLabCourseTable("Tough Spots", worstCourses, "worst")}
          ${renderGolfLabMultiCourseEvents(multiCourseEvents)}
          ${renderGolfLabAccomplishments(accomplishments)}
          ${renderGolfLabEquipment(equipment)}
        </div>
      </section>
    `;
  }

  function renderGolfLabCourseSelect(lab) {
    if (!els.golfLabCourseSelect || !els.golfLabCourseScorecard) return;
    const courses = [...lab.courses].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    if (!courses.length) {
      els.golfLabCourseSelect.hidden = true;
      els.golfLabCourseSelect.innerHTML = "";
      els.golfLabCourseScorecard.innerHTML = emptyState("Import source-backed course data to populate course scorecards.");
      return;
    }
    els.golfLabCourseSelect.hidden = false;
    if (!selectedGolfLabCourseId || !courses.some((course) => course.id === selectedGolfLabCourseId)) {
      selectedGolfLabCourseId = courses[0].id;
    }
    els.golfLabCourseSelect.innerHTML = courses.map((course) => `
      <option value="${escapeHtml(course.id)}"${course.id === selectedGolfLabCourseId ? " selected" : ""}>${escapeHtml(course.name || course.id)}</option>
    `).join("");
    renderGolfLabCourseScorecard(lab, selectedGolfLabCourseId);
  }

  function renderGolfLabCourseScorecard(lab, courseId) {
    const card = buildCourseScorecard(lab, courseId);
    if (!card) {
      els.golfLabCourseScorecard.innerHTML = emptyState("Select a course with imported history.");
      return;
    }
    const { course, difficulty, sample, weather, topFits, toughFits, events } = card;
    els.golfLabCourseScorecard.innerHTML = `
      <section class="golf-lab-course-card">
        <div class="golf-lab-course-hero">
          <div>
            <p class="eyebrow">${escapeHtml([difficulty.bucket, difficulty.basis].filter(Boolean).join(" | "))}</p>
            <h3>${escapeHtml(course.name || course.id)}</h3>
            <p>${escapeHtml([course.location, course.style].filter(Boolean).join(" | "))}</p>
          </div>
        </div>
        <div class="golf-lab-course-kpis">
          ${renderGolfLabKpi("Difficulty", difficulty.score == null ? difficulty.bucket : formatLabNumber(difficulty.score, 1, true), difficulty.bucket)}
          ${renderGolfLabKpi("Rounds", String(sample.rounds), `${sample.players} players`)}
          ${renderGolfLabKpi("Wind", Number.isFinite(weather.windMph) ? `${formatLabNumber(weather.windMph, 0)} mph` : "--", `${sample.weatherSnapshots} snapshots`)}
          ${renderGolfLabKpi("Events", String(sample.events), "history")}
        </div>
        ${renderGolfLabCourseFitList("Top Fits", topFits, "No player-course fit history yet.")}
        ${renderGolfLabCourseFitList("Tough Fits", toughFits, "No tough-course splits imported yet.")}
        ${renderGolfLabCourseEvents(events)}
      </section>
    `;
  }

  function golfLabDifficultyClass(bucket) {
    return String(bucket || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "unknown";
  }

  function renderGolfLabDifficultyBadge(bucket) {
    return `<span class="golf-lab-difficulty-badge golf-lab-difficulty-${escapeHtml(golfLabDifficultyClass(bucket))}">${escapeHtml(bucket || "Unknown")}</span>`;
  }

  function renderGolfLabCourseFitInline(row, emptyText) {
    if (!row) return escapeHtml(emptyText);
    const value = Number.isFinite(row.avgSg)
      ? `${formatLabNumber(row.avgSg, 2, true)} SG`
      : `${formatLabNumber(row.avgToPar, 1, true)} to par`;
    return `${escapeHtml(row.playerName || row.playerId)} <span>${escapeHtml(value)} | ${row.rounds}r</span>`;
  }

  function renderGolfLabCourseDifficultyBoard(lab) {
    if (!els.golfLabCourseDifficultyBoard) return;
    if (typeof buildCourseDifficultyBoard !== "function" || !lab.courses.length) {
      els.golfLabCourseDifficultyBoard.innerHTML = emptyState("Import source-backed course and scoring data to rank course difficulty.");
      return;
    }
    const board = buildCourseDifficultyBoard(lab, { limit: 8 });
    if (!board.rows.length) {
      els.golfLabCourseDifficultyBoard.innerHTML = emptyState("Import source-backed course and scoring data to rank course difficulty.");
      return;
    }
    const summary = board.summary;
    const bucketText = board.buckets
      .filter((bucket) => bucket.count > 0)
      .map((bucket) => `${bucket.count} ${bucket.bucket}`)
      .join(" | ") || "No buckets";
    const rows = board.rows.map((row) => {
      const scoreText = Number.isFinite(row.hardnessScore) ? formatLabNumber(row.hardnessScore, 1, true) : "--";
      const scoringText = Number.isFinite(row.scoring.avgAdjustedToPar)
        ? `${formatLabNumber(row.scoring.avgAdjustedToPar, 1, true)} adj`
        : Number.isFinite(row.scoring.avgToPar)
          ? `${formatLabNumber(row.scoring.avgToPar, 1, true)} to par`
          : "No scoring";
      const weatherText = Number.isFinite(row.weather.windMph)
        ? `${formatLabNumber(row.weather.windMph, 0)} mph wind`
        : `${row.sample.weatherSnapshots} weather rows`;
      const providerText = row.source.providers.length
        ? row.source.providers.slice(0, 2).join(" + ")
        : "Unverified";
      const latestEvent = row.latestEvent
        ? [row.latestEvent.name || row.latestEvent.id, row.latestEvent.startDate].filter(Boolean).join(" | ")
        : "No event history";
      const meter = Number.isFinite(row.hardnessScore)
        ? Math.max(4, Math.min(100, Math.round(50 + row.hardnessScore * 14)))
        : 0;
      return `
        <button type="button" class="golf-lab-course-difficulty-row golf-lab-course-difficulty-${escapeHtml(golfLabDifficultyClass(row.difficulty.bucket))}" data-golf-lab-course-difficulty-id="${escapeHtml(row.courseId)}">
          <div class="golf-lab-course-difficulty-rank">
            ${renderGolfLabDifficultyBadge(row.difficulty.bucket)}
            <strong>${escapeHtml(scoreText)}</strong>
            <span>${escapeHtml(row.difficulty.basis)}</span>
          </div>
          <div class="golf-lab-course-difficulty-main">
            <div class="golf-lab-course-difficulty-title">
              <strong>${escapeHtml(row.courseName)}</strong>
              <span>${escapeHtml([row.location, row.style, latestEvent].filter(Boolean).join(" | "))}</span>
            </div>
            <div class="golf-lab-course-difficulty-meter" aria-hidden="true"><i style="--course-hardness:${meter}%"></i></div>
            <div class="golf-lab-course-difficulty-meta">
              <span>${row.sample.rounds} rounds</span>
              <span>${row.sample.players} players</span>
              <span>${escapeHtml(scoringText)}</span>
              <span>${escapeHtml(weatherText)}</span>
              <span>${escapeHtml(providerText)}</span>
            </div>
          </div>
          <div class="golf-lab-course-difficulty-fit">
            <div><span>Best fit</span><strong>${renderGolfLabCourseFitInline(row.topFit, "No fit history")}</strong></div>
            <div><span>Stress spot</span><strong>${renderGolfLabCourseFitInline(row.toughFit, "No stress history")}</strong></div>
          </div>
        </button>
      `;
    }).join("");
    els.golfLabCourseDifficultyBoard.innerHTML = `
      <section class="golf-lab-course-difficulty">
        <div class="golf-lab-kpi-grid golf-lab-course-difficulty-kpis">
          ${renderGolfLabKpi("Courses", String(summary.courses), bucketText)}
          ${renderGolfLabKpi("Scored", String(summary.scoredCourses), `${summary.toughCourses} tough tests`)}
          ${renderGolfLabKpi("Hardest", summary.hardest ? summary.hardest.courseName : "--", summary.hardest ? summary.hardest.difficulty.bucket : "no score")}
          ${renderGolfLabKpi("Easiest", summary.easiest ? summary.easiest.courseName : "--", summary.easiest ? summary.easiest.difficulty.bucket : "no score")}
        </div>
        <div class="golf-lab-course-difficulty-list">${rows}</div>
      </section>
    `;
  }

  function renderGolfLabCourseSetupBoard(lab) {
    if (!els.golfLabCourseSetupBoard) return;
    if (typeof buildCourseSetupBoard !== "function" || !lab.events.length) {
      els.golfLabCourseSetupBoard.innerHTML = emptyState("Import a tournament, course setup, scoring history, and source proof to profile setup pressure.");
      return;
    }
    const board = buildCourseSetupBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      courseLimit: 5,
      playerLimit: 6
    });
    if (!board || !board.course) {
      els.golfLabCourseSetupBoard.innerHTML = emptyState("Select a tournament with an imported course profile to build the setup lab.");
      return;
    }
    const readinessKey = String(board.readiness || "thin").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "thin";
    const coursePool = board.coursePool || null;
    const eventLine = [board.event.name, board.event.startDate, board.event.tour].filter(Boolean).join(" | ");
    const courseLine = [
      coursePool ? coursePool.label : board.course.courseName,
      board.course.location,
      board.course.style
    ].filter(Boolean).join(" | ");
    const setupMeta = [
      coursePool ? `${coursePool.courseCount} course pool` : "",
      coursePool && coursePool.confidence ? `${coursePool.confidence} pool` : "",
      board.setup && board.setup.rough ? `Rough ${board.setup.rough}` : "",
      board.setup && board.setup.greenSpeed ? `Greens ${board.setup.greenSpeed}` : "",
      board.setup && board.setup.firmness ? `Firmness ${board.setup.firmness}` : ""
    ].filter(Boolean).join(" | ") || "Setup profile building";
    const sourceText = board.source.providers.length
      ? board.source.providers.slice(0, 3).join(" + ")
      : "No source proof";
    const blockers = board.blockers.length
      ? board.blockers.map((blocker) => `<span>${escapeHtml(blocker)}</span>`).join("")
      : `<span class="golf-lab-course-setup-clear">Setup gates clear</span>`;
    const dimensions = board.dimensions.map((row) => `
      <article class="golf-lab-course-setup-dimension golf-lab-course-setup-dimension-${escapeHtml(row.status)}">
        <div>
          <strong>${escapeHtml(row.label)}</strong>
          <span>${escapeHtml(row.note || "Setup input")}</span>
        </div>
        <b>${escapeHtml(row.value || (row.critical ? "Missing" : "Planned"))}</b>
      </article>
    `).join("");
    const signals = board.signals.length
      ? board.signals.map((signal) => `
        <span class="golf-lab-course-setup-signal golf-lab-course-setup-signal-${escapeHtml(signal.tone || "neutral")}">
          <b>${escapeHtml(signal.label)}</b>
          <em>${escapeHtml(signal.detail || "setup signal")}</em>
        </span>
      `).join("")
      : `<span class="golf-lab-course-setup-empty">No setup signals yet.</span>`;
    const coursePoolRows = coursePool ? coursePool.courses.map((row) => {
      const details = [
        row.location,
        Number.isFinite(row.par) ? `par ${row.par}` : "",
        Number.isFinite(row.yards) ? `${formatLabNumber(row.yards, 0)} yards` : "",
        row.rotationRole,
        row.roundNumbers ? `rounds ${row.roundNumbers}` : ""
      ].filter(Boolean).join(" | ");
      return `<article class="golf-lab-course-pool-row golf-lab-course-pool-row-${escapeHtml(row.confidence || coursePool.confidence || "verified")}">
        <div>
          <strong>${escapeHtml(row.courseName || row.courseId)}</strong>
          <span>${escapeHtml(details || "Course-pool member")}</span>
        </div>
        ${renderGolfLabDifficultyBadge(row.difficulty && row.difficulty.bucket)}
      </article>`;
    }).join("") : "";
    const compRows = board.compCourses.slice(0, 5).map((row) => `
      <article class="golf-lab-course-setup-comp">
        <div>
          <strong>${escapeHtml(row.courseName)}</strong>
          <span>${escapeHtml([row.location, row.difficulty && row.difficulty.bucket, `${row.sample.rounds} rounds`].filter(Boolean).join(" | "))}</span>
        </div>
        <b>${row.similarity}%</b>
        <div class="golf-lab-course-comp-meter" aria-hidden="true"><i style="--comp:${row.similarity}%"></i></div>
      </article>
    `).join("");
    const playerRows = board.playerFits.slice(0, 6).map((row) => {
      const value = Number.isFinite(row.avgSg)
        ? `${formatLabNumber(row.avgSg, 2, true)} SG`
        : `${formatLabNumber(row.avgToPar, 1, true)} to par`;
      const best = row.bestComp ? `Best comp: ${row.bestComp.courseName}` : "Comp profile building";
      return `
        <article class="golf-lab-course-setup-player ${row.inField ? "golf-lab-course-setup-player-field" : ""}">
          <div>
            <strong>${escapeHtml(row.playerName)}</strong>
            <span>${row.rounds} rounds | ${row.compCourses} comps | ${escapeHtml(best)}</span>
          </div>
          <b>${escapeHtml(value)}</b>
        </article>
      `;
    }).join("");
    els.golfLabCourseSetupBoard.innerHTML = `
      <section class="golf-lab-course-setup golf-lab-course-setup-${escapeHtml(readinessKey)}">
        <div class="golf-lab-course-setup-hero">
          <div>
            <p class="eyebrow">${escapeHtml(eventLine || "Selected tournament")}</p>
            <h3>${escapeHtml(coursePool ? `${coursePool.courseCount}-Course Pool` : board.course.courseName)}</h3>
            <p>${escapeHtml(courseLine || "Imported course profile")}</p>
          </div>
          <div class="golf-lab-course-setup-verdict">
            ${renderGolfLabDifficultyBadge(board.difficulty.bucket)}
            <strong>${escapeHtml(board.pressureLabel)}</strong>
            <span>${escapeHtml(setupMeta)}</span>
          </div>
        </div>
        <div class="golf-lab-kpi-grid golf-lab-course-setup-kpis">
          ${renderGolfLabKpi("Setup Score", `${board.setupScore}%`, board.readiness.replace(/-/g, " "))}
          ${renderGolfLabKpi("Pressure", Number.isFinite(board.pressureScore) ? `${board.pressureScore}/100` : "--", board.pressureLabel)}
          ${renderGolfLabKpi("Dimensions", `${board.summary.dimensionsReady}/${board.dimensions.length}`, `${board.summary.criticalMissing} critical missing`)}
          ${renderGolfLabKpi("Source Proof", `${board.summary.sourceProviders} providers`, sourceText)}
        </div>
        <div class="golf-lab-course-setup-blockers">${blockers}</div>
        <div class="golf-lab-course-setup-grid">
          ${coursePool ? `<section class="golf-lab-course-setup-block golf-lab-course-pool-block">
            <h4>Course Pool</h4>
            <div class="golf-lab-course-pool-list">${coursePoolRows}</div>
          </section>` : ""}
          <section class="golf-lab-course-setup-block">
            <h4>Setup Dimensions</h4>
            <div class="golf-lab-course-setup-dimensions">${dimensions}</div>
          </section>
          <section class="golf-lab-course-setup-block">
            <h4>Pressure Signals</h4>
            <div class="golf-lab-course-setup-signals">${signals}</div>
          </section>
          <section class="golf-lab-course-setup-block">
            <h4>Closest Course Comps</h4>
            <div class="golf-lab-course-setup-list">${compRows || emptyState("Import more course profiles to identify setup comps.")}</div>
          </section>
          <section class="golf-lab-course-setup-block">
            <h4>Player Setup Fits</h4>
            <div class="golf-lab-course-setup-list">${playerRows || emptyState("Import player rounds on comp courses to rank setup fits.")}</div>
          </section>
        </div>
      </section>
    `;
  }

  function renderGolfLabPlayerSplitMetric(metric, labelOverride) {
    if (!metric) {
      return `<span class="golf-lab-player-split-metric golf-lab-player-split-metric-missing"><b>${escapeHtml(labelOverride || "Split")}</b><em>--</em><small>No sample</small></span>`;
    }
    return `<span class="golf-lab-player-split-metric golf-lab-player-split-metric-${escapeHtml(metric.tone || "neutral")}">
      <b>${escapeHtml(labelOverride || metric.label || "Split")}</b>
      <em>${escapeHtml(metric.display || "--")}</em>
      <small>${metric.rounds || 0}r</small>
    </span>`;
  }

  function renderGolfLabPlayerSplitLeader(label, row, metricKey) {
    if (!row) {
      return `<article class="golf-lab-player-split-leader"><span>${escapeHtml(label)}</span>${emptyState("No leader yet.")}</article>`;
    }
    const metric = metricKey && row.metrics ? row.metrics[metricKey] : null;
    const metricText = metric ? `${metric.display} | ${metric.rounds} rounds` : `${row.splitScore}% fit`;
    return `<article class="golf-lab-player-split-leader">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(row.playerName)}</strong>
      <em>${escapeHtml(metricText)}</em>
    </article>`;
  }

  function renderGolfLabPlayerSplitLab(lab) {
    if (!els.golfLabPlayerSplitLabBoard) return;
    if (typeof buildPlayerSplitLab !== "function" || !lab.events.length || !lab.players.length) {
      els.golfLabPlayerSplitLabBoard.innerHTML = emptyState("Import players, tournaments, course context, and scoring splits to build player split intelligence.");
      return;
    }
    const board = buildPlayerSplitLab(lab, {
      eventId: getSelectedGolfLabEventId(),
      limit: 10,
      courseLimit: 5
    });
    if (!board) {
      els.golfLabPlayerSplitLabBoard.innerHTML = emptyState("Select a tournament to rank field-player split fit.");
      return;
    }
    const targetLine = [
      board.course ? board.course.courseName : board.event.courseName,
      board.target.difficulty.bucket,
      board.target.weather.bucket
    ].filter(Boolean).join(" | ");
    const blockers = board.blockers.length
      ? board.blockers.map((blocker) => `<span>${escapeHtml(blocker)}</span>`).join("")
      : `<span class="golf-lab-player-split-clear">Split gates clear</span>`;
    const rows = board.rows.map((row) => {
      const source = row.sourceCoverage ? `${row.sourceCoverage.score}% ${row.sourceCoverage.statusLabel}` : "No source score";
      const tags = [
        row.recommendation,
        row.profile && row.profile.archetype,
        row.inField ? "In field" : "All-player mode",
        source
      ].filter(Boolean);
      const gapText = row.gaps && row.gaps.length
        ? row.gaps.slice(0, 3).map((gap) => `<span>${escapeHtml(gap)}</span>`).join("")
        : `<span>Split inputs clear</span>`;
      return `
        <article class="golf-lab-player-split-row">
          <div class="golf-lab-player-split-score">
            <strong>${row.splitScore}%</strong>
            <span>fit</span>
          </div>
          <div class="golf-lab-player-split-main">
            <div>
              <strong>${escapeHtml(row.playerName)}</strong>
              <span>${escapeHtml(tags.join(" | "))}</span>
            </div>
            <div class="golf-lab-player-split-metrics">
              ${renderGolfLabPlayerSplitMetric(row.metrics.targetDifficulty, "Target")}
              ${renderGolfLabPlayerSplitMetric(row.metrics.tough, "Tough")}
              ${renderGolfLabPlayerSplitMetric(row.metrics.easy, "Easy")}
              ${renderGolfLabPlayerSplitMetric(row.metrics.targetWeather, "Weather")}
              ${renderGolfLabPlayerSplitMetric(row.metrics.comp, "Comps")}
            </div>
            <div class="golf-lab-player-split-gaps">${gapText}</div>
          </div>
        </article>
      `;
    }).join("");
    els.golfLabPlayerSplitLabBoard.innerHTML = `
      <section class="golf-lab-player-split">
        <div class="golf-lab-player-split-hero">
          <div>
            <p class="eyebrow">${escapeHtml([board.event.name, board.event.startDate].filter(Boolean).join(" | ") || "Selected event")}</p>
            <h3>${escapeHtml(targetLine || "Split Intelligence")}</h3>
            <p>${escapeHtml(board.target.fieldMode === "selected-field" ? "Ranking selected-field players" : "Ranking all imported players")}</p>
          </div>
          <div class="golf-lab-player-split-verdict">
            ${renderGolfLabDifficultyBadge(board.target.difficulty.bucket)}
            <strong>${board.summary.strongFits} strong fits</strong>
            <span>${board.summary.splitReadyPlayers}/${board.summary.players} split-ready players</span>
          </div>
        </div>
        <div class="golf-lab-kpi-grid golf-lab-player-split-kpis">
          ${renderGolfLabKpi("Players", String(board.summary.players), `${board.summary.matchedFieldPlayers}/${board.summary.fieldRows || board.summary.players} matched field`)}
          ${renderGolfLabKpi("Tough Plus", String(board.summary.toughPositive), `${board.target.difficulty.bucket} setup`)}
          ${renderGolfLabKpi("Weather Plus", String(board.summary.weatherPositive), board.target.weather.bucket)}
          ${renderGolfLabKpi("Source Avg", Number.isFinite(board.summary.avgSourceScore) ? `${formatLabNumber(board.summary.avgSourceScore, 0)}%` : "--", `${board.summary.blockers} blockers`)}
        </div>
        <div class="golf-lab-player-split-blockers">${blockers}</div>
        <div class="golf-lab-player-split-leaders">
          ${renderGolfLabPlayerSplitLeader("Overall Fit", board.leaders.overall)}
          ${renderGolfLabPlayerSplitLeader("Tough Courses", board.leaders.tough, "tough")}
          ${renderGolfLabPlayerSplitLeader("Easy Courses", board.leaders.easy, "easy")}
          ${renderGolfLabPlayerSplitLeader("Target Weather", board.leaders.weather, "targetWeather")}
          ${renderGolfLabPlayerSplitLeader("Course Comps", board.leaders.comp, "comp")}
        </div>
        <div class="golf-lab-player-split-list">${rows || emptyState("Import field-player scoring splits to populate the lab.")}</div>
      </section>
    `;
  }

  function renderGolfLabFeatureStorePart(part) {
    return `<span class="golf-lab-feature-store-part golf-lab-feature-store-part-${escapeHtml(part.status || "missing")}">
      <b>${escapeHtml(part.label || part.key)}</b>
      <em>${part.score}%</em>
      <small>${part.sample || 0}/${part.sampleTarget || 1}</small>
    </span>`;
  }

  function renderGolfLabFeatureStoreBoard(lab) {
    if (!els.golfLabFeatureStoreBoard) return;
    if (typeof buildFeatureStoreAuditBoard !== "function" || !lab.events.length) {
      els.golfLabFeatureStoreBoard.innerHTML = emptyState("Import a tournament field and model inputs to audit the feature store.");
      return;
    }
    const board = buildFeatureStoreAuditBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      market: golfLabModelSettings.marketFilter,
      weatherScenario: golfLabModelSettings.weatherScenario,
      maxFieldSize: 156
    });
    if (!board || !board.event) {
      els.golfLabFeatureStoreBoard.innerHTML = emptyState("Select a tournament to audit model feature readiness.");
      return;
    }
    const readinessKey = String(board.readiness || "thin").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "thin";
    const blockers = board.blockers.length
      ? board.blockers.map((blocker) => `<span>${escapeHtml(blocker)}</span>`).join("")
      : `<span class="golf-lab-feature-store-clear">Feature gates clear</span>`;
    const gateRows = board.gates.map((gate) => `
      <article class="golf-lab-feature-store-gate golf-lab-feature-store-gate-${escapeHtml(gate.status)}">
        <div>
          <strong>${escapeHtml(gate.label)}</strong>
          <span>${gate.readyPlayers}/${gate.playerCount} ready players</span>
        </div>
        <b>${gate.score}%</b>
      </article>
    `).join("");
    const playerRows = board.rows.slice(0, 10).map((row) => {
      const parts = (row.parts || []).map(renderGolfLabFeatureStorePart).join("");
      const blockersText = row.blockers.length
        ? row.blockers.slice(0, 4).map((blocker) => `<span>${escapeHtml(blocker)}</span>`).join("")
        : `<span>Player feature row ready</span>`;
      return `
        <article class="golf-lab-feature-store-row golf-lab-feature-store-row-${escapeHtml(row.readiness)}">
          <div class="golf-lab-feature-store-score">
            <strong>${row.score}%</strong>
            <span>${escapeHtml(row.readiness.replace(/-/g, " "))}</span>
          </div>
          <div class="golf-lab-feature-store-main">
            <div>
              <strong>${escapeHtml(row.playerName)}</strong>
              <span>${row.sample.rounds} rounds | ${row.sample.strokesGainedRows} SG | ${row.sample.predictionRows} model | ${row.sample.oddsRows} odds | ${row.sample.sourceProofRows}/${row.sample.sourceRows} sourced</span>
            </div>
            <div class="golf-lab-feature-store-parts">${parts}</div>
            <div class="golf-lab-feature-store-blockers">${blockersText}</div>
          </div>
        </article>
      `;
    }).join("");
    const courseLine = [
      board.course && board.course.name,
      board.course && board.course.difficulty ? board.course.difficulty.bucket : "",
      board.weatherScenario && board.weatherScenario.label,
      golfLabMarketFilterLabel(board.marketFilter)
    ].filter(Boolean).join(" | ");
    els.golfLabFeatureStoreBoard.innerHTML = `
      <section class="golf-lab-feature-store golf-lab-feature-store-${escapeHtml(readinessKey)}">
        <div class="golf-lab-feature-store-hero">
          <div>
            <p class="eyebrow">${escapeHtml([board.event.name, board.event.startDate].filter(Boolean).join(" | ") || "Selected event")}</p>
            <h3>${escapeHtml(courseLine || "Feature Store")}</h3>
            <p>${escapeHtml(`${board.summary.readyPlayers}/${board.summary.players} players model-ready | ${board.summary.blockedPlayers} blocked`)}</p>
          </div>
          <div class="golf-lab-feature-store-verdict">
            ${renderGolfLabSourceBadge(board.readiness)}
            <strong>${board.score}%</strong>
            <span>feature trust score</span>
          </div>
        </div>
        <div class="golf-lab-kpi-grid golf-lab-feature-store-kpis">
          ${renderGolfLabKpi("Players", String(board.summary.players), `${board.summary.fieldRows} field rows`)}
          ${renderGolfLabKpi("Ready", String(board.summary.readyPlayers), `${board.summary.modelReadyPlayers} modeled`)}
          ${renderGolfLabKpi("Blocked", String(board.summary.blockedPlayers), `${board.summary.blockers} board blockers`)}
          ${renderGolfLabKpi("Weather", board.summary.weatherBucket, board.weatherScenario.label)}
        </div>
        <div class="golf-lab-feature-store-blockers">${blockers}</div>
        <div class="golf-lab-feature-store-gates">${gateRows}</div>
        <div class="golf-lab-feature-store-list">${playerRows || emptyState("Import field players to audit feature rows.")}</div>
      </section>
    `;
  }

  function getGolfLabCourseCompOptions() {
    const eventId = getSelectedGolfLabEventId();
    return {
      eventId,
      courseId: eventId ? "" : selectedGolfLabCourseId,
      courseLimit: 5,
      playerLimit: 6
    };
  }

  function renderGolfLabCompEvidence(items) {
    const chips = (items || []).filter(Boolean).slice(0, 4);
    if (!chips.length) return `<span>Source-backed course profile</span>`;
    return chips.map((item) => `<span>${escapeHtml(item)}</span>`).join("");
  }

  function renderGolfLabCourseCompBoard(lab) {
    if (!els.golfLabCourseCompBoard) return;
    if (typeof buildCourseCompBoard !== "function" || !lab.courses.length) {
      els.golfLabCourseCompBoard.innerHTML = emptyState("Import course profiles and scoring history to build source-backed course comps.");
      return;
    }
    const board = buildCourseCompBoard(lab, getGolfLabCourseCompOptions());
    if (!board) {
      els.golfLabCourseCompBoard.innerHTML = emptyState("Select a course or tournament with an imported course profile.");
      return;
    }
    const target = board.targetCourse;
    const eventNote = board.event
      ? [board.event.name, board.event.startDate].filter(Boolean).join(" | ")
      : "Course database";
    const targetMeta = [
      target.difficulty.bucket,
      Number.isFinite(target.yards) ? `${formatLabNumber(target.yards, 0)} yards` : "",
      Number.isFinite(target.par) ? `par ${formatLabNumber(target.par, 0)}` : "",
      target.style
    ].filter(Boolean).join(" | ");
    const compRows = board.compCourses.map((row) => `
      <article class="golf-lab-course-comp-row">
        <div class="golf-lab-course-comp-head">
          <div>
            <strong>${escapeHtml(row.courseName)}</strong>
            <span>${escapeHtml([row.location, row.difficulty.bucket, Number.isFinite(row.yards) ? `${formatLabNumber(row.yards, 0)}y` : "", Number.isFinite(row.par) ? `par ${formatLabNumber(row.par, 0)}` : ""].filter(Boolean).join(" | "))}</span>
          </div>
          <b>${row.similarity}%</b>
        </div>
        <div class="golf-lab-course-comp-meter" aria-hidden="true"><i style="--comp:${row.similarity}%"></i></div>
        <div class="golf-lab-course-comp-evidence">${renderGolfLabCompEvidence(row.evidence)}</div>
        <small>${row.sample.rounds} rounds | ${row.sample.players} players | ${row.sample.events} events</small>
      </article>
    `).join("");
    const playerRows = board.playerRows.map((row) => {
      const value = Number.isFinite(row.avgSg)
        ? `${formatLabNumber(row.avgSg, 2, true)} SG`
        : `${formatLabNumber(row.avgToPar, 1, true)} to par`;
      const best = row.bestComp ? `Best at ${row.bestComp.courseName}` : "No best comp";
      return `<article class="golf-lab-course-comp-player ${row.inField ? "golf-lab-course-comp-player-field" : ""}">
        <div>
          <strong>${escapeHtml(row.playerName)}</strong>
          <span>${row.rounds} rounds | ${row.compCourses} comps | ${escapeHtml(value)} | ${escapeHtml(best)}</span>
        </div>
        <b>${formatLabNumber(row.fitScore, 2, true)}</b>
        <small>${row.tags.length ? row.tags.map(escapeHtml).join(" | ") : "Comp history"}</small>
      </article>`;
    }).join("");
    els.golfLabCourseCompBoard.innerHTML = `
      <section class="golf-lab-course-comps">
        <div class="golf-lab-kpi-grid golf-lab-course-comp-kpis">
          ${renderGolfLabKpi("Target", target.courseName || "--", eventNote)}
          ${renderGolfLabKpi("Comps", String(board.summary.compCourses), `${formatLabNumber(board.summary.avgSimilarity, 0)}% avg similarity`)}
          ${renderGolfLabKpi("Comp Rounds", String(board.summary.compRounds), `${board.summary.compPlayers} ranked players`)}
          ${renderGolfLabKpi("Field Fits", String(board.summary.fieldPlayersWithComps), board.summary.topPlayer ? board.summary.topPlayer.playerName : "no player history")}
        </div>
        <div class="golf-lab-course-comp-target">
          <strong>${escapeHtml(target.courseName)}</strong>
          <span>${escapeHtml(targetMeta || "Imported course profile")}</span>
        </div>
        <div class="golf-lab-course-comp-grid">
          <section>
            <h4>Closest Courses</h4>
            <div class="golf-lab-course-comp-list">${compRows || emptyState("Import more course profiles to identify comps.")}</div>
          </section>
          <section>
            <h4>Player Comp Fits</h4>
            <div class="golf-lab-course-comp-list">${playerRows || emptyState("Import player rounds on comp courses to rank fits.")}</div>
          </section>
        </div>
      </section>
    `;
  }

  function renderGolfLabCourseFitList(title, rows, emptyMessage) {
    if (!rows.length) {
      return `<article class="golf-lab-card"><h4>${escapeHtml(title)}</h4>${emptyState(emptyMessage)}</article>`;
    }
    return `<article class="golf-lab-card">
      <h4>${escapeHtml(title)}</h4>
      <div class="golf-lab-course-list">
        ${rows.slice(0, 5).map((row) => `
          <div>
            <strong>${escapeHtml(row.playerName)}</strong>
            <span>${row.rounds} rounds | ${Number.isFinite(row.avgSg) ? `${formatLabNumber(row.avgSg, 2, true)} SG` : `${formatLabNumber(row.avgToPar, 1, true)} to par`}</span>
          </div>
        `).join("")}
      </div>
    </article>`;
  }

  function renderGolfLabCourseEvents(events) {
    if (!events.length) {
      return `<article class="golf-lab-card"><h4>Event History</h4>${emptyState("No events imported for this course yet.")}</article>`;
    }
    return `<article class="golf-lab-card">
      <h4>Event History</h4>
      <div class="golf-lab-course-list">
        ${events.slice(0, 5).map((event) => `
          <div>
            <strong>${escapeHtml(event.name || event.id)}</strong>
            <span>${escapeHtml([event.tour, event.startDate, event.status].filter(Boolean).join(" | "))}</span>
          </div>
        `).join("")}
      </div>
    </article>`;
  }

  function renderGolfLabKpi(label, value, note) {
    return `<div class="golf-lab-kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><em>${escapeHtml(note)}</em></div>`;
  }

  function renderGolfLabPlayerSignalRows(rows, emptyLabel) {
    if (!rows || !rows.length) {
      return `<span class="golf-lab-player-signal-empty">${escapeHtml(emptyLabel)}</span>`;
    }
    return rows.map((row) => `
      <span class="golf-lab-player-signal golf-lab-player-signal-${escapeHtml(row.tone || "neutral")}">
        <b>${escapeHtml(row.label || row.id || "Signal")}</b>
        <em>${escapeHtml(row.detail || "")}</em>
      </span>
    `).join("");
  }

  function renderGolfLabPlayerSourcePart(label, value) {
    const safeValue = Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
    return `<span>
      <b>${escapeHtml(label)}</b>
      <em style="--player-source:${safeValue}%"></em>
      <small>${safeValue}%</small>
    </span>`;
  }

  function renderGolfLabPlayerProfile(profile, sourceCoverage, eventFit) {
    if (!profile && !sourceCoverage && !eventFit) return "";
    const tags = profile && profile.tags && profile.tags.length
      ? profile.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")
      : `<span>Profile building</span>`;
    const sourceStatus = sourceCoverage ? String(sourceCoverage.status || "thin").toLowerCase().replace(/[^a-z0-9]+/g, "-") : "thin";
    const sourceGaps = sourceCoverage && sourceCoverage.gaps && sourceCoverage.gaps.length
      ? sourceCoverage.gaps.slice(0, 4).map((gap) => `<span>${escapeHtml(gap)}</span>`).join("")
      : `<span>Source coverage clear</span>`;
    const sourceParts = sourceCoverage && sourceCoverage.parts
      ? [
        renderGolfLabPlayerSourcePart("Profile", sourceCoverage.parts.profile),
        renderGolfLabPlayerSourcePart("Rounds", sourceCoverage.parts.rounds),
        renderGolfLabPlayerSourcePart("SG", sourceCoverage.parts.strokesGained),
        renderGolfLabPlayerSourcePart("Proof", sourceCoverage.parts.proof)
      ].join("")
      : "";
    const eventLine = eventFit && eventFit.event
      ? [eventFit.event.name, eventFit.course ? eventFit.course.courseName : eventFit.event.courseName, eventFit.event.startDate].filter(Boolean).join(" | ")
      : "Select/import a tournament";
    const weatherLine = eventFit && eventFit.targetWeather
      ? [eventFit.targetWeather.bucket, Number.isFinite(eventFit.targetWeather.windMph) ? `${formatLabNumber(eventFit.targetWeather.windMph, 0)} mph` : ""].filter(Boolean).join(" | ")
      : "No event weather";
    const eventSignals = eventFit
      ? renderGolfLabPlayerSignalRows(eventFit.signals ? eventFit.signals.slice(0, 5) : [], "No event fit signals yet.")
      : renderGolfLabPlayerSignalRows([], "Select a tournament to see event fit.");
    const eventGaps = eventFit && eventFit.gaps && eventFit.gaps.length
      ? eventFit.gaps.slice(0, 4).map((gap) => `<span>${escapeHtml(gap)}</span>`).join("")
      : eventFit ? `<span>Fit inputs clear</span>` : "";

    return `
      <section class="golf-lab-player-profile">
        <div class="golf-lab-player-profile-main">
          <div>
            <span>Player Type</span>
            <strong>${escapeHtml(profile ? profile.archetype : "Needs profile")}</strong>
            <em>${escapeHtml(profile && profile.primarySkill ? `Primary signal: ${profile.primarySkill}` : "Imported source profile")}</em>
          </div>
          <div class="golf-lab-player-profile-tags">${tags}</div>
        </div>
        <div class="golf-lab-player-profile-event">
          <div class="golf-lab-player-profile-score">
            <span>Selected Event Fit</span>
            <strong>${eventFit ? `${eventFit.score}%` : "--"}</strong>
            <em>${escapeHtml(eventFit ? eventFit.label : "Needs event")}</em>
          </div>
          <div>
            <b>${escapeHtml(eventLine)}</b>
            <small>${escapeHtml(`${eventFit && eventFit.inField ? "In field" : "Field unconfirmed"} | ${weatherLine}`)}</small>
            <div class="golf-lab-player-profile-signals">${eventSignals}</div>
            ${eventGaps ? `<div class="golf-lab-player-profile-gaps">${eventGaps}</div>` : ""}
          </div>
        </div>
        <div class="golf-lab-player-profile-grid">
          <article class="golf-lab-player-profile-block">
            <h4>Strengths</h4>
            <div>${renderGolfLabPlayerSignalRows(profile ? profile.strengths : [], "No positive signal imported yet.")}</div>
          </article>
          <article class="golf-lab-player-profile-block">
            <h4>Risks</h4>
            <div>${renderGolfLabPlayerSignalRows(profile ? profile.risks : [], "No risk flags from imported data.")}</div>
          </article>
          <article class="golf-lab-player-profile-block golf-lab-player-profile-source golf-lab-player-profile-source-${escapeHtml(sourceStatus)}">
            <h4>Source Coverage</h4>
            <div class="golf-lab-player-source-head">
              <strong>${sourceCoverage ? `${sourceCoverage.score}%` : "--"}</strong>
              <span>${escapeHtml(sourceCoverage ? sourceCoverage.statusLabel : "Thin")}</span>
            </div>
            <div class="golf-lab-player-source-parts">${sourceParts}</div>
            <div class="golf-lab-player-profile-gaps">${sourceGaps}</div>
          </article>
        </div>
      </section>
    `;
  }

  function renderGolfLabSkillDNA(skills) {
    const rows = [
      ["Off the tee", skills.sgOtt],
      ["Approach", skills.sgApp],
      ["Around green", skills.sgArg],
      ["Putting", skills.sgPutt],
      ["GIR", skills.gir],
      ["Scrambling", skills.scrambling]
    ];
    return `<article class="golf-lab-card">
      <h4>Skill DNA</h4>
      <div class="golf-lab-stat-list">
        ${rows.map(([label, value]) => `
          <div><span>${escapeHtml(label)}</span><strong>${label === "GIR" || label === "Scrambling" ? formatLabPercent(value) : formatLabNumber(value, 2, true)}</strong></div>
        `).join("")}
      </div>
    </article>`;
  }

  function renderGolfLabPlayerSnapshotCourse(row, fallback) {
    if (!row) return `<strong>${escapeHtml(fallback)}</strong><span>No imported course split</span>`;
    const score = Number.isFinite(row.avgSg)
      ? `${formatLabNumber(row.avgSg, 2, true)} SG`
      : `${formatLabNumber(row.avgToPar, 1, true)} to par`;
    return `<strong>${escapeHtml(row.courseName || fallback)}</strong><span>${row.rounds} rounds | ${escapeHtml(row.difficulty || "unrated")} | ${escapeHtml(score)}</span>`;
  }

  function renderGolfLabPlayerSnapshot(snapshot) {
    if (!snapshot) return "";
    const topSkill = snapshot.topSkill
      ? `<strong>${escapeHtml(snapshot.topSkill.label)}</strong><span>${formatLabNumber(snapshot.topSkill.value, 2, true)} per round</span>`
      : `<strong>Skill building</strong><span>No SG sample imported</span>`;
    const equipment = snapshot.equipment
      ? `<strong>${escapeHtml(snapshot.equipment.primaryValue)}</strong><span>${escapeHtml(snapshot.equipment.primaryLabel)}${snapshot.equipment.capturedDate ? ` | ${escapeHtml(snapshot.equipment.capturedDate)}` : ""}</span>`
      : `<strong>Bag needed</strong><span>No equipment snapshot</span>`;
    const accomplishment = snapshot.accomplishment
      ? `<strong>${escapeHtml(snapshot.accomplishment.label)}</strong><span>${escapeHtml([snapshot.accomplishment.season, snapshot.accomplishment.type].filter(Boolean).join(" | ") || snapshot.accomplishment.date || "Accomplishment")}</span>`
      : `<strong>Resume needed</strong><span>No accomplishments imported</span>`;
    return `
      <section class="golf-lab-player-snapshot">
        <article class="golf-lab-player-snapshot-hero">
          <span>Scouting Snapshot</span>
          <strong>${escapeHtml(snapshot.headline || "Profile building")}</strong>
          <em>${escapeHtml(snapshot.headlineDetail || `${snapshot.sourceScore || 0}% source score`)}</em>
        </article>
        <article>${topSkill}</article>
        <article>${renderGolfLabPlayerSnapshotCourse(snapshot.bestCourse, "Best course")}</article>
        <article>${renderGolfLabPlayerSnapshotCourse(snapshot.worstCourse, "Trouble course")}</article>
        <article>${equipment}</article>
        <article>${accomplishment}</article>
      </section>
    `;
  }

  function renderGolfLabCourseTable(title, rows, tone) {
    if (!rows.length) {
      return `<article class="golf-lab-card"><h4>${escapeHtml(title)}</h4>${emptyState("No course history imported yet.")}</article>`;
    }
    return `<article class="golf-lab-card golf-lab-card-${escapeHtml(tone)}">
      <h4>${escapeHtml(title)}</h4>
      <div class="golf-lab-course-list">
        ${rows.map((row) => `
          <div>
            <strong>${escapeHtml(row.courseName)}</strong>
            <span>${row.rounds} rounds | ${escapeHtml(row.difficulty)} | ${Number.isFinite(row.avgSg) ? `${formatLabNumber(row.avgSg, 2, true)} SG` : `${formatLabNumber(row.avgToPar, 1, true)} to par`}</span>
          </div>
        `).join("")}
      </div>
    </article>`;
  }

  function renderGolfLabMultiCourseEvents(rows) {
    if (!rows || !rows.length) {
      return `<article class="golf-lab-card"><h4>Multi-Course Events</h4>${emptyState("No multi-course scorecard history pending course assignment.")}</article>`;
    }
    return `<article class="golf-lab-card golf-lab-multi-course-history">
      <h4>Multi-Course Events</h4>
      <div class="golf-lab-multi-course-list">
        ${rows.map((row) => {
          const score = Number.isFinite(row.avgSg)
            ? `${formatLabNumber(row.avgSg, 2, true)} SG`
            : `${formatLabNumber(row.avgToPar, 1, true)} to par`;
          return `<div class="golf-lab-multi-course-row">
            <div>
              <strong>${escapeHtml(row.eventName || row.eventId)}</strong>
              <span>${escapeHtml([row.startDate, `${row.courseCount} course pool`, row.confidence].filter(Boolean).join(" | "))}</span>
              <em>${escapeHtml(row.label || (row.courseNames || []).join(" / "))}</em>
            </div>
            <b>${escapeHtml(score)}</b>
          </div>`;
        }).join("")}
      </div>
    </article>`;
  }

  function renderGolfLabDifficultySplits(rows) {
    if (!rows || !rows.length) {
      return `<article class="golf-lab-card"><h4>Difficulty Splits</h4>${emptyState("No difficulty-tagged scoring history imported yet.")}</article>`;
    }
    return `<article class="golf-lab-card">
      <h4>Difficulty Splits</h4>
      <div class="golf-lab-course-list">
        ${rows.map((row) => `
          <div>
            <strong>${escapeHtml(row.bucket)}</strong>
            <span>${row.rounds} rounds | ${Number.isFinite(row.avgSg) ? `${formatLabNumber(row.avgSg, 2, true)} SG` : `${formatLabNumber(row.avgToPar, 1, true)} to par`}</span>
          </div>
        `).join("")}
      </div>
    </article>`;
  }

  function renderGolfLabWeatherSplits(rows) {
    if (!rows || !rows.length) {
      return `<article class="golf-lab-card"><h4>Weather Splits</h4>${emptyState("No weather-linked scoring history imported yet.")}</article>`;
    }
    return `<article class="golf-lab-card">
      <h4>Weather Splits</h4>
      <div class="golf-lab-course-list">
        ${rows.map((row) => {
          const scoring = Number.isFinite(row.avgSg)
            ? `${formatLabNumber(row.avgSg, 2, true)} SG`
            : `${formatLabNumber(row.avgToPar, 1, true)} to par`;
          const conditions = [
            Number.isFinite(row.avgWindMph) ? `${formatLabNumber(row.avgWindMph, 0)} mph` : "",
            Number.isFinite(row.avgTemperatureF) ? `${formatLabNumber(row.avgTemperatureF, 0)}F` : ""
          ].filter(Boolean).join(" | ");
          return `<div>
            <strong>${escapeHtml(row.bucket)}</strong>
            <span>${row.rounds} rounds | ${escapeHtml(scoring)}${conditions ? ` | ${escapeHtml(conditions)}` : ""}</span>
          </div>`;
        }).join("")}
      </div>
    </article>`;
  }

  function renderGolfLabWeatherDna(dna) {
    if (!dna || !dna.rows || !dna.rows.length) {
      return `<article class="golf-lab-card golf-lab-weather-dna-card"><h4>Weather DNA</h4>${emptyState("No weather-linked scoring history imported yet.")}</article>`;
    }
    const target = dna.target || {};
    const targetScore = Number.isFinite(target.score) ? `${target.score}%` : "--";
    const targetLine = [
      target.bucket && target.bucket !== "No weather" ? target.bucket : "No event weather",
      Number.isFinite(target.windMph) ? `${formatLabNumber(target.windMph, 0)} mph` : "",
      Number.isFinite(target.gustMph) ? `${formatLabNumber(target.gustMph, 0)} gust` : ""
    ].filter(Boolean).join(" | ");
    const best = dna.best ? `${dna.best.bucket} ${formatLabNumber(dna.best.delta, 2, true)}` : "No best bucket";
    const worst = dna.worst ? `${dna.worst.bucket} ${formatLabNumber(dna.worst.delta, 2, true)}` : "No stress bucket";
    const rows = dna.rows.slice(0, 4).map((row) => {
      const delta = Number.isFinite(row.delta) ? formatLabNumber(row.delta, 2, true) : "--";
      const score = Number.isFinite(row.value) ? formatLabNumber(row.value, 2, true) : "--";
      const tone = Number.isFinite(row.delta) && row.delta > 0.25
        ? "positive"
        : Number.isFinite(row.delta) && row.delta < -0.25
          ? "risk"
          : "neutral";
      return `
        <div class="golf-lab-weather-dna-row golf-lab-weather-dna-row-${escapeHtml(tone)}">
          <div>
            <strong>${escapeHtml(row.bucket)}</strong>
            <span>${row.rounds} rounds | ${escapeHtml(row.label)}</span>
          </div>
          <div>
            <b>${escapeHtml(delta)}</b>
            <em>${escapeHtml(score)} value</em>
          </div>
        </div>
      `;
    }).join("");
    return `<article class="golf-lab-card golf-lab-weather-dna-card golf-lab-weather-dna-${escapeHtml(dna.status || "thin")}">
      <h4>Weather DNA</h4>
      <div class="golf-lab-weather-dna-head">
        <div>
          <span>Target Weather</span>
          <strong>${escapeHtml(targetLine)}</strong>
          <em>${escapeHtml(target.label || dna.statusLabel || "Weather sample")}</em>
        </div>
        <b>${escapeHtml(targetScore)}</b>
      </div>
      <div class="golf-lab-weather-dna-meta">
        <span>${dna.totalRounds} weather rounds</span>
        <span>${escapeHtml(dna.statusLabel || "Sample")}</span>
        <span>Best ${escapeHtml(best)}</span>
        <span>Stress ${escapeHtml(worst)}</span>
      </div>
      <div class="golf-lab-weather-dna-list">${rows}</div>
    </article>`;
  }

  function renderGolfLabAccomplishments(accomplishments) {
    if (!accomplishments.length) {
      return `<article class="golf-lab-card"><h4>Accomplishments</h4>${emptyState("No accomplishments imported yet.")}</article>`;
    }
    return `<article class="golf-lab-card">
      <h4>Accomplishments</h4>
      <div class="golf-lab-pill-list">
        ${accomplishments.map((item) => `<span>${escapeHtml([item.season, item.label].filter(Boolean).join(" - "))}</span>`).join("")}
      </div>
    </article>`;
  }

  function renderGolfLabEquipment(equipment) {
    if (!equipment) {
      return `<article class="golf-lab-card"><h4>Bag Snapshot</h4>${emptyState("No source-backed equipment snapshot imported yet.")}</article>`;
    }
    const rows = [
      ["Driver", equipment.driver],
      ["Woods", equipment.fairwayWoods],
      ["Hybrids", equipment.hybrids],
      ["Irons", equipment.irons],
      ["Wedges", equipment.wedges],
      ["Putter", equipment.putter],
      ["Ball", equipment.ball]
    ].filter(([, value]) => value);
    return `<article class="golf-lab-card">
      <h4>Bag Snapshot</h4>
      <div class="golf-lab-stat-list">
        ${rows.length ? rows.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("") : `<div><span>Snapshot</span><strong>${escapeHtml(equipment.capturedDate || "Imported")}</strong></div>`}
      </div>
      ${equipment.sourceUrl ? `<a class="golf-lab-source-link" href="${escapeHtml(equipment.sourceUrl)}" target="_blank" rel="noopener">Source</a>` : ""}
    </article>`;
  }

  function renderGolfLabSplitLeaderBlock(title, rows, emptyMessage) {
    return `<section class="golf-lab-split-leader-block">
      <h4>${escapeHtml(title)}</h4>
      <div class="golf-lab-course-list">
        ${rows.length ? rows.map((row) => {
          const score = Number.isFinite(row.avgSg)
            ? `${formatLabNumber(row.avgSg, 2, true)} SG`
            : `${formatLabNumber(row.avgToPar, 1, true)} to par`;
          return `<div>
            <strong>${escapeHtml(row.playerName || row.playerId)}</strong>
            <span>${row.rounds} rounds | ${escapeHtml(score)}</span>
          </div>`;
        }).join("") : emptyState(emptyMessage)}
      </div>
    </section>`;
  }

  function renderGolfLabSplitLeaders(lab) {
    if (!els.golfLabSplitLeaders) return;
    if (typeof buildPlayerSplitLeaderboards !== "function" || !hasGolfLabData(lab)) {
      els.golfLabSplitLeaders.innerHTML = emptyState("Import scoring and weather rows to rank player splits.");
      return;
    }
    const leaders = buildPlayerSplitLeaderboards(lab, { limit: 4 });
    const hasRows = [
      leaders.toughCourseLeaders,
      leaders.easyCourseLeaders,
      leaders.windLeaders,
      leaders.rainLeaders
    ].some((rows) => rows.length);
    if (!hasRows) {
      els.golfLabSplitLeaders.innerHTML = emptyState("Difficulty and weather splits need linked rounds.");
      return;
    }
    els.golfLabSplitLeaders.innerHTML = `<div class="golf-lab-split-leader-grid">
      ${renderGolfLabSplitLeaderBlock("Tough Courses", leaders.toughCourseLeaders, "No tough-course rounds yet.")}
      ${renderGolfLabSplitLeaderBlock("Easy Courses", leaders.easyCourseLeaders, "No easy-course rounds yet.")}
      ${renderGolfLabSplitLeaderBlock("Wind", leaders.windLeaders, "No wind-linked rounds yet.")}
      ${renderGolfLabSplitLeaderBlock("Rain", leaders.rainLeaders, "No rain-linked rounds yet.")}
    </div>`;
  }

  function renderGolfLabTournamentBoard(lab) {
    if (!els.golfLabTournamentBoard) return;
    const upcoming = [...lab.events]
      .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""))
      .slice(0, 5);
    if (!upcoming.length) {
      els.golfLabTournamentBoard.innerHTML = emptyState("No tournaments imported yet.");
      return;
    }
    const dossier = typeof buildEventDossier === "function"
      ? buildEventDossier(lab, getSelectedGolfLabEventId())
      : null;
    if (!dossier) {
      els.golfLabTournamentBoard.innerHTML = `<div class="golf-lab-stack">
        ${upcoming.map((event) => `
          <div class="golf-lab-event-row">
            <strong>${escapeHtml(event.name || event.id)}</strong>
            <span>${escapeHtml([event.tour, event.startDate, event.courseName].filter(Boolean).join(" | "))}</span>
          </div>
        `).join("")}
      </div>`;
      return;
    }
    const blockers = dossier.blockers.slice(0, 5).map((blocker) =>
      `<span>${escapeHtml(blocker)}</span>`
    ).join("") || `<span>Model foundation ready</span>`;
    const predictions = dossier.winnerPredictions.map((row) => `
      <div class="golf-lab-event-row">
        <strong>${escapeHtml(row.playerName)}</strong>
        <span>${formatLabPercent(row.probability)} winner | fair ${row.fairOddsAmerican || "--"} | edge ${formatLabEdge(row.edge)}</span>
      </div>
    `).join("");
    const fieldRows = dossier.fieldRows.slice(0, 5).map((row) => `
      <div class="golf-lab-event-row">
        <strong>${escapeHtml(row.playerName || row.playerId || "Unknown player")}</strong>
        <span>${escapeHtml([row.status, row.teeTime, row.matched ? "matched" : "unmatched"].filter(Boolean).join(" | "))}</span>
      </div>
    `).join("");
    els.golfLabTournamentBoard.innerHTML = `
      <section class="golf-lab-event-dossier">
        <div class="golf-lab-dossier-hero golf-lab-dossier-${escapeHtml(dossier.readiness)}">
          <div>
            <span>Event Readiness</span>
            <strong>${dossier.readinessScore}</strong>
            <em>${escapeHtml(dossier.readiness.replace(/-/g, " "))}</em>
          </div>
          <p>${escapeHtml([dossier.event.name || dossier.event.id, dossier.event.startDate, dossier.course ? dossier.course.name : dossier.event.courseName].filter(Boolean).join(" | "))}</p>
        </div>
        <div class="golf-lab-dossier-kpis">
          ${renderGolfLabKpi("Field", dossier.counts.field, `${dossier.counts.matchedFields} matched`)}
          ${renderGolfLabKpi("Rounds", dossier.counts.rounds, `${dossier.counts.strokesGainedRows} SG rows`)}
          ${renderGolfLabKpi("Weather", dossier.weather.label, `${formatLabNumber(dossier.weather.windMph, 0)} mph`)}
          ${renderGolfLabKpi("Markets", dossier.counts.oddsSnapshots, `${dossier.counts.predictions} predictions`)}
        </div>
        <div class="golf-lab-dossier-blockers">${blockers}</div>
        <div class="golf-lab-dossier-split">
          <section>
            <h4>${predictions ? "Winner Board" : "Field Preview"}</h4>
            <div class="golf-lab-stack">${predictions || fieldRows || emptyState("Import the field list to populate this event.")}</div>
          </section>
        </div>
      </section>
    `;
  }

  function renderGolfLabFitReasonPills(reasons, emptyLabel) {
    if (!reasons || !reasons.length) {
      return `<span>${escapeHtml(emptyLabel)}</span>`;
    }
    return reasons.map((reason) => `
      <span>${escapeHtml(reason.label)} ${formatLabNumber(reason.value, 2, true)}</span>
    `).join("");
  }

  function renderGolfLabPriceBadge(status) {
    const key = String(status || "unpriced").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "unpriced";
    const labels = {
      edge: "Edge",
      lean: "Lean",
      pass: "Pass",
      unpriced: "No price"
    };
    return `<span class="golf-lab-price-badge golf-lab-price-badge-${escapeHtml(key)}">${escapeHtml(labels[key] || key)}</span>`;
  }

  function renderGolfLabFeatureStrip(features) {
    const rows = [
      ["Skill", features && features.skill],
      ["Form", features && features.recentForm],
      ["Course", features && features.courseFit],
      ["Diff", features && features.difficultyFit],
      ["Wx", features && features.weatherFit]
    ];
    if (features && Number.isFinite(Number(features.liveState)) && Math.abs(Number(features.liveState)) > 0.001) {
      rows.push(["Live", features.liveState]);
    }
    return `<div class="golf-lab-field-feature-strip">
      ${rows.map(([label, value]) => {
        const numeric = Number(value);
        const safe = Number.isFinite(numeric) ? Math.min(100, Math.max(8, Math.abs(numeric) * 24)) : 0;
        const tone = numeric < 0 ? "negative" : "positive";
        return `<span class="golf-lab-field-feature golf-lab-field-feature-${tone}">
          <b>${escapeHtml(label)}</b>
          <em>${formatLabNumber(numeric, 2, true)}</em>
          <i style="--feature:${safe}%"></i>
        </span>`;
      }).join("")}
    </div>`;
  }

  function renderGolfLabReadinessStatus(status, label) {
    const key = String(status || "building").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "building";
    return `<span class="golf-lab-readiness-badge golf-lab-readiness-badge-${escapeHtml(key)}">${escapeHtml(label || status || "Building")}</span>`;
  }

  function renderGolfLabReadinessPart(label, value, note) {
    const safe = Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
    return `<span class="golf-lab-field-readiness-part">
      <b>${escapeHtml(label)}</b>
      <em>${safe}%</em>
      <i style="--readiness:${safe}%"></i>
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </span>`;
  }

  function renderGolfLabFieldReadinessBoard(lab) {
    if (!els.golfLabFieldReadinessBoard) return;
    if (typeof buildFieldReadinessBoard !== "function") {
      els.golfLabFieldReadinessBoard.innerHTML = emptyState("Field readiness is not available.");
      return;
    }
    const board = buildFieldReadinessBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      market: golfLabModelSettings.marketFilter,
      limit: 8
    });
    if (!board) {
      els.golfLabFieldReadinessBoard.innerHTML = emptyState("Import or select a tournament to audit field readiness.");
      return;
    }
    if (!board.rows.length) {
      els.golfLabFieldReadinessBoard.innerHTML = emptyState("Import the tournament field to audit player-level data readiness.");
      return;
    }
    const gapSummary = board.summary.topGaps.length
      ? board.summary.topGaps.map((gap) => `<span>${escapeHtml(gap.label)} <b>${gap.count}</b></span>`).join("")
      : `<span>Research gaps clear</span>`;
    const rows = board.rows.map((row) => {
      const gapChips = row.gaps.length
        ? row.gaps.slice(0, 5).map((gap) => `<span>${escapeHtml(gap)}</span>`).join("")
        : `<span>Ready for model review</span>`;
      const subline = [
        `${row.counts.rounds} rounds`,
        `${row.counts.strokesGainedRows} SG`,
        `${row.counts.courseRounds + row.counts.compRounds} course/comp`,
        `${row.counts.targetWeatherRounds} wx`,
        `${row.sourceProofPct}% source`
      ].join(" | ");
      return `<article class="golf-lab-field-readiness-row golf-lab-field-readiness-${escapeHtml(row.status)}">
        <div class="golf-lab-field-readiness-head">
          <div>
            <strong>${escapeHtml(row.playerName || row.playerId)}</strong>
            <span>${escapeHtml(subline)}</span>
          </div>
          <div>
            <b>${row.score}</b>
            ${renderGolfLabReadinessStatus(row.status, row.statusLabel)}
          </div>
        </div>
        <div class="golf-lab-field-readiness-parts">
          ${renderGolfLabReadinessPart("Profile", row.parts.profile)}
          ${renderGolfLabReadinessPart("Form", row.parts.form)}
          ${renderGolfLabReadinessPart("Course", row.parts.course)}
          ${renderGolfLabReadinessPart("Weather", row.parts.weather)}
          ${renderGolfLabReadinessPart("Market", row.parts.market)}
          ${renderGolfLabReadinessPart("Model", row.parts.model)}
        </div>
        <div class="golf-lab-field-readiness-gaps">${gapChips}</div>
      </article>`;
    }).join("");
    const eventLine = [
      board.event.name,
      board.course ? board.course.courseName : board.event.courseName,
      board.event.startDate,
      board.targetWeather && board.targetWeather.bucket !== "No weather" ? `${board.targetWeather.bucket} weather` : ""
    ].filter(Boolean).join(" | ");
    els.golfLabFieldReadinessBoard.innerHTML = `
      <section class="golf-lab-field-readiness">
        <div class="golf-lab-kpi-grid golf-lab-field-readiness-kpis">
          ${renderGolfLabKpi("Model Ready", `${board.summary.modelReady}/${board.summary.players}`, `${board.summary.premiumReady} premium`)}
          ${renderGolfLabKpi("Avg Score", formatLabNumber(board.summary.avgScore, 0), golfLabMarketFilterLabel(board.market))}
          ${renderGolfLabKpi("Profiles", `${board.summary.matchedProfiles}/${board.summary.players}`, `${board.summary.thin} thin`) }
          ${renderGolfLabKpi("Priced", `${board.summary.marketReady}/${board.summary.players}`, `${board.summary.modelRunReady} modeled`)}
        </div>
        <div class="golf-lab-field-readiness-context">
          <strong>${escapeHtml(eventLine || "Selected field")}</strong>
          <div>${gapSummary}</div>
        </div>
        <div class="golf-lab-field-readiness-list">${rows}</div>
      </section>
    `;
  }

  function renderGolfLabFieldIntelligenceBoard(lab) {
    if (!els.golfLabFieldIntelligenceBoard) return;
    if (typeof buildFieldIntelligenceBoard !== "function") {
      els.golfLabFieldIntelligenceBoard.innerHTML = emptyState("Field intelligence is not available.");
      return;
    }
    const board = buildFieldIntelligenceBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      weights: getGolfLabModelWeights(),
      modelProfile: getGolfLabModelPreset().label,
      weatherScenario: golfLabModelSettings.weatherScenario,
      market: golfLabModelSettings.marketFilter,
      minEdge: getGolfLabEdgeThresholdProbability()
    });
    if (!board.event) {
      els.golfLabFieldIntelligenceBoard.innerHTML = emptyState("Import or select a tournament to build field intelligence.");
      return;
    }
    if (!board.rows.length) {
      els.golfLabFieldIntelligenceBoard.innerHTML = emptyState("Import the tournament field and matched player data to rank every player.");
      return;
    }
    const specialists = [
      ["Course", board.specialists.course],
      ["Difficulty", board.specialists.difficulty],
      ["Weather", board.specialists.weather],
      ["Form", board.specialists.form],
      ["Live", board.specialists.live]
    ].map(([label, row]) => {
      const featureKey = label === "Form" ? "recentForm" : label === "Live" ? "liveState" : `${label.toLowerCase()}Fit`;
      const value = row && row.features ? row.features[featureKey] : null;
      return `<div class="golf-lab-field-specialist">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(row ? row.playerName || row.playerId : "--")}</strong>
        <em>${formatLabNumber(value, 2, true)}</em>
      </div>`;
    }).join("");
    const rows = board.rows.slice(0, 10).map((row) => `
      <div class="golf-lab-field-row golf-lab-field-row-${escapeHtml(row.priceStatus)}">
        <div class="golf-lab-field-rank">${row.rank}</div>
        <div class="golf-lab-field-main">
          <div class="golf-lab-field-title">
            <strong>${escapeHtml(row.playerName || row.playerId)}</strong>
            ${renderGolfLabPriceBadge(row.priceStatus)}
          </div>
          <span>${escapeHtml(golfLabMarketFilterLabel(row.market))} | fair ${row.fairOddsAmerican || "--"} | market ${row.marketOddsAmerican || "--"} | edge ${formatLabEdge(row.edge)} | ${escapeHtml(row.confidence || "")}</span>
          ${renderGolfLabFeatureStrip(row.features)}
        </div>
      </div>
    `).join("");

    els.golfLabFieldIntelligenceBoard.innerHTML = `
      <section class="golf-lab-field-intel">
        <div class="golf-lab-kpi-grid golf-lab-field-intel-kpis">
          ${renderGolfLabKpi("Players", String(board.summary.players), `${board.summary.highConfidence} high confidence`)}
          ${renderGolfLabKpi("Priced", `${board.summary.priced}/${board.summary.players}`, golfLabMarketFilterLabel(board.market))}
          ${renderGolfLabKpi("Edges", String(board.summary.thresholdEdges || 0), `${formatLabNumber(golfLabModelSettings.edgeThreshold, 1)}+ pp`)}
          ${renderGolfLabKpi("Thin Samples", String(board.summary.thinSamples), "needs history")}
        </div>
        <div class="golf-lab-field-intel-grid">
          <section class="golf-lab-field-specialists">
            <h4>Fit Specialists</h4>
            <div>${specialists}</div>
          </section>
          <section class="golf-lab-field-table">
            <h4>${escapeHtml(board.event.name || board.event.id)} | ${escapeHtml(board.modelProfile)} | ${escapeHtml(board.weatherScenario ? board.weatherScenario.label : getGolfLabWeatherScenarioLabel())}</h4>
            <div class="golf-lab-field-list">${rows}</div>
          </section>
        </div>
      </section>
    `;
  }

  function renderGolfLabConsensusBoard(lab) {
    if (!els.golfLabConsensusBoard) return;
    if (typeof buildModelConsensusBoard !== "function") {
      els.golfLabConsensusBoard.innerHTML = emptyState("Model consensus is not available.");
      return;
    }
    const board = buildModelConsensusBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      profiles: getGolfLabConsensusProfiles(),
      weatherScenario: golfLabModelSettings.weatherScenario,
      market: golfLabModelSettings.marketFilter,
      contenderCutoff: 10,
      maxRows: 8
    });
    if (!board.event) {
      els.golfLabConsensusBoard.innerHTML = emptyState("Import or select a tournament to compare model profiles.");
      return;
    }
    if (!board.rows.length) {
      els.golfLabConsensusBoard.innerHTML = emptyState("Import matched field and scoring data to build model consensus.");
      return;
    }
    const top = board.summary.topConsensus;
    const context = [
      board.event.name,
      board.course ? board.course.name || board.course.courseName : board.event.courseName,
      board.weatherScenario ? board.weatherScenario.label : getGolfLabWeatherScenarioLabel(),
      golfLabMarketFilterLabel(board.marketFilter)
    ].filter(Boolean).join(" | ");
    const rows = board.rows.map((row) => {
      const rankRange = Number.isFinite(row.bestRank) && Number.isFinite(row.worstRank)
        ? `#${row.bestRank}-#${row.worstRank}`
        : "--";
      const chips = row.profileRows.map((profile) => {
        const isContender = Number.isFinite(profile.rank) && profile.rank <= board.summary.contenderCutoff;
        return `
          <span class="golf-lab-consensus-chip${isContender ? " golf-lab-consensus-chip-contender" : ""}">
            <b>${escapeHtml(profile.profileLabel)}</b>
            <em>${Number.isFinite(profile.rank) ? `#${profile.rank}` : "--"} | ${formatLabPercent(profile.probability)}</em>
          </span>
        `;
      }).join("");
      return `
        <article class="golf-lab-consensus-row golf-lab-consensus-${escapeHtml(row.verdict)}">
          <div class="golf-lab-consensus-head">
            <div>
              <strong>${escapeHtml(row.playerName || row.playerId)}</strong>
              <span>${escapeHtml(row.marketLabel)} | avg rank ${formatLabNumber(row.avgRank, 1)} | range ${rankRange} | avg probability ${formatLabPercent(row.avgProbability)}</span>
            </div>
            <div>
              <b class="golf-lab-consensus-badge golf-lab-consensus-badge-${escapeHtml(row.verdict)}">${escapeHtml(row.verdictLabel)}</b>
              <em>${row.contenderProfiles}/${row.profileCount} profiles</em>
            </div>
          </div>
          <div class="golf-lab-consensus-chips">${chips}</div>
          <small>Edge agreement ${Number.isFinite(row.edgeAgreementPct) ? formatLabPercent(row.edgeAgreementPct) : "--"} | avg edge ${formatLabEdge(row.avgEdge)} | priced ${row.pricedProfiles}/${row.profileCount}</small>
        </article>
      `;
    }).join("");

    els.golfLabConsensusBoard.innerHTML = `
      <section class="golf-lab-consensus">
        <div class="golf-lab-kpi-grid golf-lab-consensus-kpis">
          ${renderGolfLabKpi("Profiles", String(board.summary.profiles), `${golfLabMarketFilterLabel(board.marketFilter)} lens`)}
          ${renderGolfLabKpi("Core Picks", String(board.summary.consensusCores), `top ${board.summary.contenderCutoff}`)}
          ${renderGolfLabKpi("Sensitive", String(board.summary.profileSensitive), "profile swings")}
          ${renderGolfLabKpi("Leader", top ? top.playerName : "--", top ? `${formatLabPercent(top.avgProbability)} avg` : "waiting")}
        </div>
        <div class="golf-lab-consensus-context">${escapeHtml(context || "Selected tournament")}</div>
        <div class="golf-lab-consensus-list">${rows}</div>
      </section>
    `;
  }

  function renderGolfLabFeatureSensitivityBoard(lab) {
    if (!els.golfLabFeatureSensitivityBoard) return;
    if (typeof buildFeatureSensitivityBoard !== "function") {
      els.golfLabFeatureSensitivityBoard.innerHTML = emptyState("Feature sensitivity is not available.");
      return;
    }
    const board = buildFeatureSensitivityBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      weights: getGolfLabModelWeights(),
      modelProfile: getGolfLabModelPreset().label,
      weatherScenario: golfLabModelSettings.weatherScenario,
      market: golfLabModelSettings.marketFilter,
      maxRows: 8
    });
    if (!board.event) {
      els.golfLabFeatureSensitivityBoard.innerHTML = emptyState("Import or select a tournament to test model feature sensitivity.");
      return;
    }
    if (!board.rows.length) {
      els.golfLabFeatureSensitivityBoard.innerHTML = emptyState("Import matched field and scoring data to measure feature sensitivity.");
      return;
    }
    const topDependency = board.summary.topDependency;
    const topDriver = topDependency && topDependency.strongestDependency ? topDependency.strongestDependency : null;
    const context = [
      board.event.name,
      board.course ? board.course.name || board.course.courseName : board.event.courseName,
      board.modelProfile,
      board.weatherScenario ? board.weatherScenario.label : getGolfLabWeatherScenarioLabel(),
      golfLabMarketFilterLabel(board.marketFilter)
    ].filter(Boolean).join(" | ");
    const rows = board.rows.map((row) => {
      const dependency = row.strongestDependency;
      const chips = row.sensitivityRows.map((feature) => `
        <span class="golf-lab-sensitivity-chip${Number.isFinite(feature.rankImpact) && feature.rankImpact > 0 ? " golf-lab-sensitivity-chip-loss" : ""}">
          <b>No ${escapeHtml(feature.label)}</b>
          <em>${Number.isFinite(feature.rankImpact) ? `${formatSigned(feature.rankImpact, 0)} rank` : "--"} | ${Number.isFinite(feature.probabilityImpact) ? formatLabEdge(feature.probabilityImpact) : "--"}</em>
        </span>
      `).join("");
      return `
        <article class="golf-lab-sensitivity-row golf-lab-sensitivity-${escapeHtml(row.verdict)}">
          <div class="golf-lab-sensitivity-head">
            <div>
              <strong>${escapeHtml(row.playerName || row.playerId)}</strong>
              <span>${escapeHtml(row.marketLabel)} | rank #${row.baselineRank || "--"} | ${formatLabPercent(row.baselineProbability)} | fair ${formatGolfLabOdds(row.fairOddsAmerican)} | edge ${formatLabEdge(row.edge)}</span>
            </div>
            <div>
              <b class="golf-lab-sensitivity-badge golf-lab-sensitivity-badge-${escapeHtml(row.verdict)}">${escapeHtml(row.verdictLabel)}</b>
              <em>${dependency ? `No ${escapeHtml(dependency.label)}: ${formatSigned(dependency.rankImpact || 0, 0)} rank` : "No driver"}</em>
            </div>
          </div>
          <div class="golf-lab-sensitivity-chips">${chips}</div>
          <small>Max rank loss ${formatLabNumber(row.maxRankLoss, 0)} | max probability loss ${formatLabEdge(row.maxProbabilityLoss)} | confidence ${escapeHtml(row.confidence || "--")}</small>
        </article>
      `;
    }).join("");

    els.golfLabFeatureSensitivityBoard.innerHTML = `
      <section class="golf-lab-sensitivity">
        <div class="golf-lab-kpi-grid golf-lab-sensitivity-kpis">
          ${renderGolfLabKpi("Profile", board.modelProfile, board.weatherScenario ? board.weatherScenario.label : getGolfLabWeatherScenarioLabel())}
          ${renderGolfLabKpi("Fragile", String(board.summary.fragile), `${board.summary.robust} robust`)}
          ${renderGolfLabKpi("Features", String(board.summary.dimensions), golfLabMarketFilterLabel(board.marketFilter))}
          ${renderGolfLabKpi("Top Driver", topDependency ? topDependency.playerName : "--", topDriver ? `No ${topDriver.label}` : "balanced")}
        </div>
        <div class="golf-lab-sensitivity-context">${escapeHtml(context || "Selected tournament")}</div>
        <div class="golf-lab-sensitivity-list">${rows}</div>
      </section>
    `;
  }

  function renderGolfLabFitBoard(lab) {
    if (!els.golfLabFitBoard) return;
    if (typeof buildEventFitBoard !== "function") {
      els.golfLabFitBoard.innerHTML = emptyState("Fit board is not available.");
      return;
    }
    const board = buildEventFitBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      weights: getGolfLabModelWeights(),
      modelProfile: getGolfLabModelPreset().label,
      weatherScenario: golfLabModelSettings.weatherScenario
    });
    if (!board.event) {
      els.golfLabFitBoard.innerHTML = emptyState("Import or select a tournament to build the fit board.");
      return;
    }
    if (!board.rows.length) {
      els.golfLabFitBoard.innerHTML = emptyState("Import matched field and player data to rank tournament fits.");
      return;
    }
    const topRows = board.rows.slice(0, 5);
    const topFit = board.summary.topFit;
    els.golfLabFitBoard.innerHTML = `
      <section class="golf-lab-fit-board">
        <div class="golf-lab-edge-summary">
          ${renderGolfLabKpi("Top Fit", topFit ? topFit.playerName : "--", topFit ? `${formatLabPercent(topFit.winProbability)} win` : "model")}
          ${renderGolfLabKpi("Profile", board.modelProfile, `${escapeHtml(board.weatherScenario ? board.weatherScenario.label : getGolfLabWeatherScenarioLabel())}`)}
          ${renderGolfLabKpi("Sample", formatLabNumber(board.summary.averageSampleRounds, 0), "avg rounds")}
        </div>
        <div class="golf-lab-fit-list">
          ${topRows.map((row) => `
            <div class="golf-lab-fit-row">
              <div class="golf-lab-fit-rank">${row.rank}</div>
              <div class="golf-lab-fit-main">
                <strong>${escapeHtml(row.playerName || row.playerId)}</strong>
                <span>${formatLabPercent(row.winProbability)} win | fair ${row.fairOddsAmerican || "--"} | ${escapeHtml(row.confidence || "")}</span>
                <div class="golf-lab-fit-pill-row golf-lab-fit-strengths">
                  ${renderGolfLabFitReasonPills(row.strengths, "No positive split yet")}
                </div>
                ${row.concerns && row.concerns.length ? `
                  <div class="golf-lab-fit-pill-row golf-lab-fit-concerns">
                    ${renderGolfLabFitReasonPills(row.concerns, "")}
                  </div>
                ` : ""}
              </div>
            </div>
          `).join("")}
        </div>
      </section>
    `;
  }

  function renderGolfLabScenarioBoard(lab) {
    if (!els.golfLabScenarioBoard) return;
    if (typeof buildWeatherScenarioBoard !== "function") {
      els.golfLabScenarioBoard.innerHTML = emptyState("Scenario board is not available.");
      return;
    }
    const board = buildWeatherScenarioBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      weights: getGolfLabModelWeights(),
      modelProfile: getGolfLabModelPreset().label,
      maxRows: 3
    });
    if (!board.event) {
      els.golfLabScenarioBoard.innerHTML = emptyState("Import or select a tournament to compare weather scenarios.");
      return;
    }
    if (!board.scenarios.length || !board.summary.players) {
      els.golfLabScenarioBoard.innerHTML = emptyState("Import matched field and scoring data to compare scenario movement.");
      return;
    }
    const topMover = board.summary.topMover;
    els.golfLabScenarioBoard.innerHTML = `
      <section class="golf-lab-scenario-board">
        <div class="golf-lab-edge-summary">
          ${renderGolfLabKpi("Scenarios", board.summary.scenarios, `${board.summary.players} players`)}
          ${renderGolfLabKpi("Top Mover", topMover ? topMover.playerName : "--", topMover ? `${formatSigned(topMover.rankChange, 0)} spots | ${escapeHtml(topMover.scenarioLabel)}` : "stable")}
        </div>
        <div class="golf-lab-scenario-grid">
          ${board.scenarios.map((scenario) => `
            <section class="golf-lab-scenario-card">
              <h4>${escapeHtml(scenario.label)}</h4>
              <div class="golf-lab-scenario-list">
                ${scenario.rows.length ? scenario.rows.map((row) => `
                  <div class="golf-lab-scenario-row">
                    <strong>${escapeHtml(row.playerName || row.playerId)}</strong>
                    <span>${formatLabPercent(row.winProbability)} win | rank ${row.rank}${Number.isFinite(row.rankChange) && row.rankChange !== 0 ? ` | ${formatSigned(row.rankChange, 0)} vs base` : ""}</span>
                  </div>
                `).join("") : emptyState("No ranked players for this scenario.")}
              </div>
            </section>
          `).join("")}
        </div>
      </section>
    `;
  }

  function renderGolfLabWeatherMatrixBoard(lab) {
    if (!els.golfLabWeatherMatrixBoard) return;
    if (typeof buildWeatherMatrixBoard !== "function") {
      els.golfLabWeatherMatrixBoard.innerHTML = emptyState("Weather matrix is not available.");
      return;
    }
    const board = buildWeatherMatrixBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      limit: 5
    });
    if (!board) {
      els.golfLabWeatherMatrixBoard.innerHTML = emptyState("Import or select a tournament to build a weather matrix.");
      return;
    }
    if (board.target.bucket === "No weather") {
      els.golfLabWeatherMatrixBoard.innerHTML = emptyState("Import event weather snapshots to rank field-player weather fit.");
      return;
    }
    const conditionLine = [
      Number.isFinite(board.target.windMph) ? `${formatLabNumber(board.target.windMph, 0)} mph wind` : "",
      Number.isFinite(board.target.gustMph) ? `${formatLabNumber(board.target.gustMph, 0)} gust` : "",
      Number.isFinite(board.target.temperatureF) ? `${formatLabNumber(board.target.temperatureF, 0)} F` : "",
      Number.isFinite(board.target.precipitationIn) && board.target.precipitationIn > 0 ? `${formatLabNumber(board.target.precipitationIn, 2)} in rain` : ""
    ].filter(Boolean).join(" | ");
    const rows = board.rows.map((row) => {
      const score = Number.isFinite(row.avgSg)
        ? `${formatLabNumber(row.avgSg, 2, true)} SG`
        : `${formatLabNumber(row.avgToPar, 1, true)} to par`;
      const delta = Number.isFinite(row.delta) ? `${formatLabNumber(row.delta, 2, true)} vs base` : "baseline unknown";
      return `<article class="golf-lab-weather-matrix-row ${row.inField ? "golf-lab-weather-matrix-field" : ""}">
        <div>
          <strong>${escapeHtml(row.playerName)}</strong>
          <span>${row.weatherRounds} ${escapeHtml(board.target.bucket.toLowerCase())} rounds | ${escapeHtml(score)} | ${escapeHtml(delta)}</span>
        </div>
        <b>${formatLabNumber(row.fitScore, 2, true)}</b>
        <small>${row.tags.length ? row.tags.map(escapeHtml).join(" | ") : `${row.taggedRounds} tagged rounds`}</small>
      </article>`;
    }).join("");
    els.golfLabWeatherMatrixBoard.innerHTML = `
      <section class="golf-lab-weather-matrix">
        <div class="golf-lab-edge-summary">
          ${renderGolfLabKpi("Target", board.target.bucket, conditionLine || `${board.target.count} snapshots`)}
          ${renderGolfLabKpi("History", `${board.summary.playersWithWeatherHistory}/${board.summary.players}`, `${board.summary.weatherRounds} matching rounds`)}
        </div>
        <div class="golf-lab-weather-matrix-event">
          <strong>${escapeHtml(board.event.name)}</strong>
          <span>${escapeHtml([board.event.courseName, board.event.startDate].filter(Boolean).join(" | "))}</span>
        </div>
        <div class="golf-lab-weather-matrix-list">${rows || emptyState(`No ${board.target.bucket.toLowerCase()} history for this field yet.`)}</div>
      </section>
    `;
  }

  function renderGolfLabWeatherDrawBoard(lab) {
    if (!els.golfLabWeatherDrawBoard) return;
    if (typeof buildTeeTimeWaveBoard !== "function") {
      els.golfLabWeatherDrawBoard.innerHTML = emptyState("Weather draw is not available.");
      return;
    }
    const board = buildTeeTimeWaveBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      limit: 4
    });
    if (!board) {
      els.golfLabWeatherDrawBoard.innerHTML = emptyState("Import or select a tournament to price the tee-time draw.");
      return;
    }
    if (!board.summary.fieldCount) {
      els.golfLabWeatherDrawBoard.innerHTML = emptyState("Import a field list with tee times to split the draw.");
      return;
    }
    const eventLine = [
      board.event.name,
      board.event.courseName,
      board.event.startDate
    ].filter(Boolean).join(" | ");
    const warningRows = board.warnings.length
      ? `<div class="golf-lab-weather-draw-warnings">${board.warnings.map((warning) => `<span>${escapeHtml(warning)}</span>`).join("")}</div>`
      : "";
    const waveRows = board.waves.map((wave) => {
      const weatherLine = [
        Number.isFinite(wave.weather.windMph) ? `${formatLabNumber(wave.weather.windMph, 0)} mph wind` : "",
        Number.isFinite(wave.weather.gustMph) ? `${formatLabNumber(wave.weather.gustMph, 0)} gust` : "",
        Number.isFinite(wave.weather.temperatureF) ? `${formatLabNumber(wave.weather.temperatureF, 0)} F` : "",
        Number.isFinite(wave.weather.precipitationIn) && wave.weather.precipitationIn > 0 ? `${formatLabNumber(wave.weather.precipitationIn, 2)} in rain` : ""
      ].filter(Boolean).join(" | ");
      const playerRows = wave.players.map((player) => {
        const fit = Number.isFinite(player.weatherFit)
          ? `${formatLabNumber(player.weatherFit, 2, true)} fit`
          : "no weather fit";
        const history = player.weatherRounds
          ? `${player.weatherRounds} ${wave.weather.bucket.toLowerCase()} rounds`
          : `${player.taggedRounds} tagged rounds`;
        return `<div class="golf-lab-weather-draw-player">
          <strong>${escapeHtml(player.playerName || player.playerId)}</strong>
          <span>${escapeHtml([player.teeTime || "No tee time", history, fit].filter(Boolean).join(" | "))}</span>
        </div>`;
      }).join("");
      return `<article class="golf-lab-weather-draw-wave golf-lab-weather-draw-${escapeHtml(wave.drawLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}">
        <div class="golf-lab-weather-draw-head">
          <div>
            <strong>${escapeHtml(wave.label)}</strong>
            <span>${escapeHtml([wave.teeTimeRange || "No tee range", `${wave.fieldCount} players`, wave.weather.label].join(" | "))}</span>
          </div>
          <b>${escapeHtml(wave.drawLabel)}</b>
        </div>
        <div class="golf-lab-weather-draw-metrics">
          <span><strong>${formatLabNumber(wave.drawEdge, 1, true)}</strong><em>draw edge</em></span>
          <span><strong>${formatLabNumber(wave.weather.difficultyScore, 1)}</strong><em>weather load</em></span>
        </div>
        <small>${escapeHtml(weatherLine || `${wave.weather.count} weather snapshots`)}</small>
        <div class="golf-lab-weather-draw-players">${playerRows || emptyState("No players in this wave.")}</div>
      </article>`;
    }).join("");
    els.golfLabWeatherDrawBoard.innerHTML = `
      <section class="golf-lab-weather-draw">
        <div class="golf-lab-edge-summary">
          ${renderGolfLabKpi("Tee Times", `${board.summary.assignedTeeTimes}/${board.summary.fieldCount}`, `${board.summary.waves} waves`)}
          ${renderGolfLabKpi("Best Draw", board.summary.advantagedWave || "--", board.summary.toughWave ? `Tough: ${board.summary.toughWave}` : "needs weather")}
          ${renderGolfLabKpi("Spread", formatLabNumber(board.summary.drawSpread, 1), "weather load")}
          ${renderGolfLabKpi("Weather", String(board.summary.weatherSnapshots), "snapshots")}
        </div>
        <div class="golf-lab-weather-draw-event">${escapeHtml(eventLine || "Selected event")}</div>
        ${warningRows}
        <div class="golf-lab-weather-draw-waves">${waveRows}</div>
      </section>
    `;
  }

  function renderGolfLabPredictionLedger(lab) {
    if (!els.golfLabPredictionLedger) return;
    const predictionMap = new Map();
    [...lab.predictionLedger, ...lab.modelPredictions].forEach((prediction) => {
      if (!prediction || !prediction.id) return;
      predictionMap.set(prediction.id, prediction);
    });
    const predictions = [...predictionMap.values()]
      .filter((prediction) => golfLabMarketMatchesFilter(prediction.market, golfLabModelSettings.marketFilter))
      .sort((a, b) =>
        (b.createdAt || "").localeCompare(a.createdAt || "") ||
        (a.rank || 999) - (b.rank || 999)
      )
      .slice(0, 5);
    if (!predictions.length) {
      els.golfLabPredictionLedger.innerHTML = emptyState(`No saved ${golfLabMarketFilterNoun(golfLabModelSettings.marketFilter)} predictions yet.`);
      return;
    }
    const playerById = new Map(lab.players.map((player) => [player.id, player]));
    els.golfLabPredictionLedger.innerHTML = `<div class="golf-lab-stack">
      ${predictions.map((prediction) => {
        const player = playerById.get(prediction.playerId);
        const playerName = player ? player.name : prediction.playerId;
        const featureLine = [
          Number.isFinite(prediction.skill) ? `skill ${formatLabNumber(prediction.skill, 2, true)}` : "",
          Number.isFinite(prediction.recentForm) ? `form ${formatLabNumber(prediction.recentForm, 2, true)}` : "",
          Number.isFinite(prediction.courseFit) ? `course ${formatLabNumber(prediction.courseFit, 2, true)}` : "",
          Number.isFinite(prediction.weatherFit) ? `weather ${formatLabNumber(prediction.weatherFit, 2, true)}` : "",
          Number.isFinite(prediction.liveState) ? `live ${formatLabNumber(prediction.liveState, 2, true)}` : ""
        ].filter(Boolean).join(" | ");
        return `<div class="golf-lab-event-row">
          <strong>${escapeHtml(playerName || "Prediction")}</strong>
          <span>${escapeHtml(prediction.market || "market")} | ${formatLabPercent(prediction.probability)} | edge ${formatLabEdge(prediction.edge)} | ${escapeHtml(prediction.confidence || "")}${prediction.modelProfile ? ` | ${escapeHtml(prediction.modelProfile)}` : ""}${prediction.modelWeatherLabel ? ` | ${escapeHtml(prediction.modelWeatherLabel)}` : ""}</span>
          ${featureLine ? `<span>${escapeHtml(featureLine)}</span>` : ""}
        </div>`;
      }).join("")}
    </div>`;
  }

  function renderGolfLabPredictionRunBrief(brief) {
    if (!brief) return "";
    const sourceClass = brief.sourceSafe ? "safe" : "open";
    const nextGate = brief.nextGate
      ? `${brief.nextGate.label}: ${brief.nextGate.nextAction || brief.nextGate.detail}`
      : "All prep gates clear";
    const market = golfLabMarketFilterLabel(brief.marketFilter);
    const minEdgeText = `${formatLabNumber((brief.minEdge || 0) * 100, 1)} pp`;
    return `
      <div class="golf-lab-prep-brief golf-lab-prep-brief-${escapeHtml(sourceClass)}">
        <article class="golf-lab-prep-brief-action">
          <span>Next Move</span>
          <strong>${escapeHtml(brief.action || "Prepare sources")}</strong>
          <em>${escapeHtml(brief.statusLabel || "Needs setup")}</em>
        </article>
        <article>
          <span>Model</span>
          <strong>${escapeHtml(brief.modelProfile || "Owned model")}</strong>
          <em>${escapeHtml(brief.weatherLabel || "Imported forecast")}</em>
        </article>
        <article>
          <span>Market</span>
          <strong>${escapeHtml(market)}</strong>
          <em>${escapeHtml(`${minEdgeText}+ edge threshold`)}</em>
        </article>
        <article>
          <span>Source Safety</span>
          <strong>${escapeHtml(brief.sourceSafeLabel || "Source gates open")}</strong>
          <em>${brief.criticalReady}/${brief.criticalGates} critical gates ready</em>
        </article>
        <article>
          <span>Slate</span>
          <strong>${brief.counts ? `${brief.counts.predictions}/${brief.counts.field}` : "0/0"}</strong>
          <em>${brief.counts ? `${brief.counts.pricedPredictions} priced | ${brief.counts.playableEdges} playable` : "No model run"}</em>
        </article>
        <article>
          <span>Focus</span>
          <strong>${brief.nextGate ? escapeHtml(brief.nextGate.label) : "Clear"}</strong>
          <em>${escapeHtml(nextGate)}</em>
        </article>
      </div>
    `;
  }

  function renderGolfLabPredictionPrepBoard(lab) {
    if (!els.golfLabPredictionPrepBoard) return;
    if (typeof buildPredictionPrepBoard !== "function") {
      els.golfLabPredictionPrepBoard.innerHTML = emptyState("Prediction Prep is not available.");
      return;
    }
    const board = buildPredictionPrepBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      market: golfLabModelSettings.marketFilter,
      minEdge: getGolfLabEdgeThresholdProbability(),
      weights: getGolfLabModelWeights(),
      modelProfile: getGolfLabModelPreset().label,
      weatherScenario: golfLabModelSettings.weatherScenario
    });
    if (!board.event) {
      els.golfLabPredictionPrepBoard.innerHTML = emptyState("Import a tournament event to open Prediction Prep.");
      return;
    }
    const statusKey = String(board.status || "setup").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "setup";
    const eventLine = [
      board.event.name || board.event.id,
      board.course ? board.course.name : board.event.courseName,
      board.event.startDate,
      golfLabMarketFilterLabel(board.marketFilter)
    ].filter(Boolean).join(" | ");
    const nextActions = board.nextActions && board.nextActions.length
      ? board.nextActions.map((gate) => `
        <span class="golf-lab-prep-action golf-lab-prep-action-${escapeHtml(gate.severity || "info")}">
          <b>${escapeHtml(gate.label)}</b>
          <em>${escapeHtml(gate.nextAction || gate.detail)}</em>
        </span>
      `).join("")
      : `<span class="golf-lab-prep-action golf-lab-prep-action-clear"><b>Ready</b><em>Critical prep gates are clear.</em></span>`;
    const gateRows = board.gates.map((gate) => {
      const gateStatus = String(gate.status || "blocked").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "blocked";
      const safeScore = Number.isFinite(Number(gate.score)) ? Math.max(0, Math.min(100, Number(gate.score))) : 0;
      return `<article class="golf-lab-prep-gate golf-lab-prep-gate-${escapeHtml(gateStatus)}">
        <div>
          <strong>${escapeHtml(gate.label)}</strong>
          <b>${escapeHtml(gate.statusLabel || gate.status || "Blocked")}</b>
        </div>
        <em style="--prep:${safeScore}%"></em>
        <span>${escapeHtml(gate.detail || "")}</span>
      </article>`;
    }).join("");
    const signalCard = (label, value, note, tone = "neutral") => `
      <article class="golf-lab-prep-signal golf-lab-prep-signal-${escapeHtml(tone)}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <em>${escapeHtml(note)}</em>
      </article>
    `;
    const topFit = board.topSignals ? board.topSignals.topFit : null;
    const topEdge = board.topSignals ? board.topSignals.topEdge : null;
    const bestMarket = board.topSignals ? board.topSignals.bestMarket : null;
    const strongestComp = board.topSignals ? board.topSignals.strongestComp : null;
    const signalRows = [
      signalCard(
        "Top Fit",
        topFit ? topFit.playerName || topFit.playerId || "--" : "--",
        topFit ? `${formatLabPercent(topFit.winProbability)} win | ${topFit.confidence || "model"}` : "needs field",
        topFit ? "positive" : "neutral"
      ),
      signalCard(
        "Top Edge",
        topEdge ? topEdge.playerName || topEdge.playerId || "--" : "--",
        topEdge ? `${golfLabMarketFilterLabel(topEdge.market)} | ${formatLabEdge(topEdge.edge)} | ${formatGolfLabOdds(topEdge.marketOddsAmerican)}` : "needs priced model",
        topEdge ? "positive" : "neutral"
      ),
      signalCard(
        "Best Market",
        bestMarket ? bestMarket.label || bestMarket.key || "--" : "--",
        bestMarket ? `${bestMarket.thresholdEdges || 0} playable | ${bestMarket.pricedPct || 0}% priced` : "no market rows",
        bestMarket && bestMarket.thresholdEdges ? "positive" : "neutral"
      ),
      signalCard(
        "Course Comp",
        strongestComp ? strongestComp.courseName || strongestComp.courseId || "--" : "--",
        strongestComp ? `${formatLabNumber(strongestComp.similarity, 0)}% similar | ${strongestComp.sample ? strongestComp.sample.rounds || 0 : 0} rounds` : "needs comp history",
        strongestComp ? "positive" : "neutral"
      )
    ].join("");

    els.golfLabPredictionPrepBoard.innerHTML = `
      <section class="golf-lab-prep golf-lab-prep-${escapeHtml(statusKey)}">
        <div class="golf-lab-prep-hero">
          <div>
            <span>Selected tournament</span>
            <strong>${escapeHtml(board.statusLabel || board.status || "Needs prep")}</strong>
            <em>${escapeHtml(eventLine || "Selected event")}</em>
          </div>
          <b>${board.score}%</b>
        </div>
        ${renderGolfLabPredictionRunBrief(board.runBrief)}
        <div class="golf-lab-kpi-grid golf-lab-prep-kpis">
          ${renderGolfLabKpi("Prep Score", `${board.score}%`, board.statusLabel || statusKey)}
          ${renderGolfLabKpi("Field", String(board.summary.fieldCount || 0), `${board.summary.modelReadyPlayers || 0} history-ready`)}
          ${renderGolfLabKpi("Model", `${board.summary.fieldCoveragePct || 0}%`, `${board.summary.totalPredictions || 0} predictions`)}
          ${renderGolfLabKpi("Edges", String(board.summary.thresholdEdges || 0), `${formatLabNumber(golfLabModelSettings.edgeThreshold, 1)}+ pp`)}
        </div>
        <div class="golf-lab-prep-actions">${nextActions}</div>
        <div class="golf-lab-prep-signals">${signalRows}</div>
        <div class="golf-lab-prep-gates">${gateRows}</div>
      </section>
    `;
  }

  function renderGolfLabRunAuditBadge(status, label) {
    const key = String(status || "empty").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "empty";
    return `<b class="golf-lab-run-audit-badge golf-lab-run-audit-badge-${escapeHtml(key)}">${escapeHtml(label || key)}</b>`;
  }

  function renderGolfLabRunAuditMeter(label, value, note) {
    const safeValue = Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
    return `<div class="golf-lab-run-audit-meter">
      <div><span>${escapeHtml(label)}</span><strong>${safeValue}%</strong></div>
      <em style="--run-audit:${safeValue}%"></em>
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </div>`;
  }

  function renderGolfLabPredictionRunAuditBoard(lab) {
    if (!els.golfLabPredictionRunAuditBoard) return;
    if (typeof buildPredictionRunAuditBoard !== "function") {
      els.golfLabPredictionRunAuditBoard.innerHTML = emptyState("Prediction run audit is not available.");
      return;
    }
    const board = buildPredictionRunAuditBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      market: golfLabModelSettings.marketFilter,
      minEdge: getGolfLabEdgeThresholdProbability()
    });
    if (!board.selectedEvent) {
      els.golfLabPredictionRunAuditBoard.innerHTML = emptyState("Import a tournament event to audit prediction readiness.");
      return;
    }
    const eventLine = [
      board.selectedEvent.name,
      board.selectedEvent.courseName,
      board.selectedEvent.startDate
    ].filter(Boolean).join(" | ");
    const latestRun = board.summary.latestPredictionAt
      ? formatGolfLabSourceAge(board.summary.predictionAgeDays)
      : "No model run";
    const latestOdds = board.summary.latestOddsAt
      ? formatGolfLabSourceAge(board.summary.oddsAgeDays)
      : "No odds";
    const gapRows = board.gaps.length
      ? board.gaps.slice(0, 4).map((gap) => `
        <span class="golf-lab-run-audit-gap golf-lab-run-audit-gap-${escapeHtml(gap.severity || "info")}">
          <b>${escapeHtml(gap.label)}</b>
          <em>${escapeHtml(gap.detail)}</em>
        </span>
      `).join("")
      : `<span class="golf-lab-run-audit-gap golf-lab-run-audit-gap-clear"><b>Clean slate</b><em>No audit blockers for this filter.</em></span>`;
    const rows = board.marketRows.map((row) => {
      const settledPct = row.predictedPlayers ? Math.round((row.settled / row.predictedPlayers) * 100) : 0;
      const bookLine = row.bookCount
        ? `${row.bookCount} book${row.bookCount === 1 ? "" : "s"} | ${row.books.slice(0, 3).join(", ")}${row.bookCount > 3 ? ` +${row.bookCount - 3}` : ""}`
        : "No books";
      const gapLine = [
        row.modelOnlyCount ? `${row.modelOnlyCount} no odds: ${row.modelOnlyPlayers.join(", ")}${row.modelOnlyCount > row.modelOnlyPlayers.length ? "..." : ""}` : "",
        row.missingPredictionCount ? `${row.missingPredictionCount} not modeled: ${row.missingPredictions.join(", ")}${row.missingPredictionCount > row.missingPredictions.length ? "..." : ""}` : ""
      ].filter(Boolean).join(" | ");
      return `<article class="golf-lab-run-audit-row golf-lab-run-audit-${escapeHtml(row.status)}">
        <div class="golf-lab-run-audit-head">
          <div>
            <strong>${escapeHtml(row.label)}</strong>
            <span>${escapeHtml(`${row.predictedPlayers} modeled | ${row.pricedPredictions} priced | ${row.thresholdEdges} edges over threshold`)}</span>
          </div>
          ${renderGolfLabRunAuditBadge(row.status, row.statusLabel)}
        </div>
        <div class="golf-lab-run-audit-meters">
          ${renderGolfLabRunAuditMeter("Field modeled", row.fieldCoveragePct, `${row.fieldPredictedPlayers}/${row.activeFieldCount}`)}
          ${renderGolfLabRunAuditMeter("Predictions priced", row.pricedPct, `${row.pricedPredictions}/${row.predictedPlayers}`)}
          ${renderGolfLabRunAuditMeter("Settled", settledPct, `${row.settled}/${row.predictedPlayers}`)}
        </div>
        <small>${escapeHtml(`${bookLine} | run ${row.latestPredictionAt ? formatGolfLabSourceAge(row.predictionAgeDays) : "not run"} | odds ${row.latestOddsAt ? formatGolfLabSourceAge(row.oddsAgeDays) : "missing"}`)}</small>
        ${gapLine ? `<small>${escapeHtml(gapLine)}</small>` : ""}
      </article>`;
    }).join("");
    els.golfLabPredictionRunAuditBoard.innerHTML = `
      <section class="golf-lab-run-audit">
        <div class="golf-lab-kpi-grid golf-lab-run-audit-kpis">
          ${renderGolfLabKpi("Markets Ready", `${board.summary.readyMarkets}/${board.summary.markets}`, golfLabMarketFilterLabel(board.marketFilter))}
          ${renderGolfLabKpi("Field Modeled", `${board.summary.fieldCoveragePct}%`, `${board.summary.modeledFieldPlayers}/${board.summary.activeFieldCount} players`)}
          ${renderGolfLabKpi("Priced", `${board.summary.pricedPct}%`, `${board.summary.pricedPredictions}/${board.summary.totalPredictions} predictions`)}
          ${renderGolfLabKpi("Edges", String(board.summary.thresholdEdges), `${formatLabNumber(board.summary.profitUnits, 2, true)}u settled`)}
        </div>
        <div class="golf-lab-run-audit-event">
          <strong>${escapeHtml(eventLine || "Selected event")}</strong>
          <span>${escapeHtml(`Latest run ${latestRun} | Latest odds ${latestOdds}`)}</span>
        </div>
        <div class="golf-lab-run-audit-gaps">${gapRows}</div>
        <div class="golf-lab-run-audit-list">
          ${rows || emptyState(`No ${golfLabMarketFilterLabel(golfLabModelSettings.marketFilter).toLowerCase()} run audit rows yet.`)}
        </div>
      </section>
    `;
  }

  function renderGolfLabModelRunHistoryBoard(lab) {
    if (!els.golfLabModelRunHistoryBoard) return;
    if (typeof buildModelRunHistoryBoard !== "function") {
      els.golfLabModelRunHistoryBoard.innerHTML = emptyState("Model run history is not available.");
      return;
    }
    const board = buildModelRunHistoryBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      market: golfLabModelSettings.marketFilter,
      maxRows: 6
    });
    if (!board.selectedEvent) {
      els.golfLabModelRunHistoryBoard.innerHTML = emptyState("Import a tournament event to track model run history.");
      return;
    }
    const latest = board.summary.latestRun;
    const eventLine = [
      board.selectedEvent.name,
      board.selectedEvent.courseName,
      board.selectedEvent.startDate,
      golfLabMarketFilterLabel(board.marketFilter)
    ].filter(Boolean).join(" | ");
    const rows = board.rows.map((row) => {
      const sourceLine = row.sourceProviders.length
        ? row.sourceProviders.slice(0, 3).join(", ")
        : "No source providers linked";
      const activationLine = row.activationScore != null
        ? `${row.activationLabel || row.activationStatus || "Activation"} | ${row.activationScore}%`
        : "Activation snapshot unavailable";
      const blockerLine = row.criticalBlockers && row.criticalBlockers.length
        ? row.criticalBlockers.slice(0, 2).map((blocker) => blocker.label || blocker.detail).filter(Boolean).join(" | ")
        : "";
      const warningLine = row.warnings && row.warnings.length
        ? row.warnings.slice(0, 2).join(" | ")
        : "";
      return `<article class="golf-lab-run-history-row golf-lab-run-history-row-${escapeHtml(row.statusKey)}">
        <div class="golf-lab-run-history-head">
          <div>
            <strong>${escapeHtml(row.modelProfile || "Owned model")}</strong>
            <span>${escapeHtml(`${row.modelWeatherLabel || row.modelWeatherScenario || "Imported forecast"} | ${row.modelVersion || "model"} | ${row.createdAt || "unsaved time"}`)}</span>
          </div>
          <b>${escapeHtml(row.statusLabel)}</b>
        </div>
        <div class="golf-lab-run-history-metrics">
          ${renderGolfLabRunAuditMeter("Proof", row.proofScore, `${row.hasManifest ? "manifest" : "no manifest"} | ${row.hasSourceFetch ? "source row" : "no source row"}`)}
          ${renderGolfLabRunAuditMeter("Field", row.fieldCoveragePct, `${row.modeledPlayers || row.players}/${row.fieldRows || row.players}`)}
          ${renderGolfLabRunAuditMeter("Priced", row.pricedPct, `${row.pricedPredictions}/${row.predictions}`)}
        </div>
        <div class="golf-lab-run-history-foot">
          <span>${escapeHtml(`${row.predictions} predictions | ${row.players} players | ${row.markets} markets | avg ${formatLabNumber(row.avgSampleRounds, 1)} sample rounds`)}</span>
          <span>${escapeHtml(`${activationLine} | sources: ${sourceLine}`)}</span>
          <code>${escapeHtml(row.modelRunId)}</code>
          ${blockerLine ? `<em>${escapeHtml(blockerLine)}</em>` : ""}
          ${warningLine ? `<em>${escapeHtml(warningLine)}</em>` : ""}
        </div>
      </article>`;
    }).join("");
    els.golfLabModelRunHistoryBoard.innerHTML = `
      <section class="golf-lab-run-history">
        <div class="golf-lab-kpi-grid golf-lab-run-history-kpis">
          ${renderGolfLabKpi("Runs", String(board.summary.runs), `${board.summary.sourceBackedRuns} source-backed`)}
          ${renderGolfLabKpi("Reproducible", `${board.summary.reproduciblePct}%`, `${board.summary.manifestRuns} manifests`)}
          ${renderGolfLabKpi("Predictions", String(board.summary.predictionRows), golfLabMarketFilterLabel(board.marketFilter))}
          ${renderGolfLabKpi("Latest", latest ? (latest.modelProfile || "Owned model") : "--", latest ? (latest.modelWeatherLabel || latest.createdAt || "saved") : "no runs")}
        </div>
        <div class="golf-lab-run-history-event">
          <strong>${escapeHtml(eventLine || "Selected event")}</strong>
          <span>${escapeHtml(latest ? `Latest run ${latest.createdAt || latest.fetchedAt || "saved"}` : "No saved runs for this filter")}</span>
        </div>
        <div class="golf-lab-run-history-list">
          ${rows || emptyState(`No saved ${golfLabMarketFilterNoun(golfLabModelSettings.marketFilter)} model runs yet.`)}
        </div>
      </section>
    `;
  }

  function renderGolfLabMarketCoverageMeter(label, value, note) {
    const safeValue = Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
    return `<div class="golf-lab-market-meter">
      <div><span>${escapeHtml(label)}</span><strong>${safeValue}%</strong></div>
      <em style="--coverage:${safeValue}%"></em>
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </div>`;
  }

  function renderGolfLabMarketCoverageBoard(lab) {
    if (!els.golfLabMarketCoverageBoard) return;
    if (typeof buildMarketCoverageBoard !== "function") {
      els.golfLabMarketCoverageBoard.innerHTML = emptyState("Market coverage is not available.");
      return;
    }
    const board = buildMarketCoverageBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      market: golfLabModelSettings.marketFilter
    });
    if (!board.selectedEvent) {
      els.golfLabMarketCoverageBoard.innerHTML = emptyState("Import a tournament event, field, predictions, and odds to audit market coverage.");
      return;
    }
    const eventLine = [
      board.selectedEvent.name,
      board.selectedEvent.courseName,
      board.selectedEvent.startDate
    ].filter(Boolean).join(" | ");
    const latestOdds = board.summary.latestOddsAt
      ? formatGolfLabSourceAge(Math.min(...board.marketRows.map((row) => row.oddsAgeDays).filter(Number.isFinite)))
      : "No odds refresh";
    const fieldCount = board.selectedEventRow ? board.selectedEventRow.activeFieldCount : 0;
    const marketRows = board.marketRows.map((row) => {
      const bookLine = row.bookCount
        ? `${row.books.slice(0, 3).join(", ")}${row.bookCount > 3 ? ` +${row.bookCount - 3}` : ""}`
        : "No books";
      const missingLine = row.missingPredictionCount
        ? `${row.missingPredictionCount} missing: ${row.missingPredictions.join(", ")}${row.missingPredictionCount > row.missingPredictions.length ? "..." : ""}`
        : "No modeled-player gaps";
      return `<article class="golf-lab-market-coverage-row golf-lab-market-coverage-${escapeHtml(row.status)}">
        <div class="golf-lab-market-coverage-head">
          <div>
            <strong>${escapeHtml(row.label)}</strong>
            <span>${escapeHtml(`${row.pricedPlayers} priced | ${row.predictedPlayers} modeled | ${bookLine}`)}</span>
          </div>
          <b>${escapeHtml(row.statusLabel)}</b>
        </div>
        <div class="golf-lab-market-coverage-meters">
          ${renderGolfLabMarketCoverageMeter("Model priced", row.predictionCoverage, `${row.pricedPredictions}/${row.predictedPlayers}`)}
          ${renderGolfLabMarketCoverageMeter("Field priced", row.fieldCoverage, `${row.fieldPricedPlayers}/${row.activeFieldCount}`)}
        </div>
        <small>${escapeHtml(missingLine)}</small>
      </article>`;
    }).join("");
    els.golfLabMarketCoverageBoard.innerHTML = `
      <section class="golf-lab-market-coverage">
        <div class="golf-lab-edge-summary">
          ${renderGolfLabKpi("Markets", `${board.summary.readyMarkets}/${board.summary.markets}`, `${board.summary.pricedMarkets} priced`)}
          ${renderGolfLabKpi("Model Priced", `${board.summary.avgPredictionCoverage}%`, `${board.summary.missingPredictionCount} missing`)}
          ${renderGolfLabKpi("Field Priced", `${board.summary.avgFieldCoverage}%`, `${board.summary.uniquePricedPlayers}/${fieldCount || board.summary.uniquePredictedPlayers} players`)}
          ${renderGolfLabKpi("Books", String(board.summary.bookCount), latestOdds)}
        </div>
        <div class="golf-lab-market-coverage-event">${escapeHtml(eventLine || "Selected event")}</div>
        <div class="golf-lab-market-coverage-list">
          ${marketRows || emptyState(`No ${golfLabMarketOddsLabel(golfLabModelSettings.marketFilter)} coverage rows yet.`)}
        </div>
      </section>
    `;
  }

  function renderGolfLabOddsMovementBoard(lab) {
    if (!els.golfLabOddsMovementBoard) return;
    if (typeof buildOddsMovementBoard !== "function") {
      els.golfLabOddsMovementBoard.innerHTML = emptyState("Odds movement is not available.");
      return;
    }
    const board = buildOddsMovementBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      market: golfLabModelSettings.marketFilter,
      maxRows: 7
    });
    if (!board.selectedEvent) {
      els.golfLabOddsMovementBoard.innerHTML = emptyState("Import a tournament event and timestamped odds snapshots to audit line movement.");
      return;
    }
    if (!board.lineRows.length) {
      els.golfLabOddsMovementBoard.innerHTML = emptyState(`Import multiple ${golfLabMarketOddsLabel(golfLabModelSettings.marketFilter)} odds snapshots to track steam and drift.`);
      return;
    }
    const eventLine = [
      board.selectedEvent.name,
      board.selectedEvent.courseName,
      board.selectedEvent.startDate
    ].filter(Boolean).join(" | ");
    const latestOdds = Number.isFinite(board.summary.latestAgeDays)
      ? formatGolfLabSourceAge(board.summary.latestAgeDays)
      : "No latest timestamp";
    const marketRows = board.marketRows.slice(0, 4).map((row) => {
      const bookLine = row.bookCount
        ? `${row.books.slice(0, 3).join(", ")}${row.bookCount > 3 ? ` +${row.bookCount - 3}` : ""}`
        : "No book";
      return `<article class="golf-lab-odds-market">
        <div>
          <strong>${escapeHtml(row.label)}</strong>
          <span>${escapeHtml(`${row.trackedLines} lines | ${row.snapshots} snapshots | ${bookLine}`)}</span>
        </div>
        <b>${formatLabEdge(row.maxMove)}</b>
        <small>${escapeHtml(`${row.steam} steam | ${row.drift} drift | ${formatGolfLabSourceAge(row.latestAgeDays)}`)}</small>
      </article>`;
    }).join("");
    const moverRows = board.rows.map((row) => {
      const oddsLine = `${formatGolfLabOdds(row.openingOddsAmerican)} -> ${formatGolfLabOdds(row.latestOddsAmerican)}`;
      const snapshotLine = `${row.snapshots} snapshot${row.snapshots === 1 ? "" : "s"} | ${formatGolfLabSourceAge(row.latestAgeDays)}`;
      const providerLine = [row.book, row.sourceProvider].filter(Boolean).join(" | ");
      return `<article class="golf-lab-odds-movement-row golf-lab-odds-movement-${escapeHtml(row.movement)}">
        <div class="golf-lab-odds-movement-head">
          <div>
            <strong>${escapeHtml(row.playerName || row.playerId || "Unknown player")}</strong>
            <span>${escapeHtml([row.marketLabel, providerLine].filter(Boolean).join(" | "))}</span>
          </div>
          <b>${escapeHtml(row.movementLabel)}</b>
        </div>
        <div class="golf-lab-odds-line">
          <strong>${escapeHtml(oddsLine)}</strong>
          <em>${formatLabEdge(row.impliedDelta)}</em>
        </div>
        <small>${escapeHtml(snapshotLine)}</small>
      </article>`;
    }).join("");
    els.golfLabOddsMovementBoard.innerHTML = `
      <section class="golf-lab-odds-movement">
        <div class="golf-lab-edge-summary">
          ${renderGolfLabKpi("Lines", String(board.summary.trackedLines), `${board.summary.snapshots} snapshots`)}
          ${renderGolfLabKpi("Tape", `${board.summary.steam}/${board.summary.drift}`, "steam / drift")}
          ${renderGolfLabKpi("Books", String(board.summary.books), board.summary.bookList.slice(0, 2).join(", ") || "market")}
          ${renderGolfLabKpi("Max Move", formatLabEdge(board.summary.maxMove), latestOdds)}
        </div>
        <div class="golf-lab-odds-movement-event">${escapeHtml(eventLine || "Selected event")}</div>
        <div class="golf-lab-odds-movement-markets">
          ${marketRows || emptyState("No market movement rows yet.")}
        </div>
        <div class="golf-lab-odds-movement-list">
          ${moverRows || emptyState("No player line movement rows yet.")}
        </div>
      </section>
    `;
  }

  function renderGolfLabOddsShoppingBoard(lab) {
    if (!els.golfLabOddsShoppingBoard) return;
    if (typeof buildOddsShoppingBoard !== "function") {
      els.golfLabOddsShoppingBoard.innerHTML = emptyState("Line shopping is not available.");
      return;
    }
    const board = buildOddsShoppingBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      market: golfLabModelSettings.marketFilter,
      maxRows: 6
    });
    if (!board.selectedEvent) {
      els.golfLabOddsShoppingBoard.innerHTML = emptyState("Import a tournament event and odds snapshots to shop books.");
      return;
    }
    if (!board.lineRows.length) {
      els.golfLabOddsShoppingBoard.innerHTML = emptyState(`Import multi-book ${golfLabMarketOddsLabel(golfLabModelSettings.marketFilter)} odds snapshots to compare best prices.`);
      return;
    }
    const latestOdds = Number.isFinite(board.summary.latestAgeDays)
      ? formatGolfLabSourceAge(board.summary.latestAgeDays)
      : "No timestamp";
    const marketRows = board.marketRows.slice(0, 3).map((row) => `
      <span class="golf-lab-shopping-chip">
        <b>${escapeHtml(row.label)}</b>
        <em>${row.bestEdges} edge${row.bestEdges === 1 ? "" : "s"} | ${formatLabEdge(row.avgBestLift)}</em>
      </span>
    `).join("");
    const bookRows = board.bookRows.slice(0, 3).map((row) => `
      <span class="golf-lab-shopping-chip golf-lab-shopping-chip-${escapeHtml(row.freshness || "unknown")}">
        <b>${escapeHtml(row.book)}</b>
        <em>${row.lines} lines | ${formatGolfLabSourceAge(row.latestAgeDays)}</em>
      </span>
    `).join("");
    const rows = board.rows.map((row) => `
      <article class="golf-lab-shopping-row golf-lab-shopping-row-${escapeHtml(row.status)}">
        <div class="golf-lab-shopping-head">
          <div>
            <strong>${escapeHtml(row.playerName || row.playerId || "Unknown player")}</strong>
            <span>${escapeHtml(`${row.marketLabel} | ${row.bookCount} books | best ${row.bestBook}`)}</span>
          </div>
          <b>${escapeHtml(row.statusLabel)}</b>
        </div>
        <div class="golf-lab-shopping-prices">
          <span><b>Best</b><em>${formatGolfLabOdds(row.bestOddsAmerican)}</em></span>
          <span><b>Consensus</b><em>${formatLabPercent(row.consensusImplied)}</em></span>
          <span><b>Model</b><em>${formatLabPercent(row.modelProbability)}</em></span>
          <span><b>Lift</b><em>${formatLabEdge(row.bestLift)}</em></span>
        </div>
        <small>${escapeHtml(`Worst ${row.worstBook} ${formatGolfLabOdds(row.worstOddsAmerican)} | edge at best ${formatLabEdge(row.edgeAtBest)} | ${formatGolfLabSourceAge(row.latestAgeDays)}`)}</small>
      </article>
    `).join("");
    els.golfLabOddsShoppingBoard.innerHTML = `
      <section class="golf-lab-shopping">
        <div class="golf-lab-edge-summary">
          ${renderGolfLabKpi("Lines", String(board.summary.lines), `${board.summary.players} players`)}
          ${renderGolfLabKpi("Best Edges", String(board.summary.bestEdges), golfLabMarketFilterLabel(golfLabModelSettings.marketFilter))}
          ${renderGolfLabKpi("Avg Lift", formatLabEdge(board.summary.avgBestLift), `max ${formatLabEdge(board.summary.maxBestLift)}`)}
          ${renderGolfLabKpi("Books", String(board.summary.books), latestOdds)}
        </div>
        <div class="golf-lab-shopping-strips">
          <div>${marketRows}</div>
          <div>${bookRows}</div>
        </div>
        <div class="golf-lab-shopping-list">
          ${rows || emptyState("No shop-ready lines yet.")}
        </div>
      </section>
    `;
  }

  function renderGolfLabEdgeBoard(lab) {
    if (!els.golfLabEdgeBoard) return;
    if (typeof buildPredictionEdgeBoard !== "function") {
      els.golfLabEdgeBoard.innerHTML = emptyState("Edge board is not available.");
      return;
    }
    const board = buildPredictionEdgeBoard(lab, {
      minEdge: getGolfLabEdgeThresholdProbability(),
      maxRows: 6,
      market: golfLabModelSettings.marketFilter
    });
    if (!board.candidates.length) {
      els.golfLabEdgeBoard.innerHTML = emptyState(`Run the model with imported ${golfLabMarketOddsLabel(golfLabModelSettings.marketFilter)} odds to surface edges.`);
      return;
    }
    if (!board.playable.length) {
      els.golfLabEdgeBoard.innerHTML = `
        <div class="golf-lab-edge-summary">
          ${renderGolfLabKpi("Candidates", board.summary.totalCandidates, "priced markets")}
          ${renderGolfLabKpi("Playable", "0", `${formatLabNumber(golfLabModelSettings.edgeThreshold, 1)}+ pp edge`)}
        </div>
        ${emptyState(`No ${golfLabMarketFilterLabel(golfLabModelSettings.marketFilter).toLowerCase()} edges above the threshold.`)}
      `;
      return;
    }
    const marketText = Object.entries(board.summary.markets)
      .map(([market, count]) => `${count} ${market}`)
      .join(" | ");
    els.golfLabEdgeBoard.innerHTML = `
      <div class="golf-lab-edge-summary">
        ${renderGolfLabKpi("Playable", board.summary.playable, marketText || golfLabMarketFilterLabel(golfLabModelSettings.marketFilter))}
        ${renderGolfLabKpi("Units", formatLabNumber(board.summary.totalStakeUnits, 2), "capped Kelly")}
      </div>
      <div class="golf-lab-edge-list">
        ${board.playable.map((row) => `
          <div class="golf-lab-edge-row">
            <div>
              <strong>${escapeHtml(row.playerName || row.playerId)}</strong>
              <span>${escapeHtml([row.eventName, row.market, row.confidence].filter(Boolean).join(" | "))}</span>
            </div>
            <div>
              <em>${formatLabEdge(row.edge)}</em>
              <b>${formatLabNumber(row.stakeUnits, 2)}u</b>
            </div>
            <small>Fair ${row.fairOddsAmerican || "--"} | market ${row.marketOddsAmerican || "--"} | model ${formatLabPercent(row.probability)}</small>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderGolfLabPortfolioStatus(status, label) {
    const key = String(status || "capped").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "capped";
    return `<b class="golf-lab-portfolio-badge golf-lab-portfolio-badge-${escapeHtml(key)}">${escapeHtml(label || key)}</b>`;
  }

  function renderGolfLabPortfolioWarning(warning) {
    return `<span class="golf-lab-portfolio-warning golf-lab-portfolio-warning-${escapeHtml(warning.severity || "info")}">
      <b>${escapeHtml(warning.label)}</b>
      <em>${escapeHtml(warning.detail)}</em>
    </span>`;
  }

  function renderGolfLabPortfolioExposure(group) {
    return `<span>
      <b>${escapeHtml(group.label)}</b>
      <em>${formatLabNumber(group.stakeUnits, 2)}u | EV ${formatLabNumber(group.expectedProfitUnits, 2, true)}u</em>
    </span>`;
  }

  function renderGolfLabBetPortfolioBoard(lab) {
    if (!els.golfLabBetPortfolioBoard) return;
    if (typeof buildBetPortfolioBoard !== "function") {
      els.golfLabBetPortfolioBoard.innerHTML = emptyState("Bet portfolio is not available.");
      return;
    }
    const board = buildBetPortfolioBoard(lab, {
      minEdge: getGolfLabEdgeThresholdProbability(),
      market: golfLabModelSettings.marketFilter,
      maxRows: 8,
      candidateRows: 40,
      maxTotalUnits: 8,
      maxPlayerUnits: 2.5,
      maxMarketUnits: 4,
      maxEventUnits: 6,
      minStakeUnits: 0.25
    });
    if (!board.summary.candidates) {
      els.golfLabBetPortfolioBoard.innerHTML = emptyState(`Run the model with imported ${golfLabMarketOddsLabel(golfLabModelSettings.marketFilter)} odds to build a capped slate.`);
      return;
    }
    if (!board.summary.included) {
      const warnings = board.warnings.length ? board.warnings.map(renderGolfLabPortfolioWarning).join("") : "";
      els.golfLabBetPortfolioBoard.innerHTML = `
        <div class="golf-lab-edge-summary">
          ${renderGolfLabKpi("Candidates", String(board.summary.candidates), golfLabMarketFilterLabel(board.marketFilter))}
          ${renderGolfLabKpi("Playable", String(board.summary.playable), `${formatLabNumber(golfLabModelSettings.edgeThreshold, 1)}+ pp edge`)}
        </div>
        ${warnings ? `<div class="golf-lab-portfolio-warnings">${warnings}</div>` : ""}
        ${emptyState("No plays fit the current edge threshold and portfolio caps.")}
      `;
      return;
    }
    const warnings = board.warnings.length
      ? board.warnings.slice(0, 3).map(renderGolfLabPortfolioWarning).join("")
      : `<span class="golf-lab-portfolio-warning golf-lab-portfolio-warning-clear"><b>Balanced slate</b><em>No portfolio caps are constraining this run.</em></span>`;
    const exposure = board.groups.markets.length
      ? board.groups.markets.slice(0, 4).map(renderGolfLabPortfolioExposure).join("")
      : `<span><b>No exposure</b><em>Portfolio empty</em></span>`;
    const rows = board.rows.slice(0, 6).map((row) => {
      const detailLine = [
        row.eventName,
        row.market,
        `edge ${formatLabEdge(row.edge)}`,
        `EV ${formatGolfLabExpectedUnits(row.expectedUnitReturn)}`
      ].filter(Boolean).join(" | ");
      const oddsLine = [
        `model ${formatLabPercent(row.probability)}`,
        `fair ${row.fairOddsAmerican || "--"}`,
        `market ${row.marketOddsAmerican || "--"}`,
        `potential ${formatLabNumber(row.potentialProfitUnits, 2, true)}u`
      ].join(" | ");
      return `<article class="golf-lab-portfolio-row golf-lab-portfolio-${escapeHtml(row.status)}">
        <div class="golf-lab-portfolio-head">
          <div>
            <strong>${escapeHtml(row.playerName || row.playerId)}</strong>
            <span>${escapeHtml(detailLine)}</span>
          </div>
          <div>
            ${renderGolfLabPortfolioStatus(row.status, row.statusLabel)}
            <em>${formatLabNumber(row.recommendedUnits, 2)}u</em>
          </div>
        </div>
        <small>${escapeHtml(oddsLine)}</small>
        ${row.status !== "included" ? `<small>Requested ${formatLabNumber(row.requestedUnits, 2)}u | cap room ${formatLabNumber(row.capRoomBefore, 2)}u</small>` : ""}
      </article>`;
    }).join("");
    els.golfLabBetPortfolioBoard.innerHTML = `
      <section class="golf-lab-portfolio">
        <div class="golf-lab-kpi-grid golf-lab-portfolio-kpis">
          ${renderGolfLabKpi("Bets", `${board.summary.included}/${board.summary.playable}`, `${board.summary.candidates} candidates`)}
          ${renderGolfLabKpi("Stake", `${formatLabNumber(board.summary.totalStakeUnits, 2)}u`, `${formatLabPercent(board.summary.budgetUsedPct)} budget`)}
          ${renderGolfLabKpi("Expected", `${formatLabNumber(board.summary.expectedProfitUnits, 2, true)}u`, formatGolfLabExpectedUnits(board.summary.avgExpectedUnitReturn))}
          ${renderGolfLabKpi("Avg Edge", formatLabEdge(board.summary.avgEdge), `${board.summary.trimmed} trimmed | ${board.summary.capped} capped`)}
        </div>
        <div class="golf-lab-portfolio-warnings">${warnings}</div>
        <div class="golf-lab-portfolio-exposure">${exposure}</div>
        <div class="golf-lab-portfolio-list">${rows}</div>
      </section>
    `;
  }

  function formatGolfLabProjectionToPar(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "--";
    if (numeric === 0) return "E";
    return formatLabNumber(numeric, 1, true);
  }

  function renderGolfLabProjectedReasonRows(title, rows, emptyText) {
    const body = rows && rows.length
      ? rows.map((row) => `<span>${escapeHtml(row)}</span>`).join("")
      : `<span>${escapeHtml(emptyText)}</span>`;
    return `<div class="golf-lab-projection-reasons">
      <strong>${escapeHtml(title)}</strong>
      <div>${body}</div>
    </div>`;
  }

  function renderGolfLabProjectedStandingsBoard(lab) {
    if (!els.golfLabProjectedStandingsBoard) return;
    if (typeof buildProjectedStandingsBoard !== "function") {
      els.golfLabProjectedStandingsBoard.innerHTML = emptyState("Projected standings are not available.");
      return;
    }
    const board = buildProjectedStandingsBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      weights: getGolfLabModelWeights(),
      maxRows: 12
    });
    if (!board.rows.length) {
      els.golfLabProjectedStandingsBoard.innerHTML = emptyState("Run the owned model to create a projected standings board.");
      return;
    }
    const eventLine = board.event
      ? [board.event.name || board.event.id, board.event.startDate, board.event.courseName].filter(Boolean).join(" | ")
      : "Selected tournament";
    const top = board.rows[0];
    const rows = board.rows.map((row) => {
      const currentLine = Number.isFinite(row.livePosition)
        ? `Live T${row.livePosition} | ${formatGolfLabProjectionToPar(row.liveToPar)}`
        : "Pre-tournament projection";
      const modelLine = [
        `Model rank ${row.rank || "--"}`,
        `${formatLabPercent(row.probability)} win`,
        Number.isFinite(row.marketOddsAmerican) ? `market ${formatGolfLabOdds(row.marketOddsAmerican)}` : "model only"
      ].join(" | ");
      const movement = Number.isFinite(row.projectedMove) && row.projectedMove !== 0
        ? `${row.projectedMove < 0 ? "Gains" : "Gives back"} ${formatLabNumber(Math.abs(row.projectedMove), 1)} projected shots`
        : "Holds current level";
      const confidenceKey = String(row.confidenceKey || "medium").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
      return `<article class="golf-lab-projection-row golf-lab-projection-${escapeHtml(confidenceKey)}">
        <div class="golf-lab-projection-rank">
          <span>${escapeHtml(row.projectedPositionLabel || "--")}</span>
          <strong>${escapeHtml(formatGolfLabProjectionToPar(row.projectedToPar))}</strong>
          <em>${escapeHtml(movement)}</em>
        </div>
        <div class="golf-lab-projection-main">
          <div class="golf-lab-projection-title">
            <strong>${escapeHtml(row.playerName || row.playerId)}</strong>
            <span>${escapeHtml(currentLine)}</span>
          </div>
          <p>${escapeHtml(modelLine)}</p>
          <div class="golf-lab-projection-explain">
            ${renderGolfLabProjectedReasonRows("Why here", row.plainEnglish, "Projection is model-rank driven.")}
            ${renderGolfLabProjectedReasonRows("What could break it", row.riskFlags, "No major model concern.")}
          </div>
        </div>
        <div class="golf-lab-projection-meta">
          <span>${escapeHtml(row.confidenceLabel || row.confidence || "Confidence")}</span>
          <strong>${row.sampleRounds} rounds</strong>
          <em>${Number.isFinite(row.edge) ? `edge ${formatLabEdge(row.edge)}` : "no edge read"}</em>
        </div>
      </article>`;
    }).join("");
    els.golfLabProjectedStandingsBoard.innerHTML = `
      <section class="golf-lab-projected-standings">
        <div class="golf-lab-projection-hero">
          <div>
            <p class="eyebrow">${escapeHtml(eventLine)}</p>
            <h3>${escapeHtml(top ? `${top.playerName} Projected No. 1` : "Projected Standings")}</h3>
            <p>${escapeHtml(board.summary.liveRounds ? `Live model after ${board.summary.liveRounds} rounds. Projection blends current score with the owned model's player-fit inputs.` : "Pre-tournament model projection built from player fit inputs.")}</p>
          </div>
          <div class="golf-lab-projection-verdict">
            <strong>${escapeHtml(top ? `${top.projectedPositionLabel} / ${formatGolfLabProjectionToPar(top.projectedToPar)}` : "--")}</strong>
            <span>${escapeHtml(board.summary.modelRunId || "Latest model run")}</span>
          </div>
        </div>
        <div class="golf-lab-kpi-grid golf-lab-projection-kpis">
          ${renderGolfLabKpi("Projected Leader", top ? top.playerName : "--", top ? `${top.projectedPositionLabel} | ${formatGolfLabProjectionToPar(top.projectedToPar)}` : "--")}
          ${renderGolfLabKpi("Players", String(board.summary.players), `${board.summary.pricedRows} priced`)}
          ${renderGolfLabKpi("Live State", board.summary.liveRounds ? `${board.summary.liveRounds}/4 rounds` : "Pre-event", Number.isFinite(board.summary.liveLeaderToPar) ? `leader ${formatGolfLabProjectionToPar(board.summary.liveLeaderToPar)}` : "no live score")}
          ${renderGolfLabKpi("Cut Line", Number.isFinite(board.summary.projectedCutLine) ? formatGolfLabProjectionToPar(board.summary.projectedCutLine) : "--", "projected top 65")}
        </div>
        <div class="golf-lab-projection-list">${rows}</div>
      </section>
    `;
  }

  function formatGolfLabRankDelta(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "--";
    if (numeric === 0) return "On rank";
    return numeric > 0 ? `${Math.round(numeric)} spots high` : `${Math.abs(Math.round(numeric))} spots low`;
  }

  function renderGolfLabResultsMarketPills(markets) {
    const rows = Array.isArray(markets) ? markets.slice(0, 4) : [];
    if (!rows.length) return `<span class="golf-lab-result-market golf-lab-result-market-pending"><b>No markets</b><em>model only</em></span>`;
    return rows.map((market) => {
      const status = String(market.status || "pending").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "pending";
      return `<span class="golf-lab-result-market golf-lab-result-market-${escapeHtml(status)}">
        <b>${escapeHtml(market.marketLabel || market.market || "Market")}</b>
        <em>${escapeHtml(market.statusLabel || status)}</em>
      </span>`;
    }).join("");
  }

  function renderGolfLabResultsSummaryBoard(lab) {
    if (!els.golfLabResultsSummaryBoard) return;
    if (typeof buildPredictionResultsSummaryBoard !== "function") {
      els.golfLabResultsSummaryBoard.innerHTML = emptyState("Results summary is not available.");
      return;
    }
    const board = buildPredictionResultsSummaryBoard(lab, {
      eventId: getSelectedGolfLabEventId(),
      weights: getGolfLabModelWeights(),
      minEdge: getGolfLabEdgeThresholdProbability(),
      maxRows: 12
    });
    if (!board.rows.length) {
      els.golfLabResultsSummaryBoard.innerHTML = emptyState("Run the owned model and import tournament scoring to review why predictions worked or missed.");
      return;
    }
    const eventLine = board.event
      ? [board.event.name || board.event.id, board.event.startDate, board.event.courseName].filter(Boolean).join(" | ")
      : "Selected tournament";
    const spotlight = board.summary.biggestMiss || board.summary.topResult || board.rows[0];
    const spotlightText = spotlight
      ? `${spotlight.playerName}: ${spotlight.outcomeLabel} | model No. ${spotlight.modelRank || "--"} | finish ${spotlight.actualPositionLabel || "--"}`
      : "Awaiting results";
    const rows = board.rows.map((row) => {
      const outcomeKey = String(row.outcome || "pending").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "pending";
      const actualLine = Number.isFinite(row.actualPosition)
        ? `Finish ${row.actualPositionLabel} | ${formatGolfLabProjectionToPar(row.actualToPar)} | ${row.roundsCompleted || 0} rounds`
        : "No imported finish";
      const modelLine = [
        `Model No. ${row.modelRank || "--"}`,
        `${formatLabPercent(row.winProbability)} win`,
        Number.isFinite(row.marketOddsAmerican) ? `market ${formatGolfLabOdds(row.marketOddsAmerican)}` : "model only",
        row.confidence || ""
      ].filter(Boolean).join(" | ");
      const accuracy = Number.isFinite(row.accuracyScore) ? `${row.accuracyScore}/100` : row.eventComplete ? "--" : "live";
      return `<article class="golf-lab-result-row golf-lab-result-${escapeHtml(outcomeKey)}">
        <div class="golf-lab-result-rank">
          <span>${escapeHtml(row.outcomeLabel || "Result")}</span>
          <strong>${escapeHtml(row.actualPositionLabel || "--")}</strong>
          <em>${escapeHtml(formatGolfLabRankDelta(row.rankDelta))}</em>
        </div>
        <div class="golf-lab-result-main">
          <div class="golf-lab-result-title">
            <strong>${escapeHtml(row.playerName || row.playerId)}</strong>
            <span>${escapeHtml(actualLine)}</span>
          </div>
          <p>${escapeHtml(modelLine)}</p>
          <div class="golf-lab-result-markets">${renderGolfLabResultsMarketPills(row.marketOutcomes)}</div>
          <div class="golf-lab-result-explain">
            ${renderGolfLabProjectedReasonRows("Why it happened", row.plainEnglish, "No result explanation yet.")}
            ${renderGolfLabProjectedReasonRows("Model lesson", row.lessons, "No model lesson yet.")}
          </div>
        </div>
        <div class="golf-lab-result-meta">
          <span>${escapeHtml(accuracy)}</span>
          <strong>${row.marketHits}/${row.marketHits + row.marketMisses} markets</strong>
          <em>${Number.isFinite(row.profitUnits) && row.eventComplete ? `${formatLabNumber(row.profitUnits, 2, true)}u` : board.eventComplete ? "no units" : "pending"}</em>
        </div>
      </article>`;
    }).join("");
    els.golfLabResultsSummaryBoard.innerHTML = `
      <section class="golf-lab-results-summary">
        <div class="golf-lab-results-hero">
          <div>
            <p class="eyebrow">${escapeHtml(eventLine)}</p>
            <h3>${escapeHtml(board.eventComplete ? "Prediction Results Review" : "Live Prediction Review")}</h3>
            <p>${escapeHtml(board.eventComplete ? "Final scoring is imported, so the board explains which model reads worked, missed, or undercalled player upside." : `Tournament has ${board.summary.completedRounds || 0}/4 rounds imported, so this stays framed as a live read.`)}</p>
          </div>
          <div class="golf-lab-results-spotlight">
            <strong>${escapeHtml(spotlightText)}</strong>
            <span>${escapeHtml(board.summary.modelRunId || "Latest model run")}</span>
          </div>
        </div>
        <div class="golf-lab-kpi-grid golf-lab-results-kpis">
          ${renderGolfLabKpi("Reviewed", String(board.summary.players), `${board.summary.settledPlayers} final | ${board.summary.livePlayers} live`)}
          ${renderGolfLabKpi("Right Reads", String(board.summary.rightReads), `${formatLabPercent(board.summary.hitRate)} accuracy band`)}
          ${renderGolfLabKpi("Misses", String(board.summary.misses), `${board.summary.undercalled} undercalled`)}
          ${renderGolfLabKpi("Rank Error", Number.isFinite(board.summary.avgRankError) ? formatLabNumber(board.summary.avgRankError, 1) : "--", `score ${Number.isFinite(board.summary.avgAccuracyScore) ? formatLabNumber(board.summary.avgAccuracyScore, 0) : "--"}`)}
        </div>
        <div class="golf-lab-results-list">${rows}</div>
      </section>
    `;
  }

  function formatGolfLabExpectedUnits(value) {
    if (!Number.isFinite(value)) return "--";
    return `${formatLabNumber(value, 2, true)}u / 1u`;
  }

  function renderGolfLabVerdictBadge(verdict) {
    const key = String(verdict || "model-only").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "model-only";
    const labels = {
      play: "Play",
      lean: "Lean",
      pass: "Pass",
      "model-only": "Model only"
    };
    return `<span class="golf-lab-verdict-badge golf-lab-verdict-${escapeHtml(key)}">${escapeHtml(labels[key] || key)}</span>`;
  }

  function renderGolfLabContributionStrip(contributions) {
    return `<div class="golf-lab-explainer-features">
      ${(contributions || []).map((feature) => {
        const contribution = Number(feature.contribution);
        const width = Number.isFinite(contribution) ? Math.max(6, Math.min(100, Math.abs(contribution) * 80)) : 0;
        const impact = feature.impact || (contribution < 0 ? "negative" : contribution > 0 ? "positive" : "neutral");
        return `<span class="golf-lab-explainer-feature golf-lab-explainer-feature-${escapeHtml(impact)}">
          <b>${escapeHtml(feature.label)}</b>
          <em>${formatLabNumber(contribution, 2, true)}</em>
          <i style="--explain:${width}%"></i>
        </span>`;
      }).join("")}
    </div>`;
  }

  function renderGolfLabReasonList(title, rows, emptyText) {
    const body = rows && rows.length
      ? rows.map((row) => `<span>${escapeHtml(row.label)} ${formatLabNumber(row.contribution, 2, true)}</span>`).join("")
      : `<span>${escapeHtml(emptyText)}</span>`;
    return `<div class="golf-lab-explainer-reasons">
      <strong>${escapeHtml(title)}</strong>
      <div>${body}</div>
    </div>`;
  }

  function renderGolfLabModelExplainerBoard(lab) {
    if (!els.golfLabModelExplainerBoard) return;
    if (typeof buildPredictionExplainerBoard !== "function") {
      els.golfLabModelExplainerBoard.innerHTML = emptyState("Model explainer is not available.");
      return;
    }
    const board = buildPredictionExplainerBoard(lab, {
      market: golfLabModelSettings.marketFilter,
      minEdge: getGolfLabEdgeThresholdProbability(),
      weights: getGolfLabModelWeights(),
      maxRows: 6
    });
    if (!board.rows.length) {
      els.golfLabModelExplainerBoard.innerHTML = emptyState("Run the owned model to explain player predictions and feature contributions.");
      return;
    }
    const rows = board.rows.map((row) => {
      const marketLine = [
        row.eventName,
        row.market,
        row.modelProfile,
        row.modelWeatherLabel || row.modelWeatherScenario,
        row.confidence
      ].filter(Boolean).join(" | ");
      const priceLine = [
        `Model ${formatLabPercent(row.probability)}`,
        `fair ${row.fairOddsAmerican || "--"}`,
        `market ${row.marketOddsAmerican || "--"}`,
        `edge ${formatLabEdge(row.edge)}`,
        `EV ${formatGolfLabExpectedUnits(row.expectedUnitReturn)}`
      ].join(" | ");
      return `<article class="golf-lab-explainer-row golf-lab-explainer-${escapeHtml(row.verdict)}">
        <div class="golf-lab-explainer-head">
          <div>
            <strong>${escapeHtml(row.playerName || row.playerId)}</strong>
            <span>${escapeHtml(marketLine)}</span>
          </div>
          <div>
            ${renderGolfLabVerdictBadge(row.verdict)}
            <em>${escapeHtml(priceLine)}</em>
          </div>
        </div>
        ${renderGolfLabContributionStrip(row.contributions)}
        <div class="golf-lab-explainer-reason-grid">
          ${renderGolfLabReasonList("Why it likes it", row.strengths, "No positive feature contribution")}
          ${renderGolfLabReasonList("Risk flags", row.concerns, row.thinSample ? "Thin sample" : "No negative feature drag")}
        </div>
      </article>`;
    }).join("");
    els.golfLabModelExplainerBoard.innerHTML = `
      <section class="golf-lab-model-explainer">
        <div class="golf-lab-kpi-grid golf-lab-model-explainer-kpis">
          ${renderGolfLabKpi("Explained", String(board.summary.predictions), golfLabMarketFilterLabel(board.marketFilter))}
          ${renderGolfLabKpi("Plays", String(board.summary.plays), `${board.summary.leans} leans`)}
          ${renderGolfLabKpi("Priced", `${board.summary.priced}/${board.summary.predictions}`, `${board.summary.modelOnly} model only`)}
          ${renderGolfLabKpi("Avg EV", formatGolfLabExpectedUnits(board.summary.avgExpectedUnitReturn), `${board.summary.thinSamples} thin samples`)}
        </div>
        <div class="golf-lab-explainer-list">${rows}</div>
      </section>
    `;
  }

  function getGolfLabBacktest(lab) {
    if (typeof buildPredictionBacktest !== "function") return null;
    return buildPredictionBacktest(lab, { minEdge: getGolfLabEdgeThresholdProbability() });
  }

  function getGolfLabPerformance(lab) {
    if (typeof buildModelPerformanceBoard !== "function") return null;
    return buildModelPerformanceBoard(lab, {
      minEdge: getGolfLabEdgeThresholdProbability(),
      recentRows: 6
    });
  }

  function renderGolfLabSettlementBadge(status, label) {
    const key = String(status || "waiting").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "waiting";
    return `<b class="golf-lab-settlement-badge golf-lab-settlement-badge-${escapeHtml(key)}">${escapeHtml(label || key)}</b>`;
  }

  function renderGolfLabSettlementBoard(lab) {
    if (!els.golfLabSettlementBoard) return;
    if (typeof buildPredictionSettlementBoard !== "function") {
      els.golfLabSettlementBoard.innerHTML = emptyState("Settlement board is not available.");
      return;
    }
    const board = buildPredictionSettlementBoard(lab, {
      minEdge: getGolfLabEdgeThresholdProbability(),
      market: golfLabModelSettings.marketFilter,
      maxRows: 6
    });
    if (!board.summary.predictions) {
      els.golfLabSettlementBoard.innerHTML = emptyState("Run predictions before building a settlement board.");
      return;
    }
    const eventRows = board.eventRows.slice(0, 5).map((row) => {
      const eventLine = [
        row.courseName,
        row.startDate,
        row.markets.slice(0, 3).join(", ")
      ].filter(Boolean).join(" | ");
      const resultLine = [
        `${row.settled}/${row.total} settled`,
        `${row.gradeable} gradeable`,
        `${row.resultRounds} result rows`,
        `${formatLabNumber(row.profitUnits, 2, true)}u`
      ].join(" | ");
      const blockers = row.blockers.slice(0, 3).map((label) => `<span>${escapeHtml(label)}</span>`).join("");
      return `<article class="golf-lab-settlement-row golf-lab-settlement-${escapeHtml(row.status)}">
        <div class="golf-lab-settlement-head">
          <div>
            <strong>${escapeHtml(row.eventName)}</strong>
            <span>${escapeHtml(eventLine || row.eventId)}</span>
          </div>
          ${renderGolfLabSettlementBadge(row.status, row.statusLabel)}
        </div>
        <small>${escapeHtml(resultLine)}</small>
        ${blockers ? `<div class="golf-lab-settlement-flags">${blockers}</div>` : ""}
      </article>`;
    }).join("");
    const recentRows = board.recentSettlements.slice(0, 5).map((row) => `
      <div class="golf-lab-settlement-recent-row">
        <strong>${escapeHtml(row.playerName || row.playerId)}</strong>
        <span>${escapeHtml([row.eventId, row.market, row.result].filter(Boolean).join(" | "))}</span>
        <em>${formatLabNumber(row.profitUnits, 2, true)}u</em>
      </div>
    `).join("");
    els.golfLabSettlementBoard.innerHTML = `
      <section class="golf-lab-settlement">
        <div class="golf-lab-kpi-grid golf-lab-settlement-kpis">
          ${renderGolfLabKpi("Gradeable", String(board.summary.gradeable), `${board.summary.readyEvents} ready events`)}
          ${renderGolfLabKpi("Settled", `${board.summary.settled}/${board.summary.predictions}`, `${board.summary.pending} pending`)}
          ${renderGolfLabKpi("Units", formatLabNumber(board.summary.profitUnits, 2, true), `${board.summary.bets} priced bets`)}
          ${renderGolfLabKpi("ROI", formatLabPercent(board.summary.roi), `${formatLabPercent(board.summary.hitRate)} hit rate`)}
        </div>
        <div class="golf-lab-settlement-grid">
          <div class="golf-lab-settlement-list">${eventRows || emptyState("No event settlement rows yet.")}</div>
          <div class="golf-lab-settlement-recent">
            <h4>Recent Settlements</h4>
            ${recentRows || emptyState("No settled predictions yet.")}
          </div>
        </div>
      </section>
    `;
  }

  function renderGolfLabPerformanceGroup(title, rows, emptyLabel) {
    const usableRows = (rows || []).filter((row) => row.total > 0).slice(0, 4);
    if (!usableRows.length) {
      return `<section class="golf-lab-performance-block"><h4>${escapeHtml(title)}</h4>${emptyState(emptyLabel)}</section>`;
    }
    return `<section class="golf-lab-performance-block">
      <h4>${escapeHtml(title)}</h4>
      <div class="golf-lab-performance-list">
        ${usableRows.map((row) => `
          <div class="golf-lab-performance-row">
            <div>
              <strong>${escapeHtml(row.label)}</strong>
              <span>${row.settled}/${row.total} settled | ${row.bets} bets</span>
            </div>
            <div>
              <em>${formatLabNumber(row.profitUnits, 2, true)}u</em>
              <span>${formatLabPercent(row.hitRate)} hit | ${formatLabPercent(row.roi)} ROI</span>
            </div>
          </div>
        `).join("")}
      </div>
    </section>`;
  }

  function renderGolfLabBacktestPanel(lab) {
    if (!els.golfLabBacktestPanel) return;
    const performance = getGolfLabPerformance(lab);
    const backtest = performance || getGolfLabBacktest(lab);
    if (els.golfLabGradePredictions) {
      const canGrade = backtest && backtest.summary.total > 0 && lab.rounds.length > 0;
      els.golfLabGradePredictions.disabled = !canGrade;
    }
    if (!backtest || !backtest.summary.total) {
      els.golfLabBacktestPanel.innerHTML = emptyState("Run predictions and import tournament results to backtest the model.");
      return;
    }
    const summary = backtest.summary;
    const recent = backtest.graded
      .filter((row) => row.settled)
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "") || (a.rank || 999) - (b.rank || 999))
      .slice(0, 5);
    const groups = performance ? `
      <div class="golf-lab-performance-grid">
        ${renderGolfLabPerformanceGroup("By Market", performance.groups.markets, "No settled markets yet.")}
        ${renderGolfLabPerformanceGroup("By Profile", performance.groups.profiles, "No model profiles yet.")}
        ${renderGolfLabPerformanceGroup("By Weather", performance.groups.weather, "No weather scenarios yet.")}
        ${renderGolfLabPerformanceGroup("By Confidence", performance.groups.confidence, "No confidence buckets yet.")}
        ${renderGolfLabPerformanceGroup("Edge Buckets", performance.groups.edgeBuckets, "No edge buckets yet.")}
      </div>
    ` : "";
    els.golfLabBacktestPanel.innerHTML = `
      <div class="golf-lab-backtest-summary">
        ${renderGolfLabKpi("Settled", `${summary.settled}/${summary.total}`, `${summary.pending} pending`)}
        ${renderGolfLabKpi("Hit Rate", formatLabPercent(summary.hitRate), `${summary.hits} hits`)}
        ${renderGolfLabKpi("Units", formatLabNumber(summary.profitUnits, 2, true), `${summary.bets} bets`)}
        ${renderGolfLabKpi("ROI", formatLabPercent(summary.roi), "edge bets")}
      </div>
      ${groups}
      <div class="golf-lab-stack">
        ${recent.length ? recent.map((row) => `
          <div class="golf-lab-event-row">
            <strong>${escapeHtml([row.market, row.result].filter(Boolean).join(" | "))}</strong>
            <span>${escapeHtml(row.playerId)} | finish ${row.finishPosition || "--"} | units ${formatLabNumber(row.profitUnits, 2, true)}</span>
          </div>
        `).join("") : emptyState("No settled predictions yet.")}
      </div>
    `;
  }

  function renderGolfLabTrainingDatasetBoard(lab) {
    if (!els.golfLabTrainingDatasetBoard) return;
    if (typeof buildModelTrainingDataset !== "function") {
      els.golfLabTrainingDatasetBoard.innerHTML = emptyState("Training dataset builder is not available.");
      return;
    }
    const board = buildModelTrainingDataset(lab, {
      eventLimit: lab.events.length || 1,
      rowLimit: 24,
      weights: getGolfLabModelWeights(),
      modelProfile: getGolfLabModelPreset().label,
      weatherScenario: golfLabModelSettings.weatherScenario
    });
    if (!board.rows.length) {
      els.golfLabTrainingDatasetBoard.innerHTML = emptyState("Import completed tournament rounds to create model training examples.");
      return;
    }
    const eventRows = board.eventRows.slice(0, 6).map((row) => `
      <div class="golf-lab-training-event">
        <div>
          <strong>${escapeHtml(row.eventName)}</strong>
          <span>${escapeHtml([row.startDate, row.courseName].filter(Boolean).join(" | ") || "Completed event")}</span>
        </div>
        <div>
          <b>${row.examples}/${row.standings}</b>
          <em>${row.featureCoverage}% features</em>
        </div>
      </div>
    `).join("");
    const examples = board.rows.slice(0, 8).map((row) => `
      <article class="golf-lab-training-row${row.featureComplete ? " golf-lab-training-row-ready" : ""}">
        <div class="golf-lab-training-head">
          <div>
            <strong>${escapeHtml(row.playerName)}</strong>
            <span>${escapeHtml(row.eventName)} | finish ${row.finishPosition} | ${formatLabNumber(row.totalToPar, 0, true)} to par</span>
          </div>
          <b>${row.winner ? "Win" : row.top10 ? "Top 10" : row.top20 ? "Top 20" : "Result"}</b>
        </div>
        <div class="golf-lab-training-features">
          <span><b>${formatLabNumber(row.skill, 2, true)}</b><em>skill</em></span>
          <span><b>${formatLabNumber(row.recentForm, 2, true)}</b><em>recent</em></span>
          <span><b>${formatLabNumber(row.courseFit, 2, true)}</b><em>course</em></span>
          <span><b>${formatLabNumber(row.weatherFit, 2, true)}</b><em>weather</em></span>
        </div>
        <small>Model rank ${row.modelRank || "--"} | win ${formatLabPercent(row.winProbability)} | ${row.sampleRounds} prior rounds</small>
      </article>
    `).join("");
    els.golfLabTrainingDatasetBoard.innerHTML = `
      <section class="golf-lab-training">
        <div class="golf-lab-kpi-grid golf-lab-training-kpis">
          ${renderGolfLabKpi("Examples", String(board.summary.rows), `${board.summary.events} events`)}
          ${renderGolfLabKpi("Players", String(board.summary.players), `${board.summary.winners} winners`)}
          ${renderGolfLabKpi("Feature Coverage", `${board.summary.featureCoverage}%`, `${formatLabNumber(board.summary.avgSampleRounds, 1)} avg prior rounds`)}
          ${renderGolfLabKpi("Made Cuts", String(board.summary.madeCuts), `${board.summary.rows - board.summary.madeCuts} missed/short samples`)}
        </div>
        <div class="golf-lab-training-grid">
          <section class="golf-lab-training-block">
            <h4>Event Coverage</h4>
            <div class="golf-lab-training-list">${eventRows}</div>
          </section>
          <section class="golf-lab-training-block">
            <h4>Training Examples</h4>
            <div class="golf-lab-training-list">${examples}</div>
          </section>
        </div>
      </section>
    `;
  }

  function renderGolfLabCalibrationBadge(status, label) {
    const key = String(status || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "unknown";
    return `<b class="golf-lab-calibration-badge golf-lab-calibration-badge-${escapeHtml(key)}">${escapeHtml(label || key)}</b>`;
  }

  function renderGolfLabCalibrationAlert(alert) {
    return `<span class="golf-lab-calibration-alert golf-lab-calibration-alert-${escapeHtml(alert.severity || "info")}">
      <b>${escapeHtml(alert.label)}</b>
      <em>${escapeHtml(alert.detail)}</em>
    </span>`;
  }

  function renderGolfLabCalibrationGroup(title, rows, emptyLabel) {
    const usableRows = (rows || []).filter((row) => row.total > 0).slice(0, 6);
    if (!usableRows.length) {
      return `<section class="golf-lab-calibration-block"><h4>${escapeHtml(title)}</h4>${emptyState(emptyLabel)}</section>`;
    }
    return `<section class="golf-lab-calibration-block">
      <h4>${escapeHtml(title)}</h4>
      <div class="golf-lab-calibration-list">
        ${usableRows.map((row) => {
          const modelPct = Number.isFinite(row.avgProbability) ? Math.round(row.avgProbability * 100) : 0;
          const hitPct = Number.isFinite(row.hitRate) ? Math.round(row.hitRate * 100) : 0;
          return `<article class="golf-lab-calibration-row golf-lab-calibration-${escapeHtml(row.status)}">
            <div class="golf-lab-calibration-head">
              <div>
                <strong>${escapeHtml(row.label)}</strong>
                <span>${escapeHtml(`${row.hits}/${row.total} hit | expected ${formatLabNumber(row.expectedHits, 1)} | delta ${formatLabEdge(row.calibrationDelta)}`)}</span>
              </div>
              ${renderGolfLabCalibrationBadge(row.status, row.statusLabel)}
            </div>
            <div class="golf-lab-calibration-bars">
              <span><b>Model</b><em style="--calibration:${modelPct}%"></em><small>${formatLabPercent(row.avgProbability)}</small></span>
              <span><b>Actual</b><em style="--calibration:${hitPct}%"></em><small>${formatLabPercent(row.hitRate)}</small></span>
            </div>
            <small>Brier ${formatLabNumber(row.brierScore, 3)} | units ${formatLabNumber(row.profitUnits, 2, true)} | ROI ${formatLabPercent(row.roi)}</small>
          </article>`;
        }).join("")}
      </div>
    </section>`;
  }

  function renderGolfLabModelCalibrationBoard(lab) {
    if (!els.golfLabModelCalibrationBoard) return;
    if (typeof buildModelCalibrationBoard !== "function") {
      els.golfLabModelCalibrationBoard.innerHTML = emptyState("Model calibration is not available.");
      return;
    }
    const board = buildModelCalibrationBoard(lab, {
      market: golfLabModelSettings.marketFilter,
      minEdge: getGolfLabEdgeThresholdProbability(),
      minSamples: 5
    });
    if (!board.summary.totalPredictions) {
      els.golfLabModelCalibrationBoard.innerHTML = emptyState("Run predictions and import tournament results to calibrate model probabilities.");
      return;
    }
    if (!board.summary.settled) {
      els.golfLabModelCalibrationBoard.innerHTML = `
        <div class="golf-lab-backtest-summary">
          ${renderGolfLabKpi("Predictions", String(board.summary.totalPredictions), golfLabMarketFilterLabel(board.marketFilter))}
          ${renderGolfLabKpi("Settled", "0", `${board.summary.pending} pending`)}
        </div>
        ${emptyState("Import completed tournament rounds, then grade predictions to unlock calibration.")}
      `;
      return;
    }
    const alerts = board.alerts.length
      ? board.alerts.slice(0, 4).map(renderGolfLabCalibrationAlert).join("")
      : `<span class="golf-lab-calibration-alert golf-lab-calibration-alert-clear"><b>Stable read</b><em>No calibration warnings for this sample.</em></span>`;
    els.golfLabModelCalibrationBoard.innerHTML = `
      <section class="golf-lab-calibration">
        <div class="golf-lab-kpi-grid golf-lab-calibration-kpis">
          ${renderGolfLabKpi("Settled", `${board.summary.settled}/${board.summary.totalPredictions}`, `${board.summary.pending} pending`)}
          ${renderGolfLabKpi("Hit Rate", formatLabPercent(board.summary.hitRate), `model avg ${formatLabPercent(board.summary.avgProbability)}`)}
          ${renderGolfLabKpi("Brier", formatLabNumber(board.summary.brierScore, 3), board.summary.statusLabel)}
          ${renderGolfLabKpi("Units", formatLabNumber(board.summary.profitUnits, 2, true), `${formatLabPercent(board.summary.roi)} ROI`)}
        </div>
        <div class="golf-lab-calibration-alerts">${alerts}</div>
        <div class="golf-lab-calibration-grid">
          ${renderGolfLabCalibrationGroup("Probability Buckets", board.probabilityBuckets, "No settled probability buckets yet.")}
          ${renderGolfLabCalibrationGroup("Markets", board.marketRows, "No settled market buckets yet.")}
          ${renderGolfLabCalibrationGroup("Edge Buckets", board.edgeBuckets, "No settled edge buckets yet.")}
        </div>
      </section>
    `;
  }

  function renderGolfLabTuningAlert(alert) {
    return `<span class="golf-lab-tuning-alert golf-lab-tuning-alert-${escapeHtml(alert.severity || "info")}">
      <b>${escapeHtml(alert.label)}</b>
      <em>${escapeHtml(alert.detail)}</em>
    </span>`;
  }

  function renderGolfLabTuningGroup(title, rows, emptyLabel) {
    const usableRows = (rows || []).filter((row) => row.total > 0).slice(0, 5);
    if (!usableRows.length) {
      return `<section class="golf-lab-tuning-block"><h4>${escapeHtml(title)}</h4>${emptyState(emptyLabel)}</section>`;
    }
    return `<section class="golf-lab-tuning-block">
      <h4>${escapeHtml(title)}</h4>
      <div class="golf-lab-tuning-list">
        ${usableRows.map((row) => `
          <div class="golf-lab-tuning-mini-row">
            <div>
              <strong>${escapeHtml(row.label)}</strong>
              <span>${row.settled}/${row.total} settled | ${row.bets} bets</span>
            </div>
            <div>
              <em>${formatLabNumber(row.profitUnits, 2, true)}u</em>
              <span>${formatLabPercent(row.roi)} ROI</span>
            </div>
          </div>
        `).join("")}
      </div>
    </section>`;
  }

  function renderGolfLabModelTuningBoard(lab) {
    if (!els.golfLabModelTuningBoard) return;
    if (typeof buildModelTuningBoard !== "function") {
      els.golfLabModelTuningBoard.innerHTML = emptyState("Model tuning is not available.");
      return;
    }
    const board = buildModelTuningBoard(lab, {
      market: golfLabModelSettings.marketFilter,
      minEdge: getGolfLabEdgeThresholdProbability(),
      minSamples: 5,
      weights: getGolfLabModelWeights()
    });
    if (!board.summary.totalPredictions) {
      els.golfLabModelTuningBoard.innerHTML = emptyState("Run and grade predictions to unlock model tuning diagnostics.");
      return;
    }
    if (!board.summary.settled) {
      els.golfLabModelTuningBoard.innerHTML = `
        <div class="golf-lab-backtest-summary">
          ${renderGolfLabKpi("Predictions", String(board.summary.totalPredictions), golfLabMarketFilterLabel(board.marketFilter))}
          ${renderGolfLabKpi("Settled", "0", "needs graded results")}
        </div>
        ${emptyState("Import completed tournament rounds, then grade predictions to start tuning the model.")}
      `;
      return;
    }
    const alerts = board.alerts.length
      ? board.alerts.slice(0, 4).map(renderGolfLabTuningAlert).join("")
      : `<span class="golf-lab-tuning-alert golf-lab-tuning-alert-clear"><b>No tuning flags</b><em>Current settled sample has no strong adjustment signals.</em></span>`;
    const featureRows = board.featureRows.map((row) => `
      <article class="golf-lab-tuning-feature golf-lab-tuning-feature-${escapeHtml(row.action)}">
        <div class="golf-lab-tuning-feature-head">
          <div>
            <strong>${escapeHtml(row.label)}</strong>
            <span>${row.sampleCount} samples | split ${formatLabNumber(row.splitValue, 2, true)} | delta ${formatLabNumber(row.deltaRoi, 2, true)}u</span>
          </div>
          <b>${escapeHtml(row.actionLabel)}</b>
        </div>
        <div class="golf-lab-tuning-bars">
          <span><b>High ROI</b><em>${formatLabPercent(row.high.roi)}</em></span>
          <span><b>Low ROI</b><em>${formatLabPercent(row.low.roi)}</em></span>
          <span><b>Weight</b><em>${formatLabNumber(row.currentWeight, 2)} -> ${formatLabNumber(row.suggestedWeight, 2)}</em></span>
        </div>
      </article>
    `).join("");
    els.golfLabModelTuningBoard.innerHTML = `
      <section class="golf-lab-tuning">
        <div class="golf-lab-kpi-grid golf-lab-tuning-kpis">
          ${renderGolfLabKpi("Settled", `${board.summary.settled}/${board.summary.totalPredictions}`, golfLabMarketFilterLabel(board.marketFilter))}
          ${renderGolfLabKpi("Units", formatLabNumber(board.summary.profitUnits, 2, true), `${formatLabPercent(board.summary.roi)} ROI`)}
          ${renderGolfLabKpi("Signals", String(board.summary.tuneSignals), board.summary.bestProfile ? `best ${board.summary.bestProfile}` : "no profile edge")}
          ${renderGolfLabKpi("Calibration", formatLabEdge(board.summary.calibrationError), `${board.minSamples} min samples`)}
        </div>
        <div class="golf-lab-tuning-alerts">${alerts}</div>
        <div class="golf-lab-tuning-grid">
          <section class="golf-lab-tuning-block golf-lab-tuning-feature-block">
            <h4>Feature Weight Signals</h4>
            <div class="golf-lab-tuning-list">${featureRows}</div>
          </section>
          ${renderGolfLabTuningGroup("Profile Leaks", board.profileRows, "No model profile results yet.")}
          ${renderGolfLabTuningGroup("Market Leaks", board.marketRows, "No market results yet.")}
        </div>
      </section>
    `;
  }

  function gradeGolfLabPredictions() {
    const lab = normalizeGolfLabState(state.golfLab);
    const backtest = getGolfLabBacktest(lab);
    if (!backtest || !backtest.graded.length) {
      showToast("No predictions available to grade.");
      return;
    }
    const settled = backtest.graded.filter((row) => row.settled);
    if (!settled.length) {
      showToast("Import completed tournament rounds before grading.");
      return;
    }
    applyGolfLabDataMerge({ predictionLedger: backtest.graded }, "Prediction ledger graded.");
    setGolfLabModelStatus(`Backtest graded ${settled.length} settled predictions | units ${formatLabNumber(backtest.summary.profitUnits, 2, true)}.`);
  }

  function golfLabImportPreviewStatus(preview, fallback = "Golf Lab import complete.") {
    if (!preview || !preview.summary) return fallback;
    const summary = preview.summary;
    const verdict = preview.verdict || {};
    const firstAction = preview.nextActions && preview.nextActions.length ? preview.nextActions[0] : null;
    const movement = `${summary.scoreBefore || 0}->${summary.scoreAfter || 0}`;
    const changeText = `+${summary.addedRecords || 0} new / ${summary.updatedRecords || 0} updated`;
    const blockerText = firstAction ? ` Next: ${firstAction.label}: ${firstAction.detail}` : "";
    return `Import preview ${changeText} | score ${movement} | ${verdict.label || "Import reviewed"}.${blockerText}`;
  }

  function applyGolfLabImport(payload) {
    const snapshot = typeof buildGolfLabImportSnapshot === "function"
      ? buildGolfLabImportSnapshot(payload)
      : { golfLab: normalizeGolfLabState(payload && payload.golfLab && typeof payload.golfLab === "object" ? payload.golfLab : payload), report: null, warnings: [] };
    const normalized = normalizeGolfLabState(snapshot.golfLab);
    if (!hasGolfLabData(normalized)) {
      throw new Error("That file did not contain Golf Lab data.");
    }
    const preview = typeof buildGolfLabImportPreview === "function"
      ? buildGolfLabImportPreview(state.golfLab, { golfLab: normalized })
      : null;
    applyGolfLabDataMerge(normalized, "Golf Lab data imported.");
    if (snapshot.report) {
      setGolfLabModelStatus(golfLabImportPreviewStatus(preview, `Imported ${snapshot.report.totalRecords} warehouse records. Score ${snapshot.report.score}.`));
    }
  }

  function readGolfLabImportFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.readAsText(file);
    });
  }

  function isGolfLabJsonFile(file) {
    return /\.json$/i.test(file.name) || String(file.type || "").includes("json");
  }

  function isGolfLabCsvFile(file) {
    return /\.csv$/i.test(file.name) || String(file.type || "").includes("csv");
  }

  async function applyGolfLabImportFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let mergedLab = blankGolfLabState();
    const csvTables = {};
    const csvSources = [];
    for (const file of files) {
      const text = await readGolfLabImportFile(file);
      if (isGolfLabJsonFile(file)) {
        const parsed = JSON.parse(text);
        const snapshot = typeof buildGolfLabImportSnapshot === "function"
          ? buildGolfLabImportSnapshot(parsed, { provider: "Local JSON", endpoint: file.name })
          : { golfLab: normalizeGolfLabState(parsed && parsed.golfLab && typeof parsed.golfLab === "object" ? parsed.golfLab : parsed) };
        mergedLab = mergeGolfLabStates(mergedLab, snapshot.golfLab);
      } else if (isGolfLabCsvFile(file)) {
        if (typeof parseGolfLabCsv !== "function" || typeof collectionKeyFromFileName !== "function") {
          throw new Error("CSV importer is not available.");
        }
        const collectionKey = collectionKeyFromFileName(file.name);
        if (!collectionKey) {
          throw new Error(`Could not infer a Golf Lab collection from ${file.name}.`);
        }
        const rows = parseGolfLabCsv(text);
        if (!csvTables[collectionKey]) csvTables[collectionKey] = [];
        csvTables[collectionKey].push(...rows);
        csvSources.push(`${file.name} (${rows.length})`);
      } else {
        throw new Error(`${file.name} is not a JSON or CSV import file.`);
      }
    }
    if (Object.keys(csvTables).length) {
      const csvSnapshot = typeof buildGolfLabImportSnapshot === "function"
        ? buildGolfLabImportSnapshot({
          source: {
            provider: "Local CSV",
            endpoint: csvSources.join(", "),
            fetchedAt: new Date().toISOString()
          },
          tables: csvTables
        })
        : { golfLab: normalizeGolfLabState(csvTables) };
      mergedLab = mergeGolfLabStates(mergedLab, csvSnapshot.golfLab);
    }
    if (!hasGolfLabData(mergedLab)) {
      throw new Error("Those files did not contain Golf Lab data.");
    }
    const preview = typeof buildGolfLabImportPreview === "function"
      ? buildGolfLabImportPreview(state.golfLab, { golfLab: mergedLab })
      : null;
    applyGolfLabDataMerge(mergedLab, "Golf Lab import complete.");
    if (typeof buildWarehouseReport === "function") {
      const report = buildWarehouseReport(mergedLab);
      setGolfLabModelStatus(golfLabImportPreviewStatus(preview, `Imported ${files.length} file${files.length === 1 ? "" : "s"} | ${report.totalRecords} records | score ${report.score}.`));
    }
  }

  function downloadGolfLabTemplate() {
    const template = typeof buildGolfLabTemplate === "function"
      ? buildGolfLabTemplate({ createdAt: new Date().toISOString() })
      : { golfLab: blankGolfLabState() };
    const blob = new Blob([JSON.stringify(template, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `golf-lab-import-template-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Golf Lab template downloaded.");
  }

  function golfLabFileSlug(value) {
    return String(value || "golf-lab")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "golf-lab";
  }

  function buildGolfLabExportBundle() {
    const lab = normalizeGolfLabState(state.golfLab);
    const summary = summarizeGolfLabState(lab);
    const warehouseReport = typeof buildWarehouseReport === "function" ? buildWarehouseReport(lab) : null;
    const sourcePlan = typeof buildEventSourcePlan === "function"
      ? buildEventSourcePlan(lab, { eventId: getSelectedGolfLabEventId() })
      : null;
    const sourceOpsBoard = typeof buildSourceOpsBoard === "function"
      ? buildSourceOpsBoard(lab, { eventId: getSelectedGolfLabEventId() })
      : null;
    const sourceLineageBoard = typeof buildSourceLineageBoard === "function"
      ? buildSourceLineageBoard(lab, { eventId: getSelectedGolfLabEventId() })
      : null;
    const sourceCatalogBoard = typeof buildSourceCatalogBoard === "function"
      ? buildSourceCatalogBoard(lab, { eventId: getSelectedGolfLabEventId() })
      : null;
    const dataIntakeBoard = typeof buildDataIntakeBoard === "function"
      ? buildDataIntakeBoard(lab, { eventId: getSelectedGolfLabEventId() })
      : null;
    const acquisitionRunbook = typeof buildAcquisitionRunbook === "function"
      ? buildAcquisitionRunbook(lab, { eventId: getSelectedGolfLabEventId() })
      : null;
    const tournamentActivationPlan = typeof buildTournamentActivationPlan === "function"
      ? buildTournamentActivationPlan(lab, { eventId: getSelectedGolfLabEventId() })
      : null;
    const dataIntakePacket = typeof buildDataIntakePacket === "function"
      ? buildDataIntakePacket(lab, { eventId: getSelectedGolfLabEventId(), createdAt: new Date().toISOString() })
      : null;
    const historicalBackfillBoard = typeof buildHistoricalBackfillBoard === "function"
      ? buildHistoricalBackfillBoard(lab, { limit: lab.events.length || 1 })
      : null;
    const coverageMap = typeof buildWarehouseCoverageMap === "function"
      ? buildWarehouseCoverageMap(lab, {
        eventLimit: lab.events.length || 1,
        playerLimit: lab.players.length || 1,
        courseLimit: lab.courses.length || 1
      })
      : null;
    const playerIdentityBoard = typeof buildPlayerIdentityBoard === "function"
      ? buildPlayerIdentityBoard(lab, { eventId: getSelectedGolfLabEventId() })
      : null;
    const playerSplitLabBoard = typeof buildPlayerSplitLab === "function"
      ? buildPlayerSplitLab(lab, {
        eventId: getSelectedGolfLabEventId(),
        limit: lab.players.length || 1,
        courseLimit: lab.courses.length || 1
      })
      : null;
    const edgeBoard = typeof buildPredictionEdgeBoard === "function"
      ? buildPredictionEdgeBoard(lab, {
        minEdge: getGolfLabEdgeThresholdProbability(),
        maxRows: 25,
        market: golfLabModelSettings.marketFilter
      })
      : null;
    const betPortfolioBoard = typeof buildBetPortfolioBoard === "function"
      ? buildBetPortfolioBoard(lab, {
        minEdge: getGolfLabEdgeThresholdProbability(),
        market: golfLabModelSettings.marketFilter,
        maxRows: 25,
        candidateRows: 50,
        maxTotalUnits: 8,
        maxPlayerUnits: 2.5,
        maxMarketUnits: 4,
        maxEventUnits: 6,
        minStakeUnits: 0.25
      })
      : null;
    const modelExplainerBoard = typeof buildPredictionExplainerBoard === "function"
      ? buildPredictionExplainerBoard(lab, {
        minEdge: getGolfLabEdgeThresholdProbability(),
        maxRows: 25,
        market: golfLabModelSettings.marketFilter,
        weights: getGolfLabModelWeights()
      })
      : null;
    const projectedStandingsBoard = typeof buildProjectedStandingsBoard === "function"
      ? buildProjectedStandingsBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        weights: getGolfLabModelWeights(),
        maxRows: 25
      })
      : null;
    const resultsSummaryBoard = typeof buildPredictionResultsSummaryBoard === "function"
      ? buildPredictionResultsSummaryBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        weights: getGolfLabModelWeights(),
        minEdge: getGolfLabEdgeThresholdProbability(),
        maxRows: 25
      })
      : null;
    const settlementBoard = typeof buildPredictionSettlementBoard === "function"
      ? buildPredictionSettlementBoard(lab, {
        minEdge: getGolfLabEdgeThresholdProbability(),
        market: golfLabModelSettings.marketFilter,
        maxRows: lab.predictionLedger.length + lab.modelPredictions.length || 1
      })
      : null;
    const predictionRunAuditBoard = typeof buildPredictionRunAuditBoard === "function"
      ? buildPredictionRunAuditBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        market: golfLabModelSettings.marketFilter,
        minEdge: getGolfLabEdgeThresholdProbability()
      })
      : null;
    const modelRunHistoryBoard = typeof buildModelRunHistoryBoard === "function"
      ? buildModelRunHistoryBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        market: golfLabModelSettings.marketFilter,
        maxRows: lab.predictionLedger.length + lab.modelPredictions.length || 1
      })
      : null;
    const featureStoreAuditBoard = typeof buildFeatureStoreAuditBoard === "function"
      ? buildFeatureStoreAuditBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        market: golfLabModelSettings.marketFilter,
        weatherScenario: golfLabModelSettings.weatherScenario
      })
      : null;
    const predictionPrepBoard = typeof buildPredictionPrepBoard === "function"
      ? buildPredictionPrepBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        market: golfLabModelSettings.marketFilter,
        minEdge: getGolfLabEdgeThresholdProbability(),
        weights: getGolfLabModelWeights(),
        modelProfile: getGolfLabModelPreset().label,
        weatherScenario: golfLabModelSettings.weatherScenario
      })
      : null;
    const marketCoverageBoard = typeof buildMarketCoverageBoard === "function"
      ? buildMarketCoverageBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        market: golfLabModelSettings.marketFilter
      })
      : null;
    const oddsMovementBoard = typeof buildOddsMovementBoard === "function"
      ? buildOddsMovementBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        market: golfLabModelSettings.marketFilter,
        maxRows: lab.oddsSnapshots.length || 1
      })
      : null;
    const oddsShoppingBoard = typeof buildOddsShoppingBoard === "function"
      ? buildOddsShoppingBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        market: golfLabModelSettings.marketFilter,
        maxRows: lab.oddsSnapshots.length || 1
      })
      : null;
    const fitBoard = typeof buildEventFitBoard === "function"
      ? buildEventFitBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        weights: getGolfLabModelWeights(),
        modelProfile: getGolfLabModelPreset().label,
        weatherScenario: golfLabModelSettings.weatherScenario
      })
      : null;
    const fieldReadiness = typeof buildFieldReadinessBoard === "function"
      ? buildFieldReadinessBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        market: golfLabModelSettings.marketFilter,
        limit: lab.players.length || 1
      })
      : null;
    const fieldIntelligence = typeof buildFieldIntelligenceBoard === "function"
      ? buildFieldIntelligenceBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        weights: getGolfLabModelWeights(),
        modelProfile: getGolfLabModelPreset().label,
        weatherScenario: golfLabModelSettings.weatherScenario,
        market: golfLabModelSettings.marketFilter,
        minEdge: getGolfLabEdgeThresholdProbability()
      })
      : null;
    const modelConsensusBoard = typeof buildModelConsensusBoard === "function"
      ? buildModelConsensusBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        profiles: getGolfLabConsensusProfiles(),
        weatherScenario: golfLabModelSettings.weatherScenario,
        market: golfLabModelSettings.marketFilter,
        maxRows: 25
      })
      : null;
    const featureSensitivityBoard = typeof buildFeatureSensitivityBoard === "function"
      ? buildFeatureSensitivityBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        weights: getGolfLabModelWeights(),
        modelProfile: getGolfLabModelPreset().label,
        weatherScenario: golfLabModelSettings.weatherScenario,
        market: golfLabModelSettings.marketFilter,
        maxRows: 25
      })
      : null;
    const scenarioBoard = typeof buildWeatherScenarioBoard === "function"
      ? buildWeatherScenarioBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        weights: getGolfLabModelWeights(),
        modelProfile: getGolfLabModelPreset().label,
        maxRows: 5
      })
      : null;
    const weatherMatrixBoard = typeof buildWeatherMatrixBoard === "function"
      ? buildWeatherMatrixBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        limit: lab.players.length || 1
      })
      : null;
    const teeTimeWaveBoard = typeof buildTeeTimeWaveBoard === "function"
      ? buildTeeTimeWaveBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        limit: lab.players.length || 1
      })
      : null;
    const courseDifficultyBoard = typeof buildCourseDifficultyBoard === "function"
      ? buildCourseDifficultyBoard(lab, { limit: lab.courses.length || 1 })
      : null;
    const courseSetupBoard = typeof buildCourseSetupBoard === "function"
      ? buildCourseSetupBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        courseLimit: lab.courses.length || 1,
        playerLimit: lab.players.length || 1
      })
      : null;
    const courseCompBoard = typeof buildCourseCompBoard === "function"
      ? buildCourseCompBoard(lab, {
        eventId: getSelectedGolfLabEventId(),
        courseId: getSelectedGolfLabEventId() ? "" : selectedGolfLabCourseId,
        courseLimit: lab.courses.length || 1,
        playerLimit: lab.players.length || 1
      })
      : null;
    const playerIndexBoard = typeof buildPlayerIndexBoard === "function"
      ? buildPlayerIndexBoard(lab, { limit: lab.players.length || 1, eventId: getSelectedGolfLabEventId() })
      : null;
    const selectedPlayerScorecard = typeof buildPlayerScorecard === "function" && lab.players.length
      ? buildPlayerScorecard(lab, selectedGolfLabPlayerId || lab.players[0].id, {
        eventId: getSelectedGolfLabEventId()
      })
      : null;
    const backtest = typeof buildPredictionBacktest === "function"
      ? buildPredictionBacktest(lab, { minEdge: 0 })
      : null;
    const trainingDataset = typeof buildModelTrainingDataset === "function"
      ? buildModelTrainingDataset(lab, {
        eventLimit: lab.events.length || 1,
        rowLimit: lab.rounds.length || 1,
        weights: getGolfLabModelWeights(),
        modelProfile: getGolfLabModelPreset().label,
        weatherScenario: golfLabModelSettings.weatherScenario
      })
      : null;
    const modelPerformance = typeof buildModelPerformanceBoard === "function"
      ? buildModelPerformanceBoard(lab, {
        minEdge: 0,
        recentRows: 25
      })
      : null;
    const modelCalibration = typeof buildModelCalibrationBoard === "function"
      ? buildModelCalibrationBoard(lab, {
        minEdge: 0,
        market: golfLabModelSettings.marketFilter,
        minSamples: 5
      })
      : null;
    const modelTuningBoard = typeof buildModelTuningBoard === "function"
      ? buildModelTuningBoard(lab, {
        minEdge: 0,
        market: golfLabModelSettings.marketFilter,
        minSamples: 5,
        weights: getGolfLabModelWeights()
      })
      : null;
    const commandCenter = buildGolfLabCommandCenter(lab, warehouseReport);
    return {
      meta: {
        template: "Golf Lab owned warehouse export",
        exportedAt: new Date().toISOString(),
        app: "Fairway Ledger",
        selectedEventId: getSelectedGolfLabEventId(),
        schemaVersion: lab.schemaVersion
      },
      modelSettings: {
        ...golfLabModelSettings,
        presetLabel: getGolfLabModelPreset().label,
        weatherLabel: getGolfLabWeatherScenarioLabel(),
        weights: getGolfLabModelWeights()
      },
      summary,
      warehouseReport,
      sourceFreshness: warehouseReport ? warehouseReport.sourceFreshness : null,
      warehouseValidation: warehouseReport ? warehouseReport.validation : null,
      commandCenter,
      coverageMap,
      sourceOpsBoard,
      sourceLineageBoard,
      sourceCatalogBoard,
      dataIntakeBoard,
      acquisitionRunbook,
      tournamentActivationPlan,
      dataIntakePacket,
      historicalBackfillBoard,
      sourcePlan,
      playerIdentityBoard,
      playerSplitLabBoard,
      playerIndexBoard,
      selectedPlayerScorecard,
      fitBoard,
      fieldReadiness,
      fieldIntelligence,
      modelConsensusBoard,
      featureSensitivityBoard,
      courseDifficultyBoard,
      courseSetupBoard,
      courseCompBoard,
      scenarioBoard,
      weatherMatrixBoard,
      teeTimeWaveBoard,
      featureStoreAuditBoard,
      predictionPrepBoard,
      predictionRunAuditBoard,
      modelRunHistoryBoard,
      marketCoverageBoard,
      oddsMovementBoard,
      oddsShoppingBoard,
      edgeBoard,
      betPortfolioBoard,
      projectedStandingsBoard,
      resultsSummaryBoard,
      modelExplainerBoard,
      settlementBoard,
      modelCalibration,
      modelTuningBoard,
      modelPerformance,
      trainingDataset,
      backtest: backtest ? { summary: backtest.summary, graded: backtest.graded } : null,
      golfLab: lab
    };
  }

  function downloadJsonBundle(payload, filename, toastMessage) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(toastMessage);
  }

  function downloadGolfLabExport() {
    const lab = normalizeGolfLabState(state.golfLab);
    if (!hasGolfLabData(lab)) {
      showToast("No Golf Lab data to export yet.");
      return;
    }
    const bundle = buildGolfLabExportBundle();
    const eventSlug = bundle.sourcePlan && bundle.sourcePlan.event
      ? golfLabFileSlug(bundle.sourcePlan.event.name || bundle.sourcePlan.event.id)
      : "warehouse";
    downloadJsonBundle(
      bundle,
      `golf-lab-${eventSlug}-export-${new Date().toISOString().slice(0, 10)}.json`,
      "Golf Lab export downloaded."
    );
  }

  function downloadGolfLabResearchPacket() {
    if (typeof buildEventResearchPacket !== "function") {
      showToast("Golf Lab research packet is not available.");
      return;
    }
    const packet = buildEventResearchPacket(state.golfLab, {
      eventId: getSelectedGolfLabEventId(),
      createdAt: new Date().toISOString()
    });
    const eventSlug = packet.meta && packet.meta.eventName
      ? golfLabFileSlug(packet.meta.eventName)
      : "next-event";
    downloadJsonBundle(
      packet,
      `golf-lab-research-packet-${eventSlug}-${new Date().toISOString().slice(0, 10)}.json`,
      "Golf Lab research packet downloaded."
    );
  }

  function downloadGolfLabActivationPacket() {
    if (typeof buildTournamentActivationPlan !== "function") {
      showToast("Golf Lab activation packet is not available.");
      return;
    }
    const packet = buildTournamentActivationPlan(state.golfLab, {
      eventId: getSelectedGolfLabEventId(),
      createdAt: new Date().toISOString()
    });
    if (!packet || !packet.event) {
      showToast("Import or select a tournament before creating an activation packet.");
      return;
    }
    const eventSlug = golfLabFileSlug(packet.event.name || packet.event.id || "activation");
    downloadJsonBundle(
      packet,
      `golf-lab-activation-${eventSlug}-${new Date().toISOString().slice(0, 10)}.json`,
      "Golf Lab activation packet downloaded."
    );
  }

  function downloadGolfLabDataIntakePacket() {
    if (typeof buildDataIntakePacket !== "function") {
      showToast("Golf Lab data intake packet is not available.");
      return;
    }
    const packet = buildDataIntakePacket(state.golfLab, {
      eventId: getSelectedGolfLabEventId(),
      createdAt: new Date().toISOString()
    });
    const eventSlug = packet.meta && packet.meta.eventName
      ? golfLabFileSlug(packet.meta.eventName)
      : "intake";
    downloadJsonBundle(
      packet,
      `golf-lab-data-intake-${eventSlug}-${new Date().toISOString().slice(0, 10)}.json`,
      "Golf Lab data intake packet downloaded."
    );
  }

  function downloadGolfLabBackfillPacket() {
    if (typeof buildHistoricalBackfillBoard !== "function" || typeof buildEventResearchPacket !== "function") {
      showToast("Golf Lab backfill packet is not available.");
      return;
    }
    const board = buildHistoricalBackfillBoard(state.golfLab, { limit: 1 });
    const target = board.nextActions[0] || board.rows[0];
    if (!target) {
      showToast("Import an event schedule before creating a backfill packet.");
      return;
    }
    const packet = buildEventResearchPacket(state.golfLab, {
      eventId: target.eventId,
      createdAt: new Date().toISOString()
    });
    packet.backfillTarget = {
      eventId: target.eventId,
      eventName: target.eventName,
      priorityScore: target.priorityScore,
      nextAction: target.nextAction,
      batchInputDir: target.batchInputDir,
      outputDir: target.outputDir,
      batchCommand: target.batchCommand,
      missingAdapterTypes: target.missingAdapterTypes,
      targetFiles: target.targetFiles,
      missingLanes: target.missingLanes
    };
    const eventSlug = golfLabFileSlug(target.eventName || target.eventId || "backfill");
    downloadJsonBundle(
      packet,
      `golf-lab-backfill-packet-${eventSlug}-${new Date().toISOString().slice(0, 10)}.json`,
      "Golf Lab backfill packet downloaded."
    );
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => els.toast.classList.remove("show"), 2200);
  }

  // ---- Destructive-action typed-confirmation modal -----------------------
  //
  // Replaces window.confirm for anything that can wipe rounds. Shows what
  // will be lost (round count, course count, last-backup status), points out
  // that the app will snapshot first, and (when `expected` is set) gates the
  // destructive button behind typing that exact string. The string is the
  // current round count when there are rounds — easy enough to fulfill on
  // purpose, hard to fulfill by accident.

  function openDestructiveConfirm(config) {
    const {
      title = "Confirm",
      message = "",
      facts = [],
      expected = null,
      confirmLabel = "Delete",
      showBackupHint = true,
      onConfirm
    } = config || {};
    const overlay = els.destructiveConfirmOverlay;
    if (!overlay || typeof onConfirm !== "function") return;

    els.destructiveConfirmTitle.textContent = title;
    els.destructiveConfirmMessage.textContent = message;
    els.destructiveConfirmFacts.innerHTML = "";
    facts.filter(Boolean).forEach((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      els.destructiveConfirmFacts.appendChild(li);
    });

    if (showBackupHint) {
      const lastBackup = describeLastBackup();
      const unbacked = unbackedRoundCount();
      const unbackedLine = unbacked > 0
        ? ` You have ${unbacked} round${unbacked === 1 ? "" : "s"} not yet in an exported file.`
        : "";
      els.destructiveConfirmBackupHint.textContent =
        `${lastBackup}.${unbackedLine} The app will save a snapshot first (restore from Profile › Backups), but Export gives you a copy outside the browser too.`;
      els.destructiveConfirmBackupHint.hidden = false;
    } else {
      els.destructiveConfirmBackupHint.hidden = true;
    }

    const expectedStr = expected == null ? null : String(expected);
    if (expectedStr != null && expectedStr.length > 0) {
      els.destructiveConfirmTypeLabel.hidden = false;
      els.destructiveConfirmExpected.textContent = expectedStr;
      els.destructiveConfirmInput.value = "";
      els.destructiveConfirmGo.disabled = true;
      els.destructiveConfirmInput.oninput = () => {
        els.destructiveConfirmGo.disabled =
          els.destructiveConfirmInput.value.trim() !== expectedStr;
      };
    } else {
      els.destructiveConfirmTypeLabel.hidden = true;
      els.destructiveConfirmInput.oninput = null;
      els.destructiveConfirmGo.disabled = false;
    }
    els.destructiveConfirmGo.textContent = confirmLabel;

    function close() {
      overlay.hidden = true;
      els.destructiveConfirmInput.oninput = null;
      els.destructiveConfirmGo.onclick = null;
      els.destructiveConfirmCancel.onclick = null;
      els.destructiveConfirmClose.onclick = null;
      els.destructiveConfirmBackdrop.onclick = null;
      document.removeEventListener("keydown", onKey);
    }
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    els.destructiveConfirmGo.onclick = () => {
      if (els.destructiveConfirmGo.disabled) return;
      close();
      try { onConfirm(); }
      catch (err) { console.error("destructive confirm onConfirm threw", err); }
    };
    els.destructiveConfirmCancel.onclick = close;
    els.destructiveConfirmClose.onclick = close;
    els.destructiveConfirmBackdrop.onclick = close;
    document.addEventListener("keydown", onKey);

    overlay.hidden = false;
    window.setTimeout(() => {
      const focusTarget = expectedStr != null && expectedStr.length > 0
        ? els.destructiveConfirmInput
        : els.destructiveConfirmGo;
      try { focusTarget.focus(); } catch {}
    }, 50);
  }

  // ---- Snapshot panel (Profile tab) --------------------------------------

  function describeSnapshotTime(takenAt) {
    if (!takenAt) return "Unknown time";
    const when = new Date(takenAt);
    if (Number.isNaN(when.getTime())) return takenAt;
    const now = Date.now();
    const diffMs = now - when.getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.round(hours / 24);
    if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
    return when.toLocaleString();
  }

  function renderSnapshotPanel() {
    if (!els.snapshotList) return;
    const snaps = listSnapshots();
    if (els.snapshotCap) els.snapshotCap.textContent = String(SNAPSHOT_MAX);
    if (els.snapshotBackupStatus) {
      const meta = readBackupMeta();
      const unbacked = unbackedRoundCount();
      const exportPiece = meta.lastExportAt
        ? `Last file export: ${describeLastBackup().replace(/^Last backup:\s*/, "")}.`
        : "No file exports yet — tap Export in the header for an off-device copy.";
      const snapPiece = snaps.length === 0
        ? "No snapshots yet."
        : `${snaps.length} snapshot${snaps.length === 1 ? "" : "s"} stored in this browser.`;
      const unbackedPiece = unbacked > 0
        ? ` ${unbacked} round${unbacked === 1 ? "" : "s"} not in the most recent file export.`
        : "";
      els.snapshotBackupStatus.textContent = `${snapPiece} ${exportPiece}${unbackedPiece}`;
    }
    els.snapshotList.innerHTML = "";
    if (!snaps.length) {
      const empty = document.createElement("li");
      empty.className = "snapshot-empty";
      empty.textContent = "No snapshots yet. One will appear as soon as data changes.";
      els.snapshotList.appendChild(empty);
      return;
    }
    snaps.forEach((snap) => {
      const li = document.createElement("li");
      li.className = "snapshot-row";

      const main = document.createElement("div");
      main.className = "snapshot-row-main";
      const headline = document.createElement("div");
      headline.className = "snapshot-row-headline";
      const tag = document.createElement("span");
      const reasonClass = `snapshot-reason-${snap.reason}`.replace(/[^a-z0-9-]/gi, "-");
      tag.className = `snapshot-reason-tag ${reasonClass}`;
      tag.textContent = SNAPSHOT_REASON_LABELS[snap.reason] || snap.reason;
      headline.appendChild(tag);
      const when = document.createElement("span");
      when.textContent = describeSnapshotTime(snap.takenAt);
      headline.appendChild(when);
      main.appendChild(headline);

      const meta = document.createElement("div");
      meta.className = "snapshot-row-meta";
      const sizeKb = Math.max(1, Math.round(snap.bytes / 1024));
      meta.textContent = `${snap.roundCount} round${snap.roundCount === 1 ? "" : "s"} · ${snap.courseCount} course${snap.courseCount === 1 ? "" : "s"} · ${sizeKb} KB`;
      main.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "snapshot-row-actions";
      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "primary-button";
      restoreBtn.textContent = "Restore";
      restoreBtn.addEventListener("click", () => handleRestoreSnapshot(snap));
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "ghost-button";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => handleDeleteSnapshot(snap));
      actions.appendChild(restoreBtn);
      actions.appendChild(deleteBtn);

      li.appendChild(main);
      li.appendChild(actions);
      els.snapshotList.appendChild(li);
    });
  }

  // ---- Round detail sheet -----------------------------------------------
  //
  // Opens when the user taps a Trophy Room card. Shows the full scorecard
  // for the round that set the record — read-only, like the Scorecard
  // accordion in Recent Scorecards. Includes a secondary "Edit this round"
  // action so the editing path is one tap away when actually wanted.

  function showRoundDetail(round) {
    if (!els.roundDetailOverlay || !round) return;
    const course = getCourse(round.courseId);
    const totals = roundTotals(round);
    const courseName = course
      ? course.name + (course.tee ? ` (${course.tee})` : "")
      : "Unknown course";
    const dateStr = (() => {
      try {
        const d = new Date(round.date);
        if (Number.isNaN(d.getTime())) return round.date;
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      } catch { return round.date; }
    })();
    els.roundDetailTitle.textContent = `${totals.gross} (${formatSigned(totals.toPar, 0)})`;
    // Course name in the subtitle is a drill-down — tap it to jump to the
    // course's profile in the Courses tab (global data-open-course-name
    // handler closes this sheet first).
    const physName = physicalCourseName(round.courseId);
    const courseBit = `<button type="button" class="link-course" data-open-course-name="${escapeHtml(physName)}">${escapeHtml(courseName)}</button>`;
    const bits = [escapeHtml(dateStr), courseBit];
    if (round.wind) bits.push(escapeHtml(formatWind(round.wind)));
    if (round.tag) bits.push(escapeHtml(formatRoundTag(round.tag)));
    els.roundDetailSubtitle.innerHTML = bits.filter(Boolean).join(" · ");
    els.roundDetailBody.innerHTML = renderRoundScorecard(round);
    els.roundDetailEditButton.onclick = () => {
      closeRoundDetail();
      loadRoundIntoForm(round);
      setActiveTab("rounds");
      showToast("Editing round. Make changes and click Update round.");
    };
    function onKey(e) { if (e.key === "Escape") closeRoundDetail(); }
    els.roundDetailOverlay._escHandler = onKey;
    document.addEventListener("keydown", onKey);
    els.roundDetailOverlay.hidden = false;
    document.body.classList.add("hole-picker-open");
  }

  function closeRoundDetail() {
    if (!els.roundDetailOverlay) return;
    els.roundDetailOverlay.hidden = true;
    document.body.classList.remove("hole-picker-open");
    if (els.roundDetailEditButton) els.roundDetailEditButton.onclick = null;
    const onKey = els.roundDetailOverlay._escHandler;
    if (onKey) {
      document.removeEventListener("keydown", onKey);
      els.roundDetailOverlay._escHandler = null;
    }
  }

  function handleRestoreSnapshot(snap) {
    const currentRounds = Array.isArray(state.rounds) ? state.rounds.length : 0;
    openDestructiveConfirm({
      title: "Restore this snapshot?",
      message: `Replace the current data with the snapshot from ${describeSnapshotTime(snap.takenAt)}.`,
      facts: [
        `Current: ${currentRounds} round${currentRounds === 1 ? "" : "s"}.`,
        `Snapshot: ${snap.roundCount} round${snap.roundCount === 1 ? "" : "s"}, ${snap.courseCount} course${snap.courseCount === 1 ? "" : "s"}.`,
        "The current state will be saved as a 'Before Restore' snapshot first."
      ],
      expected: currentRounds > 0 ? String(currentRounds) : null,
      confirmLabel: "Restore",
      showBackupHint: false,
      onConfirm: () => {
        const ok = restoreSnapshot(snap.key);
        if (!ok) {
          showToast("Could not restore that snapshot.");
          return;
        }
        renderAll();
        renderSnapshotPanel();
        showToast(`Restored ${snap.roundCount} round${snap.roundCount === 1 ? "" : "s"}.`);
      }
    });
  }

  function handleDeleteSnapshot(snap) {
    openDestructiveConfirm({
      title: "Delete this snapshot?",
      message: `Remove the snapshot from ${describeSnapshotTime(snap.takenAt)}. This doesn't change your current rounds.`,
      facts: [`Snapshot has ${snap.roundCount} round${snap.roundCount === 1 ? "" : "s"}.`],
      expected: null,
      confirmLabel: "Delete snapshot",
      showBackupHint: false,
      onConfirm: () => {
        deleteSnapshot(snap.key);
        renderSnapshotPanel();
        showToast("Snapshot deleted.");
      }
    });
  }

  // ---- Games tab ----------------------------------------------------------
  //
  // Group-game scorekeeper (Match Play, Nassau, Skins, Wolf, etc). All
  // scoring math lives in lib/games.js (window.GolfGames) so it's
  // unit-tested; this section is purely the UI state machine + persistence.
  //
  // Games are stored under their own localStorage key, completely isolated
  // from state.rounds — nothing in here can touch round data.

  const GAMES_KEY = "fairwayLedger.games.v1";
  const GAME_PLAYER_NAMES_KEY = "fairwayLedger.gamePlayerNames.v1";
  const Games = window.GolfGames;

  let gamesState = (() => {
    try {
      const raw = localStorage.getItem(GAMES_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && Array.isArray(parsed.games) ? parsed : { games: [] };
    } catch { return { games: [] }; }
  })();

  // UI-only state (not persisted): which view is showing, what's mid-pick.
  const gamesUi = {
    view: "home",            // home | pick | rules | setup | play | summary
    playerCount: 4,
    entrantCount: 2,         // team count for entrant-based games (Scramble)
    pickedGameId: null,
    activeGameId: null,
    entryView: "hole",       // hole | grid
    holeIndex: 0,
    confirmingDeleteId: null
  };

  function saveGamesState() {
    try { localStorage.setItem(GAMES_KEY, JSON.stringify(gamesState)); } catch {}
  }

  function getActiveGame() {
    return gamesState.games.find((g) => g.id === gamesUi.activeGameId) || null;
  }

  function rememberPlayerNames(names) {
    try { localStorage.setItem(GAME_PLAYER_NAMES_KEY, JSON.stringify(names)); } catch {}
  }
  function recallPlayerNames() {
    try {
      const raw = localStorage.getItem(GAME_PLAYER_NAMES_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  function computeGame(game) {
    const ids = game.players.map((p) => p.id);
    switch (game.gameType) {
      case "matchplay": return Games.computeMatchPlay(game.holes, ids[0], ids[1], game.holeCount);
      case "nassau": return Games.computeNassau(game.holes, ids[0], ids[1]);
      case "skins": return Games.computeSkins(game.holes, ids, game.options);
      case "bestball": return Games.computeBestBall(game.holes, game.teams, game.holeCount);
      case "wolf": return Games.computeWolf(game.holes, ids);
      case "vegas": return Games.computeVegas(game.holes, game.teams, game.options);
      case "nines": return Games.computeNines(game.holes, ids);
      case "stableford": return Games.computeStableford(game.holes, ids);
      case "bingo": return Games.computeBingo(game.holes, ids);
      case "scramble": return Games.computeScramble(game.holes, ids);
      default: return null;
    }
  }

  function gamePlayerName(game, pid) {
    const p = game.players.find((x) => x.id === pid);
    return p ? p.name : pid;
  }

  function teamLabel(game, teamIndex) {
    if (!game.teams) return teamIndex === 0 ? "Team 1" : "Team 2";
    return game.teams[teamIndex].map((pid) => gamePlayerName(game, pid)).join(" & ");
  }

  // One-line standings summary used on the play view AND the home cards.
  function gameStandingsLines(game) {
    const computed = computeGame(game);
    if (!computed) return [];
    const ids = game.players.map((p) => p.id);
    switch (game.gameType) {
      case "matchplay": {
        if (computed.thru === 0) return ["No holes played yet."];
        if (computed.leader === null) return [`All square thru ${computed.thru}`];
        const name = gamePlayerName(game, ids[computed.leader]);
        return [`${name} ${computed.status}${computed.done ? "" : ` thru ${computed.thru}`}`];
      }
      case "nassau": {
        const betLine = (label, m) => {
          if (m.thru === 0) return `${label}: —`;
          if (m.leader === null) return `${label}: AS${m.done ? " (push)" : ""}`;
          return `${label}: ${gamePlayerName(game, ids[m.leader])} ${m.status}`;
        };
        return [
          betLine("Front", computed.front),
          betLine("Back", computed.back),
          betLine("Overall", computed.overall)
        ];
      }
      case "skins": {
        const parts = ids.map((pid) => `${gamePlayerName(game, pid)} ${computed.skinsByPlayer[pid]}`);
        if (computed.carrying > 0) parts.push(`${computed.carrying} carrying`);
        return [parts.join(" · ")];
      }
      case "bestball": {
        if (computed.thru === 0) return ["No holes played yet."];
        if (computed.leader === null) return [`All square thru ${computed.thru}`];
        return [`${teamLabel(game, computed.leader)} ${computed.status}${computed.done ? "" : ` thru ${computed.thru}`}`];
      }
      case "vegas": {
        if (!computed.holeOutcomes.length) return ["No holes played yet."];
        if (computed.points === 0) return ["Teams all square"];
        const lead = computed.points > 0 ? 0 : 1;
        return [`${teamLabel(game, lead)} +${Math.abs(computed.points)} points`];
      }
      case "wolf":
      case "nines":
      case "stableford":
      case "bingo": {
        const sorted = [...ids].sort((a, b) => computed.pointsByPlayer[b] - computed.pointsByPlayer[a]);
        return [sorted.map((pid) => `${gamePlayerName(game, pid)} ${formatGamePoints(computed.pointsByPlayer[pid])}`).join(" · ")];
      }
      case "scramble": {
        if (!computed.holesPlayed) return ["No holes played yet."];
        const line = (pid) => `${gamePlayerName(game, pid)} ${computed.totals[pid]} (${formatSigned(computed.toPar[pid], 0)})`;
        const sorted = [...ids].sort((a, b) => computed.totals[a] - computed.totals[b]);
        return [`${sorted.map(line).join(" · ")} thru ${computed.holesPlayed}`];
      }
      default: return [];
    }
  }

  function formatGamePoints(v) {
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }

  // ---- Games: rendering -----------------------------------------------------

  function renderGames() {
    if (!els.gamesRoot) return;
    let html = "";
    switch (gamesUi.view) {
      case "pick": html = renderGamePickView(); break;
      case "rules": html = renderGameRulesView(); break;
      case "setup": html = renderGameSetupView(); break;
      case "play": html = renderGamePlayView(); break;
      case "summary": html = renderGameSummaryView(); break;
      default: html = renderGamesHomeView();
    }
    els.gamesRoot.innerHTML = html;
  }

  function renderGamesHomeView() {
    const active = gamesState.games.filter((g) => g.status === "active");
    const finished = gamesState.games.filter((g) => g.status === "final")
      .sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 10);
    const card = (game) => {
      const meta = Games.GAME_BY_ID[game.gameType];
      const lines = gameStandingsLines(game);
      const confirming = gamesUi.confirmingDeleteId === game.id;
      return `
        <div class="game-card">
          <button type="button" class="game-card-main" data-game-open="${game.id}">
            <strong>${escapeHtml(meta ? meta.name : game.gameType)}</strong>
            <span class="game-card-sub">${escapeHtml(game.date || "")} · ${game.players.map((p) => escapeHtml(p.name)).join(", ")}</span>
            <span class="game-card-standings">${lines.map((l) => escapeHtml(l)).join("<br>")}</span>
          </button>
          <button type="button" class="game-card-delete${confirming ? " confirming" : ""}" data-game-delete="${game.id}">
            ${confirming ? "Tap again to delete" : "✕"}
          </button>
        </div>`;
    };
    return `
      <div class="games-home">
        <div class="games-hero">
          <h2>Golf Games</h2>
          <p>Pick a game, enter scores at the tee box, let the app do the math.</p>
          <button type="button" class="primary-button" data-game-action="new">New game →</button>
        </div>
        ${active.length ? `<h3 class="games-section-title">In progress</h3>${active.map(card).join("")}` : ""}
        ${finished.length ? `<h3 class="games-section-title">Finished</h3>${finished.map(card).join("")}` : ""}
        ${!active.length && !finished.length ? `<p class="games-empty">No games yet. Start one before your next round — the standings update live as you enter scores.</p>` : ""}
      </div>`;
  }

  function renderGamePickView() {
    const count = gamesUi.playerCount;
    const games = Games.gamesForPlayerCount(count);
    return `
      <div class="games-pick">
        <button type="button" class="games-back" data-game-action="home">← Games</button>
        <h2>How many players?</h2>
        <div class="games-count-row">
          ${[2, 3, 4].map((n) => `
            <button type="button" class="games-count-chip${n === count ? " active" : ""}" data-game-count="${n}">${n}</button>`).join("")}
        </div>
        <h3 class="games-section-title">${count}-player games</h3>
        <div class="games-list">
          ${games.map((g) => `
            <button type="button" class="game-pick-card${g.bestWith.includes(count) ? " recommended" : ""}" data-game-pick="${g.id}">
              <span class="game-pick-head">
                <strong>${escapeHtml(g.name)}</strong>
                ${g.bestWith.includes(count) ? `<span class="game-pick-badge">great with ${count}</span>` : ""}
              </span>
              <span class="game-pick-blurb">${escapeHtml(g.blurb)}</span>
              <span class="game-pick-tags">${g.tags.map((t) => `<span class="game-tag">${escapeHtml(t)}</span>`).join("")}</span>
            </button>`).join("")}
        </div>
      </div>`;
  }

  function renderGameRulesView() {
    const meta = Games.GAME_BY_ID[gamesUi.pickedGameId];
    if (!meta) return renderGamePickView();
    return `
      <div class="games-rules">
        <button type="button" class="games-back" data-game-action="pick">← Back</button>
        <h2>${escapeHtml(meta.name)}</h2>
        <p class="game-pick-blurb">${escapeHtml(meta.blurb)}</p>
        <h3 class="games-section-title">How to play</h3>
        <ul class="game-rules-list">
          ${meta.rules.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}
        </ul>
        <button type="button" class="primary-button" data-game-action="setup">Set up game →</button>
      </div>`;
  }

  function renderGameSetupView() {
    const meta = Games.GAME_BY_ID[gamesUi.pickedGameId];
    if (!meta) return renderGamePickView();
    // Entrant-based games (Scramble): the rows are TEAMS, not players —
    // one ball per team means one name + one score row per team.
    const isEntrant = Boolean(meta.entrantLabel);
    const count = isEntrant
      ? (meta.entrantCounts.includes(gamesUi.entrantCount) ? gamesUi.entrantCount : meta.entrantCounts[meta.entrantCounts.length - 1])
      : (meta.players.includes(gamesUi.playerCount)
        ? gamesUi.playerCount
        : meta.players[meta.players.length - 1]);
    const remembered = isEntrant ? [] : recallPlayerNames();
    const label = (i) => isEntrant
      ? `${meta.entrantLabel} ${i + 1}`
      : `Player ${i + 1}${i === 0 ? " (you)" : ""}`;
    const placeholder = (i) => isEntrant
      ? (i === 0 ? "e.g. Jeff & Rob" : "e.g. Dad & Mike")
      : "Name";
    const entrantChips = isEntrant ? `
      <h3 class="games-section-title">How many teams?</h3>
      <div class="games-count-row">
        ${meta.entrantCounts.map((n) => `
          <button type="button" class="games-count-chip${n === count ? " active" : ""}" data-game-entrants="${n}">${n} team${n === 1 ? "" : "s"}</button>`).join("")}
      </div>` : "";
    const nameInputs = Array.from({ length: count }, (_, i) => `
      <label class="game-setup-field">
        ${escapeHtml(label(i))}
        <input type="text" class="game-player-name" data-player-index="${i}" maxlength="24"
          value="${escapeHtml(remembered[i] || (!isEntrant && i === 0 ? "Me" : ""))}" placeholder="${escapeHtml(placeholder(i))}">
      </label>`).join("");
    const holeChips = meta.holeCounts.map((n) => `
      <button type="button" class="games-count-chip${n === 18 ? " active" : ""}" data-game-holecount="${n}">${n} holes</button>`).join("");
    const optionToggles = (meta.options || []).map((opt) => `
      <label class="game-setup-toggle">
        <input type="checkbox" class="game-option-toggle" data-option-id="${opt.id}" ${opt.default ? "checked" : ""}>
        <span>${escapeHtml(opt.label)}</span>
      </label>`).join("");
    const teamsBlock = meta.teams ? `
      <h3 class="games-section-title">Teams</h3>
      <p class="games-hint">Player 1 &amp; Player 2 are Team 1; Player 3 &amp; Player 4 are Team 2. Order the names to set the teams.</p>` : "";
    return `
      <div class="games-setup">
        <button type="button" class="games-back" data-game-action="rules">← Rules</button>
        <h2>${escapeHtml(meta.name)} — setup</h2>
        ${entrantChips}
        <h3 class="games-section-title">${isEntrant ? "Team names" : "Players"}</h3>
        <div class="game-setup-names">${nameInputs}</div>
        ${teamsBlock}
        <h3 class="games-section-title">Holes</h3>
        <div class="games-count-row">${holeChips}</div>
        ${optionToggles ? `<h3 class="games-section-title">Options</h3>${optionToggles}` : ""}
        <label class="game-setup-field game-stake-field">
          ${escapeHtml(meta.stakeLabel || "$ per point")} <span class="games-hint-inline">(optional — leave blank for bragging rights)</span>
          <input type="number" inputmode="decimal" min="0" step="0.25" class="game-stake-input" placeholder="0">
        </label>
        <button type="button" class="primary-button" data-game-action="start">Start game →</button>
      </div>`;
  }

  function gameHoleEntryComplete(game, hole) {
    const meta = Games.GAME_BY_ID[game.gameType];
    if (game.gameType === "bingo") {
      const b = hole.bingo || {};
      return Boolean(b.bingo || b.bango || b.bongo);
    }
    if (meta && meta.needsScores) {
      return game.players.every((p) => Number.isFinite(hole.scores[p.id]) && hole.scores[p.id] > 0);
    }
    return false;
  }

  function renderGamePlayView() {
    const game = getActiveGame();
    if (!game) return renderGamesHomeView();
    const meta = Games.GAME_BY_ID[game.gameType];
    const lines = gameStandingsLines(game);
    const standings = `
      <div class="game-standings">
        ${lines.map((l) => `<div class="game-standings-line">${escapeHtml(l)}</div>`).join("")}
      </div>`;
    const entry = gamesUi.entryView === "grid"
      ? renderGameGrid(game)
      : renderGameHoleEntry(game, meta);
    const doneCount = game.holes.filter((h) => gameHoleEntryComplete(game, h)).length;
    return `
      <div class="games-play">
        <div class="games-play-top">
          <button type="button" class="games-back" data-game-action="home">← Games</button>
          <span class="games-play-title">${escapeHtml(meta ? meta.name : "")}</span>
          <button type="button" class="games-view-toggle" data-game-action="toggle-view">${gamesUi.entryView === "grid" ? "Hole view" : "Grid view"}</button>
        </div>
        ${standings}
        ${entry}
        <div class="games-finish-row">
          <span class="games-hint">${doneCount}/${game.holes.length} holes entered</span>
          <button type="button" class="primary-button" data-game-action="finish">Finish game</button>
        </div>
      </div>`;
  }

  function renderGameHoleEntry(game, meta) {
    const idx = Math.max(0, Math.min(gamesUi.holeIndex, game.holes.length - 1));
    const hole = game.holes[idx];
    const parRow = meta && meta.needsPar ? `
      <div class="game-par-row">
        <span>Par</span>
        ${[3, 4, 5].map((p) => `
          <button type="button" class="games-count-chip small${hole.par === p ? " active" : ""}" data-game-par="${p}">${p}</button>`).join("")}
      </div>` : "";

    let specialControls = "";
    if (game.gameType === "wolf") {
      const ids = game.players.map((p) => p.id);
      const wolfId = Games.wolfForHole(ids, idx);
      const pick = hole.wolf || {};
      const partners = ids.filter((p) => p !== wolfId);
      specialControls = `
        <div class="game-wolf-row">
          <span class="game-wolf-label">🐺 Wolf: <strong>${escapeHtml(gamePlayerName(game, wolfId))}</strong></span>
          <div class="game-wolf-choices">
            ${partners.map((pid) => `
              <button type="button" class="games-count-chip small${pick.partnerId === pid ? " active" : ""}" data-game-wolf-partner="${pid}">+ ${escapeHtml(gamePlayerName(game, pid))}</button>`).join("")}
            <button type="button" class="games-count-chip small lone${pick.lone ? " active" : ""}" data-game-wolf-lone="1">Lone Wolf</button>
          </div>
        </div>`;
    }
    if (game.gameType === "bingo") {
      const b = hole.bingo || { bingo: null, bango: null, bongo: null };
      const row = (slot, label, hint) => `
        <div class="game-bingo-row">
          <span class="game-bingo-label"><strong>${label}</strong> <span class="games-hint-inline">${hint}</span></span>
          <div class="game-wolf-choices">
            ${game.players.map((p) => `
              <button type="button" class="games-count-chip small${b[slot] === p.id ? " active" : ""}" data-game-bingo="${slot}:${p.id}">${escapeHtml(p.name)}</button>`).join("")}
          </div>
        </div>`;
      specialControls = `
        ${row("bingo", "Bingo", "first on the green")}
        ${row("bango", "Bango", "closest once all on")}
        ${row("bongo", "Bongo", "first to hole out")}`;
    }

    const scoreRows = meta && meta.needsScores ? game.players.map((p) => {
      const val = hole.scores[p.id];
      const pull = renderGamePullChip(game, hole, p, 0);
      return `
        <div class="game-score-row">
          <span class="game-score-name">${escapeHtml(p.name)}</span>
          ${pull}
          <div class="game-stepper">
            <button type="button" class="game-step" data-game-score="${p.id}" data-delta="-1">−</button>
            <span class="game-score-value${Number.isFinite(val) ? "" : " empty"}">${Number.isFinite(val) ? val : "–"}</span>
            <button type="button" class="game-step" data-game-score="${p.id}" data-delta="1">+</button>
          </div>
        </div>`;
    }).join("") : "";

    return `
      <div class="game-hole-entry">
        <div class="game-hole-nav">
          <button type="button" class="card-step" data-game-nav="-1" ${idx === 0 ? "disabled" : ""}>‹</button>
          <strong>Hole ${hole.number}</strong>
          <button type="button" class="card-step" data-game-nav="1" ${idx >= game.holes.length - 1 ? "disabled" : ""}>›</button>
        </div>
        ${parRow}
        ${specialControls}
        ${scoreRows}
      </div>`;
  }

  // "Pull from my scorecard" chip: if the user (player 1) has an in-progress
  // round draft with a score for this hole number, offer a one-tap fill so
  // game + personal round don't need double entry.
  function renderGamePullChip(game, hole, player, playerIndex) {
    if (playerIndex !== 0) return "";
    if (game.players[0].id !== player.id) return "";
    if (Number.isFinite(hole.scores[player.id])) return "";
    const draft = loadInProgressRound();
    if (!draft) return "";
    const draftHole = (draft.holes || []).find((h) => Number(h.number) === hole.number);
    const score = draftHole ? Number(draftHole.score) : null;
    if (!Number.isFinite(score) || score <= 0) return "";
    return `<button type="button" class="game-pull-chip" data-game-pull="${score}" title="Pull from your in-progress round">⤓ ${score}</button>`;
  }

  function renderGameGrid(game) {
    const meta = Games.GAME_BY_ID[game.gameType];
    if (game.gameType === "bingo") {
      // Bingo grid: per hole, show which letters are assigned.
      return `
        <div class="game-grid-wrap">
          <table class="game-grid">
            <thead><tr><th>Hole</th>${game.players.map((p) => `<th>${escapeHtml(p.name.slice(0, 6))}</th>`).join("")}</tr></thead>
            <tbody>
              ${game.holes.map((h, i) => {
                const b = h.bingo || {};
                return `<tr data-game-grid-hole="${i}">
                  <td>${h.number}</td>
                  ${game.players.map((p) => {
                    const marks = ["bingo", "bango", "bongo"].filter((s) => b[s] === p.id).length;
                    return `<td>${marks ? "●".repeat(marks) : ""}</td>`;
                  }).join("")}
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
        <p class="games-hint">Tap a row to jump to that hole.</p>`;
    }
    return `
      <div class="game-grid-wrap">
        <table class="game-grid">
          <thead><tr><th>Hole</th>${game.players.map((p) => `<th>${escapeHtml(p.name.slice(0, 6))}</th>`).join("")}</tr></thead>
          <tbody>
            ${game.holes.map((h, i) => `
              <tr data-game-grid-hole="${i}">
                <td>${h.number}${meta && meta.needsPar ? `<span class="game-grid-par">·${h.par}</span>` : ""}</td>
                ${game.players.map((p) => {
                  const v = h.scores[p.id];
                  return `<td>${Number.isFinite(v) ? v : ""}</td>`;
                }).join("")}
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <p class="games-hint">Tap a row to jump to that hole.</p>`;
  }

  function renderGameSummaryView() {
    const game = getActiveGame();
    if (!game) return renderGamesHomeView();
    const meta = Games.GAME_BY_ID[game.gameType];
    const computed = computeGame(game);
    const lines = gameStandingsLines(game);
    const stake = game.options && Number.isFinite(game.options.stake) ? game.options.stake : null;
    let settleHtml = "";
    if (stake && computed) {
      const settlement = Games.computeSettlement(game, computed, stake);
      if (settlement && settlement.transfers.length) {
        settleHtml = `
          <h3 class="games-section-title">Settle up</h3>
          <ul class="game-settle-list">
            ${settlement.transfers.map((t) => `
              <li><strong>${escapeHtml(gamePlayerName(game, t.from))}</strong> pays <strong>${escapeHtml(gamePlayerName(game, t.to))}</strong> $${t.amount.toFixed(2)}</li>`).join("")}
          </ul>`;
      } else if (settlement) {
        settleHtml = `<h3 class="games-section-title">Settle up</h3><p class="games-hint">All square — nobody owes anything.</p>`;
      }
    }
    let extras = "";
    if (game.gameType === "skins" && computed && computed.carrying > 0) {
      extras = `<p class="games-hint">${computed.carrying} skin${computed.carrying === 1 ? "" : "s"} went unclaimed at the end.</p>`;
    }
    return `
      <div class="games-summary">
        <button type="button" class="games-back" data-game-action="home">← Games</button>
        <h2>${escapeHtml(meta ? meta.name : "")} — final</h2>
        <div class="game-standings final">
          ${lines.map((l) => `<div class="game-standings-line">${escapeHtml(l)}</div>`).join("")}
        </div>
        ${extras}
        ${settleHtml}
        ${game.status === "active" ? `<button type="button" class="primary-button" data-game-action="confirm-finish">Confirm final →</button>
        <button type="button" class="games-back-secondary" data-game-action="resume-play">← Keep playing</button>` : ""}
      </div>`;
  }

  // ---- Games: event handling --------------------------------------------------

  function gamesMutateHole(fn) {
    const game = getActiveGame();
    if (!game || game.status !== "active") return;
    const idx = Math.max(0, Math.min(gamesUi.holeIndex, game.holes.length - 1));
    fn(game, game.holes[idx], idx);
    saveGamesState();
    renderGames();
  }

  function handleGamesClick(event) {
    const t = event.target.closest("button, [data-game-grid-hole]");
    if (!t) return;

    if (t.dataset.gameAction) {
      const action = t.dataset.gameAction;
      if (action === "new") { gamesUi.view = "pick"; }
      if (action === "home") { gamesUi.view = "home"; gamesUi.confirmingDeleteId = null; }
      if (action === "pick") { gamesUi.view = "pick"; }
      if (action === "rules") { gamesUi.view = "rules"; }
      if (action === "setup") { gamesUi.view = "setup"; }
      if (action === "toggle-view") { gamesUi.entryView = gamesUi.entryView === "grid" ? "hole" : "grid"; }
      if (action === "start") { startGameFromSetup(); return; }
      if (action === "finish") { gamesUi.view = "summary"; }
      if (action === "resume-play") { gamesUi.view = "play"; }
      if (action === "confirm-finish") {
        const game = getActiveGame();
        if (game) { game.status = "final"; saveGamesState(); }
      }
      renderGames();
      return;
    }

    if (t.dataset.gameCount) {
      gamesUi.playerCount = Number(t.dataset.gameCount);
      renderGames();
      return;
    }
    if (t.dataset.gameEntrants) {
      gamesUi.entrantCount = Number(t.dataset.gameEntrants);
      renderGames();
      return;
    }
    if (t.dataset.gamePick) {
      gamesUi.pickedGameId = t.dataset.gamePick;
      gamesUi.view = "rules";
      renderGames();
      return;
    }
    if (t.dataset.gameHolecount) {
      // Toggle active chip within setup (read at start time).
      const row = t.closest(".games-count-row");
      if (row) row.querySelectorAll(".games-count-chip").forEach((c) => c.classList.toggle("active", c === t));
      return;
    }
    if (t.dataset.gameOpen) {
      const game = gamesState.games.find((g) => g.id === t.dataset.gameOpen);
      if (!game) return;
      gamesUi.activeGameId = game.id;
      gamesUi.view = game.status === "final" ? "summary" : "play";
      gamesUi.holeIndex = game.status === "final" ? 0 : firstIncompleteGameHole(game);
      renderGames();
      return;
    }
    if (t.dataset.gameDelete) {
      const id = t.dataset.gameDelete;
      if (gamesUi.confirmingDeleteId === id) {
        gamesState.games = gamesState.games.filter((g) => g.id !== id);
        gamesUi.confirmingDeleteId = null;
        saveGamesState();
      } else {
        gamesUi.confirmingDeleteId = id;
      }
      renderGames();
      return;
    }
    if (t.dataset.gameNav) {
      const game = getActiveGame();
      if (!game) return;
      gamesUi.holeIndex = Math.max(0, Math.min(game.holes.length - 1, gamesUi.holeIndex + Number(t.dataset.gameNav)));
      renderGames();
      return;
    }
    if (t.dataset.gameScore) {
      const pid = t.dataset.gameScore;
      const delta = Number(t.dataset.delta);
      gamesMutateHole((game, hole) => {
        const current = hole.scores[pid];
        if (!Number.isFinite(current)) {
          // First tap seeds par (or par+1 for "−"? No — par either way; the
          // user can step from there).
          hole.scores[pid] = Number.isFinite(hole.par) ? hole.par : 4;
        } else {
          hole.scores[pid] = Math.max(1, Math.min(15, current + delta));
        }
      });
      return;
    }
    if (t.dataset.gamePull) {
      const score = Number(t.dataset.gamePull);
      gamesMutateHole((game, hole) => {
        hole.scores[game.players[0].id] = score;
      });
      return;
    }
    if (t.dataset.gamePar) {
      const par = Number(t.dataset.gamePar);
      gamesMutateHole((game, hole) => { hole.par = par; });
      return;
    }
    if (t.dataset.gameWolfPartner) {
      const pid = t.dataset.gameWolfPartner;
      gamesMutateHole((game, hole, idx) => {
        const wolfId = Games.wolfForHole(game.players.map((p) => p.id), idx);
        const existing = hole.wolf || {};
        hole.wolf = existing.partnerId === pid
          ? null // tap again to clear
          : { wolfId, partnerId: pid, lone: false };
      });
      return;
    }
    if (t.dataset.gameWolfLone) {
      gamesMutateHole((game, hole, idx) => {
        const wolfId = Games.wolfForHole(game.players.map((p) => p.id), idx);
        const existing = hole.wolf || {};
        hole.wolf = existing.lone ? null : { wolfId, partnerId: null, lone: true };
      });
      return;
    }
    if (t.dataset.gameBingo) {
      const [slot, pid] = t.dataset.gameBingo.split(":");
      gamesMutateHole((game, hole) => {
        if (!hole.bingo) hole.bingo = { bingo: null, bango: null, bongo: null };
        hole.bingo[slot] = hole.bingo[slot] === pid ? null : pid;
      });
      return;
    }
    const gridRow = t.closest ? t.closest("[data-game-grid-hole]") : null;
    if (gridRow) {
      gamesUi.holeIndex = Number(gridRow.dataset.gameGridHole);
      gamesUi.entryView = "hole";
      renderGames();
    }
  }

  function firstIncompleteGameHole(game) {
    const idx = game.holes.findIndex((h) => !gameHoleEntryComplete(game, h));
    return idx === -1 ? game.holes.length - 1 : idx;
  }

  function startGameFromSetup() {
    const meta = Games.GAME_BY_ID[gamesUi.pickedGameId];
    if (!meta || !els.gamesRoot) return;
    const isEntrant = Boolean(meta.entrantLabel);
    const nameInputs = [...els.gamesRoot.querySelectorAll(".game-player-name")];
    const names = nameInputs.map((input, i) =>
      input.value.trim() || (isEntrant ? `${meta.entrantLabel} ${i + 1}` : `Player ${i + 1}`));
    // Team names shouldn't overwrite the remembered individual player names.
    if (!isEntrant) rememberPlayerNames(names);
    const players = names.map((name, i) => ({ id: `p${i + 1}`, name }));
    const holeChip = els.gamesRoot.querySelector("[data-game-holecount].active");
    const requested = holeChip ? Number(holeChip.dataset.gameHolecount) : 18;
    const holeCount = meta.holeCounts.includes(requested) ? requested : meta.holeCounts[0];
    const options = { stake: null };
    (meta.options || []).forEach((opt) => {
      const toggle = els.gamesRoot.querySelector(`.game-option-toggle[data-option-id="${opt.id}"]`);
      options[opt.id] = toggle ? toggle.checked : Boolean(opt.default);
    });
    const stakeInput = els.gamesRoot.querySelector(".game-stake-input");
    const stakeVal = stakeInput ? Number(stakeInput.value) : NaN;
    if (Number.isFinite(stakeVal) && stakeVal > 0) options.stake = stakeVal;
    const teams = meta.teams ? [[players[0].id, players[1].id], [players[2].id, players[3].id]] : null;
    const game = {
      id: makeId("game"),
      date: today,
      gameType: meta.id,
      holeCount,
      players,
      teams,
      options,
      holes: Array.from({ length: holeCount }, (_, i) => ({
        number: i + 1,
        par: 4,
        scores: Object.fromEntries(players.map((p) => [p.id, null]))
      })),
      status: "active"
    };
    gamesState.games.unshift(game);
    saveGamesState();
    gamesUi.activeGameId = game.id;
    gamesUi.view = "play";
    gamesUi.holeIndex = 0;
    gamesUi.entryView = "hole";
    renderGames();
  }

  if (els.gamesRoot) {
    els.gamesRoot.addEventListener("click", handleGamesClick);
    renderGames();
  }

  // Best round tile on Home → open that round's read-only scorecard sheet.
  // Same showRoundDetail path as Trophy Room and Recent Scorecards, per the
  // "every open-a-round affordance converges on the detail sheet" rule.
  if (els.metricBestRoundCard) {
    els.metricBestRoundCard.addEventListener("click", () => {
      const id = els.metricBestRoundCard.dataset.roundId;
      if (!id) return;
      const round = state.rounds.find((r) => r.id === id);
      if (round) showRoundDetail(round);
    });
  }

  // Open a course's profile in the Courses tab from anywhere, by PHYSICAL
  // name ("Ridgeview Golf Club" — tee variants pool). Used by every
  // data-open-course-name link: round-detail subtitle, Recent Scorecards
  // rows, the par-type sheet's By-course rows, the scoring-tier sheet's
  // By-course rows.
  function openCourseDetailForName(name) {
    const entries = getCatalogEntriesForCourseName(name);
    if (!entries.length) return;
    // Prefer the variant the user actually plays (most recent round at
    // this course), else the first catalog entry.
    const lastPlayed = [...state.rounds]
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .find((r) => physicalCourseName(r.courseId) === name);
    const playedEntry = lastPlayed ? entries.find((e) => e.id === lastPlayed.courseId) : null;
    selectedCourseDetailId = (playedEntry || entries[0]).id;
    renderCourseList();
    renderCourseDetail();
    setActiveTab("courses");
    setTimeout(() => {
      const panel = document.querySelector(".course-detail-panel");
      if (panel) panel.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 80);
  }

  // One global handler for every course-name link in the app. Also closes
  // whichever sheet/overlay the link was inside, so the jump lands clean.
  document.addEventListener("click", (event) => {
    const keyLink = event.target.closest("[data-go-course-key]");
    if (keyLink) {
      setActiveTab("profile");
      setTimeout(() => {
        els.courseApiPanel?.scrollIntoView({ block: "start", behavior: "smooth" });
        els.courseApiKeyInput?.focus();
      }, 80);
      return;
    }
    const link = event.target.closest("[data-open-course-name]");
    if (!link) return;
    const name = link.dataset.openCourseName;
    [els.roundDetailOverlay, els.bucketSheetOverlay, els.parTypeSheetOverlay].forEach((overlay) => {
      if (overlay && !overlay.hidden) {
        overlay.hidden = true;
      }
    });
    document.body.classList.remove("hole-picker-open");
    openCourseDetailForName(name);
  });

  // Course-search API key management (Profile → Course search).
  function renderCourseApiKeyStatus() {
    if (!els.courseApiKeyStatus) return;
    const key = getCourseApiKey();
    els.courseApiKeyStatus.textContent = key
      ? `Key saved (…${key.slice(-4)}). Online search is on — try the Courses tab.`
      : "No key yet — search covers your saved courses only.";
  }
  renderCourseApiKeyStatus();
  if (els.courseApiKeySave) {
    els.courseApiKeySave.addEventListener("click", () => {
      const value = (els.courseApiKeyInput?.value || "").trim();
      setCourseApiKey(value);
      if (els.courseApiKeyInput) els.courseApiKeyInput.value = "";
      renderCourseApiKeyStatus();
      showToast(value ? "Course search key saved." : "Course search key cleared.");
    });
  }

  // Every other Overview metric tile drills into the section that explains
  // it: Rounds / Avg score / Avg to par → the scoring trend chart, Avg SG →
  // the strokes-gained trend, Handicap → the handicap detail, GIR → the
  // hole heatmap. One delegated wiring pass; the targets live on the tiles
  // as data-drill-section / data-drill-sub.
  document.querySelectorAll(".metric-card[data-drill-section]").forEach((tile) => {
    tile.addEventListener("click", () => {
      const section = tile.dataset.drillSection;
      const sub = tile.dataset.drillSub;
      setActiveTab("home");
      setActiveHomeSection(section);
      if (sub) setActiveSubsection(section, sub);
      // Land the user on the content, not the chip strip.
      setTimeout(() => {
        const target = document.querySelector(`[data-home-subsection="${sub}"]:not(.subsection-hidden)`)
          || document.querySelector(`.home-subchips[data-home-section="${section}"]`);
        if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
      }, 80);
    });
  });

  function setActiveTab(tabName) {
    const panels = [...document.querySelectorAll("[data-tab-panel]")];
    const targetName = panels.some((panel) => panel.dataset.tabPanel === tabName) ? tabName : "home";
    panels.forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.tabPanel === targetName);
    });
    document.querySelectorAll("[data-tab-target]").forEach((button) => {
      const isActive = button.dataset.tabTarget === targetName;
      button.classList.toggle("active", isActive && button.classList.contains("tab-button"));
      if (button.classList.contains("tab-button")) {
        button.setAttribute("aria-selected", String(isActive));
      }
    });
    localStorage.setItem(ACTIVE_TAB_KEY, targetName);
    updateFloatingNavVisibility();
    // Refresh the snapshot panel on Profile entry so timestamps don't drift
    // (e.g. "2 min ago" should re-evaluate without a full reload).
    if (targetName === "profile") renderSnapshotPanel();
  }

  function refreshRoundSetup() {
    resetRoundChrome();
    renderRoundSetupOptions();
    renderScorecard(getSelectedRoundCourse());
    renderHandicapPanel();
    renderCourseBrief();
    applyRoundStartedUi();
  }

  // Re-render the round setup + scorecard while preserving entered data for
  // the given hole numbers. Used when a Deerwood nine or the tee changes:
  // the holes in the unchanged half (or all holes, for a tee swap) keep
  // their scores/putts/notes/shots/clubs; the rest reset to fresh.
  function refreshRoundPreservingHoles(preserveHoleNumbers) {
    const preserve = new Set(preserveHoleNumbers);
    const snapshot = captureScorecardSnapshot();
    // Drop the per-hole entry for any hole NOT being preserved.
    Object.keys(pendingHoles).forEach((key) => {
      if (!preserve.has(Number(key))) delete pendingHoles[key];
    });
    renderRoundSetupOptions();
    renderScorecard(getSelectedRoundCourse());
    renderHandicapPanel();
    renderCourseBrief();
    applyRoundStartedUi();
    // Re-apply the preserved holes' score/putts/fairway/gir/pen/firstPutt.
    const preservedSnap = new Map();
    snapshot.forEach((values, holeNumber) => {
      if (preserve.has(holeNumber)) preservedSnap.set(holeNumber, values);
    });
    applyScorecardSnapshot(preservedSnap);
    updateRoundPreview();
    if (viewMode === "card") syncAllPillActiveStates();
    scheduleInProgressSave();
  }

  function renderCourseBrief() {
    const container = els.roundBrief;
    if (!container) return;
    const course = getSelectedRoundCourse();
    if (!course) {
      container.hidden = true;
      container.innerHTML = "";
      return;
    }
    const brief = buildCourseBrief(course.id);
    if (!brief) {
      container.hidden = true;
      container.innerHTML = "";
      return;
    }

    const collapsed = localStorage.getItem(BRIEF_COLLAPSED_KEY) === "1";
    const deltaText = Number.isFinite(brief.courseDelta)
      ? brief.courseDelta < 0
        ? `${formatSigned(brief.courseDelta)} better than your overall average`
        : brief.courseDelta > 0
          ? `${formatSigned(brief.courseDelta)} harder for you than average`
          : "matches your overall average"
      : "first comparison vs other courses";

    const recentHtml = brief.recent.map((entry) => {
      const sg = entry.sg !== null ? ` | SG ${formatSigned(entry.sg)}` : "";
      return `<li><strong>${escapeHtml(entry.date)}</strong> · ${entry.gross} (${formatSigned(entry.toPar, 0)})${sg}</li>`;
    }).join("");

    const leaksHtml = brief.leaks.length
      ? brief.leaks.map((hole) => {
          const noteHtml = hole.latestNote
            ? `<p class="brief-list-note">"${escapeHtml(hole.latestNote.note)}" <span class="subtext">— ${escapeHtml(hole.latestNote.date)}</span></p>`
            : "";
          const hazardsHtml = Array.isArray(hole.hazards) && hole.hazards.length
            ? `<ul class="hazard-chip-list hazard-chip-list-compact">${hole.hazards.map((h) => renderHazardChip(h)).join("")}</ul>`
            : "";
          return `<li><div class="brief-list-row"><strong>${escapeHtml(hole.label)}</strong> <span class="subtext">Par ${hole.par}</span><span class="score-chip bad">${formatSigned(hole.avgSg, 2)}/rd</span></div>${hazardsHtml}${noteHtml}</li>`;
        }).join("")
      : "<li class=\"subtext\">Need more SG-eligible rounds.</li>";

    const strengthsHtml = brief.strengths.length
      ? brief.strengths.map((hole) => {
          const noteHtml = hole.latestNote
            ? `<p class="brief-list-note">"${escapeHtml(hole.latestNote.note)}" <span class="subtext">— ${escapeHtml(hole.latestNote.date)}</span></p>`
            : "";
          const hazardsHtml = Array.isArray(hole.hazards) && hole.hazards.length
            ? `<ul class="hazard-chip-list hazard-chip-list-compact">${hole.hazards.map((h) => renderHazardChip(h)).join("")}</ul>`
            : "";
          return `<li><div class="brief-list-row"><strong>${escapeHtml(hole.label)}</strong> <span class="subtext">Par ${hole.par}</span><span class="score-chip">${formatSigned(hole.avgSg, 2)}/rd</span></div>${hazardsHtml}${noteHtml}</li>`;
        }).join("")
      : "<li class=\"subtext\">Need more SG-eligible rounds.</li>";

    const cf = brief.counterfactual;
    const counterfactualHtml = cf.savings > 0 && cf.worstThree.length
      ? `<p class="brief-counterfactual"><strong>What-if:</strong> Last round (${escapeHtml(cf.lastDate)}) you shot <strong>${cf.actualScore}</strong> (${formatSigned(cf.actualToPar, 0)}). Par your 3 worst holes (${cf.worstThree.map((h) => escapeHtml(h.label || `#${h.number}`)).join(", ")}) and you'd have shot <strong>${cf.adjustedScore}</strong> — a ${cf.savings}-stroke swing.</p>`
      : "";

    const noteHtml = brief.lastNote
      ? `<p class="brief-note">Note from ${escapeHtml(cf.lastDate)}: "${escapeHtml(brief.lastNote)}"</p>`
      : "";

    container.hidden = false;
    container.innerHTML = `
      <div class="brief-header">
        <div>
          <p class="eyebrow">Pre-round brief</p>
          <h3>${escapeHtml(brief.course.name)}${brief.course.tee ? ` <span class="brief-tee">(${escapeHtml(brief.course.tee)})</span>` : ""}</h3>
        </div>
        <button class="brief-toggle" type="button" aria-expanded="${collapsed ? "false" : "true"}">${collapsed ? "Show" : "Hide"}</button>
      </div>
      <div class="brief-body" ${collapsed ? "hidden" : ""}>
        <p class="brief-summary"><strong>${brief.roundCount}</strong> round${brief.roundCount === 1 ? "" : "s"} here, averaging <strong>${brief.avgGross.toFixed(1)}</strong> (${formatSigned(brief.avgToPar)}) with <strong>${brief.avgPutts.toFixed(1)}</strong> putts — ${deltaText}.</p>
        <div class="brief-grid">
          <div class="brief-block">
            <p class="brief-block-title">Recent rounds</p>
            <ul class="brief-list">${recentHtml}</ul>
          </div>
          <div class="brief-block">
            <p class="brief-block-title">Leak holes</p>
            <ul class="brief-list brief-list-leaks">${leaksHtml}</ul>
          </div>
          <div class="brief-block">
            <p class="brief-block-title">Strength holes</p>
            <ul class="brief-list brief-list-strengths">${strengthsHtml}</ul>
          </div>
        </div>
        ${counterfactualHtml}
        ${noteHtml}
      </div>`;

    const toggle = container.querySelector(".brief-toggle");
    const body = container.querySelector(".brief-body");
    if (toggle && body) {
      toggle.addEventListener("click", () => {
        const nowCollapsed = !body.hasAttribute("hidden");
        if (nowCollapsed) {
          body.setAttribute("hidden", "");
          toggle.textContent = "Show";
          toggle.setAttribute("aria-expanded", "false");
          localStorage.setItem(BRIEF_COLLAPSED_KEY, "1");
        } else {
          body.removeAttribute("hidden");
          toggle.textContent = "Hide";
          toggle.setAttribute("aria-expanded", "true");
          localStorage.removeItem(BRIEF_COLLAPSED_KEY);
        }
      });
    }
  }

  function parseDeerwoodCourseId(courseId) {
    if (!isDeerwoodCourseId(courseId)) return null;
    const parts = String(courseId).replace("deerwood-", "").split("-");
    const teePart = parts.pop();
    const tee = DEERWOOD_TEE_OPTIONS.find((option) => option.toLowerCase() === teePart);
    const layoutId = parts.join("-");
    if (!tee || !layoutId) return null;
    return { tee, layoutId, holeCount: layoutId.includes("-") ? "18" : "9" };
  }

  function updateEditModeUi() {
    if (editingRoundId) {
      els.roundEntryTitle.textContent = "Edit Round";
      els.resetRoundButton.textContent = "Cancel edit";
      els.roundSubmitButton.textContent = "Update round";
    } else {
      els.roundEntryTitle.textContent = "Add Round";
      els.resetRoundButton.textContent = "Reset";
      els.roundSubmitButton.textContent = "Save round";
    }
  }

  function clearEditState({ rerender = true } = {}) {
    if (!editingRoundId && els.roundEntryTitle.textContent === "Add Round") return;
    editingRoundId = null;
    els.roundNote.value = "";
    if (els.roundWind) els.roundWind.value = "";
    clearInProgressRound();
    resetPendingHoles(); resetReviewState();
    resetPendingSurvey(); syncSurveyUiFromState();
    if (els.surveyDetails) els.surveyDetails.open = false;
    // Cancelling an edit returns the form to fresh-setup state. Reset entry
    // mode back to the per-installation default so the next fresh round
    // doesn't inherit whatever mode the edited round was in.
    resetRoundSetupState();
    setCurrentEntryMode(entryModeDefault);
    updateEditModeUi();
    resetRoundChrome();
    if (rerender) renderScorecard(getSelectedRoundCourse());
  }

  function loadRoundIntoForm(round) {
    if (!round) return;
    editingRoundId = round.id;
    // Editing skips the Start Round gate — the round is already real.
    // Mark every setup chip row tapped so chips render their selection
    // (otherwise the form would look blank while the user is editing).
    SETUP_CHIP_ROW_IDS.forEach((id) => setupChipRowsTapped.add(id));
    els.roundDate.value = round.date || today;
    els.roundNote.value = round.note || "";
    if (els.roundWind) els.roundWind.value = round.wind || "";
    if (els.roundTag) els.roundTag.value = round.tag || "";
    // Restore the entry mode this round was originally saved with so the
    // edited card layout matches what's on file. Legacy rounds (no
    // entryMode field) default to "detailed" via the shape normalizer.
    setCurrentEntryMode(round.entryMode === "speed" ? "speed" : "detailed");

    // Hydrate the optional reflection survey from the saved round (if any).
    resetPendingSurvey();
    if (round.survey && typeof round.survey === "object") {
      if (round.survey.feel) setSurveyField("feel", round.survey.feel);
      if (round.survey.confidence) setSurveyField("confidence", round.survey.confidence);
      if (round.survey.swingThoughts) setSurveyField("swingThoughts", round.survey.swingThoughts);
      if (round.survey.wentWell) setSurveyField("wentWell", round.survey.wentWell);
      if (round.survey.workOn) setSurveyField("workOn", round.survey.workOn);
      if (round.survey.ratings && typeof round.survey.ratings === "object") {
        ["driver", "irons", "wedges", "putter"].forEach((club) => {
          if (Number.isFinite(round.survey.ratings[club])) setSurveyRating(club, round.survey.ratings[club]);
        });
      }
    }
    syncSurveyUiFromState();
    // If the loaded survey had any content, expand the details so the user
    // sees what's already there instead of having to hunt for it.
    if (els.surveyDetails) els.surveyDetails.open = surveyHasContent(pendingSurvey);

    resetPendingHoles(); resetReviewState();
    round.holes.forEach((hole) => {
      if (hole && hole.note) setHoleNote(hole.number, hole.note);
      if (hole && Array.isArray(hole.clubsHit) && hole.clubsHit.length) {
        setHoleClubs(hole.number, hole.clubsHit);
      }
      // Prefer the canonical penaltyClubs array; fall back to the legacy
      // single penaltyClub string for rounds saved before the multi-club
      // change. Either way the in-form state ends up as the array shape.
      if (hole && Array.isArray(hole.penaltyClubs) && hole.penaltyClubs.length) {
        setHolePenaltyClubs(hole.number, hole.penaltyClubs);
      } else if (hole && hole.penaltyClub) {
        setHolePenaltyClub(hole.number, hole.penaltyClub);
      }
    });

    const deerwoodInfo = parseDeerwoodCourseId(round.courseId);
    if (deerwoodInfo) {
      els.roundCourse.value = DEERWOOD_COURSE_ID;
      els.roundHoleCount.value = deerwoodInfo.holeCount;
      els.roundTee.value = deerwoodInfo.tee;
      if (deerwoodInfo.holeCount === "9") {
        renderRoundSetupOptions();
        els.roundLayout.value = deerwoodInfo.layoutId;
      } else {
        const [front, back] = deerwoodInfo.layoutId.split("-");
        els.roundFrontNine.value = DEERWOOD_NINE_IDS.includes(front) ? front : "buck";
        els.roundBackNine.value = DEERWOOD_NINE_IDS.includes(back) ? back : "doe";
        renderRoundSetupOptions();
      }
    } else {
      if ([...els.roundCourse.options].some((option) => option.value === round.courseId)) {
        els.roundCourse.value = round.courseId;
      }
      renderRoundSetupOptions();
    }

    renderScorecard(getSelectedRoundCourse());
    renderCourseBrief();

    round.holes.forEach((hole) => {
      const holeKey = String(hole.number);
      const scoreInput = els.scorecardGrid.querySelector(`.score-input[data-hole="${holeKey}"]`);
      const puttsInput = els.scorecardGrid.querySelector(`.putts-input[data-hole="${holeKey}"]`);
      const fairwayInput = els.scorecardGrid.querySelector(`.fairway-input[data-hole="${holeKey}"]`);
      const bunkerInput = els.scorecardGrid.querySelector(`.bunker-input[data-hole="${holeKey}"]`);
      const girInput = els.scorecardGrid.querySelector(`.gir-input[data-hole="${holeKey}"]`);
      const penaltyInput = els.scorecardGrid.querySelector(`.penalty-input[data-hole="${holeKey}"]`);
      const firstPuttInput = els.scorecardGrid.querySelector(`.first-putt-input[data-hole="${holeKey}"]`);
      const fringePuttsInput = els.scorecardGrid.querySelector(`.fringe-putts-input[data-hole="${holeKey}"]`);
      if (scoreInput && Number.isFinite(hole.score)) {
        scoreInput.value = hole.score;
        // Treat the loaded score as the "current auto-fill" so editing
        // any other input (clubs / putts / penalties) on the hole
        // updates the score. Without this, dataset.autoScore is empty
        // and recalculateScoreForHole's "is this still auto-driven?"
        // gate (currentValue === lastAuto) fails — every loaded score
        // looks like a manual override and the recalc skips it.
        // Manual overrides re-stick the moment the user taps a score
        // pill (the pill handler clears dataset.autoScore).
        scoreInput.dataset.autoScore = String(hole.score);
      }
      if (puttsInput && Number.isFinite(hole.putts)) puttsInput.value = hole.putts;
      if (penaltyInput && Number.isFinite(hole.penalties)) penaltyInput.value = hole.penalties;
      if (firstPuttInput && Number.isFinite(hole.firstPuttDistance)) firstPuttInput.value = hole.firstPuttDistance;
      if (fringePuttsInput && Number.isFinite(hole.fringePutts)) fringePuttsInput.value = hole.fringePutts;
      if (fairwayInput && hole.fairway) {
        const hasOption = [...fairwayInput.options].some((option) => option.value === hole.fairway);
        if (hasOption) fairwayInput.value = hole.fairway;
      }
      if (bunkerInput && hole.bunker) {
        const hasOption = [...bunkerInput.options].some((option) => option.value === hole.bunker);
        if (hasOption) bunkerInput.value = hole.bunker;
      }
      if (girInput) girInput.checked = Boolean(hole.gir);
    });

    updateEditModeUi();
    updateRoundPreview();
    // Loaded values were written straight to the hidden inputs; re-sync the
    // card-view pills, score marks, and penalty-club rows to match them.
    if (viewMode === "card") syncAllPillActiveStates();
    // Re-derive GIR from the loaded score+putts (a manual gir from old data
    // gets corrected to whatever the formula actually says).
    syncAllDerivedFlags();
    setActiveTab("rounds");
  }

  els.roundCourse.addEventListener("change", () => {
    if (els.roundCourse.value === DEERWOOD_COURSE_ID) els.roundTee.value = "White";
    clearInProgressRound();
    resetPendingHoles(); resetReviewState();
    refreshRoundSetup();
  });
  // Hole count switch (9 ↔ 18) used to wipe all entered data. That broke
  // the common "I'm going to play another 9" flow. Now: preserve whatever
  // holes are currently on the scorecard so any entered data survives the
  // switch. For Deerwood 9-hole that's [1..9]; for non-Deerwood Back 9
  // that's [10..18]; for 18-hole layouts it's [1..18]. Holes not in the
  // new layout get dropped naturally (refreshRoundPreservingHoles only
  // re-applies preserved hole numbers that the new layout actually has).
  els.roundHoleCount.addEventListener("change", () => {
    resetReviewState();
    const currentNumbers = [...els.scorecardGrid.querySelectorAll(".score-input[data-hole]")]
      .map((input) => Number(input.dataset.hole))
      .filter(Number.isFinite);
    // Belt-and-suspenders: if for some reason no scorecard is rendered yet
    // (very early in setup), fall back to preserving the canonical front 9.
    const preserve = currentNumbers.length
      ? currentNumbers
      : [1, 2, 3, 4, 5, 6, 7, 8, 9];
    refreshRoundPreservingHoles(preserve);
  });
  // Layout change (Deerwood 9-hole nine picker: Buck → Doe → Fawn) is a
  // deliberate "different physical course" action, so still clear. Score
  // 4 on Buck 1 should NOT silently become "score 4 on Doe 1".
  els.roundLayout.addEventListener("change", () => { clearInProgressRound(); resetPendingHoles(); resetReviewState(); refreshRoundSetup(); });
  // Front 9 change keeps the back 9 (holes 10-18); back 9 change keeps the
  // front 9 (holes 1-9). This means fixing a wrong nine mid-round no longer
  // wipes the half you already entered.
  els.roundFrontNine.addEventListener("change", () => {
    refreshRoundPreservingHoles([10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });
  els.roundBackNine.addEventListener("change", () => {
    refreshRoundPreservingHoles([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  // Tee change is the same physical holes (only yardage/rating differ),
  // so preserve everything.
  els.roundTee.addEventListener("change", () => {
    refreshRoundPreservingHoles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });
  els.roundDate.addEventListener("change", scheduleInProgressSave);
  els.roundNote.addEventListener("input", scheduleInProgressSave);
  if (els.roundWind) els.roundWind.addEventListener("change", scheduleInProgressSave);

  // Survey wiring: chip clicks (event-delegated on the surveyDetails wrapper
  // so adding chips later doesn't require rewiring) + the three textareas.
  if (els.surveyDetails) {
    els.surveyDetails.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-survey-value]");
      if (!chip) return;
      event.preventDefault();
      handleSurveyChipClick(chip);
    });
  }
  if (els.surveySwingThoughts) {
    els.surveySwingThoughts.addEventListener("input", () => {
      setSurveyField("swingThoughts", els.surveySwingThoughts.value);
      scheduleInProgressSave();
    });
  }
  if (els.surveyWentWell) {
    els.surveyWentWell.addEventListener("input", () => {
      setSurveyField("wentWell", els.surveyWentWell.value);
      scheduleInProgressSave();
    });
  }
  if (els.surveyWorkOn) {
    els.surveyWorkOn.addEventListener("input", () => {
      setSurveyField("workOn", els.surveyWorkOn.value);
      scheduleInProgressSave();
    });
  }
  if (els.roundSetupBanner) {
    els.roundSetupBanner.addEventListener("click", () => {
      roundSetupOpen = !roundSetupOpen;
      roundChromeAutoCollapsed = true;
      renderRoundSetupChrome();
    });
  }
  els.resetRoundButton.addEventListener("click", () => {
    if (editingRoundId) {
      clearEditState();
      showToast("Edit cancelled.");
    } else {
      clearInProgressRound();
      resetPendingHoles(); resetReviewState();
      resetPendingSurvey(); syncSurveyUiFromState();
      if (els.surveyDetails) els.surveyDetails.open = false;
      resetRoundSetupState();
      resetRoundChrome();
      renderScorecard(getSelectedRoundCourse());
    }
  });

  if (els.startRoundButton) {
    els.startRoundButton.addEventListener("click", startRound);
  }

  if (els.viewToggleButton) {
    els.viewToggleButton.addEventListener("click", () => {
      setViewMode(viewMode === "card" ? "grid" : "card");
    });
  }

  els.scorecardGrid.addEventListener("keydown", advanceScorecardOnEnter);
  els.scorecardGrid.addEventListener("click", (event) => {
    // Prev/Next nav — delegated so the header arrows and the bottom buttons
    // both work (and survive scorecard re-renders).
    const navButton = event.target.closest("[data-card-nav]");
    if (navButton) {
      event.preventDefault();
      const step = navButton.dataset.cardNav === "prev" ? -1 : 1;
      setActiveCardIndex(getActiveCardIndex() + step);
      return;
    }
    const button = event.target.closest('[data-action="show-review"]');
    if (button) {
      event.preventDefault();
      // Make sure the hole the user is on has its par pre-fill before review.
      prefillActiveCardPar();
      openReviewSection();
    }
  });
  if (els.reviewSection) {
    els.reviewSection.addEventListener("click", (event) => {
      const button = event.target.closest('[data-action="hide-review"]');
      if (button) {
        event.preventDefault();
        closeReviewSection();
      }
    });
  }

  if (els.courseDetail) {
    els.courseDetail.addEventListener("submit", (event) => {
      const form = event.target.closest("[data-add-hazard]");
      if (!form) return;
      event.preventDefault();
      const holeNumber = Number(form.dataset.holeNumber);
      const formData = new FormData(form);
      const hazard = normalizeHazard({
        type: formData.get("type"),
        side: formData.get("side") || null,
        carryYards: formData.get("carryYards"),
        note: formData.get("note")
      });
      if (!hazard) return;
      const course = state.courses.find((c) => c.id === selectedCourseDetailId);
      if (!course) return;
      const hole = course.holes.find((h) => h.number === holeNumber);
      if (!hole) return;
      hole.hazards = Array.isArray(hole.hazards) ? [...hole.hazards, hazard] : [hazard];
      // Mirror to sibling courses (same name, different tee) so hazards are
      // shared across tee variants of the same physical layout.
      getSiblingCourses(course.id).forEach((sibling) => {
        const siblingHole = sibling.holes && sibling.holes.find((h) => h.number === holeNumber);
        if (!siblingHole) return;
        siblingHole.hazards = Array.isArray(siblingHole.hazards) ? [...siblingHole.hazards, { ...hazard }] : [{ ...hazard }];
      });
      saveState();
      const openBlock = form.closest(".course-hole-block");
      renderCourseDetail();
      // Re-open the same hole's details after re-render.
      if (openBlock) {
        const reopened = els.courseDetail.querySelector(`.course-hole-block[data-hole-number="${holeNumber}"]`);
        if (reopened) reopened.open = true;
      }
      showToast("Hazard added.");
    });

    els.courseDetail.addEventListener("click", (event) => {
      const deleteBtn = event.target.closest("[data-delete-hazard]");
      if (!deleteBtn) return;
      event.preventDefault();
      const hazardId = deleteBtn.dataset.deleteHazard;
      const block = deleteBtn.closest(".course-hole-block");
      if (!block) return;
      const holeNumber = Number(block.dataset.holeNumber);
      const course = state.courses.find((c) => c.id === selectedCourseDetailId);
      if (!course) return;
      const hole = course.holes.find((h) => h.number === holeNumber);
      if (!hole || !Array.isArray(hole.hazards)) return;
      hole.hazards = hole.hazards.filter((h) => h.id !== hazardId);
      // Mirror deletion to sibling courses.
      getSiblingCourses(course.id).forEach((sibling) => {
        const siblingHole = sibling.holes && sibling.holes.find((h) => h.number === holeNumber);
        if (!siblingHole || !Array.isArray(siblingHole.hazards)) return;
        siblingHole.hazards = siblingHole.hazards.filter((h) => h.id !== hazardId);
      });
      saveState();
      renderCourseDetail();
      const reopened = els.courseDetail.querySelector(`.course-hole-block[data-hole-number="${holeNumber}"]`);
      if (reopened) reopened.open = true;
      showToast("Hazard removed.");
    });
  }

  document.querySelectorAll(".home-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      setActiveHomeSection(chip.dataset.homeSectionTarget);
    });
  });
  if (els.floatingNavPrev) {
    els.floatingNavPrev.addEventListener("click", () => setActiveCardIndex(getActiveCardIndex() - 1));
  }
  if (els.floatingNavNext) {
    els.floatingNavNext.addEventListener("click", () => setActiveCardIndex(getActiveCardIndex() + 1));
  }
  if (els.homeFiltersButton) els.homeFiltersButton.addEventListener("click", openFiltersSheet);
  if (els.filtersSheetBackdrop) els.filtersSheetBackdrop.addEventListener("click", closeFiltersSheet);
  if (els.filtersSheetClose) els.filtersSheetClose.addEventListener("click", closeFiltersSheet);
  if (els.filtersResetButton) els.filtersResetButton.addEventListener("click", resetAllFilters);
  document.querySelectorAll(".home-subchip").forEach((chip) => {
    chip.addEventListener("click", () => {
      setActiveSubsection(activeHomeSection, chip.dataset.homeSubsectionTarget);
    });
  });

  if (els.profileBagGrid) {
    els.profileBagGrid.addEventListener("click", (event) => {
      const button = event.target.closest("[data-bag-toggle]");
      if (!button) return;
      toggleClubInBag(button.dataset.bagToggle);
    });
  }
  if (els.bagResetButton) {
    els.bagResetButton.addEventListener("click", () => {
      if (!window.confirm("Reset your bag to include every club?")) return;
      resetBagToAll();
    });
  }

  function setCardFlowMode(next) {
    if (next !== "narrative" && next !== "default") return;
    if (cardFlowMode === next) return;
    cardFlowMode = next;
    try { localStorage.setItem(CARD_FLOW_KEY, next); } catch {}
    // Re-render the scorecard if it's currently visible. Pending inputs
    // live in the hidden input cells and pendingHoles map — both untouched
    // by the re-render, so a switch in the middle of a round preserves
    // every score/putt/club/note that's been entered so far.
    if (els.scorecardGrid) renderScorecard(getSelectedRoundCourse());
    syncCardFlowRadios();
  }

  function syncCardFlowRadios() {
    if (els.cardFlowDefault) els.cardFlowDefault.checked = cardFlowMode === "default";
    if (els.cardFlowNarrative) els.cardFlowNarrative.checked = cardFlowMode === "narrative";
  }
  syncCardFlowRadios();
  if (els.cardFlowDefault) els.cardFlowDefault.addEventListener("change", () => {
    if (els.cardFlowDefault.checked) setCardFlowMode("default");
  });
  if (els.cardFlowNarrative) els.cardFlowNarrative.addEventListener("change", () => {
    if (els.cardFlowNarrative.checked) setCardFlowMode("narrative");
  });

  // Entry mode — per-installation default (Profile radio) and per-round
  // override (round-setup banner chip). The default seeds currentEntryMode
  // on app load; the per-round chip flips currentEntryMode in place. When
  // currentEntryMode flips mid-round, the scorecard re-renders so the new
  // mode's chrome shows up immediately — and because pending hole state
  // lives in the hidden inputs / pendingHole map, nothing already entered
  // is lost in the switch.
  function setEntryModeDefault(next) {
    if (next !== "detailed" && next !== "speed") return;
    if (entryModeDefault === next) return;
    entryModeDefault = next;
    try { localStorage.setItem(ENTRY_MODE_DEFAULT_KEY, next); } catch {}
    syncEntryModeDefaultRadios();
  }

  function setCurrentEntryMode(next) {
    if (next !== "detailed" && next !== "speed") return;
    if (currentEntryMode === next) return;
    currentEntryMode = next;
    if (els.roundEntryMode && els.roundEntryMode.value !== next) {
      els.roundEntryMode.value = next;
      // Repaint the chip-style picker so the new selection is reflected.
      els.roundEntryMode.dispatchEvent(new Event("change", { bubbles: true }));
    }
    applyEntryModeToScorecard();
  }

  function applyEntryModeToScorecard() {
    if (!els.scorecardGrid) return;
    const cards = els.scorecardGrid.querySelector(".scorecard-cards");
    if (cards) cards.dataset.entryMode = currentEntryMode;
    els.scorecardGrid.dataset.entryMode = currentEntryMode;
  }

  function syncEntryModeDefaultRadios() {
    if (els.entryModeDetailedDefault) els.entryModeDetailedDefault.checked = entryModeDefault === "detailed";
    if (els.entryModeSpeedDefault) els.entryModeSpeedDefault.checked = entryModeDefault === "speed";
  }
  syncEntryModeDefaultRadios();
  if (els.entryModeDetailedDefault) els.entryModeDetailedDefault.addEventListener("change", () => {
    if (els.entryModeDetailedDefault.checked) setEntryModeDefault("detailed");
  });
  if (els.entryModeSpeedDefault) els.entryModeSpeedDefault.addEventListener("change", () => {
    if (els.entryModeSpeedDefault.checked) setEntryModeDefault("speed");
  });
  if (els.roundEntryMode) {
    // Seed the in-banner control with the per-installation default so a
    // fresh page load shows the right option highlighted.
    els.roundEntryMode.value = currentEntryMode;
    els.roundEntryMode.addEventListener("change", () => {
      setCurrentEntryMode(els.roundEntryMode.value || "detailed");
    });
  }

  if (els.holePickerBackdrop) els.holePickerBackdrop.addEventListener("click", closeHolePicker);
  if (els.holePickerClose) els.holePickerClose.addEventListener("click", closeHolePicker);
  if (els.bucketSheetBackdrop) els.bucketSheetBackdrop.addEventListener("click", closeScoringBucketSheet);
  if (els.bucketSheetClose) els.bucketSheetClose.addEventListener("click", closeScoringBucketSheet);
  if (els.scoringDistribution) {
    els.scoringDistribution.addEventListener("click", (event) => {
      const button = event.target.closest("[data-scoring-bucket]");
      if (!button || button.disabled) return;
      openScoringBucketSheet(button.dataset.scoringBucket);
    });
  }
  if (els.parTypeSheetBackdrop) els.parTypeSheetBackdrop.addEventListener("click", closeParTypeDetail);
  if (els.parTypeSheetClose) els.parTypeSheetClose.addEventListener("click", closeParTypeDetail);
  if (els.parStats) {
    els.parStats.addEventListener("click", (event) => {
      const button = event.target.closest("[data-par-detail]");
      if (!button) return;
      const par = Number(button.dataset.parDetail);
      if (Number.isFinite(par)) openParTypeDetail(par);
    });
  }
  // Heatmap chip handlers — course toggle + nine toggle.
  if (els.heatmapCourseChips) {
    els.heatmapCourseChips.addEventListener("click", (event) => {
      const button = event.target.closest("[data-course-key]");
      if (!button) return;
      setHeatmapCourse(button.dataset.courseKey, button.dataset.repId, getFilteredRounds());
    });
  }
  if (els.heatmapNineChips) {
    els.heatmapNineChips.addEventListener("click", (event) => {
      const button = event.target.closest("[data-nine]");
      if (!button) return;
      setHeatmapNine(button.dataset.nine, getFilteredRounds());
    });
  }
  // Heatmap cell tap → drill-down sheet (delegated so we don't have to re-wire
  // every render).
  if (els.heatmapGrid) {
    els.heatmapGrid.addEventListener("click", (event) => {
      const cell = event.target.closest("[data-physical-id]");
      if (!cell || cell.classList.contains("tier-empty")) return;
      openHeatmapDrilldown(cell.dataset.physicalId);
    });
  }
  if (els.heatmapDrilldownBackdrop) els.heatmapDrilldownBackdrop.addEventListener("click", closeHeatmapDrilldown);
  if (els.heatmapDrilldownClose) els.heatmapDrilldownClose.addEventListener("click", closeHeatmapDrilldown);
  if (els.roundDetailBackdrop) els.roundDetailBackdrop.addEventListener("click", closeRoundDetail);
  if (els.roundDetailClose) els.roundDetailClose.addEventListener("click", closeRoundDetail);
  if (els.holePickerList) {
    els.holePickerList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-jump-hole]");
      if (!button) return;
      const index = Number(button.dataset.jumpHole);
      if (Number.isFinite(index)) {
        setActiveCardIndex(index);
        closeHolePicker();
      }
    });
  }
  if (els.roundLiveSummary) {
    els.roundLiveSummary.addEventListener("click", (event) => {
      const card = event.target.closest("[data-stat-drill]");
      if (card) openStatDrillSheet(card.dataset.statDrill);
    });
    els.roundLiveSummary.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const card = event.target.closest("[data-stat-drill]");
      if (!card) return;
      event.preventDefault();
      openStatDrillSheet(card.dataset.statDrill);
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (els.holePickerOverlay && !els.holePickerOverlay.hidden) closeHolePicker();
      if (els.bucketSheetOverlay && !els.bucketSheetOverlay.hidden) closeScoringBucketSheet();
      if (els.filtersSheetOverlay && !els.filtersSheetOverlay.hidden) closeFiltersSheet();
      if (els.heatmapDrilldownOverlay && !els.heatmapDrilldownOverlay.hidden) closeHeatmapDrilldown();
      if (els.parTypeSheetOverlay && !els.parTypeSheetOverlay.hidden) closeParTypeDetail();
    }
  });

  if (els.headerActionsToggle && els.headerActions && els.headerActionsList) {
    function closeHeaderActions() {
      els.headerActions.classList.remove("open");
      els.headerActionsToggle.setAttribute("aria-expanded", "false");
    }
    function openHeaderActions() {
      els.headerActions.classList.add("open");
      els.headerActionsToggle.setAttribute("aria-expanded", "true");
    }
    els.headerActionsToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (els.headerActions.classList.contains("open")) {
        closeHeaderActions();
      } else {
        openHeaderActions();
      }
    });
    els.headerActionsList.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest("button, label, input")) {
        // Let the action's own handler run, then close on next tick.
        setTimeout(closeHeaderActions, 60);
      }
    });
    document.addEventListener("click", (event) => {
      if (!els.headerActions.contains(event.target)) closeHeaderActions();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && els.headerActions.classList.contains("open")) {
        closeHeaderActions();
        els.headerActionsToggle.focus();
      }
    });
  }

  [els.filterCourse, els.filterTee, els.filterWindow, els.filterTag].filter(Boolean).forEach((control) => {
    control.addEventListener("change", () => {
      const rounds = getFilteredRounds();
      renderMetrics(rounds);
      renderHomeInsights(rounds);
      renderTrend(rounds);
      renderCourseStats(rounds);
      renderDeerwoodByNine(rounds);
      renderParStats(rounds);
      renderHeatmap(rounds);
      renderHandicapPanel();
      updateFiltersButtonState();
    });
  });

  document.querySelectorAll("[data-tab-target]").forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tabTarget));
  });

  els.roundForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const course = getSelectedRoundCourse();
      if (!course) throw new Error("Add a course before saving a round.");
      const holes = readScorecard(true);
      ensureSavedCourse(course);
      const note = els.roundNote.value.trim();
      const date = els.roundDate.value || today;
      // Snapshot the survey draft. surveyHasContent guard means an untouched
      // survey gets stored as a no-op empty shape — fine, just never surfaces.
      const surveyForSave = getPendingSurvey();
      if (editingRoundId) {
        const existingIndex = state.rounds.findIndex((round) => round.id === editingRoundId);
        if (existingIndex === -1) {
          editingRoundId = null;
          throw new Error("Original round could not be found. Save again to create a new round.");
        }
        const updatedRound = makeRound({
          ...state.rounds[existingIndex],
          date,
          courseId: course.id,
          tee: course.tee,
          wind: els.roundWind ? els.roundWind.value || "" : "",
          tag: els.roundTag ? els.roundTag.value || "" : "",
          entryMode: currentEntryMode,
          note,
          survey: surveyForSave,
          holes
        });
        updatedRound.narrative = generateRoundNarrative(updatedRound, state.rounds);
        state.rounds[existingIndex] = updatedRound;
        editingRoundId = null;
        clearInProgressRound();
        resetPendingHoles(); resetReviewState();
        resetPendingSurvey(); syncSurveyUiFromState();
        if (els.surveyDetails) els.surveyDetails.open = false;
        resetRoundSetupState();
        saveState();
        updateEditModeUi();
        els.roundNote.value = "";
        if (els.roundWind) els.roundWind.value = "";
        if (els.roundTag) els.roundTag.value = "";
        resetRoundChrome();
        renderAll();
        setActiveTab("home");
        showToast("Round updated.");
      } else {
        const newRound = makeRound({
          id: makeId("round"),
          date,
          courseId: course.id,
          tee: course.tee,
          wind: els.roundWind ? els.roundWind.value || "" : "",
          tag: els.roundTag ? els.roundTag.value || "" : "",
          entryMode: currentEntryMode,
          note,
          survey: surveyForSave,
          holes
        });
        newRound.narrative = generateRoundNarrative(newRound, state.rounds);
        state.rounds.push(newRound);
        clearInProgressRound();
        resetPendingHoles(); resetReviewState();
        resetPendingSurvey(); syncSurveyUiFromState();
        if (els.surveyDetails) els.surveyDetails.open = false;
        resetRoundSetupState();
        saveState();
        els.roundNote.value = "";
        if (els.roundWind) els.roundWind.value = "";
        if (els.roundTag) els.roundTag.value = "";
        resetRoundChrome();
        renderAll();
        setActiveTab("home");
        showToast("Round saved.");
        maybeAutoBackup();
      }
    } catch (error) {
      showToast(error.message);
    }
  });

  els.courseLookupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = els.courseLookupQuery.value.trim();
    if (!query) return;
    els.courseLookupResults.innerHTML = emptyState("Searching...");
    const { results, notice } = await findCourses(query);
    renderCourseLookupResults(results, query, notice);
  });

  function applySampleData() {
    takeSnapshot("before-sample", { force: true });
    const currentGolfLab = normalizeGolfLabState(state.golfLab);
    state = {
      courses: structuredClone(sampleCourses),
      rounds: structuredClone(sampleRounds),
      profile: { bag: [...CLUB_OPTIONS] },
      golfLab: currentGolfLab
    };
    clearEditState({ rerender: false });
    clearInProgressRound();
    resetPendingHoles(); resetReviewState();
    saveState();
    renderAll();
    showToast("Sample data loaded.");
  }

  function loadSampleData() {
    const currentRounds = state.rounds.length;
    if (!currentRounds) {
      // No data to lose — just load. Identical to the old fast path.
      applySampleData();
      return;
    }
    openDestructiveConfirm({
      title: "Replace your data with sample data?",
      message: "Sample Data overwrites every round and course with the built-in demo set. You can roll back via Profile › Backups, but only as long as this browser keeps its storage.",
      facts: [
        `You currently have ${currentRounds} round${currentRounds === 1 ? "" : "s"}.`,
        "A snapshot will be taken before the overwrite."
      ],
      expected: currentRounds,
      confirmLabel: "Replace with sample",
      onConfirm: applySampleData
    });
  }
  els.loadSampleButton.addEventListener("click", loadSampleData);
  if (els.welcomeSampleButton) els.welcomeSampleButton.addEventListener("click", loadSampleData);

  function applyClearAll() {
    takeSnapshot("before-clear", { force: true });
    state = { courses: [], rounds: [], profile: { bag: [...CLUB_OPTIONS] }, golfLab: blankGolfLabState() };
    clearEditState({ rerender: false });
    clearInProgressRound();
    resetPendingHoles(); resetReviewState();
    saveState();
    renderAll();
    showToast("Data cleared.");
  }

  if (els.clearButton) els.clearButton.addEventListener("click", () => {
    const currentRounds = state.rounds.length;
    const currentCourses = state.courses.length;
    openDestructiveConfirm({
      title: "Clear all data?",
      message: "Erases every round and every course in this browser. The course catalog will reload from defaults on the next refresh.",
      facts: [
        `${currentRounds} round${currentRounds === 1 ? "" : "s"} will be deleted.`,
        `${currentCourses} course${currentCourses === 1 ? "" : "s"} will be deleted.`,
        "A snapshot will be taken before the wipe — restore from Profile › Backups."
      ],
      expected: currentRounds > 0 ? currentRounds : null,
      confirmLabel: currentRounds > 0 ? "Clear all data" : "Clear",
      onConfirm: applyClearAll
    });
  });

  if (els.snapshotTakeButton) {
    els.snapshotTakeButton.addEventListener("click", () => {
      const key = takeSnapshot("manual", { force: true });
      renderSnapshotPanel();
      showToast(key ? "Snapshot saved." : "Could not save snapshot.");
    });
  }

  if (els.dangerZoneToggle && els.dangerZoneBody) {
    els.dangerZoneToggle.addEventListener("click", () => {
      const isHidden = els.dangerZoneBody.hidden;
      els.dangerZoneBody.hidden = !isHidden;
      els.dangerZoneToggle.setAttribute("aria-expanded", String(isHidden));
      els.dangerZoneToggle.textContent = isHidden ? "Hide" : "Show";
    });
  }

  function triggerBackupDownload(opts) {
    const { filenameSuffix = "", toast = "Export ready." } = opts || {};
    try {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const exportDate = new Date().toISOString().slice(0, 10);
      link.download = `fairway-ledger-${exportDate}${filenameSuffix}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      writeBackupMeta({
        lastExportAt: new Date().toISOString(),
        lastExportRoundCount: state.rounds.length
      });
      updateBackupBadge();
      if (toast) showToast(toast);
      renderSnapshotPanel();
      return true;
    } catch (err) {
      console.warn("backup download failed", err);
      return false;
    }
  }

  els.exportButton.addEventListener("click", () => triggerBackupDownload());

  // Auto-backup: after a NEW round is saved (not an edit), if the user has
  // ≥AUTO_BACKUP_ROUND_THRESHOLD unbacked rounds, trigger an export download.
  // Must run inside the round-save submit handler's call stack so iOS Safari
  // accepts it as a user-gesture-initiated download.
  function maybeAutoBackup() {
    const unbacked = unbackedRoundCount();
    if (unbacked < AUTO_BACKUP_ROUND_THRESHOLD) return;
    triggerBackupDownload({
      filenameSuffix: "-auto",
      toast: `Auto-backup downloaded (${unbacked} unbacked rounds). Check Downloads.`
    });
  }

  function applyImport(imported) {
    takeSnapshot("before-import", { force: true });
    imported.rounds = imported.rounds.map(normalizeRound);
    state = ensureGolfLabShape(ensureDeerwoodRoundLabels(ensureProfileShape(ensureCourseDataShape(mergeNewDefaultCourses(imported)))));
    clearEditState({ rerender: false });
    const previousMeta = readBackupMeta();
    writeBackupMeta({
      lastExportAt: previousMeta.lastExportAt,
      lastExportRoundCount: state.rounds.length
    });
    saveState();
    renderAll();
    showToast("Import complete.");
  }

  els.importInput.addEventListener("change", () => {
    const file = els.importInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (!imported || !Array.isArray(imported.courses) || !Array.isArray(imported.rounds)) {
          throw new Error("That file is not a Fairway Ledger export.");
        }
        // Run imports through the same migration pipeline as loadState
        // so older exports pick up new Deerwood layouts, hazards arrays,
        // round-shape normalization (wind, narrative, firstPuttDistance,
        // etc.) — anything the rest of the app assumes exists.
        const currentRounds = state.rounds.length;
        const incomingRounds = imported.rounds.length;
        const incomingCourses = imported.courses.length;
        if (currentRounds === 0) {
          // No data to lose — apply immediately. Same fast path as the old
          // import flow when starting from an empty state.
          applyImport(imported);
          return;
        }
        openDestructiveConfirm({
          title: "Replace your data with this file?",
          message: `Import overwrites everything currently in the app with the contents of ${file.name}.`,
          facts: [
            `You currently have ${currentRounds} round${currentRounds === 1 ? "" : "s"}.`,
            `The file has ${incomingRounds} round${incomingRounds === 1 ? "" : "s"} and ${incomingCourses} course${incomingCourses === 1 ? "" : "s"}.`,
            "A snapshot of the current data will be taken before the import."
          ],
          expected: currentRounds,
          confirmLabel: "Replace with file",
          onConfirm: () => applyImport(imported)
        });
      } catch (error) {
        showToast(error.message);
      } finally {
        els.importInput.value = "";
      }
    };
    reader.readAsText(file);
  });

  if (els.golfLabRunModel) {
    els.golfLabRunModel.addEventListener("click", () => {
      runGolfLabOwnedModel();
    });
  }

  if (els.golfLabTemplateButton) {
    els.golfLabTemplateButton.addEventListener("click", () => {
      downloadGolfLabTemplate();
    });
  }

  if (els.golfLabExportButton) {
    els.golfLabExportButton.addEventListener("click", () => {
      downloadGolfLabExport();
    });
  }

  if (els.golfLabResearchPacketButton) {
    els.golfLabResearchPacketButton.addEventListener("click", () => {
      downloadGolfLabResearchPacket();
    });
  }

  if (els.golfLabActivationPacketButton) {
    els.golfLabActivationPacketButton.addEventListener("click", () => {
      downloadGolfLabActivationPacket();
    });
  }

  if (els.golfLabDataIntakePacketButton) {
    els.golfLabDataIntakePacketButton.addEventListener("click", () => {
      downloadGolfLabDataIntakePacket();
    });
  }

  if (els.golfLabBackfillPacketButton) {
    els.golfLabBackfillPacketButton.addEventListener("click", () => {
      downloadGolfLabBackfillPacket();
    });
  }

  if (els.golfLabModelEventSelect) {
    els.golfLabModelEventSelect.addEventListener("change", () => {
      const lab = normalizeGolfLabState(state.golfLab);
      const warehouseReport = typeof buildWarehouseReport === "function" ? buildWarehouseReport(lab) : null;
      renderGolfLabCommandCenter(lab, warehouseReport);
      renderGolfLabActivationPlan(lab);
      renderGolfLabSourceLineageBoard(lab);
      renderGolfLabSourceOpsBoard(lab);
      renderGolfLabDataIntakeBoard(lab);
      renderGolfLabSourceCatalogBoard(lab);
      renderGolfLabSourcePlan(lab);
      renderGolfLabPlayerIdentityBoard(lab);
      renderGolfLabCourseSetupBoard(lab);
      renderGolfLabPlayerSplitLab(lab);
      renderGolfLabFeatureStoreBoard(lab);
      renderGolfLabTournamentBoard(lab);
      renderGolfLabPredictionPrepBoard(lab);
      renderGolfLabPlayerIndexBoard(lab);
      renderGolfLabPlayerScorecard(lab, selectedGolfLabPlayerId);
      renderGolfLabFitBoard(lab);
      renderGolfLabFieldReadinessBoard(lab);
      renderGolfLabFieldIntelligenceBoard(lab);
      renderGolfLabScenarioBoard(lab);
      renderGolfLabWeatherMatrixBoard(lab);
      renderGolfLabWeatherDrawBoard(lab);
      renderGolfLabCourseCompBoard(lab);
      renderGolfLabPredictionRunAuditBoard(lab);
      renderGolfLabMarketCoverageBoard(lab);
      renderGolfLabOddsMovementBoard(lab);
      renderGolfLabEdgeBoard(lab);
      renderGolfLabBetPortfolioBoard(lab);
      renderGolfLabProjectedStandingsBoard(lab);
      renderGolfLabResultsSummaryBoard(lab);
      renderGolfLabModelExplainerBoard(lab);
      renderGolfLabSettlementBoard(lab);
      renderGolfLabModelCalibrationBoard(lab);
    });
  }

  if (els.golfLabModelPreset) {
    els.golfLabModelPreset.addEventListener("change", () => {
      updateGolfLabModelSettings({ preset: els.golfLabModelPreset.value });
      setGolfLabModelStatus(`${getGolfLabModelPreset().label} profile selected.`);
    });
  }

  if (els.golfLabMarketFilter) {
    els.golfLabMarketFilter.addEventListener("change", () => {
      updateGolfLabModelSettings({ marketFilter: els.golfLabMarketFilter.value });
    });
  }

  if (els.golfLabWeatherScenario) {
    els.golfLabWeatherScenario.addEventListener("change", () => {
      updateGolfLabModelSettings({ weatherScenario: els.golfLabWeatherScenario.value });
      setGolfLabModelStatus(`${getGolfLabWeatherScenarioLabel()} scenario selected.`);
    });
  }

  if (els.golfLabEdgeThreshold) {
    els.golfLabEdgeThreshold.addEventListener("input", () => {
      updateGolfLabModelSettings({ edgeThreshold: els.golfLabEdgeThreshold.value });
    });
  }

  if (els.golfLabGradePredictions) {
    els.golfLabGradePredictions.addEventListener("click", () => {
      gradeGolfLabPredictions();
    });
  }

  if (els.golfLabPlayerSelect) {
    els.golfLabPlayerSelect.addEventListener("change", () => {
      selectedGolfLabPlayerId = els.golfLabPlayerSelect.value;
      renderGolfLabPlayerScorecard(normalizeGolfLabState(state.golfLab), selectedGolfLabPlayerId);
    });
  }

  if (els.golfLabPlayerIndexBoard) {
    els.golfLabPlayerIndexBoard.addEventListener("click", (event) => {
      const row = event.target.closest("[data-golf-lab-player-index-id]");
      if (!row) return;
      selectedGolfLabPlayerId = row.dataset.golfLabPlayerIndexId;
      if (els.golfLabPlayerSelect) els.golfLabPlayerSelect.value = selectedGolfLabPlayerId;
      renderGolfLabPlayerScorecard(normalizeGolfLabState(state.golfLab), selectedGolfLabPlayerId);
    });
  }

  if (els.golfLabCourseSelect) {
    els.golfLabCourseSelect.addEventListener("change", () => {
      selectedGolfLabCourseId = els.golfLabCourseSelect.value;
      const lab = normalizeGolfLabState(state.golfLab);
      renderGolfLabCourseScorecard(lab, selectedGolfLabCourseId);
      renderGolfLabCourseSetupBoard(lab);
      renderGolfLabCourseCompBoard(lab);
    });
  }

  if (els.golfLabCourseDifficultyBoard) {
    els.golfLabCourseDifficultyBoard.addEventListener("click", (event) => {
      const row = event.target.closest("[data-golf-lab-course-difficulty-id]");
      if (!row) return;
      selectedGolfLabCourseId = row.dataset.golfLabCourseDifficultyId;
      if (els.golfLabCourseSelect) els.golfLabCourseSelect.value = selectedGolfLabCourseId;
      renderGolfLabCourseScorecard(normalizeGolfLabState(state.golfLab), selectedGolfLabCourseId);
    });
  }

  if (els.golfLabImportInput) {
    els.golfLabImportInput.addEventListener("change", async () => {
      try {
        await applyGolfLabImportFiles(els.golfLabImportInput.files);
      } catch (error) {
        showToast(error.message);
      } finally {
        els.golfLabImportInput.value = "";
      }
    });
  }

  async function initializeApp() {
    sampleCourses = await loadCourseCatalog();
    sampleRounds = buildSampleRounds();
    state = loadState();
    // Set up chip mirrors over the round-setup selects before renderAll
    // runs so the very first paint shows chips, not (now-hidden) selects
    // with a layout gap.
    initSelectChips();
    renderAll();
    setActiveTab(localStorage.getItem(ACTIVE_TAB_KEY) || "home");
    // Offer to restore any in-progress round entry that was interrupted
    // (page reload, phone restart, accidental tab close, etc).
    maybeResumeInProgressRound();
  }

  initializeApp();
})();
