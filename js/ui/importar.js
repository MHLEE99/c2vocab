// Importar: paste text or pick a file -> automatic preview -> import.
//   - card lists (JSON from Claude, TSV, pipe lines, quick-add text) become NEW cards;
//     duplicates are skipped, enriched or overwritten (the review history is always kept)
//   - a c2vocab export file (envelope) is MERGED with the local data
// Also here: 'Pedir tarjetas a Claude' (copies the prompt built by js/prompt.js).
//
// A 'pre-import' copy is taken automatically before anything is written (js/backup.js).

import { listCards } from '../db.js';
import { parseImport, classifyRows } from '../importer.js';
import { validateEnvelope } from '../merge.js';
import { envelopeCounts } from '../export.js';
import { existingCardMap, planCardImport, commitCardImport, previewImportEnvelope, importEnvelope } from '../backup.js';
import { buildPrompt } from '../prompt.js';
import { TYPES, REGISTERS, typeLabel } from '../taxonomy.js';
import { debounce, fmtDate } from '../util.js';
import { h, clear, badge, toast, openSheet, closeSheet, emitCardsChanged } from './components.js';

const MAX_ROWS_SHOWN = 200; // longer previews are cut (everything is still imported)
const MAX_TEXTAREA_CHARS = 200000; // bigger files are not echoed into the textarea

const FORMAT_LABELS = {
  json: 'JSON',
  tsv: 'tabla con tabuladores (TSV)',
  pipe: 'líneas «expresión | definición | ejemplo | etiquetas»',
  captura: 'captura rápida',
  envelope: 'archivo de exportación',
};

const STATUS_LABELS = { nueva: 'nueva', duplicada: 'duplicada', repetida: 'repetida', invalida: 'inválida' };

const MODES = [
  { id: 'omitir', label: 'Omitir', ko: '이미 있는 카드는 건드리지 않음' },
  { id: 'enriquecer', label: 'Enriquecer', ko: '빈 칸만 채움' },
  { id: 'sobrescribir', label: 'Sobrescribir', ko: '내용만 교체, 복습 기록은 유지' },
];

// The view is rebuilt after every import (cards-changed), so its state lives here.
const state = {
  text: '', // the text being previewed (typed, pasted or read from a file)
  fileName: '',
  type: '', // default type for rows without one
  register: '', // default register for rows without one
  tagsText: '', // tags added to every row
  mode: 'enriquecer',
  result: null, // lines describing the last import
  prompt: { tema: '', tipo: '', cantidad: '20', inbox: true },
};

function errorText(err) {
  return err && err.message ? err.message : String(err);
}

