// Tests for js/merge.js (pure) and db.hydrateCard: merging two envelopes and
// reverting card content to a snapshot. Fixed timestamps, fuzz off.

import { test, assert, eq, deepEq } from './harness.js';
import { initialState, initialSrs, next, replay } from '../srs.js';
import { hydrateCard, CARD_KEYS } from '../db.js';
import { validateEnvelope, mergeDoc, restoreDoc, sameValue, sameContent } from '../merge.js';

const S = { fuzz: false, learningSteps: [10, 1440], dayBoundaryHour: 4 };

const T0 = '2026-09-01T10:00:00.000Z';
const T1 = '2026-09-10T10:00:00.000Z';
const T2 = '2026-09-20T10:00:00.000Z';
const T3 = '2026-09-25T10:00:00.000Z';
const NOW = '2026-10-03T09:00:00.000Z';

/** A full contract card; `extra` overrides any key. */
function card(id, extra) {
  return hydrateCard({ id, front: 'expresión ' + id, back: 'definición ' + id, type: 'locucion', createdAt: T0, updatedAt: T0, ...(extra || {}) });
}

function review(id, cardId, ts, rating, extra) {
  return {
    id,
    cardId,
    dir: 'rec',
    ts,
    rating,
    mode: 'srs',
    deviceId: 'dev',
    stateBefore: 'new',
    elapsedDays: 0,
    scheduledDays: 0,
    elapsedMs: 1000,
    undoneAt: null,
    ...(extra || {}),
  };
}

/** An envelope whose cards carry the srs that replay() gives for its own reviews. */
function doc(deviceId, cards, reviews) {
  const rows = reviews || [];
  return {
    app: 'c2vocab',
    schemaVersion: 1,
    exportedAt: T3,
    deviceId,
    deviceName: 'nombre-' + deviceId,
    cards: cards.map((c) => ({ ...c, srs: { rec: replay(c.id, 'rec', rows, S), prod: replay(c.id, 'prod', rows, S) } })),
    reviews: rows,
    settings: { ...S, newPerDay: deviceId === 'A' ? 15 : 30 },
  };
}

function byId(list, id) {
  return list.find((x) => x.id === id);
}

