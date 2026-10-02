// Tests for js/export.js, js/backup.js and the step-3 helpers of js/db.js.
// They run against the separate database 'c2vocab_test' (never the real one).

import { test, assert, eq, deepEq, throws } from './harness.js';
import { uuid, sleep } from '../util.js';
import { initialState, next } from '../srs.js';
import { createDb, newCard } from '../db.js';
import { buildEnvelope, exportFilename, envelopeCounts } from '../export.js';
import { createBackupApi, backupReasonLabel, BACKUP_KEEP } from '../backup.js';
import { validateEnvelope } from '../merge.js';
import { parseImport, classifyRows } from '../importer.js';

const tdb = createDb('c2vocab_test');
const backup = createBackupApi(tdb);

async function reset() {
  const d = tdb.dexie;
  await d.transaction('rw', d.cards, d.reviews, d.meta, d.backups, async () => {
    await d.cards.clear();
    await d.reviews.clear();
    await d.meta.clear();
    await d.backups.clear();
  });
  await tdb.initMeta();
}

function plusMin(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60000).toISOString();
}

function reviewRow(cardId, ts, rating, stateBefore) {
  return {
    id: uuid(),
    cardId,
    dir: 'rec',
    ts,
    rating,
    mode: 'srs',
    deviceId: 'test-device',
    stateBefore,
    elapsedDays: 0,
    scheduledDays: 0,
    elapsedMs: 1200,
    undoneAt: null,
  };
}

/** Rate a new card once ('Bien') through the real db function. Returns the review row. */
async function rateOnce(card, ts) {
  const settings = await tdb.getSettings();
  const state = next(initialState(), 3, ts, settings, card.id);
  const review = reviewRow(card.id, ts, 3, 'new');
  await tdb.applyReview(review, state, initialState());
  return review;
}

const T = '2026-10-01T10:00:00.000Z';

// ------------------------------------------------------------ db helpers

test('backup: updateSettings merges into the settings row', async () => {
  await reset();
  const s1 = await tdb.updateSettings({ lastExportAt: T });
  eq(s1.lastExportAt, T);
  eq(s1.newPerDay, 15, 'other settings kept');
  await tdb.updateSettings({ newPerDay: 7 });
  const stored = await tdb.getSettings();
  eq(stored.newPerDay, 7);
  eq(stored.lastExportAt, T, 'earlier patch kept');
  eq(stored.lastSyncAt, null);
  await tdb.dexie.meta.clear();
  eq((await tdb.updateSettings({ examDate: '2027-05-01' })).maxReviewsPerDay, 200, 'works without a stored row');
});

test('backup: allCardsIncludingDeleted returns live cards and tombstones', async () => {
  await reset();
  const a = newCard({ front: 'viva', back: 'x' });
  const b = newCard({ front: 'borrada', back: 'y' });
  await tdb.addCards([a, b]);
  await tdb.softDeleteCard(b.id);
  const all = await tdb.allCardsIncludingDeleted();
  eq(all.length, 2);
  eq(all.filter((c) => c.deletedAt).length, 1);
});

test('backup: applyDocChanges writes cards and reviews in one transaction and never deletes', async () => {
  await reset();
  const a = newCard({ front: 'a', back: 'x' });
  const b = newCard({ front: 'b', back: 'y' });
  await tdb.addCards([a]);
  const r1 = reviewRow(a.id, T, 3, 'new');
  const written = await tdb.applyDocChanges({ cards: [{ ...a, back: 'cambiada' }, b], reviews: [r1] });
  deepEq(written, { cards: 2, reviews: 1 });
  eq((await tdb.getCard(a.id)).back, 'cambiada', 'existing card replaced');
  eq((await tdb.getCard(b.id)).front, 'b', 'new card inserted');
  eq((await tdb.listReviews()).length, 1);

  // a bad review row rolls back the cards of the same call
  await throws(() => tdb.applyDocChanges({ cards: [{ ...a, back: 'no debe guardarse' }], reviews: [{ cardId: a.id }] }));
  eq((await tdb.getCard(a.id)).back, 'cambiada');
  deepEq(await tdb.applyDocChanges({}), { cards: 0, reviews: 0 });
  eq(await tdb.dexie.cards.count(), 2);
});

