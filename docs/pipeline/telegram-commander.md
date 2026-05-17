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

## Referencias

- Mockup del card del dashboard: `.pipeline/assets/mockups/15-commander-routing-metric.svg`
- Narrativa UX del feature: `.pipeline/assets/mockups/narrativa-commander-routing.md`
- README de plantillas: `.pipeline/lib/commander/templates/README.md`
- Análisis OWASP completo: comentario `security` en issue #3257
- Análisis técnico: comentario `guru` en issue #3257
- Criterios consolidados: comentario `po` en issue #3257
