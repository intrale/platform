# Telegram handlers proactivos del pipeline

> **Audiencia:** developers del pipeline V3 (`.pipeline/`) y operadores que necesitan diagnosticar por qué llegó (o no llegó) una notificación al Telegram personal de Leo.
>
> **Diferencia con `servicio-telegram.js`:** los handlers de este documento envían **directo** a la Bot API por HTTPS (con SSRF guard, redacción, fail-soft). El `servicio-telegram.js` clásico procesa una cola en `.pipeline/servicios/telegram/pendiente/` y mandan al chat principal. Los handlers proactivos se reservan para notificaciones específicas dirigidas al **chat operador** (`telegram.leo_operator_chat_id`).

## Catálogo de handlers

| Handler | Función | Issue origen | Trigger |
|---------|---------|--------------|---------|
| `telegram-notifier.notifyMockupToOperator` | Empuja a Leo el PNG del "estado esperado" generado por `/ux` (Caso A dashboard / Caso B Android) | #3384 | Skill `/ux` modo `screenshot-mockup`, paso S4.b — después de adjuntar el PNG al issue de GitHub. |

## `notifyMockupToOperator({...})`

Implementación: `.pipeline/lib/telegram-notifier.js`.

### Firma

```js
const { notifyMockupToOperator } = require('./.pipeline/lib/telegram-notifier');
const result = await notifyMockupToOperator({
  issueNumber,
  issueTitle,
  caseType,           // 'dashboard' | 'android-client' | 'android-business' | 'android-delivery'
  mockupPath,         // path local al PNG generado por LLM
  changeDescription,
  repoRoot,           // opcional — default PIPELINE_REPO_ROOT/CLAUDE_PROJECT_DIR/cwd
  deps,               // opcional — inyección para tests (http, sharp, env, logFile, applyRateLimit)
});
// → { ok: boolean, action: 'sent'|'skipped'|'error', reason?: string, statusCode?: number }
```

### Caption final

```
🖼 #<N> — <título truncado a 60 chars>
<emoji caso> <caseType>

<descripción truncada a 600 chars>

Mockup generado automáticamente · fase de definición
🔗 https://github.com/intrale/platform/issues/<N>
```

Emojis canónicos por `caseType` (CA-UX-2):

| caseType            | Emoji |
|---------------------|-------|
| `dashboard`         | 🖥    |
| `android-client`    | 📱    |
| `android-business`  | 🏪    |
| `android-delivery`  | 🛵    |

### Defensas

| Frente                         | Mecanismo                                                                                              | Test asociado                                          |
|--------------------------------|--------------------------------------------------------------------------------------------------------|--------------------------------------------------------|
| Filtración del bot token       | `redact.redactUrlLike()` antes de escribir cualquier mensaje al log (`/bot<TOKEN>` → `/bot[REDACTED]`) | `CA-S-1 / CA-S-8 · fallo de red NO escribe el bot token raw en el log` |
| Path traversal en `mockupPath` | Rechaza `..`, null bytes, paths fuera del repo, symlinks, no-`.png`, > 10MB, vacíos                    | Suite `CA-S-2 · ...` (8 casos)                          |
| Prompt-injection en caption    | Caption se envía como **texto plano** (sin `parse_mode`) — ningún `*`/`_`/`[` rompe el render          | (cubierto implícitamente por la suite CA-F-5)          |
| Filtración del `chat_id`       | El logger reemplaza apariciones del chat_id por `<chat_id>` antes de escribir                          | `CA-S-4 · chat_id no aparece en el log...`             |
| Rate-limit / retry storm       | 1 mensaje/seg por proceso. **No** retry automático (Telegram no es idempotente para sendPhoto)         | `CA-F-10 · ... rate-limit de 1s`                       |
| TOCTOU del PNG                 | Se lee a `Buffer` antes de tocar la red; no se re-lee del disco al enviar                              | (cubierto por la suite CA-F-5)                          |

### Configuración

