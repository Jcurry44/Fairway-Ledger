/*
 * Fairway Ledger — the Miss Cost map.
 *
 * What each kind of miss costs YOU, in strokes: tee shots left / right /
 * short / long, fairway and greenside sand, penalty holes and 3-putts. Each
 * miss is priced against your holes ON THE SAME PAR where that miss didn't
 * happen (tee misses vs fairway hit, sand vs no sand, 3-putts vs 1-2 putts,
 * penalty holes vs no penalty; each family on its own, so one miss never
 * inflates another's price). A par only counts when it has MIN_CELL_CLEAN
 * clean holes to compare against. Then it's scaled by how often it happens,
 * so the ranking shows what actually hurts the scorecard: cost per miss x
 * misses per 18 holes. Under EARLY_SAMPLE holes a price is an "early read".
 *
 * Honest-data rules (lib/golf-math.js): speed rounds are left out
 * (isDetailRound); a hole only counts for a miss type when that field was
 * actually entered (fairwayKnown, bunker != "", puttsKnown). Penalties have
 * no "not entered" state, so penalty holes are the holes where you recorded
 * one. A miss needs MIN_SAMPLE holes and MIN_SAMPLE baseline holes before it
 * gets a price; otherwise it's reported as "thin" with its counts.
 *
 * Pure and dependency-injected like lib/season.js: no DOM, no storage, no
 * module state, inputs never mutated.
 *
 * Loaded two ways:
 *   - Browser: a plain <script> after golf-math.js; sets window.FairwayMissCost.
 *   - Node: require("../lib/misscost.js") for the test suite.
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./golf-math.js"));
  } else {
    root.FairwayMissCost = factory(root.GolfMath);
  }
})(typeof self !== "undefined" ? self : this, function (GolfMath) {
  "use strict";

  const MIN_SAMPLE = 5;        // holes with the miss, and baseline holes, before a price is shown
  const EARLY_SAMPLE = 10;     // below this many (either side) a price is an "early read"
  const MIN_CELL_CLEAN = 3;    // clean holes a par needs before its misses are compared
  const MIN_PER18 = 0.1;       // a cost that rounds below this per 18 is "no cost so far"
  const HOLES_PER_ROUND = 18;  // frequencies and per-round costs are per 18 holes played

  const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
  const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

  const isDetailRound = GolfMath && GolfMath.isDetailRound
    ? GolfMath.isDetailRound
    : (round) => !!round && round.entryMode !== "speed";
  const puttsKnown = GolfMath && GolfMath.puttsKnown
    ? GolfMath.puttsKnown
    : (hole) => !!hole && Number.isFinite(hole.putts) && hole.putts >= 0;
  const FAIRWAY_RESULTS = ["hit", "left", "right", "short", "long", "miss"];
  const fairwayKnown = GolfMath && GolfMath.fairwayKnown
    ? GolfMath.fairwayKnown
    : (hole) => !!hole && hole.par > 3 && FAIRWAY_RESULTS.includes(hole.fairway);
  const BUNKER_RESULTS = ["none", "fairway", "greenside", "both"];

  function isScored(hole) {
    return !!hole && Number.isFinite(hole.score) && hole.score >= 1;
  }
  function parOf(hole) {
    return Number.isFinite(hole.par) && hole.par >= 1 ? hole.par : 4;
  }

  // ---- The miss types --------------------------------------------------------
  // Each family names which holes it can judge (known), which of those are
  // the clean baseline, and its buckets (the misses). Glyphs are shapes, so
  // nothing depends on colour; labels are plain words.

  const FAMILIES = [
    {
      id: "tee",
      label: "Tee shots",
      baselineLabel: "fairway hit",
      known: (h) => fairwayKnown(h),
      eligible: (h) => parOf(h) > 3,
      unloggedIsClean: false, // Quick's tee chips are optional per hole
      baseline: (h) => h.fairway === "hit",
      buckets: [
        { id: "tee-left", label: "Tee shot left", glyph: "◀\uFE0E", test: (h) => h.fairway === "left" },
        { id: "tee-right", label: "Tee shot right", glyph: "▶\uFE0E", test: (h) => h.fairway === "right" },
        { id: "tee-short", label: "Tee shot short", glyph: "▼", test: (h) => h.fairway === "short" },
        { id: "tee-long", label: "Tee shot long", glyph: "▲", test: (h) => h.fairway === "long" },
        { id: "tee-miss", label: "Missed fairway (no side)", glyph: "○", test: (h) => h.fairway === "miss" }
      ]
    },
    {
      id: "sand",
      label: "Sand",
      baselineLabel: "no sand",
      known: (h) => BUNKER_RESULTS.includes(h.bunker),
      eligible: () => true,
      unloggedIsClean: true, // sand gets marked when you're in it
      baseline: (h) => h.bunker === "none",
      buckets: [
        { id: "sand-fairway", label: "Fairway bunker", glyph: "◇", test: (h) => h.bunker === "fairway" },
        { id: "sand-greenside", label: "Greenside bunker", glyph: "◆", test: (h) => h.bunker === "greenside" },
        { id: "sand-both", label: "Both bunkers", glyph: "◈", test: (h) => h.bunker === "both" }
      ]
    },
    {
      id: "putting",
      label: "Putting",
      baselineLabel: "1-2 putts",
      known: (h) => puttsKnown(h) && h.putts >= 1,
      eligible: () => true,
      unloggedIsClean: false, // putts can be left blank per hole
      baseline: (h) => h.putts === 1 || h.putts === 2,
      buckets: [
        { id: "three-putt", label: "3-putt or worse", glyph: "③", test: (h) => h.putts >= 3 }
      ]
    },
    {
      id: "penalty",
      label: "Penalties",
      baselineLabel: "no penalty",
      known: () => true,
      eligible: () => true,
      unloggedIsClean: true,
      baseline: (h) => !(Number(h.penalties) > 0),
      buckets: [
        { id: "penalty", label: "Penalty hole", glyph: "✕", test: (h) => Number(h.penalties) > 0 }
      ]
    }
  ];

  // ---- Pricing -------------------------------------------------------------------

  function holeRef(round, hole) {
    return {
      roundId: round.id == null ? null : round.id,
      date: round.date || "",
      courseId: round.courseId == null ? null : round.courseId,
      number: hole.number == null ? null : hole.number,
      label: hole.label == null || String(hole.label).trim() === "" ? String(hole.number == null ? "" : hole.number) : String(hole.label),
      par: parOf(hole),
      score: hole.score,
      vsPar: hole.score - parOf(hole)
    };
  }

  // Bucket vs baseline, matched par by par: cost = sum over pars of
  // n_miss(par) x (avg_miss(par) - avg_clean(par)) / sum of n_miss. Misses on
  // a par with no clean holes to compare against are left out (unmatched).
  function priceBucket(missRefs, baseRefs, minCellClean) {
    const byPar = new Map();
    const add = (ref, side) => {
      let cell = byPar.get(ref.par);
      if (!cell) { cell = { par: ref.par, miss: [], base: [] }; byPar.set(ref.par, cell); }
      cell[side].push(ref.vsPar);
    };
    missRefs.forEach((ref) => add(ref, "miss"));
    baseRefs.forEach((ref) => add(ref, "base"));
    let matched = 0;
    let baseMatched = 0;
    let weighted = 0;
    const pars = [];
    Array.from(byPar.values()).sort((a, b) => a.par - b.par).forEach((cell) => {
      if (!cell.miss.length) return;
      const missAvg = cell.miss.reduce((s, x) => s + x, 0) / cell.miss.length;
      if (cell.base.length < minCellClean) {
        pars.push({ par: cell.par, misses: cell.miss.length, missAvg: r2(missAvg + cell.par), clean: cell.base.length, cleanAvg: null, diff: null });
        return;
      }
      const baseAvg = cell.base.reduce((s, x) => s + x, 0) / cell.base.length;
      matched += cell.miss.length;
      baseMatched += cell.base.length;
      weighted += cell.miss.length * (missAvg - baseAvg);
      pars.push({
        par: cell.par,
        misses: cell.miss.length,
        missAvg: r2(missAvg + cell.par),
        clean: cell.base.length,
        cleanAvg: r2(baseAvg + cell.par),
        diff: r2(missAvg - baseAvg)
      });
    });
    return {
      matched,
      baseMatched,
      unmatched: missRefs.length - matched,
      perMiss: matched ? weighted / matched : null,
      pars
    };
  }

  function computeMissCost(rounds, options) {
    const o = options || {};
    const minSample = Number.isFinite(o.minSample) && o.minSample >= 1 ? o.minSample : MIN_SAMPLE;
    const list = (Array.isArray(rounds) ? rounds : []).filter((r) => r && Array.isArray(r.holes) && r.holes.some(isScored));
    const detail = list.filter(isDetailRound);
    const result = {
      minSample,
      rounds: detail.length,
      speedRounds: list.length - detail.length,
      holes: detail.reduce((s, r) => s + r.holes.filter(isScored).length, 0),
      families: [],
      ranked: [],
      thin: [],
      free: []
    };

    FAMILIES.forEach((family) => {
      const missRefs = new Map(family.buckets.map((b) => [b.id, []]));
      const baseRefs = [];
      const contributing = new Set();
      let knownHoles = 0;
      let holesInContributing = 0;
      let eligibleInContributing = 0;
      detail.forEach((round, roundIndex) => {
        let any = false;
        round.holes.forEach((hole) => {
          if (!isScored(hole) || !family.known(hole)) return;
          any = true;
          knownHoles += 1;
          const ref = holeRef(round, hole);
          if (family.baseline(hole)) { baseRefs.push(ref); return; }
          const bucket = family.buckets.find((b) => b.test(hole));
          if (bucket) missRefs.get(bucket.id).push(ref);
        });
        if (any) {
          contributing.add(roundIndex);
          const scored = round.holes.filter(isScored);
          holesInContributing += scored.length;
          eligibleInContributing += scored.filter(family.eligible).length;
        }
      });

      const fam = {
        id: family.id,
        label: family.label,
        baselineLabel: family.baselineLabel,
        rounds: contributing.size,
        knownHoles,
        holesPlayed: holesInContributing,
        baseline: { n: baseRefs.length, holes: baseRefs },
        buckets: []
      };
      family.buckets.forEach((def) => {
        const refs = missRefs.get(def.id);
        if (!refs.length) return; // a miss you never logged isn't a row
        const price = priceBucket(refs, baseRefs, MIN_CELL_CLEAN);
        // How often it happens per 18 holes. Where an unlogged hole means
        // "clean" (sand, penalties), count every hole of the rounds that
        // logged it; where fields are optional per hole (tee chips, putts),
        // use the rate on the holes you logged, scaled to the eligible share
        // of a round (par 4s and 5s for tee shots).
        let freq18 = null;
        if (holesInContributing) {
          freq18 = family.unloggedIsClean || !knownHoles
            ? (refs.length / holesInContributing) * HOLES_PER_ROUND
            : (refs.length / knownHoles) * (eligibleInContributing / holesInContributing) * HOLES_PER_ROUND;
        }
        const enough = price.matched >= minSample && price.baseMatched >= minSample;
        const perMiss = enough ? price.perMiss : null;
        const per18 = enough && freq18 != null ? perMiss * freq18 : null;
        const early = enough && (price.matched < EARLY_SAMPLE || price.baseMatched < EARLY_SAMPLE);
        const bucket = {
          id: def.id,
          family: family.id,
          label: def.label,
          glyph: def.glyph,
          baselineLabel: family.baselineLabel,
          n: refs.length,
          matched: price.matched,
          baseline: price.baseMatched,
          unmatched: price.unmatched,
          freq18: r2(freq18),
          perMiss: r2(perMiss),
          per18: r1(per18),
          early,
          status: !enough ? "thin" : perMiss > 0 && per18 >= MIN_PER18 ? "costs" : "free",
          pars: price.pars,
          holes: refs.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.number || 0) - (a.number || 0))
        };
        fam.buckets.push(bucket);
        if (bucket.status === "costs") result.ranked.push(bucket);
        else if (bucket.status === "thin") result.thin.push(bucket);
        else result.free.push(bucket);
      });
      result.families.push(fam);
    });

    // Biggest per-18 cost first; ties go to the costlier miss, then the more
    // frequent one, then the label (stable across renders).
    result.ranked.sort((a, b) => b.per18 - a.per18 || b.perMiss - a.perMiss || b.n - a.n || a.label.localeCompare(b.label));
    result.thin.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
    result.free.sort((a, b) => a.perMiss - b.perMiss || a.label.localeCompare(b.label));
    // The headline only names a firm price; an early-only leader is offered
    // separately so the UI can say "early read".
    result.biggest = result.ranked.find((b) => !b.early) || null;
    result.earlyLeader = result.biggest ? null : (result.ranked[0] || null);
    result.totalPer18 = r1(result.ranked.reduce((s, b) => s + b.per18, 0));
    return result;
  }

  // What to log next to price more misses: the family with the fewest known
  // holes among those that matter. Returns null when everything has data.
  function missingData(result) {
    if (!result || !result.rounds) return null;
    const fams = result.families.filter((f) => f.knownHoles === 0);
    if (!fams.length) return null;
    return fams.map((f) => f.id);
  }

  return {
    MIN_SAMPLE,
    EARLY_SAMPLE,
    MIN_CELL_CLEAN,
    HOLES_PER_ROUND,
    FAMILIES: FAMILIES.map((f) => ({ id: f.id, label: f.label, baselineLabel: f.baselineLabel, buckets: f.buckets.map((b) => ({ id: b.id, label: b.label, glyph: b.glyph })) })),
    computeMissCost,
    missingData
  };
});
