# Watchdog de inactividad de despacho (#4708 / #5400)

> No confundir con `docs/pipeline/watchdog.md`, que documenta el **liveness del
> Pulpo** (proceso vivo/zombi). Este documento cubre el control que avisa cuando
> el pipeline **está vivo pero no despacha trabajo**.

## 1. Qué problema resuelve

El 2026-08-02 el pipeline estuvo **1h33 sin despachar nada** y no llegó ninguna
notificación. Había alertas de recursos, de cuota y de agentes zombis, pero
ninguna que dijera *"hace N minutos que no sale trabajo"*. Cualquier causa que
frene el despacho (pausa preservada por un restart, desync fail-closed de la
allowlist, ventana de prioridad, deadlock) producía el mismo silencio.

## 2. Anatomía del circuito

```
   filesystem                    lib/dispatch-facts.js        lib/wave-stall-watchdog.js
 ┌──────────────┐               ┌────────────────────┐        ┌────────────────────┐
 │ .paused      │──────────────▶│  leerAlcance       │        │                    │
 │ .partial-... │               │  contarElegibles   │───────▶│     decide()       │──▶ Telegram
 │ pendiente/   │               │  resolverCausa     │ hechos │  (función pura)    │──▶ dashboard
 │ state/last-  │               └────────────────────┘        └────────────────────┘
 │  dispatch    │──────────────────────────────────────────────────────▲
 └──────────────┘                                       reloj de despacho
```

