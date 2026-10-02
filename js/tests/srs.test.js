// Tests for the pure scheduler in js/srs.js. Fixed timestamps, fuzz off unless stated.

import { test, assert, eq, deepEq, throws } from './harness.js';
import {
  SM2,
  DEFAULT_SETTINGS,
  initialState,
  resolveParams,
  resolveSettings,
  next,
  predict,
  intervalLabel,
  replay,
  studyDay,
  shiftDay,
  isDue,
  isSubDayLearning,
} from '../srs.js';

const NOW = '2026-10-02T12:00:00.000Z';
const S = { fuzz: false, learningSteps: [10, 1440], dayBoundaryHour: 4 };

function plusMin(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60000).toISOString();
}

function plusDays(iso, days) {
  return plusMin(iso, days * 1440);
}

/** ISO string of a LOCAL wall-clock time (month is 0-based like in Date). */
function local(y, m, d, h, mi) {
  return new Date(y, m, d, h, mi).toISOString();
}

function st(patch) {
  return { ...initialState(), ...patch };
}

const LAST = '2026-09-22T12:00:00.000Z';

function reviewState(intervalDays, ease, extra) {
  return st({ state: 'review', due: NOW, intervalDays, ease, reps: 5, lastReviewAt: LAST, ...(extra || {}) });
}

test('srs: SM2 constants and resolveParams / resolveSettings', () => {
  deepEq(SM2.learningSteps, [10, 1440]);
  eq(SM2.maxIntervalDays, 365);
  eq(SM2.minEase, 1.3);
  eq(SM2.fuzz, true);
  const p = resolveParams({ learningSteps: [1, 5, 20], maxIntervalDays: 100, fuzz: false, newPerDay: 3 });
  deepEq(p.learningSteps, [1, 5, 20]);
  eq(p.maxIntervalDays, 100);
  eq(p.fuzz, false);
  eq(p.hardFactor, 1.2);
  const d = resolveParams(undefined);
  deepEq(d.learningSteps, [10, 1440]);
  eq(d.fuzz, true);
  deepEq(resolveParams({ learningSteps: [] }).learningSteps, [10, 1440], 'empty steps fall back');
  deepEq(SM2.learningSteps, [10, 1440], 'SM2 itself is not modified');
  eq(resolveSettings(null).newPerDay, 15);
  eq(resolveSettings({ newPerDay: 5 }).newPerDay, 5);
  eq(resolveSettings({ newPerDay: 5 }).dayBoundaryHour, 4);
  eq(DEFAULT_SETTINGS.maxReviewsPerDay, 200);
});

test('srs 1: new + Bien -> learning step 1, due in 1440 min, ease 2.5, reps 1', () => {
  deepEq(next(initialState(), 3, NOW, S, 'c1'), {
    state: 'learning',
    due: plusMin(NOW, 1440),
    intervalDays: 0,
    ease: 2.5,
    step: 1,
    reps: 1,
    lapses: 0,
    lastReviewAt: NOW,
  });
});

test('srs 2-3: new + Otra vez / Difícil -> learning step 0, due in 10 min', () => {
  for (const rating of [1, 2]) {
    const n = next(initialState(), rating, NOW, S, 'c1');
    eq(n.state, 'learning');
    eq(n.step, 0);
    eq(n.due, plusMin(NOW, 10));
    eq(n.ease, 2.5);
    eq(n.lapses, 0);
    eq(n.reps, 1);
    eq(n.lastReviewAt, NOW);
  }
});

test('srs 4: new + Fácil -> review, interval 4, due in 4 days, ease 2.5', () => {
  const n = next(initialState(), 4, NOW, S, 'c1');
  eq(n.state, 'review');
  eq(n.step, 0);
  eq(n.intervalDays, 4);
  eq(n.due, plusDays(NOW, 4));
  eq(n.ease, 2.5);
});

