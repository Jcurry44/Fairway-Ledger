/*
 * Fairway Ledger — GPS position and shot helpers.
 *
 * Browser usage: window.FairwayGps
 * Tests / Node:  require("../lib/gps.js")
 *
 * The canonical position shape deliberately stores latitude/longitude as
 * plain WGS84 numbers plus the accuracy reported by the device. Accuracy
 * quality is derived at display time so the original measurement is never
 * discarded or made to look more precise than it was.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.FairwayGps = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_POSITION_OPTIONS = Object.freeze({
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 0,
  });

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function readFiniteNumber(source, keys) {
    if (!isObject(source)) return null;
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return null;
  }

  function normalizeOptionalNumber(value, predicate) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return !predicate || predicate(value) ? value : null;
  }

  function normalizeCapturedAt(value) {
    let date = null;
    if (value instanceof Date) {
      date = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      date = new Date(value);
    } else if (typeof value === "string" && value.trim()) {
      date = new Date(value);
    }
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  /**
   * Classify a device-reported horizontal accuracy radius in meters.
   * The raw accuracy should still be persisted; this label is presentation
   * metadata only.
   */
  function classifyAccuracy(accuracyM) {
    if (typeof accuracyM !== "number" || !Number.isFinite(accuracyM) || accuracyM < 0) {
      return "unknown";
    }
    if (accuracyM <= 8) return "good";
    if (accuracyM <= 20) return "caution";
    return "poor";
  }

  /**
   * Convert a browser GeolocationPosition or a previously-normalized,
   * position-like object into Fairway Ledger's JSON-safe WGS84 shape.
   * Returns null when latitude/longitude are absent, invalid, or out of range.
   */
  function normalizePosition(input) {
    if (!isObject(input)) return null;

    const coords = isObject(input.coords) ? input.coords : input;
    let lat = readFiniteNumber(coords, ["latitude", "lat"]);
    let lng = readFiniteNumber(coords, ["longitude", "lng", "lon"]);

    // Accept a GeoJSON Point as another useful position-like input. The
    // canonical output remains lat/lng because that is easiest to consume in
    // the round-entry UI; conversion back to [lng, lat] is unambiguous.
    const point = coords.type === "Point" && Array.isArray(coords.coordinates)
      ? coords.coordinates
      : (input.type === "Point" && Array.isArray(input.coordinates) ? input.coordinates : null);
    if (lat === null && point) lat = normalizeOptionalNumber(point[1]);
    if (lng === null && point) lng = normalizeOptionalNumber(point[0]);

    if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return null;
    }

    const accuracyCandidate = readFiniteNumber(coords, ["accuracyM", "accuracy"]);
    const altitudeCandidate = readFiniteNumber(coords, ["altitudeM", "altitude"]);
    const altitudeAccuracyCandidate = readFiniteNumber(coords, ["altitudeAccuracyM", "altitudeAccuracy"]);
    const headingCandidate = readFiniteNumber(coords, ["headingDeg", "heading"]);
    const speedCandidate = readFiniteNumber(coords, ["speedMps", "speed"]);
    const capturedAt = normalizeCapturedAt(
      input.capturedAt !== undefined ? input.capturedAt
        : (input.timestamp !== undefined ? input.timestamp : coords.capturedAt),
    );
    const sourceValue = typeof input.source === "string"
      ? input.source.trim()
      : (typeof coords.source === "string" ? coords.source.trim() : "");

    return {
      lat,
      lng,
      accuracyM: normalizeOptionalNumber(accuracyCandidate, (value) => value >= 0),
      altitudeM: normalizeOptionalNumber(altitudeCandidate),
      altitudeAccuracyM: normalizeOptionalNumber(altitudeAccuracyCandidate, (value) => value >= 0),
      headingDeg: normalizeOptionalNumber(headingCandidate, (value) => value >= 0 && value <= 360),
      speedMps: normalizeOptionalNumber(speedCandidate, (value) => value >= 0),
      capturedAt,
      source: sourceValue || "gps",
    };
  }

  function clonePosition(input) {
    return normalizePosition(input);
  }

  /**
   * Normalize a shot without generating identity or time values. A shot with
   * finish:null is valid and represents an in-progress shot that can survive
   * an app reload. Unknown top-level fields are preserved for additive schema
   * compatibility; canonical nested positions are always new objects.
   */
  function normalizeShot(input) {
    if (!isObject(input)) return null;
    const start = normalizePosition(input.start);
    const finish = normalizePosition(input.finish);
    const target = normalizePosition(input.target);
    const startedAt = normalizeCapturedAt(input.startedAt) || (start && start.capturedAt) || null;
    const finishedAt = normalizeCapturedAt(input.finishedAt) || (finish && finish.capturedAt) || null;

    return {
      ...input,
      id: typeof input.id === "string" ? input.id : "",
      club: typeof input.club === "string" ? input.club : "",
      startedAt,
      start,
      target,
      finish,
      finishedAt,
    };
  }

  function cloneShot(input) {
    return normalizeShot(input);
  }

  function normalizeShots(input) {
    if (!Array.isArray(input)) return [];
    return input.map(normalizeShot).filter(Boolean);
  }

  function makeRequestError(code, message, cause) {
    const error = new Error(message);
    error.name = "GeolocationError";
    error.code = code;
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function normalizeRequestError(error) {
    const numericCode = error && typeof error.code === "number" ? error.code : null;
    const code = numericCode === 1 ? "permission-denied"
      : numericCode === 2 ? "position-unavailable"
      : numericCode === 3 ? "timeout"
      : "position-error";
    const fallback = code === "permission-denied" ? "Location permission was denied."
      : code === "position-unavailable" ? "Your location is unavailable."
      : code === "timeout" ? "Location capture timed out."
      : "Could not capture your location.";
    const providerMessage = error && typeof error.message === "string" && error.message.trim()
      ? error.message
      : "";
    // Chromium's native timeout text is commonly the terse "Timeout
    // expired." Use the stable product copy for this known case; preserve
    // provider detail for other failures where it can be useful.
    const message = code === "timeout" ? fallback : (providerMessage || fallback);
    return makeRequestError(code, message, error);
  }

  /**
   * Promise wrapper around Geolocation#getCurrentPosition.
   *
   * Pass a geolocation-compatible object for deterministic tests. When it is
   * omitted, the browser's navigator.geolocation is used. Resolves with a
   * normalized position rather than the host GeolocationPosition object.
   */
  function requestPosition(geolocation, options) {
    const provider = geolocation || (
      typeof navigator !== "undefined" && navigator ? navigator.geolocation : null
    );
    const requestOptions = {
      ...DEFAULT_POSITION_OPTIONS,
      ...(isObject(options) ? options : {}),
    };

    return new Promise((resolve, reject) => {
      if (!provider || typeof provider.getCurrentPosition !== "function") {
        reject(makeRequestError("unsupported", "Geolocation is not available on this device."));
        return;
      }

      try {
        provider.getCurrentPosition(
          (position) => {
            const normalized = normalizePosition(position);
            if (!normalized) {
              reject(makeRequestError("invalid-position", "The device returned an invalid location."));
              return;
            }
            resolve(normalized);
          },
          (error) => reject(normalizeRequestError(error)),
          requestOptions,
        );
      } catch (error) {
        reject(normalizeRequestError(error));
      }
    });
  }

  return {
    DEFAULT_POSITION_OPTIONS,
    classifyAccuracy,
    normalizePosition,
    clonePosition,
    normalizeShot,
    cloneShot,
    normalizeShots,
    requestPosition,
  };
});
