// Tests for js/importer.js (pure): format detection, row normalisation,
// classification against existing cards, and the two duplicate patches.

import { test, assert, eq, deepEq } from './harness.js';
import { newCard, dupKey } from '../db.js';
import { parseImport, classifyRows, enrichPatch, overwritePatch, matchType, inboxKey, MISSING_FRONT_ERROR } from '../importer.js';

const CLAUDE_CARDS = [
  {
    front: 'poner coto a',
    back: 'Impedir que algo perjudicial siga extendiéndose; fijarle un límite.',
    ko: '~을 막다, 제동을 걸다',
    example: 'El Gobierno aprobó un decreto para [[poner coto a]] la especulación inmobiliaria que expulsa a los vecinos de los barrios céntricos.',
    exampleSource: 'redactado',
    type: 'locucion',
    register: 'culto',
    region: 'general',
    colocaciones: [],
    equivalentes: [{ texto: 'frenar', registro: 'neutro' }],
    contraste: '',
    tags: ['tema:economia_trabajo', 'prueba:1'],
    notes: '',
  },
  {
    front: 'acarrear consecuencias',
    back: 'Traer consigo efectos, generalmente negativos.',
    ko: '결과를 초래하다',
    example: 'Una decisión tan precipitada podría [[acarrear consecuencias]] difíciles de revertir para toda la plantilla de la empresa.',
    exampleSource: 'redactado',
    type: 'colocacion',
    register: 'culto',
    region: 'general',
    colocaciones: ['acarrear problemas', 'acarrear gastos'],
    tags: ['tema:economia_trabajo', 'prueba:3'],
  },
  {
    front: 'a todas luces',
    back: 'De manera evidente, sin lugar a dudas.',
    ko: '명백히',
    example: 'La medida resulta [[a todas luces]] insuficiente para contener una inflación que no ha dejado de crecer desde el verano.',
    exampleSource: 'redactado',
    type: 'locucion',
    register: 'culto',
    region: 'general',
    tags: ['tema:economia_trabajo', 'prueba:1'],
  },
];

function fronts(result) {
  return result.rows.map((r) => (r.card ? r.card.front : null));
}

// ------------------------------------------------------------ detection

test('importer: empty text', () => {
  for (const text of ['', '   \n \t\n', null, undefined, '```\n```']) {
    const r = parseImport(text);
    eq(r.kind, 'empty');
    deepEq(r.rows, []);
  }
});

test('importer: fenced JSON array (a typical Claude answer)', () => {
  const text = 'Aquí tienes las tarjetas:\n\n```json\n' + JSON.stringify(CLAUDE_CARDS, null, 2) + '\n```\n\n¡Mucho ánimo con el DELE!';
  const r = parseImport(text);
  eq(r.kind, 'cards');
  eq(r.format, 'json');
  deepEq(fronts(r), ['poner coto a', 'acarrear consecuencias', 'a todas luces']);
  eq(r.rows[0].index, 0);
  eq(r.rows[2].index, 2);
  eq(r.rows[0].card.type, 'locucion');
  eq(r.rows[0].card.exampleSource, 'redactado');
  deepEq(r.rows[0].card.equivalentes, [{ texto: 'frenar', registro: 'neutro' }]);
  deepEq(r.rows[1].card.colocaciones, ['acarrear problemas', 'acarrear gastos']);
  deepEq(r.rows[0].warnings, []);
  assert(!r.rows[0].error, 'no error');
});

test('importer: bare JSON array, {cards: [...]} and a single object', () => {
  const bare = parseImport(JSON.stringify(CLAUDE_CARDS));
  eq(bare.kind, 'cards');
  eq(bare.format, 'json');
  eq(bare.rows.length, 3);

  const wrapped = parseImport(JSON.stringify({ cards: CLAUDE_CARDS.slice(0, 2), nota: 'x' }));
  eq(wrapped.kind, 'cards');
  eq(wrapped.format, 'json');
  eq(wrapped.rows.length, 2);

  const single = parseImport('{"front": "a la postre", "back": "al final"}');
  eq(single.kind, 'cards');
  deepEq(fronts(single), ['a la postre']);

  const emptyArray = parseImport('[]');
  eq(emptyArray.kind, 'cards');
  eq(emptyArray.rows.length, 0);
});