test('srs 5-6: learning step 1 + Bien graduates (1 day); + Otra vez goes back to step 0', () => {
  const learning = st({ state: 'learning', step: 1, due: NOW, reps: 1, lastReviewAt: LAST });
  const good = next(learning, 3, NOW, S, 'c1');
  eq(good.state, 'review');
  eq(good.intervalDays, 1);
  eq(good.due, plusDays(NOW, 1));
  eq(good.step, 0);
  eq(good.reps, 2);
  const again = next(learning, 1, NOW, S, 'c1');
  eq(again.state, 'learning');
  eq(again.step, 0);
  eq(again.due, plusMin(NOW, 10));
  eq(again.lapses, 0, 'no lapse while learning');
  const hard = next(learning, 2, NOW, S, 'c1');
  eq(hard.state, 'learning');
  eq(hard.step, 1, 'Difícil repeats the same step');
  eq(hard.due, plusMin(NOW, 1440));
  const easy = next(learning, 4, NOW, S, 'c1');
  eq(easy.state, 'review');
  eq(easy.intervalDays, 4);
});

test('srs 7-9: review I=10 E=2.5 + Bien / Difícil / Fácil', () => {
  const good = next(reviewState(10, 2.5), 3, NOW, S, 'c1');
  eq(good.state, 'review');
  eq(good.intervalDays, 25);
  eq(good.ease, 2.5);
  eq(good.due, plusDays(NOW, 25));
  eq(good.reps, 6);
  eq(good.lapses, 0);
  const hard = next(reviewState(10, 2.5), 2, NOW, S, 'c1');
  eq(hard.intervalDays, 12);
  eq(hard.ease, 2.35);
  eq(hard.due, plusDays(NOW, 12));
  const easy = next(reviewState(10, 2.5), 4, NOW, S, 'c1');
  eq(easy.intervalDays, 33);
  eq(easy.ease, 2.65);
  eq(easy.due, plusDays(NOW, 33));
});

test('srs 10: review + Otra vez -> relearning, interval halved, ease -0.20, lapse +1', () => {
  const n = next(reviewState(10, 2.5), 1, NOW, S, 'c1');
  eq(n.state, 'relearning');
  eq(n.step, 0);
  eq(n.due, plusMin(NOW, 10));
  eq(n.intervalDays, 5);
  eq(n.ease, 2.3);
  eq(n.lapses, 1);
  eq(next(reviewState(1, 2.5), 1, NOW, S, 'c1').intervalDays, 1, 'post-lapse interval is at least 1');
});

test('srs 11: relearning answers', () => {
  const rel = st({ state: 'relearning', due: NOW, intervalDays: 5, ease: 2.3, reps: 6, lapses: 1, lastReviewAt: LAST });
  const good = next(rel, 3, NOW, S, 'c1');
  eq(good.state, 'review');
  eq(good.intervalDays, 5);
  eq(good.due, plusDays(NOW, 5));
  eq(good.ease, 2.3);
  const easy = next(rel, 4, NOW, S, 'c1');
  eq(easy.state, 'review');
  eq(easy.intervalDays, 6);
  eq(easy.due, plusDays(NOW, 6));
  for (const rating of [1, 2]) {
    const n = next(rel, rating, NOW, S, 'c1');
    eq(n.state, 'relearning');
    eq(n.due, plusMin(NOW, 10));
    eq(n.lapses, 1, 'no extra lapse');
    eq(n.ease, 2.3, 'ease unchanged');
    eq(n.intervalDays, 5);
    eq(n.reps, 7);
  }
});

test('srs 12: ease never drops below 1.3', () => {
  eq(next(reviewState(10, 1.35), 1, NOW, S, 'c1').ease, 1.3);
  eq(next(reviewState(10, 1.4), 2, NOW, S, 'c1').ease, 1.3);
  eq(next(reviewState(10, 1.3), 1, NOW, S, 'c1').ease, 1.3);
});

test('srs 13-14: max interval 365 and growth guarantee (I+1)', () => {
  const capped = next(reviewState(300, 2.5), 3, NOW, S, 'c1');
  eq(capped.intervalDays, 365);
  eq(capped.due, plusDays(NOW, 365));
  eq(next(reviewState(300, 2.5), 3, NOW, { fuzz: false, maxIntervalDays: 400 }, 'c1').intervalDays, 400, 'settings.maxIntervalDays');
  const grow = next(reviewState(1, 1.3), 2, NOW, S, 'c1');
  eq(grow.intervalDays, 2);
  eq(grow.ease, 1.3);
  eq(next(reviewState(1, 1.3), 3, NOW, S, 'c1').intervalDays, 2);
});