function sortedById(list) {
  return list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

// ------------------------------------------------------------ validateEnvelope

test('merge: validateEnvelope accepts a good envelope and explains bad ones in Spanish', () => {
  deepEq(validateEnvelope(doc('A', [card('c1')], [])), { ok: true });
  deepEq(validateEnvelope({ app: 'c2vocab', schemaVersion: 1, cards: [], reviews: [] }), { ok: true });

  for (const bad of [null, undefined, 'texto', 42, [], [{ app: 'c2vocab' }]]) {
    const r = validateEnvelope(bad);
    eq(r.ok, false);
    assert(typeof r.error === 'string' && r.error.length > 10, 'has a message');
  }
  eq(validateEnvelope({ app: 'otra', schemaVersion: 1, cards: [], reviews: [] }).ok, false, 'wrong app');
  eq(validateEnvelope({ schemaVersion: 1, cards: [], reviews: [] }).ok, false, 'missing app');
  eq(validateEnvelope({ app: 'c2vocab', schemaVersion: 1, reviews: [] }).ok, false, 'missing cards');
  eq(validateEnvelope({ app: 'c2vocab', schemaVersion: 1, cards: {}, reviews: [] }).ok, false, 'cards not an array');
  eq(validateEnvelope({ app: 'c2vocab', schemaVersion: 1, cards: [] }).ok, false, 'missing reviews');
  eq(validateEnvelope({ app: 'c2vocab', schemaVersion: '1', cards: [], reviews: [] }).ok, false, 'schemaVersion not a number');
  eq(validateEnvelope({ app: 'c2vocab', cards: [], reviews: [] }).ok, false, 'schemaVersion missing');

  const newer = validateEnvelope({ app: 'c2vocab', schemaVersion: 2, cards: [], reviews: [] });
  eq(newer.ok, false);
  eq(newer.error, 'Este archivo es de una versión más nueva de la app. Actualiza la app (recarga) e inténtalo de nuevo.');
});

// ------------------------------------------------------------ hydrateCard

test('merge: hydrateCard needs id and front, fills defaults, keeps timestamps and unknown keys', () => {
  eq(hydrateCard(null), null);
  eq(hydrateCard('x'), null);
  eq(hydrateCard([]), null);
  eq(hydrateCard({ front: 'sin id' }), null);
  eq(hydrateCard({ id: '', front: 'x' }), null);
  eq(hydrateCard({ id: 7, front: 'x' }), null, 'id must be a string');
  eq(hydrateCard({ id: 'a' }), null);
  eq(hydrateCard({ id: 'a', front: '   ' }), null);

  const raw = {
    id: 'a',
    front: ' dar en el clavo ',
    back: 'acertar',
    type: 'Locución',
    register: 'nope',
    direction: 'x',
    status: 'raro',
    tags: '#Tema:X, y',
    createdAt: T0,
    updatedAt: T1,
    deletedAt: T2,
    futuro: { n: 1 },
    srs: { rec: { state: 'review', reps: 4 } },
  };
  const before = clone(raw);
  const c = hydrateCard(raw);
  deepEq(raw, before, 'the input is not mutated');
  for (const k of CARD_KEYS) assert(k in c, 'has ' + k);
  eq(c.id, 'a');
  eq(c.front, 'dar en el clavo');
  eq(c.type, 'otro', 'unknown type coerced');
  eq(c.register, '');
  eq(c.direction, 'both');
  eq(c.status, 'active');
  deepEq(c.tags, ['tema:x', 'y']);
  eq(c.createdAt, T0);
  eq(c.updatedAt, T1);
  eq(c.deletedAt, T2);
  deepEq(c.futuro, { n: 1 }, 'unknown key kept');
  eq(c.srs.rec.state, 'review');
  eq(c.srs.rec.reps, 4);
  eq(c.srs.rec.ease, 2.5, 'srs completed');
  deepEq(c.srs.prod, initialState());
  eq(c.exampleVerified, false);
  deepEq(c.colocaciones, []);
  deepEq(c.equivalentes, []);
  eq(c.notes, '');

  const minimal = hydrateCard({ id: 'b', front: 'solo' });
  eq(minimal.status, 'inbox', 'no back -> inbox');
  eq(minimal.deletedAt, null);
  deepEq(minimal.srs, initialSrs());
  eq(minimal.createdAt, minimal.updatedAt);
  assert(!Number.isNaN(Date.parse(minimal.createdAt)), 'a valid timestamp even when none was given');
  assert(sameValue(hydrateCard(c), c), 'hydrating twice changes nothing');
});

// ------------------------------------------------------------ mergeDoc: cards

test('merge: only-local cards are kept, only-incoming cards are added, invalid ones are counted', () => {
  const local = doc('A', [card('c1')]);
  const incoming = doc('B', [card('c2', { visto: true })]);
  incoming.cards.push({ id: 'sin-front' }, { front: 'sin id' }, null);

  const r = mergeDoc(local, incoming, S);
  deepEq(r.doc.cards.map((c) => c.id), ['c1', 'c2']);
  deepEq(r.changedCardIds, ['c2']);
  deepEq(r.stats, { cardsAdded: 1, cardsUpdated: 0, cardsUnchanged: 0, cardsInvalid: 3, cardsDuplicateKey: 0, reviewsAdded: 0, reviewsUpdated: 0, reviewsInvalid: 0 });
  deepEq(r.duplicateKeys, []);
  eq(byId(r.doc.cards, 'c2').visto, true, 'unknown field of an added card survives');
  eq(r.doc.cards[0], local.cards[0], 'the untouched local card is the same object');
});

test('merge: last writer wins on updatedAt, in both directions', () => {
  const older = card('c1', { back: 'versión antigua', updatedAt: T1 });
  const newer = card('c1', { back: 'versión nueva', updatedAt: T2 });

  const takeIncoming = mergeDoc(doc('A', [older]), doc('B', [newer]), S);
  eq(byId(takeIncoming.doc.cards, 'c1').back, 'versión nueva');
  eq(byId(takeIncoming.doc.cards, 'c1').updatedAt, T2);
  deepEq(takeIncoming.changedCardIds, ['c1']);
  eq(takeIncoming.stats.cardsUpdated, 1);
  eq(takeIncoming.stats.cardsAdded, 0);

  const keepLocal = mergeDoc(doc('A', [newer]), doc('B', [older]), S);
  eq(byId(keepLocal.doc.cards, 'c1').back, 'versión nueva');
  deepEq(keepLocal.changedCardIds, []);
  eq(keepLocal.stats.cardsUpdated, 0);
  eq(keepLocal.stats.cardsUnchanged, 1);
});

test('merge: delete vs edit — the newer one wins, in both orders', () => {
  const edited = (ts) => card('c1', { back: 'editada', updatedAt: ts });
  const deleted = (ts) => card('c1', { deletedAt: ts, updatedAt: ts });

  // delete newer than edit -> stays deleted, whoever is local
  let r = mergeDoc(doc('A', [edited(T1)]), doc('B', [deleted(T2)]), S);
  eq(byId(r.doc.cards, 'c1').deletedAt, T2);
  eq(r.stats.cardsUpdated, 1);
  r = mergeDoc(doc('A', [deleted(T2)]), doc('B', [edited(T1)]), S);
  eq(byId(r.doc.cards, 'c1').deletedAt, T2, 'an older edit does not resurrect the card');
  eq(r.stats.cardsUpdated, 0);
  eq(r.stats.cardsAdded, 0);

  // edit newer than delete -> undeleted, whoever is local
  r = mergeDoc(doc('A', [deleted(T1)]), doc('B', [edited(T2)]), S);
  eq(byId(r.doc.cards, 'c1').deletedAt, null);
  eq(byId(r.doc.cards, 'c1').back, 'editada');
  r = mergeDoc(doc('A', [edited(T2)]), doc('B', [deleted(T1)]), S);
  eq(byId(r.doc.cards, 'c1').deletedAt, null);
  eq(byId(r.doc.cards, 'c1').back, 'editada');
  deepEq(r.changedCardIds, []);
});

test('merge: equal updatedAt — identical content changes nothing; else the greater deviceId wins; equal deviceIds keep local', () => {
  const mine = card('c1', { back: 'de A', updatedAt: T1 });
  const theirs = card('c1', { back: 'de B', updatedAt: T1 });

  // identical content
  let r = mergeDoc(doc('A', [mine]), doc('B', [clone(mine)]), S);
  deepEq(r.changedCardIds, []);
  eq(r.stats.cardsUnchanged, 1);

  // incoming device 'B' > local 'A' -> incoming wins
  r = mergeDoc(doc('A', [mine]), doc('B', [theirs]), S);
  eq(byId(r.doc.cards, 'c1').back, 'de B');
  deepEq(r.changedCardIds, ['c1']);

  // incoming device 'A' < local 'B' -> local kept
  r = mergeDoc(doc('B', [theirs]), doc('A', [mine]), S);
  eq(byId(r.doc.cards, 'c1').back, 'de B');
  deepEq(r.changedCardIds, []);

  // same device id -> local kept
  r = mergeDoc(doc('A', [mine]), doc('A', [theirs]), S);
  eq(byId(r.doc.cards, 'c1').back, 'de A');
  deepEq(r.changedCardIds, []);
  eq(r.stats.cardsUpdated, 0);
});

// ------------------------------------------------------------ mergeDoc: reviews + srs

test('merge: reviews are a union by id; an undone review stays undone with the earliest undoneAt', () => {
  const c = card('c1');
  const shared = review('r1', 'c1', T1, 3);
  const local = doc('A', [c], [shared, review('r2', 'c1', T2, 3), review('r4', 'c1', T3, 1, { undoneAt: '2026-09-25T10:05:00.000Z' })]);
  const incoming = doc('B', [c], [
    { ...shared, undoneAt: '2026-09-10T10:01:00.000Z', elapsedMs: 9999 },
    review('r3', 'c1', T3, 4),
    review('r4', 'c1', T3, 1, { undoneAt: '2026-09-25T10:02:00.000Z' }),
  ]);

  const r = mergeDoc(local, incoming, S);
  deepEq(sortedById(r.doc.reviews).map((x) => x.id), ['r1', 'r2', 'r3', 'r4']);
  eq(r.stats.reviewsAdded, 1);
  eq(r.stats.reviewsUpdated, 2);
  deepEq(r.changedReviewIds.slice().sort(), ['r1', 'r3', 'r4']);
  const r1 = byId(r.doc.reviews, 'r1');
  eq(r1.undoneAt, '2026-09-10T10:01:00.000Z', 'undone on one side -> undone');
  eq(r1.elapsedMs, 1000, 'the other fields come from local');
  eq(byId(r.doc.reviews, 'r4').undoneAt, '2026-09-25T10:02:00.000Z', 'earliest undoneAt');
  eq(byId(r.doc.reviews, 'r2').undoneAt, null);

  // The other way round gives the same undone marks.
  const back = mergeDoc(incoming, local, S);
  eq(byId(back.doc.reviews, 'r1').undoneAt, '2026-09-10T10:01:00.000Z');
  eq(byId(back.doc.reviews, 'r4').undoneAt, '2026-09-25T10:02:00.000Z');
  eq(back.stats.reviewsAdded, 1);
  eq(back.stats.reviewsUpdated, 0, 'that side already had both undone marks (and the earliest one)');
});

test('merge: srs is rebuilt by replay for affected cards and equals stepwise next()', () => {
  const c1 = card('c1');
  const c2 = card('c2');
  const d1 = '2026-09-10T10:00:00.000Z';
  const d2 = '2026-09-11T10:30:00.000Z';
  const d3 = '2026-09-12T11:00:00.000Z';
  const d4 = '2026-09-13T11:00:00.000Z';
  // Device A answered on day 1 and 3, device B on day 2 (plus an undone and a non-srs row).
  const local = doc('A', [c1, c2], [review('a1', 'c1', d1, 3), review('a3', 'c1', d3, 4)]);
  const incoming = doc('B', [c1, c2], [
    review('b2', 'c1', d2, 3),
    review('b4', 'c1', d4, 1, { undoneAt: d4 }),
    review('b5', 'c1', d4, 1, { mode: 'cram' }),
  ]);
  const c2Before = local.cards[1];

  const r = mergeDoc(local, incoming, S);
  let expected = initialState();
  expected = next(expected, 3, d1, S, 'c1');
  expected = next(expected, 3, d2, S, 'c1');
  expected = next(expected, 4, d3, S, 'c1');
  const merged = byId(r.doc.cards, 'c1');
  deepEq(merged.srs.rec, expected);
  deepEq(merged.srs.rec, replay('c1', 'rec', r.doc.reviews, S));
  deepEq(merged.srs.prod, initialState());
  eq(merged.srs.rec.reps, 3, 'undone and non-srs rows do not count');
  eq(merged.updatedAt, T0, 'a rebuilt srs never bumps updatedAt');
  deepEq(r.changedCardIds, ['c1']);
  eq(r.stats.cardsUpdated, 1);
  eq(r.stats.cardsUnchanged, 1, 'c2 was in the file but did not change');
  eq(byId(r.doc.cards, 'c2'), c2Before, 'a card without new reviews is left alone');

  // A card that arrives with a stale srs cache gets the replayed one.
  const stale = { ...card('c9'), srs: { rec: { ...initialState(), state: 'review', reps: 9, intervalDays: 30 }, prod: initialState() } };
  const withStale = doc('B', [], [review('z1', 'c9', d1, 3)]);
  withStale.cards.push(stale);
  const r2 = mergeDoc(doc('A', [c1]), withStale, S);
  deepEq(byId(r2.doc.cards, 'c9').srs.rec, next(initialState(), 3, d1, S, 'c9'));

  // A review that only becomes undone rebuilds the card too.
  const base = doc('A', [c1], [review('a1', 'c1', d1, 3)]);
  const undone = doc('B', [c1], [review('a1', 'c1', d1, 3, { undoneAt: d2 })]);
  const r3 = mergeDoc(base, undone, S);
  deepEq(byId(r3.doc.cards, 'c1').srs.rec, initialState());
  deepEq(r3.changedCardIds, ['c1']);
});

// ------------------------------------------------------------ mergeDoc: properties

/** Two devices that diverged in every possible way. */
function divergedDocs() {
  const d1 = '2026-09-10T10:00:00.000Z';
  const d2 = '2026-09-11T10:30:00.000Z';
  const d3 = '2026-09-12T11:00:00.000Z';
  const a = doc(
    'A',
    [
      card('same'),
      card('editA', { back: 'editada en A', updatedAt: T2 }),
      card('delB', { updatedAt: T1 }),
      card('onlyA', { extraA: [1, 2] }),
      card('tie', { back: 'empate A', updatedAt: T1 }),
    ],
    [review('r-shared', 'same', d1, 3), review('r-a', 'same', d3, 3), review('r-undo', 'editA', d1, 1)]
  );
  const b = doc(
    'B',
    [
      card('same'),
      card('editA', { updatedAt: T1 }),
      card('delB', { deletedAt: T2, updatedAt: T2 }),
      card('onlyB', { extraB: 'x' }),
      card('tie', { back: 'empate B', updatedAt: T1 }),
    ],
    [review('r-shared', 'same', d1, 3), review('r-b', 'same', d2, 3), review('r-undo', 'editA', d1, 1, { undoneAt: d2 }), review('r-only-b', 'onlyB', d1, 4)]
  );
  return { a, b };
}

test('merge: idempotent — mergeDoc(a, a) changes nothing and merging b twice equals merging once', () => {
  const { a, b } = divergedDocs();
  const self = mergeDoc(a, a, S);
  deepEq(self.changedCardIds, []);
  deepEq(self.changedReviewIds, []);
  deepEq(self.stats, { cardsAdded: 0, cardsUpdated: 0, cardsUnchanged: 5, cardsInvalid: 0, cardsDuplicateKey: 0, reviewsAdded: 0, reviewsUpdated: 0, reviewsInvalid: 0 });
  deepEq(self.doc, a);

  const once = mergeDoc(a, b, S);
  assert(once.changedCardIds.length > 0, 'the first merge changes something');
  const twice = mergeDoc(once.doc, b, S);
  deepEq(twice.changedCardIds, []);
  deepEq(twice.changedReviewIds, []);
  eq(twice.stats.cardsAdded, 0);
  eq(twice.stats.cardsUpdated, 0);
  eq(twice.stats.reviewsAdded, 0);
  eq(twice.stats.reviewsUpdated, 0);
  deepEq(twice.doc, once.doc);
});

test('merge: commutative for cards and reviews when the deviceIds differ', () => {
  const { a, b } = divergedDocs();
  const ab = mergeDoc(a, b, S).doc;
  const ba = mergeDoc(b, a, S).doc;
  const cardsAb = sortedById(ab.cards);
  const cardsBa = sortedById(ba.cards);
  deepEq(cardsAb.map((c) => c.id), ['delB', 'editA', 'onlyA', 'onlyB', 'same', 'tie']);
  eq(cardsBa.length, cardsAb.length);
  for (let i = 0; i < cardsAb.length; i++) {
    assert(sameValue(cardsAb[i], cardsBa[i]), 'card ' + cardsAb[i].id + ' is the same both ways');
  }
  assert(sameValue(sortedById(ab.reviews), sortedById(ba.reviews)), 'reviews are the same both ways');

  // and the content is what the rules say
  eq(byId(ab.cards, 'editA').back, 'editada en A');
  eq(byId(ab.cards, 'delB').deletedAt, T2);
  eq(byId(ab.cards, 'tie').back, 'empate B', 'device B > A wins the tie');
  eq(byId(ab.cards, 'same').srs.rec.reps, 3);
  deepEq(byId(ab.cards, 'editA').srs.rec, initialState(), 'its only review was undone on B');
  eq(byId(ab.cards, 'onlyB').srs.rec.reps, 1);

  // settings and device identity always stay local
  eq(ab.deviceId, 'A');
  eq(ab.deviceName, 'nombre-A');
  eq(ab.settings.newPerDay, 15);
  eq(ba.deviceId, 'B');
  eq(ba.settings.newPerDay, 30);
  eq(ab.app, 'c2vocab');
  eq(ab.schemaVersion, 1);
});

test('merge: unknown fields are preserved and the inputs are never mutated', () => {
  const { a, b } = divergedDocs();
  a.futuro = { clave: 'valor' };
  a.cards[1].campoNuevo = 'local'; // 'editA': the local version is newer and its srs is rebuilt
  b.cards[1].otroCampo = { x: 1 };
  b.reviews[1].nota = 'extra';
  const a0 = clone(a);
  const b0 = clone(b);

  const r = mergeDoc(a, b, S);
  deepEq(a, a0, 'local doc untouched');
  deepEq(b, b0, 'incoming doc untouched');
  deepEq(r.doc.futuro, { clave: 'valor' }, 'unknown envelope key kept');
  eq(byId(r.doc.cards, 'editA').campoNuevo, 'local', 'kept through the srs rebuild');
  deepEq(byId(r.doc.cards, 'onlyA').extraA, [1, 2]);
  eq(byId(r.doc.cards, 'onlyB').extraB, 'x');
  eq(byId(r.doc.reviews, 'r-b').nota, 'extra');

  // an incoming card that wins brings its unknown fields with it
  const winner = card('c1', { updatedAt: T2, nuevoCampo: 7 });
  const r2 = mergeDoc(doc('A', [card('c1', { updatedAt: T1 })]), doc('B', [winner]), S);
  eq(byId(r2.doc.cards, 'c1').nuevoCampo, 7);
});

// ------------------------------------------------------------ restoreDoc

/** A snapshot and the local state some days later. */
function restoreScenario() {
  const d1 = '2026-09-10T10:00:00.000Z';
  const d2 = '2026-09-21T10:30:00.000Z';
  const snapshot = doc(
    'A',
    [
      card('edited', { back: 'definición original' }),
      card('deletedLater'),
      card('restoredLater', { deletedAt: T1, updatedAt: T1 }),
      card('same', { tags: ['a', 'b'] }),
      card('touched', { updatedAt: T1 }),
      card('gone'),
    ],
    [review('r0', 'gone', d1, 3), review('r1', 'edited', d1, 3)]
  );
  const local = doc(
    'A',
    [
      card('edited', { back: 'definición estropeada', updatedAt: T2 }),
      card('deletedLater', { deletedAt: T2, updatedAt: T2 }),
      card('restoredLater', { deletedAt: null, updatedAt: T2 }),
      card('same', { tags: ['a', 'b'] }),
      card('touched', { updatedAt: T3 }), // edited and edited back: same content, newer timestamp
      card('later', { createdAt: T2, updatedAt: T2 }),
    ],
    [review('r1', 'edited', d1, 3), review('r2', 'edited', d2, 3), review('r3', 'later', d2, 4)]
  );
  return { snapshot, local };
}

test('restore: differing cards go back to the snapshot content with updatedAt = now', () => {
  const { snapshot, local } = restoreScenario();
  const r = restoreDoc(local, snapshot, NOW, S);

  const edited = byId(r.doc.cards, 'edited');
  eq(edited.back, 'definición original');
  eq(edited.updatedAt, NOW, 'the reverted version wins future merges');
  eq(edited.createdAt, T0);
  eq(r.stats.cardsReverted, 3);
  assert(r.changedCardIds.includes('edited'));

  // the reverted card beats the edited one in a later merge
  const stale = doc('B', [card('edited', { back: 'definición estropeada', updatedAt: T2 })]);
  eq(byId(mergeDoc(r.doc, stale, S).doc.cards, 'edited').back, 'definición original');
});

test('restore: the deleted state is reverted both ways', () => {
  const { snapshot, local } = restoreScenario();
  const r = restoreDoc(local, snapshot, NOW, S);
  const undeleted = byId(r.doc.cards, 'deletedLater');
  eq(undeleted.deletedAt, null, 'deleted after the snapshot -> alive again');
  eq(undeleted.updatedAt, NOW);
  const redeleted = byId(r.doc.cards, 'restoredLater');
  eq(redeleted.deletedAt, T1, 'was in the trash in the snapshot -> back in the trash');
  eq(redeleted.updatedAt, NOW);
});

test('restore: later cards are kept, identical cards untouched, missing cards re-added', () => {
  const { snapshot, local } = restoreScenario();
  const r = restoreDoc(local, snapshot, NOW, S);

  eq(byId(r.doc.cards, 'later'), byId(local.cards, 'later'), 'a card created after the snapshot is kept as it is');
  eq(byId(r.doc.cards, 'same'), byId(local.cards, 'same'), 'identical card: same object');
  eq(byId(r.doc.cards, 'touched'), byId(local.cards, 'touched'), 'same content with a newer timestamp is not reverted');
  eq(byId(r.doc.cards, 'touched').updatedAt, T3);
  const gone = byId(r.doc.cards, 'gone');
  assert(gone, 'a card missing locally comes back');
  eq(gone.updatedAt, T0, 're-added as it was');

  deepEq(r.changedCardIds.slice().sort(), ['deletedLater', 'edited', 'gone', 'restoredLater']);
  eq(r.stats.cardsReverted, 3);
  eq(r.stats.cardsReadded, 1);
  eq(r.stats.cardsKept, 1);
  eq(r.doc.cards.length, 7);
});

test('restore: reviews are kept and unioned, srs follows the full history, inputs are not mutated', () => {
  const { snapshot, local } = restoreScenario();
  const local0 = clone(local);
  const snapshot0 = clone(snapshot);
  const r = restoreDoc(local, snapshot, NOW, S);
  deepEq(local, local0, 'local doc untouched');
  deepEq(snapshot, snapshot0, 'snapshot untouched');

  deepEq(sortedById(r.doc.reviews).map((x) => x.id), ['r0', 'r1', 'r2', 'r3']);
  eq(r.stats.reviewsAdded, 1, 'only r0 was missing');
  deepEq(r.changedReviewIds, ['r0']);

  // 'edited' keeps the progress made AFTER the snapshot (r2), not the snapshot's srs
  const edited = byId(r.doc.cards, 'edited');
  eq(edited.srs.rec.reps, 2);
  deepEq(edited.srs.rec, replay('edited', 'rec', r.doc.reviews, S));
  deepEq(edited.srs.rec, byId(local.cards, 'edited').srs.rec);
  eq(byId(r.doc.cards, 'gone').srs.rec.reps, 1);
  eq(byId(r.doc.cards, 'later').srs.rec.reps, 1);

  // restoring twice changes nothing the second time
  const again = restoreDoc(r.doc, snapshot, '2026-10-04T09:00:00.000Z', S);
  deepEq(again.changedCardIds, []);
  deepEq(again.changedReviewIds, []);
  eq(again.stats.cardsReverted, 0);
  eq(again.stats.cardsReadded, 0);
});

test('restore: sameContent ignores timestamps, srs and unknown keys', () => {
  const a = card('x', { tags: ['t'] });
  const b = { ...card('x', { tags: ['t'], updatedAt: T3, createdAt: T1 }), extra: 1, srs: { rec: { ...initialState(), reps: 5 }, prod: initialState() } };
  eq(sameContent(a, b), true);
  eq(sameContent(a, { ...b, ko: '뜻' }), false);
  eq(sameContent(a, { ...b, deletedAt: T2 }), false);
  eq(sameContent(a, { ...b, tags: ['t', 'u'] }), false);
  eq(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true, 'key order does not matter');
  eq(sameValue({ a: 1 }, { a: 1, b: undefined }), false);
  eq(sameValue([1, 2], [2, 1]), false);
  eq(sameValue(null, {}), false);
});

// ------------------------------------------------------------ malformed reviews, duplicate expressions

test('merge: malformed or orphan incoming reviews are skipped and counted instead of breaking the merge', () => {
  const d1 = '2026-09-10T10:00:00.000Z';
  const local = doc('A', [card('c1')], [review('ok-local', 'c1', d1, 3)]);
  const incoming = doc('B', [card('c1')], []);
  incoming.cards.push({ id: 'rota' }); // invalid card (no front): skipped, and so are its reviews
  incoming.reviews = [
    review('bad-rating-text', 'c1', d1, '3'),
    review('bad-rating-range', 'c1', d1, 5),
    review('bad-ts', 'c1', 'ayer', 3),
    review('bad-dir', 'c1', d1, 3, { dir: 'otra' }),
    review('orphan', 'nadie', d1, 3),
    review('of-invalid-card', 'rota', d1, 3),
    { cardId: 'c1', dir: 'rec', ts: d1, rating: 3, mode: 'srs' }, // no id
    null,
    review('good', 'c1', '2026-09-11T10:00:00.000Z', 3),
    review('ok-local', 'c1', d1, 'x'), // already known locally: only its undone mark matters
  ];
  const before = clone(incoming);

  const r = mergeDoc(local, incoming, S);
  deepEq(incoming, before, 'incoming doc untouched');
  deepEq(sortedById(r.doc.reviews).map((x) => x.id), ['good', 'ok-local']);
  eq(r.stats.reviewsAdded, 1);
  eq(r.stats.reviewsInvalid, 8);
  eq(r.stats.cardsInvalid, 1);
  deepEq(r.changedReviewIds, ['good']);
  eq(byId(r.doc.reviews, 'ok-local').rating, 3, 'the local row is kept as it is');
  eq(byId(r.doc.cards, 'c1').srs.rec.reps, 2, 'replay ran over the two good rows');
  deepEq(byId(r.doc.cards, 'c1').srs.rec, replay('c1', 'rec', r.doc.reviews, S));

  // restoreDoc applies the same filter to the snapshot's reviews
  const snap = doc('A', [card('c1')], []);
  snap.reviews = [review('bad', 'c1', d1, 9), review('orphan', 'nadie', d1, 3)];
  const restored = restoreDoc(local, snap, NOW, S);
  eq(restored.stats.reviewsInvalid, 2);
  eq(restored.stats.reviewsAdded, 0);
  deepEq(restored.changedReviewIds, []);
});

test('merge: the same expression under two ids is kept twice but reported (duplicateKeys)', () => {
  // Both devices created 'a raíz de' on their own: different ids, same front + type.
  const mine = card('id-pc', { front: 'a raíz de', type: 'locucion' });
  const theirs = card('id-iphone', { front: 'A raiz de', type: 'locucion' });
  const otherType = card('id-lexico', { front: 'a raíz de', type: 'lexico' });
  const dead = card('id-dead', { front: 'a raíz de', type: 'locucion', deletedAt: T1, updatedAt: T1 });
  const local = doc('A', [mine, card('c1')]);
  const incoming = doc('B', [theirs, otherType, dead, card('c2')]);

  const r = mergeDoc(local, incoming, S);
  eq(r.stats.cardsAdded, 4, 'cards are still merged by id');
  eq(r.stats.cardsDuplicateKey, 1);
  eq(r.duplicateKeys.length, 1);
  deepEq(r.duplicateKeys[0].ids.slice().sort(), ['id-iphone', 'id-pc'], 'another type and a tombstone do not count');

  // merging the same file again adds nothing, so nothing new is reported
  const again = mergeDoc(r.doc, incoming, S);
  eq(again.stats.cardsDuplicateKey, 0);
  deepEq(again.duplicateKeys, []);

  // restore: a deleted card was written again under a new id; the old copy comes back to life
  const snapshot = doc('A', [card('old', { front: 'dar la lata', type: 'locucion' })]);
  const now = doc('A', [
    card('old', { front: 'dar la lata', type: 'locucion', deletedAt: T2, updatedAt: T2 }),
    card('new', { front: 'dar la lata', type: 'locucion', createdAt: T3, updatedAt: T3 }),
  ]);
  const restored = restoreDoc(now, snapshot, NOW, S);
  eq(restored.stats.cardsReverted, 1);
  eq(restored.stats.cardsDuplicateKey, 1);
  deepEq(restored.duplicateKeys[0].ids.slice().sort(), ['new', 'old']);
  eq(restoreDoc(restored.doc, snapshot, NOW, S).stats.cardsDuplicateKey, 0, 'nothing new the second time');
});
