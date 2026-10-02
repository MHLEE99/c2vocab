// Export: build the envelope (the one document shape shared by export files, in-app
// backups and later sync) and hand it to the user as a .json file.
//
//   { app: 'c2vocab', schemaVersion, exportedAt, deviceId, deviceName,
//     cards: ALL cards (tombstones included), reviews: ALL rows (undone included), settings }

import { db as appDb, SCHEMA_VERSION } from './db.js';
import { nowIso as currentIso } from './util.js';

/**
 * Read the whole database into an envelope (one read transaction, so the cards and
 * the reviews belong to the same moment). Nothing is written.
 */
export async function buildEnvelope(dbObj, nowIso) {
  const store = dbObj || appDb;
  const dexie = store.dexie;
  return dexie.transaction('r', dexie.cards, dexie.reviews, dexie.meta, async () => {
    const cards = await dexie.cards.toArray();
    const reviews = await dexie.reviews.toArray();
    const settings = await store.getSettings();
    const deviceId = await store.getMeta('deviceId');
    const deviceName = await store.getMeta('deviceName');
    return {
      app: 'c2vocab',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowIso || currentIso(),
      deviceId: deviceId || '',
      deviceName: deviceName || '',
      cards,
      reviews,
      settings,
    };
  });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 'c2vocab-YYYY-MM-DD-<deviceName>.json' — the LOCAL date of exportedAt, a file-safe device name. */
export function exportFilename(envelope) {
  const env = envelope || {};
  let date = new Date(env.exportedAt);
  if (Number.isNaN(date.getTime())) date = new Date();
  const day = date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  const name = String(env.deviceName || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_-]/g, '');
  return 'c2vocab-' + day + '-' + (name || 'dispositivo') + '.json';
}

/** How much is inside an envelope: { cards (live), deleted, reviews }. */
export function envelopeCounts(envelope) {
  const cards = Array.isArray(envelope && envelope.cards) ? envelope.cards : [];
  const reviews = Array.isArray(envelope && envelope.reviews) ? envelope.reviews : [];
  const deleted = cards.filter((c) => c && c.deletedAt).length;
  return { cards: cards.length - deleted, deleted, reviews: reviews.length };
}

/** Save through a temporary <a download> and a Blob URL (PC browsers). */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before the URL disappears.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** A File for the share sheet, or null where File is not available. */
function makeFile(json, filename) {
  try {
    return new File([json], filename, { type: 'application/json' });
  } catch (e) {
    return null;
  }
}

/**
 * Export everything to a file. iPhone: the share sheet (Files / Dropbox / KakaoTalk);
 * PC: a normal download. On success settings.lastExportAt is set.
 * A cancelled share is not an error and does not set lastExportAt.
 * Returns { method: 'share' | 'download' | 'cancelled' | 'blocked', filename, counts: { cards, deleted, reviews } }.
 *
 * 'blocked': the browser refused the share sheet because the tap is "too old" (iPhone Safari
 * allows share() only right after a tap, and reading the database takes a moment). Nothing
 * was exported and lastExportAt is NOT set; the result carries shareNow(), which the caller
 * must call directly from a new tap (see runExport in js/ui/ajustes.js). shareNow() returns
 * the final result ('share' | 'download' | 'cancelled').
 */
export async function exportFile(dbObj) {
  const store = dbObj || appDb;
  const now = currentIso();
  const envelope = await buildEnvelope(store, now);
  const filename = exportFilename(envelope);
  const counts = envelopeCounts(envelope);
  const json = JSON.stringify(envelope, null, 2);

  const file = makeFile(json, filename);
  const canShare =
    !!file &&
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] });

  /** Plain download + remember the export date. */
  async function download() {
    downloadBlob(new Blob([json], { type: 'application/json' }), filename);
    await store.updateSettings({ lastExportAt: now });
    return { method: 'download', filename, counts };
  }

  /**
   * Open the share sheet. `fromNewTap` = called straight from a tap on 'Compartir archivo'.
   * navigator.share() is the FIRST thing that happens here (no await before it).
   */
  async function share(fromNewTap) {
    try {
      await navigator.share({ files: [file], title: filename });
    } catch (err) {
      if (err && err.name === 'AbortError') return { method: 'cancelled', filename, counts };
      if (err && err.name === 'NotAllowedError' && !fromNewTap) {
        // Not exported yet: the caller asks for a new tap and calls shareNow() from it.
        return { method: 'blocked', filename, counts, shareNow: () => share(true) };
      }
      // Any other share problem: fall back to a download.
      return download();
    }
    await store.updateSettings({ lastExportAt: now });
    return { method: 'share', filename, counts };
  }

  return canShare ? share(false) : download();
}