test('importer: JSON array wrapped in prose, and unreadable JSON', () => {
  const text = 'Claro, aquí va la lista:\n\n' + JSON.stringify(CLAUDE_CARDS) + '\n\nEspero que te sirva.';
  const r = parseImport(text);
  eq(r.kind, 'cards');
  eq(r.format, 'json');
  eq(r.rows.length, 3);

  // starts as JSON with junk after it: the array is still found
  const tail = parseImport(JSON.stringify(CLAUDE_CARDS.slice(0, 1)) + '\nFin de la lista.');
  eq(tail.format, 'json');
  eq(tail.rows.length, 1);

  const broken = parseImport('[{"front": "a", "back": "b",}');
  eq(broken.kind, 'cards');
  eq(broken.format, 'json');
  eq(broken.rows.length, 0);
  assert(typeof broken.error === 'string' && broken.error.length > 0, 'explains that the JSON cannot be read');
});

test('importer: a c2vocab envelope is recognised (and not turned into rows)', () => {
  const envelope = { app: 'c2vocab', schemaVersion: 1, exportedAt: '2026-10-03T09:00:00.000Z', deviceId: 'd', deviceName: 'PC', cards: [newCard({ front: 'x', back: 'y' })], reviews: [], settings: {} };
  const r = parseImport(JSON.stringify(envelope, null, 2));
  eq(r.kind, 'envelope');
  eq(r.format, 'envelope');
  deepEq(r.rows, []);
  eq(r.envelope.app, 'c2vocab');
  eq(r.envelope.cards.length, 1);
  eq(r.envelope.deviceName, 'PC');
  // a newer schemaVersion is still an envelope here; validateEnvelope rejects it later
  eq(parseImport(JSON.stringify({ ...envelope, schemaVersion: 99 })).kind, 'envelope');
  // a damaged export file (no cards list) is still an envelope, so validateEnvelope can explain it
  const broken = parseImport('{"app":"c2vocab","schemaVersion":1,"reviews":[]}');
  eq(broken.kind, 'envelope');
  deepEq(broken.rows, []);
  eq(parseImport('{"app":"c2vocab","schemaVersion":1,"cards":{},"reviews":[]}').kind, 'envelope');
});

test('importer: valid JSON is read whole even when one of its strings contains a Markdown fence', () => {
  const noted = newCard({ front: 'x', back: 'y', notes: 'usa ```code``` aquí\n```js\nlet a = 1;\n```' });
  const envelope = { app: 'c2vocab', schemaVersion: 1, exportedAt: '2026-10-03T09:00:00.000Z', deviceId: 'd', deviceName: 'PC', cards: [noted], reviews: [], settings: {} };
  const r = parseImport(JSON.stringify(envelope, null, 2)); // pretty-printed, as exportFile writes it
  eq(r.kind, 'envelope');
  eq(r.envelope.cards.length, 1);
  eq(r.envelope.cards[0].notes, noted.notes);

  const list = parseImport(JSON.stringify([{ front: 'a', back: 'b', notes: 'mira:\n```\ntexto\n```' }, { front: 'c' }], null, 2));
  eq(list.kind, 'cards');
  eq(list.format, 'json');
  deepEq(fronts(list), ['a', 'c']);
  eq(list.rows[0].card.notes, 'mira:\n```\ntexto\n```');
});

test('importer: TSV with a header row (Spanish aliases, any column order)', () => {
  const text = ['lema\tdefinición\tejemplo\ttipo\tetiquetas\tcoreano\tregistro', 'a raíz de\tcomo consecuencia de\t[[A raíz de]] la crisis, cerraron.\tlocución\ttema:economia_trabajo, prueba:1\t~로 인해\tCulto', 'dar en el clavo\tacertar\t\t\t\t\t'].join('\n');
  const r = parseImport(text);
  eq(r.kind, 'cards');
  eq(r.format, 'tsv');
  eq(r.rows.length, 2, 'the header is not a row');
  const c = r.rows[0].card;
  eq(c.front, 'a raíz de');
  eq(c.back, 'como consecuencia de');
  eq(c.example, '[[A raíz de]] la crisis, cerraron.');
  eq(c.type, 'locucion');
  deepEq(c.tags, ['tema:economia_trabajo', 'prueba:1']);
  eq(c.ko, '~로 인해');
  eq(c.register, 'culto');
  eq(r.rows[1].card.front, 'dar en el clavo');
  eq(r.rows[1].card.back, 'acertar');
  assert(!('type' in r.rows[1].card), 'an empty cell is not a value');
});

