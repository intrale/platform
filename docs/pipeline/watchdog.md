# Watchdog del pipeline — liveness por heartbeat

Documentación operativa del watchdog (`.pipeline/watchdog.ps1`) y de la
detección de **zombis** por heartbeat. Cubre dos niveles de liveness que se
apoyan en el mismo patrón (emisor escribe heartbeat → verificador chequea edad):

1. **Liveness del propio watchdog** (#4077) — el watchdog se auto-supervisa.
2. **Liveness del Pulpo** (#4154) — el watchdog detecta un Pulpo zombi.

---

## 1. Qué vigila el watchdog

El watchdog es una tarea de **Windows Task Scheduler** que corre cada **2 min**
(no es un daemon: cada disparo es un proceso nuevo; un hueco en `watchdog.log`
significa "todo OK", no caída). Verifica que los servicios críticos del pipeline
estén vivos y, si alguno cayó, lo relanza.

Servicios vigilados (por `CommandLine` del proceso `node.exe`):

| Componente   | Script                  |
|--------------|-------------------------|
| pulpo        | `pulpo.js`              |
| listener     | `listener-telegram.js`  |
| svc-telegram | `servicio-telegram.js`  |
| svc-github   | `servicio-github.js`    |
| svc-drive    | `servicio-drive.js`     |
| dashboard    | `dashboard.js`          |

**Fuente de verdad: el SO.** El watchdog NO lee archivos `.pid` (pueden quedar
desincronizados de la realidad). Usa `Get-CimInstance Win32_Process` filtrando
por la command line.

### Guardas de seguridad del ciclo

- **Heartbeat propio (#4077):** lo primero que hace cada ciclo es escribir
  `.pipeline/logs/watchdog.heartbeat` (`{ pid, ts }`, atómico tmp+rename). Lo lee
  el **supervisor** (`watchdog-supervisor.ps1`, 2da tarea de Task Scheduler) para
  relanzar el watchdog si éste dejó de correr.
- **Stand-by por restart en curso:** si `last-restart.json` tiene < 90s, el
  watchdog hace `exit 0` sin tocar nada (un restart legítimo mata y relanza todo;
  un spawn del watchdog en ese momento causaría carreras / `EADDRINUSE` en 3200).
  **Toda la lógica de kill-zombi va DESPUÉS de este guard** (CA-3.2 de #4154).

---

## 2. Detección de Pulpo zombi (#4154)

### El problema

El chequeo de "¿existe el proceso?" da por **sano** a un Pulpo *zombi*: el
proceso `node pulpo.js` sigue vivo a nivel SO, pero su **loop principal dejó de
iterar** (colgado). "Proceso existe" == "sano" es falso. Incidente 2026-06-24:
tras un restart el Pulpo quedó vivo pero sin iterar; el watchdog no lo detectó y
hubo que reiniciar el servidor a mano.

### La solución: heartbeat + verificación de edad

Mismo patrón que el liveness del watchdog (#4077), un nivel abajo:

```
Pulpo emite heartbeat por iteración  ──►  Watchdog verifica que sea reciente
   (last-tick.json)                          (si vencido + proceso vivo = zombi)
```

#### Emisión — `pulpo.js`

Al inicio de cada iteración del `while (running)`, el Pulpo escribe
`.pipeline/last-tick.json`:

```json
{ "pid": 12345, "timestamp": "2026-06-24T12:35:44.427Z" }
```

- **Campo canónico `timestamp`** (ISO8601). NO se renombra a `ts`: el read-side
  de `/salud` (`lib/commander-deterministic.js`) lee `tick.timestamp`.
- **`pid`**: lo usa el watchdog como *cross-check* PID↔SO antes de matar (SEC-1).
- **Escritura atómica** (tmp + rename): el watchdog nunca lee a medio escribir.
- **Best-effort** (try/catch): un fallo de FS jamás tumba el loop (CA-1.1).

#### Verificación — `watchdog.ps1` + Node

El watchdog, **sólo para el pulpo** y **sólo si su proceso existe**, recolecta
los hechos del SO y delega la decisión en Node:

- `lib/pulpo-liveness.js` — decisión **pura y testeable** (`node --test`), espejo
  de `lib/watchdog-supervisor.js`.
- `pulpo-liveness-run.js` — runner que el `.ps1` invoca; lee hechos por env,
  delega, devuelve `ACTION:kill-respawn | ACTION:skip` por stdout. Fail-soft:
  cualquier error interno → `ACTION:skip`.

PowerShell queda como capa fina de SO: recolecta hechos, y si Node dice
`kill-respawn`, ejecuta `Stop-Process` + respawn.

#### Decisión (`decide()`)

Hechos de entrada: `{ hbExists, hbAgeMs, hbPidFromContent, soPid, killThresholdMs }`.

| Situación                                              | Resultado               |
|--------------------------------------------------------|-------------------------|
| No existe `last-tick.json`                             | `skip` (lo cubre el spawn normal) |
| Existe pero edad ilegible (mtime raro)                 | `skip` (fail-closed)    |
| Umbral inválido                                        | `skip` (nunca matar por umbral degradado) |
| Lag ≤ umbral                                           | `skip` (sano, CA-4)     |
| Lag > umbral **y** pid del heartbeat == pid del SO     | `kill-respawn` (zombi)  |
| Lag > umbral pero pid no cruza / inválido / ausente    | `skip-log-discrepancy`  |

> **La edad (`hbAgeMs`) se calcula desde el `LastWriteTime` del archivo**, NO
> desde el `timestamp` del contenido. El contenido es input no confiable (SEC-2)
> y sólo se usa para el cross-check del `pid`.

#### Kill validado (SEC-1)

El watchdog **NUNCA** hace `Stop-Process -Id <pid-del-json>`. Mata **sólo** el
proceso que el propio scan del SO identificó por `CommandLine *pulpo.js*`
(`$soPid`). El `pid` del heartbeat es únicamente un *cross-check*: si no coincide
con `$soPid` (PID reciclado por Windows, heartbeat corrupto/falsificado) → **no
mata**, registra la discrepancia. Tras el kill, respawnea con el mismo
`Start-Process` que el path de proceso ausente (sincroniza `origin/main` antes).

> El Pulpo NO hace `listen()` de ningún puerto (los puertos los bindean
> `dashboard.js` y `listener-telegram.js`). Por eso kill+respawn del Pulpo es
> seguro respecto a `EADDRINUSE`.

---

## 3. Umbral de kill (anti falso positivo)

`config.yaml → watchdog.pulpo_liveness_kill_seconds` (default **90s**).

**Desacoplado del display.** `/salud` usa "esperado < 30s" sólo para *mostrar*
salud; 30s == 1 `poll_interval` del Pulpo, y un ciclo lento (precheck de red,
brazo pesado) podría rozarlo sin ser zombi. El umbral de *kill* es holgado:
`max(90, 3×poll_interval)`. Esto, junto con el guard de `last-restart.json < 90s`
y la auditoría de cada kill, evita **restart-storms** (SEC-3).

- Override por env: `PULPO_LIVENESS_KILL_SECONDS` (entero positivo).
- Valor inválido → cae al default. **Nunca** degrada a "nunca stale" (SEC-2).

### Semáforo recomendado en `/salud` (UX, CA-5)

| Lag                         | Estado                                   |
|-----------------------------|------------------------------------------|
| 🟢 `< 30s`                  | sano                                     |
| 🟡 `30s ≤ lag < umbral kill`| degradado (todavía no se reinicia)       |
| 🔴 `≥ umbral kill`          | zombi (el watchdog lo va a reiniciar)    |

Mostrar el lag en unidad humana (`hace 12s`), sin paths absolutos ni internos
de proceso (SEC-5).

---

## 4. Defensas de seguridad (resumen)

| Id    | Defensa                                                                       |
|-------|-------------------------------------------------------------------------------|
| SEC-1 | Kill sólo del PID del scan SO; el PID del JSON es cross-check, no comando.     |
| SEC-2 | `last-tick.json` = input no confiable: parseo defensivo, fail-closed; umbral inválido → default. |
| SEC-3 | Umbral de kill holgado y desacoplado + guard de restart + auditoría → anti restart-storm. |
| SEC-4 | (Heartbeat best-effort + atómico) un fallo de FS jamás tumba el loop.          |
| SEC-5 | `/salud` expone sólo lag / pid; sin paths ni internos.                          |

---

## 4.bis Restart selectivo de servicios con código viejo (#5646)

### El problema

El watchdog hace `git fetch origin main` + `git reset --hard FETCH_HEAD` en **dos**
caminos: antes de respawnear un Pulpo zombi, y antes del loop de servicios caídos.
Ese reset actualiza el código **en disco de todos los servicios**, pero el
watchdog sólo relanza los que estaban caídos. Los que siguen vivos quedan con el
código anterior en el `require.cache` de Node — *código viejo*.

Eso rompe a los servicios que releen datos de disco en caliente pero validan con
código cacheado. El caso confirmado (dos incidentes en dos días) es el dashboard:

- `.pipeline/config.yaml` se relee en cada validación (`reload: true`).
- `.pipeline/lib/config-schema.js` quedó congelado desde el arranque del proceso.
- Un merge que agrega una sección **a los dos archivos a la vez** deja el disco
  coherente, pero el proceso valida **config nueva contra schema viejo** →
  `clave no permitida: '<seccion>'` → fail-closed → la ola pierde todos los estados.

El fail-closed **no es el defecto**: es un control funcionando. El defecto es la
deriva entre código en memoria y datos en disco.

### El diseño: marcar y ejecutar están separados

- **Los emisores de reset sólo MARCAN.** `watchdog.ps1` (sus dos resets),
  `restart.js:syncWithMain()` y el endpoint `POST /api/ops/restart-operativo`
  computan qué componentes quedaron con código viejo y lo anotan en
  `.pipeline/stale-services.json`.
- **El watchdog es el ÚNICO EJECUTOR** del restart de servicios stale. Ya corre
  cada 2 min, ya tiene el contrato de spawn correcto, y es externo al dashboard
  (que no puede matarse a sí mismo). No existe un relanzador genérico que acepte
  paths o command lines.
- **La marca persiste hasta que el restart se confirma.** Si el relanzamiento
  falla, el componente sigue pendiente el ciclo siguiente.

### Mapeo diff → componente (estático y conservador)

| Path del diff                | Componentes afectados |
|------------------------------|-----------------------|
| `.pipeline/lib/**`           | todos                 |
| `.pipeline/config.yaml`      | todos                 |
| `.pipeline/<script propio>`  | sólo ese componente   |
| cualquier otra cosa          | ninguno               |

Nada de grafo de imports: ningún proceso puede inspeccionar el `require.cache`
de otro, así que cualquier inferencia más fina sería adivinanza. Ante duda
(SHA previo ausente, corrupto o no-hexadecimal; `git diff` que falla) el helper
devuelve `unknown: true` con **todos** los componentes — nunca la lista vacía.

### Registro canónico de componentes (9)

Es la **unión** de `restart.js:COMPONENTS` (8, con `dashboard`, sin
`outbox-drain`) y `dashboard.js:COMPONENTS` (8, con `outbox-drain`, sin
`dashboard`). Vive en `lib/stale-services.js` y `watchdog.ps1:$ScriptMap` lo
replica; hay un test que falla si divergen — un componente marcado stale sin
entrada en el mapa del ejecutor sería un fail-open silencioso.

`restart.js` limpia los pendientes **sólo de lo que `launchAll()` relanzó de
verdad** (lista derivada del retorno, no de una constante duplicada). Por eso
`outbox-drain` queda pendiente a propósito: lo relanza el watchdog.

### Cotas y guardas

- `last-selective-restart.json`, ventana **90 s** (molde de `last-restart.json`).
- Máximo **4 componentes por ronda**; el resto queda pendiente para el ciclo
  siguiente. Casi todo merge del pipeline toca `.pipeline/lib/**`, así que
  reiniciar varios servicios varias veces por día es el camino feliz, no un
  incidente: no hay notificación al operador en ese caso.
- Un componente que **no está corriendo** no se "reinicia": no tiene código
  viejo en memoria y este bloque no levanta servicios apagados. Se le baja el
  pendiente y listo.
- El endpoint HTTP tiene además una **cota agregada** (4 por minuto, en
  `lib/ops-restart-handler.js:makeAggregateLimiter`): el rate-limiter existente
  es por *target*, así que con N componentes N targets distintos pasaban la misma
  ráfaga. El conjunto se computa **server-side**; una lista de componentes en el
  body del request se ignora.

### Cómo se lee en el log

```
restart selectivo: dashboard reiniciado — cambio en .pipeline/lib/config-schema.js (PID 1234)
restart selectivo: sin componentes afectados por el reset
```

Causa antes del efecto, nombre del componente **como aparece en el panel**
(`svc-drive`, no `servicio-drive.js`), **un** path (el que motivó el restart, no
el diff entero). El caso "no reinicié nada" también deja línea: sin ella, el log
silencioso es indistinguible de un watchdog que no corrió.

Los paths salen del contenido del commit, así que se sanitizan antes de tocar el
log: `git diff --name-only -z`, strip de CR/LF y secuencias ANSI, truncado a 120
chars. Un path con salto de línea embebido no puede falsificar líneas.

### Fuera de alcance (rechazar en review)

Relajar `config-schema.js` a "ignorar claves desconocidas", degradar el
fail-closed del dashboard, o hot-reloadear el require-cache del schema. El bug es
la frescura del código; ahí es donde pega el fix.

---

## 5. Archivos involucrados

| Archivo                              | Rol                                                |
|--------------------------------------|----------------------------------------------------|
| `.pipeline/pulpo.js`                 | Emite `last-tick.json` por iteración (`writeHeartbeat`). |
| `.pipeline/lib/pulpo-liveness.js`    | Decisión pura y testeable (zombi sí/no).           |
| `.pipeline/pulpo-liveness-run.js`    | Runner invocado por el `.ps1` (env → ACTION).      |
| `.pipeline/watchdog.ps1`             | Capa SO: recolecta hechos, kill validado + respawn.|
| `.pipeline/config.yaml`              | `watchdog.pulpo_liveness_kill_seconds`.            |
| `.pipeline/test/pulpo-liveness.test.js` | Tests `node --test` de la decisión y el runner. |
| `lib/commander-deterministic.js`     | Read-side de `/salud` (lee `tick.timestamp`).      |
| `.pipeline/lib/stale-services.js`    | #5646 — registro canónico, mapeo diff→componente, marcado/limpieza y CLI del restart selectivo. |
| `.pipeline/stale-services.json`      | #5646 — pendientes de relanzar (estado runtime, no versionado). |
| `.pipeline/last-selective-restart.json` | #5646 — guard de ronda del restart selectivo (90 s). |
| `.pipeline/lib/stale-services.test.js` | #5646 — tests `node --test` del helper y de los contratos del watchdog/endpoint. |

---

## 6. Debugging operativo

```bash
# ¿El Pulpo está emitiendo heartbeat?
cat .pipeline/last-tick.json          # { "pid": ..., "timestamp": "..." }

# Edad del último tick (debería ser pequeña si el Pulpo itera normal)
node -e "const t=require('./.pipeline/last-tick.json');console.log('lag ms:',Date.now()-new Date(t.timestamp).getTime())"

# Decisiones del runner de liveness (kill / skip / discrepancia)
tail -f .pipeline/logs/pulpo-liveness.log

# Kills de zombi registrados por el watchdog (ts, pid, lag)
grep "pulpo-liveness" .pipeline/logs/watchdog.log

# #5646 — ¿Qué servicios quedaron con código viejo y todavía no se relanzaron?
cat .pipeline/stale-services.json
node .pipeline/lib/stale-services.js --json

# #5646 — Historia de restarts selectivos (qué componente y qué path lo motivó)
grep "restart selectivo" .pipeline/logs/watchdog.log

# #5646 — ¿El dashboard cayó en fail-closed por config nueva vs schema viejo?
grep "CONFIG INVÁLIDA" .pipeline/logs/dashboard.log
```

### Generalización pendiente

`#4157` (registrado como `needs-human`) propone generalizar el liveness por
heartbeat a **todos** los servicios críticos del watchdog, no sólo el Pulpo.
