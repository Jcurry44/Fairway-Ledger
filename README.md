# Fairway Ledger

A personal golf stats tracker. Static browser app, no build step, no server, no cloud — courses and rounds live in browser `localStorage`. Designed to be used on a phone during real rounds.

Live: `https://jcurry44.github.io/Fairway-Ledger/`

Open `index.html` locally to run it directly from the filesystem.

## Architecture

- **`index.html`** — single page, four tabs (Home / Add Round / Courses / Profile).
- **`app.js`** — ~5.7k lines, one IIFE. Handles UI rendering, state, persistence, event wiring.
- **`lib/golf-math.js`** — pure math (Strokes Gained, round totals, score classification, hole identity, handicap helpers, geo). Zero DOM/state. Imported in the browser as `window.GolfMath` and required in Node tests.
- **`lib/shapes.js`** — canonical `Round` and `Hole` field definitions. `makeRound` / `makeHole` / `normalizeRound` builders that every read/write path routes through, so adding a new per-hole field is a one-line change.
- **`data/courses.js`** — course catalog. 25 entries covering Deerwood Golf Course (per-nine, per-tee), Ridgeview, Lake County, and five Western New York courses (Arrowhead, Diamond Hawk, Glen Oak, Harvest Hill, Seneca Hickory Stick) including all their tee variants.
- **`sw.js`** — service worker (network-first with offline fallback). Whole app shell is precached so it works on a phone with zero signal.
- **`manifest.json` + `icon.svg`** — PWA manifest. Installs to home screen as a real-looking app with its own icon.

## Tests

```
node --test tests/golf-math.test.js tests/shapes.test.js
```

80 tests across the pure-math and canonical-shapes libs. No build step, no dependencies, just Node's built-in test runner.

The pure math runs both as a browser global (`window.GolfMath`, `window.GolfShapes`) and as a CommonJS module via the same UMD wrapper, so the tests `require()` the exact same code the browser runs.

## Home tab

A chip strip at the top swaps between four sections:

- **Overview** — KPI metrics (rounds, avg score, avg to-par, best round, GIR, SG, handicap) + auto-generated round summary narrative + key insights + Recent Scorecards.
- **Trends** — sub-chips for Trend chart, Handicap Calculator, and Strokes Gained.
- **Holes** — sub-chips for the **Heatmap** (the headline view), Scoring Distribution, Par 3/4/5, Scoring By Course, and Scoring By Nine (Deerwood).
- **Clubs** — sub-chips for Tee Club Performance and Putting by Distance.

The Heatmap is the killer view: a color-coded grid of every physical hole at the active course (green = under par, red = over par avg). Tap any hole to open a drill-down sheet with summary stats, scoring distribution, per-tee-club breakdown, recent rounds list, and per-hole notes.

Per-physical-course filtering throughout: Deerwood's six per-nine/tee catalog entries collapse to one "Deerwood" chip; Diamond Hawk's five tee variants collapse to one "Diamond Hawk" chip; etc. The unit of "a course" in the UI is the physical course, not the tee variant.

## Add Round