test('importer: TSV without a header is positional (front, back, example, type, tags)', () => {
  const text = 'a raíz de\tcomo consecuencia de\t[[A raíz de]] la crisis, cerraron.\tlocucion\ttema:x prueba:1\r\nhacer hincapié en\tsubrayar\r\n\tsin expresión';
  const r = parseImport(text);
  eq(r.format, 'tsv');
  eq(r.rows.length, 3);
  eq(r.rows[0].card.front, 'a raíz de');
  eq(r.rows[0].card.type, 'locucion');
  deepEq(r.rows[0].card.tags, ['tema:x', 'prueba:1']);
  eq(r.rows[1].card.front, 'hacer hincapié en');
  eq(r.rows[1].card.back, 'subrayar');
  eq(r.rows[2].card, null);
  eq(r.rows[2].error, MISSING_FRONT_ERROR);
});

test('importer: pipe lines front | back | example | tags', () => {
  const text = ['a raíz de | como consecuencia de | [[A raíz de]] la crisis, cerraron. | tema:x, prueba:1', 'dar en el clavo | acertar', '', 'sin ton ni son'].join('\n');
  const r = parseImport(text);
  eq(r.kind, 'cards');
  eq(r.format, 'pipe');
  eq(r.rows.length, 3);
  eq(r.rows[0].card.front, 'a raíz de');
  eq(r.rows[0].card.back, 'como consecuencia de');
  eq(r.rows[0].card.example, '[[A raíz de]] la crisis, cerraron.');
  deepEq(r.rows[0].card.tags, ['tema:x', 'prueba:1']);
  eq(r.rows[1].card.back, 'acertar');
  eq(r.rows[2].card.front, 'sin ton ni son');
  assert(!('type' in r.rows[0].card), 'pipe lines carry no type: the default applies later');
});

test('importer: pipe lines keep an empty middle cell (tags do not slide into example)', () => {
  const r = parseImport(['por ende | por lo tanto | | prueba:2', 'sin ambages | sin rodeos ||prueba:1', 'a secas | sin añadir nada | Lo llamó jefe [[a secas]]. | tema:x'].join('\n'));
  eq(r.format, 'pipe');
  eq(r.rows.length, 3);
  eq(r.rows[0].card.back, 'por lo tanto');
  assert(!r.rows[0].card.example, 'empty example cell stays empty');
  deepEq(r.rows[0].card.tags, ['prueba:2']);
  eq(r.rows[1].card.back, 'sin rodeos');
  assert(!r.rows[1].card.example, 'empty example cell without spaces stays empty');
  deepEq(r.rows[1].card.tags, ['prueba:1']);
  eq(r.rows[2].card.example, 'Lo llamó jefe [[a secas]].');
});

