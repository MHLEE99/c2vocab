// Application entry: hash router, bottom navigation, floating '+' button.

import { db, initMeta } from './db.js';
import { h, clear, onCardsChanged, isSheetOpen } from './ui/components.js';
import * as home from './ui/home.js';
import * as explorar from './ui/explorar.js';
import * as papelera from './ui/papelera.js';
import { openQuickAdd } from './ui/quickadd.js';

const ROUTES = {
  '#/': { title: 'Inicio', view: home },
  '#/explorar': { title: 'Explorar', view: explorar },
  '#/papelera': { title: 'Papelera', view: papelera },
};

// Inline SVG icons for the bottom nav (no icon font, works offline).
const ICONS = {
  '#/':
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  '#/explorar':
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 1 0 4.2 12.6l5.1 5.1 1.4-1.4-5.1-5.1A7 7 0 0 0 10 3zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z"/></svg>',
  '#/papelera':
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"/></svg>',
};

let currentHash = null;

function currentRoute() {
  const hash = window.location.hash || '#/';
  return ROUTES[hash] ? hash : '#/';
}

function renderNav() {
  const nav = document.getElementById('nav');
  clear(nav);
  for (const [hash, route] of Object.entries(ROUTES)) {
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

async function route() {
  const hash = currentRoute();
  if (window.location.hash !== hash) {
    // Unknown hash: normalise the URL; the hashchange event will call route() again.
    window.location.hash = hash;
    return;
  }
  currentHash = hash;
  const { title, view } = ROUTES[hash];
  document.getElementById('view-title').textContent = title;
  document.title = `${title} · c2vocab`;
  markActiveNav(hash);
  const container = document.getElementById('view');
  clear(container);
  window.scrollTo(0, 0);
  try {
    await view.render(container);
  } catch (err) {
    console.error(err);
    container.appendChild(
      h('p', { class: 'error' }, 'Error al cargar la vista: ' + (err && err.message ? err.message : String(err)))
    );
  }
}

/** Re-render the current view in place (after cards changed). Views keep their own filter state. */
async function refreshCurrentView() {
  if (!currentHash) return;
  const { view } = ROUTES[currentHash];
  const container = document.getElementById('view');
  clear(container);
  try {
    await view.render(container);
  } catch (err) {
    console.error(err);
  }
}

async function main() {
  await initMeta();
  renderNav();
  document.getElementById('fab').addEventListener('click', () => openQuickAdd());
  window.addEventListener('hashchange', route);
  onCardsChanged(refreshCurrentView);
  // Keyboard shortcut on desktop: "n" opens quick add when no field/sheet has focus.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'n' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
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
