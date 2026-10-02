// Bulk import: turn pasted text or a file into card rows. PURE (no database, no DOM).
// The view shows the rows as a preview and commits them through db.importCards
// (see commitCardImport in js/backup.js).
//
// Accepted inputs (detected in this order):
//   1. a c2vocab envelope (export file)           -> kind 'envelope'
//   2. JSON: an array of partial cards, or { cards: [...] } (also inside a ``` fence,
//      or with prose around the array, as chat assistants like to answer)
//   3. TSV (tab-separated; optional header row)
//   4. pipe lines: front | back | example | tags
//   5. the quick-add mini-language (capture.js)

import { normalize } from './util.js';
import { parseCapture, splitTags, normalizeTagList } from './capture.js';
import { TYPES, TYPE_IDS, REGISTER_IDS, DIRECTION_IDS } from './taxonomy.js';
import { dupKey } from './db.js';

export const MISSING_FRONT_ERROR = 'falta la expresión (front)';

/**
 * Extra lookup key for a card that is still in the inbox (front only, no definition yet):
 * it matches an imported row with the same front WHATEVER its type, so that the answer
 * to "complete my inbox" fills the waiting card instead of creating a second one.
 */
export function inboxKey(front) {
  return normalize(front) + '|*';
}

// ------------------------------------------------------------ field names

/** Lookup key of a field name: accents stripped, lowercase, no spaces/underscores/hyphens. */
function fieldKey(name) {
  return normalize(name).replace(/[\s_-]+/g, '');
}

// Canonical content keys a row may carry.
const CANONICAL_FIELDS = [
  'front',
  'back',
  'ko',
  'example',
  'exampleSource',
  'exampleVerified',
  'type',
  'register',
  'region',
  'tags',
  'colocaciones',
  'equivalentes',
  'contraste',
  'source',
  'notes',
  'direction',
];

// Keys that are recognised but always ignored for kind 'cards' (imported cards are fresh).
const IGNORED_FIELDS = ['id', 'createdAt', 'updatedAt', 'deletedAt', 'srs', 'status'];

// Spanish aliases -> canonical key.
const ALIASES = {
  lema: 'front',
  expresion: 'front',
  definicion: 'back',
  significado: 'back',
  ejemplo: 'example',
  tipo: 'type',
  registro: 'register',
  etiquetas: 'tags',
  etiqueta: 'tags',
  coreano: 'ko',
  fuente: 'source',
  notas: 'notes',
  nota: 'notes',
  direccion: 'direction',
};

const FIELD_BY_KEY = new Map();
for (const f of CANONICAL_FIELDS) FIELD_BY_KEY.set(fieldKey(f), f);
for (const f of IGNORED_FIELDS) FIELD_BY_KEY.set(fieldKey(f), null); // known, but dropped
for (const alias of Object.keys(ALIASES)) FIELD_BY_KEY.set(alias, ALIASES[alias]);

/** Canonical key for a field name; null = known but ignored; undefined = unknown. */
function canonicalField(name) {
  return FIELD_BY_KEY.get(fieldKey(name));
}

// ------------------------------------------------------------ value cleaning

function cleanText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return '';
  return String(v).trim();
}

