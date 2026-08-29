# Gestión de disco

El disco de la máquina se llenaba cada 2-3 semanas. Este documento explica por
qué, qué componente atiende cada foco de consumo y qué queda deliberadamente sin
automatizar.

## El síntoma y la causa

El foco de consumo se mueve entre mediciones — en julio de 2026 eran worktrees
huérfanos, en agosto los artefactos de build — así que **medir antes de limpiar**
es la primera regla. Lo que no cambiaba eran los defectos estructurales.

El incidente del 2026-08-20 llegó a **167 MB libres de 236 GB**. La distribución:

| Foco | Peso | Quién lo atiende |
|------|------|------------------|
| Worktrees (118 registrados) | 45 GB | `cleanup-worktrees.js` |
| `~/.android/avd` (emulador QA) | 13 GB | nadie — decisión deliberada |
| `npm-cache` | 8 GB | `rotate-caches.js` |
| `~/.cache` (puppeteer + modelos de audio) | 8,7 GB | `rotate-caches.js` (solo puppeteer) |
| `~/.gradle` | 6,8 GB | `rotate-caches.js` (solo `.tmp`) |
| `AppData/Local/Temp` | 4,8 GB | nadie — ver limitaciones |

## Por qué se acumulaban los worktrees

`cleanup-worktrees.js` consideraba muerto a un worktree con este criterio:

```js
if (contents.length <= 1) isDead = true;
```

Un worktree con código **nunca** califica, por mergeado que esté su PR. Peor:
`checkPRStatus()` se consultaba *después* de elegir candidatos, así que "PR
mergeado" solo se escribía en el log — era decorativo. Por eso se acumulaban 100+
copias del repo (~250 MB cada una) mientras `/ghostbusters` reportaba
"liberación potencial 0.00 GB".

### El criterio de reclamación

Un worktree es reclamable cuando su contenido **ya vive en `origin/main`** y no
tiene trabajo local. En orden, y cortando en la primera señal que lo salve:

1. **Heartbeat fresco** (< 15 min) → se conserva. Última línea de defensa: hay un
   agente escribiendo ahí ahora mismo, y el registro del pipeline puede estar stale.
2. **Commits fuera de main** → se conserva.
3. **Cambios sin commitear** → se conserva.
4. Si nada de lo anterior aplica → se reclama.

Sobre (2), estos dos comandos **no sirven** como criterio, y es un error fácil de
cometer:

- `git log origin/main..HEAD` — con squash-merge, *todo* PR mergeado muestra
  commits pendientes.
- `git diff origin/main...HEAD` — el diff de 3 puntos muestra los cambios de la
  rama aunque main ya los tenga.

El que sí sirve pregunta por el commit exacto:

```bash
git merge-base --is-ancestor HEAD origin/main
```

Sobre (3), el estado sucio se filtra por ruido operativo: `.claude/`,
`.pipeline/`, heartbeats y `.log` se reescriben solos en cada corrida. Si contaran
como trabajo, ningún worktree se reclamaría nunca y volveríamos al problema
original.

### La lista por stdin era una orden de borrado

`git worktree list --porcelain | node cleanup-worktrees.js` enumera **todos** los
worktrees. Esa rama los devolvía como targets sin clasificar: cualquier worktree
no protegido explícitamente se borraba, tuviera trabajo o no. Ahora esa lista se
trata como inventario y pasa por el mismo criterio. **Solo los paths pasados como
argumento son una orden explícita.**

## Rotación de cachés

`rotate-caches.js` atiende lo que no tenía dueño. Se auto-limita por umbral: si
hay más de 30 GB libres no hace nada, así que correrlo seguido no cuesta.

```bash
node .claude/hooks/rotate-caches.js --dry-run          # ver qué haría
node .claude/hooks/rotate-caches.js --force            # ignorar el umbral
node .claude/hooks/rotate-caches.js --min-free-gb=50   # umbral propio
```

Qué rota:

- `~/.gradle/.tmp` — temporales que Gradle nunca borra (28k entradas / 2 GB).
- `~/.cache/puppeteer` — una copia de Chrome (~430 MB) por versión descargada;
  conserva solo la más nueva. El orden es por segmento numérico: comparar como
  strings pone `146.0.7680.76` después de `146.0.7680.153` y borraría la nueva.
