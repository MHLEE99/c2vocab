// Merging and restoring "envelopes" (the one document shape used by export files,
// in-app backups and, later, Dropbox sync):
//
//   { app: 'c2vocab', schemaVersion, exportedAt, deviceId, deviceName,
//     cards: Card[] (ALL cards, including soft-deleted tombstones),
//     reviews: Review[] (ALL rows, including undone ones), settings }
//
// Everything here is PURE: no database, no clock, and the inputs are never mutated.
// The caller writes the result with db.applyDocChanges().
//
// Rules:
//   - cards: last writer wins on updatedAt for the WHOLE card (deletedAt included)
//   - reviews: union by id; an undone review stays undone
//   - card.srs is a cache: it is rebuilt from the merged review log with replay()

import { SCHEMA_VERSION, CONTENT_KEYS, hydrateCard, dupKey } from './db.js';
import { replay } from './srs.js';

const NEWER_VERSION_ERROR =
  'Este archivo es de una versión más nueva de la app. Actualiza la app (recarga) e inténtalo de nuevo.';

// ------------------------------------------------------------ small helpers

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep equality of JSON-like values. The order of object keys does not matter. */
export function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!sameValue(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!sameValue(a[k], b[k])) return false;
  }
  return true;
}

/** A copy of the card without its srs cache (used to compare what the learner wrote). */
function withoutSrs(card) {
  const copy = { ...card };
  delete copy.srs;
  return copy;
}

/**
 * Same editable content? Compares every contract content field plus deletedAt.
 * updatedAt, createdAt, srs and unknown keys are ignored.
 */
