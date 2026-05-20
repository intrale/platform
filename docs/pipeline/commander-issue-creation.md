# Commander Telegram — Creación de issues (#3418)

Doc operativa del flujo de creación de issues a través del Telegram Commander.
Cubre el detector de intent, las defensas SEC-1..SEC-G, el watchdog de Skill de
60 s, y el formato del audit log forense.

> **Origen**: bug observado el 2026-05-20 — el Commander invocaba `Skill /doc`
> y la sesión LLM emitía "Launching skill: doc" como texto pero **nunca**
> ejecutaba la tool. Resultado: cero issues creados, cero líneas en el audit,
> cero feedback al operador. La historia #3418 cierra ese agujero con:
> patterns continuativos + contexto reforzador, watchdog 60 s, enum cerrado
> de `skill_result`, y mensaje de fallback siempre visible.

## Flujo end-to-end

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Operador (Telegram)                                                     │
│   "creá un issue para arreglar el scroll"                               │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ pulpo.js :: procesarTextoLibre                                          │
│                                                                         │
│  1. SEC-2  isSenderAllowed(fromId)                                      │
│            ├─ false → audit('blocked', sender_not_allowed) + drop      │
│            └─ true  → continúa                                          │
│                                                                         │
│  2. SEC-B  prevContext = readPrevIssueCreationContext()                 │
│            (lee últimas 5 entradas de commander-history.jsonl,         │
│             busca direction='in_intent' con TTL 5 min)                  │
│                                                                         │
│  3. CA-1   intent = detectIssueCreationIntent(text, prevContext)        │
│            ├─ patterns explícitos → CREATE_SIMPLE / CREATE_SPLIT       │
│            ├─ continuativos con prevContext → mismo intent             │
│            └─ continuativos sin prevContext → NONE                     │
│                                                                         │
│  4. CA-9   appendCommanderHistory({ direction:'in_intent', intent })   │
│            (sólo si intent !== NONE — alimenta prevContext del próximo │
│             turno)                                                      │
│                                                                         │
│  5. SEC-5  resolveCommanderProvider()                                   │
│            ├─ provider ≠ anthropic → audit('blocked',                  │
│            │                          provider_not_anthropic) + canned │
│            └─ provider == anthropic → continúa                         │
│                                                                         │
│  6. SEC-3  sanitizeIssueCreationInput(text)                             │
│            (trunca 4000 chars, strip control chars + ANSI)             │
│                                                                         │
│  7.        ejecutarClaude(prompt) [proceso hijo Claude Code]            │
│            │                                                            │
│            │  ┌────────────────────────────────────────────────────┐   │
│            │  │ CA-3 SKILL WATCHDOG (cada 5 s):                    │   │
│            │  │  - on tool_use {name:'Skill', skill:'doc'} →       │   │
│            │  │    start clock                                      │   │
│            │  │  - on tool_result(tool_use_id) → clear              │   │
│            │  │  - if (elapsed > 60s):                              │   │
│            │  │    1. killProc (tree-kill /T)                       │   │
│            │  │    2. skillTimedOut = true                          │   │
│            │  │    3. lastText = '[SKILL_TIMEOUT:doc:NNNNms]'       │   │
│            │  └────────────────────────────────────────────────────┘   │
│            └─→ retorna respuesta (texto final del LLM o marker)         │
│                                                                         │
│  8. CA-2   inspectResponseForOutcome(respuesta)                         │
│      +     inferSkillResult({ outcome, timedOut, … })                  │
│            ├─ marker [SKILL_TIMEOUT:...] → SKILL_RESULT_TIMEOUT        │
│            ├─ issuesCreated > 0          → SKILL_RESULT_OK             │
│            ├─ launchingDetected          → SKILL_RESULT_LAUNCHING_NO_  │
│            │                                COMPLETE                    │
│            └─ default                    → SKILL_RESULT_ERROR          │
│                                                                         │
│  9. SEC-4  logSkillInvocation({ skill_result, timeout_ms, error, … })  │
│            (appendFileSync a commander-skill-audit.jsonl)              │
│                                                                         │
│ 10. UX     sendTelegram(formatSkillFailureResponse({ kind }))           │
│            (si skill_result != OK: el operador SIEMPRE recibe mensaje  │
│             accionable, nunca silencio)                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

## Enum cerrado `skill_result` (SEC-D)

Valores aceptados en `commander-skill-audit.jsonl`. Cualquier otro valor se
omite del JSONL y se loguea como alerta.

