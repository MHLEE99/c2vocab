// Tests for js/seeds.js (pure) and for the seed file itself (fetched from this origin).

import { test, assert, eq, deepEq } from './harness.js';
import { newCard } from '../db.js';
import { TYPE_IDS } from '../taxonomy.js';
import { planSeeds } from '../seeds.js';

const ROWS = [
  {
    type: 'locucion',
    front: 'a la postre',
    back: 'Al final.',
    example: 'Pero [[a la postre]] ganó.',
    exampleKo: '하지만 결국 이겼다.',
    exampleSource: 'redactado',
    tags: ['seed'],
  },
  { type: 'colocacion', front: 'zanjar un debate', back: 'Poner fin.', example: 'Quiso [[zanjar el debate]].', exampleKo: '논쟁을 매듭짓고자 했다.' },
  { front: '   ' },
  { type: 'locucion', front: 'A la postre', back: 'repetida dentro del archivo' },
];

test('seeds: new rows become cards with deterministic ids; blanks and in-file repeats are skipped', () => {
  const plan = planSeeds(ROWS, []);
  deepEq(plan.counts, { added: 2, updated: 0, existing: 1, trashed: 0, invalid: 1 });
  deepEq(plan.toUpdate, []);
  eq(plan.toAdd.length, 2);
  eq(plan.toAdd[0].id, 'seed:a la postre|locucion');
  eq(plan.toAdd[1].id, 'seed:zanjar un debate|colocacion');
  eq(plan.toAdd[0].exampleKo, '하지만 결국 이겼다.');
  eq(plan.toAdd[0].status, 'active');
  deepEq(plan.toAdd[0].tags, ['seed']);
  // The same file on another device gives the same ids: one card after a merge, not two.
  eq(planSeeds(ROWS, []).toAdd[1].id, plan.toAdd[1].id);
  // An empty database and a missing list behave the same.
  eq(planSeeds(ROWS, undefined).counts.added, 2);
});

test('seeds: existing cards are kept; only a missing translation of the SAME example is added', () => {
  const untranslated = newCard({ ...ROWS[0], id: 'seed:a la postre|locucion', exampleKo: '' });
  const ownExample = newCard({ ...ROWS[1], id: 'x1', example: 'Mi propio ejemplo.', exampleKo: '' });
  const plan = planSeeds(ROWS.slice(0, 2), [untranslated, ownExample]);
  deepEq(plan.toAdd, []);
  deepEq(plan.toUpdate, [{ id: 'seed:a la postre|locucion', patch: { exampleKo: '하지만 결국 이겼다.' } }]);
  deepEq(plan.counts, { added: 0, updated: 1, existing: 2, trashed: 0, invalid: 0 });

  // Already translated (even differently): untouched.
  const translated = newCard({ ...ROWS[0], id: 'y', exampleKo: '내 해석' });
  deepEq(planSeeds(ROWS.slice(0, 1), [translated]).toUpdate, []);
  // A card without any example gets no translation either (nothing to translate).
  const noExample = newCard({ ...ROWS[0], id: 'z', example: '', exampleKo: '' });
  deepEq(planSeeds(ROWS.slice(0, 1), [noExample]).toUpdate, []);
  // A learner's card with the same front but another type is a different card: the seed is added.
  const otherType = newCard({ front: 'a la postre', back: 'x', type: 'marcador' });
  eq(planSeeds(ROWS.slice(0, 1), [otherType]).counts.added, 1);
});

test('seeds: a seed the learner deleted stays in the Papelera (not re-added, not updated)', () => {
  const trashed = newCard({ ...ROWS[0], id: 'seed:a la postre|locucion', exampleKo: '' });
  trashed.deletedAt = '2026-11-01T10:00:00.000Z';
  const plan = planSeeds(ROWS.slice(0, 1), [trashed]);
  deepEq(plan.toAdd, []);
  deepEq(plan.toUpdate, []);
  deepEq(plan.counts, { added: 0, updated: 0, existing: 0, trashed: 1, invalid: 0 });
  // A deleted card with another id does not block the seed (the key is free again).
  const other = newCard({ ...ROWS[0], id: 'mine' });
  other.deletedAt = '2026-11-01T10:00:00.000Z';
  eq(planSeeds(ROWS.slice(0, 1), [other]).counts.added, 1);
});

test('seeds: ids, timestamps and srs in the file are ignored; inputs are not mutated', () => {
  const row = { id: 'other', createdAt: 'x', updatedAt: 'y', deletedAt: 'z', srs: { rec: { reps: 9 } }, type: 'lexico', front: 'acuciante', back: 'urgente' };
  const before = JSON.stringify(row);
  const existing = [newCard({ front: 'otra', back: 'b' })];
  const existingBefore = JSON.stringify(existing);
  const plan = planSeeds([row], existing);
  eq(JSON.stringify(row), before);
  eq(JSON.stringify(existing), existingBefore);
  eq(plan.toAdd[0].id, 'seed:acuciante|lexico');
  eq(plan.toAdd[0].srs.rec.reps, 0);
  eq(plan.toAdd[0].deletedAt, null);
  assert(plan.toAdd[0].createdAt !== 'x', 'fresh timestamp');
});

test('seeds: seeds/base.json has 20 complete cards, each example with a [[gap]] and a Korean translation', async () => {
  const res = await fetch(new URL('./seeds/base.json', window.location.href).href, { cache: 'no-store' });
  assert(res.ok, 'HTTP ' + res.status);
  const rows = await res.json();
  assert(Array.isArray(rows), 'an array of cards');
  eq(rows.length, 20);
  for (const row of rows) {
    assert(TYPE_IDS.includes(row.type), 'known type: ' + row.front);
    for (const key of ['front', 'back', 'ko', 'example', 'exampleKo']) {
      assert(typeof row[key] === 'string' && row[key].trim() !== '', key + ' of ' + row.front);
    }
    assert(/\[\[.+?\]\]/.test(row.example), 'gap marker in the example of ' + row.front);
    assert(/[가-힣]/.test(row.exampleKo), 'Korean translation of ' + row.front);
    eq(row.exampleSource, 'redactado', 'exampleSource of ' + row.front);
  }
  const plan = planSeeds(rows, []);
  eq(plan.counts.added, 20, 'no repeated expression inside the file');
  eq(new Set(plan.toAdd.map((c) => c.id)).size, 20, 'distinct deterministic ids');
});
