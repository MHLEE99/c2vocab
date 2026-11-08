// Estudiar: the daily review screen (route '#/estudiar', or '#/estudiar?modo=nuevas'
// for a session with only today's new cards). Direction 'rec' only in step 2.
//
// The session itself lives in memory (js/session.js). Every rating is written to the
// database at once (db.applyReview), so leaving in the middle of a session is always safe.

import { listCards, listReviews, getSettings, getMeta, applyReview, undoReview } from '../db.js';
import { nowIso } from '../util.js';
import { typeLabel } from '../taxonomy.js';
import { predict, resolveSettings } from '../srs.js';
import { buildQueue, createSession } from '../session.js';
import { countsToday, streak, dueTomorrow } from '../stats-lite.js';
import { snapshot } from '../backup.js';
import { h, clear, badge, toast, openSheet, closeSheet, isSheetOpen } from './components.js';
import { renderExampleHtml } from './explorar.js';

const KIND_LABELS = { new: 'nueva', review: 'repaso', learning: 'aprendiendo' };

// The four answer buttons. `css` picks the colour; the label makes them readable without colour.
const RATINGS = [
  { rating: 1, label: 'Otra vez', css: 'again', counter: 'again' },
  { rating: 2, label: 'Difícil', css: 'hard', counter: 'hard' },
  { rating: 3, label: 'Bien', css: 'good', counter: 'good' },
  { rating: 4, label: 'Fácil', css: 'easy', counter: 'easy' },
];

// The view currently on screen ({ alive, stop }) or null. destroy() stops its timer and listeners.
let active = null;

/** Is the study screen on screen right now? (sw-client asks before reloading for a new version) */
export function isSessionRunning() {
  return active !== null;
}

/** Called by the router before another view is shown. */
export function destroy() {
  if (!active) return;
  const view = active;
  active = null;
  view.alive = false;
  if (typeof view.stop === 'function') view.stop();
}

/** 83000 ms -> '01:23'. */
function fmtClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

function errorText(err) {
  return err && err.message ? err.message : String(err);
}

function goHome() {
  window.location.hash = '#/';
}

function homeButton() {
  return h('button', { class: 'btn btn-primary btn-block btn-big', type: 'button', onclick: goHome }, 'Volver al inicio');
}

