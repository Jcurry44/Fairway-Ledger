/* Unit tests for lib/gps.js. Run: node --test tests/gps.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const Gps = require("../lib/gps.js");

test("classifyAccuracy applies inclusive 8m and 20m thresholds", () => {
  assert.equal(Gps.classifyAccuracy(0), "good");
  assert.equal(Gps.classifyAccuracy(8), "good");
  assert.equal(Gps.classifyAccuracy(8.01), "caution");
  assert.equal(Gps.classifyAccuracy(20), "caution");
  assert.equal(Gps.classifyAccuracy(20.01), "poor");
  for (const value of [null, undefined, NaN, Infinity, -1, "8"]) {
    assert.equal(Gps.classifyAccuracy(value), "unknown");
  }
});

test("normalizePosition converts a browser GeolocationPosition", () => {
  const position = {
    coords: {
      latitude: 43.04078,
      longitude: -78.83765,
      accuracy: 6.5,
      altitude: 180.25,
      altitudeAccuracy: 9,
      heading: 42,
      speed: 1.2,
    },
    timestamp: Date.UTC(2026, 6, 14, 15, 30, 0),
  };
  assert.deepEqual(Gps.normalizePosition(position), {
    lat: 43.04078,
    lng: -78.83765,
    accuracyM: 6.5,
    altitudeM: 180.25,
    altitudeAccuracyM: 9,
    headingDeg: 42,
    speedMps: 1.2,
    capturedAt: "2026-07-14T15:30:00.000Z",
    source: "gps",
  });
});

test("normalizePosition accepts canonical and GeoJSON inputs and rejects bad coordinates", () => {
  const canonical = Gps.normalizePosition({
    lat: 43,
    lng: -78,
    accuracyM: 14,
    capturedAt: "2026-07-14T16:00:00Z",
    source: "manual",
  });
  assert.equal(canonical.accuracyM, 14);
  assert.equal(canonical.capturedAt, "2026-07-14T16:00:00.000Z");
  assert.equal(canonical.source, "manual");

  const geoJson = Gps.normalizePosition({
    type: "Point",
    coordinates: [-78.8, 43.1],
    accuracyM: 5,
  });
  assert.equal(geoJson.lat, 43.1);
  assert.equal(geoJson.lng, -78.8);
  assert.equal(geoJson.accuracyM, 5);

  assert.equal(Gps.normalizePosition({ lat: 91, lng: 0 }), null);
  assert.equal(Gps.normalizePosition({ lat: 0, lng: -181 }), null);
  assert.equal(Gps.normalizePosition({ coords: { latitude: NaN, longitude: 1 } }), null);
  assert.equal(Gps.normalizePosition(null), null);
});

test("shot helpers preserve additive fields and clone nested positions", () => {
  const input = {
    id: "shot-1",
    club: "Driver",
    sequence: 1,
    start: { lat: 43.04, lng: -78.83, accuracyM: 5, capturedAt: "2026-07-14T12:00:00Z" },
    target: { lat: 43.0405, lng: -78.8305, source: "map-target" },
    finish: { lat: 43.041, lng: -78.831, accuracyM: 11, capturedAt: "2026-07-14T12:04:00Z" },
    futureField: "keep-me",
  };
  const shot = Gps.normalizeShot(input);
  assert.notStrictEqual(shot, input);
  assert.notStrictEqual(shot.start, input.start);
  assert.notStrictEqual(shot.target, input.target);
  assert.notStrictEqual(shot.finish, input.finish);
  assert.equal(shot.startedAt, "2026-07-14T12:00:00.000Z");
  assert.equal(shot.finishedAt, "2026-07-14T12:04:00.000Z");
  assert.equal(shot.futureField, "keep-me");

  input.start.lat = 0;
  input.target.lat = 0;
  input.finish.lng = 0;
  assert.equal(shot.start.lat, 43.04);
  assert.equal(shot.target.lat, 43.0405);
  assert.equal(shot.finish.lng, -78.831);

  const unfinished = Gps.cloneShot({
    id: "shot-live",
    club: "7i",
    start: { latitude: 43, longitude: -78, accuracy: 7 },
    finish: null,
  });
  assert.equal(unfinished.finish, null);
  assert.equal(unfinished.finishedAt, null);
  assert.deepEqual(JSON.parse(JSON.stringify(unfinished)), unfinished);

  const shots = Gps.normalizeShots([input, null]);
  assert.equal(shots.length, 1);
  assert.notStrictEqual(shots[0], input);
  assert.notStrictEqual(shots[0].start, input.start);
  assert.deepEqual(Gps.normalizeShots(null), []);
});

test("requestPosition uses defaults, merges options, and resolves normalized data", async () => {
  const supplied = { timeout: 5000, maximumAge: 1000 };
  let receivedOptions = null;
  const geolocation = {
    getCurrentPosition(success, _failure, options) {
      receivedOptions = options;
      success({
        coords: { latitude: 43, longitude: -78, accuracy: 7 },
        timestamp: Date.UTC(2026, 6, 14),
      });
    },
  };
  const position = await Gps.requestPosition(geolocation, supplied);
  assert.deepEqual(receivedOptions, {
    enableHighAccuracy: true,
    timeout: 5000,
    maximumAge: 1000,
  });
  assert.deepEqual(supplied, { timeout: 5000, maximumAge: 1000 });
  assert.equal(position.lat, 43);
  assert.equal(position.accuracyM, 7);
});

test("requestPosition reports unsupported, provider, and invalid-position failures", async () => {
  await assert.rejects(Gps.requestPosition(null), (error) => error.code === "unsupported");

  const denied = {
    getCurrentPosition(_success, failure) {
      failure({ code: 1, message: "No location permission" });
    },
  };
  await assert.rejects(
    Gps.requestPosition(denied),
    (error) => error.code === "permission-denied" && error.message === "No location permission",
  );

  const timedOut = {
    getCurrentPosition(_success, failure) {
      failure({ code: 3, message: "Timeout expired" });
    },
  };
  await assert.rejects(
    Gps.requestPosition(timedOut),
    (error) => error.code === "timeout" && error.message === "Location capture timed out.",
  );

  const invalid = {
    getCurrentPosition(success) {
      success({ coords: { latitude: 100, longitude: 0, accuracy: 5 } });
    },
  };
  await assert.rejects(Gps.requestPosition(invalid), (error) => error.code === "invalid-position");
});
