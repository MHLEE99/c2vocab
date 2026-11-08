// Browser test runner (open http://localhost:8080/test.html). No framework, no Node.
// Database tests use a separate Dexie database 'c2vocab_test' and never touch 'c2vocab'.

import { uuid, nowIso, normalize, escapeHtml, fmtDate, sleep, hashString, mulberry32 } from './util.js';
import { parseCapture, splitTags, normalizeTagList } from './capture.js';
import { initialState, initialSrs, next } from './srs.js';
import { createDb, newCard, dupKey } from './db.js';
import { test, assert, eq, deepEq, throws, run } from './tests/harness.js';

// Step 2 test files. They register their tests when imported (before the ones below).
import './tests/srs.test.js';
import './tests/session.test.js';
import './tests/stats.test.js';
// Step 3 test files (merge, import, export/backup, prompt).
import './tests/merge.test.js';
import './tests/importer.test.js';
import './tests/backup.test.js';
import './tests/prompt.test.js';
import './tests/reminder.test.js';
// Step 4 test files (PWA: platform rules, manifest / icons / service worker files).
import './tests/platform.test.js';
import './tests/pwa.test.js';

// ------------------------------------------------------------ util.js

test('uuid() returns v4-shaped unique strings', () => {
  const a = uuid();
  const b = uuid();
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a), 'shape: ' + a);
  assert(a !== b, 'two calls differ');
});

test('nowIso() is an ISO string parseable as a date', () => {
  const s = nowIso();
  assert(/^\d{4}-\d{2}-\d{2}T/.test(s), s);
  assert(!Number.isNaN(Date.parse(s)));
});

test('normalize strips accents, lowercases, collapses whitespace, trims', () => {
  eq(normalize('  Hacer   HINCAPIÉ  en '), 'hacer hincapie en');
  eq(normalize('árbol Éxito ÜBER'), 'arbol exito uber');
  eq(normalize('a\tb\n c'), 'a b c');
  eq(normalize(''), '');
  eq(normalize(null), '');
  eq(normalize(undefined), '');
});

test('normalize keeps ñ distinct from n', () => {
  eq(normalize('Año'), 'año');
  eq(normalize('ÑU'), 'ñu');
  assert(normalize('año') !== normalize('ano'), 'año and ano must differ');
  // Already-decomposed input (n + combining tilde) is treated the same as precomposed ñ.
  eq(normalize('ñ'), 'ñ');
});

test('normalize makes hincapie match hincapié', () => {
  eq(normalize('hincapie'), normalize('hincapié'));
});

test('escapeHtml escapes the five special characters', () => {
  eq(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  eq(escapeHtml(null), '');
});

test('fmtDate returns a non-empty Spanish date and empty string for invalid input', () => {
  const s = fmtDate('2026-09-15T10:32:00.000Z');
  assert(s.length > 0 && /2026/.test(s), s);
  eq(fmtDate(''), '');
  eq(fmtDate('not a date'), '');
  eq(fmtDate(null), '');
});

test('hashString is FNV-1a 32-bit (known vectors) and deterministic', () => {
  eq(hashString(''), 0x811c9dc5);
  eq(hashString('a'), 0xe40c292c);
  eq(hashString('foobar'), 0xbf9cf968);
  eq(hashString('card-1:3'), hashString('card-1:3'));
  assert(hashString('card-1:3') !== hashString('card-1:4'), 'different input, different hash');
  assert(hashString('x') >= 0 && hashString('x') <= 0xffffffff, 'unsigned 32-bit');
});

test('mulberry32 gives the same sequence for the same seed, values in [0, 1)', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const c = mulberry32(54321);
  const seqA = [a(), a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b(), b()];
  const seqC = [c(), c(), c(), c(), c()];
  deepEq(seqA, seqB);
  assert(JSON.stringify(seqA) !== JSON.stringify(seqC), 'another seed gives another sequence');
  for (const x of seqA.concat(seqC)) assert(x >= 0 && x < 1, 'in [0, 1): ' + x);
  assert(new Set(seqA).size > 1, 'values vary');
});

// ------------------------------------------------------------ srs.js

test('initialState has the documented shape', () => {
  deepEq(initialState(), {
    state: 'new',
    due: null,
    intervalDays: 0,
    ease: 2.5,
    step: 0,
    reps: 0,
    lapses: 0,
    lastReviewAt: null,
  });
  const s = initialSrs();
  assert(s.rec && s.prod, 'rec and prod');
  assert(s.rec !== s.prod, 'rec and prod are separate objects');
});