export function sameContent(a, b) {
  for (const key of CONTENT_KEYS) {
    if (!sameValue(a[key], b[key])) return false;
  }
  return (a.deletedAt || null) === (b.deletedAt || null);
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function text(v) {
  return v === null || v === undefined ? '' : String(v);
}

// ------------------------------------------------------------ validateEnvelope

/** Check the outer shape of an export/backup document. Returns { ok: true } or { ok: false, error }. */
export function validateEnvelope(doc) {
  if (!isPlainObject(doc)) {
    return { ok: false, error: 'El archivo no es una copia de c2vocab (no es un objeto JSON).' };
  }
  if (doc.app !== 'c2vocab') {
    return { ok: false, error: 'El archivo no es una copia de c2vocab (falta «app: c2vocab»).' };
  }
  if (typeof doc.schemaVersion !== 'number' || !Number.isFinite(doc.schemaVersion)) {
    return { ok: false, error: 'El archivo no indica su versión (schemaVersion).' };
  }
  if (doc.schemaVersion > SCHEMA_VERSION) {
    return { ok: false, error: NEWER_VERSION_ERROR };
  }
  if (!Array.isArray(doc.cards)) {
    return { ok: false, error: 'El archivo no contiene la lista de tarjetas (cards).' };
  }
  if (!Array.isArray(doc.reviews)) {
    return { ok: false, error: 'El archivo no contiene la lista de repasos (reviews).' };
  }
  return { ok: true };
}

// ------------------------------------------------------------ reviews

/** Does this row count for the scheduler? (same filter as srs.replay) */
function countsForSrs(review) {
  return !!review && review.mode === 'srs' && !review.undoneAt;
}

/** The earliest non-null undoneAt of two rows (null when neither was undone). */
function earliestUndone(a, b) {
  const x = a.undoneAt || null;
  const y = b.undoneAt || null;
  if (x && y) return x < y ? x : y;
  return x || y;
}

const REVIEW_DIRS = ['rec', 'prod'];

/**
 * Can this incoming review row be stored? It needs an id, a card of the merged document,
 * a direction, a readable timestamp and a rating 1-4 (numbers). Anything else (a hand-edited
 * file, a row of a card that was skipped as invalid) would break replay() or stay behind
 * as an orphan forever, because review rows are never deleted.
 */
function usableReview(r, cardIds) {
  if (!isPlainObject(r)) return false;
  if (typeof r.id !== 'string' || r.id === '') return false;
  if (typeof r.cardId !== 'string' || !cardIds.has(r.cardId)) return false;
  if (!REVIEW_DIRS.includes(r.dir)) return false;
  if (typeof r.ts !== 'string' || Number.isNaN(Date.parse(r.ts))) return false;
  return r.rating === 1 || r.rating === 2 || r.rating === 3 || r.rating === 4;
}

/**
 * Union of two review logs by id. Local rows are never dropped; incoming rows that are
 * new must be usable (see usableReview), otherwise they are skipped and counted.
 * `cardIds` = has(id) of every card of the merged document.
 * Returns { list, added, updated, invalid, changedIds, affectedCardIds } where affectedCardIds
 * are the cards whose set of counting ('srs', not undone) reviews changed.
 */
function mergeReviews(localReviews, incomingReviews, cardIds) {
  const list = [];
  const indexById = new Map();
  for (const r of asArray(localReviews)) {
    if (r && r.id !== undefined && r.id !== null && !indexById.has(r.id)) indexById.set(r.id, list.length);
    list.push(r);
  }

  let added = 0;
  let updated = 0;
  let invalid = 0;
  const changedIds = [];
  const affectedCardIds = new Set();

  for (const r of asArray(incomingReviews)) {
    const known = isPlainObject(r) && r.id !== undefined && r.id !== null && indexById.has(r.id);
    if (!known) {
      if (!usableReview(r, cardIds)) {
        invalid += 1; // skipped: it could not be replayed, or its card does not exist
        continue;
      }
      indexById.set(r.id, list.length);
      list.push({ ...r });
      added += 1;
      changedIds.push(r.id);
      if (countsForSrs(r)) affectedCardIds.add(r.cardId);
      continue;
    }
    const index = indexById.get(r.id);
    const mine = list[index];
    const undoneAt = earliestUndone(mine, r);
    if (undoneAt === (mine.undoneAt || null)) continue; // nothing new
    const wasCounting = countsForSrs(mine);
    const merged = { ...mine, undoneAt };
    list[index] = merged;
    if (!changedIds.includes(r.id)) {
      // (a row that was added from the incoming doc in this same pass is already listed)
      updated += 1;
      changedIds.push(r.id);
    }
    if (wasCounting !== countsForSrs(merged)) affectedCardIds.add(merged.cardId);
  }

  return { list, added, updated, invalid, changedIds, affectedCardIds };
}

/** Review rows grouped by cardId (so replay() only looks at one card's rows). */
function groupByCard(reviews) {
  const groups = new Map();
  for (const r of reviews) {
    if (!r) continue;
    if (!groups.has(r.cardId)) groups.set(r.cardId, []);
    groups.get(r.cardId).push(r);
  }
  return groups;
}

/** A copy of the card whose srs was rebuilt from the review log. */
function withReplayedSrs(card, reviewsByCard, settings) {
  const rows = reviewsByCard.get(card.id) || [];
  return {
    ...card,
    srs: {
      rec: replay(card.id, 'rec', rows, settings),
      prod: replay(card.id, 'prod', rows, settings),
    },
  };
}

/** Settings for replay: the explicit argument, else the local document's settings. */
function replaySettings(settings, localDoc) {
  if (isPlainObject(settings)) return settings;
  return isPlainObject(localDoc.settings) ? localDoc.settings : {};
}

/**
 * Groups of LIVE cards that share a dupKey (same expression + type under different ids)
 * where at least one card of the group is in `newIds`. Cards are matched by id only, so
 * the same expression created independently on two devices ends up twice after a merge;
 * the caller shows these groups as a warning. Returns [{ key, ids: string[] }].
 */
function findDuplicateKeys(cards, newIds) {
  const groups = new Map();
  for (const c of cards) {
    if (!c || c.deletedAt || typeof c.front !== 'string') continue;
    const key = dupKey(c.front, c.type);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c.id);
  }
  const out = [];
  for (const [key, ids] of groups) {
    if (ids.length > 1 && ids.some((id) => newIds.has(id))) out.push({ key, ids });
  }
  return out;
}

/** Assemble the output document: everything from the local doc, with the merged lists. */
function buildDoc(localDoc, cards, reviews) {
  return { ...localDoc, cards, reviews };
}

// ------------------------------------------------------------ mergeDoc

