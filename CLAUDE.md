# c2vocab — notes for Claude Code sessions

Personal Spanish C2 (DELE) vocabulary app for a Korean learner. Vanilla HTML/CSS/JS, IndexedDB via Dexie,
served as plain static files. The owner is not a developer: explain changes step by step, keep code readable.

## Folder layout

```
c2vocab/
  index.html          app shell (top bar, #view, FAB, bottom nav, toast/sheet roots)
  styles.css          mobile-first, iOS-safe styles; desktop >= 800px centred 720px column
  test.html           browser test runner (open /test.html)
  start.bat           double-click: python tools/serve.py 8080 + opens the browser
  tools/serve.py      static server with Cache-Control: no-store and correct JS MIME type (--lan for phone testing)
  js/
    app.js            entry: hash router (#/, #/explorar, #/papelera, #/ajustes, #/estudiar[?modo=nuevas],
                      #/importar, #/copias), nav, FAB, view lifecycle (optional destroy()), cards-changed
                      refresh (skipped on #/estudiar), one-time navigator.storage.persist() request
    util.js           uuid, nowIso, normalize, escapeHtml, debounce, fmtDate, sleep
    taxonomy.js       TYPES, REGISTERS, REGIONS, STATUSES, DIRECTIONS, SUGGESTED_TEMAS
    srs.js            pure SM-2 scheduler: SM2, next, predict, replay, studyDay, isDue, isSubDayLearning
    session.js        buildQueue / queueInfo (pure) + createSession in-memory controller (no database)
    stats-lite.js     countsToday, streak, dueTomorrow (pure, over review rows)
    capture.js        parseCapture(text, defaults) quick-add mini-language (pure) + SYNTAX_HELP_KO
    db.js             createDb(name) factory, default db 'c2vocab', all data-access functions; hydrateCard,
                      CARD_KEYS/CONTENT_KEYS; step 3: allCardsIncludingDeleted, updateSettings,
                      applyDocChanges, importCards, addBackup/listBackups/getBackup
    merge.js          PURE: validateEnvelope, mergeDoc (import/sync merge), restoreDoc (revert to a snapshot)
    importer.js       PURE: parseImport (envelope / JSON / TSV / pipe lines / captura), classifyRows,
                      enrichPatch, overwritePatch
    export.js         buildEnvelope, exportFilename, envelopeCounts, exportFile (share sheet or download)
    backup.js         createBackupApi(db): snapshot ring buffer, previewRestore/restoreBackup,
                      previewImportEnvelope/importEnvelope, existingCardMap, planCardImport/commitCardImport
    prompt.js         PURE: buildPrompt({tema, tipo, cantidad, inboxFronts}) - the text copied into Claude
    reminder.js       PURE: exportReminder / exportReminderText (Inicio banner after 7 days without export)
    tests.js          test entry: util/capture/db tests (db tests use database 'c2vocab_test'), calls run()
    tests/            harness.js (test/assert/eq/deepEq/throws/run) + srs, session, stats, merge, importer,
                      backup (export/backup/db step 3), prompt, reminder .test.js files
    ui/
      components.js   h() DOM builder, toast, openSheet/closeSheet, chip, badge, emitCardsChanged
      home.js         Inicio: export reminder banner, today's numbers (queueInfo/countsToday/streak),
                      Estudiar, Nuevas del día, library counts, Cargar ejemplos, Añadir
      review.js       Estudiar: session screen (front -> reveal -> 4 ratings), undo, time-limit sheet,
                      summary (takes a 'session' snapshot); exports render(container, params) + destroy()
      ajustes.js      Ajustes: Exportar todo, links to Importar / Copias, device name, storage persistence,
                      data counts; runExport() (exportFile + 'Compartir archivo' sheet), exportToastText
      importar.js     Importar (#/importar): paste/file -> preview -> import cards or merge an export file;
                      'Pedir tarjetas a Claude' (Copiar prompt). State is module-level (survives re-render)
      copias.js       Copias automáticas (#/copias): list of snapshots, Crear copia ahora, Restaurar sheet
      quickadd.js     bottom-sheet quick add with live preview
      explorar.js     search + filters + list + inline edit + soft delete
      papelera.js     deleted cards with Restaurar
  seeds/base.json     20 example cards loaded by 'Cargar ejemplos' (array of partial cards, or {cards:[...]})
  vendor/dexie.min.js Dexie 4.0.11 UMD build (pinned; defines window.Dexie)
  docs/plan.json      the full design plan (steps 1-12)
  docs/PROMPT.md      the Claude prompt (mirror of js/prompt.js) + the weekly routine, in Korean
  tools/verify_export.py   python tools/verify_export.py <file.json> - validates an export file (stdlib only)
  imports/            (git-ignored) hand-written or Claude-written card files to load through Importar
  exports/            (git-ignored) a place to keep exported files
```

