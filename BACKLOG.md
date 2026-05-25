# Fairway Ledger — Backlog

*Living doc of ideas, feedback, and to-dos that haven't been picked up yet.
Captured in full detail so they survive context resets. Each entry has the
original prompt/thought + my take + a rough effort estimate.*

Last updated: 2026-05-25 (session captured Rob's feedback batch)

---

## Pending — picked up later

### 1. Investigate heatmap "weird numbers" bug 🐛

**Reported**: User noticed rounds pooled in the heatmap were showing weird
numbers. No specifics shared yet.

**Suspects** (in order of probability):
1. Malformed Deerwood labels (e.g. "buck1" without the space breaking the
   `physicalHoleId` regex)
2. A 9-hole round being averaged differently than the 18-hole rounds on the
   same physical hole
3. Scoring distribution that should be par-relative on a hole where the
   user has never broken par (so the cell looks all-red even though they
   play it fine — already addressed by the heatmap "relative coloring"
   change but may need verification)
4. The new Red tee Deerwood entries may be triggering an edge case where
   the same physical hole exists at 3 tee variants and rollup math
   double-counts

**Next step**: ask user for ONE specific weird heatmap cell (which hole,
what it shows vs what they'd expect). 2-minute diagnosis from there.

**Effort**: 30 min to diagnose, 1-2 hours to fix once root cause is known.

---

### 2. Allow multiple uses of the same club on a hole 🛠️

**Reported (Rob via user)**: "There are way too many times I have to hit my
wedge multiple times, but right now no way to select that."

**My take**: Required for data accuracy. Should be done BEFORE the
"best-scoring club" recommendation (item 6) because that math wants
accurate per-club counts.

**Implementation**:
- `clubsHit` is already an array; just allow duplicates instead of
  deduplicating on selection
- UI: tapping a club twice (or a "+1" button) increments its count for
  that hole
- Display as `Driver · 7i · PW × 3` in the breakdown
- Migration: existing data is unchanged (arrays already without
  duplicates)

**Effort**: 1-2 hours.

---

### 3. Default tee club to your most-used club on this physical hole 💡

**Reported (Rob via user)**: "On Fawn 2 if I've used a hybrid 4 times, a
driver 5 times, and a 6 iron 8 times it would default to 6 iron."

**My take**: Immediate UX win. Stops the "Driver → undo → 6i" tap dance
every round. The data is already there.

**Implementation**:
- On hole load, look up `clubsHit[0]` across rounds where
  `physicalHoleId(courseId, hole) === thisHoleId`
- Pick the mode (most frequent value)
- Fall back to Driver if no history exists (or <3 plays on this hole)
- Set as the pre-selected tee club in pending state

**Effort**: 1-2 hours.

---

### 4. Card view scorecard flow reorder (tee → forward) 🎯

**Reported (Rob via user)**: "He would like the flow on the scorecard more
to start with like tee shot club, then next shot, etc... He said the
current set up makes it seem kind of backwards."

**My take**: Rob's right. Current order is outcome-first (score, putts,
FIR, GIR, clubs). Reorder to match how you experience the hole:

1. Tee shot — what club?
2. Approach / subsequent shots — what clubs?
3. Result on the green — GIR? bunker?
4. Putts (+ first-putt distance)
5. Penalty (if any)
6. Final score

Reordering makes round entry feel like *narrating the hole as you played
it*, not like filling out an exit survey.

**Implementation**:
- Reorder the form sections inside `card-row` / `card-shots-block` etc.
  in the renderCardForHole function
- Score becomes the last field (anchors the entry)
- Putts can stay second-to-last
- GIR may become auto-derived ("clubs hit on green = GIR") rather than a
  separate input

**Effort**: 2-3 hours of careful card-view UX work.

**Risk**: changes a familiar workflow. May want to ship behind a toggle.

---

### 5. League play tag 🏷️

**Reported (user)**: "Maybe like a league play selector as well? Might be
cool to know how I average in a league vs normal play."

**My take**: Easy and useful. A free-form `round.tag` field with chip
selection (League / Casual / Tournament / Practice) plus filter chips on
home stats to slice by tag.

**Implementation**:
- Add `tag` field to round shape (`lib/shapes.js`)
- Chip row in round-setup form: League · Casual · Tournament · Practice
  (multi-select OK, or single)
- Filter chip in the home filter sheet
- All stat panels respect the active tag filter

**Effort**: 1-2 hours.

---

### 6. Best-scoring club recommendation 🎓

**Reported (Rob via user)**: "Maybe for holes like that where there are a
bunch of different clubs used the app could give a recommendation based
on what you have scored the best with. I think we would need a certain
amount of data before giving recommendation though."

**My take**: This is the kind of insight that would feel like the app is
*actually helping you play better*, not just tracking. Threshold matters
— below ~3-4 uses of each club, the signal is noise.

**Implementation**:
- Threshold: ≥2 different clubs used on this hole, ≥3 plays each
- Compare avg score-to-par per club
- Only show recommendation if the gap is ≥0.4 strokes
- UI: small inline hint above the tee-club chip row:
  *"You've scored best with the 6i here (+0.2 avg, 8 plays) vs your usual
  Driver (+1.1 avg, 5 plays)."*
- Should respect the default tee club (item 3) — if the recommendation
  matches the default, no point showing it

**Effort**: 3-4 hours.

**Depends on**: item 2 (multi-use clubs for accuracy).

---

### 7. Trophy room / record book 🏆

**Reported (user)**: "I think it would be cool to have like a trophy
room/record book type thing that has some of your coolest stats."

**My take**: Love it. The missing motivational layer.

**Stats to track** (initial set):
- Lowest 18-hole gross
- Lowest 18-hole to-par
- Lowest 9-hole gross / 9-hole to-par
- Most birdies in a round
- Most pars in a round
- Most pars in a row (across rounds; streak)
- Most birdies in a row (streak)
- Longest streak without a 3-putt
- Best scoring 3-hole stretch (lowest cumulative to-par)
- Best scoring 9-hole stretch
- Most fairways hit in a round
- Most GIRs in a round
- Lowest putts in a round
- Hole-in-one count
- "First time you broke 90 / 85 / 80" — the milestone bands
- Best round on each physical course

**UI**: new section on Home (under "Spotlight" or its own panel), or
its own top-level tab. Display as a card grid with the record + the
round/date that set it. Tap a record to drill to that round.

**Effort**: 4-6 hours. The streak math (across rounds, dropping when a
non-par lands) is the trickier bit but well-bounded.

---

### 8. Stats Explorer — canned queries (Phase 1) 🔍

**Reported (user)**: "Really the ability to query every single one of
your rounds."

**My take**: Dream feature. Split in two phases — start with canned
queries which is safe, simple, free.

**Phase 1: pre-built queries** (this item)

A "Stats Explorer" tab with 8-12 buttons. Each runs a small JS function
over `state.rounds` and renders the result. Initial set:

- Rounds with ≥8 pars · count + avg score
- Rounds without a triple+ · count + avg score (and how much that beats
  your normal)
- Penalty-free rounds · count + avg score
- Average score by month / day of week
- Best 3-hole stretch ever (with date + course)
- Same-course progression (first 5 rounds vs last 5 at any given
  physical course)
- "How much better do I shoot when X" where X is one of: no triples, no
  3-putts, fairway hit on hole 1, etc.
- Rounds with ≥3 birdies
- Best month / worst month
- Average gross by weather/wind condition

Each query result is rendered as a small data card with the headline
number + a one-line context.

**Effort**: 3-4 hours.

---

### 9. Stats Explorer — natural-language query (Phase 2) 🤖

**Reported (user)**: "How much better do I shoot when I avoid having a
triple bogey or worse" — they want free-form questions.

**My take**: Doable but bigger. Same pattern as the Order Up
ingestion spike: small API call where the LLM translates the question
into a JS query, we run it locally, render the result.

**Implementation**:
- Settings-gated (requires API key)
- Free-form text input
- LLM prompt: given the user's `state.rounds` schema, translate the
  question into a JS expression that runs over rounds and returns a
  result object
- Render the result with a one-line context
- Cost: ~$0.02 per question

**Effort**: 2-3 hours after Phase 1 is shipped.

**Depends on**: item 8 (Phase 1 establishes the result-rendering UI).

---

## Recommended sequencing

Most user value per hour, in order:

| # | Item | Effort | Why this position |
|---|---|---|---|
| 1 | Heatmap bug | 30m–2h | Quality issue. Don't ship anything new until known. |
| 2 | Multi-use clubs | 1-2h | Data accuracy. Blocks recommendations. |
| 3 | Default to most-used tee club | 1-2h | Instant UX win for wife/dad. |
| 4 | Card flow reorder | 2-3h | Better mental model. May ship behind a toggle. |
| 5 | League play tag | 1-2h | Easy + useful. |
| 6 | Best-scoring club hint | 3-4h | The "this app is helping me play better" moment. |
| 7 | Trophy room | 4-6h | Motivational layer. |
| 8 | Stats Explorer Phase 1 | 3-4h | Foundation for query feature. |
| 9 | Stats Explorer Phase 2 (NLP) | 2-3h | Cherry on top. |

**Total**: roughly 18-30 hours across 4-6 focused sessions.

---

## Notes for future sessions

- The user's wife and dad are starting to use the app. UX changes should
  be tested with that audience in mind — they're not the developer.
- "Make sure rounds are pooled correctly across tee variants" is a
  recurring theme. The `physicalHoleId` and `physicalCourseName` helpers
  in `lib/golf-math.js` and `app.js` are the canonical groupings — every
  new aggregation should use them.
- Default tee club, multi-use clubs, and best-scoring club hint form a
  coherent "smart tee club" sub-project. Worth doing together.
