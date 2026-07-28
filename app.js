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
    haversineMeters,
    metersToYards,
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
  const { validateRecap, decodeVoiceRecapFragment, VOICE_RECAP_FRAGMENT_KEY, voiceRecapNeedsFreshStoreConfirmation } = window.FairwayVoiceRecap;

  const VoiceRecap = window.FairwayVoiceRecap;

  const {
    classifyAccuracy,
    cloneShot,
    normalizeShots,
    requestPosition
  } = window.FairwayGps;

  const STORAGE_KEY = "fairwayLedger.v1";
  const ACTIVE_TAB_KEY = "fairwayLedger.activeTab";
  const BACKUP_META_KEY = "fairwayLedger.backupMeta.v1";
  const BRIEF_COLLAPSED_KEY = "fairwayLedger.briefCollapsed.v1";
  const VIEW_MODE_KEY = "fairwayLedger.viewMode.v1";
  const IN_PROGRESS_KEY = "fairwayLedger.inProgressRound.v1";
  const VOICE_DRAFT_CONFIG_KEY = "fairwayLedger.voiceDraft.config.v1";
  const VOICE_DRAFT_SESSION_KEY = "fairwayLedger.voiceDraft.session.v1";
  const VOICE_DRAFT_APPLIED_KEY = "fairwayLedger.voiceDraft.applied.v1";
  // Browser-safe Supabase connection defaults. These are intentionally
  // public client values; the ingest and service-role secrets never ship.
  const VOICE_DRAFT_DEFAULT_CONFIG = Object.freeze({
    projectUrl: "https://vodtsentyuehvddattkf.supabase.co",
    anonKey: "sb_publishable_Rc0PiwsLZZyccib95d9jAA_qyGpCA5W"
  });
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

  let sampleCourses = [];
  let selectedCourseDetailId = null;
  let editingRoundId = null;
  let viewMode = readInitialViewMode();
  let courseMapController = null;

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
  let gpsCaptureGeneration = 0;

  function resetPendingHoles() {
    pendingHoles = {};
    // Invalidate any geolocation request that was started for the previous
    // round/setup so a late device response cannot populate a fresh round.
    gpsCaptureGeneration += 1;
    if (courseMapController) courseMapController.clearTargets();
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
      && !(entry.shots && entry.shots.length)
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

  // ---- GPS-tracked shots -------------------------------------------------

  function getHoleShots(holeNumber) {
    const entry = pendingHoles[String(holeNumber)];
    return entry && Array.isArray(entry.shots) ? entry.shots.map(cloneShot) : [];
  }

  function setHoleShots(holeNumber, shots) {
    const entry = getOrCreatePendingHole(holeNumber);
    const normalized = normalizeShots(shots);
    if (normalized.length) entry.shots = normalized;
    else delete entry.shots;
    compactPendingHole(holeNumber);
    if (courseMapController && courseMapController.isOpen()) courseMapController.refresh();
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
  let pendingVoiceRecap = null;
  let state = {
    courses: [],
    rounds: [],
    profile: { bag: [] },
    mapAnnotations: null,
    mapAnnotationSeedState: null
  };

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
    voiceDraftInbox: document.getElementById("voiceDraftInbox"),
    voiceDraftProjectUrl: document.getElementById("voiceDraftProjectUrl"),
    voiceDraftAnonKey: document.getElementById("voiceDraftAnonKey"),
    voiceDraftEmail: document.getElementById("voiceDraftEmail"),
    voiceDraftSaveSettings: document.getElementById("voiceDraftSaveSettings"),
    voiceDraftRefresh: document.getElementById("voiceDraftRefresh"),
    voiceDraftStatus: document.getElementById("voiceDraftStatus"),
    voiceDraftIdentity: document.getElementById("voiceDraftIdentity"),
    voiceDraftOverlay: document.getElementById("voiceDraftOverlay"),
    voiceDraftBackdrop: document.getElementById("voiceDraftBackdrop"),
    voiceDraftClose: document.getElementById("voiceDraftClose"),
    voiceDraftTitle: document.getElementById("voiceDraftTitle"),
    voiceDraftBody: document.getElementById("voiceDraftBody"),
    voiceDraftApply: document.getElementById("voiceDraftApply"),
    voiceDraftArchive: document.getElementById("voiceDraftArchive"),
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
    voiceRecapInput: document.getElementById("voiceRecapInput"),
    voiceRecapPreview: document.getElementById("voiceRecapPreview"),
    voiceRecapApply: document.getElementById("voiceRecapApply"),
    voiceRecapPreviewOutput: document.getElementById("voiceRecapPreviewOutput"),
    voiceRecapStorageNotice: document.getElementById("voiceRecapStorageNotice"),
    voiceRecapFreshStoreConfirm: document.getElementById("voiceRecapFreshStoreConfirm"),
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
    roundForm: document.getElementById("roundForm"),
    resetRoundButton: document.getElementById("resetRoundButton"),
    viewToggleButton: document.getElementById("viewToggleButton"),
    courseMapButton: document.getElementById("courseMapButton"),
    roundEntryTitle: document.getElementById("roundEntryTitle"),
    roundSubmitButton: document.getElementById("roundSubmitButton"),
    scorecardGrid: document.getElementById("scorecardGrid"),
    quickStartSlot: document.getElementById("quickStartSlot"),
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
    courseMapOverlay: document.getElementById("courseMapOverlay"),
    courseMapBackdrop: document.getElementById("courseMapBackdrop"),
    courseMapClose: document.getElementById("courseMapClose"),
    courseMapTitle: document.getElementById("courseMapTitle"),
    courseMapHole: document.getElementById("courseMapHole"),
    courseMapLocate: document.getElementById("courseMapLocate"),
    courseMapZoomOut: document.getElementById("courseMapZoomOut"),
    courseMapFit: document.getElementById("courseMapFit"),
    courseMapZoomIn: document.getElementById("courseMapZoomIn"),
    courseMapViewport: document.getElementById("courseMapViewport"),
    courseMapStage: document.getElementById("courseMapStage"),
    courseMapImage: document.getElementById("courseMapImage"),
    courseMapSvg: document.getElementById("courseMapSvg"),
    courseMapTargetSummary: document.getElementById("courseMapTargetSummary"),
    courseMapStatus: document.getElementById("courseMapStatus"),
    courseMapClearTarget: document.getElementById("courseMapClearTarget"),
    courseMapAttribution: document.getElementById("courseMapAttribution"),
    courseMapEdit: document.getElementById("courseMapEdit"),
    courseMapEditor: document.getElementById("courseMapEditor"),
    courseMapFeatureType: document.getElementById("courseMapFeatureType"),
    courseMapFeatureLabel: document.getElementById("courseMapFeatureLabel"),
    courseMapEditorHint: document.getElementById("courseMapEditorHint"),
    courseMapUndoVertex: document.getElementById("courseMapUndoVertex"),
    courseMapResetDraft: document.getElementById("courseMapResetDraft"),
    courseMapCancelEdit: document.getElementById("courseMapCancelEdit"),
    courseMapSaveFeature: document.getElementById("courseMapSaveFeature"),
    courseMapDeleteFeature: document.getElementById("courseMapDeleteFeature"),
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
        return ensureDeerwoodRoundLabels(ensureProfileShape(ensureCourseDataShape(mergeNewDefaultCourses(saved))));
      }
    } catch (error) {
      console.warn("Could not load saved golf data", error);
    }
    // First launch: ship with the course catalog but no sample rounds.
    // The header's "Sample data" button still loads the sample rounds for
    // anyone who wants to poke at populated UI without playing a round.
    // Showing strangers Jeff's test scores on first open is the previous
    // behavior we deliberately ditched.
    return ensureProfileShape(ensureCourseDataShape({
      courses: structuredClone(sampleCourses),
      rounds: []
    }));
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

  function getCourseMapLabelsApi() {
    return window.FairwayCourseMapLabels && typeof window.FairwayCourseMapLabels.normalizeCollection === "function"
      ? window.FairwayCourseMapLabels
      : null;
  }

  function getDeerwoodAerialLabels() {
    return window.FairwayDeerwoodAerialLabels
      && window.FairwayDeerwoodAerialLabels.dataset === "deerwood-aerial-observations-v1"
      ? window.FairwayDeerwoodAerialLabels
      : null;
  }

  const EMPTY_COURSE_MAP_ANNOTATIONS = Object.freeze({
    type: "FeatureCollection",
    dataset: "deerwood-user-map-v1",
    coordinateSystem: "WGS84",
    mapId: "deerwood-aerial-2024",
    mapSha256: "5FD178E66F235E7712E231DA2AC42BF466914BD889A2535875461D1CB9A1478A",
    legacyHazardDataUsed: false
  });

  const EMPTY_COURSE_MAP_SEED_STATE = Object.freeze({
    dataset: "deerwood-aerial-observations-suppressions-v1",
    mapId: "deerwood-aerial-2024",
    mapSha256: "5FD178E66F235E7712E231DA2AC42BF466914BD889A2535875461D1CB9A1478A"
  });

  function createEmptyCourseMapAnnotations() {
    const labelsApi = getCourseMapLabelsApi();
    return labelsApi && typeof labelsApi.createEmptyCollection === "function"
      ? labelsApi.createEmptyCollection()
      : { ...EMPTY_COURSE_MAP_ANNOTATIONS, features: [] };
  }

  function normalizeCourseMapAnnotations(value) {
    const labelsApi = getCourseMapLabelsApi();
    if (labelsApi) return labelsApi.normalizeCollection(value);
    // If the optional module misses one load, preserve only its already-pinned
    // opaque dataset. The label UI stays disabled, so nothing is interpreted;
    // a later successful load runs the strict feature-by-feature normalizer.
    if (value
      && typeof value === "object"
      && !Array.isArray(value)
      && value.type === EMPTY_COURSE_MAP_ANNOTATIONS.type
      && value.dataset === EMPTY_COURSE_MAP_ANNOTATIONS.dataset
      && value.coordinateSystem === EMPTY_COURSE_MAP_ANNOTATIONS.coordinateSystem
      && value.mapId === EMPTY_COURSE_MAP_ANNOTATIONS.mapId
      && value.mapSha256 === EMPTY_COURSE_MAP_ANNOTATIONS.mapSha256
      && value.legacyHazardDataUsed === false
      && Array.isArray(value.features)
      && !Object.prototype.hasOwnProperty.call(value, "hazards")
      && !Object.prototype.hasOwnProperty.call(value, "legacyHazards")) {
      return structuredClone(value);
    }
    return createEmptyCourseMapAnnotations();
  }

  function createEmptyCourseMapSeedState() {
    const labelsApi = getCourseMapLabelsApi();
    return labelsApi && typeof labelsApi.createEmptySeedState === "function"
      ? labelsApi.createEmptySeedState()
      : { ...EMPTY_COURSE_MAP_SEED_STATE, hiddenFeatureIds: [] };
  }

  function normalizeCourseMapSeedState(value) {
    const labelsApi = getCourseMapLabelsApi();
    if (labelsApi && typeof labelsApi.normalizeSeedState === "function") {
      return labelsApi.normalizeSeedState(value);
    }
    if (value
      && typeof value === "object"
      && !Array.isArray(value)
      && value.dataset === EMPTY_COURSE_MAP_SEED_STATE.dataset
      && value.mapId === EMPTY_COURSE_MAP_SEED_STATE.mapId
      && value.mapSha256 === EMPTY_COURSE_MAP_SEED_STATE.mapSha256
      && Array.isArray(value.hiddenFeatureIds)) {
      return structuredClone(value);
    }
    return createEmptyCourseMapSeedState();
  }

  function ensureCourseDataShape(stateValue) {
    if (!stateValue || !Array.isArray(stateValue.courses)) return stateValue;
    stateValue.mapAnnotations = normalizeCourseMapAnnotations(stateValue.mapAnnotations);
    stateValue.mapAnnotationSeedState = normalizeCourseMapSeedState(stateValue.mapAnnotationSeedState);
    stateValue.courses.forEach((course) => {
      if (!Array.isArray(course.holes)) return;
      const rejectLegacyHazards = course.id === DEERWOOD_COURSE_ID || isDeerwoodCourseId(course.id);
      course.holes.forEach((hole) => {
        // Absolute quarantine: old Deerwood hazard notes are not retained in
        // normalized state, snapshots restored into state, or imported data.
        if (rejectLegacyHazards) {
          hole.hazards = [];
          return;
        }
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
      // Deerwood hazards have already been scrubbed by ensureCourseDataShape;
      // never propagate hazard data across its tee/layout variants.
      if (group.some((course) => isDeerwoodCourseId(course.id))) return;
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
    // Refresh Deerwood from the catalog so layout/par/yardage updates land on
    // returning users. Rejected hazards are intentionally not copied forward.
    const defaultDeerwoodCourses = sampleCourses.filter((course) => isDeerwoodCourseId(course.id));
    const defaultDeerwoodById = new Map(defaultDeerwoodCourses.map((course) => [course.id, course]));
    const updatedCourses = saved.courses.map((course) => {
      if (!defaultDeerwoodById.has(course.id)) return course;
      return structuredClone(defaultDeerwoodById.get(course.id));
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
      // The per-round entry mode override travels with the draft — a speed
      // round that gets evicted mid-loop must not resume as a detail wall.
      entryMode: currentEntryMode,
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
        const holeShots = {};
        Object.entries(pendingHoles).forEach(([key, data]) => {
          if (data.note) holeNotes[key] = data.note;
          if (data.clubs && data.clubs.length) holeClubs[key] = [...data.clubs];
          if (data.shots && data.shots.length) holeShots[key] = normalizeShots(data.shots);
          // Write the canonical array form. Legacy drafts wrote a single
          // string under the same key — restore handles both shapes.
          if (Array.isArray(data.penaltyClubs) && data.penaltyClubs.length) {
            holePenaltyClubs[key] = data.penaltyClubs.slice();
          } else if (data.penaltyClub) {
            holePenaltyClubs[key] = [data.penaltyClub];
          }
        });
        return { holeNotes, holeClubs, holePenaltyClubs, holeShots };
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
      const hasShots = Object.values(draft.holeShots || {}).some((shots) => Array.isArray(shots) && shots.length > 0);
      // Note: clubs are intentionally NOT a "started a round" signal — they're
      // pre-seeded with Driver/Putter defaults, so counting them would flag a
      // round in progress before the user has actually entered anything.
      if (!hasScores && !hasNotes && !hasShots) {
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
    if (data.entryMode === "speed" || data.entryMode === "detailed") {
      setCurrentEntryMode(data.entryMode);
    }
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
    Object.entries(data.holeShots || {}).forEach(([num, shots]) => {
      if (Array.isArray(shots) && shots.length) setHoleShots(Number(num), shots);
    });
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

  // After a restore, land the card view on the hole play actually left off
  // at — not Hole 1. All holes scored → land on the last card (next stop is
  // Review & save).
  function jumpToFirstUnscoredCard() {
    const stack = els.scorecardGrid.querySelector(".scorecard-cards");
    if (!stack) return;
    const cards = [...stack.querySelectorAll(".scorecard-card")];
    if (!cards.length) return;
    const idx = cards.findIndex((card) => {
      const input = card.querySelector(".score-input");
      return input instanceof HTMLInputElement && input.value.trim() === "";
    });
    const target = idx === -1 ? cards.length - 1 : idx;
    if (target > 0) setActiveCardIndex(target);
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
    const shotCount = Object.values(data.holeShots || {}).reduce((sum, shots) => sum + (Array.isArray(shots) ? shots.length : 0), 0);
    if (!scoreCount && !noteCount && !shotCount) {
      clearInProgressRound();
      return;
    }
    // A round saved in the last 12 hours IS today's round — iOS evicts the
    // PWA constantly during a 4-hour loop, and every relaunch used to route
    // through a native confirm whose Cancel button permanently discarded
    // the draft. Same-day drafts now restore themselves; the phone waking
    // up mid-round goes straight back to the hole you're standing on.
    const ageMs = data.savedAt ? Date.now() - data.savedAt : Infinity;
    const FRESH_DRAFT_MS = 12 * 60 * 60 * 1000;
    if (ageMs < FRESH_DRAFT_MS) {
      restoreInProgressRound(data);
      jumpToFirstUnscoredCard();
      showToast(`Resumed your round — ${scoreCount} hole${scoreCount === 1 ? "" : "s"} scored.`);
      return;
    }
    // Older drafts still ask — but Cancel only postpones. Discarding is an
    // explicit act (the Reset button), never the default button of a dialog.
    const parts = [];
    if (scoreCount) parts.push(`${scoreCount} hole${scoreCount === 1 ? "" : "s"} scored`);
    if (noteCount) parts.push(`${noteCount} note${noteCount === 1 ? "" : "s"}`);
    if (shotCount) parts.push(`${shotCount} GPS shot${shotCount === 1 ? "" : "s"}`);
    const days = Math.floor(ageMs / 86400000);
    const ageLabel = ageMs === Infinity ? "" : days >= 1
      ? ` from ${days} day${days === 1 ? "" : "s"} ago`
      : ` from ${Math.floor(ageMs / 3600000)} hr ago`;
    const ok = window.confirm(
      `Resume the unfinished round${ageLabel}?\n\n${parts.join(", ")}.\n\nOK resumes it. Cancel keeps it for later — nothing is deleted.`
    );
    if (ok) {
      restoreInProgressRound(data);
      jumpToFirstUnscoredCard();
      showToast("Resumed round in progress.");
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
        label: `${deerwoodNineLabels[nineId]} ${hole.number}`,
        // Hard quarantine: the old hand-entered mapping is not a trusted
        // geographic source. Verified GeoJSON will replace it.
        hazards: []
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

  // Voice systems should send a course object rather than trying to infer the
  // app's generated Deerwood route ids. This resolver turns that compact
  // description into the exact same course object used by manual entry.
  function resolveVoiceRecapCourse(input) {
    const descriptor = input.course || (input.courseId ? { id: input.courseId, tee: input.tee } : null);
    if (!descriptor || typeof descriptor !== "object") throw new Error("Include course.id in the recap.");
    const id = String(descriptor.id || "");
    if (id === DEERWOOD_COURSE_ID) {
      const tee = DEERWOOD_TEE_OPTIONS.includes(descriptor.tee) ? descriptor.tee : "White";
      if (descriptor.nine) {
        if (!DEERWOOD_NINE_IDS.includes(descriptor.nine)) throw new Error("Deerwood nine must be buck, doe, or fawn.");
        return buildDeerwoodCourse("9", descriptor.nine, tee);
      }
      const front = descriptor.frontNine || "buck";
      const back = descriptor.backNine || "doe";
      if (!DEERWOOD_NINE_IDS.includes(front) || !DEERWOOD_NINE_IDS.includes(back)) throw new Error("Deerwood frontNine and backNine must be buck, doe, or fawn.");
      return buildDeerwoodCourse("18", `${front}-${back}`, tee);
    }
    const course = getCourse(id);
    if (!course) throw new Error(`Course '${id}' was not found. Use a course.id from the Courses list.`);
    return course;
  }

  function syncVoiceRecapApplyState() {
    if (!els.voiceRecapApply) return;
    const needsConfirmation = pendingVoiceRecap && pendingVoiceRecap.needsFreshStoreConfirmation;
    els.voiceRecapApply.disabled = !pendingVoiceRecap || (needsConfirmation && (!els.voiceRecapFreshStoreConfirm || !els.voiceRecapFreshStoreConfirm.checked));
  }

  function renderVoiceRecapStorageNotice() {
    if (!els.voiceRecapStorageNotice || !els.voiceRecapFreshStoreConfirm) return;
    const show = !!(pendingVoiceRecap && pendingVoiceRecap.needsFreshStoreConfirmation);
    els.voiceRecapStorageNotice.hidden = !show;
    els.voiceRecapFreshStoreConfirm.checked = false;
  }

  function previewVoiceRecapPayload(input, options = {}) {
    if (!els.voiceRecapPreviewOutput) return;
    pendingVoiceRecap = null;
    if (els.voiceRecapApply) els.voiceRecapApply.disabled = true;
    try {
      const course = resolveVoiceRecapCourse(input);
      const recap = validateRecap(input, course);
      const round = makeRound({ id: "__voice_recap_preview__", date: recap.date, courseId: course.id, tee: course.tee, wind: recap.wind || "", tag: recap.tag || "", note: recap.note || "", coaching: recap.coaching, entryMode: "detailed", holes: recap.holes.map(makeHole) });
      const totals = roundTotals(round);
      pendingVoiceRecap = { course, recap, round, needsFreshStoreConfirmation: !!options.fromVoiceLink && voiceRecapNeedsFreshStoreConfirmation(state.rounds.length) };
      els.voiceRecapPreviewOutput.innerHTML = `<strong>Ready to add:</strong> ${escapeHtml(course.name)} · ${escapeHtml(recap.date)} · ${totals.gross} (${formatSigned(totals.toPar, 0)}) across ${recap.holes.length} holes.`;
      renderVoiceRecapStorageNotice();
      syncVoiceRecapApplyState();
    } catch (error) {
      els.voiceRecapPreviewOutput.textContent = error.message || "That recap could not be read.";
    }
  }

  function previewVoiceRecap() {
    if (!els.voiceRecapInput) return;
    try { previewVoiceRecapPayload(JSON.parse(els.voiceRecapInput.value)); }
    catch (error) {
      pendingVoiceRecap = null;
      renderVoiceRecapStorageNotice();
      if (els.voiceRecapApply) els.voiceRecapApply.disabled = true;
      if (els.voiceRecapPreviewOutput) els.voiceRecapPreviewOutput.textContent = error.message || "That recap could not be read.";
    }
  }

  function clearVoiceRecapFragment() {
    // Fragments never leave the device in HTTP requests, but remove them as
    // soon as read so browser history and copied URLs do not retain a recap.
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }

  function loadVoiceRecapFromFragment() {
    const prefix = `#${VOICE_RECAP_FRAGMENT_KEY}=`;
    if (!location.hash.startsWith(prefix)) return false;
    const hash = location.hash;
    clearVoiceRecapFragment();
    setActiveTab("rounds");
    const importPanel = document.getElementById("voiceImport");
    if (importPanel) importPanel.open = true;
    try {
      const input = decodeVoiceRecapFragment(hash);
      if (els.voiceRecapInput) els.voiceRecapInput.value = JSON.stringify(input, null, 2);
      previewVoiceRecapPayload(input, { fromVoiceLink: true });
      showToast("Voice recap ready to review.");
    } catch (error) {
      pendingVoiceRecap = null;
      renderVoiceRecapStorageNotice();
      if (els.voiceRecapApply) els.voiceRecapApply.disabled = true;
      if (els.voiceRecapPreviewOutput) els.voiceRecapPreviewOutput.textContent = error.message || "Voice recap link could not be read.";
      showToast(error.message || "Voice recap link could not be read.");
    }
    return true;
  }

  function applyVoiceRecap() {
    if (!pendingVoiceRecap) return previewVoiceRecap();
    if (pendingVoiceRecap.needsFreshStoreConfirmation && (!els.voiceRecapFreshStoreConfirm || !els.voiceRecapFreshStoreConfirm.checked)) {
      showToast("Confirm this is a separate empty copy before saving here.");
      return;
    }
    const { course, recap, round } = pendingVoiceRecap;
    ensureSavedCourse(course);
    const newRound = makeRound({ ...round, id: makeId("round") });
    newRound.narrative = generateRoundNarrative(newRound, state.rounds);
    state.rounds.push(newRound);
    saveState();
    pendingVoiceRecap = null;
    renderVoiceRecapStorageNotice();
    els.voiceRecapInput.value = "";
    els.voiceRecapPreviewOutput.textContent = "Round added. Your original scorecards are unchanged.";
    els.voiceRecapApply.disabled = true;
    renderAll();
    setActiveTab("home");
    showRoundDetail(newRound);
    showToast(`Voice recap added: ${recap.date}. ${state.rounds.length} saved round${state.rounds.length === 1 ? "" : "s"} in this browser.`);
    maybeAutoBackup();
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
    // The one-tap replay card lives above the setup form — only in the
    // pre-start phase, and only when there's a last round to replay.
    renderQuickStart();
    syncWakeLock();
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

  // ---- One-tap "Play it again" quick start --------------------------------
  //
  // The blank-by-design setup form is the right default for a NEW situation,
  // but Joe replays the same course/tee constantly — standing on the first
  // tee, eight chip rows is why a paper card wins. This reconstructs the
  // most recent round's setup and starts scoring in a single tap. Wind and
  // play-type stay unset (weather changes daily; both editable from the
  // collapsed setup banner after start).

  function describeLastRoundSetup() {
    if (!state.rounds.length) return null;
    const last = [...state.rounds].sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
    if (!last || !last.courseId) return null;
    if (isDeerwoodCourseId(last.courseId)) {
      // Saved Deerwood ids encode layout + tee: deerwood-{nine[-nine]}-{tee}.
      const parts = String(last.courseId).replace("deerwood-", "").split("-");
      const teePart = parts.pop();
      const tee = DEERWOOD_TEE_OPTIONS.find((option) => option.toLowerCase() === teePart);
      const layoutId = parts.join("-");
      if (!tee || !layoutId || !parts.every((nine) => DEERWOOD_NINE_IDS.includes(nine))) return null;
      const holeCount = layoutId.includes("-") ? "18" : "9";
      const nines = parts.map((nine) => deerwoodNineLabels[nine] || nine).join("–");
      return {
        course: DEERWOOD_COURSE_ID, holeCount, layoutId, tee,
        name: "Deerwood",
        detail: `${nines} · ${tee} tees · ${holeCount} holes`
      };
    }
    const entry = getCourse(last.courseId);
    if (!entry) return null; // course no longer in catalog — nothing to replay
    const nine = (last.holes || []).length > 0 && last.holes.length <= 9;
    const firstHole = nine ? Number(last.holes[0] && last.holes[0].number) : 1;
    return {
      course: last.courseId,
      holeCount: nine ? "9" : "18",
      layoutId: nine ? (firstHole >= 10 ? "back" : "front") : "",
      tee: last.tee || "",
      name: physicalCourseName(last.courseId) || entry.name,
      detail: [
        nine ? `${firstHole >= 10 ? "Back" : "Front"} 9` : "18 holes",
        last.tee ? `${last.tee} tees` : ""
      ].filter(Boolean).join(" · ")
    };
  }

  function renderQuickStart() {
    if (!els.quickStartSlot) return;
    const show = !roundStarted && !editingRoundId;
    const setup = show ? describeLastRoundSetup() : null;
    els.quickStartSlot.hidden = !setup;
    if (!setup) { els.quickStartSlot.innerHTML = ""; return; }
    els.quickStartSlot.innerHTML = `
      <button type="button" class="quick-start-card" id="quickStartButton">
        <span class="qs-eyebrow">Play it again</span>
        <span class="qs-course">${escapeHtml(setup.name)}</span>
        <span class="qs-meta">${escapeHtml(setup.detail)}</span>
        <span class="qs-go">Start scoring →</span>
      </button>`;
    const button = els.quickStartSlot.querySelector("#quickStartButton");
    if (button) button.addEventListener("click", () => applyQuickStart(setup));
  }

  function applyQuickStart(setup) {
    // Same field order restoreInProgressRound uses — course first, then hole
    // count (which re-renders the layout options), then tee/layout.
    els.roundDate.value = today;
    els.roundCourse.value = setup.course;
    renderRoundSetupOptions();
    els.roundHoleCount.value = setup.holeCount;
    renderRoundSetupOptions();
    if (setup.course === DEERWOOD_COURSE_ID) {
      if (setup.holeCount === "9") {
        els.roundLayout.value = setup.layoutId;
      } else {
        const [front, back] = String(setup.layoutId).split("-");
        if (DEERWOOD_NINE_IDS.includes(front)) els.roundFrontNine.value = front;
        if (DEERWOOD_NINE_IDS.includes(back)) els.roundBackNine.value = back;
      }
    } else if (setup.holeCount === "9" && setup.layoutId) {
      els.roundLayout.value = setup.layoutId;
    }
    if (setup.tee) els.roundTee.value = setup.tee;
    renderRoundSetupOptions();
    SETUP_CHIP_ROW_IDS.forEach((id) => setupChipRowsTapped.add(id));
    syncAllChipsToSelects();
    startRound();
    showToast(`Round started — ${setup.name}, ${setup.detail}.`);
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
    updateCourseMapAvailability(course);
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

  // ---- Deerwood aerial course map ---------------------------------------

  function getDeerwoodCourseMapConfig() {
    return window.FairwayCourseMaps && window.FairwayCourseMaps.deerwood
      ? window.FairwayCourseMaps.deerwood
      : null;
  }

  function getPhysicalDeerwoodHoleIdentity(holeNumber) {
    const labelsApi = getCourseMapLabelsApi();
    if (!labelsApi || typeof labelsApi.holeIdentity !== "function") return null;
    const course = getSelectedRoundCourse();
    const hole = course && Array.isArray(course.holes)
      ? course.holes.find((item) => Number(item.number) === Number(holeNumber))
      : null;
    if (!hole) return null;
    const holeLabel = typeof hole.label === "string" && hole.label.trim()
      ? hole.label.trim()
      : `Hole ${holeNumber}`;
    const holeId = labelsApi.holeIdentity({ label: holeLabel });
    return holeId ? { holeId, holeLabel } : null;
  }

  function ensureCourseMapController() {
    if (courseMapController) return courseMapController;
    const config = getDeerwoodCourseMapConfig();
    if (!config || !window.FairwayCourseMap || !window.FairwayCourseMapUi) return null;
    const mapElements = {
      overlay: els.courseMapOverlay,
      backdrop: els.courseMapBackdrop,
      close: els.courseMapClose,
      title: els.courseMapTitle,
      hole: els.courseMapHole,
      locate: els.courseMapLocate,
      zoomOut: els.courseMapZoomOut,
      fit: els.courseMapFit,
      zoomIn: els.courseMapZoomIn,
      viewport: els.courseMapViewport,
      stage: els.courseMapStage,
      image: els.courseMapImage,
      svg: els.courseMapSvg,
      targetSummary: els.courseMapTargetSummary,
      status: els.courseMapStatus,
      clearTarget: els.courseMapClearTarget,
      attribution: els.courseMapAttribution,
      edit: els.courseMapEdit,
      editor: els.courseMapEditor,
      featureType: els.courseMapFeatureType,
      featureLabel: els.courseMapFeatureLabel,
      editorHint: els.courseMapEditorHint,
      undoVertex: els.courseMapUndoVertex,
      resetDraft: els.courseMapResetDraft,
      cancelEdit: els.courseMapCancelEdit,
      saveFeature: els.courseMapSaveFeature,
      deleteFeature: els.courseMapDeleteFeature
    };
    const requiredMapElements = [
      "overlay", "backdrop", "close", "title", "hole", "locate", "zoomOut", "fit", "zoomIn",
      "viewport", "stage", "image", "svg", "targetSummary", "status", "clearTarget", "attribution"
    ];
    if (requiredMapElements.some((key) => !mapElements[key])) return null;
    try {
      courseMapController = window.FairwayCourseMapUi.createCourseMapController({
        mapConfig: config,
        engine: window.FairwayCourseMap,
        labelsApi: getCourseMapLabelsApi(),
        seedAnnotations: getDeerwoodAerialLabels(),
        elements: mapElements,
        requestPosition,
        getShots: (holeNumber) => getHoleShots(holeNumber),
        getAnnotations: () => state.mapAnnotations,
        onAnnotationsChange: (nextCollection) => {
          state.mapAnnotations = normalizeCourseMapAnnotations(nextCollection);
          saveState();
        },
        getSeedState: () => state.mapAnnotationSeedState,
        onSeedStateChange: (nextSeedState) => {
          state.mapAnnotationSeedState = normalizeCourseMapSeedState(nextSeedState);
          saveState();
        },
        getHoleIdentity: getPhysicalDeerwoodHoleIdentity,
        onClose: () => { if (els.courseMapButton) els.courseMapButton.focus(); }
      });
    } catch (error) {
      console.error("Could not initialize Deerwood course map", error);
      return null;
    }
    return courseMapController;
  }

  function activeCourseMapHoleNumber(course) {
    const activeCard = els.scorecardGrid && els.scorecardGrid.querySelector(".scorecard-card.active");
    const activeNumber = activeCard ? Number(activeCard.dataset.holeNumber) : null;
    if (Number.isFinite(activeNumber)) return activeNumber;
    return course && course.holes && course.holes[0] ? Number(course.holes[0].number) : 1;
  }

  function updateCourseMapAvailability(course) {
    if (!els.courseMapButton) return;
    const available = Boolean(
      course
      && isDeerwoodCourseId(course.id)
      && getDeerwoodCourseMapConfig()
      && window.FairwayCourseMap
      && window.FairwayCourseMapUi
    );
    els.courseMapButton.hidden = !available;
    if (!available && courseMapController && courseMapController.isOpen()) courseMapController.close();
  }

  function openCourseMap() {
    const course = getSelectedRoundCourse();
    if (!course || !isDeerwoodCourseId(course.id)) return;
    const controller = ensureCourseMapController();
    if (!controller) {
      showToast("The Deerwood aerial map is not available yet.");
      return;
    }
    controller.open({
      holes: course.holes,
      holeNumber: activeCourseMapHoleNumber(course),
      position: controller.getPosition()
    });
  }

  function gpsAccuracyText(position) {
    if (!position || !Number.isFinite(position.accuracyM)) return "accuracy unknown";
    return `GPS +/-${Math.round(position.accuracyM)}m`;
  }

  function gpsQualityText(position) {
    const quality = classifyAccuracy(position && position.accuracyM);
    if (quality === "good") return "Good fix";
    if (quality === "caution") return "Usable fix";
    if (quality === "poor") return "Low accuracy";
    return "Accuracy unknown";
  }

  function trackedShotDistanceYards(shot) {
    if (!shot || !shot.start || !shot.finish) return null;
    const meters = haversineMeters(shot.start.lat, shot.start.lng, shot.finish.lat, shot.finish.lng);
    return Number(metersToYards(meters).toFixed(1));
  }

  function renderShotTracker(hole) {
    const shots = getHoleShots(hole.number);
    const activeShot = [...shots].reverse().find((shot) => shot && shot.start && !shot.finish) || null;
    const trackedClubs = shots.map((shot) => shot.club).filter(Boolean);
    const options = CLUB_OPTIONS.filter((club) => getBag().includes(club) || trackedClubs.includes(club));
    const seededClub = getHoleClubs(hole.number).find((club) => club !== "Putter" && options.includes(club))
      || options.find((club) => club !== "Putter")
      || options[0]
      || "Other";
    const completed = shots.filter((shot) => shot.start && shot.finish);
    const rows = completed.map((shot, index) => {
      const distance = trackedShotDistanceYards(shot);
      const startQuality = classifyAccuracy(shot.start.accuracyM);
      const finishQuality = classifyAccuracy(shot.finish.accuracyM);
      const approximate = startQuality !== "good" || finishQuality !== "good";
      return `
        <li class="gps-shot-row">
          <span class="gps-shot-number">${index + 1}</span>
          <span class="gps-shot-main"><strong>${escapeHtml(shot.club || "Club")}</strong><small>${gpsAccuracyText(shot.start)} start / ${gpsAccuracyText(shot.finish)} finish</small></span>
          <span class="gps-shot-distance">${approximate ? "~" : ""}${distance === null ? "--" : distance.toFixed(1)}<small>yds</small></span>
          <button type="button" class="gps-shot-icon-button" data-gps-action="retry-finish" data-hole="${hole.number}" data-shot-id="${escapeHtml(shot.id)}" aria-label="Retry finish location">Retry</button>
          <button type="button" class="gps-shot-icon-button gps-shot-delete" data-delete-gps-shot data-hole="${hole.number}" data-shot-id="${escapeHtml(shot.id)}" aria-label="Delete GPS shot">x</button>
        </li>`;
    }).join("");
    const activeHtml = activeShot ? `
      <div class="gps-shot-active">
        <span><strong>${escapeHtml(activeShot.club || "Club")}</strong> started</span>
        <span class="gps-quality gps-quality-${classifyAccuracy(activeShot.start.accuracyM)}">${gpsQualityText(activeShot.start)} / ${gpsAccuracyText(activeShot.start)}</span>
        <div class="gps-shot-active-actions">
          <button type="button" class="ghost-button" data-delete-gps-shot data-hole="${hole.number}" data-shot-id="${escapeHtml(activeShot.id)}">Delete shot</button>
          <button type="button" class="ghost-button" data-gps-action="retry-start" data-hole="${hole.number}" data-shot-id="${escapeHtml(activeShot.id)}">Retry start</button>
          <button type="button" class="primary-button gps-finish-button" data-gps-action="finish" data-hole="${hole.number}" data-shot-id="${escapeHtml(activeShot.id)}">Mark finish</button>
        </div>
      </div>` : `
      <div class="gps-shot-start-row">
        <label><span>Club</span><select data-gps-club data-hole="${hole.number}">${options.map((club) => `<option value="${escapeHtml(club)}"${club === seededClub ? " selected" : ""}>${escapeHtml(club)}</option>`).join("")}</select></label>
        <button type="button" class="primary-button gps-start-button" data-gps-action="start" data-hole="${hole.number}">Start shot</button>
      </div>`;
    return `
      <section class="gps-shot-tracker" data-gps-shot-tracker data-hole="${hole.number}">
        <div class="gps-shot-heading"><div><span class="eyebrow">On-course GPS</span><strong>Shot locations</strong></div><span>${completed.length} recorded</span></div>
        ${activeHtml}
        ${rows ? `<ol class="gps-shot-list">${rows}</ol>` : `<p class="gps-shot-empty">Choose a club at the ball, then mark the finish when you reach it.</p>`}
        <p class="gps-shot-status" data-gps-status aria-live="polite"></p>
      </section>`;
  }

  function refreshShotTracker(holeNumber) {
    const course = getSelectedRoundCourse();
    const hole = course && course.holes.find((item) => Number(item.number) === Number(holeNumber));
    const current = els.scorecardGrid.querySelector(`[data-gps-shot-tracker][data-hole="${holeNumber}"]`);
    if (hole && current) current.outerHTML = renderShotTracker(hole);
  }

  let gpsCaptureBusy = false;

  async function handleGpsShotAction(button) {
    if (gpsCaptureBusy) return;
    const action = button.dataset.gpsAction;
    const holeNumber = Number(button.dataset.hole);
    if (!Number.isFinite(holeNumber)) return;
    const tracker = button.closest("[data-gps-shot-tracker]");
    const status = tracker && tracker.querySelector("[data-gps-status]");
    const captureGeneration = gpsCaptureGeneration;
    gpsCaptureBusy = true;
    button.disabled = true;
    if (status) status.textContent = "Finding the best available GPS position...";
    try {
      const position = await requestPosition();
      if (captureGeneration !== gpsCaptureGeneration) {
        throw new Error("The round changed before GPS finished. That location was discarded.");
      }
      const shots = getHoleShots(holeNumber);
      const shotId = button.dataset.shotId;
      const index = shotId ? shots.findIndex((shot) => shot.id === shotId) : -1;
      if (action === "start") {
        const select = tracker && tracker.querySelector(`[data-gps-club][data-hole="${holeNumber}"]`);
        const club = select && select.value ? select.value : "Other";
        shots.push({
          id: makeId("shot"),
          club,
          target: courseMapController ? courseMapController.getTarget(holeNumber) : null,
          startedAt: position.capturedAt || new Date().toISOString(),
          start: position,
          finish: null
        });
      } else if (index >= 0 && action === "finish") {
        const next = { ...shots[index], finish: position, finishedAt: position.capturedAt || new Date().toISOString() };
        next.distanceYards = trackedShotDistanceYards(next);
        shots[index] = next;
      } else if (index >= 0 && action === "retry-start") {
        const next = { ...shots[index], start: position, startedAt: position.capturedAt || new Date().toISOString() };
        if (next.finish) next.distanceYards = trackedShotDistanceYards(next);
        shots[index] = next;
      } else if (index >= 0 && action === "retry-finish") {
        const next = { ...shots[index], finish: position, finishedAt: position.capturedAt || new Date().toISOString() };
        next.distanceYards = trackedShotDistanceYards(next);
        shots[index] = next;
      } else {
        throw new Error("That shot is no longer available.");
      }
      setHoleShots(holeNumber, shots);
      if (courseMapController) courseMapController.setPosition(position);
      roundTouched = true;
      scheduleInProgressSave();
      refreshShotTracker(holeNumber);
      const quality = classifyAccuracy(position.accuracyM);
      showToast(quality === "poor"
        ? `Location saved with low accuracy (${gpsAccuracyText(position)}). Retry when the phone has a clearer sky view.`
        : `GPS location saved (${gpsAccuracyText(position)}).`);
    } catch (error) {
      if (status) status.textContent = error && error.message
        ? error.message
        : "Could not get your location. Check browser location permission and try again.";
      button.disabled = false;
    } finally {
      gpsCaptureBusy = false;
    }
  }

  function deleteGpsShot(button) {
    const holeNumber = Number(button.dataset.hole);
    const shotId = button.dataset.shotId;
    const next = getHoleShots(holeNumber).filter((shot) => shot.id !== shotId);
    setHoleShots(holeNumber, next);
    roundTouched = true;
    scheduleInProgressSave();
    refreshShotTracker(holeNumber);
    showToast("GPS shot removed.");
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
            ${!isDeerwoodCourseId(course.id) && Array.isArray(hole.hazards) && hole.hazards.length ? `<ul class="hazard-chip-list hazard-chip-list-compact">${hole.hazards.map((h) => renderHazardChip(h)).join("")}</ul>` : ""}
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
          ${renderScorePills(hole)}${renderPuttsPills(hole)}
          <div class="card-extra">
            ${cardFlowMode === "narrative" ? `
              ${renderClubsHitPills(hole)}
              ${renderShotTracker(hole)}
              ${renderFairwayPills(hole)}
              ${renderFirstPuttPills(hole)}
              ${renderPenPills(hole)}
              ${renderPenaltyClubRow(hole)}
              ${renderBunkerPills(hole)}
              <label class="card-note-field">
                <span>What happened on this hole?</span>
                <textarea class="card-note-input" data-hole="${hole.number}" rows="2" placeholder="Drove left, chipped twice, 2-putt from 12ft… (tap the mic on your keyboard for voice)">${escapeHtml(getHoleNote(hole.number))}</textarea>
              </label>
            ` : `
              ${renderFirstPuttPills(hole)}
              ${renderFairwayPills(hole)}
              ${renderClubsHitPills(hole)}
              ${renderShotTracker(hole)}
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

  // Tap a score, walk to the next tee — the card advances itself. SPEED
  // mode only: there score is the whole job, so entry becomes literally one
  // tap per hole; in detailed mode the user still has putts/clubs below and
  // an auto-jump would fight them. Only from the card being played, only
  // INTO a hole with no score yet (so tapping back to fix hole 4 never
  // yanks the view forward), never off the last hole (the Review CTA is
  // the next step there). Edit mode is naturally immune: every hole
  // already has a value.
  let autoAdvanceTimer = null;
  function maybeAutoAdvanceAfterScore(holeNumber) {
    if (currentEntryMode !== "speed") return;
    if (viewMode !== "card") return;
    const stack = els.scorecardGrid.querySelector(".scorecard-cards");
    if (!stack) return;
    const cards = [...stack.querySelectorAll(".scorecard-card")];
    const idx = cards.findIndex((c) => c.dataset.holeNumber === String(holeNumber));
    if (idx === -1 || idx !== getActiveCardIndex()) return;
    if (idx >= cards.length - 1) return;
    const next = cards[idx + 1].querySelector(".score-input");
    if (!(next instanceof HTMLInputElement) || next.value.trim() !== "") return;
    if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
    autoAdvanceTimer = setTimeout(() => {
      autoAdvanceTimer = null;
      if (viewMode !== "card" || getActiveCardIndex() !== idx) return;
      setActiveCardIndex(idx + 1);
    }, 450);
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
          maybeAutoAdvanceAfterScore(holeNumber);
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
      shots: h.shots,
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
        ,shots: getHoleShots(hole)
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
      if (Array.isArray(values.shots)) setHoleShots(holeNumber, values.shots);
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
      const shots = getHoleShots(holeNumber);
      if (requireComplete) {
        if (!scoreValue || scoreValue < 1) {
          throw new Error(`Enter a score on ${scoreInput.dataset.label || `hole ${holeNumber}`} before saving.`);
        }
        if (puttsValue < 0 || penaltyValue < 0) {
          throw new Error("Putts and penalties must be 0 or higher.");
        }
        if (shots.some((shot) => shot && shot.start && !shot.finish)) {
          throw new Error(`Finish or delete the active GPS shot on ${scoreInput.dataset.label || `hole ${holeNumber}`} before saving.`);
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
        clubsHit: getHoleClubs(holeNumber),
        shots
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

    // Trend ticks (2026-07-06): the tiles judge by DIRECTION, never by level —
    // a +14 golfer improving is a green story, and a naked level can't say
    // that. Last-5 vs prior-5, shown only when both windows have 3+ rounds
    // (an honest trend or none at all). Arrow = which way the number moved;
    // color = whether that direction is good for THIS metric.
    const byDate = [...rounds].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const totals18 = byDate.filter((r) => Array.isArray(r.holes) && r.holes.length === 18).map(roundTotals);
    const windowDelta = (values) => {
      const recent5 = values.slice(0, 5);
      const prior5 = values.slice(5, 10);
      if (recent5.length < 3 || prior5.length < 3) return NaN;
      return average(recent5) - average(prior5);
    };
    const setTrend = (id, delta, higherIsBetter, unit) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (!Number.isFinite(delta) || Math.abs(delta) < 0.05) {
        el.hidden = true;
        el.textContent = "";
        el.className = "metric-trend";
        return;
      }
      const improving = higherIsBetter ? delta > 0 : delta < 0;
      el.hidden = false;
      el.className = `metric-trend ${improving ? "trend-good" : "trend-warn"}`;
      el.textContent = `${delta < 0 ? "▾" : "▴"} ${Math.abs(delta).toFixed(1)}${unit || ""} vs prior 5`;
    };
    setTrend("metricParTrend", windowDelta(totals18.map((t) => t.toPar)), false);
    setTrend("metricGirTrend", windowDelta(byDate.map(roundTotals).map((t) => (t.girTotal ? (100 * t.girMade) / t.girTotal : NaN)).filter(Number.isFinite)), true, "%");
    setTrend("metricSgTrend", windowDelta(byDate.map(roundStrokesGained).filter(Boolean).map((s) => s.total)), true);
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
    // Tone layer (2026-07-06): every card carries its meaning. Form is judged
    // by TREND (improving/steady/rising — never by the raw level, which would
    // shout at a perfectly normal +14 golfer); the leak is always the amber
    // card; the handicap void is an honest pending state, not a dark box
    // with two dashes.
    const formTone = !Number.isFinite(formDelta) ? ""
      : formDelta <= -0.5 ? " tone-good" : formDelta >= 0.5 ? " tone-warn" : "";
    const formTick = !Number.isFinite(formDelta) ? "Last 5 rounds"
      : formDelta <= -0.5 ? `▾ ${Math.abs(formDelta).toFixed(1)} better than the prior 5`
      : formDelta >= 0.5 ? `▴ ${formDelta.toFixed(1)} over the prior 5`
      : "holding steady vs the prior 5";
    const hasIndex = handicap.index !== null;
    els.homeInsights.innerHTML = `
      <article class="insight-card${formTone}">
        <span>Current form</span>
        <strong>${formatSigned(recentAvg)}</strong>
        <small class="insight-tick">${formTick}</small>
      </article>
      <article class="insight-card tone-good">
        <span>Best course fit</span>
        <strong>${escapeHtml(bestCourse && bestCourse.course ? bestCourse.course.name.replace("Deerwood Golf Course - ", "") : "--")}</strong>
        <small>${bestCourse ? `${formatSigned(bestCourse.avgToPar)} avg to par · ${bestCourse.rounds} round${bestCourse.rounds === 1 ? "" : "s"}` : "--"}</small>
      </article>
      <article class="insight-card tone-warn">
        <span>Biggest leak</span>
        <strong>${weakestPar ? `Par ${weakestPar.par}s` : "--"}</strong>
        <small>${weakestPar ? `${formatSigned(weakestPar.avgToPar)} per hole · ${weakestPar.count} holes played` : "--"}</small>
      </article>
      <article class="insight-card ${hasIndex ? "dark" : "pending"}">
        <span>Handicap signal</span>
        <strong>${hasIndex ? handicap.index.toFixed(1) : "Building"}</strong>
        <small>${hasIndex
          ? `${handicap.approximateNineCount || 0} nine-hole estimate${(handicap.approximateNineCount || 0) === 1 ? "" : "s"} included`
          : "unlocks with rated 18-hole rounds — 9-holers pair up as estimates"}</small>
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
        // Deerwood's replacement features must come from the sourced,
        // confidence-rated geographic dataset. Other courses retain their
        // existing behavior.
        hazards: deerwood ? [] : (Array.isArray(courseHole.hazards) ? courseHole.hazards : [])
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

  // A post-round report stays strict about evidence: narrated facts are
  // labelled reported, while score patterns are explicitly inferences.
  function renderPostRoundBriefing(round) {
    const holes = Array.isArray(round.holes) ? round.holes.filter((h) => Number.isFinite(h.score) && h.score > 0) : [];
    if (!holes.length) return "";
    const totals = roundTotals(round);
    const known = (field) => holes.filter((h) => h.voiceKnown && h.voiceKnown[field]);
    const teeHoles = known("teeClub"), puttHoles = known("putts"), penaltyHoles = known("penalties");
    const penalties = penaltyHoles.reduce((sum, h) => sum + Number(h.penalties || 0), 0);
    const costly = [...holes].sort((a, b) => (b.score - b.par) - (a.score - a.par)).filter((h) => h.score > h.par).slice(0, 3);
    const context = holes.filter((h) => h.approachNote || h.result || h.missContext || h.note);
    const takeaways = [];
    if (teeHoles.length) {
      const clubs = new Map(); teeHoles.forEach((h) => clubs.set(h.teeClub, (clubs.get(h.teeClub) || 0) + 1));
      const [club, count] = [...clubs.entries()].sort((a, b) => b[1] - a[1])[0];
      takeaways.push(`<strong>Reported:</strong> ${teeHoles.length} tee clubs logged; ${escapeHtml(club)} was used ${count} time${count === 1 ? "" : "s"}.`);
    }
    if (puttHoles.length) takeaways.push(`<strong>Reported:</strong> ${puttHoles.length} holes include putts (${puttHoles.reduce((s, h) => s + h.putts, 0)} total on those holes).`);
    if (penaltyHoles.length) takeaways.push(`<strong>Reported:</strong> ${penalties} penalty stroke${penalties === 1 ? "" : "s"} across ${penaltyHoles.length} narrated holes.`);
    if (costly.length) takeaways.push(`<strong>Inference from score:</strong> ${costly.map((h) => `${escapeHtml(h.label || `Hole ${h.number}`)} ${formatSigned(h.score - h.par, 0)}`).join(", ")} were the largest over-par holes; causes are unknown unless noted below.`);
    const practice = penalties > 0 ? "Practice focus: repeat one tee-shot start-line routine; that targets the penalty strokes you reported."
      : puttHoles.filter((h) => h.putts >= 3).length ? "Practice focus: distance-control putting, because the recap specifically logged three-putts."
      : costly.length ? "Practice focus: revisit the narrated decisions on the highest-scoring holes before changing mechanics."
      : "Practice focus: capture one tee-shot and one approach result per hole next time so the next briefing can be more specific.";
    const coaching = round.coaching || {};
    const coachingHtml = coaching.story || coaching.pattern || coaching.nextRoundCue || (coaching.strengths || []).length || (coaching.practicePlan || []).length ? `<div class="briefing-coaching"><span class="briefing-kicker">Player-reported coaching context</span>${coaching.story ? `<p>${escapeHtml(coaching.story)}</p>` : ""}${coaching.pattern ? `<p><strong>Pattern:</strong> ${escapeHtml(coaching.pattern)}</p>` : ""}${coaching.nextRoundCue ? `<p class="briefing-cue"><strong>Next-round cue:</strong> ${escapeHtml(coaching.nextRoundCue)}</p>` : ""}${coaching.strengths?.length ? `<p><strong>Strengths:</strong> ${coaching.strengths.map(escapeHtml).join(" · ")}</p>` : ""}${coaching.practicePlan?.length ? `<p><strong>Practice plan:</strong> ${coaching.practicePlan.map(escapeHtml).join(" · ")}</p>` : ""}</div>` : "";
    return `<section class="post-round-briefing"><div class="briefing-hero"><span>Post-round briefing</span><strong>${totals.gross} <small>${formatSigned(totals.toPar, 0)}</small></strong><p>${escapeHtml(round.narrative || "Scorecard captured. Add shot context to turn the next recap into a sharper coaching report.")}</p></div><div class="briefing-grid"><div><span class="briefing-kicker">Evidence-led takeaways</span><ul>${takeaways.length ? takeaways.map((item) => `<li>${item}</li>`).join("") : "<li>No shot detail was reported; this briefing only uses the scorecard.</li>"}</ul></div><div><span class="briefing-kicker">Practice focus</span><p class="briefing-focus">${escapeHtml(practice)}</p></div></div>${coachingHtml}${context.length ? `<div class="briefing-context"><span class="briefing-kicker">Full recap trail</span>${context.map((h) => `<p><strong>${escapeHtml(h.label || `Hole ${h.number}`)}</strong> ${escapeHtml([h.approachNote, h.result, h.missContext, h.note].filter(Boolean).join(" · "))}</p>`).join("")}</div>` : ""}</section>`;
  }

  function renderRecentRounds() {
    // Score badge context (2026-07-06): each round leads with a tone-coded
    // badge judged against the player's OWN average for that round length —
    // celebrate (green when you beat your average, gold for the personal
    // best), never scold: an ordinary round stays neutral cream.
    const toParByLen = {};
    state.rounds.forEach((r) => {
      const len = Array.isArray(r.holes) ? r.holes.length : 0;
      (toParByLen[len] = toParByLen[len] || []).push(roundTotals(r).toPar);
    });
    const bestToPar18 = Math.min(...state.rounds
      .filter((r) => Array.isArray(r.holes) && r.holes.length === 18)
      .map((r) => roundTotals(r).toPar));
    const fmtRowDate = (iso) => {
      try {
        const d = new Date(`${iso}T12:00:00`);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      } catch { return iso; }
    };
    const rows = [...state.rounds]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 7)
      .map((round) => {
        const course = getCourse(round.courseId);
        const totals = roundTotals(round);
        const sg = roundStrokesGained(round);
        const tagBadge = round.tag ? ` <span class="round-tag-badge round-tag-${escapeHtml(round.tag)}">${escapeHtml(formatRoundTag(round.tag))}</span>` : "";
        const editingBadge = editingRoundId === round.id ? ' <span class="editing-pill">editing</span>' : "";
        const len = Array.isArray(round.holes) ? round.holes.length : 0;
        const peerAvg = average(toParByLen[len] || []);
        const beat = Number.isFinite(peerAvg) && (toParByLen[len] || []).length >= 3
          ? peerAvg - totals.toPar : NaN;
        const isBest = len === 18 && Number.isFinite(bestToPar18) && totals.toPar === bestToPar18
          && (toParByLen[18] || []).length >= 3;
        const badgeTone = isBest ? " tone-gold" : (Number.isFinite(beat) && beat >= 0.5 ? " tone-good" : "");
        const context = [];
        if (isBest) context.push('<span class="round-context-best">personal best</span>');
        else if (Number.isFinite(beat) && beat >= 0.5) context.push(`<span class="round-context-good">beat your average by ${beat.toFixed(1)}</span>`);
        if (sg) context.push(`SG ${formatSigned(sg.total)}`);
        if (round.wind) context.push(escapeHtml(formatWind(round.wind)));
        if (len && len !== 18) context.push(`${len} holes`);
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
            <div class="round-badge${badgeTone}" aria-hidden="true">
              <strong>${totals.gross}</strong>
              <span>${formatSigned(totals.toPar, 0)}</span>
            </div>
            <div class="round-row-main">
              <strong class="round-row-head"><span>${fmtRowDate(round.date)}</span><button type="button" class="link-course" data-open-course-name="${escapeHtml(physicalCourseName(round.courseId))}">${escapeHtml(course ? course.name : "Unknown")}</button>${editingBadge}${tagBadge}</strong>
              ${context.length ? `<span class="subtext round-row-context">${context.join(" · ")}</span>` : ""}
              ${narrativeHtml}
              ${scorecardHtml}
            </div>
            <div class="row-actions">
              <button type="button" data-view-round="${round.id}">View</button>
              <button type="button" class="row-delete" data-delete-round="${round.id}" aria-label="Delete round">Delete</button>
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
    // Deleting a round is DESTRUCTIVE in a localStorage-only app — it goes
    // through the same confirm modal as every other wipe path (P0 fix
    // 2026-07-06: this button used to delete on a single tap, no confirm,
    // one thumb-width from View), and snapshots first so Profile › Backups
    // can undo a change of heart.
    els.recentRounds.querySelectorAll("[data-delete-round]").forEach((button) => {
      button.addEventListener("click", () => {
        const targetId = button.dataset.deleteRound;
        const round = state.rounds.find((candidate) => candidate.id === targetId);
        if (!round) return;
        const course = getCourse(round.courseId);
        const totals = roundTotals(round);
        openDestructiveConfirm({
          title: "Delete this round?",
          message: "This removes the round from every stat, trend, and record.",
          facts: [
            `${round.date} · ${course ? course.name : "Unknown course"}`,
            `${totals.gross} (${formatSigned(totals.toPar, 0)})${round.holes ? ` · ${round.holes.length} holes` : ""}`
          ],
          confirmLabel: "Delete round",
          onConfirm: () => {
            takeSnapshot("before-round-delete", { force: true });
            state.rounds = state.rounds.filter((candidate) => candidate.id !== targetId);
            if (editingRoundId === targetId) clearEditState({ rerender: true });
            saveState();
            renderAll();
            showToast("Round deleted. A snapshot was saved first (Profile › Backups).");
          }
        });
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
    const allowLegacyHazardEditor = !isDeerwoodCourseId(course.id);
    const holeRows = course.holes.map((hole) => {
      const stats = holeGroups.find((group) => group.number === hole.number);
      const hazards = allowLegacyHazardEditor && Array.isArray(hole.hazards) ? hole.hazards : [];
      const hazardCountLabel = !allowLegacyHazardEditor
        ? `<span class="hazard-count hazard-count-empty">Verified map pending</span>`
        : hazards.length
        ? `<span class="hazard-count">${hazards.length} hazard${hazards.length === 1 ? "" : "s"}</span>`
        : `<span class="hazard-count hazard-count-empty">+ add hazard</span>`;
      const chipsHtml = !allowLegacyHazardEditor
        ? `<p class="hazard-empty">The old hand-entered hazard mapping is disabled. This hole will use the new sourced satellite map when its geometry is verified.</p>`
        : hazards.length
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
            ${allowLegacyHazardEditor ? `<form class="hazard-form" data-add-hazard data-hole-number="${hole.number}">
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
            </form>` : ""}
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

  // ---- Shared voice-recap inbox -----------------------------------------
  //
  // This stays outside `state` on purpose. Cloud drafts are review material,
  // not local history; they only become a round after the explicit Apply
  // action below. Supabase's anon key is publishable and RLS protects rows;
  // no service credential or voice-ingest secret ever reaches this browser.
  let voiceDrafts = [];
  let openVoiceDraftId = null;

  function readVoiceDraftConfig() {
    try {
      const value = JSON.parse(localStorage.getItem(VOICE_DRAFT_CONFIG_KEY) || "{}");
      return {
        projectUrl: typeof value.projectUrl === "string" && value.projectUrl.trim() ? value.projectUrl.replace(/\/$/, "") : VOICE_DRAFT_DEFAULT_CONFIG.projectUrl,
        anonKey: typeof value.anonKey === "string" && value.anonKey.trim() ? value.anonKey.trim() : VOICE_DRAFT_DEFAULT_CONFIG.anonKey,
        email: typeof value.email === "string" ? value.email.trim() : ""
      };
    } catch { return { ...VOICE_DRAFT_DEFAULT_CONFIG, email: "" }; }
  }

  function readVoiceDraftSession() {
    try { return JSON.parse(localStorage.getItem(VOICE_DRAFT_SESSION_KEY) || "null"); } catch { return null; }
  }

  function writeVoiceDraftStatus(message) {
    if (els.voiceDraftStatus) els.voiceDraftStatus.textContent = message;
  }

  function readAppliedVoiceDraftIds() {
    try { return new Set(JSON.parse(localStorage.getItem(VOICE_DRAFT_APPLIED_KEY) || "[]")); } catch { return new Set(); }
  }

  function rememberAppliedVoiceDraft(id) {
    if (!id) return;
    const ids = readAppliedVoiceDraftIds(); ids.add(id);
    try { localStorage.setItem(VOICE_DRAFT_APPLIED_KEY, JSON.stringify([...ids].slice(-100))); } catch {}
  }

  function isVoiceInboxConfigured() {
    const { projectUrl, anonKey } = readVoiceDraftConfig();
    return /^https:\/\/.+\.supabase\.co$/i.test(projectUrl) && anonKey.length > 20;
  }

  async function getFreshVoiceDraftSession() {
    const session = readVoiceDraftSession();
    if (!session || !session.access_token) return null;
    if (!session.expires_at || session.expires_at * 1000 > Date.now() + 60_000 || !session.refresh_token) return session;
    const config = readVoiceDraftConfig();
    const response = await fetch(`${config.projectUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST", headers: { apikey: config.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!response.ok) return session;
    const refreshed = await response.json();
    const next = { access_token: refreshed.access_token, refresh_token: refreshed.refresh_token || session.refresh_token, expires_at: refreshed.expires_at || 0 };
    try { localStorage.setItem(VOICE_DRAFT_SESSION_KEY, JSON.stringify(next)); } catch {}
    return next;
  }

  async function voiceSupabaseRequest(path, options = {}) {
    const config = readVoiceDraftConfig();
    const session = await getFreshVoiceDraftSession();
    if (!isVoiceInboxConfigured() || !session || !session.access_token) throw new Error("Connect your secure voice inbox first.");
    const response = await fetch(`${config.projectUrl}${path}`, {
      ...options,
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error("Your inbox sign-in expired. Send yourself a new sign-in link in Profile.");
      throw new Error("Could not reach your private voice inbox.");
    }
    return response.status === 204 ? null : response.json();
  }

  async function refreshVoiceDraftIdentity() {
    if (!isVoiceInboxConfigured()) return;
    try {
      const user = await voiceSupabaseRequest("/auth/v1/user");
      if (els.voiceDraftIdentity && user && user.id) {
        els.voiceDraftIdentity.hidden = false;
        els.voiceDraftIdentity.textContent = `Voice-service routing ID: ${user.id}`;
      }
    } catch {
      if (els.voiceDraftIdentity) els.voiceDraftIdentity.hidden = true;
    }
  }

  function renderVoiceDraftInbox() {
    if (!els.voiceDraftInbox) return;
    if (!isVoiceInboxConfigured()) {
      els.voiceDraftInbox.innerHTML = `<div class="voice-inbox-empty">Voice recap inbox is ready to connect in Profile. Drafts stay separate from saved rounds.</div>`;
      return;
    }
    const applied = readAppliedVoiceDraftIds();
    const pending = voiceDrafts.filter((draft) => draft.status === "pending" && !applied.has(draft.id));
    if (!pending.length) {
      els.voiceDraftInbox.innerHTML = `<div class="voice-inbox-empty">No new voice recaps. Finish a spoken recap and its complete draft will appear here.</div>`;
      return;
    }
    els.voiceDraftInbox.innerHTML = pending.map((draft) => {
      const total = roundTotals(draft.round);
      const title = draft.recap.title || `${draft.round.date || "New"} voice recap`;
      const meta = [draft.round.tee ? `${draft.round.tee} tees` : "", total.gross ? `${total.gross} (${formatSigned(total.toPar, 0)})` : "", `${draft.recap.holeNarration.length} narrated holes`].filter(Boolean).join(" · ");
      return `<button class="voice-inbox-card" type="button" data-open-voice-draft="${escapeHtml(draft.id)}"><span><strong>${escapeHtml(title)}</strong><span>${escapeHtml(meta)}</span></span><em>Review ›</em></button>`;
    }).join("");
    els.voiceDraftInbox.querySelectorAll("[data-open-voice-draft]").forEach((button) => button.addEventListener("click", () => openVoiceDraft(button.dataset.openVoiceDraft)));
  }

  async function refreshVoiceDraftInbox({ quiet = false } = {}) {
    if (!isVoiceInboxConfigured()) { renderVoiceDraftInbox(); return; }
    const session = readVoiceDraftSession();
    if (!session || !session.access_token) { writeVoiceDraftStatus("Saved connection. Send yourself a secure sign-in link to see drafts."); renderVoiceDraftInbox(); return; }
    try {
      const rows = await voiceSupabaseRequest("/rest/v1/voice_recap_drafts?select=id,payload,status,created_at,updated_at&status=eq.pending&order=created_at.desc");
      voiceDrafts = (Array.isArray(rows) ? rows : []).map((row) => VoiceRecap.normalizeDraft({ ...row.payload, id: row.id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }));
      refreshVoiceDraftIdentity();
      renderVoiceDraftInbox();
      writeVoiceDraftStatus(`${voiceDrafts.length} pending secure voice recap${voiceDrafts.length === 1 ? "" : "s"}.`);
    } catch (error) {
      if (!quiet) writeVoiceDraftStatus(error.message);
      renderVoiceDraftInbox();
    }
  }

  async function requestVoiceDraftSignIn() {
    const config = readVoiceDraftConfig();
    if (!isVoiceInboxConfigured() || !/^\S+@\S+\.\S+$/.test(config.email)) {
      writeVoiceDraftStatus("Enter your Supabase project URL, publishable anon key, and email first."); return;
    }
    try {
      const response = await fetch(`${config.projectUrl}/auth/v1/otp`, {
        method: "POST", headers: { apikey: config.anonKey, "Content-Type": "application/json" },
        // The owner signs in with their email for the first time here. Email
        // confirmation remains enabled in Supabase; RLS still prevents every
        // account from seeing anyone else's drafts.
        // This is the raw GoTrue REST endpoint, whose redirect field is
        // `redirect_to` (the SDK calls it options.emailRedirectTo).
        body: JSON.stringify({ email: config.email, create_user: true, redirect_to: `${location.origin}${location.pathname}` })
      });
      if (!response.ok) {
        let detail = "";
        try {
          const body = await response.json();
          detail = typeof body.message === "string" ? body.message : (typeof body.error_description === "string" ? body.error_description : "");
        } catch {}
        const guidance = response.status === 403
          ? " In Supabase, open Authentication → Providers → Email and enable Email."
          : " Check Supabase Authentication → URL Configuration: the Site URL and Redirect URL must include https://jcurry44.github.io/Fairway-Ledger/.";
        throw new Error(`Could not send the sign-in link (${response.status})${detail ? `: ${detail}` : "."}${guidance}`);
      }
      writeVoiceDraftStatus("Secure sign-in link sent. Open it on this phone, then refresh the inbox.");
    } catch (error) { writeVoiceDraftStatus(error.message); }
  }

  function captureVoiceDraftAuthReturn() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const accessToken = hash.get("access_token");
    if (!accessToken) return;
    try {
      localStorage.setItem(VOICE_DRAFT_SESSION_KEY, JSON.stringify({ access_token: accessToken, refresh_token: hash.get("refresh_token") || "", expires_at: Number(hash.get("expires_at") || 0) }));
      history.replaceState(null, document.title, `${location.pathname}${location.search}`);
      writeVoiceDraftStatus("Secure voice inbox connected.");
    } catch {}
  }

  function openVoiceDraft(id) {
    const draft = voiceDrafts.find((item) => item.id === id);
    if (!draft || !els.voiceDraftOverlay) return;
    openVoiceDraftId = id;
    const validation = VoiceRecap.validateDraft(draft);
    const total = roundTotals(draft.round);
    els.voiceDraftTitle.textContent = draft.recap.title || "Voice recap draft";
    const coaching = draft.recap.coaching.length ? `<section class="voice-draft-section"><h4>Coaching</h4><ul class="voice-draft-coaching">${draft.recap.coaching.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul></section>` : "";
    const holes = draft.recap.holeNarration.length ? `<section class="voice-draft-section"><h4>Hole-by-hole recap</h4><ol class="voice-draft-holes">${draft.recap.holeNarration.map((item) => `<li><strong>${escapeHtml(item.label || `Hole ${item.holeNumber}`)}</strong>${item.narration ? `<p>${escapeHtml(item.narration)}</p>` : ""}${item.coaching ? `<p class="voice-coaching">Coach: ${escapeHtml(item.coaching)}</p>` : ""}</li>`).join("")}</ol></section>` : "";
    els.voiceDraftBody.innerHTML = `<div><strong>${total.gross || "—"}${total.gross ? ` (${formatSigned(total.toPar, 0)})` : ""}</strong> · ${escapeHtml(draft.round.date || "Date unconfirmed")} · ${escapeHtml(draft.round.tee || "Tee unconfirmed")}</div>${draft.recap.summary ? `<section class="voice-draft-section"><h4>Round recap</h4><p class="voice-draft-summary">${escapeHtml(draft.recap.summary)}</p></section>` : ""}${coaching}${holes}${validation.valid ? "" : `<p class="voice-inbox-empty">Cannot apply yet: ${escapeHtml(validation.errors[0])}</p>`}`;
    els.voiceDraftApply.disabled = !validation.valid;
    els.voiceDraftOverlay.hidden = false; document.body.classList.add("hole-picker-open");
  }

  function closeVoiceDraft() { if (els.voiceDraftOverlay) els.voiceDraftOverlay.hidden = true; document.body.classList.remove("hole-picker-open"); openVoiceDraftId = null; }

  async function setVoiceDraftRemoteStatus(id, status) {
    await voiceSupabaseRequest(`/rest/v1/voice_recap_drafts?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(status === "applied" ? { status, applied_at: new Date().toISOString() } : { status }) });
  }

  async function applyOpenVoiceDraft() {
    const draft = voiceDrafts.find((item) => item.id === openVoiceDraftId);
    if (!draft) return;
    try {
      const round = VoiceRecap.toAppliedRound(draft, makeRound, makeId);
      if (!getCourse(round.courseId)) throw new Error("This draft's course is not available in Fairway Ledger yet.");
      state.rounds.push(round); saveState(); rememberAppliedVoiceDraft(draft.id); renderAll(); closeVoiceDraft();
      showToast("Voice recap applied as a new round.");
      try { await setVoiceDraftRemoteStatus(draft.id, "applied"); } catch { writeVoiceDraftStatus("Round saved locally; inbox status will sync after you sign in again."); }
    } catch (error) { showToast(error.message); }
  }

  async function archiveOpenVoiceDraft() {
    const id = openVoiceDraftId; if (!id) return;
    try { await setVoiceDraftRemoteStatus(id, "archived"); voiceDrafts = voiceDrafts.filter((draft) => draft.id !== id); closeVoiceDraft(); renderVoiceDraftInbox(); showToast("Voice recap archived."); }
    catch (error) { showToast(error.message); }
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
    renderVoiceDraftInbox();
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
    els.roundDetailBody.innerHTML = renderPostRoundBriefing(round) + renderRoundScorecard(round);
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
    confirmingDeleteId: null,
    editingStake: false      // summary view: stake input open
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
    syncWakeLock();
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
          <input type="text" inputmode="decimal" class="game-stake-input" placeholder="0">
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
      const scored = game.players.every((p) => Number.isFinite(hole.scores[p.id]) && hole.scores[p.id] > 0);
      // Wolf: a fully-scored hole with no partner/Lone-Wolf pick is worth 0
      // points in the engine — counting it "complete" hides real money from
      // the settle-up. The pick is part of entering the hole.
      if (game.gameType === "wolf") {
        return scored && Boolean(hole.wolf && hole.wolf.wolfId);
      }
      return scored;
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
          <span class="games-hint">${(() => {
            const counts = gameScoreCounts(game);
            const uneven = counts.length > 1 && new Set(counts.map((c) => c.count)).size > 1;
            return uneven
              ? `${doneCount}/${game.holes.length} complete — ${escapeHtml(counts.map((c) => `${c.name} ${c.count}`).join(" · "))}`
              : `${doneCount}/${game.holes.length} holes entered`;
          })()}</span>
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
          <span class="game-hole-title">Hole ${hole.number} <em>of ${game.holes.length}</em></span>
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

  // Forgiving stake reader: users type "$5", "5.00", "5," — take the number,
  // reject garbage loudly instead of silently starting a stakeless game.
  function parseStakeValue(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return { empty: true, value: null };
    const cleaned = Number(text.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(cleaned) || cleaned <= 0) return { empty: false, value: null, bad: text };
    return { empty: false, value: cleaned };
  }

  // Per-player entered-hole counts — the honest answer to "why doesn't the
  // app see my 18 holes?" (a match hole only counts when EVERYONE has a
  // score on it).
  function gameScoreCounts(game) {
    const meta = Games.GAME_BY_ID[game.gameType];
    if (!meta || !meta.needsScores) return [];
    return game.players.map((p) => ({
      name: p.name,
      count: game.holes.filter((h) => Number.isFinite(h.scores[p.id]) && h.scores[p.id] > 0).length
    }));
  }

  function renderGameSummaryView() {
    const game = getActiveGame();
    if (!game) return renderGamesHomeView();
    const meta = Games.GAME_BY_ID[game.gameType];
    const computed = computeGame(game);
    const lines = gameStandingsLines(game);
    const stake = game.options && Number.isFinite(game.options.stake) ? game.options.stake : null;
    // A match-style game "finished" before it was mathematically decided
    // settles on the current lead — say so, or the payout looks wrong next
    // to the standings line.
    const matchStates = game.gameType === "nassau"
      ? [computed.front, computed.back, computed.overall]
      : (game.gameType === "matchplay" || game.gameType === "bestball") ? [computed] : [];
    const endedEarly = matchStates.some((m) => m && m.thru > 0 && !m.done);
    const doneCount = game.holes.filter((h) => gameHoleEntryComplete(game, h)).length;
    const counts = gameScoreCounts(game);
    const somebodyEntered = counts.some((c) => c.count > 0);
    const uneven = counts.length > 1 && new Set(counts.map((c) => c.count)).size > 1;
    const countsLine = counts.map((c) => `${c.name} ${c.count}`).join(" · ");
    // The stake row is always present and always fixable — 'we forgot to
    // set a stake on the first tee' shouldn't cost the settle-up.
    const stakeRow = (gamesUi.editingStake || !stake) ? `
      <div class="game-stake-late-row">
        <input class="game-stake-late-input" type="text" inputmode="decimal" placeholder="${stake ? String(stake) : "$ stake"}" value="${stake ? String(stake) : ""}">
        <button type="button" class="games-count-chip small" data-game-action="set-stake">${stake ? "Save" : "Set stake"}</button>
      </div>` : `
      <p class="games-hint game-stake-line">Stake: $${stake.toFixed(2)}${meta && meta.stakeLabel ? ` (${escapeHtml(meta.stakeLabel.replace("$ ", ""))})` : ""}
        <button type="button" class="game-stake-edit" data-game-action="edit-stake">Edit</button></p>`;
    let settleHtml = "";
    if (stake && computed) {
      const settlement = Games.computeSettlement(game, computed, stake);
      const earlyNote = endedEarly
        ? `<p class="games-hint game-settle-note">Called early — settled on the standings as they sit.</p>` : "";
      const unevenNote = (uneven && doneCount > 0)
        ? `<p class="games-hint game-settle-note">Uneven entry — ${escapeHtml(countsLine)} holes. ${game.gameType === "stableford"
            ? "Missing holes score 0 points for that player."
            : "Only holes with everyone's score count."}</p>` : "";
      if (doneCount === 0) {
        settleHtml = `<h3 class="games-section-title">Settle up</h3>${stakeRow}<p class="games-hint">${somebodyEntered
          ? `No hole has a score for every player yet — entered so far: ${escapeHtml(countsLine)}. Fill in the missing scores, then finish.`
          : "No holes entered — nothing to settle."}</p>`;
      } else if (settlement && settlement.transfers.length) {
        settleHtml = `
          <h3 class="games-section-title">Settle up</h3>
          ${stakeRow}
          ${earlyNote}${unevenNote}
          <ul class="game-settle-list">
            ${settlement.transfers.map((t) => `
              <li><span class="settle-who"><strong>${escapeHtml(gamePlayerName(game, t.from))}</strong> pays <strong>${escapeHtml(gamePlayerName(game, t.to))}</strong></span><span class="settle-amount">$${t.amount.toFixed(2)}</span></li>`).join("")}
          </ul>`;
      } else if (settlement) {
        settleHtml = `<h3 class="games-section-title">Settle up</h3>${stakeRow}${earlyNote}${unevenNote}<p class="games-hint">All square — nobody owes anything.</p>`;
      }
    } else {
      settleHtml = `<h3 class="games-section-title">Settle up</h3>${stakeRow}<p class="games-hint">No stake set — bragging rights only. Add one above to settle up, even now.</p>`;
    }
    let extras = "";
    if (game.gameType === "skins" && computed && computed.carrying > 0) {
      extras = `<p class="games-hint">${computed.carrying} skin${computed.carrying === 1 ? "" : "s"} went unclaimed at the end.</p>`;
    }
    return `
      <div class="games-summary">
        <button type="button" class="games-back" data-game-action="home">← Games</button>
        <div class="game-final-hero">
          <p class="game-final-eyebrow">${game.status === "final" ? "Final" : "Finishing up"}</p>
          <h2 class="game-final-name">${escapeHtml(meta ? meta.name : "")}</h2>
          <div class="game-final-standings">
            ${lines.map((l) => `<div class="game-standings-line">${escapeHtml(l)}</div>`).join("")}
          </div>
        </div>
        ${extras}
        ${settleHtml}
        ${game.status === "active" ? `<button type="button" class="primary-button" data-game-action="confirm-finish">Confirm final →</button>
        <button type="button" class="games-back-secondary" data-game-action="resume-play">← Keep playing</button>`
        : `<button type="button" class="games-back-secondary" data-game-action="reopen">Reopen game — fix a score</button>`}
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
      if (action === "finish") { gamesUi.view = "summary"; gamesUi.editingStake = false; }
      if (action === "resume-play") { gamesUi.view = "play"; gamesUi.editingStake = false; }
      if (action === "confirm-finish") {
        const game = getActiveGame();
        if (game) { game.status = "final"; saveGamesState(); }
      }
      if (action === "reopen") {
        // Finality is a UI state, not a contract — a fat-fingered score
        // discovered after Confirm shouldn't leave the money wrong forever.
        const game = getActiveGame();
        if (game) {
          game.status = "active";
          saveGamesState();
          gamesUi.view = "play";
          gamesUi.holeIndex = firstIncompleteGameHole(game);
        }
      }
      if (action === "edit-stake") { gamesUi.editingStake = true; }
      if (action === "set-stake") {
        const game = getActiveGame();
        const input = els.gamesRoot.querySelector(".game-stake-late-input");
        if (game && input) {
          const parsed = parseStakeValue(input.value);
          if (parsed.bad) {
            showToast(`Couldn't read "${parsed.bad}" as a stake — digits only, like 5.`);
            return;
          }
          game.options = { ...(game.options || {}), stake: parsed.value };
          saveGamesState();
          gamesUi.editingStake = false;
          showToast(parsed.value ? `Stake set — $${parsed.value.toFixed(2)}.` : "Stake cleared.");
        }
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
    const parsedStake = parseStakeValue(stakeInput ? stakeInput.value : "");
    if (parsedStake.bad) {
      // A stake the user typed but we can't read must never silently become
      // "no stake" — that's an 18-holes-later surprise on the settle screen.
      showToast(`Couldn't read "${parsedStake.bad}" as a stake — digits only, like 5.`);
      return;
    }
    if (parsedStake.value) options.stake = parsedStake.value;
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
    syncWakeLock();
  }

  // ---- Screen wake lock ---------------------------------------------------
  //
  // Keep the screen awake while actually scoring — a live round on the
  // rounds tab, or a live game on the games tab. iOS releases the lock
  // whenever the app is pocketed; the visibilitychange hook re-acquires on
  // wake. Feature-detected, fails silent (Safari 16.4+ / installed PWAs).
  let screenWakeLock = null;
  function wantsWakeLock() {
    const roundsLive = roundStarted && !editingRoundId
      && !!document.querySelector('.tab-panel[data-tab-panel="rounds"].active');
    const gameLive = gamesUi.view === "play"
      && !!document.querySelector('.tab-panel[data-tab-panel="games"].active');
    return roundsLive || gameLive;
  }
  async function syncWakeLock() {
    if (!("wakeLock" in navigator)) return;
    const want = wantsWakeLock() && document.visibilityState === "visible";
    try {
      if (want && !screenWakeLock) {
        screenWakeLock = await navigator.wakeLock.request("screen");
        screenWakeLock.addEventListener("release", () => { screenWakeLock = null; });
      } else if (!want && screenWakeLock) {
        const lock = screenWakeLock;
        screenWakeLock = null;
        await lock.release();
      }
    } catch {
      screenWakeLock = null;
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncWakeLock();
  });

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
    // The selected routing may change while the device is still resolving a
    // fix. Even preserved hole numbers can refer to different physical holes.
    gpsCaptureGeneration += 1;
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
      if (hole && Array.isArray(hole.shots) && hole.shots.length) {
        setHoleShots(hole.number, hole.shots);
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
      return;
    }
    const doReset = () => {
      clearInProgressRound();
      resetPendingHoles(); resetReviewState();
      resetPendingSurvey(); syncSurveyUiFromState();
      if (els.surveyDetails) els.surveyDetails.open = false;
      resetRoundSetupState();
      resetRoundChrome();
      renderScorecard(getSelectedRoundCourse());
    };
    // Reset was a silent one-tap wipe of the live round — in a
    // localStorage-only app that's unrecoverable. With real entries on the
    // card it now routes through the destructive-confirm sheet.
    const snapshot = captureInProgressRound();
    const scored = snapshot.holes.filter((h) => {
      const score = Number(h.score);
      return Number.isFinite(score) && score > 0;
    }).length;
    if (!roundTouched || !scored) { doReset(); return; }
    const courseName = els.roundCourse && els.roundCourse.selectedOptions[0]
      ? els.roundCourse.selectedOptions[0].textContent : "";
    openDestructiveConfirm({
      title: "Discard this round?",
      message: "The round in progress will be wiped. This cannot be undone.",
      facts: [
        courseName && `Course: ${courseName}`,
        `${scored} hole${scored === 1 ? "" : "s"} scored`
      ],
      confirmLabel: "Discard round",
      showBackupHint: false,
      onConfirm: () => {
        doReset();
        showToast("Round discarded.");
      }
    });
  });
  if (els.voiceRecapPreview) els.voiceRecapPreview.addEventListener("click", previewVoiceRecap);
  if (els.voiceRecapApply) els.voiceRecapApply.addEventListener("click", applyVoiceRecap);
  if (els.voiceRecapInput) els.voiceRecapInput.addEventListener("input", () => {
    pendingVoiceRecap = null;
    renderVoiceRecapStorageNotice();
    syncVoiceRecapApplyState();
  });
  if (els.voiceRecapFreshStoreConfirm) els.voiceRecapFreshStoreConfirm.addEventListener("change", syncVoiceRecapApplyState);

  if (els.startRoundButton) {
    els.startRoundButton.addEventListener("click", startRound);
  }

  if (els.viewToggleButton) {
    els.viewToggleButton.addEventListener("click", () => {
      setViewMode(viewMode === "card" ? "grid" : "card");
    });
  }

  if (els.courseMapButton) {
    els.courseMapButton.addEventListener("click", openCourseMap);
  }

  els.scorecardGrid.addEventListener("keydown", advanceScorecardOnEnter);
  els.scorecardGrid.addEventListener("click", (event) => {
    const gpsButton = event.target.closest("[data-gps-action]");
    if (gpsButton) {
      event.preventDefault();
      void handleGpsShotAction(gpsButton);
      return;
    }
    const deleteGpsButton = event.target.closest("[data-delete-gps-shot]");
    if (deleteGpsButton) {
      event.preventDefault();
      deleteGpsShot(deleteGpsButton);
      return;
    }
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
      if (!course || isDeerwoodCourseId(course.id)) return;
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
      if (!course || isDeerwoodCourseId(course.id)) return;
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
  if (els.voiceDraftBackdrop) els.voiceDraftBackdrop.addEventListener("click", closeVoiceDraft);
  if (els.voiceDraftClose) els.voiceDraftClose.addEventListener("click", closeVoiceDraft);
  if (els.voiceDraftApply) els.voiceDraftApply.addEventListener("click", applyOpenVoiceDraft);
  if (els.voiceDraftArchive) els.voiceDraftArchive.addEventListener("click", archiveOpenVoiceDraft);
  if (els.voiceDraftSaveSettings) els.voiceDraftSaveSettings.addEventListener("click", () => {
    const next = {
      projectUrl: (els.voiceDraftProjectUrl?.value || "").trim().replace(/\/$/, ""),
      anonKey: (els.voiceDraftAnonKey?.value || "").trim(),
      email: (els.voiceDraftEmail?.value || "").trim()
    };
    try { localStorage.setItem(VOICE_DRAFT_CONFIG_KEY, JSON.stringify(next)); } catch {}
    renderVoiceDraftInbox(); requestVoiceDraftSignIn();
  });
  if (els.voiceDraftRefresh) els.voiceDraftRefresh.addEventListener("click", () => refreshVoiceDraftInbox());
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
    const mapAnnotations = normalizeCourseMapAnnotations(state.mapAnnotations);
    const mapAnnotationSeedState = normalizeCourseMapSeedState(state.mapAnnotationSeedState);
    state = {
      courses: structuredClone(sampleCourses),
      rounds: structuredClone(sampleRounds),
      mapAnnotations,
      mapAnnotationSeedState
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
    state = {
      courses: [],
      rounds: [],
      mapAnnotations: createEmptyCourseMapAnnotations(),
      mapAnnotationSeedState: createEmptyCourseMapSeedState()
    };
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
    state = ensureDeerwoodRoundLabels(ensureProfileShape(ensureCourseDataShape(mergeNewDefaultCourses(imported))));
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

  async function initializeApp() {
    captureVoiceDraftAuthReturn();
    const voiceConfig = readVoiceDraftConfig();
    if (els.voiceDraftProjectUrl) els.voiceDraftProjectUrl.value = voiceConfig.projectUrl;
    if (els.voiceDraftAnonKey) els.voiceDraftAnonKey.value = voiceConfig.anonKey;
    if (els.voiceDraftEmail) els.voiceDraftEmail.value = voiceConfig.email;
    sampleCourses = await loadCourseCatalog();
    sampleRounds = buildSampleRounds();
    state = loadState();
    // Set up chip mirrors over the round-setup selects before renderAll
    // runs so the very first paint shows chips, not (now-hidden) selects
    // with a layout gap.
    initSelectChips();
    renderAll();
    setActiveTab(localStorage.getItem(ACTIVE_TAB_KEY) || "home");
    refreshVoiceDraftInbox({ quiet: true });
    // Offer to restore any in-progress round entry that was interrupted
    // (page reload, phone restart, accidental tab close, etc).
    maybeResumeInProgressRound();
    // A phone link from a voice conversation wins over the remembered tab and
    // opens the same preview/explicit-apply path as pasted JSON.
    loadVoiceRecapFromFragment();
  }

  initializeApp();
})();
