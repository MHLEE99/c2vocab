// Browser integration tests for the PWA files (same-origin fetches from test.html):
// manifest, icons, service worker markers and precache list, app version.
// These FAIL on purpose when the icons are missing (see README: tools/make-icons.html).

import { test, assert, eq } from './harness.js';
import { APP_VERSION } from '../version.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Same-origin URL of a './...' path, resolved against this page (test.html lives at the app root). */
function appUrl(relative) {
  return new URL(relative, window.location.href).href;
}

async function fetchOk(url, init = {}) {
  const res = await fetch(url, { cache: 'no-store', ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status} para ${url}`);
  return res;
}

async function assertPng(url) {
  const res = await fetchOk(url);
  const bytes = new Uint8Array((await res.arrayBuffer()).slice(0, 8));
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error(`${url} no es un PNG (firma incorrecta)`);
  }
}

/** The list between the @release-precache markers of sw.js. */
function precacheFromSw(text) {
  // \r?\n: the markers must also be found on a CRLF checkout (see .gitattributes / tools/release.py).
  const match = /\/\/ @release-precache\r?\n([\s\S]*?)\/\/ @release-precache-end/.exec(text);
  if (!match) throw new Error('sw.js: marcadores @release-precache no encontrados');
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

let swTextPromise = null;
function swText() {
  if (!swTextPromise) swTextPromise = fetchOk(appUrl('./sw.js')).then((res) => res.text());
  return swTextPromise;
}

test('pwa: manifest.webmanifest parses with start_url ./, scope ./, standalone', async () => {
  const res = await fetchOk(appUrl('./manifest.webmanifest'));
  const manifest = await res.json();
  eq(manifest.start_url, './');
  eq(manifest.scope, './');
  eq(manifest.display, 'standalone');
  eq(manifest.name, 'C2 Vocab');
  eq(manifest.theme_color, '#1f5f8b');
  assert(Array.isArray(manifest.icons) && manifest.icons.length >= 3, 'three icons');
  assert(manifest.icons.some((i) => i.purpose === 'maskable'), 'a maskable icon');
});

test('pwa: every manifest icon and the apple-touch-icon are real PNG files', async () => {
  const res = await fetchOk(appUrl('./manifest.webmanifest'));
  const manifest = await res.json();
  const manifestUrl = appUrl('./manifest.webmanifest');
  for (const icon of manifest.icons) {
    assert(icon.src.startsWith('./'), 'icon src is relative: ' + icon.src);
    await assertPng(new URL(icon.src, manifestUrl).href);
  }
  await assertPng(appUrl('./icons/apple-touch-icon.png'));
  const svg = await fetchOk(appUrl('./icons/favicon.svg'));
  assert((await svg.text()).includes('<svg'), 'favicon.svg is an SVG');
});

test('pwa: sw.js has the release markers and a VERSION', async () => {
  const text = await swText();
  assert(/\/\/ @release-version\r?\n/.test(text), 'version marker');
  assert(text.includes('// @release-version-end'), 'version end marker');
  assert(/\/\/ @release-precache\r?\n/.test(text), 'precache marker');
  assert(text.includes('// @release-precache-end'), 'precache end marker');
  const version = /const VERSION = '([^']+)';/.exec(text);
  assert(version && version[1].length > 0, 'VERSION is a non-empty string');
  assert(text.includes("'c2vocab-'"), 'cache name prefix');
});

test('pwa: every PRECACHE entry exists and nothing forbidden is listed', async () => {
  const entries = precacheFromSw(await swText());
  assert(entries.length >= 4, 'at least the shell files are listed: ' + entries.length);
  for (const must of ['./', './index.html', './styles.css', './manifest.webmanifest', './js/app.js']) {
    assert(entries.includes(must), 'listed: ' + must);
  }
  for (const entry of entries) {
    assert(entry.startsWith('./'), 'relative entry: ' + entry);
    assert(!/test\.html|js\/tests|tools\/|docs\//.test(entry), 'never cached: ' + entry);
    // HEAD is enough to prove the file is served; GitHub Pages and tools/serve.py both answer it.
    const res = await fetch(appUrl(entry), { method: 'HEAD', cache: 'no-store' });
    assert(res.ok, `HTTP ${res.status} para ${entry}`);
  }
});

test('pwa: js/version.js exports a non-empty APP_VERSION string', () => {
  eq(typeof APP_VERSION, 'string');
  assert(APP_VERSION.length > 0, 'not empty');
});
