// Logic tests for sw.js, run inside test.html WITHOUT a real service worker (the embedded browser used
// for acceptance refuses to register one). The source of sw.js is fetched and evaluated with
// `new Function`; every global the worker touches is replaced by a small fake (self, caches, fetch,
// console). The scope is a SUB-PATH like GitHub Pages, so the URL-resolution rules are really tested.
//
// Rule for sw.js (CLAUDE.md): worker globals only through explicit `self.*`, and requests read only
// through standard Request fields (url, method, mode, headers, destination, cache, clone), so that the
// fakes below (navigation requests are plain objects) can stand in for the real ones.

import { test, assert, eq, deepEq, throws } from './harness.js';

const SCOPE = 'https://example.test/c2vocab/';

// Files that exist on the fake server but are NOT in PRECACHE.
const EXTRA_FILES = ['sw.js', 'README.md', 'test.html', 'js/tests/x.js', 'tools/x.html', 'docs/x.md', 'js/extra.js', 'seeds/extra.json'];

// Every global sw.js may reach: each becomes a parameter of the sandbox function, so the real window
// globals are never seen. Bare worker globals (addEventListener, registration, clients, skipWaiting,
// location) are passed as undefined ON PURPOSE: using them without `self.` throws inside the sandbox.
// `globalThis` points at the fake self too, so no path leads to the real test window.
const SHADOWED = [
  'self',
  'globalThis',
  'WorkerGlobalScope',
  'ServiceWorkerGlobalScope',
  'window',
  'addEventListener',
  'registration',
  'clients',
  'skipWaiting',
  'caches',
  'fetch',
  'Request',
  'Response',
  'Headers',
  'URL',
  'console',
  'location',
  'setTimeout',
  'setInterval',
  'importScripts',
];

// ---------------------------------------------------------------- fakes

/** URL string of a request (Request, plain { url } or string) without the hash; without the query too when asked. */
function urlKey(request, ignoreSearch) {
  const url = new URL(typeof request === 'string' ? request : request.url);
  url.hash = '';
  if (ignoreSearch) url.search = '';
  return url.href;
}

/** One cache: url -> Response. Stored responses are never consumed, match() hands out clones like the real API. */
class FakeCache {
  constructor(network) {
    this.network = network;
    this.entries = new Map();
  }
  async put(request, response) {
    if (!(response instanceof Response)) throw new TypeError('put: not a Response');
    // Like the real Cache.put: a used body is refused, and the body given is read to the end, so a
    // worker that forgets `.clone()` before `put` can no longer return that response to the page.
    if (response.bodyUsed) throw new TypeError('put: body already used');
    const stored = response.clone();
    await response.arrayBuffer();
    this.entries.set(urlKey(request, false), stored);
  }
  async addAll(requests) {
    const responses = await Promise.all(requests.map((r) => this.network.fetch(r)));
    for (const r of responses) if (!r.ok) throw new TypeError('addAll: a request failed with HTTP ' + r.status);
    requests.forEach((r, i) => this.entries.set(urlKey(r, false), responses[i]));
  }
  async match(request, options = {}) {
    const method = typeof request === 'string' ? 'GET' : request.method || 'GET';
    if (method !== 'GET') return undefined;
    const wanted = urlKey(request, !!options.ignoreSearch);
    for (const [key, response] of this.entries) {
      const candidate = options.ignoreSearch ? urlKey(key, true) : key;
      if (candidate === wanted) return response.clone();
    }
    return undefined;
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

/** The `caches` global: name -> FakeCache. */
class FakeCacheStorage {
  constructor(network) {
    this.network = network;
    this.caches = new Map();
  }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache(this.network));
    return this.caches.get(name);
  }
  async has(name) {
    return this.caches.has(name);
  }
  async delete(name) {
    return this.caches.delete(name);
  }
  async keys() {
    return [...this.caches.keys()];
  }
  async match(request, options) {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(request, options);
      if (hit) return hit;
    }
    return undefined;
  }
}

