// Papelera: soft-deleted cards with a Restaurar button each. There is deliberately
// no "empty trash" action: cards are never hard-deleted.

import { listCards, restoreCard } from '../db.js';
import { typeLabel } from '../taxonomy.js';
import { fmtDate } from '../util.js';
import { h, badge, toast, emitCardsChanged } from './components.js';

export async function render(container) {
  const cards = await listCards({ deleted: true });
  cards.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));

  container.appendChild(h('p', { class: 'hint-ko' }, '카드는 절대 완전히 삭제되지 않습니다. 여기서 복원할 수 있습니다.'));
  container.appendChild(h('div', { class: 'count-line' }, `${cards.length} ${cards.length === 1 ? 'tarjeta eliminada' : 'tarjetas eliminadas'}`));

  if (cards.length === 0) {
    container.appendChild(h('div', { class: 'empty' }, h('p', {}, 'La papelera está vacía.')));
    return;
  }

  const list = h('div', { class: 'card-list' });
  for (const card of cards) {
    const restoreBtn = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: async () => {
          restoreBtn.disabled = true;
          await restoreCard(card.id);
          toast(`Restaurada: ${card.front}`);
          emitCardsChanged();
        },
      },
      'Restaurar'
    );
    list.appendChild(
      h(
        'article',
        { class: 'card', style: { cursor: 'default' } },
        h('div', { class: 'card-header' }, h('span', { class: 'card-front' }, card.front), badge(typeLabel(card.type), 'type')),
        card.back ? h('p', { class: 'card-back muted small' }, card.back) : null,
        h('div', { class: 'card-meta' }, 'Eliminada: ' + fmtDate(card.deletedAt)),
        h('div', { class: 'card-actions' }, restoreBtn)
      )
    );
  }
  container.appendChild(list);
}
