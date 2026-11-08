// Ajustes: backup (export / import / automatic copies), device name, storage, data counts.

import { allCardsIncludingDeleted, listReviews, getSettings, getMeta, setMeta, SCHEMA_VERSION } from '../db.js';
import { exportFile } from '../export.js';
import { listBackups } from '../backup.js';
import { fmtDate } from '../util.js';
import { APP_VERSION } from '../version.js';
import { isStandalone } from '../platform.js';
import { checkForUpdate, isUpdateAvailable, canInstall, promptInstall } from '../sw-client.js';
import { h, toast, openSheet, closeSheet } from './components.js';

function errorText(err) {
  return err && err.message ? err.message : String(err);
}

/** Toast text for the result of exportFile(). */
export function exportToastText(result) {
  if (result.method === 'cancelled') return 'Exportación cancelada';
  const n = result.counts.cards;
  const what = `${n} ${n === 1 ? 'tarjeta' : 'tarjetas'}, ${result.counts.reviews} repasos`;
  if (result.method === 'share') return `Exportado (${what})`;
  return `Exportado: ${result.filename} (${what})`;
}

/**
 * exportFile() plus the one case that needs the screen: when the iPhone refuses the share
 * sheet because the tap is too old (result 'blocked'), show a small sheet whose button
 * opens the share sheet directly from a new tap. Returns the final exportFile result
 * ('share' | 'download' | 'cancelled'); lastExportAt is only set when a file really left the app.
 */
export async function runExport() {
  const first = await exportFile();
  if (first.method !== 'blocked') return first;

  return new Promise((resolve, reject) => {
    let outcome = { method: 'cancelled', filename: first.filename, counts: first.counts };
    let failure = null;
    const shareBtn = h(
      'button',
      {
        class: 'btn btn-primary',
        type: 'button',
        onclick: () => {
          shareBtn.disabled = true;
          // shareNow() calls navigator.share() immediately: nothing may be awaited before it.
          first
            .shareNow()
            .then((result) => {
              outcome = result;
            })
            .catch((err) => {
              failure = err;
            })
            .then(() => closeSheet());
        },
      },
      'Compartir archivo'
    );
    const cancelBtn = h('button', { class: 'btn', type: 'button', onclick: () => closeSheet() }, 'Cancelar');
    openSheet(
      h(
        'div',
        { class: 'form' },
        h('h2', { class: 'sheet-title' }, 'El archivo está listo'),
        h('p', { class: 'muted small' }, first.filename),
        h('p', { class: 'hint-ko' }, "파일이 준비되었습니다. 'Compartir archivo'를 누르면 공유 창이 열립니다 → '파일에 저장'이나 Dropbox, 카카오톡을 고르세요."),
        h('div', { class: 'sheet-actions' }, cancelBtn, shareBtn)
      ),
      {
        // Every way of closing the sheet (button, backdrop, Escape) ends the export.
        onClose: () => {
          if (failure) reject(failure);
          else resolve(outcome);
        },
      }
    );
  });
}

/** 'si' | 'no' | 'no-disponible': asks the browser when it can, else uses the cached answer. */
async function persistenceState() {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : null;
  if (!storage || typeof storage.persisted !== 'function') {
    return (await getMeta('storagePersist')) || 'no-disponible';
  }
  try {
    return (await storage.persisted()) ? 'si' : 'no';
  } catch (err) {
    return (await getMeta('storagePersist')) || 'no-disponible';
  }
}

function persistenceLabel(state) {
  if (state === 'si') return 'sí';
  if (state === 'no') return 'no';
  return 'no disponible';
}

function dataRow(label, value) {
  return h('div', { class: 'data-row' }, h('span', { class: 'data-label' }, label), h('span', { class: 'data-value' }, String(value)));
}

