// Inicio: today's study numbers, Estudiar buttons, library counts, seed loader, quick add.

import { listCards, listReviews, getSettings, addCards, newCard, existingKeys, dupKey } from '../db.js';
import { fmtDate, nowIso } from '../util.js';
import { queueInfo, isEligible } from '../session.js';
import { countsToday, streak } from '../stats-lite.js';
import { h, toast, emitCardsChanged } from './components.js';
import { openQuickAdd } from './quickadd.js';

const SEEDS_URL = './seeds/base.json';

function stat(value, label) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, String(value)), h('div', { class: 'stat-label' }, label));
}

function goTo(hash) {
  window.location.hash = hash;
}

export async function render(container) {
  const [cards, reviews, settings] = await Promise.all([listCards({ deleted: false }), listReviews(), getSettings()]);

  // ---- today's study numbers (same calculation as the Estudiar screen)
  const now = nowIso();
  const today = countsToday(reviews, now, settings);
  // reviewsDone = answers to review-state cards only (new/learning answers do not use up the review limit)
  const info = queueInfo({ cards, now, settings, newSeenToday: today.newSeen, reviewsDoneToday: today.reviewsDone });
  const racha = streak(reviews, now, settings);
  const studyable = cards.filter(isEligible).length;

  container.appendChild(h('h2', { class: 'section-title section-title-first' }, 'Hoy'));
  container.appendChild(
    h(
      'div',
      { class: 'stats' },
      stat(info.due, 'pendientes'),
      stat(info.news, 'nuevas'),
      stat(today.done, 'hechas hoy'),
      stat(`${racha} ${racha === 1 ? 'día' : 'días'}`, 'racha')
    )
  );

  const estudiar = h(
    'button',
    { class: 'btn btn-primary btn-block btn-big', type: 'button', disabled: info.total === 0, onclick: () => goTo('#/estudiar') },
    `Estudiar (${info.total})`
  );
  container.appendChild(estudiar);

  if (studyable === 0) {
    container.appendChild(
      h('p', { class: 'hint-ko' }, "아직 공부할 카드가 없습니다. 'Añadir'로 표현을 추가하거나 'Cargar ejemplos'로 예시 카드를 넣어 보세요.")
    );
  } else if (info.total === 0) {
    container.appendChild(h('p', { class: 'hint-ko' }, '오늘 복습할 카드가 없습니다. 내일 다시 오세요!'));
  }
  if (info.newPaused) {
    container.appendChild(h('p', { class: 'hint-ko warn-text' }, '밀린 복습이 많아 새 카드는 잠시 멈췄습니다'));
  }

  const nuevasBtn = h(
    'button',
    { class: 'btn btn-block', type: 'button', disabled: info.news === 0, onclick: () => goTo('#/estudiar?modo=nuevas') },
    `Nuevas del día (${info.news})`
  );
  container.appendChild(h('div', { class: 'btn-row' }, nuevasBtn));

  // ---- library counts
  const total = cards.length;
  const inbox = cards.filter((c) => c.status === 'inbox').length;
  const sinEjemplo = cards.filter((c) => !c.example || c.example.trim() === '').length;
  const last = cards.length ? cards[0].updatedAt : null; // listCards is sorted updatedAt desc

  container.appendChild(h('h2', { class: 'section-title' }, 'Mis tarjetas'));
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
