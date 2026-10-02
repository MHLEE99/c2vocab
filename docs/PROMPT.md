# Claude에게 카드 만들어 달라고 하기 (Copiar prompt)

이 문서는 앱의 **Importar → Pedir tarjetas a Claude → Copiar prompt** 버튼이 복사해 주는
프롬프트를 그대로 옮겨 놓은 것입니다. 프롬프트 본문은 `js/prompt.js` 의 `buildPrompt()` 가 만들며,
이 문서와 내용이 달라지면 `js/prompt.js` 가 기준입니다.

## 매주 하는 순서 (수집 → 프롬프트 복사 → 붙여넣기)

1. **수집 (recoger)** — 읽거나 듣다가 모르는 표현을 만나면 `+` 버튼으로 표현만 적어 둡니다.
   정의 없이 저장한 카드는 Bandeja(대기함)에 쌓입니다.
2. **Copiar prompt** — 앱에서 `Ajustes → Importar` 로 들어가 Tema(주제), Tipo(유형), Cantidad(개수)를 고르고
   `Incluir mi bandeja` 를 체크한 뒤 `Copiar prompt` 를 누릅니다. 프롬프트가 클립보드에 복사됩니다.
3. **Claude에 붙여넣기** — Claude 대화창에 붙여넣고 보냅니다. Claude가 JSON 배열 하나로 답합니다.
4. **Importar에 붙여넣기** — Claude의 답 전체를 복사해 Importar 화면의 입력칸에 붙여넣습니다
   (앞뒤에 설명 문장이나 ```` ``` ```` 코드 블록 표시가 섞여 있어도 됩니다).
   미리보기에서 nuevas / duplicadas 개수를 확인하고 `Importar N tarjetas` 를 누릅니다.
   - 대기함에 있던 표현은 `duplicada` 로 표시되고, 기본값 `Enriquecer`(빈 칸만 채움)로 정의·예문이 채워져 학습 카드가 됩니다.
   - 가져오기 직전에 자동 복사본(Copias automáticas)이 하나 만들어지므로, 결과가 마음에 들지 않으면 되돌릴 수 있습니다.
5. 카드를 훑어보고 어색한 예문이나 정의는 Explorar에서 직접 고칩니다. Claude가 쓴 예문은 `exampleSource: redactado`
   (지어낸 예문)로 표시됩니다. 실제 출처가 있는 예문만 직접 출처를 적으세요.

## 프롬프트 (예: Tema = economía y trabajo, Tipo = cualquiera, Cantidad = 20)

```text
Eres un lexicógrafo y profesor de español que prepara a un estudiante coreano para el examen DELE C2.
Nivel: DELE C2. Busca vocabulario culto y preciso, locuciones, colocaciones y marcadores propios de la prensa de calidad, el ensayo y el registro académico; nada que un estudiante de B2 ya domine.

ENCARGO
Cantidad: 20 tarjetas nuevas.
Tema: economía y trabajo.
Tipo: cualquiera; elige para cada tarjeta el tipo que mejor encaje y varía los tipos.

FORMATO DE LA RESPUESTA
Devuelve ÚNICAMENTE un array JSON válido (sin texto antes ni después, sin comentarios). Cada elemento es un objeto con estas claves:
- "front": la expresión en su forma canónica (lema: verbos en infinitivo, sin artículo innecesario).
- "back": definición monolingüe en español, clara y precisa, de 25 palabras como máximo. No repitas la expresión dentro de la definición.
- "ko": equivalente o glosa en coreano, de 6 palabras como máximo.
- "example": una oración natural de 15 a 35 palabras, propia de un texto de nivel C2, con la expresión marcada entre dobles corchetes [[...]] tal como aparece (conjugada o flexionada si hace falta). Para el tipo "verbo_prep" marca solo la preposición.
- "exampleSource": siempre "redactado". No inventes citas ni atribuyas el ejemplo a autores, periódicos u obras.
- "type": uno de estos identificadores exactos: locucion | colocacion | refran | marcador | falso_amigo | verbo_prep | variante | expresion | lexico | estructura | otro.
- "register": culto | neutro | coloquial | vulgar.
- "region": "general", salvo que la expresión sea propia de una zona (ES, MX, AR, CO, RioPlata...).
- "colocaciones": array de 2 a 4 combinaciones frecuentes cuando el tipo es "colocacion" o "lexico"; en los demás tipos, [] o las que sean realmente útiles.
- "equivalentes": opcional; array de objetos {"texto": "...", "registro": "..."} con sinónimos o variantes de otro registro.
- "contraste": obligatorio para "falso_amigo" (con qué se confunde y por qué) y para "variante" (la forma equivalente en otra zona); en los demás tipos, "" o una advertencia de uso.
- "tags": array de etiquetas en minúsculas; incluye siempre "tema:economia_y_trabajo" y "prueba:1", "prueba:2" o "prueba:3" según la prueba del DELE C2 en la que resulte más útil.
- "notes": opcional; régimen preposicional, matices, errores típicos de hablantes de coreano.

REGLAS
- No repitas expresiones ni incluyas dos variantes triviales de la misma.
- Todo el contenido en español, excepto "ko".
- Comillas dobles rectas, sin comas finales: el JSON debe poder leerse con JSON.parse.
```

`Incluir mi bandeja` 를 체크하면 프롬프트 끝에 아래 부분이 덧붙습니다 (대기함의 표현이 한 줄에 하나씩):

```text

SEGUNDA TAREA: COMPLETAR MI BANDEJA
ADEMÁS de las 20 tarjetas nuevas, completa exactamente estas 2 expresiones que ya he recogido (una por línea). Usa cada una como "front" sin cambiarla, rellena todos los campos con el mismo formato y añádelas al mismo array JSON:
dar en el clavo
a regañadientes
```

## 항목 설명 (Claude가 돌려주는 JSON의 키)

| 키 | 뜻 |
| --- | --- |
| `front` | 표현 (기본형) |
| `back` | 스페인어 정의 (25단어 이내) |
| `ko` | 한국어 뜻 (6단어 이내) |
| `example` | 예문. 표현 부분은 `[[...]]` 로 표시 (복습 화면에서 빈칸이 됨) |
| `exampleSource` | 항상 `redactado` (지어낸 예문) |
| `type` | 11가지 유형 중 하나 |
| `register` | culto / neutro / coloquial / vulgar |
| `region` | 보통 `general`, 지역 표현이면 ES, MX, AR... |
| `colocaciones` | 자주 함께 쓰는 조합 |
| `equivalentes` | 비슷한 표현 `{texto, registro}` |
| `contraste` | 헷갈리기 쉬운 것 (falso_amigo, variante에서는 필수) |
| `tags` | `tema:...`, `prueba:1|2|3` 등 |
| `notes` | 그 밖의 메모 |

## 직접 만든 파일 가져오기

같은 형식(위 키를 가진 객체들의 JSON 배열)으로 직접 파일을 만들어 `imports/` 폴더에 두었다가 Importar의
파일 선택으로 불러와도 됩니다. `id`, `status`, `srs`, 날짜 값은 적어도 무시되며, 가져온 카드는 항상 새 카드로 시작합니다.
탭으로 구분한 표(엑셀에서 복사)나 `표현 | 정의 | 예문 | 태그` 형식의 줄도 인식합니다.
