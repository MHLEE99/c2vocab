// Small statistics for Inicio and the session summary. Pure functions over
// review rows and cards. Rows that were undone (undoneAt) or that are not
// scheduler reviews (mode !== 'srs') are ignored everywhere.

import { studyDay, shiftDay, resolveSettings } from './srs.js';
import { isEligible } from './session.js';

function counts(review) {
  return !!review && !review.undoneAt && review.mode === 'srs';
}

/**
 * Today's numbers (study day of `nowIso`): { done, newSeen, again, hard, good, easy, reviewsDone }.
 * `done` counts every rating; `reviewsDone` only the answers to cards that were in
 * state 'review' — that is the number the daily review limit (maxReviewsPerDay) uses,
 * so new cards and learning repeats do not eat into it.
 */
export function countsToday(reviews, nowIso, settings) {
  const hour = resolveSettings(settings).dayBoundaryHour;
  const today = studyDay(nowIso, hour);
  const out = { done: 0, newSeen: 0, again: 0, hard: 0, good: 0, easy: 0, reviewsDone: 0 };
  for (const r of Array.isArray(reviews) ? reviews : []) {
    if (!counts(r)) continue;
    if (studyDay(r.ts, hour) !== today) continue;
    out.done += 1;
    if (r.stateBefore === 'new') out.newSeen += 1;
    if (r.stateBefore === 'review') out.reviewsDone += 1;
    if (r.rating === 1) out.again += 1;
    else if (r.rating === 2) out.hard += 1;
    else if (r.rating === 3) out.good += 1;
    else if (r.rating === 4) out.easy += 1;
  }
  return out;
}

/**
 * Consecutive study days with at least one review, ending today — or ending
 * yesterday when nothing has been reviewed yet today. 0 if neither.
 */
export function streak(reviews, nowIso, settings) {
  const hour = resolveSettings(settings).dayBoundaryHour;
  const days = new Set();
  for (const r of Array.isArray(reviews) ? reviews : []) {
    if (counts(r)) days.add(studyDay(r.ts, hour));
  }
  let day = studyDay(nowIso, hour);
  if (!days.has(day)) day = shiftDay(day, -1);
  let n = 0;
  while (days.has(day)) {
    n += 1;
    day = shiftDay(day, -1);
  }
  return n;
}

/** How many eligible cards have their 'rec' due date on the next study day. */
export function dueTomorrow(cards, nowIso, settings) {
  const hour = resolveSettings(settings).dayBoundaryHour;
  const tomorrow = shiftDay(studyDay(nowIso, hour), 1);
  let n = 0;
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!isEligible(card)) continue;
    const st = card.srs && card.srs.rec;
    if (!st || st.state === 'new' || !st.due) continue;
    if (studyDay(st.due, hour) === tomorrow) n += 1;
  }
  return n;
}
