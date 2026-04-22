# Pipeline V3 — Metricas extendidas (issue #2477)

Capa transversal de trazabilidad y consumo para el pipeline V3. Define el contrato de eventos que **todos los skills** (LLM y deterministicos) deben emitir, implementa los helpers compartidos y expone los endpoints de consulta.

Este documento describe **la capa comun**. La instrumentacion concreta de cada skill vive en el issue de migracion de ese skill (builder #2476, reset, cleanup, monitor, cost, branch, delivery, etc.).

## Objetivo

Responder en tiempo real, con cualquier corte temporal, preguntas como:

- Cuantos tokens consumio cada skill (input + output + cache read + cache write).
- Cuanto duro cada skill (wall-clock).
- Cuantos caracteres / segundos de audio TTS genero cada skill.
- Cual fue el costo end-to-end de un issue, fase por fase.

Cortes soportados: **por agente/skill**, **por fase** (`definicion`, `dev`, `build`, `qa`, `review`, etc.) y **por issue** (pipeline completo de intake a merge).

## Schema de eventos

Los eventos se escriben al activity-log compartido (`.claude/activity-log.jsonl`) como lineas JSON.

### `session:start`

```json
{
  "event": "session:start",
  "skill": "android-dev",
  "issue": 2476,
  "phase": "dev",
  "model": "claude-opus-4-7",
  "ts": "2026-04-22T11:00:00.000Z",
  "pid": 12345
}
```

### `session:end`

```json
{
  "event": "session:end",
  "skill": "android-dev",
  "issue": 2476,
  "phase": "dev",
  "model": "claude-opus-4-7",
  "tokens_in": 45200,
  "tokens_out": 8900,
  "cache_read": 120000,
  "cache_write": 3000,
  "duration_ms": 1140000,
  "tool_calls": 34,
  "exit_code": 0,
  "ts": "2026-04-22T11:19:00.000Z",
  "pid": 12345
}
```

Para **skills deterministicos**: `tokens_in = tokens_out = cache_read = cache_write = 0` y `model = "deterministic"`. Esto mantiene el schema homogeneo y permite comparar duraciones y tasa de rebote independientemente del tipo de skill.

### `tts:generated`

```json
{
  "event": "tts:generated",
  "skill": "qa",
  "issue": 2461,
  "phase": "qa",
  "provider": "openai",
  "chars": 820,
  "audio_seconds": 42.5,
  "voice": "alloy",
  "cost_estimate_usd": 0.0123,
  "ts": "2026-04-22T11:00:00.000Z"
}
```

## Componentes

### Helpers comunes (`.pipeline/lib/`)

| Archivo | Exporta | Uso |
|---|---|---|
| `traceability.js` | `emitSessionStart({skill, issue, phase, model})`, `emitSessionEnd(handle, metrics)`, `estimateCostUsd(model, tokens)`, `MODEL_PRICING` | Invocado por skills deterministicos en `main()`; por el Pulpo al spawnear skills LLM. |
| `tts-logger.js` | `wrapTts(ctx, fn)`, `emitTtsGenerated(ctx)`, `estimateAudioSeconds(chars)`, `estimateTtsCost(provider, seg, chars)` | Se envuelve a cualquier invocacion TTS (OpenAI, edge-tts) para que emita el evento automaticamente. |

**Context envvars** (pickup automatico cuando los opts no traen el campo):

- `PIPELINE_SKILL` — nombre del skill (builder, qa, android-dev...).
- `PIPELINE_ISSUE` — numero del issue de GitHub.
- `PIPELINE_FASE` / `PIPELINE_PHASE` — fase actual del pipeline.

Asi los skills no tienen que pasar el contexto explicitamente en cada llamada.

### Agregador (`.pipeline/metrics/aggregator.js`)

Lee `activity-log.jsonl` y construye el snapshot agrupado.

```bash
node .pipeline/metrics/aggregator.js --once               # un snapshot y salir
node .pipeline/metrics/aggregator.js --window 24h         # ventana temporal
node .pipeline/metrics/aggregator.js                      # modo daemon (refresh cada 60s)
node .pipeline/metrics/aggregator.js --refresh 30000      # refresh custom (ms, min 5s)
```

Output: `.pipeline/metrics/snapshot.json` con:

- `totals` — agregados globales de la ventana.
- `agents[]` — bucket por skill, ordenado por costo descendente.
- `phases[]` — bucket por fase, ordenado por costo.
- `issues[]` — bucket por issue + `timeline` (eventos ordenados temporalmente).
- `tts.by_provider[]` / `tts.by_agent[]` — desglose TTS.
- `pricing` — snapshot del `MODEL_PRICING` vigente (referencia).

Ventanas soportadas: `1h`, `24h`, `7d`, `all`, o cualquier `Nh` / `Nd`.

### Pagina `/consumo`

Dashboard V3 expone la pagina `http://localhost:3200/consumo` con tres tabs:

- **Por agente**: tokens / cache / duracion prom. / TTS / costo por skill.
- **Por fase**: mismo desglose por fase del pipeline.
- **Por issue**: ranking por costo + drill-down (click en fila) al timeline completo del issue con todos los eventos ordenados cronologicamente.

Selector de ventana temporal y auto-refresh cada 60s. Link directo desde el header del dashboard (badge `Consumo`).

### Endpoints JSON

| Endpoint | Descripcion |
|---|---|
| `GET /metrics/snapshot?window=24h` | Snapshot completo (totals + agents + phases + issues + tts). |
| `GET /metrics/totals?window=24h` | Solo totales agregados. |
| `GET /metrics/agents?window=24h` | Ranking por skill. |
| `GET /metrics/phases?window=24h` | Ranking por fase. |
| `GET /metrics/issues?window=24h` | Todos los issues con actividad. |
| `GET /metrics/issues/:n?window=24h` | Timeline end-to-end de un issue (incluye `not_found:true` si no hay eventos). |
| `GET /metrics/tts?window=24h` | Desglose TTS por provider y por agente+provider. |

Todos aceptan `window` en querystring. Default: `all`.

### Reporte diario

```bash
node .pipeline/metrics/report-daily.js             # ventana 24h + envio Telegram
node .pipeline/metrics/report-daily.js --dry       # solo HTML + PDF local, sin enviar
node .pipeline/metrics/report-daily.js --window 7d # ventana custom
```

Genera `docs/qa/reporte-consumo-v3-YYYY-MM-DD.html` y lo envia por Telegram via `scripts/report-to-pdf-telegram.js` (pipeline unificado HTML -> PDF -> Telegram ya existente).

## Pricing

`MODEL_PRICING` en `lib/traceability.js` esta alineado al pricing publico de Anthropic (USD por 1M tokens):

| Modelo | input | output | cache_read | cache_write |
|---|---|---|---|---|
| claude-opus-4-7 | 15.00 | 75.00 | 1.50 | 18.75 |
| claude-opus-4-6 | 15.00 | 75.00 | 1.50 | 18.75 |
| claude-sonnet-4-6 | 3.00 | 15.00 | 0.30 | 3.75 |
| claude-haiku-4-5 | 1.00 | 5.00 | 0.10 | 1.25 |
| deterministic | 0 | 0 | 0 | 0 |

Actualizar aca si Anthropic cambia precios. No pretendemos reflejar billing real (no hay API publica de facturacion); la estimacion sirve para ranking relativo y deteccion de deltas sospechosos entre dias.

TTS:

| Provider | Costo |
|---|---|
| openai (gpt-4o-mini-tts) | ~$0.00025 / seg de audio |
| edge-tts (Microsoft) | gratis |

## Contrato para migraciones V3

Cuando se migra un skill LLM a deterministico (o se instrumenta un skill LLM existente), el issue correspondiente DEBE:

1. Reemplazar (o envolver) el punto de entrada con un llamado a:
   ```js
   const trace = require('../lib/traceability');
   const handle = trace.emitSessionStart({ skill, issue, phase, model });
   // ... trabajo ...
   trace.emitSessionEnd(handle, { tokens_in, tokens_out, cache_read, cache_write, tool_calls, exit_code });
   ```
   (Deterministicos: todos los tokens en 0, model `deterministic`.)

2. Si el skill genera audio TTS, envolver la invocacion:
   ```js
   const { wrapTts } = require('../lib/tts-logger');
   const audio = await wrapTts({ skill, issue, phase, provider: 'openai', voice, chars: text.length },
       () => openaiTts(text));
   ```

3. Verificar al cerrar el issue que los eventos aparezcan en `/metrics/issues/<numero>` y en la pagina `/consumo` → tab `Por issue`.

## Fuera de scope

- Control automatico / throttling por costo — este issue solo mide. Acciones (cambiar modelos, recortar prompts) viven en issues separados informados por estos datos.
- Backfill historico de eventos pre-V3 — las metricas son forward-only desde el primer skill instrumentado.
- Billing real de Anthropic — usamos estimacion por pricing publico.

## Relacionado

- #2477 — este capa comun.
- #2476 — primer consumidor (builder deterministico).
- #2478 — estado `bloqueado-humano` (complementa V3 para evitar rebotes caros).
- `docs/qa/reporte-eficiencia-tokens-v2-2026-04-22.pdf` — reporte que motivo V3.