/** The network: url (no query) -> { status, body, type }; `offline` makes fetch reject like a browser does. */
class FakeNetwork {
  constructor() {
    this.table = new Map();
    this.offline = false;
    this.calls = []; // { url, cache, mode } for every fetch, in order
  }
  set(url, { status = 200, body = '', type = 'text/plain' } = {}) {
    this.table.set(urlKey(url, true), { status, body, type });
  }
  async fetch(request) {
    const isObject = typeof request !== 'string';
    this.calls.push({
      url: urlKey(request, false),
      cache: isObject && request.cache ? request.cache : null,
      mode: isObject && request.mode ? request.mode : null,
    });
    if (this.offline) throw new TypeError('Failed to fetch (offline)');
    const entry = this.table.get(urlKey(request, true));
    if (!entry) return new Response('not found', { status: 404 });
    return new Response(entry.body, { status: entry.status, headers: { 'content-type': entry.type } });
  }
}

/** A navigation request. `new Request(url, { mode: 'navigate' })` throws in browsers, so a plain object with the standard fields. */
function navigationRequest(url) {
  const request = { url, method: 'GET', mode: 'navigate', headers: new Headers(), destination: 'document', cache: 'default' };
  request.clone = () => request;
  return request;
}

// ---------------------------------------------------------------- sandbox

let srcPromise = null;
function swSource() {
  if (!srcPromise) {
    srcPromise = fetch('./sw.js', { cache: 'reload' }).then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' para sw.js');
      return res.text();
    });
  }
  return srcPromise;
}

/** Evaluate sw.js against fresh fakes. Returns the fakes plus dispatch helpers for the four events. */
async function createWorker() {
  const src = await swSource();
  const network = new FakeNetwork();
  const cacheStorage = new FakeCacheStorage(network);
  const handlers = new Map(); // event type -> [fn]
  const log = { errors: [] };
  const fakeConsole = {
    log() {},
    warn() {},
    error(...args) {
      log.errors.push(args);
    },
  };
  const fakeSelf = {
    registration: { scope: SCOPE },
    location: { href: SCOPE + 'sw.js', origin: new URL(SCOPE).origin },
    skipWaitingCalls: 0,
    skipWaiting() {
      fakeSelf.skipWaitingCalls += 1;
      return Promise.resolve();
    },
    clients: {
      claimCalls: 0,
      claim() {
        fakeSelf.clients.claimCalls += 1;
        return Promise.resolve();
      },
    },
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
  };
  const globals = {
    self: fakeSelf,
    globalThis: fakeSelf,
    caches: cacheStorage,
    fetch: (request) => network.fetch(request),
    Request,
    Response,
    Headers,
    URL,
    console: fakeConsole,
  };
  // The appended `return` exposes the stamped constants without changing sw.js.
  const factory = new Function(...SHADOWED, src + '\nreturn { VERSION, PRECACHE, CACHE_NAME };');
  const exported = factory(...SHADOWED.map((name) => globals[name]));
  // The four listeners must have reached the FAKE self: otherwise every 'not handled' test would pass
  // vacuously (dispatch() returns undefined when nothing is registered).
  for (const type of ['install', 'activate', 'fetch', 'message']) {
    if (!handlers.has(type)) throw new Error('sw.js registered no ' + type + ' listener on self');
  }

  // The fake server has every precached file plus a few extras. Body = 'file:' + relative path.
  for (const entry of exported.PRECACHE) {
    network.set(new URL(entry, SCOPE).href, { body: 'file:' + entry, type: 'text/plain' });
  }
  for (const rel of EXTRA_FILES) network.set(SCOPE + rel, { body: 'file:./' + rel });

  function dispatch(type, extra = {}) {
    const fns = handlers.get(type) || [];
    const pending = [];
    if (type === 'fetch') {
      let response; // the promise given to respondWith, or undefined when the worker stays out
      const event = {
        request: extra.request,
        respondWith(p) {
          response = Promise.resolve(p);
        },
        waitUntil(p) {
          pending.push(p);
        },
      };
      for (const fn of fns) fn(event);
      return response;
    }
    const event = {
      data: extra.data,
      waitUntil(p) {
        pending.push(p);
      },
    };
    for (const fn of fns) fn(event);
    return Promise.all(pending).then(() => undefined);
  }

  return {
    self: fakeSelf,
    network,
    caches: cacheStorage,
    handlers,
    log,
    VERSION: exported.VERSION,
    PRECACHE: exported.PRECACHE,
    CACHE_NAME: exported.CACHE_NAME,
    install: () => dispatch('install'),
    activate: () => dispatch('activate'),
    message: (data) => dispatch('message', { data }),
    fetch: (request) => dispatch('fetch', { request }),
  };
}

