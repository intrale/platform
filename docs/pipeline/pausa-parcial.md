# Pausa parcial — modos del pipeline V3

Documenta los tres estados del pipeline (running, paused, partial_pause), cómo se activan, cómo se persisten, y la lógica de auto-inclusión de dependencias incorporada en el issue #2893.

## Tres estados

| Estado | Marker en `.pipeline/` | Comportamiento |
|---|---|---|
| `running` | (ninguno) | Procesa todo, intake/lanzamiento/barrido normales. |
| `paused` | `.paused` | Bloquea TODO lanzamiento. Solo Telegram queda activo. |
| `partial_pause` | `.partial-pause.json` | Procesa exclusivamente los issues listados en `allowed_issues`. |

**Precedencia**: `paused` > `partial_pause` > `running`. Si coexisten `.paused` y `.partial-pause.json`, gana el más restrictivo.

API canónica: `lib/partial-pause.js` exporta `getPipelineMode()`, `isIssueAllowed(n)`, `setPartialPause(list, opts)`, `clearPartialPause()`, `resumeAll()`.

## Shape del marker `.partial-pause.json`

```json
{
  "allowed_issues": [2882, 2890, 2891, 2892],
  "created_at": "2026-04-30T18:42:00.000Z",
  "source": "dashboard-auto-deps",
  "accepted_dep_risk": false,
  "dep_sources": {
    "2890": "auto-deps",
    "2891": "auto-deps",
    "2892": "auto-deps"
  }
}
```

Campos:

