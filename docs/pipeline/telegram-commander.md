# Telegram Commander — Router determinístico vs LLM

> **Issue origen:** #3257 — separar comandos de status/listado/snapshot del
> flujo LLM. Forma parte de la Ola N+5 (resiliencia ante caída de cuota
> Claude + UX del Commander Telegram).

El Commander del pipeline V3 atiende dos tipos de tráfico desde Telegram:

1. **Pista determinística** — lectura de filesystem + render de plantilla
   Markdown. Responde SIEMPRE, sin invocar LLM. Diseñada para sobrevivir
   caída de cuota Claude y degradación de cualquier proveedor.
2. **Pista LLM** — texto libre, creación de issues, análisis de rechazos.
   Pasa por Claude (o el provider del multi-provider chain). Si cae,
   responde canned y deja el mensaje audit-loggeado.

Este documento describe cómo se distribuye el tráfico entre ambas pistas,
cómo se agregan comandos nuevos, y los criterios de seguridad que ningún
handler determinístico puede romper.

---

## Mapa de comandos por pista

| Comando / intent           | Pista          | Handler                                  | Plantilla              |
|----------------------------|----------------|------------------------------------------|------------------------|
| `/status`, `qué hay…`       | determinística | `pulpo.cmdStatus` (legacy)                | (legacy — TBD migrar) |
| `snapshot de ola`          | determinística | `pulpo.cmdStatus` extendido               | `snapshot-ola.md`      |
| `listado`, `listar issues` | determinística | `pulpo.cmdBloqueados` + filtros           | `listado-issues.md`    |
| `allowlist`                | determinística | lectura `.partial-pause.json`             | `allowlist.md`         |
| `tail <archivo>`           | determinística | `commander-det.handlers.tail`             | `tail-logs.md`         |
| `levantá el dashboard`     | determinística | spawn `node dashboard.js` (TBD)           | `dashboard-up.md`      |
| `bajá el dashboard`        | determinística | kill por PID (TBD)                        | `dashboard-down.md`    |
| `screenshot`               | determinística | puppeteer headless (TBD)                  | `screenshot.md`        |
| `procesos node`            | determinística | `ps`/`tasklist` con argv (TBD)            | `procesos-node.md`     |
| `salud del pulpo`          | determinística | `commander-det.handlers.salud`            | `salud-pulpo.md`       |
| `modo descanso`            | determinística | `commander-det.handlers.descanso`         | `modo-descanso.md`     |
| `/pausar`, `/reanudar`     | determinística | `pulpo.cmdPausar` / `cmdReanudar` (legacy)| —                      |
| `/ghostbusters`            | determinística | `pulpo.cmdGhostbusters` (legacy)          | —                      |
| `/actividad`, `/costos`    | determinística | handlers legacy en `pulpo.js`             | —                      |
| `/help`, `/start`          | determinística | `pulpo.cmdHelp` (legacy)                  | —                      |
| `/restart`, `/limpiar`     | determinística | handlers legacy                            | —                      |
| `/bloqueados`, `/unblock`  | determinística | handlers legacy                            | —                      |
| `/intake <num>`            | **LLM**        | `pulpo.cmdIntake` con Claude              | —                      |
| `/proponer`                | **LLM**        | `pulpo.cmdProponer` con Claude            | —                      |
| Texto libre > 80 chars     | **LLM**        | `ejecutarClaude(prompt)`                  | —                      |
| Slash desconocido `/foo`   | **unknown**    | sin handler                               | `error-unknown.md`     |

> **Nota sobre handlers TBD:** los marcados como "TBD" arrancan con el
> handler default del módulo (que devuelve placeholder o stub) o caen al
> switch legacy de `pulpo.js`. La migración progresiva está cubierta por
> issues hijos de Ola N+5 / N+6.

---

## Cómo agregar un comando determinístico nuevo

1. **Sumalo al allowlist** en `.pipeline/lib/commander-deterministic.js`:
   ```js
   const DETERMINISTIC_SLASH = new Set([..., 'mi-comando']);
   ```
   Si querés que se reconozca por lenguaje natural, agregalo a
   `NLP_PATTERNS` con su regex.

2. **Definí el schema de args** en `ARG_SCHEMAS`:
   ```js
   'mi-comando': {
     allow: (args) => /^[a-z0-9-]{1,40}$/.test(args || ''),
     usage: 'mi-comando <slug>',
     allowedValues: ['x', 'y'],
     hint: 'Solo letras, números y guiones (máx 40 chars).',
   }
   ```
   El validator rechaza inputs que no matcheen ANTES de llamar al handler.

