# Fairway Ledger

A personal golf stats tracker. Static browser app, no build step, no server, no cloud — courses and rounds live in browser `localStorage`. Designed to be used on a phone during real rounds.

Live: `https://jcurry44.github.io/Fairway-Ledger/`

Open `index.html` locally to run it directly from the filesystem.

## Architecture

- **`index.html`** — single page, six tabs (Home / Add Round / Courses / Golf Lab / Games / Profile).
- **`app.js`** — ~5.7k lines, one IIFE. Handles UI rendering, state, persistence, event wiring.
- **`lib/golf-math.js`** — pure math (Strokes Gained, round totals, score classification, hole identity, handicap helpers, geo). Zero DOM/state. Imported in the browser as `window.GolfMath` and required in Node tests.
- **`lib/shapes.js`** — canonical `Round` and `Hole` field definitions. `makeRound` / `makeHole` / `normalizeRound` builders that every read/write path routes through, so adding a new per-hole field is a one-line change.
- **`lib/golf-lab.js`** — pure professional-golf data contracts and scorecard helpers for Golf Lab. Keeps pro players, courses, scorecards, equipment, accomplishments, odds, and prediction-ledger records normalized before the UI renders them.
- **`lib/golf-lab-warehouse.js`** — owned Golf Lab warehouse/import layer. Accepts source-backed collection bundles, previews import impact before merge, exports blank import templates, scores data quality, flags gaps, reports event/model readiness, audits market coverage, maps database coverage, shops best odds by book, grades source freshness/provenance, and traces provider-to-collection/event lineage.
- **`lib/golf-lab-sources.js`** — event-level source playbook for the owned Golf Lab warehouse. Turns data gaps into a Research Queue, acquisition runbook, source-proof gates, and per-tournament research packets with collection column contracts.
- **`lib/golf-lab-model.js`** — owned Golf Lab prediction model. Scores imported fields with transparent feature pieces for skill, recent form, course fit, difficulty fit, weather fit, and automatic live-state context for in-progress tournaments, then writes auditable prediction-ledger records.
- **`scripts/golf-lab-build.js`** — local owned-data builder. Combines a folder of source-backed CSV/JSON files into one Golf Lab import bundle with warehouse, coverage-map, source-lineage, and source-ops reports.
- **`scripts/golf-lab-adapt.js`** — local source-export adapter. Converts owned/public schedule, profile, field, course, leaderboard, odds, weather, and enrichment CSV exports into normalized Golf Lab collection CSVs with provenance rows.
- **`scripts/golf-lab-espn.js`** — saved ESPN public golf scoreboard adapter. Converts the raw JSON response into source-backed players, events, courses, fields, rounds, and source-fetch CSVs while skipping partial in-progress rounds by default.
- **`scripts/golf-lab-espn-backfill.js`** — manifest-driven historical ESPN backfill runner. Replays saved raw scoreboard JSON files sequentially into one clean multi-event folder and can build the import/report in the same pass.
- **`scripts/golf-lab-espn-season.js`** — saved ESPN public PGA season adapter. Converts season-level scoreboard payloads into every usable stroke-play event, skipping match/team/no-scorecard events and leaving course fields blank unless a verified course map supplies venue metadata.
- **`scripts/golf-lab-derived-scoring.js`** — owned field-relative scoring model. Derives SG Total, adjusted-to-field scoring, round difficulty buckets, and course/setup difficulty from source-backed scorecards while filtering implausible public-feed scores.
- **`scripts/golf-lab-pgatour-schedule.js`** — saved public PGA TOUR schedule enrichment lane. Matches official schedule course metadata back to existing warehouse events, then updates events, rounds, courses, course setups, and source-fetch proof rows together.
- **`scripts/golf-lab-pgatour-stats.js`** — saved public PGA TOUR stats adapter. Converts exported/public stats JSON, CSV, or saved page payloads into source-backed player profile rows and season/career aggregate `strokes_gained.csv` skill DNA for SG components, distance, accuracy, GIR, and scrambling.
- **`scripts/golf-lab-open-meteo-weather.js`** — public Open-Meteo historical weather backfill lane. Geocodes course locations, saves raw archive JSON, and writes AM/PM tournament-day wind, gust, temperature, and precipitation snapshots with source-fetch proof.
- **`scripts/golf-lab-vegasinsider-odds.js`** — saved public VegasInsider golf futures adapter. Converts a raw HTML market snapshot into event-scoped `odds_snapshots.csv` rows across books, computes implied probability, maps players to the selected event field, and writes source-fetch proof.
- **`scripts/golf-lab-the-odds-api.js`** — paid The Odds API golf adapter. Reuses the same `THE_ODDS_API_KEY` env-file pattern as the MLB framework, fetches or adapts saved golf outrights JSON, saves raw proof snapshots, writes book-level and best-price `odds_snapshots.csv` rows, and keeps request/quota metadata in source-fetch manifests.
- **`scripts/golf-lab-oddschecker-odds.js`** — saved public Oddschecker market adapter. Converts rendered HTML or visible page text for placement/cut markets into `odds_snapshots.csv`, supports fractional/decimal/American prices, maps field players, and appends an `Oddschecker Best` row for model pricing while preserving book-level rows.
- **`scripts/golf-lab-capture-oddschecker.js`** — optional convenience capture lane for machines where local Edge/Chrome exposes a headless DevTools port. Saves rendered Oddschecker HTML/text snapshots for top-10, top-20, and make-cut pages before the adapter runs; if browser capture is blocked, save the page text/HTML manually and run the same adapter command.
- **`scripts/golf-lab-weather-gov.js`** — saved NOAA/NWS hourly forecast adapter. Converts weather.gov JSON into tournament-scoped `weather_snapshots.csv` rows with round/date/wave buckets and source-fetch provenance.
- **`scripts/golf-lab-run-model.js`** — source-backed owned-model runner. Rebuilds a selected event slate from the warehouse, writes model predictions, prediction-ledger rows, source-fetch proof, and a JSON model report without needing the browser button.
- **`data/courses.js`** — course catalog. 25 entries covering Deerwood Golf Course (per-nine, per-tee), Ridgeview, Lake County, and five Western New York courses (Arrowhead, Diamond Hawk, Glen Oak, Harvest Hill, Seneca Hickory Stick) including all their tee variants.
- **`sw.js`** — service worker (network-first with offline fallback). Whole app shell is precached so it works on a phone with zero signal.
- **`manifest.json` + `icon.svg`** — PWA manifest. Installs to home screen as a real-looking app with its own icon.