test('srs 15-16: input state is not mutated; invalid rating throws', async () => {
  const input = reviewState(10, 2.5);
  const copy = JSON.stringify(input);
  const out = next(input, 1, NOW, S, 'c1');
  eq(JSON.stringify(input), copy, 'input untouched');
  assert(out !== input, 'a new object is returned');
  const fresh = initialState();
  next(fresh, 3, NOW, S, 'c1');
  deepEq(fresh, initialState());
  await throws(() => next(initialState(), 0, NOW, S, 'c1'));
  await throws(() => next(initialState(), 5, NOW, S, 'c1'));
  await throws(() => next(initialState(), '3', NOW, S, 'c1'));
  await throws(() => next(initialState(), undefined, NOW, S, 'c1'));
});

test('srs 17: fuzz is deterministic, bounded, skipped for short intervals', () => {
  const F = {}; // fuzz defaults to true
  const base = reviewState(100, 2.5); // unfuzzed Bien = 250, range = floor(12.5) = 12
  const a = next(base, 3, NOW, F, 'card-A');
  const b = next(base, 3, NOW, F, 'card-A');
  deepEq(a, b, 'same inputs -> same output');
  assert(Number.isInteger(a.intervalDays), 'integer interval');
  assert(Math.abs(a.intervalDays - 250) <= 12, 'within +/-12 of 250, got ' + a.intervalDays);
  eq(a.due, plusDays(NOW, a.intervalDays), 'due matches the fuzzed interval');

  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const n = next(base, 3, NOW, F, 'card-' + i);
    assert(Math.abs(n.intervalDays - 250) <= 12, 'bounded for card-' + i);
    seen.add(n.intervalDays);
  }
  assert(seen.size > 1, 'different cardIds can get different intervals');

  // 7 * 2.5 = 17.5 -> 18; floor(18 * 0.05) = 0 -> no fuzz
  eq(next(reviewState(7, 2.5), 3, NOW, F, 'card-A').intervalDays, 18);
  // fuzz never pushes past the maximum
  for (let i = 0; i < 20; i++) {
    assert(next(reviewState(300, 2.5), 3, NOW, F, 'cap-' + i).intervalDays <= 365, 'capped after fuzz');
  }
  // fuzz off -> exact value
  eq(next(base, 3, NOW, { fuzz: false }, 'card-A').intervalDays, 250);
  // learning answers are never fuzzed
  eq(next(initialState(), 4, NOW, F, 'card-A').intervalDays, 4);
});

test('srs: predict gives the button labels; intervalLabel units', () => {
  deepEq(predict(initialState(), S, NOW, 'c1'), { 1: '10 min', 2: '10 min', 3: '1 d', 4: '4 d' });
  deepEq(predict(reviewState(10, 2.5), S, NOW, 'c1'), { 1: '10 min', 2: '12 d', 3: '25 d', 4: '33 d' });
  eq(intervalLabel(10), '10 min');
  eq(intervalLabel(120), '2 h');
  eq(intervalLabel(1440), '1 d');
  eq(intervalLabel(25 * 1440), '25 d');
  eq(intervalLabel(90 * 1440), '3 m');
  eq(intervalLabel(75 * 1440), '2.5 m');
  eq(intervalLabel(365 * 1440), '1 a');
});

