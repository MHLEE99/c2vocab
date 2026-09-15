// Quick add: bottom sheet with the mini-language textarea, chips, live preview and save.

import { parseCapture, splitTags, SYNTAX_HELP_KO, SYNTAX_PLACEHOLDER } from '../capture.js';
import { getMeta, setMeta, allTags, addCards, newCard, existingKeys, dupKey } from '../db.js';
import { TYPES, REGISTERS, REGIONS, typeLabel } from '../taxonomy.js';
import { debounce } from '../util.js';
import { h, clear, chip, badge, toast, openSheet, closeSheet, emitCardsChanged } from './components.js';

const DEFAULT_CHOICE = { type: 'expresion', register: 'neutro', region: '' };

function excerpt(text, max = 60) {
  const t = String(text || '');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Open the quick-add sheet. Safe to call from any view. */
export async function openQuickAdd() {
  const saved = (await getMeta('lastChoice')) || {};
  const state = {
    type: TYPES.some((t) => t.id === saved.type) ? saved.type : DEFAULT_CHOICE.type,
    register: REGISTERS.some((r) => r.id === saved.register) ? saved.register : '',
    region: typeof saved.region === 'string' ? saved.region : '',
    tagsText: '',
    parsed: { cards: [], warnings: [] },
    dupFronts: new Set(), // fronts (by dupKey) that already exist
    saving: false,
  };
  const tagList = await allTags();
  // Declared before any listener is attached (const is not hoisted); updatePreview is a
  // function declaration further down, which is hoisted.
  const schedulePreview = debounce(updatePreview, 150);

  // --- textarea + help
  const textarea = h('textarea', {
    rows: 6,
    placeholder: SYNTAX_PLACEHOLDER,
    autocapitalize: 'off',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Texto de captura',
  });
  const help = h(
    'details',
    { class: 'help', open: window.matchMedia('(min-width: 800px)').matches },
    h('summary', {}, '입력 형식 도움말'),
    h('p', { class: 'hint-ko' }, SYNTAX_HELP_KO)
  );

  // --- chips
  const typeRow = h('div', { class: 'chip-row' });
  const registerRow = h('div', { class: 'chip-row' });
  // Korean gloss of the active chip, shown inline because `title` tooltips never appear on iOS.
  const typeGloss = h('div', { class: 'chip-gloss' });
  const registerGloss = h('div', { class: 'chip-gloss' });

  function renderChips() {
    clear(typeRow);
    for (const t of TYPES) {
      typeRow.appendChild(
        chip(t.label, {
          active: state.type === t.id,
          title: t.ko,
          onClick: () => {
            state.type = t.id;
            renderChips();
            schedulePreview();
          },
        })
      );
    }
    const activeType = TYPES.find((t) => t.id === state.type);
    typeGloss.textContent = activeType ? `${activeType.label} · ${activeType.ko}` : '';

    clear(registerRow);
    for (const r of REGISTERS) {
      registerRow.appendChild(
        chip(r.label, {
          active: state.register === r.id,
          title: r.ko,
          onClick: () => {
            state.register = state.register === r.id ? '' : r.id; // tap again to clear
            renderChips();
            schedulePreview();
          },
        })
      );
    }
    const activeRegister = REGISTERS.find((r) => r.id === state.register);
    registerGloss.textContent = activeRegister ? `${activeRegister.label} · ${activeRegister.ko}` : '선택 안 함 (다시 누르면 해제)';
  }
  renderChips();

  // --- region select + tags input
  const regionSelect = h(
    'select',
    { 'aria-label': 'Región', onchange: (ev) => (state.region = ev.target.value) },
    h('option', { value: '' }, 'Región (opcional)'),
    REGIONS.map((r) => h('option', { value: r.id, selected: state.region === r.id }, `${r.label} · ${r.ko}`))
  );
  if (state.region && !REGIONS.some((r) => r.id === state.region)) {
    regionSelect.appendChild(h('option', { value: state.region, selected: true }, state.region));
  }

  const datalist = h('datalist', { id: 'qa-tag-list' }, tagList.map((t) => h('option', { value: t.tag })));
  const tagsInput = h('input', {
    type: 'text',
    list: 'qa-tag-list',
    placeholder: 'Etiquetas (tema:economia_trabajo, prueba:1)',
    autocapitalize: 'off',
    autocomplete: 'off',
    'aria-label': 'Etiquetas',
    oninput: (ev) => {
      state.tagsText = ev.target.value;
      schedulePreview();
    },
  });

  // --- preview + actions
  const preview = h('div', { class: 'preview' });
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true, onclick: save }, 'Guardar');
  const cancelBtn = h('button', { class: 'btn', type: 'button', onclick: () => closeSheet() }, 'Cancelar');

  const content = h(
    'div',
    { class: 'form', onkeydown: onKeydown },
    h('h2', { class: 'sheet-title' }, 'Añadir'),
    textarea,
    help,
    h('div', { class: 'filter-label' }, 'Tipo'),
    typeRow,
    typeGloss,
    h('div', { class: 'filter-label' }, 'Registro'),
    registerRow,
    registerGloss,
    h('div', { class: 'field-row' }, regionSelect, h('div', {}, tagsInput, datalist)),
    preview,
    h('div', { class: 'sheet-actions' }, cancelBtn, saveBtn)
  );

  textarea.addEventListener('input', schedulePreview);

  openSheet(content);
  // Autofocus only on desktop: on iOS a programmatic focus pops the keyboard over the sheet.
  if (window.matchMedia('(min-width: 800px)').matches) {
    textarea.focus();
  }

  function currentDefaults() {
    return { type: state.type, register: state.register, region: state.region, tags: splitTags(state.tagsText) };
  }

  async function updatePreview() {
    state.parsed = parseCapture(textarea.value, currentDefaults());
    const keys = await existingKeys();
    state.dupFronts = new Set();
    const seenInText = new Set();
    clear(preview);

    for (const c of state.parsed.cards) {
      const key = dupKey(c.front, c.type);
      const isDup = keys.has(key);
      const repeated = seenInText.has(key);
      seenInText.add(key);
      if (isDup) state.dupFronts.add(key);

      const item = h(
        'div',
        { class: 'preview-item' + (isDup || repeated ? ' preview-dup' : '') },
        h('span', { class: 'preview-front' }, c.front),
        badge(typeLabel(c.type), 'type'),
        c.register ? badge(c.register) : null,
        c.back === '' ? badge('Bandeja', 'inbox') : null,
        c.back !== '' ? h('span', { class: 'preview-back' }, excerpt(c.back)) : null,
        c.tags.length ? h('span', { class: 'preview-back' }, c.tags.map((t) => '#' + t).join(' ')) : null,
        isDup ? h('span', { class: 'preview-warn' }, 'Ya existe una tarjeta con esta expresión y tipo (se guardará igualmente).') : null,
        repeated ? h('span', { class: 'preview-warn' }, 'Repetida dentro del texto.') : null
      );
      preview.appendChild(item);
    }
    for (const w of state.parsed.warnings) {
      preview.appendChild(h('div', { class: 'preview-warn' }, w));
    }
    if (state.parsed.cards.length === 0 && textarea.value.trim() !== '' && state.parsed.warnings.length === 0) {
      preview.appendChild(h('div', { class: 'preview-warn' }, 'Sin entradas válidas.'));
    }
    saveBtn.disabled = state.parsed.cards.length === 0 || state.saving;
  }

  function onKeydown(ev) {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      save();
    }
  }

  async function save() {
    if (state.saving) return;
    // Parse synchronously so a Ctrl+Enter right after typing does not miss the last keystrokes.
    state.parsed = parseCapture(textarea.value, currentDefaults());
    if (state.parsed.cards.length === 0) return;
    state.saving = true;
    saveBtn.disabled = true;
    try {
      const cards = state.parsed.cards.map((c) => newCard(c));
      await addCards(cards);
      await setMeta('lastChoice', { type: state.type, register: state.register, region: state.region });
      toast(cards.length === 1 ? `Guardada: ${cards[0].front}` : `${cards.length} guardadas`);
      closeSheet();
      emitCardsChanged();
    } catch (err) {
      console.error(err);
      toast('Error al guardar: ' + (err && err.message ? err.message : err));
      state.saving = false;
      saveBtn.disabled = false;
    }
  }
}
