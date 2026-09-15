# c2vocab

DELE C2 준비를 위한 나만의 스페인어 표현 사전 + (2단계부터) 간격 반복 복습 앱입니다.
설치할 프로그램 없이 브라우저에서만 동작하고, 데이터는 내 기기 안에만 저장됩니다.

## PC에서 실행하기

1. `start.bat`을 더블클릭합니다. (검은 창이 하나 열리고 브라우저가 http://localhost:8080 을 엽니다.)
   - 검은 창은 앱을 쓰는 동안 닫지 마세요. 다 쓰면 닫아도 됩니다.
2. 또는 이 폴더에서 직접 실행: `python -m http.server 8080` → 브라우저에서 http://localhost:8080

Python이 설치되어 있어야 합니다(이미 설치되어 있습니다).

## 1단계에서 할 수 있는 것

- **Inicio**: 카드 수, 대기함(bandeja) 카드 수, 예문 없는 카드 수, 마지막 수정 시각을 봅니다.
  - `Cargar ejemplos (20)`: 예시 카드 20장을 넣습니다. 이미 있는 카드는 건너뜁니다.
  - `Estudiar`는 아직 꺼져 있습니다(2단계에서 켜집니다).
- **+ 버튼 / Añadir**: 표현을 빠르게 추가합니다. 여러 개를 한 번에 붙여넣을 수 있습니다.
- **Explorar**: 검색(악센트 없이 쳐도 찾습니다: `hincapie` → `hincapié`), 종류/레지스터/상태/태그 필터,
  카드를 눌러 `Editar`(수정) 또는 `Eliminar`(삭제). 삭제 직후 `Deshacer`로 되돌릴 수 있습니다.
- **Papelera**: 삭제한 카드 목록. `Restaurar`로 복원합니다. 카드는 절대 완전히 지워지지 않습니다.

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

## 데이터는 어디에 있나요?

- 브라우저 안의 IndexedDB(데이터베이스 이름 `c2vocab`)에 저장됩니다. 파일로는 보이지 않습니다.
- **주의**: 브라우저의 "사이트 데이터 삭제"를 하면 카드가 모두 사라집니다. 아직 백업 기능이 없으니 하지 마세요.
- 내보내기/가져오기/백업은 3단계에서 추가됩니다.
- 다른 브라우저(예: Chrome ↔ Edge)나 다른 기기는 서로 다른 저장소를 씁니다. 동기화는 8단계에서 추가됩니다.

## 테스트 페이지

http://localhost:8080/test.html 을 열면 모든 줄이 `PASS`여야 합니다. 탭 제목에 "N passed, 0 failed"가 보이면 정상입니다.

## 다음 단계

- 2단계: SM-2 복습 엔진 + 일일 복습 화면 (`Estudiar` 버튼 활성화)
- 3단계: 내보내기/가져오기/백업 + Claude로 대량 카드 만들기
- 4단계: PWA + GitHub Pages → 아이폰에 설치
- 이후: 산출(producción)/빈칸 모드, 통계, Dropbox 동기화, DELE 모드 (자세한 계획은 `docs/plan.json`)
