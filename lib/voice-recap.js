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
    return result;
  }
  return { validateRecap, OPTIONAL_HOLE_FIELDS, VOICE_RECAP_FRAGMENT_KEY, MAX_VOICE_RECAP_BYTES, encodeVoiceRecapFragment, decodeVoiceRecapFragment, voiceRecapNeedsFreshStoreConfirmation };
});
