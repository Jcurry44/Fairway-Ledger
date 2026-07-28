/* Fairway Ledger voice recap import. Browser global + Node test module. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FairwayVoiceRecap = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const OPTIONAL_HOLE_FIELDS = ["putts", "penalties", "fringePutts", "firstPuttDistance", "fairway", "gir", "bunker", "note", "clubsHit", "shots", "penaltyClubs"];
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
      ["fairway", "bunker"].forEach((key) => { if (raw[key] != null) hole[key] = text(raw[key], `Hole ${index + 1} ${key}`, 20); });
      if (raw.gir != null) { if (typeof raw.gir !== "boolean") fail(`Hole ${index + 1} gir must be true or false.`); hole.gir = raw.gir; }
      ["clubsHit", "shots", "penaltyClubs"].forEach((key) => { if (raw[key] != null) { if (!Array.isArray(raw[key])) fail(`Hole ${index + 1} ${key} must be an array.`); hole[key] = raw[key]; } });
      return hole;
    });
    const result = { date: input.date, holes };
    ["wind", "tag", "note"].forEach((key) => { if (input[key] != null) result[key] = text(input[key], key, key === "note" ? 500 : 30); });
    return result;
  }
  return { validateRecap, OPTIONAL_HOLE_FIELDS };
});