| Pieza | Responsabilidad |
|---|---|
| `lib/last-dispatch.js` | Estampa atómica del **despacho efectivo** (`state/last-dispatch.json`). Es el reloj honesto: se escribe sólo cuando salió un agente de verdad. |
| `lib/dispatch-facts.js` | **Brazo de recolección**: alcance vigente, conteo elegible y causa declarada. Todas las dependencias entran inyectadas. |
| `lib/dispatch-cause-kind.js` | Traduce el enum de causas de despacho (#4709) al vocabulario del watchdog. |
| `lib/wave-stall-watchdog.js` | **Decisión pura**: umbrales, escalada, backoff, mensajes. No lee del filesystem. |
| `pulpo.js` (brazo) | Cableado: junta hechos, llama `decide()`, emite Telegram y estampa el status. Read-only sobre el estado de despacho. |

## 3. Las dos definiciones que hay que tener claras

### "Sin despachar" se mide con la estampa, no con `trabajando/`

El conteo de `trabajando/` miente en los dos sentidos: un agente clavado lo
mantiene fijo (el watchdog cree que hay movimiento y calla) y los agentes que
terminan lo hacen bajar (el watchdog cree que hubo movimiento y reinicia el
reloj). Por eso la señal primaria es `state/last-dispatch.json`.

`trabajando/ > 0` es un **atenuante**, nunca un skip: con agentes en curso se
suma `busy_grace_minutes` a los dos umbrales.

#### Y en modo `never` el conteo **tampoco** cuenta como movimiento

`stampState: never` = todavía no se vio ninguna estampa. Ahí no hay reloj honesto
y sólo queda la proxy legacy de #4708 (conteo + `avancePct`). Esa proxy usaba la
**firma** (`${dispatching}:${avance}`), que es igualdad de string: cambia también
cuando el conteo **baja**, o sea cuando los agentes viejos terminan. El resultado
medido, con **cero** despachos y agentes drenando 3 → 2 → 1 → 0:

```
t=100min disp=3 → alert/unexplained-stall, stalled=99min
t=101min disp=2 → skip/within-threshold,   stalled=0min,  recovery=SÍ
t=201min disp=1 → skip/within-threshold,   stalled=0min
```

Cada muerte de un agente clavado reiniciaba el reloj y se anunciaba como
*"despacho reanudado"* — que en `pulpo.js` dispara `clearWaveStalled()` y borra
`needs_attention` en plena detención. Con el conteo **oscilando** entre fases el
umbral no se alcanzaba nunca y el watchdog quedaba **mudo**.

Hoy, en modo `never`, **sólo un aumento de `avancePct` cuenta como movimiento**.
El aumento de `dispatching` tampoco vale, y el argumento es específico de esta
rama: la estampa se escribe en el spawn real y tiene espejo en memoria si el FS
falla, así que **un despacho de verdad habría sacado al watchdog de `never`**. Si
seguimos en `never`, ese aumento no vino de un despacho sino de una ficha
promovida entre fases (el conteo es global a todas).

Por la misma razón **no se emite `recovery` con `stampState !== 'ok'`**: el
mensaje afirma una duración exacta y sin reloj honesto no se puede sostener.

#### Dónde se estampa (y por qué ahí y no antes)

La estampa se escribe en **`lanzarAgenteClaude`, después de
`const child = launchResult.child`** — el único punto donde ya existe un proceso
hijo — más un punto explícito en la rama del **ejecutor determinístico del
contrato de tarea**, que resuelve la fase sin `child` pero también es despacho
real.

**No** se estampa en los call sites del loop de candidatos ni del deadlock
breaker, aunque ahí exista un `if (launched)` que lo tiente. `launched` viene de
`slotClaim.reserveSlot`, que hace:

```js
if (countFn() >= max) return;
onAcquired();
launched = true;
```

o sea que `launched === true` sólo significa *"el slot estaba libre y
`onAcquired()` no tiró excepción"*. `lanzarAgenteClaude` es **síncrona** y tiene
8 `return` tempranos **antes** del spawn — cuota agotada, invariante de skill,
prompt faltante, workfile corrupto, stale-log, error de worktree, worktree
irrecuperable, aborto por infra — y **ninguno lanza excepción**.

El caso de **cuota agotada** es el peor porque es **cíclico**: los candidatos
vuelven a `pendiente/` y el mainLoop los reintenta cada ciclo. Estampando desde
el call site, el reloj se reseteaba en cada vuelta y el watchdog quedaba **mudo
para siempre** justo con la cuota agotada — una de las causas que este control
existe para nombrar. Medido sobre `decide()`: 3 h de cuota agotada con 5
elegibles esperando daban **0 alertas** estampando por ciclo, contra las que
corresponden estampando sólo en el spawn.

Cubierto por `lib/__tests__/dispatch-stamp-wiring.test.js`.

### "Trabajo elegible" es `pendiente/` **cruzado con la allowlist**

`pendiente/` es el estacionamiento del backlog completo, no la cola de la ola.
Al 2026-08-03 tenía 228 workfiles, de los cuales **224 estaban fuera de la
allowlist** (algunos con 200 h de antigüedad). Contarlos como trabajo esperando
rompía tres cosas:

- el guard de CA-3 (*"cola legítimamente vacía ⇒ no alertar"*) nunca daba 0;
- el gate `enabledCount > 0`, que es lo que hace **aditiva** la escalada, era
  constante-verdadero: toda pausa de despacho terminaba alertando;
- el mensaje mentía por un factor de ~18x.

Semántica del cruce (`contarElegibles`):

| Estado | Elegibles |
|---|---|
| `PIPELINE_ALLOW_UNSCOPED_DISPATCH=1` | todos los pendientes |
| allowlist presente | pendientes ∩ allowlist |
| allowlist presente **+ pausa total** | pendientes ∩ allowlist (los que saldrían al levantar la pausa) |
| sin allowlist, con ola activa | pendientes ∩ issues abiertos de la ola (desync fail-closed) |
| sin allowlist, sin ola | 0 **y `ciego: true`** si hay cola — ver abajo |

`elegibles` cuenta **issues distintos y parseables**, no workfiles: el mismo
issue presente en 3 fases cuenta **una** vez. Antes se contaban workfiles (y la
rama del escape hatch devolvía el total crudo, sin filtrar los que no parsean),
así que el número que gobierna CA-3 y que viaja al mensaje de Telegram venía
inflado.

### "No hay trabajo" ≠ "no puedo ver el trabajo"

Sin allowlist, sin ola y sin escape hatch, el recolector sale por
`fail-closed-sin-ola` con `elegibles: 0`. Con la **cola llena**, eso no es una
cola vacía: es no poder determinar qué es despachable. Devolverlo como un 0 a
secas hacía que `decide()` saliera por `no-enabled-work` — un skip **mudo** con
el pipeline trabado, o sea **CA-3 comiéndose a CA-1**, que es la función primaria
del componente.

Por eso el conteo emite `ciego: true` y el brazo lo pasa como `scopeBlind`. Con
el alcance ciego la vigilancia **sigue**: manda la causa declarada (que en ese
estado es `wave-empty`, así que calla el rato normal y después escala) y el aviso
dice *"alcance de despacho no determinable"* con el tamaño crudo de la cola, en
vez de reportar "0 esperando" —  que se lee como *"no hay nada que hacer"*.

Una cola **realmente** vacía sigue sin alertar: `ciego` es `false` y CA-3 vale
igual que siempre.

> La pausa total **no** borra la allowlist para este conteo. `getPipelineMode()`
> devuelve `allowedIssues: []` en cuanto existe `.paused`; si el recolector se
> quedara con eso, el escenario "pipeline pausado con trabajo esperando" daría 0
> elegibles y jamás alertaría — justo el incidente que originó el issue.

## 4. Causas declaradas y orden de resolución

Una causa declarada **explica** un rato de no-despacho; no lo explica para
siempre. Por debajo de `declared_cause_escalate_minutes` silencia; por encima,
con elegibles esperando, el aviso sale igual con
`reason: stale-declared-cause:<kind>`.

Orden de `resolverCausaDeclarada` (el primero que matchea gana):

1. **pausa total** (`.paused`) — con el marker presente no sale nada.
2. **pausa parcial** — *sólo si no deja trabajo elegible*. Desde #5060
   `partial_pause` con allowlist viva es el modo **normal** de operación: si hay
   elegibles esperando, lo que frena el despacho es otra cosa.
3. **sin ola vigente** — allowlist ausente con dispatch fail-closed.
4. ventana de reposo · 5. cuota agotada · 6. presión de recursos ·
   7. `waiting-operator`.
8. **artifact de causa declarada** (#4709) — cubre concurrencia, ventana de
   prioridad, cooldown, deadlock y cb-infra sin duplicar su lógica.

La **anomalía** (`"no sé por qué no despacho"`) nunca silencia: es el caso en que
más hace falta avisar (fail-closed).

> **Una excepción tampoco silencia.** Si `getPipelineMode()` o
> `unscopedDispatchEnabled()` tiran, el alcance queda con `modeReadable: false` y
> el paso 3 **no** declara `wave-empty`: una lectura que falló no es una
> explicación. Antes degradaba a `mode: 'running'` con `scoped:false`, y eso
> callaba la alarma por doble vía (causa declarada **y** `fail-closed-sin-ola`)
> — lo contrario de lo que promete el header del módulo.

### Autoría

Siempre rotulada como **declarada** y display-only. Para la pausa total sale de
`readFullPauseOrigin().rawSource` (#5399), que es el único lugar donde queda
registrada; `getPipelineMode().source` devuelve `null` por estructura. Sin dato
el mensaje dice *"autoría no registrada"* — **prohibido** defaultear a una
persona.

## 5. Anti-spam

- **Backoff exponencial** entre re-alertas del mismo episodio:
  30 → 60 → 120 → … con tope 16× (8 h con el cooldown default). Una detención de
  14 h cuesta ~6 mensajes, no ~27. El primer aviso nunca se demora.
- Un episodio nuevo (el pipeline despachó y volvió a frenarse) reinicia el
  contador y vuelve a alertar de una.
- Una **cola legítimamente vacía también cierra el episodio** y resetea el
  backoff. Antes el reset colgaba sólo de "movió ficha", así que el primer aviso
  del episodio siguiente heredaba el cooldown acumulado del anterior (hasta 8 h
  de mordaza) sin que nada lo justificara.
- Al reanudarse el despacho sale **un** aviso de recuperación con la duración
  total de la detención — **sólo con `stampState: 'ok'`** (ver §3).
- Si el estado no se puede persistir, el brazo mantiene un **espejo en memoria**
  y lo prefiere sobre el disco. Sin él, un `.pipeline/state/` no escribible
  reiniciaba el anti-flooding en cada tick: un mensaje por minuto del mismo
  episodio.

## 6. Configuración (`config.yaml` → `wave_watchdog`)

| Clave | Default | Qué hace |
|---|---|---|
| `enabled` | `true` | Prende el brazo. |
| `kill_switch` | `false` | Corte de emergencia en caliente (no requiere restart). |
| `stall_minutes` | `20` | Inactividad de despacho que se considera detención. |
| `declared_cause_escalate_minutes` | `45` | A partir de acá una causa declarada deja de silenciar. |
| `busy_grace_minutes` | `60` | Gracia extra mientras hay agentes en `trabajando/`. |
| `alert_cooldown_minutes` | `30` | Base del backoff entre re-alertas. |
| `tick_ms` | `60000` | Cada cuánto corre el brazo. |

Todos los umbrales se validan con clamp `[1, 1440]`: un valor 0, negativo, no
numérico o gigante **cae al default** y nunca desactiva el control de facto.

## 7. El control apagado no puede parecer "todo OK"

El meta-bug de #5400 fue que el watchdog estuvo en `enabled: false` desde su
merge y nada lo avisó. Cada tick estampa
`state/dispatch-watchdog-status.json` — **incluso cuando sale temprano por estar
apagado** — y el dashboard muestra explícitamente OFF / degradado. La ausencia de
badge no es señal de salud.

`degraded: true` cubre: apagado, kill-switch, brazo sin latir (>10 min),
estampa de despacho ausente/corrida y estado que no se pudo persistir.

**El watchdog sano no implica el pipeline sano.** El banner marca *silencio
saludable* sólo si `degraded === false` **y** la última decisión fue `skip`.
Antes colgaba únicamente de `degraded`, así que un watchdog perfectamente vivo
que estaba **alertando** por despacho detenido se pintaba como silencio
saludable: el banner decía "todo bien" mientras el propio control gritaba lo
contrario. Sin `action` observada tampoco se afirma salud.

## 8. Debugging

```bash
# ¿Cuándo se despachó por última vez?
cat .pipeline/state/last-dispatch.json

# ¿Qué está viendo el watchdog?
cat .pipeline/state/dispatch-watchdog-status.json
#   pendientes                → elegibles (los que gobiernan la decisión)
#   pendientesTotal           → todos los workfiles en pendiente/
#   pendientesFueraDeAlcance  → backlog parkeado
#   alcanceAplicado           → allowlist | unscoped | desync-ola | fail-closed-sin-ola
#   alcanceCiego              → true = "0 elegibles" NO es una cola vacía (§3)
#   modoLeible                → false = getPipelineMode() tiró; no se declara causa
#   action                    → última decisión: skip | alert | escalate

# Episodio en curso (reloj de movimiento, cantidad de avisos)
cat .pipeline/state/wave-stall-watchdog-state.json

# Log del brazo
grep dispatch-watchdog .pipeline/logs/pulpo.log | tail -30
```

## 9. Garantías

- **Read-only por contrato**: el watchdog no toca `.paused`, ni la allowlist, ni
  la cola, ni promueve issues. Todo destrabe sigue siendo humano.
- **Accesorio**: si el brazo tira, se loguea y el loop del Pulpo sigue.
- **Fail-closed**: cualquier chequeo de causa que explote se ignora, y sin causa
  el watchdog dispara. Una excepción jamás puede silenciarlo.

## 10. Tests

| Archivo | Cubre |
|---|---|
| `lib/wave-stall-watchdog.test.js`, `lib/__tests__/dispatch-stall-watchdog.test.js` | la decisión pura (umbrales, estampa, recuperación, escalada) |
| `lib/__tests__/dispatch-facts.test.js` | el brazo de recolección contra un filesystem real |
| `lib/__tests__/dispatch-watchdog-circuito.test.js` | el circuito completo: FS → hechos → `decide()` → mensaje, con un escenario por Gherkin |
| `lib/__tests__/dispatch-cause-kind.test.js` | traducción del enum de causas |
| `lib/__tests__/dispatch-watchdog-emisores.test.js` | que no haya un tercer emisor sin dedup (R-1) |

Suite: `npm run test:pipeline`.
