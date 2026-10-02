// IndexedDB access through Dexie 4.0.11 (loaded as a classic script from ./vendor/dexie.min.js,
// which defines window.Dexie before this module runs).
//
// Everything is built by createDb(name) so that tests can run against a separate database
// ('c2vocab_test'). The default export `db` is the real app database ('c2vocab').
//
// Rules enforced here (see CLAUDE.md):
//   - cards are NEVER hard-deleted: softDeleteCard sets deletedAt, restoreCard clears it
//   - every content change bumps updatedAt; createdAt never changes
//   - multi-record writes happen in ONE Dexie transaction
//   - a rating (applyReview / undoReview) never bumps card.updatedAt: srs is a cache
//     that can be recomputed from the review log
//   - reviews are append-only: undo only marks a row with undoneAt, rows are never deleted
//   - only rows of the `backups` table may ever be deleted (pruning the snapshot ring buffer)

import { uuid, nowIso, normalize } from './util.js';
import { initialSrs, DEFAULT_SETTINGS } from './srs.js';
import { normalizeTagList } from './capture.js';
import { TYPE_IDS, REGISTER_IDS, STATUS_IDS, DIRECTION_IDS } from './taxonomy.js';

const Dexie = window.Dexie;
if (!Dexie) {
  throw new Error('Dexie no está cargado: incluye ./vendor/dexie.min.js antes de js/app.js');
}

export const SCHEMA_VERSION = 1;

/** Default value of the meta row 'settings' (study settings + bookkeeping dates). */
export function defaultSettings() {
  return {
    newPerDay: DEFAULT_SETTINGS.newPerDay,
    maxReviewsPerDay: DEFAULT_SETTINGS.maxReviewsPerDay,
    sessionMinutes: DEFAULT_SETTINGS.sessionMinutes,
    learningSteps: DEFAULT_SETTINGS.learningSteps.slice(),
    dayBoundaryHour: DEFAULT_SETTINGS.dayBoundaryHour,
    examDate: null,
    lastExportAt: null,
    lastSyncAt: null,
  };
}

const SRS_DIRS = ['rec', 'prod'];

// Error text when a study session works with an outdated copy of a card
// (the same card was rated in another tab or window).
const STALE_MESSAGE = 'la tarjeta cambió en otra pestaña o ventana; vuelve a Inicio y abre Estudiar de nuevo';

/** Default rows of the `meta` table, written on first run when missing. */
function defaultMeta() {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: uuid(),
    deviceName: guessDeviceName(),
    algo: { name: 'sm2', version: 1 },
    settings: defaultSettings(),
    lastChoice: { type: 'expresion', register: 'neutro', region: '' },
  };
}

/** 'iPhone' | 'Android' | 'PC' guessed from the browser. The user can rename it later. */
export function guessDeviceName() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const platform = (typeof navigator !== 'undefined' && navigator.platform) || '';
  if (/iPhone|iPad|iPod/i.test(ua) || /iPhone|iPad/i.test(platform)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  return 'PC';
}

/** Duplicate key: accent-insensitive front + type. */
export function dupKey(front, type) {
  return normalize(front) + '|' + String(type || '');
}

function cleanString(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function cleanStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => cleanString(x).trim()).filter((x) => x !== '');
}

function cleanEquivalentes(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({ texto: cleanString(e.texto).trim(), registro: cleanString(e.registro).trim() }))
    .filter((e) => e.texto !== '');
}

function cleanTags(v) {
  return normalizeTagList(Array.isArray(v) ? v : String(v || '').split(/[\s,]+/));
}

/** Replace enum values outside the closed lists with their defaults. Mutates and returns `card`. */
function coerceEnums(card) {
  if (!TYPE_IDS.includes(card.type)) card.type = 'otro';
  if (!REGISTER_IDS.includes(card.register)) card.register = '';
  if (!DIRECTION_IDS.includes(card.direction)) card.direction = 'both';
  if (!STATUS_IDS.includes(card.status)) card.status = 'active';
  return card;
}

/**
 * Apply the status/back contract: back may be empty only while status is 'inbox',
 * and an inbox card that receives a back becomes active. Mutates and returns `card`.
 */
