// Tests for js/stats-lite.js. Timestamps are built from LOCAL time so the
// study-day boundary (04:00) is tested the same way in every timezone.

import { test, eq, deepEq } from './harness.js';
import { initialState } from '../srs.js';
import { countsToday, streak, dueTomorrow } from '../stats-lite.js';

const S = { fuzz: false, dayBoundaryHour: 4 };

/** ISO string of a LOCAL wall-clock time (month is 0-based like in Date). */
function local(y, m, d, h, mi) {
  return new Date(y, m, d, h, mi || 0).toISOString();
}

let seq = 0;
function row(ts, rating, extra) {
  seq += 1;
  return { id: 'r' + seq, cardId: 'c' + seq, dir: 'rec', ts, rating, mode: 'srs', stateBefore: 'review', undoneAt: null, ...(extra || {}) };
}

const NOW = local(2026, 9, 2, 12); // 2 Oct 2026, noon

test('stats 23: countsToday uses the study day and ignores undone / non-srs rows', () => {
  const reviews = [
    row(local(2026, 9, 2, 5), 3, { stateBefore: 'new' }), // today
    row(local(2026, 9, 2, 3), 1), // 03:00 still belongs to 1 Oct
    row(local(2026, 9, 3, 2), 4), // 02:00 of the 3rd still belongs to 2 Oct
    row(local(2026, 9, 2, 9), 2, { undoneAt: local(2026, 9, 2, 9, 1) }), // undone
    row(local(2026, 9, 2, 10), 1, { mode: 'cram' }), // not a scheduler review
    row(local(2026, 9, 1, 12), 3, { stateBefore: 'new' }), // yesterday
  ];
  deepEq(countsToday(reviews, NOW, S), { done: 2, newSeen: 1, again: 0, hard: 0, good: 1, easy: 1, reviewsDone: 1 });
  deepEq(countsToday([], NOW, S), { done: 0, newSeen: 0, again: 0, hard: 0, good: 0, easy: 0, reviewsDone: 0 });
  // seen from yesterday's study day (2 Oct 03:30 is still 1 Oct)
  deepEq(countsToday(reviews, local(2026, 9, 2, 3, 30), S), { done: 2, newSeen: 1, again: 1, hard: 0, good: 1, easy: 0, reviewsDone: 1 });
});

test('stats 23: countsToday.reviewsDone counts only answers to review-state cards', () => {
  const reviews = [
    row(local(2026, 9, 2, 8, 0), 1, { stateBefore: 'new' }),
    row(local(2026, 9, 2, 8, 1), 3, { stateBefore: 'learning' }),
    row(local(2026, 9, 2, 8, 2), 1, { stateBefore: 'review' }), // a lapse: counts once
    row(local(2026, 9, 2, 8, 3), 3, { stateBefore: 'relearning' }),
    row(local(2026, 9, 2, 8, 4), 3, { stateBefore: 'review' }),
    row(local(2026, 9, 2, 8, 5), 4, { stateBefore: 'review', undoneAt: local(2026, 9, 2, 8, 6) }), // undone
    row(local(2026, 9, 1, 12), 3, { stateBefore: 'review' }), // yesterday
  ];
  const today = countsToday(reviews, NOW, S);
  eq(today.done, 5, 'every rating of today');
  eq(today.reviewsDone, 2, 'only the two review-state answers');
  eq(today.newSeen, 1);
});

test('stats 23: streak — today, yesterday only, a gap breaks it, 0', () => {
  const oct2 = row(local(2026, 9, 2, 12), 3);
  const oct1 = row(local(2026, 9, 1, 12), 3);
  const sep30 = row(local(2026, 8, 30, 12), 3);
  const sep28 = row(local(2026, 8, 28, 12), 3);

  eq(streak([oct2, oct1, sep30, sep28], NOW, S), 3, 'three days in a row, then a gap');
  eq(streak([oct2, oct2, oct2], NOW, S), 1, 'several reviews on one day count once');
  eq(streak([oct1, sep30], NOW, S), 2, 'nothing today yet: the streak ending yesterday still counts');
  eq(streak([sep30, sep28], NOW, S), 0, 'neither today nor yesterday');
  eq(streak([], NOW, S), 0);
  eq(streak([{ ...oct2, undoneAt: NOW }], NOW, S), 0, 'undone rows do not count');
  eq(streak([{ ...oct2, mode: 'cram' }], NOW, S), 0, 'non-srs rows do not count');
  // a review at 02:00 on 2 Oct belongs to 1 Oct
  eq(streak([row(local(2026, 9, 2, 2), 3)], NOW, S), 1, 'counts as yesterday');
  eq(streak([row(local(2026, 9, 2, 2), 3), sep30], NOW, S), 2);
});

test('stats 23: dueTomorrow counts eligible cards due on the next study day', () => {
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
  const tomorrowNoon = local(2026, 9, 3, 12);
  const cards = [
    card('a', { state: 'review', intervalDays: 1, due: tomorrowNoon }), // counts
    card('b', { state: 'learning', step: 1, due: local(2026, 9, 3, 22) }), // counts
    card('c', { state: 'review', intervalDays: 1, due: local(2026, 9, 2, 22) }), // today
    card('d', { state: 'review', intervalDays: 2, due: local(2026, 9, 4, 12) }), // in two days
    card('e'), // new
    card('f', { state: 'review', intervalDays: 1, due: tomorrowNoon }, { status: 'suspended' }),
    card('g', { state: 'review', intervalDays: 1, due: tomorrowNoon }, { deletedAt: '2026-10-01T00:00:00.000Z' }),
    card('h', { state: 'review', intervalDays: 1, due: local(2026, 9, 4, 3) }), // 03:00 of the 4th = study day 3 Oct
  ];
  eq(dueTomorrow(cards, NOW, S), 3);
  eq(dueTomorrow([], NOW, S), 0);
});
