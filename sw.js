// Fairway Ledger service worker.
//
// Strategy (2026-07-21 rework):
//   - Same-origin subresources: cache-first with background revalidate
//     (stale-while-revalidate). On-course launch speed comes from here —
//     with 1-2 bars of LTE, every asset used to wait on the network before
//     the cache fallback fired; now a cached hit paints immediately and the
//     refresh happens behind it.
//   - Navigations: network-first with a 2.5s cap, then cached shell. The
//     browser's own sw.js update check still runs on every navigation, so a
//     capped-to-cache boot does not delay picking up a new deploy.
//   - Precache stores the SAME versioned URLs the page requests
//     (`app.js?v=...`). The old worker precached query-less URLs that were
//     only fetched at install and then beat fresher runtime `?v=` entries on
//     every ignoreSearch match — which is how a phone could keep running a
//     months-old bundle offline forever.
//
// Deploy semantics: bump ASSET_VERSION *and* every `?v=` in index.html
// together, ALWAYS, for any change to a CORE asset. CACHE_VERSION derives
// from ASSET_VERSION so the bump also rotates the cache bucket. A deploy
// without the bump does not reach offline/flaky-signal users — there is no
// "small enough to skip the bump" edit to core assets.

const ASSET_VERSION = '2026-07-28g'; // must equal the ?v= buster in index.html
const CACHE_VERSION = 'fairway-ledger-v95-' + ASSET_VERSION;

// Assets index.html requests WITH the ?v= buster — precached under the
// exact versioned URL so install always fetches the deployed bytes and
// runtime refreshes replace (never shadow) the install-time entry.
const VERSIONED_ASSETS = [
  './index.html',
  './styles.css',
  './app.js',
  './data/courses.js',
  './data/course-maps/deerwood-runtime.js',
  './lib/golf-math.js',
  './lib/shapes.js',
  './lib/voice-recap.js',
  './lib/gps.js',
  './lib/course-map.js',
  './lib/course-map-labels.js',
  './data/course-maps/deerwood-aerial-labels-v1.js',
  './lib/course-map-ui.js',
  './lib/games.js',
  './manifest.json',
  './icon.svg',
];

// Assets requested with no query string (navigations, JS-loaded media).
const PLAIN_ASSETS = [
  './',
  './assets/maps/deerwood/aerial-2024.webp',
];

const PRECACHE_URLS = [
  ...PLAIN_ASSETS,
  ...VERSIONED_ASSETS.map((path) => `${path}?v=${ASSET_VERSION}`),
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        // addAll is atomic — if any asset 404s the whole install fails, which
        // is what we want (a half-cached shell is worse than no SW at all).
        // cache:'reload' bypasses the HTTP cache: a revalidated 304 (or a
        // max-age-stale copy on GitHub Pages) would otherwise abort the
        // install / precache stale bytes.
        cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' }))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only intercept GETs. Anything else (POST to some future endpoint, etc.)
  // should pass through to the network untouched.
  if (req.method !== 'GET') return;

  // Skip cross-origin requests (fonts, analytics, anything we haven't opted
  // into). Letting the browser handle them avoids caching opaque responses
  // that we can't introspect.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(navigationFetch(event, req));
  } else {
    event.respondWith(staleWhileRevalidate(event, req));
  }
});

function cachePut(cache, req, response) {
  if (response && response.status === 200 && response.type === 'basic') {
    // clone() before reading — the original response gets returned to the
    // page and can only be consumed once. Quota errors are non-fatal.
    cache.put(req, response.clone()).catch(() => {});
  }
  return response;
}

// Subresources: cached bytes paint NOW, the network refreshes behind them.
// An exact (versioned) match is authoritative. A miss goes to the network —
// never straight to an ignoreSearch fallback, so a freshly-deployed
// index.html online always gets freshly-deployed assets, not a stale
// bundle. ignoreSearch is strictly the offline last resort.
async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  const refresh = fetch(req)
    .then((fresh) => cachePut(cache, req, fresh));
  if (cached) {
    event.waitUntil(refresh.catch(() => {}));
    return cached;
  }
  try {
    return await refresh;
  } catch (err) {
    const fallback = await caches.match(req, { ignoreSearch: true });
    if (fallback) return fallback;
    return Response.error();
  }
}

// Navigations: try the network, but never make a golfer on one bar stare at
// a blank screen — after 2.5s serve the cached shell and let the network
// response land in cache for next time.
const NAV_TIMEOUT_MS = 2500;

async function navigationFetch(event, req) {
  const cache = await caches.open(CACHE_VERSION);
  const network = fetch(req)
    .then((fresh) => cachePut(cache, req, fresh));
  try {
    return await Promise.race([
      network,
      new Promise((_, reject) => setTimeout(() => reject(new Error('nav-timeout')), NAV_TIMEOUT_MS)),
    ]);
  } catch (err) {
    // Timed out or offline. Keep the (possibly still-running) fetch alive so
    // a slow success still refreshes the cache for the next open.
    event.waitUntil(network.catch(() => {}));
    const cached = await caches.match(req, { ignoreSearch: true })
      || await caches.match('./index.html', { ignoreSearch: true });
    if (cached) return cached;
    // Nothing cached (first-ever visit on a dead connection): fall through
    // to whatever the network eventually does.
    return network.catch(() => Response.error());
  }
}

// Allow the page to ask the SW to skip waiting (used after the page detects
// an update is available and the user is happy to take it). Not wired up
// yet, but the hook is here for later.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
