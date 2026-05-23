/*
 * Fairway Ledger — pure golf math.
 *
 * Every function here is deterministic and side-effect free: no DOM, no
 * localStorage, no module state. That makes it the one part of the app that
 * can be unit-tested directly (see tests/golf-math.test.js).
 *
 * Loaded two ways:
 *   - Browser: a plain <script> that sets window.GolfMath (app.js destructures
 *     from it). No build step.
 *   - Node: require("../lib/golf-math.js") for the test suite.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.GolfMath = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- Small numeric utilities -------------------------------------------

  function average(values) {
    const realValues = values.filter((value) => Number.isFinite(value));
    if (!realValues.length) return NaN;
    return realValues.reduce((sum, value) => sum + value, 0) / realValues.length;
  }

  function percentage(made, total) {
    if (!total) return "--";
    return `${Math.round((made / total) * 100)}%`;
  }

  function formatSigned(value, digits = 1) {
    if (!Number.isFinite(value)) return "--";
    const rounded = Number(value.toFixed(digits));
    if (rounded > 0) return `+${rounded}`;
    return String(rounded);
  }

  // ---- Strokes Gained vs. PGA Tour benchmark -----------------------------
  //
  // Source: Mark Broadie, "Every Shot Counts" tour averages; intermediate
  // yardages interpolated linearly. This is a TOUR baseline, not "scratch" —
  // tour pros average ~70-71, scratch golfers ~73-74, so amateur SG vs tour
  // skews more negative than vs true scratch.
  const TOUR_BENCHMARK_TABLES = {
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

  function tourExpectedStrokes(par, yards) {
    const table = TOUR_BENCHMARK_TABLES[par];
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
    return tourExpectedStrokes(hole.par, hole.yards) - hole.score;
  }

  function roundStrokesGained(round) {
    if (!round || !Array.isArray(round.holes)) return null;
    const valid = round.holes.filter((hole) => Number.isFinite(hole.score) && hole.score > 0);
    if (!valid.length) return null;
    const total = valid.reduce((sum, hole) => sum + (holeStrokesGained(hole) || 0), 0);
    return { total, holes: valid.length };
  }

  // ---- Round totals ------------------------------------------------------

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

  // ---- Scoring-tier classification ---------------------------------------
  //
  // Traditional scorecard notation tier for a score vs. par.

  function scoreMarkClass(score, par) {
    if (!Number.isFinite(score) || score <= 0 || !Number.isFinite(par)) return "";
    const delta = score - par;
    if (delta <= -2) return "score-mark-eagle";
    if (delta === -1) return "score-mark-birdie";
    if (delta === 0) return "score-mark-par";
    if (delta === 1) return "score-mark-bogey";
    if (delta === 2) return "score-mark-double";
    return "score-mark-triple";
  }

  // ---- Derived flags -----------------------------------------------------
  //
  // Green in regulation: on the green in (par - 2) strokes or fewer, with
  // enough putts left to finish. Pure function of the saved per-hole inputs,
  // so the user never needs to tick it manually.
  //
  //   par 3  → GIR iff (score - putts) ≤ 1   (on green in 1 stroke)
  //   par 4  → GIR iff (score - putts) ≤ 2
  //   par 5  → GIR iff (score - putts) ≤ 3
  //
  // A chip-in (0 putts from off-green) correctly fails GIR; a 3-putt from
  // on-in-reg correctly stays GIR.
  function derivedGir(score, putts, par) {
    if (!Number.isFinite(score) || score <= 0) return false;
    if (!Number.isFinite(par) || par <= 0) return false;
    const p = Number.isFinite(putts) && putts >= 0 ? putts : 0;
    return (score - p) <= (par - 2);
  }

  // ---- Hole identity -----------------------------------------------------

  function isDeerwoodCourseId(courseId) {
    return String(courseId || "").startsWith("deerwood-");
  }

  // A physical hole's stable identity, independent of routing and tee.
  // Deerwood holes carry a label like "Buck 3" that encodes nine + within-nine
  // number — stable no matter where the nine sits in an 18-hole routing.
  function physicalHoleId(courseId, hole) {
    if (isDeerwoodCourseId(courseId) && hole) {
      const match = String(hole.label || "").trim().match(/^(buck|doe|fawn)\s+(\d+)$/i);
      if (match) return `deerwood:${match[1].toLowerCase()}:${match[2]}`;
    }
    return `course:${courseId}:${hole ? hole.number : ""}`;
  }

  // ---- Geo (GPS shot distances) ------------------------------------------

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function metersToYards(meters) {
    return meters * 1.0936133;
  }

  // ---- Handicap helpers (WHS-style) --------------------------------------

  function expectedNineHoleDifferential(index) {
    return Math.max(0, (0.52 * index) + 1.2);
  }

  // Single-round score differential, WHS-style. For 9-hole rounds, the
  // expected-9-hole-differential (a function of the player's current index)
  // is added so a 9 becomes comparable to an 18. If `currentIndex` is null,
  // we fall back to doubling the raw 9-hole differential (rough but stable).
  function estimateRoundDifferential(course, holes, currentIndex) {
    if (!course || !course.rating || !course.slope || !Array.isArray(holes) || !holes.length) return null;
    const gross = holes.reduce((sum, hole) => sum + Number(hole.score || 0), 0);
    const differential = ((gross - course.rating) * 113) / course.slope;
    if (holes.length >= 18) return Number(differential.toFixed(1));
    const fallbackIndex = Math.max(0, differential * 2);
    const indexToUse = (currentIndex === null || currentIndex === undefined) ? fallbackIndex : currentIndex;
    const expectedDifferential = expectedNineHoleDifferential(indexToUse);
    return Number((differential + expectedDifferential).toFixed(1));
  }

  // Build the list of rated score-differential entries (used as input to the
  // best-N selection). lookupCourse is the only side-effect-shaped dependency
  // — pass a function (courseId) => { rating, slope } | null.
  function getRatedDifferentialEntries(rounds, lookupCourse, expectedIndex, includeNineHoleRounds) {
    return rounds
      .map((round) => {
        const course = lookupCourse(round.courseId);
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

  // Best-N-of-rule + WHS adjustment. Negative results clamp to 0.
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

  // Seed index from 9-hole rounds only — used when we have no 18-hole
  // differentials to start the iteration. Just doubles the raw 9-hole base
  // and averages, then iteration in calculateHandicapEstimate refines it.
  function estimateSeedIndexFromNineHoleRounds(rounds, lookupCourse) {
    const doubledDifferentials = getRatedDifferentialEntries(rounds, lookupCourse, null, true)
      .filter((item) => item.holes === 9)
      .map((item) => item.nineHoleDifferential * 2);
    if (!doubledDifferentials.length) return null;
    return Math.max(0, average(doubledDifferentials));
  }

  // Top-level WHS-style handicap index estimate. The expected-9-hole formula
  // depends on the player's current index, so we iterate: seed from 18-hole
  // only (or doubled 9-hole), then re-evaluate including 9-hole rounds with
  // the seed index, then up to 3 more rounds to converge.
  function calculateHandicapEstimate(rounds, lookupCourse) {
    const fullOnly = buildHandicapResult(getRatedDifferentialEntries(rounds, lookupCourse, null, false));
    let seedIndex = fullOnly.index;
    if (seedIndex === null) {
      seedIndex = estimateSeedIndexFromNineHoleRounds(rounds, lookupCourse);
    }

    let result = buildHandicapResult(getRatedDifferentialEntries(rounds, lookupCourse, seedIndex, true));
    for (let iteration = 0; iteration < 3 && result.index !== null; iteration += 1) {
      result = buildHandicapResult(getRatedDifferentialEntries(rounds, lookupCourse, result.index, true));
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

  // How many of the best score differentials to use, and the adjustment, for
  // a given count of eligible rounds (WHS Rule of Handicapping table).
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

  return {
    average,
    percentage,
    formatSigned,
    TOUR_BENCHMARK_TABLES,
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
    estimateRoundDifferential,
    getRatedDifferentialEntries,
    buildHandicapResult,
    estimateSeedIndexFromNineHoleRounds,
    calculateHandicapEstimate
  };
});
