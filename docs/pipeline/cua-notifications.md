# Notificaciones Telegram de entregables CUA

Issue: **#3541** — `Entregables parciales del CUA: notificaciones Telegram estructuradas`.

## Resumen

El **CUA** (Comando de Usuario Asistido) es el subsistema del pipeline que ejecuta comandos ad-hoc del operador desde Telegram (ej. `/wave promote`, `/listado`, `/status`, `/cargar-ola`, etc.). A diferencia de los entregables de issues — que avisan al cierre de cada fase del flujo principal — el CUA emite **stages intermedios** del comando en curso.

Este documento describe el contrato del feature, decisiones de diseño y operación.

## Pipeline conceptual

```
operador → Telegram
       └── listener (chat_id allowlist)
            └── commander-deterministic.dispatch()
                 ├── classify / validate / rate-limit / auth
                 ├── ⚙️ notifyCua({command, stage: 'init', status: 'in_progress'})
                 ├── handler({ args, message, intent, cuaEmit })
                 │    └── opcional: cuaEmit({command, stage: 'validation', status: 'ok', preview: '✅ ...'})
                 │    └── opcional: cuaEmit({command, stage: 'analysis', status: 'ok', preview: '🔍 ...'})
                 └── ⚙️ notifyCua({command, stage: 'completion', status: ok|fail, duration})
                       └── deliverable-notify
                            ├── validar schema (Ajv)
                            ├── validar command (whitelist + regex)
                            ├── validar attachment (whitelist ext + cap + path)
                            ├── dedup CUA
                            ├── enqueue dropfile → servicio-telegram/pendiente/
                            ├── audit JSONL (skill=cua, command=<cmd>, issue=null)
                            └── audio TTS fire-and-forget (opcional)
```

## Estructura del entregable CUA

Schema: [`.pipeline/esquemas/cua-entregable.schema.json`](../../.pipeline/esquemas/cua-entregable.schema.json) — JSON Schema draft-07, validado con Ajv en runtime (CA-SEC-4, fail closed).

```ts
type CuaEntregable = {
  command: string;            // matchea /^[a-z][a-z0-9-]{0,40}$/ (CA-SEC-3)
  stage: 'init' | 'validation' | 'analysis' | 'completion';
  status: 'ok' | 'fail' | 'in_progress';
  preview?: string;            // máximo 4000 chars; truncado a `cua.truncate_chars` en payload
  attachment?: {
    type: 'json' | 'csv' | 'xlsx' | 'pdf' | 'txt' | 'md' | 'log';
    path: string;              // bajo .pipeline/cua-outputs/<subroot>/ (CA-SEC-5)
    filename?: string;         // nombre legible para Telegram (CA-UX-4)
    caption?: string;          // texto que acompaña el adjunto
  };
  duration?: number;           // segundos del stage
  error?: string;              // texto cuando status=fail (redactado pre-TTS)
  args?: string;               // args del comando para el header `⚙️ /<cmd> <args>`
};
```

## Flags de configuración (`.pipeline/config.yaml`)