/**
 * Merge an incoming envelope into the local one.
 * Returns { doc, changedCardIds, changedReviewIds, duplicateKeys, stats } — `doc` is the merged
 * envelope (local settings / deviceId / deviceName), the id lists say which rows must be written,
 * duplicateKeys lists the live cards that now share an expression + type with another id.
 *
 * stats: cardsAdded      cards that did not exist locally
 *        cardsUpdated    local cards whose stored value changed (content and/or srs)
 *        cardsUnchanged  valid incoming cards that changed nothing
 *        cardsInvalid    incoming cards without id/front (skipped)
 *        cardsDuplicateKey  expressions that are now stored twice (see duplicateKeys)
 *        reviewsAdded / reviewsUpdated (updated = became undone, or undone earlier)
 *        reviewsInvalid  incoming review rows skipped (malformed, or of a card nobody has)
 */
export function mergeDoc(localDoc, incomingDoc, settings) {
  const local = isPlainObject(localDoc) ? localDoc : {};
  const incoming = isPlainObject(incomingDoc) ? incomingDoc : {};
  const localCards = asArray(local.cards);
  const localDevice = text(local.deviceId);
  const incomingDevice = text(incoming.deviceId);

  // Working list: local cards first (kept as they are), incoming-only cards appended.
  const cards = localCards.slice();
  const indexById = new Map();
  cards.forEach((c, i) => {
    if (c && typeof c.id === 'string' && !indexById.has(c.id)) indexById.set(c.id, i);
  });
  const originalById = new Map();
  for (const [id, i] of indexById) originalById.set(id, cards[i]);

  const touched = new Set(); // added or replaced: srs must be rebuilt
  const seenIncoming = new Set();
  let cardsInvalid = 0;

  for (const raw of asArray(incoming.cards)) {
    const card = hydrateCard(raw);
    if (!card) {
      cardsInvalid += 1;
      continue;
    }
    seenIncoming.add(card.id);
    if (!indexById.has(card.id)) {
      indexById.set(card.id, cards.length);
      cards.push(card);
      touched.add(card.id);
      continue;
    }
    const index = indexById.get(card.id);
    const mine = cards[index];
    const mineUpdated = text(mine.updatedAt);
    const theirsUpdated = text(card.updatedAt);
    let takeIncoming = false;
    if (theirsUpdated > mineUpdated) {
      takeIncoming = true;
    } else if (theirsUpdated === mineUpdated) {
      // Same timestamp: identical content -> nothing; otherwise the greater deviceId wins.
      const identical = sameValue(withoutSrs(mine), withoutSrs(card));
      takeIncoming = !identical && incomingDevice > localDevice;
    }
    if (takeIncoming) {
      cards[index] = card;
      touched.add(card.id);
    }
  }

  // Reviews: union; then rebuild the srs cache of every affected card.
  const merged = mergeReviews(local.reviews, incoming.reviews, indexById);
  const replayWith = replaySettings(settings, local);
  const reviewsByCard = groupByCard(merged.list);
  const affected = new Set(touched);
  for (const id of merged.affectedCardIds) affected.add(id);
  for (const id of affected) {
    if (!indexById.has(id)) continue; // review of a card nobody has
    const index = indexById.get(id);
    cards[index] = withReplayedSrs(cards[index], reviewsByCard, replayWith);
  }

  // What really changed compared with the local document?
  const changedCardIds = [];
  let cardsAdded = 0;
  let cardsUpdated = 0;
  for (const id of affected) {
    if (!indexById.has(id)) continue;
    const now = cards[indexById.get(id)];
    if (!originalById.has(id)) {
      cardsAdded += 1;
      changedCardIds.push(id);
    } else if (sameValue(originalById.get(id), now)) {
      cards[indexById.get(id)] = originalById.get(id); // identical: keep the stored object
    } else {
      cardsUpdated += 1;
      changedCardIds.push(id);
    }
  }
  let cardsUnchanged = 0;
  for (const id of seenIncoming) {
    if (!changedCardIds.includes(id)) cardsUnchanged += 1;
  }
  // Cards whose content came from the incoming doc and that now collide with another live card.
  const duplicateKeys = findDuplicateKeys(cards, new Set(changedCardIds.filter((id) => touched.has(id))));

  return {
    doc: buildDoc(local, cards, merged.list),
    changedCardIds,
    changedReviewIds: merged.changedIds,
    duplicateKeys,
    stats: {
      cardsAdded,
      cardsUpdated,
      cardsUnchanged,
      cardsInvalid,
      cardsDuplicateKey: duplicateKeys.length,
      reviewsAdded: merged.added,
      reviewsUpdated: merged.updated,
      reviewsInvalid: merged.invalid,
    },
  };
}