## Tests

```
node --test tests/golf-math.test.js tests/shapes.test.js tests/games.test.js tests/golf-lab.test.js tests/golf-lab-warehouse.test.js tests/golf-lab-sources.test.js tests/golf-lab-model.test.js tests/golf-lab-run-model-cli.test.js tests/golf-lab-build-cli.test.js tests/golf-lab-adapt-cli.test.js tests/golf-lab-espn-cli.test.js tests/golf-lab-espn-backfill-cli.test.js tests/golf-lab-espn-season-cli.test.js tests/golf-lab-derived-scoring-cli.test.js tests/golf-lab-pgatour-schedule-cli.test.js tests/golf-lab-pgatour-stats-cli.test.js tests/golf-lab-open-meteo-weather-cli.test.js tests/golf-lab-vegasinsider-odds-cli.test.js tests/golf-lab-the-odds-api-cli.test.js tests/golf-lab-oddschecker-odds-cli.test.js tests/golf-lab-weather-gov-cli.test.js
```

Pure-module tests run with no build step, no dependencies, just Node's built-in test runner.

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

- **Card view** (default on phones ≤640px wide) — one hole per screen. Big tap targets, pill-based input (par-anchored Score row, Putts 0-5, Pen 0-3, fairway result, 1st-putt distance, clubs hit, per-hole note). Prev/Next arrows + floating mid-screen arrows + bottom-sheet hole picker. Auto-collapses round setup once you're scoring.
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

## Golf Lab

Golf Lab is the professional-golf analytics wing of Fairway Ledger. It is built as an owned golf warehouse and modeling surface: import source-backed PGA/DP World/etc. JSON payloads, keep every record audit-friendly, and render a Blue Line-style player scorecard without depending on a paid provider sync.

The normalized Golf Lab shape includes players, tours, events, courses, course setups, fields, pro rounds, strokes gained, weather snapshots, odds snapshots, model predictions with run IDs, prediction ledger entries, equipment snapshots, accomplishments, and source fetch audit rows with optional model-run manifests. Player scorecards surface:

- A premium scouting profile with player archetype, strengths, risks, source coverage, and selected-tournament fit.
- Distance, accuracy, GIR, scrambling, and strokes-gained skill DNA.
- Best and worst courses by imported scoring/strokes-gained history.
- Weather DNA with baseline-adjusted condition deltas, best/worst buckets, selected-event weather alignment, plus wind, rain, heat, cold, calm, and neutral scoring splits when weather snapshots are imported.
- Source-backed equipment/bag snapshots with source links.
- Accomplishments and ranking/profile metadata.
- Tournament data room, prediction ledger, and backtest panels for the future betting/modeling workflow.

