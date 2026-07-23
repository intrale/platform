# Cuota de Codex/OpenAI: fuente única de verdad + resets (#4863)

> Gemelo de #4861 (Anthropic sobre `claude -p /usage`). Mantiene la misma
> disciplina de **una sola fuente fidedigna** por proveedor.

## 1. Problema que resolvió

El cálculo de cuota de Codex tenía **dos subsistemas que no se hablaban**, y el
dashboard se contradecía a sí mismo:

- **Tarjeta "cuota por proveedor"** (medición real): el adapter
  `lib/quota-adapters/openai-codex.js` lee el uso real que Codex persiste
  localmente (equivalente a su `/status`). Cero inferencia, cero HTTP. Regla de
  frescura: si el último evento es de hace **>1h** (Codex inactivo) devuelve
  `adapterStatus:'unknown'` / `pct:null`.
  > **Actualizado por #4885:** la fuente local cambió con Codex v0.145.0 — ya no
  > es el SQLite `~/.codex/logs_2.sqlite` sino los rollouts JSONL de sesión.
  > Ver §3.1.
- **Banner de degradación** (arriba): lee el flag `.pipeline/quota-exhausted.json`
  (escrito por `detectQuotaExhausted()` cuando un spawn real falla por límite).
  Fuente totalmente distinta.

**Síntoma:** el `enrich()` de `lib/provider-quota.js` (mode `event`) colapsaba
"sin dato por inactividad" con "sin límite":

```js
// ANTES (#4533):
sub.eventOk = !(st === 'error' || q === 'critical');
```

Un `adapterStatus:'unknown'` (stale) NO es `error` ni `critical` ⇒ `eventOk=true`
⇒ la tarjeta mostraba **"✓ sin límite"** (verde) mientras el banner decía
**"cuota agotada"**. El mismo dashboard se contradecía.

## 2. Fuente única reconciliada (CA-1 / CA-2 / CA-4)

`enrich()` mode `event` ahora deriva **tres estados explícitos** en vez del
booleano, y reconcilia con el flag que usa el banner:

```js
// DESPUÉS (#4863):
if (q === 'critical' || _isProviderExhausted(provider, opts)) {
    eventState = 'exhausted';        // tope real activo
} else if (st === 'ok' && (q === 'ok' || q === 'normal' || q === 'warning')) {
    eventState = 'ok';               // dato FRESCO y sin tope → "sin límite"
} else {
    eventState = 'nodata';           // stale/unknown/error/no_usage_data → "sin dato"
}
```