test('backup: importCards adds and patches in one transaction (updatedAt bump, status rule)', async () => {
  await reset();
  const inbox = newCard({ front: 'en bandeja' });
  await tdb.addCards([inbox]);
  await sleep(5);
  const fresh = newCard({ front: 'nueva', back: 'def' });
  const result = await tdb.importCards({ toAdd: [fresh], toUpdate: [{ id: inbox.id, patch: { back: 'ahora sí', tags: ['X'], id: 'otro', createdAt: T } }] });
  deepEq(result, { added: 1, updated: 1 });
  const stored = await tdb.getCard(inbox.id);
  eq(stored.back, 'ahora sí');
  eq(stored.status, 'active', 'inbox + back -> active');
  deepEq(stored.tags, ['x']);
  eq(stored.createdAt, inbox.createdAt, 'createdAt cannot be patched');
  assert(stored.updatedAt > inbox.updatedAt, 'updatedAt bumped');
  deepEq(stored.srs, inbox.srs, 'srs untouched');
  eq((await tdb.getCard(fresh.id)).front, 'nueva');
  deepEq(await tdb.importCards({}), { added: 0, updated: 0 });
});

test('backup: importCards is atomic (a failing update or a duplicate id writes nothing)', async () => {
  await reset();
  const a = newCard({ front: 'a', back: 'x' });
  await tdb.addCards([a]);

  const b = newCard({ front: 'b', back: 'y' });
  await throws(() => tdb.importCards({ toAdd: [b], toUpdate: [{ id: 'no-existe', patch: { back: 'z' } }] }), 'unknown id must throw');
  eq(await tdb.dexie.cards.count(), 1, 'b was rolled back');

  const dup = newCard({ front: 'c', back: 'z', id: a.id });
  await throws(() => tdb.importCards({ toAdd: [b, dup], toUpdate: [{ id: a.id, patch: { back: 'cambiada' } }] }), 'duplicate id must throw');
  eq(await tdb.dexie.cards.count(), 1);
  eq((await tdb.getCard(a.id)).back, 'x', 'the patch was not applied either');
  eq((await tdb.getCard(a.id)).updatedAt, a.updatedAt);
});

// ------------------------------------------------------------ export.js

test('export: buildEnvelope has the envelope shape, with tombstones and undone reviews', async () => {
  await reset();
  await tdb.setMeta('deviceName', 'PC de prueba');
  const a = newCard({ front: 'viva', back: 'x' });
  const b = newCard({ front: 'borrada', back: 'y' });
  const c = newCard({ front: 'otra', back: 'z' });
  await tdb.addCards([a, b, c]);
  await tdb.softDeleteCard(b.id);
  await rateOnce(a, T);
  const undone = await rateOnce(c, T);
  await tdb.undoReview(undone.id, c.id, 'rec', initialState());

  const env = await buildEnvelope(tdb, '2026-10-03T09:00:00.000Z');
  deepEq(Object.keys(env), ['app', 'schemaVersion', 'exportedAt', 'deviceId', 'deviceName', 'cards', 'reviews', 'settings']);
  eq(env.app, 'c2vocab');
  eq(env.schemaVersion, 1);
  eq(env.exportedAt, '2026-10-03T09:00:00.000Z');
  eq(env.deviceId, await tdb.getMeta('deviceId'));
  eq(env.deviceName, 'PC de prueba');
  eq(env.cards.length, 3, 'all cards');
  eq(env.cards.filter((x) => x.deletedAt).length, 1, 'the tombstone is included');
  eq(env.reviews.length, 2, 'all review rows');
  eq(env.reviews.filter((x) => x.undoneAt).length, 1, 'the undone review is included');
  eq(env.settings.newPerDay, 15);
  deepEq(validateEnvelope(env), { ok: true });
  deepEq(envelopeCounts(env), { cards: 2, deleted: 1, reviews: 2 });
  deepEq(JSON.parse(JSON.stringify(env)), env, 'survives a JSON round trip');
});