function excerpt(text, max = 90) {
  const t = String(text || '');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export async function render(container) {
  let previewSeq = 0; // goes up with every preview of THIS render; a slow, outdated one is thrown away
  const liveCards = await listCards({ deleted: false });
  const inboxFronts = liveCards.filter((c) => c.status === 'inbox').map((c) => c.front);

  container.appendChild(h('a', { class: 'back-link', href: '#/ajustes' }, '‹ Volver'));

  // ------------------------------------------------------------ result of the last import

  const resultBox = h('div', {});
  container.appendChild(resultBox);

  function drawResult() {
    clear(resultBox);
    if (!state.result) return;
    resultBox.appendChild(
      h(
        'div',
        { class: 'banner banner-ok', role: 'status' },
        h('div', { class: 'banner-title' }, state.result.title),
        state.result.lines.map((line) => h('div', { class: 'small' }, line))
      )
    );
  }
  drawResult();

  // ------------------------------------------------------------ text + file

  container.appendChild(h('h2', { class: 'section-title section-title-first' }, 'Pegar texto o elegir un archivo'));

  const textarea = h('textarea', {
    rows: 7,
    class: 'import-text',
    placeholder: 'Pega aquí la respuesta de Claude, una tabla, o el contenido de un archivo exportado…',
    autocapitalize: 'off',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Texto para importar',
    value: state.text.length <= MAX_TEXTAREA_CHARS ? state.text : '',
  });
  const schedulePreview = debounce(() => updatePreview(), 250);
  textarea.addEventListener('input', () => {
    state.text = textarea.value;
    state.fileName = '';
    state.result = null;
    drawResult();
    drawFileLine();
    markPreviewStale();
    schedulePreview();
  });

  /** Everything the preview depends on, as one string (to notice that it is out of date). */
  function inputKey() {
    return JSON.stringify([state.text, state.type, state.register, state.tagsText, state.mode]);
  }

  /**
   * An input changed: until the new preview is drawn, the buttons of the old one must not
   * import or merge what it showed (the preview is debounced and reads the database).
   */
  function markPreviewStale() {
    for (const button of preview.querySelectorAll('button')) button.disabled = true;
  }

  /** True when the inputs changed since the preview with this key was drawn (it is redrawn). */
  async function previewIsStale(key) {
    if (inputKey() === key) return false;
    toast('La vista previa ha cambiado: revísala y pulsa de nuevo');
    await updatePreview();
    return true;
  }

  const fileLine = h('p', { class: 'muted small' });
  function drawFileLine() {
    fileLine.textContent = state.fileName ? `Archivo: ${state.fileName} (${Math.max(1, Math.round(state.text.length / 1024))} KB)` : '';
    fileLine.hidden = !state.fileName;
  }
  drawFileLine();

  const fileInput = h('input', {
    type: 'file',
    accept: '.json,.txt,.tsv,.csv,application/json,text/plain',
    'aria-label': 'Elegir archivo',
    onchange: async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        state.text = text;
        state.fileName = file.name;
        state.result = null;
        markPreviewStale();
        textarea.value = text.length <= MAX_TEXTAREA_CHARS ? text : '';
        drawResult();
        drawFileLine();
        await updatePreview();
      } catch (err) {
        console.error(err);
        toast('No se pudo leer el archivo: ' + errorText(err));
      } finally {
        fileInput.value = ''; // the same file can be chosen again
      }
    },
  });

  const clearBtn = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: () => {
        resetText();
        state.result = null;
        drawResult();
        updatePreview();
      },
    },
    'Limpiar'
  );

  function resetText() {
    state.text = '';
    state.fileName = '';
    textarea.value = '';
    drawFileLine();
  }

  container.appendChild(textarea);
  container.appendChild(h('div', { class: 'field import-file' }, h('label', {}, 'O elige un archivo (.json, .txt, .tsv, .csv)'), fileInput));
  container.appendChild(fileLine);
  container.appendChild(
    h(
      'p',
      { class: 'hint-ko' },
      "붙여넣으면 형식을 자동으로 알아냅니다: Claude의 JSON 답변(``` 표시나 앞뒤 설명이 있어도 됨), 엑셀에서 복사한 표(탭 구분), '표현 | 정의 | 예문 | 태그' 줄, 빠른 추가 문법, 그리고 'Exportar todo'로 만든 파일.\n아래 미리보기를 확인한 뒤 버튼을 눌러야 실제로 저장됩니다."
    )
  );

  // ------------------------------------------------------------ options for card lists

  const typeSelect = h(
    'select',
    {
      id: 'import-type',
      onchange: () => {
        state.type = typeSelect.value;
        markPreviewStale();
        updatePreview();
      },
    },
    h('option', { value: '', selected: state.type === '' }, '— (otro)'),
    TYPES.map((t) => h('option', { value: t.id, selected: state.type === t.id }, `${t.label} · ${t.ko}`))
  );
  const registerSelect = h(
    'select',
    {
      id: 'import-register',
      onchange: () => {
        state.register = registerSelect.value;
        markPreviewStale();
        updatePreview();
      },
    },
    h('option', { value: '', selected: state.register === '' }, '—'),
    REGISTERS.map((r) => h('option', { value: r.id, selected: state.register === r.id }, `${r.label} · ${r.ko}`))
  );
  const tagsInput = h('input', {
    type: 'text',
    id: 'import-tags',
    value: state.tagsText,
    placeholder: 'claude-economia',
    autocapitalize: 'off',
    autocomplete: 'off',
    oninput: () => {
      state.tagsText = tagsInput.value;
      markPreviewStale();
      schedulePreview();
    },
  });

  const modeBox = h(
    'fieldset',
    { class: 'radio-group' },
    h('legend', {}, 'Si la tarjeta ya existe (duplicadas)'),
    MODES.map((m) =>
      h(
        'label',
        { class: 'check-row' },
        h('input', {
          type: 'radio',
          name: 'import-mode',
          value: m.id,
          checked: state.mode === m.id,
          onchange: () => {
            state.mode = m.id;
            markPreviewStale();
            updatePreview();
          },
        }),
        h('span', {}, m.label, ' ', h('span', { class: 'muted small' }, '· ' + m.ko))
      )
    )
  );

  const options = h(
    'div',
    { class: 'form import-options', hidden: true },
    h(
      'div',
      { class: 'field-row' },
      h('div', { class: 'field' }, h('label', { for: 'import-type' }, 'Tipo por defecto'), typeSelect),
      h('div', { class: 'field' }, h('label', { for: 'import-register' }, 'Registro por defecto'), registerSelect)
    ),
    h('div', { class: 'field' }, h('label', { for: 'import-tags' }, 'Etiquetas para todas'), tagsInput),
    h('p', { class: 'hint-ko' }, 'Tipo/Registro por defecto는 그 값이 비어 있는 줄에만 적용됩니다. Etiquetas는 모든 카드에 추가됩니다.'),
    modeBox
  );
  container.appendChild(options);

  const preview = h('div', { class: 'import-preview' });
  container.appendChild(preview);
  container.appendChild(h('div', { class: 'btn-row' }, clearBtn));

  // ------------------------------------------------------------ preview

  async function updatePreview() {
    previewSeq += 1;
    const seq = previewSeq;
    const key = inputKey(); // the inputs this preview is made from
    const parsed = parseImport(state.text);
    const box = h('div', {});
    let showOptions = false;

    try {
      if (parsed.kind === 'empty') {
        if (state.text.trim() !== '') box.appendChild(h('p', { class: 'warn-text' }, 'No se ha reconocido ninguna tarjeta en el texto.'));
      } else if (parsed.kind === 'envelope') {
        await drawEnvelopePreview(box, parsed.envelope, key);
      } else {
        showOptions = !parsed.error;
        await drawCardsPreview(box, parsed, key);
      }
    } catch (err) {
      console.error(err);
      box.appendChild(h('p', { class: 'error' }, 'Error al preparar la vista previa: ' + errorText(err)));
    }

    if (seq !== previewSeq) return; // a newer preview took over
    options.hidden = !showOptions;
    clear(preview);
    preview.appendChild(box);
  }

  // ---- card lists

  async function drawCardsPreview(box, parsed, key) {
    if (parsed.error) {
      box.appendChild(h('p', { class: 'error' }, parsed.error));
      return;
    }
    const existing = await existingCardMap();
    const cls = classifyRows(parsed.rows, existing, { type: state.type, register: state.register, tags: state.tagsText });
    const mode = state.mode;
    const plan = await planCardImport(cls.rows, mode);
    const c = cls.counts;
    const toWrite = plan.counts.added + plan.counts.updated;

    box.appendChild(h('h2', { class: 'section-title' }, 'Vista previa'));
    box.appendChild(h('p', { class: 'muted small' }, 'Formato detectado: ' + (FORMAT_LABELS[parsed.format] || parsed.format)));
    box.appendChild(
      h(
        'div',
        { class: 'import-counts' },
        countPill(c.nuevas, c.nuevas === 1 ? 'nueva' : 'nuevas', 'nueva'),
        countPill(c.duplicadas, c.duplicadas === 1 ? 'duplicada' : 'duplicadas', 'duplicada'),
        countPill(c.repetidas, c.repetidas === 1 ? 'repetida' : 'repetidas', 'repetida'),
        countPill(c.invalidas, c.invalidas === 1 ? 'inválida' : 'inválidas', 'invalida')
      )
    );
    for (const w of parsed.warnings || []) box.appendChild(h('p', { class: 'warn-text small' }, w));

    if (c.duplicadas > 0) {
      let text = '';
      if (mode === 'omitir') text = `Las ${c.duplicadas} duplicadas no se tocarán.`;
      else if (plan.counts.updated === 0) text = 'Las duplicadas ya tienen todos esos datos: no cambiará nada en ellas.';
      else text = `${plural(plan.counts.updated, 'duplicada se actualizará', 'duplicadas se actualizarán')}; ${plan.counts.unchanged} sin cambios.`;
      box.appendChild(h('p', { class: 'small' }, text));
    }

    const importBtn = h(
      'button',
      {
        class: 'btn btn-primary btn-block',
        type: 'button',
        disabled: c.nuevas + (mode === 'omitir' ? 0 : c.duplicadas) === 0,
        onclick: () => doImportCards(importBtn, cls.rows, mode, key),
      },
      `Importar ${plural(toWrite, 'tarjeta', 'tarjetas')}`
    );
    box.appendChild(importBtn);
    box.appendChild(h('p', { class: 'hint-ko' }, '가져오기 직전에 자동 복사본(Copias automáticas)이 만들어지므로 나중에 되돌릴 수 있습니다.'));

    const list = h('div', { class: 'preview' });
    cls.rows.slice(0, MAX_ROWS_SHOWN).forEach((row) => list.appendChild(rowItem(row)));
    box.appendChild(list);
    if (cls.rows.length > MAX_ROWS_SHOWN) {
      box.appendChild(h('p', { class: 'muted small' }, `… y ${cls.rows.length - MAX_ROWS_SHOWN} filas más (también se importarán).`));
    }
  }

  function countPill(n, label, status) {
    return h('span', { class: 'import-count badge-st-' + status }, `${n} ${label}`);
  }

  function rowItem(row) {
    const dup = row.status === 'duplicada' || row.status === 'repetida';
    const cls = 'preview-item' + (dup ? ' preview-dup' : '') + (row.status === 'invalida' ? ' preview-invalid' : '');
    const card = row.card;
    return h(
      'div',
      { class: cls },
      badge(STATUS_LABELS[row.status] || row.status, 'st-' + row.status),
      card ? h('span', { class: 'preview-front' }, card.front) : h('span', { class: 'preview-front' }, `Fila ${row.index + 1}`),
      card ? badge(typeLabel(card.type), 'type') : null,
      card && card.register ? badge(card.register) : null,
      card && !card.back ? badge('Bandeja', 'inbox') : null,
      card && card.back ? h('span', { class: 'preview-back' }, excerpt(card.back)) : null,
      card && card.tags && card.tags.length ? h('span', { class: 'preview-back' }, card.tags.map((t) => '#' + t).join(' ')) : null,
      row.error ? h('span', { class: 'preview-warn' }, row.error) : null,
      (row.warnings || []).map((w) => h('span', { class: 'preview-warn' }, w))
    );
  }

  async function doImportCards(button, rows, mode, key) {
    button.disabled = true;
    try {
      if (await previewIsStale(key)) return; // the inputs changed after this preview was drawn
      const res = await commitCardImport(rows, mode);
      const lines = [`${plural(res.added, 'tarjeta nueva añadida', 'tarjetas nuevas añadidas')}`];
      lines.push(`${plural(res.updated, 'tarjeta existente actualizada', 'tarjetas existentes actualizadas')}, ${res.unchanged} sin cambios`);
      if (res.skipped > 0) lines.push(`${plural(res.skipped, 'fila omitida', 'filas omitidas')} (duplicadas, repetidas o inválidas)`);
      state.result = { title: 'Importación terminada', lines };
      resetText();
      toast(`${res.added} añadidas, ${res.updated} actualizadas`);
      if (res.added + res.updated > 0) {
        emitCardsChanged(); // rebuilds this view too (the state above is kept)
      } else {
        drawResult();
        await updatePreview();
        window.scrollTo(0, 0);
      }
    } catch (err) {
      console.error(err);
      toast('No se pudo importar: ' + errorText(err));
      button.disabled = false;
    }
  }

  // ---- export file (envelope)

  async function drawEnvelopePreview(box, envelope, key) {
    box.appendChild(h('h2', { class: 'section-title' }, 'Archivo de exportación'));
    const check = validateEnvelope(envelope);
    if (!check.ok) {
      box.appendChild(h('p', { class: 'error' }, check.error));
      return;
    }
    const dry = await previewImportEnvelope(envelope);
    const s = dry.stats;
    const inside = envelopeCounts(envelope);
    const device = envelope.deviceName ? `«${envelope.deviceName}»` : 'otro dispositivo';
    const when = fmtDate(envelope.exportedAt);
    box.appendChild(h('p', { class: 'small' }, `Origen: ${device}${when ? ' · exportado el ' + when : ''}`));
    box.appendChild(
      h('p', { class: 'muted small' }, `Contiene ${plural(inside.cards, 'tarjeta', 'tarjetas')}, ${inside.deleted} en papelera y ${plural(inside.reviews, 'repaso', 'repasos')}.`)
    );
    box.appendChild(
      h(
        'div',
        { class: 'data-list' },
        statRow('Tarjetas nuevas', s.cardsAdded),
        statRow('Tarjetas actualizadas', s.cardsUpdated),
        statRow('Tarjetas sin cambios', s.cardsUnchanged),
        s.cardsInvalid > 0 ? statRow('Tarjetas inválidas (se omiten)', s.cardsInvalid) : null,
        statRow('Repasos nuevos', s.reviewsAdded),
        s.reviewsUpdated > 0 ? statRow('Repasos actualizados', s.reviewsUpdated) : null,
        s.reviewsInvalid > 0 ? statRow('Repasos inválidos (se omiten)', s.reviewsInvalid) : null,
        s.cardsDuplicateKey > 0 ? statRow('Expresiones que quedarán repetidas', s.cardsDuplicateKey) : null
      )
    );
    if (s.cardsDuplicateKey > 0) {
      const names = duplicateFronts(dry, 5);
      box.appendChild(
        h(
          'p',
          { class: 'warn-text small' },
          `${plural(s.cardsDuplicateKey, 'expresión existe', 'expresiones existen')} en los dos dispositivos como tarjetas distintas: ${names}`
        )
      );
      box.appendChild(
        h(
          'p',
          { class: 'hint-ko' },
          '두 기기에서 같은 표현을 따로 만들었기 때문에(예: 양쪽에서 Cargar ejemplos), 합친 뒤에 같은 카드가 두 장씩 생깁니다.\n합친 다음 Explorar에서 둘 중 하나를 Eliminar로 지우면 됩니다. 복습 기록은 사라지지 않습니다.'
        )
      );
    }
    const nothing = dry.changedCardIds.length === 0 && dry.changedReviewIds.length === 0;
    if (nothing) box.appendChild(h('p', { class: 'small' }, 'Ya tienes todo lo que hay en este archivo: fusionar no cambiará nada.'));

    const mergeBtn = h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => doMerge(mergeBtn, envelope, key) }, 'Fusionar');
    box.appendChild(mergeBtn);
    box.appendChild(
      h(
        'p',
        { class: 'hint-ko' },
        '두 기기의 데이터를 합칩니다. 같은 카드는 더 나중에 수정한 쪽이 남고, 더 나중에 삭제한 카드는 삭제된 채로 유지됩니다.\n복습 기록은 양쪽 것을 모두 합치며, 아무것도 지워지지 않습니다. 합치기 직전에 자동 복사본이 만들어집니다.'
      )
    );
  }

  /** The fronts of the first `max` duplicated expressions of a merge result, as one line of text. */
  function duplicateFronts(result, max) {
    const byId = new Map(result.doc.cards.map((c) => [c.id, c]));
    const fronts = result.duplicateKeys.slice(0, max).map((d) => {
      const card = byId.get(d.ids[0]);
      return card ? `«${card.front}»` : d.key;
    });
    const more = result.duplicateKeys.length - fronts.length;
    return fronts.join(', ') + (more > 0 ? ` … y ${more} más` : '');
  }

  function statRow(label, value) {
    return h('div', { class: 'data-row' }, h('span', { class: 'data-label' }, label), h('span', { class: 'data-value' }, String(value)));
  }

  async function doMerge(button, envelope, key) {
    button.disabled = true;
    try {
      if (await previewIsStale(key)) return; // the inputs changed after this preview was drawn
      const res = await importEnvelope(envelope);
      const s = res.stats;
      const lines = [
        `${plural(s.cardsAdded, 'tarjeta nueva', 'tarjetas nuevas')}, ${s.cardsUpdated} actualizadas, ${s.cardsUnchanged} sin cambios`,
        `${plural(s.reviewsAdded, 'repaso nuevo', 'repasos nuevos')}`,
      ];
      if (s.cardsDuplicateKey > 0) {
        lines.push(`${plural(s.cardsDuplicateKey, 'expresión ha quedado repetida', 'expresiones han quedado repetidas')}: elimina una de cada par en Explorar`);
      }
      state.result = { title: 'Fusión terminada', lines };
      resetText();
      toast(`Fusionado: ${s.cardsAdded} nuevas, ${s.cardsUpdated} actualizadas`);
      if (res.changedCardIds.length > 0 || res.changedReviewIds.length > 0) {
        emitCardsChanged(); // rebuilds this view too (the state above is kept)
      } else {
        drawResult();
        await updatePreview();
        window.scrollTo(0, 0);
      }
    } catch (err) {
      console.error(err);
      toast('No se pudo fusionar: ' + errorText(err));
      button.disabled = false;
    }
  }

  // ------------------------------------------------------------ Pedir tarjetas a Claude

  container.appendChild(h('h2', { class: 'section-title' }, 'Pedir tarjetas a Claude'));

  const temaInput = h('input', {
    type: 'text',
    id: 'prompt-tema',
    value: state.prompt.tema,
    placeholder: 'economía y trabajo',
    autocapitalize: 'off',
    autocomplete: 'off',
    oninput: () => (state.prompt.tema = temaInput.value),
  });
  const tipoSelect = h(
    'select',
    { id: 'prompt-tipo', onchange: () => (state.prompt.tipo = tipoSelect.value) },
    h('option', { value: '', selected: state.prompt.tipo === '' }, 'cualquiera'),
    TYPES.map((t) => h('option', { value: t.id, selected: state.prompt.tipo === t.id }, `${t.label} · ${t.ko}`))
  );
  const cantidadInput = h('input', {
    type: 'number',
    id: 'prompt-cantidad',
    value: state.prompt.cantidad,
    min: '1',
    max: '200',
    step: '1',
    inputmode: 'numeric',
    oninput: () => (state.prompt.cantidad = cantidadInput.value),
  });
  const inboxCheck = h('input', {
    type: 'checkbox',
    checked: state.prompt.inbox && inboxFronts.length > 0,
    disabled: inboxFronts.length === 0,
    onchange: () => (state.prompt.inbox = inboxCheck.checked),
  });

  const copyBtn = h(
    'button',
    {
      class: 'btn btn-primary btn-block',
      type: 'button',
      onclick: async () => {
        // Everything is already loaded: the copy must happen directly inside the tap (iOS rule).
        const text = buildPrompt({
          tema: temaInput.value,
          tipo: tipoSelect.value,
          cantidad: Number(cantidadInput.value),
          inboxFronts: inboxCheck.checked ? inboxFronts : [],
        });
        try {
          await copyText(text);
          toast('Prompt copiado');
        } catch (err) {
          console.error(err);
          openPromptSheet(text); // copying is blocked: let the learner copy it by hand
        }
      },
    },
    'Copiar prompt'
  );

  container.appendChild(
    h(
      'div',
      { class: 'form' },
      h('div', { class: 'field' }, h('label', { for: 'prompt-tema' }, 'Tema'), temaInput),
      h(
        'div',
        { class: 'field-row' },
        h('div', { class: 'field' }, h('label', { for: 'prompt-tipo' }, 'Tipo'), tipoSelect),
        h('div', { class: 'field' }, h('label', { for: 'prompt-cantidad' }, 'Cantidad'), cantidadInput)
      ),
      h('label', { class: 'check-row' }, inboxCheck, h('span', {}, `Incluir mi bandeja (${inboxFronts.length})`)),
      copyBtn,
      h(
        'p',
        { class: 'hint-ko' },
        "1. 'Copiar prompt'를 누르고 Claude 대화창에 붙여넣어 보냅니다.\n2. Claude의 답(JSON) 전체를 복사합니다.\n3. 이 화면 맨 위 입력칸에 붙여넣고 미리보기를 확인한 뒤 'Importar N tarjetas'를 누릅니다."
      )
    )
  );

  await updatePreview();
}

// ---------------------------------------------------------------- clipboard

/** Copy with the old execCommand API (for browsers without navigator.clipboard). Throws when blocked. */
function fallbackCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (err) {
    ok = false;
  }
  area.remove();
  if (!ok) throw new Error('el navegador no permite copiar');
}

async function copyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      // not allowed here (permissions, http): try the old way
    }
  }
  fallbackCopy(text);
}

/** Last resort when the browser blocks copying: show the prompt so it can be copied by hand. */
function openPromptSheet(text) {
  const area = h('textarea', { rows: 12, readonly: true, value: text, 'aria-label': 'Prompt' });
  openSheet(
    h(
      'div',
      { class: 'form' },
      h('h2', { class: 'sheet-title' }, 'Prompt'),
      h('p', { class: 'hint-ko' }, '자동 복사가 막혀 있습니다. 아래 글을 전체 선택해서 직접 복사하세요.'),
      area,
      h(
        'div',
        { class: 'sheet-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => closeSheet() }, 'Cerrar'),
        h(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            onclick: () => {
              area.focus();
              area.select();
            },
          },
          'Seleccionar todo'
        )
      )
    )
  );
}
