(function (root, factory) {
  "use strict";
  const api = typeof module === "object" && module.exports
    ? factory(require("../../lib/course-map.js"))
    : factory(root.FairwayCourseMap);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FairwayDeerwoodAerialLabels = api;
})(typeof self !== "undefined" ? self : this, function (engine) {
  "use strict";

  const DATASET = "deerwood-aerial-observations-v1";
  const MAP_ID = "deerwood-aerial-2024";
  const MAP_SHA256 = "5FD178E66F235E7712E231DA2AC42BF466914BD889A2535875461D1CB9A1478A";
  const IMAGE_SIZE = Object.freeze({ width: 3000, height: 2000 });
  const PROJECTED_BOUNDS = Object.freeze({ minX: 1077000, minY: 1106000, maxX: 1083000, maxY: 1110000 });
  const LABELS = Object.freeze({ open_water: "Visible water", sand_surface: "Sand / bunker candidate" });

  function ring(pixels) {
    if (!engine || typeof engine.imagePixelToLonLat !== "function") return [];
    return pixels.map(([x, y]) => {
      const point = engine.imagePixelToLonLat({ x, y }, PROJECTED_BOUNDS, IMAGE_SIZE);
      return [point.lng, point.lat];
    });
  }

  function feature(id, kind, holeIds, pixels) {
    return {
      type: "Feature",
      id,
      geometry: { type: "Polygon", coordinates: [ring(pixels)] },
      properties: {
        dataset: DATASET,
        courseId: "deerwood",
        mapId: MAP_ID,
        mapSha256: MAP_SHA256,
        holeIds,
        holeAssignment: "official_scorecard_routing_and_flyover",
        kind,
        label: LABELS[kind],
        geometrySource: "nysdop_2024_aerial_manual_trace",
        classificationSource: "manual_visual_review",
        classificationConfidence: "high_visual",
        outlineConfidence: "draft_trace",
        rulesStatus: "not_official",
        status: "draft_aerial_observation",
        legacyHazardDataUsed: false
      }
    };
  }

  const features = [
    feature("seed-v1-water-01", "open_water", ["fawn-4", "fawn-5"], [[1170,279],[1198,264],[1226,274],[1254,258],[1280,275],[1313,271],[1343,288],[1380,286],[1404,305],[1400,326],[1370,340],[1339,335],[1314,349],[1288,333],[1262,348],[1238,332],[1206,339],[1181,322],[1170,279]]),
    feature("seed-v1-water-03", "open_water", ["doe-3", "doe-5"], [[925,520],[971,506],[1025,510],[1068,530],[1076,552],[1052,575],[1007,589],[958,583],[918,564],[902,541],[925,520]]),
    feature("seed-v1-water-04", "open_water", ["doe-3", "doe-6", "doe-2"], [[1350,526],[1401,521],[1444,538],[1462,563],[1450,588],[1417,604],[1371,597],[1338,581],[1323,558],[1350,526]]),
    feature("seed-v1-water-05", "open_water", ["fawn-2", "doe-2"], [[1800,480],[1831,497],[1842,530],[1834,567],[1840,600],[1828,641],[1807,676],[1788,681],[1775,658],[1782,618],[1773,585],[1784,548],[1780,516],[1800,480]]),
    feature("seed-v1-water-06", "open_water", ["fawn-6"], [[1954,547],[1981,556],[1998,579],[1995,612],[1977,643],[1950,652],[1936,632],[1941,602],[1933,576],[1954,547]]),
    feature("seed-v1-water-07", "open_water", ["fawn-7", "fawn-8"], [[2125,585],[2150,596],[2162,620],[2158,646],[2136,659],[2113,649],[2105,623],[2110,600],[2125,585]]),
    feature("seed-v1-water-08", "open_water", ["buck-1", "doe-8"], [[1532,939],[1556,960],[1565,997],[1564,1045],[1558,1085],[1561,1135],[1548,1176],[1526,1189],[1508,1166],[1503,1123],[1509,1079],[1505,1035],[1512,989],[1532,939]]),
    feature("seed-v1-water-09", "open_water", ["buck-5", "buck-6"], [[713,1256],[748,1275],[762,1308],[748,1342],[718,1357],[685,1349],[663,1325],[660,1293],[679,1268],[713,1256]]),
    feature("seed-v1-water-11", "open_water", ["buck-7", "buck-8"], [[1240,1440],[1272,1415],[1313,1418],[1345,1397],[1388,1415],[1420,1411],[1452,1432],[1484,1438],[1495,1465],[1478,1490],[1438,1491],[1400,1507],[1360,1493],[1320,1508],[1282,1492],[1248,1480],[1231,1461],[1240,1440]]),
    feature("seed-v1-water-12", "open_water", ["buck-1", "doe-9"], [[1750,1237],[1780,1250],[1796,1282],[1792,1320],[1772,1353],[1742,1362],[1717,1340],[1711,1304],[1723,1267],[1750,1237]]),
    feature("seed-v1-water-13", "open_water", ["doe-9", "buck-9"], [[2190,1340],[2230,1326],[2278,1335],[2315,1321],[2350,1340],[2380,1368],[2372,1402],[2335,1428],[2295,1438],[2262,1460],[2219,1458],[2187,1438],[2167,1405],[2173,1368],[2190,1340]]),

    feature("seed-v1-sand-01", "sand_surface", ["fawn-4"], [[1098,364],[1107,358],[1121,359],[1133,366],[1131,374],[1118,380],[1105,375],[1098,364]]),
    feature("seed-v1-sand-02", "sand_surface", ["doe-3"], [[939,455],[947,449],[958,451],[964,458],[958,466],[946,467],[939,455]]),
    feature("seed-v1-sand-03", "sand_surface", ["fawn-3"], [[1644,383],[1652,370],[1669,367],[1685,376],[1683,391],[1674,405],[1658,408],[1647,398],[1644,383]]),
    feature("seed-v1-sand-04", "sand_surface", ["fawn-2"], [[1811,406],[1817,397],[1826,400],[1830,411],[1825,421],[1815,418],[1811,406]]),
    feature("seed-v1-sand-05", "sand_surface", ["fawn-2"], [[1867,410],[1872,402],[1882,404],[1886,414],[1881,423],[1871,420],[1867,410]]),
    feature("seed-v1-sand-06", "sand_surface", ["fawn-5"], [[1975,201],[1983,195],[1994,198],[2000,207],[1993,214],[1981,211],[1975,201]]),
    feature("seed-v1-sand-07", "sand_surface", ["fawn-5"], [[1955,245],[1963,237],[1975,240],[1981,249],[1973,257],[1961,255],[1955,245]]),
    feature("seed-v1-sand-08", "sand_surface", ["fawn-7"], [[2276,489],[2284,482],[2298,483],[2307,490],[2301,497],[2287,499],[2276,489]]),
    feature("seed-v1-sand-09", "sand_surface", ["fawn-7"], [[2273,547],[2280,540],[2294,541],[2302,549],[2295,556],[2281,556],[2273,547]]),
    feature("seed-v1-sand-10", "sand_surface", ["fawn-7"], [[2198,639],[2205,630],[2212,634],[2217,624],[2223,635],[2233,637],[2226,646],[2231,654],[2220,652],[2215,659],[2209,650],[2199,652],[2203,644],[2198,639]]),
    feature("seed-v1-sand-11", "sand_surface", ["fawn-8"], [[2229,746],[2238,736],[2247,740],[2254,729],[2260,740],[2269,745],[2263,756],[2254,753],[2248,765],[2240,758],[2230,761],[2229,746]]),
    feature("seed-v1-sand-12", "sand_surface", ["fawn-6"], [[1987,868],[1992,859],[2002,860],[2007,870],[2002,881],[1991,879],[1987,868]]),
    feature("seed-v1-sand-13", "sand_surface", ["fawn-6"], [[1985,899],[1990,888],[2002,887],[2009,897],[2004,908],[1992,911],[1985,899]]),
    feature("seed-v1-sand-14", "sand_surface", ["buck-5"], [[638,1169],[643,1159],[653,1157],[661,1165],[658,1177],[649,1183],[640,1178],[638,1169]]),
    feature("seed-v1-sand-15", "sand_surface", ["buck-5"], [[698,1161],[703,1151],[714,1149],[721,1158],[718,1170],[708,1177],[700,1171],[698,1161]]),
    feature("seed-v1-sand-16", "sand_surface", ["buck-5"], [[768,1223],[774,1210],[784,1208],[792,1218],[789,1231],[779,1238],[770,1233],[768,1223]]),
    feature("seed-v1-sand-17", "sand_surface", ["buck-2"], [[1435,1251],[1440,1242],[1449,1241],[1454,1250],[1450,1261],[1440,1264],[1435,1251]]),
    feature("seed-v1-sand-18", "sand_surface", ["buck-1"], [[1683,1133],[1691,1122],[1705,1117],[1719,1121],[1727,1131],[1721,1143],[1707,1150],[1692,1147],[1683,1133]]),
    feature("seed-v1-sand-19", "sand_surface", ["doe-9"], [[2407,1266],[2414,1256],[2427,1258],[2434,1268],[2428,1279],[2415,1280],[2407,1266]]),
    feature("seed-v1-sand-20", "sand_surface", ["doe-9"], [[2441,1329],[2448,1320],[2461,1321],[2468,1330],[2462,1340],[2449,1341],[2441,1329]]),
    feature("seed-v1-sand-21", "sand_surface", ["doe-9"], [[2467,1363],[2474,1354],[2487,1357],[2493,1367],[2486,1377],[2473,1375],[2467,1363]])
  ];

  return Object.freeze({
    type: "FeatureCollection",
    dataset: DATASET,
    coordinateSystem: "WGS84",
    mapId: MAP_ID,
    mapSha256: MAP_SHA256,
    legacyHazardDataUsed: false,
    features
  });
});
