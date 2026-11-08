// Application entry: hash router, bottom navigation, floating '+' button.

import { db, initMeta, getMeta, setMeta } from './db.js';
import { h, clear, onCardsChanged, isSheetOpen } from './ui/components.js';
import * as home from './ui/home.js';
import * as explorar from './ui/explorar.js';
import * as papelera from './ui/papelera.js';
import * as review from './ui/review.js';
import * as ajustes from './ui/ajustes.js';
import * as importar from './ui/importar.js';
import * as copias from './ui/copias.js';
import { openQuickAdd } from './ui/quickadd.js';
import { shouldRegisterSw } from './platform.js';
import { registerServiceWorker, setupInstallPrompt } from './sw-client.js';

// Route options:
//   nav: false     not listed in the bottom nav
//   navHash        which nav item is highlighted while on this route
//   studying       study screen: hides the '+' button and is never rebuilt by cards-changed
const ROUTES = {
  '#/': { title: 'Inicio', view: home },
  '#/explorar': { title: 'Explorar', view: explorar },
  '#/papelera': { title: 'Papelera', view: papelera },
  '#/ajustes': { title: 'Ajustes', view: ajustes },
  '#/estudiar': { title: 'Estudiar', view: review, nav: false, navHash: '#/', studying: true },
  '#/importar': { title: 'Importar', view: importar, nav: false, navHash: '#/ajustes' },
  '#/copias': { title: 'Copias automáticas', view: copias, nav: false, navHash: '#/ajustes' },
};

// Inline SVG icons for the bottom nav (no icon font, works offline).
const ICONS = {
  '#/':
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  '#/explorar':
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 1 0 4.2 12.6l5.1 5.1 1.4-1.4-5.1-5.1A7 7 0 0 0 10 3zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z"/></svg>',
  '#/papelera':
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"/></svg>',
  '#/ajustes':
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M10.3 2h3.4l.5 2.6c.6.2 1.1.5 1.6.9l2.5-.9 1.7 3-2 1.7a7 7 0 0 1 0 1.8l2 1.7-1.7 3-2.5-.9c-.5.4-1 .7-1.6.9l-.5 2.6h-3.4l-.5-2.6a7 7 0 0 1-1.6-.9l-2.5.9-1.7-3 2-1.7a7 7 0 0 1 0-1.8l-2-1.7 1.7-3 2.5.9c.5-.4 1-.7 1.6-.9zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/></svg>',
};

let currentBase = null; // route key of the view on screen, e.g. '#/estudiar'
let currentParams = {}; // its query parameters, e.g. { modo: 'nuevas' }
let currentView = null; // its view module (so destroy() can be called when leaving)
let renderSeq = 0; // goes up with every render; a slow, outdated render is thrown away

/**
 * Split the URL hash into route + parameters:
 * '#/estudiar?modo=nuevas' -> { base: '#/estudiar', full: '#/estudiar?modo=nuevas', params: { modo: 'nuevas' } }.
 * Unknown routes fall back to Inicio.
 */
function parseHash() {
  const raw = window.location.hash || '#/';
  const cut = raw.indexOf('?');
  const base = cut === -1 ? raw : raw.slice(0, cut);
  if (!ROUTES[base]) return { base: '#/', full: '#/', params: {} };
  const params = {};
  if (cut !== -1) {
    new URLSearchParams(raw.slice(cut + 1)).forEach((value, key) => {
      params[key] = value;
    });
  }
  return { base, full: raw, params };
}

function renderNav() {
  const nav = document.getElementById('nav');
  clear(nav);
  for (const [hash, route] of Object.entries(ROUTES)) {
    if (route.nav === false) continue;
    const link = h('a', { class: 'nav-item', href: hash, dataset: { hash }, html: ICONS[hash] });
    link.appendChild(h('span', { class: 'nav-label' }, route.title));
    nav.appendChild(link);
  }
}