| Valor | Causa raíz | Forma de detectarlo en el flow |
|---|---|---|
| `ok` | Skill se invocó y al menos 1 issue se creó. | `outcome.issuesCreated.length > 0` |
| `error` | Skill arrancó pero no se creó nada (gh rechazó, args inválidos detectables post-hoc, etc.). | `outcome.issuesCreated == []` AND `outcome.launchingDetected == false` |
| `blocked` | SEC-2/SEC-5 cortaron antes del spawn (sender no autorizado, provider ≠ anthropic). | Gates pre-LLM |
| `timeout` | El watchdog de 60 s mató al Skill después de un `tool_use` sin `tool_result`. | Marker `[SKILL_TIMEOUT:...]` en respuesta |
| `launching_no_complete` | El LLM emitió texto "Launching skill: doc" pero **nunca** el evento `tool_use`. Sin reloj para el watchdog, sin issue creado. | `outcome.launchingDetected == true` AND `issuesCreated == []` |
| `invalid_args` | Skill se invocó con args malformados (detectable por gh o por el handler del Skill). | El handler reporta error específico |

## Distinción crítica: `timeout` vs `launching_no_complete`

Es importante no confundirlas — apuntan a bugs distintos:

- **`timeout`**: el LLM emitió correctamente `tool_use:Skill` con `tool_use_id`,
  el watchdog arrancó el reloj de 60 s, y el `tool_result` correspondiente
  nunca llegó. Causa probable: el Skill arrancó pero quedó colgado, o el
  process hijo del Skill murió silenciosamente. **Acción**: revisar logs del
  Skill `/doc` o `/planner` para el `tool_use_id` mencionado en el audit.

- **`launching_no_complete`**: el LLM **nunca** emitió el evento estructurado
  `tool_use` — solo texto narrando que iba a invocar. Sin evento, sin reloj,
  sin watchdog disparable. **Acción**: revisar el system prompt del Commander
  para confirmar que enfatiza la instrucción "INVOCÁ Skill(skill='doc', ...)"
  vs "anunciá que vas a invocar".

## Patterns continuativos (CA-1) con contexto reforzador (SEC-B)

El detector original requería verbos explícitos (`creá`, `levantá`). Frases
continuativas como "Realos cuatro", "los 4", "creálos" pasaban por debajo del
radar. Ahora los aceptamos, **pero sólo cuando el turno previo del operador
ya tuvo un intent matched**:

```js
// Habilita CONTINUATION_PATTERNS
detectIssueCreationIntent('los 4', { intent: 'create_simple' })
// → { intent: 'create_simple', matched: '...', continuation: true }

// Sin contexto previo → NONE (cero falsos positivos)
detectIssueCreationIntent('los 4')
// → { intent: 'none', matched: null }
```

El `prevContext` se reconstruye leyendo las últimas 5 entradas de
`commander-history.jsonl` y buscando una con `direction: 'in_intent'` y TTL
< 5 minutos.

### Anti-falsos-positivos (ADVERSARIAL_NEGATIVE_PATTERNS)

Aunque haya contexto, si el texto contiene términos de dominios ajenos
(`build`, `PR`, `test`, `deploy`, `gradle`, `daemon`, `taskwarrior`, etc.)
se descarta:

```js
detectIssueCreationIntent('reintentá el build', { intent: 'create_simple' })
// → { intent: 'none' }  ← build es dominio ajeno
```

## Watchdog del Skill (CA-3)

Constante: `SKILL_WATCHDOG_MS = 60_000`. Implementación en
`pulpo.js::ejecutarClaude`. Sólo trackea `tool_use` cuyo `name === 'Skill'`
**y** cuyo `input.skill` esté en la allowlist (`doc` o `planner`). Otras
tools (Bash, Read, Edit, etc.) caen bajo el `HARD_TIMEOUT_MS = 10 * 60_000`
existente.

**Cleanup determinístico (SEC-E)**: `killProc` ya hace
`taskkill /PID <pid> /F /T` en Windows. El tree-kill garantiza que ningún
proceso hijo del Skill queda como zombi. La escritura del audit es
`appendFileSync` (sync) — bajo timeout la línea queda atómica.

## Audit log: lectura forense

Archivo: `.pipeline/logs/commander-skill-audit.jsonl`. Una línea JSON por
intento, append-only.

### Ejemplos de líneas

```jsonl
{"timestamp":"2026-05-20T14:30:00Z","from":{"id":12345,"username":"leitolarreta"},"input_text":"creá un issue para arreglar el scroll","input_text_truncated":false,"skill_invoked":"doc","skill_result":"ok","issue_created":3299,"duration_ms":4500,"provider":"anthropic","intent":"create_simple"}
{"timestamp":"2026-05-20T14:35:12Z","from":{"id":12345},"input_text":"creá 4 issues nuevos","skill_invoked":"doc","skill_result":"timeout","timeout_ms":60123,"duration_ms":60500,"provider":"anthropic","intent":"create_simple","error":"skill_watchdog_timeout_60s"}
{"timestamp":"2026-05-20T14:40:01Z","skill_invoked":"doc","skill_result":"launching_no_complete","error":"launching_marker_without_tool_use","provider":"anthropic","intent":"create_simple"}
{"timestamp":"2026-05-20T14:45:00Z","skill_invoked":"planner","skill_result":"blocked","error":"provider_not_anthropic","provider":"cerebras"}
```