/** 'Locución' -> 'locucion', 'falso amigo' -> 'falso_amigo', 'verbo + prep.' -> 'verbo_prep'. */
function typeSlug(value) {
  return normalize(value)
    .replace(/\./g, '')
    .replace(/[\s+\-_/]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const TYPE_BY_SLUG = new Map();
for (const t of TYPES) {
  TYPE_BY_SLUG.set(typeSlug(t.id), t.id);
  TYPE_BY_SLUG.set(typeSlug(t.label), t.id);
}

/** Lenient type match. Returns a type id, or null when the text is not a known type. */
export function matchType(value) {
  const slug = typeSlug(value);
  if (slug === '') return null;
  return TYPE_BY_SLUG.has(slug) ? TYPE_BY_SLUG.get(slug) : null;
}

function cleanTagsValue(v) {
  if (Array.isArray(v)) return normalizeTagList(v.map((x) => cleanText(x)));
  return splitTags(cleanText(v));
}

function cleanColocaciones(v) {
  const parts = Array.isArray(v) ? v : cleanText(v).split(/[;\n]+/);
  return parts.map((x) => cleanText(x)).filter((x) => x !== '');
}

function cleanEquivalentes(v) {
  const parts = Array.isArray(v) ? v : cleanText(v).split(/[;\n]+/);
  const out = [];
  for (const part of parts) {
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      const texto = cleanText(part.texto);
      if (texto !== '') out.push({ texto, registro: cleanText(part.registro) });
    } else {
      const texto = cleanText(part);
      if (texto !== '') out.push({ texto, registro: '' });
    }
  }
  return out;
}

/**
 * One raw row (object with any of the known keys/aliases) -> { index, card | null, error?, warnings }.
 * `card` is PARTIAL card content: only the keys the row really had.
 */
export function normalizeRow(raw, index) {
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { index, card: null, error: 'la fila no es un objeto con campos', warnings };
  }

  // Collect the values under their canonical key (the first non-empty one wins).
  const found = {};
  for (const key of Object.keys(raw)) {
    const field = canonicalField(key);
    if (!field) continue; // unknown or ignored key
    const value = raw[key];
    if (value === null || value === undefined) continue;
    if (field in found && cleanText(found[field]) !== '') continue;
    found[field] = value;
  }

  const card = {};
  for (const field of ['front', 'back', 'ko', 'example', 'exampleSource', 'region', 'contraste', 'source', 'notes']) {
    if (field in found) card[field] = cleanText(found[field]);
  }

  if ('type' in found) {
    const typed = cleanText(found.type);
    if (typed !== '') {
      const id = matchType(typed);
      if (id) {
        card.type = id;
      } else {
        card.type = 'otro';
        warnings.push('tipo desconocido «' + typed + '»: se usará «otro»');
      }
    }
  }

  if ('register' in found) {
    const reg = normalize(cleanText(found.register));
    if (REGISTER_IDS.includes(reg)) card.register = reg;
    else if (reg !== '') warnings.push('registro desconocido «' + cleanText(found.register) + '»: se deja vacío');
  }

  if ('direction' in found) {
    const dir = normalize(cleanText(found.direction));
    if (DIRECTION_IDS.includes(dir)) card.direction = dir;
  }

  if ('exampleVerified' in found) card.exampleVerified = found.exampleVerified === true;
  if ('tags' in found) card.tags = cleanTagsValue(found.tags);
  if ('colocaciones' in found) card.colocaciones = cleanColocaciones(found.colocaciones);
  if ('equivalentes' in found) card.equivalentes = cleanEquivalentes(found.equivalentes);

  if (!card.front) {
    return { index, card: null, error: MISSING_FRONT_ERROR, warnings };
  }
  return { index, card, warnings };
}

function rowsFromObjects(list) {
  return list.map((raw, i) => normalizeRow(raw, i));
}

// ------------------------------------------------------------ detection helpers

/** Content of the first Markdown code fence, or the text itself when there is none. */
function unfence(text) {
  const open = text.indexOf('```');
  if (open < 0) return text;
  const lineEnd = text.indexOf('\n', open);
  if (lineEnd < 0) return text;
  const close = text.indexOf('```', lineEnd + 1);
  const inner = close < 0 ? text.slice(lineEnd + 1) : text.slice(lineEnd + 1, close);
  return inner.trim();
}

function tryJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, value: undefined };
  }
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** An array with at least one object in it (what a list of cards looks like). */
function looksLikeCardArray(v) {
  return Array.isArray(v) && v.some((x) => isObject(x));
}

/** Interpret a parsed JSON value. Returns a parseImport result, or null when it is not card data. */
function resultFromJson(value) {
  // Anything that says app: 'c2vocab' is an export file. A damaged one (no cards list)
  // is still an envelope, so that validateEnvelope can explain what is wrong with it.
  if (isObject(value) && value.app === 'c2vocab') {
    return { kind: 'envelope', format: 'envelope', envelope: value, rows: [], warnings: [] };
  }
  if (isObject(value) && Array.isArray(value.cards)) {
    return { kind: 'cards', format: 'json', rows: rowsFromObjects(value.cards), warnings: [] };
  }
  if (Array.isArray(value)) {
    return { kind: 'cards', format: 'json', rows: rowsFromObjects(value), warnings: [] };
  }
  if (isObject(value)) {
    // A single card object.
    return { kind: 'cards', format: 'json', rows: rowsFromObjects([value]), warnings: [] };
  }
  return null;
}

