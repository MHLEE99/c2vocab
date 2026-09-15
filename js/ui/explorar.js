// Explorar: search, filters, card list with inline edit and soft delete.
// Filter state lives at module level so a re-render (after cards change) keeps it.

import { listCards, allTags, updateCard, softDeleteCard, restoreCard } from '../db.js';
import { TYPES, REGISTERS, REGIONS, STATUSES, DIRECTIONS, typeLabel } from '../taxonomy.js';
import { normalize, escapeHtml, debounce, fmtDate } from '../util.js';
import { h, clear, chip, badge, toast, emitCardsChanged } from './components.js';

const state = {
  q: '',
  type: '',
  register: '',
  status: '',
  sinEjemplo: false,
  tag: '',
  expandedId: null,
  editingId: null,
};

// The inline edit form currently open (module level so it survives list and view
// re-renders; its inputs keep whatever the user typed). Cleared when editing ends.
let editEl = null;
// The renderList of the most recent render(), so handlers inside editEl can refresh
// the list even after the view was rebuilt around them.
let refreshList = null;

/** Escape then turn [[gap]] markers into underlined spans. */
export function renderExampleHtml(example) {
  return escapeHtml(example).replace(/\[\[(.+?)\]\]/g, '<span class="gap">$1</span>');
}

function haystack(card) {
  return normalize([card.front, card.back, card.example, card.ko, (card.tags || []).join(' ')].join(' '));
}

function matchesQuery(card, tokens) {
  if (tokens.length === 0) return true;
  const hay = haystack(card);
  return tokens.every((t) => hay.includes(t));
}

function applyFilters(cards) {
  const tokens = normalize(state.q).split(' ').filter((t) => t !== '');
  return cards.filter((c) => {
    if (state.type && c.type !== state.type) return false;
    if (state.register && c.register !== state.register) return false;
    if (state.status && c.status !== state.status) return false;
    if (state.sinEjemplo && c.example && c.example.trim() !== '') return false;
    if (state.tag && !(c.tags || []).includes(state.tag)) return false;
    return matchesQuery(c, tokens);
  });
}

