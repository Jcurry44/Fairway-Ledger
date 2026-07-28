/* Fairway Ledger voice recap import. Browser global + Node test module. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FairwayVoiceRecap = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const OPTIONAL_HOLE_FIELDS = ["putts", "penalties", "fringePutts", "firstPuttDistance", "fairway", "gir", "bunker", "note", "clubsHit", "shots", "penaltyClubs"];
  const VOICE_RECAP_FRAGMENT_KEY = "voice-recap";
  // Keep a deep link comfortably below common mobile sharing/app URL limits.
  // A complete score-only 18-hole round is typically well under 1 KB.
  const MAX_VOICE_RECAP_BYTES = 8192;
  function fail(message) { throw new Error(message); }
  function finite(value, name, min, max) {
    if (!Number.isFinite(value) || value < min || value > max) fail(`${name} must be a number from ${min} to ${max}.`);
    return value;
  }
  function text(value, name, max) {
    if (typeof value !== "string") fail(`${name} must be text.`);
    if (value.length > max) fail(`${name} is too long.`);
    return value.trim();
  }
  function validDate(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00`)); }
  function textList(value, name) { if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.length > 300)) fail(`${name} must be a list of short text items.`); return value.map((v) => v.trim()).filter(Boolean); }

  function utf8ToBase64Url(value) {
    const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(value) : Buffer.from(value, "utf8");
    if (bytes.length > MAX_VOICE_RECAP_BYTES) fail("Voice recap link is too large.");
    let base64;
    if (typeof Buffer !== "undefined") base64 = Buffer.from(bytes).toString("base64");
    else {
      let binary = "";
      bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
      base64 = btoa(binary);
    }
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToUtf8(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) fail("Voice recap link is malformed.");
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    let bytes;
    if (typeof Buffer !== "undefined") bytes = Uint8Array.from(Buffer.from(padded, "base64"));
    else bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    if (bytes.length > MAX_VOICE_RECAP_BYTES) fail("Voice recap link is too large.");
    return typeof TextDecoder !== "undefined" ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString("utf8");
  }

  function encodeVoiceRecapFragment(recap) {
    return `${VOICE_RECAP_FRAGMENT_KEY}=${utf8ToBase64Url(JSON.stringify(recap))}`;
  }

  function decodeVoiceRecapFragment(hash) {
    const raw = String(hash || "").replace(/^#/, "");
    if (!raw) return null;
    const prefix = `${VOICE_RECAP_FRAGMENT_KEY}=`;
    if (!raw.startsWith(prefix)) return null;
    const encoded = raw.slice(prefix.length);
    if (encoded.length > Math.ceil(MAX_VOICE_RECAP_BYTES * 4 / 3)) fail("Voice recap link is too large.");
    try { return JSON.parse(base64UrlToUtf8(encoded)); }
    catch (error) { if (error && /Voice recap link/.test(error.message)) throw error; fail("Voice recap link could not be read."); }
  }

  // localStorage is intentionally isolated by browser origin and profile. A
  // link opened in a fresh partition must never look like it replaced history.
  function voiceRecapNeedsFreshStoreConfirmation(existingRoundCount) {
    return !Number.isFinite(existingRoundCount) || existingRoundCount <= 0;
  }

  function validateRecap(input, course) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("Recap must be a JSON object.");
    if (!course || !Array.isArray(course.holes) || !course.holes.length) fail("This recap's course route could not be found.");
    if (!validDate(input.date)) fail("date must use YYYY-MM-DD.");
    if (!Array.isArray(input.holes) || input.holes.length !== course.holes.length) {
      fail(`This route has ${course.holes.length} holes; provide exactly ${course.holes.length} hole entries.`);
    }
    const holes = input.holes.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`Hole ${index + 1} must be an object.`);
      if (raw.number != null && Number(raw.number) !== course.holes[index].number) fail(`Hole ${index + 1} does not match the selected route.`);
      const hole = { number: course.holes[index].number, label: course.holes[index].label || String(course.holes[index].number), par: course.holes[index].par, yards: course.holes[index].yards, hcp: course.holes[index].hcp || null, score: finite(Number(raw.score), `Hole ${index + 1} score`, 1, 20) };
      if (raw.putts != null) hole.putts = finite(Number(raw.putts), `Hole ${index + 1} putts`, 0, 10);
      if (raw.penalties != null) hole.penalties = finite(Number(raw.penalties), `Hole ${index + 1} penalties`, 0, 10);
      if (raw.fringePutts != null) hole.fringePutts = finite(Number(raw.fringePutts), `Hole ${index + 1} fringePutts`, 0, 10);
      if (raw.firstPuttDistance != null) hole.firstPuttDistance = finite(Number(raw.firstPuttDistance), `Hole ${index + 1} firstPuttDistance`, 0, 200);
      if (raw.note != null) hole.note = text(raw.note, `Hole ${index + 1} note`, 500);
      ["teeClub", "approachNote", "result", "missContext"].forEach((key) => { if (raw[key] != null) hole[key] = text(raw[key], `Hole ${index + 1} ${key}`, 500); });
      ["fairway", "bunker"].forEach((key) => { if (raw[key] != null) hole[key] = text(raw[key], `Hole ${index + 1} ${key}`, 20); });
      if (raw.gir != null) { if (typeof raw.gir !== "boolean") fail(`Hole ${index + 1} gir must be true or false.`); hole.gir = raw.gir; }
      ["clubsHit", "shots", "penaltyClubs"].forEach((key) => { if (raw[key] != null) { if (!Array.isArray(raw[key])) fail(`Hole ${index + 1} ${key} must be an array.`); hole[key] = raw[key]; } });
      if (hole.teeClub && !hole.clubsHit) hole.clubsHit = [hole.teeClub];
      hole.voiceKnown = {
        teeClub: raw.teeClub != null,
        putts: raw.putts != null,
        penalties: raw.penalties != null,
        approachNote: raw.approachNote != null,
        result: raw.result != null,
        missContext: raw.missContext != null,
        note: raw.note != null,
        shots: raw.shots != null
      };
      return hole;
    });
    const result = { date: input.date, holes };
    ["wind", "tag", "note"].forEach((key) => { if (input[key] != null) result[key] = text(input[key], key, key === "note" ? 500 : 30); });
    if (input.coaching != null) {
      if (!input.coaching || typeof input.coaching !== "object" || Array.isArray(input.coaching)) fail("coaching must be an object.");
      const c = input.coaching;
      result.coaching = {};
      ["story", "pattern", "nextRoundCue"].forEach((key) => { if (c[key] != null) result.coaching[key] = text(c[key], `coaching.${key}`, 800); });
      ["strengths", "practicePlan"].forEach((key) => { if (c[key] != null) result.coaching[key] = textList(c[key], `coaching.${key}`); });
    }
    return result;
  }
  // Shared drafts preserve the complete reviewed recap beside the canonical
  // scorecard. They are intentionally rejected when they contain scores only.
  const SCHEMA_VERSION = 1;
  const trimDraftText = (value, max = 12000) => typeof value === "string" ? value.trim().slice(0, max) : "";
  const copyDraftValue = (value) => value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : {};
  function normalizeDraft(input) {
    const raw = input && typeof input === "object" ? input : {};
    const rawRound = raw.round && typeof raw.round === "object" ? raw.round : {};
    const rawRecap = raw.recap && typeof raw.recap === "object" ? raw.recap : {};
    const round = copyDraftValue(rawRound);
    round.holes = Array.isArray(rawRound.holes) ? copyDraftValue(rawRound.holes) : [];
    const holeNarration = (Array.isArray(rawRecap.holeNarration) ? rawRecap.holeNarration : []).map((item, index) => {
      const source = item && typeof item === "object" ? item : {};
      const holeNumber = Number(source.holeNumber || source.number || index + 1);
      return { holeNumber: Number.isInteger(holeNumber) && holeNumber > 0 && holeNumber <= 27 ? holeNumber : index + 1, label: trimDraftText(source.label, 80), narration: trimDraftText(source.narration || source.note), coaching: trimDraftText(source.coaching, 4000) };
    }).filter((item) => item.narration || item.coaching);
    holeNarration.forEach((item) => {
      const hole = round.holes.find((candidate) => Number(candidate && candidate.number) === item.holeNumber);
      if (hole && !trimDraftText(hole.note)) hole.note = item.narration;
    });
    return {
      id: trimDraftText(raw.id, 120), schemaVersion: SCHEMA_VERSION,
      status: ["pending", "applied", "archived"].includes(raw.status) ? raw.status : "pending",
      createdAt: trimDraftText(raw.createdAt, 80), updatedAt: trimDraftText(raw.updatedAt, 80),
      source: { kind: trimDraftText(raw.source && raw.source.kind, 80) || "voice", conversationId: trimDraftText(raw.source && raw.source.conversationId, 200), capturedAt: trimDraftText(raw.source && raw.source.capturedAt, 80) },
      round,
      recap: { title: trimDraftText(rawRecap.title, 240), summary: trimDraftText(rawRecap.summary || rawRecap.roundSummary), coaching: Array.isArray(rawRecap.coaching) ? rawRecap.coaching.map((line) => trimDraftText(line, 4000)).filter(Boolean) : [], holeNarration, evidence: Array.isArray(rawRecap.evidence) ? copyDraftValue(rawRecap.evidence) : [] }
    };
  }
  function validateDraft(input) {
    const draft = normalizeDraft(input), errors = [];
    if (!draft.round.date) errors.push("A round date is required.");
    if (!draft.round.courseId) errors.push("A Fairway Ledger courseId is required.");
    if (!draft.round.tee) errors.push("A tee is required.");
    if (!draft.round.holes.length) errors.push("At least one scored hole is required.");
    if (!draft.recap.summary && !draft.recap.holeNarration.length && !draft.recap.coaching.length) errors.push("The rich recap is empty; refusing to create a score-only voice draft.");
    return { valid: errors.length === 0, errors, draft };
  }
  function toAppliedRound(input, makeRound, makeId) {
    const result = validateDraft(input);
    if (!result.valid) throw new Error(result.errors[0]);
    const draft = result.draft;
    return makeRound({ ...draft.round, id: makeId("round"), voiceRecap: { draftId: draft.id, source: draft.source, recap: draft.recap, receivedAt: draft.createdAt || new Date().toISOString() } });
  }
  return { validateRecap, OPTIONAL_HOLE_FIELDS, VOICE_RECAP_FRAGMENT_KEY, MAX_VOICE_RECAP_BYTES, encodeVoiceRecapFragment, decodeVoiceRecapFragment, voiceRecapNeedsFreshStoreConfirmation, SCHEMA_VERSION, normalizeDraft, validateDraft, toAppliedRound };
});
