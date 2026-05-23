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

  const STORAGE_KEY = "fairwayLedger.v1";
  const ACTIVE_TAB_KEY = "fairwayLedger.activeTab";
  const BACKUP_META_KEY = "fairwayLedger.backupMeta.v1";
  const BRIEF_COLLAPSED_KEY = "fairwayLedger.briefCollapsed.v1";
  const VIEW_MODE_KEY = "fairwayLedger.viewMode.v1";
  const IN_PROGRESS_KEY = "fairwayLedger.inProgressRound.v1";
  const IN_PROGRESS_DEBOUNCE_MS = 500;
  const BACKUP_NAG_THRESHOLD = 3;
  const today = new Date().toISOString().slice(0, 10);

  let sampleCourses = [];
  let selectedCourseDetailId = null;
  let editingRoundId = null;
  let viewMode = readInitialViewMode();

  // ---- Per-hole pending state (in-progress round data) -------------------
  //
  // One map of hole-number -> { note, shots, clubs, penaltyClub } holds every
  // per-hole input that isn't a DOM field. Adding a new per-hole field means
  // extending this shape + one getter/setter pair — NOT a new top-level map
  // and a new entry in every reset call site.
  //
  // The serialized in-progress draft still uses the older flat layout
  // (holeNotes, holeShots, holeClubs, holePenaltyClubs) so existing saved
  // drafts continue to restore unchanged. captureInProgressRound translates
  // on write; restoreInProgressRound uses the same setters that pre-existed.

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
      && !(entry.shots && entry.shots.length)
      && !(entry.clubs && entry.clubs.length)
      && !entry.penaltyClub;
    if (empty) delete pendingHoles[key];
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
  // keep it out of the lead slot whenever another club is present — that way
  // removing a pre-seeded Driver and tapping the real tee club just works.
  function normalizeClubOrder(clubs) {
    if (clubs.length > 1 && clubs[0] === "Putter") {
      return [...clubs.slice(1), "Putter"];
    }
    return clubs;
  }

  function setHoleClubs(holeNumber, clubs) {
    const entry = getOrCreatePendingHole(holeNumber);
    if (Array.isArray(clubs) && clubs.length) {
      entry.clubs = normalizeClubOrder([...clubs]);
    } else {
      delete entry.clubs;
    }
    compactPendingHole(holeNumber);
  }

  // Pre-select the likely clubs on every hole so the card shows them ready:
  // Driver (tee shot) + Putter on par 4/5/6; just Putter on par 3 (the iron
  // tee shot is up to the player). The TEE badge is suppressed when only
  // Putter is selected, so a fresh par 3 doesn't mislead. Skipped in edit
  // mode.
  function seedDefaultClubs(course) {
    if (editingRoundId || !course || !Array.isArray(course.holes)) return;
    course.holes.forEach((hole) => {
      if (getHoleClubs(hole.number).length > 0) return;
      // Default seed depends on hole type, then is filtered to the bag —
      // never pre-select a club the user has said they don't carry.
      const desired = hole.par === 3 ? ["Putter"] : ["Driver", "Putter"];
      const filtered = desired.filter(isInBag);
      if (filtered.length) setHoleClubs(hole.number, filtered);
    });
  }

  function toggleHoleClub(holeNumber, club) {
    const current = getHoleClubs(holeNumber);
    const next = current.includes(club) ? current.filter((c) => c !== club) : [...current, club];
    setHoleClubs(holeNumber, next);
    return next;
  }

  // ---- Penalty club ------------------------------------------------------
  //
  // The club blamed for a hole's penalty stroke(s) — one per hole, defaults
  // to the tee club when a penalty is first logged.

  function getHolePenaltyClub(holeNumber) {
    const entry = pendingHoles[String(holeNumber)];
    return (entry && entry.penaltyClub) || "";
  }

  function setHolePenaltyClub(holeNumber, club) {
    const entry = getOrCreatePendingHole(holeNumber);
    if (club) entry.penaltyClub = club;
    else delete entry.penaltyClub;
    compactPendingHole(holeNumber);
  }

  // ---- GPS shots ---------------------------------------------------------

  function getHoleShots(holeNumber) {
    const entry = pendingHoles[String(holeNumber)];
    return (entry && entry.shots) || [];
  }

  function setHoleShots(holeNumber, shots) {
    const entry = getOrCreatePendingHole(holeNumber);
    if (Array.isArray(shots) && shots.length) {
      entry.shots = shots;
    } else {
      delete entry.shots;
    }
    compactPendingHole(holeNumber);
  }

  function appendHoleShot(holeNumber, shot) {
    const entry = getOrCreatePendingHole(holeNumber);
    entry.shots = [...(entry.shots || []), shot];
    return entry.shots;
  }

  function updateHoleShotAtIndex(holeNumber, index, partial) {
    const entry = pendingHoles[String(holeNumber)];
    const existing = (entry && entry.shots) || [];
    if (!existing[index]) return existing;
    const next = existing.map((shot, i) => (i === index ? { ...shot, ...partial } : shot));
    if (entry) entry.shots = next;
    return next;
  }

  function deleteHoleShotAtIndex(holeNumber, index) {
    const entry = pendingHoles[String(holeNumber)];
    const existing = (entry && entry.shots) || [];
    const next = existing.filter((_shot, i) => i !== index);
    // Recompute distances since shot positions are relative to predecessors.
    const rebuilt = next.map((shot, i) => {
      if (i === 0) return { ...shot, distanceYards: null };
      const prev = next[i - 1];
      const meters = haversineMeters(prev.lat, prev.lon, shot.lat, shot.lon);
      return { ...shot, distanceYards: Math.round(metersToYards(meters)) };
    });
    if (entry) {
      if (rebuilt.length) {
        entry.shots = rebuilt;
      } else {
        delete entry.shots;
        compactPendingHole(holeNumber);
      }
    }
    return rebuilt;
  }

  // Subscribes to GPS updates via watchPosition, collects samples, returns
  // the MEDIAN position (robust to outliers) once we have enough confident
  // samples or the timer expires. Median is much more reliable than "best
  // accuracy" alone because a single fix can be a flier even with optimistic
  // accuracy metadata.
  function getFreshPositionAsync(timeoutMs = 10000, onProgress) {
    return new Promise((resolve, reject) => {
      if (!navigator || !navigator.geolocation) {
        reject(new Error("Your device does not support location."));
        return;
      }
      if (typeof window !== "undefined" && window.isSecureContext === false) {
        reject(new Error("INSECURE_CONTEXT"));
        return;
      }
      const samples = [];
      let resolved = false;
      let watchId = null;
      const startTime = Date.now();
      const finish = (result, error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        if (error) reject(error);
        else resolve(result);
      };
      const median = (arr) => {
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
      };
      const finalize = () => {
        if (!samples.length) {
          finish(null, new Error("GPS timeout — try again outdoors with a clear sky view."));
          return;
        }
        // Drop the first sample — it's often the stalest one the OS had cached.
        const useful = samples.length >= 3 ? samples.slice(1) : samples;
        const medianPos = {
          coords: {
            latitude: median(useful.map((s) => s.coords.latitude)),
            longitude: median(useful.map((s) => s.coords.longitude)),
            accuracy: median(useful.map((s) => s.coords.accuracy))
          },
          timestamp: Date.now(),
          sampleCount: useful.length
        };
        finish(medianPos);
      };
      const timer = setTimeout(finalize, timeoutMs);
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          samples.push(position);
          const bestAccuracySoFar = Math.min(...samples.map((s) => s.coords.accuracy));
          if (typeof onProgress === "function") {
            try { onProgress({
              accuracy: bestAccuracySoFar,
              elapsed: Date.now() - startTime,
              sampleCount: samples.length
            }); } catch {}
          }
          // Early-resolve criteria, all required:
          //  - at least 3 samples collected (so median has something to chew on)
          //  - latest sample reports accuracy <= 8 m (~9 yds)
          //  - we've spent at least 2.5 s collecting (GPS settle time)
          if (samples.length >= 3 && position.coords.accuracy <= 8 && Date.now() - startTime >= 2500) {
            finalize();
          }
        },
        (error) => {
          if (samples.length) finalize();
          else finish(null, error);
        },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
      );
    });
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
  const DEERWOOD_TEE_OPTIONS = ["White", "Blue"];
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
  let state = { courses: [], rounds: [], profile: { bag: [] } };

  const els = {
    metricRounds: document.getElementById("metricRounds"),
    metricAverageScore: document.getElementById("metricAverageScore"),
    metricAverageScoreNote: document.getElementById("metricAverageScoreNote"),
    metricAveragePar: document.getElementById("metricAveragePar"),
    metricBestRound: document.getElementById("metricBestRound"),
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
    roundSetup: document.getElementById("roundSetup"),
    roundSetupBanner: document.getElementById("roundSetupBanner"),
    roundNote: document.getElementById("roundNote"),
    roundCourseMeta: document.getElementById("roundCourseMeta"),
    roundBrief: document.getElementById("roundBrief"),
    roundLiveSummary: document.getElementById("roundLiveSummary"),
    completionCheck: document.getElementById("completionCheck"),
    reviewSection: document.getElementById("reviewSection"),
    roundForm: document.getElementById("roundForm"),
    resetRoundButton: document.getElementById("resetRoundButton"),
    viewToggleButton: document.getElementById("viewToggleButton"),
    roundEntryTitle: document.getElementById("roundEntryTitle"),
    roundSubmitButton: document.getElementById("roundSubmitButton"),
    scorecardGrid: document.getElementById("scorecardGrid"),
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
    deerwoodByNinePanel: document.getElementById("deerwoodByNinePanel"),
    deerwoodByNineCard: document.getElementById("deerwoodByNineCard"),
    profileBagGrid: document.getElementById("profileBagGrid"),
    profileBagSummary: document.getElementById("profileBagSummary"),
    bagResetButton: document.getElementById("bagResetButton"),
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
    courseLookupForm: document.getElementById("courseLookupForm"),
    courseLookupQuery: document.getElementById("courseLookupQuery"),
    courseLookupResults: document.getElementById("courseLookupResults"),
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

  function normalizeCourse(course) {
    return {
      ...course,
      rating: Number.isFinite(Number(course.rating)) ? Number(course.rating) : null,
      slope: Number.isFinite(Number(course.slope)) ? Number(course.slope) : null,
      holes: Array.isArray(course.holes) ? course.holes.map(toHole) : []
    };
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
        return ensureProfileShape(ensureCourseDataShape(mergeNewDefaultCourses(saved)));
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  // Per-session sticky state for the card's "More on this hole" collapse —
  // open it once and subsequent holes start open too. Resets on every new
  // round (resetRoundChrome). Edit mode always opens it regardless.
  let cardMoreSticky = false;

  function captureInProgressRound() {
    const snapshot = captureScorecardSnapshot();
    const holes = [];
    snapshot.forEach((values, holeNumber) => {
      holes.push({ number: holeNumber, ...values });
    });
    return {
      v: 1,
      savedAt: Date.now(),
      date: els.roundDate ? els.roundDate.value || "" : "",
      course: els.roundCourse ? els.roundCourse.value || "" : "",
      holeCount: els.roundHoleCount ? els.roundHoleCount.value || "" : "",
      layoutId: els.roundLayout ? els.roundLayout.value || "" : "",
      tee: els.roundTee ? els.roundTee.value || "" : "",
      wind: els.roundWind ? els.roundWind.value || "" : "",
      note: els.roundNote ? els.roundNote.value || "" : "",
      holes,
      // Wire format mirrors the older flat-map layout so existing in-progress
      // drafts continue to restore — translate from unified pendingHoles.
      ...(() => {
        const holeNotes = {};
        const holeShots = {};
        const holeClubs = {};
        const holePenaltyClubs = {};
        Object.entries(pendingHoles).forEach(([key, data]) => {
          if (data.note) holeNotes[key] = data.note;
          if (data.shots && data.shots.length) holeShots[key] = JSON.parse(JSON.stringify(data.shots));
          if (data.clubs && data.clubs.length) holeClubs[key] = [...data.clubs];
          if (data.penaltyClub) holePenaltyClubs[key] = data.penaltyClub;
        });
        return { holeNotes, holeShots, holeClubs, holePenaltyClubs };
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
      const hasShots = Object.keys(draft.holeShots || {}).length > 0;
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
    Object.entries(data.holeNotes || {}).forEach(([num, note]) => setHoleNote(num, note));
    Object.entries(data.holeShots || {}).forEach(([num, shots]) => {
      if (Array.isArray(shots) && shots.length) setHoleShots(Number(num), shots);
    });
    Object.entries(data.holeClubs || {}).forEach(([num, clubs]) => {
      if (Array.isArray(clubs) && clubs.length) setHoleClubs(Number(num), clubs);
    });
    Object.entries(data.holePenaltyClubs || {}).forEach(([num, club]) => {
      if (club) setHolePenaltyClub(Number(num), club);
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
    const shotCount = Object.values(data.holeShots || {}).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0
    );
    const noteCount = Object.keys(data.holeNotes || {}).length;
    if (!scoreCount && !shotCount && !noteCount) {
      clearInProgressRound();
      return;
    }
    const parts = [];
    if (scoreCount) parts.push(`${scoreCount} hole${scoreCount === 1 ? "" : "s"} scored`);
    if (shotCount) parts.push(`${shotCount} GPS shot${shotCount === 1 ? "" : "s"}`);
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
    return getCourse(els.roundCourse.value);
  }

  function ensureSavedCourse(course) {
    if (!course || state.courses.some((candidate) => candidate.id === course.id)) return;
    state.courses.push(course);
  }

  function getFilteredRounds() {
    const courseValue = els.filterCourse.value || "all";
    const teeValue = els.filterTee.value || "all";
    let rounds = [...state.rounds];

    if (courseValue === DEERWOOD_COURSE_ID) {
      rounds = rounds.filter((round) => isDeerwoodCourseId(round.courseId));
    } else if (courseValue !== "all") {
      rounds = rounds.filter((round) => round.courseId === courseValue);
    }

    if (teeValue !== "all") {
      rounds = rounds.filter((round) => round.tee === teeValue);
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
        const chip = event.target.closest("[data-chip-value]");
        if (!chip) return;
        const value = chip.dataset.chipValue;
        if (select.value === value) return;
        select.value = value;
        // Bubbles so any listener on form / parent picks it up.
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
    syncAllChipsToSelects();
  }

  function syncAllChipsToSelects() {
    document.querySelectorAll('select[data-use-chips="true"]').forEach(syncChipsForSelect);
  }

  function syncChipsForSelect(select) {
    const row = document.querySelector(`[data-chips-for="${select.id}"]`);
    if (!row) return;
    const currentValue = select.value;
    // Skip placeholder options whose value is "" (e.g. the leading "Wind…").
    // The unselected state is communicated by no chip being active.
    const opts = [...select.options].filter((opt) => opt.value !== "");
    row.innerHTML = opts.map((opt) => `
      <button type="button"
              class="select-chip${opt.value === currentValue ? " active" : ""}"
              data-chip-value="${escapeHtml(opt.value)}">
        ${escapeHtml(opt.text || opt.value)}
      </button>
    `).join("");
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
    els.roundHoleCountField.hidden = !isDeerwood;
    els.roundTeeField.hidden = !isDeerwood;
    if (!isDeerwood) {
      els.roundLayoutField.hidden = true;
      els.roundFrontNineField.hidden = true;
      els.roundBackNineField.hidden = true;
      return;
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
      const currentNine = els.roundLayout.value;
      els.roundLayout.innerHTML = nines
        .map((nine) => `<option value="${nine.id}">${nine.label}</option>`)
        .join("");
      els.roundLayout.value = nines.some((n) => n.id === currentNine) ? currentNine : nines[0].id;
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
    if (viewMode === "card") applyCardMoreToActive();
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

  // Pills for fast on-course tap entry. Each pill row writes to the hidden
  // typed input (which preserves all existing read/save logic) plus offers
  // a small custom input as an escape hatch for values outside the pill set.
  function renderPillsRow({ label, holeNumber, inputClass, values, customMin, customMax, customPlaceholder = "…", parValue, scoreTiers = false }) {
    const pills = values.map((v) => {
      const isPar = parValue !== undefined && Number(v) === Number(parValue);
      let tierCls = "";
      // Score pills carry their scoring-tier shape (circle birdie / box bogey).
      if (scoreTiers && parValue !== undefined) {
        const variant = scoreMarkClass(Number(v), Number(parValue));
        if (variant) tierCls = ` pill-${variant.replace("score-mark-", "tier-")}`;
      }
      return `<button type="button" class="pill${isPar ? " pill-par" : ""}${tierCls}" data-pill-value="${v}">${v}</button>`;
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
    return renderPillsRow({
      label: "Putts",
      holeNumber: hole.number,
      inputClass: "putts-input",
      values: [0, 1, 2, 3, 4, 5],
      customMin: 0,
      customMax: 8
    });
  }

  function renderPenPills(hole) {
    return renderPillsRow({
      label: "Pen",
      holeNumber: hole.number,
      inputClass: "penalty-input",
      values: [0, 1, 2, 3],
      customMin: 0,
      customMax: 8
    });
  }

  function renderFirstPuttPills(hole) {
    return renderPillsRow({
      label: "1st putt (ft)",
      holeNumber: hole.number,
      inputClass: "first-putt-input",
      values: [3, 6, 10, 15, 20, 30, 50],
      customMin: 0,
      customMax: 120,
      customPlaceholder: "ft"
    });
  }

  function renderFairwayPills(hole) {
    if (hole.par === 3) {
      return `
        <div class="card-pill-row" data-pill-group="fairway-input" data-hole="${hole.number}">
          <span class="card-pill-label">Fairway</span>
          <span class="card-pill-na">N/A (par 3)</span>
        </div>`;
    }
    const options = [
      { value: "hit", label: "Hit" },
      { value: "left", label: "Left" },
      { value: "right", label: "Right" },
      { value: "short", label: "Short" },
      { value: "long", label: "Long" },
      { value: "miss", label: "Miss" }
    ];
    const pills = options.map((opt) => `<button type="button" class="pill" data-pill-value="${opt.value}">${escapeHtml(opt.label)}</button>`).join("");
    return `
      <div class="card-pill-row" data-pill-group="fairway-input" data-hole="${hole.number}">
        <span class="card-pill-label">Fairway</span>
        <div class="card-pill-options card-pill-options-no-custom">${pills}</div>
      </div>`;
  }

  function renderClubsHitPills(hole) {
    const selected = getHoleClubs(hole.number); // ordered array — index 0 is tee club
    const selectedSet = new Set(selected);
    // Putter is never a tee shot. If it's the only club selected (e.g. a
    // freshly-seeded par 3) suppress the TEE badge until a real tee club
    // joins the list.
    const teeClub = (selected[0] && !(selected[0] === "Putter" && selected.length === 1)) ? selected[0] : null;
    // Only render pills for clubs in the user's bag (plus any already
    // selected on this hole, even if they're no longer in the bag).
    const available = clubsForHole(hole.number);
    const pills = available.map((club) => {
      const isActive = selectedSet.has(club);
      const isTee = club === teeClub;
      const cls = `pill pill-club${isActive ? " active" : ""}${isTee ? " pill-club-tee" : ""}`;
      const teeBadge = isTee ? `<span class="pill-tee-badge" aria-label="tee shot">TEE</span>` : "";
      return `<button type="button" class="${cls}" data-toggle-club="${escapeHtml(club)}" data-hole="${hole.number}">${escapeHtml(club)}${teeBadge}</button>`;
    }).join("");
    return `
      <div class="card-clubs-row" data-hole="${hole.number}">
        <span class="card-pill-label">Clubs hit <span class="card-pill-sublabel">(first tap = tee shot)</span></span>
        <div class="card-clubs-grid">${pills}</div>
      </div>`;
  }

  const CLUB_OPTIONS = [
    "Driver", "3W", "5W", "7W", "Hybrid",
    "3i", "4i", "5i", "6i", "7i", "8i", "9i",
    "PW", "50°", "52°", "54°", "56°", "58°", "60°",
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
    const penaltyClub = getHolePenaltyClub(holeNumber);
    const extras = [];
    onHole.forEach((club) => {
      if (!bag.includes(club) && !extras.includes(club)) extras.push(club);
    });
    if (penaltyClub && !bag.includes(penaltyClub) && !extras.includes(penaltyClub)) {
      extras.push(penaltyClub);
    }
    // Preserve canonical CLUB_OPTIONS order: bag clubs first (in canon order),
    // then any extras (in canon order).
    return CLUB_OPTIONS.filter((c) => bag.includes(c) || extras.includes(c));
  }

  // Shown only when a hole has a penalty logged — captures which club caused
  // it. syncPenaltyClubRows() toggles visibility and defaults to the tee club.
  function renderPenaltyClubRow(hole) {
    const current = getHolePenaltyClub(hole.number);
    const options = clubsForHole(hole.number)
      .map((club) => `<option value="${escapeHtml(club)}"${club === current ? " selected" : ""}>${escapeHtml(club)}</option>`)
      .join("");
    return `
      <div class="card-penalty-club-row" data-hole="${hole.number}" hidden>
        <span class="card-pill-label">Penalty club</span>
        <select class="penalty-club-input compact-select" data-hole="${hole.number}" aria-label="Club that caused the penalty">
          <option value="">— club —</option>
          ${options}
        </select>
      </div>`;
  }

  function renderShotsBlock(holeNumber) {
    const shots = getHoleShots(holeNumber);
    const header = `
      <div class="card-shots-header">
        <p class="card-shots-title">Shot tracker</p>
        <button type="button" class="card-shot-button" data-mark-shot="${holeNumber}">
          ${shots.length === 0 ? "📍 Mark starting position" : "📍 Mark next shot end"}
        </button>
      </div>`;
    if (shots.length === 0) {
      return header + `<p class="card-shots-empty">Tap before your first swing to capture your tee position, then tap again at your ball after each shot. Distances populate automatically.</p>`;
    }
    const rows = shots.map((shot, index) => {
      const isStart = index === 0;
      const distanceLabel = isStart
        ? `<span class="card-shot-distance start">Start</span>`
        : `<span class="card-shot-distance">${shot.distanceYards} yds</span>`;
      // Show bag clubs + the club that was already chosen for this shot (if
      // it's no longer in the bag) so existing data stays editable.
      const bag = getBag();
      const shotClubs = CLUB_OPTIONS.filter((c) => bag.includes(c) || c === shot.club);
      const clubOptions = shotClubs.map((club) => `<option value="${escapeHtml(club)}"${club === shot.club ? " selected" : ""}>${escapeHtml(club)}</option>`).join("");
      const clubPicker = isStart
        ? `<span class="card-shot-club-static">Tee position</span>`
        : `<select class="card-shot-club" data-shot-club="${holeNumber}" data-shot-index="${index}" aria-label="Club for shot ${index}"><option value="">Club…</option>${clubOptions}</select>`;
      const accuracyMeta = Number.isFinite(shot.accuracy)
        ? `<small class="card-shot-accuracy">±${Math.round(metersToYards(shot.accuracy))} yds</small>`
        : "";
      return `
        <li class="card-shot-row" data-shot-row="${index}">
          <div class="card-shot-row-top">
            <span class="card-shot-index">${isStart ? "Start" : `Shot ${index}`}</span>
            ${distanceLabel}
            <button type="button" class="card-shot-delete" data-delete-shot="${holeNumber}" data-shot-index="${index}" aria-label="Delete shot ${index}">×</button>
          </div>
          <div class="card-shot-row-bottom">
            ${clubPicker}
            ${accuracyMeta}
          </div>
        </li>`;
    }).join("");
    return header + `<ul class="card-shot-list">${rows}</ul>`;
  }

  async function handleMarkShot(holeNumber, buttonElement) {
    if (buttonElement.dataset.busy === "true") return;
    buttonElement.dataset.busy = "true";
    const originalText = buttonElement.textContent;
    buttonElement.textContent = "📡 Getting GPS…";
    buttonElement.disabled = true;
    try {
      const position = await getFreshPositionAsync(10000, ({ accuracy, sampleCount }) => {
        const yds = Math.round(metersToYards(accuracy));
        buttonElement.textContent = `📡 ±${yds} yds · ${sampleCount} fix${sampleCount === 1 ? "" : "es"}`;
      });
      const existing = getHoleShots(holeNumber);
      const next = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        accuracy: position.coords.accuracy,
        timestamp: Date.now(),
        club: "",
        distanceYards: null
      };
      if (existing.length > 0) {
        const prev = existing[existing.length - 1];
        const meters = haversineMeters(prev.lat, prev.lon, next.lat, next.lon);
        next.distanceYards = Math.round(metersToYards(meters));
      }
      appendHoleShot(holeNumber, next);
      refreshShotsBlock(holeNumber);
      scheduleInProgressSave();
      const accuracyYds = Number.isFinite(position.coords.accuracy)
        ? Math.round(metersToYards(position.coords.accuracy))
        : null;
      const sampleNote = position.sampleCount ? `, ${position.sampleCount} fixes` : "";
      const accuracyNote = accuracyYds !== null ? ` (±${accuracyYds} yds${sampleNote})` : "";
      if (existing.length === 0) {
        showToast(`Start position captured${accuracyNote}.`);
      } else {
        // If the computed distance is inside the combined GPS error window,
        // the result is statistically meaningless — warn the user honestly.
        // Also warn if the accuracy itself is poor (>25 yds error) regardless
        // of distance, since that means GPS is unreliable here at all.
        const prev = existing[existing.length - 1];
        const combinedErrorYds = Math.round(metersToYards((prev.accuracy || 0) + (position.coords.accuracy || 0)));
        if (accuracyYds !== null && accuracyYds > 25) {
          showToast(`Recorded ${next.distanceYards} yds but GPS accuracy here is poor (±${accuracyYds} yds). Move to clearer sky and consider re-marking.`);
        } else if (next.distanceYards < combinedErrorYds || next.distanceYards < 5) {
          showToast(`Recorded ${next.distanceYards} yds — but GPS noise here is ±${combinedErrorYds} yds. Short shots (<30 yds) aren't reliable; use the × to delete if it's wrong.`);
        } else {
          showToast(`Shot recorded: ${next.distanceYards} yds${accuracyNote}.`);
        }
      }
    } catch (error) {
      const message = describeGeolocationError(error);
      showToast(message);
      buttonElement.textContent = originalText;
      buttonElement.disabled = false;
    } finally {
      buttonElement.dataset.busy = "false";
    }
  }

  function describeGeolocationError(error) {
    if (error && error.message === "INSECURE_CONTEXT") {
      return "Shot tracking needs a secure (https://) page. The deployed app on GitHub Pages works; opening index.html directly from disk does not.";
    }
    if (!error || typeof error.code !== "number") return "Could not get location. Try again outdoors with a clear sky view.";
    if (error.code === 1) return "Location permission denied. Enable it in your browser settings (or your phone's Settings → Safari/Chrome → Location) to track shots.";
    if (error.code === 2) return "GPS unavailable right now. Try again in a moment — sometimes a cloudy sky or being indoors blocks the signal.";
    if (error.code === 3) return "GPS read timed out. Try again — sometimes the first read is slow, especially indoors.";
    return error.message || "Could not get location.";
  }

  function refreshShotsBlock(holeNumber) {
    const container = els.scorecardGrid.querySelector(`.card-shots[data-hole="${holeNumber}"]`);
    if (!container) return;
    container.innerHTML = renderShotsBlock(holeNumber);
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
            ${fairwayInputCell(hole)}
            ${penaltyInputCell(hole)}
            ${girInputCell(hole)}
          </div>
          ${renderScorePills(hole)}
          ${renderPuttsPills(hole)}
          <button type="button" class="card-more-toggle" data-toggle-more aria-expanded="false">
            <span class="card-more-toggle-text">More on this hole</span>
            <span class="card-more-toggle-caret" aria-hidden="true">▾</span>
          </button>
          <div class="card-more" hidden>
            ${renderFirstPuttPills(hole)}
            ${renderFairwayPills(hole)}
            ${renderPenPills(hole)}
            ${renderPenaltyClubRow(hole)}
            ${renderClubsHitPills(hole)}
            <label class="card-note-field">
              <span>What happened on this hole?</span>
              <textarea class="card-note-input" data-hole="${hole.number}" rows="2" placeholder="Drove left, chipped twice, 2-putt from 12ft… (tap the mic on your keyboard for voice)">${escapeHtml(getHoleNote(hole.number))}</textarea>
            </label>
            <div class="card-shots" data-hole="${hole.number}">${renderShotsBlock(hole.number)}</div>
          </div>
        </article>`;
    }).join("");

    return `
      <div class="scorecard-cards" data-active-index="0">${cards}</div>
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
  // Open/close the "More on this hole" collapse on a card. The Score and
  // Putts rows are always visible; everything else (1st putt, fairway, pen,
  // clubs hit, note, shot tracker) lives inside the .card-more block.
  function setCardMore(card, open) {
    if (!card) return;
    const moreDiv = card.querySelector(".card-more");
    const toggleBtn = card.querySelector(".card-more-toggle");
    if (moreDiv) moreDiv.hidden = !open;
    if (toggleBtn) {
      toggleBtn.setAttribute("aria-expanded", String(open));
      toggleBtn.classList.toggle("is-open", open);
      const text = toggleBtn.querySelector(".card-more-toggle-text");
      const caret = toggleBtn.querySelector(".card-more-toggle-caret");
      if (text) text.textContent = open ? "Hide details" : "More on this hole";
      if (caret) caret.textContent = open ? "▴" : "▾";
    }
  }

  function applyCardMoreToActive() {
    if (viewMode !== "card") return;
    const card = els.scorecardGrid.querySelector(".scorecard-card.active");
    if (!card) return;
    // Edit mode reveals everything for review; a fresh round starts closed
    // unless the user has stickied it open on an earlier hole this session.
    const open = !!editingRoundId || cardMoreSticky;
    setCardMore(card, open);
  }

  function prefillActiveCardPar() {
    if (editingRoundId || viewMode !== "card") return;
    const activeCard = els.scorecardGrid.querySelector(".scorecard-card.active");
    if (!activeCard) return;
    const scoreInput = activeCard.querySelector(".score-input");
    if (!(scoreInput instanceof HTMLInputElement) || scoreInput.value.trim() !== "") return;
    const par = Number(scoreInput.dataset.par) || 4;
    scoreInput.value = String(par);
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
    // Apply the user's "More on this hole" preference to the new card.
    applyCardMoreToActive();
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
      const moreToggle = event.target.closest("[data-toggle-more]");
      if (moreToggle) {
        event.preventDefault();
        const card = moreToggle.closest(".scorecard-card");
        const moreDiv = card ? card.querySelector(".card-more") : null;
        const nextOpen = moreDiv ? moreDiv.hidden : true; // open if currently hidden
        cardMoreSticky = nextOpen;
        setCardMore(card, nextOpen);
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
        return;
      }
      const markShotButton = event.target.closest("[data-mark-shot]");
      if (markShotButton) {
        event.preventDefault();
        handleMarkShot(markShotButton.dataset.markShot, markShotButton);
        return;
      }
      const deleteShotButton = event.target.closest("[data-delete-shot]");
      if (deleteShotButton) {
        event.preventDefault();
        const holeNumber = deleteShotButton.dataset.deleteShot;
        const index = Number(deleteShotButton.dataset.shotIndex);
        deleteHoleShotAtIndex(holeNumber, index);
        refreshShotsBlock(holeNumber);
        scheduleInProgressSave();
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
      const clubSelect = event.target.closest("[data-shot-club]");
      if (clubSelect) {
        const holeNumber = clubSelect.dataset.shotClub;
        const index = Number(clubSelect.dataset.shotIndex);
        updateHoleShotAtIndex(holeNumber, index, { club: clubSelect.value });
        scheduleInProgressSave();
        return;
      }
      const penClubSelect = event.target.closest(".penalty-club-input");
      if (penClubSelect) {
        setHolePenaltyClub(penClubSelect.dataset.hole, penClubSelect.value);
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
    row.querySelectorAll(".pill").forEach((p) => {
      p.classList.toggle("active", p.dataset.pillValue !== undefined && String(p.dataset.pillValue) === String(value));
    });
  }

  function syncAllPillActiveStates() {
    els.scorecardGrid.querySelectorAll(".card-pill-row").forEach(syncPillActiveStateForRow);
    syncCardScoreMarks();
    syncPenaltyClubRows();
  }

  // Reveal the penalty-club picker only on holes with a penalty logged, and
  // default it to the tee club the first time a penalty appears.
  function syncPenaltyClubRows() {
    els.scorecardGrid.querySelectorAll(".card-penalty-club-row[data-hole]").forEach((row) => {
      const hole = row.dataset.hole;
      const penInput = els.scorecardGrid.querySelector(`.penalty-input[data-hole="${hole}"]`);
      const pen = penInput ? Number(penInput.value) : 0;
      const show = Number.isFinite(pen) && pen > 0;
      row.hidden = !show;
      if (!show) return;
      const select = row.querySelector(".penalty-club-input");
      if (select && !select.value && !getHolePenaltyClub(hole)) {
        // Default to the hole's tee club; fall back to Driver, or the first
        // non-Putter club in the bag if Driver isn't carried.
        const bag = getBag();
        const tee = getHoleClubs(hole)[0];
        const fallback = bag.includes("Driver") ? "Driver" : (bag.find((c) => c !== "Putter") || "");
        const guess = tee || fallback;
        if (guess && [...select.options].some((option) => option.value === guess)) {
          select.value = guess;
          setHolePenaltyClub(hole, guess);
        }
      }
    });
  }

  // GIR is purely a function of score + putts + par, so the user never needs
  // to tick it. Recompute on every score/putts change and update the hidden
  // checkbox so save/readScorecard see the right value. Also auto-add Putter
  // to clubsHit whenever putts > 0 (the user's "if I putted, putter was used"
  // rule).
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
    if (Number.isFinite(putts) && putts > 0 && isInBag("Putter") && !getHoleClubs(hole).includes("Putter")) {
      setHoleClubs(hole, [...getHoleClubs(hole), "Putter"]);
      const row = els.scorecardGrid.querySelector(`.card-clubs-row[data-hole="${hole}"]`);
      if (row) row.outerHTML = renderClubsHitPills({ number: hole });
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

  function renderCompletionCheck(allHoles, enteredHoles) {
    if (!els.completionCheck) return;
    if (!allHoles.length) {
      els.completionCheck.innerHTML = "";
      els.completionCheck.hidden = true;
      return;
    }
    // Identify what's missing: score is required; flag empty putts (user
    // cleared) or empty first-putt-distance (truly null) as soft warnings.
    const missingScore = [];
    const missingPutts = [];
    const missingFirstPutt = [];
    allHoles.forEach((hole) => {
      const hasScore = Number.isFinite(hole.score) && hole.score > 0;
      if (!hasScore) {
        missingScore.push(hole);
        return; // Other fields aren't worth flagging on a hole with no score
      }
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
      const girInput = els.scorecardGrid.querySelector(`.gir-input[data-hole="${hole}"]`);
      const penaltyInput = els.scorecardGrid.querySelector(`.penalty-input[data-hole="${hole}"]`);
      const firstPuttInput = els.scorecardGrid.querySelector(`.first-putt-input[data-hole="${hole}"]`);
      map.set(Number(hole), {
        score: scoreInput.value,
        putts: puttsInput ? puttsInput.value : "",
        fairway: fairwayInput ? fairwayInput.value : "",
        gir: girInput ? girInput.checked : false,
        penalty: penaltyInput ? penaltyInput.value : "",
        firstPutt: firstPuttInput ? firstPuttInput.value : ""
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
      const girInput = els.scorecardGrid.querySelector(`.gir-input[data-hole="${hole}"]`);
      const penaltyInput = els.scorecardGrid.querySelector(`.penalty-input[data-hole="${hole}"]`);
      const firstPuttInput = els.scorecardGrid.querySelector(`.first-putt-input[data-hole="${hole}"]`);
      if (scoreInput && values.score !== "") scoreInput.value = values.score;
      if (puttsInput && values.putts !== "") puttsInput.value = values.putts;
      if (fairwayInput && values.fairway && [...fairwayInput.options].some((option) => option.value === values.fairway)) {
        fairwayInput.value = values.fairway;
      }
      if (girInput) girInput.checked = Boolean(values.gir);
      if (penaltyInput && values.penalty !== "") penaltyInput.value = values.penalty;
      if (firstPuttInput && values.firstPutt !== "") firstPuttInput.value = values.firstPutt;
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
    // Per-hole "More" collapse goes back to closed for a new round.
    cardMoreSticky = false;
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
    // when they tap their first score pill. (Tapping a pill mid-page when
    // an element above grows from 0 to 100px otherwise pushes the content
    // they're looking at down by 100px, which feels like the page scrolled
    // up.)
    const complete = entered.length === allHoles.length;
    const gross = entered.reduce((sum, hole) => sum + hole.score, 0);
    const par = entered.reduce((sum, hole) => sum + hole.par, 0);
    const putts = entered.reduce((sum, hole) => sum + hole.putts, 0);
    const penalties = entered.reduce((sum, hole) => sum + hole.penalties, 0);
    const girMade = entered.filter((hole) => hole.gir).length;
    const fairwayHoles = entered.filter((hole) => hole.fairway && hole.fairway !== "na");
    const fairwaysHit = fairwayHoles.filter((hole) => hole.fairway === "hit").length;
    const differential = (entered.length && complete) ? estimateRoundDifferential(getSelectedRoundCourse(), entered) : null;
    const sgTotal = entered.length ? entered.reduce((sum, hole) => sum + (holeStrokesGained(hole) || 0), 0) : null;
    const throughSuffix = entered.length ? (complete ? "" : ` | thru ${entered.length}/${allHoles.length}`) : "";

    els.roundPreview.textContent = entered.length
      ? `${gross} (${formatSigned(gross - par, 0)}) | ${putts} putts${throughSuffix}`
      : "--";

    const grossLabel = !entered.length ? "Gross" : complete ? "Gross" : `Gross (thru ${entered.length})`;
    const grossValue = entered.length ? gross : "--";
    const toParValue = entered.length ? formatSigned(gross - par, 0) : "--";
    const puttsValue = entered.length ? putts : "--";
    const firValue = fairwayHoles.length ? percentage(fairwaysHit, fairwayHoles.length) : "--";
    const girValue = girMade ? percentage(girMade, entered.length) : "--";
    const penValue = entered.length ? penalties : "--";
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
      const girInput = els.scorecardGrid.querySelector(`.gir-input[data-hole="${holeNumber}"]`);
      const penaltyInput = els.scorecardGrid.querySelector(`.penalty-input[data-hole="${holeNumber}"]`);
      const firstPuttInput = els.scorecardGrid.querySelector(`.first-putt-input[data-hole="${holeNumber}"]`);
      const scoreRaw = scoreInput.value.trim();
      const scoreValue = scoreRaw === "" ? null : Number(scoreRaw);
      const puttsValue = Number(puttsInput.value);
      const penaltyValue = Number(penaltyInput.value);
      const firstPuttRaw = firstPuttInput ? firstPuttInput.value.trim() : "";
      const firstPuttValue = firstPuttRaw === "" ? null : Number(firstPuttRaw);
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
        penaltyClub: (Number.isFinite(penaltyValue) && penaltyValue > 0) ? getHolePenaltyClub(holeNumber) : "",
        firstPuttDistance: Number.isFinite(firstPuttValue) && firstPuttValue >= 0 ? firstPuttValue : null,
        note: getHoleNote(holeNumber),
        shots: getHoleShots(holeNumber),
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

    els.metricRounds.textContent = String(rounds.length);
    els.metricAverageScore.textContent = Number.isFinite(fullAvg) ? fullAvg.toFixed(1) : "--";
    els.metricAveragePar.textContent = formatSigned(fullToPar);
    els.metricBestRound.textContent = best ? `${roundTotals(best).gross} (${formatSigned(roundTotals(best).toPar, 0)})` : "--";
    els.metricGir.textContent = percentage(girMade, girTotal);
    els.metricSg.textContent = Number.isFinite(avgSg) ? formatSigned(avgSg) : "--";
    els.metricHandicap.textContent = handicap.index === null ? "--" : handicap.index.toFixed(1);
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

  function renderHandicapPanel() {
    const estimate = calculateHandicapEstimate(state.rounds);
    if (estimate.index === null) {
      els.handicapPanel.innerHTML = `
        <div class="handicap-index-box">
          <span>Estimated index</span>
          <strong>--</strong>
          <small>${estimate.eligible.length} rated score differential${estimate.eligible.length === 1 ? "" : "s"}</small>
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
    const bestDiffs = estimate.used
      .map((item) => `${item.differential.toFixed(1)}${item.approximate ? "*" : ""}`)
      .join(", ");

    els.handicapPanel.innerHTML = `
      <div class="handicap-index-box">
        <span>Estimated index</span>
        <strong>${estimate.index.toFixed(1)}</strong>
        <small>${estimate.eligible.length} rated differentials | using best ${estimate.used.length}</small>
      </div>
      <div class="handicap-details">
        <div class="handicap-detail-row"><span>Best differentials</span><strong>${escapeHtml(bestDiffs)}</strong></div>
        <div class="handicap-detail-row"><span>9-hole estimates</span><strong>${estimate.approximateNineCount}</strong></div>
        <div class="handicap-detail-row"><span>Next course handicap</span><strong>${courseHandicap === null ? "--" : courseHandicap}</strong></div>
        <div class="handicap-detail-row"><span>PCC</span><strong>0</strong></div>
      </div>
      <p class="handicap-note">${estimate.note}</p>
    `;
  }

  function renderCourseStats(rounds) {
    const groups = groupBy(rounds, (round) => round.courseId);
    const rows = Object.entries(groups).map(([courseId, courseRounds]) => {
      const course = getCourse(courseId);
      const totals = courseRounds.map(roundTotals);
      const best = Math.min(...totals.map((item) => item.gross));
      const yards = course ? course.holes.reduce((sum, hole) => sum + Number(hole.yards || 0), 0) : 0;
      return `
        <div class="course-stat-row">
          <div>
            <strong>${escapeHtml(course ? course.name : "Unknown")}</strong>
            <span class="subtext">${escapeHtml(course ? course.tee : "--")} | ${yards || "--"} yds | rating ${course && course.rating ? course.rating.toFixed(1) : "--"} | slope ${course && course.slope ? course.slope : "--"}</span>
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

  function renderParStats(rounds) {
    const holes = rounds.flatMap((round) => round.holes);
    const groups = groupBy(holes, (hole) => String(hole.par));
    const maxAvg = Math.max(1, ...Object.values(groups).map((items) => average(items.map((hole) => hole.score))));
    const parOrder = [3, 4, 5, 6];
    const html = parOrder
      .filter((par) => groups[String(par)])
      .map((par, index) => {
        const items = groups[String(par)];
        const avgScore = average(items.map((hole) => hole.score));
        const avgToPar = average(items.map((hole) => hole.score - hole.par));
        const parsOrBetter = items.filter((hole) => hole.score <= hole.par).length;
        const sgValues = items.map(holeStrokesGained).filter((value) => value !== null);
        const avgSg = sgValues.length ? average(sgValues) : NaN;
        const fill = Math.max(4, (avgScore / maxAvg) * 100);
        const color = index === 0 ? "blue" : index === 1 ? "" : "gold";
        return `
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span>Par ${par}</span>
              <span>${avgScore.toFixed(2)} (${formatSigned(avgToPar)})</span>
            </div>
            <div class="track"><div class="fill ${color}" style="width:${fill}%"></div></div>
            <div class="subtext">${items.length} holes | ${percentage(parsOrBetter, items.length)} par or better | SG ${Number.isFinite(avgSg) ? formatSigned(avgSg, 2) : "--"} per hole</div>
          </div>`;
      }).join("");

    els.parStats.innerHTML = html || emptyState("Save a round to see how you score on par 3s, 4s, and 5s.", { action: "rounds" });
  }

  // Wind is stored as the raw selector value: "", "calm", "5".."25", "30+".
  function formatWind(wind) {
    if (!wind) return "";
    if (wind === "calm") return "Calm";
    return `${wind} mph wind`;
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

  // Map avg-vs-par to a CSS tier class. Thresholds chosen so a hole you
  // typically birdie reads green, a typical par reads neutral, and the deep
  // red is reserved for holes that consistently destroy you (avg double+).
  function heatmapTier(avgToPar) {
    if (!Number.isFinite(avgToPar)) return "tier-empty";
    if (avgToPar <= -0.8) return "tier-eagle";
    if (avgToPar <= -0.25) return "tier-birdie";
    if (avgToPar < -0.05) return "tier-under";
    if (avgToPar < 0.25) return "tier-par";
    if (avgToPar < 0.8) return "tier-bogey";
    if (avgToPar < 1.5) return "tier-double";
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

    els.heatmapGrid.innerHTML = cells.map((cell) => {
      const tier = heatmapTier(cell.avgToPar);
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
        <span class="heatmap-legend-item"><span class="heatmap-legend-swatch" style="background:#1f7a59"></span>Under par</span>
        <span class="heatmap-legend-item"><span class="heatmap-legend-swatch" style="background:#f1f2ec"></span>Around par</span>
        <span class="heatmap-legend-item"><span class="heatmap-legend-swatch" style="background:#f1d39b"></span>Bogey avg</span>
        <span class="heatmap-legend-item"><span class="heatmap-legend-swatch" style="background:#d97a6a"></span>Double avg+</span>
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
    // to a single "Deerwood" chip regardless of which child course id their
    // rounds are tagged with.
    const seen = new Set();
    const chips = [];
    rounds.forEach((round) => {
      if (isDeerwoodCourseId(round.courseId)) {
        if (seen.has("deerwood")) return;
        seen.add("deerwood");
        chips.push({ key: "deerwood", label: "Deerwood", representativeId: round.courseId });
      } else {
        if (seen.has(round.courseId)) return;
        seen.add(round.courseId);
        const course = getCourse(round.courseId);
        chips.push({ key: round.courseId, label: course ? course.name : round.courseId, representativeId: round.courseId });
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
      heatmapScope = { courseId: courseKey };
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
      const sorted = [...bucket.holes].sort((a, b) => b.date.localeCompare(a.date));
      els.bucketSheetList.innerHTML = sorted.map((h) => `
        <li class="bucket-row">
          <div class="bucket-row-main">
            <strong>${escapeHtml(h.label)}</strong>
            <span class="subtext">${escapeHtml(h.courseName)} · Par ${h.par}</span>
          </div>
          <div class="bucket-row-meta">
            <span class="bucket-row-score">${h.score}</span>
            <span class="bucket-row-date">${escapeHtml(h.date)}</span>
          </div>
        </li>`).join("");
    }
    els.bucketSheetOverlay.hidden = false;
    document.body.classList.add("hole-picker-open");
    if (els.bucketSheetClose) els.bucketSheetClose.focus();
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

  function computeTeeClubPerformance(rounds) {
    const grouped = new Map();
    rounds.forEach((round) => {
      round.holes.forEach((hole) => {
        if (!Number.isFinite(hole.score) || hole.score <= 0) return;
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
  function computePenaltyClubs(rounds) {
    const map = new Map();
    let totalStrokes = 0;
    rounds.forEach((round) => {
      round.holes.forEach((hole) => {
        const pen = Number(hole.penalties);
        if (!Number.isFinite(pen) || pen <= 0 || !hole.penaltyClub) return;
        totalStrokes += pen;
        if (!map.has(hole.penaltyClub)) map.set(hole.penaltyClub, { club: hole.penaltyClub, strokes: 0, holes: 0 });
        const entry = map.get(hole.penaltyClub);
        entry.strokes += pen;
        entry.holes += 1;
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
    const data = computeTeeClubPerformance(rounds);
    const penaltyHtml = renderPenaltyClubsSection(computePenaltyClubs(rounds));
    if (!data.length) {
      els.teeClubPanel.innerHTML = emptyState("Tag your tee shots in Clubs Hit (first club tapped = tee shot) to unlock tee-club performance.") + penaltyHtml;
      return;
    }
    const total = data.reduce((sum, entry) => sum + entry.count, 0);
    // Highlight the lowest-avg club, but only when there's a real comparison
    // (at least 2 clubs with 5+ tee shots each). Tightened threshold vs the
    // per-hole version because this aggregates across many different holes.
    const eligibleForBest = data.filter((d) => d.count >= 5);
    const bestClub = eligibleForBest.length >= 2
      ? eligibleForBest.reduce((best, d) => (d.avgToPar < best.avgToPar ? d : best))
      : null;
    const rows = data.map((entry) => {
      const parParts = [];
      if (entry.par3) parParts.push(`${entry.par3}× par 3`);
      if (entry.par4) parParts.push(`${entry.par4}× par 4`);
      if (entry.par5) parParts.push(`${entry.par5}× par 5`);
      if (entry.par6) parParts.push(`${entry.par6}× par 6`);
      const parBreakdown = parParts.length ? parParts.join(" · ") : "";
      const tier = heatmapTier(entry.avgToPar);
      const isBest = bestClub && entry.club === bestClub.club && data.length > 1;
      const sgText = Number.isFinite(entry.avgSg) ? formatSigned(entry.avgSg, 2) : "—";
      return `
        <li class="tee-club-row${isBest ? " is-best" : ""}">
          <div class="tee-club-row-main">
            <strong>${escapeHtml(entry.club)}${isBest ? `<span class="hd-tc-best-flag">best avg</span>` : ""}</strong>
            <span class="subtext">${entry.count} tee shot${entry.count === 1 ? "" : "s"}${parBreakdown ? ` · ${escapeHtml(parBreakdown)}` : ""}</span>
          </div>
          <div class="tee-club-row-stats">
            <span class="hd-tc-avg ${tier}" title="Avg score-to-par">${formatSigned(entry.avgToPar, 2)}</span>
            <span class="tee-club-sg" title="Strokes gained per tee shot">SG ${sgText}</span>
          </div>
        </li>`;
    }).join("");
    els.teeClubPanel.innerHTML = `
      <p class="tee-club-total">${total} tee shot${total === 1 ? "" : "s"} tagged across ${data.length} club${data.length === 1 ? "" : "s"}.</p>
      <ul class="tee-club-list">${rows}</ul>
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

  function generateRoundNarrative(round, allRounds) {
    if (!round || !Array.isArray(round.holes) || !round.holes.length) return "";
    const valid = round.holes.filter((hole) => Number.isFinite(hole.score) && hole.score > 0);
    if (!valid.length) return "";

    const course = getCourse(round.courseId);
    const courseName = course ? course.name : "the course";
    const totals = roundTotals(round);
    const sg = roundStrokesGained(round);

    const pieces = [];

    // 1. Opening: score + course + how it compares to recent form.
    const otherRounds = allRounds.filter((other) => other.id !== round.id);
    const otherTotals = otherRounds
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5)
      .map(roundTotals);
    const recentAvgToPar = otherTotals.length ? average(otherTotals.map((entry) => entry.toPar)) : null;
    let opening = `Shot ${totals.gross} (${formatSigned(totals.toPar, 0)}) at ${courseName}`;
    if (recentAvgToPar !== null && Number.isFinite(recentAvgToPar)) {
      const delta = totals.toPar - recentAvgToPar;
      if (delta <= -3) opening += ` — clearly better than your recent form (avg ${formatSigned(recentAvgToPar)}).`;
      else if (delta <= -1) opening += ` — a bit better than your recent average (${formatSigned(recentAvgToPar)}).`;
      else if (delta >= 3) opening += ` — tougher day than your recent form (avg ${formatSigned(recentAvgToPar)}).`;
      else if (delta >= 1) opening += ` — a bit above your recent average (${formatSigned(recentAvgToPar)}).`;
      else opening += ` — right around your recent average.`;
    } else {
      opening += `.`;
    }
    pieces.push(opening);

    // 2. Theme: identify the dominant story (penalties, 3-putts, big leak hole, strength hole).
    const penalties = valid.reduce((sum, hole) => sum + (Number(hole.penalties) || 0), 0);
    const penaltyHoles = valid.filter((hole) => Number(hole.penalties) > 0).map((hole) => hole.label || `#${hole.number}`);
    const threePuttHoles = valid.filter((hole) => Number(hole.putts) >= 3);
    const fairwayHoles = valid.filter((hole) => hole.fairway && hole.fairway !== "na");
    const fairwaysHit = fairwayHoles.filter((hole) => hole.fairway === "hit").length;
    const fairwayRate = fairwayHoles.length ? fairwaysHit / fairwayHoles.length : null;
    const girMade = valid.filter((hole) => hole.gir).length;
    const girRate = valid.length ? girMade / valid.length : 0;
    const totalPutts = valid.reduce((sum, hole) => sum + (Number(hole.putts) || 0), 0);
    const avgPutts = totalPutts / valid.length;

    const holesWithLoss = valid.map((hole) => ({ ...hole, loss: hole.score - hole.par }));
    const worstHole = [...holesWithLoss].sort((a, b) => b.loss - a.loss)[0];
    const bestHole = [...holesWithLoss].sort((a, b) => a.loss - b.loss)[0];

    const themeBits = [];
    if (penalties >= 2) {
      const where = penaltyHoles.length ? ` (${penaltyHoles.slice(0, 3).map(escapeForText).join(", ")})` : "";
      themeBits.push(`${penalties} penalty stroke${penalties === 1 ? "" : "s"}${where} hurt the round`);
    }
    if (threePuttHoles.length >= 2) {
      themeBits.push(`${threePuttHoles.length} three-putts cost roughly ${threePuttHoles.length} stroke${threePuttHoles.length === 1 ? "" : "s"} on the greens`);
    }
    if (worstHole && worstHole.loss >= 3) {
      themeBits.push(`a ${worstHole.score} on ${escapeForText(worstHole.label || `hole ${worstHole.number}`)} (${formatSigned(worstHole.loss, 0)}) was the standout leak`);
    }
    if (fairwayRate !== null && fairwayHoles.length >= 6 && fairwayRate >= 0.75) {
      themeBits.push(`tee shots were dialed (${fairwaysHit}/${fairwayHoles.length} fairways)`);
    }
    if (fairwayRate !== null && fairwayHoles.length >= 6 && fairwayRate <= 0.35) {
      themeBits.push(`driver missed often (${fairwaysHit}/${fairwayHoles.length} fairways)`);
    }
    if (girRate >= 0.45) {
      themeBits.push(`iron play held up (${girMade}/${valid.length} GIR)`);
    }
    if (avgPutts <= 1.7 && valid.length >= 9) {
      themeBits.push(`putter was hot (${avgPutts.toFixed(2)} putts/hole)`);
    }
    if (avgPutts >= 2.2 && valid.length >= 9) {
      themeBits.push(`putting drifted (${avgPutts.toFixed(2)} putts/hole)`);
    }
    if (bestHole && bestHole.loss <= -1) {
      const tag = bestHole.loss === -1 ? "birdie" : bestHole.loss === -2 ? "eagle" : "big number under";
      themeBits.push(`a ${tag} on ${escapeForText(bestHole.label || `hole ${bestHole.number}`)} was the highlight`);
    }

    if (themeBits.length) {
      const sentence = themeBits.slice(0, 2).join(" and ");
      pieces.push(sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".");
    }

    // 3. Counterfactual: drop the 3 worst holes.
    const worstThree = [...holesWithLoss]
      .filter((hole) => hole.loss > 0)
      .sort((a, b) => b.loss - a.loss)
      .slice(0, 3);
    const savings = worstThree.reduce((sum, hole) => sum + hole.loss, 0);
    if (savings >= 3 && worstThree.length >= 2) {
      const adjusted = totals.gross - savings;
      const labels = worstThree.map((hole) => escapeForText(hole.label || `#${hole.number}`)).join(", ");
      pieces.push(`Without your three worst holes (${labels}) you'd have shot ${adjusted} — a ${savings}-stroke swing.`);
    }

    // 4. SG signal (optional, if we have it).
    if (sg && Number.isFinite(sg.total)) {
      pieces.push(`Strokes Gained: ${formatSigned(sg.total)} vs PGA Tour benchmark.`);
    }

    return pieces.join(" ");
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
    // same-hole-count Deerwood round, regardless of routing.
    const courseRounds = state.rounds
      .filter((round) => deerwood
        ? (isDeerwoodCourseId(round.courseId) && round.holes.length === holeCount)
        : round.courseId === courseId)
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
        const editingBadge = editingRoundId === round.id ? ' <span class="editing-pill">editing</span>' : "";
        const narrative = round.narrative || (round.holes && round.holes.some((h) => Number.isFinite(h.score) && h.score > 0) ? generateRoundNarrative(round, state.rounds) : "");
        const narrativeHtml = narrative
          ? `<details class="round-row-summary"><summary>Summary</summary><p>${escapeHtml(narrative)}</p></details>`
          : "";
        const scorecardHtml = `<details class="round-row-scorecard"><summary>Scorecard</summary>${renderRoundScorecard(round)}</details>`;
        return `
          <div class="round-row${editingRoundId === round.id ? " editing" : ""}">
            <div class="round-row-main">
              <strong>${totals.gross} (${formatSigned(totals.toPar, 0)})${editingBadge}</strong>
              <span class="subtext">${round.date} | ${escapeHtml(course ? course.name : "Unknown")}${windLabel}${sgLabel}</span>
              ${narrativeHtml}
              ${scorecardHtml}
            </div>
            <div class="row-actions">
              <button type="button" data-edit-round="${round.id}">Edit</button>
              <button type="button" data-delete-round="${round.id}">Delete</button>
            </div>
          </div>`;
      }).join("");

    els.recentRounds.innerHTML = rows || emptyState("Your scorecards will appear here once you save a round.", { action: "rounds" });
    els.recentRounds.querySelectorAll("[data-edit-round]").forEach((button) => {
      button.addEventListener("click", () => {
        const round = state.rounds.find((candidate) => candidate.id === button.dataset.editRound);
        if (!round) {
          showToast("Round not found.");
          return;
        }
        loadRoundIntoForm(round);
        renderRecentRounds();
        showToast("Editing round. Make changes and click Update round.");
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
    "putting-by-distance": "clubs"
  };
  const HOME_SECTIONS = ["overview", "trends", "holes", "clubs"];
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
    const hasActive = (courseVal && courseVal !== "all") || (teeVal && teeVal !== "all") || (windowVal && windowVal !== "all");
    els.homeFiltersButton.classList.toggle("has-active-filter", hasActive);
  }

  function resetAllFilters() {
    if (els.filterCourse) els.filterCourse.value = "all";
    if (els.filterTee) els.filterTee.value = "all";
    if (els.filterWindow) els.filterWindow.value = "all";
    // Fire a single change event — the existing handler re-reads all three.
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

  async function findCourses(query) {
    const apiResults = await findCoursesFromApi(query);
    if (apiResults.length) return apiResults;
    return findCoursesFromCatalog(query);
  }

  async function findCoursesFromApi(query) {
    if (window.location.protocol === "file:") return [];
    try {
      const response = await fetch(`/api/course-search?q=${encodeURIComponent(query)}`);
      if (!response.ok) return [];
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.courses)) return [];
      return payload.courses.map(normalizeLookupResult).filter(Boolean);
    } catch (error) {
      return [];
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

  function renderCourseLookupResults(results, query) {
    if (!results.length) {
      els.courseLookupResults.innerHTML = emptyState(`No automatic scorecard match for "${escapeHtml(query)}".`);
      return;
    }

    els.courseLookupResults.innerHTML = results.map((result) => `
      <div class="lookup-row">
        <div>
          <strong>${escapeHtml(result.name)}</strong>
          <span class="subtext">${escapeHtml([result.location, result.summary].filter(Boolean).join(" | "))}</span>
        </div>
        <button type="button" data-lookup-course="${escapeHtml(result.id)}">Use</button>
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
    const bars = ordered.map((round) => {
      const total = roundTotals(round);
      const height = Math.max(4, Math.round((Math.abs(total.toPar) / maxAbs) * 124));
      const goodClass = total.toPar <= 0 ? "good" : "";
      return `
        <div class="trend-item">
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
    if (!els.roundCourse.value) els.roundCourse.value = DEERWOOD_COURSE_ID;
    renderScorecard(getSelectedRoundCourse());
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
    renderRecentRounds();
    updateBackupBadge();
    renderCourseList();
    renderProfileBag();
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
  }

  function refreshRoundSetup() {
    resetRoundChrome();
    renderRoundSetupOptions();
    renderScorecard(getSelectedRoundCourse());
    renderHandicapPanel();
    renderCourseBrief();
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
    updateEditModeUi();
    resetRoundChrome();
    if (rerender) renderScorecard(getSelectedRoundCourse());
  }

  function loadRoundIntoForm(round) {
    if (!round) return;
    editingRoundId = round.id;
    els.roundDate.value = round.date || today;
    els.roundNote.value = round.note || "";
    if (els.roundWind) els.roundWind.value = round.wind || "";

    resetPendingHoles(); resetReviewState();
    round.holes.forEach((hole) => {
      if (hole && hole.note) setHoleNote(hole.number, hole.note);
      if (hole && Array.isArray(hole.shots) && hole.shots.length) {
        setHoleShots(hole.number, hole.shots);
      }
      if (hole && Array.isArray(hole.clubsHit) && hole.clubsHit.length) {
        setHoleClubs(hole.number, hole.clubsHit);
      }
      if (hole && hole.penaltyClub) {
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
      const girInput = els.scorecardGrid.querySelector(`.gir-input[data-hole="${holeKey}"]`);
      const penaltyInput = els.scorecardGrid.querySelector(`.penalty-input[data-hole="${holeKey}"]`);
      const firstPuttInput = els.scorecardGrid.querySelector(`.first-putt-input[data-hole="${holeKey}"]`);
      if (scoreInput && Number.isFinite(hole.score)) scoreInput.value = hole.score;
      if (puttsInput && Number.isFinite(hole.putts)) puttsInput.value = hole.putts;
      if (penaltyInput && Number.isFinite(hole.penalties)) penaltyInput.value = hole.penalties;
      if (firstPuttInput && Number.isFinite(hole.firstPuttDistance)) firstPuttInput.value = hole.firstPuttDistance;
      if (fairwayInput && hole.fairway) {
        const hasOption = [...fairwayInput.options].some((option) => option.value === hole.fairway);
        if (hasOption) fairwayInput.value = hole.fairway;
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
  els.roundHoleCount.addEventListener("change", () => { clearInProgressRound(); resetPendingHoles(); resetReviewState(); refreshRoundSetup(); });
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
      resetRoundChrome();
      renderScorecard(getSelectedRoundCourse());
    }
  });

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

  [els.filterCourse, els.filterTee, els.filterWindow].forEach((control) => {
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
          note,
          holes
        });
        updatedRound.narrative = generateRoundNarrative(updatedRound, state.rounds);
        state.rounds[existingIndex] = updatedRound;
        editingRoundId = null;
        clearInProgressRound();
        resetPendingHoles(); resetReviewState();
        saveState();
        updateEditModeUi();
        els.roundNote.value = "";
        if (els.roundWind) els.roundWind.value = "";
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
          note,
          holes
        });
        newRound.narrative = generateRoundNarrative(newRound, state.rounds);
        state.rounds.push(newRound);
        clearInProgressRound();
        resetPendingHoles(); resetReviewState();
        saveState();
        els.roundNote.value = "";
        if (els.roundWind) els.roundWind.value = "";
        resetRoundChrome();
        renderAll();
        setActiveTab("home");
        showToast("Round saved.");
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
    const results = await findCourses(query);
    renderCourseLookupResults(results, query);
  });

  function loadSampleData() {
    if (state.rounds.length && !window.confirm("Replace current data with sample data?")) return;
    state = {
      courses: structuredClone(sampleCourses),
      rounds: structuredClone(sampleRounds)
    };
    clearEditState({ rerender: false });
    clearInProgressRound();
    resetPendingHoles(); resetReviewState();
    saveState();
    renderAll();
    showToast("Sample data loaded.");
  }
  els.loadSampleButton.addEventListener("click", loadSampleData);
  if (els.welcomeSampleButton) els.welcomeSampleButton.addEventListener("click", loadSampleData);

  els.clearButton.addEventListener("click", () => {
    if (!window.confirm("Clear all courses and rounds?")) return;
    state = { courses: [], rounds: [] };
    clearEditState({ rerender: false });
    clearInProgressRound();
    resetPendingHoles(); resetReviewState();
    saveState();
    renderAll();
    showToast("Data cleared.");
  });

  els.exportButton.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const exportDate = new Date().toISOString().slice(0, 10);
    link.download = `fairway-ledger-${exportDate}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    writeBackupMeta({
      lastExportAt: new Date().toISOString(),
      lastExportRoundCount: state.rounds.length
    });
    updateBackupBadge();
    showToast("Export ready.");
  });

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
        imported.rounds = imported.rounds.map(normalizeRound);
        state = ensureProfileShape(ensureCourseDataShape(mergeNewDefaultCourses(imported)));
        clearEditState({ rerender: false });
        const previousMeta = readBackupMeta();
        writeBackupMeta({
          lastExportAt: previousMeta.lastExportAt,
          lastExportRoundCount: state.rounds.length
        });
        saveState();
        renderAll();
        showToast("Import complete.");
      } catch (error) {
        showToast(error.message);
      } finally {
        els.importInput.value = "";
      }
    };
    reader.readAsText(file);
  });

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