// ------------------------------------------------------------ capture.js

const ACCEPTANCE_TEXT = [
  'hacer hincapié en',
  ': subrayar o insistir en la importancia de algo',
  '= 강조하다',
  '> El ministro [[hizo hincapié en]] la necesidad de reformar el sistema de pensiones antes de fin de año.',
  '# tema:politica_sociedad prueba:1',
  '',
  'a raíz de :: como consecuencia de, a partir de | [[A raíz de]] la crisis, muchas empresas cerraron.',
  '',
  'dar en el clavo',
].join('\n');

test('splitTags / normalizeTagList: commas, spaces, leading #, case, dedupe', () => {
  deepEq(splitTags('#Tema:Economia, prueba:1 prueba:1,,  #x'), ['tema:economia', 'prueba:1', 'x']);
  deepEq(normalizeTagList(['A', 'a', '', ' b ']), ['a', 'b']);
  deepEq(splitTags(''), []);
});

test('parseCapture: single entry with all prefixes', () => {
  const text = ['hacer hincapié en', ': subrayar algo', '= 강조하다', '> El ministro [[hizo hincapié en]] la reforma.', '# tema:politica_sociedad, prueba:1', '@ clase 2026-09-15'].join('\n');
  const { cards, warnings } = parseCapture(text, { type: 'locucion', register: 'neutro', region: 'ES', tags: [] });
  eq(warnings.length, 0);
  eq(cards.length, 1);
  const c = cards[0];
  eq(c.front, 'hacer hincapié en');
  eq(c.back, 'subrayar algo');
  eq(c.ko, '강조하다');
  eq(c.example, 'El ministro [[hizo hincapié en]] la reforma.');
  deepEq(c.tags, ['tema:politica_sociedad', 'prueba:1']);
  eq(c.source, 'clase 2026-09-15');
  eq(c.type, 'locucion');
  eq(c.register, 'neutro');
  eq(c.region, 'ES');
});

test('parseCapture: one-liner with example', () => {
  const { cards } = parseCapture('a raíz de :: como consecuencia de | [[A raíz de]] la crisis, cerraron.');
  eq(cards.length, 1);
  eq(cards[0].front, 'a raíz de');
  eq(cards[0].back, 'como consecuencia de');
  eq(cards[0].example, '[[A raíz de]] la crisis, cerraron.');
});

test('parseCapture: one-liner without example', () => {
  const { cards } = parseCapture('a raíz de :: como consecuencia de');
  eq(cards.length, 1);
  eq(cards[0].back, 'como consecuencia de');
  eq(cards[0].example, '');
});

test('parseCapture: one-liner followed by prefixed lines', () => {
  const { cards } = parseCapture('a raíz de :: como consecuencia de\n= ~로 인해\n# tema:economia_trabajo');
  eq(cards.length, 1);
  eq(cards[0].ko, '~로 인해');
  deepEq(cards[0].tags, ['tema:economia_trabajo']);
});

test('parseCapture: two entries separated by a blank line (also a line with spaces)', () => {
  const { cards } = parseCapture('uno\n: primero\n   \ndos\n: segundo');
  eq(cards.length, 2);
  eq(cards[0].front, 'uno');
  eq(cards[0].back, 'primero');
  eq(cards[1].front, 'dos');
  eq(cards[1].back, 'segundo');
});

test('parseCapture: front-only entry gives back ""', () => {
  const { cards } = parseCapture('dar en el clavo');
  eq(cards.length, 1);
  eq(cards[0].front, 'dar en el clavo');
  eq(cards[0].back, '');
});

test('parseCapture: repeated ":" and ">" lines append with a space; unknown lines go to back', () => {
  const { cards } = parseCapture('x\n: parte uno\n: parte dos\nparte tres\n> ej uno\n> ej dos');
  eq(cards[0].back, 'parte uno parte dos parte tres');
  eq(cards[0].example, 'ej uno ej dos');
});

test('parseCapture: "#" tags with commas and leading #, repeated # merge', () => {
  const { cards } = parseCapture('x\n# #Tema:Salud, prueba:2\n# prueba:2 otro');
  deepEq(cards[0].tags, ['tema:salud', 'prueba:2', 'otro']);
});