/** A worker after a successful install, with the network log cleared. */
async function installedWorker() {
  const worker = await createWorker();
  await worker.install();
  worker.network.calls.length = 0;
  return worker;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// ---------------------------------------------------------------- tests

test('sw: source reaches worker globals only through self.* (harness rule)', async () => {
  const code = stripComments(await swSource());
  for (const name of ['addEventListener', 'registration', 'clients', 'skipWaiting', 'location']) {
    const bare = new RegExp('(^|[^.\\w])' + name + '\\b');
    assert(!bare.test(code), 'sw.js uses bare ' + name + ' (must be self.' + name + ')');
  }
  for (const name of ['globalThis', 'window', 'WorkerGlobalScope', 'ServiceWorkerGlobalScope']) {
    assert(!new RegExp('\\b' + name + '\\b').test(code), 'sw.js uses ' + name + ' (must be self)');
  }
  assert(code.includes('self.addEventListener'), 'listeners are registered on self');
});

test('sw: install precaches exactly PRECACHE against the scope, with cache: reload, into c2vocab-<VERSION>', async () => {
  const w = await createWorker();
  const stamped = /const VERSION = '([^']+)';/.exec(await swSource());
  assert(stamped, 'VERSION is stamped in sw.js');
  eq(w.VERSION, stamped[1], 'the sandbox runs the stamped VERSION');
  eq(w.CACHE_NAME, 'c2vocab-' + w.VERSION);
  assert(w.PRECACHE.length >= 4 && w.PRECACHE.includes('./js/app.js'), 'PRECACHE lists the app files');

  await w.install();
  deepEq(await w.caches.keys(), ['c2vocab-' + w.VERSION], 'one cache, named after the version');
  const cache = await w.caches.open(w.CACHE_NAME);
  const cachedUrls = (await cache.keys()).map((r) => r.url).sort();
  const expected = w.PRECACHE.map((entry) => new URL(entry, SCOPE).href).sort();
  deepEq(cachedUrls, expected, 'exactly the PRECACHE list, resolved against the scope');
  assert(cachedUrls.includes('https://example.test/c2vocab/js/app.js'), 'resolved against the sub-path');
  assert(cachedUrls.includes('https://example.test/c2vocab/'), 'the root entry');
  assert(!cachedUrls.some((u) => u.startsWith('https://example.test/js/')), 'nothing resolved against the origin root');

  deepEq(w.network.calls.map((c) => c.url).sort(), expected, 'one network request per entry');
  assert(w.network.calls.every((c) => c.cache === 'reload'), 'every precache request bypasses the HTTP cache');
  eq(await (await cache.match(SCOPE + 'index.html')).text(), 'file:./index.html', 'the body was stored');
  eq(w.log.errors.length, 0, 'nothing logged');
});

test('sw: install rejects when one precache entry answers 404', async () => {
  const w = await createWorker();
  w.network.set(SCOPE + 'js/app.js', { status: 404, body: 'not found' });
  await throws(() => w.install(), 'install must fail');
  assert(w.log.errors.length >= 1, 'the missing file is logged');
  assert(String(w.log.errors[0][0]).includes('js/app.js'), 'the log names the file');
});