3. **Implementá el handler** — puede vivir en `buildDefaultHandlers(ctx)`
   del módulo, o ser inyectado por `pulpo.js` vía `opts.handlers`:
   ```js
   handlers.miComando = async ({ args, message }) => {
     // Leer FS, NUNCA spawnar con shell concat.
     // Devolver string Markdown o { reply: '…' }.
     return fillTemplate('mi-comando', { foo: 'bar' });
   };
   ```

4. **Creá la plantilla** en `.pipeline/lib/commander/templates/mi-comando.md`
   siguiendo la sintaxis Handlebars-básica del README.

5. **Sumá fixtures** en `.pipeline/lib/__tests__/commander-router.test.js`:
   un test de clasificación + un test de schema válido + un adversarial.

6. **Auditá la tabla de este documento** (sección anterior).

---

## Esquema del audit log

Cada dispatch (sea cual sea su clase) deja una línea JSONL en
`.pipeline/logs/commander-audit-YYYY-MM-DD.jsonl`:

```json
{
  "ts": "2026-05-17T01:23:45.678Z",
  "from": "Leo",
  "chat_id": "123456789",
  "raw_command": "tail commander.log",
  "intent_class": "deterministic",
  "handler": "tail",
  "args_hash": "<sha256 hex>",
  "result_status": "ok",
  "duration_ms": 42
}
```

Campos:

- **`raw_command`** se persiste **redactado** (AWS keys, JWTs, passwords
  reemplazados por `[REDACTED]`). Útil para debug pero seguro.
- **`args_hash`** es `sha256(args)` — permite detectar repeticiones del
  mismo input sin guardar el contenido crudo.
- **`intent_class`** ∈ `deterministic | llm | unknown`.
- **`result_status`** ∈ `ok | rate_limited | invalid_args | error | delegated_to_llm | unauthorized`.

El log rota por día (un archivo por fecha UTC). Sin política de retención
explícita — la limpieza viene de afuera (cron `find -mtime +30 -delete`).

---

## Métricas de routing (CA-4)

El dashboard expone dos integraciones:

1. **Endpoint JSON** `GET /api/metrics/commander/routing?days=7` que
   devuelve:
   ```json
   {
     "window_days": 7,
     "buckets": [
       { "date": "2026-05-17", "deterministic": 42, "llm": 7, "unknown": 1, "total": 50, "percentDeterministic": 84.0 },
       …
     ],
     "totals": { "deterministic": 240, "llm": 35, "unknown": 5, "total": 280, "percentDeterministic": 85.7 }
   }
   ```

2. **Tarjeta visible** en la sección "DORA & Routing" del dashboard
   principal. Muestra `%` determinístico hoy, `%` determinístico 7d, y
   contadores absolutos. Si `% deterministic` cae por debajo del 60%,
   el indicador cambia de verde a amarillo — puede significar:
   - Tráfico real con muchas creaciones de issues (esperado en sprint nuevo).
   - O bien tráfico que debería ser determinístico está cayendo a LLM
     porque falta una entrada en el allowlist (acción: revisar
     `commander-audit-*.jsonl` y ampliar `DETERMINISTIC_SLASH` /
     `NLP_PATTERNS`).

---

## Reglas de seguridad inquebrantables

Las reglas siguen el análisis OWASP del issue (CA-7 a CA-15). Cualquier
PR que las viole debe ser rechazado en code review.

1. **Allowlist explícita** — los slash-commands viven en
   `DETERMINISTIC_SLASH`. Cualquier input fuera del set cae a `unknown`
   o `llm`. **Prohibido denylist**.
2. **Validación de args estricta** — cada handler declara su schema.
   Inputs que no matcheen → rechazo `invalid_args`, sin delegar al LLM.
3. **Redacción del read-path** — `tail`, `salud`, `procesos`, etc.
   pasan toda salida por `commander/redact-read.js` antes de la
   plantilla. Cubre AWS keys, JWT, OpenAI/Anthropic/Groq/Gemini keys,
   GitHub PATs, Telegram bot tokens, emails, passwords.
4. **Audit log persistente** — formato arriba. Append-only.
5. **Rate limit por `chat_id`** — token bucket 30 req/min, burst 10.
   Solo aplica a la pista determinística (los LLM ya tienen su gate
   natural por latencia + quota).
