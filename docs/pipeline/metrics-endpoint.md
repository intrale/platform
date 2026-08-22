# Endpoint `/metrics` — contrato y deny-list de seguridad

> Documento producido en #3733 (split de #3715 — ventana KPIs V3).
> Cierra la memoria `project_metrics-endpoint-lost`: el endpoint **nunca estuvo
> caído** — vive en `dashboard.js`. Lo que se había perdido era el **link visual**
> desde la home V3, recuperado con el CTA de la ventana `?view=kpis` (CA-9).

## Contrato actual

El dashboard del pipeline (`.pipeline/dashboard.js`, bind loopback `127.0.0.1:3200`)
expone dos endpoints de métricas históricas:

### `GET /metrics` — página HTML

Render server-side de la página de métricas históricas. El body lo produce
`views/dashboard/kpis.js::renderMetricsPage({ data })`, consumiendo el slice de
`lib/kpis-data.js::getMetricsSlice(ctx)`. Si la vista no cargó, `dashboard.js`
cae a un body legacy inerte (CA-A3) — nunca tira 500.

Contenido:

- **Snapshots del Pulpo** (CPU/RAM/agentes) en ventanas 1h/6h/24h: promedios, máximos,
  sparklines y gráficos de serie temporal.
- **Throughput de entregas** (issues entregados 24h / histórico).
- **Tasa de rechazo** (`rechazados / procesados`).
- **Tokens estimados** (proxy `duración_seg × 15 + tools × 500`) + costo USD estimado.
- **Velocidad por fase** (promedios de ETA por fase/skill).
- **Top sesiones por consumo** — con **session IDs truncados a 8 chars** (CA-17).
- **Rendimiento por agente** (issues, duración media, % rechazo, tool calls).
- **DORA adaptado** (Lead Time / Throughput / Change Failure Rate, rolling 7d).

### `GET /api/metrics` — JSON crudo

Devuelve el objeto de `getMetricsData()` (= `getMetricsSlice`) serializado. Shape:

```jsonc
{
  "snapshots":       [ { "ts": 0, "cpu": 0, "mem": 0, "agents": 0, "level": "green" } ],
  "etaAverages":     { "<fase>": { "avgMs": 0, "count": 0 } },
  "entregas":        [ { "issue": "1234", "ts": 0 } ],
  "tokenEstimates":  { "totalSessions": 0, "totalTools": 0, "totalEstimatedTokens": 0,
                       "bySession": [ { "id": "abcdefgh", "tools": 0, "durMin": 0, "tokens": 0 } ] },
  "totalProcessed":  0,
  "totalRejected":   0,
  "agentPerf":       { "<skill>": { "issues": 0, "rejected": 0, "totalDurMs": 0, "durCount": 0, "toolCalls": 0 } }
}
```

Consumidores conocidos: scripts del pipeline y bots de Telegram (lectura programática).
Por eso el endpoint **se mantiene** (ver "Decisión sobre legacy" abajo).

### Headers de respuesta (CA-15)

Ambos endpoints responden con:

```
Cache-Control: no-store, no-cache, must-revalidate
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

y **NO** setean `Access-Control-Allow-Origin` (endpoint local-only). `/metrics`
usa `Content-Type: text/html; charset=utf-8`; `/api/metrics` usa
`application/json; charset=utf-8`.

### Same-origin enforcement (CA-18)

`/api/metrics` valida el header `Origin`: si está presente y su host **no** coincide
con el `Host` del request → `403`. Scripts/CLI/Telegram no envían `Origin` (pasan);
un fetch cross-site desde el browser sí lo envía (se rechaza). Defense in depth sobre
el bind loopback.

## Datos que `/metrics` NO expone (deny-list de `security`)

El endpoint **jamás** debe emitir ninguno de estos valores. Es un contrato: cualquier
cambio futuro a `getMetricsSlice` o `renderMetricsPage` que pueda filtrarlos debe
rechazarse en review.

- **API keys de proveedores** — Anthropic (`sk-ant-…`), OpenAI/Codex, Groq, Gemini,
  Cerebras (`sk-…`, etc.).
- **JWT / tokens de Cognito** — patrón `eyJ[A-Za-z0-9_-]{20,}\.`.
- **AWS** — access key IDs (`AKIA…`), secret keys (`aws_secret`), claves privadas
  (`-----BEGIN PRIVATE KEY-----`).
- **Tokens / chat_id de Telegram.**
- **Contenido completo de body de issues** confidenciales.
- **Paths absolutos a credenciales** (`~/.claude/secrets/credentials.json` y similares).
- **Valores de `process.env.*`** (a lo sumo nombres, nunca valores).
- **Session IDs completos** — siempre truncados a 8 chars (`id.slice(0, 8)` en el slice
  + `safeSessionId` en el render).

### Verificación (smoke / CI)

```bash
# El endpoint responde (CA-31)
curl -sI http://127.0.0.1:3200/metrics | head -1 | grep -qE '200|301'

# Headers de seguridad (CA-15)
curl -sI http://127.0.0.1:3200/metrics | grep -i 'Cache-Control' | grep -qE 'no-store'
curl -sI http://127.0.0.1:3200/metrics | grep -vi 'Access-Control-Allow-Origin'

# No filtra secretos (CA-16) — falla si encuentra alguno
curl -s http://127.0.0.1:3200/metrics | grep -E 'sk-ant|AKIA|BEGIN PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.|aws_secret' && exit 1 || exit 0
```

El test unitario `views/dashboard/__tests__/kpis.test.js` cubre el render de
`renderMetricsPage` con payloads XSS y verifica ausencia de patrones de secreto sin
necesidad de un dashboard corriendo. Una regresión preventiva más amplia se trackea
en la recomendación #3759 (fuera de scope de #3733).

## Decisión sobre el legacy `/metrics` HTML

**Se mantiene** (decisión cerrada #3 del issue, vía suave). NO se deprecó ni se hace
redirect `301 → /dashboard?view=kpis`.

Razones:

1. Hay scripts externos y bookmarks que dependen del path `/metrics`; deprecarlo es
   scope creep y rompería integraciones.
2. La memoria `project_metrics-endpoint-lost` se cierra recuperando el **link visual**
   (CTA en la ventana `?view=kpis`, CA-9), no migrando el endpoint.

La alternativa de `301 → KPIs` (propuesta por `guru`) queda como **recomendación futura
no bloqueante** — puede abrirse como issue independiente si se aprueba.

## Relación con la ventana KPIs V3 (`?view=kpis`)

- La ventana `?view=kpis` es la vista **resumida** (instrument panel read-only): KPI row,
  DORA, Commander routing, providers, rendimiento por agente, y el **CTA hacia `/metrics`**.
- `/metrics` es la vista **detallada** (series temporales, gráficos, tablas históricas).
- Ambas comparten la fuente de datos `lib/kpis-data.js::getMetricsSlice` (+ `kpisSlice`
  para DORA/tokens). El screenshot de evidencia visual del épico se toma contra
  `/dashboard?view=kpis` (NO se agrega `/metrics` a la allowlist anti-SSRF de
  `screenshot-capture.js`, CA-5).
