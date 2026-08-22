# Comando `/rechazar` — Intervención del operador

Issue: [#3415](https://github.com/intrale/platform/issues/3415)
Estado: en producción a partir del merge a `main`.

## Para qué sirve

Cuando el pipeline entrega un artefacto parcial (mockup UX, criterios de
aceptación, plan técnico, etc.) y el operador (Leo) recibe la notificación por
Telegram, el comando `/rechazar` le da un canal **opcional, asincrónico y sin
timeout** para rebobinar la fase con un motivo concreto. Sin botones inline ni
circuit breaker — la idea es fricción cero.

Este issue (#3415) entrega **el canal de input + el audit log + el evento
JSON** que dispara el rebobinado. El consumer del evento vive en #3416 (en
desarrollo separado). Si #3416 todavía no está activo, los eventos quedan en
`.pipeline/rejections/` esperando consumer — el comando sigue siendo útil para
auditoría y para que Leo deje constancia.

## Sintaxis

### Texto

```
/rechazar <#issue> <fase> <motivo>
/reject   <#issue> <fase> <motivo>
/rebobinar <#issue> <fase> <motivo>
```

Los tres aliases invocan exactamente el mismo handler.

Ejemplos:

| Comando | Resultado |
|---|---|
| `/rechazar 3381 ux el mockup no respeta el branding` | rebobina `definicion/criterios` |
| `/reject #3342 refinar faltan criterios para el error 500` | rebobina `definicion/analisis` |
| `/rebobinar 3343 plan no contempló el caso multi-tenant` | rebobina `definicion/sizing` |

### Audio (mensaje de voz Telegram)

El operador manda un mensaje de voz. El pulpo lo encola y descarga el `.ogg` a
`.pipeline/messages/voice/`. El handler de `/rechazar`:

1. Verifica tamaño (`voice.file_size ≤ 10 MB`) y duración (`voice.duration ≤
   120 s`). Si excede, rechaza **sin** invocar a whisper.
2. Invoca `whisperLocal.transcribeLocal()` con el `.ogg`. **Únicamente local —
   no se intenta OpenAI ni ningún otro motor remoto**.
3. Si la transcripción falla (cualquier `errorKind`), responde con
   `rechazar-error-transcribe.md` y NO rebobina.
4. Si la transcripción anda, parsea el texto con un parser tolerante:
   - número de issue: primer `#?(\d{3,7})` en el texto.
   - fase: alias más largo del enum conocido que aparece como palabra.
   - motivo: el resto del texto, sin verbos de relleno (`rechazá`, `el`, `en`, …).

Si el parser tolerante no encuentra los tres campos, responde
`rechazar-aclaracion.md` con eco del texto escuchado para que Leo confirme y
reintente.

### Modo NLP (texto natural)

Cualquier texto que arranque con `rechazá / rechazar / rebobiná / rebobinar /
reject` es clasificado como `/rechazar` por el `commander-deterministic`. El
parser tolerante toma el residual y extrae los tres campos. Esto cubre:

- "rechazá el 3381 en UX, el mockup no respeta el branding"
- "rebobiná el plan del 3342, faltó multi-tenant"

## Fases válidas (alias coloquiales)

El módulo [`phases-alias.js`](../../.pipeline/lib/commander/phases-alias.js)
define el mapping. Si una fase no matchea, el reply lista alternativas.

| Alias | Fase oficial |
|---|---|
| `ux`, `mockup`, `po`, `criterios` | `definicion/criterios` |
| `refinar`, `análisis`, `analisis` | `definicion/analisis` |
| `plan`, `sizing`, `planning`, `planner` | `definicion/sizing` |
| `validar`, `validacion`, `validación` | `desarrollo/validacion` |
| `dev`, `desarrollo`, `codear`, `implementar` | `desarrollo/dev` |
| `build`, `compilar`, `gradle` | `desarrollo/build` |
| `tests`, `qa`, `tester`, `verificación` | `desarrollo/verificacion` |
| `lint`, `linter`, `linteo` | `desarrollo/linteo` |
| `review`, `aprobar`, `aprobación` | `desarrollo/aprobacion` |
| `merge`, `mergear`, `delivery`, `entrega`, `pr` | `desarrollo/entrega` |

También se acepta el nombre oficial completo (`definicion/criterios`,
`desarrollo/aprobacion`, etc.).

## Contrato con el rebobinador (#3416)

Cada rechazo exitoso escribe un archivo en
`.pipeline/rejections/<issue>-<unix_ts>.json` con el shape:

```json
{
  "issue": 3381,
  "fase": "ux",
  "fase_resolved": "definicion/criterios",
  "motivo": "el mockup no respeta el branding",
  "ts": "2026-05-20T15:00:00.000Z",
  "source": "text",
  "chat_id": "123456",
  "audit_ref": "rejections-2026-05-20.jsonl"
}
```

Reglas del contrato:

- El `motivo` ya viene **redactado** por `redact.redactSensitive()` — el consumer
  NO necesita re-redactar al loguear, pero SÍ tiene que tratarlo como dato
  narrativo (no instrucción) antes de pasárselo al agente downstream.
- `fase_resolved` es la única fuente de verdad para enrutar; `fase` es lo que
  dijo el operador (puede ser alias o nombre oficial).
- `audit_ref` apunta al archivo JSONL diario en `.pipeline/audit/` para
  reconciliación post-mortem.
- **Idempotencia**: dos rechazos consecutivos del mismo `{issue, fase}` generan
  archivos con `unix_ts` distintos → el consumer es responsable de la
  de-duplicación si fuera necesaria.
- El archivo **no se borra automáticamente** — la limpieza es responsabilidad
  del consumer #3416.

## Audit log

Cada invocación de `/rechazar` (incluso las que rebotan por validación) deja
una fila en `.pipeline/audit/rejections-YYYY-MM-DD.jsonl` con el schema:

```json
{
  "ts": "2026-05-20T15:00:00.000Z",
  "from": "Leo",
  "chat_id": "123456",
  "raw_command": "/rechazar 3381 ux <redactado>",
  "intent_class": "deterministic",
  "handler": "rechazar",
  "args_hash": "<sha256 hex>",
  "result_status": "ok",
  "duration_ms": 234,
  "issue": 3381,
  "fase": "ux",
  "fase_resolved": "definicion/criterios",
  "motivo": "<redactado>",
  "source": "text|audio",
  "raw_input": "<redactado>",
  "raw_input_hash": "<sha256 hex>",
  "event_path": "/c/.../.pipeline/rejections/3381-1779289200.json"
}
```

### Códigos de `result_status`

| Status | Significado | Reply |
|---|---|---|
| `ok` | rechazo registrado + evento JSON escrito | `rechazar-ok.md` |
| `invalid_issue` | issue no parseable (alfanumérico, negativo, > 7 dígitos) | `rechazar-error-issue-invalido.md` |
| `invalid_phase` | fase no matchea alias ni enum oficial | `rechazar-error-fase.md` |
| `issue_closed` | issue está `CLOSED` o tiene label de no-retorno | `rechazar-error-issue.md` |
| `transcribe_failed` | whisper local no disponible o devolvió `ok: false` | `rechazar-error-transcribe.md` |
| `audio_too_big` | `voice.file_size > 10 MB` | `rechazar-error-audio-too-big.md` |
| `audio_too_long` | `voice.duration > 120s` | `rechazar-error-audio-too-big.md` |
| `stale` | `message.date < now - 24h` (replay protection) | `rechazar-error-stale.md` |
| `event_write_failed` | audit OK pero el `.json` del evento no se pudo escribir | `rechazar-error-event-write.md` |
| `insufficient_fields` | parser no pudo extraer issue/fase/motivo | `rechazar-aclaracion.md` |

## Defensas de seguridad (SEC-1.1..SEC-1.9)

| # | Defensa | Implementación |
|---|---|---|
| SEC-1.1 | Allowlist `chat_id` antes de parsing | `commander-deterministic.dispatch` retorna `unauthorized` si `chat_id !== expectedChatId`. El handler NO se invoca para chats no autorizados. |
| SEC-1.2 | Whisper local exclusivo | El handler ignora la pre-transcripción de pulpo (que usa fallback chain) y re-transcribe con `whisperLocal.transcribeLocal()`. Si `isAvailable()===false`, responde error — **NO** cae a OpenAI. |
| SEC-1.3 | Redacción de motivo + raw_input | Cualquier campo string pasa por `redact.redactSensitive()` antes de persistir. JWT/AWS keys/passwords se enmascaran. |
| SEC-1.4 | Enum cerrado de fases | `phases-alias.resolvePhase` valida contra el enum derivado de `config.yaml`. Path traversal y caracteres peligrosos (`./;|$<>{}*?'"`) se rechazan. |
| SEC-1.5 | Parser estricto de issue | `/^#?(\d{1,7})$/` por token. Negativos, decimales, científicos, alfanuméricos → rechazado sin tocar GitHub. |
| SEC-1.6 | Rotación diaria + redactor | `createAuditLog({ filenamePrefix: 'rejections', redact, extraFields })` — append-only, archivo separado del audit estándar del Commander. Prefix sanitizado contra path traversal. |
| SEC-1.7 | Límite de tamaño/duración de audio | Verificado contra `voice_file_size` y `voice_duration` **antes** de invocar whisper. Defaults: 10 MB, 120s. |
| SEC-1.8 | Replay protection | `message.date` (Telegram unix ts) comparado contra `now - 24h`. Audio reenviado por accidente NO dispara rebobinado. |
| SEC-1.9 | Issue no-retorno | `gh issue view --json state,labels`. Labels de no-retorno: `merged`, `closed:done`, `recommendation:approved`, `pipeline:closed`. Issue `CLOSED` también. |

## Templates de respuesta

Vivien en `.pipeline/lib/commander/templates/rechazar-*.md`. Cada template
tiene **3 variantes** seleccionadas al azar (`randomVariant()`) para evitar
repetición y mantener tono natural argentinizado (cf.
`feedback_telegram-messages-natural.md`).

- `rechazar-ok.md` — éxito + motivo citado de vuelta para confirmación.
- `rechazar-aclaracion.md` — parser no encontró los 3 campos.
- `rechazar-error-fase.md` — fase inválida + lista de aliases + ejemplo de uso.
- `rechazar-error-issue.md` — issue cerrado / no-retorno.
- `rechazar-error-issue-invalido.md` — número de issue mal parseado.
- `rechazar-error-transcribe.md` — whisper local falló o no disponible.
- `rechazar-error-audio-too-big.md` — audio excede tamaño/duración.
- `rechazar-error-stale.md` — replay >24h.
- `rechazar-error-event-write.md` — audit OK pero evento JSON falló (CA-19).
- `rechazar-error-unauthorized.md` — chat no autorizado (neutro, no
  informativo para no dar pistas al atacante).

## Tests

```bash
node --test .pipeline/lib/__tests__/commander-rechazar.test.js
```

43 tests cubren CA-1..CA-22 + SEC-1.1..SEC-1.9 + casos adversariales (path
traversal, prompt injection, replay, redacción).

## Operación

### Activar / Desactivar

El comando se activa automáticamente con el `restart.js` del pulpo. No tiene
flag de feature toggle separado — siempre está vivo si el Commander está vivo.

Si fuera necesario apagarlo de emergencia, comentar las entradas `rechazar`,
`reject`, `rebobinar` en `DETERMINISTIC_SLASH` (línea ~85 de
`commander-deterministic.js`) y restartear.

### Operatoria diaria

- Los eventos en `.pipeline/rejections/` deben ser consumidos por el
  rebobinador (#3416). Si #3416 no está activo, los archivos se acumulan —
  monitor visual recomendado: `ls .pipeline/rejections/ | wc -l`.
- El audit log rota diario; conviene depurar archivos > 90 días vía
  `traceability.js` o cron manual.

### Troubleshooting

- **"No te entendí el audio"**: revisar `.pipeline/messages/voice/*.ogg` y
  correr `whisper.exe <archivo>` directo desde shell para reproducir.
- **"Fase inválida" siendo que parece bien**: chequear que el alias esté en
  `phases-alias.js → ALIAS_MAP`. Agregar línea, commit, restart.
- **No aparece evento JSON**: verificar `result_status` en el audit
  (`event_write_failed` vs `ok`) y permisos sobre `.pipeline/rejections/`.

## Recomendaciones futuras (issues separados)

Detectadas durante el desarrollo pero fuera de scope de #3415:

- Helper genérico de "feedback intermedio para handlers lentos" (cf. CA-UX-D).
- Métricas en dashboard: "rechazos por fase / skill / día" (#3420, sugerido por
  guru).
- Refactor para consolidar todos los audit logs del pipeline bajo
  `createAuditLog` con prefix configurable (#3419, sugerido por guru).