Credencial nueva (estructura nested unificada en `~/.claude/secrets/credentials.json`, #3311):

```json
{
  "telegram": {
    "bot_token": "...",
    "chat_id": "...",
    "leo_operator_chat_id": "<chat_id del operador>"
  }
}
```

El cargador `.pipeline/lib/credentials.js#loadIntoEnv()` mapea automáticamente:

```
telegram.leo_operator_chat_id  →  TELEGRAM_LEO_OPERATOR_CHAT_ID
```

**Sin esa credencial el handler se autoinhabilita** silenciosamente — el `/ux` sigue cerrando normalmente.

Override opcional en `.claude/settings.json`:

```json
{ "telegram": { "notify_ux_mockups": false } }
```

→ skip explícito (útil para cortar el handler en un entorno específico sin tocar credenciales).

### Defaults y umbrales

| Constante                       | Valor          | Razón                                                                                      |
|---------------------------------|----------------|--------------------------------------------------------------------------------------------|
| `MAX_TITLE_CHARS`               | 60             | CA-UX-1 — header legible en mobile.                                                        |
| `MAX_DESCRIPTION_CHARS`         | 600            | CA-UX-5 — escaneabilidad antes del cap duro de Telegram.                                   |
| `MAX_CAPTION_CHARS`             | 1024           | Cap duro de Telegram (defensa adicional).                                                  |
| `MAX_PNG_BYTES`                 | 10 MB          | CA-S-2 — límite oficial Telegram para `sendPhoto`.                                         |
| `COMPRESS_THRESHOLD_BYTES`      | 1.5 MB         | CA-UX-6 — arriba de eso intentamos comprimir con `sharp` si está disponible.               |
| `TIMEOUT_MS`                    | 5000           | CA-F-9 — fail-soft, no bloqueamos el cierre del issue por una red lenta.                   |
| `RATE_LIMIT_MS`                 | 1000           | CA-F-10 — un mensaje por segundo por proceso.                                              |

### Logs operativos

- **Path:** `.pipeline/logs/telegram-notifier.log` (creado on-demand, append-only).
- **Formato:** `[ISO-8601] [telegram-notifier] <mensaje redactado>`
- **Qué se loguea:** path inválido, fallos de red, status no-2xx de Telegram, sharp ausente.
- **Qué NO se loguea:** el bot token raw (CA-S-1), el `chat_id` del operador (CA-S-4), payloads multipart.

### Trazas comunes y diagnóstico

| Síntoma                                                            | Causa probable                                          | Verificación                                                                                |
|--------------------------------------------------------------------|---------------------------------------------------------|---------------------------------------------------------------------------------------------|
| El handler devuelve `{ reason: 'no_operator_chat_id' }`            | Falta `telegram.leo_operator_chat_id` en credentials    | `node .pipeline/lib/credentials.js` → verificar `TELEGRAM_LEO_OPERATOR_CHAT_ID` en hydrated |
| `{ reason: 'invalid_mockup_path:invalid_extension' }`              | El UX pasó algo que no termina en `.png`                | Verificar el output de `ux-mockup-generator.js`                                             |
| `{ reason: 'invalid_mockup_path:outside_repo' }`                   | `mockupPath` apunta fuera de `PIPELINE_REPO_ROOT`       | Confirmar que el UX trabaja dentro del worktree del pipeline                                |
| `{ action: 'error', reason: 'telegram_non_2xx', statusCode: 401 }` | Bot token revocado o incorrecto                         | Rotar el token (ver `docs/runbooks/credential-rotation.md`)                                 |
| `{ action: 'error', reason: 'ENOTFOUND' }`                         | Red caída                                               | Telegram quedó inalcanzable; el log queda como evidencia                                    |

### Tests

`node --test .pipeline/lib/__tests__/telegram-notifier.test.js`

Cubre los 26 CA consolidados del issue #3384 (12 funcionales + 8 seguridad + 6 operator-UX). Los tests no hacen red real — todo es contra mocks de `http-client` y `sharp`.

## Roadmap

Si en el futuro aparecen más notificaciones proactivas al operador (por ejemplo: alerta de rebote de QA en cadena, fin de sprint, etc.), agregar acá la nueva función en la tabla "Catálogo de handlers" y reutilizar `lib/telegram-notifier.js` como base. **No** mezclar handlers proactivos con la cola de `servicio-telegram.js` — son flujos distintos y la separación es intencional para acotar superficie de fallo.
