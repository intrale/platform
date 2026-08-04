# Runbook — Cutover al store durable del kernel

> **Para el operador que está por encender `kernel.durable`, o que ya lo encendió
> y algo se rompió.** Este documento se lee **antes** de tocar nada, y empieza por
> cómo volver atrás porque eso es lo que hace falta cuando el cutover sale mal.
>
> Historia que lo crea: #5136 (split de #5125 ← #5112 ← #5107 · Ola 9.4 · E2).

## 0 · Antes de empezar

### Qué cubre y qué no

Cubre el **encendido del store durable del kernel** (`kernel.durable: false → true`
en `.pipeline/config.yaml`) y su vuelta atrás: qué respaldar antes, en qué orden
avanzar, qué reconciliar después y cómo desandar cada paso.

**No** cubre el aprovisionamiento de las tablas de DynamoDB ni la ejecución del
cutover en sí: eso es #5126 (Bloque B). Este runbook lo **prescribe**; #5126 lo
**ejecuta**. No hay circularidad: si estás leyendo esto para ejecutar el cutover,
la fuente de los pasos operativos es este archivo, y el issue que los corre es #5126.

**Cero datos reales.** Este archivo vive en git. Todo lo que parezca un
identificador de cuenta, un nombre de tabla o un ARN está escrito como
`<placeholder>` y **se resuelve en el momento**, nunca se commitea.

### Léxico único

Un concepto, un identificador literal, un término en criollo. Sin sinónimos.