The first owned model pass scores an imported tournament field with transparent features: baseline skill, recent form, course fit, course-difficulty fit, weather fit, and automatic live-state context when current-event scorecards exist. The hero-level model console supports persistent profiles (Balanced, Hot Hand, Course Horse, Major Test, Weather Desk), market filtering, edge threshold, and weather scenarios (imported forecast, calm, wind, rain, cold, heat) so the same warehouse can be viewed through different betting-model lenses before final conditions are locked. The Tournament Command Center sits at the top of Golf Lab and condenses event readiness, source score, field/weather/market counts, top fit, consensus leader, fragility, run audit, best edge, portfolio exposure, and active blockers into one low-scroll decision hub. The Activation Plan turns the selected event into a prioritized operator checklist with source proof, data intake, warehouse, model activation phases, next actions, adapter commands, and target files; its Packet button exports that exact checklist as a focused JSON handoff. The Prediction Prep board turns the selected event into a source-backed command gate and Run Brief, scoring field depth, profile matching, historical inputs, course setup, weather, markets, model coverage, playable edges, provenance, next model action, active profile, weather scenario, market, edge threshold, and source-safety status before calling a slate bet-ready. The Player Identity board audits exact, normalized, ambiguous, and unresolved player matches across field, scoring, strokes-gained, odds, prediction, equipment, and accomplishment rows so source IDs are cleaned before modeling. The Fit Board ranks the selected event before odds are imported, showing top player-course-weather fits with strengths and concerns. The Field Readiness Matrix audits every selected-field player for profile match, round/SG history, course and comp rounds, weather history, market odds, model output, enrichment, and source proof before predictions are trusted. The Field Intelligence board expands that into a full selected-event model desk with every field player, fit specialists, confidence buckets, fair odds, market odds, edge status, and feature strips. The Consensus Board runs the field through every model profile at once, labeling consensus-core picks, stable leans, profile-sensitive players, rank ranges, profile chips, probability spread, and edge agreement before any single lens is trusted. The Feature Sensitivity board stress-tests the selected profile by removing skill, form, course, difficulty, weather, and live-state inputs one at a time, then labels robust picks, feature-dependent picks, fragile picks, max rank loss, probability loss, and strongest dependency. The Player Index turns the roster into a scan-friendly scouting directory with SG/distance/accuracy leaders, tough-course and wind specialists, best/worst course context, bag coverage, source score, selected-event fit, player archetype, and one-click drill-down into the full player scorecard. The Player Split Lab ranks the selected field by tough-course fit, easy-course scoring, target-weather DNA, comp-course performance, source depth, and a concise recommendation such as major-test fit or scoring-course fit. The Feature Store Audit checks the selected event player-by-player for source-backed profile, skill, recent form, course fit, difficulty fit, weather fit, market, model output, and provenance inputs before prediction trust is allowed. The Course Difficulty Board ranks every imported course from hardest to easiest, shows the basis/provenance behind the difficulty score, highlights scoring/weather samples, and identifies the players who have historically fit or struggled at each setup. The Course Setup Lab grades the selected tournament's setup pressure across par, yardage, rough, green speed, firmness, difficulty, weather, source proof, closest course comps, and player setup fits before model prep. The Course Comp Board compares the selected tournament course to similar imported setups by difficulty, yardage, par, style, rating, and slope, then ranks players with actual comp-course rounds. The Scenario Board compares the selected tournament across weather scenarios and surfaces the biggest rank movers versus baseline, while the Weather Matrix ranks the selected field by actual imported history in the event's current weather bucket. The Tee-Time Waves board compares AM/PM field waves against imported wave-level or timestamped weather snapshots, labels the advantaged/tough draw, and surfaces player weather-history context inside each wave. The Run Owned Model button is launch-gated by the Activation Plan, requiring official field rows and clear critical source lanes before saved predictions are written. The model saves fair odds, confidence, model profile, weather scenario, live position/to-par context where available, model run ID, edge where market odds exist, and source-fetch manifest rows for winner, top-10, top-20, and make-cut markets so predictions can be reproduced, reviewed, and improved over time. The Run Audit board checks whether the selected prediction slate is modeled, priced, fresh, settled, and gap-free by market before any edge is trusted. The Run History board reconstructs saved model slates from prediction rows and source-fetch manifests, showing proof score, profile, weather scenario, activation score, field coverage, pricing coverage, source providers, warnings, and the exact model run ID for each run. The Market Coverage board audits whether modeled players have current odds by event, market, book, and field coverage. The Odds Movement board turns timestamped odds snapshots into a market tape, grouping player/book lines by event and market, labeling steam, drift, and flat moves from implied-probability deltas. The Best Price Board line-shops the latest book prices, compares best price to consensus implied probability and owned model probability, and surfaces the extra edge gained by taking the best available line before the Edge Board ranks positive model edges with conservative capped unit sizing. The Bet Portfolio board turns playable edges into a capped staking slate with total, player, market, and event unit limits plus expected-unit exposure by market. The Model Explainer translates every prediction into weighted feature contributions, verdicts, strengths, risk flags, and expected-unit context. The Settlement Board separates pending, ready-to-grade, and already-settled predictions by event after result rounds are imported, showing units, ROI, blockers, and recent settlements before the Grade action writes results back into the ledger. The Model Results panel grades markets against imported tournament rounds with breakdowns by market, model profile, weather scenario, confidence bucket, and edge bucket; the Training Dataset board turns completed tournament results into leakage-aware event/player examples with prior-round features and outcome labels; the Model Calibration board compares expected probabilities to actual settled outcomes with Brier score, calibration drift, probability buckets, market buckets, edge buckets, and ROI; and the Model Tuning Lab turns settled feature splits into auditable increase/decrease/hold recommendations without automatically changing weights.