test('export: exportFilename uses the local date and a file-safe device name', () => {
  const noon = new Date(2026, 9, 3, 12, 0).toISOString(); // local noon, 3 Oct 2026
  eq(exportFilename({ exportedAt: noon, deviceName: 'PC' }), 'c2vocab-2026-10-03-PC.json');
  eq(exportFilename({ exportedAt: noon, deviceName: 'iPhone de Mó/1' }), 'c2vocab-2026-10-03-iPhone-de-M1.json');
  eq(exportFilename({ exportedAt: noon, deviceName: ' mi_PC-2 ' }), 'c2vocab-2026-10-03-mi_PC-2.json');
  eq(exportFilename({ exportedAt: noon, deviceName: '../..\\x.json' }), 'c2vocab-2026-10-03-xjson.json');
  eq(exportFilename({ exportedAt: noon, deviceName: '한국어' }), 'c2vocab-2026-10-03-dispositivo.json');
  eq(exportFilename({ exportedAt: noon }), 'c2vocab-2026-10-03-dispositivo.json');
  const lateEvening = new Date(2026, 0, 5, 23, 30).toISOString(); // still 5 Jan in local time
  eq(exportFilename({ exportedAt: lateEvening, deviceName: 'PC' }), 'c2vocab-2026-01-05-PC.json');
});

// ------------------------------------------------------------ snapshots

test('backup: snapshot stores the envelope with counts; nothing is stored for an empty database', async () => {
  await reset();
  eq(await backup.snapshot('manual', T), null, '0 cards -> skipped');
  eq((await backup.listBackups()).length, 0);

  const a = newCard({ front: 'viva', back: 'x' });
  const b = newCard({ front: 'borrada', back: 'y' });
  await tdb.addCards([a, b]);
  await tdb.softDeleteCard(b.id);
  await rateOnce(a, T);

  const info = await backup.snapshot('manual', T);
  eq(info.reason, 'manual');
  eq(info.createdAt, T);
  eq(info.cards, 1, 'live cards only');
  eq(info.reviews, 1);
  assert(typeof info.id === 'number');

  const list = await backup.listBackups();
  eq(list.length, 1);
  eq(list[0].id, info.id);
  eq(list[0].createdAt, T);
  eq(list[0].reason, 'manual');
  eq(list[0].cards, 1);
  eq(list[0].reviews, 1);
  assert(!('json' in list[0]), 'the list carries no json');

  const row = await backup.getBackup(info.id);
  const stored = JSON.parse(row.json);
  deepEq(validateEnvelope(stored), { ok: true });
  eq(stored.cards.length, 2, 'the snapshot itself contains the tombstone');
  eq(stored.exportedAt, T);
  eq(await backup.getBackup(99999), undefined);
  eq(backupReasonLabel('session').length > 0, true);
});

test('backup: session snapshots are throttled to one per 60 minutes', async () => {
  await reset();
  await tdb.addCards([newCard({ front: 'a', back: 'x' })]);
  assert(await backup.snapshot('session', T), 'first session snapshot');
  eq(await backup.snapshot('session', plusMin(T, 30)), null, '30 min later: skipped');
  eq(await backup.snapshot('session', plusMin(T, 59)), null, '59 min later: skipped');
  assert(await backup.snapshot('manual', plusMin(T, 31)), 'other reasons are never throttled');
  assert(await backup.snapshot('pre-import', plusMin(T, 32)), 'other reasons are never throttled');
  eq(await backup.snapshot('session', plusMin(T, 45)), null, 'a manual copy does not reset the throttle');
  assert(await backup.snapshot('session', plusMin(T, 60)), '60 min later: stored');
  eq(await backup.snapshot('session', plusMin(T, 100)), null, 'throttled from the newest session copy');
  const reasons = (await backup.listBackups()).map((b) => b.reason);
  deepEq(reasons, ['session', 'pre-import', 'manual', 'session'], 'newest first');
});

test('backup: only the 10 newest snapshots are kept; cards and reviews are never pruned', async () => {
  await reset();
  const a = newCard({ front: 'a', back: 'x' });
  await tdb.addCards([a]);
  await rateOnce(a, T);
  for (let i = 0; i < 13; i++) {
    await backup.snapshot('manual', plusMin(T, i));
  }
  const list = await backup.listBackups();
  eq(BACKUP_KEEP, 10);
  eq(list.length, 10);
  eq(list[0].createdAt, plusMin(T, 12), 'newest first');
  eq(list[9].createdAt, plusMin(T, 3), 'the three oldest are gone');
  eq(await tdb.dexie.backups.count(), 10);
  eq(await tdb.dexie.cards.count(), 1);
  eq(await tdb.dexie.reviews.count(), 1);
});