- `npm-cache` — solo si supera 2 GB.
- `build/`, `.gradle/`, `.kotlin/`, `kotlin-js-store/` de worktrees sin heartbeat
  fresco.

Se engancha en `tryFreeResources()` del Pulpo, que hasta ahora limpiaba solo el
mapa en memoria de `activeProcesses` — ni un byte de disco. Corre desacoplado
(`spawn` + `unref`, nunca bloquea el ciclo), con throttle de 1 hora, y en ventana
nocturna va con `--force`.

## El guardián automático (#6708)

Todo lo anterior describe **cómo** se limpia. Hasta #6708 faltaba **cuándo se
limpia solo y quién lo decide**: el único control por espacio libre era `/ops`
avisando por debajo de 5 GB, y sólo si un humano lo corría. El cron interno del
Pulpo corría en `dry_run: true` desde que se creó — nunca borró un byte.

El Pulpo ahora mide el espacio libre **en cada tick** y aplica una escalera de
acciones. El estado vive en `.pipeline/disk-guard-state.json` (no versionado) y
el dashboard lo muestra como un gauge más, con el color del umbral vigente.

### El presupuesto

Los umbrales viven en `.pipeline/config.yaml`, bloque `disk_budget`, y se
cambian sin tocar código:

| Campo | Default | Qué hace |
|-------|---------|----------|
| `enabled` | `true` | Kill-switch del guardián entero |
| `green_gb` | 40 | Por encima: no se hace nada |
| `yellow_gb` | 25 | Piso del amarillo |
| `orange_gb` | 12 | Piso del naranja; debajo es rojo |
| `hysteresis_gb` | 2 | Margen extra para **salir** del freno (anti-flapping) |
| `rotate_throttle_min` | 60 | Mínimo entre rotaciones de caché |
| `reclaim_throttle_min` | 60 | Mínimo entre reclamaciones de worktrees |
| `alert_cooldown_min` | 120 | Re-aviso de Telegram mientras el umbral persiste |
| `freeze_heavy_phases` | `true` | Kill-switch sólo del freno de fases |
| `alert_freed_gb` | 5 | Avisar si una corrida liberó más que esto |

Son **GB libres, no porcentaje**: lo que importa es si entra un build de Gradle o
un video de QA, no qué fracción del disco se usó.

Los umbrales deben ser estrictamente descendientes. Si no lo son, se descarta la
terna entera y se vuelve a los defaults — corregir sólo el campo ofensor daría un
presupuesto que el operador no escribió y en el que no puede confiar.

### La escalera de acciones

Es **acumulativa**: el nivel no elige *una* acción, elige *hasta dónde llega*.

| Nivel | Libres | Qué corre |
|-------|--------|-----------|
| 🟢 verde | `> green_gb` | nada |
| 🟡 amarillo | `yellow_gb`–`green_gb` | rotar cachés (`rotate-caches.js`) |
| 🟠 naranja | `orange_gb`–`yellow_gb` | + reclamar worktrees integrados **sin el cap de 5** + alerta a Telegram |
| 🔴 rojo | `< orange_gb` | + frenar el despacho de `build` y `verificacion` + alerta a Telegram |

El freno de rojo existe para no rebotar issues sanos: sin disco, un build falla
y el pipeline lo reporta como defecto del código. Se levanta recién en
`orange_gb + hysteresis_gb`, para que un tick que rasguña el umbral no prenda y
apague el freno alternadamente.

Cada acción tiene su throttle propio y un flag en memoria que impide dos
corridas en vuelo. Si la medición falla, el nivel es `unknown` y **no corre
ninguna acción destructiva**: un guardián ciego no borra.

El módulo es **accesorio**: toda función pública devuelve un valor utilizable
ante cualquier error, y el gate de despacho es fail-open por partida doble. Si
`disk-guard.js` se rompe, el Pulpo sigue despachando — a lo sumo sin guardián.

### Salida del dry-run, auditada

`ghostbusters_cron.dry_run` pasó a `false`. Cada borrado queda en
`.pipeline/audit/ghostbusters-worktrees.jsonl` (path, peso, motivo, timestamp) y
cada acción del guardián en `.pipeline/audit/disk-guard.jsonl` (acción, libre
antes/después, liberado, presupuesto vigente). Ambos son append-only y no se
versionan.

