"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Snap = require("../lib/snapshots.js");
const shapes = require("../lib/shapes.js");

const PREFIX = "fairwayLedger.snapshot.v1.";
const CANON = "fairwayLedger.v1";

// Storage double with an optional character quota (counts key+value length).
function makeStorage(quota) {
  const map = new Map();
  const used = () => [...map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    map,
    quota,
    used,
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      const next = used() - (map.has(k) ? k.length + map.get(k).length : 0) + k.length + String(v).length;
      if (this.quota != null && next > this.quota) { const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; }
      map.set(k, String(v));
    },
    removeItem(k) { map.delete(k); }
  };
}

function stateWith(n, pad) {
  return JSON.stringify({ courses: [{ id: "c" }], rounds: Array.from({ length: n }, (_, i) => ({ id: "r" + i, note: "x".repeat(pad || 0) })) });
}
function clock(start) { let t = start; const f = () => t; f.advance = (ms) => { t += ms; }; return f; }
function snapKey(storage, at, reason, state) {
  const takenAt = new Date(at).toISOString();
  const key = PREFIX + takenAt.replace(/[:.]/g, "-");
  storage.setItem(key, JSON.stringify({ takenAt, reason, roundCount: 1, courseCount: 1, state: JSON.parse(state || stateWith(1)) }));
  return key;
}
const T0 = Date.parse("2026-10-01T12:00:00Z");

test("take: writes a snapshot with counts and reason", () => {
  const st = makeStorage(); const now = clock(T0);
  const s = Snap.create({ storage: st, now });
  const key = s.take("manual", { json: stateWith(3) });
  assert.ok(key.startsWith(PREFIX));
  const [row] = s.list();
  assert.equal(row.reason, "manual"); assert.equal(row.roundCount, 3); assert.equal(row.courseCount, 1);
});

test("autosave dedupe: identical JSON is skipped even after the interval", () => {
  const st = makeStorage(); const now = clock(T0);
  const s = Snap.create({ storage: st, now });
  assert.ok(s.take("autosave", { json: stateWith(1) }));
  now.advance(11 * 60 * 1000);
  assert.equal(s.take("autosave", { json: stateWith(1) }), null);
  assert.equal(s.list().length, 1);
});

test("autosave 10-minute throttle; force and non-autosave bypass it", () => {
  const st = makeStorage(); const now = clock(T0);
  const s = Snap.create({ storage: st, now });
  assert.ok(s.take("autosave", { json: stateWith(1) }));
  now.advance(60 * 1000);
  assert.equal(s.take("autosave", { json: stateWith(2) }), null);
  assert.ok(s.take("autosave", { json: stateWith(2), force: true }));
  now.advance(1000);
  assert.ok(s.take("before-clear", { json: stateWith(3) }));
  now.advance(10 * 60 * 1000);
  assert.ok(s.take("autosave", { json: stateWith(4) }));
  assert.equal(s.list().length, 4);
});

test("count cap: never more than max, newest kept", () => {
  const st = makeStorage(); const now = clock(T0);
  const s = Snap.create({ storage: st, now, max: 5 });
  for (let i = 0; i < 9; i++) { now.advance(1000); s.take("manual", { json: stateWith(i + 1) }); }
  const rows = s.list();
  assert.equal(rows.length, 5);
  assert.equal(rows[0].roundCount, 9);
});

test("count cap evicts autosaves before pre-destructive snapshots", () => {
  const st = makeStorage(); const now = clock(T0);
  const s = Snap.create({ storage: st, now, max: 4 });
  now.advance(1000); s.take("before-import", { json: stateWith(1) });
  for (let i = 0; i < 6; i++) { now.advance(1000); s.take("autosave", { json: stateWith(10 + i), force: true }); }
  const rows = s.list();
  assert.equal(rows.length, 4);
  assert.ok(rows.some((r) => r.reason === "before-import"), "oldest pre-destructive snapshot must survive");
});

test("byte cap: prunes oldest autosaves, pre-destructive last, newest protected", () => {
  const st = makeStorage(); const now = clock(T0);
  const s = Snap.create({ storage: st, now, maxBytes: 5000, protectNewest: 2 });
  now.advance(1000); s.take("before-clear", { json: stateWith(1, 400) });
  for (let i = 0; i < 8; i++) { now.advance(1000); s.take("autosave", { json: stateWith(1, 401 + i), force: true }); }
  const rows = s.list();
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  assert.ok(total <= 5000, "under cap, got " + total);
  assert.ok(rows.some((r) => r.reason === "before-clear"));
  assert.equal(rows[0].reason, "autosave");
  assert.ok(rows.length >= 2, "newest two protected");
});

test("quota on take: prunes then retries; canonical key untouched", () => {
  const st = makeStorage(6000); const now = clock(T0);
  st.setItem(CANON, stateWith(2));
  const s = Snap.create({ storage: st, now });
  for (let i = 0; i < 12; i++) { now.advance(1000); s.take("autosave", { json: stateWith(2 + i, 150), force: true }); }
  assert.equal(st.getItem(CANON), stateWith(2));
  assert.ok(s.list().length >= 1);
});

test("take never throws when even the retry fails", () => {
  const st = makeStorage(10); const s = Snap.create({ storage: st });
  assert.equal(s.take("manual", { json: stateWith(1) }), null);
});

