/*
 * Fairway Ledger — interactive course-map controller.
 *
 * Keeps pan/zoom, live GPS, aim targets, and shot overlays out of app.js.
 * The controller only consumes trusted map configuration and callbacks from
 * the app; it never reads the rejected legacy hazard arrays.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FairwayCourseMapUi = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function escapeXml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function normalizePosition(value) {
    if (!value || typeof value !== "object") return null;
    const lat = finite(value.lat) ? value.lat : value.latitude;
    const lng = finite(value.lng) ? value.lng : (finite(value.lon) ? value.lon : value.longitude);
    if (!finite(lat) || !finite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { ...value, lat, lng };
  }

  function haversineYards(a, b) {
    const from = normalizePosition(a);
    const to = normalizePosition(b);
    if (!from || !to) return null;
    const radians = (degrees) => degrees * Math.PI / 180;
    const dLat = radians(to.lat - from.lat);
    const dLng = radians(to.lng - from.lng);
    const lat1 = radians(from.lat);
    const lat2 = radians(to.lat);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    const meters = 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return meters * 1.0936132983377078;
  }

  function bearingDegrees(a, b) {
    const from = normalizePosition(a);
    const to = normalizePosition(b);
    if (!from || !to) return null;
    const radians = (degrees) => degrees * Math.PI / 180;
    const lat1 = radians(from.lat);
    const lat2 = radians(to.lat);
    const dLng = radians(to.lng - from.lng);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2)
      - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function compassLabel(degrees) {
    if (!finite(degrees)) return "";
    const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return labels[Math.round(degrees / 45) % labels.length];
  }

  function polygonRings(boundary) {
    if (!boundary || typeof boundary !== "object") return [];
    if (boundary.type === "Feature") return polygonRings(boundary.geometry);
    if (boundary.type === "FeatureCollection") {
      return boundary.features.flatMap((feature) => polygonRings(feature));
    }
    if (boundary.type === "Polygon") return Array.isArray(boundary.coordinates) ? boundary.coordinates : [];
    if (boundary.type === "MultiPolygon") {
      return Array.isArray(boundary.coordinates) ? boundary.coordinates.flat() : [];
    }
    return [];
  }

  function distanceToSegment(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = (dx * dx) + (dy * dy);
    if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
    const amount = Math.max(0, Math.min(1,
      (((point.x - start.x) * dx) + ((point.y - start.y) * dy)) / lengthSquared));
    return Math.hypot(point.x - (start.x + (amount * dx)), point.y - (start.y + (amount * dy)));
  }

  function pointInRing(point, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const currentPoint = ring[index];
      const previousPoint = ring[previous];
      const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y);
      if (!crosses) continue;
      const crossingX = ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)
        / (previousPoint.y - currentPoint.y)) + currentPoint.x;
      if (point.x < crossingX) inside = !inside;
    }
    return inside;
  }

  function createCourseMapController(options) {
    const config = options && options.mapConfig;
    const engine = options && options.engine;
    const elements = options && options.elements;
    if (!config || !engine || !elements) throw new Error("Course map configuration is incomplete.");

    const imageConfig = config.image || config;
    const imageSize = {
      width: Number(imageConfig.width),
      height: Number(imageConfig.height),
    };
    const bounds = imageConfig.projectedBounds || imageConfig.bounds || config.projectedBounds || config.bounds;
    if (!finite(imageSize.width) || !finite(imageSize.height) || !bounds) {
      throw new Error("Course map image metadata is invalid.");
    }

    const labelsApi = (options && options.labelsApi)
      || (typeof globalThis !== "undefined" ? globalThis.FairwayCourseMapLabels : null);
    const labelElements = {
      edit: elements.edit,
      editor: elements.editor,
      featureType: elements.featureType,
      featureLabel: elements.featureLabel,
      editorHint: elements.editorHint,
      undoVertex: elements.undoVertex,
      resetDraft: elements.resetDraft,
      cancelEdit: elements.cancelEdit,
      saveFeature: elements.saveFeature,
      deleteFeature: elements.deleteFeature,
    };
    const labelsMapIdentityMatches = Boolean(labelsApi
      && typeof config.mapId === "string"
      && config.mapId === labelsApi.MAP_ID
      && typeof imageConfig.sha256 === "string"
      && typeof labelsApi.MAP_SHA256 === "string"
      && imageConfig.sha256.toLowerCase() === labelsApi.MAP_SHA256.toLowerCase()
      && config.legacyHazardDataUsed === false);
    const labelsEnabled = Boolean(labelsMapIdentityMatches
      && labelsApi.FEATURE_DEFINITIONS
      && typeof labelsApi.normalizeCollection === "function"
      && typeof labelsApi.featuresForHole === "function"
      && typeof labelsApi.buildDraftFeature === "function"
      && typeof labelsApi.withFeature === "function"
      && typeof labelsApi.removeFeature === "function");
    const seedAnnotations = options && options.seedAnnotations;
    const seedLabelsEnabled = Boolean(labelsEnabled
      && seedAnnotations
      && typeof labelsApi.normalizeSeedCollection === "function"
      && typeof labelsApi.seedFeaturesForHole === "function"
      && typeof labelsApi.normalizeSeedState === "function"
      && typeof labelsApi.hideSeedFeature === "function"
      && typeof labelsApi.isSeedFeature === "function");
    const hasLabelUi = labelsEnabled && Object.values(labelElements).every(Boolean);
    const labelDefinitions = labelsEnabled ? Object.entries(labelsApi.FEATURE_DEFINITIONS) : [];

    const targets = new Map();
    const state = {
      open: false,
      holes: [],
      selectedHole: null,
      position: null,
      view: { scale: 1, x: 0, y: 0 },
      gesture: null,
      imageReady: false,
      locating: false,
      annotations: labelsEnabled ? labelsApi.normalizeCollection(null) : null,
      seedState: seedLabelsEnabled ? labelsApi.normalizeSeedState(null) : null,
      editor: {
        active: false,
        kind: labelDefinitions[0] ? labelDefinitions[0][0] : null,
        points: [],
        selectedId: null,
        lastTapAt: 0,
        lastTapPoint: null,
      },
    };
    // Geolocation cannot be cancelled at the browser API level. Incrementing
    // this token lets close/reopen invalidate an older request so its late
    // result cannot repopulate the map or overwrite the new request's UI.
    let locateGeneration = 0;
    const maxZoom = finite(options.maxZoom) ? options.maxZoom : 9;
    const viewOptions = { padding: 10, maxZoom };

    function viewportSize() {
      const rect = elements.viewport.getBoundingClientRect();
      return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
    }

    function elementPoint(event) {
      const rect = elements.viewport.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function getShots() {
      if (!finite(state.selectedHole) || typeof options.getShots !== "function") return [];
      const shots = options.getShots(state.selectedHole);
      return Array.isArray(shots) ? shots : [];
    }

    function currentTarget() {
      return targets.get(String(state.selectedHole)) || null;
    }

    function currentOrigin(shots) {
      const live = normalizePosition(state.position);
      if (live) return live;
      for (let index = shots.length - 1; index >= 0; index -= 1) {
        const shot = shots[index];
        const finish = normalizePosition(shot && shot.finish);
        if (finish) return finish;
        const start = normalizePosition(shot && shot.start);
        if (start) return start;
      }
      return null;
    }

    function setStatus(message, tone) {
      elements.status.textContent = message || "";
      elements.status.dataset.tone = tone || "";
    }

    function setView(nextView) {
      state.view = engine.constrainView(nextView, imageSize, viewportSize(), viewOptions);
      elements.stage.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`;
      renderLayers();
    }

    function fit() {
      if (!state.open) return;
      const size = viewportSize();
      const fitted = engine.fitView(imageSize, size, viewOptions);
      if (size.width <= 640) {
        // A strict contain-fit of the 3:2 aerial leaves most of a portrait
        // phone viewport empty. Open one zoom step closer while retaining the
        // engine's strict fit as the minimum, so Zoom out still reveals the
        // complete mosaic.
        const focal = { x: size.width / 2, y: size.height / 2 };
        setView(engine.zoomViewAt(fitted, 1.4, focal, imageSize, size, viewOptions));
        return;
      }
      setView(fitted);
    }

    function zoom(factor, focalPoint) {
      if (!state.open) return;
      const size = viewportSize();
      const focal = focalPoint || { x: size.width / 2, y: size.height / 2 };
      setView(engine.zoomViewAt(state.view, factor, focal, imageSize, size, viewOptions));
    }

    function containerPoint(position) {
      const normalized = normalizePosition(position);
      if (!normalized) return null;
      return engine.lonLatToContainerPixel(normalized, bounds, imageSize, state.view);
    }

    function pointVisible(point, margin) {
      if (!point || !finite(point.x) || !finite(point.y)) return false;
      const size = viewportSize();
      const pad = finite(margin) ? margin : 40;
      return point.x >= -pad && point.x <= size.width + pad && point.y >= -pad && point.y <= size.height + pad;
    }

    function boundaryMarkup() {
      const rings = polygonRings(config.boundary);
      return rings.map((ring) => {
        if (!Array.isArray(ring) || ring.length < 3) return "";
        const points = ring.map((coordinate) => {
          if (!Array.isArray(coordinate) || coordinate.length < 2) return null;
          return containerPoint({ lng: Number(coordinate[0]), lat: Number(coordinate[1]) });
        }).filter(Boolean);
        if (points.length < 3) return "";
        const d = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
        return `<path class="course-map-boundary" d="${d} Z"></path>`;
      }).join("");
    }

    function currentHoleIdentity() {
      if (!labelsEnabled || !finite(state.selectedHole)) return null;
      const hole = state.holes.find((item) => Number(item.number) === Number(state.selectedHole));
      const supplied = typeof options.getHoleIdentity === "function"
        ? options.getHoleIdentity(state.selectedHole)
        : null;
      const holeId = typeof labelsApi.holeIdentity === "function"
        ? labelsApi.holeIdentity(supplied || hole)
        : (supplied && supplied.holeId);
      if (!holeId) return null;
      return {
        holeId,
        holeLabel: (supplied && (supplied.holeLabel || supplied.label))
          || (hole && hole.label)
          || `Hole ${state.selectedHole}`,
      };
    }

    function readAnnotations() {
      if (!labelsEnabled) return null;
      const source = typeof options.getAnnotations === "function"
        ? options.getAnnotations()
        : state.annotations;
      state.annotations = labelsApi.normalizeCollection(source);
      return state.annotations;
    }

    function annotationsForCurrentHole() {
      const identity = currentHoleIdentity();
      const collection = readAnnotations();
      if (!identity || !collection) return [];
      return labelsApi.featuresForHole(collection, identity.holeId);
    }

    function readSeedState() {
      if (!seedLabelsEnabled) return null;
      const source = typeof options.getSeedState === "function"
        ? options.getSeedState()
        : state.seedState;
      state.seedState = labelsApi.normalizeSeedState(source);
      return state.seedState;
    }

    function seedAnnotationsForCurrentHole() {
      const identity = currentHoleIdentity();
      if (!identity || !seedLabelsEnabled) return [];
      return labelsApi.seedFeaturesForHole(seedAnnotations, readSeedState(), identity.holeId);
    }

    function visibleAnnotationsForCurrentHole() {
      return [...seedAnnotationsForCurrentHole(), ...annotationsForCurrentHole()];
    }

    function writeAnnotations(collection) {
      if (!labelsEnabled) return;
      state.annotations = labelsApi.normalizeCollection(collection);
      if (typeof options.onAnnotationsChange === "function") {
        options.onAnnotationsChange(state.annotations);
      }
    }

    function writeSeedState(nextSeedState) {
      if (!seedLabelsEnabled) return;
      state.seedState = labelsApi.normalizeSeedState(nextSeedState);
      if (typeof options.onSeedStateChange === "function") {
        options.onSeedStateChange(state.seedState);
      }
    }

    function featurePoints(feature) {
      if (!feature || !feature.geometry) return [];
      const coordinates = feature.geometry.type === "Point"
        ? [feature.geometry.coordinates]
        : (feature.geometry.coordinates && feature.geometry.coordinates[0]) || [];
      return coordinates.map((coordinate) => containerPoint({
        lng: Number(coordinate[0]),
        lat: Number(coordinate[1]),
      })).filter(Boolean);
    }

    function annotationMarkup() {
      if (!labelsEnabled) return "";
      return visibleAnnotationsForCurrentHole().map((feature) => {
        const points = featurePoints(feature);
        if (!points.length) return "";
        const kind = feature.properties.kind;
        const selected = state.editor.selectedId === feature.id ? " is-selected" : "";
        const baseline = seedLabelsEnabled && labelsApi.isSeedFeature(feature);
        const className = `course-map-annotation course-map-annotation--${escapeXml(kind)}${baseline ? " course-map-annotation--baseline" : ""}${selected}`;
        const displayLabel = feature.properties.name || feature.properties.label;
        if (feature.geometry.type === "Point") {
          const point = points[0];
          return `<g class="${className}" data-course-map-annotation-id="${escapeXml(feature.id)}" data-course-map-annotation-source="${baseline ? "aerial-suggestion" : "user"}" transform="translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})"><circle r="9"></circle><path d="M-13 0H13M0-13V13"></path><text x="13" y="-11">${escapeXml(displayLabel)}</text></g>`;
        }
        const openPoints = points.length > 1
          && points[0].x === points[points.length - 1].x
          && points[0].y === points[points.length - 1].y
          ? points.slice(0, -1)
          : points;
        if (openPoints.length < 3) return "";
        const d = openPoints.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
        const center = openPoints.reduce((result, point) => ({
          x: result.x + (point.x / openPoints.length),
          y: result.y + (point.y / openPoints.length),
        }), { x: 0, y: 0 });
        return `<g class="${className}" data-course-map-annotation-id="${escapeXml(feature.id)}" data-course-map-annotation-source="${baseline ? "aerial-suggestion" : "user"}"><path d="${d} Z"></path><text x="${center.x.toFixed(2)}" y="${center.y.toFixed(2)}">${escapeXml(displayLabel)}</text></g>`;
      }).join("");
    }

    function draftAnnotationMarkup() {
      if (!state.editor.active || !state.editor.points.length) return "";
      const definition = labelsEnabled ? labelsApi.FEATURE_DEFINITIONS[state.editor.kind] : null;
      const points = state.editor.points.map((coordinate) => containerPoint({
        lng: coordinate[0],
        lat: coordinate[1],
      })).filter(Boolean);
      if (!definition || !points.length) return "";
      if (definition.geometryType === "Point") {
        const point = points[0];
        return `<g class="course-map-annotation-draft course-map-annotation-draft--point" transform="translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})"><circle r="10"></circle><path d="M-14 0H14M0-14V14"></path></g>`;
      }
      const d = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
      const vertices = points.map((point, index) => `<g class="course-map-annotation-vertex" transform="translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})"><circle r="6"></circle><text x="9" y="-8">${index + 1}</text></g>`).join("");
      return `<path class="course-map-annotation-draft" d="${d}"></path>${vertices}`;
    }

    function annotationAtPoint(point) {
      const features = visibleAnnotationsForCurrentHole();
      for (let index = features.length - 1; index >= 0; index -= 1) {
        const feature = features[index];
        const points = featurePoints(feature);
        if (!points.length) continue;
        if (feature.geometry.type === "Point") {
          if (Math.hypot(point.x - points[0].x, point.y - points[0].y) <= 18) return feature;
          continue;
        }
        const openPoints = points.slice(0, -1);
        for (let segment = 0; segment < openPoints.length; segment += 1) {
          const next = openPoints[(segment + 1) % openPoints.length];
          if (distanceToSegment(point, openPoints[segment], next) <= 10) return feature;
        }
      }
      return null;
    }

    function shotMarkup(shots) {
      return shots.map((shot, index) => {
        const start = normalizePosition(shot && shot.start);
        if (!start) return "";
        const startPoint = containerPoint(start);
        if (!startPoint) return "";
        const finish = normalizePosition(shot.finish);
        const finishPoint = finish ? containerPoint(finish) : null;
        const target = normalizePosition(shot.target);
        const targetPoint = target ? containerPoint(target) : null;
        const pieces = [];
        if (targetPoint) {
          pieces.push(`<line class="course-map-shot-plan" x1="${startPoint.x}" y1="${startPoint.y}" x2="${targetPoint.x}" y2="${targetPoint.y}"></line>`);
        }
        if (finishPoint) {
          pieces.push(`<line class="course-map-shot-line" x1="${startPoint.x}" y1="${startPoint.y}" x2="${finishPoint.x}" y2="${finishPoint.y}"></line>`);
        }
        pieces.push(`<circle class="course-map-shot-start" cx="${startPoint.x}" cy="${startPoint.y}" r="5"></circle>`);
        if (finishPoint) pieces.push(`<circle class="course-map-shot-finish" cx="${finishPoint.x}" cy="${finishPoint.y}" r="6"></circle>`);
        const labelPoint = finishPoint || startPoint;
        const club = escapeXml(shot.club || `Shot ${index + 1}`);
        const distance = finish ? haversineYards(start, finish) : null;
        const label = distance === null ? club : `${club} · ${Math.round(distance)}y`;
        pieces.push(`<text class="course-map-shot-label" x="${labelPoint.x + 9}" y="${labelPoint.y - 9}">${label}</text>`);
        return pieces.join("");
      }).join("");
    }

    function renderTargetSummary(shots) {
      const target = currentTarget();
      elements.clearTarget.hidden = !target;
      if (!target) {
        elements.targetSummary.textContent = "Tap the aerial to set an aim point.";
        return;
      }
      const origin = currentOrigin(shots);
      if (!origin) {
        elements.targetSummary.textContent = "Aim point set. Locate yourself to calculate the distance.";
        return;
      }
      const yards = haversineYards(origin, target);
      const direction = compassLabel(bearingDegrees(origin, target));
      elements.targetSummary.textContent = `${Math.round(yards)} yards ${direction} to aim point`;
    }

    function renderLayers() {
      if (!state.open) return;
      const size = viewportSize();
      elements.svg.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
      const shots = getShots();
      const pieces = [boundaryMarkup(), annotationMarkup(), draftAnnotationMarkup(), shotMarkup(shots)];
      const target = currentTarget();
      const targetPoint = containerPoint(target);
      const origin = currentOrigin(shots);
      const originPoint = containerPoint(origin);
      if (targetPoint && originPoint) {
        pieces.push(`<line class="course-map-current-aim" x1="${originPoint.x}" y1="${originPoint.y}" x2="${targetPoint.x}" y2="${targetPoint.y}"></line>`);
      }
      if (targetPoint) {
        pieces.push(`<g class="course-map-target" transform="translate(${targetPoint.x} ${targetPoint.y})"><circle r="10"></circle><path d="M-14 0H14M0-14V14"></path></g>`);
      }
      const livePoint = containerPoint(state.position);
      if (livePoint && pointVisible(livePoint, 100)) {
        const accuracy = engine.gpsAccuracyCircle(state.position, bounds, imageSize, state.view, { minRadiusPx: 7 });
        if (accuracy) {
          pieces.push(`<circle class="course-map-gps-accuracy" cx="${livePoint.x}" cy="${livePoint.y}" r="${accuracy.radiusPx}"></circle>`);
        }
        pieces.push(`<circle class="course-map-gps-pulse" cx="${livePoint.x}" cy="${livePoint.y}" r="10"></circle>`);
        pieces.push(`<circle class="course-map-gps-dot" cx="${livePoint.x}" cy="${livePoint.y}" r="5"></circle>`);
      }
      elements.svg.innerHTML = pieces.join("");
      renderTargetSummary(shots);
      syncEditorUi();
    }

    function syncEditorUi() {
      if (!labelElements.edit) return;
      labelElements.edit.hidden = !hasLabelUi;
      labelElements.edit.setAttribute("aria-pressed", String(Boolean(state.editor.active)));
      if (!hasLabelUi) return;
      labelElements.editor.hidden = !state.editor.active;
      if (!labelElements.featureType.dataset.definitionsReady) {
        labelElements.featureType.innerHTML = labelDefinitions.map(([kind, definition]) => (
          `<option value="${escapeXml(kind)}">${escapeXml(definition.label)}</option>`
        )).join("");
        labelElements.featureType.dataset.definitionsReady = "true";
      }
      if (state.editor.kind) labelElements.featureType.value = state.editor.kind;
      const definition = labelsApi.FEATURE_DEFINITIONS[state.editor.kind];
      const pointCount = state.editor.points.length;
      const canSave = Boolean(definition
        && ((definition.geometryType === "Point" && pointCount === 1)
          || (definition.geometryType === "Polygon" && pointCount >= 3)));
      labelElements.undoVertex.disabled = pointCount === 0;
      labelElements.resetDraft.disabled = pointCount === 0;
      labelElements.saveFeature.disabled = !canSave;
      labelElements.deleteFeature.disabled = !state.editor.selectedId;
      const selectedFeature = state.editor.selectedId
        ? visibleAnnotationsForCurrentHole().find((feature) => feature.id === state.editor.selectedId)
        : null;
      const selectedSeed = Boolean(selectedFeature && seedLabelsEnabled && labelsApi.isSeedFeature(selectedFeature));
      labelElements.deleteFeature.textContent = selectedSeed ? "Hide suggestion" : "Delete";
      elements.hole.disabled = state.editor.active && pointCount > 0;
      if (selectedSeed) {
        labelElements.editorHint.textContent = "Aerial suggestion selected. Hide it everywhere if the 2024 trace is not useful.";
      } else if (state.editor.selectedId) {
        labelElements.editorHint.textContent = "Saved draft selected. Delete it to retrace, or tap elsewhere to begin another label.";
      } else if (!definition) {
        labelElements.editorHint.textContent = "Choose a supported map label.";
      } else if (definition.geometryType === "Point") {
        labelElements.editorHint.textContent = pointCount
          ? "Aim spot placed. Save explicitly when it looks right."
          : "Tap once to place a personal aim spot. Draft only; it will never activate automatically.";
      } else {
        labelElements.editorHint.textContent = pointCount
          ? `${pointCount} ${pointCount === 1 ? "vertex" : "vertices"}. Add at least 3, then save the outline explicitly.`
          : `Tap around the visible ${definition.label.toLowerCase()} edge. Draft · traced from 2024 imagery.`;
      }
    }

    function beginAnnotation(kind) {
      if (!labelsEnabled || !labelsApi.FEATURE_DEFINITIONS[kind]) return false;
      const wasActive = state.editor.active;
      state.editor.active = true;
      state.editor.kind = kind;
      state.editor.points = [];
      state.editor.selectedId = null;
      state.editor.lastTapAt = 0;
      state.editor.lastTapPoint = null;
      if (labelElements.featureLabel) labelElements.featureLabel.value = "";
      renderLayers();
      // Revealing the editor reduces the map row height. Refit once after that
      // layout change so the first tracing view never opens on a clipped aerial;
      // later feature-type changes preserve the user's chosen zoom and pan.
      if (!wasActive && typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          if (state.open && state.editor.active) fit();
        });
      }
      return true;
    }

    function undoAnnotationPoint() {
      if (!state.editor.active || !state.editor.points.length) return false;
      state.editor.points.pop();
      renderLayers();
      return true;
    }

    function resetAnnotationDraft() {
      if (!state.editor.active) return false;
      state.editor.points = [];
      state.editor.selectedId = null;
      state.editor.lastTapAt = 0;
      state.editor.lastTapPoint = null;
      renderLayers();
      return true;
    }

    function cancelAnnotation() {
      if (!state.editor.active && !state.editor.points.length && !state.editor.selectedId) return false;
      state.editor.active = false;
      state.editor.points = [];
      state.editor.selectedId = null;
      state.editor.lastTapAt = 0;
      state.editor.lastTapPoint = null;
      elements.hole.disabled = false;
      if (labelElements.featureLabel) labelElements.featureLabel.value = "";
      renderLayers();
      return true;
    }

    function makeAnnotationId() {
      const randomPart = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      return `ann-${randomPart}`;
    }

    function commitAnnotation(label) {
      if (!labelsEnabled || !state.editor.active) return null;
      const identity = currentHoleIdentity();
      const definition = labelsApi.FEATURE_DEFINITIONS[state.editor.kind];
      if (!identity || !definition) {
        setStatus("Select a recognized Deerwood hole before saving this label.", "error");
        return null;
      }
      const enoughPoints = definition.geometryType === "Point"
        ? state.editor.points.length === 1
        : state.editor.points.length >= 3;
      if (!enoughPoints) {
        setStatus(definition.geometryType === "Point" ? "Place the aim spot first." : "Add at least three outline vertices.", "warning");
        return null;
      }
      const now = new Date().toISOString();
      const name = typeof label === "string" ? label.trim().replace(/\s+/g, " ") : "";
      const geometry = definition.geometryType === "Point"
        ? { type: "Point", coordinates: [...state.editor.points[0]] }
        : { type: "Polygon", coordinates: [state.editor.points.map((coordinate) => [...coordinate])] };
      const feature = labelsApi.buildDraftFeature({
        id: makeAnnotationId(),
        holeId: identity.holeId,
        kind: state.editor.kind,
        geometry,
        ...(name ? { name } : {}),
        createdAt: now,
        updatedAt: now,
      });
      if (!feature) {
        setStatus("That outline is invalid or crosses itself. Undo a point and try again.", "error");
        return null;
      }
      const next = labelsApi.withFeature(readAnnotations(), feature);
      writeAnnotations(next);
      state.editor.points = [];
      state.editor.selectedId = feature.id;
      state.editor.lastTapAt = 0;
      state.editor.lastTapPoint = null;
      if (labelElements.featureLabel) labelElements.featureLabel.value = "";
      setStatus(`${feature.properties.label} saved as a draft aerial trace.`, "success");
      renderLayers();
      return feature;
    }

    function selectAnnotation(id) {
      if (!labelsEnabled || typeof id !== "string") return null;
      const feature = visibleAnnotationsForCurrentHole().find((item) => item.id === id);
      if (!feature) return null;
      state.editor.active = true;
      state.editor.points = [];
      state.editor.selectedId = feature.id;
      state.editor.kind = feature.properties.kind;
      if (labelElements.featureLabel) labelElements.featureLabel.value = feature.properties.name || "";
      renderLayers();
      return feature;
    }

    function deleteAnnotation(id) {
      if (!labelsEnabled) return false;
      const featureId = typeof id === "string" ? id : state.editor.selectedId;
      const feature = featureId
        ? visibleAnnotationsForCurrentHole().find((item) => item.id === featureId)
        : null;
      if (!feature) return false;
      const seedFeature = seedLabelsEnabled && labelsApi.isSeedFeature(feature);
      if (seedFeature) {
        writeSeedState(labelsApi.hideSeedFeature(readSeedState(), featureId));
      } else {
        writeAnnotations(labelsApi.removeFeature(readAnnotations(), featureId));
      }
      state.editor.selectedId = null;
      state.editor.points = [];
      if (labelElements.featureLabel) labelElements.featureLabel.value = "";
      setStatus(seedFeature ? "Aerial suggestion hidden on this device." : "Draft map label deleted.", "success");
      renderLayers();
      return true;
    }

    function addAnnotationPoint(point) {
      if (!state.editor.active || !labelsEnabled) return false;
      if (!state.editor.points.length) {
        const selectedFeature = annotationAtPoint(point);
        if (selectedFeature) {
          selectAnnotation(selectedFeature.id);
          return true;
        }
      }
      const imagePoint = engine.containerToImagePixel(point, state.view);
      if (imagePoint.x < 0 || imagePoint.y < 0 || imagePoint.x > imageSize.width || imagePoint.y > imageSize.height) return false;
      const now = Date.now();
      if (state.editor.lastTapPoint
        && now - state.editor.lastTapAt < 350
        && Math.hypot(point.x - state.editor.lastTapPoint.x, point.y - state.editor.lastTapPoint.y) < 8) {
        return false;
      }
      const lonLat = engine.containerPixelToLonLat(point, bounds, imageSize, state.view);
      if (!lonLat || !finite(lonLat.lng) || !finite(lonLat.lat)) return false;
      const definition = labelsApi.FEATURE_DEFINITIONS[state.editor.kind];
      if (!definition) return false;
      const coordinate = [lonLat.lng, lonLat.lat];
      state.editor.selectedId = null;
      state.editor.points = definition.geometryType === "Point"
        ? [coordinate]
        : [...state.editor.points.slice(0, 199), coordinate];
      state.editor.lastTapAt = now;
      state.editor.lastTapPoint = { ...point };
      renderLayers();
      return true;
    }

    function setSelectedHole(value) {
      const number = Number(value);
      if (!state.holes.some((hole) => Number(hole.number) === number)) return;
      if (state.selectedHole !== number && (state.editor.points.length || state.editor.selectedId)) {
        state.editor.points = [];
        state.editor.selectedId = null;
        state.editor.lastTapAt = 0;
        state.editor.lastTapPoint = null;
      }
      state.selectedHole = number;
      elements.hole.value = String(number);
      const hole = state.holes.find((item) => Number(item.number) === number);
      elements.title.textContent = hole ? `${hole.label || `Hole ${number}`} map` : "Course map";
      renderLayers();
    }

    function setPosition(position) {
      state.position = normalizePosition(position);
      if (typeof options.onPosition === "function") options.onPosition(state.position);
      renderLayers();
    }

    async function locate() {
      if (state.locating || typeof options.requestPosition !== "function") return;
      const generation = ++locateGeneration;
      state.locating = true;
      elements.locate.disabled = true;
      setStatus("Finding your best available GPS position…");
      try {
        const position = await options.requestPosition();
        if (!state.open || generation !== locateGeneration) return;
        setPosition(position);
        const accuracy = finite(position && position.accuracyM) ? ` · ±${Math.round(position.accuracyM)}m` : "";
        setStatus(`Location updated${accuracy}`, position && position.accuracyM > 20 ? "warning" : "success");
      } catch (error) {
        if (!state.open || generation !== locateGeneration) return;
        setStatus(error && error.message ? error.message : "Could not get your location.", "error");
      } finally {
        if (generation === locateGeneration) {
          state.locating = false;
          elements.locate.disabled = false;
        }
      }
    }

    function setTargetFromPoint(point) {
      const imagePoint = engine.containerToImagePixel(point, state.view);
      if (imagePoint.x < 0 || imagePoint.y < 0 || imagePoint.x > imageSize.width || imagePoint.y > imageSize.height) return;
      const lonLat = engine.containerPixelToLonLat(point, bounds, imageSize, state.view);
      const target = normalizePosition({
        lat: lonLat.lat,
        lng: lonLat.lng,
        accuracyM: null,
        capturedAt: new Date().toISOString(),
        source: "map-target",
      });
      targets.set(String(state.selectedHole), target);
      if (typeof options.onTargetChange === "function") options.onTargetChange(state.selectedHole, target);
      renderLayers();
    }

    function clearCurrentTarget() {
      targets.delete(String(state.selectedHole));
      if (typeof options.onTargetChange === "function") options.onTargetChange(state.selectedHole, null);
      renderLayers();
    }

    function populateHoles(holes, requestedHole) {
      state.holes = Array.isArray(holes) ? holes.filter((hole) => finite(Number(hole.number))) : [];
      elements.hole.innerHTML = state.holes.map((hole) => {
        const label = hole.label || `Hole ${hole.number}`;
        return `<option value="${Number(hole.number)}">${escapeXml(label)}</option>`;
      }).join("");
      const preferred = state.holes.some((hole) => Number(hole.number) === Number(requestedHole))
        ? Number(requestedHole)
        : (state.holes[0] ? Number(state.holes[0].number) : null);
      if (preferred !== null) setSelectedHole(preferred);
    }

    function open(input) {
      state.open = true;
      elements.overlay.hidden = false;
      document.body.classList.add("hole-picker-open");
      setStatus("");
      if (input && input.position) setPosition(input.position);
      populateHoles(input && input.holes, input && input.holeNumber);
      elements.image.src = imageConfig.url;
      elements.image.width = imageSize.width;
      elements.image.height = imageSize.height;
      elements.image.alt = config.alt || "2024 aerial view of Deerwood Golf Course";
      elements.stage.style.width = `${imageSize.width}px`;
      elements.stage.style.height = `${imageSize.height}px`;
      elements.attribution.textContent = config.attribution || "";
      requestAnimationFrame(fit);
      if (options.autoLocate !== false) void locate();
      elements.close.focus();
    }

    function close() {
      if (!state.open) return;
      if (state.editor.active || state.editor.points.length || state.editor.selectedId) cancelAnnotation();
      state.open = false;
      state.gesture = null;
      locateGeneration += 1;
      state.locating = false;
      state.position = null;
      elements.locate.disabled = false;
      elements.overlay.hidden = true;
      document.body.classList.remove("hole-picker-open");
      if (typeof options.onClose === "function") options.onClose();
    }

    function refresh() {
      renderLayers();
    }

    function getTarget(holeNumber) {
      const target = targets.get(String(holeNumber));
      return target ? { ...target } : null;
    }

    function clearTargets() {
      targets.clear();
      renderLayers();
    }

    elements.close.addEventListener("click", close);
    elements.backdrop.addEventListener("click", close);
    elements.fit.addEventListener("click", fit);
    elements.zoomIn.addEventListener("click", () => zoom(1.4));
    elements.zoomOut.addEventListener("click", () => zoom(1 / 1.4));
    elements.locate.addEventListener("click", () => void locate());
    elements.clearTarget.addEventListener("click", clearCurrentTarget);
    elements.hole.addEventListener("change", () => setSelectedHole(elements.hole.value));
    if (labelElements.edit) {
      labelElements.edit.addEventListener("click", () => {
        if (state.editor.active) cancelAnnotation();
        else beginAnnotation(labelElements.featureType && labelElements.featureType.value
          ? labelElements.featureType.value
          : state.editor.kind);
      });
    }
    if (labelElements.featureType) {
      labelElements.featureType.addEventListener("change", () => beginAnnotation(labelElements.featureType.value));
    }
    if (labelElements.undoVertex) labelElements.undoVertex.addEventListener("click", undoAnnotationPoint);
    if (labelElements.resetDraft) labelElements.resetDraft.addEventListener("click", resetAnnotationDraft);
    if (labelElements.cancelEdit) labelElements.cancelEdit.addEventListener("click", cancelAnnotation);
    if (labelElements.saveFeature) {
      labelElements.saveFeature.addEventListener("click", () => commitAnnotation(labelElements.featureLabel.value));
    }
    if (labelElements.deleteFeature) labelElements.deleteFeature.addEventListener("click", () => deleteAnnotation());
    elements.image.addEventListener("load", () => {
      state.imageReady = true;
      fit();
    });
    elements.image.addEventListener("error", () => setStatus("The offline aerial could not be loaded.", "error"));

    elements.viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const point = elementPoint(event);
      state.gesture = { id: event.pointerId, start: point, last: point, moved: false };
      elements.viewport.setPointerCapture(event.pointerId);
    });
    elements.viewport.addEventListener("pointermove", (event) => {
      if (!state.gesture || state.gesture.id !== event.pointerId) return;
      const point = elementPoint(event);
      const dx = point.x - state.gesture.last.x;
      const dy = point.y - state.gesture.last.y;
      if (Math.hypot(point.x - state.gesture.start.x, point.y - state.gesture.start.y) > 5) state.gesture.moved = true;
      state.gesture.last = point;
      setView(engine.panView(state.view, { x: dx, y: dy }, imageSize, viewportSize(), viewOptions));
    });
    elements.viewport.addEventListener("pointerup", (event) => {
      if (!state.gesture || state.gesture.id !== event.pointerId) return;
      const gesture = state.gesture;
      state.gesture = null;
      if (elements.viewport.hasPointerCapture(event.pointerId)) elements.viewport.releasePointerCapture(event.pointerId);
      if (!gesture.moved) {
        const point = elementPoint(event);
        if (state.editor.active) addAnnotationPoint(point);
        else setTargetFromPoint(point);
      }
    });
    elements.viewport.addEventListener("pointercancel", () => { state.gesture = null; });
    elements.viewport.addEventListener("wheel", (event) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.22 : 1 / 1.22, elementPoint(event));
    }, { passive: false });
    elements.viewport.addEventListener("dblclick", (event) => {
      event.preventDefault();
      if (state.editor.active) return;
      zoom(1.6, elementPoint(event));
    });
    window.addEventListener("resize", () => {
      if (!state.open) return;
      setView(engine.constrainView(state.view, imageSize, viewportSize(), viewOptions));
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.open) close();
    });

    return {
      open,
      close,
      fit,
      locate,
      refresh,
      setPosition,
      getPosition: () => state.position && { ...state.position },
      getTarget,
      clearTargets,
      setSelectedHole,
      beginAnnotation,
      undoAnnotationPoint,
      resetAnnotationDraft,
      commitAnnotation,
      cancelAnnotation,
      selectAnnotation,
      deleteAnnotation,
      isAnnotating: () => state.editor.active,
      isOpen: () => state.open,
    };
  }

  return { createCourseMapController };
});