6. **Escape MarkdownV2** — toda interpolación de `{{var}}` pasa por
   `escapeMarkdownV2()`. Triple-brace `{{{var}}}` solo para fragmentos
   ya seguros (composición).
7. **Sin `eval` / `new Function` / `vm`** — el parser es regex + state
   machine. Para spawn de procesos: `execFile`/`spawn` con argv array,
   nunca shell-concat.
8. **Fixtures anonimizados** — los `chat_id` y tokens de tests son
   sintéticos (`'123'`, `'rl'`, `'user1'`).
9. **Concurrencia** — el commander corre como singleton (`singleton('listener')`),
   evitando race conditions sobre `commander-session.json`. Si un futuro
   refactor introduce paralelismo, agregar lock con `proper-lockfile`.

---

## Mapeo CA → archivo

| CA   | Archivo principal                                          |
|------|------------------------------------------------------------|
| CA-1 | `.pipeline/lib/commander-deterministic.js` (`classify`)    |
| CA-2 | mismo archivo (`buildDefaultHandlers`) + `pulpo.js` (legacy) |
| CA-3 | `.pipeline/lib/commander/templates/*.md` + `fill-template.js` |
| CA-4 | `.pipeline/dashboard.js` (`/api/metrics/commander/routing`) |
| CA-5 | este documento                                             |
| CA-6 | `.pipeline/lib/__tests__/commander-router.test.js`         |
| CA-7 | `DETERMINISTIC_SLASH` allowlist                            |
| CA-8 | `ARG_SCHEMAS` + `validateArgs`                             |
| CA-9 | `.pipeline/lib/commander/redact-read.js`                   |
| CA-10 | `.pipeline/lib/commander/audit-log.js`                    |
| CA-11 | `.pipeline/lib/commander/rate-limit.js`                   |
| CA-12 | `.pipeline/lib/commander/fill-template.js` (`escapeMarkdownV2`) |
| CA-13 | sin `eval`; spawn con argv array (verificado en code review) |
| CA-14 | tests adversariales `#1`..`#6` en commander-router.test.js |
| CA-15 | singleton del commander (heredado de `pulpo.js`)            |
| CA-16 | `quotaNotifier` preservado en `_brazoCommanderInner`        |
| CA-17 | `expectedChatId` re-verificado en `dispatch()`             |
| CA-18 | NLP patterns legacy preservados — tests `/pausar`, `/ghostbusters` |

---

## Creación de issues delega a /doc y /planner (#3250)

