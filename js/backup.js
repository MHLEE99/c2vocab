// In-app safety net and the database side of importing.
//
//   - snapshot(): a copy of the whole envelope inside the `backups` table (ring buffer of 10)
//   - previewRestore() / restoreBackup(): revert card CONTENT to a snapshot (merge.restoreDoc);
//     the study history is never rolled back
//   - previewImportEnvelope() / importEnvelope(): merge an export file (merge.mergeDoc)
//   - planCardImport() / commitCardImport(): bulk import of new cards (js/importer.js rows)
//
// Cards and reviews are NEVER deleted here. Only rows of `backups` are pruned.
// createBackupApi(dbObj) builds the functions for one database (tests use 'c2vocab_test');
// the exports at the bottom are bound to the app database.

import { db as appDb, newCard, dupKey } from './db.js';
import { nowIso as currentIso } from './util.js';
import { buildEnvelope } from './export.js';
import { validateEnvelope, mergeDoc, restoreDoc } from './merge.js';
import { enrichPatch, overwritePatch, inboxKey } from './importer.js';

export const BACKUP_KEEP = 10;
export const SESSION_THROTTLE_MS = 60 * 60 * 1000; // at most one 'session' backup per hour
export const BACKUP_REASONS = ['session', 'pre-import', 'pre-restore', 'manual'];

/** Spanish label of a backup reason (for the Copias list). */
export function backupReasonLabel(reason) {
  if (reason === 'session') return 'Después de estudiar';
  if (reason === 'pre-import') return 'Antes de importar';
  if (reason === 'pre-restore') return 'Antes de restaurar';
  if (reason === 'manual') return 'Manual';
  return String(reason || '');
}

/** The rows of `doc` whose id is in `ids`. */
function pickById(rows, ids) {
  const wanted = new Set(ids);
  return rows.filter((row) => row && wanted.has(row.id));
}