The Warehouse Workbench is the database control room: it scores collection depth, player/course matching, scoring coverage, weather coverage, market coverage, source audit health, and row validation. Its Validation block flags duplicate IDs and missing model-critical fields before weak rows can pollute predictions, and the import flow now previews add/update counts, score movement, validation deltas, verdict, and top blockers before merging source-backed files. The Warehouse Coverage Map turns that into a database readiness heat map across collections, events, player depth, course depth, blockers, and next actions. The Source Audit Board then breaks the trust score into latest refresh age, provenance coverage, provider freshness, stale-source flags, and collection-level source metadata coverage. The Source Lineage board adds the chain-of-custody layer: provider chains, collection proof, selected-event lineage, linked source-fetch rows, blockers, and proof scores that show whether tournament data is traceable enough to trust. The Source Ops Board turns that audit trail into an operating desk with refresh risk, proof readiness, source-ledger recency, provider alerts, and the next source tasks to resolve before a tournament model run is trusted. The Data Intake board converts that plan into the operator workflow: a one-pass batch ingest command, adapter-ready lanes, public-first acquisition recipes, generated `golf-lab-adapt.js` commands, expected raw headers, target collection files, output folder, manual lanes, proof state, and next actions; its Packet button exports the acquisition runbook, batch command, lane commands, blank raw CSV header templates, manual collection contracts, source-proof checklist, quality gates, and import checklist for the selected event. The Source Catalog Board translates the same source playbook into an acquisition manifest with priority, cadence, target files, source URLs, proof status, and next actions for every tournament data lane. The Historical Backfill board ranks past tournaments by missing model-critical data, source proof, and training value, then gives each event a batch raw-folder command, missing adapter lanes, and target collection files so the owned model can be improved deliberately instead of researched ad hoc. The Template button downloads a blank import contract with every supported collection and column list. The Export button downloads the current owned warehouse with normalized data, warehouse report, source freshness audit, source lineage board, player identity board, row validation audit, selected model settings, command center, coverage map, source ops board, data intake board, acquisition runbook, tournament activation plan, data intake packet, source catalog board, historical backfill board, source plan, prediction prep board, player split lab, feature store audit, player index, selected player scorecard, fit board, field readiness matrix, field intelligence, model consensus board, feature sensitivity board, course difficulty board, course setup board, course comp board, scenario board, weather matrix board, tee-time wave board, prediction run audit, model run history, market coverage board, odds movement board, odds shopping board, edge board, bet portfolio, model explainer, settlement board, training dataset, model calibration, model tuning board, model-performance breakdowns, and backtest summary. The importer accepts either Golf Lab JSON or collection-named CSV files such as `players.csv`, `events.csv`, `rounds.csv`, `strokes_gained.csv`, `weather_snapshots.csv`, and `odds.csv`; operator manifests such as `source_catalog.csv` are ignored by the importer and summarized in build reports instead.

The Research Queue turns that warehouse score into event-level source work: schedule, player profiles, field list, course profile, round results, weather, market odds, and enrichment. Each task now carries source-proof status from `source_fetches.csv` rows, so planned, missing, review, partial, and proof-ready lanes are visible next to the row-count target, while Source Ops ranks the same tasks by freshness cadence and model-blocking risk. The Research Queue Packet button exports the selected tournament, current source plan, warehouse health snapshot, source freshness audit, validation audit, and every collection contract into a JSON bundle that can be filled from owned research and imported back into Golf Lab; the Historical Backfill Packet button does the same for the highest-priority thin historical event.

