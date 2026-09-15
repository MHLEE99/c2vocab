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

import { uuid, nowIso, normalize } from './util.js';
import { initialSrs } from './srs.js';
import { normalizeTagList } from './capture.js';
import { TYPE_IDS, REGISTER_IDS, STATUS_IDS, DIRECTION_IDS } from './taxonomy.js';

const Dexie = window.Dexie;
if (!Dexie) {
  throw new Error('Dexie no está cargado: incluye ./vendor/dexie.min.js antes de js/app.js');
}

export const SCHEMA_VERSION = 1;

/** Default rows of the `meta` table, written on first run when missing. */
function defaultMeta() {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: uuid(),
    deviceName: guessDeviceName(),
    algo: { name: 'sm2', version: 1 },
    settings: {
      newPerDay: 15,
      maxReviewsPerDay: 200,
      sessionMinutes: 15,
      learningSteps: [10, 1440],
      dayBoundaryHour: 4,
      examDate: null,
      lastExportAt: null,
      lastSyncAt: null,
    },
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
      const p = { ...patch };
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
      merged.updatedAt = nowIso();
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

export default db;