test('backup: the snapshot just taken survives pruning even when older rows carry later timestamps', async () => {
  await reset();
  await tdb.addCards([newCard({ front: 'a', back: 'x' })]);
  // The clock was ahead while these ten were stored...
  for (let i = 0; i < BACKUP_KEEP; i++) {
    await backup.snapshot('manual', plusMin(T, 1000 + i));
  }
  // ...and is correct now: the new copy has the smallest createdAt of all.
  const fresh = await backup.snapshot('pre-import', T);
  assert(fresh && typeof fresh.id === 'number');
  const row = await backup.getBackup(fresh.id);
  assert(row, 'the copy taken right before a write is still there');
  eq(row.reason, 'pre-import');
  const list = await backup.listBackups();
  eq(list.length, BACKUP_KEEP);
  assert(!list.some((b) => b.createdAt === plusMin(T, 1000)), 'the first stored row was pruned instead');
});

// ------------------------------------------------------------ restore

test('backup: restoreBackup reverts an edited card, keeps reviews and later cards, and takes a pre-restore copy', async () => {
  await reset();
  const a = newCard({ front: 'restaurable', back: 'definición original' });
  const gone = newCard({ front: 'se borrará', back: 'x' });
  await tdb.addCards([a, gone]);
  await rateOnce(a, T);
  const copy = await backup.snapshot('manual');
  await sleep(5);

  // after the copy: edit, delete, add a card, study once more
  await tdb.updateCard(a.id, { back: 'definición estropeada' });
  await tdb.softDeleteCard(gone.id);
  const later = newCard({ front: 'posterior', back: 'y' });
  await tdb.addCards([later]);
  await rateOnce(later, plusMin(T, 5));
  const srsBefore = (await tdb.getCard(a.id)).srs;
  await sleep(5);

  const preview = await backup.previewRestore(copy.id);
  eq(preview.stats.cardsReverted, 2);
  eq(preview.stats.cardsKept, 1);
  eq(preview.stats.cardsReadded, 0);
  eq(preview.stats.reviewsAdded, 0);
  eq((await tdb.getCard(a.id)).back, 'definición estropeada', 'the preview writes nothing');
  eq((await backup.listBackups()).length, 1, 'the preview takes no snapshot');

  const result = await backup.restoreBackup(copy.id);
  eq(result.stats.cardsReverted, 2);
  eq(result.stats.cardsKept, 1);
  deepEq(result.changedCardIds.slice().sort(), [a.id, gone.id].sort());

  const restored = await tdb.getCard(a.id);
  eq(restored.back, 'definición original');
  eq(restored.createdAt, a.createdAt);
  assert(restored.updatedAt > a.updatedAt, 'updatedAt moved forward so the reverted card wins later merges');
  deepEq(restored.srs, srsBefore, 'progress is not rolled back');
  eq((await tdb.getCard(gone.id)).deletedAt, null, 'the deleted card is back');
  eq((await tdb.getCard(later.id)).front, 'posterior', 'a card added after the copy is still there');
  eq((await tdb.getCard(later.id)).srs.rec.reps, 1);
  eq((await tdb.listReviews()).length, 2, 'reviews untouched');
  eq(await tdb.dexie.cards.count(), 3);

  const list = await backup.listBackups();
  eq(list.length, 2);
  eq(list[0].reason, 'pre-restore');
  eq(list[0].id, result.safetyBackupId);
  const safety = JSON.parse((await backup.getBackup(list[0].id)).json);
  eq(safety.cards.find((c) => c.id === a.id).back, 'definición estropeada', 'the pre-restore copy holds the state before restoring');

  // restoring the same copy again changes nothing
  const again = await backup.previewRestore(copy.id);
  eq(again.stats.cardsReverted, 0);
  deepEq(again.changedCardIds, []);
  await throws(() => backup.restoreBackup(424242), 'unknown backup id');
  await throws(() => backup.previewRestore(424242), 'unknown backup id');
});

// ------------------------------------------------------------ importEnvelope

