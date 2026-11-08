// Page side of the service worker: registration, the "Nueva versión disponible" banner, periodic
// update checks, and the Chrome/Android install prompt (beforeinstallprompt).
// The pure decisions (register or not, iOS, standalone) live in platform.js.

import { h } from './ui/components.js';

const UPDATE_EVERY_MS = 60 * 60 * 1000; // registration.update() once an hour while the page is open

let registration = null; // ServiceWorkerRegistration once register() resolved
let bannerEl = null; // the update banner on screen, or null
let hadController = false; // was a service worker already controlling the page when we started?
let reloading = false; // controllerchange reloads the page once, never twice
let userAskedUpdate = false; // 'Actualizar' was pressed: reload even while a session is running
let pendingReload = false; // the new worker took control but a study session was running
let holdReload = () => false; // app.js tells us when reloading would destroy a running session
let updateTimer = null;
let deferredInstall = null; // the captured beforeinstallprompt event (Chrome/Edge/Android)

/**
 * Register ./sw.js (relative: the site lives under a sub-path on GitHub Pages).
 *   shouldHoldReload()  returns true while the study screen has a running session; then a new
 *                       version is not applied by an automatic reload, the banner stays and
 *                       'Actualizar' does it.
 */
export async function registerServiceWorker({ shouldHoldReload } = {}) {
  if (!('serviceWorker' in navigator)) return null;
  if (typeof shouldHoldReload === 'function') holdReload = shouldHoldReload;
  hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

  try {
    registration = await navigator.serviceWorker.register('./sw.js');
  } catch (err) {
    console.error('[sw] registro fallido', err);
    return null;
  }

  if (registration.waiting && navigator.serviceWorker.controller) {
    // A new version was already downloaded on an earlier visit and is waiting.
    showBanner();
  } else if (registration.installing) {
    // The browser checks sw.js on its own when the page is opened; by the time register() resolves
    // that worker may already be installing, and its 'updatefound' fired before we could listen.
    trackInstalling(registration.installing);
  }
  registration.addEventListener('updatefound', () => trackInstalling(registration.installing));

  // Look for a new version when the user comes back to the app and once an hour.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate().catch(() => {});
  });
  updateTimer = setInterval(() => checkForUpdate().catch(() => {}), UPDATE_EVERY_MS);
  return registration;
}

/** Follow a newly found worker: when it is installed behind a running one, offer the update. */
function trackInstalling(worker) {
  if (!worker) return;
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed' && navigator.serviceWorker.controller) showBanner();
  });
}

function onControllerChange() {
  if (!hadController) {
    // First install: the page already runs the newest code, nothing to reload.
    hadController = true;
    return;
  }
  if (reloading) return;
  if (holdReload() && !userAskedUpdate) {
    // A study session is running: do not pull the screen away. The banner stays and
    // 'Actualizar' reloads when the learner decides.
    pendingReload = true;
    showBanner();
    return;
  }
  reloading = true;
  window.location.reload();
}

/** Is a newer version downloaded and waiting to be applied? (for Ajustes) */
export function isUpdateAvailable() {
  return pendingReload || !!(registration && registration.waiting);
}

/**
 * Ask the browser to look for a new sw.js now. Resolves to:
 *   'sin-sw'      no service worker on this page (plain http development)
 *   'disponible'  a new version is ready: the banner is on screen
 *   'descargando' a new version is being downloaded: the banner will appear when it is ready
 *   'al-dia'      nothing new
 */
export async function checkForUpdate() {
  if (!registration) return 'sin-sw';
  await registration.update();
  if (pendingReload || registration.waiting) {
    showBanner();
    return 'disponible';
  }
  if (registration.installing) return 'descargando';
  return 'al-dia';
}

/** Apply the waiting version: the worker skips waiting, controllerchange reloads the page. */
export function applyUpdate() {
  userAskedUpdate = true;
  if (pendingReload) {
    // The new worker already controls the page: a reload is all that is missing.
    if (reloading) return;
    reloading = true;
    window.location.reload();
    return;
  }
  if (registration && registration.waiting) {
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    return;
  }
  // Nothing is waiting any more (another tab applied it): just reload.
  if (reloading) return;
  reloading = true;
  window.location.reload();
}

// ---------------------------------------------------------------- update banner

function showBanner() {
  if (bannerEl) return;
  const updateBtn = h(
    'button',
    {
      class: 'btn btn-primary',
      type: 'button',
      onclick: () => {
        updateBtn.disabled = true;
        applyUpdate();
      },
    },
    'Actualizar'
  );
  const laterBtn = h('button', { class: 'btn', type: 'button', onclick: hideBanner }, 'Después');
  bannerEl = h(
    'div',
    { class: 'update-banner', role: 'status' },
    h(
      'div',
      { class: 'update-banner-text' },
      h('div', { class: 'banner-title' }, 'Nueva versión disponible'),
      h('div', { class: 'hint-ko update-banner-hint' }, "새 버전이 있습니다. 'Actualizar'를 누르면 새로 고침됩니다.")
    ),
    h('div', { class: 'update-banner-actions' }, laterBtn, updateBtn)
  );
  document.body.appendChild(bannerEl);
}

function hideBanner() {
  if (!bannerEl) return;
  bannerEl.remove();
  bannerEl = null;
}

// ---------------------------------------------------------------- install prompt (Chrome / Android / desktop)

/** Capture beforeinstallprompt so Ajustes can offer an 'Instalar' button. Call once at start. */
export function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault(); // no mini-infobar: we show our own button
    deferredInstall = ev;
    document.dispatchEvent(new CustomEvent('c2:install-available'));
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
  });
}

export function canInstall() {
  return deferredInstall !== null;
}

/** Show the browser's install dialog. Resolves to 'accepted' | 'dismissed' | 'unavailable'. */
export async function promptInstall() {
  if (!deferredInstall) return 'unavailable';
  const ev = deferredInstall;
  deferredInstall = null; // a prompt event can be used only once
  ev.prompt();
  const choice = await ev.userChoice;
  return choice && choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
}

/** Stops the hourly timer (not used by the app, handy for tests and debugging). */
export function stopUpdateChecks() {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = null;
}
