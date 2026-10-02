// Spaced repetition: SM-2 style scheduler (Anki-like learning steps).
//
// Everything here is PURE: no Date.now(), no database, no DOM. The current time
// is always passed in as an ISO string ('now'), so the same inputs always give
// the same result and the stored srs state can be rebuilt from the review log
// (see replay()).
//
// Every card carries srs.rec and srs.prod from the moment it is created.

import { hashString, mulberry32 } from './util.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DAY_MINUTES = 1440;

/** Scheduler constants. Some can be overridden by the user settings (see resolveParams). */
export const SM2 = {
  learningSteps: [10, 1440], // minutes
  graduatingIntervalDays: 1,
  easyIntervalDays: 4,
  startEase: 2.5,
  minEase: 1.3,
  hardFactor: 1.2,
  easyBonus: 1.3,
  lapseFactor: 0.5,
  relearnStepMinutes: 10,
  maxIntervalDays: 365,
  againEaseDelta: -0.2,
  hardEaseDelta: -0.15,
  easyEaseDelta: 0.15,
  fuzzPct: 0.05,
  fuzz: true,
};

/** Study settings used by the scheduler, the queue and the stats (same values as meta.settings). */
export const DEFAULT_SETTINGS = {
  newPerDay: 15,
  maxReviewsPerDay: 200,
  sessionMinutes: 15,
  learningSteps: [10, 1440],
  dayBoundaryHour: 4,
};

/** A fresh, never-reviewed SRS state for one direction. */
export function initialState() {
  return {
    state: 'new', // 'new' | 'learning' | 'review' | 'relearning'
    due: null, // ISO string once scheduled
    intervalDays: 0,
    ease: 2.5,
    step: 0,
    reps: 0,
    lapses: 0,
    lastReviewAt: null,
  };
}

/** The srs object stored on every card: one state per direction. */
export function initialSrs() {
  return { rec: initialState(), prod: initialState() };
}

/** Settings merged over DEFAULT_SETTINGS (settings may be null/partial). */
export function resolveSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  if (!isValidSteps(merged.learningSteps)) merged.learningSteps = DEFAULT_SETTINGS.learningSteps.slice();
  if (!Number.isFinite(merged.dayBoundaryHour)) merged.dayBoundaryHour = DEFAULT_SETTINGS.dayBoundaryHour;
  if (!Number.isFinite(merged.newPerDay)) merged.newPerDay = DEFAULT_SETTINGS.newPerDay;
  if (!Number.isFinite(merged.maxReviewsPerDay)) merged.maxReviewsPerDay = DEFAULT_SETTINGS.maxReviewsPerDay;
  if (!Number.isFinite(merged.sessionMinutes)) merged.sessionMinutes = DEFAULT_SETTINGS.sessionMinutes;
  return merged;
}

function isValidSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  return steps.every((m) => Number.isFinite(m) && m > 0);
}

/** SM2 constants with the user's learningSteps / maxIntervalDays / fuzz layered on top. */
export function resolveParams(settings) {
  const p = { ...SM2, learningSteps: SM2.learningSteps.slice() };
  const s = settings || {};
  if (isValidSteps(s.learningSteps)) p.learningSteps = s.learningSteps.slice();
  if (Number.isFinite(s.maxIntervalDays) && s.maxIntervalDays >= 1) p.maxIntervalDays = s.maxIntervalDays;
  if (typeof s.fuzz === 'boolean') p.fuzz = s.fuzz;
  return p;
}

// ------------------------------------------------------------ small helpers

function addMinutes(nowMs, minutes) {
  return new Date(nowMs + minutes * MINUTE_MS).toISOString();
}

function addDays(nowMs, days) {
  return new Date(nowMs + days * DAY_MS).toISOString();
}

/** Ease after a change: 2 decimals, never below minEase. */
function adjustEase(ease, delta, params) {
  const rounded = Math.round((ease + delta) * 100) / 100;
  return Math.max(params.minEase, rounded);
}

/** A valid index into the learning steps (settings may have changed since the last review). */
function clampStep(step, steps) {
  const n = Number.isFinite(step) ? Math.floor(step) : 0;
  return Math.min(Math.max(0, n), steps.length - 1);
}

/**
 * Deterministic fuzz: move the interval by up to +/- floor(interval * fuzzPct) days.
 * The offset depends only on (cardId, reps before this review).
 */
