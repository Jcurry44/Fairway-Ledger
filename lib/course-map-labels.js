(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FairwayCourseMapLabels = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DATASET = "deerwood-user-map-v1";
  const SEED_DATASET = "deerwood-aerial-observations-v1";
  const SEED_STATE_DATASET = "deerwood-aerial-observations-suppressions-v1";
  const COURSE_ID = "deerwood";
  const COORDINATE_SYSTEM = "WGS84";
  const MAP_ID = "deerwood-aerial-2024";
  const MAP_SHA256 = "5FD178E66F235E7712E231DA2AC42BF466914BD889A2535875461D1CB9A1478A";
  const SOURCE = "manual_trace_nysdop_2024_aerial";
  const CONFIDENCE = "unverified_visual";
  const STRATEGY_SOURCE = "user_strategy";
  const STRATEGY_CONFIDENCE = "personal";
  const STATUS = "draft";
  const HOLE_ASSIGNMENT = "user_selected";
  const SEED_GEOMETRY_SOURCE = "nysdop_2024_aerial_manual_trace";
  const SEED_CLASSIFICATION_SOURCE = "manual_visual_review";
  const SEED_CLASSIFICATION_CONFIDENCE = "high_visual";
  const SEED_OUTLINE_CONFIDENCE = "draft_trace";
  const SEED_HOLE_ASSIGNMENT = "official_scorecard_routing_and_flyover";
  const SEED_RULES_STATUS = "not_official";
  const SEED_STATUS = "draft_aerial_observation";

  const FEATURE_DEFINITIONS = Object.freeze({
    sand_surface: Object.freeze({ label: "Sand / bunker candidate", geometryType: "Polygon" }),
    open_water: Object.freeze({ label: "Visible water", geometryType: "Polygon" }),
    green_surface: Object.freeze({ label: "Green surface", geometryType: "Polygon" }),
    tee_surface: Object.freeze({ label: "Tee surface", geometryType: "Polygon" }),
    tree_canopy: Object.freeze({ label: "Tree canopy", geometryType: "Polygon" }),
    strategy_target: Object.freeze({ label: "Personal aim", geometryType: "Point" })
  });
  const KIND_LABELS = Object.freeze(Object.fromEntries(
    Object.entries(FEATURE_DEFINITIONS).map(([kind, definition]) => [kind, definition.label])
  ));
  const POLYGON_KINDS = Object.freeze([
    "sand_surface",
    "open_water",
    "green_surface",
    "tee_surface",
    "tree_canopy"
  ]);
  const POINT_KINDS = Object.freeze(["strategy_target"]);
  const POLYGON_KIND_SET = new Set(POLYGON_KINDS);
  const POINT_KIND_SET = new Set(POINT_KINDS);

  // Exact inverse-projected corners of the authoritative NYSDOP image footprint.
  // GeoJSON coordinates are [longitude, latitude].
  const MAP_FOOTPRINT = Object.freeze([
    Object.freeze([-78.85003818, 43.046127456]),
    Object.freeze([-78.82759216, 43.046177563]),
    Object.freeze([-78.827548627, 43.035202418]),
    Object.freeze([-78.849990647, 43.03515233])
  ]);

  const GEOMETRY_EPSILON = 1e-12;
  const MIN_POLYGON_AREA = 1e-14;
  const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const SEED_ID_PATTERN = /^seed-v1-[a-z0-9][a-z0-9-]{0,95}$/;
  const HOLE_ID_PATTERN = /^(buck|doe|fawn)-[1-9]$/;

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isFiniteCoordinate(value) {
    return Array.isArray(value)
      && value.length === 2
      && typeof value[0] === "number"
      && Number.isFinite(value[0])
      && typeof value[1] === "number"
      && Number.isFinite(value[1])
      && value[0] >= -180
      && value[0] <= 180
      && value[1] >= -90
      && value[1] <= 90;
  }

  function cloneCoordinate(value) {
    return [value[0], value[1]];
  }

  function coordinatesEqual(left, right) {
    return left[0] === right[0] && left[1] === right[1];
  }

  function cross(a, b, c) {
    return ((b[0] - a[0]) * (c[1] - a[1])) - ((b[1] - a[1]) * (c[0] - a[0]));
  }

  function pointOnSegment(point, start, end) {
    if (Math.abs(cross(start, end, point)) > GEOMETRY_EPSILON) return false;
    return point[0] >= Math.min(start[0], end[0]) - GEOMETRY_EPSILON
      && point[0] <= Math.max(start[0], end[0]) + GEOMETRY_EPSILON
      && point[1] >= Math.min(start[1], end[1]) - GEOMETRY_EPSILON
      && point[1] <= Math.max(start[1], end[1]) + GEOMETRY_EPSILON;
  }

  function pointInsideMap(point) {
    if (!isFiniteCoordinate(point)) return false;
    let inside = false;
    for (let index = 0, previous = MAP_FOOTPRINT.length - 1; index < MAP_FOOTPRINT.length; previous = index++) {
      const currentPoint = MAP_FOOTPRINT[index];
      const previousPoint = MAP_FOOTPRINT[previous];
      if (pointOnSegment(point, previousPoint, currentPoint)) return true;
      const crossesLatitude = (currentPoint[1] > point[1]) !== (previousPoint[1] > point[1]);
      if (!crossesLatitude) continue;
      const crossingLongitude = ((previousPoint[0] - currentPoint[0]) * (point[1] - currentPoint[1])
        / (previousPoint[1] - currentPoint[1])) + currentPoint[0];
      if (point[0] < crossingLongitude) inside = !inside;
    }
    return inside;
  }

  function orientation(a, b, c) {
    const value = cross(a, b, c);
    if (Math.abs(value) <= GEOMETRY_EPSILON) return 0;
    return value > 0 ? 1 : -1;
  }

  function segmentsIntersect(a, b, c, d) {
    const first = orientation(a, b, c);
    const second = orientation(a, b, d);
    const third = orientation(c, d, a);
    const fourth = orientation(c, d, b);
    if (first !== second && third !== fourth && first !== 0 && second !== 0 && third !== 0 && fourth !== 0) {
      return true;
    }
    return (first === 0 && pointOnSegment(c, a, b))
      || (second === 0 && pointOnSegment(d, a, b))
      || (third === 0 && pointOnSegment(a, c, d))
      || (fourth === 0 && pointOnSegment(b, c, d));
  }

  function polygonArea(openRing) {
    // Translate near the origin before summing so small course-scale polygons do
    // not lose their area to cancellation in large longitude/latitude products.
    const origin = openRing[0];
    let twiceArea = 0;
    for (let index = 0; index < openRing.length; index += 1) {
      const current = openRing[index];
      const next = openRing[(index + 1) % openRing.length];
      const currentX = current[0] - origin[0];
      const currentY = current[1] - origin[1];
      const nextX = next[0] - origin[0];
      const nextY = next[1] - origin[1];
      twiceArea += (currentX * nextY) - (nextX * currentY);
    }
    return Math.abs(twiceArea) / 2;
  }

  function hasSelfIntersection(openRing) {
    const segmentCount = openRing.length;
    for (let first = 0; first < segmentCount; first += 1) {
      const firstNext = (first + 1) % segmentCount;
      for (let second = first + 1; second < segmentCount; second += 1) {
        const secondNext = (second + 1) % segmentCount;
        const adjacent = first === second || firstNext === second || secondNext === first;
        if (adjacent) continue;
        if (segmentsIntersect(openRing[first], openRing[firstNext], openRing[second], openRing[secondNext])) {
          return true;
        }
      }
    }
    return false;
  }

  function normalizePointGeometry(geometry) {
    if (!isPlainObject(geometry) || geometry.type !== "Point") return null;
    if (!isFiniteCoordinate(geometry.coordinates) || !pointInsideMap(geometry.coordinates)) return null;
    return { type: "Point", coordinates: cloneCoordinate(geometry.coordinates) };
  }

  function normalizePolygonGeometry(geometry) {
    if (!isPlainObject(geometry) || geometry.type !== "Polygon") return null;
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 1) return null;
    const inputRing = geometry.coordinates[0];
    if (!Array.isArray(inputRing) || inputRing.length < 3) return null;

    const ring = [];
    for (const coordinate of inputRing) {
      if (!isFiniteCoordinate(coordinate) || !pointInsideMap(coordinate)) return null;
      ring.push(cloneCoordinate(coordinate));
    }
    if (ring.length > 1 && coordinatesEqual(ring[0], ring[ring.length - 1])) ring.pop();
    if (ring.length < 3) return null;

    const seen = new Set();
    for (const coordinate of ring) {
      const key = `${coordinate[0]},${coordinate[1]}`;
      if (seen.has(key)) return null;
      seen.add(key);
    }
    if (polygonArea(ring) <= MIN_POLYGON_AREA || hasSelfIntersection(ring)) return null;

    const closedRing = ring.map(cloneCoordinate);
    closedRing.push(cloneCoordinate(ring[0]));
    return { type: "Polygon", coordinates: [closedRing] };
  }

  function normalizeId(value) {
    return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
  }

  function normalizeHoleId(value) {
    return typeof value === "string" && HOLE_ID_PATTERN.test(value) ? value : null;
  }

  function holeIdentity(hole) {
    if (typeof hole === "string") {
      const canonical = normalizeHoleId(hole);
      if (canonical) return canonical;
      const match = /^\s*(buck|doe|fawn)\s+([1-9])\s*$/i.exec(hole);
      return match ? `${match[1].toLowerCase()}-${match[2]}` : null;
    }
    if (!isPlainObject(hole)) return null;

    const direct = normalizeHoleId(hole.holeId);
    if (direct) return direct;
    for (const property of ["label", "name", "title"]) {
      const parsed = holeIdentity(hole[property]);
      if (parsed) return parsed;
    }

    const nine = hole.nineName ?? hole.nine;
    const number = hole.holeNumber ?? hole.number;
    if (typeof nine !== "string" || !Number.isInteger(number) || number < 1 || number > 9) return null;
    return holeIdentity(`${nine} ${number}`);
  }

  function expectedGeometryType(kind) {
    return FEATURE_DEFINITIONS[kind]?.geometryType || null;
  }

  function expectedProvenance(kind) {
    return kind === "strategy_target"
      ? { source: STRATEGY_SOURCE, confidence: STRATEGY_CONFIDENCE }
      : { source: SOURCE, confidence: CONFIDENCE };
  }

  function normalizeTimestamp(value) {
    if (typeof value !== "string") return null;
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) return null;
    return new Date(milliseconds).toISOString() === value ? value : null;
  }

  function normalizeOptionalMetadata(value) {
    const result = {};
    if (Object.prototype.hasOwnProperty.call(value, "name")) {
      if (typeof value.name !== "string" || /[\u0000-\u001F\u007F]/.test(value.name)) return null;
      const name = value.name.trim().replace(/\s+/g, " ");
      if (!name || name.length > 80) return null;
      result.name = name;
    }
    for (const property of ["createdAt", "updatedAt"]) {
      if (!Object.prototype.hasOwnProperty.call(value, property)) continue;
      const timestamp = normalizeTimestamp(value[property]);
      if (!timestamp) return null;
      result[property] = timestamp;
    }
    if (result.createdAt && result.updatedAt && result.updatedAt < result.createdAt) return null;
    return result;
  }

  function canonicalProperties(holeId, kind, optionalMetadata = {}) {
    const provenance = expectedProvenance(kind);
    return {
      dataset: DATASET,
      courseId: COURSE_ID,
      mapId: MAP_ID,
      mapSha256: MAP_SHA256,
      holeId,
      holeAssignment: HOLE_ASSIGNMENT,
      kind,
      label: KIND_LABELS[kind],
      source: provenance.source,
      confidence: provenance.confidence,
      status: STATUS,
      legacyHazardDataUsed: false,
      ...optionalMetadata
    };
  }

  function normalizeFeature(value) {
    if (!isPlainObject(value) || value.type !== "Feature" || value.legacyHazardDataUsed === true) return null;
    const id = normalizeId(value.id);
    const properties = value.properties;
    if (!id || SEED_ID_PATTERN.test(id) || !isPlainObject(properties)) return null;
    if (properties.dataset !== DATASET
      || properties.courseId !== COURSE_ID
      || properties.mapId !== MAP_ID
      || properties.mapSha256 !== MAP_SHA256
      || properties.holeAssignment !== HOLE_ASSIGNMENT
      || properties.status !== STATUS
      || properties.legacyHazardDataUsed !== false) return null;

    const holeId = normalizeHoleId(properties.holeId);
    const kind = typeof properties.kind === "string" ? properties.kind : null;
    const geometryType = expectedGeometryType(kind);
    if (!holeId || !geometryType || properties.label !== KIND_LABELS[kind]) return null;
    const provenance = expectedProvenance(kind);
    if (properties.source !== provenance.source || properties.confidence !== provenance.confidence) return null;
    const optionalMetadata = normalizeOptionalMetadata(properties);
    if (!optionalMetadata) return null;
    const geometry = geometryType === "Point"
      ? normalizePointGeometry(value.geometry)
      : normalizePolygonGeometry(value.geometry);
    if (!geometry) return null;
    return { type: "Feature", id, geometry, properties: canonicalProperties(holeId, kind, optionalMetadata) };
  }

  function buildDraftFeature(input) {
    if (!isPlainObject(input)) return null;
    const holeId = normalizeHoleId(input.holeId);
    const kind = typeof input.kind === "string" ? input.kind : null;
    if (!holeId || !expectedGeometryType(kind)) return null;
    const optionalMetadata = normalizeOptionalMetadata(input);
    if (!optionalMetadata) return null;
    return normalizeFeature({
      type: "Feature",
      id: input.id,
      geometry: input.geometry,
      properties: canonicalProperties(holeId, kind, optionalMetadata)
    });
  }

  function createEmptyCollection() {
    return {
      type: "FeatureCollection",
      dataset: DATASET,
      coordinateSystem: COORDINATE_SYSTEM,
      mapId: MAP_ID,
      mapSha256: MAP_SHA256,
      legacyHazardDataUsed: false,
      features: []
    };
  }

  function hasCanonicalCollectionMetadata(value) {
    return isPlainObject(value)
      && value.type === "FeatureCollection"
      && value.dataset === DATASET
      && value.coordinateSystem === COORDINATE_SYSTEM
      && value.mapId === MAP_ID
      && value.mapSha256 === MAP_SHA256
      && value.legacyHazardDataUsed === false
      && Array.isArray(value.features)
      && !Object.prototype.hasOwnProperty.call(value, "hazards")
      && !Object.prototype.hasOwnProperty.call(value, "legacyHazards");
  }

  function normalizeCollection(value) {
    const result = createEmptyCollection();
    if (value == null) return result;
    if (!hasCanonicalCollectionMetadata(value)) return result;
    const seenIds = new Set();
    for (const candidate of value.features) {
      const feature = normalizeFeature(candidate);
      if (!feature || seenIds.has(feature.id)) continue;
      seenIds.add(feature.id);
      result.features.push(feature);
    }
    return result;
  }

  function featuresForHole(collection, holeId) {
    const canonicalHoleId = normalizeHoleId(holeId);
    if (!canonicalHoleId) return [];
    return normalizeCollection(collection).features
      .filter((feature) => feature.properties.holeId === canonicalHoleId)
      .map((feature) => normalizeFeature(feature));
  }

  function withFeature(collection, candidate) {
    const result = normalizeCollection(collection);
    const feature = normalizeFeature(candidate);
    if (!feature || result.features.some((existing) => existing.id === feature.id)) return result;
    result.features.push(feature);
    return result;
  }

  function removeFeature(collection, id) {
    const result = normalizeCollection(collection);
    const canonicalId = normalizeId(id);
    if (!canonicalId) return result;
    result.features = result.features.filter((feature) => feature.id !== canonicalId);
    return result;
  }

  function normalizeSeedHoleIds(value) {
    if (!Array.isArray(value) || !value.length || value.length > 27) return null;
    const result = [];
    const seen = new Set();
    for (const candidate of value) {
      const holeId = normalizeHoleId(candidate);
      if (!holeId || seen.has(holeId)) return null;
      seen.add(holeId);
      result.push(holeId);
    }
    return result;
  }

  function canonicalSeedProperties(holeIds, kind) {
    return {
      dataset: SEED_DATASET,
      courseId: COURSE_ID,
      mapId: MAP_ID,
      mapSha256: MAP_SHA256,
      holeIds: [...holeIds],
      holeAssignment: SEED_HOLE_ASSIGNMENT,
      kind,
      label: KIND_LABELS[kind],
      geometrySource: SEED_GEOMETRY_SOURCE,
      classificationSource: SEED_CLASSIFICATION_SOURCE,
      classificationConfidence: SEED_CLASSIFICATION_CONFIDENCE,
      outlineConfidence: SEED_OUTLINE_CONFIDENCE,
      rulesStatus: SEED_RULES_STATUS,
      status: SEED_STATUS,
      legacyHazardDataUsed: false
    };
  }

  function normalizeSeedFeature(value) {
    if (!isPlainObject(value) || value.type !== "Feature" || value.legacyHazardDataUsed === true) return null;
    const id = typeof value.id === "string" && SEED_ID_PATTERN.test(value.id) ? value.id : null;
    const properties = value.properties;
    if (!id || !isPlainObject(properties)) return null;
    const kind = properties.kind;
    const holeIds = normalizeSeedHoleIds(properties.holeIds);
    if (!holeIds || !POLYGON_KIND_SET.has(kind) || !["open_water", "sand_surface"].includes(kind)) return null;
    const expected = canonicalSeedProperties(holeIds, kind);
    for (const [property, expectedValue] of Object.entries(expected)) {
      if (property === "holeIds") continue;
      if (properties[property] !== expectedValue) return null;
    }
    if (!Array.isArray(properties.holeIds)
      || properties.holeIds.length !== holeIds.length
      || properties.holeIds.some((holeId, index) => holeId !== holeIds[index])) return null;
    const geometry = normalizePolygonGeometry(value.geometry);
    if (!geometry) return null;
    return { type: "Feature", id, geometry, properties: expected };
  }

  function createEmptySeedCollection() {
    return {
      type: "FeatureCollection",
      dataset: SEED_DATASET,
      coordinateSystem: COORDINATE_SYSTEM,
      mapId: MAP_ID,
      mapSha256: MAP_SHA256,
      legacyHazardDataUsed: false,
      features: []
    };
  }

  function normalizeSeedCollection(value) {
    const result = createEmptySeedCollection();
    if (!isPlainObject(value)
      || value.type !== result.type
      || value.dataset !== result.dataset
      || value.coordinateSystem !== result.coordinateSystem
      || value.mapId !== result.mapId
      || value.mapSha256 !== result.mapSha256
      || value.legacyHazardDataUsed !== false
      || !Array.isArray(value.features)
      || Object.prototype.hasOwnProperty.call(value, "hazards")
      || Object.prototype.hasOwnProperty.call(value, "legacyHazards")) return result;
    const seenIds = new Set();
    for (const candidate of value.features) {
      const feature = normalizeSeedFeature(candidate);
      if (!feature || seenIds.has(feature.id)) continue;
      seenIds.add(feature.id);
      result.features.push(feature);
    }
    return result;
  }

  function createEmptySeedState() {
    return {
      dataset: SEED_STATE_DATASET,
      mapId: MAP_ID,
      mapSha256: MAP_SHA256,
      hiddenFeatureIds: []
    };
  }

  function normalizeSeedState(value) {
    const result = createEmptySeedState();
    if (!isPlainObject(value)
      || value.dataset !== result.dataset
      || value.mapId !== result.mapId
      || value.mapSha256 !== result.mapSha256
      || !Array.isArray(value.hiddenFeatureIds)) return result;
    const seen = new Set();
    for (const candidate of value.hiddenFeatureIds) {
      if (typeof candidate !== "string" || !SEED_ID_PATTERN.test(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      result.hiddenFeatureIds.push(candidate);
    }
    return result;
  }

  function isSeedFeature(value) {
    return Boolean(normalizeSeedFeature(value));
  }

  function seedFeaturesForHole(collection, seedState, holeId) {
    const canonicalHoleId = normalizeHoleId(holeId);
    if (!canonicalHoleId) return [];
    const hidden = new Set(normalizeSeedState(seedState).hiddenFeatureIds);
    return normalizeSeedCollection(collection).features
      .filter((feature) => feature.properties.holeIds.includes(canonicalHoleId) && !hidden.has(feature.id))
      .map((feature) => normalizeSeedFeature(feature));
  }

  function hideSeedFeature(seedState, id) {
    const result = normalizeSeedState(seedState);
    if (typeof id !== "string" || !SEED_ID_PATTERN.test(id) || result.hiddenFeatureIds.includes(id)) return result;
    result.hiddenFeatureIds.push(id);
    return result;
  }

  return Object.freeze({
    DATASET,
    SEED_DATASET,
    SEED_STATE_DATASET,
    COURSE_ID,
    COORDINATE_SYSTEM,
    MAP_ID,
    MAP_SHA256,
    SOURCE,
    CONFIDENCE,
    STRATEGY_SOURCE,
    STRATEGY_CONFIDENCE,
    STATUS,
    HOLE_ASSIGNMENT,
    SEED_GEOMETRY_SOURCE,
    SEED_CLASSIFICATION_SOURCE,
    SEED_CLASSIFICATION_CONFIDENCE,
    SEED_OUTLINE_CONFIDENCE,
    SEED_HOLE_ASSIGNMENT,
    SEED_RULES_STATUS,
    SEED_STATUS,
    FEATURE_DEFINITIONS,
    KIND_LABELS,
    POLYGON_KINDS,
    POINT_KINDS,
    MAP_FOOTPRINT,
    normalizeHoleId,
    holeIdentity,
    buildDraftFeature,
    normalizeFeature,
    normalizeCollection,
    featuresForHole,
    withFeature,
    removeFeature,
    createEmptyCollection,
    normalizeSeedFeature,
    normalizeSeedCollection,
    seedFeaturesForHole,
    isSeedFeature,
    createEmptySeedCollection,
    createEmptySeedState,
    normalizeSeedState,
    hideSeedFeature
  });
});