export async function render(container, params = {}) {
  destroy(); // never two sessions at once
  const view = { alive: true, stop: null };
  active = view;

  const mode = params && params.modo === 'nuevas' ? 'new' : 'all';

  const [cards, reviews, storedSettings, deviceId] = await Promise.all([
    listCards({ deleted: false }),
    listReviews(),
    getSettings(),
    getMeta('deviceId'),
  ]);
  if (!view.alive) return; // the user left while the data was loading

  const settings = resolveSettings(storedSettings);
  const startedAt = nowIso();
  const today = countsToday(reviews, startedAt, settings);
  const queue = buildQueue({
    cards,
    now: startedAt,
    settings,
    newSeenToday: today.newSeen,
    reviewsDoneToday: today.reviewsDone, // only answers to review-state cards use up the review limit
    mode,
  });

  // ------------------------------------------------------------ empty queue

  if (queue.length === 0) {
    container.appendChild(
      h(
        'div',
        { class: 'empty' },
        h('p', {}, mode === 'new' ? 'No quedan tarjetas nuevas para hoy.' : 'No hay tarjetas para estudiar ahora.'),
        h('p', { class: 'hint-ko' }, '오늘 공부할 카드를 모두 끝냈거나 아직 활성 카드가 없습니다.\n내일 다시 오거나, Inicio에서 카드를 추가해 보세요.'),
        homeButton()
      )
    );
    const onEmptyKey = (ev) => {
      if (ev.key === 'Escape' && !isSheetOpen()) goHome();
    };
    document.addEventListener('keydown', onEmptyKey);
    view.stop = () => document.removeEventListener('keydown', onEmptyKey);
    return;
  }

  // ------------------------------------------------------------ session state

  const cardsById = new Map(cards.map((c) => [c.id, c]));
  const session = createSession({ queue, cardsById, settings, startedAt, deviceId: deviceId || '' });

  let phase = 'card'; // 'card' | 'summary'
  let revealed = false; // is the answer side showing?
  let busy = false; // a database write is running: ignore input
  let limitShown = false; // the "you have studied N min" sheet appears once per session
  let limitSheetOpen = false;
  let frozenMs = 0; // session time shown in the summary
  let summarySeq = 0; // guards the async summary against a quick undo
  let pausedMs = 0; // time the page was hidden (phone locked, other tab): not study time
  let hiddenAt = document.hidden ? Date.now() : 0; // when the page was hidden (0 = visible)

  const limitMs = settings.sessionMinutes > 0 ? settings.sessionMinutes * 60 * 1000 : 0;

  // ------------------------------------------------------------ layout

  const statusLine = h('div', { class: 'review-status', role: 'timer' });
  const cardArea = h('div', { class: 'review-card' });
  const keysHint = h('p', { class: 'review-keys' }, 'Espacio / Enter: mostrar · 1–4: valorar · Z: deshacer · Esc: salir');
  const actionInner = h('div', { class: 'review-actions-inner' });
  const actionBar = h('div', { class: 'review-actions' }, actionInner);

  container.appendChild(h('div', { class: 'review' }, statusLine, cardArea, keysHint));
  container.appendChild(actionBar); // fixed above the bottom nav (see styles.css)

  const timer = setInterval(updateStatus, 1000);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('visibilitychange', onVisibility);
  view.stop = () => {
    clearInterval(timer);
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('visibilitychange', onVisibility);
    if (limitSheetOpen) closeSheet();
  };

  showCard();

  // ------------------------------------------------------------ study time

  /** Session time without the periods in which the page was hidden. */
  function studyMs() {
    const hiddenNow = hiddenAt ? Math.max(0, Date.now() - hiddenAt) : 0;
    return Math.max(0, session.elapsedMs(nowIso()) - pausedMs - hiddenNow);
  }

  /** Phone locked / tab in the background: stop the clock; restart the answer time on return. */
  function onVisibility() {
    if (!view.alive) return;
    if (document.hidden) {
      if (!hiddenAt) hiddenAt = Date.now();
      return;
    }
    if (!hiddenAt) return;
    pausedMs += Math.max(0, Date.now() - hiddenAt);
    hiddenAt = 0;
    if (phase === 'card') {
      session.markShown(nowIso()); // the time away does not count as answer time
      updateStatus();
    }
  }

  // ------------------------------------------------------------ header line

  function updateStatus() {
    if (!view.alive || phase !== 'card') return;
    const left = session.remaining();
    const news = session.remainingNew();
    const clock = fmtClock(studyMs());
    statusLine.textContent = `${left} ${left === 1 ? 'restante' : 'restantes'} · ${news} ${news === 1 ? 'nueva' : 'nuevas'} · ${clock}`;
  }

  // ------------------------------------------------------------ card

  /** Show the current card on its FRONT side. */
  function showCard() {
    phase = 'card';
    revealed = false;
    session.markShown(nowIso());
    statusLine.hidden = false;
    keysHint.hidden = false;
    updateStatus();
    renderCard();
    renderActions();
    window.scrollTo(0, 0);
  }

  function extraLine(label, text) {
    return h('p', { class: 'review-extra' }, h('strong', {}, label + ': '), text);
  }

  function renderCard() {
    clear(cardArea);
    cardArea.className = 'review-card';
    const item = session.current();
    const card = session.currentCard();
    if (!item || !card) {
      cardArea.appendChild(h('p', { class: 'error' }, 'No se encontró la tarjeta.'));
      return;
    }

    cardArea.appendChild(
      h(
        'div',
        { class: 'review-badges' },
        badge(KIND_LABELS[item.kind] || item.kind, 'kind-' + item.kind),
        badge(typeLabel(card.type), 'type'),
        card.register ? badge(card.register) : null,
        card.region ? badge(card.region) : null
      )
    );
    cardArea.appendChild(h('div', { class: 'review-front' }, card.front));

    if (!revealed) return;

    const answer = h('div', { class: 'review-answer' });
    answer.appendChild(h('p', { class: 'review-back' }, card.back));
    if (card.ko) answer.appendChild(h('p', { class: 'review-ko' }, card.ko));
    if (card.example) answer.appendChild(h('p', { class: 'review-example', html: renderExampleHtml(card.example) }));
    if (card.colocaciones && card.colocaciones.length) {
      answer.appendChild(extraLine('Colocaciones', card.colocaciones.join(' · ')));
    }
    if (card.equivalentes && card.equivalentes.length) {
      const list = card.equivalentes.map((e) => (e.registro ? `${e.texto} (${e.registro})` : e.texto));
      answer.appendChild(extraLine('Equivalentes', list.join(' · ')));
    }
    if (card.contraste) answer.appendChild(extraLine('Contraste', card.contraste));
    if (card.notes) answer.appendChild(extraLine('Notas', card.notes));
    if (card.tags && card.tags.length) {
      answer.appendChild(h('div', { class: 'card-tags' }, card.tags.map((t) => h('span', { class: 'tag' }, t))));
    }
    cardArea.appendChild(answer);
  }

  // ------------------------------------------------------------ action bar

  function renderActions() {
    clear(actionInner);
    if (phase !== 'card' || !session.current()) {
      actionBar.hidden = true;
      return;
    }
    actionBar.hidden = false;

    if (session.canUndo()) {
      actionInner.appendChild(
        h(
          'div',
          { class: 'review-undo-row' },
          h('button', { class: 'review-undo', type: 'button', disabled: busy, onclick: onUndo }, 'Deshacer')
        )
      );
    }

    if (!revealed) {
      actionInner.appendChild(
        h(
          'button',
          { class: 'btn btn-primary btn-block btn-big review-reveal', type: 'button', disabled: busy, onclick: reveal },
          'Mostrar respuesta'
        )
      );
      return;
    }

    // Predicted interval under each label ('10 min', '1 d', ...).
    const labels = predict(session.currentState(), settings, nowIso(), session.current().cardId);
    const row = h('div', { class: 'rating-row' });
    for (const r of RATINGS) {
      row.appendChild(
        h(
          'button',
          { class: 'rate-btn rate-' + r.css, type: 'button', disabled: busy, onclick: () => onRate(r.rating) },
          h('span', { class: 'rate-label' }, r.label),
          h('span', { class: 'rate-interval' }, labels[r.rating])
        )
      );
    }
    actionInner.appendChild(row);
  }

  /** Lock or unlock every button of the view while a database write runs. */
  function setBusy(value) {
    busy = value;
    actionInner.querySelectorAll('button').forEach((b) => {
      b.disabled = value;
    });
    cardArea.querySelectorAll('button').forEach((b) => {
      b.disabled = value;
    });
  }

  function reveal() {
    if (busy || phase !== 'card' || revealed || !session.current()) return;
    revealed = true;
    renderCard();
    renderActions();
  }

  // ------------------------------------------------------------ rating

  async function onRate(rating) {
    if (busy || phase !== 'card' || !revealed || !session.current()) return;
    setBusy(true);

    let result;
    try {
      result = session.rate(rating, nowIso());
    } catch (err) {
      console.error(err);
      toast('No se pudo valorar: ' + errorText(err));
      setBusy(false);
      return;
    }

    try {
      // Review row + card srs in one transaction. prevState lets the database refuse the
      // rating if the same card was already rated in another tab (stale session).
      await applyReview(result.review, result.nextState, result.prevState);
    } catch (err) {
      console.error(err);
      session.undo(); // nothing was saved: put the session back as it was
      toast('No se pudo guardar la respuesta: ' + errorText(err));
      if (view.alive) setBusy(false);
      return;
    }

    busy = false;
    if (!view.alive) return; // the rating is saved; the screen is gone

    if (!session.current()) {
      showSummary();
      return;
    }
    showCard();
    maybeShowLimitSheet();
  }

  // ------------------------------------------------------------ undo

  async function onUndo() {
    if (busy) return;
    const entry = session.peekUndo();
    if (!entry) return;
    setBusy(true);
    try {
      // Database first: if this fails, the session on screen is still correct.
      await undoReview(entry.reviewId, entry.cardId, entry.dir, entry.prevState);
    } catch (err) {
      console.error(err);
      toast('No se pudo deshacer: ' + errorText(err));
      if (view.alive) setBusy(false);
      return;
    }
    session.undo(nowIso());
    busy = false;
    if (!view.alive) return;
    summarySeq += 1; // a summary still loading must not overwrite the card
    showCard(); // the undone card comes back on its front side
    toast('Deshecho');
  }

  // ------------------------------------------------------------ soft time limit

  function maybeShowLimitSheet() {
    if (limitShown || limitMs === 0 || !session.current()) return;
    const elapsed = studyMs();
    if (elapsed <= limitMs) return;
    limitShown = true;

    let finish = false;
    const minutes = Math.floor(elapsed / 60000);
    const left = session.remaining();
    const content = h(
      'div',
      {},
      h('h2', { class: 'sheet-title' }, `Llevas ${minutes} min estudiando`),
      h('p', {}, `${left === 1 ? 'Queda 1 tarjeta' : 'Quedan ' + left + ' tarjetas'} en esta sesión.`),
      h('p', { class: 'hint-ko' }, '목표 시간을 넘겼습니다. 계속해도 되고 여기서 끝내도 됩니다.\n지금까지의 답은 모두 저장되어 있고, 남은 카드는 나중에 다시 나옵니다.'),
      h(
        'div',
        { class: 'sheet-actions' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              finish = true;
              closeSheet();
            },
          },
          'Terminar'
        ),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => closeSheet() }, 'Seguir')
      )
    );

    limitSheetOpen = true;
    openSheet(content, {
      onClose: () => {
        limitSheetOpen = false;
        if (!view.alive) return;
        if (finish) showSummary();
        else session.markShown(nowIso()); // the pause does not count as answer time
      },
    });
  }

  // ------------------------------------------------------------ summary

  async function showSummary() {
    phase = 'summary';
    summarySeq += 1;
    const seq = summarySeq;
    const now = nowIso();
    frozenMs = studyMs();
    // Safety copy after studying (at most one per hour). It runs in the background and
    // must never block or break the summary.
    Promise.resolve()
      .then(() => snapshot('session', now))
      .catch((err) => console.error(err));
    statusLine.hidden = true;
    keysHint.hidden = true;
    renderActions(); // hides the action bar
    clear(cardArea);
    cardArea.className = 'review-card review-summary';
    window.scrollTo(0, 0);

    // Fresh data so the streak and tomorrow's count include this session.
    let racha = null;
    let tomorrow = null;
    try {
      const [freshCards, freshReviews] = await Promise.all([listCards({ deleted: false }), listReviews()]);
      racha = streak(freshReviews, now, settings);
      tomorrow = dueTomorrow(freshCards, now, settings);
    } catch (err) {
      console.error(err);
    }
    if (!view.alive || phase !== 'summary' || seq !== summarySeq) return;

    const c = session.counters();
    const left = session.remaining();
    clear(cardArea);
    cardArea.appendChild(h('h2', { class: 'summary-title' }, 'Sesión terminada'));
    cardArea.appendChild(
      h(
        'div',
        { class: 'stats' },
        summaryStat(c.done, 'tarjetas revisadas'),
        summaryStat(c.newSeen, 'nuevas'),
        summaryStat(fmtClock(frozenMs), 'tiempo'),
        summaryStat(racha === null ? '—' : `${racha} ${racha === 1 ? 'día' : 'días'}`, 'racha')
      )
    );
    cardArea.appendChild(
      h(
        'div',
        { class: 'rating-counts' },
        RATINGS.map((r) => h('span', { class: 'rating-count rate-' + r.css }, `${r.label}: ${c[r.counter]}`))
      )
    );
    if (left > 0) {
      cardArea.appendChild(
        h('p', { class: 'muted small' }, `${left === 1 ? 'Queda 1 tarjeta' : 'Quedan ' + left + ' tarjetas'} para hoy. Puedes seguir más tarde desde Inicio.`)
      );
    }
    if (tomorrow !== null) {
      cardArea.appendChild(h('p', { class: 'hint-ko' }, `내일 복습 예정: ${tomorrow}장`));
    }
    cardArea.appendChild(homeButton());
    if (session.canUndo()) {
      cardArea.appendChild(
        h(
          'div',
          { class: 'review-undo-row review-undo-center' },
          h('button', { class: 'review-undo', type: 'button', onclick: onUndo }, 'Deshacer la última respuesta')
        )
      );
    }
  }

  function summaryStat(value, label) {
    return h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, String(value)), h('div', { class: 'stat-label' }, label));
  }

  // ------------------------------------------------------------ keyboard (desktop)

  function onKeydown(ev) {
    if (!view.alive || isSheetOpen()) return;
    const target = ev.target;
    const tag = (target && target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (target && target.isContentEditable)) return;

    const key = ev.key;
    const lower = typeof key === 'string' ? key.toLowerCase() : '';

    // Undo: 'z' alone, or Ctrl/Cmd+Z. With the Korean keyboard active ev.key is not 'z'
    // ('Process' or 'ㅋ'), so the physical key (ev.code) counts too when ev.key is not a Latin letter.
    const isZ = lower === 'z' || (ev.code === 'KeyZ' && !/^[a-z]$/.test(lower));
    if (isZ && !ev.altKey) {
      ev.preventDefault();
      onUndo();
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    if (key === 'Escape') {
      ev.preventDefault();
      goHome();
      return;
    }
    if (phase !== 'card' || busy) return;

    if (key === ' ' || key === 'Spacebar' || key === 'Enter') {
      // A focused button or link handles Space/Enter itself.
      if (tag === 'BUTTON' || tag === 'A') return;
      ev.preventDefault(); // Space must not scroll the page
      reveal();
      return;
    }
    if (revealed && (key === '1' || key === '2' || key === '3' || key === '4')) {
      ev.preventDefault();
      onRate(Number(key));
    }
  }
}