## Hard rules

- Vanilla ES modules only. NO build step, NO npm, NO Node, NO CDN/runtime loads (the app must work offline
  from step 4). The only library is `./vendor/dexie.min.js`, loaded as a classic `<script>` BEFORE the module.
- ALL paths are relative (`./js/app.js`, `./seeds/base.json`). Never a leading slash: the same files are
  served from `https://<user>.github.io/c2vocab/` later.
- Served with `python tools/serve.py` (plain static files, no caching). No service worker until step 4.
- UI labels in SPANISH (Inicio, Explorar, Papelera, Guardar, Cancelar, Buscar, Restaurar, Eliminar,
  Deshacer...). Short helper text in KOREAN where the learner needs guidance. `<html lang="es">`.
- Mobile-first, iPhone Safari safe: `viewport-fit=cover` + `env(safe-area-inset-*)`, >= 44px tap targets,
  inputs/textarea font-size >= 16px (no auto-zoom), no hover-only affordances,
  `-webkit-tap-highlight-color: transparent`, bottom nav reachable by thumb.
- NEVER hard-delete a card. Delete = set `deletedAt` (ISO) and bump `updatedAt`. Papelera restores by
  setting `deletedAt = null` and bumping `updatedAt`. There is no "empty trash".
- Every content edit bumps `updatedAt` (nowIso). `createdAt` never changes.
- Multi-record writes go in ONE Dexie transaction (`addCards`, `initMeta`).
- Schema changes require a Dexie migration (`db.version(2).stores(...).upgrade(...)`) — framework in step 6.
  Until then the schema is frozen at version 1.
- Dexie 4.0.11 is pinned in `vendor/`. Do not upgrade casually.
- IndexedDB cannot index `null`: `deletedAt: null` rows are absent from that index. Load with `toArray()`
  and filter in JS (`listCards`). Never `where('deletedAt').equals(null)`.
- A rating NEVER bumps `updatedAt` (`applyReview` / `undoReview`): `updatedAt` is for content edits; `srs` is
  a cache that can be recomputed from the review log with `replay()`.
- Reviews are append-only. Undo only marks the row with `undoneAt` (ISO); review rows are NEVER deleted.
  Readers skip rows with `undoneAt` or `mode !== 'srs'`.
- Scheduler/queue/stats functions (`srs.js`, `session.js`, `stats-lite.js`) are pure: no `Date.now()`, no
  database, `now` is always an ISO-string parameter.
- Day-level due dates (state `review`, or learning on a >= 1440 min step) are compared by study day:
  `studyDay(due) <= studyDay(now)` (day boundary 04:00 local). Only sub-day learning compares `due <= now`.
- Views export `render(container, params)`; a view with timers/listeners also exports `destroy()`, which the
  router calls before showing another route. `#/estudiar` is not in the bottom nav, hides the FAB, and is
  never rebuilt by the cards-changed refresh (that would reset the running session).
- The review screen persists every rating immediately (`applyReview`); undo writes the database first
  (`session.peekUndo()` -> `undoReview`) and only then rolls the in-memory session back (`session.undo()`).
- `applyReview(review, nextState, prevState)` refuses a rating when the stored srs is no longer at `prevState`
  (same card rated in another tab); `undoReview` only undoes the card's latest, not-yet-undone rating.
- The daily review limit uses `countsToday().reviewsDone` (answers to review-state cards), not `done`.
- The router renders each view into a detached element and shows it only if no newer render started
  (`renderInto` in `app.js`), so views must only append to the `container` they are given during `render`.
- Only rows of the `backups` table may ever be deleted (`addBackup` prunes to the 10 most recently STORED
  rows, by auto-increment id, so the row just added always survives a wrong device clock). No code
  path deletes cards or reviews: import, merge and restore only add or replace rows (`applyDocChanges`,
  `importCards`, each ONE transaction).
- `merge.js` and `importer.js` are pure (no database, no clock, inputs never mutated). The database side
  lives in `backup.js` / `export.js`; views call those, never Dexie directly.
