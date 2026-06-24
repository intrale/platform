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
```

### Generalización pendiente

`#4157` (registrado como `needs-human`) propone generalizar el liveness por
heartbeat a **todos** los servicios críticos del watchdog, no sólo el Pulpo.
