# Fairway Ledger — Backlog

*Living doc of ideas, feedback, and to-dos. Captured in full detail so they
survive context resets. Each entry has the original prompt/thought + my
take + a rough effort estimate.*

Last updated: 2026-07-21 (convenience + settle-trust batch — see below)

---

## On branch `games-settle-oncourse-2026-07-21` (NOT pushed; ready to deploy)

Joe's ask: "using it less and less when I golf — not convenient enough…
better UI/UX, more premium. Also my wife said the quick score settling
wasn't working at all." Nine commits, verified in-browser + 187/187 tests:

1. `4d21d3a` **P0 settle fix** — match-style games (Match Play/Nassau/Best
   Ball) called before mathematical completion settled as "All square"
   (the wife's bug: 9 holes of a default-18 match = "Joe 9 UP" and
   "nobody owes anything" on one screen). Early finishes now pay the
   leader with an honest "Called early" note. +7 engine tests.
2. `52072b7` **Score-first hole cards** — SCORE led-from-bottom → top in
   both flow modes (it sat below 23 club chips + GPS + 7 rows; narrative
   default since 2026-05-26 tracks the usage decline).
3. `c4c617f` **Auto-resume + guarded discard** — <12h drafts restore with
   no dialog onto the first unscored hole; the old confirm's Cancel
   DISCARDED the round (P0 data-loss trap); Reset now routes through the
   destructive-confirm sheet; drafts carry entry mode.
4. `5dc6c26` **"Play it again" card** — one tap replays last round's
   course/nines/tee and starts scoring.
5. `fb93def` **P0 SW rework** — stale-while-revalidate assets (instant
   launch on weak LTE), 2.5s-capped navigations, VERSIONED precache
   (query-less entries used to strand offline phones on stale bundles
   forever), fonts non-blocking, busters unified to ASSET_VERSION.
6. `ca4b467` **Deploy-consistency test gate** — every index.html ?v= must
   equal sw.js ASSET_VERSION or the suite fails.
