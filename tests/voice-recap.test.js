const test = require("node:test");
const assert = require("node:assert/strict");
const { validateRecap, encodeVoiceRecapFragment, decodeVoiceRecapFragment } = require("../lib/voice-recap.js");
const course = { holes: [{ number: 1, label: "Buck 1", par: 4 }, { number: 2, label: "Buck 2", par: 3 }] };
test("accepts a complete score-only recap and optional hole notes", () => {
  const recap = validateRecap({ date: "2026-07-28", note: "Good day", holes: [{ score: 5, note: "Lost one right" }, { score: 3, putts: 1 }] }, course);
  assert.equal(recap.holes[0].label, "Buck 1");
  assert.equal(recap.holes[1].putts, 1);
});
test("rejects wrong route length and invalid scores", () => {
  assert.throws(() => validateRecap({ date: "2026-07-28", holes: [{ score: 4 }] }, course), /exactly 2/);
  assert.throws(() => validateRecap({ date: "2026-07-28", holes: [{ score: 0 }, { score: 4 }] }, course), /score/);
});
test("round-trips a Unicode-safe fragment payload without a query string", () => {
  const recap = { date: "2026-07-28", note: "Doe felt great ⛳", holes: [{ score: 4 }] };
  const fragment = encodeVoiceRecapFragment(recap);
  assert.match(fragment, /^voice-recap=[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeVoiceRecapFragment(`#${fragment}`), recap);
});
test("rejects malformed or oversized voice recap fragments", () => {
  assert.throws(() => decodeVoiceRecapFragment("#voice-recap=***"), /malformed/);
  assert.throws(() => decodeVoiceRecapFragment(`#voice-recap=${"a".repeat(12000)}`), /too large/);
});
