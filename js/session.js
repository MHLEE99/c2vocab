// Study session logic: which cards to show today (buildQueue, pure) and an
// in-memory controller that walks through them (createSession).
// Nothing here touches the database: the review screen persists what rate() returns.
//
// Step 2 only studies the 'rec' direction (reconocimiento).

import { uuid, hashString, mulberry32 } from './util.js';
import { initialState, next, isDue, isSubDayLearning, studyDay, resolveSettings } from './srs.js';

const DIR = 'rec';
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEUE_GAP = 8; // a failed card comes back after this many other cards
const NEW_EVERY_N_REVIEWS = 3; // one new card after every 3 reviews
const BACKLOG_FACTOR = 6; // new cards pause when due reviews > newPerDay * 6

/** Can this card be studied at all? (live, active, has a definition, not production-only) */
export function isEligible(card) {
  if (!card || card.deletedAt) return false;
  if (card.status !== 'active') return false;
  if (typeof card.back !== 'string' || card.back.trim() === '') return false;
  if (card.direction === 'prod') return false;
  return true;
}

function recState(card) {
  return card.srs && card.srs[DIR] ? card.srs[DIR] : initialState();
}

function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function byDueThenId(a, b) {
  return Date.parse(recState(a).due) - Date.parse(recState(b).due) || compareText(a.id, b.id);
}

/**
 * Shuffle position of one card for one study day: a number in [0, 1) from a PRNG
 * seeded with the day and the card id. Every card gets its own number, so the
 * relative order of two cards stays the same all day, whichever other cards are
 * still due (the order does not jump when the learner leaves and comes back).
 */
function shuffleKey(today, cardId) {
  return mulberry32(hashString(today + ':' + cardId))();
}

/**
 * Sort the cards into the four groups of a study day and apply the daily limits.
 * Shared by buildQueue and queueInfo so their numbers always agree.
 */
function classify({ cards, now, settings, newSeenToday = 0, reviewsDoneToday = 0, mode = 'all' }) {
  const s = resolveSettings(settings);
  const hour = s.dayBoundaryHour;
  const today = studyDay(now, hour);

  const learningDue = [];
  const learnAhead = [];
  const dueReviews = [];
  const newCards = [];

  for (const card of Array.isArray(cards) ? cards : []) {
    if (!isEligible(card)) continue;
    const st = recState(card);
    if (st.state === 'new') {
      newCards.push(card);
    } else if (st.state === 'learning' || st.state === 'relearning') {
      if (isDue(st, now, s)) learningDue.push(card);
      else if (isSubDayLearning(st, s)) learnAhead.push(card);
      // day-level learning that is not due yet waits for its day
    } else if (st.state === 'review') {
      if (isDue(st, now, s)) {
        dueReviews.push({ card, day: studyDay(st.due, hour), key: shuffleKey(today, card.id) });
      }
    }
  }

  learningDue.sort(byDueThenId);
  learnAhead.sort(byDueThenId);

  // Reviews: oldest study day first; inside one day a shuffled order that is stable for today.
  dueReviews.sort((a, b) => compareText(a.day, b.day) || a.key - b.key || compareText(a.card.id, b.card.id));
  const dueReviewCount = dueReviews.length;
  const reviewCap = Math.max(0, s.maxReviewsPerDay - reviewsDoneToday);
  const reviews = mode === 'new' ? [] : dueReviews.slice(0, reviewCap).map((x) => x.card);

  // New cards: oldest first, limited per day, paused while the review backlog is large.
  newCards.sort((a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id));
  const baseCap = Math.max(0, s.newPerDay - newSeenToday);
  const backlog = dueReviewCount > s.newPerDay * BACKLOG_FACTOR;
  const newCap = backlog ? 0 : baseCap;
  const news = newCards.slice(0, newCap);
  // "Paused" is reported only when cards were really held back by the backlog.
  const newPaused = backlog && baseCap > 0 && newCards.length > 0;

  return { learningDue, learnAhead, reviews, news, newPaused };
}

function item(card, kind) {
  return { cardId: card.id, dir: DIR, kind };
}

/**
 * Today's queue: [{ cardId, dir: 'rec', kind: 'learning' | 'review' | 'new' }].
 * Order: due learning cards, reviews with one new card after every 3 reviews,
 * the remaining new cards, and finally learning cards whose short timer has not
 * run out yet (so a short session can still finish them).
 * mode 'new' leaves the reviews out.
 */
export function buildQueue(input) {
  const groups = classify(input || {});
  const queue = [];

  for (const card of groups.learningDue) queue.push(item(card, 'learning'));

  let newIndex = 0;
  let sinceNew = 0;
  for (const card of groups.reviews) {
    queue.push(item(card, 'review'));
    sinceNew += 1;
    if (sinceNew === NEW_EVERY_N_REVIEWS && newIndex < groups.news.length) {
      queue.push(item(groups.news[newIndex], 'new'));
      newIndex += 1;
      sinceNew = 0;
    } else if (sinceNew === NEW_EVERY_N_REVIEWS) {
      sinceNew = 0;
    }
  }
  while (newIndex < groups.news.length) {
    queue.push(item(groups.news[newIndex], 'new'));
    newIndex += 1;
  }

  for (const card of groups.learnAhead) queue.push(item(card, 'learning'));
  return queue;
}

/** Numbers for Inicio, computed exactly like buildQueue: { due, news, total, newPaused }. */
export function queueInfo(input) {
  const groups = classify(input || {});
  const due = groups.learningDue.length + groups.learnAhead.length + groups.reviews.length;
  const news = groups.news.length;
  return { due, news, total: due + news, newPaused: groups.newPaused };
}

function emptyCounters() {
  return { done: 0, again: 0, hard: 0, good: 0, easy: 0, newSeen: 0 };
}