function nonEmptyLines(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
}

const TSV_POSITIONS = ['front', 'back', 'example', 'type', 'tags'];

function parseTsv(lines) {
  const table = lines.map((l) => l.split('\t').map((c) => c.trim()));
  const first = table[0];
  const named = first.filter((c) => c !== '');
  const isHeader = named.length > 0 && named.every((c) => canonicalField(c) !== undefined);
  const header = isHeader ? first : TSV_POSITIONS;
  const body = isHeader ? table.slice(1) : table;
  const objects = body.map((cells) => {
    const obj = {};
    cells.forEach((cell, i) => {
      const name = header[i];
      if (name && cell !== '') obj[name] = cell;
    });
    return obj;
  });
  return rowsFromObjects(objects);
}

const PIPE_RE = /\s+\|\s+/; // detection: a pipe with spaces around it
// Splitting is more lenient than detection: 'a | b | | tags' and 'a | b ||tags' must
// keep the empty example cell, otherwise the tags slide into the example column.
const PIPE_CELL_RE = /\s*\|\s*/;
const PIPE_POSITIONS = ['front', 'back', 'example', 'tags'];

const CAPTURE_PREFIX_RE = /^\s*[:=>#@]/; // ': back', '= ko', '> example', '# tags', '@ source'

function isPipeLine(line) {
  if (CAPTURE_PREFIX_RE.test(line)) return false; // a quick-add detail line, even with ' | ' in it
  return PIPE_RE.test(line) && line.indexOf('::') < 0; // 'a :: b | c' is the quick-add one-liner
}

function parsePipes(lines) {
  const objects = lines.map((line) => {
    const cells = line.trim().split(PIPE_CELL_RE);
    const obj = {};
    cells.forEach((cell, i) => {
      const name = PIPE_POSITIONS[i];
      const value = cell.trim();
      if (!name || value === '') return;
      obj[name] = value;
    });
    return obj;
  });
  return rowsFromObjects(objects);
}

function parseCaptura(text) {
  const parsed = parseCapture(text, {});
  const rows = parsed.cards.map((c, i) => {
    // parseCapture fills its own defaults; drop them so the import defaults can apply.
    const card = { front: c.front };
    if (c.back) card.back = c.back;
    if (c.ko) card.ko = c.ko;
    if (c.example) card.example = c.example;
    if (c.source) card.source = c.source;
    if (c.tags && c.tags.length > 0) card.tags = c.tags;
    return { index: i, card, warnings: [] };
  });
  return { rows, warnings: parsed.warnings };
}

// ------------------------------------------------------------ parseImport

/**
 * Detect the format of `text` and return its rows.
 * { kind: 'envelope' | 'cards' | 'empty',
 *   format: 'envelope' | 'json' | 'tsv' | 'pipe' | 'captura',
 *   envelope?,                 (kind 'envelope': the parsed document, validate it with validateEnvelope)
 *   rows: [{ index, card | null, error?, warnings: string[] }],
 *   warnings: string[],        (problems of the whole text, e.g. skipped quick-add entries)
 *   error?: string }           (the text looked like JSON but could not be read)
 */
export function parseImport(text) {
  let source = String(text === null || text === undefined ? '' : text)
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (source === '') return { kind: 'empty', format: 'captura', rows: [], warnings: [] };

  // A text that is valid JSON as a whole (an export file, a bare array) is read as it is:
  // a ``` inside one of its strings (e.g. in a card's notes) is not a Markdown fence.
  if (source[0] === '{' || /^\[\s*[{\]]/.test(source)) {
    const whole = tryJson(source);
    if (whole.ok) {
      const result = resultFromJson(whole.value);
      if (result) return result;
    }
  }

  source = unfence(source);
  if (source === '') return { kind: 'empty', format: 'captura', rows: [], warnings: [] };

  // --- JSON
  const startsLikeJson = source[0] === '{' || /^\[\s*[{\]]/.test(source);
  if (startsLikeJson) {
    const direct = tryJson(source);
    if (direct.ok) {
      const result = resultFromJson(direct.value);
      if (result) return result;
    }
  }
  // An array with prose around it: take from the first '[' to the last ']'.
  const open = source.indexOf('[');
  const close = source.lastIndexOf(']');
  if (open >= 0 && close > open) {
    const inner = tryJson(source.slice(open, close + 1));
    if (inner.ok && looksLikeCardArray(inner.value)) {
      return { kind: 'cards', format: 'json', rows: rowsFromObjects(inner.value), warnings: [] };
    }
  }
  if (startsLikeJson) {
    return {
      kind: 'cards',
      format: 'json',
      rows: [],
      warnings: [],
      error: 'El texto parece JSON pero no se puede leer (¿falta una coma, una comilla o un corchete?).',
    };
  }

  // --- TSV / pipe lines / quick-add
  const lines = nonEmptyLines(source);
  if (lines[0].indexOf('\t') >= 0) {
    return { kind: 'cards', format: 'tsv', rows: parseTsv(lines), warnings: [] };
  }
  const pipeCount = lines.filter(isPipeLine).length;
  if (pipeCount * 2 > lines.length) {
    return { kind: 'cards', format: 'pipe', rows: parsePipes(lines), warnings: [] };
  }
  const captura = parseCaptura(source);
  if (captura.rows.length === 0 && captura.warnings.length === 0) {
    return { kind: 'empty', format: 'captura', rows: [], warnings: [] };
  }
  return { kind: 'cards', format: 'captura', rows: captura.rows, warnings: captura.warnings };
}

// ------------------------------------------------------------ classifyRows

/**
 * Give every row its import status.
 *   'nueva'      a card that does not exist yet
 *   'duplicada'  same front + type as a live card (row.existingId is set when
 *                `existing` is a Map of dupKey -> card or dupKey -> id); also a row with
 *                the same front as an INBOX card when `existing` has its inboxKey()
 *   'repetida'   same front + type as an EARLIER row of this batch
 *   'invalida'   no usable front
 * `existing` is a Set of dupKeys (db.existingKeys()) or a Map dupKey -> card.
 * defaults = { type, register, region, tags }: applied only where the row has no value;
 * default tags are merged into every row.
 * Returns { rows, counts: { total, nuevas, duplicadas, repetidas, invalidas } } — new row
 * objects (the input is not mutated), each with
 * { index, card, status, key, existingId, typeExplicit, error, warnings }.
 * typeExplicit = the row carried its own type (false when card.type is only the default / 'otro').
 */
export function classifyRows(rows, existing, defaults = {}) {
  const d = defaults || {};
  const defaultType = TYPE_IDS.includes(d.type) ? d.type : '';
  const defaultRegister = REGISTER_IDS.includes(d.register) ? d.register : '';
  const defaultRegion = cleanText(d.region);
  const defaultTags = Array.isArray(d.tags) ? normalizeTagList(d.tags) : splitTags(cleanText(d.tags));
  const lookup = existing && typeof existing.has === 'function' ? existing : new Set();

  const counts = { total: 0, nuevas: 0, duplicadas: 0, repetidas: 0, invalidas: 0 };
  const seen = new Set();
  const out = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    counts.total += 1;
    const warnings = Array.isArray(row && row.warnings) ? row.warnings.slice() : [];
    const index = row && typeof row.index === 'number' ? row.index : out.length;
    if (!row || !row.card || !row.card.front) {
      counts.invalidas += 1;
      out.push({
        index,
        card: null,
        status: 'invalida',
        key: '',
        existingId: null,
        typeExplicit: false,
        error: (row && row.error) || MISSING_FRONT_ERROR,
        warnings,
      });
      continue;
    }

    const card = { ...row.card };
    // Did the row itself say its type? (false = the type below is only a fallback, which
    // must never replace the type the learner chose for a card waiting in the inbox)
    const typeExplicit = !!card.type;
    if (!card.type) card.type = defaultType || 'otro';
    if (!card.register && defaultRegister) card.register = defaultRegister;
    if (!card.region && defaultRegion) card.region = defaultRegion;
    if (defaultTags.length > 0 || card.tags) {
      card.tags = normalizeTagList((card.tags || []).concat(defaultTags));
    }

    let key = dupKey(card.front, card.type);
    let status = 'nueva';
    let existingId = null;
    if (!lookup.has(key) && !seen.has(key) && lookup.has(inboxKey(card.front))) {
      key = inboxKey(card.front); // completes a card waiting in the inbox
    }
    if (lookup.has(key)) {
      status = 'duplicada';
      if (typeof lookup.get === 'function') {
        const hit = lookup.get(key);
        existingId = hit && typeof hit === 'object' ? hit.id : hit || null;
      }
    } else if (seen.has(key)) {
      status = 'repetida';
    }
    seen.add(key);

    if (status === 'nueva') counts.nuevas += 1;
    else if (status === 'duplicada') counts.duplicadas += 1;
    else counts.repetidas += 1;

    out.push({ index, card, status, key, existingId, typeExplicit, error: null, warnings });
  }

  return { rows: out, counts };
}

// ------------------------------------------------------------ patches for duplicates

const STRING_FIELDS = ['back', 'ko', 'example', 'exampleSource', 'register', 'region', 'contraste', 'source', 'notes'];
const LIST_FIELDS = ['colocaciones', 'equivalentes'];

function isEmptyText(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

function listOf(v) {
  return Array.isArray(v) ? v : [];
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 'Enriquecer': fill ONLY the content fields that are empty on the existing card
 * ('' strings, empty arrays); tags become the union. Never contains id, timestamps,
 * srs, status, direction or front. Returns the patch, or null when nothing would change.
 * (An inbox card that receives a back becomes active through the normal updateCard rule,
 * and only such a card also takes the incoming type — unless options.typeExplicit is false,
 * i.e. the incoming type is only the import default and not something the row said.)
 */
export function enrichPatch(existingCard, incoming, options) {
  const have = existingCard || {};
  const inc = incoming || {};
  const typeExplicit = !options || options.typeExplicit !== false;
  const patch = {};

  for (const field of STRING_FIELDS) {
    if (field === 'exampleSource') continue; // handled together with the example
    if (isEmptyText(have[field]) && !isEmptyText(inc[field])) patch[field] = String(inc[field]).trim();
  }
  // A front-only inbox card has no real type yet (it got the quick-add default): take the incoming one.
  if (typeExplicit && have.status === 'inbox' && isEmptyText(have.back) && 'back' in patch) {
    if (TYPE_IDS.includes(inc.type) && inc.type !== have.type) patch.type = inc.type;
  }
  // exampleSource describes the example: fill it only when the example comes from the
  // incoming card too (or is the same text), never to label the learner's own example.
  if (isEmptyText(have.exampleSource) && !isEmptyText(inc.exampleSource)) {
    const sameExample = !isEmptyText(have.example) && String(have.example).trim() === String(inc.example || '').trim();
    if ('example' in patch || sameExample) patch.exampleSource = String(inc.exampleSource).trim();
  }

  for (const field of LIST_FIELDS) {
    if (listOf(have[field]).length === 0 && listOf(inc[field]).length > 0) patch[field] = listOf(inc[field]).slice();
  }

  const haveTags = normalizeTagList(listOf(have.tags));
  const union = normalizeTagList(haveTags.concat(listOf(inc.tags)));
  if (union.length > haveTags.length) patch.tags = union;

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * 'Sobrescribir': the incoming NON-EMPTY content fields replace the existing ones
 * (tags = incoming tags when it has any). Never contains id, timestamps, srs, direction
 * or status (status changes only through the updateCard rule: inbox + back -> active).
 * With options.typeExplicit === false the incoming type is only the import default
 * and the existing type is kept. Returns the patch, or null when nothing would change.
 */
export function overwritePatch(existingCard, incoming, options) {
  const have = existingCard || {};
  const inc = incoming || {};
  const typeExplicit = !options || options.typeExplicit !== false;
  const patch = {};

  for (const field of ['front', 'type'].concat(STRING_FIELDS)) {
    if (field === 'type' && !typeExplicit) continue;
    if (isEmptyText(inc[field])) continue;
    const value = String(inc[field]).trim();
    if (value !== have[field]) patch[field] = value;
  }
  for (const field of LIST_FIELDS) {
    const list = listOf(inc[field]);
    if (list.length > 0 && !sameJson(list, listOf(have[field]))) patch[field] = list.slice();
  }
  const tags = normalizeTagList(listOf(inc.tags));
  if (tags.length > 0 && !sameJson(tags, listOf(have.tags))) patch.tags = tags;
  if (typeof inc.exampleVerified === 'boolean' && inc.exampleVerified !== (have.exampleVerified === true)) {
    patch.exampleVerified = inc.exampleVerified;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