test('parseCapture: empty text yields 0 cards and no warnings', () => {
  const r = parseCapture('');
  eq(r.cards.length, 0);
  eq(r.warnings.length, 0);
  eq(parseCapture('   \n\n  ').cards.length, 0);
});

test('parseCapture: defaults tags are merged with entry tags', () => {
  const { cards } = parseCapture('x\n# b', { tags: ['A', 'b'] });
  deepEq(cards[0].tags, ['a', 'b']);
  const r2 = parseCapture('y', { tags: ['clase'] });
  deepEq(r2.cards[0].tags, ['clase']);
});

test('parseCapture: block starting with a prefix line is skipped with a warning', () => {
  const r = parseCapture(': sin expresión\n\nok');
  eq(r.cards.length, 1);
  eq(r.cards[0].front, 'ok');
  eq(r.warnings.length, 1);
});

test('parseCapture: CRLF line endings and default type', () => {
  const { cards } = parseCapture('uno\r\n: a\r\n\r\ndos');
  eq(cards.length, 2);
  eq(cards[0].type, 'expresion');
});

test('parseCapture: acceptance text gives 3 entries, one inbox', () => {
  const { cards, warnings } = parseCapture(ACCEPTANCE_TEXT, { type: 'locucion' });
  eq(warnings.length, 0);
  eq(cards.length, 3);
  eq(cards[0].front, 'hacer hincapié en');
  deepEq(cards[0].tags, ['tema:politica_sociedad', 'prueba:1']);
  eq(cards[1].front, 'a raíz de');
  eq(cards[1].example, '[[A raíz de]] la crisis, muchas empresas cerraron.');
  eq(cards[2].front, 'dar en el clavo');
  eq(cards.filter((c) => c.back === '').length, 1);
});

// ------------------------------------------------------------ newCard (pure)

const CARD_KEYS = [
  'id',
  'type',
  'front',
  'back',
  'ko',
  'example',
  'exampleSource',
  'exampleVerified',
  'register',
  'region',
  'tags',
  'colocaciones',
  'equivalentes',
  'contraste',
  'source',
  'notes',
  'direction',
  'status',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'srs',
];

test('newCard: every contract key is present with defaults', () => {
  const c = newCard({ front: '  dar en el clavo ' });
  for (const k of CARD_KEYS) assert(k in c, 'missing key ' + k);
  eq(Object.keys(c).length, CARD_KEYS.length, 'no extra keys');
  eq(c.front, 'dar en el clavo');
  eq(c.type, 'otro');
  eq(c.back, '');
  eq(c.register, '');
  eq(c.direction, 'both');
  eq(c.exampleVerified, false);
  eq(c.deletedAt, null);
  deepEq(c.tags, []);
  deepEq(c.colocaciones, []);
  deepEq(c.equivalentes, []);
  eq(c.createdAt, c.updatedAt);
  deepEq(c.srs, initialSrs());
  assert(typeof c.id === 'string' && c.id.length > 10, 'id assigned');
});

test('newCard: status is inbox iff back is empty', () => {
  eq(newCard({ front: 'a' }).status, 'inbox');
  eq(newCard({ front: 'a', back: '   ' }).status, 'inbox');
  eq(newCard({ front: 'a', back: 'def' }).status, 'active');
  eq(newCard({ front: 'a', back: 'def', status: 'suspended' }).status, 'suspended');
  eq(newCard({ front: 'a', back: 'def', status: 'inbox' }).status, 'active');
});

test('newCard: tags normalised (string or array), invalid enums fall back', () => {
  deepEq(newCard({ front: 'a', tags: ['#Tema:X', 'tema:x', ' y '] }).tags, ['tema:x', 'y']);
  deepEq(newCard({ front: 'a', tags: 'uno, dos tres' }).tags, ['uno', 'dos', 'tres']);
  eq(newCard({ front: 'a', type: 'nope' }).type, 'otro');
  eq(newCard({ front: 'a', register: 'nope' }).register, '');
  eq(newCard({ front: 'a', direction: 'nope' }).direction, 'both');
});

test('newCard: a partial srs is completed over the defaults', () => {
  const c = newCard({ front: 'a', srs: { rec: {}, prod: { state: 'review', reps: 3 } } });
  const keys = Object.keys(initialState());
  for (const k of keys) {
    assert(k in c.srs.rec, 'rec has ' + k);
    assert(k in c.srs.prod, 'prod has ' + k);
  }
  eq(c.srs.rec.ease, 2.5);
  eq(c.srs.prod.state, 'review');
  eq(c.srs.prod.reps, 3);
  eq(c.srs.prod.ease, 2.5);
  deepEq(newCard({ front: 'a', srs: { rec: {} } }).srs, initialSrs(), 'missing prod falls back');
  deepEq(newCard({ front: 'a', srs: 'junk' }).srs, initialSrs(), 'non-object falls back');
});