test('backup: importEnvelope of the database\'s own envelope is a no-op', async () => {
  await reset();
  const a = newCard({ front: 'a', back: 'x' });
  const b = newCard({ front: 'b' });
  await tdb.addCards([a, b]);
  await tdb.softDeleteCard(b.id);
  await rateOnce(a, T);
  const env = JSON.parse(JSON.stringify(await buildEnvelope(tdb, T)));
  const cardsBefore = JSON.stringify(await tdb.allCardsIncludingDeleted());

  const preview = await backup.previewImportEnvelope(env);
  deepEq(preview.stats, { cardsAdded: 0, cardsUpdated: 0, cardsUnchanged: 2, cardsInvalid: 0, cardsDuplicateKey: 0, reviewsAdded: 0, reviewsUpdated: 0, reviewsInvalid: 0 });
  const result = await backup.importEnvelope(env);
  deepEq(result.stats, preview.stats);
  deepEq(result.changedCardIds, []);
  deepEq(result.changedReviewIds, []);
  eq(JSON.stringify(await tdb.allCardsIncludingDeleted()), cardsBefore, 'nothing changed');
  eq((await tdb.listReviews()).length, 1);
  eq((await backup.listBackups()).length, 0, 'a no-op import does not use up a backup slot');
});

test('backup: importEnvelope after a local delete keeps the card deleted (the tombstone is newer)', async () => {
  await reset();
  const a = newCard({ front: 'se queda borrada', back: 'x' });
  const b = newCard({ front: 'otra', back: 'y' });
  await tdb.addCards([a, b]);
  const env = JSON.parse(JSON.stringify(await buildEnvelope(tdb)));
  await sleep(5);
  await tdb.softDeleteCard(a.id);

  const result = await backup.importEnvelope(env);
  eq(result.stats.cardsAdded, 0, 'no resurrection');
  eq(result.stats.cardsUpdated, 0);
  eq(result.stats.cardsUnchanged, 2);
  assert((await tdb.getCard(a.id)).deletedAt, 'still deleted');
  eq((await tdb.listCards({ deleted: false })).length, 1);
});

test('backup: importEnvelope merges another device (new card, newer edit, reviews) after a pre-import copy', async () => {
  await reset();
  const shared = newCard({ front: 'compartida', back: 'versión local' });
  await tdb.addCards([shared]);
  const settings = await tdb.getSettings();
  const local = await buildEnvelope(tdb);

  const otherCard = newCard({ front: 'del iPhone', back: 'z' });
  const ts = '2026-10-02T08:00:00.000Z';
  const incoming = {
    ...local,
    deviceId: 'zzz-otro-dispositivo',
    deviceName: 'iPhone',
    cards: [{ ...shared, back: 'versión del iPhone', updatedAt: plusMin(shared.updatedAt, 1), campoFuturo: 1 }, otherCard, { id: 'rota' }],
    reviews: [reviewRow(shared.id, ts, 3, 'new'), reviewRow(otherCard.id, ts, 4, 'new')],
  };

  const dry = await backup.previewImportEnvelope(incoming);
  deepEq(dry.stats, { cardsAdded: 1, cardsUpdated: 1, cardsUnchanged: 0, cardsInvalid: 1, cardsDuplicateKey: 0, reviewsAdded: 2, reviewsUpdated: 0, reviewsInvalid: 0 });
  eq(await tdb.dexie.cards.count(), 1, 'the dry run writes nothing');

  const result = await backup.importEnvelope(incoming);
  deepEq(result.stats, dry.stats);
  const merged = await tdb.getCard(shared.id);
  eq(merged.back, 'versión del iPhone');
  eq(merged.campoFuturo, 1, 'unknown field stored');
  deepEq(merged.srs.rec, next(initialState(), 3, ts, settings, shared.id), 'srs rebuilt from the merged reviews');
  const added = await tdb.getCard(otherCard.id);
  eq(added.front, 'del iPhone');
  deepEq(added.srs.rec, next(initialState(), 4, ts, settings, otherCard.id));
  eq((await tdb.listReviews()).length, 2);
  eq(await tdb.getMeta('deviceName') !== 'iPhone', true, 'device identity stays local');

  const copies = await backup.listBackups();
  eq(copies.length, 1);
  eq(copies[0].reason, 'pre-import');
  eq(JSON.parse((await backup.getBackup(copies[0].id)).json).cards[0].back, 'versión local');

  // importing the same file again changes nothing
  const again = await backup.importEnvelope(incoming);
  eq(again.stats.cardsAdded, 0);
  eq(again.stats.cardsUpdated, 0);
  eq(again.stats.reviewsAdded, 0);
  eq((await backup.listBackups()).length, 1);
});

