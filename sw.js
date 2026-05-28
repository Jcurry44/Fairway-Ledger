// Fairway Ledger service worker.
//
// Strategy: network-first with a cached fallback, plus a precached app shell
// so the whole app keeps working on a phone with zero signal (range trips,
// underground parking garages, dead spots on the course).
//
// Deploy semantics: bump CACHE_VERSION any time you change a file listed in
// CORE_ASSETS. Old cache buckets are deleted on activate. The fetch handler
// already does network-first, so for *most* edits you don't strictly need to
// bump the version — but bumping it is the only way to drop a now-unused
// asset from a returning visitor's cache.

const CACHE_VERSION = 'fairway-ledger-v55-2026-05-26s';

// Paths are relative to the SW's location (./sw.js at the project root).
const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data/courses.js',
  './lib/golf-math.js',
  './lib/shapes.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        // addAll is atomic — if any asset 404s the whole install fails, which
        // is what we want (a half-cached shell is worse than no SW at all).
        cache.addAll(CORE_ASSETS),
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

  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const fresh = await fetch(req);
    // Only cache successful, same-origin "basic" responses. Skip opaque /
    // redirect / error responses so we never serve garbage as a fallback.
    if (fresh && fresh.status === 200 && fresh.type === 'basic') {
      // clone() before reading — the original response gets returned to the
      // page and can only be consumed once.
      cache.put(req, fresh.clone()).catch(() => {
        // Quota errors, etc. — non-fatal. The page still gets `fresh`.
      });
    }
    return fresh;
  } catch (err) {
    // Network failed (offline, DNS, etc.). Try the cache, ignoring the
    // `?v=...` cache-buster so an older cached bundle still satisfies a
    // newer URL.
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;

    // For top-level navigations with no cached entry, fall back to the
    // shell so the app still boots offline.
    if (req.mode === 'navigate') {
      const shell = await caches.match('./index.html', { ignoreSearch: true });
      if (shell) return shell;
    }

    return Response.error();
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
