// Inicio: counts, disabled Estudiar button (step 2), seed loader, shortcut to quick add.

import { listCards, addCards, newCard, existingKeys, dupKey } from '../db.js';
import { fmtDate } from '../util.js';
import { h, toast, emitCardsChanged } from './components.js';
import { openQuickAdd } from './quickadd.js';

const SEEDS_URL = './seeds/base.json';

function stat(value, label) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, String(value)), h('div', { class: 'stat-label' }, label));
}

export async function render(container) {
  const cards = await listCards({ deleted: false });
  const total = cards.length;
  const inbox = cards.filter((c) => c.status === 'inbox').length;
  const sinEjemplo = cards.filter((c) => !c.example || c.example.trim() === '').length;
  const last = cards.length ? cards[0].updatedAt : null; // listCards is sorted updatedAt desc

  container.appendChild(
    h(
      'div',
      { class: 'stats' },
      stat(total, 'tarjetas'),
      stat(inbox, 'en bandeja'),
      stat(sinEjemplo, 'sin ejemplo'),
      h('div', { class: 'stat' }, h('div', { class: 'stat-value', style: { fontSize: '16px' } }, last ? fmtDate(last) : '—'), h('div', { class: 'stat-label' }, 'última actualización'))
    )
  );

  const estudiar = h('button', { class: 'btn btn-primary btn-block btn-big', type: 'button', disabled: true }, 'Estudiar');
  container.appendChild(estudiar);
  container.appendChild(h('p', { class: 'hint-ko' }, '2단계에서 활성화됩니다'));

  const loadBtn = h(
    'button',
    { class: 'btn', type: 'button', onclick: () => loadSeeds(loadBtn) },
    'Cargar ejemplos (20)'
  );
  const addBtn = h('button', { class: 'btn', type: 'button', onclick: () => openQuickAdd() }, 'Añadir');
  container.appendChild(h('div', { class: 'btn-row' }, addBtn, loadBtn));

  container.appendChild(
    h(
      'p',
      { class: 'hint-ko' },
      "'Añadir' 또는 오른쪽 아래 '+' 버튼으로 표현을 빠르게 저장합니다.\n'Cargar ejemplos'는 미리 준비된 예시 카드 20장을 넣어 줍니다(이미 있는 카드는 건너뜁니다)."
    )
  );
}

/** Fetch ./seeds/base.json and add the rows that are not already in the database. */
async function loadSeeds(button) {
  button.disabled = true;
  try {
    const res = await fetch(SEEDS_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rows = Array.isArray(json) ? json : Array.isArray(json && json.cards) ? json.cards : [];
    if (rows.length === 0) throw new Error('el archivo no contiene tarjetas');

    const keys = await existingKeys();
    const toAdd = [];
    let existing = 0;
    let invalid = 0;
    for (const row of rows) {
      if (!row || typeof row.front !== 'string' || row.front.trim() === '') {
        invalid += 1;
        continue;
      }
      // Seeds never carry ids/timestamps/srs of another device: let newCard assign fresh ones.
      const { id, createdAt, updatedAt, deletedAt, srs, ...content } = row;
      // Build the card first so the duplicate key uses the same coerced type that
      // newCard stores (an unknown row.type becomes 'otro' on disk).
      const card = newCard(content);
      const key = dupKey(card.front, card.type);
      if (keys.has(key)) {
        existing += 1;
        continue;
      }
      keys.add(key); // also skips duplicates inside the seed file itself
      toAdd.push(card);
    }
    const added = await addCards(toAdd);
    let msg = `${added} tarjetas añadidas, ${existing} ya existían`;
    if (invalid) msg += `, ${invalid} inválidas`;
    toast(msg);
    if (added > 0) emitCardsChanged();
  } catch (err) {
    console.error(err);
    toast('No se pudieron cargar los ejemplos: ' + (err && err.message ? err.message : err));
  } finally {
    button.disabled = false;
  }
}