Setup form opens fully blank — no chip pre-selected anywhere. User taps Course, then Tee (auto-revealed for the course's available tees), then Deerwood-specific fields if relevant. Once required setup is satisfied, the big "Start Round →" button enables and reveals the scorecard.

Two scorecard views, persisted per user:

- **Card view** (default on phones ≤640px wide) — one hole per screen. Big tap targets, pill-based input (par-anchored Score row, Putts 0-5, Pen 0-3, fairway result, 1st-putt distance, clubs hit, per-hole note, GPS shot tracker). Prev/Next arrows + floating mid-screen arrows + bottom-sheet hole picker. Auto-collapses round setup once you're scoring.
- **Grid view** — all 18 holes at once, typed inputs. Desktop-friendly.

Switching views mid-round preserves all entered scores.

Auto-saved to `localStorage` every 500ms after any input. If you reload mid-round or your phone restarts, on next open you get prompted to resume.

## Per-hole inputs

Every input is captured per-hole for richest analytics later:

- **Score** + **Putts** (required)
- **GIR** (auto-derived from score + putts + par — not user input)
- **Fairway result** (Hit / Left / Right / Short / Long / Miss; hidden on par 3s where it's structurally meaningless)
- **Penalties** count
- **Penalty club** (appears when penalties ≥ 1; pre-fills to the tee club used)
- **1st putt distance** (pill row: 3 / 6 / 10 / 15 / 20 / 30 / 50 ft + custom)
- **Clubs hit** — multi-select pill grid. First club tapped is the tee shot (gold "TEE" badge). Putter auto-added when putts ≥ 1. Default seeds for par 3/4/5 use the player's bag.
- **Per-hole note** — narrative text, iOS voice dictation works via the keyboard mic.
- **GPS shots** — tap to mark starting position, tap again to mark each shot's end; Haversine distance per shot, per-club tagging.

All fields visible inline on every card (no hide-behind-toggle gimmicks — the point of the app is data completeness).

## Round-level inputs

- Date (defaults to today)
- Wind (Calm / 5 / 10 / 15 / 20 / 25 / 30+ mph)
- Round summary textarea — free-form reflection on the round, prominently placed in the post-round Review section
- Auto-generated 2-4 sentence coach-style **round narrative** that opens with score vs. recent form, calls out a dominant theme (penalties / three-putts / hot putter / leak hole / clean back nine), and closes with a counterfactual ("Without your three worst holes you'd have shot 77")

## Analytics

- **Strokes Gained** vs. PGA Tour benchmark, broken down per hole and by par type. Surfaced on the live scorecard, par-type bars, drill-down sheets, and a dedicated SG panel with trend chart. Tour benchmark labeled honestly: pros average 70-71, scratch is 73-74, so amateur SG against tour skews more negative than against true scratch.
- **Handicap Index** estimate using WHS-style score differentials for rated 18-hole rounds. 9-hole rounds feed an expected-differential approximation.
- **Putting by Distance** — make % by bucket (Inside 3 ft / 3-6 / 6-10 / 10-20 / 20+), with three-jack count.
- **Tee Club Performance** — avg score-to-par + avg SG by tee club (Driver vs 3W vs Hybrid vs Iron), with per-par-type breakdown and a "best avg" flag when there's a meaningful comparison.
- **Penalty Clubs** — strokes lost per club. Surfaces the quiet costers (often the driver).
- **Pre-round brief** — when you select a course you have 2+ rounds at, a collapsible panel above the scorecard surfaces your round count, averages, recent rounds, top 3 leak/strength holes (with most recent per-hole note inline), a counterfactual, and hazards per hole.

## Deerwood specifics

- 27 holes split into three named nines: Buck / Doe / Fawn.
- 18-hole rounds use independent Front 9 / Back 9 selectors so every pro-shop routing works (including the same nine twice).
- Per-hole stats pool by physical hole identity ("Buck 3" is one history regardless of whether it played as hole 3 or hole 12).
- Two tees: White + Blue, with per-tee ratings/slopes and per-hole yardages.
- Per-hole hazards live on the course profile (Water / Bunker / OB / Trees / Hill / Other; Left / Right / Center / Long / Short; carry yardage; strategy note). Hazards mirror across tee variants of the same physical layout.

## Other features

- **Backup hygiene** — Export filename date-stamped; gold badge on the Export button after 3+ unbacked rounds.
- **JSON import / export** — full state round-trip. Imports route through the same migration pipeline as load so older exports pick up new shape defaults.
- **Round editing** from Recent Scorecards (date, course, layout, tee, every per-hole input).
- **Profile tab** with bag customization. Pill grid of every known club; tap to include/remove. Only bag clubs appear as pickable options in-round. Historical rounds keep clubs that have since been removed from the bag.
- **PWA install** — manifest + service worker + Inter font + icon. "Add to Home Screen" gives a real-looking standalone app. Network-first caching means deploys land cleanly; full offline use possible on the course.
- **First-launch welcome callout** for users with no saved rounds — friendly intro, "Add your first round" CTA, "Try with sample data" alternate.
- **Cache-busting query strings** (`?v=YYYY-MM-DD<letter>`) on the stylesheet and scripts. Bump for deploys that need to bust mobile cache. Service worker `CACHE_VERSION` bumped for deploys that need to purge precache.

## Included Courses

- **Deerwood Golf Course** — Buck, Doe, Fawn nines. Each available in 9-hole or 18-hole rounds (independent Front 9 / Back 9 selection). White and Blue tees.
- **Arrowhead Golf Club** (Akron, NY) — White tees.
- **Diamond Hawk Golf Course** (Cheektowaga, NY) — Black, Gold, Green, Silver, Burgundy tees.
- **Glen Oak Golf Club** (East Amherst, NY) — White tees.
- **Harvest Hill Golf Course** (Orchard Park, NY) — Black, Gold, Silver, Bronze, Blue tees.
- **Lake County Links** — White tees.
- **Ridgeview Golf Club** — Blue tees.
- **Seneca Hickory Stick Golf Course** (Lewiston, NY) — Black, Blue, White, Green, Red tees.

Course yardages, ratings, and slopes verified against published scorecards (GolfPass / 18Birdies / Aimy Golf). Seneca Hickory Stick's non-Black tees use per-nine-scaled estimates from the Black scorecard (the only one publicly available with hole-by-hole data) — totals match published values exactly, individual hole yardages are within a few yards of the real scorecard.
