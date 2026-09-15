# c2vocab — notes for Claude Code sessions

Personal Spanish C2 (DELE) vocabulary app for a Korean learner. Vanilla HTML/CSS/JS, IndexedDB via Dexie,
served as plain static files. The owner is not a developer: explain changes step by step, keep code readable.

## Folder layout

```
c2vocab/
  index.html          app shell (top bar, #view, FAB, bottom nav, toast/sheet roots)
  styles.css          mobile-first, iOS-safe styles; desktop >= 800px centred 720px column
  test.html           browser test runner (open /test.html)
  start.bat           double-click: python -m http.server 8080 + opens the browser
  js/
    app.js            entry: hash router (#/, #/explorar, #/papelera), nav, FAB, cards-changed refresh
    util.js           uuid, nowIso, normalize, escapeHtml, debounce, fmtDate, sleep
    taxonomy.js       TYPES, REGISTERS, REGIONS, STATUSES, DIRECTIONS, SUGGESTED_TEMAS
    srs.js            initialState() / initialSrs() only (scheduler comes in step 2)
    capture.js        parseCapture(text, defaults) quick-add mini-language (pure) + SYNTAX_HELP_KO
    db.js             createDb(name) factory, default db 'c2vocab', all data-access functions
    tests.js          tests for util/capture/srs/db (db tests use database 'c2vocab_test')
    ui/
      components.js   h() DOM builder, toast, openSheet/closeSheet, chip, badge, emitCardsChanged
      home.js         Inicio: counts, disabled Estudiar, Cargar ejemplos, Añadir
      quickadd.js     bottom-sheet quick add with live preview
      explorar.js     search + filters + list + inline edit + soft delete
      papelera.js     deleted cards with Restaurar
  seeds/base.json     20 example cards loaded by 'Cargar ejemplos' (array of partial cards, or {cards:[...]})
  vendor/dexie.min.js Dexie 4.0.11 UMD build (pinned; defines window.Dexie)
  docs/plan.json      the full design plan (steps 1-12)
```

## Hard rules

- Vanilla ES modules only. NO build step, NO npm, NO Node, NO CDN/runtime loads (the app must work offline
  from step 4). The only library is `./vendor/dexie.min.js`, loaded as a classic `<script>` BEFORE the module.
- ALL paths are relative (`./js/app.js`, `./seeds/base.json`). Never a leading slash: the same files are
  served from `https://<user>.github.io/c2vocab/` later.
- Served with `python -m http.server 8080` (plain static files). No service worker until step 4.
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

## Dexie schema (version 1)

```
cards:   'id, updatedAt, deletedAt, type, status, *tags, srs.rec.due, srs.prod.due'
reviews: 'id, cardId, ts'
meta:    'key'          rows: schemaVersion, deviceId, deviceName, algo, settings, lastChoice
backups: '++id, createdAt'
```

## Quick-add mini-language (capture.js)

Entries separated by blank lines. Line 1 = front (or `front :: back | example`). Then `: back`, `= ko`,
`> example`, `# tags`, `@ source`; unknown lines append to back. Front-only entries become `status: 'inbox'`.

## How to run / test

- Run: double-click `start.bat`, or `python -m http.server 8080` in this folder, then http://localhost:8080
- Test: http://localhost:8080/test.html — every row must say PASS; the tab title shows "N passed, M failed".
- Debug in the console: `await __c2.db.listCards()`.

## Step status (see docs/plan.json → step_plan)

1. 뼈대 + 저장소 + 빠른 추가 + 개인 사전 (PC) — DONE
2. SM-2 엔진 + 일일 복습 화면 (reconocimiento) — pending
3. 내보내기/가져오기/병합 + 백업 + Claude 대량 붙여넣기 — pending
4. PWA + GitHub Pages + 폰 설치 — pending
5. Producción/cloze 방향 + Bandeja — pending
6. 데이터 안전 강화 (마이그레이션 틀, 스키마 가드) — pending
7. 통계 + 학습량 설정 + 시험일 — pending
8. Dropbox 연결 + 첫 동기화 — pending
9. 동기화 안정화 — pending
10. 빠른 수집 다듬기 + Claude 루프 — pending
11. 시험 도구 (DELE 모드) — pending
12. 장기 유지보수 — pending