test('backup: importEnvelope rejects an invalid or newer envelope and writes nothing', async () => {
  await reset();
  await tdb.addCards([newCard({ front: 'a', back: 'x' })]);
  await throws(() => backup.importEnvelope({ app: 'otra', schemaVersion: 1, cards: [], reviews: [] }), 'wrong app');
  await throws(() => backup.importEnvelope({ app: 'c2vocab', schemaVersion: 2, cards: [newCard({ front: 'z' })], reviews: [] }), 'newer version');
  await throws(() => backup.previewImportEnvelope(null), 'not an object');
  let message = '';
  try {
    await backup.importEnvelope({ app: 'c2vocab', schemaVersion: 2, cards: [], reviews: [] });
  } catch (e) {
    message = e.message;
  }
  assert(/versión más nueva/.test(message), 'the Spanish reason is the error message');
  eq(await tdb.dexie.cards.count(), 1);
  eq((await backup.listBackups()).length, 0);
});

// ------------------------------------------------------------ bulk card import

const PASTE = '```json\n' + JSON.stringify([
  { front: 'poner coto a', back: 'Impedir que algo siga extendiéndose.', ko: '제동을 걸다', example: 'Urge [[poner coto a]] la especulación.', exampleSource: 'redactado', type: 'locucion', register: 'culto', region: 'general', tags: ['tema:economia_trabajo', 'prueba:1'] },
  { front: 'acarrear consecuencias', back: 'Traer consigo efectos negativos.', ko: '결과를 초래하다', type: 'colocacion', colocaciones: ['acarrear problemas'], tags: ['prueba:3'] },
  { front: 'a todas luces', back: 'De manera evidente.', ko: '명백히', type: 'locucion', tags: ['prueba:1'] },
]) + '\n```';

async function classifyPaste(text, defaults) {
  const parsed = parseImport(text);
  return classifyRows(parsed.rows, await backup.existingCardMap(), defaults || {});
}

test('backup: commitCardImport adds new cards once; the same paste again is all duplicates and Enriquecer changes nothing', async () => {
  await reset();
  const first = await classifyPaste(PASTE, { tags: ['claude-economia'] });
  deepEq(first.counts, { total: 3, nuevas: 3, duplicadas: 0, repetidas: 0, invalidas: 0 });
  deepEq(await backup.commitCardImport(first.rows, 'enriquecer'), { added: 3, updated: 0, unchanged: 0, skipped: 0 });
  const cards = await tdb.listCards({ deleted: false });
  eq(cards.length, 3);
  const coto = cards.find((c) => c.front === 'poner coto a');
  eq(coto.status, 'active');
  eq(coto.type, 'locucion');
  deepEq(coto.tags, ['tema:economia_trabajo', 'prueba:1', 'claude-economia']);
  eq(coto.srs.rec.state, 'new', 'imported cards are always fresh');
  eq((await backup.listBackups()).length, 0, 'nothing to protect before the first import');

  const stamp = JSON.stringify(await tdb.allCardsIncludingDeleted());
  const second = await classifyPaste(PASTE, { tags: ['claude-economia'] });
  deepEq(second.counts, { total: 3, nuevas: 0, duplicadas: 3, repetidas: 0, invalidas: 0 });
  eq(second.rows[0].existingId, coto.id);
  deepEq(await backup.commitCardImport(second.rows, 'enriquecer'), { added: 0, updated: 0, unchanged: 3, skipped: 0 });
  deepEq(await backup.commitCardImport(second.rows, 'omitir'), { added: 0, updated: 0, unchanged: 0, skipped: 3 });
  eq(JSON.stringify(await tdb.allCardsIncludingDeleted()), stamp, 'not a single card was touched');
  eq((await backup.listBackups()).length, 0, 'no write, no snapshot');
});

