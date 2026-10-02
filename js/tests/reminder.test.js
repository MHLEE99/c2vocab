// Tests for js/reminder.js (pure): the export reminder shown on Inicio.

import { test, eq, deepEq } from './harness.js';
import { exportReminder, exportReminderText } from '../reminder.js';

const NOW = '2026-10-20T10:00:00.000Z';
const TODAY = '2026-10-20';

function daysAgo(n) {
  return new Date(Date.parse(NOW) - n * 24 * 60 * 60 * 1000).toISOString();
}

test('reminder: no banner without cards; "never exported" banner with cards', () => {
  eq(exportReminder({ cardCount: 0, lastExportAt: null, lastSyncAt: null, snoozedDay: null, today: TODAY, nowIso: NOW }), null);
  const r = exportReminder({ cardCount: 3, lastExportAt: null, lastSyncAt: null, snoozedDay: null, today: TODAY, nowIso: NOW });
  deepEq(r, { never: true, days: 0 });
  eq(exportReminderText(r), 'Aún no has exportado tus datos');
  eq(exportReminderText(null), '');
});

test('reminder: appears only when the newest export/sync is older than 7 days', () => {
  const base = { cardCount: 5, snoozedDay: null, today: TODAY, nowIso: NOW };
  eq(exportReminder({ ...base, lastExportAt: daysAgo(2), lastSyncAt: null }), null, 'recent export');
  eq(exportReminder({ ...base, lastExportAt: daysAgo(7), lastSyncAt: null }), null, 'exactly 7 days is not older');
  const old = exportReminder({ ...base, lastExportAt: daysAgo(9.5), lastSyncAt: null });
  deepEq(old, { never: false, days: 9 });
  eq(exportReminderText(old), 'Hace 9 días que no exportas tus datos');
  // The newest of export and sync counts.
  eq(exportReminder({ ...base, lastExportAt: daysAgo(30), lastSyncAt: daysAgo(1) }), null, 'recent sync');
  deepEq(exportReminder({ ...base, lastExportAt: null, lastSyncAt: daysAgo(8.2) }), { never: false, days: 8 });
});

test('reminder: "Más tarde" hides it for the same study day only', () => {
  const base = { cardCount: 5, lastExportAt: null, lastSyncAt: null, today: TODAY, nowIso: NOW };
  eq(exportReminder({ ...base, snoozedDay: TODAY }), null, 'snoozed today');
  deepEq(exportReminder({ ...base, snoozedDay: '2026-10-19' }), { never: true, days: 0 }, 'snoozed yesterday');
});