| Flag | Default | Propósito |
|---|---|---|
| `cua.enabled` | `false` | Kill principal. Default OFF para rollout gradual (mismo patrón que #3414/#3539). |
| `cua.kill_switch` | `false` | Corta sin reiniciar el pulpo. |
| `cua.notifiable_stages` | `[init, validation, analysis, completion]` | CA-FUNC-6 — qué stages se notifican. Quitar entradas reduce verbosidad. |
| `cua.allowed_commands` | (lista de 25 comandos) | CA-SEC-3 — whitelist explícita. Doble check con regex defensiva. |
| `cua.truncate_chars` | `1500` | Max chars del preview narrable. |
| `cua.dedup_window_hours` | **`1`** | CA-UX-7 — **NO 24h del patrón issues** (el operador corre comandos repetidos varias veces el día). |
| `cua.max_attachment_bytes` | `5242880` (5 MB) | CA-SEC-2 — cap previo al upload (anti DoS bot + anti exfil masiva). |
| `cua.attachment_subroot` | `""` | Subdir bajo `.pipeline/cua-outputs/` (root hardcodeado en código, CA-SEC-5). |
| `cua.audit_file` | `.pipeline/audit/deliverable-notifications.jsonl` | Mismo JSONL que issues; discriminado por `skill:'cua'` + `command` presente. |
| `cua.operator_chat_ids` | `[]` | CA-SEC-6 — chat_ids autorizados a `/rechazar` CUA. **Vacío = fail closed**. |
| `cua.audio_enabled` | `false` | CA-FUNC-3 — TTS opt-in. Default OFF, activar después de estabilizar texto. |
| `cua.kill_switch_audio` | `false` | Corta audio sin afectar texto. |
| `cua.max_tts_chunks` | `3` | Cap superior de chunks por notificación (CA-SEC-2 anti chunk-bombing). |
| `cua.tts_chunk_timeout_ms` | `30000` | Timeout por chunk TTS (CA-SEC-4). |

## Decisión CA-TEC-1: modelo de envelope

Adoptamos la opción **(a)**: el envelope HTML comment incluye `command: <string>` + `issue: null` (explícito, no omitido). Esto evita migrar el envelope de #3414 y mantiene compatibilidad con los parsers existentes. El refactor a `source_ref` agnóstico queda fuera de scope (issue de recomendación #3555).

Formato del envelope CUA:

```html
<!-- pipeline-meta {"issue":null,"command":"load-wave","stage":"validation","skill":"cua","pipeline":"cua","ts":1779915705} -->
```

Consumers del envelope deben tolerar ambas formas: `issue: <number>` o `issue: null + command: <string>`.

## Decisión CA-TEC-2: filtro de stages en el caller

El filtro de `cua.notifiable_stages` se aplica en **`commander-deterministic.js` (caller)**, no en `deliverable-notify.notifyCua()` (dispatcher). Esto deja a `notifyCua()` idempotente: una llamada siempre intenta encolar. `notifyCua()` también verifica el filtro como defensa, pero el camino feliz nunca llega ahí si el stage no está en la lista.

Justificación:
- El config de `notifiable_stages` vive cerca de la lógica de CUA, no en el módulo genérico.
- Permite que el caller decida qué stages emitir sin consultar a `notifyCua()`.

## Decisión CA-TEC-3: política de retención de `.pipeline/cua-outputs/`

**Pendiente** — se difiere a un issue posterior. El directorio se crea al primer adjunto. Cleanup manual hasta que se implemente `cua.retention_days`.

Sugerencia: implementar barrido tipo `find .pipeline/cua-outputs -type f -mtime +<retention_days> -delete` con default 7 días. Ver issue de recomendación pendiente.

## Decisión CA-TEC-4: comportamiento de `/rechazar` sobre stages posteriores

**Por simplicidad de v1**: `/rechazar <command> <stage> <motivo>` solo persiste el evento de rechazo en `.pipeline/rejections/cua-<command>-<stage>-<ts>.json` y notifica al operador. **No** cancela stages posteriores ya en ejecución — el handler del comando puede haber avanzado.

El consumer downstream del evento de rechazo (todavía no implementado) decidirá si:
- Aborta el comando (cuando sea idempotente).
- Solo deja registro histórico (cuando el stage ya se materializó).

Si en el futuro se quiere cancelación real, conviene exponer un `AbortController` desde el dispatcher e inyectarlo en los handlers.

## CA-SEC-* — Notas operativas de seguridad

- **CA-SEC-1** — Whitelist de extensiones hardcodeada en `deliverable-notify.js` (`ALLOWED_CUA_EXTENSIONS`). No es configurable desde `config.yaml` (defensa anti-tampering). Defense in depth: extensión declarada (`attachment.type`) DEBE coincidir con la extensión real del archivo (`path.extname()`).
- **CA-SEC-2** — Cap de tamaño antes del upload (`fs.statSync(path).size > cua.max_attachment_bytes` → rechazo con `attachment_too_large`).
- **CA-SEC-3** — `command` validado por whitelist (`cua.allowed_commands`) Y regex `^[a-z][a-z0-9-]{0,40}$`. Falla cualquiera → `invalid_cua_command` en audit y respuesta clara.
- **CA-SEC-4** — Ajv en runtime sobre el schema. Fail closed: schema_invalid → audit + no notificación.
- **CA-SEC-5** — Root `CUA_ATTACHMENT_ROOT = '.pipeline/cua-outputs/'` hardcodeado. Solo `cua.attachment_subroot` configurable. Path traversal rechazado por `validateAttachmentPath`.
- **CA-SEC-6** — `/rechazar` CUA exige chat_id en `cua.operator_chat_ids` (configurable). Vacío = fail closed. El listener Telegram ya filtra por chat_id principal, esto es defense in depth.
- **CA-SEC-7** — `redactSensitive()` se aplica al texto **antes** de pasar al pipeline TTS. Patrón heredado del audio de issues (#3539) — el archivo `.ogg` nunca persiste secrets legibles.
- **CA-SEC-8** — Dedup key CUA = `sha256(command + stage + ts_minuto + preview_hash)`. Audit JSONL incluye `command` y `issue: null` explícitos.

## CA-UX-* — Iconografía y copy

| Stage / Status | Emoji | Cuándo |
|---|---|---|
| `init` (cualquier status) | ⏳ | Comando arrancó. |
| `validation` + `ok` | ✅ | Stage de validación pasó. |
| `validation` + `fail` | ❌ | Validación rechazó input. |
| `analysis` | 🔍 | Análisis intermedio. |
| `completion` + `ok` | 🎯 | Comando completado. |
| `completion` + `fail` | ⚠️ | Errores no fatales. |
| Adjunto | 📎 | Hay archivo para revisar. |

Header inequívoco: **`⚙️ /<command> [<args>] — <stage>`**. NO se reutiliza `#NNNN` (eso es de issues).

Ejemplo de mensaje bien formado:

```
⚙️ /load-wave n11 — validation
✅ Ola N+11 validada — 9 issues, 0 bloqueados

⏱ 3.2s
📎 wave-n11.json adjunto abajo
```

## API pública

### `deliverable-notify.js`

```js
const dn = require('./.pipeline/lib/deliverable-notify');

// Fachada de alto nivel (zero-blocking, fire-and-forget audio):
const r = dn.notifyCua({
  entregable: { command, stage, status, preview, attachment?, duration?, error?, args? },
  config: cuaConfigBlock,            // del config.yaml
  pipelineRoot: '/abs/path',
  telegramQueueDir: '/abs/path/.pipeline/servicios/telegram/pendiente',
  deps: { /* hooks de tests */ }
});
// r.ok === true  → action='enqueued'
// r.ok === false → action='skipped'|'rejected'|'error', r.reason='...'
```

### `commander-deterministic.js`

```js
const cmd = require('./.pipeline/lib/commander-deterministic');

// Crear emisor reutilizable (los handlers fuera del switch determinístico
// también pueden usarlo):
const emitter = cmd.createCuaEmitter({
  config: cuaConfigBlock,
  pipelineRoot,
  telegramQueueDir,
  log,
});
emitter.emit({ command, stage, status, preview });

// O usar el dispatcher con el bloque cua inyectado:
const d = cmd.createDispatcher({
  pipelineRoot, logsDir, expectedChatId,
  cua: { config: cuaConfigBlock, pipelineRoot, telegramQueueDir, log },
});
// Los handlers reciben `ctx.cuaEmit` para emitir stages internos.
```

### `commander/rechazar-handler.js`

`createRechazarHandler` ahora acepta:
- `cuaOperatorChatIds: string[]` — CA-SEC-6, allowlist de operadores autorizados a rebobinar CUA.
- `allowedCuaCommands: string[]` — sincronizado con `cua.allowed_commands`.

Parser: si el primer token NO es numérico Y matchea `^[a-z][a-z0-9-]{0,40}$` Y el segundo token está en `{init, validation, analysis, completion}` → se trata como rechazo CUA. Caso contrario → fallback al parser regular de issues.

## Audit JSONL

Records CUA conviven con los de issues en el mismo archivo (default `.pipeline/audit/deliverable-notifications.jsonl`), discriminados por `skill: 'cua'`:

```json
{"ts":"2026-05-27T21:01:45.939Z","issue":null,"command":"load-wave","stage":"validation","status":"ok","skill":"cua","pipeline":"cua","dedup_hash":"63bc3f5d...","content_hash":"aaa0f00...","preview":"⚙️ /load-wave · validation\n✅ ...","telegram_enqueue_ok":true,"dropfile":"1779915705940-cua-load-wave-validation.json"}
```

Audio TTS genera un record paralelo con `kind: 'audio_cua'` (los records `kind: 'audio'` siguen siendo de issues).

**Breaking change implícito**: consumers que esperan `issue: number` ahora deben tolerar `issue: null` en records CUA. Lo registramos como observación en este doc para que cualquier herramienta downstream (dashboard, reportes) lo adopte sin sorpresas.

## Tests

Ver [`.pipeline/tests/cua-notifications.test.js`](../../.pipeline/tests/cua-notifications.test.js).

Cobertura:
- Schema invalid → fail closed con audit `schema_invalid`.
- Command fuera de whitelist → audit `command_not_in_whitelist`.
- Command con regex inválida (`../etc/passwd`, `<script>`) → audit `command_regex_mismatch`.
- Adjunto con extensión denegada (`.exe`, `.sh`) → audit `extension_not_allowed`.
- Adjunto con extensión declarada distinta de la real → audit `extension_mismatch`.
- Adjunto path traversal → audit `parent_segment`.
- Adjunto excede `cua.max_attachment_bytes` → audit `attachment_too_large`.
- Dedup CUA: dos notificaciones idénticas en mismo minuto → segunda deduplicada; preview distinto → ambas se notifican.
- `redactSensitive()` aplicado antes del TTS.
- `parseCuaTextArgs`: branch CUA vs branch issue.
- `/rechazar` CUA sin chat_id autorizado → `unauthorized_rebobinar`.

Ejecutar:

```bash
node --test .pipeline/tests/cua-notifications.test.js
```

## Rollout

1. Mergear con `cua.enabled: false`. Tests + smoke local.
2. Activar `cua.enabled: true` y `audio_enabled: false`. Observar audit 1-2 días.
3. Sumar el chat_id de Leo a `cua.operator_chat_ids` para habilitar `/rechazar` CUA.
4. Activar `audio_enabled: true` después de estabilizar texto.
5. Si aparece ruido, `kill_switch: true` corta sin reiniciar el pulpo.

## Issues relacionados

- **#3414** — Patrón base de notificación (text + envelope + audit + dedup).
- **#3415** — `/rechazar` para entregables de issues.
- **#3539** — Audio TTS base (`multimedia.js` + perfiles).
- **#3540** — Adjuntos multimedia (deseable, no bloqueante para #3541).
- **#3555** — Refactor envelope a `source_ref` agnóstico (recomendación, no bloqueante).
- **#3556** — Extraer `attachment-policy.js` reusable (recomendación, no bloqueante).