Salir del dry-run sólo tiene sentido junto con el guard refinado del punto
siguiente: sin él, el sweep seguiría cerrando con "liberación potencial 0.00 GB".

### Ruido de infra ya no protege worktrees muertos

El guard de "archivos sin commitear" protegía a decenas de worktrees de issues
**ya cerrados** por un único archivo de heartbeat o una copia de `.claude/`. Eso
es ruido de infra regenerable, no trabajo humano, y volvía decorativo al
automatismo entero.

`.pipeline/lib/infra-noise.js` clasifica ese ruido y lo excluye del conteo:
heartbeats, `.claude/` copiado, evidencia de QA, colas y estado del pipeline,
artefactos de build. Es **fail-closed**: una línea que no se puede parsear, un
conflicto de merge o un path desconocido cuentan como cambio real. El código
fuente del pipeline **no** es ruido, aunque viva bajo `.pipeline/`.

Un worktree con un `.kt` modificado sin pushear se sigue conservando.

### Cómo revertir

Todo se revierte por config, sin tocar código ni desplegar:

- **Apagar el guardián entero** — `disk_budget.enabled: false`.
- **Volver al modo reporte** — `ghostbusters_cron.dry_run: true`. El sweep
  vuelve a listar sin borrar; el audit sigue registrando ambos modos.
- **Sólo desactivar el freno de fases** — `disk_budget.freeze_heavy_phases:
  false`. La limpieza sigue corriendo, el despacho no se frena nunca.
- **Aflojar los umbrales** — bajar `green_gb`/`yellow_gb`/`orange_gb` retrasa
  cada escalón.

Cualquiera de los cuatro requiere reiniciar el Pulpo para tomar efecto.

## Lo que NO se toca, y por qué

- **`~/.android/avd`** (13 GB) — el emulador QA con su snapshot `qa-ready`.
  Regenerarlo cuesta una sesión de QA entera.
- **`~/.cache/whisper` y `~/.cache/huggingface`** (4,5 GB) — modelos de audio
  operativos.
- **`qa/evidence`** — evidencia de gates de QA. El walk de artefactos corta en
  `qa/` explícitamente.
- **`.pipeline/`** — trampa clásica: `.pipeline/desarrollo/build` **no** es un
  directorio de Gradle sino una **fase** del pipeline
  (`pendiente`/`trabajando`/`listo`/`procesado`). Un `find -name build` se lo
  lleva puesto. El walk corta en `.pipeline` por esto.
- **Logs y audios** — son operación. No se podan sin OK explícito.

## Deuda pendiente

**`qa/evidence` está trackeado en git pese a estar en `.gitignore`.** El ignore no
aplica a lo ya trackeado, así que los 950 archivos siguen en el índice: 659 PNGs,
17 MP4 y 27 ZIPs, **185 MB de los 284 MB de peso base del repo**. Cada
`git worktree add` los materializa. Con ~100 worktrees son **~18 GB de evidencia
QA replicada** — el consumo individual más grande del sistema.

El fix es `git rm -r --cached qa/evidence` (no borra nada del disco, solo saca
del índice), pero saca la evidencia histórica de los checkouts. **Queda a
decisión del operador**; a la fecha de este documento no se aplicó.

Menor: `~/AppData/Local/Temp` acumula ~3 GB en archivos de más de 48h, incluidas
copias del repo (~1 GB) con nombre de issue (`qa5244*`, `sec5396*`). Solo se
deben borrar las de issues **cerrados**, y nunca el directorio de la sesión de
Claude en curso — ahí viven los outputs de tareas en background.

## Al medir

- `ls` y `du` sobre Temp o los worktrees tardan más de 10 minutos y timeoutean.
  Usar Node (`fs.readdirSync` recursivo).
- En PowerShell, `$var += ...` dentro de `ForEach-Object` escribe en un scope hijo
  y devuelve 0. Usar `Measure-Object`.
- `find ... | tee f | head -N` trunca el archivo por SIGPIPE.
- `git worktree remove --force` falla seguido en worktrees con `.claude/` copiado;
  el fallback `fs.rmSync(recursive)` funciona. Después, `git worktree prune`.
