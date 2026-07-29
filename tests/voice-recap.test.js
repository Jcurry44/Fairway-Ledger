const test = require("node:test");
const assert = require("node:assert/strict");
const Recap = require("../lib/voice-recap.js");
const { validateRecap, encodeVoiceRecapFragment, decodeVoiceRecapFragment, voiceRecapNeedsFreshStoreConfirmation } = Recap;
const Shapes = require("../lib/shapes.js");
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
test("fresh storage requires an explicit confirmation before a linked recap saves", () => {
  assert.equal(voiceRecapNeedsFreshStoreConfirmation(0), true);
  assert.equal(voiceRecapNeedsFreshStoreConfirmation(12), false);
});
test("preserves detailed narrated hole context without inventing missing stats", () => {
  const recap = validateRecap({ date: "2026-07-28", holes: [{ score: 5, teeClub: "Driver", approachNote: "8i from 145 to the middle", result: "two-putt bogey", missContext: "tee shot right" }, { score: 3 }] }, course);
  assert.equal(recap.holes[0].teeClub, "Driver");
  assert.deepEqual(recap.holes[0].clubsHit, ["Driver"]);
  assert.equal(recap.holes[0].voiceKnown.putts, false);
  assert.equal(recap.holes[1].voiceKnown.teeClub, false);
});
test("preserves player-reported coaching context separately from scored evidence", () => {
  const recap = validateRecap({ date: "2026-07-28", coaching: { story: "Played better than the score.", pattern: "Open-face protection created push-slices.", nextRoundCue: "Square setup, stock swing.", strengths: ["3-wood"], practicePlan: ["Start-line routine"] }, holes: [{ score: 5 }, { score: 3 }] }, course);
  assert.equal(recap.coaching.nextRoundCue, "Square setup, stock swing.");
  assert.deepEqual(recap.coaching.strengths, ["3-wood"]);
});

const deerwoodDraft = {
  id: "deerwood-july-28", createdAt: "2026-07-28T20:00:00Z",
  round: { date: "2026-07-28", courseId: "deerwood-buck-doe-white", tee: "White", holes: [{ number: 1, par: 4, score: 5 }] },
  recap: { summary: "A full Deerwood recap.", coaching: ["Keep the tee ball in play."], holeNarration: [{ holeNumber: 1, label: "Buck 1", narration: "Missed left but recovered for bogey.", coaching: "Commit to the target." }] }
};
test("shared drafts preserve narration and coaching instead of collapsing to scores", () => {
  const draft = Recap.normalizeDraft(deerwoodDraft);
  assert.equal(draft.recap.holeNarration[0].narration, "Missed left but recovered for bogey.");
  assert.equal(draft.round.holes[0].note, "Missed left but recovered for bogey.");
  assert.equal(Recap.validateDraft(draft).valid, true);
});
test("shared drafts reject score-only payloads", () => {
  const result = Recap.validateDraft({ ...deerwoodDraft, recap: {} });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /score-only/i);
});
test("applying a shared draft adds a canonical round and retains recap detail", () => {
  const round = Recap.toAppliedRound(deerwoodDraft, Shapes.makeRound, () => "new-round");
  assert.equal(round.id, "new-round");
  assert.equal(round.voiceRecap.draftId, "deerwood-july-28");
  assert.equal(round.holes[0].note, "Missed left but recovered for bogey.");
});
test("the app's course route, not the draft, is the authority on hole identity", () => {
  const route = { tee: "White", holes: [{ number: 1, label: "Buck 1", par: 4, yards: 377, hcp: 5 }] };
  const lyingDraft = { ...deerwoodDraft, round: { ...deerwoodDraft.round, tee: "white", holes: [{ number: 7, par: 3, yards: 120, score: 5, putts: 2 }] } };
  const round = Recap.toAppliedRound(lyingDraft, Shapes.makeRound, () => "merged-round", route);
  assert.equal(round.holes[0].number, 1);
  assert.equal(round.holes[0].label, "Buck 1");
  assert.equal(round.holes[0].par, 4);
  assert.equal(round.holes[0].yards, 377);
  assert.equal(round.holes[0].score, 5);
  assert.equal(round.holes[0].putts, 2);
  assert.equal(round.tee, "White");
});
test("a hole-count mismatch with the selected route refuses to apply", () => {
  const route = { tee: "White", holes: [{ number: 1, par: 4 }, { number: 2, par: 3 }] };
  assert.throws(() => Recap.toAppliedRound(deerwoodDraft, Shapes.makeRound, () => "x", route), /1 scored holes but the selected route has 2/);
});