The Tournament Board becomes an event dossier when a tournament is selected: field size and player matching, course setup, historical scoring rows, weather label, market count, prediction count, blockers, and the winner board all live in one low-scroll panel.

The Split Leaders panel ranks players globally by imported performance on tough courses, easy courses, wind, rain, and calm conditions, giving the database the fast "who fits this setup?" view that sits between raw scorecards and full model runs.

For bulk work outside the browser, the local builder can combine a folder of source-backed files:

```
node scripts/golf-lab-build.js --init data/golf-lab/raw
node scripts/golf-lab-build.js --event-kit data/golf-lab/us-open-2026 --event-name "U.S. Open" --course-name "Shinnecock Hills Golf Club" --start-date 2026-06-18 --tour "PGA Tour"
node scripts/golf-lab-adapt.js --batch downloads/us-open-raw --out data/golf-lab/us-open-2026 --event-id us-open-2026 --course-id shinnecock-hills --provider "Owned Research" --source-url "https://example.com/source"
node scripts/golf-lab-adapt.js --type leaderboard --in downloads/us-open-r1.csv --out data/golf-lab/us-open-2026 --event-id us-open-2026 --course-id shinnecock-hills --provider "Official leaderboard" --source-url "https://example.com/leaderboard"
node scripts/golf-lab-build.js --in data/golf-lab/raw --out data/golf-lab/import.json --report data/golf-lab/build-report.json --provider "Owned Research"
```

The first command writes header-only CSV starter files. The event-kit command writes a tournament-specific research folder with task CSVs, starter event/course rows, a planned `source_fetches.csv` provenance ledger, a `source_catalog.csv` operator manifest for priority/cadence/owners/source URLs, an `acquisition_runbook.json` file with public-first source recipes and proof gates, and a checklist README. The batch adapter command maps a folder of messy owned/public exports into normalized collection CSVs when file names include hints such as `schedule`, `profiles`, `field`, `course`, `leaderboard`, `odds`, `weather`, or `enrichment`; the lane adapter command remains available for tighter one-file control. Supported lanes are `schedule`, `profile`, `field`, `course`, `leaderboard`, `odds`, `weather`, and `enrichment`, and flexible headers like `Player Name`, `Tee Time`, `SG OTT`, `Odds`, `Green Speed`, `Driver`, and `Accomplishment` are normalized before rows are merged into `players.csv`, `courses.csv`, `course_setups.csv`, `fields.csv`, `rounds.csv`, `strokes_gained.csv`, `odds_snapshots.csv`, `weather_snapshots.csv`, `equipment_snapshots.csv`, `accomplishments.csv`, and `source_fetches.csv`. The final command turns filled CSV/JSON files into a single importable Golf Lab bundle, with an optional build-report JSON for quick warehouse score, coverage map, source lineage, tournament activation plan, player identity resolution, player split lab, feature store audit, course setup pressure, source ops, data intake commands, acquisition runbook, prediction prep, model run history, source catalog, historical backfill, model training dataset, odds shopping, source freshness, validation, gap, and source-file review outside the browser.

For the current public-scoreboard lane, save the raw ESPN response first, then adapt and build:

```
Invoke-WebRequest -Uri https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard -OutFile data/golf-lab/raw/espn/pga-scoreboard-2026-06-19.json
Invoke-WebRequest -Uri "https://api.weather.gov/points/40.899,-72.441" -OutFile data/golf-lab/raw/weather-gov-shinnecock-point-2026-06-19.json
Invoke-WebRequest -Uri "https://api.weather.gov/gridpoints/OKX/85,59/forecast/hourly" -OutFile data/golf-lab/raw/weather-gov-shinnecock-hourly-2026-06-19.json
node scripts/golf-lab-espn.js --in data/golf-lab/raw/espn/pga-scoreboard-2026-06-19.json --out data/golf-lab/us-open-2026 --event-id us-open-2026 --course-id shinnecock-hills --course-name "Shinnecock Hills Golf Club" --course-location "Southampton, New York" --course-source-url "https://www.usopen.com/2026/articles/current-exempt-players-126th-us-open-shinnecock.html" --source-url "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard" --fetched-at "2026-06-19T12:00:00-04:00"
node scripts/golf-lab-weather-gov.js --in data/golf-lab/raw/weather-gov-shinnecock-hourly-2026-06-19.json --out data/golf-lab/us-open-2026 --event-id us-open-2026 --course-id shinnecock-hills --course-name "Shinnecock Hills Golf Club" --source-url "https://api.weather.gov/gridpoints/OKX/85,59/forecast/hourly" --fetched-at "2026-06-19T17:20:13+00:00" --start-date 2026-06-19 --end-date 2026-06-21 --event-start-date 2026-06-18
node scripts/golf-lab-build.js --in data/golf-lab/us-open-2026 --out data/golf-lab/us-open-2026-import.json --report data/golf-lab/us-open-2026-report.json --provider "ESPN public scoreboard + NOAA/NWS hourly forecast"
```