function applyStatusRule(card) {
  if (card.back === '') card.status = 'inbox';
  else if (card.status === 'inbox') card.status = 'active';
  return card;
}

/**
 * Build a full srs object from a possibly partial one: every SrsState key is
 * present for both directions, with the given values layered over the defaults.
 */
function cleanSrs(v) {
  const base = initialSrs();
  if (!v || typeof v !== 'object') return base;
  return {
    rec: { ...base.rec, ...(v.rec && typeof v.rec === 'object' ? v.rec : {}) },
    prod: { ...base.prod, ...(v.prod && typeof v.prod === 'object' ? v.prod : {}) },
  };
}

/**
 * Build a complete card from a partial one. Pure (no database access).
 * Every key of the card contract is present afterwards.
 * status: 'inbox' iff back is empty (unless a valid status is passed explicitly and back is non-empty).
 */
export function newCard(partial = {}) {
  const p = partial || {};
  const ts = nowIso();
  const front = cleanString(p.front).trim();
  if (front === '') {
    throw new Error('newCard: front es obligatorio');
  }

  const card = {
    id: cleanString(p.id).trim() || uuid(),
    type: p.type,
    front,
    back: cleanString(p.back).trim(),
    ko: cleanString(p.ko).trim(),
    example: cleanString(p.example).trim(),
    exampleSource: cleanString(p.exampleSource).trim(),
    exampleVerified: p.exampleVerified === true,
    register: p.register,
    region: cleanString(p.region).trim(),
    tags: cleanTags(p.tags),
    colocaciones: cleanStringArray(p.colocaciones),
    equivalentes: cleanEquivalentes(p.equivalentes),
    contraste: cleanString(p.contraste).trim(),
    source: cleanString(p.source).trim(),
    notes: cleanString(p.notes),
    direction: p.direction,
    status: p.status,
    createdAt: cleanString(p.createdAt) || ts,
    updatedAt: cleanString(p.updatedAt) || ts,
    deletedAt: p.deletedAt ? cleanString(p.deletedAt) : null,
    srs: cleanSrs(p.srs),
  };
  coerceEnums(card);
  return applyStatusRule(card);
}

/** Every key of the card contract, in the order newCard writes them. */
export const CARD_KEYS = [
  'id',
  'type',
  'front',
  'back',
  'ko',
  'example',
  'exampleSource',
  'exampleVerified',
  'register',
  'region',
  'tags',
  'colocaciones',
  'equivalentes',
  'contraste',
  'source',
  'notes',
  'direction',
  'status',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'srs',
];

/** The keys a learner can edit (everything except id, timestamps and srs). */
export const CONTENT_KEYS = CARD_KEYS.filter(
  (k) => k !== 'id' && k !== 'createdAt' && k !== 'updatedAt' && k !== 'deletedAt' && k !== 'srs'
);

// Timestamp used when a stored/exported card has none (hydrateCard is pure: no clock).
const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

/**
 * Lenient read of a stored or exported card. Pure (no clock, no database), never mutates `raw`.
 * Returns a full contract card, or null when the id or the front is missing.
 * id, createdAt, updatedAt, deletedAt and every UNKNOWN extra key are kept as they are;
 * missing contract keys get their defaults, enums are coerced like in newCard and
 * srs is completed over initialSrs().
 */
export function hydrateCard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return null;
  if (typeof raw.front !== 'string' || raw.front.trim() === '') return null;

  const createdAt = cleanString(raw.createdAt) || cleanString(raw.updatedAt) || EPOCH_ISO;
  const updatedAt = cleanString(raw.updatedAt) || createdAt;

  const card = {
    ...raw, // unknown keys (from a newer version or another tool) survive
    id: raw.id,
    type: raw.type,
    front: raw.front.trim(),
    back: cleanString(raw.back).trim(),
    ko: cleanString(raw.ko).trim(),
    example: cleanString(raw.example).trim(),
    exampleSource: cleanString(raw.exampleSource).trim(),
    exampleVerified: raw.exampleVerified === true,
    register: raw.register,
    region: cleanString(raw.region).trim(),
    tags: cleanTags(raw.tags),
    colocaciones: cleanStringArray(raw.colocaciones),
    equivalentes: cleanEquivalentes(raw.equivalentes),
    contraste: cleanString(raw.contraste).trim(),
    source: cleanString(raw.source).trim(),
    notes: cleanString(raw.notes),
    direction: raw.direction,
    status: raw.status,
    createdAt,
    updatedAt,
    deletedAt: raw.deletedAt ? cleanString(raw.deletedAt) : null,
    srs: cleanSrs(raw.srs),
  };
  coerceEnums(card);
  return applyStatusRule(card);
}