test('importer: quick-add detail lines with a pipe in them are not pipe rows', () => {
  const r = parseImport('ser | estar\n: contraste clásico | muy útil\n> Ejemplo | otro');
  eq(r.kind, 'cards');
  eq(r.format, 'captura');
  eq(r.rows.length, 1, 'one entry, not three cards');
  for (const row of r.rows) {
    assert(!/^[:>=#@]/.test(row.card.front), 'a detail line never becomes a front');
  }
  // real pipe lines are still pipe lines
  eq(parseImport('ser | estar\nhaber | tener\ncaber | entrar').format, 'pipe');
});

test('importer: anything else falls back to the quick-add mini-language', () => {
  const text = ['hacer hincapié en', ': subrayar la importancia de algo', '= 강조하다', '> El ministro [[hizo hincapié en]] la reforma.', '# tema:politica_sociedad', '', 'a raíz de :: como consecuencia de | [[A raíz de]] la crisis, cerraron.', '', 'dar en el clavo', '', ': huérfana'].join('\n');
  const r = parseImport(text);
  eq(r.kind, 'cards');
  eq(r.format, 'captura');
  deepEq(fronts(r), ['hacer hincapié en', 'a raíz de', 'dar en el clavo']);
  eq(r.rows[0].card.back, 'subrayar la importancia de algo');
  eq(r.rows[0].card.ko, '강조하다');
  deepEq(r.rows[0].card.tags, ['tema:politica_sociedad']);
  eq(r.rows[1].card.back, 'como consecuencia de', 'the :: one-liner is not mistaken for pipe lines');
  eq(r.rows[1].card.example, '[[A raíz de]] la crisis, cerraron.');
  assert(!('back' in r.rows[2].card), 'front-only entry');
  assert(!('type' in r.rows[0].card), 'no type: the import default applies');
  eq(r.warnings.length, 1, 'the entry without a front is reported');
});

// ------------------------------------------------------------ row normalisation

test('importer: Spanish aliases map to the contract keys', () => {
  const r = parseImport(
    JSON.stringify([
      { lema: 'uno', definicion: 'def 1', ejemplo: 'ej 1', tipo: 'refrán', registro: 'coloquial', etiquetas: 'a b', coreano: '하나', fuente: 'clase', notas: 'nota 1' },
      { 'expresión': 'dos', 'definición': 'def 2' },
      { expresion: 'tres', significado: 'def 3', Region: 'MX', Contraste: 'ojo' },
    ])
  );
  deepEq(r.rows[0].card, { front: 'uno', back: 'def 1', ko: '하나', example: 'ej 1', source: 'clase', notes: 'nota 1', type: 'refran', register: 'coloquial', tags: ['a', 'b'] });
  deepEq(r.rows[1].card, { front: 'dos', back: 'def 2' });
  deepEq(r.rows[2].card, { front: 'tres', back: 'def 3', region: 'MX', contraste: 'ojo' });
});

test('importer: type is matched leniently; an unknown type becomes otro with a warning', () => {
  eq(matchType('locución'), 'locucion');
  eq(matchType('Falso amigo'), 'falso_amigo');
  eq(matchType('verbo + prep.'), 'verbo_prep');
  eq(matchType('verbo_prep'), 'verbo_prep');
  eq(matchType('verbo-prep'), 'verbo_prep');
  eq(matchType('LÉXICO'), 'lexico');
  eq(matchType('  expresión '), 'expresion');
  eq(matchType('adjetivo'), null);
  eq(matchType(''), null);

  const r = parseImport(JSON.stringify([{ front: 'a', type: 'Falso Amigo' }, { front: 'b', type: 'adjetivo' }, { front: 'c', type: '' }, { front: 'd', register: 'formal' }]));
  eq(r.rows[0].card.type, 'falso_amigo');
  deepEq(r.rows[0].warnings, []);
  eq(r.rows[1].card.type, 'otro');
  eq(r.rows[1].warnings.length, 1);
  assert(/adjetivo/.test(r.rows[1].warnings[0]), 'the warning names the unknown type');
  assert(!('type' in r.rows[2].card), 'an empty type is no value (and no warning)');
  deepEq(r.rows[2].warnings, []);
  assert(!('register' in r.rows[3].card), 'unknown register dropped');
  eq(r.rows[3].warnings.length, 1);
});

test('importer: tags, colocaciones and equivalentes accept arrays or strings', () => {
  const r = parseImport(
    JSON.stringify([
      { front: 'a', tags: ['#Tema:X', 'tema:x', ' y '], colocaciones: [' una ', '', 'dos'], equivalentes: [{ texto: ' frenar ', registro: 'neutro' }, 'atajar', { texto: '' }, { registro: 'culto' }] },
      { front: 'b', tags: '#uno, dos tres', colocaciones: 'una; dos\ntres ;', equivalentes: 'frenar; atajar' },
    ])
  );
  deepEq(r.rows[0].card.tags, ['tema:x', 'y']);
  deepEq(r.rows[0].card.colocaciones, ['una', 'dos']);
  deepEq(r.rows[0].card.equivalentes, [
    { texto: 'frenar', registro: 'neutro' },
    { texto: 'atajar', registro: '' },
  ]);
  deepEq(r.rows[1].card.tags, ['uno', 'dos', 'tres']);
  deepEq(r.rows[1].card.colocaciones, ['una', 'dos', 'tres']);
  deepEq(r.rows[1].card.equivalentes, [
    { texto: 'frenar', registro: '' },
    { texto: 'atajar', registro: '' },
  ]);
});

test('importer: id, timestamps, srs and status in rows are ignored; rows without a front are invalid', () => {
  const r = parseImport(
    JSON.stringify([
      { id: 'viejo-id', front: 'a', back: 'b', status: 'suspended', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', deletedAt: '2020-01-02T00:00:00.000Z', srs: { rec: { reps: 9 } }, desconocido: 1 },
      { back: 'sin expresión' },
      { front: '   ' },
      'texto suelto',
      null,
    ])
  );
  deepEq(r.rows[0].card, { front: 'a', back: 'b' });
  eq(r.rows[1].card, null);
  eq(r.rows[1].error, 'falta la expresión (front)');
  eq(r.rows[2].card, null);
  eq(r.rows[2].error, 'falta la expresión (front)');
  eq(r.rows[3].card, null);
  assert(r.rows[3].error.length > 0);
  eq(r.rows[4].card, null);
  deepEq(r.rows.map((x) => x.index), [0, 1, 2, 3, 4]);
});

// ------------------------------------------------------------ classifyRows

test('importer: classifyRows gives nueva / duplicada / repetida / invalida and counts', () => {
  const existingCard = newCard({ front: 'Hacer hincapié en', back: 'x', type: 'locucion' });
  const existing = new Map([[dupKey(existingCard.front, existingCard.type), existingCard]]);
  const parsed = parseImport(
    JSON.stringify([
      { front: 'hacer hincapie en', type: 'locucion', back: 'subrayar' }, // duplicate (accents ignored)
      { front: 'a raíz de', type: 'locucion' },
      { front: 'A RAÍZ DE', type: 'locución' }, // repeated inside the batch
      { front: 'hacer hincapié en', type: 'lexico' }, // another type: a new card
      { back: 'nada' },
    ])
  );
  const before = JSON.stringify(parsed.rows);
  const { rows, counts } = classifyRows(parsed.rows, existing, {});
  eq(JSON.stringify(parsed.rows), before, 'the parsed rows are not mutated');
  deepEq(rows.map((r) => r.status), ['duplicada', 'nueva', 'repetida', 'nueva', 'invalida']);
  deepEq(counts, { total: 5, nuevas: 2, duplicadas: 1, repetidas: 1, invalidas: 1 });
  eq(rows[0].existingId, existingCard.id, 'the existing card can be found');
  eq(rows[0].key, dupKey('hacer hincapié en', 'locucion'));
  eq(rows[1].existingId, null);
  eq(rows[4].card, null);
  eq(rows[4].error, 'falta la expresión (front)');

  // a plain Set of keys (db.existingKeys()) works too
  const withSet = classifyRows(parsed.rows, new Set(existing.keys()), {});
  deepEq(withSet.rows.map((r) => r.status), ['duplicada', 'nueva', 'repetida', 'nueva', 'invalida']);
  eq(withSet.rows[0].existingId, null);
  // nothing existing
  deepEq(classifyRows(parsed.rows, new Set(), {}).counts, { total: 5, nuevas: 3, duplicadas: 0, repetidas: 1, invalidas: 1 });
  deepEq(classifyRows([], new Set(), {}).counts, { total: 0, nuevas: 0, duplicadas: 0, repetidas: 0, invalidas: 0 });
});

test('importer: classifyRows defaults apply only where the row has no value; tags are merged', () => {
  const parsed = parseImport(JSON.stringify([{ front: 'a', type: 'refran', register: 'culto', region: 'MX', tags: ['propia'] }, { front: 'b' }]));
  const { rows } = classifyRows(parsed.rows, new Set(), { type: 'locucion', register: 'neutro', region: 'general', tags: ['Claude-Economia', 'propia'] });
  eq(rows[0].card.type, 'refran');
  eq(rows[0].card.register, 'culto');
  eq(rows[0].card.region, 'MX');
  deepEq(rows[0].card.tags, ['propia', 'claude-economia']);
  eq(rows[1].card.type, 'locucion');
  eq(rows[1].card.register, 'neutro');
  eq(rows[1].card.region, 'general');
  deepEq(rows[1].card.tags, ['claude-economia', 'propia']);

  // the default type decides the duplicate key
  const existing = new Set([dupKey('b', 'locucion')]);
  eq(classifyRows(parsed.rows, existing, { type: 'locucion' }).rows[1].status, 'duplicada');
  eq(classifyRows(parsed.rows, existing, { type: 'lexico' }).rows[1].status, 'nueva');
  // without any default the type is 'otro'
  eq(classifyRows(parsed.rows, new Set(), {}).rows[1].card.type, 'otro');
  assert(!('register' in classifyRows(parsed.rows, new Set(), {}).rows[1].card), 'no default, no value');
});

test('importer: a row with the front of an inbox card completes it whatever its type', () => {
  const waiting = newCard({ front: 'poner coto a', type: 'expresion' }); // front only -> inbox
  const existing = new Map([
    [dupKey(waiting.front, waiting.type), waiting],
    [inboxKey(waiting.front), waiting],
  ]);
  const parsed = parseImport(JSON.stringify(CLAUDE_CARDS));
  const { rows, counts } = classifyRows(parsed.rows, existing, {});
  deepEq(rows.map((r) => r.status), ['duplicada', 'nueva', 'nueva']);
  eq(rows[0].existingId, waiting.id);
  eq(counts.duplicadas, 1);
  const patch = enrichPatch(waiting, rows[0].card);
  eq(patch.type, 'locucion', 'the waiting card takes the real type');
  eq(patch.back, CLAUDE_CARDS[0].back);
  assert(!('status' in patch), 'status changes through the updateCard rule only');
  eq(rows[0].typeExplicit, true, 'the row said its type');
});

test('importer: a fallback type (default or otro) never replaces the type of an inbox card', () => {
  const waiting = newCard({ front: 'poner coto a', type: 'locucion' }); // inbox, type chosen by the learner
  const existing = new Map([
    [dupKey(waiting.front, waiting.type), waiting],
    [inboxKey(waiting.front), waiting],
  ]);
  const parsed = parseImport('poner coto a | impedir que algo siga\notra cosa | definición');
  for (const defaults of [{}, { type: 'lexico' }]) {
    const { rows } = classifyRows(parsed.rows, existing, defaults);
    eq(rows[0].status, 'duplicada');
    eq(rows[0].typeExplicit, false, 'the type is only the fallback');
    eq(rows[0].card.type, defaults.type || 'otro');
    deepEq(enrichPatch(waiting, rows[0].card, { typeExplicit: rows[0].typeExplicit }), { back: 'impedir que algo siga' });
    deepEq(overwritePatch(waiting, rows[0].card, { typeExplicit: rows[0].typeExplicit }), { back: 'impedir que algo siga' });
  }
  // an explicit type is still taken (both patches)
  const typed = { front: 'poner coto a', back: 'def', type: 'colocacion' };
  eq(enrichPatch(waiting, typed, { typeExplicit: true }).type, 'colocacion');
  eq(overwritePatch(waiting, typed).type, 'colocacion');
  eq(classifyRows([{ index: 0, card: null, warnings: [] }], new Set(), {}).rows[0].typeExplicit, false);
});

// ------------------------------------------------------------ enrichPatch / overwritePatch

function fullExisting() {
  return newCard({
    front: 'poner coto a',
    back: 'mi definición',
    ko: '',
    example: '',
    type: 'locucion',
    register: '',
    region: 'ES',
    tags: ['mia', 'tema:economia_trabajo'],
    colocaciones: [],
    equivalentes: [{ texto: 'limitar', registro: '' }],
    notes: '',
  });
}

test('importer: enrichPatch fills only the empty fields and unions the tags', () => {
  const existing = fullExisting();
  const before = JSON.stringify(existing);
  const incoming = { ...CLAUDE_CARDS[0], colocaciones: ['poner coto al gasto'], notes: 'nota nueva' };
  const patch = enrichPatch(existing, incoming);
  eq(JSON.stringify(existing), before, 'the existing card is not mutated');
  deepEq(Object.keys(patch).sort(), ['colocaciones', 'example', 'exampleSource', 'ko', 'notes', 'register', 'tags']);
  eq(patch.ko, incoming.ko);
  eq(patch.example, incoming.example);
  eq(patch.exampleSource, 'redactado');
  eq(patch.register, 'culto');
  eq(patch.notes, 'nota nueva');
  deepEq(patch.colocaciones, ['poner coto al gasto']);
  deepEq(patch.tags, ['mia', 'tema:economia_trabajo', 'prueba:1'], 'union, existing order first');
  assert(!('back' in patch), 'a filled field is never replaced');
  assert(!('region' in patch), 'a filled field is never replaced');
  assert(!('equivalentes' in patch), 'a non-empty list is never replaced');
  for (const k of ['id', 'createdAt', 'updatedAt', 'deletedAt', 'srs', 'status', 'direction', 'front', 'type']) {
    assert(!(k in patch), 'never touches ' + k);
  }
});

test('importer: enrichPatch returns null when nothing would change and never labels the learner\'s own example', () => {
  const complete = newCard({ ...CLAUDE_CARDS[0], notes: 'n', contraste: 'c', source: 's', colocaciones: ['x'] });
  eq(enrichPatch(complete, CLAUDE_CARDS[0]), null, 'same card again: nothing to fill');
  eq(enrichPatch(complete, { front: 'poner coto a' }), null);
  eq(enrichPatch(complete, { front: 'poner coto a', tags: ['PRUEBA:1'] }), null, 'tags already there');

  const ownExample = newCard({ front: 'a', back: 'b', example: 'Mi propio ejemplo.' });
  const patch = enrichPatch(ownExample, { front: 'a', example: 'Otro ejemplo.', exampleSource: 'redactado', ko: '뜻' });
  deepEq(patch, { ko: '뜻' }, 'exampleSource belongs to the incoming example, which was not taken');

  // an active card keeps its type even when the incoming one differs
  const typed = newCard({ front: 'a', back: 'b', type: 'lexico' });
  eq(enrichPatch(typed, { front: 'a', type: 'locucion' }), null);
});

test('importer: overwritePatch replaces with the incoming non-empty fields only', () => {
  const existing = fullExisting();
  const incoming = { ...CLAUDE_CARDS[0], front: 'Poner coto a', region: '', notes: '', colocaciones: [] };
  const patch = overwritePatch(existing, incoming);
  eq(patch.front, 'Poner coto a');
  eq(patch.back, incoming.back);
  eq(patch.ko, incoming.ko);
  eq(patch.example, incoming.example);
  eq(patch.register, 'culto');
  deepEq(patch.tags, ['tema:economia_trabajo', 'prueba:1'], 'incoming tags replace the old ones');
  deepEq(patch.equivalentes, [{ texto: 'frenar', registro: 'neutro' }]);
  assert(!('region' in patch), 'an empty incoming field replaces nothing');
  assert(!('notes' in patch));
  assert(!('colocaciones' in patch));
  assert(!('type' in patch), 'same type: not in the patch');
  for (const k of ['id', 'createdAt', 'updatedAt', 'deletedAt', 'srs', 'status', 'direction']) {
    assert(!(k in patch), 'never touches ' + k);
  }

  const same = newCard(CLAUDE_CARDS[0]);
  eq(overwritePatch(same, CLAUDE_CARDS[0]), null, 'identical content: null');
  eq(overwritePatch(same, { front: 'poner coto a' }), null);
  deepEq(overwritePatch(same, { front: 'poner coto a', tags: [] }), null, 'empty incoming tags keep the old ones');
  deepEq(overwritePatch(same, { front: 'poner coto a', back: 'otra' }), { back: 'otra' });
});