That real-data run currently produces 156 players, 190 completed round rows, 122 skipped partial round rows, 59 NOAA/NWS hourly weather snapshots, and a 566-record Golf Lab import bundle with clean validation and source provenance. ESPN provides the field, scoreboard, and round scoring; weather.gov provides tournament-window forecast context; venue/course context is supplied separately when the scoreboard feed does not expose it.

For historical U.S. Open backfill, save the final-date ESPN scoreboard responses and replay the manifest:

```
Invoke-WebRequest -Uri "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=20250615" -OutFile data/golf-lab/raw/espn/pga-scoreboard-us-open-2025-final.json
Invoke-WebRequest -Uri "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=20240616" -OutFile data/golf-lab/raw/espn/pga-scoreboard-us-open-2024-final.json
node scripts/golf-lab-espn-backfill.js --manifest data/golf-lab/us-open-history-manifest.json --out data/golf-lab/us-open-history --build-out data/golf-lab/us-open-history-import.json --report data/golf-lab/us-open-history-report.json --provider "ESPN public historical scoreboard" --clean
```

That historical seed currently produces 236 unique players, 2 U.S. Open events, 2 major-test courses, 312 field rows, 904 completed round rows, and a 1,460-record import bundle with clean validation and full provenance. It is enough to power early tough-course player splits while weather, strokes-gained, and market backfill lanes are added.

For a broader major-championship training seed, use the 2024-2025 major manifest:

```
node scripts/golf-lab-espn-backfill.js --manifest data/golf-lab/major-history-2024-2025-manifest.json --out data/golf-lab/major-history-2024-2025 --build-out data/golf-lab/major-history-2024-2025-import.json --report data/golf-lab/major-history-2024-2025-report.json --provider "ESPN public historical scoreboard" --clean
```

That broader seed currently covers 8 men's majors from 2024-2025: Masters, PGA Championship, U.S. Open, and The Open for each year. After derived scoring it produces 418 unique players, 7 courses, 1,121 field rows, 3,344 completed round rows, 3,344 derived SG Total rows, 9 source-fetch proofs, and an 8,259-record import bundle with clean validation and full provenance.

For the widest public ESPN PGA scoring backfill, save season payloads and replay every usable stroke-play event. The practical public edge found so far is 2002: ESPN returns usable scoreboards for 2002-2026, while 2001 returned an ESPN core timeout and 1999-2000 returned unavailable responses during research.

```
foreach ($year in 2002..2026) {
  Invoke-WebRequest -Uri "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=$year" -OutFile "data/golf-lab/raw/espn/pga-scoreboard-season-$year.json"
}
```

Then run `scripts/golf-lab-espn-season.js` once per saved season into `data/golf-lab/pga-public-history-2002-2026`, using `--clean` on the first year only. After the public scorecards are written, run the owned derived scoring model and finish with the scale-safe lite builder:

