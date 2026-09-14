# Runbook — Cutover del estado operativo al store durable

> **Para el operador que está por encender `operational_state.durable`, o que ya
> lo encendió y algo se rompió.** Se lee **antes** de tocar nada y empieza por
> cómo volver atrás, porque eso es lo que hace falta cuando el cutover sale mal.
>
> Historia que lo crea: #5113 (CA-C8 · Ola 9.4 · E2 · cadena `#5108 → #5109 → #5110 → #5113`).
> Espejo estructural de `docs/pipeline/runbook-cutover-durable.md`.
>
> **Alcance de #5113 (PR-1 · Bloque A): el mecanismo, con el flag APAGADO.** La
> ejecución del cutover —Bloques B y C: precondiciones por sonda, migración con
> paridad, rollback ensayado en real, aborto en la ventana real y multi-instancia
> en dos hosts— vive en la historia hija **#7189** `[Split de #5113]`, bloqueada
> por ésta. #5113 **no reclama** el valor multi-instancia.

## Rollback en una pantalla (CA-UX4)

Si estás apurado, esto es todo lo que necesitás. El detalle está en §1.

```bash
# 1) APAGAR el flag — .pipeline/config.yaml, bloque `operational_state:` (~línea 2616).
#    OJO: hay DOS claves `durable:` en el archivo. La de `kernel:` (~1850) NO es ésta.
sed -n '/^operational_state:/,/^$/p' .pipeline/config.yaml | grep -n "durable:"
#   → debe quedar:  durable: false

# 2) REINICIAR (desde PowerShell, no desde Git Bash)
node .pipeline/restart.js

# 3) VERIFICAR el modo EFECTIVO del runtime (no el YAML)
node -e "console.log(JSON.stringify(require('./.pipeline/lib/operational-state-backend').describeMode()))"
#   → {"mode":"fs","source":"config","degraded":false,"degradedKeys":[],"observed":false,...}

# 4) ¿QUEDÓ PAUSADO? Si la degradación abrió la ventana de cutover, el sink
#    escribió `.pipeline/.paused` y el restart NO lo levanta solo (a propósito).
#    Sin este paso el modo dice `fs` — verde — y el pipeline sigue muerto.
cat .pipeline/.paused 2>/dev/null && echo "^^ HAY HALT ACTIVO: mandá /reanudar (o borrá el archivo)"
```

Atajo en caliente, sin editar ni mergear el YAML (§1.3):

```bash
PIPELINE_OPSTATE_DURABLE=0 node .pipeline/restart.js
```

**Lo escrito en el store no se borra: deja de leerse.** El rollback es un cambio
de sustrato de lectura/escritura, no un borrado. Lo que se registró durante la
ventana remota se recupera restaurando el filesystem desde el backup (§1.4).

---

## 0 · Antes de empezar

### Qué cubre y qué no

Cubre el **cutover del estado operativo** —el **registro de olas** (`waves.json`)
y la **allowlist de ejecución** (`.partial-pause.json`)— desde filesystem a la
**tabla de coordinación** `intrale-kernel-coordination`, y su vuelta atrás.

**No** cubre el cutover del kernel (`kernel.durable`: descriptores, catálogo,
firmas, audit y claims): eso es `docs/pipeline/runbook-cutover-durable.md`, y es
un **prerrequisito** de éste (§3). Tampoco cubre el aprovisionamiento de tablas,
CMK ni IAM: eso lo hizo #5207 y está documentado allá.

**Cero datos reales.** Este archivo vive en un repo público. Todo lo que parezca
account-id, ARN o credencial va como `<placeholder>` y **se resuelve en el
momento**; nunca se commitea.

### Estado de ejecución — qué está hecho y qué no

Este runbook se escribe **antes** de ejecutar el cutover. La distinción no es
cosmética: un runbook que se lee como registro de una corrida que nunca ocurrió
es peor que no tenerlo.

| Bloque | Qué es | Ensayado en seco | Ejecutado |
|---|---|---|---|
| **Bloque A** — backend + guardrails | `lib/operational-state-backend.js`, CAS con `expectedVersion` **propagado desde los mutadores de los dos estados** (allowlist vía `readAllowlistSnapshot`, registro de olas vía la versión adosada al snapshot de `loadWaves`), cotas de payload, redacción, gate `boolean` estricto, regla `async-gate` del lint, `partial-pause` en `SOURCES` y en `DEFAULT_KNOWN_KEYS`, driver Dynamo síncrono | — | ✅ **Implementado, con el flag APAGADO.** Sin impacto operativo: con `durable: false` no se construye driver ni se hace una sola llamada a AWS |
| **Bloque B** — precondiciones (CA-B1…CA-B5) | strict auth, `atomicUpdate` por sonda, identidad del runtime, audit trail (single-host, D-8), namespaceado ON | ✅ **#7189 (2026-09-14)** · sonda `--preconditions` ejecutada contra el host real: CA-B2 y CA-B3 en verde; **CA-B1 y CA-B5 en rojo diagnóstico** (`strict_auth_apagado`, `namespaceado_apagado` / `migrated:false`). Ver §10 | ⏳ **PENDIENTE de ejecución real — vive en H0 (#7194).** Los rojos de la sonda son exactamente lo que H0 tiene que poner en verde antes de la ventana |
| **Bloque C** — cutover, sondas y rollback | migración, sonda positiva no-vacía, ensayo de rollback, ensayo de aborto, multi-instancia | ✅ **#7189 (2026-09-14)** · CAS contra AWS real en verde (`--cas-probe`); sonda positiva ejecutada contra la tabla real ⇒ **rojo `estado_vacio`** (fail-closed sobre vacío demostrado); dry-run + backup verificado (`olas: 12 · allowlist: 54`); export store→FS y aborto ensayados contra fake / sandbox. Ver §10 | ⏳ **PENDIENTE — vive en H0 (#7194).** `apply` contra AWS, sonda positiva en verde, R8 medido y aborto en ventana real no ocurrieron. Multi-instancia (CA-C6) es H4 (#7198), fuera de H0 (D-6) |
| **CA-UX1…CA-UX5** — lo que ve el operador | chip de procedencia en el header, causa propia en el enum de no-despacho, canal único de alerta, rollback en la primera pantalla, copy que nombra la acción | — | ✅ **Implementado y verificado en el render real**, con el flag apagado. El chip muestra `filesystem local` hoy; los otros tres estados se capturaron hidratando la bandeja del header contra el dashboard servido |

