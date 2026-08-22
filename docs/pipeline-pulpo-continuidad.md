# Continuidad del Pulpo — doc operacional

> Issue padre: #3259. Implementación: `agent/3259-pipeline-dev`. Sign-off: 2026-05-17.

## Qué resuelve

Cuando **todos** los providers de la cadena de fallbacks de un skill quedan gated por cuota (Anthropic + OpenAI Codex + free providers), el Pulpo:

1. Aplica la label `provider-exhaustion-pause` al issue (idempotente).
2. Encola un mensaje en Telegram con la cadena intentada y ETA del retry.
3. Persiste un marker en `.pipeline/state/exhaustion-notified/<issue>.json` para dedup de notificaciones.
4. Devuelve el archivo de trabajo a `pendiente/` (mismo comportamiento que el gate clásico).
5. Cada `retry_interval_ms` (clampeado a piso 60s), un brazo de retry inspecciona los issues con esa label. Si algún provider de la cadena se liberó, quita la label, borra el marker y notifica a Leo por Telegram.

El orquestador **nunca** deja de procesar issues que tengan providers libres. Sólo los issues con la chain completa gated se pausan — los demás siguen.

## Endpoints expuestos

### `GET /api/pulpo/provider-health`

Healthcheck por provider. Cache TTL **5 min** (hardcoded floor — config no puede bajar). Allowlist de providers desde `live-ping.PROVIDER_PING_ENDPOINTS`.

Respuesta:

```json
{
  "ts": "2026-05-17T01:00:00Z",
  "providers": [
    {
      "id": "anthropic",
      "status": "ok|gated|unknown",
      "reason": "authenticated|quota_exhausted|no_key_configured|...",
      "last_ping_ts": "2026-05-17T00:55:00Z",
      "last_quota_flag_ts": null,
      "resets_at": null,
      "cache_age_s": 270
    }
  ],
  "cache_ttl_ms": 300000
}
```

Reglas de seguridad:

- Solo IDs allowlisted (`live-ping.PROVIDER_PING_ENDPOINTS`). Provider arbitrario → 400 `unknown_provider`.
- Rate-limit inline 6 req/min por IP — 503 con `retry_after_s: 60` si excede.
- API keys nunca en la respuesta — solo IDs, status, ts.
- HTTPS-only en el ping subyacente (forzado en `live-ping.doRequest`).

### `GET /api/dash/dispatch-by-provider` (alias: `/api/dashboard/dispatch-by-provider`)

Conteo de despachos por provider en las últimas 24h. Source: `.claude/activity-log.jsonl` (eventos `session:start`).

```json
{
  "ts": "2026-05-17T01:00:00Z",
  "window_ms": 86400000,
  "totals": { "anthropic": 42, "openai-codex": 8, "groq": 3 },
  "total": 53
}
```

## Tarjeta "Continuidad del Pulpo" en el dashboard

Renderizada en el home kiosk (`/v3`). Polling cada 30s (el endpoint cachea TTL 5 min internamente — no martilla APIs).

- **Pills por provider** con dot de color: verde (ok), ámbar (gated), amarillo (unknown). El status se rendea con icono + texto + dot (R6 — cero reliance en color solo, WCAG AA).
- **Barra apilada de despachos 24h** con `--provider-*` tokens del UX (3.c/3.d de `assets/design-tokens.css`).
- **Auto-refresh** cada 30s.
- **Anti-XSS**: todo texto que viene del JSON (provider id, reason, status) se rendea con `textContent`. Cero `innerHTML` con strings interpolados.

Assets:
- Mockup: `.pipeline/assets/mockups/16-continuidad-pulpo-card.svg`
- Telegram: `.pipeline/assets/mockups/16b-telegram-exhaustion.svg`
- Narrativa UX: `.pipeline/assets/mockups/narrativa-continuidad-pulpo.md`

## Brazo de retry — flujo

```text
loop pulpo (cada poll_interval_seconds, default 30s):
  ...
  brazoProviderExhaustionRetry(config)
     └── si now - lastTick < retry_interval_ms → noop
     └── tryResume():
            ├── listExhaustedIssues() vía gh (label provider-exhaustion-pause + state:open)
            ├── readDefensive() del flag de cuota
            ├── por cada issue:
            │     ├── lee marker .pipeline/state/exhaustion-notified/<n>.json
            │     ├── si no hay provider activo del flag → destrabar con el primer provider de la chain
            │     ├── si chain[i] !== activeFlagProvider → destrabar con ese provider
            │     └── si chain solo contiene el activeFlagProvider → skip "still_gated_same_provider"
            ├── gh issue edit --remove-label provider-exhaustion-pause
            ├── unlink marker
            ├── enqueue Telegram "destrabado"
            └── audit hash-chained: event = provider-exhaustion-resumed
```

## Configuración (`config.yaml`)

```yaml
pulpo_continuidad:
  retry_interval_ms: 300000   # default 5 min, piso hardcoded 60s
```

Valores menores a `60000` se clampean a 60s automáticamente (defensa anti-DoS contra providers free).

## Kill-switch operacional

