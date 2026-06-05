# Fairway Ledger — architecture & modular-split roadmap

## Current shape

Fairway Ledger is a static browser PWA with **no build step**. Every file is
loaded by the browser exactly as it sits in the repo. That constraint shapes
the whole architecture.

```
index.html
  ├─ <script src="data/courses.js">        ── global: COURSES
  ├─ <script src="lib/golf-math.js">       ── global: window.GolfMath
  ├─ <script src="lib/shapes.js">          ── global: window.GolfShapes
  └─ <script src="app.js">                 ── one IIFE; binds the above into scope
sw.js  ── service worker, precaches the shell, network-first at runtime
```

### The modular pattern that already exists

`lib/golf-math.js` and `lib/shapes.js` show the working pattern for a
no-build modular split:

1. The file wraps its body in `(function () { ... })()` and exports a small
   API via `window.X = { … }` at the end.
2. `app.js` destructures that API into local consts at the top.
3. Node tests (`node --test tests/*.js`) require the file with a tiny
   `window`-shim header.

Anything we extract should follow this exact pattern.

## Why we haven't split app.js yet

`app.js` is ~8800 lines as of 2026-06-05. Most of it touches the DOM, the
in-memory `state`, or `localStorage` — i.e. it isn't pure. A premature split
risks:

* races on `state` between modules
* duplicate event-listener registration
* breaking the snapshot/auto-export safety net (P0 — user is terrified of
  losing rounds)

So the rule is: **only extract code that is genuinely pure** (no DOM, no
shared mutable state). Everything else stays in `app.js` until we have
either browser test coverage OR enough refactor budget to thread state
explicitly.

## Section map (the seams)

The TOC comment at the top of `app.js` lists every `// ---- Title ----`
separator. The table below adds, for each seam, **how hard it would be to
extract** and **what blocks it**.

| Seam | Purity | Block to extraction |
|---|---|---|
| Per-hole pending state | impure | reads/writes shared `pendingHole` |
| Notes | impure | DOM (textarea) |
| Clubs hit | impure | DOM + `pendingHole.clubsHit` |
| Penalty clubs | impure | DOM + `pendingHole.penaltyClubs` |
| Snapshot system | mostly pure | localStorage I/O is the only side-effect; could move to `lib/snapshots.js` with passed-in storage |
| Physical course grouping | **pure** | needs the COURSES array as input |
| Chip-style form selectors | impure | DOM-bound |
| Start Round flow | impure | DOM + state |
| Par-type drill-down sheet | impure | DOM rendering |
| Heatmap | mixed | aggregation pure, rendering impure |
| Drill-down sheet | impure | DOM |
| Scoring distribution + bucket sheet | mixed | `computeScoringDistribution`, `computeBucketBreakdown`, `computePlayCountByPhysicalHole` are pure given inputs; rendering is impure |
| **Narrative builders** | **pure** | `computeTypicalParTypeScoring`, `buildNarrativeParTypes`, `buildNarrativeBestStretch` are pure given `(round, validHoles, allRounds)`. `buildNarrativeHeadline` uses `physicalCourseName` (pure, lives at line ~1545). |
| Reflection survey paragraph | mixed | mostly pure string assembly |
| Trophy Room | impure | DOM-heavy |
| Stats Explorer | impure | hidden right now anyway |
| Destructive-confirmation modal | impure | DOM + handlers |
| Snapshot restore panel | impure | DOM |
| Round detail sheet | impure | DOM |

## Suggested incremental extraction order

The goal is to get to a state where `app.js` is "the DOM/state layer" and
everything else is a tested pure module. Do these in order; each step is
independently shippable and tests cover the boundary.

1. **`lib/narrative.js`** — extract the four pure narrative builders. They
   only depend on `average`, `formatSigned`, `roundTotals`, and
   `physicalCourseName`. Easiest first move; adds insight tests.
2. **`lib/insights.js`** — extract `computeScoringDistribution`,
   `computeBucketBreakdown`, `computePlayCountByPhysicalHole`. Take
   `courses`/`coursesById` as a parameter instead of closure access.
3. **`lib/course-pooling.js`** — extract `physicalCourseName` + helpers.
   Tiny module but used widely; a clean test seam.
4. **`lib/snapshots.js`** — move the rolling-backup engine, injecting
   `localStorage` (so tests can pass a fake). Big safety win: snapshot
   logic gets real coverage instead of being only manually verified.
5. **`lib/heatmap.js`** (just the aggregator) — extract the pure
   per-cell aggregation; rendering stays in `app.js`.

Stop here for the first pass. The remaining seams are DOM-bound and not
worth extracting until we add a real UI test harness.

## Constraints (do not break)

- **IIFE must stay.** All globals from `lib/` go on `window` and get
  destructured at the top of the IIFE. No ES modules — the file:// fallback
  and the precached SW model would break.
- **`sw.js` CORE_ASSETS must list every new `lib/` file** added to the page,
  or offline boot fails.
- **`index.html` cache-buster (`?v=YYYY-MM-DDx`) must be bumped on every
  user-visible change** AND `sw.js` `CACHE_VERSION` must move with it.
- **Snapshot/auto-export paths are P0.** The user is terrified of losing
  rounds. Any refactor that touches those paths needs a manual smoke test
  before push.
- **Tests live in `tests/`** and run via `node --test tests/*.test.js`.
  Every new `lib/` module needs a sibling `tests/<name>.test.js`.

## How to actually do step 1 (narrative extraction)

When the time comes (next session, with browser to verify):

1. Create `lib/narrative.js` mirroring the shape of `lib/golf-math.js`
   (IIFE → `window.GolfNarrative = { ... }`).
2. Copy `computeTypicalParTypeScoring`, `buildNarrativeParTypes`,
   `buildNarrativeBestStretch` verbatim. Their dependencies (`average`,
   `formatSigned`) come from `window.GolfMath`, so the lib file can require
   `window.GolfMath` itself.
3. Leave `buildNarrativeHeadline` and `buildNarrativeStory` in `app.js` for
   now — they touch `physicalCourseName` (closure-bound) and orchestrate
   the others.
4. In `app.js`, replace the three function definitions with destructuring
   from `window.GolfNarrative`.
5. Add `lib/narrative.js` to `index.html` (between golf-math and shapes)
   AND to `sw.js` `CORE_ASSETS`. Bump cache buster + `CACHE_VERSION`.
6. Add `tests/narrative.test.js` with at least: thin-history fallback,
   par-5-carried-the-round headline, par-3s-cost-you worst case,
   best-stretch detection.
7. Run `node --test tests/*.test.js`. Boot the app locally and tap into a
   round with ≥3 prior rounds to verify the narrative still renders.
8. Commit on a branch, get user review before merging.

Apply the same playbook for steps 2-5.
