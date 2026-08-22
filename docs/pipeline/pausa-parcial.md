# Pausa parcial — modos del pipeline V3

Documenta los tres estados del pipeline (running, paused, partial_pause), cómo se activan, cómo se persisten, y la lógica de auto-inclusión de dependencias incorporada en el issue #2893.

## Tres estados

| Estado | Marker en `.pipeline/` | Comportamiento |
|---|---|---|
| `running` | (ninguno) | **No dispatcha ningún issue** (#5060). Sin allowlist no hay ola vigente que acote el trabajo. |
| `paused` | `.paused` | Bloquea TODO lanzamiento. Solo Telegram queda activo. |
| `partial_pause` | `.partial-pause.json` | Procesa exclusivamente los issues listados en `allowed_issues`. |

**Precedencia**: `paused` > `partial_pause` > `running`. Si coexisten `.paused` y `.partial-pause.json`, gana el más restrictivo.

API canónica: `lib/partial-pause.js` exporta `getPipelineMode()`, `isIssueAllowed(n)`, `setPartialPause(list, opts)`, `clearPartialPause()`, `resumeAll()`.

## Ejecución solo por olas (#5060)

El pipeline **no tiene un modo "procesar todo el backlog"**. El único camino para
que un issue se dispatche es estar en `allowed_issues`, que se puebla al promover
una ola. Sin allowlist, `isIssueAllowed()` deniega.

Esto cambió tras el incidente del 2026-07-26. Hasta entonces `running` significaba
barra libre: al cerrarse la ola 8, la poda convergente (#4753) ejecutó
`setPartialPause([])`, que con lista vacía borra el marker, y el Pulpo quedó sin
filtro durante ~10 horas — ~320 agentes sobre ~100 issues del backlog histórico,
que a su vez generaron 97 issues nuevos en cadena.

El alcance de la ola **no se enforza en `waves.json`** (ese archivo es el registro
semántico de qué contiene la ola); se enforza en esta allowlist. Por eso "sin
allowlist" tiene que significar *denegar*, no *permitir*.

### Consecuencias operativas

- Al cerrarse una ola el dispatch queda **detenido**, y la poda convergente lo
  avisa por Telegram. Hay que promover la ola siguiente para que el pipeline
  vuelva a tomar trabajo.
- El wave-stall watchdog (#4708/#4709) declara la causa `wave-empty` en ese
  estado, así que no alerta por una espera que el operador ya controla.
- `isSkillAllowed()` **no** cambió: los skills del control-plane (smoke-test de
  providers, harnesses de diagnóstico) no consumen backlog y deben poder correr
  entre olas.

### Escape hatch

`PIPELINE_ALLOW_UNSCOPED_DISPATCH=1` reabre el dispatch sin ola. Es para
diagnóstico y recuperación, está apagado por default y loguea una advertencia en
cada arranque que lo use. **No debe quedar prendido en operación normal**: es
exactamente el comportamiento que causó el incidente.

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
2. Append a `logs/partial-pause-deps.log` con `{timestamp, issue, missing_deps, signature, action}` (CA-9; `signature` desde #5978).
3. Telegram (con cooldown 30 min por `(issue, deps-set)`): mensaje + inline keyboard con cuatro botones de **callback**:
   - "✅ Sí, incluir las N" → `pp:include-deps:<n>`
   - "🎯 Seguir sólo con #N" → `pp:keep-original:<n>`
   - "🔕 No avisar más por este caso" → `pp:mute-case:<n>` (#5978)
   - "🔓 Levantar la pausa parcial" → `pp:cancel-partial-pause`

Desde #5923 los botones **no** son de tipo `url`: son `callback_data` con el contrato
congelado `pp:<action>[:<issue>]` (≤64 bytes, `telegram-button-url.js`). El
`callback-handler.js` los resuelve contra el mapa congelado `PP_ROUTES` — el
`action` que manda el cliente se usa **como clave**, nunca se interpola en la
URL — y ejecuta el POST loopback contra el dashboard. Antes eran botones `url` a
`localhost`, que la Bot API rechazaba: no ejecutaban nada.

### Banner del dashboard (CA-8)

El dashboard polletea `GET /api/partial-pause/deps-state` cada 30s. Si hay missing deps, muestra un banner amarillo con:

- Cabecera con el conteo (`N casos activos, M silenciados`).
- Botón **"Agregar dependencias al allowlist"** que llama a `POST /api/partial-pause/include-deps`.
- Botón "Ocultar" (sessionStorage 5 min) — **del banner entero**, temporal y por sesión.
- **Una fila por caso** `(issue, deps-set)` (#5978), que es la misma unidad que
  indexa el store de silencios.

Cada fila lleva su estado por **ícono + chip textual**, nunca sólo por color u
opacidad (mismo contrato WCAG AA que fija el semáforo de sync de #4375):

| Estado | Chip | Ícono | Borde izq. | Acción de la fila |
|---|---|---|---|---|
| Activo | `Activo` | `ic-warn` | `var(--warning)` | **Silenciar** |
| Silenciado | `Silenciado` | `ic-bell-off` | `var(--border-strong)`, `opacity:.72` | **Reactivar aviso** |

"Ocultar" y "Silenciar" **no** son lo mismo, y por eso se leen distinto:
"Ocultar" saca el banner de la vista por 5 minutos en esta sesión del browser;
"Silenciar" persiste la decisión en disco y sobrevive al restart del Pulpo.

### Recursión

`resolveOpenDeps` recorre el grafo de dependencias hasta profundidad 3. Si el grafo es más profundo, marca `truncated: true` y emite warning. Esto evita exploraciones costosas en grafos patológicos.

### Bidireccionalidad

Cuando se incluye un parent (ej. #2882) en el allowlist, el sistema **incluye los hijos** porque el parent depende de ellos (`Closes #N`). Cuando se incluye un hijo (#2890), **NO se incluye el parent** automáticamente — el hijo puede mergearse solo, y el parent no es un pre-requisito del hijo.

## #5978 — Las tres acciones del operador, y qué hace cada una

El aviso ofrece tres salidas además de levantar la pausa. Antes de #5978 dos de
ellas eran indistinguibles: `keep-original` ya llamaba a `markDepRiskAccepted`, y
ese flag **no suprimía nada** (sus dos usos en `pulpo.js` son escrituras hacia el
state del banner; ningún lector lo consulta para decidir si alerta). La única
barrera contra la re-alerta era un cooldown temporal que vive en un `Map` en
memoria del Pulpo (`partialPauseDepsAlertCache`), así que un restart lo reseteaba
y el ruido volvía.

| Acción | Toca la lista de trabajo | `accepted_dep_risk` | ¿Sigue avisando? |
|---|---|---|---|
| `include-deps` — *"Sí, incluir las N"* | **Sí**: suma las deps al allowlist | — | El caso desaparece |
| `keep-original` — *"Seguir sólo con #N"* | No | Lo marca en `true` | **Sí, sigue avisando** |
| `mute-case` — *"No avisar más por este caso"* | No | **No lo toca** | **No**, mientras la firma no cambie |

`mute-case` escribe **sólo** en el store de silencios: no llama a
`markDepRiskAccepted`, no toca `allowed_issues` y —a diferencia de las otras dos
resoluciones— tampoco borra `partial-pause-deps-state.json`, porque el caso
**sigue existiendo** y el banner tiene que poder mostrarlo como *silenciado* en
vez de hacerlo desaparecer. Un caso invisible es justo el fallo que este issue
viene a evitar.

### Alcance del silencio: la firma `(issue, deps-set)`

La clave del store es la firma que `partial-pause-deps.alertSignature()` ya
producía para el cooldown: `<issue>:<dep1,dep2,...>` con las deps numerizadas y
**ordenadas**, así que es determinística e independiente del orden de detección.

```
#6033 dependiendo de #6032 y #6041  →  "6033:6032,6041"
```

El silencio **no se hereda**. Si aparece una dep nueva o se resuelve una de las
existentes, la firma cambia y el aviso **vuelve a salir**. Es deliberado: el
operador dijo "no me avises por *este* caso", no "no me avises nunca más por
*este issue*", y un caso con otras deps es otra situación. Tampoco contagia entre
issues: dos issues con las mismas deps son dos firmas distintas.

### Persistencia y purga

El store vive en `.pipeline/state/partial-pause-mutes.json` (gitignoreado), se
escribe bajo `withLockSync` + `atomicWriteFile` —lock propio, sin contención con
el del marker de pausa parcial— y por eso **sobrevive al restart del Pulpo**, que
era el agujero original.

```json
{
  "6033:6032,6041": {
    "issue": 6033,
    "deps": [6032, 6041],
    "muted_at": "2026-08-21T14:00:00.000Z",
    "muted_by": "telegram-partial-pause-deps",
    "operator_ref": "<from.id>",
    "wave": 10
  }
}
```

`pruneStale({allowedIssues, activeSignatures})` corre en cada barrido **antes**
de consultar los silencios, para que una entrada zombi no pueda callar un caso
reaparecido. Limpia las entradas cuyo issue salió de la ola y las que ya no
tienen deps faltantes. Si no se le pasan argumentos no barre nada (guard
anti-borrado masivo), y si falla la escritura deja todo como estaba y reintenta
en el barrido siguiente.

### Fail-open hacia el aviso (invariante)

Un error de lectura **jamás** puede traducirse en silencio: una alerta de más es
ruido, un silencio accidental es un pipeline trabado que nadie ve. Por eso
`isMuted()` devuelve `false` ante estado ausente, JSON roto, shape inesperado o
excepción, y `mute-case` responde `409` sin escribir nada cuando el state de deps
no tiene entrada vigente para ese issue.

### Orden de decisión en el barrido

La decisión vive en `partial-pause-mutes.decideAlert()` y no inline en
`pulpo.js`, porque `pulpo.js` es un daemon que ningún test puede `require()`:
dejarla adentro habría significado testear una réplica de la lógica. El cooldown
en memoria **no se elimina** — sigue siendo la segunda barrera del caso *no*
silenciado:

| Condición | `action` en `logs/partial-pause-deps.log` | ¿Alerta? |
|---|---|---|
| Firma en el store de silencios | `suppressed_by_mute` | No |
| Dentro del cooldown (30 min) | `detected_within_cooldown` | No |
| Ni silenciado ni en cooldown | `alert_sent` | Sí |

Cada entrada del log incluye ahora también la `signature` del caso.

### Cómo se revierte

- **Desde el dashboard**: botón **"Reactivar aviso"** en la fila silenciada →
  `POST /api/partial-pause/unmute-case` con `{ signature }`. Sin esta salida, el
  operador entraría al estado silenciado con un botón y saldría editando un JSON
  a mano.
- **Automáticamente**: `pruneStale` limpia el silencio cuando el issue sale de la
  ola o deja de tener deps faltantes.
- **Por cambio de la situación**: si el set de deps cambia, la firma cambia y el
  aviso vuelve solo.

### Autorización y auditoría

`mute-case` entra por el **mismo** bloque HTTP que `keep-original`, así que pasa
por el mismo `evaluateLocalMutationGate` (loopback + Origin/Referer +
Content-Type), el mismo `validateAuthorizedBy` contra el enum cerrado de #3625 y
el mismo anti-replay (`mode !== 'partial_pause'` ⇒ `409`, cero mutación). Un
`authorizedBy` fuera del enum devuelve `403` **sin escribir nada**.

`operatorRef` (el `from.id` real de Telegram) viaja por `justification`/`extra`,
**nunca** por `authorizedBy`: el enum es de clase de origen, no de identidad.
Cada silenciado y cada reactivación quedan en el audit hash-chain
(`partial-pause-audit.appendMutation`) con `previous`/`current` vacíos —
`mute-case` no muta la allowlist y la entry no debe confundirse con una que sí lo
hace— y con la firma, el origen y el `operatorRef` en `extra`.

Asimetría deliberada: `mute` **no muta si el audit falla** (un silencio sin
rastro es el agujero que este issue cierra), mientras que `unmute` sí procede
igual, porque es de-escalación pura: su peor efecto posible es una alerta de más.

Las deps que arman la firma **no llegan del cliente**: las resuelve el servidor
desde `partial-pause-deps-state.json` al momento del click. El `callback_data` de
Telegram transporta sólo el issue (contrato congelado de ≤64 bytes), y dejar que
el cliente eligiera las deps habría convertido la firma en un dato controlable
por quien aprieta.

## Endpoints HTTP

| Método | Path | Descripción |
|---|---|---|
| `POST` | `/api/pause-partial` | Activa/actualiza pausa parcial. Body: `{ issues, detectDeps?, includeDeps?, acceptedDepRisk?, source? }`. Devuelve `409 MISSING_DEPS` cuando `detectDeps:true` encuentra deps faltantes. |
| `POST` | `/api/partial-pause/check-deps` | Preview de deps para una allowlist hipotética. Body: `{ issues }`. |
| `POST` | `/api/partial-pause/include-deps` | Aplica auto-include sobre la allowlist actual. Sin body. |
| `GET` | `/api/partial-pause/deps-state` | Estado de la última detección continua + `mutes[]` (alimenta el banner). |
| `POST` | `/api/partial-pause/keep-original` | No cambia el allowlist; marca `accepted_dep_risk`. **Sigue avisando.** |
| `POST` | `/api/partial-pause/mute-case` | #5978 — Silencia la re-alerta de la firma `(issue, deps-set)`. Body: `{ authorizedBy, operatorRef?, issue }`. |
| `POST` | `/api/partial-pause/unmute-case` | #5978 — Reactiva el aviso. Body: `{ signature, operatorRef? }`. |
| `POST` | `/api/partial-pause/cancel-partial-pause` | Levanta la pausa parcial. |
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
- `lib/__tests__/partial-pause-mutes.test.js` — #5978: store de silencios, persistencia tras restart, invalidación por cambio de firma, fail-open ante estado corrupto, `pruneStale` y `decideAlert` (23 tests).
- `lib/__tests__/partial-pause-resolution.test.js` — #5923/#5978: las tres resoluciones, el gate de request, el enum de `authorizedBy` y la diferencia verificable entre `keep-original` y `mute-case` (31 tests).

```bash
node --test .pipeline/lib/__tests__/partial-pause.test.js \
  .pipeline/tests/partial-pause-deps.test.js \
  .pipeline/lib/__tests__/partial-pause-mutes.test.js \
  .pipeline/lib/__tests__/partial-pause-resolution.test.js
```

## Logs

- `logs/partial-pause-deps.log` — JSONL con cada detección y alerta: `{timestamp, issue, missing_deps, signature, action}`. Útil para post-mortem y debug del cooldown y de los silencios (`suppressed_by_mute`).
- `logs/pulpo.log` — entradas con prefijo `[partial-pause-deps]`.