function applyFuzz(interval, params, cardId, repsBefore) {
  const range = Math.floor(interval * params.fuzzPct);
  if (range < 1) return interval;
  const random = mulberry32(hashString(String(cardId) + ':' + String(repsBefore)));
  const offset = Math.floor(random() * (2 * range + 1)) - range;
  return interval + offset;
}

// ------------------------------------------------------------ next()

/**
 * Compute the state after one answer. Never mutates `state`.
 * rating: 1 Otra vez, 2 Difícil, 3 Bien, 4 Fácil (anything else throws).
 */
export function next(state, rating, nowIso, settings, cardId) {
  if (rating !== 1 && rating !== 2 && rating !== 3 && rating !== 4) {
    throw new Error('next: valoración no válida: ' + String(rating));
  }
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) {
    throw new Error('next: fecha no válida: ' + String(nowIso));
  }
  const params = resolveParams(settings);
  const prev = { ...initialState(), ...(state || {}) };
  const out = { ...prev, reps: prev.reps + 1, lastReviewAt: nowIso };

  if (prev.state === 'review') {
    answerReview(out, prev, rating, nowMs, params, cardId);
  } else if (prev.state === 'relearning') {
    answerRelearning(out, prev, rating, nowMs, params);
  } else {
    // 'new' is treated as learning at step 0.
    answerLearning(out, prev, rating, nowMs, params);
  }
  return out;
}

function graduate(out, days, nowMs, params) {
  out.state = 'review';
  out.step = 0;
  out.intervalDays = Math.min(days, params.maxIntervalDays);
  out.due = addDays(nowMs, out.intervalDays);
}

function answerLearning(out, prev, rating, nowMs, params) {
  const steps = params.learningSteps;
  const step = prev.state === 'new' ? 0 : clampStep(prev.step, steps);

  if (rating === 1) {
    out.state = 'learning';
    out.step = 0;
    out.due = addMinutes(nowMs, steps[0]);
    return;
  }
  if (rating === 2) {
    out.state = 'learning';
    out.step = step;
    out.due = addMinutes(nowMs, steps[step]);
    return;
  }
  if (rating === 3) {
    if (step + 1 < steps.length) {
      out.state = 'learning';
      out.step = step + 1;
      out.due = addMinutes(nowMs, steps[step + 1]);
    } else {
      graduate(out, params.graduatingIntervalDays, nowMs, params);
    }
    return;
  }
  // rating 4: graduate immediately with the easy interval. Ease is unchanged in learning.
  graduate(out, params.easyIntervalDays, nowMs, params);
}

function answerReview(out, prev, rating, nowMs, params, cardId) {
  const interval = prev.intervalDays;
  const ease = prev.ease;

  if (rating === 1) {
    out.lapses = prev.lapses + 1;
    out.ease = adjustEase(ease, params.againEaseDelta, params);
    out.state = 'relearning';
    out.step = 0;
    out.intervalDays = Math.max(1, Math.round(interval * params.lapseFactor));
    out.due = addMinutes(nowMs, params.relearnStepMinutes);
    return;
  }

  let days;
  if (rating === 2) {
    days = Math.max(interval + 1, Math.round(interval * params.hardFactor));
    out.ease = adjustEase(ease, params.hardEaseDelta, params);
  } else if (rating === 3) {
    days = Math.max(interval + 1, Math.round(interval * ease));
  } else {
    days = Math.max(interval + 1, Math.round(interval * ease * params.easyBonus));
    out.ease = adjustEase(ease, params.easyEaseDelta, params);
  }

  // Cap, then fuzz, then cap again.
  days = Math.min(days, params.maxIntervalDays);
  if (params.fuzz) {
    days = applyFuzz(days, params, cardId, prev.reps);
  }
  days = Math.max(1, Math.min(days, params.maxIntervalDays));

  out.state = 'review';
  out.step = 0;
  out.intervalDays = days;
  out.due = addDays(nowMs, days);
}

function answerRelearning(out, prev, rating, nowMs, params) {
  if (rating === 1 || rating === 2) {
    // Stay in relearning: no extra lapse, no ease change.
    out.state = 'relearning';
    out.step = 0;
    out.due = addMinutes(nowMs, params.relearnStepMinutes);
    return;
  }
  // intervalDays already holds the post-lapse interval.
  let days = Math.max(1, prev.intervalDays);
  if (rating === 4) days += 1;
  days = Math.min(days, params.maxIntervalDays);
  out.state = 'review';
  out.step = 0;
  out.intervalDays = days;
  out.due = addDays(nowMs, days);
}