/**
 * The card that results from merging `patch` into `card` at time `ts`. Pure, returns a new object.
 * This is THE edit rule of the app (used by updateCard and importCards):
 * id/createdAt/deletedAt cannot be patched, undefined values mean "not patched",
 * enums are coerced, the status/back rule is applied and updatedAt becomes `ts`.
 */
function patchCard(card, patch, ts) {
  const p = { ...(patch || {}) };
  delete p.id;
  delete p.createdAt;
  delete p.updatedAt;
  delete p.deletedAt;
  for (const key of Object.keys(p)) {
    if (p[key] === undefined) delete p[key];
  }
  if ('tags' in p) p.tags = cleanTags(p.tags);
  if ('front' in p) p.front = cleanString(p.front).trim();
  if ('back' in p) p.back = cleanString(p.back).trim();
  if ('colocaciones' in p) p.colocaciones = cleanStringArray(p.colocaciones);
  if ('equivalentes' in p) p.equivalentes = cleanEquivalentes(p.equivalentes);
  if ('srs' in p) p.srs = cleanSrs(p.srs);
  const merged = { ...card, ...p };
  if (merged.front === '') merged.front = card.front; // never blank a front
  coerceEnums(merged);
  applyStatusRule(merged);
  merged.updatedAt = ts;
  return merged;
}

/**
 * Create a database handle. Returns an object with the Dexie instance (`dexie`)
 * and all data-access functions bound to it.
 */
