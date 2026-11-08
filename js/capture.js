// Quick-add mini-language parser. Pure: no DOM, no database, unit-tested in js/tests.js.
//
// Text is split into entries by one or more blank lines. Inside an entry:
//   line 1            -> front   (or "front :: back | example | exampleKo" one-liner)
//   : texto           -> back    (repeats append with a space)
//   = texto           -> ko
//   > texto           -> example (repeats append with a space)
//   >> texto          -> exampleKo (Korean translation of the example; repeats append)
//   # tag1 tag2, tag3 -> tags    (repeats merge)
//   @ texto           -> source
//   anything else     -> appended to back
//
// Returned cards are PARTIAL: db.newCard() fills id, timestamps, srs, status...

const PREFIX_RE = /^([:=>#@])\s*(.*)$/;
// Checked before PREFIX_RE: a line starting with '>>' is the example's Korean translation.
const EXAMPLE_KO_RE = /^>>\s*(.*)$/;
const ONE_LINER_RE = /\s*::\s*/;

/** Split a tag string on whitespace/commas, strip leading '#', lowercase, dedupe. */
export function splitTags(text) {
  return normalizeTagList(String(text || '').split(/[\s,]+/));
}

/** Lowercase, trim, strip leading '#', drop empties, keep first occurrence only. */
export function normalizeTagList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const t = String(raw || '').trim().replace(/^#+/, '').trim().toLowerCase();
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function appendWithSpace(existing, extra) {
  if (!existing) return extra;
  if (!extra) return existing;
  return existing + ' ' + extra;
}

/**
 * Parse quick-add text into partial cards.
 * @param {string} text
 * @param {{type?:string, register?:string, region?:string, tags?:string[]}} defaults values from the chips
 * @returns {{cards: object[], warnings: string[]}}
 */
export function parseCapture(text, defaults = {}) {
  const d = {
    type: defaults.type || 'expresion',
    register: defaults.register || '',
    region: defaults.region || '',
    tags: normalizeTagList(defaults.tags || []),
  };
  const cards = [];
  const warnings = [];

  const source = String(text || '').replace(/\r\n?/g, '\n');
  // A "blank" separator line may contain spaces or tabs.
  const blocks = source.split(/\n[ \t]*\n+/);

  let entryNumber = 0;
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    if (lines.length === 0) continue;
    entryNumber += 1;

    const entry = { front: '', back: '', ko: '', example: '', exampleKo: '', tags: [], source: '' };
    const first = lines[0];
    const rest = lines.slice(1);

    if (/^[:=>#@]/.test(first)) {
      // The block starts with a prefixed line: there is no front to attach it to.
      warnings.push(`Entrada ${entryNumber}: falta la expresión en la primera línea (omitida)`);
      continue;
    }

    if (ONE_LINER_RE.test(first)) {
      // "front :: back | example | exampleKo" (the last two cells are optional)
      const parts = first.split(ONE_LINER_RE);
      entry.front = parts[0].trim();
      const after = parts.slice(1).join(' :: ');
      const cells = after.split('|');
      entry.back = cells[0].trim();
      if (cells.length > 1) entry.example = cells[1].trim();
      if (cells.length > 2) entry.exampleKo = cells.slice(2).join('|').trim();
    } else {
      entry.front = first;
    }

    for (const line of rest) {
      const ko = EXAMPLE_KO_RE.exec(line);
      if (ko) {
        entry.exampleKo = appendWithSpace(entry.exampleKo, ko[1].trim());
        continue;
      }
      const m = PREFIX_RE.exec(line);
      if (!m) {
        entry.back = appendWithSpace(entry.back, line);
        continue;
      }
      const prefix = m[1];
      const value = m[2].trim();
      switch (prefix) {
        case ':':
          entry.back = appendWithSpace(entry.back, value);
          break;
        case '=':
          entry.ko = appendWithSpace(entry.ko, value);
          break;
        case '>':
          entry.example = appendWithSpace(entry.example, value);
          break;
        case '#':
          entry.tags = entry.tags.concat(splitTags(value));
          break;
        case '@':
          entry.source = appendWithSpace(entry.source, value);
          break;
        default:
          entry.back = appendWithSpace(entry.back, line);
      }
    }

    entry.front = entry.front.trim();
    if (entry.front === '') {
      warnings.push(`Entrada ${entryNumber}: expresión vacía (omitida)`);
      continue;
    }

    cards.push({
      front: entry.front,
      back: entry.back,
      ko: entry.ko,
      example: entry.example,
      exampleKo: entry.exampleKo,
      source: entry.source,
      tags: normalizeTagList(d.tags.concat(entry.tags)),
      type: d.type,
      register: d.register,
      region: d.region,
    });
  }

  return { cards, warnings };
}

/** Korean help text shown under the quick-add textarea. */
export const SYNTAX_HELP_KO = [
  '첫 줄: 표현 (예: hacer hincapié en)',
  ': 정의 (스페인어)   = 한국어 뜻   > 예문 ([[빈칸]] 표시 가능)   >> 예문 해석',
  '# 태그 (띄어쓰기/쉼표로 구분)   @ 출처',
  '한 줄로: 표현 :: 정의 | 예문 | 예문 해석',
  '빈 줄로 여러 항목을 구분합니다. 표현만 적으면 Bandeja(대기함)에 저장됩니다.',
].join('\n');

/** Short placeholder for the textarea (Spanish, shows the shape of one entry). */
export const SYNTAX_PLACEHOLDER = [
  'hacer hincapié en',
  ': subrayar la importancia de algo',
  '= 강조하다',
  '> El ministro [[hizo hincapié en]] la reforma.',
  '>> 장관은 개혁을 강조했다.',
  '# tema:politica_sociedad',
  '',
  'a raíz de :: como consecuencia de | [[A raíz de]] la crisis, cerraron.',
].join('\n');