test('newCard: empty front throws', async () => {
  await throws(() => newCard({ front: '   ' }));
  await throws(() => newCard({}));
});

test('dupKey is accent- and case-insensitive and includes the type', () => {
  eq(dupKey('Hacer HINCAPIÉ en', 'locucion'), dupKey('hacer hincapie en', 'locucion'));
  assert(dupKey('x', 'locucion') !== dupKey('x', 'lexico'));
});

// ------------------------------------------------------------ db.js (separate database)

const tdb = createDb('c2vocab_test');

async function resetTestDb() {
  await tdb.dexie.transaction('rw', tdb.dexie.cards, tdb.dexie.reviews, tdb.dexie.meta, tdb.dexie.backups, async () => {
    await tdb.dexie.cards.clear();
    await tdb.dexie.reviews.clear();
    await tdb.dexie.meta.clear();
    await tdb.dexie.backups.clear();
  });
}

test('db: uses the test database name', () => {
  eq(tdb.name, 'c2vocab_test');
  eq(tdb.dexie.name, 'c2vocab_test');
});

test('db: initMeta writes defaults once and keeps deviceId on second run', async () => {
  await resetTestDb();
  await tdb.initMeta();
  eq(await tdb.getMeta('schemaVersion'), 1);
  const settings = await tdb.getMeta('settings');
  eq(settings.newPerDay, 15);
  eq(settings.maxReviewsPerDay, 200);
  deepEq(settings.learningSteps, [10, 1440]);
  deepEq(await tdb.getMeta('algo'), { name: 'sm2', version: 1 });
  deepEq(await tdb.getMeta('lastChoice'), { type: 'expresion', register: 'neutro', region: '' });
  const id1 = await tdb.getMeta('deviceId');
  assert(typeof id1 === 'string' && id1.length > 10, 'deviceId');
  assert(typeof (await tdb.getMeta('deviceName')) === 'string', 'deviceName');
  await tdb.initMeta();
  eq(await tdb.getMeta('deviceId'), id1);
});

test('db: initMeta keeps user-modified settings and lastChoice', async () => {
  await resetTestDb();
  await tdb.initMeta();
  const settings = await tdb.getMeta('settings');
  await tdb.setMeta('settings', { ...settings, newPerDay: 99, examDate: '2027-05-01' });
  await tdb.setMeta('lastChoice', { type: 'refran', register: '', region: 'MX' });
  await tdb.initMeta();
  const after = await tdb.getMeta('settings');
  eq(after.newPerDay, 99);
  eq(after.examDate, '2027-05-01');
  eq(after.maxReviewsPerDay, 200, 'untouched fields kept');
  deepEq(await tdb.getMeta('lastChoice'), { type: 'refran', register: '', region: 'MX' });
});

test('db: setMeta / getMeta round trip, missing key is undefined', async () => {
  await tdb.setMeta('lastChoice', { type: 'refran', register: '', region: 'MX' });
  deepEq(await tdb.getMeta('lastChoice'), { type: 'refran', register: '', region: 'MX' });
  eq(await tdb.getMeta('does-not-exist'), undefined);
});

test('db: addCards + listCards (sorted updatedAt desc, live only)', async () => {
  await resetTestDb();
  const a = newCard({ front: 'primera', back: 'a', type: 'lexico', tags: ['t1'] });
  await sleep(5);
  const b = newCard({ front: 'segunda', type: 'lexico', tags: ['t1', 't2'] });
  const n = await tdb.addCards([a, b]);
  eq(n, 2);
  eq(await tdb.addCards([]), 0);
  const list = await tdb.listCards({ deleted: false });
  eq(list.length, 2);
  eq(list[0].front, 'segunda', 'newest first');
  eq(list[1].front, 'primera');
  const stored = list[1];
  for (const k of CARD_KEYS) assert(k in stored, 'stored card has ' + k);
});