// ------------------------------------------------------------ restoreDoc

/**
 * Revert CARD CONTENT to a snapshot without losing anything newer.
 *   - snapshot card missing locally        -> added as it is
 *   - content differs (incl. deleted state) -> snapshot content, updatedAt = nowIso
 *     (so the reverted version wins future merges); createdAt stays
 *   - identical content                     -> untouched
 *   - local cards created after the snapshot are kept; reviews are only ever unioned
 *     (study history is never rolled back) and srs is rebuilt by replay.
 * Returns { doc, changedCardIds, changedReviewIds, duplicateKeys, stats } with
 * stats { cardsReverted, cardsReadded, cardsKept, cardsInvalid, cardsDuplicateKey,
 *         reviewsAdded, reviewsUpdated, reviewsInvalid }.
 * duplicateKeys: live cards that share an expression + type after the restore (e.g. a card
 * that was deleted and written again, and whose old copy comes back).
 */
export function restoreDoc(localDoc, snapshotDoc, nowIso, settings) {
  const local = isPlainObject(localDoc) ? localDoc : {};
  const snapshot = isPlainObject(snapshotDoc) ? snapshotDoc : {};

  const cards = asArray(local.cards).slice();
  const indexById = new Map();
  cards.forEach((c, i) => {
    if (c && typeof c.id === 'string' && !indexById.has(c.id)) indexById.set(c.id, i);
  });
  const originalById = new Map();
  for (const [id, i] of indexById) originalById.set(id, cards[i]);

  const touched = new Set();
  const inSnapshot = new Set();
  let cardsReverted = 0;
  let cardsReadded = 0;
  let cardsInvalid = 0;

  for (const raw of asArray(snapshot.cards)) {
    const snap = hydrateCard(raw);
    if (!snap) {
      cardsInvalid += 1;
      continue;
    }
    if (inSnapshot.has(snap.id)) continue; // a repeated id: the first one counts
    inSnapshot.add(snap.id);
    if (!indexById.has(snap.id)) {
      indexById.set(snap.id, cards.length);
      cards.push(snap);
      touched.add(snap.id);
      cardsReadded += 1;
      continue;
    }
    const index = indexById.get(snap.id);
    const mine = cards[index];
    const mineFull = hydrateCard(mine) || mine;
    if (sameContent(mineFull, snap)) continue;
    cards[index] = {
      ...snap,
      createdAt: mine.createdAt || snap.createdAt,
      updatedAt: nowIso,
      srs: mineFull.srs,
    };
    touched.add(snap.id);
    cardsReverted += 1;
  }

  let cardsKept = 0;
  for (const id of originalById.keys()) {
    if (!inSnapshot.has(id)) cardsKept += 1;
  }

  const merged = mergeReviews(local.reviews, snapshot.reviews, indexById);
  const replayWith = replaySettings(settings, local);
  const reviewsByCard = groupByCard(merged.list);
  const affected = new Set(touched);
  for (const id of merged.affectedCardIds) affected.add(id);

  const changedCardIds = [];
  for (const id of affected) {
    if (!indexById.has(id)) continue;
    const index = indexById.get(id);
    const rebuilt = withReplayedSrs(cards[index], reviewsByCard, replayWith);
    if (originalById.has(id) && sameValue(originalById.get(id), rebuilt)) {
      cards[index] = originalById.get(id);
      continue;
    }
    cards[index] = rebuilt;
    changedCardIds.push(id);
  }
  const duplicateKeys = findDuplicateKeys(cards, new Set(changedCardIds.filter((id) => touched.has(id))));

  return {
    doc: buildDoc(local, cards, merged.list),
    changedCardIds,
    changedReviewIds: merged.changedIds,
    duplicateKeys,
    stats: {
      cardsReverted,
      cardsReadded,
      cardsKept,
      cardsInvalid,
      cardsDuplicateKey: duplicateKeys.length,
      reviewsAdded: merged.added,
      reviewsUpdated: merged.updated,
      reviewsInvalid: merged.invalid,
    },
  };
}
