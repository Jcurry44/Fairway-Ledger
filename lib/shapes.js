/*
 * Fairway Ledger — canonical Round + Hole shapes.
 *
 * The point of this file is that there is exactly ONE place to look up "what
 * fields does a hole carry?" and "what fields does a round carry?". Adding a
 * new per-hole field (we've added several: notes, shots, clubsHit,
 * penaltyClub, firstPuttDistance, ...) is a one-line change here, and every
 * read/write path picks it up via the builders below.
 *
 * The shapes are intentionally additive — unknown fields on incoming data
 * are preserved, not stripped. We never want to drop a user's field by
 * accident when a future deploy hasn't seen the latest schema.
 *
 * Loaded both as a browser global (window.GolfShapes) and as a CommonJS
 * module for the test runner, same UMD pattern as lib/golf-math.js.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.GolfShapes = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- Defaults ----------------------------------------------------------
  //
  // These are the values a brand-new hole / round gets when no overrides are
  // supplied. They are NOT a JSON schema — they're just sensible blanks. A
  // hole's `score` is null (not 0) so "user hasn't entered anything yet" is
  // distinguishable from "user scored 0", and `gir` defaults to false rather
  // than null so the boolean code paths don't have to deal with three states.

  const HOLE_DEFAULTS = Object.freeze({
    number: 0,
    label: "",
    par: 4,
    yards: 0,
    hcp: null,
    score: null,
    putts: 0,
    fairway: "na",
    gir: false,
    penalties: 0,
    penaltyClub: "",
    firstPuttDistance: null,
    // Did the player end up in sand on this hole, and where? Empty string
    // means "not entered". Valid values: "" / "none" / "fairway" /
    // "greenside" / "both". Fuels sand-save % and scrambling analytics.
    bunker: "",
    note: "",
    // shots and clubsHit are arrays — we freeze them shallowly so a stray
    // .push() on the default doesn't pollute every future hole. Builders
    // always clone before returning.
    shots: Object.freeze([]),
    clubsHit: Object.freeze([]),
  });

  const ROUND_DEFAULTS = Object.freeze({
    id: "",
    date: "",
    courseId: "",
    tee: "",
    wind: "",
    note: "",
    narrative: null,
    // Optional post-round reflection survey. Every field is "" or null when
    // not answered, so renderers can skip them cleanly. ratings is its own
    // sub-object (not flat) so we can add new clubs later without further
    // shape-versioning. The summary narrative weaves these into a closing
    // "Self-rated reflection" paragraph when any field is filled in.
    survey: Object.freeze({
      feel: "",            // "" | "great" | "good" | "okay" | "tough"
      confidence: "",      // "" | "shaky" | "building" | "solid" | "locked"
      ratings: Object.freeze({
        driver: null,      // null | 1..5
        irons: null,
        wedges: null,
        putter: null
      }),
      swingThoughts: "",
      wentWell: "",
      workOn: ""
    }),
    holes: Object.freeze([]),
  });

  // The keys arrays are exposed so callers (tests, debug tools) can introspect
  // the canonical field list without reaching into the frozen defaults.
  const HOLE_FIELDS = Object.freeze(Object.keys(HOLE_DEFAULTS));
  const ROUND_FIELDS = Object.freeze(Object.keys(ROUND_DEFAULTS));

  // ---- Builders ----------------------------------------------------------
  //
  // makeHole({score: 5, par: 4}) returns a hole with every canonical field
  // set (defaults filled in) plus any extras you pass through. Arrays are
  // freshly cloned so the result is safe to mutate.

  function makeHole(overrides) {
    const o = overrides || {};
    return {
      ...HOLE_DEFAULTS,
      // Replace frozen array defaults with fresh, mutable arrays.
      shots: [],
      clubsHit: [],
      // Spread overrides last so user values win, including replacing the
      // fresh arrays above when caller provided their own.
      ...o,
      // If caller provided shots/clubsHit, clone them so we don't alias.
      ...(Array.isArray(o.shots) ? { shots: o.shots.slice() } : {}),
      ...(Array.isArray(o.clubsHit) ? { clubsHit: o.clubsHit.slice() } : {}),
    };
  }

  // Defensively clone the frozen survey default into something mutable so
  // callers can update individual fields without TypeError. Caller-supplied
  // surveys win and get a shallow-merged ratings sub-object so partial
  // overrides ("just set ratings.driver = 4") work.
  function makeSurvey(input) {
    const base = {
      feel: "",
      confidence: "",
      ratings: { driver: null, irons: null, wedges: null, putter: null },
      swingThoughts: "",
      wentWell: "",
      workOn: ""
    };
    if (!input || typeof input !== "object") return base;
    const ratings = input.ratings && typeof input.ratings === "object"
      ? { ...base.ratings, ...input.ratings }
      : base.ratings;
    return { ...base, ...input, ratings };
  }

  function makeRound(overrides) {
    const o = overrides || {};
    const holes = Array.isArray(o.holes) ? o.holes.map(makeHole) : [];
    return {
      ...ROUND_DEFAULTS,
      holes: [],
      ...o,
      holes,
      survey: makeSurvey(o.survey),
    };
  }

  // ---- Normalizers -------------------------------------------------------
  //
  // normalizeHole / normalizeRound are the load-time path: take whatever
  // shape was on disk (or in an imported JSON) and return something every
  // read path can trust. Critically: extra fields are PRESERVED. This file
  // doesn't get to decide which fields are "real" — only which are required.

  function normalizeHole(input) {
    if (!input || typeof input !== "object") return makeHole();
    return makeHole(input);
  }

  function normalizeRound(input) {
    if (!input || typeof input !== "object") return makeRound();
    const round = makeRound(input);
    // makeRound already maps holes through makeHole; this is just an
    // explicit guard for callers that pass a non-array holes value.
    if (!Array.isArray(round.holes)) round.holes = [];
    return round;
  }

  return {
    HOLE_DEFAULTS,
    ROUND_DEFAULTS,
    HOLE_FIELDS,
    ROUND_FIELDS,
    makeHole,
    makeRound,
    normalizeHole,
    normalizeRound,
  };
});