test('db: addCards is atomic (duplicate id rolls back the whole batch)', async () => {
  await resetTestDb();
  const a = newCard({ front: 'a', back: 'x' });
  await tdb.addCards([a]);
  const b = newCard({ front: 'b', back: 'y' });
  const dupId = newCard({ front: 'c', back: 'z', id: a.id });
  await throws(() => tdb.addCards([b, dupId]), 'duplicate id must throw');
  eq(await tdb.dexie.cards.count(), 1, 'b must not have been added');
});

test('db: softDelete -> restore round trip', async () => {
  await resetTestDb();
  const c = newCard({ front: 'borrable', back: 'x' });
  await tdb.addCards([c]);
  await sleep(5);
  const deleted = await tdb.softDeleteCard(c.id);
  assert(typeof deleted.deletedAt === 'string', 'deletedAt set');
  assert(deleted.updatedAt > c.updatedAt, 'updatedAt bumped on delete');
  eq((await tdb.listCards({ deleted: false })).length, 0, 'not in live list');
  const trash = await tdb.listCards({ deleted: true });
  eq(trash.length, 1);
  eq(trash[0].id, c.id);
  eq(await tdb.dexie.cards.count(), 1, 'row still exists (never hard deleted)');

  await sleep(5);
  const restored = await tdb.restoreCard(c.id);
  eq(restored.deletedAt, null);
  assert(restored.updatedAt > deleted.updatedAt, 'updatedAt advanced on restore');
  eq(restored.createdAt, c.createdAt, 'createdAt unchanged');
  eq((await tdb.listCards({ deleted: false })).length, 1);
  eq((await tdb.listCards({ deleted: true })).length, 0);
  eq(await tdb.softDeleteCard('missing-id'), null);
  eq(await tdb.restoreCard('missing-id'), null);
});

test('db: updateCard bumps updatedAt, keeps createdAt, activates inbox card when back is set', async () => {
  await resetTestDb();
  const c = newCard({ front: 'en bandeja' });
  eq(c.status, 'inbox');
  await tdb.addCards([c]);
  await sleep(5);
  const u = await tdb.updateCard(c.id, { back: 'ahora con definición', tags: 'A, b', createdAt: '1999-01-01T00:00:00.000Z' });
  eq(u.status, 'active');
  eq(u.back, 'ahora con definición');
  deepEq(u.tags, ['a', 'b']);
  eq(u.createdAt, c.createdAt, 'createdAt cannot be patched');
  assert(u.updatedAt > c.updatedAt, 'updatedAt advanced');
  const again = await tdb.getCard(c.id);
  eq(again.status, 'active');
  eq(await tdb.updateCard('missing-id', { back: 'x' }), null);
});

test('db: updateCard with only a ko patch keeps inbox status', async () => {
  await resetTestDb();
  const c = newCard({ front: 'solo ko' });
  await tdb.addCards([c]);
  const u = await tdb.updateCard(c.id, { ko: '뜻' });
  eq(u.status, 'inbox');
  eq(u.ko, '뜻');
});

test('db: updateCard drops any card to inbox when its back is emptied', async () => {
  await resetTestDb();
  const s = newCard({ front: 'suspendida', back: 'x', status: 'suspended' });
  const a = newCard({ front: 'activa', back: 'y' });
  await tdb.addCards([s, a]);
  eq((await tdb.updateCard(s.id, { back: '' })).status, 'inbox', 'suspended -> inbox');
  eq((await tdb.updateCard(a.id, { back: '   ' })).status, 'inbox', 'active -> inbox');
});

test('db: updateCard coerces enums, ignores deletedAt and undefined values', async () => {
  await resetTestDb();
  const c = newCard({ front: 'coerce', back: 'x', type: 'locucion', tags: ['t1'], register: 'culto' });
  await tdb.addCards([c]);
  const u = await tdb.updateCard(c.id, {
    type: 'Locución',
    register: 'nope',
    direction: 'nope',
    status: 'nope',
    deletedAt: 'x',
    tags: undefined,
    srs: { rec: { reps: 2 } },
  });
  eq(u.type, 'otro');
  eq(u.register, '');
  eq(u.direction, 'both');
  eq(u.status, 'active');
  eq(u.deletedAt, null, 'deletedAt cannot be patched');
  deepEq(u.tags, ['t1'], 'undefined means not patched');
  eq(u.srs.rec.reps, 2);
  eq(u.srs.rec.ease, 2.5, 'partial srs completed');
  eq(u.srs.prod.state, 'new');
  eq((await tdb.listCards({ deleted: false })).length, 1, 'still a live card');
});

