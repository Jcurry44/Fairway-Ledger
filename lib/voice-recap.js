/*
 * Fairway Ledger — shared voice-recap draft contract.
 *
 * This is deliberately a data contract, not a second round shape.  A draft
 * contains the canonical round fields plus the complete human recap beside
 * them.  The latter is never compressed into a score-only link: it is what
 * lets the inbox render the per-hole story and coaching verbatim.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FairwayVoiceRecap = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SCHEMA_VERSION = 1;
  const MAX_TEXT = 12000;
  const trimText = (value, max = MAX_TEXT) => typeof value === "string" ? value.trim().slice(0, max) : "";
  const copy = (value) => value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : {};

  function normalizeHoleNarration(value, index) {
    const raw = value && typeof value === "object" ? value : {};
    const holeNumber = Number(raw.holeNumber || raw.number || index + 1);
    return {
      holeNumber: Number.isInteger(holeNumber) && holeNumber > 0 && holeNumber <= 27 ? holeNumber : index + 1,
      label: trimText(raw.label, 80),
      narration: trimText(raw.narration || raw.note),
      coaching: trimText(raw.coaching, 4000),
    };
  }

  function normalizeDraft(input) {
    const raw = input && typeof input === "object" ? input : {};
    const rawRound = raw.round && typeof raw.round === "object" ? raw.round : {};
    const rawRecap = raw.recap && typeof raw.recap === "object" ? raw.recap : {};
    const holeNarration = Array.isArray(rawRecap.holeNarration)
      ? rawRecap.holeNarration.map(normalizeHoleNarration).filter((h) => h.narration || h.coaching)
      : [];
    const round = copy(rawRound);
    round.holes = Array.isArray(rawRound.holes) ? copy(rawRound.holes) : [];
    // Preserve narration in the canonical hole note too, so applying the
    // draft retains the golfer's own words in normal round history.
    holeNarration.forEach((entry) => {
      const hole = round.holes.find((candidate) => Number(candidate && candidate.number) === entry.holeNumber);
      if (hole && !trimText(hole.note)) hole.note = entry.narration;
    });
    return {
      id: trimText(raw.id, 120),
      schemaVersion: SCHEMA_VERSION,
      status: ["pending", "applied", "archived"].includes(raw.status) ? raw.status : "pending",
      createdAt: trimText(raw.createdAt, 80),
      updatedAt: trimText(raw.updatedAt, 80),
      source: {
        kind: trimText(raw.source && raw.source.kind, 80) || "voice",
        conversationId: trimText(raw.source && raw.source.conversationId, 200),
        capturedAt: trimText(raw.source && raw.source.capturedAt, 80),
      },
      round,
      recap: {
        title: trimText(rawRecap.title, 240),
        summary: trimText(rawRecap.summary || rawRecap.roundSummary),
        coaching: Array.isArray(rawRecap.coaching) ? rawRecap.coaching.map((line) => trimText(line, 4000)).filter(Boolean) : [],
        holeNarration,
        // The original transcript / structured evidence is opaque and
        // preserved intact. Renderers only show known, reviewed fields.
        evidence: Array.isArray(rawRecap.evidence) ? copy(rawRecap.evidence) : [],
      },
    };
  }

  function validateDraft(input) {
    const draft = normalizeDraft(input);
    const errors = [];
    if (!draft.round.date) errors.push("A round date is required.");
    if (!draft.round.courseId) errors.push("A Fairway Ledger courseId is required.");
    if (!draft.round.tee) errors.push("A tee is required.");
    if (!Array.isArray(draft.round.holes) || !draft.round.holes.length) errors.push("At least one scored hole is required.");
    if (!draft.recap.summary && !draft.recap.holeNarration.length && !draft.recap.coaching.length) {
      errors.push("The rich recap is empty; refusing to create a score-only voice draft.");
    }
    return { valid: errors.length === 0, errors, draft };
  }

  function toAppliedRound(input, makeRound, makeId) {
    const result = validateDraft(input);
    if (!result.valid) throw new Error(result.errors[0]);
    const draft = result.draft;
    return makeRound({
      ...draft.round,
      id: makeId("round"),
      // Keep the exact reviewed payload attached to history. Unknown fields
      // survive canonical normalization, so future detail views can expose it.
      voiceRecap: {
        draftId: draft.id,
        source: draft.source,
        recap: draft.recap,
        receivedAt: draft.createdAt || new Date().toISOString(),
      },
    });
  }

  return { SCHEMA_VERSION, normalizeDraft, validateDraft, toAppliedRound };
});