export async function render(container) {
  const cards = await listCards({ deleted: false });
  const tags = await allTags();

  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Buscar (expresión, definición, ejemplo, 한국어, etiqueta)',
    value: state.q,
    autocapitalize: 'off',
    autocomplete: 'off',
    'aria-label': 'Buscar',
    oninput: debounce((ev) => {
      state.q = ev.target.value;
      renderList();
    }, 150),
  });

  const filters = h('div', { class: 'filter-block' });
  const countLine = h('div', { class: 'count-line' });
  const list = h('div', { class: 'card-list' });

  container.appendChild(search);
  container.appendChild(filters);
  container.appendChild(countLine);
  container.appendChild(list);

  refreshList = renderList;
  renderFilters();
  renderList();

  // ------------------------------------------------------------ filters

  function renderFilters() {
    clear(filters);

    const presentTypes = TYPES.filter((t) => cards.some((c) => c.type === t.id));
    const typeRow = h('div', { class: 'chip-row' });
    typeRow.appendChild(chip('Todos', { active: state.type === '', onClick: () => setFilter('type', '') }));
    for (const t of presentTypes) {
      typeRow.appendChild(chip(t.label, { active: state.type === t.id, title: t.ko, onClick: () => setFilter('type', t.id) }));
    }
    // Korean gloss of the selected type, inline because `title` tooltips never show on iOS.
    const activeType = TYPES.find((t) => t.id === state.type);
    const typeGloss = h('div', { class: 'chip-gloss' }, activeType ? `${activeType.label} · ${activeType.ko}` : '');

    const registerRow = h('div', { class: 'chip-row' });
    for (const r of REGISTERS) {
      registerRow.appendChild(
        chip(r.label, {
          active: state.register === r.id,
          title: r.ko,
          onClick: () => setFilter('register', state.register === r.id ? '' : r.id),
        })
      );
    }

    const statusRow = h('div', { class: 'chip-row' });
    for (const s of STATUSES) {
      statusRow.appendChild(
        chip(s.label, {
          active: state.status === s.id,
          title: s.ko,
          onClick: () => setFilter('status', state.status === s.id ? '' : s.id),
        })
      );
    }
    statusRow.appendChild(
      chip('sin ejemplo', {
        active: state.sinEjemplo,
        title: '예문 없는 카드만',
        onClick: () => setFilter('sinEjemplo', !state.sinEjemplo),
      })
    );

    const tagSelect = h(
      'select',
      { 'aria-label': 'Etiqueta', onchange: (ev) => setFilter('tag', ev.target.value) },
      h('option', { value: '' }, 'Todas las etiquetas'),
      tags.map((t) => h('option', { value: t.tag, selected: state.tag === t.tag }, `${t.tag} (${t.count})`))
    );
    if (state.tag && !tags.some((t) => t.tag === state.tag)) {
      tagSelect.appendChild(h('option', { value: state.tag, selected: true }, state.tag));
    }

    filters.appendChild(typeRow);
    filters.appendChild(typeGloss);
    filters.appendChild(registerRow);
    filters.appendChild(statusRow);
    filters.appendChild(tagSelect);
  }

  function setFilter(key, value) {
    state[key] = value;
    renderFilters();
    renderList();
  }

  // ------------------------------------------------------------ list

  function renderList() {
    clear(list);
    const shown = applyFilters(cards);
    countLine.textContent = `${shown.length} ${shown.length === 1 ? 'tarjeta' : 'tarjetas'}`;

    if (cards.length === 0) {
      list.appendChild(
        h(
          'div',
          { class: 'empty' },
          h('p', {}, 'Todavía no hay tarjetas.'),
          h('p', { class: 'hint-ko' }, "오른쪽 아래 '+' 버튼으로 표현을 추가하거나, Inicio에서 'Cargar ejemplos'를 눌러 예시 카드를 넣어 보세요.")
        )
      );
      return;
    }
    if (shown.length === 0) {
      list.appendChild(h('div', { class: 'empty' }, h('p', {}, 'Ninguna tarjeta coincide con la búsqueda o los filtros.')));
      return;
    }
    for (const card of shown) {
      if (state.editingId === card.id) {
        // Reuse the open form so a re-render (search, filter, another card tapped,
        // quick-add save) does not discard what the user has typed.
        if (!editEl || editEl.dataset.id !== card.id) editEl = renderEditCard(card);
        list.appendChild(editEl);
      } else {
        list.appendChild(renderCard(card));
      }
    }
  }

  function stopEditing() {
    state.editingId = null;
    editEl = null;
  }

  function renderCard(card) {
    const expanded = state.expandedId === card.id;
    const header = h(
      'div',
      { class: 'card-header' },
      h('span', { class: 'card-front' }, card.front),
      badge(typeLabel(card.type), 'type'),
      card.register ? badge(card.register) : null,
      card.region ? badge(card.region) : null,
      card.status === 'inbox' ? badge('Bandeja', 'inbox') : null,
      card.status === 'suspended' ? badge('suspendida', 'suspended') : null
    );

    const body = h('div', { class: 'card-body' });
    if (card.back) body.appendChild(h('p', { class: 'card-back' }, card.back));
    if (card.ko) body.appendChild(h('p', { class: 'card-ko' }, card.ko));
    if (card.example) body.appendChild(h('p', { class: 'card-example', html: renderExampleHtml(card.example) }));
    if (card.tags && card.tags.length) {
      body.appendChild(h('div', { class: 'card-tags' }, card.tags.map((t) => h('span', { class: 'tag' }, t))));
    }

    const el = h('article', { class: 'card' + (expanded ? ' card-expanded' : ''), dataset: { id: card.id } }, header, body);

    if (expanded) {
      const meta = [];
      if (card.colocaciones && card.colocaciones.length) meta.push('Colocaciones: ' + card.colocaciones.join(' · '));
      if (card.contraste) meta.push('Contraste: ' + card.contraste);
      if (card.source) meta.push('Fuente: ' + card.source);
      if (card.exampleSource) meta.push('Ejemplo: ' + card.exampleSource);
      if (card.notes) meta.push('Notas: ' + card.notes);
      meta.push('Actualizada: ' + fmtDate(card.updatedAt));
      el.appendChild(h('div', { class: 'card-meta' }, meta.map((m) => h('div', {}, m))));
      el.appendChild(
        h(
          'div',
          { class: 'card-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => startEdit(card) }, 'Editar'),
          h('button', { class: 'btn btn-danger', type: 'button', onclick: () => removeCard(card) }, 'Eliminar')
        )
      );
    }

    el.addEventListener('click', (ev) => {
      // Buttons and links inside the card handle their own clicks.
      if (ev.target.closest('button, a, input, textarea, select, label')) return;
      state.expandedId = expanded ? null : card.id;
      renderList();
    });
    return el;
  }

  function startEdit(card) {
    stopEditing(); // a fresh form from the stored values
    state.editingId = card.id;
    state.expandedId = card.id;
    renderList();
  }

  async function removeCard(card) {
    const result = await softDeleteCard(card.id);
    if (!result) return;
    if (state.expandedId === card.id) state.expandedId = null;
    toast(`Eliminada: ${card.front}`, {
      actionLabel: 'Deshacer',
      onAction: async () => {
        await restoreCard(card.id);
        toast(`Restaurada: ${card.front}`);
        emitCardsChanged();
      },
    });
    emitCardsChanged();
  }

  // ------------------------------------------------------------ inline edit form

  function field(labelText, control) {
    return h('div', { class: 'field' }, h('label', {}, labelText), control);
  }

  function select(options, current, extra = {}) {
    return h(
      'select',
      extra,
      options.map((o) => h('option', { value: o.id, selected: o.id === current }, o.label))
    );
  }

  function renderEditCard(card) {
    const front = h('input', { type: 'text', value: card.front, required: true });
    const type = select(TYPES, card.type);
    const register = select([{ id: '', label: '—' }].concat(REGISTERS), card.register);
    const region = h('input', { type: 'text', value: card.region, list: 'edit-region-list', autocapitalize: 'off' });
    const regionList = h('datalist', { id: 'edit-region-list' }, REGIONS.map((r) => h('option', { value: r.id })));
    const back = h('textarea', { rows: 3, value: card.back });
    const ko = h('input', { type: 'text', value: card.ko });
    const example = h('textarea', { rows: 3, value: card.example, placeholder: 'Marca el hueco con [[...]]' });
    const exampleSource = h('input', { type: 'text', value: card.exampleSource, placeholder: "'redactado' o la fuente real" });
    const tagsInput = h('input', { type: 'text', value: (card.tags || []).join(', '), autocapitalize: 'off' });
    const colocaciones = h('textarea', { rows: 2, value: (card.colocaciones || []).join('\n') });
    const contraste = h('input', { type: 'text', value: card.contraste });
    const source = h('input', { type: 'text', value: card.source });
    const notes = h('textarea', { rows: 2, value: card.notes });
    const status = select(STATUSES, card.status);
    const direction = select(DIRECTIONS, card.direction);

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Guardar');
    const cancelBtn = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: () => {
          stopEditing();
          // The view may have been rebuilt since this form was created: use the latest list.
          if (refreshList) refreshList();
        },
      },
      'Cancelar'
    );

    const form = h(
      'form',
      {
        class: 'form',
        onsubmit: async (ev) => {
          ev.preventDefault();
          if (front.value.trim() === '') {
            front.focus();
            return;
          }
          saveBtn.disabled = true;
          const patch = {
            front: front.value,
            type: type.value,
            register: register.value,
            region: region.value.trim(),
            back: back.value,
            ko: ko.value.trim(),
            example: example.value.trim(),
            exampleSource: exampleSource.value.trim(),
            tags: tagsInput.value,
            colocaciones: colocaciones.value.split('\n'),
            contraste: contraste.value.trim(),
            source: source.value.trim(),
            notes: notes.value,
            status: status.value,
            direction: direction.value,
          };
          try {
            await updateCard(card.id, patch);
            stopEditing();
            toast(`Guardada: ${patch.front.trim()}`);
            emitCardsChanged();
          } catch (err) {
            console.error(err);
            toast('Error al guardar: ' + (err && err.message ? err.message : err));
            saveBtn.disabled = false;
          }
        },
      },
      field('Expresión', front),
      h('div', { class: 'field-row' }, field('Tipo', type), field('Registro', register)),
      h('div', { class: 'field-row' }, field('Región', h('div', {}, region, regionList)), field('Estado', status)),
      field('Definición (español)', back),
      field('Coreano', ko),
      field('Ejemplo', example),
      field('Fuente del ejemplo', exampleSource),
      field('Etiquetas (coma o espacio)', tagsInput),
      field('Colocaciones (una por línea)', colocaciones),
      field('Contraste (no confundir con...)', contraste),
      field('Fuente', source),
      field('Notas', notes),
      field('Dirección', direction),
      h('div', { class: 'card-actions' }, cancelBtn, saveBtn)
    );

    return h('article', { class: 'card card-expanded', dataset: { id: card.id } }, h('div', { class: 'card-header' }, h('span', { class: 'card-front' }, 'Editar: ' + card.front)), form);
  }
}