test('db: findDuplicate is accent-insensitive, type-aware and ignores deleted cards', async () => {
  await resetTestDb();
  const c = newCard({ front: 'hacer hincapié en', back: 'x', type: 'locucion' });
  await tdb.addCards([c]);
  const hit = await tdb.findDuplicate('HACER hincapie en', 'locucion');
  assert(hit && hit.id === c.id, 'found by normalized front');
  eq(await tdb.findDuplicate('hacer hincapie en', 'lexico'), null, 'different type');
  eq(await tdb.findDuplicate('otra cosa', 'locucion'), null);
  await tdb.softDeleteCard(c.id);
  eq(await tdb.findDuplicate('hacer hincapie en', 'locucion'), null, 'deleted cards are ignored');
  const keys = await tdb.existingKeys();
  eq(keys.size, 0);
});

test('db: allTags counts tags across live cards only', async () => {
  await resetTestDb();
  const a = newCard({ front: 'a', tags: ['x', 'y'] });
  const b = newCard({ front: 'b', tags: ['x'] });
  const c = newCard({ front: 'c', tags: ['z'] });
  await tdb.addCards([a, b, c]);
  await tdb.softDeleteCard(c.id);
  deepEq(await tdb.allTags(), [
    { tag: 'x', count: 2 },
    { tag: 'y', count: 1 },
  ]);
});

test('db: reviews / backups tables exist and accept rows', async () => {
  await resetTestDb();
  await tdb.dexie.reviews.add({ id: uuid(), cardId: 'c1', ts: nowIso(), direction: 'rec', grade: 3 });
  eq(await tdb.dexie.reviews.count(), 1);
  const bid = await tdb.dexie.backups.add({ createdAt: nowIso(), payload: '{}' });
  assert(typeof bid === 'number', 'auto-increment id');
  await resetTestDb();
});

// ------------------------------------------------------------ db.js: reviews (step 2)

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

test('db: getSettings merges stored settings over the defaults', async () => {
  await resetTestDb();
  const defaults = await tdb.getSettings();
  eq(defaults.newPerDay, 15, 'works before initMeta');
  eq(defaults.dayBoundaryHour, 4);
  deepEq(defaults.learningSteps, [10, 1440]);
  await tdb.setMeta('settings', { newPerDay: 5 });
  const merged = await tdb.getSettings();
  eq(merged.newPerDay, 5);
  eq(merged.maxReviewsPerDay, 200);
  eq(merged.sessionMinutes, 15);
  await resetTestDb();
});

test('db: applyReview stores the review and the new srs state, without touching updatedAt', async () => {
  await resetTestDb();
  const c = newCard({ front: 'repasable', back: 'x' });
  await tdb.addCards([c]);
  await sleep(5);
  const ts = '2026-10-02T12:00:00.000Z';
  const state1 = next(initialState(), 3, ts, { fuzz: false }, c.id);
  const review = reviewRow(c.id, ts, 3, 'new');
  await tdb.applyReview(review, state1);

  const stored = await tdb.getCard(c.id);
  deepEq(stored.srs.rec, state1);
  deepEq(stored.srs.prod, initialState(), 'the other direction is untouched');
  eq(stored.updatedAt, c.updatedAt, 'a rating never bumps updatedAt');
  eq(stored.createdAt, c.createdAt);
  eq(stored.front, 'repasable');
  const rows = await tdb.listReviews();
  eq(rows.length, 1);
  deepEq(rows[0], review);
});

test('db: applyReview is atomic (failed review insert or missing card writes nothing)', async () => {
  await resetTestDb();
  const c = newCard({ front: 'atómica', back: 'x' });
  await tdb.addCards([c]);
  const ts = '2026-10-02T12:00:00.000Z';
  const state1 = next(initialState(), 3, ts, { fuzz: false }, c.id);
  const review = reviewRow(c.id, ts, 3, 'new');
  await tdb.applyReview(review, state1);

  // Same review id again: reviews.add fails, so the card must keep state1.
  const state2 = next(state1, 1, '2026-10-03T12:00:00.000Z', { fuzz: false }, c.id);
  await throws(() => tdb.applyReview({ ...review, rating: 1 }, state2), 'duplicate review id must throw');
  deepEq((await tdb.getCard(c.id)).srs.rec, state1, 'card state rolled back');
  eq((await tdb.listReviews()).length, 1);

  // Unknown card: the review row must not be written.
  await throws(() => tdb.applyReview(reviewRow('missing-card', ts, 3, 'new'), state1), 'missing card must throw');
  eq((await tdb.listReviews()).length, 1);
  await throws(() => tdb.applyReview({ ...reviewRow(c.id, ts, 3, 'new'), dir: 'nope' }, state1), 'invalid direction');
  eq((await tdb.listReviews()).length, 1);
});

