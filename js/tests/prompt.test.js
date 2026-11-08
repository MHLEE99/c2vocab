// Tests for js/prompt.js (pure): the text copied into Claude.

import { test, assert, eq } from './harness.js';
import { TYPE_IDS } from '../taxonomy.js';
import { buildPrompt } from '../prompt.js';
import { parseImport } from '../importer.js';

test('prompt: contains the level, the quantity, the topic and the requested type', () => {
  const p = buildPrompt({ tema: 'economía y trabajo', tipo: 'colocacion', cantidad: 12, inboxFronts: [] });
  assert(p.includes('DELE C2'), 'level');
  assert(p.includes('Cantidad: 12 tarjetas'), 'quantity');
  assert(p.includes('Tema: economía y trabajo.'), 'topic');
  assert(p.includes('del tipo "colocacion"'), 'type');
  assert(p.includes('"tema:economia_y_trabajo"'), 'the topic tag is spelled out');
  assert(/array JSON/.test(p) && /ÚNICAMENTE/.test(p), 'asks for JSON only');
});

test('prompt: lists the 11 type ids, every key of the contract and the fixed rules', () => {
  const p = buildPrompt({ tema: '', tipo: 'cualquiera', cantidad: 20 });
  eq(TYPE_IDS.length, 11);
  for (const id of TYPE_IDS) assert(p.includes(id), 'type id ' + id);
  for (const key of ['front', 'back', 'ko', 'example', 'exampleKo', 'exampleSource', 'type', 'register', 'region', 'colocaciones', 'equivalentes', 'contraste', 'tags', 'notes']) {
    assert(p.includes('"' + key + '"'), 'key ' + key);
  }
  assert(p.includes('[[...]]'), 'gap marker');
  assert(p.includes('"redactado"'), 'exampleSource value');
  assert(p.includes('culto | neutro | coloquial | vulgar'), 'registers');
  assert(p.includes('"prueba:1"') && p.includes('"prueba:3"'), 'prueba tags');
  assert(p.includes('"general"'), 'default region');
  assert(p.includes('Tipo: cualquiera'), 'no fixed type');
  assert(!p.includes('del tipo "'), 'no single type requested');
  assert(p.includes('Tema: libre'), 'no topic given');
});

test('prompt: defaults — 20 cards, unknown type means any type', () => {
  const p = buildPrompt();
  assert(p.includes('Cantidad: 20 tarjetas'));
  assert(buildPrompt({ cantidad: 'muchas' }).includes('Cantidad: 20 tarjetas'));
  assert(buildPrompt({ cantidad: 0 }).includes('Cantidad: 20 tarjetas'));
  assert(buildPrompt({ cantidad: '8' }).includes('Cantidad: 8 tarjetas'));
  assert(buildPrompt({ tipo: 'inventado' }).includes('Tipo: cualquiera'));
});

test('prompt: the inbox list appears only when it is given', () => {
  const without = buildPrompt({ tema: 'salud', cantidad: 5, inboxFronts: [] });
  assert(!without.includes('BANDEJA'), 'no second task');
  assert(!buildPrompt({ inboxFronts: ['  ', ''] }).includes('BANDEJA'), 'blank entries do not count');

  const withInbox = buildPrompt({ tema: 'salud', cantidad: 5, inboxFronts: ['dar en el clavo', '  a regañadientes ', ''] });
  assert(withInbox.includes('BANDEJA'), 'second task present');
  assert(withInbox.includes('exactamente estas 2 expresiones'), 'says how many');
  const lines = withInbox.split('\n');
  assert(lines.includes('dar en el clavo'), 'one expression per line');
  assert(lines.includes('a regañadientes'), 'trimmed');
  eq(lines[lines.length - 1], 'a regañadientes', 'the list closes the prompt');
  assert(withInbox.startsWith(without), 'the rest of the prompt is unchanged');
});

test('prompt: the prompt itself is not mistaken for card data when pasted back', () => {
  // (a learner may paste the wrong clipboard content into Importar)
  const r = parseImport(buildPrompt({ tema: 'salud' }));
  assert(r.format !== 'json' && r.kind !== 'envelope', 'not parsed as JSON');
});
