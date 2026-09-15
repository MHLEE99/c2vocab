// Small pure helpers shared by every module. No DOM, no database.

/** Random UUID v4. Uses crypto.randomUUID when available (modern browsers, https/localhost). */
export function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older WebViews: build a v4 UUID from getRandomValues.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Current time as ISO 8601 string (UTC). Used for createdAt/updatedAt/deletedAt. */
export function nowIso() {
  return new Date().toISOString();
}

// Private-use placeholders so that "ñ" survives the accent stripping below.
const N_TILDE_LOWER = '';
const N_TILDE_UPPER = '';

/**
 * Search/duplicate key: strip accents, lowercase, collapse whitespace, trim.
 * "hincapié" -> "hincapie". The letter "ñ" is kept distinct from "n"
 * ("año" and "ano" are different words), so it is protected before NFD.
 */
export function normalize(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .normalize('NFC')
    .replace(/ñ/g, N_TILDE_LOWER)
    .replace(/Ñ/g, N_TILDE_UPPER)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining diacritical marks
    .toLowerCase()
    .replace(/[]/g, 'ñ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escape text for safe insertion into innerHTML. */
export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Returns a function that waits `ms` after the last call before running `fn`. */
export function debounce(fn, ms) {
  let timer = null;
  return function debounced(...args) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, ms);
  };
}

/** Short Spanish date, e.g. "15 sept 2026, 10:32". Returns '' for empty/invalid input. */
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('es-ES', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  } catch (e) {
    return d.toLocaleString();
  }
}

/** Small sleep helper (used by tests and by undo timing). */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