- **`opts.exhaustedProviders`** lo computa `quotaSlice` (en `dashboard-slices.js`)
  leyendo el **mismo** snapshot que alimenta el banner:
  `quota-exhausted-state.getQuotaState()` (lectura read-only de
  `quota-exhausted.json`). Así la tarjeta y el banner **derivan del mismo
  snapshot** y nunca se contradicen (escenario Gherkin #1).
- La distinción de los tres estados llega hasta el render
  (`views/dashboard/home.js` → `_mzHydrateWinCell`):
  - `ok` → "✓ sin límite" (celda sana).
  - `exhausted` → "tope activo".
  - `nodata` → "sin dato" (clase `mz-qm-nodata`), **nunca verde**.

Se distingue explícitamente **"sin dato por inactividad"** de **"sin límite"** y
de **"cuota agotada"** (CA-4).

## 3.1. Fuente local del dato (actualizada por #4885 — Codex v0.145.0)

Codex **v0.145.0 cambió dónde persiste la cuota**. El adapter se actualizó para
seguir el dato; la disciplina de fuente única y el invariante offline no cambian.

| | Antes (Codex < 0.145.0, #4868) | Ahora (Codex ≥ 0.145.0, #4885) |
|---|---|---|
| Archivo | `~/.codex/logs_2.sqlite` (tabla `logs`) | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Evento | `codex.rate_limits` en `feedback_log_body` | `payload.rate_limits` en líneas `event_msg`/`token_count` |
| Lectura | CLI `sqlite3` vía `execFileSync` | `fs` (sin proceso externo ni dependencia nativa) |
| Campo de reset | `reset_at` | `resets_at` |
| Mapeo de ventanas | **posicional**: `primary`=5h, `secondary`=7d | **por `window_minutes`**: `<1440`→sesión, `≥1440`→semanal |

**Por qué el mapeo dejó de ser posicional:** en v0.145.0 el uso **semanal** llega
en `primary` (`window_minutes: 10080`) con `secondary: null`. Asumir la posición
mandaba el semanal al bucket de sesión y dejaba el gating/pacing sin dato. La
ventana es el único discriminante confiable.

Muestra real capturada (v0.145.0):

```json
{"timestamp":"2026-07-23T19:38:32.183Z","type":"event_msg",
 "payload":{"type":"token_count","info":{...},
   "rate_limits":{"limit_id":"codex","limit_name":null,
     "primary":{"used_percent":1.0,"window_minutes":10080,"resets_at":1785373521},
     "secondary":null,"plan_type":"plus", ...}}}
```

**Mecánica de lectura:** se recorren los rollouts del más nuevo al más viejo
(orden lexicográfico de `YYYY/MM/DD` + nombre prefijado por ISO ⇒ cronológico,
sin `stat` por archivo, tope de 40 archivos) y se toma el **último** objeto
`rate_limits` del primer rollout que tenga uno. Se lee sólo la **cola** del
archivo (512 KB) para no cargar rollouts grandes; las líneas partidas por el
corte fallan el `JSON.parse` y se descartan.

**Frescura:** anclada al `timestamp` del evento en el JSONL. Un evento sin
timestamp, o fechado **en el futuro** más allá de 5 min (clock skew / timestamp
corrupto), degrada a `unknown` — una edad negativa atravesaría el chequeo de
staleness y mostraría como fresco un dato no confiable.

**Override:** `CODEX_SESSIONS_DIR` (env) reemplaza a `CODEX_QUOTA_LOG_PATH`, que
quedó obsoleto junto con la fuente SQLite (también `CODEX_SQLITE3_BIN`).

> **Consecuencia operativa:** el reconcile de cuota (#4865) vuelve a recibir dato
> real de Codex. Los tests que ejercitan `setFlag` deben fijar
> `CODEX_SESSIONS_DIR` a un path inexistente para no depender del estado real de
> la máquina (si Codex reporta cuota sobrante, el reconcile vetea el flag).

## 3. Probe / dato fresco tras inactividad (CA-3)

> **Nota #4885:** el dilema de abajo era sobre **de dónde sacar el dato**. Con
> v0.145.0 el dato **sigue persistiéndose localmente** (rollouts, §3.1), así que
> **no hace falta probe ni canal HTTP** para leerlo: el invariante offline se
> mantiene. Lo que sigue vigente es el problema de **inactividad** (si Codex no
> corre, no hay evento nuevo y el dato envejece), y para eso la política sigue
> siendo la de esta sección.

**Estado actual: fail-safe, sin probe.** Tras >1h sin eventos, la tarjeta
muestra **"sin dato"** (no un % viejo, no "sin límite" espurio). El síntoma que
motivó el issue —el verde espurio por inactividad— queda **eliminado**.

Refrescar el `rate_limits` real de forma proactiva **tras un período de
inactividad** requiere una de dos rutas, ambas con costo, y la **decisión de
arquitectura sigue abierta**:

1. **`codex exec` mínimo** (prompt trivial hardcodeado): escribe un evento fresco
   pero **consume tokens** (un turn completo). Requiere medir el costo real y
   frecuencia configurable con piso mínimo.
2. **Endpoint app-server `account/rateLimits/read`**: daría el dato **sin gastar
   cuota**, pero es **HTTP** ⇒ rompe el invariante "cero clientes HTTP / offline"
   de los adapters (CA-#6 de #3092) ⇒ exige **review de seguridad explícito**
   (SSRF/secrets en el runtime del dashboard).

> **Decisión de este issue (fail-safe):** NO se abre canal HTTP ni se agrega un
> probe que consuma cuota. Mientras la ruta no se decida en definición/arquitectura,
> el estado por defecto es **"sin dato por inactividad"** (distinto de "sin límite"
> y de "agotada"), que es lo correcto y de bajo riesgo. El probe de liveness
> existente (`probeCodexHealth` → `codex --version`, offline, cero tokens) NO
> escribe un evento `rate_limits`, así que **no** sirve como refresh de cuota.

`CODEX_QUOTA_STALENESS_MS` (env, default 1h, piso 5 min) controla el umbral de
frescura del adapter.

## 4. Mecánica de los "usage limit resets" de Codex (CA-5)

Investigado contra fuentes de OpenAI + comunidad (jun–jul 2026; ver comentarios
del issue #4863). Resumen **autoritativo para el diseño**:

| Propiedad | Valor |
|-----------|-------|
| ¿Se renuevan? | **NO.** No son periódicos (ni semanal ni mensual). |
| Naturaleza | **Grants finitos, de un solo uso** ("reset banking"). |
| Caducidad | Cada reset **caduca a los 30 días** de otorgado. |
| Origen del stock | 1 reset gratis (asignación inicial, 11-jun-2026) + hasta 3 por referidos (promo 11–24 jun 2026, **ya cerrada**). |
| Efecto | Destraba el límite (ventana 5h y/o semanal) **al instante**, sin esperar el reset natural. |
| Dónde vive el conteo | **Server-side** (`account/rateLimits/read`, lo mismo que muestra `/usage`). **No** hay tabla local canónica. |
| Plan de la cuenta | `plus` (según `~/.codex/auth.json`). |

Fuentes: help.openai.com/articles/11369540 · anuncio OpenAI 12-jun-2026 (savable
resets) · docs bswen (2026-03), knightli (2026-06/07) · OpenAI Developer
Community · `openai/codex#16423`.

## 5. Política de reset: fail-closed, NUNCA automático (CA-6)

Como el stock es **finito, no renovable y caduca a 30 días**, un auto-reset ciego
al alcanzar el límite lo **quemaría en días**. Es un anti-patrón operacional
(equivale a gastar un recurso escaso sin autorización).

**Reglas de este issue (fail-closed):**

- **NO auto-resetear** en cada límite. Los resets se tratan como recurso escaso.
- Reset **sólo bajo gate manual / criterio crítico** (ej. ola bloqueada por cuota
  + aprobación humana identificable), nunca por silencio ni de forma recurrente.
  Esto se alinea con GATE 2 del `CLAUDE.md` (fail-closed) y con el `readDefensive`/
  `setFlag` de `quota-exhausted.js` que ya audita cada mutación (log-antes-de-mutar).
- **Si la mecánica de renovación no está confirmada** para una cuenta dada → NO
  consumir resets, **escalar a decisión humana** (alerta).
- Exponer el **conteo de resets disponibles** en el dashboard obliga a leerlo de
  `account/rateLimits/read` (HTTP) → misma tensión que CA-3 ruta 2. Queda
  **diferido** a la decisión de arquitectura del canal HTTP; hasta entonces no se
  muestra un conteo inventado.

> **Estado del código:** el pipeline **no ejecuta ningún auto-reset** (no existe
> tal código, y este issue mantiene ese invariante). La detección de "límite
> alcanzado" ya existe vía el flag `quota-exhausted` (banner + gate de spawn por
> proveedor). Cualquier consumo de resets futuro DEBE pasar por gate humano.

## 6. Archivos afectados

- `lib/provider-quota.js` — `enrich()` mode `event`: 3 estados + helper
  `_isProviderExhausted(provider, opts)`.
- `lib/dashboard-slices.js` — `quotaSlice`: computa `exhaustedProviders` desde
  `quota-exhausted-state.getQuotaState()` y lo pasa a `enrich`.
- `views/dashboard/home.js` — `_mzHydrateWinCell`: render de `ok`/`exhausted`/`nodata`.
- Tests: `tests/provider-quota-codex-reconcile-4863.test.js`,
  `tests/home-quota-render-4327.test.js` (casos #4863).

**#4885 (migración a rollouts JSONL):**

- `lib/quota-adapters/openai-codex.js` — lectura de rollouts JSONL, clasificación
  por `window_minutes`, `resets_at`, guard de evento futuro.
- `lib/quota-adapters/index.js` — doc del contrato (`codexSessionsDir`).
- Tests: `lib/__tests__/quota-adapters/openai-codex.test.js` (reescrito),
  `lib/__tests__/dashboard-slices-kpis.test.js` y
  `lib/__tests__/quota-exhausted.test.js` (hermeticidad vía `CODEX_SESSIONS_DIR`).

## 7. Trabajo diferido (issues de recomendación)

1. **Ruta del dato fresco de cuota/resets** (CA-3 completo + conteo de resets):
   decidir en definición/arquitectura entre `codex exec` acotado (con costo
   medido + frecuencia configurable) vs. excepción HTTP controlada a
   `account/rateLimits/read` (con review de seguridad SSRF/secrets).
2. **Gate manual de reset**: si se decide exponer y consumir resets, diseñar el
   gate humano fail-closed + alertas (stock ≤1, reset por caducar <30d) + log
   auditable no repudiable (timestamp, motivo, quién autorizó, resets antes/después).
