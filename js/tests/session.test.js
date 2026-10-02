// Tests for js/session.js: queue building (pure) and the in-memory session controller.

import { test, assert, eq, deepEq, throws } from './harness.js';
import { initialState } from '../srs.js';
import { buildQueue, queueInfo, createSession, isEligible } from '../session.js';

const S = { fuzz: false, newPerDay: 15, maxReviewsPerDay: 200, learningSteps: [10, 1440], dayBoundaryHour: 4 };

// Local noon, so that +/- 24 h always lands on the neighbouring study day.
const NOW = new Date(2026, 9, 2, 12, 0).toISOString();

function plusMin(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60000).toISOString();
}

/** A minimal eligible card; `rec` patches srs.rec, `extra` patches the card. */
function card(id, rec, extra) {
  return {
    id,
    front: id,
    back: 'definición',
    status: 'active',
    direction: 'both',
    deletedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    srs: { rec: { ...initialState(), ...(rec || {}) }, prod: initialState() },
    ...(extra || {}),
  };
}

function newCardAt(id, minute) {
  return card(id, null, { createdAt: plusMin('2026-09-01T00:00:00.000Z', minute) });
}

function reviewCard(id, dueIso) {
  return card(id, { state: 'review', intervalDays: 3, due: dueIso, reps: 3 });
}

function ids(queue) {
  return queue.map((q) => q.cardId);
}

function kinds(queue) {
  return queue.map((q) => q.kind);
}

/** The mixed deck used by several tests. */
function mixedDeck() {
  const yesterday = plusMin(NOW, -1440);
  return [
    card('L1', { state: 'learning', step: 0, due: plusMin(NOW, -5) }),
    card('L2', { state: 'relearning', intervalDays: 2, due: plusMin(NOW, -10) }),
    card('LA', { state: 'learning', step: 0, due: plusMin(NOW, 5) }), // short timer still running
    card('LD', { state: 'learning', step: 1, due: plusMin(NOW, 1440) }), // 1-day step, due tomorrow
    reviewCard('R1', plusMin(NOW, -3 * 1440)), // the oldest review
    reviewCard('R2', yesterday),
    reviewCard('R3', yesterday),
    reviewCard('R4', yesterday),
    reviewCard('R5', yesterday),
    reviewCard('R6', yesterday),
    reviewCard('R7', yesterday),
    reviewCard('RF', plusMin(NOW, 2 * 1440)), // not due yet
    newCardAt('N1', 1),
    newCardAt('N2', 2),
    newCardAt('N3', 3),
    newCardAt('N4', 4),
  ];
}

test('session 21: isEligible / buildQueue leave out inbox, suspended, deleted and prod-only cards', () => {
  const cards = [
    card('ok'),
    card('inbox', null, { status: 'inbox', back: '' }),
    card('noback', null, { back: '   ' }),
    card('susp', null, { status: 'suspended' }),
    card('del', null, { deletedAt: '2026-09-30T00:00:00.000Z' }),
    card('prod', null, { direction: 'prod' }),
    card('reconly', null, { direction: 'rec', createdAt: '2026-09-02T00:00:00.000Z' }),
  ];
  eq(isEligible(cards[0]), true);
  eq(isEligible(cards[1]), false);
  eq(isEligible(cards[2]), false);
  eq(isEligible(cards[3]), false);
  eq(isEligible(cards[4]), false);
  eq(isEligible(cards[5]), false);
  eq(isEligible(cards[6]), true);
  const q = buildQueue({ cards, now: NOW, settings: S, newSeenToday: 0, reviewsDoneToday: 0 });
  deepEq(q, [
    { cardId: 'ok', dir: 'rec', kind: 'new' },
    { cardId: 'reconly', dir: 'rec', kind: 'new' },
  ]);
  deepEq(buildQueue({ cards: [], now: NOW, settings: S }), []);
});