```
$out = "data\golf-lab\pga-public-history-2002-2026"
foreach ($year in 2002..2026) {
  $argsList = @("scripts\golf-lab-espn-season.js", "--in", "data\golf-lab\raw\espn\pga-scoreboard-season-$year.json", "--out", $out, "--provider", "ESPN public season scoreboard", "--fetched-at", "2026-06-19T15:30:00-04:00")
  if ($year -eq 2002) { $argsList += "--clean" }
  node @argsList
}
node scripts/golf-lab-derived-scoring.js --in data/golf-lab/pga-public-history-2002-2026 --provider "Golf Lab derived scoring model" --fetched-at "2026-06-19T18:45:00-04:00" --report data/golf-lab/pga-public-history-2002-2026-derived-scoring-report.json
foreach ($year in 2012..2026) {
  Invoke-WebRequest -Uri "https://www.pgatour.com/schedule/$year" -OutFile "data/golf-lab/raw/pgatour/schedule-$year-page-2026-06-19.html"
}
node scripts/golf-lab-pgatour-schedule.js --batch data/golf-lab/raw/pgatour --out data/golf-lab/pga-public-history-2002-2026 --provider "PGA TOUR public schedule" --fetched-at "2026-06-19T18:55:00-04:00"
$statImports = @(
  @("02675", "sgTotal"), @("02674", "sgT2g"), @("02567", "sgOtt"), @("02568", "sgApp"), @("02569", "sgArg"),
  @("02564", "sgPutt"), @("101", "drivingDistance"), @("102", "accuracy"), @("103", "gir"), @("130", "scrambling")
)
foreach ($stat in $statImports) {
  Invoke-WebRequest -Uri "https://www.pgatour.com/stats/detail/$($stat[0])" -OutFile "data/golf-lab/raw/pgatour/stats-detail-$($stat[0])-2026-06-19.html"
  node scripts/golf-lab-pgatour-stats.js --in "data/golf-lab/raw/pgatour/stats-detail-$($stat[0])-2026-06-19.html" --out data/golf-lab/pga-public-history-2002-2026 --season 2026 --stat-key $stat[1] --provider "PGA TOUR public stats" --source-url "https://www.pgatour.com/stats/detail/$($stat[0])" --fetched-at "2026-06-19T18:35:00-04:00"
}
node scripts/golf-lab-open-meteo-weather.js --out data/golf-lab/pga-public-history-2002-2026 --raw-dir data/golf-lab/raw/open-meteo --season-min 2012 --season-max 2026 --fetched-at "2026-06-19T19:30:00-04:00"
node scripts/golf-lab-open-meteo-weather.js --out data/golf-lab/pga-public-history-2002-2026 --raw-dir data/golf-lab/raw/open-meteo --season-min 2012 --season-max 2026 --refresh-raw --fetched-at "2026-06-19T19:45:00-04:00"
New-Item -ItemType Directory -Force data/golf-lab/raw/vegasinsider | Out-Null
Invoke-WebRequest -Uri "https://www.vegasinsider.com/golf/odds/futures/" -OutFile "data/golf-lab/raw/vegasinsider/us-open-futures-2026-06-19.html"
node scripts/golf-lab-vegasinsider-odds.js --in data/golf-lab/raw/vegasinsider/us-open-futures-2026-06-19.html --out data/golf-lab/pga-public-history-2002-2026 --event-id 2026-u-s-open-401811952 --market winner --provider "VegasInsider public odds" --source-url "https://www.vegasinsider.com/golf/odds/futures/" --fetched-at "2026-06-19T20:30:00-04:00"
node scripts/golf-lab-the-odds-api.js --out data/golf-lab/pga-public-history-2002-2026 --event-id 2026-u-s-open-401811952 --sport golf_us_open_winner --market winner --provider "The Odds API" --env-file "..\MLB Betting Framework\.env" --raw-out data/golf-lab/raw/the-odds-api/golf-us-open-winner-2026-06-20.json --fetched-at "2026-06-20T08:25:00-04:00"
New-Item -ItemType Directory -Force data/golf-lab/raw/oddschecker | Out-Null
node scripts/golf-lab-capture-oddschecker.js --date 2026-06-20
node scripts/golf-lab-oddschecker-odds.js --in data/golf-lab/raw/oddschecker/us-open-top-10-2026-06-20.txt --out data/golf-lab/pga-public-history-2002-2026 --event-id 2026-u-s-open-401811952 --market "top 10" --provider "Oddschecker public odds" --source-url "https://www.oddschecker.com/golf/us-open/top-10-finish" --fetched-at "2026-06-20T08:20:00-04:00"
node scripts/golf-lab-oddschecker-odds.js --in data/golf-lab/raw/oddschecker/us-open-top-20-2026-06-20.txt --out data/golf-lab/pga-public-history-2002-2026 --event-id 2026-u-s-open-401811952 --market "top 20" --provider "Oddschecker public odds" --source-url "https://www.oddschecker.com/golf/us-open/top-20-finish" --fetched-at "2026-06-20T08:20:00-04:00"
node scripts/golf-lab-oddschecker-odds.js --in data/golf-lab/raw/oddschecker/us-open-make-cut-2026-06-20.txt --out data/golf-lab/pga-public-history-2002-2026 --event-id 2026-u-s-open-401811952 --market "make cut" --provider "Oddschecker public odds" --source-url "https://www.oddschecker.com/golf/us-open/to-make-the-cut" --fetched-at "2026-06-20T08:20:00-04:00"
node scripts/golf-lab-build.js --lite --compact --in data/golf-lab/pga-public-history-2002-2026 --out data/golf-lab/pga-public-history-2002-2026-import.json --report data/golf-lab/pga-public-history-2002-2026-report.json --provider "ESPN public season scoreboard + Golf Lab derived scoring model + PGA TOUR public stats + PGA TOUR public schedule + Open-Meteo historical weather + VegasInsider public odds"
```