test("writeGuarded: success path", () => {
  const st = makeStorage(); const s = Snap.create({ storage: st });
  assert.deepEqual(s.writeGuarded(CANON, "abc"), { ok: true, stage: 0 });
});

test("quota exceeded: writeGuarded prunes snapshots and the round is saved", () => {
  const st = makeStorage(5000); const now = clock(T0);
  const s = Snap.create({ storage: st, now, protectNewest: 2 });
  st.setItem(CANON, stateWith(1));
  for (let i = 0; i < 6; i++) { now.advance(1000); snapKey(st, now(), "autosave", stateWith(1, 300)); }
  st.quota = st.used() + 50; // storage is now effectively full
  const big = stateWith(5, 300);
  assert.throws(() => st.setItem(CANON, big), /Quota/, "precondition: plain write would fail");
  const r = s.writeGuarded(CANON, big);
  assert.equal(r.ok, true); assert.ok(r.stage >= 1);
  assert.equal(st.getItem(CANON), big);
});

test("quota exceeded: pre-destructive snapshots survive early stages", () => {
  const st = makeStorage(8000); const now = clock(T0);
  const s = Snap.create({ storage: st, now, protectNewest: 1 });
  st.setItem(CANON, stateWith(1));
  now.advance(1000); const keep = snapKey(st, now(), "before-import", stateWith(1, 300));
  for (let i = 0; i < 5; i++) { now.advance(1000); snapKey(st, now(), "autosave", stateWith(1, 300)); }
  const r = s.writeGuarded(CANON, stateWith(4, 300));
  assert.equal(r.ok, true);
  assert.ok(st.getItem(keep), "before-import snapshot still present");
});

test("quota exceeded for good: ok:false, old canonical value intact, never removed", () => {
  const st = makeStorage(3000); const s = Snap.create({ storage: st });
  const old = stateWith(1);
  st.setItem(CANON, old);
  const r = s.writeGuarded(CANON, "y".repeat(20000));
  assert.equal(r.ok, false);
  assert.equal(st.getItem(CANON), old);
});

test("corrupted snapshots are skipped by list and read, never thrown", () => {
  const st = makeStorage(); const now = clock(T0);
  const s = Snap.create({ storage: st, now });
  st.setItem(PREFIX + "bad1", "{not json");
  st.setItem(PREFIX + "bad2", JSON.stringify({ takenAt: "x" }));
  st.setItem(PREFIX + "bad3", JSON.stringify({ state: { courses: [] } }));
  now.advance(1000); const good = s.take("manual", { json: stateWith(2) });
  assert.ok(s.list().some((r) => r.key === good));
  assert.ok(!s.list().some((r) => r.key === PREFIX + "bad1" || r.key === PREFIX + "bad2"));
  assert.equal(s.read(PREFIX + "bad1"), null);
  assert.equal(s.read(PREFIX + "bad2"), null);
  assert.equal(s.read(PREFIX + "bad3"), null);
  assert.equal(s.read("missing"), null);
  assert.ok(s.read(good));
  assert.doesNotThrow(() => s.prune(0));
});

test("read + normalizeRound: old bare export loads, unknown fields preserved", () => {
  const oldExport = { courses: [{ id: "ridgeview-blue" }], rounds: [{ id: "r1", date: "2024-05-01", courseId: "ridgeview-blue", holes: [{ number: 1, par: 4, score: 5, mysteryHoleField: "keep" }], futureRoundField: { a: 1 } }], profile: { bag: ["Driver"] } };
  const st = makeStorage(); const s = Snap.create({ storage: st });
  const key = s.take("before-import", { json: JSON.stringify(oldExport), force: true });
  const payload = s.read(key);
  const rounds = payload.state.rounds.map(shapes.normalizeRound);
  assert.equal(rounds[0].id, "r1");
  assert.deepEqual(rounds[0].futureRoundField, { a: 1 });
  assert.equal(rounds[0].holes[0].mysteryHoleField, "keep");
  assert.equal(rounds[0].holes[0].score, 5);
  assert.deepEqual(payload.state.profile, { bag: ["Driver"] });
});

test("export JSON of in-memory state round-trips through take/read losslessly", () => {
  const state = { courses: [{ id: "c", extra: [1, 2] }], rounds: [{ id: "r", holes: [] }], mapAnnotations: { deerwood: { z: 1 } } };
  const st = makeStorage(); const s = Snap.create({ storage: st });
  const key = s.take("manual", { json: JSON.stringify(state) });
  assert.deepEqual(s.read(key).state, state);
});

test("pruneAutosaves removes only autosaves beyond the protected newest", () => {
  const st = makeStorage(); const now = clock(T0);
  const s = Snap.create({ storage: st, now });
  now.advance(1000); s.take("before-clear", { json: stateWith(1), force: true });
  for (let i = 0; i < 4; i++) { now.advance(1000); s.take("autosave", { json: stateWith(2 + i), force: true }); }
  const removed = s.pruneAutosaves(1);
  assert.equal(removed, 3);
  const rows = s.list();
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.reason === "before-clear"));
});

test("usageBytes counts keys and values", () => {
  const st = makeStorage(); const s = Snap.create({ storage: st });
  st.setItem("ab", "cdef");
  assert.equal(s.usageBytes(), 12);
});