function markActiveNav(hash) {
  document.querySelectorAll('#nav .nav-item').forEach((a) => {
    const active = a.dataset.hash === hash;
    a.classList.toggle('nav-active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/** View lifecycle: a view module may export destroy() to stop timers and remove listeners. */
function destroyCurrentView() {
  if (currentView && typeof currentView.destroy === 'function') {
    try {
      currentView.destroy();
    } catch (err) {
      console.error(err);
    }
  }
  currentView = null;
}

async function route() {
  const { base, full, params } = parseHash();
  if (window.location.hash !== full) {
    // Unknown hash: normalise the URL; the hashchange event will call route() again.
    window.location.hash = full;
    return;
  }
  destroyCurrentView();
  const def = ROUTES[base];
  currentBase = base;
  currentParams = params;
  currentView = def.view;
  document.getElementById('view-title').textContent = def.title;
  document.title = `${def.title} · c2vocab`;
  markActiveNav(def.navHash || base);
  // The study screen has its own action bar at the bottom: no '+' button there.
  document.getElementById('fab').hidden = !!def.studying;
  document.body.classList.toggle('studying', !!def.studying);
  const container = document.getElementById('view');
  clear(container);
  window.scrollTo(0, 0);
  await renderInto(container, def.view, params);
}

/**
 * Render a view into a detached element first and put it on screen only if no
 * newer render started in the meantime. Without this, a slow render (the views
 * wait for the database) could add its content after the user already moved to
 * another route, and two screens would be stacked.
 */
async function renderInto(container, view, params) {
  renderSeq += 1;
  const seq = renderSeq;
  const holder = h('div');
  try {
    await view.render(holder, params);
  } catch (err) {
    console.error(err);
    holder.appendChild(
      h('p', { class: 'error' }, 'Error al cargar la vista: ' + (err && err.message ? err.message : String(err)))
    );
  }
  if (seq !== renderSeq) return; // a newer render took over: drop this one
  clear(container);
  while (holder.firstChild) container.appendChild(holder.firstChild);
}

/** Re-render the current view in place (after cards changed). Views keep their own filter state. */
async function refreshCurrentView() {
  if (!currentBase) return;
  const def = ROUTES[currentBase];
  // Rebuilding the study screen would reset the running session: never refresh it.
  if (def.studying) return;
  // The old content stays on screen until the new one is ready (see renderInto).
  await renderInto(document.getElementById('view'), def.view, currentParams);
}

/**
 * Ask the browser (once, on the first start) to keep our data even when the disk gets full.
 * The answer is cached in the meta row 'storagePersist': 'si' | 'no' | 'no-disponible'.
 * Ajustes shows it. Never blocks or breaks the start of the app.
 */
async function requestPersistence() {
  const cached = await getMeta('storagePersist');
  if (cached) return;
  const storage = typeof navigator !== 'undefined' ? navigator.storage : null;
  if (!storage || typeof storage.persist !== 'function') {
    await setMeta('storagePersist', 'no-disponible');
    return;
  }
  const granted = await storage.persist();
  await setMeta('storagePersist', granted ? 'si' : 'no');
}

/**
 * Service worker (offline + update banner). Registered only on https (the published site) or
 * with ?sw=1 on http (acceptance run): daily development on localhost stays cache-free.
 * A new version is never applied by an automatic reload while the study screen is open.
 */
function setupServiceWorker() {
  const { protocol, hostname, search } = window.location;
  if (!shouldRegisterSw({ protocol, hostname, search })) return;
  registerServiceWorker({
    shouldHoldReload: () => currentBase === '#/estudiar' && review.isSessionRunning(),
  }).catch((err) => console.error(err));
}

async function main() {
  await initMeta();
  requestPersistence().catch((err) => console.error(err)); // in the background
  setupInstallPrompt(); // Chrome/Edge/Android: captures beforeinstallprompt for Ajustes -> Instalar
  setupServiceWorker();
  renderNav();
  document.getElementById('fab').addEventListener('click', () => openQuickAdd());
  window.addEventListener('hashchange', route);
  onCardsChanged(refreshCurrentView);
  // Keyboard shortcut on desktop: "n" opens quick add when no field/sheet has focus.
  document.addEventListener('keydown', (ev) => {
    // With the Korean keyboard active ev.key is not 'n' ('Process' or a Hangul letter),
    // so the physical key (ev.code) is accepted too when ev.key is not a Latin letter.
    const key = typeof ev.key === 'string' ? ev.key : '';
    const isN = key === 'n' || (ev.code === 'KeyN' && !/^[a-zA-Z]$/.test(key));
    if (!isN || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (currentBase && ROUTES[currentBase].studying) return; // no quick add while studying
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || isSheetOpen()) return;
    ev.preventDefault();
    openQuickAdd();
  });
  await route();
}

main().catch((err) => {
  console.error(err);
  const container = document.getElementById('view');
  if (container) container.textContent = 'No se pudo iniciar la aplicación: ' + err.message;
});

// Debugging aid only: lets you inspect the database from the browser console
// (e.g. `await __c2.db.listCards()`). Nothing in the app depends on it.
window.__c2 = { db };
