# Gate del smoke test: presupuesto de tiempo y decisión de rollback

Documenta el contrato entre `.pipeline/restart.js` (el runner) y
`.pipeline/smoke-test.js` (el gate), y por qué los tiempos de ambos salen de un
único módulo: `.pipeline/lib/smoke-budget.js`.

Contexto: issue #5725, incidente del 2026-08-09.

## El problema que resuelve

El runner mataba el smoke test por timeout **antes de que escribiera su
diagnóstico**, y después trataba esa muerte como si el pipeline estuviera roto.

```
[2026-08-10 02:32:35] === SMOKE TEST ===
[2026-08-10 02:34:06] Smoke test FAIL (exit -1, signal=SIGTERM)
[2026-08-10 02:32:36] Esperando marker ready de: pulpo, listener, ...
```

El log se cortaba en "Esperando marker ready" y el auto-rollback se disparaba con
un `exit -1` que no distinguía **"el pipeline está roto"** de **"el smoke test no
llegó a terminar"**. El `EADDRINUSE` que explicaba todo estaba en
`dashboard.log`, pero el gate que decidía el rollback no lo mencionaba.

Tres causas concretas:

1. El timeout del runner (90s) y las ventanas del smoke (60s livianos + ventana
   diferenciada del dashboard) eran constantes **independientes**. El runner
   cortaba primero.
2. No había forma de volcar el estado parcial antes de morir.
3. `restart.js` colapsaba `status === null` a `-1`, perdiendo la distinción que
   `signal` sí conservaba.

## La fórmula del presupuesto

> El peor caso de la espera de markers es `max(light, dash)`, **no** `light + dash`.

`waitForComponentMarkers` no encadena los dos timeouts en serie: descuenta lo ya
transcurrido, porque el dashboard viene booteando durante la espera de los
livianos. Calcularlo como suma sobredimensiona sobre una premisa falsa — y si
después alguien "optimiza" restando ese margen de más, vuelve el bug.

```
markerWait = max(lightTimeoutMs, dashTimeoutMs)
postWait   = sonda HTTP con reintentos + /api/state + N self-checks
smoke      = markerWait + postWait + margen del watchdog
runner     = smoke + margen de volcado + margen del runner
```

Valores por defecto hoy:

| Tramo | Valor |
|-------|-------|
| Espera de markers (peor caso) | 120s |
| Chequeos posteriores | 156s |
| **Presupuesto propio del smoke** | **281s** |
| **Ventana del runner** | **316s** |

La invariante `runner > smoke + volcado` está fijada por test
(`.pipeline/tests/smoke-budget.test.js`). Si sube la ventana del dashboard, la
del runner **sube sola**: no hay dos números que mantener sincronizados a mano.

## Por qué el mecanismo es un watchdog y no un handler de SIGTERM

En Windows **el handler del hijo nunca corre**. Node no tiene señales POSIX ahí:
el `timeout` de `spawnSync` mata con `TerminateProcess`, que es incondicional
(equivalente a `SIGKILL`). Verificado empíricamente:

```
$ node parent.js          # spawnSync(child, {timeout:3000})
status= null signal= SIGTERM err= ETIMEDOUT

$ cat sig-out.txt
CHILD-ARRANCO             <-- el hijo arrancó
                          <-- HANDLER-CORRIO no aparece
```

El `signal=SIGTERM` que ve `restart.js` es lo que observa **el padre**, no algo
que el hijo pueda interceptar. Por eso hay tres capas, en orden de preferencia:

1. **La ventana derivada** hace que el runner no mate al smoke. Elimina la causa.
2. **El watchdog interno** (cooperativo): el smoke se autolimita a su propio
   presupuesto y vuelca el estado parcial él mismo. Funciona igual en Windows y
   en Linux. Sale con **exit 5**.
3. **El heartbeat**: `log()` hace `appendFileSync` línea por línea, así que todo
   lo logueado sobrevive incluso a una muerte abrupta. Cada 15s se escribe qué
   componentes faltan. Aun en el peor caso el log tiene el último estado conocido.

