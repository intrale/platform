# Kill-switch operacional por provider (`provider-disabled`)

> Issue: #3811 · Módulo: `.pipeline/lib/provider-disabled.js`

## Qué resuelve

El pipeline V3 ya tenía un mecanismo para tratar un provider de IA como no
disponible: el flag de **cuota agotada** (`.pipeline/quota-exhausted.json`). Pero
ese flag tiene semántica de *"cuota agotada → esperar reset"*: **pausa** el spawn
del skill (lo deja en `pendiente/`) y NO cascadea al siguiente provider de la
cadena de fallbacks.

En la prueba controlada del 2026-06-03, marcar Anthropic como agotado **no hizo
saltar** los agentes (architect/po/ux/planner) a Codex: todos corrieron en
Anthropic igual, porque `shouldGateSpawn` es un **gate** (pausa), no un
**dispatcher** (salto).

El kill-switch agrega un primitivo operacional explícito: **un switch por
provider** que, al apagarlo, ordena a `dispatch-with-fallback` **saltar al
siguiente eslabón de la cadena del skill**, replicando una *"caída en runtime"*
en lugar de una *"espera de reset de cuota"*.

## Modelo de datos

Persistencia: `.pipeline/provider-disabled.json`

```json
{
  "disabled": [
    { "name": "anthropic", "disabled_at": "2026-06-03T20:00:00.000Z", "ttl_expires_at": "2026-06-03T20:20:00.000Z" },
    { "name": "cerebras",  "disabled_at": "2026-06-03T20:05:00.000Z" }
  ]
}
```

- `ttl_expires_at` ausente/`null` → apagado **permanente** (hasta `enable`/`clear-all`).
- `ttl_expires_at` presente y vencido → la entrada se **drena en lectura** (auto-restaurado).
- Archivo ausente == **ningún provider apagado** (todos encendidos).

Providers válidos (allowlist, espejo de `resolve-provider.js`):
`anthropic`, `openai-codex`, `gemini-google`, `cerebras`, `nvidia-nim`.
`deterministic` **no** es apagable (no es un provider de IA).

## TTL

- Default: **20 minutos** (`DEFAULT_TTL_MS`).
- Cap máximo: **7 días** (`MAX_TTL_MS`). Un apagado "indefinido" se hace con TTL
  `never` (permanente), no con un número gigante.
- Auto-restaurado: cualquier lectura (`isProviderDisabled`, `listDisabledProviders`)
  drena las entradas vencidas y re-habilita el provider.

## CLI operacional

Script: `.pipeline/scripts/manage-providers.sh` (bash, delega en el módulo Node).

```bash
# Apagar anthropic por 20 min (default)
.pipeline/scripts/manage-providers.sh disable anthropic

# Apagar por una duración explícita (s|m|h|d)
.pipeline/scripts/manage-providers.sh disable anthropic --ttl 2h
.pipeline/scripts/manage-providers.sh disable cerebras  --ttl 90s

# Apagar permanente (hasta enable / clear-all)
.pipeline/scripts/manage-providers.sh disable cerebras --ttl never

# Encender un provider
.pipeline/scripts/manage-providers.sh enable anthropic

# Ver estado + TTL restante
.pipeline/scripts/manage-providers.sh list

# Re-habilitar TODO (escape manual)
.pipeline/scripts/manage-providers.sh clear-all
```

La operación es **por terminal Windows**, sin pasar por Telegram ni LLM
(determinístico: solo filesystem JSON + comparación de strings).

## Perilla en el Dashboard

El panel **Providers** del dashboard (`/dashboard` → tab "1 · Proveedores")
expone un **toggle on/off por provider** bajo la tarjeta *"Apagar / encender
providers"*.

- Encendido = verde; apagado = rojo (el switch en rojo significa "caído").
- Muestra el TTL restante cuando un provider está apagado.
- Escribe la misma fuente de verdad (`provider-disabled.json`) vía:
  - `GET  /api/multi-provider/providers-disabled` — estado de todos los providers.
  - `POST /api/multi-provider/providers/:provider/disable` — apaga (body opcional `{ "ttl_ms": <num|null> }`).
  - `POST /api/multi-provider/providers/:provider/enable` — enciende.
- Las mutaciones exigen **CSRF** (igual que el resto del panel multi-provider).

El efecto desde el dashboard es **idéntico** al switch por terminal.

## Integración en el dispatcher

`.pipeline/lib/agent-launcher/dispatch-with-fallback.js :: resolveSpawnWithFallback`
consulta `isProviderDisabled(provider)` **además** del gate de cuota:

```
primaryGated = shouldGateSpawn(skill, {provider})  ||  isProviderDisabled(provider)
```

- Si el primario está apagado → salta a `fallbacks[]` como si estuviera gateado
  por cuota. Audit: evento `provider_disabled`.
- Si un fallback está apagado → se saltea al siguiente eslabón. Audit:
  evento `fallback_provider_disabled`.
- Audit log: `.pipeline/logs/cross-provider-dispatch-YYYY-MM-DD.jsonl`
  (hash-chain SHA-256, mismo archivo que el resto del dispatch).

> **Fase 1 (este issue):** el módulo + integración en `dispatch-with-fallback`.
> No requiere cambio obligatorio de `pulpo.js`: el dispatcher ya es el punto
> único de resolución de provider pre-spawn.

## Diferencia con `quota-exhausted`

| | `quota-exhausted` | `provider-disabled` (kill-switch) |
|---|---|---|
| Semántica | "cuota agotada → esperar reset" | "caída en runtime → saltar a fallback" |
| Disparador | detector automático del CLI | **operador** (terminal o dashboard) |
| Efecto | pausa el spawn (queda en `pendiente/`) | salta al siguiente provider de la cadena |
| TTL | hasta `resets_at` (semanal/mensual) | default 20 min (corto, operacional) |

## Kill-switch del kill-switch

Si por un bug el archivo queda corrupto o pegado:

```bash
rm .pipeline/provider-disabled.json
```

restaura todos los providers (el archivo ausente == ningún provider apagado).
El módulo además es **fail-open**: cualquier error de IO o JSON corrupto degrada
a "provider encendido" — el kill-switch nunca bloquea el pipeline por un bug
propio.

## Tests

- `.pipeline/lib/__tests__/provider-disabled.test.js` — 20 casos: set/read/clear
  idempotentes, TTL + drenado, apagado permanente, backward-compat, validación
  de provider, JSON corrupto.
- `.pipeline/tests/dispatch-with-fallback.test.js` — casos `#3811`: salto del
  primario apagado, sin-fallbacks → all-gated, fallback apagado → siguiente
  eslabón, sin-módulo → flow legacy intacto.

```bash
node --test .pipeline/lib/__tests__/provider-disabled.test.js
node --test .pipeline/tests/dispatch-with-fallback.test.js
```
