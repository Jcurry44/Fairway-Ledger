# Fairway Ledger

A first-pass personal golf stats tracker. It runs as a static browser app and stores courses and rounds in local storage.

Open `index.html` in a browser to use it.

## MVP Scope

- Manual round entry by hole
- Course setup with 9-hole or 18-hole par sequences
- Scoring averages by course
- Scoring averages by par 3, par 4, par 5, and par 6
- Best and worst holes by average score to par
- Hole spotlight with score history
- Recent-round trend chart
- JSON import and export
- Lookup-only course adding; no manual par or yardage entry
- Handicap Index estimate using WHS-style score differentials for rated 18-hole rounds
- Deerwood hole yardages, hole handicap indexes, ratings, and slopes
- 9-hole rounds can feed the handicap estimate with an expected-differential approximation
- Tabbed premium dashboard layout with Home, Add Round, and Courses views
- Dedicated course catalog at `data/courses.js` (loaded as a script so the app works from a plain `file://` open with no local server)
- Add Round scorecard sections with live gross, to-par, putts, FIR, GIR, penalty, and differential estimates
- Course profile view with ratings, slope, yardage, hole handicaps, and personal scoring by hole
- Strokes Gained (vs. PGA Tour scratch baseline) per round, per hole, and broken down by par 3 / 4 / 5; surfaced in the live scorecard, home metrics, par-type bars, hole spotlight, and a dedicated Strokes Gained panel with trend chart. Baselines are interpolated from Mark Broadie's tour averages; amateur SG will typically be negative against scratch, which is expected.
- Pre-round brief in the Add Round flow: when you select a course you have 2+ rounds at, a collapsible panel above the scorecard surfaces your round count and averages, recent rounds, top 3 leak holes and strength holes by SG, a "what-if you parred your 3 worst holes last round" counterfactual, and the note from your most recent round there.
- One-hole-at-a-time card view for mobile/on-course entry: toggle between the desktop grid and a big-input card layout (Card view / Grid view button in the Add Round panel). Card view shows one hole per screen with large score input plus +/- shortcut buttons, Putts/Fairway/GIR/Pen secondary inputs, a per-hole narrative note textarea (iOS voice dictation works via the keyboard mic), and Prev/Next nav. The card header shows a tappable "Hole N of N" pill that opens a bottom-sheet hole picker listing all holes with par, label, current score, and active highlight. Defaults to card view on screens ≤640px, persists user preference in localStorage, and preserves entered scores when switching modes mid-round.
- Per-hole narrative notes: capture what actually happened on each hole ("chipped twice and 2-putted from 15ft", "blocked driver OB right, hit 3W instead"). Notes save with the round and surface two places: (1) the Hole Spotlight panel shows the last 5 notes for that hole as a per-hole diary with date + score, and (2) the pre-round Brief embeds the most recent note inline on each leak and strength hole — so walking to the tee you already see "Buck 3 (Par 4) · -1.2/rd · 'always come up short with 7-iron'".
- Round summary narrative: every saved round gets an auto-generated 2-4 sentence coach-style summary that opens with score + course + comparison to your recent form, calls out the dominant theme (penalties, three-putts, big leak hole, hot putter, dialed driver, GIR streak), and closes with a counterfactual ("Without your three worst holes you'd have shot 77"). Featured as a dark callout card at the top of Home for your most recent round, and available as an expandable "Summary" in every row of Recent Scorecards.
- First-putt distance tracking: per-hole "1st putt (ft)" input in both the card and grid views. New "Putting by Distance" panel on Home shows make % by bucket (Inside 3 ft / 3-6 / 6-10 / 10-20 / 20+), plus total tracked greens and three-jack count. Make = 1-putt total on that hole. Until you've logged any distances the panel guides you to where to add them.
- Shot distance tracking (tap-and-tap, hardware-free): per-hole "Shot tracker" section in card view. Tap "Mark starting position" before your first swing to capture your tee location via `navigator.geolocation`; tap "Mark next shot end" after each shot to record a position and auto-compute the distance from the previous point (Haversine, meters → yards). Each shot stores lat/lon/timestamp/club/accuracy and renders in a list with a club picker and delete button. Deleting recomputes distances. Saves with the round, restores on edit. Browser geolocation permission asked the first time. Friendly error messages on denied / timeout / unavailable. Phase 1 (capture + display); per-club distance dashboards and category-level Strokes Gained come later. Club picker uses degrees for wedges (PW / 50° / 52° / 54° / 56° / 58° / 60°) plus 7W, since modern bag setups vary too much to standardize on GW/SW/LW labels.
- Per-hole hazards (manual course intelligence): each hole in the course catalog gets a hazards editor in the Course Profile detail view. Pick type (Water / Bunker / OB / Trees / Hill / Other), side (Left / Right / Center / Long / Short), carry yardage, and an optional strategy note. Hazards render as color-coded chips with type-specific icons. Surface in two places: (1) the pre-round Brief shows hazards on each leak and strength hole row inline, and (2) the card view shows hazards for the current hole below the par/yards/HCP meta. Walking to the tee on Buck 3, you already see "💧 Water Left · 245y · lay up if not pure". One-time entry per course; permanent across all rounds. Hazards mirror automatically across tee variants of the same physical layout (Buck White and Buck Blue share the same hazard list since they're the same holes from different boxes).
- Cache-busting query strings (`?v=2026-05-16c`) on the stylesheet and scripts in `index.html`. Bump the version before each push that ships code changes worth users seeing — mobile browsers cache JS/CSS aggressively, and the version string forces a fresh fetch without requiring users to manually clear cache.
- Edit existing rounds from the Recent Scorecards list (date, course, layout, tee, and every per-hole input); Cancel edit reverts the form to a fresh state.
- Backup hygiene: Export filename is date-stamped, last-export timestamp is tracked, and the Export button shows a gold badge with the unbacked round count once 3+ rounds have been added since the last export.

## Included Courses

- Deerwood Golf Course with a round setup flow for 9 or 18 holes
- Deerwood 18-hole layouts: Buck / Doe, Buck / Fawn, Doe / Fawn
- Deerwood 9-hole layouts: Buck, Doe, Fawn
- Deerwood tee options: White by default, plus Blue