> **"Ensayado en seco" y "ejecutado" son dos estados distintos, a propósito.**
> #7189 corrió cada paso con el flag apagado (tests contra driver fake +
> corridas de sólo lectura / idempotentes contra AWS real con la identidad del
> runtime) y dejó la evidencia redactada en §10 y en
> `docs/pipeline/evidence/7189/`. Nada de eso movió un flag ni migró un byte:
> los Bloques B y C se marcan ✅ en la columna "Ejecutado" recién cuando H0
> (#7194) los corra bajo firma del operador. Las dos decisiones que estaban
> abiertas las cerró el PO en `criterios` de #7189: **CA-C6** sale a una hija de
> ejecución (H4, #7198) que depende de código de coordinación nuevo (D-6, §9), y
> **el operador ejecuta** todo lo irreversible siguiendo este runbook (D-7).

### Léxico único

Un concepto, un identificador literal, un término en criollo. Sin sinónimos.

| Identificador literal | En criollo | Qué es |
|---|---|---|
| `operational_state.durable` | *el switch del estado operativo* | Flag **único** de `.pipeline/config.yaml` (~2616) que mueve el registro de olas y la allowlist al store. Gatea **lectura y escritura a la vez**. Default `false`. Lo lee **un solo archivo**: `lib/operational-state-backend.js` |
| `kernel.durable` | *el switch del kernel* | Flag **distinto** (~1850), del otro cutover. Prerrequisito, no sinónimo |
| `operational_state.namespaced.enabled` | *el namespaceado* | Flag de #5110: el estado vive bajo `.pipeline/projects/<projectId>/`. Default `false`. Debe estar en `true` **antes** de migrar (D-4) |
| `PIPELINE_OPSTATE_DURABLE` | *el override en caliente* | Env var `1`/`0` que fuerza el modo sin tocar el YAML. Gana sobre config |
| `intrale-kernel-coordination` | *la tabla de coordinación* | Destino del estado operativo (D-2). Es la única de las dos tablas que admite `UpdateItem`/`DeleteItem`. Declarada en `kernel.coordinationTableName` |
| `coord#waves` | *la clave del registro de olas* | SK del ítem, en la partición `PK = <projectId>` |
| `coord#partial-pause` | *la clave de la allowlist* | Ídem, para `.partial-pause.json` (CA-A8) |
| `.paused` | *el halt total* | Marker de halt del pipeline. **Filesystem SIEMPRE**, con el flag encendido o apagado (D-3 / SEC-7). Es también el mecanismo de aborto de este cutover |
| `kernel.cutover_window` | *la ventana de cutover* | Flag que pone el sink de degradación en modo fail-loud. Sólo el booleano `true` exacto la abre |
| `expectedVersion` | *el CAS* | Entero incremental de `body.version` del ítem. En modo remoto es **la** primitiva de exclusión: `withLockSync` es local por PID y entre hosts no excluye nada (CA-A4) |

> **Ojo con el falso amigo.** `kernel-cutover-probe.js` es la sonda del cutover
> **del kernel** (descriptores, producto, catálogo). **No prueba nada** sobre el
> estado operativo: no lee `coord#waves` ni `coord#partial-pause`. Lo que sí se
> reusa de ese módulo son sus helpers (`verifyRuntimeIdentity`,
> `getItemConsistent`) para armar la sonda de §8.

### Cómo verificar que estás parado donde creés

Antes de leer una línea más, tres preguntas con tres comandos:

```bash
# 1) ¿En qué estado están los flags del bloque?
sed -n '/^operational_state:/,/^$/p' .pipeline/config.yaml | grep -E "durable:|enabled:|strict_context:"

# 2) ¿Cuál es el modo EFECTIVO del runtime? (distinto del YAML si hay override por env)
node -e "console.log(JSON.stringify(require('./.pipeline/lib/operational-state-backend').describeMode()))"

# 3) ¿Dónde vive hoy el estado en disco?
node .pipeline/scripts/migrate-operational-state-namespace.js --status
```

Salida esperada **antes** del cutover — todo apagado, layout plano:

```
  durable: false
    enabled: false
    strict_context: false
```
```
{"mode":"fs","source":"config","degraded":false,"lastError":null}
```
```json
{
  "projectId": "intrale-platform",
  "stateDir": "…/.pipeline",
  "migrated": false
}
```

`describeMode()` imprime antes unas líneas de `[config-resolver]`: es ruido
normal del resolutor, no un error. Lo que importa es el JSON de la última línea.

Si `mode` dice `remote`, **no estás antes del cutover: estás en el medio de
uno**. Andá a §1 antes de tocar cualquier otra cosa. Si `source` dice `env`, el
valor del YAML es irrelevante en ese proceso: manda `PIPELINE_OPSTATE_DURABLE`.

---

## 1 · Rollback primero — cómo volver atrás

El rollback de este cutover es **más barato** que el del kernel, y por un motivo
concreto: el estado operativo es **mutable** y vive en la tabla de coordinación,
que sí admite borrado. No hay append-only que reconciliar. El precio de esa
comodidad es otro: **lo que se escribió durante la ventana remota no está en el
filesystem**, así que apagar el flag sin restaurar deja al pipeline leyendo el
estado que había **antes** de la migración.

### 1.1 · Qué deshace el apagado del flag, y qué no

| Qué | Cómo vuelve | ¿Automático? |
|---|---|---|
| Dónde se lee y se escribe el estado operativo | `operational_state.durable: false` + reinicio | ❌ **Manual** (edición + restart) |
| Ídem, sin editar el YAML | `PIPELINE_OPSTATE_DURABLE=0` en el entorno del proceso | ❌ Manual, y **sólo aplica a procesos nuevos** (§1.3) |
| `waves.json` / `.partial-pause.json` en filesystem | `kernel-store-migrate.js --rollback --from <dir>` | ✅ Sí, un comando |
| Los ítems `coord#waves` / `coord#partial-pause` ya escritos en DynamoDB | **No se borran.** Quedan ahí y dejan de leerse | — |
| Los cambios de estado hechos **durante** la ventana remota | **No vuelven solos al filesystem.** Hay que exportarlos antes de apagar (§1.5) o aceptar perderlos | ❌ **Manual** |
| `.paused` | **Ojo: participa aunque nunca se haya ido del filesystem (D-3).** El estado *dónde vive* no cambia, pero si la degradación ocurrió con la ventana de cutover abierta, el sink lo ESCRIBIÓ para abortar. Se levanta con `/reanudar` (o borrando `.pipeline/.paused`) — ver §1.6 | ❌ **Manual, y obligatorio si existe** |

> **Sin esta tabla, esta sección mentiría por omisión.** Apagar el flag es
> instantáneo; recuperar *lo escrito mientras estuvo encendido* no lo es.

### 1.2 · El apagado versionado (el camino normal)

```bash
# 1) Editar .pipeline/config.yaml → operational_state.durable: false
sed -n '/^operational_state:/,/^$/p' .pipeline/config.yaml | grep -n "durable:"

# 2) Reinicio limpio (PowerShell)
node .pipeline/restart.js

# 3) Verificación del modo efectivo
node -e "console.log(JSON.stringify(require('./.pipeline/lib/operational-state-backend').describeMode()))"
```

Verde es `{"mode":"fs","source":"config","degraded":false,"lastError":null}`.
Si sigue diciendo `"mode":"remote"`, el reinicio no tomó el archivo nuevo: no
avances, repetí el paso 2.

**No lo hagas al revés.** Reiniciar antes de editar deja el pipeline arrancando
otra vez contra el store; editar sin reiniciar deja procesos vivos con el flag
viejo en su config cacheada (`invalidateConfigCache()` existe, pero es para
tests y recarga in-process, no para el pipeline en producción).

### 1.3 · El atajo en caliente, y su letra chica

```bash
PIPELINE_OPSTATE_DURABLE=0 node .pipeline/restart.js
```

`isRemote()` mira `process.env.PIPELINE_OPSTATE_DURABLE` **antes** que la
config: `'0'` fuerza filesystem, `'1'` fuerza remoto, cualquier otra cosa cae en
el YAML. Sirve para cortar sin pasar por una edición de archivo versionado —y
por su merge— en el medio de una ventana.

Tres cosas que no son detalle:

1. **No cambia el entorno de un proceso ya vivo.** Un pulpo corriendo no ve la
   variable que exportaste después. Por eso el atajo se usa *al relanzar*, y el
   reinicio sigue siendo obligatorio.
2. **Es invisible en el YAML.** Un operador que después grepee `config.yaml` va
   a leer `durable: true` y va a creer que está en remoto. Por eso la sonda de
   verificación es `describeMode()` y no un `grep`: `source: "env"` es
   exactamente el aviso de que hay un override activo.
3. **No es el estado final.** El atajo destraba; el valor versionado tiene que
   quedar en `false` igual, o el próximo respawn vuelve a encender.

### 1.4 · Restaurar el filesystem desde el backup

El migrador deja un backup timestampeado **antes** de escribir nada (§2.2). La
restauración verifica **primero** el checksum del backup contra su `manifest.json`
y, si no cierra, no restaura nada (fail-closed):

```bash
node .pipeline/lib/kernel-store-migrate.js --rollback --from .pipeline/backup/<timestamp>
```

**Dónde restaura (#5113 rev-12).** El destino por default es el layout VIGENTE,
resuelto con la misma función que usa el sustrato (`project-context.stateDir()`):

- con `namespaced.enabled: false` → `.pipeline/` plano;
- con `namespaced.enabled: true` (que el orden de encendido de §3 exige) →
  `.pipeline/projects/<projectId>/`.

Antes el default era siempre el plano: con el namespaceado encendido, el
rollback escribía en el directorio equivocado y devolvía `[OK]` igual — un falso
verde en la única ruta de recuperación del cutover, que además re-creaba los
archivos obsoletos del layout plano. Para apuntar a un layout distinto del que
declara la config (por ejemplo, volver al plano después de apagar el
namespeceado) está el flag explícito:

```bash
# destino explícito (tiene que caer dentro de .pipeline/, si no se rechaza)
node .pipeline/lib/kernel-store-migrate.js --rollback --from .pipeline/backup/<ts> \
     --target-dir .pipeline

# comprobar a dónde va a escribir ANTES de correrlo
node -e "console.log(require('./.pipeline/lib/project-context').stateDir())"
```

El rollback toma el **lock** de cada archivo y escribe de forma atómica (tmp +
fsync + rename), igual que el pipeline en caliente: `.partial-pause.json` es el
archivo que controla el acceso al dispatch y un write a medias deja la allowlist
ilegible. Si el lock está tomado por un proceso vivo, **no escribe**: devuelve
`restore_locked`. Con el pipeline detenido y un lock stale, `--force` saltea el
lock (y sólo entonces).

Salida esperada (comparación visual, no interpretativa):

```
===== MIGRACIÓN ESTADO DE COORDINACIÓN [ROLLBACK] =====

--- BACKUP ---
[--] sin backup (rollback)

--- MIGRACIÓN ---
clave              | fuente                 | presente | registros | acción
waves              | waves.json             | sí       | 0         | ausente
partial-pause      | .partial-pause.json    | sí       | 0         | ausente

--- RESULTADO ---
[OK] estado restaurado desde el backup.
```

Códigos de error que frenan el paso:

| Código | Qué pasó | Qué hacer |
|---|---|---|
| `from_required` | Falta `--from`. | Pasá el directorio del backup. |
| `from_out_of_root` | El `--from` cae fuera de `.pipeline/backup/`. | Rechazado por path-traversal. Usá un backup real. |
| `from_not_found` | No existe ese `<timestamp>`. | `ls -1 .pipeline/backup/ \| tail -5`. |
| `manifest_unreadable` / `checksum_mismatch` | El backup perdió integridad. | **No restaura nada.** Elegí otro `<timestamp>`. |
| `unsafe_backup_entry` | El manifest trae una entrada fuera de la allowlist de fuentes. | **Descartá ese backup**: es sospechoso. |
| `state_dir_unresolved` | No se pudo resolver dónde vive el estado (contexto de proyecto inválido). | **No restaura nada**, a propósito: adivinar el layout plano es volver al defecto. Corregí el contexto o pasá `--target-dir` explícito. |
| `target_out_of_root` | El `--target-dir` cae fuera de `.pipeline/`. | Rechazado por path-traversal. |
| `target_unwritable` | No se pudo preparar el directorio destino. | Revisá permisos del `.pipeline/projects/<projectId>/`. |
| `restore_locked` | Otro proceso tiene el lock del archivo a restaurar. | Detené el pipeline y reintentá. Si el proceso que lo sostiene está muerto, repetí con `--force`. |

> **El rollback restaura los archivos, no el destino.** Después de restaurar hay
> que apagar el flag igual (§1.2): si el pipeline sigue en modo remoto, esos
> archivos no los lee nadie.

### 1.6 · Reanudar si el halt dejó el pipeline pausado

> **Éste es el paso que más se olvida, y el que deja el pipeline muerto en
> silencio.** Escenario real y cerrado: el store se cae con la ventana de
> cutover abierta → el sink aborta y escribe `.pipeline/.paused` → el operador
> hace exactamente lo que dice la alerta (apagar el flag + `restart.js`) →
> `describeMode()` devuelve `mode: fs`, que este runbook presenta como verde →
> **y el pipeline sigue sin despachar**, por un marker que nadie le nombró.

El marker del halt es deliberadamente **no auto-levantable**: `restart.js` no lo
borra (`isAutoLiftableSource` lo rechaza), justamente para que un cutover
abortado no desaparezca sin registro.

```bash
# 1) ¿Existe el halt, y de quién es?
cat .pipeline/.paused 2>/dev/null
#   → {"source":"kernel-cutover-degraded-halt","ts":"...","cause":"red",...}

# 2) Levantarlo (cualquiera de las dos):
#    · por Telegram:  /reanudar
#    · a mano:
rm .pipeline/.paused

# 3) Confirmar que el pipeline volvió a despachar
node -e "console.log(JSON.stringify(require('./.pipeline/lib/partial-pause').getPipelineMode()))"
#   → mode distinto de 'paused'
```

Si el `source` **no** es `kernel-cutover-degraded-halt`, había una pausa previa
de otro origen y el aborto no la pisó (la alerta lo dice explícitamente): no la
levantes sin revisar antes por qué estaba puesta.

### 1.5 · Lo escrito durante la ventana remota (y R8)

Apagar el flag no reintegra al filesystem lo que se escribió en el store. Si la
ventana duró lo suficiente como para que el pipeline avanzara olas o tocara la
allowlist, hay que **exportar antes de apagar**. El export está **scripteado**
(#7189, CA-5) y se niega a correr sin el freno puesto:

```bash
# 1) Freno (D-3): sin `.pipeline/.paused` el export NO corre — el pipeline seguiría
#    escribiendo en el store mientras exportás. Por Telegram `/pausar`, o a mano:
node -e "require('fs').writeFileSync('.pipeline/.paused', JSON.stringify({source:'manual', ts:new Date().toISOString(), reason:'export store→FS'}))"

# 2) Export (fija PIPELINE_OPSTATE_DURABLE=1 sólo en su propio proceso; no toca el config)
node .pipeline/scripts/opstate-cutover-probe.js --export-to-fs
# → [OK] lectura:waves · lectura:partial-pause · escritura:waves · escritura:partial-pause
# → R8 (tramo export) · olas: <n> · allowlist: <m> · avance perdido: 0
```

Lee las **dos** claves antes de escribir nada (nada queda a medias), escribe con
el write atómico del sustrato en `backend.fileFor(key)` —el path **namespaceado**
vigente (`project-context.stateDir()`), donde el modo filesystem va a leer— y
verifica releyendo cada archivo: `sha256Canonical(filesystem) === sha256Canonical(store)`.
Cualquier diferencia es `avance perdido > 0` y el veredicto es ROJO
(`export_hash_distinto`): **no reinicies** hasta resolverlo. Si el store no
tiene una clave (`estado_vacio`) o degrada (`lectura_degradada`) tampoco escribe.

> **Estado del ensayo (#7189, 2026-09-14):** el camino verde (freno puesto,
> estado sembrado, conteos correctos, sha256 FS = store, `avance perdido: 0`) y
> los negativos (sin `.paused` ⇒ `freno_ausente` sin leer el store; clave
> ausente ⇒ nada escrito) están ensayados **contra el driver fake** en
> `opstate-cutover-probe-7189.test.js`. Contra el host real sólo se corrió el
> rechazo sin freno (`docs/pipeline/evidence/7189/export-drill.txt`): el store
> está vacío hoy. El export contra el store real es parte del ensayo de rollback
> de **H0 (#7194)**.

**R8** es el tiempo desde que arranca el rollback hasta que el pipeline completa
una fase leyendo desde filesystem. Se registra en el issue del cutover **con los
conteos al lado**:

```
R8 = <minutos> min · olas en el registro: <n> · issues en la allowlist: <m> · avance perdido: 0
```

Un R8 sin conteos no sirve: no distingue "recuperé rápido" de "no había nada que
recuperar". El CA promete **minutos**; el tramo automatizado (apagar + reiniciar)
es de segundos, y el resto lo dominan el export de §1.5 y la primera fase completa.

---

## 2 · La migración del estado operativo

### 2.1 · Qué entra al alcance y qué no

| Fuente | Clave | ¿Migra? |
|---|---|---|
| `waves.json` | `coord#waves` | ✅ Sí |
| `.partial-pause.json` | `coord#partial-pause` | ✅ Sí (CA-A8) |
| `blocked-issues.json`, `blocked-by-infra.json`, `infra-health.json` | `coord#blocked`, `coord#blocked-by-infra`, `coord#health` | ❌ **No en este cutover.** Están en `SOURCES` del migrador, pero #5112 las excluye del alcance |
| `.paused` | — | ❌ **Nunca. Por diseño (D-3 / SEC-7)** |

> ### `.paused` queda FUERA, y no es una omisión
>
> `.paused` es el **halt de último recurso** y, a la vez, el **mecanismo de
> aborto de este mismo cutover** (§5). Si viviera en DynamoDB, una degradación
> del store dejaría al operador **sin freno justo en el peor momento**: el
> instante en que más falta hace pausar es exactamente el instante en que el
> store no responde.
>
> El invariante está cableado, no confiado a la memoria de nadie: `pauseFile()`
> no pasa por `operational-state-backend.js`, la clave no está en `KEYS` ni en
> `FILE_FOR_KEY`, no está en `SOURCES` del migrador ni en `DEFAULT_KNOWN_KEYS`
> del store de coordinación, y hay **tests negativos** que fallan si aparece en
> cualquiera de esos lugares.
>
> Corolario operativo: `.paused` **no se namespacea ni se externaliza**. Vive en
> `.pipeline/.paused`, es global, y tiene precedencia máxima.

### 2.2 · Backup y dry-run (siempre primero)

```bash
node .pipeline/lib/kernel-store-migrate.js      # dry-run: NO escribe en el store
```

El dry-run **sí** deja el backup: `.pipeline/backup/<timestamp>/` con su
`manifest.json`, permisos `0700` en el directorio y `0600` en los archivos, y el
`<timestamp>` derivado **internamente** (nunca de input del operador: es la
guarda anti path-traversal). La última línea del reporte imprime el comando de
rollback exacto para ese backup — copialo antes de seguir.

Verificar el backup es **recalcular** el checksum de cada archivo contra su
manifest, no mirar que el directorio exista:

```bash
node -e "
const fs=require('node:fs'), path=require('node:path');
const m=require('./.pipeline/lib/kernel-store-migrate');
const dir=process.argv[1];
const man=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
let ok=true;
for (const [file,meta] of Object.entries(man.files||{})) {
  if (!meta.present) continue;
  const val=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
  const got=m.sha256Canonical(val);
  const veredicto = got===meta.checksum ? 'OK' : 'MISMATCH';
  if (veredicto!=='OK') ok=false;
  console.log(file.padEnd(24), meta.checksum.slice(0,18), got.slice(0,18), veredicto);
}
console.log(ok ? '[OK] backup INTEGRO y restaurable.' : '[FALLA] backup CORRUPTO: no lo uses.');
" .pipeline/backup/<timestamp>
```

> **Ojo con la trampa.** No compares el backup contra el archivo **origen**: el
> estado es vivo y puede cambiar entre que lo respaldás y que lo verificás. Un
> mismatch ahí es el pipeline funcionando, no un backup roto. Lo que importa es
> que el backup sea **íntegro y restaurable**, y eso se prueba contra su propio
> manifest.

### 2.3 · El `--apply` del CLI está bloqueado: la migración va por API

```bash
node .pipeline/lib/kernel-store-migrate.js --apply
# → alcance_no_implementado: --apply no puede migrar nada todavía, así que no toca nada.
```

**No es un bug y no se destraba.** El guard de `--apply` es del cutover del
kernel (#5136 · D-4): el alcance de aquél (`descriptor#self`, `product#<id>`,
`catalog#index`, `signature#`, `audit#`, `claim#`) no tiene ruta de migración en
ese módulo, y lo único que el módulo sabe mover son las fuentes de coordinación,
que **#5112 prohíbe migrar en ese cutover**. El guard corta **antes** de tocar
filesystem o pedir credenciales.

Para **este** cutover la migración se invoca por API declarando el alcance de
forma explícita —que es el contrato de `migrateState`, con `sources_no_explicitas`
si no lo declarás—, acotado a las dos claves del estado operativo:

```bash
node -e "
const m=require('./.pipeline/lib/kernel-store-migrate');
const { createCoordinationStore } = require('./.pipeline/lib/kernel-coordination-store');
const { createAwsCliRunner, createAwsCliDynamoDriver } = require('./.pipeline/lib/provisioner-infra');
const { resolveRuntimeAwsEnv } = require('./.pipeline/lib/kernel-runtime-credentials');
const pc = require('./.pipeline/lib/project-context');
const cfg = require('./.pipeline/lib/config-resolver').resolve({ pipelineDir: '.pipeline' });

const creds = resolveRuntimeAwsEnv({ kernel: cfg.kernel });
if (!creds.ok) { console.log('[FALLA]', creds.code, creds.error); process.exit(1); }

const { run } = createAwsCliRunner(creds.env);
const driver = createAwsCliDynamoDriver({ run });          // <-- DRIVER REAL, no el default
const projectId = pc.currentProjectIdOrNull();
if (!projectId) { console.log('[FALLA] sin contexto de proyecto resuelto'); process.exit(1); }

const store = createCoordinationStore({
  driver, contextProjectId: projectId, config: cfg,
  knownKeys: m.MIGRATION_KNOWN_KEYS,
});

m.migrateState({
  apply: true,
  store,
  sourceDir: pc.stateDir(),                                 // <-- OJO: §2.4
  sources: m.SOURCES.filter(s => s.key === 'waves' || s.key === 'partial-pause'),
}).then(r => { console.log(r.report || r.error); process.exit(r.ok ? 0 : 1); });
"
```

> ⚠️ **Este comando no fue ejecutado todavía.** Cada pieza está verificada
> contra las firmas reales de los módulos, pero la corrida es parte del Bloque C
> y está pendiente. Corrélo **primero en dry-run** (`apply: false`, sin `store`)
> y recién después con `apply: true`, con el pipeline pausado y la ventana de
> cutover abierta.

### 2.4 · Trampa 1 — `sourceDir` con el namespaceado encendido

**Corregido en #5113 rev-12**, pero la verificación sigue valiendo. El
`sourceDir` por default del migrador ya **no** es `.pipeline/` plano: resuelve
por `project-context.stateDir()`, la misma función que usa el sustrato, así que
sigue al layout vigente (plano con el flag apagado, `.pipeline/projects/<id>/`
con el flag encendido). Lo que este párrafo describía era el riesgo real:

- las fuentes aparecían como `presente: no` y el resultado era `no_sources`, o
- peor, encontraba archivos viejos del layout plano y **migraba estado obsoleto**.

El snippet sigue pasando `sourceDir: pc.stateDir()` explícito — ser explícito en
un cutover no molesta — y la comprobación previa sigue siendo obligatoria:

```bash
node .pipeline/scripts/migrate-operational-state-namespace.js --status
node -e "console.log(require('./.pipeline/lib/project-context').stateDir())"
```

Los dos tienen que apuntar al mismo directorio, y `migrated` tiene que ser `true`.

### 2.5 · Trampa 2 — `createCoordinationStore` sin driver migra a la memoria

`createCoordinationStore({ ... })` **sin `driver`** cae a un driver **in-memory**
y la migración corre entera contra RAM: reporte en verde, paridad perfecta, y
**cero bytes en DynamoDB**. Es el falso verde más caro de este runbook.

Cómo confirmar que estás contra el driver real antes de aplicar:

```bash
node -e "
const { createAwsCliRunner, createAwsCliDynamoDriver } = require('./.pipeline/lib/provisioner-infra');
const { resolveRuntimeAwsEnv } = require('./.pipeline/lib/kernel-runtime-credentials');
const cfg = require('./.pipeline/lib/config-resolver').resolve({ pipelineDir: '.pipeline' });
const creds = resolveRuntimeAwsEnv({ kernel: cfg.kernel });
if (!creds.ok) { console.log('[FALLA]', creds.code); process.exit(1); }
const d = createAwsCliDynamoDriver({ run: createAwsCliRunner(creds.env).run });
console.log('driver.kind =', d.kind, '| tabla =', cfg.kernel.coordinationTableName);
"
# → driver.kind = aws-cli | tabla = <nombre-de-la-tabla-de-coordinación>
```

`driver.kind = in-memory` ⇒ **frená**: lo que estés por migrar no sale del proceso.

> **Dos `kind` válidos, no uno (precisión del PO en `validacion` de #7189,
> 2026-09-14).** El snippet de arriba arma el driver **async** (`aws-cli`). El
> backend del estado operativo (`operational-state-backend.resolveDriver()`) usa
> `createAwsCliDynamoDriverSync` ⇒ **`aws-cli-sync`** (`provisioner-infra.js`).
> Los dos son el cableado real; la sonda de #7189 acepta `aws-cli` **o**
> `aws-cli-sync` y rechaza `in-memory`, `fake-sync` y cualquier valor
> desconocido (`driver_no_aws_cli`). Un chequeo literal `kind === 'aws-cli'`
> daría **falso rojo** contra AWS real.

### 2.6 · Cómo se lee el reporte (y por qué `migrated_count: 0` no importa acá)

La paridad de **este** cutover es la sección
`--- VERIFICACIÓN (checksum sha256 canónico) ---`: el mismo SHA-256 canónico
antes (leído de las fuentes) y después (**releído del store**, no de lo que
creemos haber escrito) para las claves `waves` y `partial-pause`. Cualquier
discrepancia ⇒ `{ ok:false, code:'integrity_mismatch' }`, con el detalle de los
`mismatches` y sin lenguaje de éxito.

En cambio, la sección `--- ALCANCE DEL CUTOVER --- migrated_count: 0` es un
**diagnóstico del otro cutover** (el del kernel, #5208): cuenta descriptores y
productos, no claves de coordinación. Va a decir `0` aunque esta migración haya
salido perfecta, y el reporte va a imprimir el bloque `[DIAGNÓSTICO] … el
cutover NO migró ninguna entidad de su alcance`. **En el cutover del estado
operativo ese cero es esperado y no invalida nada** — lo que sí hay que exigir
es la sección de checksums en verde y, después, la sonda de §8.

Ante `integrity_mismatch`: **no apagues nada todavía y no reintentes a ciegas**.
El reporte trae el `ROLLBACK:` con el comando exacto para su backup; ese es el
próximo paso (§1.4), y después se investiga qué clave divergió.

### 2.7 · Idempotencia

La escritura al store es idempotente por clave (`coord#<key>`, conditional
write): re-correr la migración no duplica ni corrompe. Reintentar es la acción
correcta ante una falla de red a mitad de camino — lo que **no** es correcto es
reintentar ante `integrity_mismatch` sin haber entendido la discrepancia.

---

## 3 · Orden de encendido NO NEGOCIABLE (D-4 / CA-B5)

Los seis pasos van **en este orden**. El bloque `operational_state:` de
`.pipeline/config.yaml` lo declara igual; si algo de acá contradijera ese
comentario, manda el config.

| # | Paso | Verificación |
|---|---|---|
| 1 | `operational_state.namespaced.enabled: true` **y sonda de aislamiento en verde** | `node --test .pipeline/lib/__tests__/operational-state-isolation.test.js` + `migrate-operational-state-namespace.js --status` con `migrated: true` |
| 2 | **Cutover del kernel ensayado** (tablas, CMK, IAM y credenciales del runtime probadas en #5207/#5208/#5209) — **no** "`kernel.durable: true` obligatorio" (D-9) | `docs/pipeline/runbook-cutover-durable.md` §0 y §8. La sonda `--preconditions` **reporta** el valor efectivo de `kernel.durable` (hoy `false`: estado terminal del ensayo de rollback #5209, runbook durable §8.6) y no lo exige; re-encenderlo es trabajo aparte (runbook durable §1), fuera de #7189 y de H0 |
| 3 | **Migración** con backup y **paridad SHA-256 en verde** (§2) | sección de checksums del reporte, sin `integrity_mismatch` |
| 4 | **Sonda positiva NO VACÍA** por dos caminos disjuntos (§8) | reporte de la sonda + `get-item --consistent-read` |
| 5 | **Ensayo de rollback ejecutado** (§1) y **ensayo de aborto** (§5) | R8 medido con conteos + `.paused` escrito por el sink |
| 6 | **Recién ahí** `operational_state.durable: true` + reinicio | `describeMode()` ⇒ `{"mode":"remote","source":"config"}` |

**Por qué ese orden y no otro:**

- **Migrar con `namespaced.enabled: false` deja el estado en el store con layout
  plano y obliga a re-migrar.** El backend particiona por `projectId`
  (`PK = <projectId>`) y falla cerrado si no hay contexto resuelto: sin el
  namespaceado encendido y verificado, el `projectId` sale de un camino de
  compatibilidad (`single-project` / `host-fallback`) y lo que quede escrito en
  DynamoDB puede no coincidir con la partición que el runtime va a leer después.
- **Encender el flag antes de la sonda** convierte al pipeline productivo en el
  banco de pruebas: la primera lectura remota fallida no es un test, es una ola
  que deja de despachar.
- **Ensayar el rollback antes de necesitarlo** es lo único que convierte a §1 en
  un procedimiento y no en una promesa. Un rollback que se estrena en la
  emergencia no es un rollback.
- El paso 6 va último porque es el **único irreversible sin trabajo manual**: a
  partir de ahí, cada escritura que el pipeline haga vive sólo en el store hasta
  que alguien la exporte (§1.5).

---

## 4 · Precondiciones del Bloque B — verificadas por sonda, no por supuesto

Los cinco CA se verifican **ejecutando**, no leyendo el código. Desde #7189 los
cubre una sola sonda, idempotente y de sólo lectura, con exit ≠ 0 si alguna está
en rojo:

```bash
node .pipeline/scripts/opstate-cutover-probe.js --preconditions          # texto para el operador
node .pipeline/scripts/opstate-cutover-probe.js --preconditions --json   # evidencia redactada
```

Corrida contra el host real el 2026-09-14 (§10, `evidence/7189/preconditions.json`):
CA-B2 y CA-B3 **verdes**; CA-B1 y CA-B5 **rojos diagnóstico**. Cada `[FALLA]`
trae su causa (`strict_auth_apagado`, `namespaceado_apagado`, …) y el paso de
H0 que la pone en verde. Los comandos sueltos de abajo siguen valiendo para
mirar cada CA por separado.

### CA-B1 · `PARTIAL_PAUSE_STRICT_AUTH=1` activo

El gate de autoría de la allowlist (#3625) está en **grace mode** por default:
sin `authorizedBy` loguea un warning y **deja pasar**. En multi-instancia eso
significa que cualquier proceso con la credencial saca issues de la ola **sin
identidad** y el audit trail queda con un agujero.

```bash
node -e "console.log('strict:', process.env.PARTIAL_PAUSE_STRICT_AUTH === '1')"
grep -n "PARTIAL_PAUSE_STRICT_AUTH" .pipeline/lib/partial-pause.js
```

Tiene que estar `1` en el entorno del pipeline **antes** de la ventana. Con
`strict: false` ⇒ **no arranques el cutover**.

**Cómo se cierra (D-10, cerrada por el PO en `criterios` de #7189):**

- Se satisface con `PARTIAL_PAUSE_STRICT_AUTH=1` **en el entorno del servicio**
  (launcher / `restart.js`), leído desde el proceso del Pulpo — **no** desde una
  shell suelta (SEC-1). La sonda `--preconditions` lee el valor del entorno de
  **su propio** proceso y lo dice en el detalle: para que la evidencia sea la
  del servicio, correla desde el mismo entorno que lanza al Pulpo (o después de
  reiniciar con la variable exportada).
- La sonda además cuenta las entradas `gate_grace: true` de los **últimos 30
  días** en el audit local y da rojo si hay alguna (`gate_grace_reciente`): un
  removal sin autoría reciente es un caller sin migrar, no ruido. Estado al
  2026-09-14: 214 entradas, **0** `gate_grace` en 30 días (la última es del
  2026-08-13).
- **#5165 no es dependencia de #7189 ni de H0** (single-host); **sí lo es de H4**
  (#7198): la amenaza T-2 sólo se materializa con varios hosts.

### CA-B2 · `atomicUpdate === true` verificado por sonda EJECUTADA

Sin `atomicUpdate`, `buildCasWriteOptions()` devuelve `{}` y el CAS **desaparece
en silencio**: `compareAndSet` queda apoyado en la lectura previa monohilo, que
entre hosts no excluye nada, y `release` pierde la condición de ownership (la
instancia B puede liberar el claim de A). Es un `{}` que no rompe ningún test de
tipo y borra la garantía entera, así que **se afirma, no se deriva**.

```bash
node -e "
const c=require('./.pipeline/lib/kernel-coordination-store');
console.log('atomicUpdate=true  ->', JSON.stringify(c.buildCasWriteOptions(7, true)));
console.log('atomicUpdate=false ->', JSON.stringify(c.buildCasWriteOptions(7, false)), '<- CAS AUSENTE');
"
```

En el camino síncrono del estado operativo, `resolveDriver()` fija
`atomicUpdate: true` explícito (no lo deriva de `!isInMemory`). La sonda
`--preconditions` lo verifica sobre el driver **realmente resuelto** por el
backend (`_describeDriver()`: `kind`, `atomicUpdate`, tabla, partición — nunca
el driver en sí) y da rojo con `atomic_update_falso` o `driver_no_aws_cli`. La
sonda que cierra este CA contra AWS es la de §8.3: **dos escrituras con la misma
`expectedVersion`, la segunda rechazada por conflicto** — ejecutada en #7189
(`--cas-probe`, verde; §10).

### CA-B3 · Identidad efectiva del runtime

Si el runtime corriera con un perfil administrativo, **toda la policy de deny es
decorativa** y cualquier sonda posterior da verde sin probar nada.

```bash
aws sts get-caller-identity --profile <perfil-runtime>
# El último segmento del Arn debe ser EXACTAMENTE `kernel.runtimePrincipal` del config.

node -e "
const p=require('./.pipeline/lib/kernel-cutover-probe');
const cfg=require('./.pipeline/lib/config-resolver').resolve({ pipelineDir: '.pipeline' });
console.log(JSON.stringify(p.verifyRuntimeIdentity({
  expectedPrincipal: cfg.kernel.runtimePrincipal,
  profile: cfg.kernel.runtimeProfile,
})));
"
```

`identidad_inesperada` ⇒ **frená**. `runtime_principal_ausente` ⇒ falta declarar
`kernel.runtimePrincipal`: tampoco sigas.

> **`kernel.runtimeProfile` ≠ `kernel.runtimePrincipal`.** El *principal* es el
> nombre IAM contra el que se compara la identidad efectiva; el *profile* es el
> perfil local del que salen las claves. Y **no apuntes `runtimeProfile` al
> perfil administrativo** para destrabar un arranque.

### CA-B4 · Dónde vive el audit trail en multi-instancia

**Estado: definido, no externalizado (D-8, cerrada por el PO en `criterios` de
#7189).** El régimen vigente es **single-host**: el trail local con cadena de
hash es el audit trail del cutover, y se verifica con `verifyChain()` **antes y
después** de la ventana. La externalización a la tabla append-only de no-repudio
(SEC-3) es la hija **H2 (#7196)**, prerrequisito de H4 (#7198). **No se enciende
multi-host con trail particionado.**

Hoy el audit trail de mutaciones de allowlist es un JSONL **local, con cadena de
hash**:

```bash
node -e "console.log(require('./.pipeline/lib/partial-pause-audit')._paths().AUDIT_FILE)"
# → …/.pipeline/projects/<projectId>/audit/partial-pause-mutations.jsonl
```

Está **namespaceado por proyecto** (#5110), pero **no externalizado**: vive en el
filesystem del host que escribió. Consecuencia directa en régimen
multi-instancia: **una mutación hecha desde la instancia B no deja rastro en el
host A que la sufre.** El estado se comparte; su bitácora no.

Qué significa para la ventana de cutover, en concreto:

- Mientras el cutover corra **desde un solo host** (que es el modo previsto de
  §3), el audit trail sigue siendo completo y verificable con
  `partial-pause-audit.verifyChain()`.
- **El multi-instancia real (CA-C6) no se habilita hasta cerrar esto**: sería un
  audit log particionado por host, que no es un audit log.
- La externalización del trail **no está en el alcance de #5113 ni de #7189**
  (mueven registro de olas y allowlist, no la auditoría). Es **H2 (#7196)**:
  ítems `audit#` append-only vía `kernel-store.appendAuditEntry`, IAM por ARN
  explícito. Precondición explícita de H4, no detalle de implementación.

Verificación de integridad del trail local, antes y después de la ventana:

```bash
node -e "
const a=require('./.pipeline/lib/partial-pause-audit');
console.log(JSON.stringify(a.verifyChain()));
"
```

### CA-B5 · Namespaceado encendido y verificado ANTES de migrar

```bash
sed -n '/^operational_state:/,/^$/p' .pipeline/config.yaml | grep -E "enabled:|strict_context:"
node .pipeline/scripts/migrate-operational-state-namespace.js --status
node --test .pipeline/lib/__tests__/operational-state-isolation.test.js
```

Verde es `enabled: true`, `migrated: true` y el test de aislamiento en verde.
Con `migrated: false` y `enabled: true` estás en la peor combinación posible: el
runtime lee de `projects/<id>/` y el estado sigue en el layout plano.

La sonda `--preconditions` compara además el `stateDir` que reporta `--status`
con `project-context.stateDir()` y da rojo si difieren (`state_dir_divergente`,
trampa §2.4). Estado al 2026-09-14: `namespaceEnabled(): false`,
`migrated: false`, layout plano con `waves.json`, `.partial-pause.json`,
`archived/` y `audit/` ⇒ `namespaceado_apagado`. Es el **paso 1 de H0**.

> `strict_context` es un flag **aparte** y **no** es precondición de este
> cutover: se enciende recién con dos proyectos reales, después de #5164.
> Prenderlo antes deja el dashboard, los hooks y los skills sin estado operativo.

---

## 5 · Criterio de aborto durante la ventana (CA-C5)

**Ante degradación del store durante la ventana de cutover, el comportamiento es
abortar y pausar escribiendo `.pipeline/.paused`.**

Prohibido, y con motivo:

| Lo que NO se hace | Por qué |
|---|---|
| `process.exit` | Mata al proceso sin dejar el freno puesto: el watchdog lo respawnea y vuelve a intentar contra el store caído, en loop |
| `throw` que se propaga | Sube por un camino que alguien va a catchear más arriba, y el aborto se convierte en un log |
| Degradar a filesystem | Es la falla que este cutover existe para eliminar: **dos fuentes de verdad**. Una allowlist local stale no es un dato viejo, es **una autorización revocada que vuelve a estar vigente** (CA-A7 / SEC-6) |
| "Alertar y seguir" | Fuera de la ventana es aceptable (§6); **dentro** de la ventana es comparar filesystem contra filesystem mientras el write path escribe a DynamoDB |

Cómo queda cableado: `operational-state-backend.js` reporta la degradación con
`reportDegradation()`, que la clasifica y se la pasa al sink de
`kernel-degradation-alert.js`. Con `kernel.cutover_window: true`, ese sink está
en **fail-loud**: aborta suspendiendo el dispatch **escribiendo
`.pipeline/.paused`**. Con la ventana cerrada, el mismo sink es best-effort
(alerta fuerte, el pipeline sigue). Por eso **abrir la ventana es parte del
procedimiento**, no un detalle:

```bash
grep -n "cutover_window" .pipeline/config.yaml
#   cutover_window: true    ← durante el cutover
#   cutover_window: false   ← régimen normal
```

Sólo el booleano `true` exacto la abre (`"true"`, `1` o la clave ausente cuentan
como cerrada). **La ventana la abre y la cierra el mismo operador**, y el cierre
es parte del cutover, no limpieza posterior: dejarla abierta es un estado de
mantenimiento permanente que nadie mira.

### Cómo se verifica el aborto (ensayado en seco en #7189; en ventana real, H0)

El ensayo de CA-C5 se hace **provocando** la degradación, no esperándola. Desde
#7189 está scripteado con el **sink real** y un `halt` inyectado que escribe el
marker en un **sandbox temporal** (nunca en el `.pipeline/` real, nunca manda
Telegram):

```bash
node .pipeline/scripts/opstate-cutover-probe.js --abort-drill --window true
# → [OK] sin-throw · sin-exit · sin-fallback · ventana · sink-aborto · paused
# → paused: <sandbox>/.paused · {"source":"kernel-cutover-degraded-halt","cause":"red",...}

node .pipeline/scripts/opstate-cutover-probe.js --abort-drill --window '"true"'   # string
node .pipeline/scripts/opstate-cutover-probe.js --abort-drill --window 1          # número
node .pipeline/scripts/opstate-cutover-probe.js --abort-drill --window absent     # clave ausente
node .pipeline/scripts/opstate-cutover-probe.js --abort-drill                     # valor EFECTIVO del config
# → [FALLA] ventana · ventana CERRADA: cutover_window = "true" (string) — sólo el booleano true abre la ventana
# → [OK] sec-4 · .paused ausente (correcto)
```

El drill intercepta `process.exit` durante la corrida (si alguien lo llama, es
rojo `process_exit_llamado`), trata cualquier excepción como rojo
(`throw_propagado`) y exige `value: null` + `degraded: true` + `remote: true` en
la lectura (`fallback_a_filesystem` si el backend devolviera contenido). Con la
ventana cerrada reporta el literal **con su tipo** (SEC-4) y verifica que **no**
se escribió `.paused`. Evidencia: `docs/pipeline/evidence/7189/abort-drill.txt`.

El snippet manual de abajo cubre sólo el tramo del backend (sink inyectado, sin
marker); sigue siendo útil para aislar ese tramo:

```bash
node -e "
process.env.PIPELINE_OPSTATE_DURABLE='1';
const b=require('./.pipeline/lib/operational-state-backend');
let abortado=false;
b.setDegradationSink({ onDegraded: (err, ctx) => { abortado=true; console.log('sink:', ctx.stage, '|', String(err.message).slice(0,80)); } });
b._setDriverForTests({
  driver: { getItem(){ throw Object.assign(new Error('store caído (ensayo CA-C5)'), { name:'NetworkError' }); } },
  spec: {}, projectId: 'ensayo', instanceId: 'ensayo', atomicUpdate: true,
});
const r=b.readKeyWithVersion(b.KEYS.PARTIAL_PAUSE);
console.log('value:', r.value, '| degraded:', r.degraded, '| sink disparado:', abortado);
console.log('lastDegradation:', JSON.stringify(b.getLastDegradation()));
"
```

Verde es: `value: null`, `degraded: true`, sink disparado. Ese `null` es lo que
hace que el gate **deniegue**; si en cambio viera contenido, alguien reintrodujo
el fallback a filesystem.

Con el sink real y la ventana abierta, el mismo camino tiene que dejar el
`.pipeline/.paused` **en disco**. Esa es la evidencia del ensayo:

```bash
ls -la .pipeline/.paused && cat .pipeline/.paused
```

> **Lo que queda para H0:** el drill escribe el marker en un sandbox. El aborto
> **en la ventana real** —con `kernel.cutover_window: true` en el config, el sink
> cableado por el Pulpo y el `.pipeline/.paused` de verdad— es CA-C5b y lo
> ejecuta el operador en H0 (#7194). El drill en verde es la precondición para
> abrir esa ventana, no su reemplazo.

---

## 6 · Degradación fuera de la ventana — qué ve el operador

Con la ventana cerrada (régimen normal), una degradación del store **no tumba el
pipeline**: el gate deniega y el hecho se publica. Tres piezas, un solo hecho:

| Pieza | Qué hace |
|---|---|
| `readKey()` ⇒ `null` | `getPipelineMode()` cae en `mode: 'running'` e `isIssueAllowedInState` **deniega** (fail-closed post-#5060) |
| Causa de no-despacho `estado_remoto_degradado` | Entrada propia del enum de `dispatch-cause.js`, alertable y por encima de `modo_ola` en la precedencia. Sin ella, la degradación se le presenta al operador como `anomalia_no_determinable` — un misterio |
| `kernel-degradation-alert.js` | **Único** canal de aviso del hecho: template fijo, correlation id y rate-limit por causa. No se emite un `sendTelegram` nuevo para esto (CA-UX3) |
| Chip de procedencia en el header (CA-UX1) | `#hdr-opstate`, en la bandeja compartida por el home y los 10 satélites. Cuatro estados, símbolo + etiqueta: `#` filesystem local · `✓` externo · en línea · `~` cutover en curso · `!` externo · sin respuesta. Sale del flag **efectivo del runtime**, así que un override por `PIPELINE_OPSTATE_DURABLE` se muestra como `(forzado por env)` |

Diagnóstico rápido cuando el tablero muestra la causa:

```bash
node -e "
const b=require('./.pipeline/lib/operational-state-backend');
console.log(JSON.stringify(b.describeMode()));
console.log(JSON.stringify(b.getLastDegradation()));
"
```

`degraded: true` con `lastError` poblado ⇒ el store no responde o rechazó el
payload. **La acción correcta casi nunca es "reintentar el dispatch"**: es
decidir entre esperar al store o hacer el rollback de §1.

Antes de CA-UX1, un pipeline frenado a propósito se veía en el tablero
exactamente igual que uno frenado por un bug, y la única forma de distinguirlos
era este comando. Hoy el chip del header lo dice primero y el comando queda para
el detalle (`lastError`, `stage`, `at`): el operador no tiene que abrir una
terminal para saber **de dónde sale el estado que está mirando**.

---

## 7 · Qué NO es la verificación de este cutover

Tres trampas, las tres a un `grep` de distancia:

1. **`kernel-parity.js` no verifica nada de esto.** Es la paridad de la Ola 9.1:
   compara blobs de git entre un tag y un SHA. No lee el store, no conoce
   `operational_state.durable` y no toca DynamoDB. **No lo toques ni lo
   extiendas**: romperlo deja a 9.1 sin su prueba.
2. **`kernel-cutover-probe.js` es la sonda del otro cutover.** Verifica
   `descriptor#self`, `product#<id>` y `catalog#index`. Que dé verde no dice
   **nada** sobre `coord#waves` ni `coord#partial-pause`. Se reusan sus helpers
   (§8), no su veredicto.
3. **`migrated_count` no es una medida de paridad de este cutover** (§2.6). Es
   un diagnóstico del alcance del kernel y va a decir `0` siempre.

```bash
git diff --stat origin/main -- .pipeline/lib/kernel-parity.js .pipeline/lib/kernel-parity-92.js
# Salida esperada: VACÍA. Cualquier línea ⇒ revertí ese cambio antes de avanzar.
```

Y el chequeo que sí es de este cutover — **ningún lector físico suelto** fuera
del backend (CA-C1: un lector olvidado son dos fuentes de verdad).

> ⚠️ **Este grep tuvo dos agujeros y los dos dejaron pasar el defecto real del
> rebote rev-1.** Están cerrados; se documentan porque el próximo que audite
> esto va a escribir el grep de memoria y le va a salir el que fallaba.
>
> 1. **El alcance era `.pipeline/lib/*.js`.** Los lectores vivían en
>    `.pipeline/scripts/`. Corré sobre `.pipeline/` entero, recursivo.
> 2. **El path no siempre viene de un literal.** `scripts/init-waves-from-partial.js`
>    lo pedía con `require('../lib/waves')._paths().WAVES_FILE`: no hay ningún
>    `'waves.json'` que grepear, así que el control salía limpio mientras el
>    script leía **y escribía** el registro de olas en disco con el flag
>    encendido. Esa forma la cubre ahora la regla `paths-indirect` del guardrail
>    — el grep solo NO alcanza.

```bash
# 1 · lectores/escritores físicos por path del sustrato, TODO .pipeline/
FUERA_DE_SCOPE='__tests__|\.test\.js|/tests/|/test-|/tmp'   # tests + scratch: mismo scope que walkJs

grep -rnE "(readFileSync|writeFileSync|existsSync|unlinkSync)\(\s*(wavesFile|partialFile)\(\)"   .pipeline --include=*.js | grep -vE "$FUERA_DE_SCOPE"
# Salida esperada: sólo la línea de EJEMPLO comentada dentro de
# `lib/operational-state-lint.js` (documenta el anti-patrón). Cualquier línea de
# código real ⇒ hay una segunda fuente de verdad: no encender el flag.

# 2 · literales de estado dentro de una construcción de path
grep -rnE "['\"](waves\.json|\.partial-pause\.json)['\"]" .pipeline --include=*.js   | grep -vE "$FUERA_DE_SCOPE" | grep -E "path\.join|readFileSync|writeFileSync|existsSync"
# Salida esperada: SÓLO los dueños del path (lib/waves.js, lib/partial-pause.js).

# 3 · el control mecánico, que cubre lo que el grep no puede ver
node .pipeline/lib/operational-state-lint.js      # enforce: exit 0
```

Y la prueba que no depende de que el grep esté bien escrito — el boot completo
con el flag encendido, espiando `fs`:

```bash
node --test .pipeline/lib/__tests__/operational-state-boot-no-fs-5113.test.js
# `ensureWavesFile` + `initWavesFromPartial` + el alcance de ola del
# desync-detector: CERO contacto con waves.json / .partial-pause.json.
```

---

## 8 · Sondas — la evidencia que sí prueba algo (CA-C3)

**Una sonda que pasa sobre estado vacío no cuenta.** Es la mitad que siempre
falta: comparar cero contra cero da verde y no prueba absolutamente nada. Las
tres sondas de abajo exigen contenido, y la comparación se hace por **dos
caminos disjuntos**.

> **Estado (#7189, 2026-09-14):** 8.1 está scripteada (`--positive`) y **se
> ejecutó contra la tabla real: ROJO con causa `estado_vacio`** por los dos
> caminos, porque nada migró todavía — ésa es la evidencia de fail-closed sobre
> vacío que exige CA-3. 8.3 está scripteada (`--cas-probe`) y **verde contra AWS
> real**. Su verde en 8.1 y 8.2 contra el store real es de H0 (#7194).

### 8.1 · Sonda positiva no-vacía, por dos caminos disjuntos

Scripteada en #7189 (los comandos manuales de abajo siguen valiendo para mirar
cada camino por separado):

```bash
node .pipeline/scripts/opstate-cutover-probe.js --positive          # fija PIPELINE_OPSTATE_DURABLE=1 sólo en su proceso
node .pipeline/scripts/opstate-cutover-probe.js --positive --json   # evidencia
# verde ⇔ por CADA clave: A (backend) y B (get-item --consistent-read) con contenido NO vacío
#         (olas > 0, allowlist > 0), body.version entero ≥ 1 y sha256Canonical idéntico.
# causas: estado_vacio · hash_distinto_por_camino · version_invalida · item_ausente_camino_b ·
#         clave_distinta · lectura_degradada · driver_no_aws_cli (kind ∉ {aws-cli, aws-cli-sync})
```

Camino A — la **API del driver** (el mismo cableado que usa el runtime):

```bash
node -e "
process.env.PIPELINE_OPSTATE_DURABLE='1';
const b=require('./.pipeline/lib/operational-state-backend');
for (const key of [b.KEYS.WAVES, b.KEYS.PARTIAL_PAUSE]) {
  const r=b.readKeyWithVersion(key);
  const n = r.value ? Object.keys(r.value).length : 0;
  console.log(key.padEnd(15), '| remoto:', r.remote, '| version:', r.version, '| claves:', n, '| degradado:', r.degraded);
}
"
```

Camino B — **`aws dynamodb get-item --consistent-read`**, por afuera del driver:

```bash
aws dynamodb get-item \
  --table-name <tabla-de-coordinación> \
  --region <región> \
  --key '{"PK":{"S":"<projectId>"},"SK":{"S":"coord#waves"}}' \
  --consistent-read --output json --profile <perfil-runtime>

aws dynamodb get-item \
  --table-name <tabla-de-coordinación> \
  --region <región> \
  --key '{"PK":{"S":"<projectId>"},"SK":{"S":"coord#partial-pause"}}' \
  --consistent-read --output json --profile <perfil-runtime>
```

La comparación se cierra con el SHA-256 canónico del `body.value` de cada lado
—el mismo `sha256Canonical` del migrador—, no "a ojo". Criterio de verde:

- `body.value` **no vacío** en las dos claves (0 olas y allowlist vacía **no**
  cierran la sonda: no distinguen "migró" de "no había nada");
- `PK` = el `projectId` esperado y `SK` = `coord#waves` / `coord#partial-pause`;
- `body.version` entero ≥ 1;
- SHA-256 idéntico por los dos caminos.

> **`ItemCount` NO sirve como evidencia.** DynamoDB lo actualiza cada ~6 horas:
> `describe-table` puede informar `ItemCount: 0` con ítems ya escritos. La única
> lectura concluyente es `get-item --consistent-read`.

### 8.2 · Sonda negativa cross-tenant (aislamiento)

El estado remoto está particionado por `projectId` (CA-B5). Un ítem de otra
partición **debe** ser rechazado, no leído:

```bash
aws dynamodb get-item \
  --table-name <tabla-de-coordinación> --region <región> \
  --key '{"PK":{"S":"<projectId-ajeno>"},"SK":{"S":"coord#waves"}}' \
  --consistent-read --output json --profile <perfil-runtime>
# Esperado: sin `Item` (la partición ajena está vacía).
```

Y el rechazo por validación, que es el que importa: `validateCoordinationRawItem`
descarta un ítem cuyo `projectId` no coincide con el contexto. La sonda es que
`readKeyWithVersion` devuelva `value: null` **y** `degraded: true` en ese caso.

### 8.3 · Sonda del CAS (cierra CA-B2 y CA-A4)

Dos escrituras con la **misma** `expectedVersion`: la segunda tiene que volver
con `{ ok:false, conflict:true }`, no aplicarse en silencio.

```bash
node --test .pipeline/lib/__tests__/operational-state-backend-5113.test.js
node --test .pipeline/lib/__tests__/operational-state-concurrency.test.js
```

Los tests prueban la **semántica**; la sonda contra AWS prueba que el
`ConditionExpression` viaja de verdad. Las dos, no una: un test verde con
`atomicUpdate: false` pasaría igual y el CAS no existiría.

La sonda contra AWS está scripteada y **ejecutada en #7189** (§10):

```bash
node .pipeline/scripts/opstate-cutover-probe.js --cas-probe [--json]
# identidad (SEC-2) → driver.kind ∈ {aws-cli, aws-cli-sync} → buildCasWriteOptions no vacío →
# 1ª compareAndSet(expectedVersion = v) ok, v+1 → 2ª con la MISMA v ⇒ conflict:true →
# readback get-item --consistent-read: versión v+1 y sha256 de la 1ª escritura.
```

Escribe **una** clave de sonda (`coord#opstate-cas-probe`) por `compareAndSet`
—nunca `put-item` a mano (SEC-9), nunca `coord#waves` / `coord#partial-pause`—
y es idempotente: cada corrida parte de la versión vigente. Sin coincidencia de
identidad no escribe nada.

#### Y el CAS del CAMINO REAL, que es otra cosa

Los dos de arriba prueban que el backend hace CAS **cuando alguien le pasa
`expectedVersion` a mano**. No prueban que los mutadores se lo pasen — y esa es
la mitad que se puede tener rota con esos tests en verde: un `writeKey` sin
`expectedVersion` no es "un write sin CAS", es un write **efectivamente
incondicional**, porque el backend rellena el hueco con la versión que él mismo
relee un instante antes del `putItem`.

Los dos estados operativos tienen su propia suite sobre el camino real de
mutación (dos instancias con carpetas locales distintas ⇒ lockfiles distintos ⇒
dos hosts, contra el mismo store), cada una con el caso negativo que falla si el
`putItem` sale con la versión releída:

```bash
node --test .pipeline/lib/__tests__/partial-pause-allowlist-cas-5113.test.js
node --test .pipeline/lib/__tests__/waves-registro-cas-5113.test.js
```

Ninguna de las dos es opcional: CA-A4 dice "allowlist **y** registro de olas".

### 8.4 · Regresión mínima antes de encender

```bash
node --test .pipeline/lib/__tests__/operational-state*.test.js
node --test .pipeline/lib/__tests__/partial-pause*.test.js
node --test .pipeline/lib/__tests__/waves*.test.js
node --test .pipeline/lib/__tests__/kernel-store-migrate.test.js
node --test .pipeline/lib/__tests__/kernel-coordination-store.test.js
node .pipeline/lib/operational-state-lint.js --check
```

Todo verde **sin editar un solo test**. Editar un test de regresión para que pase
es exactamente el modo de falla que estos controles existen para detectar.

---

## 9 · Multi-instancia (CA-C6) — el límite conocido

El valor entero de esta historia es el pipeline distribuido, y hay **dos cosas
que hoy no están**:

1. **El singleton se resuelve por nombre de proceso en el SO local**
   (`commandLine.includes('pulpo.js')`). Dos pulpos en la misma máquina no
   coexisten aunque tengan estado distinto: el segundo aborta antes de tocar
   nada. La prueba de CA-C6 **necesita dos hosts**, o mover el singleton a un
   lease del coordination store por `(projectId, host)`.
2. **El audit trail sigue siendo local por host** (CA-B4, §4). Un trail
   particionado por host no es un trail.

**No se acepta** degradar CA-C6 a "dos procesos escritores con `fork`": eso ya lo
cubre el test de concurrencia, valida el CAS y **no** valida el multi-instancia.

Hasta cerrar los dos puntos, el cutover se opera **desde un solo host**. Eso no
invalida el resto del cutover —el estado ya vive afuera, que es la precondición—
pero sí impide declarar el multi-instancia como entregado.

**Decisión D-6 (PO, `criterios` de #7189, 2026-09-11) y cómo se reparte:**

Hay un tercer punto que ninguno de los dos anteriores cubre, verificado en
`main` y en la rama de #5113: el dispatch del Pulpo **no reclama trabajo por
lease** (`grep -c '\.claim(' .pipeline/pulpo.js` ⇒ `0`), y las colas de fase
(`pendiente/`, `trabajando/`, `listo/`) son filesystem local que no migra. Dos
hosts compartirían registro de olas y allowlist, pero cada uno haría **su propio
intake desde GitHub** ⇒ dispatch duplicado **por diseño**, no por bug. Ni (a)
dos hosts reales ni (b) singleton por lease prueban "se lo lleva una sola" sin
código nuevo. Por eso CA-C6 **sale de #7189 y de H0** y se acepta en una hija de
ejecución con tres hijas de código por delante:

| Hija | Issue | Qué cierra | Depende de |
|---|---|---|---|
| **H1** · lease de dispatch por issue | #7195 | `claim('dispatch#<issue>', { owner, leaseMs })` / `release` en el punto de intake/dispatch del Pulpo, sobre la primitiva que ya existe (`kernel-coordination-store.claim` / `release`) | #5113 |
| **H2** · audit trail de allowlist append-only (SEC-3) | #7196 | externaliza el trail de CA-B4 a ítems `audit#` vía `kernel-store.appendAuditEntry`, IAM por ARN explícito | #5113 |
| **H3** · halt compartido entre instancias (SEC-5) | #7197 | que `.paused` de una instancia frene a las demás | #5113 |
| **H4** · ensayo multi-instancia en dos hosts (CA-C6) | #7198 | la prueba real de "se lo lleva una sola", con audit y halt compartidos | #7194 (H0), #7195, #7196, #7197, #5165 |

La opción (b) "singleton por lease `(projectId, host)`" **no reemplaza** a H1: es
opcional y la decide el planner. **No se acepta** degradar a `fork`. Hasta H4,
"multi-instancia" **no está entregado** y este runbook no lo afirma.

---

## 10 · Ensayo en seco (#7189) — evidencia y lo que queda para H0

**Fecha:** 2026-09-14 · **Rama:** `agent/7189-pipeline-dev` sobre
`origin/main @ fe48aefe0` · **Flag:** `operational_state.durable: false` (no se
tocó `config.yaml`; `git diff --stat origin/main -- .pipeline/config.yaml` ⇒
vacío) · **Identidad:** `kernel.runtimePrincipal` con el perfil
`kernel.runtimeProfile` · **Herramienta:** `.pipeline/scripts/opstate-cutover-probe.js`
· **Evidencia completa:** `docs/pipeline/evidence/7189/` (README con el índice).

Regla del ensayo, heredada de D-7: el agente corre **todo lo idempotente y de
sólo lectura** (sondas, tests, dry-run, backup, sonda del CAS, export y aborto
contra fake/sandbox); **el operador** corre en H0 (#7194) los flips, la
migración `apply`, los reinicios, CA-C9b, CA-C4 (R8) y CA-C5b. Todo output de
esta sección pasó por `redactAll` (secretos + account-ids), y el chequeo
`grep -nE "[0-9]{12}|arn:aws[:]|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}"` sobre la
evidencia y este archivo es **vacío** (`evidence/7189/redaction-check.txt`).

Formato de conteos, único en todo el ensayo: `olas: n · allowlist: m` (+ `· avance perdido: k` donde aplica).

### 10.0 · Identidad del runtime (SEC-2, paso 0 de todo)

```
$ node .pipeline/scripts/opstate-cutover-probe.js --preconditions
[OK]    CA-B3 · identidad efectiva = `kernel.runtimePrincipal` — principal efectivo: intrale-kernel-runtime (coincide con config)
```

Todas las corridas contra AWS de esta sección (CAS, sonda positiva) verifican la
identidad **antes** de tocar nada y abortan con `identidad_inesperada` si el
principal efectivo no es el declarado. No se corrió nada con un perfil administrativo.

### 10.1 · CA-1 — Sonda de precondiciones (`evidence/7189/preconditions.json`)

```
$ node .pipeline/scripts/opstate-cutover-probe.js --preconditions --pipeline-dir <host>/.pipeline
naturaleza: sonda de sólo lectura — segura de re-ejecutar

[FALLA] CA-B1 · PARTIAL_PAUSE_STRICT_AUTH=1 + sin `gate_grace` en 30 días — strict: false (leído del entorno de ESTE proceso: ausente) · gate_grace en 30 días: 0 (audit: 214 entradas, último gate_grace 2026-08-13T18:16:22.173Z)
        causa: strict_auth_apagado
        → H0 paso 0 · exportá PARTIAL_PAUSE_STRICT_AUTH=1 en el entorno del SERVICIO (launcher / restart.js) y reiniciá (D-10)
[OK]    CA-B2 · `atomicUpdate === true` en el driver real + `buildCasWriteOptions` no vacío — buildCasWriteOptions(7,true): "#b.#v = :ev" · driver: kind=aws-cli-sync atomicUpdate=true tabla=intrale-kernel-coordination partición=intrale-platform
[OK]    CA-B3 · identidad efectiva = `kernel.runtimePrincipal` — principal efectivo: intrale-kernel-runtime (coincide con config)
[FALLA] CA-B5 · namespaceado encendido + `--status` ⇒ migrated:true + stateDir coincidente — namespaceEnabled(): false · --status: migrated=false stateDir=<host>/.pipeline/projects/intrale-platform · project-context.stateDir(): <host>/.pipeline
        causa: namespaceado_apagado
        → H0 paso 1 · encendé `operational_state.namespaced.enabled: true` y corré `migrate-operational-state-namespace.js` (D-4 / CA-B5)
[OK]    D-9 · valor efectivo de `kernel.durable` (se reporta, no se exige) (informativo) — kernel.durable = false (boolean)
[OK]    modo · `describeMode()` del backend (informativo) — mode: fs · source: config · degraded: false · observed: false

VEREDICTO: ROJO — 2 en rojo (CA-B1, CA-B5) · causas: strict_auth_apagado, namespaceado_apagado.      exit=1
```

**Lectura:** el rojo es **diagnóstico, no falso verde** —exactamente lo que
CA-1 anticipaba para hoy (`migrated: false`, layout plano) más el grace mode de
CA-B1. Los dos son pasos de H0. `describeMode()` devuelve el literal `mode: fs`
(el texto de CA-9 dice "filesystem": es el mismo estado, el token del backend es
`fs`).

### 10.2 · CA-2 — Sonda del CAS contra AWS real (`evidence/7189/cas-probe.json`)

```
$ node .pipeline/scripts/opstate-cutover-probe.js --cas-probe --pipeline-dir <host>/.pipeline
naturaleza: escribe UNA clave de sonda (coord#opstate-cas-probe) por compareAndSet — idempotente

[OK]    identidad · principal efectivo = `kernel.runtimePrincipal` (SEC-2) — principal efectivo: intrale-kernel-runtime
[OK]    driver · driver.kind ∈ {aws-cli, aws-cli-sync} — kind=aws-cli-sync · credenciales: perfil AWS "kernel-runtime"
[OK]    cas-options · `buildCasWriteOptions(1, true)` no vacío — "#b.#v = :ev"
[OK]    cas-1 · 1ª escritura con expectedVersion=1 — ok · versión 1 → 2
[OK]    cas-2 · 2ª escritura con la MISMA expectedVersion=1 ⇒ conflict:true — rechazada como corresponde · conflict:true · versión vigente 2
[OK]    readback · lectura consistente cruda coincide con la 1ª escritura (versión + sha256) — PK=intrale-platform SK=coord#opstate-cas-probe body.version=2

VEREDICTO: VERDE — 6 verificación(es) en verde.      exit=0
```

La primera corrida del día creó la clave (`v0 → v1`, conflicto sobre `0`); la
de la evidencia partió de `v1`: la sonda es idempotente y cada corrida vuelve a
demostrar el conflicto. La clave queda en la tabla (ítem chico; purga manual
excepcional según `kernel-tablas-cutover-5210.md`, nunca desde la sonda).

### 10.3 · CA-3 — Sonda positiva por dos caminos (`evidence/7189/positive-probe.json`)

```
$ node .pipeline/scripts/opstate-cutover-probe.js --positive --pipeline-dir <host>/.pipeline
naturaleza: sonda de sólo lectura — backend con PIPELINE_OPSTATE_DURABLE=1 en este proceso vs `get-item --consistent-read`

[OK]    driver · driver del backend ∈ {aws-cli, aws-cli-sync} — kind=aws-cli-sync tabla=intrale-kernel-coordination partición=intrale-platform
[FALLA] A:waves · camino A · backend.readKeyWithVersion('waves') — remote=true degraded=false version=null (null) olas=0     causa: estado_vacio
[FALLA] B:waves · camino B · get-item --consistent-read coord#waves — ítem AUSENTE (sin `Item` en la respuesta)                causa: estado_vacio
[FALLA] A:partial-pause · camino A · backend.readKeyWithVersion('partial-pause') — remote=true degraded=false version=null allowlist=0   causa: estado_vacio
[FALLA] B:partial-pause · camino B · get-item --consistent-read coord#partial-pause — ítem AUSENTE                             causa: estado_vacio

conteos: olas: 0 · allowlist: 0
VEREDICTO: ROJO — 4 en rojo · causas: estado_vacio.      exit=1
```

**Lectura:** ningún camino da verde leyendo vacío: es el fail-closed sobre vacío
que CA-3 exige demostrar contra la tabla real (como #5208 §8 con la partición
vacía). El verde con estado sembrado y los negativos (hash distinto por camino
⇒ `hash_distinto_por_camino`; `driver.kind === 'in-memory'` ⇒ `driver_no_aws_cli`
sin leer nada; degradación ⇒ `lectura_degradada`; 0 olas / allowlist vacía ⇒
`estado_vacio`) están en la suite contra el fake.

### 10.4 · CA-4 — Migración en seco (`evidence/7189/migration-dry-run.txt`)

```
$ node .pipeline/scripts/opstate-cutover-probe.js --migration-dry-run --pipeline-dir <host>/.pipeline
[OK]    fuentes · waves.json: presente (olas 12, 7 claves top-level) · .partial-pause.json: presente (allowlist 54, 3 claves top-level)
[OK]    dry-run · migrateState({ apply:false }) — ok · backup en <host>/.pipeline/backup/2026-09-14T03-15-59-072Z
[OK]    backup · backup coincide con su propio manifest.json (sha256 + conteo por archivo)
conteos: olas: 12 · allowlist: 54
VEREDICTO: VERDE      exit=0
```

`apply` **no se ejecutó contra AWS** (D-4: con el namespaceado apagado migraría
al layout plano, trampa §2.4). `migrateState({ apply: true, store })` está
probado contra el driver fake en la suite: paridad SHA-256 + conteo, segunda
pasada `noop` (idempotencia) y un store que miente ⇒ `integrity_mismatch` con el
comando de rollback en el resultado.

### 10.5 · CA-5 — Export store→FS (`evidence/7189/export-drill.txt`)

Contra el host real, sin freno: `[FALLA] freno · AUSENTE (marker_ausente)` ⇒
`freno_ausente`, **antes** de leer el store, con el comando exacto para frenar.
Contra el fake con `.paused` presente y estado sembrado: dos lecturas, dos
escrituras atómicas en `stateDir()`, `sha256(filesystem) = sha256(store)` en
ambas, y `R8 (tramo export) · olas: 2 · allowlist: 3 · avance perdido: 0`. Los
minutos del R8 los mide el operador en H0.

### 10.6 · CA-6 — Ensayo de aborto (`evidence/7189/abort-drill.txt`)

```
$ node .pipeline/scripts/opstate-cutover-probe.js --abort-drill --window true
[OK]    sin-throw · sin-exit · sin-fallback (value=null degraded=true remote=true)
[OK]    ventana · cutover_window = true (boolean)
[OK]    sink-aborto · aborted=true causas=["red"]
[OK]    paused · <sandbox>/.paused · {"source":"kernel-cutover-degraded-halt","cause":"red","correlationId":"kdeg-drill-…"}
VEREDICTO: VERDE      exit=0

$ node .pipeline/scripts/opstate-cutover-probe.js --abort-drill --window '"true"'   (ídem con 1, absent y el config efectivo = false)
[FALLA] ventana · ventana CERRADA: cutover_window = "true" (string) — sólo el booleano true abre la ventana     causa: ventana_cerrada
[OK]    sec-4 · .paused ausente (correcto) · sink.aborted=false
VEREDICTO: ROJO      exit=1
```

### 10.7 · CA-7 — Tests y regresión (`evidence/7189/tests.txt`, `tests-final.txt`)

- `node --test .pipeline/lib/__tests__/opstate-cutover-probe-7189.test.js` ⇒ **62/62**: caso verde de cada subcomando + un test por cada causa `[FALLA]` de la sonda.
- Regresión §8.4 **sin editar un solo test existente**: `operational-state*` 263/263 · `partial-pause*` 169/169 · `waves*` 167/167 · `kernel-store-migrate` 47/47 · `kernel-coordination-store` 34/34.
- `node .pipeline/lib/operational-state-lint.js --check` ⇒ 0 violaciones (una entry nueva en la allowlist, anclada al único literal `.paused` de la sonda: el marker del **sandbox** del drill; el freno real se consulta por `readFullPauseOrigin()`).
- Redacción: grep vacío sobre `evidence/7189/*` y este runbook.

### 10.8 · Qué queda para H0 (#7194) — operador, un comando por paso

Placeholders como en `runbook-cutover-durable.md`: `<perfil-runtime>` = `kernel.runtimeProfile`,
`<projectId>` = partición del contexto (hoy `intrale-platform`). Todo con el
pipeline **pausado** (`/pausar`) salvo donde se indica.

| # | Paso | Comando exacto | Verde esperado | Evidencia a pegar | Quién |
|---|---|---|---|---|---|
| 0 | `PARTIAL_PAUSE_STRICT_AUTH=1` en el entorno del **servicio** y reinicio (D-10) | exportar la variable en el launcher / `restart.js` → `node .pipeline/restart.js` (PowerShell) → `node .pipeline/scripts/opstate-cutover-probe.js --preconditions` desde ese entorno | `[OK] CA-B1 … strict: true · gate_grace en 30 días: 0` | salida de `--preconditions --json` | operador |
| 1 | Namespaceado ON + layout migrado (D-4 / CA-B5) | `operational_state.namespaced.enabled: true` (commit a `main`, no sólo local: el respawn hace `reset --hard`) → `node .pipeline/scripts/migrate-operational-state-namespace.js --dry-run` → sin `--dry-run` → `--status` → `node .pipeline/scripts/opstate-cutover-probe.js --preconditions` | `--status` ⇒ `migrated: true`; sonda ⇒ `[OK] CA-B5` y **VEREDICTO: VERDE** (exit 0) | `--status` + `--preconditions --json` | operador |
| 2 | Cutover del kernel **ensayado** (D-9) | nada que encender acá: la sonda ya reporta `kernel.durable = false (boolean)`; si se decide re-encenderlo, es runbook durable §1, fuera de H0 | `D-9` informativo en la sonda | — | operador (decisión) |
| 3 | Dry-run + backup, y recién ahí `apply` por API (§2.3) | `node .pipeline/scripts/opstate-cutover-probe.js --migration-dry-run` → `node -e` de §2.3 con `migrateState({ apply:true, store, sourceDir: pc.stateDir(), sources: SOURCES.filter(waves\|partial-pause) })` con `driver.kind` verificado (§2.5) | dry-run VERDE con `olas: n · allowlist: m`; `apply` ⇒ `ok:true`, `actions: created/created`, sin `integrity_mismatch` | reporte del migrador (backup dir + checksums) | operador |
| 4 | Sonda positiva por dos caminos (CA-C3) | `node .pipeline/scripts/opstate-cutover-probe.js --positive --json` | **VEREDICTO: VERDE**: `A:*`, `B:*` y `A=B:*` en verde para `waves` y `partial-pause`, conteos = los del paso 3 | `positive-probe.json` de H0 | operador |
| 5 | Ventana abierta + drill en la ventana real (CA-C5b) | `kernel.cutover_window: true` → `node .pipeline/restart.js` → provocar degradación según §5 (o `--abort-drill` como control previo) | `.pipeline/.paused` escrito con `source: kernel-cutover-degraded-halt`, alerta Telegram con `PIPELINE PAUSADO`; después `/reanudar` (§1.6) | `cat .pipeline/.paused` + captura de la alerta | operador |
| 6 | Encendido: `operational_state.durable: true` + reinicio (paso 6 de §3) | editar config (commit) → `node .pipeline/restart.js` → `node -e "console.log(JSON.stringify(require('./.pipeline/lib/operational-state-backend').describeMode()))"` | `{"mode":"remote","source":"config","degraded":false,...}`; chip del dashboard en `store durable` | `describeMode()` + captura del chip | operador |
| 7 | CA-C9b: una fase completa despachada leyendo del store | operar normal una fase (issue chico de la ola) con `PIPELINE_OPSTATE_DURABLE` **sin** override | fase en `procesado/` con `describeMode().observed: true` y `degraded: false` | log del Pulpo + `describeMode()` | operador |
| 8 | Ensayo de rollback con R8 medido (CA-C4) | `/pausar` → `node .pipeline/scripts/opstate-cutover-probe.js --export-to-fs` → `operational_state.durable: false` → `node .pipeline/restart.js` → `/reanudar` → una fase completa desde filesystem | export VERDE con `avance perdido: 0`; `describeMode()` ⇒ `mode: fs`; **`R8 = <min> min · olas: n · allowlist: m · avance perdido: 0`** | línea R8 en el issue + salida del export | operador |
| 9 | Cerrar la ventana | `kernel.cutover_window: false` (commit) → reinicio → `grep -n "cutover_window" .pipeline/config.yaml` | `cutover_window: false` | diff del config | operador |
| 10 | Cierre de H0 | marcar Bloques B y C como ✅ **Ejecutado** en §0 con la fecha y pegar la evidencia redactada en una `§11` de este runbook | `grep -nE "[0-9]{12}\|arn:aws[:]\|AKIA[0-9A-Z]{16}\|ASIA[0-9A-Z]{16}"` vacío | PR de H0 | operador |

**Fuera de H0, a propósito:** multi-instancia (CA-C6 → H4 #7198, con H1 #7195,
H2 #7196, H3 #7197 y #5165 por delante, D-6); externalizar el audit trail (H2);
re-encender `kernel.durable` (D-9).

---

## Si algo sale mal

### "Encendí el flag y el pipeline dejó de despachar"

Mirá primero si es fail-closed a propósito:

```bash
node -e "
const b=require('./.pipeline/lib/operational-state-backend');
console.log(JSON.stringify(b.describeMode()), JSON.stringify(b.getLastDegradation()));
"
```

`degraded: true` ⇒ el store no responde o rechazó el payload: es la denegación
esperada (§6), no un bug. Decidí entre esperar o rollback (§1). `degraded: false`
con el estado vacío ⇒ la migración no dejó contenido: andá a §8.1.

### "Falta `kernel.coordinationTableName`"

```
operational-state-backend: falta `kernel.coordinationTableName` en .pipeline/config.yaml.
Es requerido para el driver real (fail-closed): sin esa clave el estado operativo
remoto no tiene destino.
```

Es el fail-closed correcto. **No inventes un nombre de tabla**: si la tabla no
está aprovisionada, el cutover no arranca (CA-0 del runbook del kernel).

### "Credenciales AWS del runtime no resueltas"

`createAwsCliRunner` exige **claves estáticas** en el env: `AWS_PROFILE` **no le
sirve**. `kernel-runtime-credentials.js` las resuelve en tres pasos (env → `aws
configure get` sobre `kernel.runtimeProfile` → error como dato). Si falla:

```bash
node -e "
const cfg=require('./.pipeline/lib/config-resolver').resolve({ pipelineDir: '.pipeline' });
const r=require('./.pipeline/lib/kernel-runtime-credentials').resolveRuntimeAwsEnv({ kernel: cfg.kernel });
console.log(r.ok ? ('[OK] source=' + r.source) : ('[FALLA] ' + r.code + ': ' + r.error));
"
```

`runtime_profile_ausente` ⇒ declará `kernel.runtimeProfile`. **Nunca lo apuntes
al perfil administrativo** para destrabar: el kernel dejaría de operar con
least-privilege y los `Deny` de la policy no se probarían nunca.

### "Corrí `--apply` y me dijo `alcance_no_implementado`"

Es el comportamiento correcto (§2.3). El `--apply` del CLI está bloqueado a
propósito y **no se destraba pasándole `SOURCES`**: eso migraría las 4 fuentes de
coordinación que #5112 prohíbe. La migración del estado operativo va por API con
`sources` acotadas a `waves` y `partial-pause`.

### "El migrador dice `no_sources`"

Estás leyendo el directorio equivocado (§2.4). Con el namespaceado encendido, el
estado vive en `.pipeline/projects/<projectId>/`; pasá `sourceDir: pc.stateDir()`.

### "La migración dio verde pero DynamoDB está vacío"

Migraste contra el driver **in-memory** (§2.5). Verificá `driver.kind` y repetí.

### "`integrity_mismatch`"

**No apagues nada todavía y no reintentes a ciegas.** El reporte trae el comando
`ROLLBACK:` de su propio backup: usalo (§1.4) y después investigá qué clave
divergió. El migrador ya se negó a aprobar en silencio; forzarlo es peor.

### "El estado quedó a mitad y no sé qué se escribió"

A diferencia del cutover del kernel, acá **no hay append-only**: los ítems
`coord#*` son mutables y la migración es idempotente por clave. El camino seguro
es (1) pausar con `.paused`, (2) leer las dos claves por §8.1, (3) decidir entre
re-migrar o rollback. **No borres ítems a mano** con `aws dynamodb delete-item`:
salteás el CAS y la próxima escritura conflictúa contra una versión que ya no
existe.

### "El Pulpo alertó `Integridad de waves.json comprometida` al bootear"

Antes de tratarlo como tampering, descartá la causa benigna conocida: un registro
de olas **sellado antes del fix de rev-9**. Hasta ese fix, `waves.js` computaba el
`integrity_hash` sobre el estado **sin redactar** y la capa de storage aplicaba la
redacción de campos libres (`source`, `note`, `justification`, `reason`, `detail`)
**después**, al escribir. Si alguno de esos campos tenía forma de secreto, lo
persistido dejaba de ser lo hasheado y `checkStateIntegrity()` devolvía `mismatch`
sobre un estado que nadie había tocado.

Cómo distinguir una cosa de la otra:

```bash
# 1. ¿Hay campos redactados en el estado vigente?
node -e "console.log(JSON.stringify(require('./.pipeline/lib/operational-state-backend').readKey('waves')))" | grep -o "\[REDACTED[^\"]*\]" | sort -u
# 2. ¿Qué dice el chequeo hoy?
node -e "console.log(JSON.stringify(require('./.pipeline/lib/waves').checkStateIntegrity()))"
```

- **Hay `[REDACTED]` + `mismatch`** ⇒ es el desfase de sello descrito arriba. El
  estado es sano: la **primera escritura** del registro de olas posterior al fix
  lo re-sella sobre el payload ya redactado y el `mismatch` desaparece. No hace
  falta restaurar desde `archived/`.
- **No hay ningún `[REDACTED]` y aun así `mismatch`** ⇒ tratalo como alteración
  fuera del flujo: pausá, compará contra el último backup de `archived/` y
  escalá. Esa es la señal que el control de #4370 está para dar.

Desde rev-9 la redacción corre **antes** del sello (misma función que usa la capa
de storage, aplicada in-place), así que lo hasheado y lo escrito coinciden en los
dos sustratos y este falso positivo no se vuelve a generar.

### Cómo verificar que el pipeline volvió a un estado sano

```bash
sed -n '/^operational_state:/,/^$/p' .pipeline/config.yaml | grep "durable:"
node -e "console.log(JSON.stringify(require('./.pipeline/lib/operational-state-backend').describeMode()))"
ls -la .pipeline/.paused 2>/dev/null || echo "sin halt total"
```

Salida esperada — switch apagado, modo `fs`, sin halt:

```
  durable: false
{"mode":"fs","source":"config","degraded":false,"lastError":null}
sin halt total
```

---

## Referencias

- **#5113** — esta historia: backend del estado operativo, flag único, migración, rollback y este runbook (CA-C8).
- **#5107** — épico de la Ola 9.4 · E2. Cadena `#5108 → #5109 → #5110 → #5113`.
- **#5110** — namespaceado por `projectId`. Precondición de D-4 / CA-B5.
- **#7189** — ensayo en seco del cutover (sondas, dry-run, export, aborto) con el flag apagado; §10 y `docs/pipeline/evidence/7189/`.
- **#7194 (H0)** — ejecución supervisada del cutover, con gate humano (flips, `apply`, R8, aborto en ventana real). **#7195 (H1)** lease de dispatch · **#7196 (H2)** audit trail append-only · **#7197 (H3)** halt compartido · **#7198 (H4)** ensayo multi-instancia (CA-C6).
- **#5165** — salida del grace mode del gate de autoría. Con D-10: no es dependencia de #7189 ni de H0 (single-host); sí de H4.
- **#5119** — procedencia del estado y sus degradaciones en el dashboard (CA-UX1).
- **#5116** — hash de integridad de la allowlist efectiva.
- `docs/pipeline/runbook-cutover-durable.md` — cutover del kernel (`kernel.durable`). Prerrequisito y espejo estructural de este documento.
- `docs/pipeline/contrato-estado-operativo.md` — contrato de la fachada; §12 es la dimensión de aislamiento por `projectId`.
- `docs/pipeline/externalizacion-estado-operativo-remoto.md` · `docs/pipeline/spike-estado-remoto-hallazgos.md` — base documental del cutover.
- `docs/pipeline/kernel-iam-policy.md` — policy IAM del kernel y separación de identidades.
- `.pipeline/lib/operational-state-backend.js` — la capa de storage: flag único, claves, CAS, degradación.
- `.pipeline/lib/kernel-coordination-store.js` — `skFor`, envelope, `buildCasWriteOptions`, `DEFAULT_KNOWN_KEYS`.
- `.pipeline/lib/kernel-store-migrate.js` — migración, backup, paridad SHA-256, `rollbackState`.
- `.pipeline/scripts/migrate-operational-state-namespace.js` — migración del layout local al namespaceado (#5110).
- `.pipeline/scripts/opstate-cutover-probe.js` — sondas del cutover del estado operativo (#7189): `--preconditions`, `--cas-probe`, `--positive`, `--migration-dry-run`, `--export-to-fs`, `--abort-drill`.
- `.pipeline/lib/kernel-degradation-alert.js` — sink de degradación y aborto con `.paused`.
