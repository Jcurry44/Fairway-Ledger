(function () {
  "use strict";

  const STORAGE_KEY = "fairwayLedger.v1";
  const ACTIVE_TAB_KEY = "fairwayLedger.activeTab";
  const BACKUP_META_KEY = "fairwayLedger.backupMeta.v1";
  const BRIEF_COLLAPSED_KEY = "fairwayLedger.briefCollapsed.v1";
  const VIEW_MODE_KEY = "fairwayLedger.viewMode.v1";
  const BACKUP_NAG_THRESHOLD = 3;
  const today = new Date().toISOString().slice(0, 10);

  let sampleCourses = [];
  let selectedCourseDetailId = null;
  let editingRoundId = null;
  let viewMode = readInitialViewMode();

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
  const deerwoodLayoutOptions = {
    "9": [
      { id: "buck", label: "Buck", nines: ["buck"] },
      { id: "doe", label: "Doe", nines: ["doe"] },
      { id: "fawn", label: "Fawn", nines: ["fawn"] }
    ],
    "18": [
      { id: "buck-doe", label: "Buck / Doe", nines: ["buck", "doe"] },
      { id: "buck-fawn", label: "Buck / Fawn", nines: ["buck", "fawn"] },
      { id: "doe-fawn", label: "Doe / Fawn", nines: ["doe", "fawn"] }
    ]
  };
  const deerwoodNineLabels = {
    buck: "Buck",
    doe: "Doe",
    fawn: "Fawn"
  };

  let sampleRounds = [];
  let state = { courses: [], rounds: [] };

  const els = {
    metricRounds: document.getElementById("metricRounds"),
    metricAverageScore: document.getElementById("metricAverageScore"),
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
    roundTee: document.getElementById("roundTee"),
    roundTeeField: document.getElementById("roundTeeField"),
    roundNote: document.getElementById("roundNote"),
    roundCourseMeta: document.getElementById("roundCourseMeta"),
    roundBrief: document.getElementById("roundBrief"),
    roundLiveSummary: document.getElementById("roundLiveSummary"),
    roundForm: document.getElementById("roundForm"),
    resetRoundButton: document.getElementById("resetRoundButton"),
    viewToggleButton: document.getElementById("viewToggleButton"),
    roundEntryTitle: document.getElementById("roundEntryTitle"),
    roundSubmitButton: document.getElementById("roundSubmitButton"),
    scorecardGrid: document.getElementById("scorecardGrid"),
    roundPreview: document.getElementById("roundPreview"),
    spotlightCourse: document.getElementById("spotlightCourse"),
    spotlightHole: document.getElementById("spotlightHole"),
    spotlightStats: document.getElementById("spotlightStats"),
    spotlightHistory: document.getElementById("spotlightHistory"),
    trendChart: document.getElementById("trendChart"),
    handicapPanel: document.getElementById("handicapPanel"),
    courseStats: document.getElementById("courseStats"),
    parStats: document.getElementById("parStats"),
    bestHoles: document.getElementById("bestHoles"),
    worstHoles: document.getElementById("worstHoles"),
    recentRounds: document.getElementById("recentRounds"),
    strokesGainedPanel: document.getElementById("strokesGainedPanel"),
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
    toast: document.getElementById("toast")
  };

  function toHole(item) {
    if (Array.isArray(item)) {
      return { number: item[0], par: item[1], yards: item[2], hcp: item[3] || null };
    }
    return {
      number: Number(item.number),
      label: item.label || String(item.number),
      par: Number(item.par),
      yards: Number(item.yards || 0),
      hcp: item.hcp ? Number(item.hcp) : null
    };
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
      makeRound("2026-04-18", "ridgeview-blue", [5, 5, 4, 6, 5, 4, 3, 7, 5, 5, 4, 5, 6, 6, 4, 4, 6, 6], "First round tracked"),
      makeRound("2026-04-25", "lake-county-white", [6, 5, 4, 4, 6, 6, 5, 4, 5, 5, 6, 3, 5, 5, 4, 6, 5, 5], "Better putting day"),
      makeRound("2026-05-02", "ridgeview-blue", [4, 5, 3, 6, 5, 5, 4, 6, 4, 5, 5, 4, 7, 5, 4, 5, 6, 5], "Driver missed right"),
      makeRound("2026-05-09", "ridgeview-blue", [5, 4, 4, 5, 4, 5, 3, 6, 5, 4, 4, 4, 6, 5, 5, 4, 5, 5], "Clean back nine"),
      makeRound("2026-05-12", "lake-county-white", [5, 5, 5, 3, 5, 7, 4, 4, 5, 4, 6, 4, 6, 4, 5, 6, 5, 4], "Penalty on 6"),
      makeRound("2026-05-15", "ridgeview-blue", [4, 4, 4, 5, 5, 4, 3, 6, 4, 5, 4, 3, 6, 5, 4, 4, 5, 5], "Best tee day")
    ];
  }

  function makeRound(date, courseId, scores, note) {
    const course = sampleCourses.find((candidate) => candidate.id === courseId);
    return {
      id: makeId("round"),
      date,
      courseId,
      tee: course.tee,
      note,
      holes: course.holes.map((hole, index) => {
        const score = scores[index];
        const over = score - hole.par;
        return {
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
        };
      })
    };
  }

  function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.courses) && Array.isArray(saved.rounds)) {
        return mergeNewDefaultCourses(saved);
      }
    } catch (error) {
      console.warn("Could not load saved golf data", error);
    }
    return {
      courses: structuredClone(sampleCourses),
      rounds: structuredClone(sampleRounds)
    };
  }

  function mergeNewDefaultCourses(saved) {
    const defaultDeerwoodCourses = sampleCourses.filter((course) => isDeerwoodCourseId(course.id));
    const defaultDeerwoodById = new Map(defaultDeerwoodCourses.map((course) => [course.id, course]));
    const updatedCourses = saved.courses.map((course) => {
      return defaultDeerwoodById.has(course.id) ? structuredClone(defaultDeerwoodById.get(course.id)) : course;
    });
    const existingCourseIds = new Set(updatedCourses.map((course) => course.id));
    const missingDefaultCourses = defaultDeerwoodCourses.filter((course) => {
      return course.id.startsWith("deerwood-") && !existingCourseIds.has(course.id);
    });

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

  function isDeerwoodCourseId(courseId) {
    return String(courseId || "").startsWith("deerwood-");
  }

  function deerwoodCourseId(layoutId, tee) {
    return `deerwood-${layoutId}-${tee.toLowerCase()}`;
  }

  function getDeerwoodNineCourse(nineId, tee) {
    const courseId = deerwoodCourseId(nineId, tee);
    return sampleCourses.find((course) => course.id === courseId)
      || state.courses.find((course) => course.id === courseId);
  }

  function getDeerwoodLayout(holeCount, layoutId) {
    const layouts = deerwoodLayoutOptions[String(holeCount)] || deerwoodLayoutOptions["18"];
    return layouts.find((layout) => layout.id === layoutId) || layouts[0];
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

  function getSelectedRoundCourse() {
    if (els.roundCourse.value === DEERWOOD_COURSE_ID) {
      return buildDeerwoodCourse(els.roundHoleCount.value, els.roundLayout.value, els.roundTee.value);
    }
    return getCourse(els.roundCourse.value);
  }

  function ensureSavedCourse(course) {
    if (!course || state.courses.some((candidate) => candidate.id === course.id)) return;
    state.courses.push(course);
  }

  function formatSigned(value, digits = 1) {
    if (!Number.isFinite(value)) return "--";
    const rounded = Number(value.toFixed(digits));
    if (rounded > 0) return `+${rounded}`;
    return String(rounded);
  }

  function average(values) {
    const realValues = values.filter((value) => Number.isFinite(value));
    if (!realValues.length) return NaN;
    return realValues.reduce((sum, value) => sum + value, 0) / realValues.length;
  }

  function percentage(made, total) {
    if (!total) return "--";
    return `${Math.round((made / total) * 100)}%`;
  }

  // PGA Tour scratch baseline expected strokes by par and yardage.
  // Source: Mark Broadie, "Every Shot Counts" tour averages; intermediate
  // points interpolated linearly. Used as the anchor for Strokes Gained.
  const SCRATCH_BASELINE_TABLES = {
    3: [
      { yards: 100, strokes: 2.92 },
      { yards: 125, strokes: 2.97 },
      { yards: 150, strokes: 3.00 },
      { yards: 175, strokes: 3.05 },
      { yards: 200, strokes: 3.12 },
      { yards: 225, strokes: 3.19 },
      { yards: 250, strokes: 3.30 }
    ],
    4: [
      { yards: 250, strokes: 3.40 },
      { yards: 300, strokes: 3.51 },
      { yards: 330, strokes: 3.70 },
      { yards: 350, strokes: 3.84 },
      { yards: 380, strokes: 3.98 },
      { yards: 400, strokes: 4.04 },
      { yards: 420, strokes: 4.10 },
      { yards: 440, strokes: 4.16 },
      { yards: 460, strokes: 4.23 },
      { yards: 480, strokes: 4.31 },
      { yards: 500, strokes: 4.40 }
    ],
    5: [
      { yards: 450, strokes: 4.40 },
      { yards: 475, strokes: 4.55 },
      { yards: 500, strokes: 4.66 },
      { yards: 525, strokes: 4.78 },
      { yards: 550, strokes: 4.87 },
      { yards: 575, strokes: 4.94 },
      { yards: 600, strokes: 5.01 },
      { yards: 625, strokes: 5.10 },
      { yards: 650, strokes: 5.22 }
    ],
    6: [
      { yards: 600, strokes: 5.40 },
      { yards: 650, strokes: 5.55 },
      { yards: 700, strokes: 5.70 },
      { yards: 750, strokes: 5.85 },
      { yards: 800, strokes: 6.00 }
    ]
  };

  function scratchExpectedStrokes(par, yards) {
    const table = SCRATCH_BASELINE_TABLES[par];
    if (!table) return Number(par);
    const numericYards = Number(yards);
    if (!Number.isFinite(numericYards) || numericYards <= 0) {
      const midpoint = table[Math.floor(table.length / 2)];
      return midpoint.strokes;
    }
    if (numericYards <= table[0].yards) return table[0].strokes;
    if (numericYards >= table[table.length - 1].yards) return table[table.length - 1].strokes;
    for (let i = 0; i < table.length - 1; i += 1) {
      const a = table[i];
      const b = table[i + 1];
      if (numericYards >= a.yards && numericYards <= b.yards) {
        const t = (numericYards - a.yards) / (b.yards - a.yards);
        return a.strokes + (b.strokes - a.strokes) * t;
      }
    }
    return Number(par);
  }

  function holeStrokesGained(hole) {
    if (!hole || !Number.isFinite(hole.score) || hole.score <= 0) return null;
    return scratchExpectedStrokes(hole.par, hole.yards) - hole.score;
  }

  function roundStrokesGained(round) {
    if (!round || !Array.isArray(round.holes)) return null;
    const valid = round.holes.filter((hole) => Number.isFinite(hole.score) && hole.score > 0);
    if (!valid.length) return null;
    const total = valid.reduce((sum, hole) => sum + (holeStrokesGained(hole) || 0), 0);
    return { total, holes: valid.length };
  }

  function roundTotals(round) {
    const gross = round.holes.reduce((sum, hole) => sum + Number(hole.score || 0), 0);
    const par = round.holes.reduce((sum, hole) => sum + Number(hole.par || 0), 0);
    const putts = round.holes.reduce((sum, hole) => sum + Number(hole.putts || 0), 0);
    const girMade = round.holes.filter((hole) => hole.gir).length;
    const firHoles = round.holes.filter((hole) => hole.par > 3 && hole.fairway !== "na");
    const firMade = firHoles.filter((hole) => hole.fairway === "hit").length;
    return {
      gross,
      par,
      toPar: gross - par,
      putts,
      girMade,
      girTotal: round.holes.length,
      firMade,
      firTotal: firHoles.length
    };
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
    const currentSpotlightCourse = els.spotlightCourse.value;

    els.filterCourse.innerHTML = courseOptions;
    els.roundCourse.innerHTML = roundOptions;
    els.spotlightCourse.innerHTML = [...nonDeerwoodCourses, ...deerwoodRoundCourses]
      .map((course) => `<option value="${course.id}">${escapeHtml(course.name)} (${escapeHtml(course.tee)})</option>`)
      .join("");

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

    const spotlightCourseIds = [...nonDeerwoodCourses, ...deerwoodRoundCourses].map((course) => course.id);
    if (spotlightCourseIds.includes(currentSpotlightCourse)) {
      els.spotlightCourse.value = currentSpotlightCourse;
    }

    const tees = [...new Set(state.rounds.map((round) => round.tee).filter(Boolean))].sort();
    const currentTee = els.filterTee.value;
    els.filterTee.innerHTML = [
      `<option value="all">All tees</option>`,
      ...tees.map((tee) => `<option value="${escapeHtml(tee)}">${escapeHtml(tee)}</option>`)
    ].join("");
    if (tees.includes(currentTee)) els.filterTee.value = currentTee;

    renderRoundSetupOptions();
    renderSpotlightHoleOptions();
  }

  function renderRoundSetupOptions() {
    const isDeerwood = els.roundCourse.value === DEERWOOD_COURSE_ID;
    [els.roundHoleCountField, els.roundLayoutField, els.roundTeeField].forEach((field) => {
      field.hidden = !isDeerwood;
    });
    if (!isDeerwood) return;

    if (!els.roundHoleCount.value) els.roundHoleCount.value = "18";
    if (!DEERWOOD_TEE_OPTIONS.includes(els.roundTee.value)) els.roundTee.value = "White";

    const layouts = deerwoodLayoutOptions[els.roundHoleCount.value] || deerwoodLayoutOptions["18"];
    const currentLayout = els.roundLayout.value;
    els.roundLayout.innerHTML = layouts
      .map((layout) => `<option value="${layout.id}">${layout.label}</option>`)
      .join("");
    if (layouts.some((layout) => layout.id === currentLayout)) {
      els.roundLayout.value = currentLayout;
    } else {
      els.roundLayout.value = layouts[0].id;
    }
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

    els.scorecardGrid.className = `scorecard mode-${viewMode}`;
    els.scorecardGrid.innerHTML = viewMode === "card"
      ? renderScorecardCardMode(course)
      : renderScorecardGridMode(course);

    els.scorecardGrid.querySelectorAll("input, select").forEach((input) => {
      input.addEventListener("input", updateRoundPreview);
      input.addEventListener("change", updateRoundPreview);
    });
    if (viewMode === "card") wireCardModeBehavior();
    updateViewToggleLabel();
    updateRoundPreview();
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
    return `<label class="gir-toggle compact-toggle"><input class="gir-input" data-hole="${hole.number}" type="checkbox" aria-label="${escapeHtml(hole.label || `Hole ${hole.number}`)} GIR"><span></span></label>`;
  }

  function penaltyInputCell(hole) {
    return `<input class="penalty-input compact-input" data-hole="${hole.number}" type="number" min="0" max="8" inputmode="numeric" value="0" aria-label="${escapeHtml(hole.label || `Hole ${hole.number}`)} penalties">`;
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
            <span class="card-position">${positionText}</span>
          </div>
          <div class="card-headline">
            <h3 class="card-hole-label">${escapeHtml(hole.label || `Hole ${hole.number}`)}</h3>
            <div class="card-hole-meta">
              <span>Par ${hole.par}</span>
              <span>${hole.yards ? `${hole.yards} yds` : "no yardage"}</span>
              <span>HCP ${hole.hcp || "--"}</span>
            </div>
          </div>
          <div class="card-score-row">
            <button type="button" class="card-score-shortcut" data-score-delta="-1" aria-label="Decrease score for ${escapeHtml(hole.label || `hole ${hole.number}`)}">−</button>
            ${scoreInputCell(hole)}
            <button type="button" class="card-score-shortcut" data-score-delta="1" aria-label="Increase score for ${escapeHtml(hole.label || `hole ${hole.number}`)}">+</button>
          </div>
          <div class="card-secondary">
            <label class="card-field">
              <span>Putts</span>
              ${puttsInputCell(hole)}
            </label>
            <label class="card-field">
              <span>Fairway</span>
              ${fairwayInputCell(hole)}
            </label>
            <div class="card-field card-field-toggle">
              <span>GIR</span>
              ${girInputCell(hole)}
            </div>
            <label class="card-field">
              <span>Pen</span>
              ${penaltyInputCell(hole)}
            </label>
          </div>
        </article>`;
    }).join("");

    const jumpDots = course.holes.map((hole, index) => `
      <button type="button" class="card-jump-dot${index === 0 ? " active" : ""}" data-card-jump="${index}" aria-label="Go to hole ${index + 1}">${index + 1}</button>
    `).join("");

    return `
      <div class="scorecard-cards" data-active-index="0">${cards}</div>
      <div class="scorecard-card-nav">
        <button type="button" class="card-nav-button" data-card-nav="prev">← Prev</button>
        <div class="card-jump-strip" role="tablist">${jumpDots}</div>
        <button type="button" class="card-nav-button" data-card-nav="next">Next →</button>
      </div>`;
  }

  function wireCardModeBehavior() {
    const stack = els.scorecardGrid.querySelector(".scorecard-cards");
    if (!stack) return;
    const cards = [...stack.querySelectorAll(".scorecard-card")];
    const dots = [...els.scorecardGrid.querySelectorAll(".card-jump-dot")];
    const navPrev = els.scorecardGrid.querySelector('[data-card-nav="prev"]');
    const navNext = els.scorecardGrid.querySelector('[data-card-nav="next"]');

    function setActive(index) {
      const clamped = Math.max(0, Math.min(cards.length - 1, index));
      cards.forEach((card, i) => card.classList.toggle("active", i === clamped));
      dots.forEach((dot, i) => dot.classList.toggle("active", i === clamped));
      stack.dataset.activeIndex = String(clamped);
      const activeCard = cards[clamped];
      if (activeCard) {
        const dot = dots[clamped];
        if (dot && typeof dot.scrollIntoView === "function") {
          dot.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
        }
        const scoreInput = activeCard.querySelector(".score-input");
        if (scoreInput instanceof HTMLInputElement) {
          scoreInput.focus({ preventScroll: true });
          scoreInput.select();
        }
      }
    }

    function currentIndex() {
      return Number(stack.dataset.activeIndex || "0");
    }

    if (navPrev) navPrev.addEventListener("click", () => setActive(currentIndex() - 1));
    if (navNext) navNext.addEventListener("click", () => setActive(currentIndex() + 1));
    dots.forEach((dot) => {
      dot.addEventListener("click", () => setActive(Number(dot.dataset.cardJump)));
    });

    stack.addEventListener("focusin", (event) => {
      const card = event.target.closest(".scorecard-card");
      if (!card) return;
      const index = Number(card.dataset.cardIndex);
      if (Number.isFinite(index) && index !== currentIndex()) setActive(index);
    });

    stack.addEventListener("click", (event) => {
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
      map.set(Number(hole), {
        score: scoreInput.value,
        putts: puttsInput ? puttsInput.value : "",
        fairway: fairwayInput ? fairwayInput.value : "",
        gir: girInput ? girInput.checked : false,
        penalty: penaltyInput ? penaltyInput.value : ""
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
      if (scoreInput && values.score !== "") scoreInput.value = values.score;
      if (puttsInput && values.putts !== "") puttsInput.value = values.putts;
      if (fairwayInput && values.fairway && [...fairwayInput.options].some((option) => option.value === values.fairway)) {
        fairwayInput.value = values.fairway;
      }
      if (girInput) girInput.checked = Boolean(values.gir);
      if (penaltyInput && values.penalty !== "") penaltyInput.value = values.penalty;
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

  function updateRoundPreview() {
    const allHoles = readScorecard(false);
    const entered = allHoles.filter((hole) => Number.isFinite(hole.score) && hole.score > 0);
    if (!entered.length) {
      els.roundPreview.textContent = "--";
      els.roundLiveSummary.innerHTML = "";
      return;
    }
    const complete = entered.length === allHoles.length;
    const gross = entered.reduce((sum, hole) => sum + hole.score, 0);
    const par = entered.reduce((sum, hole) => sum + hole.par, 0);
    const putts = entered.reduce((sum, hole) => sum + hole.putts, 0);
    const penalties = entered.reduce((sum, hole) => sum + hole.penalties, 0);
    const girMade = entered.filter((hole) => hole.gir).length;
    const fairwayHoles = entered.filter((hole) => hole.fairway && hole.fairway !== "na");
    const fairwaysHit = fairwayHoles.filter((hole) => hole.fairway === "hit").length;
    const differential = complete ? estimateRoundDifferential(getSelectedRoundCourse(), entered) : null;
    const sgTotal = entered.reduce((sum, hole) => sum + (holeStrokesGained(hole) || 0), 0);
    const throughSuffix = complete ? "" : ` | thru ${entered.length}/${allHoles.length}`;
    els.roundPreview.textContent = `${gross} (${formatSigned(gross - par, 0)}) | ${putts} putts${throughSuffix}`;
    els.roundLiveSummary.innerHTML = `
      <div class="live-summary-card"><span>${complete ? "Gross" : `Gross (thru ${entered.length})`}</span><strong>${gross}</strong></div>
      <div class="live-summary-card"><span>To par</span><strong>${formatSigned(gross - par, 0)}</strong></div>
      <div class="live-summary-card"><span>Putts</span><strong>${putts}</strong></div>
      <div class="live-summary-card"><span>FIR</span><strong>${fairwayHoles.length ? percentage(fairwaysHit, fairwayHoles.length) : "--"}</strong></div>
      <div class="live-summary-card"><span>GIR</span><strong>${girMade ? percentage(girMade, entered.length) : "--"}</strong></div>
      <div class="live-summary-card"><span>Pen</span><strong>${penalties}</strong></div>
      <div class="live-summary-card"><span>SG vs scratch</span><strong>${formatSigned(sgTotal)}</strong></div>
      <div class="live-summary-card accent"><span>Diff est.</span><strong>${differential === null ? "--" : differential.toFixed(1)}</strong></div>
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
      const scoreRaw = scoreInput.value.trim();
      const scoreValue = scoreRaw === "" ? null : Number(scoreRaw);
      const puttsValue = Number(puttsInput.value);
      const penaltyValue = Number(penaltyInput.value);
      if (requireComplete) {
        if (!scoreValue || scoreValue < 1) {
          throw new Error(`Enter a score on ${scoreInput.dataset.label || `hole ${holeNumber}`} before saving.`);
        }
        if (puttsValue < 0 || penaltyValue < 0) {
          throw new Error("Putts and penalties must be 0 or higher.");
        }
      }
      return {
        number: Number(holeNumber),
        label: scoreInput.dataset.label || holeNumber,
        par: Number(scoreInput.dataset.par),
        yards: Number(scoreInput.dataset.yards || 0),
        hcp: Number(scoreInput.dataset.hcp || 0) || null,
        score: scoreValue,
        putts: Number.isFinite(puttsValue) ? puttsValue : 0,
        fairway: fairwayInput.value,
        gir: girInput.checked,
        penalties: Number.isFinite(penaltyValue) ? penaltyValue : 0
      };
    });
  }

  function estimateRoundDifferential(course, holes) {
    if (!course || !course.rating || !course.slope || !holes.length) return null;
    const gross = holes.reduce((sum, hole) => sum + hole.score, 0);
    const differential = ((gross - course.rating) * 113) / course.slope;
    if (holes.length >= 18) return Number(differential.toFixed(1));

    const currentIndex = calculateHandicapEstimate(state.rounds).index;
    const fallbackIndex = Math.max(0, differential * 2);
    const expectedDifferential = expectedNineHoleDifferential(currentIndex ?? fallbackIndex);
    return Number((differential + expectedDifferential).toFixed(1));
  }

  function renderMetrics(rounds) {
    const totals = rounds.map(roundTotals);
    const girMade = totals.reduce((sum, item) => sum + item.girMade, 0);
    const girTotal = totals.reduce((sum, item) => sum + item.girTotal, 0);
    const handicap = calculateHandicapEstimate(state.rounds);
    const best = [...rounds].sort((a, b) => {
      const aTotals = roundTotals(a);
      const bTotals = roundTotals(b);
      return aTotals.toPar - bTotals.toPar || aTotals.gross - bTotals.gross;
    })[0];
    const sgRounds = rounds.map(roundStrokesGained).filter(Boolean);
    const avgSg = sgRounds.length ? average(sgRounds.map((item) => item.total)) : NaN;

    els.metricRounds.textContent = String(rounds.length);
    els.metricAverageScore.textContent = Number.isFinite(average(totals.map((item) => item.gross)))
      ? average(totals.map((item) => item.gross)).toFixed(1)
      : "--";
    els.metricAveragePar.textContent = formatSigned(average(totals.map((item) => item.toPar)));
    els.metricBestRound.textContent = best ? `${roundTotals(best).gross} (${formatSigned(roundTotals(best).toPar, 0)})` : "--";
    els.metricGir.textContent = percentage(girMade, girTotal);
    els.metricSg.textContent = Number.isFinite(avgSg) ? formatSigned(avgSg) : "--";
    els.metricHandicap.textContent = handicap.index === null ? "--" : handicap.index.toFixed(1);
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

  function calculateHandicapEstimate(rounds) {
    const fullOnly = buildHandicapResult(getRatedDifferentialEntries(rounds, null, false));
    let seedIndex = fullOnly.index;
    if (seedIndex === null) {
      seedIndex = estimateSeedIndexFromNineHoleRounds(rounds);
    }

    let result = buildHandicapResult(getRatedDifferentialEntries(rounds, seedIndex, true));
    for (let iteration = 0; iteration < 3 && result.index !== null; iteration += 1) {
      result = buildHandicapResult(getRatedDifferentialEntries(rounds, result.index, true));
    }

    const approximateNineCount = result.eligible.filter((item) => item.approximate).length;
    return {
      ...result,
      approximateNineCount,
      note: approximateNineCount
        ? "Estimate only: 9-hole rounds use official 9-hole differentials plus an expected 9-hole differential approximation. Official GHIN/WHS uses an unpublished expected-score model, PCC, score adjustments, safeguards, and verification."
        : "Estimate only: uses gross score, Course Rating, Slope Rating, and PCC 0. Official GHIN/WHS posting also applies score adjustments, safeguards, and verification."
    };
  }

  function getRatedDifferentialEntries(rounds, expectedIndex, includeNineHoleRounds) {
    return rounds
      .map((round) => {
        const course = getCourse(round.courseId);
        const totals = roundTotals(round);
        if (!course || !course.rating || !course.slope) return undefined;
        const baseDifferential = ((totals.gross - course.rating) * 113) / course.slope;

        if (round.holes.length >= 18) {
          return {
            round,
            course,
            gross: totals.gross,
            holes: round.holes.length,
            differential: Number(baseDifferential.toFixed(1))
          };
        }

        if (!includeNineHoleRounds || round.holes.length !== 9) return undefined;
        const fallbackIndex = Math.max(0, baseDifferential * 2);
        const expectedDifferential = expectedNineHoleDifferential(expectedIndex ?? fallbackIndex);
        return {
          round,
          course,
          gross: totals.gross,
          holes: 9,
          approximate: true,
          nineHoleDifferential: Number(baseDifferential.toFixed(1)),
          expectedDifferential: Number(expectedDifferential.toFixed(1)),
          differential: Number((baseDifferential + expectedDifferential).toFixed(1))
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.round.date.localeCompare(a.round.date))
      .slice(0, 20);
  }

  function buildHandicapResult(eligible) {
    const rule = handicapRuleForCount(eligible.length);
    if (!rule) {
      return {
        index: null,
        eligible,
        used: [],
        rule: null,
        note: "Need at least three rated score differentials for a WHS-style estimate."
      };
    }

    const used = [...eligible]
      .sort((a, b) => a.differential - b.differential)
      .slice(0, rule.count);
    const raw = average(used.map((item) => item.differential)) + rule.adjustment;
    return {
      index: Math.max(0, Number(raw.toFixed(1))),
      eligible,
      used,
      rule
    };
  }

  function estimateSeedIndexFromNineHoleRounds(rounds) {
    const doubledDifferentials = getRatedDifferentialEntries(rounds, null, true)
      .filter((item) => item.holes === 9)
      .map((item) => item.nineHoleDifferential * 2);
    if (!doubledDifferentials.length) return null;
    return Math.max(0, average(doubledDifferentials));
  }

  function expectedNineHoleDifferential(index) {
    return Math.max(0, (0.52 * index) + 1.2);
  }

  function handicapRuleForCount(count) {
    if (count < 3) return null;
    if (count === 3) return { count: 1, adjustment: -2 };
    if (count === 4) return { count: 1, adjustment: -1 };
    if (count === 5) return { count: 1, adjustment: 0 };
    if (count === 6) return { count: 2, adjustment: -1 };
    if (count <= 8) return { count: 2, adjustment: 0 };
    if (count <= 11) return { count: 3, adjustment: 0 };
    if (count <= 14) return { count: 4, adjustment: 0 };
    if (count <= 16) return { count: 5, adjustment: 0 };
    if (count <= 18) return { count: 6, adjustment: 0 };
    if (count === 19) return { count: 7, adjustment: 0 };
    return { count: 8, adjustment: 0 };
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
      : emptyState("No course stats yet.");
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

    els.parStats.innerHTML = html || emptyState("No par-type stats yet.");
  }

  function getHoleGroups(rounds) {
    const map = new Map();
    rounds.forEach((round) => {
      const course = getCourse(round.courseId);
      round.holes.forEach((hole) => {
        const key = `${round.courseId}-${hole.number}`;
        if (!map.has(key)) {
          map.set(key, {
            key,
            courseId: round.courseId,
            courseName: course ? course.name : "Unknown",
            tee: round.tee,
            number: hole.number,
            label: hole.label || `#${hole.number}`,
            par: hole.par,
            scores: [],
            dates: []
          });
        }
        const group = map.get(key);
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

  function renderHoleLists(rounds) {
    const groups = getHoleGroups(rounds).filter((group) => group.rounds >= 1);
    const best = [...groups].sort((a, b) => a.avgToPar - b.avgToPar).slice(0, 5);
    const worst = [...groups].sort((a, b) => b.avgToPar - a.avgToPar).slice(0, 5);
    els.bestHoles.innerHTML = best.length ? best.map((group) => holeCard(group, false)).join("") : emptyState("No hole data yet.");
    els.worstHoles.innerHTML = worst.length ? worst.map((group) => holeCard(group, true)).join("") : emptyState("No hole data yet.");
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
      const course = getCourse(group.courseId);
      const courseHole = course && course.holes.find((hole) => hole.number === group.number);
      const yards = courseHole ? Number(courseHole.yards || 0) : 0;
      const expected = scratchExpectedStrokes(group.par, yards);
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
        <text x="${width - 20}" y="${zeroY - 4}" text-anchor="end" font-size="10" font-weight="700" fill="#7a8780">scratch</text>
        <polyline points="${path}" fill="none" stroke="#2f6f9f" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></polyline>
        ${circles}
      </svg>`;
  }

  function holeCard(group, bad) {
    return `
      <div class="hole-card">
        <div>
          <strong>${escapeHtml(group.courseName)} ${escapeHtml(group.label)}</strong>
          <span class="subtext">Par ${group.par} | ${group.rounds} rounds | best ${group.best}</span>
        </div>
        <span class="score-chip ${bad ? "bad" : ""}">${formatSigned(group.avgToPar)}</span>
      </div>`;
  }

  function buildCourseBrief(courseId) {
    if (!courseId || courseId === DEERWOOD_COURSE_ID) return null;
    const course = getCourse(courseId);
    if (!course) return null;

    const courseRounds = state.rounds
      .filter((round) => round.courseId === courseId)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (courseRounds.length < 2) return null;

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

    const holeStatsMap = new Map();
    courseRounds.forEach((round) => {
      round.holes.forEach((hole) => {
        if (!Number.isFinite(hole.score) || hole.score <= 0) return;
        let entry = holeStatsMap.get(hole.number);
        if (!entry) {
          entry = {
            number: hole.number,
            label: hole.label || `#${hole.number}`,
            par: hole.par,
            yards: hole.yards,
            scores: [],
            sgs: []
          };
          holeStatsMap.set(hole.number, entry);
        }
        entry.scores.push(hole.score);
        const sg = holeStrokesGained(hole);
        if (sg !== null) entry.sgs.push(sg);
      });
    });
    const holeStats = [...holeStatsMap.values()].map((entry) => {
      const avgScore = average(entry.scores);
      return {
        ...entry,
        avgScore,
        avgToPar: avgScore - entry.par,
        avgSg: entry.sgs.length ? average(entry.sgs) : NaN,
        rounds: entry.scores.length
      };
    });

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

  function renderRecentRounds() {
    const rows = [...state.rounds]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 7)
      .map((round) => {
        const course = getCourse(round.courseId);
        const totals = roundTotals(round);
        const sg = roundStrokesGained(round);
        const sgLabel = sg ? ` | SG ${formatSigned(sg.total)}` : "";
        const editingBadge = editingRoundId === round.id ? ' <span class="editing-pill">editing</span>' : "";
        return `
          <div class="round-row${editingRoundId === round.id ? " editing" : ""}">
            <div>
              <strong>${totals.gross} (${formatSigned(totals.toPar, 0)})${editingBadge}</strong>
              <span class="subtext">${round.date} | ${escapeHtml(course ? course.name : "Unknown")}${sgLabel}</span>
            </div>
            <div class="row-actions">
              <button type="button" data-edit-round="${round.id}">Edit</button>
              <button type="button" data-delete-round="${round.id}">Delete</button>
            </div>
          </div>`;
      }).join("");

    els.recentRounds.innerHTML = rows || emptyState("No rounds saved yet.");
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

  function renderCourseList() {
    const visibleCourses = state.courses.filter((course) => {
      return !isDeerwoodCourseId(course.id) || state.rounds.some((round) => round.courseId === course.id);
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

    els.courseList.innerHTML = rows || emptyState("No courses saved.");
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
      return `
        <div class="course-hole-row">
          <strong>${escapeHtml(hole.label || `#${hole.number}`)}</strong>
          <span>Par ${hole.par}</span>
          <span>${hole.yards || "--"} yds</span>
          <span>HCP ${hole.hcp || "--"}</span>
          <span>${stats ? `${stats.avgScore.toFixed(2)} avg` : "-- avg"}</span>
          <span>${stats ? `${formatSigned(stats.avgToPar)} to par` : "--"}</span>
        </div>`;
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
      els.trendChart.innerHTML = emptyState("No trend data yet.");
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

  function renderSpotlightHoleOptions() {
    const course = getCourse(els.spotlightCourse.value) || state.courses[0];
    if (!course) {
      els.spotlightHole.innerHTML = "";
      return;
    }
    const currentHole = Number(els.spotlightHole.value) || 1;
    els.spotlightCourse.value = course.id;
    els.spotlightHole.innerHTML = course.holes
      .map((hole) => `<option value="${hole.number}">${escapeHtml(hole.label || `#${hole.number}`)}</option>`)
      .join("");
    if (course.holes.some((hole) => hole.number === currentHole)) {
      els.spotlightHole.value = String(currentHole);
    }
  }

  function renderSpotlight() {
    const courseId = els.spotlightCourse.value;
    const holeNumber = Number(els.spotlightHole.value);
    const course = getCourse(courseId);
    if (!course || !holeNumber) {
      els.spotlightStats.innerHTML = emptyState("No hole selected.");
      els.spotlightHistory.innerHTML = "";
      return;
    }

    const courseHole = course.holes.find((hole) => hole.number === holeNumber);
    const holeRounds = state.rounds
      .filter((round) => round.courseId === courseId)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((round) => ({
        round,
        hole: round.holes.find((hole) => hole.number === holeNumber)
      }))
      .filter((item) => item.hole);

    if (!holeRounds.length) {
      els.spotlightStats.innerHTML = emptyState("No saved rounds for this hole.");
      els.spotlightHistory.innerHTML = "";
      return;
    }

    const scores = holeRounds.map((item) => item.hole.score);
    const avgScore = average(scores);
    const avgToPar = avgScore - courseHole.par;
    const parOrBetter = holeRounds.filter((item) => item.hole.score <= item.hole.par).length;
    const sgValues = holeRounds.map((item) => holeStrokesGained(item.hole)).filter((value) => value !== null);
    const avgSg = sgValues.length ? average(sgValues) : NaN;

    els.spotlightStats.innerHTML = `
      <div class="spotlight-kpis">
        <div><span>Average</span><strong>${avgScore.toFixed(2)}</strong></div>
        <div><span>To par</span><strong>${formatSigned(avgToPar)}</strong></div>
        <div><span>SG / hole</span><strong>${Number.isFinite(avgSg) ? formatSigned(avgSg, 2) : "--"}</strong></div>
        <div><span>Best / worst</span><strong>${Math.min(...scores)} / ${Math.max(...scores)}</strong></div>
        <div><span>Par or better</span><strong>${percentage(parOrBetter, holeRounds.length)}</strong></div>
        <div><span>Yardage</span><strong>${courseHole.yards || "--"}</strong></div>
      </div>`;

    els.spotlightHistory.innerHTML = miniChart(holeRounds, courseHole.par);
  }

  function miniChart(items, par) {
    const width = 360;
    const height = 130;
    const maxScore = Math.max(...items.map((item) => item.hole.score), par + 2);
    const minScore = Math.min(...items.map((item) => item.hole.score), par - 1);
    const range = Math.max(1, maxScore - minScore);
    const points = items.map((item, index) => {
      const x = items.length === 1 ? width / 2 : 20 + index * ((width - 40) / (items.length - 1));
      const y = 20 + ((maxScore - item.hole.score) / range) * 75;
      return { x, y, score: item.hole.score, date: item.round.date };
    });
    const path = points.map((point) => `${point.x},${point.y}`).join(" ");
    const circles = points.map((point) => `
      <circle cx="${point.x}" cy="${point.y}" r="5" fill="#217a57"></circle>
      <text x="${point.x}" y="${point.y - 10}" text-anchor="middle" font-size="11" font-weight="800" fill="#19231f">${point.score}</text>
    `).join("");

    return `
      <svg class="mini-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Hole score history">
        <rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#fbfcfa"></rect>
        <text x="14" y="24" font-size="12" font-weight="800" fill="#66746c">Score history</text>
        <polyline points="${path}" fill="none" stroke="#2f6f9f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
        ${circles}
      </svg>`;
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
    renderParStats(rounds);
    renderHoleLists(rounds);
    renderStrokesGained(rounds);
    renderRecentRounds();
    updateBackupBadge();
    renderCourseList();
    renderSpotlight();
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

  function emptyState(message) {
    return `<div class="empty-state">${message}</div>`;
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
  }

  function refreshRoundSetup() {
    renderRoundSetupOptions();
    renderScorecard(getSelectedRoundCourse());
    renderHandicapPanel();
    renderCourseBrief();
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
      ? brief.leaks.map((hole) => `<li><strong>${escapeHtml(hole.label)}</strong> <span class="subtext">Par ${hole.par}</span><span class="score-chip bad">${formatSigned(hole.avgSg, 2)}/rd</span></li>`).join("")
      : "<li class=\"subtext\">Need more SG-eligible rounds.</li>";

    const strengthsHtml = brief.strengths.length
      ? brief.strengths.map((hole) => `<li><strong>${escapeHtml(hole.label)}</strong> <span class="subtext">Par ${hole.par}</span><span class="score-chip">${formatSigned(hole.avgSg, 2)}/rd</span></li>`).join("")
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
    updateEditModeUi();
    if (rerender) renderScorecard(getSelectedRoundCourse());
  }

  function loadRoundIntoForm(round) {
    if (!round) return;
    editingRoundId = round.id;
    els.roundDate.value = round.date || today;
    els.roundNote.value = round.note || "";

    const deerwoodInfo = parseDeerwoodCourseId(round.courseId);
    if (deerwoodInfo) {
      els.roundCourse.value = DEERWOOD_COURSE_ID;
      els.roundHoleCount.value = deerwoodInfo.holeCount;
      renderRoundSetupOptions();
      els.roundLayout.value = deerwoodInfo.layoutId;
      els.roundTee.value = deerwoodInfo.tee;
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
      if (scoreInput && Number.isFinite(hole.score)) scoreInput.value = hole.score;
      if (puttsInput && Number.isFinite(hole.putts)) puttsInput.value = hole.putts;
      if (penaltyInput && Number.isFinite(hole.penalties)) penaltyInput.value = hole.penalties;
      if (fairwayInput && hole.fairway) {
        const hasOption = [...fairwayInput.options].some((option) => option.value === hole.fairway);
        if (hasOption) fairwayInput.value = hole.fairway;
      }
      if (girInput) girInput.checked = Boolean(hole.gir);
    });

    updateEditModeUi();
    updateRoundPreview();
    setActiveTab("rounds");
  }

  els.roundCourse.addEventListener("change", () => {
    if (els.roundCourse.value === DEERWOOD_COURSE_ID) els.roundTee.value = "White";
    refreshRoundSetup();
  });
  els.roundHoleCount.addEventListener("change", refreshRoundSetup);
  els.roundLayout.addEventListener("change", refreshRoundSetup);
  els.roundTee.addEventListener("change", refreshRoundSetup);
  els.resetRoundButton.addEventListener("click", () => {
    if (editingRoundId) {
      clearEditState();
      showToast("Edit cancelled.");
    } else {
      renderScorecard(getSelectedRoundCourse());
    }
  });

  if (els.viewToggleButton) {
    els.viewToggleButton.addEventListener("click", () => {
      setViewMode(viewMode === "card" ? "grid" : "card");
    });
  }

  els.scorecardGrid.addEventListener("keydown", advanceScorecardOnEnter);

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
      renderParStats(rounds);
      renderHoleLists(rounds);
      renderHandicapPanel();
    });
  });

  els.spotlightCourse.addEventListener("change", () => {
    renderSpotlightHoleOptions();
    renderSpotlight();
  });
  els.spotlightHole.addEventListener("change", renderSpotlight);

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
        state.rounds[existingIndex] = {
          ...state.rounds[existingIndex],
          date,
          courseId: course.id,
          tee: course.tee,
          note,
          holes
        };
        editingRoundId = null;
        saveState();
        updateEditModeUi();
        els.roundNote.value = "";
        renderAll();
        setActiveTab("home");
        showToast("Round updated.");
      } else {
        state.rounds.push({
          id: makeId("round"),
          date,
          courseId: course.id,
          tee: course.tee,
          note,
          holes
        });
        saveState();
        els.roundNote.value = "";
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

  els.loadSampleButton.addEventListener("click", () => {
    if (state.rounds.length && !window.confirm("Replace current data with sample data?")) return;
    state = {
      courses: structuredClone(sampleCourses),
      rounds: structuredClone(sampleRounds)
    };
    clearEditState({ rerender: false });
    saveState();
    renderAll();
    showToast("Sample data loaded.");
  });

  els.clearButton.addEventListener("click", () => {
    if (!window.confirm("Clear all courses and rounds?")) return;
    state = { courses: [], rounds: [] };
    clearEditState({ rerender: false });
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
        state = imported;
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
    renderAll();
    setActiveTab(localStorage.getItem(ACTIVE_TAB_KEY) || "home");
  }

  initializeApp();
})();
