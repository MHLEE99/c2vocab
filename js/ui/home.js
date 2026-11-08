// Inicio: today's study numbers, Estudiar buttons, library counts, seed loader, quick add.

import { listCards, listReviews, getSettings, getMeta, setMeta, allCardsIncludingDeleted, importCards } from '../db.js';
import { planSeeds } from '../seeds.js';
import { fmtDate, nowIso } from '../util.js';
import { queueInfo, isEligible } from '../session.js';
import { countsToday, streak } from '../stats-lite.js';
import { studyDay, resolveSettings } from '../srs.js';
import { exportReminder, exportReminderText } from '../reminder.js';
import { isIos, isIosSafari, isStandalone, installHint, onboardingHint } from '../platform.js';
import { exportToastText, runExport } from './ajustes.js';
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
  const [cards, reviews, settings, snoozedDay, installSnoozeDay] = await Promise.all([
    listCards({ deleted: false }),
    listReviews(),
    getSettings(),
    getMeta('exportSnoozeDay'),
    getMeta('installHintSnoozeDay'),
  ]);

  // ---- today's study numbers (same calculation as the Estudiar screen)
  const now = nowIso();
  const today = countsToday(reviews, now, settings);
  // reviewsDone = answers to review-state cards only (new/learning answers do not use up the review limit)
  const info = queueInfo({ cards, now, settings, newSeenToday: today.newSeen, reviewsDoneToday: today.reviewsDone });
  const racha = streak(reviews, now, settings);
  const studyable = cards.filter(isEligible).length;

  // ---- export reminder (only when there is something to lose)
  const dayNow = studyDay(now, resolveSettings(settings).dayBoundaryHour);
  const reminder = exportReminder({
    cardCount: cards.length,
    lastExportAt: settings.lastExportAt,
    lastSyncAt: settings.lastSyncAt,
    snoozedDay,
    today: dayNow,
    nowIso: now,
  });
  if (reminder) container.appendChild(exportBanner(reminder, dayNow));

  // ---- iPhone: "add to the home screen" banner (browser tab, not installed, not snoozed today);
  //      in Chrome / KakaoTalk / other iOS webviews it says to open the address in Safari instead
  const hint = installHint({
    ios: isIos(navigator.userAgent, navigator.maxTouchPoints || 0),
    safari: isIosSafari(navigator.userAgent, navigator.maxTouchPoints || 0),
    standalone: isStandalone({
      navigatorStandalone: navigator.standalone === true,
      matchMediaStandalone: typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches,
    }),
    snoozeDay: installSnoozeDay,
    today: dayNow,
    cardCount: cards.length,
  });
  if (hint) container.appendChild(installBanner(dayNow, hint.kind));

  // ---- empty database: import the file from the other device BEFORE loading the examples.
  //      While the iOS install banner shows, the import must wait: iOS keeps separate storage for
  //      a browser tab and for the installed app, so importing here would leave the app empty.
  const onboarding = onboardingHint({ cardCount: cards.length, install: hint });
  if (onboarding) container.appendChild(emptyDbBanner(onboarding));

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
      "'Añadir' 또는 오른쪽 아래 '+' 버튼으로 표현을 빠르게 저장합니다.\n'Cargar ejemplos'는 미리 준비된 예시 카드 20장을 넣어 줍니다(이미 있는 카드는 건너뛰고, 예문 해석만 비어 있으면 채워 줍니다)."
    )
  );
}

/** The 'you have not exported for a while' banner with its two buttons. */
function exportBanner(reminder, today) {
  const exportBtn = h(
    'button',
    {
      class: 'btn btn-primary',
      type: 'button',
      onclick: async () => {
        exportBtn.disabled = true;
        try {
          const result = await runExport();
          toast(exportToastText(result));
          if (result.method !== 'cancelled') banner.remove(); // lastExportAt is set: no reminder for 7 days
        } catch (err) {
          console.error(err);
          toast('No se pudo exportar: ' + (err && err.message ? err.message : err));
        } finally {
          exportBtn.disabled = false;
        }
      },
    },
    'Exportar ahora'
  );
  const laterBtn = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        banner.remove();
        // Snooze until the next study day.
        await setMeta('exportSnoozeDay', today);
      },
    },
    'Más tarde'
  );
  const banner = h(
    'div',
    { class: 'banner banner-warn', role: 'status' },
    h('div', { class: 'banner-title' }, exportReminderText(reminder)),
    h(
      'p',
      { class: 'hint-ko' },
      "데이터는 이 브라우저 안에만 있습니다. 'Exportar ahora'를 누르면 카드와 복습 기록 전체가 파일 하나로 저장됩니다 (일주일에 한 번 권장)."
    ),
    h('div', { class: 'btn-row' }, exportBtn, laterBtn)
  );
  return banner;
}