const RATING_COUNTER = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };

function round2(x) {
  return Math.round(x * 100) / 100;
}

/**
 * In-memory session controller. It never touches the database.
 *   queue      result of buildQueue (copied)
 *   cardsById  Map or plain object: id -> card (cards are not mutated)
 *   settings   meta settings
 *   startedAt  ISO string, start of the session
 *   deviceId   written into every review row
 */
export function createSession({ queue, cardsById, settings, startedAt, deviceId = '' }) {
  let items = (Array.isArray(queue) ? queue : []).map((q) => ({ ...q }));
  let counters = emptyCounters();
  let shownAt = startedAt; // when the current card was put on screen
  const undoStack = [];
  const states = new Map(); // 'cardId|dir' -> current SrsState of this session

  function getCard(cardId) {
    if (!cardsById) return null;
    if (cardsById instanceof Map) return cardsById.get(cardId) || null;
    return cardsById[cardId] || null;
  }

  function stateKey(cardId, dir) {
    return cardId + '|' + dir;
  }

  /** Current SRS state of a card in this session (a copy; initial state if unknown). */
  function stateOf(cardId, dir = DIR) {
    const key = stateKey(cardId, dir);
    if (!states.has(key)) {
      const card = getCard(cardId);
      const stored = card && card.srs && card.srs[dir] ? card.srs[dir] : null;
      states.set(key, { ...initialState(), ...(stored || {}) });
    }
    return { ...states.get(key) };
  }

  function current() {
    return items.length > 0 ? items[0] : null;
  }

  function currentCard() {
    const it = current();
    return it ? getCard(it.cardId) : null;
  }

  function currentState() {
    const it = current();
    return it ? stateOf(it.cardId, it.dir) : null;
  }

  function remaining() {
    return items.length;
  }

  function remainingNew() {
    return items.filter((q) => q.kind === 'new').length;
  }

  /** Tell the controller when the current card appeared (for the answer time). Optional. */
  function markShown(nowIso) {
    shownAt = nowIso;
  }

  /**
   * Answer the current card. Returns { review, nextState, prevState }; the caller
   * persists `review` + `nextState` (db.applyReview) and calls undo() if that fails.
   */
  function rate(rating, nowIso) {
    const it = current();
    if (!it) throw new Error('rate: no quedan tarjetas en la sesión');
    const prevState = stateOf(it.cardId, it.dir);
    const nextState = next(prevState, rating, nowIso, settings, it.cardId); // throws on a bad rating
    const nowMs = Date.parse(nowIso);

    const review = {
      id: uuid(),
      cardId: it.cardId,
      dir: it.dir,
      ts: nowIso,
      rating,
      mode: 'srs',
      deviceId,
      stateBefore: prevState.state,
      elapsedDays: prevState.lastReviewAt ? round2(Math.max(0, nowMs - Date.parse(prevState.lastReviewAt)) / DAY_MS) : 0,
      scheduledDays: prevState.intervalDays,
      elapsedMs: Math.max(0, nowMs - Date.parse(shownAt)),
      undoneAt: null,
    };

    undoStack.push({
      reviewId: review.id,
      cardId: it.cardId,
      dir: it.dir,
      prevState,
      queueSnapshot: items.map((q) => ({ ...q })),
      countersSnapshot: { ...counters },
      shownAtSnapshot: shownAt,
    });

    // Requeue rule: short-step learning cards come back later in this session.
    items = items.slice(1);
    if (isSubDayLearning(nextState, settings)) {
      const position = Math.min(REQUEUE_GAP, items.length);
      items.splice(position, 0, { ...it, kind: 'learning' });
    }

    counters = { ...counters };
    counters.done += 1;
    counters[RATING_COUNTER[rating]] += 1;
    if (prevState.state === 'new') counters.newSeen += 1;

    states.set(stateKey(it.cardId, it.dir), { ...nextState });
    shownAt = nowIso;

    return { review, nextState, prevState };
  }

  /**
   * Take back the last rate(): restores queue, counters and the card's state.
   * Returns the undo entry ({ reviewId, cardId, dir, prevState, ... }) or null.
   * The caller then runs db.undoReview(entry.reviewId, entry.cardId, entry.dir, entry.prevState).
   */
  function undo(nowIso) {
    if (undoStack.length === 0) return null;
    const entry = undoStack.pop();
    items = entry.queueSnapshot.map((q) => ({ ...q }));
    counters = { ...entry.countersSnapshot };
    states.set(stateKey(entry.cardId, entry.dir), { ...entry.prevState });
    shownAt = nowIso || entry.shownAtSnapshot;
    return entry;
  }

  function canUndo() {
    return undoStack.length > 0;
  }

  /**
   * The entry undo() would return, WITHOUT undoing anything (null if there is none).
   * The review screen uses it to update the database first and the session second.
   */
  function peekUndo() {
    if (undoStack.length === 0) return null;
    const entry = undoStack[undoStack.length - 1];
    return { reviewId: entry.reviewId, cardId: entry.cardId, dir: entry.dir, prevState: { ...entry.prevState } };
  }

  function getCounters() {
    return { ...counters };
  }

  function elapsedMs(nowIso) {
    return Math.max(0, Date.parse(nowIso) - Date.parse(startedAt));
  }

  /** Copy of the remaining queue (for tests and debugging). */
  function queueCopy() {
    return items.map((q) => ({ ...q }));
  }

  return {
    startedAt,
    current,
    currentCard,
    currentState,
    stateOf,
    remaining,
    remainingNew,
    markShown,
    rate,
    undo,
    canUndo,
    peekUndo,
    counters: getCounters,
    elapsedMs,
    queue: queueCopy,
  };
}
