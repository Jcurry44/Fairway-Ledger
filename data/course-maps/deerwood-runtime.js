/* Browser-safe runtime metadata generated from the tracked Deerwood sources. */
(function (root) {
  "use strict";

  const boundary = {
    type: "Feature",
    id: "deerwood-facility-reference-boundary",
    properties: {
      featureType: "facility-reference-boundary",
      confidence: "reference",
      sourceId: "osm-way-24154378",
      intendedUse: ["map-framing", "facility-context"],
      notForUse: ["playable-boundary-ruling", "hole-identification", "hazard-placement", "aiming-recommendation"]
    },
    geometry: {
      type: "Polygon",
      coordinates: [[
        [-78.846693, 43.0430207],
        [-78.8440174, 43.042476],
        [-78.8439954, 43.0424756],
        [-78.8395207, 43.0423895],
        [-78.8383526, 43.0419428],
        [-78.8387858, 43.0404606],
        [-78.838877, 43.0402371],
        [-78.838818, 43.0398685],
        [-78.8401484, 43.0398764],
        [-78.8409704, 43.0404686],
        [-78.8430666, 43.0399313],
        [-78.8462799, 43.0400646],
        [-78.8463069, 43.0398943],
        [-78.8462477, 43.0396294],
        [-78.8455772, 43.0384179],
        [-78.8454216, 43.0379591],
        [-78.8443755, 43.0366456],
        [-78.8436924, 43.0362876],
        [-78.8416254, 43.0363152],
        [-78.8415262, 43.0362887],
        [-78.8411311, 43.0362873],
        [-78.8409172, 43.0362688],
        [-78.8407359, 43.0362622],
        [-78.8403318, 43.0362832],
        [-78.8397814, 43.0363399],
        [-78.8294618, 43.0364779],
        [-78.8295501, 43.0383584],
        [-78.8299828, 43.0383562],
        [-78.8301263, 43.0386282],
        [-78.8286029, 43.038632],
        [-78.8290214, 43.0394841],
        [-78.8305304, 43.0394774],
        [-78.8305491, 43.0401608],
        [-78.8300405, 43.0401652],
        [-78.83025, 43.0405368],
        [-78.8295347, 43.0405416],
        [-78.8300068, 43.0415396],
        [-78.831289, 43.0415583],
        [-78.8313014, 43.0419076],
        [-78.8314124, 43.041908],
        [-78.8314392, 43.0424114],
        [-78.8315442, 43.0424113],
        [-78.8315759, 43.0432841],
        [-78.8319651, 43.0432851],
        [-78.8319937, 43.0437868],
        [-78.8330754, 43.0437879],
        [-78.8330931, 43.0442935],
        [-78.8339107, 43.0442948],
        [-78.8339275, 43.0447517],
        [-78.8342185, 43.0447528],
        [-78.834487, 43.0449999],
        [-78.834494, 43.0452657],
        [-78.841071, 43.0452319],
        [-78.8412803, 43.0444988],
        [-78.8421225, 43.0444047],
        [-78.8418113, 43.0437343],
        [-78.844912, 43.0437421],
        [-78.8464194, 43.0436559],
        [-78.8464462, 43.0432285],
        [-78.846693, 43.0430207]
      ]]
    }
  };

  const deerwood = Object.freeze({
    id: "deerwood",
    mapId: "deerwood-aerial-2024",
    name: "Deerwood Golf Course",
    status: "authoritative-aerial-reference-boundary",
    image: Object.freeze({
      url: "./assets/maps/deerwood/aerial-2024.webp",
      width: 3000,
      height: 2000,
      sha256: "5fd178e66f235e7712e231da2ac42bf466914bd889a2535875461d1cb9a1478a",
      projectedBounds: Object.freeze({
        minX: 1077000,
        minY: 1106000,
        maxX: 1083000,
        maxY: 1110000
      })
    }),
    boundary,
    alt: "2024 aerial view of Deerwood Golf Course in North Tonawanda",
    attribution: "Imagery © NYS ITS Geospatial Services, NYSDOP 2024 · Boundary © OpenStreetMap contributors",
    legacyHazardDataUsed: false
  });

  root.FairwayCourseMaps = Object.freeze({
    ...(root.FairwayCourseMaps || {}),
    deerwood
  });
})(typeof self !== "undefined" ? self : this);