test('sw: activate deletes old c2vocab-* caches, keeps the current one and other apps, claims clients', async () => {
  const w = await installedWorker();
  await w.caches.open('c2vocab-20200101-000000');
  await w.caches.open('other-app');
  eq((await w.caches.keys()).length, 3);
  eq(w.self.clients.claimCalls, 0);

  await w.activate();
  deepEq((await w.caches.keys()).sort(), ['c2vocab-' + w.VERSION, 'other-app'].sort());
  eq(await w.caches.has('c2vocab-20200101-000000'), false, 'the old version is gone');
  const cache = await w.caches.open(w.CACHE_NAME);
  eq((await cache.keys()).length, w.PRECACHE.length, 'the current cache is intact');
  eq(w.self.clients.claimCalls, 1, 'clients.claim() called once');
});

test('sw: app navigations get the cached index.html even offline; navigations to real files do not', async () => {
  const w = await installedWorker();
  const indexBody = 'file:./index.html';
  w.network.offline = true;
  for (const rel of ['', '?sw=1', 'index.html', 'estudiar', 'ajustes/hoy']) {
    const res = await w.fetch(navigationRequest(SCOPE + rel));
    assert(res, 'handled: "' + rel + '"');
    eq(await res.text(), indexBody, 'navigation to "' + rel + '" offline');
  }
  eq(w.network.calls.length, 0, 'no network needed while offline');

  // Online the shell is still cache-first: opening the app never waits for the network.
  w.network.offline = false;
  for (const rel of ['', 'estudiar']) {
    const res = await w.fetch(navigationRequest(SCOPE + rel));
    eq(await res.text(), indexBody, 'navigation to "' + rel + '" online');
  }
  eq(w.network.calls.length, 0, 'the shell is served from the cache even online');

  for (const rel of ['sw.js', 'seeds/base.json', 'README.md']) {
    const res = await w.fetch(navigationRequest(SCOPE + rel));
    assert(res, 'handled: ' + rel);
    eq(await res.text(), 'file:./' + rel, 'navigation to a real file returns the file: ' + rel);
  }
  eq(await w.fetch(navigationRequest(SCOPE + 'test.html')), undefined, 'test.html is left to the browser');

  // Offline, a real file is never replaced by index.html: a non-cached one fails, a seed gives its own copy.
  w.network.offline = true;
  await throws(() => w.fetch(navigationRequest(SCOPE + 'README.md')), 'offline README.md must not become index.html');
  eq(await (await w.fetch(navigationRequest(SCOPE + 'seeds/base.json'))).text(), 'file:./seeds/base.json', 'offline seed navigation');
});

test('sw: a precached file is served from the cache without the network, also offline', async () => {
  const w = await installedWorker();
  const res = await w.fetch(new Request(SCOPE + 'js/app.js'));
  eq(await res.text(), 'file:./js/app.js');
  eq(w.network.calls.length, 0, 'no fetch');

  w.network.offline = true;
  const offline = await w.fetch(new Request(SCOPE + 'styles.css'));
  eq(await offline.text(), 'file:./styles.css');
  const root = await w.fetch(new Request(SCOPE));
  eq(await root.text(), 'file:./', 'a plain GET of the root entry (not a navigation) returns its own copy');
  eq(w.network.calls.length, 0, 'still no fetch');
});