| Identificador literal | En criollo | Qué es |
|---|---|---|
| `kernel.durable` | *el switch durable* | Flag de `.pipeline/config.yaml` que enciende el store durable. Default `false`. |
| `kernel.cutover_window` | *la ventana de cutover* | Clave que declara la ventana de mantenimiento del cutover. **Todavía no existe** (la crea #5135). |
| `kernel.tableName` | *la tabla de no-repudio* | Tabla con `descriptor#self`, `product#<id>`, `catalog#index`, `signature#` y `audit#`. |
| `kernel.coordinationTableName` | *la tabla de coordinación* | Segunda tabla, donde viven los `claim#` desde #5124. Es la única que admite `DeleteItem`. |
| `descriptor#self` | *el descriptor propio* | SK fija: **uno solo por partición de proyecto**. Vive en la **partición del tenant**. |
| `product#<id>` | *el producto* | Uno por producto registrado. Relación **1:N** con los archivos de `.pipeline/descriptors/`. Vive en la **partición del control-plane**. |
| `catalog#index` | *el índice del catálogo* | SK fija y única. Vive en la **partición del control-plane**. |
| `kernel-control-plane` | *la partición del control-plane* | PK reservada del kernel (no es un tenant). Ahí viven `product#<id>` y `catalog#index`: es **la única partición que enumera el boot**. |
| `durableRegisterProduct` | *el poblador* | Función de `.pipeline/lib/project-bootstrap.js` (#4821). Es lo único que puebla descriptores y catálogo. |
| *fuentes de coordinación* | — | Los 4 JSON operativos: `waves.json`, `blocked-issues.json`, `blocked-by-infra.json`, `infra-health.json`. |

> **Ojo con el falso amigo.** El migrador `kernel-store-migrate.js` sabe mover las
> **fuentes de coordinación**, que son exactamente las que #5112 **prohíbe migrar**
> en el cutover. El **alcance real** del cutover (`descriptor#self`, `product#<id>`,
> `catalog#index`) lo puebla `durableRegisterProduct`, no el migrador. Por eso
> `node .pipeline/lib/kernel-store-migrate.js --apply` está bloqueado y falla
> siempre con `alcance_no_implementado`. Es a propósito.

### Cómo verificar que estás parado donde creés

Antes de leer una línea más, confirmá en qué estado está el switch durable y si
ya existe algún backup:

```bash
grep -n "durable:" .pipeline/config.yaml
ls -1 .pipeline/backup/ 2>/dev/null | tail -3 || echo "SIN BACKUPS"
```

Salida esperada **antes** del cutover — el switch apagado y, si nunca corriste el
dry-run, ningún backup todavía:

```
  durable: false     # default OFF -- todo sigue en FS, cero llamadas AWS
SIN BACKUPS
```

Si `durable:` ya dice `true`, **no estás antes del cutover: estás en el medio de
uno**. Saltá directo a §1 (rollback) antes de tocar cualquier otra cosa.

---

## 1 · Rollback primero — cómo volver atrás

Antes de encender nada, tenés que saber que podés apagarlo. Y tenés que saber que
**los artefactos de backup son dos, separados, y restaurar uno NO restaura el otro.**

### Qué restaura el comando automático y qué queda manual

| Qué | Cómo se restaura | ¿Automático? |
|---|---|---|
| Las 4 **fuentes de coordinación** (`waves.json`, `blocked-issues.json`, `blocked-by-infra.json`, `infra-health.json`) | `kernel-store-migrate.js --rollback --from <dir>` | ✅ Sí, un comando |
| Los **descriptores** de `.pipeline/descriptors/` (origen de `product#<id>`) | Helper `restoreDescriptors()` — artefacto y manifest **distintos** | ⚠️ Sí, pero es **otro** comando |
| `kernel.durable` de vuelta en `false` | Edición manual de `.pipeline/config.yaml` + `node .pipeline/restart.js` | ❌ **Manual** |
| Ítems ya escritos en la **tabla de no-repudio** (`signature#`, `audit#`) | **No se borran nunca** — son append-only por diseño | ❌ **Manual**, por reconciliación (§2) |
| Ítems de la **tabla de coordinación** (`claim#`) | Se vencen solos por lease, o `release()` | ❌ **Manual** |

> **Sin esta tabla, esta sección mentiría por omisión.** El rollback automático
> cubre archivos locales. **No deshace escrituras ya hechas al store durable.**

### Los dos backups se toman ANTES, con el mismo instante

```bash
# 1) Backup de las fuentes de coordinación (lo hace solo el dry-run del migrador).
node .pipeline/lib/kernel-store-migrate.js
# → deja .pipeline/backup/<timestamp>/ con manifest.json

# 2) Backup de los descriptores — artefacto PROPIO, manifest PROPIO.
node -e "const m=require('./.pipeline/lib/kernel-store-migrate');
         const r=m.backupDescriptors({});
         console.log(r.ok ? r.dir : r.error);"
# → deja .pipeline/backup/<timestamp>/descriptors/ con SU manifest.json
```

Los dos artefactos conviven bajo el mismo `<timestamp>`: el de descriptores vive
un nivel **abajo**, en su propio subdirectorio, así que nunca se pisan.

### Cómo verificar el rollback de las fuentes de coordinación

```bash
node .pipeline/lib/kernel-store-migrate.js --rollback --from .pipeline/backup/<timestamp>
```

Salida esperada (comparación visual, no interpretativa):

```
===== MIGRACIÓN ESTADO DE COORDINACIÓN [ROLLBACK] =====

--- BACKUP ---
[OK] backup en: .pipeline/backup/<timestamp>

--- MIGRACIÓN ---
clave              | fuente                 | presente | registros | acción
waves              | waves.json             | sí       | 0         | ausente
blocked            | blocked-issues.json    | sí       | 0         | ausente
blocked-by-infra   | blocked-by-infra.json  | sí       | 0         | ausente
health             | infra-health.json      | sí       | 0         | ausente

--- RESULTADO ---
[OK] estado restaurado desde el backup.
```

Si en vez de eso ves `backup_corrupt`, **frená**: el backup no coincide con su
checksum y el comando **no restauró nada** (es fail-closed a propósito). Elegí
otro `<timestamp>`. Si ves `from_out_of_root`, el `--from` que pasaste cae fuera
de `.pipeline/backup/` y se rechazó por path-traversal.

### Cómo verificar el rollback de los descriptores

Es **otro comando**. Correr el de arriba y suponer que los descriptores volvieron
es el error más caro de esta sección.

```bash
node -e "const m=require('./.pipeline/lib/kernel-store-migrate');
         const r=m.restoreDescriptors({ fromDir:'.pipeline/backup/<timestamp>/descriptors' });
         console.log(JSON.stringify(r,null,2));"
```

Salida esperada:

```json
{
  "ok": true,
  "restored": [
    "intrale-platform.json"
  ],
  "fromDir": "<ruta-absoluta>/.pipeline/backup/<timestamp>/descriptors",
  "targetDir": "<ruta-absoluta>/.pipeline/descriptors"
}
```

`"ok": false` con `descriptors_backup_corrupt` significa que **no se restauró
ninguno** (valida todo antes de escribir algo). Con `unsafe_descriptor_entry`, el
manifest traía una entrada fuera del conjunto cerrado de nombres: **descartá ese
backup**, es sospechoso.

---

## 2 · Reconciliación de firmas (`signature#`) y auditoría (`audit#`)

Los ítems `signature#` y `audit#` de la **tabla de no-repudio** son **append-only**.
El rollback no los borra, y no debe. Si el cutover se abortó a mitad de camino,
lo que queda no es "estado sucio a limpiar" sino **evidencia a reconciliar**.

Este es el procedimiento que **#5126 ejecuta** (CA-B6). Acá se prescribe:

1. **Congelá la ventana.** No dejes que entren firmas nuevas mientras reconciliás
   (ver §5).
2. **Listá lo escrito durante la ventana**, acotando por el instante de apertura
   del cutover, no por "todo".
3. **Cruzá contra el registro local** de lo que el pipeline creía haber firmado.
4. **Clasificá cada divergencia** en una de tres, y sólo tres:
   - *escrita y conocida* → nada que hacer;
   - *escrita y desconocida localmente* → **no la borres**; anotala en el issue
     del cutover con su `signatureId` y seguí;
   - *conocida localmente y no escrita* → se re-firma después de encender, no durante.
5. **Dejá el resultado por escrito** en el issue del cutover antes de avanzar al
   bloque siguiente. Una reconciliación que no quedó escrita no ocurrió.

> **Nunca** intentes "limpiar" la tabla de no-repudio con un borrado masivo. La
> policy IAM no concede `DeleteItem` sobre esa tabla justamente para que esto no
> sea posible (#5124 · `docs/pipeline/kernel-iam-policy.md`).

### Cómo verificar la reconciliación de `signature#` y `audit#`

```bash
gh issue view <issue-del-cutover> --json comments \
  --jq '[.comments[] | select(.body | test("reconciliaci"))] | length'
```

Salida esperada — al menos un comentario de reconciliación registrado:

```
1
```

Si devuelve `0`, la reconciliación **no está documentada**: no avances al bloque
siguiente hasta que lo esté.

---

## 3 · Clave de cifrado del store: CMK de KMS, no clave AWS-owned

**Decisión: se usa una CMK de KMS.** No una clave AWS-owned. No es preferencia
estética, y el motivo va escrito porque es el que sostiene el resto del runbook:

- Una clave **AWS-owned no tiene key policy** → no hay dónde declarar quién
  puede descifrar.
- **No registra uso en CloudTrail** → §2 se queda sin ancla de auditoría: no
  podés demostrar quién leyó qué durante la ventana.
- **No se puede deshabilitar** → el rollback se queda **sin kill-switch
  criptográfico**. Si perdés control del acceso, con una AWS-owned no tenés
  ninguna palanca; con una CMK deshabilitás la clave y todo el store queda ilegible
  en un solo movimiento.

Controles mínimos, no negociables:

- **Principals explícitos en la key policy. NUNCA `"*"`.** Ni en `Principal` ni
  como comodín efectivo.
- **`kms:ViaService` restringido a DynamoDB** de la región del store
  (`dynamodb.<region>.amazonaws.com`), para que la clave no sirva desde otro servicio.
- **Rotación anual habilitada.**
- **CloudTrail sobre `Decrypt` y `GenerateDataKey`**, que son las dos operaciones
  que delatan uso real de la clave.

### Cómo verificar que la clave es una CMK y no una AWS-owned

```bash
aws kms describe-key --key-id <alias-o-id-de-la-cmk> \
  --query 'KeyMetadata.{Manager:KeyManager,State:KeyState,Rotation:MultiRegion}'
```

Salida esperada:

```json
{
    "Manager": "CUSTOMER",
    "State": "Enabled",
    "Rotation": false
}
```

`"Manager": "AWS"` significa que estás mirando una clave **AWS-owned/AWS-managed**:
**frená el cutover** y creá la CMK antes de seguir.

### Cómo verificar la key policy y el rastro en CloudTrail

```bash
aws kms get-key-policy --key-id <alias-o-id-de-la-cmk> --policy-name default \
  --output text | grep -c '"Principal": *{ *"AWS": *"\*"'
aws kms get-key-rotation-status --key-id <alias-o-id-de-la-cmk>
```

Salida esperada:

```
0
{
    "KeyRotationEnabled": true
}
```

El `0` es el que importa: **cero principals comodín**. Cualquier número mayor a
cero es un bloqueante duro del cutover. Si `KeyRotationEnabled` es `false`,
habilitá la rotación antes de avanzar.

---

## 4 · Orden de bloques: CA-0 → Bloque A → Bloque B

El orden **no es negociable**, y cada bloque tiene una puerta de salida:

1. **CA-0** — precondiciones de infraestructura. Las tablas existen, la CMK existe
   (§3), la policy IAM está aplicada. Sin CA-0, el Bloque B no arranca.
2. **Bloque A** — **código, sin AWS** (#5124, ya mergeado). Sacar los `claim#` de
   la tabla de no-repudio y arreglar el reclamo de lease. Puerta de salida: el
   código de Bloque A tiene que estar **mergeado en el `main` que vas a poner en
   producción**, no sólo "hecho".
3. **Bloque B** — **cutover, requiere CA-0** (#5126, abierto). Provisionar, migrar,
   verificar paridad, encender `kernel.durable` y ensayar el rollback.

> **Prohibido tocar `kernel.durable` antes de que Bloque A esté mergeado.** Es el
> orden que fijó el `po` en #5112 y no admite atajos: con el claim viejo todavía
> vivo, el primer agente que muera con un claim tomado deja esa fase trabada para
> siempre (ver `docs/pipeline/kernel-iam-policy.md`).

### Cómo verificar el orden de bloques antes de avanzar

```bash
git log --oneline -1 origin/main
grep -n "coordinationTableName" .pipeline/config.yaml
```

Salida esperada — el `main` contiene Bloque A y la clave de la tabla de
coordinación ya está declarada:

```
<sha-corto> [Split de #5112] Bloque A (1/2): sacar los claims de la particion de no-repudio y arreglar el reclamo de lease (#5153)
  coordinationTableName: ""   # requerido para el driver real (fail-closed sin ella)
```

Si el `grep` no devuelve nada, Bloque A **no está** en ese `main`: **frená el
cutover** y mergeá #5124 antes de seguir.

---

## 5 · La ventana de cutover: `kernel.cutover_window`

**Quién abre:** el operador que ejecuta #5126, y **sólo** él. La apertura se
anuncia en el issue del cutover antes de tocar nada.
**Quién cierra:** el **mismo** operador, después de que §2 quedó documentada. No
se delega el cierre.

**Qué pasa si queda abierta:** el pipeline sigue tratando el estado como si
estuviera en mantenimiento — la degradación durable no se reporta como falla y
las escrituras siguen entrando sin el gate de la ventana. En criollo: **la ventana
abierta es un falso verde permanente.** Cerrarla es parte del cutover, no una
tarea de limpieza posterior.

> ⚠️ **`kernel.cutover_window` todavía NO existe en `.pipeline/config.yaml`.** La
> crea la historia hermana **#5135**, que está abierta.
>
> **Qué hacer mientras tanto —** mientras #5135 no esté mergeada:
> 1. **Frená el cutover en este paso.** No hay ventana que abrir, así que no hay
>    forma de declarar mantenimiento ni de detectar que quedó abierta.
> 2. **Escalá a #5135** dejando comentario en el issue del cutover con el `sha` de
>    `main` que verificaste. No improvises la clave a mano: dos historias tocando
>    `.pipeline/config.yaml` es conflicto garantizado, y **está prohibido
>    implementarla desde acá**.

### Cómo verificar si `kernel.cutover_window` quedó abierta

Esta pregunta se responde con un comando, no con un párrafo:

```bash
grep -n "cutover_window" .pipeline/config.yaml || echo "AUSENTE"
```

Salida esperada **hoy** (#5135 todavía no mergeada — la clave no existe):

```
AUSENTE
```

Salida esperada **una vez que #5135 mergee, con la ventana CERRADA**:

```
  cutover_window: false
```

Salida que exige acción — **la ventana quedó ABIERTA**:

```
  cutover_window: true
```

Si ves `true`, cerrala (ponela en `false`) y corré `node .pipeline/restart.js`.
Si ves `AUSENTE` y estabas por ejecutar el cutover, aplicá el "qué hacer mientras
tanto" de arriba.

---

## 6 · Qué NO es el gancho de verificación del cutover

**`kernel-parity.js` no verifica este cutover.** Es la trampa más fácil de este
runbook, porque buscar "paridad" en el repo lleva derecho ahí.

`.pipeline/lib/kernel-parity.js` es la verificación de paridad **de la Ola 9.1**
(#4665): compara **blobs de git** entre el tag `pre-ola9-migracion` y un SHA
congelado. **No lee el store, no conoce `kernel.durable` y no toca DynamoDB.** Que
dé verde no dice absolutamente nada sobre el cutover durable.

**No lo toques.** No lo extiendas, no lo "adaptes" para que también mire el store:
es un verificador de otra ola y romperlo deja a 9.1 sin su prueba.

La verificación real del cutover es la de §2 (reconciliación) más la paridad
funcional que ejecuta #5126.

### Cómo verificar que `kernel-parity.js` no fue tocado

```bash
git diff --stat origin/main -- .pipeline/lib/kernel-parity.js .pipeline/lib/kernel-parity-92.js
```

Salida esperada — **vacía**, sin una sola línea:

```
```

Cualquier línea de salida significa que el diff del cutover tocó un verificador de
otra ola: **revertí ese cambio** antes de avanzar.

---

## 7 · Decisión de CA-A1 — resuelta en #5124

CA-A1 preguntaba cómo acotar los permisos de `claim#` cuando IAM no sabe scopear
por prefijo de **sort key**. **La decisión está tomada y mergeada** (#5124,
cerrado): **Opción B′-1 — separación por `Resource`.**

- Los `claim#` se mudaron a la **tabla de coordinación** (`kernel.coordinationTableName`).
- La **tabla de no-repudio** dejó de contener `claim#`, así que el `Deny` sobre
  ella ya **no necesita `Condition`** — y un `Deny` sin condición no puede volver
  a quedar inerte por un cambio de schema.
- **Descartada** la PK dedicada (`<projectId>#coord`): el contrato de datos no
  admite `#` en la PK y habría costado el chequeo anti-IDOR.

La justificación completa está en `docs/pipeline/kernel-iam-policy.md`
(§ "Qué cambió en #5124"). **No la repliques acá ni la reinterpretes**: si alguna
vez divergen, manda ese documento.

> **Qué hacer si el `main` que vas a poner en producción NO contiene #5124 —**
> **frená el cutover en este paso** y mergeá Bloque A primero (§4 tiene el comando
> que lo verifica). Encender `kernel.durable` sin #5124 reintroduce el claim roto,
> que traba fases de forma permanente.

### Cómo verificar el estado de la decisión de CA-A1

```bash
grep -c "Opción B′-1" docs/pipeline/kernel-iam-policy.md
```

Salida esperada — la decisión está documentada:

```
1
```

Si devuelve `0`, estás en un checkout que no tiene #5124: no avances (§4).

---

## Si algo sale mal

### "Corrí `--apply` y me dijo `alcance_no_implementado`"

Es el comportamiento correcto, no un bug. `--apply` está **bloqueado a propósito**
(#5136 · D-4): el alcance real del cutover no tiene ruta de migración en ese módulo,
y lo único que ese migrador sabe mover son las **fuentes de coordinación**, que
#5112 prohíbe migrar. **No lo "destrabes" pasando `SOURCES`**: eso migraría
exactamente las 4 fuentes prohibidas. Los descriptores y el catálogo los puebla
`durableRegisterProduct`.

### "Restauré el backup pero los descriptores siguen rotos"

Restauraste **un** artefacto. Son **dos**. Corré también el `restoreDescriptors()`
de §1 — la tabla del principio dice exactamente qué cubre cada uno.

### "El cutover quedó a mitad y no sé qué se escribió"

No borres nada de la tabla de no-repudio. Andá a §2 y reconciliá: `signature#` y
`audit#` son append-only, y lo que quedó es evidencia, no basura.

### "Encendí `kernel.durable` y el pipeline no arranca"

Ponelo en `false`, corré `node .pipeline/restart.js` y recién ahí diagnosticá. El
switch durable es lo primero que se apaga, siempre. Si el error menciona
`coordinationTableName`, te falta CA-0 (§4): la segunda tabla no está aprovisionada
y el store de coordinación falla fail-closed al primer claim.

### Cómo verificar que el pipeline volvió a un estado sano

```bash
grep -n "durable:" .pipeline/config.yaml
node .pipeline/lib/kernel-store-migrate.js --rollback --from .pipeline/backup/<timestamp> \
  | tail -2
```

Salida esperada — el switch durable apagado y el rollback confirmado:

```
  durable: false     # default OFF -- todo sigue en FS, cero llamadas AWS
[OK] estado restaurado desde el backup.
```

Si `durable:` sigue en `true`, el pipeline **no** volvió atrás todavía.

---

## Referencias

- **#5136** — esta historia: alcance del migrador, backup de descriptores y este runbook.
- **#5135** — hermana: sink fail-loud de degradación durable y `kernel.cutover_window`. **Abierta.**
- **#5126** — Bloque B: provisionar, migrar, verificar paridad, encender durable y ensayar el rollback. **Abierta.**
- **#5124** — Bloque A: los `claim#` fuera de la partición de no-repudio. **Cerrada y mergeada.**
- **#5112 / #5107** — historia madre y épico de la Ola 9.4 (E2).
- `docs/pipeline/kernel-iam-policy.md` — decisión de CA-A1 y policy IAM del kernel.
- `docs/pipeline/ola-puente-kernel-multiproducto.md` — diseño del kernel multi-producto y modos del migrador.
- `docs/pipeline/spike-estado-remoto-hallazgos.md` — §2/§3/§4/§5.3, base documental del cutover.
- `docs/runbooks/credential-rotation.md` — formato de referencia de este runbook.
- `.pipeline/lib/kernel-store-migrate.js` — migrador, `backupDescriptors()` y `restoreDescriptors()`.
- `.pipeline/lib/project-bootstrap.js` — `durableRegisterProduct`, el poblador real (#4821).
