// The prompt the learner copies into Claude to get new cards (or to complete the
// expressions waiting in the inbox). Pure: text in, text out. docs/PROMPT.md mirrors it.

import { TYPES, TYPE_IDS } from './taxonomy.js';

const DEFAULT_CANTIDAD = 20;

function cleanLine(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/\s+/g, ' ')
    .trim();
}

/** A positive whole number, or the default (20). */
function cleanCantidad(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CANTIDAD;
  return Math.min(n, 200);
}

/** 'economía y trabajo' -> 'economia_y_trabajo' (the form used in 'tema:...' tags). */
function temaSlug(tema) {
  return cleanLine(tema)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^tema:/, '')
    .replace(/[^a-z0-9ñ]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Build the Spanish prompt.
 * @param {{tema?: string, tipo?: string, cantidad?: number, inboxFronts?: string[]}} options
 *   tipo: one of the 11 type ids, or '' / 'cualquiera' for any type.
 *   inboxFronts: expressions already collected (front only) that must be completed too.
 */
export function buildPrompt(options = {}) {
  const o = options || {};
  const tema = cleanLine(o.tema);
  const tipo = TYPE_IDS.includes(o.tipo) ? o.tipo : '';
  const cantidad = cleanCantidad(o.cantidad);
  const inbox = (Array.isArray(o.inboxFronts) ? o.inboxFronts : []).map(cleanLine).filter((f) => f !== '');

  const typeList = TYPES.map((t) => t.id).join(' | ');
  const tipoLine = tipo
    ? 'Tipo: todas las tarjetas deben ser del tipo "' + tipo + '".'
    : 'Tipo: cualquiera; elige para cada tarjeta el tipo que mejor encaje y varía los tipos.';
  const temaLine = tema
    ? 'Tema: ' + tema + '.'
    : 'Tema: libre; reparte las tarjetas entre los ámbitos habituales del DELE C2 (política y sociedad, economía, ciencia, cultura, medios...).';
  const slug = temaSlug(tema);
  const temaTag = slug ? '"tema:' + slug + '"' : '"tema:..." (una palabra o varias unidas con guion bajo, sin tildes)';

  const lines = [
    'Eres un lexicógrafo y profesor de español que prepara a un estudiante coreano para el examen DELE C2.',
    'Nivel: DELE C2. Busca vocabulario culto y preciso, locuciones, colocaciones y marcadores propios de la prensa de calidad, el ensayo y el registro académico; nada que un estudiante de B2 ya domine.',
    '',
    'ENCARGO',
    'Cantidad: ' + cantidad + ' tarjetas nuevas.',
    temaLine,
    tipoLine,
    '',
    'FORMATO DE LA RESPUESTA',
    'Devuelve ÚNICAMENTE un array JSON válido (sin texto antes ni después, sin comentarios). Cada elemento es un objeto con estas claves:',
    '- "front": la expresión en su forma canónica (lema: verbos en infinitivo, sin artículo innecesario).',
    '- "back": definición monolingüe en español, clara y precisa, de 25 palabras como máximo. No repitas la expresión dentro de la definición.',
    '- "ko": equivalente o glosa en coreano, de 6 palabras como máximo.',
    '- "example": una oración natural de 15 a 35 palabras, propia de un texto de nivel C2, con la expresión marcada entre dobles corchetes [[...]] tal como aparece (conjugada o flexionada si hace falta). Para el tipo "verbo_prep" marca solo la preposición.',
    '- "exampleSource": siempre "redactado". No inventes citas ni atribuyas el ejemplo a autores, periódicos u obras.',
    '- "type": uno de estos identificadores exactos: ' + typeList + '.',
    '- "register": culto | neutro | coloquial | vulgar.',
    '- "region": "general", salvo que la expresión sea propia de una zona (ES, MX, AR, CO, RioPlata...).',
    '- "colocaciones": array de 2 a 4 combinaciones frecuentes cuando el tipo es "colocacion" o "lexico"; en los demás tipos, [] o las que sean realmente útiles.',
    '- "equivalentes": opcional; array de objetos {"texto": "...", "registro": "..."} con sinónimos o variantes de otro registro.',
    '- "contraste": obligatorio para "falso_amigo" (con qué se confunde y por qué) y para "variante" (la forma equivalente en otra zona); en los demás tipos, "" o una advertencia de uso.',
    '- "tags": array de etiquetas en minúsculas; incluye siempre ' + temaTag + ' y "prueba:1", "prueba:2" o "prueba:3" según la prueba del DELE C2 en la que resulte más útil.',
    '- "notes": opcional; régimen preposicional, matices, errores típicos de hablantes de coreano.',
    '',
    'REGLAS',
    '- No repitas expresiones ni incluyas dos variantes triviales de la misma.',
    '- Todo el contenido en español, excepto "ko".',
    '- Comillas dobles rectas, sin comas finales: el JSON debe poder leerse con JSON.parse.',
  ];

  if (inbox.length > 0) {
    lines.push('');
    lines.push('SEGUNDA TAREA: COMPLETAR MI BANDEJA');
    lines.push(
      'ADEMÁS de las ' +
        cantidad +
        ' tarjetas nuevas, completa exactamente estas ' +
        inbox.length +
        ' expresiones que ya he recogido (una por línea). Usa cada una como "front" sin cambiarla, rellena todos los campos con el mismo formato y añádelas al mismo array JSON:'
    );
    for (const front of inbox) lines.push(front);
  }

  return lines.join('\n');
}
