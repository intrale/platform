# Guidelines de UX auditiva para TTS

Issue: [#2958](https://github.com/intrale/platform/issues/2958) · Modulo: `.pipeline/lib/text-to-speech-adapter.js`

## Que es

El **adaptador TTS** transforma el texto pensado para chat en un guion auditivo apto para Edge TTS (default) o el fallback. La regla rectora: el audio tiene que sonar a *"una persona hablandole a otra"*, no a *"screen reader leyendo el chat"*.

Todos los puntos del pipeline que generan audio (commander, /status, rejection reports, alertas de recuperacion, scripts CLI) pasan por `sanitizeForTts()` en `multimedia.js`, que delega 100% en el adaptador. **No hay que cambiar callers** — basta con que el adaptador haga su trabajo.

## API publica

```js
const { textToSpeechScript, sanitizeForTts } = require('./lib/text-to-speech-adapter');

// API completa con telemetria.
const { script, droppedCategories, summarized, truncated } = textToSpeechScript(text, opts);

// Compat para el wrapper existente — devuelve string directo.
const cleaned = sanitizeForTts(text);
```

Opciones:

| Opcion | Default | Que hace |
|---|---|---|
| `maxChars` | `1500` | Cap del script. Si se excede, se aplica resumen heuristico. |
| `preserveModelNames` | `true` (desde #3505) | Por default conserva nombres de modelo IA y proveedor (Sonnet, Opus, Claude, Gemini, Cerebras, Codex, GPT-4o, etc.) tal cual — son palabras cortas que el motor TTS pronuncia bien y Whisper transcribe correctamente. Pasar `false` solo si se necesita un audio totalmente generico (uso historico pre-#3505). |
| `summarize` | `true` | Si `false`, no aplica resumen aunque exceda `maxChars`. |

## Pipeline de transformacion (orden importa)

1. **Cap defensivo** — input > `MAX_TTS_INPUT_CHARS` (50000) se trunca para evitar ReDoS.
2. **Redaccion de secretos** — JWT, AWS access key, Telegram bot token, `Authorization: Bearer`, query strings `password=` / `token=` / `api_key=`, AWS secret key precedida de etiqueta. **PRIMERO**, antes de cualquier limpieza visual, para que el secret no quede residual en el audio.
3. **Enmascaramiento de emails** — reusa `lib/redact.js`.
4. **Modelos IA** — preservados tal cual por default (desde #3505). Solo se reemplazan por `"el agente"` cuando el caller pasa `preserveModelNames: false` explicitamente.
5. **URLs** — issue GitHub → `"link al issue NNNN"`, PR GitHub → `"link al PR NNNN"`, resto → `"link adjunto"`.
6. **Paths** — `C:\...`, `.pipeline/...`, `./foo/bar.js` → `"archivo del pipeline"`.
7. **Hashes de commit** — 7 a 40 hex aislados → `"commit reciente"`.
8. **Markdown + emojis + tablas** — headers, listas, code blocks, italicas, negritas, blockquotes, emojis decorativos. Tablas cortas (<= 4 filas x <= 4 columnas) se reformulan a frase natural; tablas grandes caen al fallback CSV.
9. **Resumen heuristico** — si supera `maxChars`, conserva primer parrafo + primeras oraciones de los siguientes parrafos hasta llenar el cap.

## Catalogo de reglas (con ejemplos antes/despues)

### Emojis decorativos

| Input chat | Script auditivo |
|---|---|
| `PR #2891 mergeado ✅` | `PR numero 2891 mergeado` |
| `🚨 Build roto` | `Build roto` |
| `🟢 verde 🔴 rojo` | `verde rojo` |

Los emojis de **gravedad** (🚨 critico, ❌ falla) se omiten visualmente, pero las palabras adyacentes que indican severidad (`"critico"`, `"falla"`, `"bloqueado"`) **no se atenuan** — son la unica senal de urgencia en audio.

### Modelos IA (por default se PRESERVAN — #3505)

| Input chat | Script auditivo (default) |
|---|---|
| `Sonnet 4.6 proceso el delivery` | `Sonnet 4.6 proceso el delivery` |
| `Opus 4.7 fallo en QA` | `Opus 4.7 fallo en QA` |
| `GPT-4o quedo sin cuota` | `GPT-4o quedo sin cuota` |

Excepcion: con `preserveModelNames: false` se reemplazan por `"el agente"` (uso historico, hoy no hay callers que lo pidan).

**Por que cambio** (issue #3505): el reemplazo por `"el agente"` provocaba que Whisper en el lado del receptor transcribiera la frase como `"gente"` (la `l` de `"el"` y la `a` de `"agente"` se pegan en la transcripcion), perdiendo la trazabilidad de que proveedor / modelo intervino en cada operacion.

### Paths, hashes, URLs

| Input chat | Script auditivo |
|---|---|
| `editado C:\Workspaces\Intrale\platform\foo.js` | `editado archivo del pipeline` |
| `commit 75fc4efa12345` | `commit reciente` |
| `https://github.com/intrale/platform/issues/2958` | `link al issue 2958` |
| `https://github.com/intrale/platform/pull/3312` | `link al PR 3312` |
| `https://example.com/x` | `link adjunto` |

### Markdown estructural

| Input chat | Script auditivo |
|---|---|
| `# Titulo\n## Subtitulo\nTexto` | `Titulo Subtitulo Texto` (sin pausa rara) |
| ` ```js\nconst x = 1;\n``` ` | (descartado) |
| `texto **importante**` | `texto importante` |
| `- uno\n- dos\n- tres` | `uno dos tres` (saltos preservados) |

### Tablas cortas a frase natural

Input:
```
| PR | estado |
|---|---|
| modelo | merged |
| scripts | merged |
| heuristica | merged |
```

Script auditivo:
> 3 prs: modelo, scripts y heuristica.

Tablas con mas de 4 filas o 4 columnas caen al fallback CSV linea por linea (mas legible que la frase forzada).

### Resumen heuristico

Para mensajes > 1500 chars: conserva el primer parrafo + las primeras oraciones de los siguientes hasta llenar el cap. Determinista, sin LLM. La idea es que el oyente escuche el **que** + el **por que** + al menos un **dato concreto** en los primeros 30-60 segundos.

## UX auditiva (extension del comentario del rol UX en el issue)

### 1. Registro y tono

- **Espanol rioplatense informal.** El adaptador no traduce ni neutraliza: `"mergé"` queda `"mergé"`. Conservar coloquialismos (`"bancame un toque"`, `"salio bien"`).
- **Voz activa preferida.** Cuando el chat dice `"el PR fue mergeado"`, sigue siendo aceptable, pero el caller deberia preferir `"se mergeo el PR"` en origen.
- **Tuteo / voseo** en mensajes dirigidos a Leo se preserva tal cual.
- **El agente que habla es `"el agente"` o `"el bot"`**, nunca `"Sonnet"` o `"GPT"`.

### 2. Cadencia y respiracion

- **Frases cortas, < 20 palabras** son mas naturales en audio. Si el caller manda parrafos largos, el adapter ayuda separando con puntuacion que Edge TTS interpreta como pausa.
- **Pausa entre bloques tematicos.** El doble salto de linea queda preservado y Edge TTS lo lee como ~600 ms de pausa.
- **Listas con frase introductoria.** Los bullets sueltos pierden contexto en audio. Los callers deberian envolver listas con una frase introductoria; el adapter aplana los bullets pero la frase introductoria es responsabilidad del caller.
- **Duracion objetivo 30-60s** para mensajes tipicos. El cap de 1500 chars (CA-8) lo aproxima.

### 3. Pronunciacion y numeros

- **`#1234` → `numero 1234`**, Edge TTS lo pronuncia en espanol natural.
- **Acronimos:** `PR`, `QA`, `CI/CD` se leen como palabras tal como el equipo los dice verbalmente. El adapter no modifica acronimos.
- **Versiones:** `Kotlin 2.2.21` queda tal cual; Edge TTS lo pronuncia razonablemente. Si la version es ruido (raramente importa al oyente), conviene omitirla en origen.

### 4. Jerarquia auditiva

A diferencia del chat, en audio no se puede saltar al final. **Conviene que el caller ponga el estado primero** y el contexto despues:

- Chat: `"El issue #2891 sobre TTS adapter fue mergeado tras 3 rebotes con qa:passed."`
- Mejor script: `"se mergeo el issue 2891 sobre el TTS adapter. paso despues de tres rebotes."`

El adaptador no reordena oraciones — esto es responsabilidad del caller.

### 5. Verificacion humana (CA-17)

Para el sign-off del issue se requieren **3 audios de muestra** revisados por Leo:

1. **Mensaje corto del commander** (~200-400 chars, sin tablas ni paths) — verifica pacing y tono natural.
2. **Reporte /status** (~800-1200 chars, con tabla y emojis decorativos) — verifica reformulacion de tabla y omision visual.
3. **Rejection report** (> 1500 chars, con paths, hashes, modelos, secret simulado) — verifica resumen, redaccion de secrets y omision de paths.

Cada audio se entrega con la **transcripcion del script generado** al lado, para que la comparacion input/output sea repetible sin volver a escuchar.

## Seguridad y privacidad

### Politica de secretos

El audio es **persistible y reenviable** por Telegram. Cualquier secreto leakeado al audio es exfiltracion de facto.

- **Redaccion ANTES de limpieza visual.** Si el adapter limpiara markdown primero, un token escondido entre backticks quedaria expuesto en plano antes de ser detectado.
- **Patrones cubiertos**: JWT (`eyJ...`), AWS access key (`AKIA[A-Z0-9]{16}`), AWS secret key (precedida de etiqueta), Telegram bot token (`digits:opaque{35}`), `Authorization: Bearer/Basic/Token`, query strings `password=` / `token=` / `api_key=` / `secret=` / `access_key=` / `auth=`.
- **Marcador**: `[REDACTED:<tipo>]` (ej. `[REDACTED:jwt]`). El tipo va inline para que sea util en logs, pero **no contiene el secret**.

### PII en fixtures de test

Cuando se agreguen fixtures derivados de mensajes reales de `.pipeline/servicios/telegram/listo/*.json`:

- **Chat IDs** → `<chatid>`.
- **Username / first_name / last_name** de Telegram → removidos.
- **DNI, emails, telefonos** → placeholders (`leito.larreta@gmail.com` → `usuario@ejemplo.com`).
- **Hashes reales** → hashes ficticios (`75fc4efa12345` es un hash sintetico que NO existe en el repo).
- **Tokens reales** → NUNCA. Aunque esten expirados.

### Logging de telemetria

`textToSpeechScript()` retorna `droppedCategories` con **conteos por tipo** (markdown, emoji, path, url, secret, model, hash, email, table). **No retorna el contenido textual** de los segmentos removidos — eso seria re-exfiltracion por log.

Formato seguro para loggear:

```json
{
  "input_chars": 1842,
  "output_chars": 643,
  "dropped": { "markdown": 14, "emoji": 7, "path": 2, "url": 3, "secret": 1, "model": 4, "hash": 1, "email": 0, "table": 1 },
  "summarized": true,
  "truncated": false
}
```

### Proteccion ReDoS

- Cap `MAX_TTS_INPUT_CHARS = 50000` aplicado **antes** de regex.
- Patrones nuevos usan repeticiones acotadas (`{0,12}`) y clases de caracteres especificas, no `.*` greedy.
- Cada regex nueva debe pasar test adversarial: `'a'.repeat(10000) + '!'` en < 100 ms.

## Como agregar una regla nueva

1. **Identificar la categoria** (emoji, path, hash, secret, etc.). Si no entra en ninguna, agregar una nueva en `droppedCategories` y documentarla aca.
2. **Escribir la regex con cap explicito** y test adversarial.
3. **Decidir si va antes o despues de los secretos.** Si el patron puede matchear un secreto, va DESPUES de la redaccion de secretos.
4. **Agregar test de idempotencia** — la regla nueva tiene que dejar el output estable.
5. **Documentar antes/despues** en este archivo.

## Telemetria de produccion

El adaptador exporta los conteos por categoria. El caller decide si loggearlos o no. Recomendacion: loggear conteos en `audit-log.jsonl` cuando el TTS se genera para un evento critico (rejection report, alerta), no en cada mensaje del commander (volumen alto, ruido).

## Recomendaciones futuras (issues independientes, fuera de scope)

- **#3319** — perfiles TTS por contexto (voice personas).
- **#3321** — consolidar secret scanner reutilizable en `lib/redact`.
- **#3322** — auditoria periodica de fuentes upstream que generan texto TTS.