- Merge (`mergeDoc`, used by Importar for export files and later by sync): cards by id, last-writer-wins on
  `updatedAt` for the WHOLE content including `deletedAt` (a newer delete beats an edit, a newer edit
  undeletes); equal `updatedAt` + different content -> the greater `deviceId` wins, equal deviceIds keep
  local. Reviews: union by id; `undoneAt` on either side wins (earliest). `srs` is a cache: recomputed with
  `replay()` for every affected card. Idempotent and commutative; unknown card fields are preserved.
  Incoming review rows that are new must be usable (string id, `cardId` of a card in the merged doc, `dir`
  rec/prod, parsable `ts`, numeric `rating` 1-4); the others are skipped and counted (`stats.reviewsInvalid`).
  Cards are matched by id ONLY: the same expression created on two devices stays as two cards; the result
  reports them (`duplicateKeys`, `stats.cardsDuplicateKey`) and Importar / Copias show a warning.
- Restore (`restoreDoc`, Copias automáticas): reverts card CONTENT to the snapshot and sets
  `updatedAt = now` (so the reverted version wins later merges); cards created after the snapshot are kept;
  reviews are only unioned: study history is never rolled back.
- Safety snapshots: `restoreBackup` ALWAYS takes a 'pre-restore' snapshot first; an import (`importEnvelope`,
  `commitCardImport`) takes a 'pre-import' snapshot only when it is going to write something (a no-op import
  uses no backup slot). `snapshot()` returns null when there are no cards at all; a snapshot that throws
  aborts the write.
- Snapshots: reasons 'session' (after a study session, at most one per 60 min), 'pre-import', 'pre-restore',
  'manual'; skipped when there are no cards. They live inside the browser: only 'Exportar todo' protects
  against clearing site data.
- Card-list imports always create FRESH cards: `id`, timestamps, `srs`, `status` in the rows are ignored.
  Duplicates (same `dupKey`, or the same front as an inbox card) follow the chosen mode: Omitir /
  Enriquecer (fill empty fields only, tags union) / Sobrescribir (replace content, keep srs and history).
  A row's type replaces the existing card's type only when the row itself carried it (`row.typeExplicit`
  from `classifyRows`), never when it is just 'Tipo por defecto' / 'otro'.