test('sw: non-precached same-origin files go to the network and are never stored', async () => {
  const w = await installedWorker();
  const cache = await w.caches.open(w.CACHE_NAME);
  const before = (await cache.keys()).length;

  // Excluded files: the worker does not answer at all, the browser fetches them itself.
  const excluded = ['test.html', 'js/tests/x.js', 'tools/x.html', 'docs/x.md'];
  for (const rel of excluded) eq(await w.fetch(new Request(SCOPE + rel)), undefined, 'not handled: ' + rel);
  eq(w.network.calls.length, 0, 'the worker itself fetched nothing');

  // Other files inside the scope: fetched by the worker, kept nowhere.
  const passThrough = ['README.md', 'js/extra.js'];
  for (const rel of passThrough) {
    const res = await w.fetch(new Request(SCOPE + rel));
    eq(await res.text(), 'file:./' + rel, 'network body: ' + rel);
  }
  deepEq(
    w.network.calls.map((c) => c.url),
    passThrough.map((rel) => SCOPE + rel)
  );
  eq((await cache.keys()).length, before, 'cache size unchanged');
  for (const rel of excluded.concat(passThrough)) {
    eq(await w.caches.match(SCOPE + rel), undefined, 'not cached: ' + rel);
  }

  // Offline such a file fails honestly: the worker never invents content.
  w.network.offline = true;
  await throws(() => w.fetch(new Request(SCOPE + 'README.md')), 'offline non-precached file rejects');
});

test('sw: seeds are network-first (fresh copy stored), cached copy offline, 404 not stored', async () => {
  const w = await installedWorker();
  const url = SCOPE + 'seeds/base.json';
  const cache = await w.caches.open(w.CACHE_NAME);
  eq(await (await cache.match(url)).text(), 'file:./seeds/base.json', 'precached copy');

  w.network.set(url, { body: '[{"front":"v2"}]', type: 'application/json' });
  const online = await w.fetch(new Request(url));
  eq(await online.text(), '[{"front":"v2"}]', 'online: the network body');
  deepEq(
    w.network.calls.map((c) => c.url),
    [url]
  );
  eq(await (await cache.match(url)).text(), '[{"front":"v2"}]', 'the cache was updated');

  w.network.offline = true;
  const offline = await w.fetch(new Request(url));
  eq(await offline.text(), '[{"front":"v2"}]', 'offline: the cached copy');
  await throws(() => w.fetch(new Request(SCOPE + 'seeds/extra.json')), 'a seed never seen online cannot be served offline');

  w.network.offline = false;
  w.network.set(url, { status: 404, body: 'gone' });
  const missing = await w.fetch(new Request(url));
  eq(missing.status, 404, 'a 404 is returned as is');
  eq(await (await cache.match(url)).text(), '[{"front":"v2"}]', 'a 404 never overwrites the cached copy');
});

test('sw: cross-origin, non-GET, Range and out-of-scope requests are not handled', async () => {
  const w = await installedWorker();
  eq(await w.fetch(new Request('https://other.test/c2vocab/js/app.js')), undefined, 'cross-origin GET');
  eq(await w.fetch(new Request(SCOPE + 'js/app.js', { method: 'POST', body: 'x' })), undefined, 'same-origin POST');
  eq(await w.fetch(new Request(SCOPE + 'js/app.js', { headers: { Range: 'bytes=0-99' } })), undefined, 'GET with Range');
  eq(await w.fetch(new Request('https://example.test/otra-app/js/app.js')), undefined, 'same origin, outside the scope');
  eq(await w.fetch(navigationRequest('https://example.test/')), undefined, 'the origin root is outside the sub-path scope');
  eq(w.network.calls.length, 0, 'the worker fetched nothing');
});

test('sw: message SKIP_WAITING calls skipWaiting, other messages do not', async () => {
  const w = await installedWorker();
  await w.message({ type: 'PING' });
  await w.message(null);
  await w.message('SKIP_WAITING');
  eq(w.self.skipWaitingCalls, 0, 'nothing yet');
  await w.message({ type: 'SKIP_WAITING' });
  eq(w.self.skipWaitingCalls, 1);
});

test('sw: a query string still hits the precached entry (ignoreSearch)', async () => {
  const w = await installedWorker();
  const res = await w.fetch(new Request(SCOPE + 'js/app.js?x=1'));
  eq(await res.text(), 'file:./js/app.js');
  eq(w.network.calls.length, 0, 'served from the cache');
  w.network.offline = true;
  const offline = await w.fetch(new Request(SCOPE + 'styles.css?v=2'));
  eq(await offline.text(), 'file:./styles.css', 'also offline');
  eq(w.network.calls.length, 0);
});