export async function render(container) {
  const [cards, reviews, settings, deviceName, schemaVersion, backups, persist] = await Promise.all([
    allCardsIncludingDeleted(),
    listReviews(),
    getSettings(),
    getMeta('deviceName'),
    getMeta('schemaVersion'),
    listBackups(),
    persistenceState(),
  ]);

  // ------------------------------------------------------------ Copia de seguridad

  container.appendChild(h('h2', { class: 'section-title section-title-first' }, 'Copia de seguridad'));

  const lastLine = h('p', { class: 'count-line' });
  function showLastExport(iso) {
    lastLine.textContent = 'Última exportación: ' + (iso ? fmtDate(iso) : 'nunca');
  }
  showLastExport(settings.lastExportAt);

  const exportBtn = h(
    'button',
    {
      class: 'btn btn-primary btn-block',
      type: 'button',
      onclick: async () => {
        exportBtn.disabled = true;
        try {
          const result = await runExport();
          toast(exportToastText(result));
          if (result.method !== 'cancelled') showLastExport((await getSettings()).lastExportAt);
        } catch (err) {
          console.error(err);
          toast('No se pudo exportar: ' + errorText(err));
        } finally {
          exportBtn.disabled = false;
        }
      },
    },
    'Exportar todo'
  );
  container.appendChild(exportBtn);
  container.appendChild(lastLine);
  container.appendChild(
    h(
      'p',
      { class: 'hint-ko' },
      "카드, 삭제한 카드, 복습 기록, 설정이 모두 파일 하나(.json)에 들어갑니다.\n아이폰: 공유 창이 열립니다 → '파일에 저장'이나 Dropbox, 카카오톡을 고르세요.\nPC: '다운로드' 폴더에 파일이 저장됩니다."
    )
  );

  container.appendChild(
    h(
      'div',
      { class: 'btn-row' },
      h('a', { class: 'btn', href: '#/importar' }, 'Importar'),
      h('a', { class: 'btn', href: '#/copias' }, `Copias automáticas (${backups.length})`)
    )
  );
  container.appendChild(
    h('p', { class: 'hint-ko' }, 'Importar: 내보낸 파일을 다시 합치거나, Claude가 만든 카드를 한꺼번에 붙여넣습니다.\nCopias automáticas: 앱이 브라우저 안에 자동으로 만들어 둔 복사본으로 되돌립니다.')
  );

  // ------------------------------------------------------------ Dispositivo

  container.appendChild(h('h2', { class: 'section-title' }, 'Dispositivo'));

  const nameInput = h('input', {
    type: 'text',
    id: 'device-name',
    value: deviceName || '',
    maxlength: '40',
    autocomplete: 'off',
    autocapitalize: 'off',
  });
  const saveNameBtn = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        const name = nameInput.value.trim();
        if (name === '') {
          toast('Escribe un nombre para este dispositivo');
          return;
        }
        try {
          await setMeta('deviceName', name);
          nameInput.value = name;
          toast('Nombre guardado');
        } catch (err) {
          console.error(err);
          toast('No se pudo guardar: ' + errorText(err));
        }
      },
    },
    'Guardar'
  );
  container.appendChild(
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'device-name' }, 'Nombre de este dispositivo'),
      h('div', { class: 'inline-row' }, nameInput, saveNameBtn)
    )
  );
  container.appendChild(h('p', { class: 'hint-ko' }, '내보낸 파일 이름과 가져오기 화면에 표시되는 이 기기의 이름입니다 (예: iPhone, PC).'));

  const persistLine = h('p', { class: 'count-line' }, 'Almacenamiento persistente: ' + persistenceLabel(persist));
  container.appendChild(persistLine);
  const canAsk = typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function';
  if (persist === 'no' && canAsk) {
    const askBtn = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: async () => {
          askBtn.disabled = true;
          try {
            const granted = await navigator.storage.persist();
            await setMeta('storagePersist', granted ? 'si' : 'no');
            persistLine.textContent = 'Almacenamiento persistente: ' + persistenceLabel(granted ? 'si' : 'no');
            toast(granted ? 'Almacenamiento persistente activado' : 'El navegador no lo ha concedido todavía');
            if (granted) askBtn.hidden = true;
          } catch (err) {
            console.error(err);
            toast('No se pudo solicitar: ' + errorText(err));
          } finally {
            askBtn.disabled = false;
          }
        },
      },
      'Solicitar de nuevo'
    );
    container.appendChild(h('div', { class: 'btn-row' }, askBtn));
  }
  container.appendChild(
    h(
      'p',
      { class: 'hint-ko' },
      "'sí'이면 브라우저가 저장 공간이 부족해도 이 앱의 데이터를 마음대로 지우지 않습니다.\n'no'여도 평소에는 문제없지만, 정기적으로 'Exportar todo'를 해 두세요.\n아이폰: 앱을 홈 화면에 설치하면(아래 'Instalación') 데이터가 더 안전하게 보관됩니다."
    )
  );

  // ------------------------------------------------------------ Instalación

  container.appendChild(h('h2', { class: 'section-title' }, 'Instalación'));
  const standalone = isStandalone({
    navigatorStandalone: navigator.standalone === true,
    matchMediaStandalone: typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches,
  });
  container.appendChild(
    h(
      'div',
      { class: 'data-list' },
      dataRow('Instalada como app', standalone ? 'sí' : 'no'),
      dataRow('Versión', APP_VERSION),
      dataRow('Nueva versión lista', isUpdateAvailable() ? 'sí' : 'no')
    )
  );

  const updateBtn = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        updateBtn.disabled = true;
        try {
          const result = await checkForUpdate();
          if (result === 'sin-sw') toast('Sin service worker (modo desarrollo o navegador sin soporte)');
          else if (result === 'disponible') toast("Nueva versión lista: pulsa 'Actualizar' en el aviso");
          else if (result === 'descargando') toast('Descargando la nueva versión…');
          else toast('Ya tienes la última versión');
        } catch (err) {
          console.error(err);
          toast('No se pudo comprobar: ' + errorText(err));
        } finally {
          updateBtn.disabled = false;
        }
      },
    },
    'Buscar actualización'
  );
  const installRow = h('div', { class: 'btn-row' }, updateBtn);
  container.appendChild(installRow);

  // Chrome / Edge / Android offer an install dialog; the button appears when the browser allows it.
  function addInstallButton() {
    if (!canInstall() || installRow.querySelector('.install-btn')) return;
    const installBtn = h(
      'button',
      {
        class: 'btn btn-primary install-btn',
        type: 'button',
        onclick: async () => {
          installBtn.disabled = true;
          try {
            const outcome = await promptInstall();
            if (outcome === 'accepted') {
              toast('Instalada: ábrela desde el icono de la pantalla de inicio');
              installBtn.remove();
            } else if (outcome === 'dismissed') {
              toast('Instalación cancelada');
              installBtn.remove(); // the browser gives one prompt per visit
            } else {
              toast('El navegador no ofrece la instalación ahora');
              installBtn.remove();
            }
          } catch (err) {
            console.error(err);
            toast('No se pudo instalar: ' + errorText(err));
            installBtn.disabled = false;
          }
        },
      },
      'Instalar'
    );
    installRow.appendChild(installBtn);
  }
  addInstallButton();
  // The browser may fire beforeinstallprompt after this screen was drawn.
  function onInstallAvailable() {
    if (!installRow.isConnected) {
      // This render was replaced by a newer one: stop listening for it.
      document.removeEventListener('c2:install-available', onInstallAvailable);
      return;
    }
    addInstallButton();
  }
  document.addEventListener('c2:install-available', onInstallAvailable);

  container.appendChild(
    h(
      'p',
      { class: 'hint-ko' },
      "아이폰에 설치하기: Safari로 https://mhlee99.github.io/c2vocab/ 를 열고 → 아래 공유 버튼(네모에 화살표) → '홈 화면에 추가' → 추가. 그다음부터는 홈 화면의 'C2 Vocab' 아이콘으로 엽니다.\n새 버전이 나오면 앱 아래에 'Nueva versión disponible' 알림이 뜹니다. 'Actualizar'를 누르면 새로 고침됩니다. 'Buscar actualización'은 지금 바로 확인합니다."
    )
  );
  container.appendChild(
    h(
      'p',
      { class: 'hint-ko warn-text' },
      '주의: iOS는 홈 화면 앱과 Safari 탭의 데이터를 따로 보관합니다. 데이터 가져오기(Importar)는 반드시 설치한 앱 안에서 하세요.'
    )
  );

  // ------------------------------------------------------------ Datos

  container.appendChild(h('h2', { class: 'section-title' }, 'Datos'));
  const deleted = cards.filter((c) => c.deletedAt).length;
  const undone = reviews.filter((r) => r.undoneAt).length;
  container.appendChild(
    h(
      'div',
      { class: 'data-list' },
      dataRow('Tarjetas', cards.length - deleted),
      dataRow('En papelera', deleted),
      dataRow('Repasos', reviews.length - undone),
      dataRow('Versión del esquema', schemaVersion || SCHEMA_VERSION)
    )
  );
}