// ------------------------------------------------------------ labels

function oneDecimal(x) {
  return String(Math.round(x * 10) / 10);
}

/** Short Spanish label for a delay in minutes: '10 min', '2 h', '25 d', '3 m', '1 a'. */
export function intervalLabel(minutes) {
  if (minutes < 60) return String(Math.max(1, Math.round(minutes))) + ' min';
  if (minutes < DAY_MINUTES) return oneDecimal(minutes / 60) + ' h';
  const days = minutes / DAY_MINUTES;
  if (days < 60) return String(Math.round(days)) + ' d';
  if (days < 365) return oneDecimal(days / 30) + ' m';
  return oneDecimal(days / 365) + ' a';
}

/** Interval labels for the four rating buttons: { 1: '10 min', 2: '10 min', 3: '1 d', 4: '4 d' }. */
export function predict(state, settings, nowIso, cardId) {
  const nowMs = Date.parse(nowIso);
  const labels = {};
  for (const rating of [1, 2, 3, 4]) {
    const after = next(state, rating, nowIso, settings, cardId);
    const minutes = (Date.parse(after.due) - nowMs) / MINUTE_MS;
    labels[rating] = intervalLabel(minutes);
  }
  return labels;
}

// ------------------------------------------------------------ replay

function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Rebuild the state of one card/direction from the review log.
 * Only rows of that card and direction with mode 'srs' that were not undone count.
 */
export function replay(cardId, dir, reviews, settings) {
  const rows = (Array.isArray(reviews) ? reviews : []).filter(
    (r) => r && r.cardId === cardId && r.dir === dir && r.mode === 'srs' && !r.undoneAt
  );
  rows.sort((a, b) => compareText(a.ts, b.ts) || compareText(String(a.id), String(b.id)));
  let state = initialState();
  for (const r of rows) {
    state = next(state, r.rating, r.ts, settings, cardId);
  }
  return state;
}

// ------------------------------------------------------------ study day / due

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localDayString(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

/**
 * The "study day" of a moment: the LOCAL date of (time - dayBoundaryHour hours).
 * With the default 4, 03:59 local still belongs to the previous day.
 */
export function studyDay(iso, dayBoundaryHour = 4) {
  const ms = Date.parse(iso);
  const shifted = new Date(ms - dayBoundaryHour * 60 * MINUTE_MS);
  return localDayString(shifted);
}

/** 'YYYY-MM-DD' moved by n days (n may be negative). Calendar arithmetic in local time. */
export function shiftDay(dayString, n) {
  const parts = String(dayString).split('-');
  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + n);
  return localDayString(date);
}

function boundaryHour(settings) {
  return settings && Number.isFinite(settings.dayBoundaryHour) ? settings.dayBoundaryHour : DEFAULT_SETTINGS.dayBoundaryHour;
}

/** Delay in minutes of the step a learning/relearning state is waiting on (null for other states). */
function currentStepMinutes(state, settings) {
  const params = resolveParams(settings);
  if (state.state === 'relearning') return params.relearnStepMinutes;
  if (state.state === 'learning') {
    const steps = params.learningSteps;
    return steps[clampStep(state.step, steps)];
  }
  return null;
}

/** True for learning/relearning states whose current step is shorter than one day. */
export function isSubDayLearning(state, settings) {
  if (!state) return false;
  const minutes = currentStepMinutes(state, settings);
  return minutes !== null && minutes < DAY_MINUTES;
}

/**
 * Is this state due at `nowIso`?
 *   - 'new' is never "due" (new cards are handled by the daily new-card limit)
 *   - sub-day learning/relearning: due when due <= now
 *   - day-level states (review, or learning on a >= 1 day step): due when the
 *     study day of `due` is today or earlier (so a card answered at 22:00 with a
 *     1-day delay is due from 04:00 the next day, not at 22:00)
 */
export function isDue(state, nowIso, settings) {
  if (!state || state.state === 'new' || !state.due) return false;
  if (isSubDayLearning(state, settings)) {
    return Date.parse(state.due) <= Date.parse(nowIso);
  }
  const hour = boundaryHour(settings);
  return studyDay(state.due, hour) <= studyDay(nowIso, hour);
}