test('srs 18: replay equals stepwise next() and ignores foreign / undone rows', () => {
  const t0 = '2026-09-01T10:00:00.000Z';
  const t1 = '2026-09-02T10:00:00.000Z';
  const t2 = '2026-09-03T10:00:00.000Z';
  const t3 = '2026-09-07T10:00:00.000Z';
  const t4 = '2026-09-07T10:10:00.000Z';
  let s = initialState();
  s = next(s, 3, t0, S, 'X');
  s = next(s, 3, t1, S, 'X');
  s = next(s, 4, t2, S, 'X');
  s = next(s, 1, t3, S, 'X');
  s = next(s, 3, t4, S, 'X');
  eq(s.state, 'review');
  eq(s.lapses, 1);
  eq(s.reps, 5);

  const row = (id, ts, rating, extra) => ({ id, cardId: 'X', dir: 'rec', ts, rating, mode: 'srs', undoneAt: null, ...(extra || {}) });
  const rows = [
    row('r5', t4, 3),
    row('r2', t1, 3),
    row('u1', t2, 1, { undoneAt: '2026-09-03T10:00:05.000Z' }), // undone
    row('r4', t3, 1),
    row('p1', t1, 1, { dir: 'prod' }), // other direction
    row('r1', t0, 3),
    row('o1', t1, 1, { cardId: 'Y' }), // other card
    row('m1', t2, 1, { mode: 'cram' }), // not a scheduler review
    row('r3', t2, 4),
  ];
  const before = JSON.stringify(rows);
  deepEq(replay('X', 'rec', rows, S), s);
  eq(JSON.stringify(rows), before, 'input rows are not reordered');
  deepEq(replay('nobody', 'rec', rows, S), initialState());
  eq(replay('X', 'prod', rows, S).reps, 1);
  // same ts -> id decides the order: Otra vez (a) then Bien (b)
  const tie = [row('b', t0, 3), row('a', t0, 1)];
  eq(replay('X', 'rec', tie, S).step, 1);
});

test('srs 19: studyDay boundary is 04:00 local', () => {
  eq(studyDay(local(2026, 9, 2, 3, 59), 4), '2026-10-01');
  eq(studyDay(local(2026, 9, 2, 4, 0), 4), '2026-10-02');
  eq(studyDay(local(2026, 9, 2, 23, 30), 4), '2026-10-02');
  eq(studyDay(local(2026, 9, 2, 3, 59)), '2026-10-01', 'default boundary is 4');
  eq(studyDay(local(2026, 0, 1, 2, 0), 4), '2025-12-31', 'crosses the year');
  eq(studyDay(local(2026, 9, 2, 0, 30), 0), '2026-10-02', 'boundary 0 = calendar day');
  eq(shiftDay('2026-10-01', -1), '2026-09-30');
  eq(shiftDay('2026-12-31', 1), '2027-01-01');
  eq(shiftDay('2026-03-01', -1), '2026-02-28');
});

test('srs 20: isDue compares day-level states by study day, sub-day ones by the clock', () => {
  eq(isDue(initialState(), NOW, S), false, 'new is never due');

  const rev = st({ state: 'review', intervalDays: 1, due: local(2026, 9, 3, 22, 0) });
  eq(isDue(rev, local(2026, 9, 2, 23, 0), S), false, 'due tomorrow 22:00, now today 23:00');
  eq(isDue(rev, local(2026, 9, 3, 8, 0), S), true, 'due tomorrow 22:00, now tomorrow 08:00');
  eq(isDue(rev, local(2026, 9, 5, 8, 0), S), true, 'overdue');

  // learning on the 1-day step behaves like a day-level card
  const dayLearning = st({ state: 'learning', step: 1, due: local(2026, 9, 3, 22, 0) });
  eq(isSubDayLearning(dayLearning, S), false);
  eq(isDue(dayLearning, local(2026, 9, 3, 3, 59), S), false, '03:59 is still the previous study day');
  eq(isDue(dayLearning, local(2026, 9, 3, 4, 0), S), true, 'due from 04:00');

  const short = st({ state: 'learning', step: 0, due: plusMin(NOW, 5) });
  eq(isSubDayLearning(short, S), true);
  eq(isDue(short, NOW, S), false);
  eq(isDue(short, plusMin(NOW, 6), S), true);
  eq(isDue(short, plusMin(NOW, 5), S), true, 'due exactly now');

  const rel = st({ state: 'relearning', intervalDays: 5, due: plusMin(NOW, 5) });
  eq(isSubDayLearning(rel, S), true);
  eq(isDue(rel, NOW, S), false);
  eq(isDue(rel, plusMin(NOW, 6), S), true);

  eq(isSubDayLearning(rev, S), false);
  eq(isSubDayLearning(initialState(), S), false);
});