test('db: undoReview marks undoneAt, restores the srs state, keeps the row and updatedAt', async () => {
  await resetTestDb();
  const c = newCard({ front: 'deshacer', back: 'x' });
  await tdb.addCards([c]);
  const ts = '2026-10-02T12:00:00.000Z';
  const prev = initialState();
  const state1 = next(prev, 1, ts, { fuzz: false }, c.id);
  const review = reviewRow(c.id, ts, 1, 'new');
  await tdb.applyReview(review, state1);
  await sleep(5);

  const undoneAt = await tdb.undoReview(review.id, c.id, 'rec', prev);
  assert(typeof undoneAt === 'string' && !Number.isNaN(Date.parse(undoneAt)), 'returns the undoneAt timestamp');
  const rows = await tdb.listReviews();
  eq(rows.length, 1, 'the review row is never deleted');
  eq(rows[0].undoneAt, undoneAt);
  eq(rows[0].rating, 1, 'the rest of the row is unchanged');
  const stored = await tdb.getCard(c.id);
  deepEq(stored.srs.rec, initialState(), 'srs equals the state before the rating');
  eq(stored.updatedAt, c.updatedAt, 'undo never bumps updatedAt');

  await throws(() => tdb.undoReview('missing-review', c.id, 'rec', prev), 'unknown review must throw');
  await throws(() => tdb.undoReview(review.id, c.id, 'rec', prev), 'a review cannot be undone twice');
  eq((await tdb.listReviews())[0].undoneAt, undoneAt, 'the first undo timestamp is kept');
  await resetTestDb();
});

test('db: applyReview / undoReview refuse a stale session (card already rated elsewhere)', async () => {
  await resetTestDb();
  const c = newCard({ front: 'dos pestañas', back: 'x' });
  await tdb.addCards([c]);
  const prev = initialState();
  const tsA = '2026-10-02T12:00:00.000Z';
  const tsB = '2026-10-02T12:00:30.000Z';

  // Tab A rates the new card 'Bien'.
  const stateA = next(prev, 3, tsA, { fuzz: false }, c.id);
  const reviewA = reviewRow(c.id, tsA, 3, 'new');
  await tdb.applyReview(reviewA, stateA, prev);
  deepEq((await tdb.getCard(c.id)).srs.rec, stateA);

  // Tab B still thinks the card is new: its rating must be refused and write nothing.
  const stateB = next(prev, 1, tsB, { fuzz: false }, c.id);
  await throws(() => tdb.applyReview(reviewRow(c.id, tsB, 1, 'new'), stateB, prev), 'stale rating must throw');
  eq((await tdb.listReviews()).length, 1, 'no second review row');
  deepEq((await tdb.getCard(c.id)).srs.rec, stateA, 'stored state unchanged');

  // A rating computed from the current state is accepted.
  const stateC = next(stateA, 3, tsB, { fuzz: false }, c.id);
  const reviewC = reviewRow(c.id, tsB, 3, 'learning');
  await tdb.applyReview(reviewC, stateC, stateA);
  eq((await tdb.listReviews()).length, 2);

  // Undo of the older rating is refused (it is no longer the latest one) ...
  await throws(() => tdb.undoReview(reviewA.id, c.id, 'rec', prev), 'only the latest rating can be undone');
  // ... and so is an undo with the wrong card or direction.
  await throws(() => tdb.undoReview(reviewC.id, 'other-card', 'rec', stateA), 'wrong card');
  await throws(() => tdb.undoReview(reviewC.id, c.id, 'prod', stateA), 'wrong direction');
  const rows = await tdb.listReviews();
  eq(rows.filter((r) => r.undoneAt).length, 0, 'nothing was marked as undone');
  deepEq((await tdb.getCard(c.id)).srs.rec, stateC);

  // The latest rating can be undone; the stored state equals the replay of the log again.
  await tdb.undoReview(reviewC.id, c.id, 'rec', stateA);
  deepEq((await tdb.getCard(c.id)).srs.rec, stateA);
  await resetTestDb();
});

// ------------------------------------------------------------ runner

run();