Cuando el Commander recibe un pedido por Telegram que dispara creación de
issues ("creá un issue para X", "creá un épico", "esto hay que dividirlo en
A y B", etc.), **NO arma el body con su propio LLM**. Delega al skill
correspondiente para que el inventario quede indistinguible de un `/doc` por
consola.

### Routing por tipo de pedido

| Texto del usuario | Skill invocado | Args |
|-------------------|----------------|------|
| "creá un issue para X" / "levantá una historia de Y" / "hace falta un ticket de Z" / "armá un issue de W" | `doc` | `nueva <descripción>` |
| "creá un épico" / "esto hay que dividirlo en A y B" / "separá en backend y app" / "esto toca varios módulos" | `planner` | `split ...` (si hay padre) o `proponer ...` (si Leo pide ideas) |

La detección viene en dos pasos:

1. **Heurística pre-LLM** (módulo `lib/commander/issue-creation.js`,
   función `detectIssueCreationIntent`). Patrones regex en español. Si
   matchea, el Pulpo activa los gates SEC-3/SEC-4/SEC-5 antes de invocar
   a Claude. Si NO matchea, el flow sigue al LLM y el routing real lo
   decide Claude (instruido por el bloque `buildIssueCreationPromptBlock`
   inyectado en el `userPrompt`).
2. **Bloque de prompt** — Claude recibe siempre una regla específica en
   mayúsculas en el `userPrompt` con: la allowlist de skills (`doc` y
   `planner`), la prohibición de `gh issue create` directo, la
   validación post-éxito con `gh issue view`, y el formato esperado del
   reporte a Telegram para split. Ver `buildIssueCreationPromptBlock()`
   en el módulo.

### Reglas inquebrantables aplicadas

| ID | Origen | Implementación |
|----|--------|----------------|
| **CA-1** | issue body | heurística + prompt inyectado |
| **CA-2** | issue body | Skill tool via `bypassPermissions` — único entrypoint |
| **CA-3** | issue body | prompt obliga `gh issue view` post-éxito |
| **CA-4** | issue body | prompt define formato split (`🧩 ... blocked:dependencies → ...`) |
| **CA-5** | issue body | prompt PROHÍBE `gh issue create` y declara los copys de error |
| **CA-6** | issue body | esta sección + `feedback_commander-delega-doc-planner.md` |
| **SEC-1** | análisis security | `ALLOWED_SKILLS_FOR_ISSUE_CREATION = ['doc', 'planner']` |
| **SEC-2** | análisis security | `isSenderAllowed(from.id, getAllowedSenderIds())`, env `TELEGRAM_ALLOWED_USER_IDS` |
| **SEC-3** | análisis security | `sanitizeIssueCreationInput()` — trunca a 4000 chars + strip control/ANSI |
| **SEC-4** | análisis security | `logSkillInvocation()` → `.pipeline/logs/commander-skill-audit.jsonl` |
| **SEC-5** | análisis security | `resolveCommanderProvider()` + gate explícito si `provider !== 'anthropic'` |

### Audit log de invocaciones de skill (SEC-4)

Path: `.pipeline/logs/commander-skill-audit.jsonl`. Una línea JSON por
invocación. Convive con `commander-audit-YYYY-MM-DD.jsonl` (audit
general de routing) pero el shape es específico de creación de issues:

```json
{
  "timestamp": "2026-05-17T01:45:00.123Z",
  "from": { "id": 12345678, "username": "leitolarreta" },
  "input_text": "creá un issue para arreglar el bug del scroll en el feed",
  "input_text_truncated": false,
  "skill_invoked": "doc",
  "skill_args": null,
  "skill_result": "ok",
  "issue_created": 3299,
  "duration_ms": 245000,
  "provider": "anthropic",
  "intent": "create_simple",
  "sender_allowed": true
}
```

Casos especiales:

- **`skill_result: "blocked"`** con `error: "sender_not_allowed"` →
  SEC-2 rechazó el mensaje (sender fuera de `TELEGRAM_ALLOWED_USER_IDS`).
- **`skill_result: "blocked"`** con `error: "provider_not_anthropic"` →
  SEC-5 rechazó el pedido (failover a Codex/Groq/etc.).
- **`skill_result: "error"`** → Claude termino pero la respuesta no
  menciona invocación de skill ni issue creado → posible fallback
  silencioso (alerta forense).
- **`input_text`** se guarda redactado en los primeros 200 chars (preview
  forense). El texto completo del usuario vive en
  `commander-history.jsonl` con la política de redacción ya existente.

### Bloqueo cuando el provider activo no es Anthropic (SEC-5)

Los providers no-Anthropic (Groq/Cerebras/Gemini/Codex) no tienen Skill
tool habilitado en el harness — intentar `/doc` o `/planner` allí
caería en fallback silencioso con calidad degradada. Cuando el dispatcher
(`commanderMP.resolveCommanderProvider`) resuelve a un provider distinto
de Anthropic, el Pulpo NO invoca a Claude y responde directo:

```
🚧 No puedo crear issues ahora mismo — el cerebro principal está caído (failover a <provider>).
Reintentá más tarde o creá manual por consola: /doc nueva ...
```

Cuando #3258 (multi-provider fallback chain) declare más providers, este
gate se mantiene válido porque el contrato es "Anthropic o nada" — sólo
Anthropic tiene Skill tool en este pipeline.

### Cómo verificar manualmente

```bash
# 1. Estado del audit log
tail -n 20 .pipeline/logs/commander-skill-audit.jsonl

# 2. Test del módulo
node --test .pipeline/lib/__tests__/commander-issue-creation.test.js

# 3. Sintaxis pulpo.js (smoke)
node --check .pipeline/pulpo.js

# 4. Provider activo del commander
node -e "console.log(require('./.pipeline/lib/commander/multi-provider').resolveCommanderProvider({ pipelineDir: '.pipeline' }))"
```

---

## Referencias

- Mockup del card del dashboard: `.pipeline/assets/mockups/15-commander-routing-metric.svg`
- Narrativa UX del feature: `.pipeline/assets/mockups/narrativa-commander-routing.md`
- README de plantillas: `.pipeline/lib/commander/templates/README.md`
- Análisis OWASP completo: comentario `security` en issue #3257
- Análisis técnico: comentario `guru` en issue #3257
- Criterios consolidados: comentario `po` en issue #3257
- Delegación a /doc y /planner: issue #3250 + módulo `.pipeline/lib/commander/issue-creation.js`