test('backup: commitCardImport enriches / overwrites duplicates, completes inbox cards and keeps their reviews', async () => {
  await reset();
  const mine = newCard({ front: 'a todas luces', back: 'mi definición', type: 'locucion', tags: ['mia'] });
  const waiting = newCard({ front: 'Poner coto a', type: 'expresion' }); // inbox, front only
  await tdb.addCards([mine, waiting]);
  await rateOnce(mine, T);
  const srsBefore = (await tdb.getCard(mine.id)).srs;
  await sleep(5);

  const rows = (await classifyPaste(PASTE)).rows;
  deepEq(rows.map((r) => r.status), ['duplicada', 'nueva', 'duplicada']);
  const plan = await backup.planCardImport(rows, 'enriquecer');
  eq(plan.toAdd.length, 1);
  eq(plan.toUpdate.length, 2);
  eq(await tdb.dexie.cards.count(), 2, 'planning writes nothing');

  deepEq(await backup.commitCardImport(rows, 'enriquecer'), { added: 1, updated: 2, unchanged: 0, skipped: 0 });
  const enriched = await tdb.getCard(mine.id);
  eq(enriched.back, 'mi definición', 'Enriquecer keeps what was there');
  eq(enriched.ko, '명백히', 'and fills the empty field');
  deepEq(enriched.tags, ['mia', 'prueba:1']);
  deepEq(enriched.srs, srsBefore, 'study progress untouched');
  assert(enriched.updatedAt > mine.updatedAt, 'updatedAt bumped');
  const completed = await tdb.getCard(waiting.id);
  eq(completed.status, 'active', 'the inbox card was completed');
  eq(completed.back, 'Impedir que algo siga extendiéndose.');
  eq(completed.type, 'locucion');
  eq(completed.front, 'Poner coto a', 'Enriquecer never changes the front');
  eq(await tdb.dexie.cards.count(), 3);
  const copies = await backup.listBackups();
  eq(copies.length, 1);
  eq(copies[0].reason, 'pre-import');
  eq(copies[0].cards, 2, 'the copy was taken before the import');

  const again = (await classifyPaste(PASTE)).rows;
  deepEq(again.map((r) => r.status), ['duplicada', 'duplicada', 'duplicada']);
  const result = await backup.commitCardImport(again, 'sobrescribir');
  eq(result.added, 0);
  eq(result.updated, 2, 'the two cards that differ from the paste');
  eq(result.unchanged, 1);
  const overwritten = await tdb.getCard(mine.id);
  eq(overwritten.back, 'De manera evidente.', 'Sobrescribir replaces the content');
  deepEq(overwritten.tags, ['prueba:1']);
  deepEq(overwritten.srs, srsBefore, 'but never the study progress');
  eq(overwritten.createdAt, mine.createdAt);
  eq((await tdb.getCard(waiting.id)).front, 'poner coto a');
  eq((await tdb.listReviews()).length, 1);
  await reset();
});

test('backup: a row without its own type completes an inbox card but keeps the type the learner chose', async () => {
  for (const mode of ['enriquecer', 'sobrescribir']) {
    await reset();
    const waiting = newCard({ front: 'poner coto a', type: 'locucion' }); // inbox, type chosen in quick add
    await tdb.addCards([waiting]);
    // A pipe line has no type column; 'Tipo por defecto' is left empty (-> 'otro') or set to another type.
    for (const defaults of [{}, { type: 'lexico' }]) {
      const cls = await classifyPaste('poner coto a | impedir que algo siga', defaults);
      eq(cls.rows[0].status, 'duplicada', 'matched through the inbox key');
      eq(cls.rows[0].typeExplicit, false);
      const plan = await backup.planCardImport(cls.rows, mode);
      eq(plan.toUpdate.length, 1);
      assert(!('type' in plan.toUpdate[0].patch), mode + ': a fallback type is not in the patch');
    }
    const rows = (await classifyPaste('poner coto a | impedir que algo siga')).rows;
    await backup.commitCardImport(rows, mode);
    const stored = await tdb.getCard(waiting.id);
    eq(stored.back, 'impedir que algo siga');
    eq(stored.status, 'active');
    eq(stored.type, 'locucion', mode + ': the chosen type is kept');
  }
  await reset();
});
