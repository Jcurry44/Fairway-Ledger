# Deerwood hole-source audit

Retrieved 2026-07-14. This audit intentionally excludes the rejected hand-entered hazard data.

## What can be mapped now

The only source-backed geospatial feature ready to publish is the facility reference boundary in `deerwood-reference.geojson`. It comes from OpenStreetMap way 24154378, version 11 (timestamp 2026-07-01T22:15:06Z), and is limited to framing, cropping, and facility context. It is not a surveyed property/play boundary and must not drive hole identity, target selection, or rulings.

No hole-level point, line, or polygon is defensible yet. The official scorecard illustration and flyovers identify each routing visually, but neither contains coordinates or a georeferenced scale. They can validate a trace made against the approved 2024 NYSDOP orthophotography; they cannot by themselves supply tee, green, centerline, target, water, bunker, or other hazard coordinates.

## Official course sources

- Course page: <https://www.deerwoodgc.com/course-details>
- Current hole-yardage scorecard image: <https://static.wixstatic.com/media/acc4c5_da8d3c2d47174d5f8bb53b81d40491aa~mv2.png>
- Current illustrated course-map/rating image: <https://static.wixstatic.com/media/acc4c5_4f11dbd80dd44d709844b9aee5a1d27b~mv2.png>
- Buck rating/length table: <https://static.wixstatic.com/media/acc4c5_9f884c797eae4b7ea28491a28b336e46~mv2.png>
- Doe rating/length table: <https://static.wixstatic.com/media/acc4c5_43f22b361e494f038d9ce33602214301~mv2.png>
- Fawn rating/length table: <https://static.wixstatic.com/media/acc4c5_656b26d301f24864a6f17a6e0b9bbef2~mv2.png>

The official page states that Deerwood has three nine-hole layouts: Buck, Doe, and Fawn. The scorecard provides the routing illustration, hole labels, pars, tee yardages, and handicap rows. Its illustration is useful as a topology/orientation reference only.

## Official hole flyovers

These are the exact links currently published by Deerwood Golf Course / North Tonawanda Parks & Recreation.

| Hole | Official flyover | Hole | Official flyover | Hole | Official flyover |
| --- | --- | --- | --- | --- | --- |
| Buck 1 | <https://youtu.be/PByxPi7Uh9s> | Doe 1 | <https://youtu.be/zOSv6_FURhQ> | Fawn 1 | <https://youtu.be/A2z40zRo0Go> |
| Buck 2 | <https://www.youtube.com/watch?v=0NQdcTmm6YE> | Doe 2 | <https://youtu.be/-2W92JyTVH0> | Fawn 2 | <https://youtu.be/4yEN3elMPZs> |
| Buck 3 | <https://youtu.be/eyBiOHzIr1A> | Doe 3 | <https://youtu.be/O4klU5ubDzE> | Fawn 3 | <https://youtu.be/soAB-4ko-Bo> |
| Buck 4 | <https://youtu.be/YH4BJnJKlYU> | Doe 4 | <https://youtu.be/_oujHNbYGIk> | Fawn 4 | <https://youtu.be/dFnGbrhF_qA> |
| Buck 5 | <https://youtu.be/oHLc_jNJF4g> | Doe 5 | <https://youtu.be/Jq5VlO_SSs4> | Fawn 5 | <https://youtu.be/zA4-80uocmI> |
| Buck 6 | <https://youtu.be/CqnJIRhsMBE> | Doe 6 | <https://youtu.be/tgrwN5XwxeU> | Fawn 6 | <https://youtu.be/FP4pGRteCCI> |
| Buck 7 | <https://www.youtube.com/watch?v=oiHj2BKxW1c> | Doe 7 | <https://youtu.be/KaIY_FsKOIY> | Fawn 7 | <https://youtu.be/Wn2yxMqkbWM> |
| Buck 8 | <https://www.youtube.com/watch?v=l7T4iOJbhAY> | Doe 8 | <https://youtu.be/Z6NNxMnWh5M> | Fawn 8 | <https://youtu.be/P-TjP7n9p0s> |
| Buck 9 | <https://youtu.be/i4mBoUMDDws> | Doe 9 | <https://youtu.be/eHGA9xYR_9c> | Fawn 9 | <https://youtu.be/g4VFnoG10S0> |

## Confidence and next gate

| Evidence | Supports | Confidence | Does not support |
| --- | --- | --- | --- |
| OSM way 24154378 v11 | Facility frame/crop | Reference | Hole identity, aiming, hazards, rulings |
| Official scorecard illustration | Layout identity and rough topology | High for identity; non-geospatial | Exact coordinates or scale |
| Official 27 flyovers | Visual hole-routing validation | High for identity; non-geospatial | Direct GPS coordinates |
| 2024 NYSDOP one-foot imagery | Visible surface-feature tracing | Imagery-traced after manual review | Hole number by itself |

A hole feature should advance to `imagery-traced` only when its visible shape is traced from NYSDOP and its Buck/Doe/Fawn hole identity is matched independently against the scorecard and relevant official flyover. Tee and green observations from play can later advance confidence to `gps-observed` or `field-verified`.