| Problema | Comando |
|----------|---------|
| Label aplicada por error a un issue específico | `gh issue edit <n> --remove-label provider-exhaustion-pause --repo intrale/platform` |
| Borrar marker de notificación (forzar re-notify) | `rm .pipeline/state/exhaustion-notified/<n>.json` |
| Liberar flag de cuota anthropic globalmente | `rm .pipeline/quota-exhausted.json` |
| Limpiar cache de provider-health | `rm .pipeline/cache/provider-health.json` |

## Simular caída de Claude en local (chaos test manual)

```bash
# 1. Setear flag de cuota anthropic con resets_at futuro:
node -e '
  const f = require("./.pipeline/lib/quota-exhausted");
  f.setFlag({
    errorType: "usage_limit_error",
    provider: "anthropic",
    resetsAt: new Date(Date.now() + 60*60*1000).toISOString(),
    agent: "manual-chaos",
  });
  console.log("flag seteado, drenar con: rm .pipeline/quota-exhausted.json");
'

# 2. Apuntar un issue de prueba al pulpo (gh issue create --label "Ready").

# 3. Observar logs: el dispatcher itera fallbacks. Si TODOS los providers de
#    la chain están gated, el bloque CA-4 dispara label + Telegram.

# 4. Verificar:
gh issue view <n> --json labels --jq '.labels[].name' | grep provider-exhaustion-pause
ls .pipeline/state/exhaustion-notified/
ls .pipeline/servicios/telegram/pendiente/ | grep exhaustion

# 5. Drenar el flag (simula reset):
rm .pipeline/quota-exhausted.json

# 6. Esperar el siguiente tick del pulpo (≤ retry_interval_ms). El brazo
#    `brazoProviderExhaustionRetry` quita la label y encola "destrabado".
```

## Test de chaos (CA-7)

`.pipeline/tests/chaos-claude-down.test.js` cubre:

| # | Escenario |
|---|-----------|
| 1 | Anthropic gated + OpenAI libre → dispatcher devuelve fallback, sin exhaustion. |
| 2 | TODOS los providers gated → reportExhaustion aplica label + Telegram + marker + audit. |
| 3 | Dedup CA-9: misma chain dentro de 2h → silencio. |
| 4 | Chain cambió dentro de 2h → re-notifica. |
| 5 | tryResume: flag liberado → quita label, borra marker, encola destrabe. |
| 6 | tryResume: chain = solo provider activo del flag → skip. |
| 7 | Security: issue inválido (`'3259; rm -rf /'`) → reject sin gh spawn. |
| 8 | Security: Telegram body strip de ANSI/control chars. |
| 9 | Helper: clampRetryIntervalMs respeta piso 60s. |
| 10 | provider-health: cache TTL 5min evita re-ping. |

Correr con:

```bash
node --test .pipeline/tests/chaos-claude-down.test.js
```

## Hash-chain audit log

Cada evento `provider-exhaustion-pause` y `provider-exhaustion-resumed` se persiste en `.pipeline/logs/exhaustion-pause-YYYY-MM-DD.jsonl` con hash-chain SHA-256 (`lib/audit-log.js`). Si `lib/audit-log` no cargara por bug, hay fallback a append directo sin hash-chain (best-effort — el pipeline nunca se rompe por el audit).

Entradas incluyen:

```json
{
  "ts": "2026-05-17T01:00:00Z",
  "event": "provider-exhaustion-pause",
  "skill": "guru",
  "issue": 3259,
  "primary_provider": "anthropic",
  "chain_tried": ["anthropic", "openai-codex", "groq"],
  "label_applied": true,
  "notified": true,
  "notify_reason": "first_notify",
  "hash_prev": "...",
  "hash_self": "..."
}
```

Verificable con `lib/audit-log.verifyChain(file)`.

## Out of scope (siguientes pasos)

Reservado para issues hijos (no bloquean #3259):

- #3277 — Rename `lanzarAgenteClaude → lanzarAgenteLLM`.
- #3278 — Persistir snapshots de `provider-health` en `metrics-history.jsonl` para análisis de tendencias.
- #3279 — Migrar callers legacy de `quota_detector.error_types` al `providerDef` de `agent-models.json`.
- #3285 — Middleware reusable de rate-limit para endpoints sensibles del dashboard V3.
- #3288 — Alerting proactivo Telegram cuando un provider entra en cuota baja (early warning).
- #3290 — Auto-tuning de RETRY_INTERVAL según `resets_at` del provider.

## Referencias cruzadas

- `lib/agent-launcher/dispatch-with-fallback.js` (#3198) — consumer runtime de `skill.fallbacks[]`.
- `lib/quota-exhausted.js` (#2974/#3077) — detector multi-provider de cuota agotada.
- `lib/multi-provider/live-ping.js` (#3177) — ping de cuota/disponibilidad con SSRF allowlist.
- `lib/audit-log.js` — hash-chain SHA-256 para forense.
- `docs/pipeline-pulpo-llm-audit.md` — auditoría LLM del Pulpo (CA-1 de este issue).
- `docs/pipeline/multi-provider.md` — doc operativa multi-provider general (#3176).
