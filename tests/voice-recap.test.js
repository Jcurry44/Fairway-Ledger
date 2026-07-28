const test = require("node:test");
const assert = require("node:assert/strict");
const Recap = require("../lib/voice-recap.js");
const Shapes = require("../lib/shapes.js");

const deerwood = {
  id: "deerwood-july-28",
  createdAt: "2026-07-28T20:00:00Z",
  round: { date: "2026-07-28", courseId: "deerwood-buck-doe-white", tee: "White", holes: [{ number: 1, par: 4, score: 5 }] },
  recap: { summary: "A full Deerwood recap.", coaching: ["Keep the tee ball in play."], holeNarration: [{ holeNumber: 1, label: "Buck 1", narration: "Missed left but recovered for bogey.", coaching: "Commit to the target." }] }
};

test("rich voice drafts preserve narration and coaching instead of collapsing to scores", () => {
  const draft = Recap.normalizeDraft(deerwood);
  assert.equal(draft.recap.holeNarration[0].narration, "Missed left but recovered for bogey.");
  assert.equal(draft.recap.holeNarration[0].coaching, "Commit to the target.");
  assert.equal(draft.round.holes[0].note, "Missed left but recovered for bogey.");
  assert.equal(Recap.validateDraft(draft).valid, true);
});

test("score-only voice payloads are rejected", () => {
  const result = Recap.validateDraft({ ...deerwood, recap: {} });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /score-only/i);
});

test("applying a draft creates a new canonical round and retains the reviewed recap", () => {
  const round = Recap.toAppliedRound(deerwood, Shapes.makeRound, () => "new-round");
  assert.equal(round.id, "new-round");
  assert.equal(round.voiceRecap.draftId, "deerwood-july-28");
  assert.equal(round.holes[0].note, "Missed left but recovered for bogey.");
});
