// Shared UI building blocks: DOM helper, toast, bottom sheet, chips, change events.

/**
 * Tiny DOM builder: h('button', {class:'btn', onclick: fn}, 'Guardar').
 * props: attributes; keys starting with "on" are event listeners; `class`, `dataset`, `style` supported.
 * children: strings become text nodes; null/false are skipped; arrays are flattened.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      el.className = value;
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key === 'html') {
      el.innerHTML = value;
    } else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') {
      el[key] = value;
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(el, child);
    } else if (child instanceof Node) {
      el.appendChild(child);
    } else {
      el.appendChild(document.createTextNode(String(child)));
    }
  }
}

/** Remove every child of an element. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ---------------------------------------------------------------- toast

let toastTimer = null;

/**
 * Show a transient message above the bottom nav. Only one toast at a time.
 * opts.actionLabel + opts.onAction add a button (e.g. 'Deshacer').
 */
export function toast(message, opts = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  clear(root);
  if (toastTimer) clearTimeout(toastTimer);

  const ms = opts.ms || (opts.actionLabel ? 6000 : 3000);
  const box = h('div', { class: 'toast', role: 'status' }, h('span', { class: 'toast-text' }, message));
  if (opts.actionLabel) {
    box.appendChild(
      h(
        'button',
        {
          class: 'toast-action',
          type: 'button',
          onclick: () => {
            hideToast();
            if (typeof opts.onAction === 'function') opts.onAction();
          },
        },
        opts.actionLabel
      )
    );
  }
  root.appendChild(box);
  root.hidden = false;
  toastTimer = setTimeout(hideToast, ms);
}

export function hideToast() {
  const root = document.getElementById('toast-root');
  if (!root) return;
  clear(root);
  root.hidden = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
}

// ---------------------------------------------------------------- bottom sheet

let sheetOnClose = null;

/**
 * Open a bottom sheet (full-width on phone, centred card on desktop) containing contentEl.
 * Escape and a click on the backdrop close it. opts.onClose runs after closing.
 */
export function openSheet(contentEl, opts = {}) {
  const root = document.getElementById('sheet-root');
  if (!root) return;
  closeSheet();
  sheetOnClose = typeof opts.onClose === 'function' ? opts.onClose : null;

  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, contentEl);
  const backdrop = h('div', {
    class: 'sheet-backdrop',
    onclick: (ev) => {
      if (ev.target === backdrop) closeSheet();
    },
  });
  backdrop.appendChild(panel);
  root.appendChild(backdrop);
  root.hidden = false;
  document.body.classList.add('sheet-open');
  document.addEventListener('keydown', onSheetKeydown);
}

function onSheetKeydown(ev) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    closeSheet();
  }
}

export function closeSheet() {
  const root = document.getElementById('sheet-root');
  if (!root) return;
  const wasOpen = !root.hidden;
  clear(root);
  root.hidden = true;
  document.body.classList.remove('sheet-open');
  document.removeEventListener('keydown', onSheetKeydown);
  const cb = sheetOnClose;
  sheetOnClose = null;
  if (wasOpen && cb) cb();
}

export function isSheetOpen() {
  const root = document.getElementById('sheet-root');
  return !!root && !root.hidden;
}

// ---------------------------------------------------------------- chips

/** A pill-shaped toggle button. */
export function chip(label, { active = false, onClick = null, title = '' } = {}) {
  return h(
    'button',
    {
      type: 'button',
      class: 'chip' + (active ? ' chip-active' : ''),
      'aria-pressed': active ? 'true' : 'false',
      title: title || null,
      onclick: onClick,
    },
    label
  );
}

/** Small non-interactive label (type, register, region, Bandeja...). */
export function badge(text, kind = '') {
  return h('span', { class: 'badge' + (kind ? ' badge-' + kind : '') }, text);
}

// ---------------------------------------------------------------- data-change events

const CARDS_CHANGED = 'c2:cards-changed';

/** Tell the app that cards were added/edited/deleted so the current view can refresh. */
export function emitCardsChanged() {
  document.dispatchEvent(new CustomEvent(CARDS_CHANGED));
}

export function onCardsChanged(handler) {
  document.addEventListener(CARDS_CHANGED, handler);
}
