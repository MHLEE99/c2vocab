# c2vocab

DELE C2 준비를 위한 나만의 스페인어 표현 사전 + 간격 반복 복습 앱입니다.
설치할 프로그램 없이 브라우저에서만 동작하고, 데이터는 내 기기 안에만 저장됩니다.

## PC에서 실행하기

1. `start.bat`을 더블클릭합니다. (검은 창이 하나 열리고 브라우저가 http://localhost:8080 을 엽니다.)
   - 검은 창은 앱을 쓰는 동안 닫지 마세요. 다 쓰면 닫아도 됩니다.
2. 또는 이 폴더에서 직접 실행: `python tools/serve.py` → 브라우저에서 http://localhost:8080

Python이 설치되어 있어야 합니다(이미 설치되어 있습니다).

## 지금 할 수 있는 것

- **Inicio**: 오늘의 숫자(`pendientes` 복습할 카드, `nuevas` 오늘의 새 카드, `hechas hoy` 오늘 한 복습, `racha` 연속 학습 일수)와
  카드 수, 대기함(bandeja) 카드 수, 예문 없는 카드 수, 마지막 수정 시각을 봅니다.
  - `Estudiar (N)`: 오늘의 복습을 시작합니다. (아래 "공부하는 방법" 참고)
  - `Nuevas del día (M)`: 오늘의 새 카드만 공부합니다.
  - `Cargar ejemplos (20)`: 예시 카드 20장을 넣습니다. 이미 있는 카드는 건너뜁니다.
- **+ 버튼 / Añadir**: 표현을 빠르게 추가합니다. 여러 개를 한 번에 붙여넣을 수 있습니다.
- **Explorar**: 검색(악센트 없이 쳐도 찾습니다: `hincapie` → `hincapié`), 종류/레지스터/상태/태그 필터,
  카드를 눌러 `Editar`(수정) 또는 `Eliminar`(삭제). 삭제 직후 `Deshacer`로 되돌릴 수 있습니다.
- **Papelera**: 삭제한 카드 목록. `Restaurar`로 복원합니다. 카드는 절대 완전히 지워지지 않습니다.
- **Ajustes**: 백업(`Exportar todo`, `Importar`, `Copias automáticas`), 기기 이름, 데이터 개수를 봅니다.
  (아래 "백업과 복원", "Claude로 카드 대량 만들기" 참고)

## 공부하는 방법 (Estudiar)

1. Inicio에서 `Estudiar (N)`을 누릅니다. 카드의 **앞면(표현)** 만 보입니다. 뜻을 머릿속으로 떠올려 보세요.
2. `Mostrar respuesta`를 누르면 정의, 한국어 뜻, 예문 등이 나옵니다.
3. 얼마나 잘 기억했는지 네 개의 버튼 중 하나를 누릅니다. 버튼 아래에는 그 카드가 다시 나올 때까지의 간격이 표시됩니다.

| 버튼 | 뜻 | 결과 |
| --- | --- | --- |
| `Otra vez` | 기억나지 않음 | 약 10분 뒤, 같은 세션 안에서 다시 나옵니다 |
| `Difícil` | 겨우 기억남 | 간격이 조금만 늘어납니다 |
| `Bien` | 기억남 (보통은 이것) | 간격이 정상적으로 늘어납니다 |
| `Fácil` | 아주 쉬움 | 간격이 크게 늘어납니다 |

- **Deshacer**: 버튼을 잘못 눌렀으면 `Deshacer`를 누르세요. 바로 전 카드가 앞면으로 다시 나오고, 일정도 원래대로 돌아갑니다.
- **하루 새 카드 15장**: 새 카드는 하루에 15장까지만 나옵니다. 밀린 복습이 너무 많으면(90장 초과) 새 카드는 잠시 멈춥니다.
- **새벽 4시 기준**: "하루"는 새벽 4시에 바뀝니다. 밤 12시를 넘겨 공부해도 새벽 4시 전이면 같은 날로 계산됩니다.
  예를 들어 밤 10시에 `Bien`을 누른 새 카드는 다음 날 새벽 4시 이후에 다시 나옵니다.
- **시간 알림**: 15분을 넘기면 `Llevas N min estudiando` 창이 한 번 뜹니다. `Seguir`(계속) 또는 `Terminar`(끝내기)를 고르세요.
- 세션이 끝나면 요약(복습한 카드 수, 새 카드 수, 버튼별 횟수, 시간, 연속 학습 일수 `racha`, 내일 복습 예정 장수)이 나옵니다.
- 버튼을 누를 때마다 바로 저장되므로, 중간에 나가거나 창을 닫아도 안전합니다.
- 정의(뜻)가 없는 대기함 카드와 보류(suspendida) 카드는 복습에 나오지 않습니다.

PC 키보드 단축키:

| 키 | 동작 |
| --- | --- |
| `Space` 또는 `Enter` | 답 보기 |
| `1` `2` `3` `4` | Otra vez / Difícil / Bien / Fácil (답을 본 뒤에만) |
| `Z` 또는 `Ctrl+Z` | Deshacer (되돌리기) |
| `Esc` | Inicio로 돌아가기 |

## 빠른 추가 문법 (치트 시트)

```
첫 줄            표현 (필수)
: ...           정의 (스페인어)
= ...           한국어 뜻
> ...           예문 ([[ ]]로 빈칸 표시 가능)
# ...           태그 (띄어쓰기 또는 쉼표로 구분)
@ ...           출처
표현 :: 정의 | 예문   한 줄 형식
```

- 항목 사이는 **빈 줄**로 구분합니다.
- 표현만 적으면 **Bandeja**(대기함)에 저장됩니다. 나중에 정의를 채우면 자동으로 활성 카드가 됩니다.
- 종류(tipo)·레지스터·지역은 입력창 아래의 칩으로 고릅니다. 마지막 선택을 기억합니다.

예 1 — 전체 형식:

```
hacer hincapié en
: subrayar o insistir en la importancia de algo
= 강조하다
> El ministro [[hizo hincapié en]] la necesidad de reformar el sistema de pensiones.
# tema:politica_sociedad prueba:1
```

예 2 — 한 줄 형식 + 표현만:

```
a raíz de :: como consecuencia de, a partir de | [[A raíz de]] la crisis, muchas empresas cerraron.

dar en el clavo
```

PC에서는 `Ctrl+Enter`로 저장합니다.

## 백업과 복원

아래 화면은 모두 맨 아래 메뉴의 **Ajustes**에서 들어갑니다.

### Exportar todo (파일로 내보내기) — 가장 중요한 백업

- `Exportar todo`를 누르면 카드, 삭제한 카드, 복습 기록, 설정이 **파일 하나**(`c2vocab-날짜-기기이름.json`)로 저장됩니다.
  - PC: `다운로드` 폴더에 저장됩니다. Dropbox 폴더 등 안전한 곳으로 옮겨 두세요.
  - 아이폰: 공유 창이 열립니다. `파일에 저장`, Dropbox, 카카오톡(나에게 보내기) 중에서 고르세요.
- 일주일 넘게 내보내지 않으면 Inicio 맨 위에 `Hace N días que no exportas tus datos` 알림이 뜹니다.
  `Exportar ahora`를 누르면 바로 내보내고, `Más tarde`를 누르면 다음 날까지 숨깁니다.
- 브라우저의 "사이트 데이터 삭제"나 컴퓨터 고장으로부터 지켜 주는 것은 **이 파일뿐**입니다. 일주일에 한 번은 해 두세요.
- 파일이 멀쩡한지 확인하고 싶으면: `python tools/verify_export.py 파일이름.json`

### Importar (가져오기)

- `Ajustes → Importar`에서 내보낸 파일을 고르거나 내용을 붙여넣으면, 먼저 **미리보기**가 나옵니다
  (새 카드 몇 장, 바뀌는 카드 몇 장, 그대로인 카드 몇 장, 새 복습 기록 몇 개).
- `Fusionar`를 누르면 지금 데이터와 **합칩니다**(덮어쓰기가 아닙니다).
  - 같은 카드가 양쪽에 있으면 더 나중에 수정한 쪽이 남습니다.
  - 더 나중에 삭제한 카드는 삭제된 채로 유지됩니다(옛 파일을 가져와도 되살아나지 않습니다).
  - 복습 기록은 양쪽 것을 모두 합칩니다. 아무것도 지워지지 않습니다.
- 같은 파일을 두 번 가져와도 결과는 같습니다.

### Copias automáticas (자동 복사본)

- 앱이 브라우저 안에 자동으로 복사본을 만들어 둡니다: 공부를 마친 뒤(1시간에 최대 1개), 가져오기 직전, 복원 직전.
  `Crear copia ahora`로 직접 만들 수도 있습니다. 최근 10개만 보관합니다.
- 복사본 옆의 `Restaurar`를 누르면 무엇이 바뀌는지 먼저 보여 줍니다
  (`N tarjetas volverán a su contenido de esa fecha` = N장이 그때 내용으로 돌아감,
  `M tarjetas creadas después se conservan` = 그 뒤에 만든 M장은 그대로 유지).
- **복원이 하는 일**: 카드의 *내용*(정의, 예문, 태그, 삭제 여부)만 그 시점으로 되돌립니다.
  **복습 기록은 절대 되돌리지 않고**, 그 뒤에 만든 카드도 사라지지 않습니다.
  복원 직전 상태도 복사본으로 남으므로, 마음에 안 들면 다시 되돌릴 수 있습니다.
- 주의: 이 복사본은 브라우저 안에만 있습니다. 브라우저 데이터를 지우면 함께 사라지므로 `Exportar todo`를 대신할 수 없습니다.

## Claude로 카드 대량 만들기

1. `Ajustes → Importar` 화면 아래쪽 **Pedir tarjetas a Claude**에서 `Tema`(주제), `Tipo`(유형), `Cantidad`(개수)를 정합니다.
   `Incluir mi bandeja`를 체크하면 대기함에 모아 둔 표현도 함께 완성해 달라고 요청합니다.
2. `Copiar prompt`를 누르고, Claude 대화창에 붙여넣어 보냅니다.
3. Claude의 답(JSON) 전체를 복사해서 Importar 화면 위쪽 입력칸에 붙여넣습니다.
   앞뒤에 설명 문장이나 코드 블록 표시가 섞여 있어도 됩니다.
4. 미리보기에서 `nuevas`(새 카드) / `duplicadas`(이미 있는 카드) / `repetidas`(붙여넣은 글 안에서 중복) / `inválidas`(표현이 없는 줄)
   개수를 확인합니다.
   - `Tipo por defecto`, `Registro por defecto`: 그 값이 비어 있는 줄에만 적용됩니다.
   - `Etiquetas para todas`: 모든 카드에 붙일 태그 (예: `claude-economia`).
   - 이미 있는 카드를 어떻게 할지: `Omitir`(건드리지 않음) / `Enriquecer`(빈 칸만 채움, 기본값) /
     `Sobrescribir`(내용만 교체, 복습 기록은 유지).
5. `Importar N tarjetas`를 누르면 저장됩니다. 직전에 자동 복사본이 만들어지므로 되돌릴 수 있습니다.

엑셀에서 복사한 표(탭 구분)나 `표현 | 정의 | 예문 | 태그` 형식의 줄, 직접 만든 JSON 파일(`imports/` 폴더에 보관)도 같은 화면에서 가져올 수 있습니다.
프롬프트 전문과 매주 하는 순서는 `docs/PROMPT.md`에 있습니다.

## 데이터는 어디에 있나요?

- 브라우저 안의 IndexedDB(데이터베이스 이름 `c2vocab`)에 저장됩니다. 파일로는 보이지 않습니다.
- **주의**: 브라우저의 "사이트 데이터 삭제"를 하면 카드가 모두 사라집니다. 정기적으로 `Ajustes → Exportar todo`로 파일을 만들어 두세요.
- 다른 브라우저(예: Chrome ↔ Edge)나 다른 기기는 서로 다른 저장소를 씁니다. 지금은 한쪽에서 `Exportar todo` → 다른 쪽에서 `Importar`로
  옮길 수 있고, 자동 동기화는 8단계에서 추가됩니다.

## 테스트 페이지

http://localhost:8080/test.html 을 열면 모든 줄이 `PASS`여야 합니다. 탭 제목에 "N passed, 0 failed"가 보이면 정상입니다.

## 다음 단계

- (완료) 1단계: 뼈대 + 저장소 + 빠른 추가 + 개인 사전
- (완료) 2단계: SM-2 복습 엔진 + 일일 복습 화면 (`Estudiar`)
- (완료) 3단계: 내보내기/가져오기/병합 + 자동 복사본 + Claude로 대량 카드 만들기
- 다음: 4단계: PWA + GitHub Pages → 아이폰에 설치
- 이후: 산출(producción)/빈칸 모드, 통계, Dropbox 동기화, DELE 모드 (자세한 계획은 `docs/plan.json`)