export function createBackupApi(dbObj) {
  const store = dbObj;

  /**
   * Store a snapshot of everything. Returns { id, createdAt, reason, cards, reviews },
   * or null when it was skipped (no cards at all, or a 'session' snapshot younger than 60 min exists).
   */
  async function snapshot(reason, nowIso) {
    const now = nowIso || currentIso();
    const envelope = await buildEnvelope(store, now);
    if (envelope.cards.length === 0) return null;

    if (reason === 'session') {
      const existing = await store.listBackups(); // newest first
      const lastSession = existing.find((b) => b.reason === 'session');
      if (lastSession) {
        const age = Date.parse(now) - Date.parse(lastSession.createdAt);
        if (age >= 0 && age < SESSION_THROTTLE_MS) return null;
      }
    }

    const row = {
      createdAt: now,
      reason,
      json: JSON.stringify(envelope),
      cards: envelope.cards.filter((c) => !c.deletedAt).length,
      reviews: envelope.reviews.length,
    };
    const id = await store.addBackup(row, BACKUP_KEEP);
    return { id, createdAt: row.createdAt, reason: row.reason, cards: row.cards, reviews: row.reviews };
  }

  /** Backups without their json, newest first: [{ id, createdAt, reason, cards, reviews }]. */
  async function listBackups() {
    return store.listBackups();
  }

  /** One full backup row { id, createdAt, reason, json, cards, reviews }, or undefined. */
  async function getBackup(id) {
    return store.getBackup(id);
  }

  /** The envelope stored in a backup row. Throws a Spanish error when it cannot be read. */
  async function loadBackupDoc(id) {
    const row = await store.getBackup(id);
    if (!row) throw new Error('Esa copia ya no existe.');
    let doc = null;
    try {
      doc = JSON.parse(row.json);
    } catch (e) {
      throw new Error('La copia está dañada y no se puede leer.');
    }
    const check = validateEnvelope(doc);
    if (!check.ok) throw new Error(check.error);
    return doc;
  }

  /** What restoring this backup WOULD change (no writes): the restoreDoc result. */
  async function previewRestore(id, nowIso) {
    const now = nowIso || currentIso();
    const snapshotDoc = await loadBackupDoc(id);
    const local = await buildEnvelope(store, now);
    return restoreDoc(local, snapshotDoc, now, local.settings);
  }

  /**
   * Restore a backup: take a 'pre-restore' snapshot first, then write the changed rows.
   * Returns { stats, changedCardIds, changedReviewIds, duplicateKeys, safetyBackupId }.
   */
  async function restoreBackup(id, nowIso) {
    const now = nowIso || currentIso();
    // Read the backup BEFORE taking the safety snapshot (pruning could remove the oldest row).
    const snapshotDoc = await loadBackupDoc(id);
    const safety = await snapshot('pre-restore', now);
    const local = await buildEnvelope(store, now);
    const result = restoreDoc(local, snapshotDoc, now, local.settings);
    await store.applyDocChanges({
      cards: pickById(result.doc.cards, result.changedCardIds),
      reviews: pickById(result.doc.reviews, result.changedReviewIds),
    });
    return {
      stats: result.stats,
      changedCardIds: result.changedCardIds,
      changedReviewIds: result.changedReviewIds,
      duplicateKeys: result.duplicateKeys,
      safetyBackupId: safety ? safety.id : null,
    };
  }

  /** Dry run of importEnvelope: the mergeDoc result, nothing written. Throws on an invalid envelope. */
  async function previewImportEnvelope(envelope, nowIso) {
    const check = validateEnvelope(envelope);
    if (!check.ok) throw new Error(check.error);
    const local = await buildEnvelope(store, nowIso || currentIso());
    return mergeDoc(local, envelope, local.settings);
  }

  /**
   * Merge an export file into the database. When the merge changes something, a
   * 'pre-import' snapshot is taken first and the changed rows are written in one transaction.
   * Returns { stats, changedCardIds, changedReviewIds, duplicateKeys }. Throws a Spanish error on an invalid envelope.
   */
  async function importEnvelope(envelope, nowIso) {
    const now = nowIso || currentIso();
    const result = await previewImportEnvelope(envelope, now);
    const hasChanges = result.changedCardIds.length > 0 || result.changedReviewIds.length > 0;
    if (hasChanges) {
      await snapshot('pre-import', now);
      await store.applyDocChanges({
        cards: pickById(result.doc.cards, result.changedCardIds),
        reviews: pickById(result.doc.reviews, result.changedReviewIds),
      });
    }
    return {
      stats: result.stats,
      changedCardIds: result.changedCardIds,
      changedReviewIds: result.changedReviewIds,
      duplicateKeys: result.duplicateKeys,
    };
  }

  /**
   * Map dupKey -> live card, to pass to importer.classifyRows as `existing`.
   * Inbox cards without a definition are also listed under inboxKey(front), so an
   * imported row with the same front completes them whatever its type.
   */
  async function existingCardMap() {
    const cards = await store.listCards({ deleted: false });
    const map = new Map();
    for (const c of cards) {
      const key = dupKey(c.front, c.type);
      if (!map.has(key)) map.set(key, c);
    }
    for (const c of cards) {
      if (c.status !== 'inbox' || c.back !== '') continue;
      const key = inboxKey(c.front);
      if (!map.has(key)) map.set(key, c);
    }
    return map;
  }

  /**
   * Decide what importing these classified rows would write (no writes).
   * mode for duplicates: 'omitir' | 'enriquecer' | 'sobrescribir'.
   * Returns { toAdd: Card[], toUpdate: [{ id, patch }], counts: { added, updated, unchanged, skipped } }
   *   added     new cards
   *   updated   duplicates that receive a patch
   *   unchanged duplicates where the patch would change nothing
   *   skipped   everything else (invalid rows, repeated rows, duplicates in mode 'omitir')
   */
  async function planCardImport(classifiedRows, mode) {
    const rows = Array.isArray(classifiedRows) ? classifiedRows : [];
    const byKey = await existingCardMap();
    const toAdd = [];
    const toUpdate = [];
    const counts = { added: 0, updated: 0, unchanged: 0, skipped: 0 };
    const patchedIds = new Set();

    for (const row of rows) {
      if (!row || !row.card) {
        counts.skipped += 1;
      } else if (row.status === 'nueva') {
        toAdd.push(newCard(row.card));
        counts.added += 1;
      } else if (row.status === 'duplicada' && (mode === 'enriquecer' || mode === 'sobrescribir')) {
        const existing = byKey.get(row.key || dupKey(row.card.front, row.card.type));
        if (!existing || patchedIds.has(existing.id)) {
          counts.skipped += 1;
          continue;
        }
        // A type that is only the import default never replaces the existing card's type.
        const options = { typeExplicit: row.typeExplicit !== false };
        const patch = mode === 'enriquecer' ? enrichPatch(existing, row.card, options) : overwritePatch(existing, row.card, options);
        if (patch) {
          toUpdate.push({ id: existing.id, patch });
          patchedIds.add(existing.id);
          counts.updated += 1;
        } else {
          counts.unchanged += 1;
        }
      } else {
        counts.skipped += 1;
      }
    }
    return { toAdd, toUpdate, counts };
  }

  /**
   * Import classified rows: plan, take a 'pre-import' snapshot when something will be
   * written, then write everything in ONE transaction (db.importCards).
   * Returns { added, updated, unchanged, skipped }.
   */
  async function commitCardImport(classifiedRows, mode, nowIso) {
    const plan = await planCardImport(classifiedRows, mode);
    if (plan.toAdd.length > 0 || plan.toUpdate.length > 0) {
      await snapshot('pre-import', nowIso || currentIso());
      await store.importCards({ toAdd: plan.toAdd, toUpdate: plan.toUpdate });
    }
    return plan.counts;
  }

  return {
    snapshot,
    listBackups,
    getBackup,
    previewRestore,
    restoreBackup,
    previewImportEnvelope,
    importEnvelope,
    existingCardMap,
    planCardImport,
    commitCardImport,
  };
}

// The functions bound to the application database. Views import these directly.
const api = createBackupApi(appDb);
export const snapshot = api.snapshot;
export const listBackups = api.listBackups;
export const getBackup = api.getBackup;
export const previewRestore = api.previewRestore;
export const restoreBackup = api.restoreBackup;
export const previewImportEnvelope = api.previewImportEnvelope;
export const importEnvelope = api.importEnvelope;
export const existingCardMap = api.existingCardMap;
export const planCardImport = api.planCardImport;
export const commitCardImport = api.commitCardImport;
