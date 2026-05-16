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
- One-hole-at-a-time card view for mobile/on-course entry: toggle between the desktop grid and a big-input card layout (Card view / Grid view button in the Add Round panel). Card view shows one hole per screen with large score input plus +/- shortcut buttons, Putts/Fairway/GIR/Pen secondary inputs, and a horizontal jump strip (1-N) plus Prev/Next nav. Defaults to card view on screens ≤640px, persists user preference in localStorage, and preserves entered scores when switching modes mid-round. Enter still advances to the next hole's score input and Tab still works.
- Edit existing rounds from the Recent Scorecards list (date, course, layout, tee, and every per-hole input); Cancel edit reverts the form to a fresh state.
- Backup hygiene: Export filename is date-stamped, last-export timestamp is tracked, and the Export button shows a gold badge with the unbacked round count once 3+ rounds have been added since the last export.

## Included Courses

- Deerwood Golf Course with a round setup flow for 9 or 18 holes
- Deerwood 18-hole layouts: Buck / Doe, Buck / Fawn, Doe / Fawn
- Deerwood 9-hole layouts: Buck, Doe, Fawn
- Deerwood tee options: White by default, plus Blue
