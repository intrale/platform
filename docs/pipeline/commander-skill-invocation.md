# Commander — invocación de Skill `/doc` y `/planner` desde Telegram

Documento técnico operativo del flujo end-to-end por el cual el Commander de
Telegram delega creación de issues a los skills `/doc` y `/planner`. Cubre
arquitectura, audit log, troubleshooting y el catálogo cerrado del enum
`skill_result`.

Issues relacionados: #3250 (delegación original), #3418 (watchdog + enum
inicial), **#3587 (instrumentación trace + fix del bug "string opaco")**.

---

## 1. Diagrama de flujo

```
Telegram (Leo en el celu)
        │
        │  "creá un issue para arreglar el scroll"
        ▼
[pulpo.js — procesarTextoLibre]
        │
        ├─► detectIssueCreationIntent()          (issue-creation.js)
        │       └─► intent = create_simple|create_split|none
        │
        ├─► [si intent ≠ none]
        │       ├─► sanitizeIssueCreationInput() (SEC-3)
        │       ├─► sender allowlist             (SEC-2)
        │       ├─► provider == anthropic        (SEC-5)
        │       └─► OK ► ejecutarClaude(prompt, original, trace = {})
        │
        ▼
[ejecutarClaude — spawn Claude CLI con stream-json]
        │
        │  read line-by-line del stdout JSON:
        │       ├─► evt.type === 'assistant' + tool_use ────►  trace.toolUseSequence.push(...)
        │       ├─► evt.type === 'user'      + tool_result ──►  trace.toolResultsSummary.push(...)
        │       └─► evt.type === 'result'                  ───►  finalResult
        │
        │  watchdogs:
        │       ├─► SKILL_WATCHDOG_MS  = 60s   (tool_use:Skill sin tool_result)
        │       └─► HARD_TIMEOUT_MS    = 10min (límite absoluto del subproceso)
        │
        ▼
[de vuelta en procesarTextoLibre — post-LLM]
        │
        ├─► inspectResponseForOutcome(respuesta)
        │       └─► { issuesCreated[], skillsMentioned[], launchingDetected }
        │
        ├─► inferSkillResult({ outcome, toolUseSequence, toolResultsSummary })
        │       └─► uno de los 9 valores del enum (ver §3)
        │
        ├─► inferToolUsedInstead(toolUseSequence)
        │       └─► "Bash" | "Read" | ... | null
        │
        ├─► logSkillInvocation({ ... + trace })
        │       └─► append JSONL en logs/commander-skill-audit.jsonl
        │       └─► todos los nuevos campos pasan por _redactReadOutput
        │
        ▼
[Telegram — reporte al operador]
        │
        ├─► success           → bot publica "✓ Issue #NNNN creado: <título>"
        ├─► timeout           → ⏰ (3 variantes rotando por seed)
        ├─► skill_not_invoked → ⚠ "El modelo agarró <tool> en vez de Skill"
        ├─► skill_failed      → ✗ "El Skill /doc se invocó pero no creó issue"
        ├─► launching_no_complete → ⚠ "anunció /doc pero no llegó a invocarlo"
        └─► (otros — ver §3)
```

---

## 2. Allowlist de skills permitidos

Los **únicos** skills invocables desde un pedido de creación de issue por
Telegram son:

| Skill     | Cuándo se invoca                                              |
|-----------|---------------------------------------------------------------|
| `doc`     | El operador pide UN issue (`creá un issue`, `levantá ticket`) |
| `planner` | El operador pide un épico, split o multi-módulo               |

Cualquier otro skill (`delivery`, `builder`, `reset`, `qa`, `ghostbusters`,
`auth`, etc.) está **PROHIBIDO** desde este flow (SEC-1). El prompt al LLM lo
declara explícitamente; si el LLM intenta otro skill, el watchdog NO se arma y
el outcome final será `skill_not_invoked`.

La lista está congelada en `ALLOWED_SKILLS_FOR_ISSUE_CREATION` en
`.pipeline/lib/commander/issue-creation.js`. Tests de regresión
(`commander-issue-creation.test.js` + `commander-skill-watchdog.test.js`)
verifican que no se amplíe sin cambio explícito.

