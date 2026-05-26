# Fairway Ledger — Backlog

*Living doc of ideas, feedback, and to-dos. Captured in full detail so they
survive context resets. Each entry has the original prompt/thought + my
take + a rough effort estimate.*

Last updated: 2026-05-26 (autonomous batch — items #1–#8 shipped on
branch `backlog-batch`, awaiting Jeff's review before merge to main)

---

## Shipped on `backlog-batch` (awaiting review)

| # | Item | Commit |
|---|---|---|
| 1 | Heatmap "weird numbers" bug — Deerwood label pooling | `7b3d233` |
| 2 | Multi-use clubs on a hole (tap to bump, ×N badge, cap 5) | `496b2f5` |
| 3 | Default tee club to most-used on this physical hole | `3ff5479` |
| 4 | Card flow reorder behind off-by-default Profile toggle | `2967069` |
| 5 | League play tag (round.tag + filter + badge) | `a4afd05` |
| 6 | Best-scoring club recommendation hint | `b3953ff` |
| 7 | Trophy Room — Home → Records, 12 record types | `fa6d5d8` |
| 8 | Stats Explorer Phase 1 — pre-built query cards | `489afe1` |

To review locally:
```
git checkout backlog-batch
# open Golf Stats Tracker/index.html or run any static server
```

To merge: `git checkout main && git merge backlog-batch` then push.

To cherry-pick a subset: `git cherry-pick <commit>` from main.

---

## Not yet picked up

### 9. Stats Explorer — natural-language query (Phase 2) 🤖

**Reported (user)**: "How much better do I shoot when I avoid having a
triple bogey or worse" — they want free-form questions.

**My take**: Same pattern as the Order Up ingestion spike: small API
call where the LLM translates the question into a JS query, we run it
locally, render the result.

**Implementation**:
- Settings-gated (requires API key)
- Free-form text input
- LLM prompt: given the user's `state.rounds` schema, translate the
  question into a JS expression that runs over rounds and returns a
  result object
- Render the result with a one-line context (reuses Phase 1's card
  rendering, which is already in place after #8)
- Cost: ~$0.02 per question

**Effort**: 2-3 hours after we sort out API key sourcing and a
spend ceiling.

**Depends on**: item 8 (already shipped on `backlog-batch`).

---

## Notes for future sessions

- The user's wife and dad are starting to use the app. UX changes should
  be tested with that audience in mind — they're not the developer.
- The `physicalHoleId` and `physicalCourseName` helpers in
  `lib/golf-math.js` and `app.js` are the canonical groupings — every
  new aggregation should use them. With #1 shipped, Deerwood pooling
  finally works correctly across tee variants.
- The "smart tee club" sub-project (items #2, #3, #6) now ships as one
  coherent UX: club pills support multi-use, freshly opened holes
  pre-seed your most-used club from history, and a recommendation hint
  flags holes where a different club has scored better.
