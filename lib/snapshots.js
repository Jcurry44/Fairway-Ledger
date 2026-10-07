/*
 * Fairway Ledger - rolling snapshots + guarded writes over an injected
 * Storage-like object (getItem/setItem/removeItem/key/length).
 *
 * Data-safety rules this module enforces:
 *   - A failed write never throws and never touches the canonical state key.
 *   - Pruning evicts autosaves first (oldest first), then any other reason
 *     (oldest first), and never the newest PROTECT_NEWEST snapshots.
 *   - Pre-destructive snapshots (before-clear, before-import, ...) outlive
 *     autosaves.
 *
 * Loaded two ways:
 *   - Browser: plain <script> that sets window.FairwaySnapshots.
 *   - Node: require("../lib/snapshots.js") for the test suite.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.FairwaySnapshots = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULTS = {
    prefix: "fairwayLedger.snapshot.v1.",
    max: 20,
    maxBytes: 2500000,
    minIntervalMs: 10 * 60 * 1000,
    protectNewest: 3
  };

  function create(options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const storage = opts.storage;
    const prefix = opts.prefix;
    const clock = typeof opts.now === "function" ? opts.now : Date.now;
    let lastJson = null;
    let lastAt = 0;

    function list() {
      const out = [];
      try {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key || !key.startsWith(prefix)) continue;
          try {
            const text = storage.getItem(key) || "";
            const raw = JSON.parse(text);
            if (!raw || !raw.state) continue;
            out.push({
              key,
              takenAt: raw.takenAt || null,
              reason: raw.reason || "autosave",
              roundCount: Number.isFinite(raw.roundCount)
                ? raw.roundCount
                : (Array.isArray(raw.state.rounds) ? raw.state.rounds.length : 0),
              courseCount: Number.isFinite(raw.courseCount)
                ? raw.courseCount
                : (Array.isArray(raw.state.courses) ? raw.state.courses.length : 0),
              bytes: text.length
            });
          } catch (e) { /* corrupted snapshot: skipped, never thrown */ }
        }
      } catch (e) { /* storage unavailable */ }
      out.sort((a, b) => (b.takenAt || "").localeCompare(a.takenAt || ""));
      return out;
    }

    // Snapshots eligible for deletion, in the order they should go.
    // `snaps` is newest-first. The newest `protect` are never eligible.
    function evictionOrder(snaps, protect) {
      const eligible = snaps.slice(protect).reverse(); // oldest first
      return eligible.filter((s) => s.reason === "autosave")
        .concat(eligible.filter((s) => s.reason !== "autosave"));
    }

    function removeKey(key) {
      try { storage.removeItem(key); return true; } catch (e) { return false; }
    }

    // Count cap (max - extraDrop), then byte cap. Returns number removed.
    function prune(extraDrop, config) {
      const drop = Number(extraDrop) || 0;
      const protect = config && Number.isFinite(config.protectNewest)
        ? config.protectNewest : opts.protectNewest;
      let removed = 0;
      let snaps = list();
      const keepCount = Math.max(0, opts.max - drop);
      if (snaps.length > keepCount) {
        const need = snaps.length - keepCount;
        const victims = evictionOrder(snaps, protect).slice(0, need);
        victims.forEach((v) => { if (removeKey(v.key)) removed++; });
        snaps = list();
      }
      let total = snaps.reduce((sum, s) => sum + s.bytes, 0);
      if (total > opts.maxBytes) {
        for (const v of evictionOrder(snaps, protect)) {
          if (total <= opts.maxBytes) break;
          if (removeKey(v.key)) { removed++; total -= v.bytes; }
        }
      }
      return removed;
    }

    // Remove every autosave snapshot except the newest `protect` overall.
    function pruneAutosaves(protect) {
      const p = Number.isFinite(protect) ? protect : opts.protectNewest;
      let removed = 0;
      list().slice(p).filter((s) => s.reason === "autosave")
        .forEach((s) => { if (removeKey(s.key)) removed++; });
      return removed;
    }

    function take(reason, takeOpts) {
      const o = takeOpts || {};
      const why = reason || "autosave";
      try {
        const stateJson = typeof o.json === "string" ? o.json : null;
        if (stateJson == null) return null;
        const now = clock();
        if (!o.force && why === "autosave") {
          if (stateJson === lastJson) return null;
          if (now - lastAt < opts.minIntervalMs) return null;
        }
        const parsed = JSON.parse(stateJson);
        const takenAt = new Date(now).toISOString();
        const key = prefix + takenAt.replace(/[:.]/g, "-");
        const serialized = JSON.stringify({
          takenAt,
          reason: why,
          roundCount: Array.isArray(parsed.rounds) ? parsed.rounds.length : 0,
          courseCount: Array.isArray(parsed.courses) ? parsed.courses.length : 0,
          state: parsed
        });
        try {
          storage.setItem(key, serialized);
        } catch (quotaErr) {
          prune(3);
          try { storage.setItem(key, serialized); }
          catch (e2) { return null; }
        }
        lastJson = stateJson;
        lastAt = now;
        prune(0);
        return key;
      } catch (e) {
        return null;
      }
    }

    function read(key) {
      try {
        const payload = JSON.parse(storage.getItem(key));
        if (!payload || !payload.state) return null;
        if (!Array.isArray(payload.state.courses) || !Array.isArray(payload.state.rounds)) return null;
        return payload;
      } catch (e) {
        return null;
      }
    }

    function remove(key) {
      return removeKey(key);
    }

    // Guarded write of the canonical state (or any key). Order of escalation:
    //   1. plain write
    //   2. prune snapshots down by 5, retry
    //   3. drop all autosaves except the newest few, retry
    //   4. drop everything except the newest `protectNewest`, retry
    // The key's existing value is never removed; if all attempts fail it is
    // left exactly as it was and { ok: false } is returned.
    function writeGuarded(key, value) {
      try { storage.setItem(key, value); return { ok: true, stage: 0 }; } catch (e) { /* fall through */ }
      prune(5);
      try { storage.setItem(key, value); return { ok: true, stage: 1 }; } catch (e) { /* fall through */ }
      pruneAutosaves(opts.protectNewest);
      try { storage.setItem(key, value); return { ok: true, stage: 2 }; } catch (e) { /* fall through */ }
      list().slice(opts.protectNewest).forEach((s) => removeKey(s.key));
      try { storage.setItem(key, value); return { ok: true, stage: 3 }; } catch (e) { /* fall through */ }
      return { ok: false, stage: 4 };
    }

    // Approximate bytes used (UTF-16: 2 bytes per code unit), all keys.
    function usageBytes() {
      let total = 0;
      try {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key == null) continue;
          total += (key.length + (storage.getItem(key) || "").length) * 2;
        }
      } catch (e) { /* ignore */ }
      return total;
    }

    return { list, prune, pruneAutosaves, take, read, remove, writeGuarded, usageBytes, options: opts };
  }

  return { create, DEFAULTS };
});