### Troubleshooting

| Síntoma | Diagnóstico |
|---|---|
| Operador reporta "no se creó el issue" + no hay línea en el audit | Heurística no detectó intent. Verificar: `node -e "const ic=require('./.pipeline/lib/commander/issue-creation'); console.log(ic.detectIssueCreationIntent('<texto>', { intent: 'create_simple' }))"`. Si devuelve NONE: el operador necesita una frase más explícita. Si devuelve intent matched: el flow de SEC-B/CA-9 no está persistiendo en `commander-history.jsonl`. |
| Audit tiene `skill_result: timeout` | Skill arrancó pero quedó colgado >60s. Revisar el Skill `/doc` (process hijo). |
| Audit tiene `skill_result: launching_no_complete` | El LLM anunció el Skill pero no lo invocó. Revisar prompt del Commander y modelo activo. |
| Audit tiene `skill_result: error` con `no_skill_invoked_or_no_issue_created` | El LLM no mencionó `/doc`/`/planner` ni creó issues — comportamiento totalmente off-rail. Revisar el system prompt y el sanitizador SEC-3. |
| `input_text` contiene `[REDACTED]` | SEC-C redactó un token detectado en la entrada. Normal — no es un bug. |

### Comando rápido para inspeccionar el último error del operador

```bash
node -e "
const fs=require('fs');
const lines=fs.readFileSync('.pipeline/logs/commander-skill-audit.jsonl','utf8').trim().split('\\n');
const last10=lines.slice(-10).map(l=>JSON.parse(l));
console.table(last10.map(l=>({ts:l.timestamp,result:l.skill_result,skill:l.skill_invoked,issue:l.issue_created,err:l.error?l.error.slice(0,60):''})))
"
```

## Defensas SEC-A..SEC-G (resumen)

- **SEC-A** Allowlist canónica: `['doc', 'planner']`. Test snapshot verifica
  igualdad estricta. Para sumar un skill nuevo a este flow se requiere PR
  explícito que actualice también `buildIssueCreationPromptBlock` y los
  tests.
- **SEC-B** Continuativos requieren `prevContext` reforzador. Sin él, los
  patterns continuativos NO matchean — comportamiento backward-compat exacto.
- **SEC-C** `error` y `input_text` se redactan con `redact-read.js` ANTES
  de truncar a 200/500 chars. Cubre AWS keys, JWT, gh PATs, gemini keys,
  Telegram tokens y `password|secret|token=...` genéricos.
- **SEC-D** Enum cerrado de `skill_result`. Valores fuera del enum se omiten
  del JSONL y se loguean como alerta.
- **SEC-E** Cleanup determinístico: el watchdog usa `killProc` que ya hace
  `taskkill /PID <pid> /F /T` en Windows. `appendFileSync` sync para que la
  línea quede atómica bajo timeout.
- **SEC-F** Rate limiter por default (`createRateLimiter`, burst=10,
  30/min): 4 invocaciones paralelas caben sin bypass.
- **SEC-G** **Recomendación operativa para producción**: poblar
  `TELEGRAM_ALLOWED_USER_IDS` (comma-separated user IDs numéricos) en el
  entorno del pulpo. Por default está vacía (allowlist desactivada,
  permitiendo cualquier sender). Mientras el bot esté pinned a un único
  operador (Leo) y el bot token no leakee, la postura es aceptable; ante
  cualquier sospecha de leak, poblar inmediatamente.

## Tests asociados

- `.pipeline/lib/__tests__/commander-issue-creation.test.js` — patterns,
  enum, SEC-A/B/C/D, helpers de inferencia.
- `.pipeline/lib/__tests__/commander-skill-watchdog.test.js` — CA-4
  (regresión simple), CA-5 (4 paralelas), CA-3 (timeout y
  launching_no_complete), SEC-F (rate-limiter).

Ejecutar: `node --test .pipeline/lib/__tests__/commander-*.test.js`.

## Follow-ups conocidos (no bloquean #3418)

- **#3427** — Rotación + redacción periódica de
  `commander-skill-audit.jsonl` (el archivo crece con esta historia).
- **#3430** — Investigar señalización explícita de fin de Skill en Claude
  Code SDK (reemplazaría la heurística del watchdog 60 s).
- **#3431** — Watchdog activo del audit con alerta proactiva a Telegram.
- **#3432** — Tono natural y variado en mensajes de fallo del Commander
  (alinear con `feedback_telegram-messages-natural.md`).
- **#3433** — Feedback granular cuando el Commander crea N issues en batch
  (resumen consolidado).