- `parseImport` tries the whole text as JSON BEFORE looking for a Markdown fence (a ``` inside a card's
  notes must not cut an export file apart); any object with `app: 'c2vocab'` is an envelope.
- Importar commits only the preview that matches the current inputs (`inputKey()` in `ui/importar.js`):
  changing the text or an option disables the old preview's buttons until the new preview is drawn.
- Extra meta rows since step 3: `storagePersist` ('si' | 'no' | 'no-disponible'), `exportSnoozeDay`
  (study day on which the export reminder was postponed). `settings.lastExportAt` is set by `exportFile`
  only when a file really left the app (share resolved or download started). Views call `runExport()`
  (`ui/ajustes.js`): when the iPhone refuses `navigator.share()` because the tap is too old (`method:
  'blocked'`), it shows a sheet whose 'Compartir archivo' button shares from a fresh tap.
- Small modules, short English comments, no clever one-liners.

## Card JSON contract (every stored card has every key)

```
{
  id: string (crypto.randomUUID; fallback generator if missing),
  type: 'locucion'|'colocacion'|'refran'|'marcador'|'falso_amigo'|'verbo_prep'|'variante'|'expresion'|'lexico'|'estructura'|'otro',
  front: string (required, trimmed),
  back: string ('' allowed only while status==='inbox'),
  ko: string,
  example: string (may contain [[gap]] markers),
  exampleSource: string ('' | 'redactado' | free text),
  exampleVerified: boolean (false),
  register: ''|'culto'|'neutro'|'coloquial'|'vulgar',
  region: string ('' | 'ES' | 'MX' | 'AR' | 'CO' | 'RioPlata' | 'general' | free),
  tags: string[] (lowercased, trimmed, unique, no leading '#'),
  colocaciones: string[],
  equivalentes: {texto: string, registro: string}[],
  contraste: string,
  source: string,
  notes: string,
  direction: 'both'|'rec'|'prod' (default 'both'),
  status: 'inbox'|'active'|'suspended' (inbox iff back is empty at creation; saving a back on an inbox card sets it active),
  createdAt: ISO string, updatedAt: ISO string, deletedAt: ISO string | null,
  srs: { rec: SrsState, prod: SrsState }
}
SrsState = { state:'new', due: null, intervalDays: 0, ease: 2.5, step: 0, reps: 0, lapses: 0, lastReviewAt: null }
```

Duplicates are detected by `normalize(front) + type` among non-deleted cards (`dupKey` / `findDuplicate`).

## Envelope (export files, in-app backups, later Dropbox sync)

```
{ app: 'c2vocab', schemaVersion: 1, exportedAt: ISO, deviceId, deviceName,
  cards: Card[]   (ALL cards, soft-deleted tombstones included),
  reviews: Review[] (ALL rows, undone ones included),
  settings }
```

`validateEnvelope` rejects a wrong `app`, missing arrays, and a `schemaVersion` newer than the app's.
File name: `c2vocab-YYYY-MM-DD-<deviceName>.json`. Check a file with `python tools/verify_export.py <file>`.

## Import JSON contract (files under imports/, or text pasted into Importar)

A JSON array of partial cards (or `{ "cards": [...] }`). Only `front` is required. Keys:
`front, back, ko, example ([[gap]] markers), exampleSource ('redactado' for invented examples), type,
register, region, tags (array or string), colocaciones (array, or string split on ';'), equivalentes
([{texto, registro}] or strings), contraste, source, notes, direction`. Spanish aliases are accepted
(`lema/expresión`, `definición/significado`, `ejemplo`, `tipo`, `registro`, `etiquetas`, `coreano`, `fuente`,
`notas`). `type` is matched leniently ('locución', 'falso amigo', 'verbo + prep.'); unknown -> 'otro' with a
warning. `id`, `createdAt`, `updatedAt`, `deletedAt`, `srs`, `status` are ignored. Also recognised: a
Markdown-fenced array, an array with prose around it, TSV (header row or positional
front/back/example/type/tags), pipe lines `front | back | example | tags`, and the quick-add mini-language.

## Dexie schema (version 1)

```
cards:   'id, updatedAt, deletedAt, type, status, *tags, srs.rec.due, srs.prod.due'
reviews: 'id, cardId, ts'
meta:    'key'          rows: schemaVersion, deviceId, deviceName, algo, settings, lastChoice,
                        storagePersist, exportSnoozeDay
backups: '++id, createdAt'   rows: { id, createdAt, reason, json (envelope string), cards, reviews }
```

## Quick-add mini-language (capture.js)

Entries separated by blank lines. Line 1 = front (or `front :: back | example`). Then `: back`, `= ko`,
`> example`, `# tags`, `@ source`; unknown lines append to back. Front-only entries become `status: 'inbox'`.

## How to run / test

- Run: double-click `start.bat`, or `python tools/serve.py` in this folder, then http://localhost:8080
- Test: http://localhost:8080/test.html — every row must say PASS; the tab title shows "N passed, M failed".
- Debug in the console: `await __c2.db.listCards()`.

## Step status (see docs/plan.json → step_plan)

1. 뼈대 + 저장소 + 빠른 추가 + 개인 사전 (PC) — DONE
2. SM-2 엔진 + 일일 복습 화면 (reconocimiento) — DONE
3. 내보내기/가져오기/병합 + 백업 + Claude 대량 붙여넣기 — DONE
4. PWA + GitHub Pages + 폰 설치 — pending
5. Producción/cloze 방향 + Bandeja — pending
6. 데이터 안전 강화 (마이그레이션 틀, 스키마 가드) — pending
7. 통계 + 학습량 설정 + 시험일 — pending
8. Dropbox 연결 + 첫 동기화 — pending
9. 동기화 안정화 — pending
10. 빠른 수집 다듬기 + Claude 루프 — pending
11. 시험 도구 (DELE 모드) — pending
12. 장기 유지보수 — pending

## Known follow-ups (decide in the step named)

- Step 4 (phone onboarding): on a new device the learner should IMPORT their export file (or sync) before
  pressing 'Cargar ejemplos'. Seed cards now get deterministic ids ('seed:' + dupKey), so seeds loaded on two
  fresh devices merge into one card; seeds loaded before 2026-10-03 have random ids and would duplicate.
- Step 8/9 (sync): cards merge by id only. The same expression created independently on two devices becomes two
  live cards; mergeDoc reports them (duplicateKeys, stats.cardsDuplicateKey) and the UI warns. Design a real
  duplicate resolution (canonical id + review remapping) before automatic sync.
- Step 7 (settings): no 'more new cards today' control yet (newPerDay fixed at 15); review.elapsedMs is not capped.
- Browser verification: use http://127.0.0.1:8080 for clean acceptance runs; agents test on http://localhost:8080.
