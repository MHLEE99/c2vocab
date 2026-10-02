// Copias automáticas: the snapshots kept inside the browser (ring buffer of 10) and
// 'Restaurar', which reverts card CONTENT to a snapshot. Study history is never rolled back.

import { listBackups, previewRestore, restoreBackup, snapshot, backupReasonLabel, BACKUP_KEEP } from '../backup.js';
import { fmtDate } from '../util.js';
import { h, clear, badge, toast, openSheet, closeSheet, emitCardsChanged } from './components.js';

function errorText(err) {
  return err && err.message ? err.message : String(err);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export async function render(container) {
  container.appendChild(h('a', { class: 'back-link', href: '#/ajustes' }, '‹ Volver'));
  container.appendChild(
    h(
      'p',
      { class: 'hint-ko' },
      `앱이 자동으로 만든 복사본입니다 (공부를 마친 뒤, 가져오기 전, 복원하기 전). 최근 ${BACKUP_KEEP}개만 보관합니다.\n이 복사본은 브라우저 안에만 있습니다. 브라우저의 '사이트 데이터 삭제'로부터 지켜 주는 것은 Ajustes의 'Exportar todo'뿐입니다.`
    )
  );

  const createBtn = h('button', { class: 'btn btn-block', type: 'button', onclick: () => createNow(createBtn, list) }, 'Crear copia ahora');
  container.appendChild(createBtn);

  const list = h('div', {});
  container.appendChild(list);
  await drawList(list);
}

/** (Re)build the list of backups inside `list`. */
async function drawList(list) {
  const backups = await listBackups();
  clear(list);
  list.appendChild(h('div', { class: 'count-line' }, plural(backups.length, 'copia', 'copias')));
  if (backups.length === 0) {
    list.appendChild(h('div', { class: 'empty' }, h('p', {}, 'Todavía no hay copias.')));
    return;
  }
  const cards = h('div', { class: 'card-list' });
  for (const b of backups) {
    const restoreBtn = h('button', { class: 'btn', type: 'button', onclick: () => openRestoreSheet(b, restoreBtn) }, 'Restaurar');
    cards.appendChild(
      h(
        'article',
        { class: 'card', style: { cursor: 'default' } },
        h('div', { class: 'card-header' }, h('span', { class: 'card-front' }, fmtDate(b.createdAt)), badge(backupReasonLabel(b.reason), 'type')),
        h('div', { class: 'card-meta' }, `${plural(b.cards, 'tarjeta', 'tarjetas')} · ${plural(b.reviews, 'repaso', 'repasos')}`),
        h('div', { class: 'card-actions' }, restoreBtn)
      )
    );
  }
  list.appendChild(cards);
}

async function createNow(button, list) {
  button.disabled = true;
  try {
    const made = await snapshot('manual');
    if (!made) {
      toast('No hay tarjetas que copiar todavía');
    } else {
      toast('Copia creada');
      await drawList(list);
    }
  } catch (err) {
    console.error(err);
    toast('No se pudo crear la copia: ' + errorText(err));
  } finally {
    button.disabled = false;
  }
}

/** Show what restoring would change, then restore on confirmation. */
async function openRestoreSheet(backup, button) {
  button.disabled = true;
  let stats = null;
  try {
    stats = (await previewRestore(backup.id)).stats;
  } catch (err) {
    console.error(err);
    toast('No se puede restaurar: ' + errorText(err));
    button.disabled = false;
    return;
  }
  button.disabled = false;

  const nothing = stats.cardsReverted === 0 && stats.cardsReadded === 0 && stats.reviewsAdded === 0;
  const lines = [
    h(
      'li',
      {},
      stats.cardsReverted === 1
        ? '1 tarjeta volverá a su contenido de esa fecha'
        : `${stats.cardsReverted} tarjetas volverán a su contenido de esa fecha`
    ),
    stats.cardsReadded > 0
      ? h('li', {}, stats.cardsReadded === 1 ? '1 tarjeta que falta se añadirá de nuevo' : `${stats.cardsReadded} tarjetas que faltan se añadirán de nuevo`)
      : null,
    h('li', {}, stats.cardsKept === 1 ? '1 tarjeta creada después se conserva' : `${stats.cardsKept} tarjetas creadas después se conservan`),
    stats.cardsDuplicateKey > 0
      ? h(
          'li',
          { class: 'warn-text' },
          stats.cardsDuplicateKey === 1
            ? '1 expresión quedará repetida (la tarjeta recuperada ya existe con otro id): elimina una de las dos en Explorar'
            : `${stats.cardsDuplicateKey} expresiones quedarán repetidas (las tarjetas recuperadas ya existen con otro id): elimina una de cada par en Explorar`
        )
      : null,
  ];

  const confirmBtn = h(
    'button',
    {
      class: 'btn btn-primary',
      type: 'button',
      disabled: nothing,
      onclick: async () => {
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
          const result = await restoreBackup(backup.id);
          const n = result.stats.cardsReverted + result.stats.cardsReadded;
          closeSheet();
          toast(`Copia restaurada: ${plural(n, 'tarjeta recuperada', 'tarjetas recuperadas')}`);
          emitCardsChanged(); // also rebuilds this list (a 'pre-restore' copy was added)
        } catch (err) {
          console.error(err);
          toast('No se pudo restaurar: ' + errorText(err));
          confirmBtn.disabled = false;
          cancelBtn.disabled = false;
        }
      },
    },
    'Restaurar'
  );
  const cancelBtn = h('button', { class: 'btn', type: 'button', onclick: () => closeSheet() }, 'Cancelar');

  openSheet(
    h(
      'div',
      { class: 'form' },
      h('h2', { class: 'sheet-title' }, 'Restaurar copia'),
      h('p', { class: 'muted small' }, `${fmtDate(backup.createdAt)} · ${backupReasonLabel(backup.reason)}`),
      h('ul', { class: 'plain-list' }, lines),
      nothing ? h('p', { class: 'warn-text small' }, 'Tus tarjetas ya coinciden con esta copia: no hay nada que restaurar.') : null,
      h(
        'p',
        { class: 'hint-ko' },
        '카드의 내용(정의, 예문, 태그, 삭제 여부)만 그 시점으로 되돌립니다.\n복습 기록과 그 이후에 만든 카드는 절대 사라지지 않습니다.\n복원하기 직전의 상태도 자동으로 복사본으로 남으므로, 다시 되돌릴 수 있습니다.'
      ),
      h('div', { class: 'sheet-actions' }, cancelBtn, confirmBtn)
    )
  );
}