For a two-round live weekend slate, refresh the current event scoreboard, weather, and odds snapshots first, then rerun derived scoring, save the owned model, and rebuild the compact bundle:

```
node scripts/golf-lab-derived-scoring.js --in data/golf-lab/pga-public-history-2002-2026 --provider "Golf Lab derived scoring model" --fetched-at "2026-06-20T08:05:00-04:00" --report data/golf-lab/pga-public-history-2002-2026-derived-scoring-report.json
node scripts/golf-lab-the-odds-api.js --out data/golf-lab/pga-public-history-2002-2026 --event-id 2026-u-s-open-401811952 --sport golf_us_open_winner --market winner --provider "The Odds API" --env-file "..\MLB Betting Framework\.env" --raw-out data/golf-lab/raw/the-odds-api/golf-us-open-winner-2026-06-20.json --fetched-at "2026-06-20T08:25:00-04:00"
node scripts/golf-lab-oddschecker-odds.js --in data/golf-lab/raw/oddschecker/us-open-top-10-2026-06-20.txt --out data/golf-lab/pga-public-history-2002-2026 --event-id 2026-u-s-open-401811952 --market "top 10" --provider "Oddschecker public odds" --source-url "https://www.oddschecker.com/golf/us-open/top-10-finish" --fetched-at "2026-06-20T08:20:00-04:00"
node scripts/golf-lab-oddschecker-odds.js --in data/golf-lab/raw/oddschecker/us-open-top-20-2026-06-20.txt --out data/golf-lab/pga-public-history-2002-2026 --event-id 2026-u-s-open-401811952 --market "top 20" --provider "Oddschecker public odds" --source-url "https://www.oddschecker.com/golf/us-open/top-20-finish" --fetched-at "2026-06-20T08:20:00-04:00"
node scripts/golf-lab-run-model.js --in data/golf-lab/pga-public-history-2002-2026 --event-id 2026-u-s-open-401811952 --profile "Major Test" --weather-scenario baseline --created-at "2026-06-20T08:10:00-04:00" --report data/golf-lab/pga-public-history-2002-2026-weekend-model-report.json
node scripts/golf-lab-build.js --lite --compact --in data/golf-lab/pga-public-history-2002-2026 --out data/golf-lab/pga-public-history-2002-2026-import.json --report data/golf-lab/pga-public-history-2002-2026-report.json --provider "ESPN public season scoreboard + ESPN public scoreboard + Golf Lab derived scoring model + PGA TOUR public stats + PGA TOUR public schedule + Open-Meteo historical weather + NOAA/NWS hourly forecast + VegasInsider public odds + Golf Lab Owned Model"
```

That all-available public scoring seed currently imports 992 stroke-play PGA event scoreboards from 2002 through current 2026-to-date, 15 saved public PGA TOUR schedule pages from 2012-2026, 10 saved public PGA TOUR 2026 stat-detail pages for official aggregate skill enrichment, 782 saved Open-Meteo raw geocode/archive weather files, refreshed ESPN two-round U.S. Open scorecard data, a NOAA/NWS weekend forecast, saved public VegasInsider U.S. Open futures market snapshots, and a paid The Odds API U.S. Open outrights snapshot. It produces 3,751 unique players, 126,378 field rows, 395,365 completed round rows, 393,168 strokes-gained rows, 161 official 2026 PGA TOUR aggregate skill rows, 141 course rows, 642 event-course setup rows, 5,232 weather snapshots, 2,138 U.S. Open winner odds snapshots, 1,248 saved model predictions, 1,248 prediction-ledger rows, 1,666 source-fetch proofs, and a 931,969-record import bundle with 100% provenance coverage. The June 20 U.S. Open weekend run saved 624 fresh `owned-v0.4` predictions across 156 field players and four markets, with 149 priced predictions, 106 positive edges, 99% live-score coverage, live leader context at -7 to par, and 24% pricing coverage. The current report has validation score 99, warehouse score 86, grade `premium`, source quality 100, and import verdict `ready`. The PGA TOUR stats lane imports official aggregate skill components, distance, accuracy, GIR, and scrambling from saved public exports; it is season/career player DNA, not raw ShotLink shot-level data, and one-stat exports can be replayed with `--stat-key sgApp`, `--stat-key sgPutt`, etc. into the same folder without erasing earlier metrics. The import file is large by design, about 545 MB compact after enrichment, so the lite compact report path uses a streamed compact JSON writer rather than one huge `JSON.stringify` allocation. Remaining model-enrichment gaps are broader historical odds coverage, more current markets such as top-10/top-20/make-cut, and saved settlement rows after results are final.

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