- `allowed_issues` (number[]) — issues habilitados.
- `created_at` (ISO date) — timestamp de activación.
- `source` (string) — origen: `telegram`, `dashboard`, `dashboard-auto-deps`, `auto-deadlock-prevention`.
- `accepted_dep_risk` (bool, opcional, #2893) — el operador decidió continuar sabiendo que un issue tiene deps abiertas fuera del allowlist.
- `dep_sources` (object, opcional, #2893) — por qué cada issue terminó en la lista (ej. `auto-deps` cuando el sistema lo agregó por dependencia).

Los campos opcionales son aditivos: lectores anteriores que no los conocen los ignoran sin romperse.

## #2893 — Auto-inclusión de dependencias

**Problema (incidente 2026-04-30)**: pausa parcial con `allowed_issues: [2882]` cuando el épico #2882 dependía de tres splits abiertos (#2890, #2891, #2892) que no estaban en el allowlist. El pipeline quedó "trabado" 9 horas: el issue habilitado no podía avanzar porque sus pre-requisitos estaban bloqueados, y los pre-requisitos no podían procesarse porque estaban fuera del allowlist.

### Detección al activar (CA-1, CA-2, CA-3)

Cuando se activa pausa parcial desde el dashboard (`POST /api/pause-partial` con `detectDeps: true`), el endpoint:

1. Llama a `lib/partial-pause-deps.js → findMissingDeps(allowlist)`.
2. Para cada issue del allowlist, lee body+comments via `gh issue view` y extrae deps con regex (`Closes #N`, `Depends on #N`, `Split de #N`, `Tracked by #N`, `Blocked by #N`).
3. Si alguna dep está abierta y NO está en el allowlist, devuelve `409 Conflict` con la lista de missing deps + chains.
4. El cliente (modal del dashboard, mensaje de Telegram) muestra 3 opciones:
   - **Sí, incluir todas** → POST con `includeDeps: true`. El servidor une el allowlist con las deps detectadas y persiste con `source: 'dashboard-auto-deps'` + `dep_sources: { N: 'auto-deps' }`.
   - **Solo el original** → POST con `acceptedDepRisk: true`. Persiste solo el allowlist original con `accepted_dep_risk: true` (el flag dispara la detección continua del Pulpo para alertar).
   - **Cancelar** → no persiste; pausa parcial NO se activa.

Cache: `lib/partial-pause-deps.js` cachea las consultas de `gh` con TTL 5 min en `.pipeline/partial-pause-deps-cache.json`.

### Detección continua durante el partial_pause (CA-6, CA-7)

El Pulpo corre `brazoPartialPauseDeps(config)` cada N=5 ciclos (configurable en `config.yaml → partial_pause_deps.check_every_n_ticks`). Si encuentra issues habilitados con deps abiertas fuera del allowlist:

1. Persiste `partial-pause-deps-state.json` para el banner del dashboard.
2. Append a `logs/partial-pause-deps.log` con `{timestamp, issue, missing_deps, action}` (CA-9).
3. Telegram (con cooldown 30 min por `(issue, deps-set)`): mensaje + inline keyboard con tres botones URL al dashboard:
   - "Sí, incluir todas" → `<dashUrl>/?action=include-deps&issue=<n>`
   - "Solo #<n>" → `<dashUrl>/?action=keep-original&issue=<n>`
   - "Cancelar pausa parcial" → `<dashUrl>/?action=cancel-partial-pause`

Los botones son tipo `url`, no requieren callback_query handling — el Telegram client abre el dashboard directamente.

### Banner del dashboard (CA-8)

El dashboard polletea `GET /api/partial-pause/deps-state` cada 30s. Si hay missing deps, muestra un banner amarillo con:

- Lista de issues habilitados con deps faltantes.
- Botón **"Agregar dependencias al allowlist"** que llama a `POST /api/partial-pause/include-deps`.
- Botón "Ocultar" (sessionStorage 5 min).

### Recursión

`resolveOpenDeps` recorre el grafo de dependencias hasta profundidad 3. Si el grafo es más profundo, marca `truncated: true` y emite warning. Esto evita exploraciones costosas en grafos patológicos.

### Bidireccionalidad

Cuando se incluye un parent (ej. #2882) en el allowlist, el sistema **incluye los hijos** porque el parent depende de ellos (`Closes #N`). Cuando se incluye un hijo (#2890), **NO se incluye el parent** automáticamente — el hijo puede mergearse solo, y el parent no es un pre-requisito del hijo.

## Endpoints HTTP

| Método | Path | Descripción |
|---|---|---|
| `POST` | `/api/pause-partial` | Activa/actualiza pausa parcial. Body: `{ issues, detectDeps?, includeDeps?, acceptedDepRisk?, source? }`. Devuelve `409 MISSING_DEPS` cuando `detectDeps:true` encuentra deps faltantes. |
| `POST` | `/api/partial-pause/check-deps` | Preview de deps para una allowlist hipotética. Body: `{ issues }`. |
| `POST` | `/api/partial-pause/include-deps` | Aplica auto-include sobre la allowlist actual. Sin body. |
| `GET` | `/api/partial-pause/deps-state` | Estado de la última detección continua (alimenta el banner). |
| `POST` | `/api/pause` | Pausa/resume completos. Body: `{ action: 'pause' | 'resume' }`. |

## Comandos del pulpo

El Pulpo expone también el chequeo en su loop principal:

```js
// .pipeline/pulpo.js
const partialPauseDeps = require('./lib/partial-pause-deps');

// Cada N=5 ciclos del mainLoop, si modo === 'partial_pause':
brazoPartialPauseDeps(config).catch(...);
```

Configuración (en `config.yaml`):

```yaml
partial_pause_deps:
  check_every_n_ticks: 5         # cada 5 ciclos del Pulpo
  alert_cooldown_ms: 1800000     # 30 min cooldown por (issue, deps-set)
```

## Tests

- `lib/__tests__/partial-pause.test.js` — tests del módulo base (15 tests).
- `tests/partial-pause-deps.test.js` — tests del módulo de detección + persistencia + E2E del incidente (28 tests).

```bash
node --test .pipeline/lib/__tests__/partial-pause.test.js .pipeline/tests/partial-pause-deps.test.js
```

## Logs

- `logs/partial-pause-deps.log` — JSONL con cada detección y alerta. Útil para post-mortem y debug del cooldown.
- `logs/pulpo.log` — entradas con prefijo `[partial-pause-deps]`.