export function createDb(name = 'c2vocab') {
  const dexie = new Dexie(name);

  // NOTE on indexes: IndexedDB cannot index null/undefined/boolean values, so
  // `deletedAt: null` rows are simply absent from the deletedAt index and
  // where('deletedAt').equals(null) would throw. We therefore load cards with
  // toArray() and filter in JS (fine for a few thousand cards).
  // Schema changes after step 6 must go through db.version(n+1).stores().upgrade().
  dexie.version(1).stores({
    cards: 'id, updatedAt, deletedAt, type, status, *tags, srs.rec.due, srs.prod.due',
    reviews: 'id, cardId, ts',
    meta: 'key',
    backups: '++id, createdAt',
  });

  /** Write default meta rows that are missing. Safe to call on every start. */
  async function initMeta() {
    const defaults = defaultMeta();
    await dexie.transaction('rw', dexie.meta, async () => {
      for (const key of Object.keys(defaults)) {
        const existing = await dexie.meta.get(key);
        if (!existing) {
          await dexie.meta.put({ key, value: defaults[key] });
        }
      }
    });
  }

  async function getMeta(key) {
    const row = await dexie.meta.get(key);
    return row ? row.value : undefined;
  }

  async function setMeta(key, value) {
    await dexie.meta.put({ key, value });
  }

  /** Insert complete cards (already passed through newCard) in one transaction. Returns count. */
  async function addCards(cards) {
    const list = Array.isArray(cards) ? cards : [];
    if (list.length === 0) return 0;
    for (const c of list) {
      if (!c || !c.id || !c.front) throw new Error('addCards: tarjeta incompleta (usa newCard)');
    }
    await dexie.transaction('rw', dexie.cards, async () => {
      await dexie.cards.bulkAdd(list);
    });
    return list.length;
  }

  async function getCard(id) {
    return dexie.cards.get(id);
  }

  /**
   * Merge `patch` into a card and bump updatedAt. id/createdAt/deletedAt cannot be
   * changed here (use softDeleteCard/restoreCard for the tombstone). Keys whose value
   * is undefined are treated as "not patched". Enum fields are coerced like in newCard.
   * If the merged card is inbox but now has a back, it becomes active; a card whose
   * back becomes empty always drops to inbox (back may be empty only in inbox).
   * Returns the stored card, or null when the id does not exist.
   */
  async function updateCard(id, patch = {}) {
    return dexie.transaction('rw', dexie.cards, async () => {
      const card = await dexie.cards.get(id);
      if (!card) return null;
      const merged = patchCard(card, patch, nowIso());
      await dexie.cards.put(merged);
      return merged;
    });
  }

  /** Tombstone a card. Never removes the row. */
  async function softDeleteCard(id) {
    return dexie.transaction('rw', dexie.cards, async () => {
      const card = await dexie.cards.get(id);
      if (!card) return null;
      const ts = nowIso();
      card.deletedAt = ts;
      card.updatedAt = ts;
      await dexie.cards.put(card);
      return card;
    });
  }

  /** Undo a soft delete. */
  async function restoreCard(id) {
    return dexie.transaction('rw', dexie.cards, async () => {
      const card = await dexie.cards.get(id);
      if (!card) return null;
      card.deletedAt = null;
      card.updatedAt = nowIso();
      await dexie.cards.put(card);
      return card;
    });
  }

  /**
   * All cards, filtered by tombstone state and sorted by updatedAt desc.
   * {deleted:false} (default) -> live cards; {deleted:true} -> Papelera.
   */
  async function listCards({ deleted = false } = {}) {
    const all = await dexie.cards.toArray();
    const filtered = all.filter((c) => (deleted ? !!c.deletedAt : !c.deletedAt));
    filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return filtered;
  }

  /** Unique tags across live cards with usage counts: [{tag, count}] sorted by count desc, tag asc. */
  async function allTags() {
    const cards = await listCards({ deleted: false });
    const counts = new Map();
    for (const c of cards) {
      for (const t of c.tags || []) {
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    const list = Array.from(counts, ([tag, count]) => ({ tag, count }));
    list.sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    return list;
  }

  /** First live card with the same normalized front and type, or null. */
  async function findDuplicate(front, type) {
    const key = dupKey(front, type);
    const cards = await listCards({ deleted: false });
    return cards.find((c) => dupKey(c.front, c.type) === key) || null;
  }

  /** Set of dupKey() for every live card — for checking many fronts at once. */
  async function existingKeys() {
    const cards = await listCards({ deleted: false });
    return new Set(cards.map((c) => dupKey(c.front, c.type)));
  }

  /** Stored settings merged over the defaults (works even before initMeta has run). */
  async function getSettings() {
    const stored = await getMeta('settings');
    const safe = stored && typeof stored === 'object' ? stored : {};
    return { ...defaultSettings(), ...safe };
  }

  /** Every row of the review log (including undone ones; filter with !r.undoneAt). */
  async function listReviews() {
    return dexie.reviews.toArray();
  }

  /** The stored srs state of one direction (empty object if the card has none). */
  function storedSrs(card, dir) {
    return card.srs && card.srs[dir] ? card.srs[dir] : {};
  }

  /**
   * Persist one rating: append the review row AND store the card's new srs state
   * for that direction, in ONE transaction. Does NOT bump card.updatedAt.
   * Throws (and writes nothing) if the card is missing or the review id already exists.
   *
   * expectedPrev (optional): the state the rating was computed from. When given, the
   * stored state must still be at the same point (same reps and lastReviewAt); if another
   * tab or window rated the card in the meantime, nothing is written and an error is
   * thrown. This keeps "stored srs == replay(review log)" true.
   */
  async function applyReview(review, nextState, expectedPrev) {
    if (!review || !review.id || !review.cardId) throw new Error('applyReview: repaso incompleto');
    if (!SRS_DIRS.includes(review.dir)) throw new Error('applyReview: dirección no válida');
    if (!nextState || typeof nextState !== 'object') throw new Error('applyReview: falta el estado nuevo');
    await dexie.transaction('rw', dexie.cards, dexie.reviews, async () => {
      const card = await dexie.cards.get(review.cardId);
      if (!card) throw new Error('applyReview: la tarjeta no existe');
      if (expectedPrev && typeof expectedPrev === 'object') {
        const stored = storedSrs(card, review.dir);
        const sameReps = (stored.reps || 0) === (expectedPrev.reps || 0);
        const sameLast = (stored.lastReviewAt || null) === (expectedPrev.lastReviewAt || null);
        if (!sameReps || !sameLast) throw new Error(STALE_MESSAGE);
      }
      await dexie.reviews.add(review);
      await dexie.cards.update(review.cardId, { ['srs.' + review.dir]: { ...nextState } });
    });
  }

  /**
   * Undo one rating: mark the review row with undoneAt (the row is kept) AND put
   * the previous srs state back on the card, in ONE transaction. Does NOT bump
   * card.updatedAt. Returns the undoneAt timestamp.
   * Throws (and writes nothing) if the review was already undone, belongs to another
   * card/direction, or is not the card's latest rating (another tab rated it since).
   */
  async function undoReview(reviewId, cardId, dir, prevState) {
    if (!SRS_DIRS.includes(dir)) throw new Error('undoReview: dirección no válida');
    if (!prevState || typeof prevState !== 'object') throw new Error('undoReview: falta el estado anterior');
    const undoneAt = nowIso();
    await dexie.transaction('rw', dexie.cards, dexie.reviews, async () => {
      const review = await dexie.reviews.get(reviewId);
      if (!review) throw new Error('undoReview: el repaso no existe');
      const card = await dexie.cards.get(cardId);
      if (!card) throw new Error('undoReview: la tarjeta no existe');
      if (review.undoneAt) throw new Error('undoReview: el repaso ya estaba deshecho');
      if (review.cardId !== cardId || review.dir !== dir) {
        throw new Error('undoReview: el repaso no pertenece a esa tarjeta');
      }
      // Only the latest rating of the card can be undone.
      if ((storedSrs(card, dir).lastReviewAt || null) !== review.ts) throw new Error(STALE_MESSAGE);
      await dexie.reviews.update(reviewId, { undoneAt });
      await dexie.cards.update(cardId, { ['srs.' + dir]: { ...prevState } });
    });
    return undoneAt;
  }

  // ---------------------------------------------------------------- step 3

  /** Every card row, including soft-deleted ones (tombstones). No sorting. */
  async function allCardsIncludingDeleted() {
    return dexie.cards.toArray();
  }

  /**
   * Merge `patch` into the meta row 'settings' (over the defaults) in one transaction.
   * Returns the stored settings.
   */
  async function updateSettings(patch) {
    return dexie.transaction('rw', dexie.meta, async () => {
      const row = await dexie.meta.get('settings');
      const stored = row && row.value && typeof row.value === 'object' ? row.value : {};
      const merged = { ...defaultSettings(), ...stored, ...(patch || {}) };
      await dexie.meta.put({ key: 'settings', value: merged });
      return merged;
    });
  }

  /**
   * Write the cards and reviews that a merge or a restore changed, in ONE transaction.
   * Rows are put whole (bulkPut = insert or replace). Nothing is ever deleted.
   * Returns { cards, reviews } (how many rows were written).
   */
  async function applyDocChanges({ cards = [], reviews = [] } = {}) {
    const cardList = Array.isArray(cards) ? cards : [];
    const reviewList = Array.isArray(reviews) ? reviews : [];
    for (const c of cardList) {
      if (!c || !c.id || !c.front) throw new Error('applyDocChanges: tarjeta incompleta');
    }
    for (const r of reviewList) {
      if (!r || !r.id) throw new Error('applyDocChanges: repaso incompleto');
    }
    if (cardList.length === 0 && reviewList.length === 0) return { cards: 0, reviews: 0 };
    await dexie.transaction('rw', dexie.cards, dexie.reviews, async () => {
      if (cardList.length > 0) await dexie.cards.bulkPut(cardList);
      if (reviewList.length > 0) await dexie.reviews.bulkPut(reviewList);
    });
    return { cards: cardList.length, reviews: reviewList.length };
  }

  /**
   * Bulk import in ONE transaction: add the new cards (complete cards from newCard) and
   * patch existing ones with the same rules as updateCard (updatedAt bump, status rule).
   * If anything fails (duplicate id, unknown id to update) nothing at all is written.
   * Returns { added, updated }.
   */
  async function importCards({ toAdd = [], toUpdate = [] } = {}) {
    const addList = Array.isArray(toAdd) ? toAdd : [];
    const updateList = Array.isArray(toUpdate) ? toUpdate : [];
    for (const c of addList) {
      if (!c || !c.id || !c.front) throw new Error('importCards: tarjeta incompleta (usa newCard)');
    }
    for (const u of updateList) {
      if (!u || !u.id) throw new Error('importCards: actualización sin id');
    }
    if (addList.length === 0 && updateList.length === 0) return { added: 0, updated: 0 };
    await dexie.transaction('rw', dexie.cards, async () => {
      if (addList.length > 0) await dexie.cards.bulkAdd(addList);
      const ts = nowIso();
      for (const u of updateList) {
        const card = await dexie.cards.get(u.id);
        if (!card) throw new Error('importCards: la tarjeta no existe: ' + u.id);
        await dexie.cards.put(patchCard(card, u.patch, ts));
      }
    });
    return { added: addList.length, updated: updateList.length };
  }

  /** A backup row without its (large) json string. */
  function backupInfo(row) {
    const info = { ...row };
    delete info.json;
    return info;
  }

  /**
   * Store one snapshot row and prune the table to the `keep` most recently STORED rows,
   * in ONE transaction. Pruning goes by the auto-increment id, not by createdAt: the row
   * just added always survives, even when the device clock went backwards.
   * Only rows of `backups` are ever deleted. Returns the new row id.
   */
  async function addBackup(row, keep = 10) {
    return dexie.transaction('rw', dexie.backups, async () => {
      const id = await dexie.backups.add(row);
      const ids = await dexie.backups.toCollection().primaryKeys(); // ascending id = oldest first
      const extra = ids.length - keep;
      if (extra > 0) await dexie.backups.bulkDelete(ids.slice(0, extra));
      return id;
    });
  }

  /** Backups, newest first, WITHOUT the json string: [{ id, createdAt, reason, cards, reviews }]. */
  async function listBackups() {
    const rows = await dexie.backups.toArray();
    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return b.id - a.id;
    });
    return rows.map(backupInfo);
  }

  /** One full backup row (with json), or undefined. */
  async function getBackup(id) {
    return dexie.backups.get(id);
  }

  return {
    name,
    dexie,
    initMeta,
    getMeta,
    setMeta,
    newCard,
    addCards,
    getCard,
    updateCard,
    softDeleteCard,
    restoreCard,
    listCards,
    allTags,
    findDuplicate,
    existingKeys,
    getSettings,
    listReviews,
    applyReview,
    undoReview,
    hydrateCard,
    allCardsIncludingDeleted,
    updateSettings,
    applyDocChanges,
    importCards,
    addBackup,
    listBackups,
    getBackup,
  };
}

// The application database. Views import these bound functions directly.
export const db = createDb('c2vocab');
export const initMeta = db.initMeta;
export const getMeta = db.getMeta;
export const setMeta = db.setMeta;
export const addCards = db.addCards;
export const getCard = db.getCard;
export const updateCard = db.updateCard;
export const softDeleteCard = db.softDeleteCard;
export const restoreCard = db.restoreCard;
export const listCards = db.listCards;
export const allTags = db.allTags;
export const findDuplicate = db.findDuplicate;
export const existingKeys = db.existingKeys;
export const getSettings = db.getSettings;
export const listReviews = db.listReviews;
export const applyReview = db.applyReview;
export const undoReview = db.undoReview;
export const allCardsIncludingDeleted = db.allCardsIncludingDeleted;
export const updateSettings = db.updateSettings;
export const applyDocChanges = db.applyDocChanges;
export const importCards = db.importCards;

export default db;