Los `process.on('SIGTERM')` existen como red de seguridad para POSIX y para el
Ctrl-C manual, pero **no** son el mecanismo principal.

## Exit codes

| Código | Significado | ¿Rollback? |
|--------|-------------|-----------|
| 0 | Pipeline sano | — |
| 1 | Componente no llegó a ready (o su PID murió) | Sí |
| 2 | Dashboard no responde en :3200 | Sí |
| 3 | Falta `last-restart.json` | Sí |
| 4 | Falló el self-check de un skill determinístico | Sí |
| **5** | **El smoke no completó sus chequeos** | **No** |

Además, `classifySmokeResult()` trata como "no completó" (y por lo tanto **sin
rollback**) estos casos, que antes caían todos en `exit -1`:

- `status === null` con `signal` → lo mató el runner o una señal externa.
- `error.code === 'ETIMEDOUT'` → específicamente el timeout del runner.
- `spawnSync` no pudo lanzar el proceso (`ENOENT`, `EACCES`).

El criterio es uno solo: **sin veredicto del gate no hay evidencia contra el
código, y sin evidencia no se revierte un deploy.** El operador recibe una
alerta de Telegram explicando que quedó la versión nueva y que requiere revisión
manual.

## Formato del log (es la interfaz del operador)

El log se lee de abajo para arriba a las 2 AM con el pipeline caído. Reglas:

- **Nunca termina en una línea de espera.** El volcado parcial cierra con
  `=== SMOKE TEST INTERRUMPIDO (motivo tras Ns) ===` y una línea final
  `INCOMPLETO: …`. Nunca reutiliza `=== SMOKE TEST OK ===` ni el `FAIL:` de un
  fallo real, que significan otra cosa.
- **Un solo veredicto por corrida, al final.** La última línea responde
  "¿esto anduvo?" sola.
- **Vocabulario fijo**: `OK` / `STALE` / `MISSING` / `PENDIENTE` / `WARN` / `FAIL`.
  - `MISSING` → se agotó su ventana sin marker: hay veredicto.
  - `PENDIENTE` → seguíamos esperándolo cuando nos interrumpieron: sin veredicto.
- **La cola del log del componente caído va adjunta**, indentada bajo su línea y
  acotada a 12 líneas:

```
  MISSING dashboard (sin marker ready tras 5s — no completó init)
    └ últimas 2 líneas de logs/dashboard.log:
      [2026-08-09 23:37:02] cargando slices
      Error: listen EADDRINUSE: address already in use :::3200
FAIL: Componentes no-ready tras 5s: dashboard
```

`pulpo.log` pesa varios MB: la cola se lee con un `read` posicional del último
bloque, nunca con `readFileSync`. Las líneas se limpian de control chars para
que un log no pueda falsificar la estructura del diagnóstico.

## Overrides por entorno

| Variable | Efecto |
|----------|--------|
| `DASHBOARD_MARKER_TIMEOUT_MS` | Ventana de markers del dashboard (arrastra la del runner) |
| `SMOKE_LIGHT_MARKER_TIMEOUT_MS` | Ventana de markers de los componentes livianos |
| `SMOKE_SELF_BUDGET_MS` | Fuerza el presupuesto propio del smoke (útil para probar el watchdog) |
| `SMOKE_RUNNER_TIMEOUT_MS` | Fuerza la ventana del runner |

## Cómo reproducir cada camino

```bash
# Watchdog interno: vuelca estado parcial y sale con 5
SMOKE_SELF_BUDGET_MS=3000 node .pipeline/smoke-test.js \
  --components=componente-fantasma --timeout 60 --no-http --no-self-check

# FAIL con diagnóstico + cola del log (exit 1)
PIPELINE_RUNTIME_DIR=/tmp/runtime-falso DASHBOARD_MARKER_TIMEOUT_MS=2000 \
  node .pipeline/smoke-test.js --components=dashboard --timeout 2 --no-http --no-self-check

# Tests
node --test .pipeline/tests/smoke-budget.test.js .pipeline/tests/smoke-test-diagnostico.test.js
```