/**
 * iPhone: how to install the app on the home screen. 'Más tarde' hides it until the next study day.
 *   kind 'ios'        Safari: share button -> add to home screen
 *   kind 'ios-other'  Chrome / KakaoTalk / another webview: open the address in Safari first
 */
function installBanner(today, kind) {
  const safari = kind !== 'ios-other';
  const laterBtn = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        banner.remove();
        await setMeta('installHintSnoozeDay', today);
      },
    },
    'Más tarde'
  );
  // Other iOS browsers cannot add to the home screen: offer to copy the address for Safari.
  const copyBtn = safari
    ? null
    : h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: async () => {
            const address = window.location.href.split('#')[0];
            try {
              await navigator.clipboard.writeText(address);
              toast('Dirección copiada: ' + address);
            } catch (err) {
              // Some webviews block the clipboard: show the address so it can be typed.
              toast('Abre en Safari: ' + address);
            }
          },
        },
        'Copiar dirección'
      );
  const banner = h(
    'div',
    { class: 'banner banner-info', role: 'status' },
    h('div', { class: 'banner-title' }, safari ? 'Instala C2 Vocab en la pantalla de inicio' : 'Abre C2 Vocab en Safari'),
    h(
      'p',
      { class: 'hint-ko' },
      safari
        ? '사파리 아래 공유 버튼 → 홈 화면에 추가. 설치한 앱 안에서 써야 데이터가 안전하게 유지됩니다.'
        : '이 브라우저(Chrome, 카카오톡 등)에서는 홈 화면에 설치할 수 없습니다. 주소를 복사해 Safari에 붙여넣어 연 다음, 공유 버튼 → 홈 화면에 추가를 하세요.'
    ),
    h('div', { class: 'btn-row' }, copyBtn, laterBtn)
  );
  return banner;
}

/**
 * No cards yet: tell a learner who already has data elsewhere to import it first.
 *   kind 'import'         Ajustes -> Importar (with a button) before 'Cargar ejemplos'
 *   kind 'install-first'  an iOS browser tab: install first, then import INSIDE the installed app
 *                         (no Importar button: an import here would not reach the installed app)
 */
function emptyDbBanner(kind) {
  const installFirst = kind === 'install-first';
  return h(
    'div',
    { class: 'banner banner-info', role: 'status' },
    h('div', { class: 'banner-title' }, 'Empezar en este dispositivo'),
    h(
      'p',
      { class: 'hint-ko' },
      installFirst
        ? "지금은 브라우저 탭에서 보고 있습니다. iOS는 홈 화면 앱과 브라우저 탭의 데이터를 따로 보관하기 때문에, 여기서 가져온 카드는 설치한 앱에 나타나지 않습니다.\n먼저 홈 화면에 설치하고, 설치한 앱 안에서 Ajustes → Importar로 PC에서 내보낸 파일을 가져오세요. 'Cargar ejemplos'도 그 안에서 누르세요."
        : "다른 기기(PC 등)에 이미 카드가 있다면, 먼저 그쪽에서 'Exportar todo'로 만든 파일을 여기로 가져오세요: Ajustes → Importar → Elegir archivo.\n'Cargar ejemplos'는 그 다음에 누르세요. 처음부터 새로 시작한다면 바로 'Añadir'나 'Cargar ejemplos'를 눌러도 됩니다."
    ),
    installFirst ? null : h('div', { class: 'btn-row' }, h('a', { class: 'btn', href: '#/importar' }, 'Importar'))
  );
}

/** Fetch ./seeds/base.json and write what planSeeds (js/seeds.js) decides: new seeds, missing example translations. */
async function loadSeeds(button) {
  button.disabled = true;
  try {
    const res = await fetch(SEEDS_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rows = Array.isArray(json) ? json : Array.isArray(json && json.cards) ? json.cards : [];
    if (rows.length === 0) throw new Error('el archivo no contiene tarjetas');

    // Pure plan: new seeds (ids 'seed:' + dupKey), the Korean translation for cards that still
    // show the seed's example without one, nothing for seeds the learner deleted.
    const plan = planSeeds(rows, await allCardsIncludingDeleted());
    await importCards({ toAdd: plan.toAdd, toUpdate: plan.toUpdate }); // ONE transaction
    const c = plan.counts;
    let msg = `${c.added} tarjetas añadidas, ${c.existing} ya existían`;
    if (c.updated) msg += `, ${c.updated} con la traducción del ejemplo añadida`;
    if (c.trashed) msg += `, ${c.trashed} en la papelera`;
    if (c.invalid) msg += `, ${c.invalid} inválidas`;
    toast(msg);
    if (c.added > 0 || c.updated > 0) emitCardsChanged();
  } catch (err) {
    console.error(err);
    toast('No se pudieron cargar los ejemplos: ' + (err && err.message ? err.message : err));
  } finally {
    button.disabled = false;
  }
}
