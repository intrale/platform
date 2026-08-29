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
