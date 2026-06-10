/*
 * Fairway Ledger — golf game scoring engines.
 *
 * Pure math for the Games tab: given a game's per-hole entries, compute
 * standings, hole-by-hole outcomes, and (when a stake is set) the
 * end-of-round settlement. No DOM, no storage — everything here is a pure
 * function so it can be unit-tested in Node.
 *
 * Shared input shape (one entry per hole the group has played):
 *   hole = {
 *     number: 1..18,
 *     par: 3|4|5,                       // only consulted when meta.needsPar
 *     scores: { [playerId]: int|null },  // gross strokes; null = not entered
 *     wolf:  { wolfId, partnerId|null, lone: bool } | undefined   (Wolf only)
 *     bingo: { bingo: pid|null, bango: pid|null, bongo: pid|null } (BBB only)
 *   }
 *
 * A hole only counts toward a game's standings when it is "complete" for
 * that game (every needed score entered / every needed pick made). Partial
 * holes are simply ignored, so live standings stay truthful mid-hole.
 *
 * Same UMD pattern as lib/golf-math.js: window.GolfGames in the browser,
 * module.exports under Node for the test runner.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.GolfGames = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- Game catalog --------------------------------------------------------
  //
  // Everything the UI needs to recommend, explain, and configure each game.
  // `players` is the list of player counts the game supports; `bestWith`
  // drives the "recommended for your group" sort. `rules` is shown in the
  // pre-game rules sheet — written to be read out loud on the first tee.

  const GAME_CATALOG = [
    {
      id: "matchplay",
      name: "Match Play",
      players: [2],
      bestWith: [2],
      teams: false,
      needsPar: false,
      needsScores: true,
      holeCounts: [9, 18],
      tags: ["head-to-head", "classic"],
      blurb: "Hole-by-hole duel. Win more holes than your opponent — total strokes don't matter.",
      stakeLabel: "$ per match",
      rules: [
        "Each hole is its own contest: lower score wins the hole, ties halve it.",
        "Standings are counted in holes, e.g. \"2 UP with 4 to play.\"",
        "The match ends early when someone is up by more holes than remain (\"3&2\" = 3 up with 2 to play).",
        "\"Dormie\" means you're up by exactly the holes remaining — your opponent must win every hole left to tie.",
        "Stake (optional): loser pays the winner the match stake. A tied match pushes."
      ]
    },
    {
      id: "nassau",
      name: "Nassau",
      players: [2],
      bestWith: [2],
      teams: false,
      needsPar: false,
      needsScores: true,
      holeCounts: [18],
      tags: ["money game", "classic"],
      blurb: "Three match-play bets in one round: front 9, back 9, and overall 18.",
      stakeLabel: "$ per bet (×3 bets)",
      rules: [
        "Three separate match-play bets: the front nine, the back nine, and the full 18.",
        "Each bet is scored like match play — most holes won takes that bet.",
        "Stake (optional): each of the three bets is worth the stake. Win all three (\"sweep\") and you collect 3× the stake.",
        "House-rule note: presses (doubling down mid-nine) are not tracked in v1 — handle those on the side."
      ]
    },
    {
      id: "skins",
      name: "Skins",
      players: [2, 3, 4],
      bestWith: [3, 4],
      teams: false,
      needsPar: false,
      needsScores: true,
      holeCounts: [9, 18],
      tags: ["money game", "drama"],
      blurb: "Every hole is worth a skin — but only an outright win takes it. Ties carry the pot.",
      stakeLabel: "$ per skin",
      options: [{ id: "carryovers", label: "Carryovers (ties roll the pot to the next hole)", default: true }],
      rules: [
        "Each hole is worth one skin. The lowest score wins it — but only if it beats everyone outright.",
        "Any tie for low means no skin (with carryovers ON, the skin rolls forward, so the next outright winner can take a multi-skin pot).",
        "A pot still carrying when the round ends goes unclaimed.",
        "Stake (optional): each skin is worth the stake from every other player."
      ]
    },
    {
      id: "bestball",
      name: "Best Ball (2v2)",
      players: [4],
      bestWith: [4],
      teams: true,
      needsPar: false,
      needsScores: true,
      holeCounts: [9, 18],
      tags: ["team", "classic"],
      blurb: "Two teams, everyone plays their own ball — each hole counts only the team's best score.",
      stakeLabel: "$ per player per match",
      rules: [
        "Pick teams of two. Everyone plays their own ball the whole way.",
        "On each hole, a team's score is the LOWER of its two players' scores.",
        "Teams then play match play with those best-ball scores: lower team score wins the hole.",
        "Stake (optional): each player on the losing team pays the stake; tied match pushes."
      ]
    },
    {
      id: "wolf",
      name: "Wolf",
      players: [4],
      bestWith: [4],
      teams: false,
      needsPar: false,
      needsScores: true,
      holeCounts: [9, 18],
      tags: ["team", "strategy", "cult favorite"],
      blurb: "Rotating captain picks a partner after watching tee shots — or goes Lone Wolf for triple points.",
      stakeLabel: "$ per point",
      rules: [
        "Players rotate as the Wolf — a new Wolf each hole, in setup order.",
        "After watching each tee shot, the Wolf may claim that player as a partner (decide immediately, no waiting to see the rest) — or pass on everyone and go LONE WOLF.",
        "Teams then play best ball for the hole: Wolf side vs the rest.",
        "Points: a winning pair gets 1 point each. A winning Lone Wolf gets 3 points. If the Lone Wolf loses, the other three get 1 point each. Tied hole: no points.",
        "Stake (optional): settle the point differences at the stake per point.",
        "House-rule note: the \"last-place player wolfs the final holes\" variant isn't tracked in v1 — rotation just continues."
      ]
    },
    {
      id: "vegas",
      name: "Vegas",
      players: [4],
      bestWith: [4],
      teams: true,
      needsPar: true,
      needsScores: true,
      holeCounts: [9, 18],
      tags: ["team", "money game", "high stakes"],
      blurb: "Team scores pair into a 2-digit number (4 & 5 → 45). Low number wins the difference in points.",
      stakeLabel: "$ per point",
      options: [{ id: "birdieFlip", label: "Birdie flip (a natural birdie flips the losers' number, 45 → 54)", default: true }],
      rules: [
        "Teams of two. On each hole, pair your team's two scores into one number — LOWER score first (a 4 and a 5 makes 45).",
        "The team with the lower number wins the DIFFERENCE in points (45 vs 56 = 11 points).",
        "Birdie flip (optional, brutal): when a team wins the hole with a natural birdie, the losing team's number flips high-digit-first (45 becomes 54).",
        "Scores cap at 9 for number-building, so a blow-up hole maxes the damage.",
        "Stake (optional): each player on the losing side pays the point difference × stake at the end.",
        "Points swing fast — agree on the stake BEFORE the first tee."
      ]
    },
    {
      id: "nines",
      name: "Nines (9 Points)",
      players: [3],
      bestWith: [3],
      teams: false,
      needsPar: false,
      needsScores: true,
      holeCounts: [9, 18],
      tags: ["money game", "the 3-player game"],
      blurb: "THE three-player game. 9 points split every hole: 5 for best, 3 for middle, 1 for worst.",
      stakeLabel: "$ per point",
      rules: [
        "Every hole splits 9 points: 5 to the lowest score, 3 to the middle, 1 to the highest.",
        "Ties split the combined points evenly: two tied for best take 4 each (5+3 split), two tied for worst take 2 each (3+1 split), all square is 3-3-3.",
        "Highest point total after the round wins.",
        "Stake (optional): settle the point differences at the stake per point."
      ]
    },
    {
      id: "stableford",
      name: "Stableford",
      players: [1, 2, 3, 4],
      bestWith: [2, 3],
      teams: false,
      needsPar: true,
      needsScores: true,
      holeCounts: [9, 18],
      tags: ["points", "blow-up proof"],
      blurb: "Points for good holes, nothing for bad ones — one disaster hole can't ruin your day.",
      stakeLabel: "$ per point",
      rules: [
        "Score points on every hole based on par: par = 2 points, birdie = 3, eagle = 4, double-eagle = 5, bogey = 1, double bogey or worse = 0.",
        "Highest point total wins. Because the floor is zero, a blow-up hole costs you nothing extra — keep swinging.",
        "Great equalizer for mixed-skill groups when everyone plays their usual game.",
        "Stake (optional): settle the point differences at the stake per point."
      ]
    },
    {
      id: "bingo",
      name: "Bingo Bango Bongo",
      players: [2, 3, 4],
      bestWith: [2, 3, 4],
      teams: false,
      needsPar: false,
      needsScores: false,
      holeCounts: [9, 18],
      tags: ["mixed skill", "no scores needed"],
      blurb: "3 points a hole: first on the green, closest once everyone's on, first to hole out. Skill optional.",
      stakeLabel: "$ per point",
      rules: [
        "Three points on every hole: BINGO — first ball on the green. BANGO — closest to the pin once every ball is on. BONGO — first ball in the hole.",
        "Play strictly in turn (farthest from the hole plays first) or the whole game falls apart.",
        "Brilliant for mixed-skill groups: a short hitter who's on in 4 can still win all 3 points.",
        "Stake (optional): settle the point differences at the stake per point."
      ]
    }
  ];

  const GAME_BY_ID = Object.fromEntries(GAME_CATALOG.map((g) => [g.id, g]));

  // Games that fit a player count, best-fit games first.
  function gamesForPlayerCount(count) {
    return GAME_CATALOG
      .filter((g) => g.players.includes(count))
      .sort((a, b) => {
        const aBest = a.bestWith.includes(count) ? 0 : 1;
        const bBest = b.bestWith.includes(count) ? 0 : 1;
        return aBest - bBest;
      });
  }

  // ---- Shared helpers ------------------------------------------------------

  function holeComplete(hole, playerIds) {
    return playerIds.every((pid) => {
      const s = hole.scores && hole.scores[pid];
      return Number.isFinite(s) && s > 0;
    });
  }

  // ---- Match play core (used by matchplay, nassau, bestball) ---------------
  //
  // `sides` is [{id, scoreFor(hole)}, {id, scoreFor(hole)}]. Returns running
  // match state. Holes after a closeout are ignored (the match is over).

  function computeMatchCore(holes, sides, totalHoles) {
    let diff = 0; // positive = side 0 up
    let thru = 0;
    let closedAt = null;
    const holeResults = [];
    const playable = [...holes].sort((a, b) => a.number - b.number);
    for (const hole of playable) {
      const a = sides[0].scoreFor(hole);
      const b = sides[1].scoreFor(hole);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (closedAt !== null) break;
      thru += 1;
      const winner = a < b ? 0 : b < a ? 1 : null;
      if (winner === 0) diff += 1;
      if (winner === 1) diff -= 1;
      holeResults.push({ number: hole.number, winner });
      const remaining = totalHoles - thru;
      if (Math.abs(diff) > remaining) {
        closedAt = { up: Math.abs(diff), toPlay: remaining };
        break;
      }
    }
    const remaining = totalHoles - thru;
    const leader = diff > 0 ? 0 : diff < 0 ? 1 : null;
    let status;
    if (closedAt) {
      status = `${closedAt.up}&${closedAt.toPlay}`;
    } else if (thru >= totalHoles) {
      status = diff === 0 ? "AS" : `${Math.abs(diff)} UP`;
    } else if (diff === 0) {
      status = thru === 0 ? "" : "AS";
    } else if (Math.abs(diff) === remaining) {
      status = `${Math.abs(diff)} UP · dormie`;
    } else {
      status = `${Math.abs(diff)} UP`;
    }
    return {
      thru,
      diff,
      leader,                                   // 0 | 1 | null
      done: closedAt !== null || thru >= totalHoles,
      winner: (closedAt !== null || thru >= totalHoles) ? leader : null,
      status,
      holeResults
    };
  }

  function computeMatchPlay(holes, p1, p2, totalHoles) {
    return computeMatchCore(
      holes,
      [
        { id: p1, scoreFor: (h) => h.scores ? h.scores[p1] : null },
        { id: p2, scoreFor: (h) => h.scores ? h.scores[p2] : null }
      ],
      totalHoles
    );
  }

  function computeNassau(holes, p1, p2) {
    const front = holes.filter((h) => h.number <= 9);
    const back = holes.filter((h) => h.number >= 10);
    return {
      front: computeMatchPlay(front, p1, p2, 9),
      back: computeMatchPlay(back, p1, p2, 9),
      overall: computeMatchPlay(holes, p1, p2, 18)
    };
  }

  // ---- Skins ----------------------------------------------------------------

  function computeSkins(holes, playerIds, opts) {
    const carryovers = !opts || opts.carryovers !== false;
    const skinsByPlayer = Object.fromEntries(playerIds.map((p) => [p, 0]));
    let carrying = 0;
    const holeOutcomes = [];
    const playable = [...holes].sort((a, b) => a.number - b.number);
    playable.forEach((hole) => {
      if (!holeComplete(hole, playerIds)) return;
      const entries = playerIds.map((pid) => ({ pid, score: hole.scores[pid] }));
      const low = Math.min(...entries.map((e) => e.score));
      const lowEntries = entries.filter((e) => e.score === low);
      const potValue = 1 + (carryovers ? carrying : 0);
      if (lowEntries.length === 1) {
        skinsByPlayer[lowEntries[0].pid] += potValue;
        holeOutcomes.push({ number: hole.number, winner: lowEntries[0].pid, skins: potValue });
        carrying = 0;
      } else {
        holeOutcomes.push({ number: hole.number, winner: null, skins: 0 });
        if (carryovers) carrying += 1;
      }
    });
    return { skinsByPlayer, carrying, holeOutcomes };
  }

  // ---- Best Ball -------------------------------------------------------------

  function teamBest(hole, team) {
    const scores = team
      .map((pid) => hole.scores ? hole.scores[pid] : null)
      .filter((s) => Number.isFinite(s) && s > 0);
    // Both players must have a score for the hole to count — otherwise a
    // mid-entry hole would give the half-entered team an unfair "best".
    return scores.length === team.length ? Math.min(...scores) : null;
  }

  function computeBestBall(holes, teams, totalHoles) {
    return computeMatchCore(
      holes,
      [
        { id: "A", scoreFor: (h) => teamBest(h, teams[0]) },
        { id: "B", scoreFor: (h) => teamBest(h, teams[1]) }
      ],
      totalHoles
    );
  }

  // ---- Wolf -------------------------------------------------------------------

  function computeWolf(holes, playerIds) {
    const pointsByPlayer = Object.fromEntries(playerIds.map((p) => [p, 0]));
    const holeOutcomes = [];
    const playable = [...holes].sort((a, b) => a.number - b.number);
    playable.forEach((hole) => {
      const pick = hole.wolf;
      if (!pick || !pick.wolfId) return;
      if (!holeComplete(hole, playerIds)) return;
      const wolfSide = pick.lone || !pick.partnerId
        ? [pick.wolfId]
        : [pick.wolfId, pick.partnerId];
      const packSide = playerIds.filter((p) => !wolfSide.includes(p));
      const wolfBest = Math.min(...wolfSide.map((p) => hole.scores[p]));
      const packBest = Math.min(...packSide.map((p) => hole.scores[p]));
      let outcome;
      if (wolfBest < packBest) {
        const pts = wolfSide.length === 1 ? 3 : 1;
        wolfSide.forEach((p) => { pointsByPlayer[p] += pts; });
        outcome = { winner: "wolf", points: pts };
      } else if (packBest < wolfBest) {
        packSide.forEach((p) => { pointsByPlayer[p] += 1; });
        outcome = { winner: "pack", points: 1 };
      } else {
        outcome = { winner: null, points: 0 };
      }
      holeOutcomes.push({ number: hole.number, lone: wolfSide.length === 1, ...outcome });
    });
    return { pointsByPlayer, holeOutcomes };
  }

  // The wolf for a given hole index (0-based), rotating through setup order.
  function wolfForHole(playerIds, holeIndex) {
    return playerIds[holeIndex % playerIds.length];
  }

  // ---- Vegas -------------------------------------------------------------------

  function vegasNumber(scores, flipped) {
    // Cap at 9 so number-building stays 2-digit (and a 12 can't somehow
    // help by colliding into weird concatenation).
    const a = Math.min(9, scores[0]);
    const b = Math.min(9, scores[1]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return flipped ? hi * 10 + lo : lo * 10 + hi;
  }

  function computeVegas(holes, teams, opts) {
    const birdieFlip = !opts || opts.birdieFlip !== false;
    let points = 0; // positive = team A up
    const holeOutcomes = [];
    const allIds = [...teams[0], ...teams[1]];
    const playable = [...holes].sort((a, b) => a.number - b.number);
    playable.forEach((hole) => {
      if (!holeComplete(hole, allIds)) return;
      const sA = teams[0].map((p) => hole.scores[p]);
      const sB = teams[1].map((p) => hole.scores[p]);
      // A natural birdie (vs par) by the winning side flips the losing
      // side's number. Need par to know what a birdie is.
      const par = Number.isFinite(hole.par) ? hole.par : 4;
      const aBirdie = sA.some((s) => s <= par - 1);
      const bBirdie = sB.some((s) => s <= par - 1);
      let nA = vegasNumber(sA, false);
      let nB = vegasNumber(sB, false);
      if (birdieFlip) {
        // Determine the pre-flip winner, then flip the loser if the winner
        // had a natural birdie.
        if (nA < nB && aBirdie) nB = vegasNumber(sB, true);
        else if (nB < nA && bBirdie) nA = vegasNumber(sA, true);
      }
      const delta = nB - nA; // positive = A wins points
      points += delta;
      holeOutcomes.push({ number: hole.number, teamANumber: nA, teamBNumber: nB, delta });
    });
    return { points, holeOutcomes };
  }

  // ---- Nines ---------------------------------------------------------------------

  function computeNines(holes, playerIds) {
    if (playerIds.length !== 3) throw new Error("Nines requires exactly 3 players");
    const pointsByPlayer = Object.fromEntries(playerIds.map((p) => [p, 0]));
    const holeOutcomes = [];
    const playable = [...holes].sort((a, b) => a.number - b.number);
    playable.forEach((hole) => {
      if (!holeComplete(hole, playerIds)) return;
      const entries = playerIds.map((pid) => ({ pid, score: hole.scores[pid] }))
        .sort((a, b) => a.score - b.score);
      // Point slots best→worst. Tied players split the slots their
      // positions span (5+3 → 4 each, 3+1 → 2 each, 5+3+1 → 3 each).
      const slots = [5, 3, 1];
      const awarded = {};
      let i = 0;
      while (i < entries.length) {
        let j = i;
        while (j + 1 < entries.length && entries[j + 1].score === entries[i].score) j += 1;
        const groupSlots = slots.slice(i, j + 1);
        const share = groupSlots.reduce((s, v) => s + v, 0) / (j - i + 1);
        for (let k = i; k <= j; k++) awarded[entries[k].pid] = share;
        i = j + 1;
      }
      playerIds.forEach((pid) => { pointsByPlayer[pid] += awarded[pid]; });
      holeOutcomes.push({ number: hole.number, awarded });
    });
    return { pointsByPlayer, holeOutcomes };
  }

  // ---- Stableford -----------------------------------------------------------------

  function stablefordPoints(score, par) {
    const diff = score - par;
    if (diff >= 2) return 0;
    if (diff === 1) return 1;
    if (diff === 0) return 2;
    if (diff === -1) return 3;
    if (diff === -2) return 4;
    return 5; // -3 or better
  }

  function computeStableford(holes, playerIds) {
    const pointsByPlayer = Object.fromEntries(playerIds.map((p) => [p, 0]));
    holes.forEach((hole) => {
      const par = Number.isFinite(hole.par) ? hole.par : 4;
      playerIds.forEach((pid) => {
        const s = hole.scores ? hole.scores[pid] : null;
        if (Number.isFinite(s) && s > 0) {
          pointsByPlayer[pid] += stablefordPoints(s, par);
        }
      });
    });
    return { pointsByPlayer };
  }

  // ---- Bingo Bango Bongo --------------------------------------------------------------

  function computeBingo(holes, playerIds) {
    const pointsByPlayer = Object.fromEntries(playerIds.map((p) => [p, 0]));
    holes.forEach((hole) => {
      const b = hole.bingo;
      if (!b) return;
      ["bingo", "bango", "bongo"].forEach((slot) => {
        const pid = b[slot];
        if (pid && pointsByPlayer[pid] !== undefined) pointsByPlayer[pid] += 1;
      });
    });
    return { pointsByPlayer };
  }

  // ---- Settlement ------------------------------------------------------------------------
  //
  // Converts final standings + a stake into per-player dollar nets (always
  // zero-sum) and a minimal who-pays-whom transfer list.

  // Point-difference games (nines, stableford, bingo, wolf): every point is
  // worth `stake` against every other player. net_i = stake * (n*p_i - Σp).
  function netsFromPoints(pointsByPlayer, stake) {
    const ids = Object.keys(pointsByPlayer);
    const total = ids.reduce((s, p) => s + pointsByPlayer[p], 0);
    const n = ids.length;
    const nets = {};
    ids.forEach((pid) => {
      nets[pid] = stake * (n * pointsByPlayer[pid] - total);
    });
    return nets;
  }

  function computeSettlement(game, computed, stake) {
    if (!Number.isFinite(stake) || stake <= 0) return null;
    const ids = game.players.map((p) => p.id);
    let nets = Object.fromEntries(ids.map((p) => [p, 0]));

    switch (game.gameType) {
      case "matchplay": {
        if (computed.winner !== null && computed.winner !== undefined) {
          const winner = ids[computed.winner];
          const loser = ids[1 - computed.winner];
          nets[winner] = stake;
          nets[loser] = -stake;
        }
        break;
      }
      case "nassau": {
        ["front", "back", "overall"].forEach((bet) => {
          const m = computed[bet];
          if (m && m.winner !== null && m.winner !== undefined) {
            nets[ids[m.winner]] += stake;
            nets[ids[1 - m.winner]] -= stake;
          }
        });
        break;
      }
      case "skins": {
        // Each skin is worth the stake from every other player.
        const n = ids.length;
        const total = ids.reduce((s, p) => s + computed.skinsByPlayer[p], 0);
        ids.forEach((pid) => {
          const mine = computed.skinsByPlayer[pid];
          nets[pid] = stake * (mine * (n - 1) - (total - mine));
        });
        break;
      }
      case "bestball": {
        if (computed.winner !== null && computed.winner !== undefined) {
          const winners = game.teams[computed.winner];
          const losers = game.teams[1 - computed.winner];
          winners.forEach((pid) => { nets[pid] = stake; });
          losers.forEach((pid) => { nets[pid] = -stake; });
        }
        break;
      }
      case "vegas": {
        // computed.points positive = team A up by that many points.
        const amount = Math.abs(computed.points) * stake;
        if (computed.points !== 0) {
          const winners = computed.points > 0 ? game.teams[0] : game.teams[1];
          const losers = computed.points > 0 ? game.teams[1] : game.teams[0];
          winners.forEach((pid) => { nets[pid] = amount; });
          losers.forEach((pid) => { nets[pid] = -amount; });
        }
        break;
      }
      case "wolf":
      case "nines":
      case "stableford":
      case "bingo": {
        nets = netsFromPoints(computed.pointsByPlayer, stake);
        break;
      }
      default:
        return null;
    }

    return { nets, transfers: settleTransfers(nets) };
  }

  // Greedy debt settlement: biggest debtor pays biggest creditor until
  // everyone is square. Produces at most n-1 transfers.
  function settleTransfers(nets) {
    const EPS = 0.005;
    const creditors = [];
    const debtors = [];
    Object.entries(nets).forEach(([pid, amt]) => {
      if (amt > EPS) creditors.push({ pid, amt });
      else if (amt < -EPS) debtors.push({ pid, amt: -amt });
    });
    creditors.sort((a, b) => b.amt - a.amt);
    debtors.sort((a, b) => b.amt - a.amt);
    const transfers = [];
    let ci = 0, di = 0;
    while (ci < creditors.length && di < debtors.length) {
      const pay = Math.min(creditors[ci].amt, debtors[di].amt);
      transfers.push({
        from: debtors[di].pid,
        to: creditors[ci].pid,
        amount: Math.round(pay * 100) / 100
      });
      creditors[ci].amt -= pay;
      debtors[di].amt -= pay;
      if (creditors[ci].amt <= EPS) ci += 1;
      if (debtors[di].amt <= EPS) di += 1;
    }
    return transfers;
  }

  return {
    GAME_CATALOG,
    GAME_BY_ID,
    gamesForPlayerCount,
    computeMatchPlay,
    computeNassau,
    computeSkins,
    computeBestBall,
    computeWolf,
    wolfForHole,
    computeVegas,
    vegasNumber,
    computeNines,
    computeStableford,
    stablefordPoints,
    computeBingo,
    computeSettlement,
    settleTransfers
  };
});