7. `93fe650` **Settle-trust pack** — stake can't be silently lost (text
   input + forgiving parse + blocking toast), stake add/edit ON the
   settle screen (finals too), per-player entered counts ("Joe 3 ·
   Kate 0"), honest zero/uneven-entry messages for every game type,
   Reopen for confirmed finals, wolf pick required for hole completion.
8. `ce4d073` **On-course ergonomics** — fixed bottom tab bar on phones,
   44px pills, speed-mode auto-advance on score tap, screen wake lock.
9. `1a0ca53` **Games premium pass** — settle-up payoff hero + brass
   transfer rows, hole-entry card material, home-card parity, grid
   de-spreadsheet, 160ms card-settle.

**Deploy notes:** cache buster = `2026-07-21b` / SW `v87`. After push,
each phone needs ONE online open to pick up the new SW (skipWaiting+claim)
— until then old clients still run the pre-fix bundle.

**Audit leftovers (confirmed real, not yet done, in priority order):**
- Scramble setup: tapping a team-count chip re-renders and wipes typed
  names + stake (harvest inputs into gamesUi before renderGames).
- needsPar games (Vegas/Stableford/Scramble): every hole seeds par 4 and
  a never-touched par row silently settles wrong money — create with
  par:null, require par for completeness.
- saveGamesState swallows storage failures silently (games are ALSO
  excluded from snapshots + export — no safety net; surface a toast +
  retry like takeSnapshot's quota prune).
- Stableford uneven-entry money (warning shipped; decide whether to gate
  on holeComplete instead).
- Round↔game single-entry: auto-push player-1 scores from the live round
  draft into the active game (pull chip is one-way/per-hole today);
  bigger version = linked games (design in audit output).
- Detailed-card "Details" disclosure (GPS/1st putt/bunker/pen-club/note
  collapsed per hole), warm-token alignment on Add Round card, Profile
  panel merge, pace-vs-your-average line (computePaceVsSelf in
  lib/golf-math.js), 18-hole auto-advance for detailed mode once the
  disclosure exists.

---

## On branch `ui-premium-2026-07` (2026-07-06 — NOT pushed; review first)

Jeff's ask: "improve the UI/design into something that feels as premium as
Icenomics." Identity kept (cream / masters green / brass / Fraunces);
craft raised. Three commits, one per item:

1. **Overview tone layer** (`c339abc`) — insight cards carry accent bars +
   tinted washes by meaning (form judged by TREND, never level — no red
   walls on a scorecard); metric tiles gain last-5-vs-prior-5 trend ticks
   (shown only when both windows have 3+ rounds); Best round is the gold
   trophy tile; the Handicap dark void became an honest dashed "Building"
   card that says how to unlock it.
2. **P0 delete-confirm** (`5963f08`) — Recent Scorecards' Delete was a
   single-tap instant delete (no confirm, one thumb from View, in a
   localStorage-only app). Now routes through the existing destructive-
   confirm modal with the round's facts AND takes a snapshot first
   (restorable via Profile › Backups).
3. **Scorecard rows** (`beb0964`) — tone-coded score badges lead each row
   (gold = personal best w/ label, green = beat your average by X, neutral
   otherwise), human dates, chip separators, Delete recedes to quiet text.

Verified: desktop + 375px, no horizontal scroll, sample-data walkthrough,
delete cancel/confirm/snapshot loop.

**Next candidates for the same pass (in order):** Add Round flow (the money
surface — hole entry ergonomics), Trends tab charts (apply the gridline +
tone language), Courses/Games/Profile consistency sweep, and the
`wip-country-club-2026-07-06` branch holds a prior session's uncommitted
country-club/TV experiments (preserved verbatim — review before building on
main).

---

## Shipped

The autonomous batch (items 1–8) and three bugfix passes are live on
`main` and deployed to https://jcurry44.github.io/Fairway-Ledger/. Last
commit on main: `fd7bcad`. See `git log` for the per-feature breakdown —
each commit message includes the originating user quote and the change
scope.

---

## On branch `narrative-and-insights` (NOT yet pushed — review first)

Pre-modular backup tag: `pre-modular-snapshot` (points at the commit just
before any modular work started — `git reset --hard pre-modular-snapshot`
puts us back to that exact tree if anything goes wrong).

### Smarter round narrative

**User quote**: "I feel like the summary should be smarter. Like the one
round I played the par 5's -3. Thats something that should have definitely
been shouted out."

**Shipped on branch (commit `7290b57`)**:
- New `computeTypicalParTypeScoring(currentRound, allRounds)` — establishes
  a per-par-type baseline from ≥3 prior same-length rounds with ≥6 holes
  per par bucket
- New `buildNarrativeParTypes` — surfaces par-type wins/losses, leads with
  any par type that went ≥-3 across the round (the "par 5s carried it"
  insight), then adds 1 best + 1 worst vs typical (threshold ±1.5 strokes
  to avoid noise)
- New `buildNarrativeBestStretch` — walks consecutive 3-hole windows for
  best/worst stretches
- `buildNarrativeHeadline` now does course-specific personal-best
  detection ("your best ever at Ridgeview Golf Club, previous best 83")
  before falling back to recent-form comparison

### Tier drill-down: multi-dimensional summary

**User quote**: "The distribution in holes is super cool, but I feel like
when you click into like birdies or pars it should be more of a heatmap
then show you every single hole that you have pard. There should be like
a heatmap, summary view that shows like birdies on par 5's, 4's, 3s. By
course maybe, which holes you have birdied the most."

**Shipped on branch (commit `04ced5d`)**:
- Tapping a scoring tier (Birdies, Pars, Doubles, etc) now opens a
  breakdown view, not a flat hole list
- Top line: overall rate ("12 birdies across 247 tracked holes, 4.9%")
- By par type: count + how many distinct holes ("8 birdies on 5 different
  par 5s")
- By course (pooled via `physicalCourseName` so tee variants merge)
- Holes you tier'd the most — top 5, with play-counts when available
  ("Ridgeview · #7 · Par 5 — 3 birdies in 11 plays"), only shown if at
  least one hole has ≥2 entries
- Recent trend: last 5 rounds count vs prior 5, with ↗/↘/→ arrow
- The original flat hole list still exists at the bottom inside a
  collapsed `<details>` so you can drill into every single hole

### Architecture roadmap (Task #37 — modular split groundwork)

**User quote**: "if you have time which you should as I will be gone quite
a while maybe start working on making this modular?"

**Shipped on branch**:
- `pre-modular-snapshot` git tag captures the exact pre-modular state for
  a one-command rollback if needed
- TOC comment block added to the top of `app.js` listing every major
  section with approximate line ranges
- New `ARCHITECTURE.md` documents:
  - The no-build PWA model and the working modular pattern
    (`lib/golf-math.js`, `lib/shapes.js`)
  - Why we haven't split `app.js` yet (data-safety risk, no UI tests)
  - Section map with per-seam purity + extraction blockers
  - Suggested extraction order (narrative → insights → course-pooling →
    snapshots → heatmap aggregator)
  - Constraints to preserve (IIFE, sw.js core assets, cache-buster
    discipline, snapshot path is P0)
  - Step-by-step playbook for the first real extraction (narrative.js)

**Deliberately NOT shipped on this branch**: any actual code extraction.
Doing it without browser-verification would risk the snapshot/auto-export
path, which is P0 per the data-safety memory. The roadmap is set up so
the next session can do step 1 (narrative.js) cleanly and incrementally.

### Verification checklist (do these before pushing the branch)

- [ ] All 86 Node tests pass: `node --test tests/golf-math.test.js tests/shapes.test.js`
- [ ] Boot the app locally, open a round with ≥3 prior same-length rounds,
      confirm the narrative still renders and now mentions par-type
      performance when relevant
- [ ] Tap a tier on Scoring Distribution (Birdies if you have ≥1), confirm
      the new breakdown view renders and the disclosure for the flat list
      works
- [ ] Cache buster bumped to `v=2026-06-05a` (verified in `index.html` +
      `sw.js` CACHE_VERSION = `fairway-ledger-v64-2026-06-05a`)
- [ ] No console errors in the browser
- [ ] `git diff main..narrative-and-insights` looks like only the changes
      above — no surprise edits

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

**Depends on**: item 8 (already shipped).

---

### 10. Garmin Connect round import 🔗

**Reported (user via brother, 2026-05-26)**: "My brother uses Garmin
for his distances and clubs etc... Is there any way to integrate his
data into the app for him?"

**My take**: Genuinely doable, but only via file-import (Path A below).
Auto-sync via Garmin's API isn't realistic for a static PWA — would
need a backend for OAuth tokens, and Garmin's golf API is
partner-only access last I checked.

**Recommended path — Garmin Connect file import**:
- User exports a round from Garmin Connect (web → Activities → round
  → ⋮ menu → Export as CSV / TCX / GPX / FIT)
- Fairway Ledger gets an **Import from Garmin** option (header dropdown
  next to Export / Import / Sample data)
- Parser reads the file, maps Garmin fields → our `Round`/`Hole` shape
  via the canonical builders in `lib/shapes.js`
- Routes through the same `normalizeRound` pipeline as JSON import
- Pre-fills the round-entry form for review before saving (so the
  user can confirm course matching, fix anything Garmin got wrong)
- Course matching: Garmin uses its own course IDs that don't match our
  catalog. Implementation needs a fuzzy-match prompt: "Garmin says
  'Ridgeview Golf Course' — match to: Ridgeview Golf Club (Blue) ▼"
  with the option to add as a new course if no match.

**What's NOT in scope for v1**:
- Auto-sync (would need a server — see "Why not API" below)
- Per-shot location data (Garmin's TCX has it; we'd capture clubsHit
  and per-hole stats, store the raw shot list as a passthrough field
  for future use)
- Bulk-import of round history (start with one-at-a-time; bulk is a
  follow-up once parser is solid)

**Why not the Garmin API**:
- Requires Garmin developer account + golf endpoints approval (their
  public API is fitness-only as of last check; golf data is in a
  partner program)
- OAuth tokens need a server to hold them — Fairway Ledger is
  intentionally a static PWA with zero backend, would mean recurring
  infra cost
- Realistically beyond a personal-app project; the file-import path
  delivers 90% of the value with 0% of the infra

**Risks / unknowns**:
- CSV format varies by Garmin product (S40 vs S62 vs R10 etc) — need
  sample files to write a robust parser. **BLOCKING**: don't start
  coding until brother has shared at least one actual export file.
- Garmin's per-shot club tagging accuracy varies — sometimes "Driver"
  is right, sometimes it's "Club 1" because the user didn't configure
  the bag in Garmin Connect. Parser should be permissive and let the
  user fix per-hole if needed.
- If brother uses Garmin's email-summary feature instead of an export,
  that's not a clean format and shouldn't be supported.

**Effort estimate** (post-sample-data):
- CSV-only parser, single round at a time, with course-match prompt:
  6–8 hours
- Add TCX (XML) support with per-shot club data: +3-4 hours
- Bulk import (history dump): +2-3 hours

**Simpler alternative if Jeff wants to skip the build**:
Brother keeps Garmin for on-course distances/clubs, enters scores
manually in Fairway Ledger after the round (~2 min for 18 with the
card view). He gets the analytics layer (Trophy Room, best-scoring
club hint, etc) on top without a parser dependency.

**Next action**: Wait for brother to share a CSV export of one of
his rounds. Then I'll inspect the actual fields and give a concrete
parser scope.

---

## Notes for future sessions

- The user's wife and dad are starting to use the app. UX changes should
  be tested with that audience in mind — they're not the developer.
- The `physicalHoleId` and `physicalCourseName` helpers in
  `lib/golf-math.js` and `app.js` are the canonical groupings — every
  new aggregation should use them. With the heatmap pooling fix
  shipped, Deerwood pooling finally works correctly across tee variants.
- The "smart tee club" sub-project (multi-use clubs + default tee club
  + best-scoring rec) now ships as one coherent UX: club pills support
  multi-use, freshly opened holes pre-seed your most-used club from
  history, and a recommendation hint flags holes where a different
  club has scored better.
- "Open a round" entry points all converge on the round-detail sheet
  (Trophy card tap, Recent Scorecards View button). Edit is the
  secondary action inside the sheet, never the default behavior.
- Any new "open a round" affordance should use `showRoundDetail(round)`
  for consistency.
- ALL avg-gross math MUST restrict to 18-hole rounds (`has18` in the
  compute functions). Mixing 9 and 18 gross silently misrepresents
  results. Hole-level counts / streaks can mix safely.