test('session 21: buildQueue order — learning, 1 new after every 3 reviews, leftover news, learn-ahead last', () => {
  const input = { cards: mixedDeck(), now: NOW, settings: S, newSeenToday: 0, reviewsDoneToday: 0 };
  const q = buildQueue(input);
  deepEq(kinds(q), [
    'learning',
    'learning',
    'review',
    'review',
    'review',
    'new',
    'review',
    'review',
    'review',
    'new',
    'review',
    'new',
    'new',
    'learning',
  ]);
  const order = ids(q);
  eq(order[0], 'L2', 'earliest due learning card first');
  eq(order[1], 'L1');
  eq(order[2], 'R1', 'oldest study day first');
  eq(order[5], 'N1');
  eq(order[9], 'N2');
  eq(order[11], 'N3');
  eq(order[12], 'N4');
  eq(order[13], 'LA', 'learn-ahead at the very end');
  const reviewIds = q.filter((x) => x.kind === 'review').map((x) => x.cardId).sort();
  deepEq(reviewIds, ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']);
  assert(!order.includes('LD'), 'day-level learning not due is left out');
  assert(!order.includes('RF'), 'future review is left out');
  assert(q.every((x) => x.dir === 'rec'), 'only rec in step 2');

  deepEq(queueInfo(input), { due: 10, news: 4, total: 14, newPaused: false });
});

test('session 21: stable shuffle — same day and same cards give the same queue, whatever the input order', () => {
  const a = buildQueue({ cards: mixedDeck(), now: NOW, settings: S });
  const b = buildQueue({ cards: mixedDeck(), now: plusMin(NOW, 60), settings: S });
  const c = buildQueue({ cards: mixedDeck().reverse(), now: NOW, settings: S });
  deepEq(ids(a).filter((id) => id.startsWith('R')), ids(b).filter((id) => id.startsWith('R')), 'same study day');
  deepEq(c, a, 'input order does not matter');
});

test('session 21: stable shuffle — the remaining reviews keep their order when some are already done', () => {
  const full = ids(buildQueue({ cards: mixedDeck(), now: NOW, settings: S })).filter((id) => id.startsWith('R'));
  eq(full.length, 7);

  // Later the same day: R1, R3 and R5 were answered and are no longer due.
  const gone = ['R1', 'R3', 'R5'];
  const restDeck = mixedDeck().filter((c) => !gone.includes(c.id));
  const rest = ids(buildQueue({ cards: restDeck, now: plusMin(NOW, 90), settings: S })).filter((id) => id.startsWith('R'));
  deepEq(rest, full.filter((id) => !gone.includes(id)), 'same relative order as in the first queue');

  // With a review cap, the cards that survive the cap are the first ones of that same order.
  const capped = buildQueue({ cards: restDeck, now: NOW, settings: { ...S, maxReviewsPerDay: 2 } });
  deepEq(ids(capped).filter((id) => id.startsWith('R')), rest.slice(0, 2));
});

test('session 21: new-card cap, review cap, backlog pause', () => {
  const news = [];
  for (let i = 0; i < 20; i++) news.push(newCardAt('N' + String(i).padStart(2, '0'), i));

  const all = buildQueue({ cards: news, now: NOW, settings: S, newSeenToday: 0, reviewsDoneToday: 0 });
  eq(all.length, 15, 'newPerDay 15');
  eq(all[0].cardId, 'N00', 'oldest first');
  eq(all[14].cardId, 'N14');
  deepEq(queueInfo({ cards: news, now: NOW, settings: S }), { due: 0, news: 15, total: 15, newPaused: false });

  eq(buildQueue({ cards: news, now: NOW, settings: S, newSeenToday: 13 }).length, 2, '15 - 13');
  eq(buildQueue({ cards: news, now: NOW, settings: S, newSeenToday: 15 }).length, 0);
  eq(buildQueue({ cards: news, now: NOW, settings: S, newSeenToday: 20 }).length, 0, 'never negative');
  deepEq(queueInfo({ cards: news, now: NOW, settings: S, newSeenToday: 15 }), { due: 0, news: 0, total: 0, newPaused: false });

  // review cap: 7 due reviews, max 5 per day, 2 already done -> 3
  const deck = mixedDeck();
  const capped = { cards: deck, now: NOW, settings: { ...S, maxReviewsPerDay: 5 }, newSeenToday: 0, reviewsDoneToday: 2 };
  const q = buildQueue(capped);
  eq(q.filter((x) => x.kind === 'review').length, 3);
  eq(q[2].cardId, 'R1', 'the oldest review survives the cap');
  deepEq(queueInfo(capped), { due: 6, news: 4, total: 10, newPaused: false });
  eq(buildQueue({ ...capped, reviewsDoneToday: 9 }).filter((x) => x.kind === 'review').length, 0);

  // backlog pause: 7 due reviews > newPerDay 1 * 6 -> no new cards
  const paused = { cards: deck, now: NOW, settings: { ...S, newPerDay: 1 }, newSeenToday: 0, reviewsDoneToday: 0 };
  eq(buildQueue(paused).filter((x) => x.kind === 'new').length, 0);
  deepEq(queueInfo(paused), { due: 10, news: 0, total: 10, newPaused: true });
  // 6 due reviews is not more than 6 -> 1 new card
  const sixReviews = deck.filter((c) => c.id !== 'R7');
  const notPaused = { cards: sixReviews, now: NOW, settings: { ...S, newPerDay: 1 }, newSeenToday: 0, reviewsDoneToday: 0 };
  eq(buildQueue(notPaused).filter((x) => x.kind === 'new').length, 1);
  eq(queueInfo(notPaused).newPaused, false);
});

test("session 21: mode 'new' keeps learning + new cards only", () => {
  const input = { cards: mixedDeck(), now: NOW, settings: S, newSeenToday: 0, reviewsDoneToday: 0, mode: 'new' };
  const q = buildQueue(input);
  deepEq(ids(q), ['L2', 'L1', 'N1', 'N2', 'N3', 'N4', 'LA']);
  deepEq(kinds(q), ['learning', 'learning', 'new', 'new', 'new', 'new', 'learning']);
  deepEq(queueInfo(input), { due: 3, news: 4, total: 7, newPaused: false });
});

// ------------------------------------------------------------ controller

const T0 = '2026-10-02T03:00:00.000Z';
const T1 = '2026-10-02T03:00:07.000Z';
const T2 = '2026-10-02T03:00:12.000Z';

function newSession(n) {
  const cards = [];
  for (let i = 0; i < n; i++) cards.push(newCardAt('C' + String(i).padStart(2, '0'), i));
  const cardsById = {};
  for (const c of cards) cardsById[c.id] = c;
  const queue = buildQueue({ cards, now: T0, settings: { ...S, newPerDay: 50 } });
  return { cards, session: createSession({ queue, cardsById, settings: S, startedAt: T0, deviceId: 'dev-1' }) };
}

test('session 22: Bien on a new card removes it; Otra vez reinserts it; counters and review row', () => {
  const { cards, session } = newSession(3);
  eq(session.remaining(), 3);
  eq(session.remainingNew(), 3);
  eq(session.canUndo(), false);
  deepEq(session.current(), { cardId: 'C00', dir: 'rec', kind: 'new' });
  eq(session.currentCard().id, 'C00');
  eq(session.currentState().state, 'new');

  const first = session.rate(3, T1);
  eq(first.prevState.state, 'new');
  eq(first.nextState.state, 'learning');
  eq(first.nextState.step, 1, '1-day step -> leaves the session');
  eq(session.remaining(), 2);
  eq(session.current().cardId, 'C01');
  deepEq(session.counters(), { done: 1, again: 0, hard: 0, good: 1, easy: 0, newSeen: 1 });
  eq(first.review.elapsedMs, 7000, 'answer time since the session started');

  const second = session.rate(1, T2);
  eq(session.remaining(), 2, 'failed card stays in the session');
  deepEq(session.queue(), [
    { cardId: 'C02', dir: 'rec', kind: 'new' },
    { cardId: 'C01', dir: 'rec', kind: 'learning' },
  ]);
  eq(session.remainingNew(), 1);
  deepEq(session.counters(), { done: 2, again: 1, hard: 0, good: 1, easy: 0, newSeen: 2 });
  eq(session.stateOf('C01').state, 'learning');
  eq(session.stateOf('C01').step, 0);

  const r = second.review;
  assert(typeof r.id === 'string' && r.id.length > 10, 'review id');
  eq(r.cardId, 'C01');
  eq(r.dir, 'rec');
  eq(r.ts, T2);
  eq(r.rating, 1);
  eq(r.mode, 'srs');
  eq(r.deviceId, 'dev-1');
  eq(r.stateBefore, 'new');
  eq(r.elapsedDays, 0);
  eq(r.scheduledDays, 0);
  eq(r.elapsedMs, 5000);
  eq(r.undoneAt, null);
  deepEq(Object.keys(r), ['id', 'cardId', 'dir', 'ts', 'rating', 'mode', 'deviceId', 'stateBefore', 'elapsedDays', 'scheduledDays', 'elapsedMs', 'undoneAt']);

  deepEq(cards[1].srs.rec, initialState(), 'the card objects are not mutated');
  eq(session.elapsedMs(T2), 12000);
});

test('session 22: undo restores queue, counters and state; canUndo', () => {
  const { session } = newSession(3);
  session.rate(3, T1);
  const second = session.rate(1, T2);
  eq(session.canUndo(), true);

  const entry = session.undo();
  eq(entry.reviewId, second.review.id);
  eq(entry.cardId, 'C01');
  eq(entry.dir, 'rec');
  deepEq(entry.prevState, initialState());
  eq(session.current().cardId, 'C01');
  eq(session.current().kind, 'new');
  eq(session.remaining(), 2);
  deepEq(session.counters(), { done: 1, again: 0, hard: 0, good: 1, easy: 0, newSeen: 1 });
  eq(session.stateOf('C01').state, 'new');
  eq(session.canUndo(), true, 'the first rating can still be undone');

  const entry2 = session.undo();
  eq(entry2.cardId, 'C00');
  eq(session.current().cardId, 'C00');
  eq(session.remaining(), 3);
  deepEq(session.counters(), { done: 0, again: 0, hard: 0, good: 0, easy: 0, newSeen: 0 });
  eq(session.stateOf('C00').state, 'new');
  eq(session.canUndo(), false);
  eq(session.undo(), null);
});

test('session 22: requeue 8 positions later, or at the end of a short queue', () => {
  const long = newSession(12).session;
  long.rate(1, T1);
  const q = long.queue();
  eq(q.length, 12);
  eq(q[8].cardId, 'C00', '8 other cards come first');
  eq(q[0].cardId, 'C01');
  eq(q[7].cardId, 'C08');
  eq(q[9].cardId, 'C09');

  const short = newSession(5).session;
  short.rate(2, T1); // Difícil on a new card also stays on the 10-minute step
  const q2 = short.queue();
  eq(q2.length, 5);
  eq(q2[4].cardId, 'C00', 'at the end when fewer than 8 remain');
  deepEq(short.counters(), { done: 1, again: 0, hard: 1, good: 0, easy: 0, newSeen: 1 });
});

test('session 22: a single remaining card comes back immediately; an empty session rejects rate()', async () => {
  const { session } = newSession(1);
  session.rate(1, T1);
  eq(session.remaining(), 1);
  deepEq(session.current(), { cardId: 'C00', dir: 'rec', kind: 'learning' });
  const second = session.rate(3, T2);
  eq(second.prevState.state, 'learning');
  eq(second.review.stateBefore, 'learning');
  eq(second.nextState.step, 1);
  eq(session.remaining(), 0);
  eq(session.current(), null);
  eq(session.currentCard(), null);
  deepEq(session.counters(), { done: 2, again: 1, hard: 0, good: 1, easy: 0, newSeen: 1 });
  await throws(() => session.rate(3, T2));
  await throws(() => newSession(2).session.rate(9, T1), 'invalid rating');
});

test('session 22: an invalid rating leaves the session untouched; review cards report elapsedDays', async () => {
  const { session } = newSession(2);
  await throws(() => session.rate(7, T1));
  eq(session.remaining(), 2);
  eq(session.canUndo(), false);
  deepEq(session.counters(), { done: 0, again: 0, hard: 0, good: 0, easy: 0, newSeen: 0 });

  const rev = card('RV', { state: 'review', intervalDays: 10, ease: 2.5, reps: 4, due: T0, lastReviewAt: '2026-09-22T15:00:00.000Z' });
  const map = new Map([[rev.id, rev]]);
  const s2 = createSession({ queue: [{ cardId: 'RV', dir: 'rec', kind: 'review' }], cardsById: map, settings: S, startedAt: T0 });
  const out = s2.rate(3, T0);
  eq(out.review.stateBefore, 'review');
  eq(out.review.scheduledDays, 10);
  eq(out.review.elapsedDays, 9.5, '9 days 12 hours');
  eq(out.review.deviceId, '');
  eq(out.nextState.intervalDays, 25);
  eq(s2.remaining(), 0);
  deepEq(s2.counters(), { done: 1, again: 0, hard: 0, good: 1, easy: 0, newSeen: 0 });
});

test('session 22: peekUndo shows the next undo entry without changing the session', () => {
  const { session } = newSession(3);
  eq(session.peekUndo(), null, 'nothing to undo yet');

  const first = session.rate(1, T1);
  const peek = session.peekUndo();
  eq(peek.reviewId, first.review.id);
  eq(peek.cardId, 'C00');
  eq(peek.dir, 'rec');
  deepEq(peek.prevState, initialState());
  eq(session.canUndo(), true, 'peek does not consume the entry');
  eq(session.remaining(), 3, 'queue untouched by peek');
  deepEq(session.counters(), { done: 1, again: 1, hard: 0, good: 0, easy: 0, newSeen: 1 });
  eq(session.stateOf('C00').state, 'learning', 'state untouched by peek');

  const entry = session.undo();
  eq(entry.reviewId, peek.reviewId, 'undo returns the entry that peek announced');
  eq(session.peekUndo(), null);
});
