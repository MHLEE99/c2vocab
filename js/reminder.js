// "You have not exported for a while" reminder shown on Inicio. Pure: no database, no clock.

const DAY_MS = 24 * 60 * 60 * 1000;

export const EXPORT_REMINDER_DAYS = 7;

/** Milliseconds of an ISO string, or null when it is empty or unreadable. */
function parseMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Decide whether Inicio shows the export reminder.
 *   cardCount    live cards (no reminder while there is nothing to lose)
 *   lastExportAt / lastSyncAt   ISO strings or null (from settings)
 *   snoozedDay   study day ('YYYY-MM-DD') on which 'Más tarde' was pressed, or null
 *   today        the current study day ('YYYY-MM-DD')
 *   nowIso       the current time
 * Returns null (no banner) or { never: boolean, days: number }:
 *   never = nothing was ever exported or synced; days = whole days since the newest of the two.
 */
export function exportReminder({ cardCount, lastExportAt, lastSyncAt, snoozedDay, today, nowIso } = {}) {
  if (!cardCount || cardCount < 1) return null;
  // 'Más tarde' hides the banner until the next study day.
  if (snoozedDay && today && String(snoozedDay) >= String(today)) return null;

  const exportMs = parseMs(lastExportAt);
  const syncMs = parseMs(lastSyncAt);
  if (exportMs === null && syncMs === null) return { never: true, days: 0 };

  const newest = Math.max(exportMs === null ? -Infinity : exportMs, syncMs === null ? -Infinity : syncMs);
  const nowMs = parseMs(nowIso);
  if (nowMs === null) return null;
  const age = nowMs - newest;
  if (age <= EXPORT_REMINDER_DAYS * DAY_MS) return null;
  return { never: false, days: Math.floor(age / DAY_MS) };
}

/** The Spanish headline of the banner. */
export function exportReminderText(reminder) {
  if (!reminder) return '';
  if (reminder.never) return 'Aún no has exportado tus datos';
  return `Hace ${reminder.days} días que no exportas tus datos`;
}
