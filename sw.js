// c2vocab service worker: makes the installed app work offline.
//
// VERSION and PRECACHE are stamped by `python tools/release.py` (never edit them by hand).
// A new VERSION means a new cache name: the old cache is deleted on activate.
//
// Rules (see CLAUDE.md):
//   - every URL is resolved against the registration scope, never against '/': the site lives
//     under https://<user>.github.io/c2vocab/;
//   - only precached files are served from the cache (plus seeds, network-first);
//   - test.html, js/tests/, tools/ and docs/ are never cached;
//   - no automatic skipWaiting: the page shows a banner and asks with { type: 'SKIP_WAITING' }.

// @release-version
const VERSION = '20261108-130643';
// @release-version-end

// @release-precache
const PRECACHE = [
  './',
  './icons/apple-touch-icon.png',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './index.html',
  './js/app.js',
  './js/backup.js',
  './js/capture.js',
  './js/db.js',
  './js/export.js',
  './js/importer.js',
  './js/merge.js',
  './js/platform.js',
  './js/prompt.js',
  './js/reminder.js',
  './js/seeds.js',
  './js/session.js',
  './js/srs.js',
  './js/stats-lite.js',
  './js/sw-client.js',
  './js/taxonomy.js',
  './js/ui/ajustes.js',
  './js/ui/components.js',
  './js/ui/copias.js',
  './js/ui/explorar.js',
  './js/ui/home.js',
  './js/ui/importar.js',
  './js/ui/papelera.js',
  './js/ui/quickadd.js',
  './js/ui/review.js',
  './js/util.js',
  './js/version.js',
  './manifest.webmanifest',
  './seeds/base.json',
  './styles.css',
  './vendor/dexie.min.js',
];
// @release-precache-end

const CACHE_PREFIX = 'c2vocab-';
const CACHE_NAME = CACHE_PREFIX + VERSION;

/** Absolute URL (string) of a './...' entry, resolved against the service worker scope. */
function scopedUrl(relative) {
  return new URL(relative, self.registration.scope).href;
}

/** Path of a request URL relative to the scope ('js/app.js', 'seeds/base.json', '' for the root); null when outside. */
function relativePath(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scopePath)) return null;
  return url.pathname.slice(scopePath.length);
}

/** Files that must never be cached, whatever the request looks like. */
function isExcluded(rel) {
  return rel === 'test.html' || rel.startsWith('js/tests') || rel.startsWith('tools/') || rel.startsWith('docs/');
}

function isSeed(rel) {
  return rel.startsWith('seeds/') && rel.endsWith('.json') && rel.indexOf('/', 'seeds/'.length) === -1;
}

/**
 * Navigations that mean "open the app": the scope root, index.html, or a path whose last segment has
 * no file extension. A URL typed for a real file (sw.js, seeds/base.json, README.md) is NOT the app
 * shell: it falls through to the normal cache/network branches so the file itself is returned.
 */
function isAppRoute(rel) {
  if (rel === '' || rel === 'index.html') return true;
  const last = rel.slice(rel.lastIndexOf('/') + 1);
  return last.indexOf('.') === -1;
}

// ---------------------------------------------------------------- install

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAll());
});

async function precacheAll() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(
    PRECACHE.map(async (entry) => {
      const url = scopedUrl(entry);
      try {
        // cache: 'reload' bypasses the HTTP cache so the new version gets fresh files.
        const response = await fetch(new Request(url, { cache: 'reload' }));
        if (!response.ok) throw new Error('HTTP ' + response.status);
        await cache.put(url, response);
      } catch (err) {
        // One missing file fails the whole install (loudly): a half-cached version is worse than none.
        console.error('[sw] no se pudo precargar ' + url, err);
        throw err;
      }
    })
  );
}

// ---------------------------------------------------------------- activate

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

// ---------------------------------------------------------------- messages

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ---------------------------------------------------------------- fetch

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return; // media ranges: let the browser handle them
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const rel = relativePath(url);
  if (rel === null || isExcluded(rel)) return;

  if (request.mode === 'navigate' && isAppRoute(rel)) {
    event.respondWith(serveNavigation(request));
    return;
  }
  if (isSeed(rel)) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});

/** App shell: the cached index.html for navigations to the app (see isAppRoute); network as a fallback. */
async function serveNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(scopedUrl('./index.html'), { ignoreSearch: true });
  if (cached) return cached;
  return fetch(request);
}

/** Seeds: fresh copy when online (and remembered), cached copy when offline. */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

/** Everything else inside the scope: cache when precached, network otherwise (never stored). */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  return fetch(request);
}