---

## 3. Catálogo del enum `skill_result`

Valores posibles del campo `skill_result` en
`.pipeline/logs/commander-skill-audit.jsonl`. Enum cerrado validado en
`logSkillInvocation` — valores fuera del enum se descartan con log de error.

| Valor                    | Significado                                                                                          | Acción típica del operador                                              |
|--------------------------|------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------|
| `success`                | Skill se invocó y al menos 1 issue se creó. **Preferido en código nuevo (#3587).**                  | nada — está OK                                                           |
| `ok`                     | Alias legacy de `success` (back-compat con líneas pre-#3587 y tests existentes).                    | nada — está OK                                                           |
| `timeout`                | El watchdog de 60s mató al Skill por no completar (`tool_use:Skill` sin `tool_result` en 60s).      | reintentar; investigar si el subskill necesita más budget (ver #3588)    |
| `skill_not_invoked`      | El LLM terminó sin emitir `tool_use:Skill`. Campo `tool_used_instead` documenta qué tool usó. **#3587.** | reintentar; si recurre, levantar issue de prompt-tuning                  |
| `skill_failed`           | El LLM invocó `tool_use:Skill`, el subskill corrió, pero el `tool_result` indicó error o no creó issue. **#3587.** | revisar `tool_results_summary[].content_tail` en el JSONL                |
| `launching_no_complete`  | El LLM imprimió "Launching skill: doc" como texto pero nunca emitió el `tool_use` real. (#3418 CA-3.) | reintentar explícitamente con `/doc nueva <título>`                      |
| `invalid_args`           | El Skill se invocó con args malformados (detectable por gh o por el handler del skill).             | reformular el pedido; abrir issue de validación del input                |
| `blocked`                | SEC-2 o SEC-5 cortaron antes del spawn (sender no autorizado o provider ≠ anthropic).               | confirmar credenciales; esperar recuperación de cuota                    |
| `error`                  | Alias legacy genérico. Code path nuevo emite categorías específicas.                                | inspeccionar línea completa del JSONL para más contexto                  |

**Eliminado en #3587 CA-3**: el string opaco genérico que se usaba antes para
todos los casos "el LLM no hizo lo esperado" fue reemplazado por el enum
específico. `grep` sobre `.pipeline/` debe devolver vacío para ese literal.

---

## 4. Audit log JSONL — schema completo

Path: `.pipeline/logs/commander-skill-audit.jsonl`. Una línea JSON por intento
de creación de issue.

### Campos comunes

| Campo                | Tipo            | Descripción                                                                  |
|----------------------|-----------------|------------------------------------------------------------------------------|
| `timestamp`          | ISO8601 string  | Cuando arrancó el intento                                                    |
| `from.id`            | number          | Telegram user ID del operador                                                |
| `from.username`      | string          | Telegram username                                                            |
| `input_text`         | string (≤200c)  | Preview del mensaje del operador, redactado y truncado                       |
| `input_text_truncated` | boolean       | true si el input excedía 4000c y se cortó (SEC-3)                            |
| `skill_invoked`      | enum            | `"doc"` o `"planner"` (allowlist)                                            |
| `skill_args`         | string (≤500c)  | Args pasados al skill, si están disponibles                                  |
| `skill_result`       | enum            | Ver §3                                                                       |
| `issue_created`      | number \| array | Número del issue creado, o lista si fueron varios (split)                    |
| `duration_ms`        | number          | Tiempo total del spawn LLM                                                   |
| `timeout_ms`         | number          | Solo cuando `skill_result === 'timeout'`                                     |
| `provider`           | string          | `"anthropic"` (siempre — SEC-5 bloquea otros)                                |
| `error`              | string (≤500c)  | Mensaje de error categorizado (NO string opaco — #3587 CA-3)                 |
| `sender_allowed`     | boolean         | true si pasó SEC-2                                                           |
| `intent`             | enum            | `"create_simple"` \| `"create_split"`                                        |

### Campos nuevos (#3587 CA-1 — instrumentación)

| Campo                  | Tipo         | Descripción                                                                  |
|------------------------|--------------|------------------------------------------------------------------------------|
| `tool_use_sequence`    | array        | TODOS los `tool_use` que el LLM emitió, en orden                            |
| `tool_use_sequence[].name`         | string  | `"Skill"`, `"Bash"`, `"Read"`, etc.                                |
| `tool_use_sequence[].input_preview` | string | Input del tool, redactado y truncado a 512c                        |
| `tool_use_sequence[].id_short`     | string  | Primeros 12 chars del `tool_use_id`                                |
| `tool_use_sequence[].ts_ms`        | number  | Offset desde el spawn (ms)                                         |
| `tool_results_summary` | array        | Tool results en orden                                                       |
| `tool_results_summary[].tool_use_id_short` | string | Primeros 12 chars del id                                  |
| `tool_results_summary[].content_tail`      | string | Tail del output, redactado, truncado a 512c               |
| `tool_results_summary[].is_error`          | boolean | true si `is_error` del tool_result                      |
| `subprocess`           | object       | Metadata del child process Claude                                            |
| `subprocess.cmd`       | string       | Path al binario (típicamente `claude.cmd`)                                   |
| `subprocess.args_redacted` | string   | Args concatenados, redactados, ≤512c                                         |
| `subprocess.exit_code` | number \| null | Exit code (null si fue matado antes de exit)                              |
| `subprocess.duration_ms` | number     | Duración total del subproceso                                                |
| `subprocess.killed_by_watchdog` | boolean | true si murió por SKILL_WATCHDOG_MS                                |
| `tool_used_instead`    | string \| null | Cuando `skill_result === 'skill_not_invoked'`, el primer tool no-Skill que el LLM invocó. Ej: `"Bash"`. |

**Caps de tamaño** (defensa A08 software & data integrity):
- `tool_use_sequence`: máximo 32 entradas. Si hay más, se agrega `{name: "_truncated", extra: N}`.
- `tool_results_summary`: máximo 32 entradas (misma política).
- Cada `input_preview` / `content_tail`: 512 chars.
- `subprocess.args_redacted`: 512 chars.

**Seguridad SEC-1 (#3587)**: TODOS los nuevos campos pasan por
`_redactReadOutput` (del módulo `redact-read.js`) ANTES de truncar y
serializar. Cubre AWS keys, JWT, GitHub PATs, Telegram tokens, Google AI
keys, Slack tokens, y `password|secret|token=...` genéricos.

---

## 5. Cómo agregar un nuevo skill al Commander

> Esto NO es una operación trivial. La allowlist está congelada con tests de
> regresión. Solo agregar si hay una historia de usuario que lo justifique.

1. **Editar la allowlist** en `.pipeline/lib/commander/issue-creation.js`:
   ```js
   const ALLOWED_SKILLS_FOR_ISSUE_CREATION = Object.freeze(['doc', 'planner', 'NUEVO']);
   ```

2. **Actualizar el prompt block** (`buildIssueCreationPromptBlock`) para que el
   LLM sepa cuándo invocar el nuevo skill — agregar un caso explícito tipo
   "Si el usuario pide X, INVOCÁ Skill(skill='NUEVO', args=...)".

3. **Verificar el detector de intent** (`detectIssueCreationIntent`): si el
   trigger del nuevo skill no matchea ningún pattern (`SPLIT_PATTERNS` /
   `SIMPLE_PATTERNS`), agregar patterns.

4. **Actualizar tests**:
   - `commander-issue-creation.test.js → #3418 SEC-A` (allowlist exacta).
   - `commander-skill-watchdog.test.js → #3418 SEC-A` (allowlist exacta).
   - Agregar tests positivos del nuevo trigger.

5. **Coordinar con el rol PO** — la ampliación debe quedar justificada en una
   historia de usuario con criterios de aceptación.

---

## 6. Troubleshooting

### "El bot no respondió a mi pedido de crear issue"

```bash
# Ver últimas 5 invocaciones para tu chat
tail -n 50 .pipeline/logs/commander-skill-audit.jsonl | \
  grep '"from":{"id":<TU_TELEGRAM_ID>' | tail -5
```

### "skill_result == skill_not_invoked: ¿qué hizo el LLM?"

```bash
# Buscar la línea del intento (timestamp aprox)
grep '"timestamp":"2026-05-26T22:30' .pipeline/logs/commander-skill-audit.jsonl
```

Revisar:
- `tool_used_instead`: la primera tool no-Skill que invocó. Si dice `"Bash"`,
  el LLM probablemente intentó `gh issue create` directo (violación del prompt).
- `tool_use_sequence[].name`: lista completa de tools que usó.
- `subprocess.duration_ms`: cuánto tardó (>50s sugiere el watchdog del LLM 1M
  o algún otro path lento).

### "skill_result == timeout: ¿quién murió?"

```bash
grep '"skill_result":"timeout"' .pipeline/logs/commander-skill-audit.jsonl | \
  jq -r '.timestamp + " " + (.timeout_ms|tostring) + "ms " + .skill_invoked'
```

`timeout_ms` indica cuánto esperó antes de matar. Si es exactamente 60000-60123,
es `SKILL_WATCHDOG_MS` (60s hardcoded). Reportar persistencia → #3588 propone
elevar el budget por categoría de skill.

### "skill_result == skill_failed: ¿qué dijo el subskill?"

```bash
# El content_tail del tool_result tiene el error real
grep '"skill_result":"skill_failed"' .pipeline/logs/commander-skill-audit.jsonl | \
  tail -1 | jq '.tool_results_summary'
```

### "Quiero ver la última invocación end-to-end con todo el detalle"

```bash
tail -1 .pipeline/logs/commander-skill-audit.jsonl | jq
```

### Búsqueda histórica del bug del string opaco (#3587)

Si encontrás líneas del JSONL pre-#3587 con `error:
no_skill_invoked_or_no_issue_created`, son fallos del bug original que se
arregló en este issue. Nuevas líneas tendrán `skill_result: skill_not_invoked`
con `tool_used_instead` poblado.

---

## 7. Mensajes a Telegram — guía visual

| Símbolo | Categoría             | Tono                                                 |
|---------|-----------------------|------------------------------------------------------|
| ✓       | success               | confirmación seca, sin entusiasmo excesivo           |
| ⏰      | timeout               | factual, mencionar segundos exactos                  |
| ⚠       | skill_not_invoked / launching_no_complete | preocupante pero no catastrófico; explicar qué hizo el modelo |
| ✗       | skill_failed / generic / invalid_args / gh_error | error real; incluir mensaje corto del fallo |
| 🔌      | quota                 | degradación de provider                              |
| 🚧      | blocked               | provider ≠ anthropic                                 |

**Reglas inquebrantables (UX guideline #3587):**
- NO usar emojis multicolor (🚀/🎉/🔴/🟢) — el operador lee decenas de mensajes
  por día y los emojis ruidosos cansan.
- Máximo 6 líneas por mensaje; el resto vive en el audit log.
- Variabilidad: timeout tiene 3 variantes que rotan por seed temporal.
- Tono argento natural: "Cortó a los 65s" en vez de "Timeout after 65000ms".
- Siempre incluir hint accionable al final ("reintentá", "abrílo a mano con
  `/doc nueva ...`").

---

## 8. Referencias

- **Código**: `.pipeline/pulpo.js` (`ejecutarClaude` + `procesarTextoLibre`),
  `.pipeline/lib/commander/issue-creation.js`.
- **Tests**: `.pipeline/lib/__tests__/commander-issue-creation.test.js`,
  `.pipeline/lib/__tests__/commander-skill-watchdog.test.js`.
- **Issues**: #3250 (delegación), #3418 (watchdog + enum), #3587 (instrumentación
  trace + fix bug "string opaco").
- **Recomendaciones pendientes (no bloquean)**: #3588 (watchdog por categoría),
  #3589 (detectar bypass via Bash), #3590 (extraer issue number desde stream),
  #3591 (redactar nuevos campos del audit log — cerrado en #3587 CA-1).
