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

**No** cubre el aprovisionamiento de las tablas de DynamoDB: eso lo hizo #5207.
La **ejecución** del cutover la hizo #5208, y su procedimiento con evidencia
redactada está en **§8** de este mismo archivo. No hay circularidad: los pasos
operativos se prescriben acá (§1 a §7) y §8 registra la corrida real que los
siguió.

**Cero datos reales.** Este archivo vive en git. Todo lo que parezca un
identificador de cuenta, un nombre de tabla o un ARN está escrito como
`<placeholder>` y **se resuelve en el momento**, nunca se commitea.

### Léxico único

Un concepto, un identificador literal, un término en criollo. Sin sinónimos.

| Identificador literal | En criollo | Qué es |
|---|---|---|
| `kernel.durable` | *el switch durable* | Flag de `.pipeline/config.yaml` que enciende el store durable. Default `false`. |
| `kernel.cutover_window` | *la ventana de cutover* | Clave de `.pipeline/config.yaml` que declara la ventana de mantenimiento del cutover. **Existe** (la creó #5135). Default `false`; sólo el booleano `true` exacto la abre. |
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
| Ítems ya escritos en la **tabla de no-repudio** (`signature#`, `audit#`) | **No se borran nunca** — son append-only por diseño. Se **reintegran** al filesystem con `node .pipeline/kernel-reconcile.js --apply --frozen` (§2) | ✅ Sí, un comando (#5209) — pero **no borra** de DynamoDB, copia |
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

> **#5209 — esto dejó de ser manual.** Hasta acá el procedimiento se ejecutaba a
> ojo, cruzando listados contra "lo que el pipeline creía haber firmado". Eso no
> es verificable y falla del peor modo posible: en silencio. Ahora hay un comando
> que exporta, reintegra y **prueba con conteos y SHA-256** que ningún registro
> quedó únicamente en DynamoDB — y que se **niega a habilitar el apagado del
> flag** si la paridad no cierra exacta.

### 2.1 · El comando

```bash
# Estado actual (sólo lectura, no toca AWS ni el filesystem)
node .pipeline/kernel-reconcile.js --status

# Reconciliación real (exige la ventana congelada)
node .pipeline/kernel-reconcile.js --apply --frozen \
  --profile <perfil-runtime> --project-id <projectId>
```

`--frozen` es **obligatorio** y es una afirmación tuya: la ventana está congelada
y no entran firmas nuevas (§5). Sin él, el comando corta antes de hablar con AWS.
No es burocracia: si entra una firma mientras se exporta, el conjunto exportado
nace viejo y la paridad se calcula contra un universo que ya cambió — **daría
verde sin serlo**.

Salida esperada cuando cierra:

```
== RECONCILIACIÓN APPEND-ONLY (DynamoDB → filesystem) ==
[OK] estado final: compare
     firmas: 3 · audit: 2 · total: 5
     nuevos: 5 · idempotentes: 0 · sólo locales: 0
     paridad exacta verificada releyendo del filesystem.

VEREDICTO: HABILITADO para apagar `kernel.durable`.
```

Exit code `0` **sólo** con paridad exacta. Cualquier otro caso ⇒ `1` y
`VEREDICTO: BLOQUEADO`.

### 2.2 · Qué hace por dentro (y por qué en ese orden)

La máquina de estados es fail-closed y no se puede saltear ningún paso:

```
precheck → freeze → export → validate → stage → atomic-promote
         → reread-filesystem → compare
```

| Paso | Qué garantiza |
|------|---------------|
| `precheck` | El destino cuelga de una raíz allowlisted y no es un symlink. |
| `freeze` | La ventana está congelada; si no, no se exporta nada. |
| `export` | Lectura **paginada completa** de `signature#`/`audit#`. Una página perdida es una firma perdida. |
| `validate` | Conjunto no vacío, **una firma Y un audit** como mínimo, sin conflictos de ID. |
| `stage` | Todo se escribe primero en `.staging/` (0700 dir / 0600 files, con `fsync`). |
| `atomic-promote` | `rename` por archivo. Si falla a mitad, el destino vuelve a la generación anterior. |
| `reread-filesystem` | Se relee **del disco**. Comparar contra lo que creemos haber escrito no prueba nada. |
| `compare` | Paridad exacta de IDs, conteos y SHA-256 — y cobertura: todo lo de DynamoDB está en filesystem. |

Las tres reglas de conflicto, que son las que hacen que reintentar sea seguro:

- **mismo ID + mismo hash** → idempotente. Reintentar no duplica nada.
- **mismo ID + contenido distinto** → **conflicto fatal**. Un append-only jamás
  se sobreescribe: aborta y conserva DynamoDB como fuente efectiva.
- **sólo existe en filesystem** → se **conserva**. Reconciliar no puede borrar un
  registro local; ese es el modo de falla que convierte "rollback" en "pérdida".

### 2.3 · Abort, reintento y staging

Todo aborto es seguro por construcción:

- El flag **nunca** se apaga en un camino de error. El comando lo dice explícito
  (`VEREDICTO: BLOQUEADO`).
- El aborto queda **auditado en el propio store durable** (`kernel.reconcile.abort`),
  con el estado y el código, redactado.
- El `.staging/` se limpia solo. Restos de un intento interrumpido **no** se
  mezclan con el intento siguiente: se borran antes de escribir.
- Reintentar es la acción correcta ante casi cualquier falla: la reconciliación
  es idempotente y el segundo intento reporta `nuevos: 0`.

Códigos de aborto y qué hacer con cada uno:

| Código | Qué pasó | Qué hacer |
|--------|----------|-----------|
| `ventana_no_congelada` | Falta `--frozen`. | Congelá la ventana (§5) y repetí. |
| `conjunto_vacio` | No hay nada que reconciliar. | Generá la sonda positiva (§8.4). **No** bajes el mínimo. |
| `sonda_incompleta` | Hay firmas pero no audit (o al revés). | Generá el tipo que falta: el ensayo exige los dos. |
| `conflicto_id` | Mismo ID con contenido distinto. | **No lo fuerces.** Investigá cuál es el bueno y anotalo en el issue. |
| `hash_divergente` / `linea_corrupta` | El JSONL local fue alterado. | Restaurá desde backup; el archivo perdió integridad. |
| `promocion_fallida` | El rename se interrumpió. | El destino ya volvió a la generación anterior. Reintentá. |
| `cobertura_incompleta` | Algo quedó sólo en DynamoDB. | **No apagues el flag.** Reintentá y revisá el listado. |

### 2.4 · Orden de apagado y reinicio (no se negocia)

El comando **no** apaga el flag ni reinicia: eso lo hacés vos, y sólo después de
`VEREDICTO: HABILITADO`. Un script de reconciliación que además reinicia
servicios puede dejar el pipeline fuera de servicio si falla a mitad.

```
1. node .pipeline/kernel-reconcile.js --apply --frozen   → HABILITADO
2. kernel.durable: false   en .pipeline/config.yaml
3. reinicio limpio
4. completar UNA fase leyendo desde filesystem
5. registrar R8 en el issue del cutover
```

Invertir 1 y 2 es exactamente la pérdida silenciosa que todo esto evita.

### 2.5 · R8 — el tiempo real de recuperación

**R8** es el tiempo desde que arranca la reconciliación hasta que el pipeline
completa una fase operando desde filesystem. Se registra en el issue del cutover
junto con los conteos:

```
R8 = <minutos> min · firmas reconciliadas: <n> · audit: <m> · paridad: exacta
```

Un R8 sin conteos al lado no sirve: no distingue "recuperé rápido" de "no había
nada que recuperar".

### 2.6 · Dónde quedan los artefactos (y por qué no en Git)

Los registros reintegrados viven en `.pipeline/audit/kernel-reconcile/`:

- `signatures.jsonl` — una firma por línea.
- `audit.jsonl` — una entrada de auditoría por línea.
- `manifest.json` — conteos, `(tipo, id, hash)` de cada registro y `manifestHash`.

Ese directorio está **fuera de Git** (`.pipeline/audit/` está en `.gitignore`) y
hay un test que lo verifica. Es deliberado: son firmas y auditoría del kernel en
un repo **público**. Nunca los agregues al diff "para dejar evidencia" — la
evidencia va al issue, redactada.

> **Nunca** intentes "limpiar" la tabla de no-repudio con un borrado masivo. La
> policy IAM no concede `DeleteItem` sobre esa tabla justamente para que esto no
> sea posible (#5124 · `docs/pipeline/kernel-iam-policy.md`). La reconciliación
> **copia, no mueve**: DynamoDB conserva todo, y hay un test que lo comprueba.

### 2.7 · Evidencia del ensayo (#5209) y qué queda del operador

Lo **verificado en AWS real** con el principal runtime (`intrale-kernel-runtime`,
perfil `kernel-runtime`), sin escribir ni borrar nada:

```
$ aws sts get-caller-identity --profile kernel-runtime
  Arn: arn:aws:iam::<ACCOUNT>:user/intrale-kernel-runtime     ← coincide con kernel.runtimePrincipal

$ node -e "...exportAppendOnly(store, { pageSize: 25 })..."   ← Query real contra la tabla
  EXPORT REAL OK · counts = {"total":0,"signature":0,"audit":0}
```

Dos conclusiones, y ninguna es cosmética:

1. **`dynamodb:Query` está concedido** al principal runtime sobre la tabla de
   no-repudio. No era obvio: la policy es least-privilege y hasta #5209 nadie
   necesitaba `Query` (todo se leía por `GetItem`). Si faltara, la reconciliación
   fallaría en producción con `AccessDeniedException` — no con un conjunto vacío.
2. **Hoy la partición está vacía.** Por eso la reconciliación aborta con
   `conjunto_vacio`, que es el comportamiento correcto: sin datos no hay ensayo.

Lo que **falta y lo hace el operador**, porque son acciones irreversibles o que
tocan producción:

| Paso | Por qué no lo automatiza un agente |
|------|-----------------------------------|
| Generar la sonda positiva (una firma + un audit reales) | Es una escritura **irreversible** en la tabla de no-repudio: la policy IAM no concede `DeleteItem`, así que lo que se escribe queda para siempre. |
| Apagar `kernel.durable` y reiniciar | Toca el pipeline en producción. Un restart mal coordinado es una caída. |
| Registrar R8 | Depende de los dos anteriores. |

Recién con esos tres pasos el ensayo queda cerrado. La herramienta ya está y es
idempotente: se puede correr las veces que haga falta.

### Cómo verificar la reconciliación de `signature#` y `audit#`

**1. El estado en filesystem no está vacío:**

```bash
node .pipeline/kernel-reconcile.js --status
```

Salida esperada — conteos mayores a cero en ambos tipos:

```
[OK] registros reintegrados: 5
     signature: 3 (signatures.jsonl)
     audit: 2 (audit.jsonl)
```

Si dice `registros reintegrados: 0`, la reconciliación **no ocurrió**: no avances.

**2. El manifiesto cierra contra lo escrito:**

```bash
node -e "
const R=require('./.pipeline/lib/kernel-append-only-reconcile');
const fs=require('fs'), p='.pipeline/audit/kernel-reconcile';
const m=JSON.parse(fs.readFileSync(p+'/manifest.json','utf8'));
const r=R.readFilesystemRecords(p);
console.log(JSON.stringify(R.validateReconcileManifest(m, r.records)));
"
```

Salida esperada:

```
{"ok":true}
```

Cualquier otra cosa (`manifest_alterado`, `conteo_divergente`) significa que el
manifiesto y los datos no coinciden: **no apagues el flag**.

**3. Quedó documentado en el issue del cutover:**

```bash
gh issue view <issue-del-cutover> --json comments \
  --jq '[.comments[] | select(.body | test("reconciliaci"))] | length'
```

Salida esperada — al menos un comentario de reconciliación registrado:

```
1
```

Si devuelve `0`, la reconciliación **no está documentada**: no avances al bloque
siguiente hasta que lo esté. Una reconciliación que no quedó escrita no ocurrió.

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

### Trail persistente para el uso de la CMK

El trail regional `intrale-kernel-kms` guarda management events en un bucket S3
privado y exclusivo de la cuenta. La retención es de **365 días**: cubre una
revisión anual completa y ventanas de investigación mayores a los 90 días del
Event history, sin conservar indefinidamente evidencia operativa. El lifecycle
del bucket aplica esa decisión automáticamente.

El aprovisionador es dry-run por defecto. Requiere una sesión AWS administrativa
vigente y deriva el account id en runtime:

```bash
node .pipeline/lib/kernel-cloudtrail-provision.js            # dry-run: imprime el plan
node .pipeline/lib/kernel-cloudtrail-provision.js --apply    # crea bucket + trail (admin)
```

La verificación está partida en **dos comandos con dos identidades distintas**,
porque ninguna identidad puede (ni debe) hacer las dos cosas:

```bash
# 1) Emitir uso real de la CMK — identidad con kms:Decrypt (NO la del pipeline).
AWS_PROFILE=<perfil-runtime> node .pipeline/lib/kernel-cloudtrail-provision.js --emit-usage

# 2) Leer el trail y confirmar la evidencia — identidad con lectura del bucket.
AWS_PROFILE=<perfil-pipeline> node .pipeline/lib/kernel-cloudtrail-provision.js \
  --verify --since <UTC-INICIO> --wait 900
```

`--emit-usage` escribe, lee y borra un ítem efímero en la tabla de coordinación
(nunca en la tabla append-only de no-repudio). `--verify` **lee los objetos del
trail en S3** —no el Event history— y exige `Decrypt` y `GenerateDataKey`
asociados a `alias/intrale-kernel-store`.

⚠️ **`Decrypt` y `GenerateDataKey` NO los ejecuta el mismo principal, y
`GenerateDataKey` no se produce a demanda.** Los dos puntos se verificaron
empíricamente el 2026-08-05 y condicionan cómo se lee la evidencia:

- **`Decrypt` → usuario runtime.** Aparece con el ARN de
  `intrale-kernel-runtime`, `invokedBy: dynamodb.amazonaws.com`.
- **`GenerateDataKey` → DynamoDB, como `AWSService`.** El usuario runtime **no
  tiene** `kms:GenerateDataKey` en ninguna policy: una llamada directa devuelve
  `no identity-based policy allows the kms:GenerateDataKey action`. La data key
  la genera DynamoDB en nombre de la tabla. Exigir el ARN del runtime en esta
  operación sería exigir un evento que AWS nunca emite.

Lo que prueba uso legítimo en `GenerateDataKey` es que la invocación venga de
**DynamoDB** —justo lo que ata el `kms:ViaService` de la key policy—. Una data
key generada desde otro servicio sería el hallazgo, y el verificador la marca
`principalExpected: false`.

Además, `GenerateDataKey` corresponde al **ciclo de vida de la data key de la
tabla** (creación/rotación), no a cada escritura: una emisión nueva produce
`Decrypt` pero normalmente **no** `GenerateDataKey`. Por eso `--verify` sin
`--since` —sobre la ventana completa de retención— es la forma correcta de
cerrar la correlación; acotar la ventana a la emisión sólo evidencia `Decrypt`.
Que falte `GenerateDataKey` en una ventana corta **no** es un fallo del trail:
recrearlo no cambia nada. CloudTrail entrega en lotes de ~5
minutos: un exit code `2` significa *todavía no llegó la evidencia*, se repite la
verificación; **no** se recrea el trail. `--wait <segundos>` reintenta solo.

#### Identidades: quién puede aprovisionar y quién puede consultar

Verificado empíricamente al aprovisionar el trail (2026-08-05):

| Acción | Identidad requerida | `claude-code` (pipeline) | `intrale-kernel-runtime` |
|---|---|---|---|
| Crear bucket + trail (`--apply`) | Sesión **administrativa** | ❌ `s3:CreateBucket` denegado | ❌ |
| Ver que el trail existe y loguea | `cloudtrail:DescribeTrails`, `GetTrailStatus` | ✅ permitido | — |
| **Leer el trail en S3** (`--verify`) | `s3:ListBucket`, `s3:GetObject` | ✅ **permitido** | — |
| Emitir uso de la CMK (`--emit-usage`) | `kms:Decrypt` vía DynamoDB | ❌ **denegado** | ✅ permitido |
| Consultar Event history (`lookup-events`) | `cloudtrail:LookupEvents` | ❌ denegado | ❌ |
| Endurecer la policy del destino (`put-bucket-policy`) | `s3:PutBucketPolicy` | ✅ permitido | ❌ denegado |

El aprovisionamiento es un **paso admin de una sola vez**: la identidad del
pipeline no puede crear el bucket ni el trail, y eso es deseable (el pipeline no
debe poder alterar su propia auditoría).

**La separación es intencional y hay que respetarla**: el pipeline (`claude-code`)
**lee** la auditoría pero no puede descifrar el store; el runtime
(`intrale-kernel-runtime`) **descifra** el store pero no puede leer ni alterar la
auditoría. Ninguna de las dos puede provisionar. Por eso la verificación son dos
comandos y no uno: quien genera la evidencia no es quien la lee.

Verificado empíricamente (2026-08-05): `claude-code` recibe `AccessDenied` en
`kms:Decrypt`, y `intrale-kernel-runtime` recibe un **explicit deny** en
`dynamodb:CreateTable` desde la policy `IntraleKernelStore`. Ambas denegaciones
quedan registradas en el trail, que es exactamente para lo que sirve.

`lookup-events` sigue denegado para el pipeline, pero **ya no bloquea la
reconciliación**: el procedimiento de abajo lee el trail desde S3, que es la
fuente con retención de 365 días.

#### Consultar el rastro durante una reconciliación

⚠️ **`lookup-events` NO consulta este trail.** Lee el *Event history* de
CloudTrail, que existe con trail o sin él y **sólo cubre 90 días**. Sirve para
una reconciliación reciente, pero **no** es la evidencia persistente que este
trail conserva 365 días. Confundir ambos es el error que deja una investigación
sin respaldo justo cuando pasa la barrera de los 90 días.

Ventana **menor a 90 días** — consulta rápida por Event history:

```bash
aws cloudtrail lookup-events --region us-east-2 \
  --lookup-attributes AttributeKey=EventName,AttributeValue=Decrypt \
  --start-time <UTC-INICIO> --end-time <UTC-FIN>
aws cloudtrail lookup-events --region us-east-2 \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GenerateDataKey \
  --start-time <UTC-INICIO> --end-time <UTC-FIN>
```

Ventana **mayor a 90 días** (o si hace falta evidencia con validación de
integridad) — leer los objetos del trail en S3:

```bash
BUCKET=intrale-kernel-cloudtrail-<ACCOUNT_ID>-us-east-2
aws s3 ls s3://$BUCKET/AWSLogs/<ACCOUNT_ID>/CloudTrail/us-east-2/<AAAA>/<MM>/<DD>/
aws s3 cp s3://$BUCKET/<objeto>.json.gz - | gunzip | \
  jq '.Records[] | select(.eventName=="Decrypt" or .eventName=="GenerateDataKey")
      | select(.resources[]?.ARN | test("alias-o-id-de-la-CMK"))
      | {eventTime, eventName, userIdentity, sourceIPAddress, resources}'
```

En ambos casos, confirmar en el JSON de cada evento la **CMK** (`resources[].ARN`),
el **principal** (`userIdentity`) y que el origen sea DynamoDB
(`sourceIPAddress: dynamodb.amazonaws.com`) — un `Decrypt` de la CMK con otro
origen es exactamente lo que el `kms:ViaService` debería estar impidiendo.

##### Camino scriptado (el mismo, sin armar el `jq` a mano)

El aprovisionador ya implementa la lectura del trail en S3, así que una
reconciliación no necesita reconstruir el pipeline de comandos de arriba:

```bash
node .pipeline/lib/kernel-cloudtrail-provision.js --verify --since <UTC-INICIO>
```

Devuelve por cada operación (`Decrypt`, `GenerateDataKey`) la lista de eventos con
`eventTime`, `principal`, `invokedBy` y `errorCode`, más un `complete` que es
`true` sólo si **cada** operación tiene al menos un evento **exitoso**.

Dos cosas que importan al leer la salida:

- **Un `errorCode` no es evidencia de uso.** Los intentos denegados aparecen en la
  lista —el trail los captura, que para eso está— pero no cuentan para `complete`.
  Contarlos dejaría la verificación fail-open: un `AccessDenied` daría por probada
  una postura de auditoría que nunca se ejerció.
- **Exit code `2` significa "todavía no llegó la evidencia"**, no que el trail esté
  mal. CloudTrail entrega en lotes de ~5 minutos; se repite la consulta (o se usa
  `--wait <segundos>`), **no** se recrea el trail.

El trail tiene `--enable-log-file-validation`, así que la integridad de los
archivos se puede probar contra los digest de
`AWSLogs/<ACCOUNT_ID>/CloudTrail-Digest/`:

```bash
aws cloudtrail validate-logs --trail-arn <TRAIL_ARN> \
  --start-time <UTC-INICIO> --region us-east-2
```

#### Evidencia redactada: qué sale y qué nunca sale

La evidencia se construye por **proyección allowlist**, no por redacción posterior
(`.pipeline/lib/kernel-audit-evidence.js`). El orden importa: nunca se persiste la
respuesta cruda de AWS "para limpiarla después". Un registro de CloudTrail trae
`recipientAccountId`, `requestID`, `eventID`, ARNs completos y `requestParameters`
con contexto de cifrado; una denylist sobre eso falla **abierta** ante cualquier
campo nuevo que AWS agregue, y una allowlist falla **cerrada**.

Lo único que sale de un evento es: `eventTime`, `eventName`, `principal`
(reducido a `user/<nombre>`), `principalExpected`, `invokedBy`, `errorCode` y
`outcome`. La clave se referencia por **alias + huella** (`sha256` truncado), no
por ARN ni key id.

Nunca salen: account-id, ARN completo, request/event IDs, key id, nombre de
sesión de un rol asumido, credenciales ni material criptográfico. Una segunda
capa (`assertRedacted`) reescanea lo ya proyectado y **aborta** si algo pasó; su
mensaje nombra la ruta y el patrón, nunca el valor —un error que imprime el ARN
que estaba ocultando lo filtra igual, y los errores terminan en logs y en issues.

Esto aplica también al `stdout` del aprovisionador: el plan crudo lleva el
account-id embebido en el nombre del bucket y el ARN entero del trail, así que
**todo** lo que imprime pasa por la proyección.

#### Endurecimiento del destino

La policy del bucket declara cinco statements (`bucketPolicy` en
`.pipeline/lib/kernel-cloudtrail-provision.js`):

| Sid | Efecto | Para qué |
|---|---|---|
| `AWSCloudTrailAclCheck` / `AWSCloudTrailWrite` | Allow | Entrega del trail, acotada por `AWS:SourceArn` |
| `DenyInsecureTransport` | Deny `*` | TLS-only. Va sobre `Principal: '*'` a propósito: la garantía es del canal, no de quién llama |
| `DenyRuntimeAuditAccess` | Deny runtime | El runtime no borra, no degrada retención, no reescribe la policy **y tampoco lee** la auditoría que genera |
| `AllowAuditorRead` | Allow auditor | Acceso de auditoría declarado en el destino, separado del runtime y de sólo lectura |

El deny explícito gana sobre cualquier allow presente o futuro: si mañana alguien
le adjunta una policy amplia al runtime, estas operaciones siguen bloqueadas.

El destino se cifra con **SSE-S3 (`AES256`)**, deliberadamente *distinta* de la
CMK auditada. Si fueran la misma clave, deshabilitarla para contener un incidente
del store dejaría ilegible la evidencia de ese mismo incidente. El verificador lo
comprueba (`destinationKeySeparateFromCmk`) en vez de asumirlo.

Para leer la postura **efectiva** desde AWS —no la policy que creemos haber
aplicado— con la identidad auditora:

```bash
node -e "const ct=require('./.pipeline/lib/kernel-cloudtrail-provision');
const p=ct.buildPlan({accountId:ct.runAws(['sts','get-caller-identity']).Account});
console.log(ct.verifyDestinationPosture(p,{keyArn:ct.resolveKeyArn(p)}))"
```

Devuelve una garantía por campo, así que un `false` nombra exactamente qué se
rompió. `--verify` sale con **exit code `3`** si la evidencia está completa pero
la postura no cumple: se distingue del `2` porque acá reintentar no sirve, hay
que corregir.

#### Pruebas negativas: la postura se prueba, no se lee

Inspeccionar policies no alcanza — una policy puede leerse correcta y estar
anulada por un allow heredado, un boundary ausente o una SCP mal ordenada. La
matriz de `.pipeline/lib/kernel-audit-negative-tests.js` **intenta** cada
operación destructiva con las credenciales reales del runtime y exige
`AccessDenied`.

```bash
# El key id lo resuelve la identidad AUDITORA: el runtime no tiene kms:DescribeKey.
KEY_ID=$(aws kms describe-key --key-id alias/intrale-kernel-store \
  --region us-east-2 --query 'KeyMetadata.KeyId' --output text)

node .pipeline/lib/kernel-audit-negative-tests.js                      # dry-run: imprime la matriz
AWS_PROFILE=<perfil-runtime> node .pipeline/lib/kernel-audit-negative-tests.js \
  --run --key-id "$KEY_ID"
```

Tres salvaguardas que hacen seguro correr esto contra producción:

1. **Guarda de identidad.** El runner se niega a arrancar si el llamador no es el
   principal runtime. Con una sesión administrativa, `stop-logging` y
   `delete-trail` **no** serían denegados: destruirían el trail de verdad.
2. **Parámetros que no destruyen.** `update-trail` y `put-event-selectors`
   reenvían la configuración vigente; `delete-object` apunta a una clave
   inexistente con nonce. Si el permiso existiera, la llamada tendría éxito —que
   es el hallazgo— sin romper nada.
3. **Corta-escalada.** En cuanto una operación de un servicio no resulta
   denegada, las **destructivas** que quedan de ese servicio no se ejecutan: el
   hallazgo ya está probado y seguir sólo agrega la chance de detener el trail o
   deshabilitar la clave.

El veredicto es **fail-closed**: denegado aprueba, permitido es crítico, y
cualquier otro error es `inconclusivo` —que **no** aprueba. Un timeout de red no
puede leerse como "está protegido". Las operaciones de KMS exigen key id porque
con alias devuelven `InvalidArnException`, que no es una denegación: sin esa
distinción, un error de forma se leería como postura verificada.

Después de correr la matriz, confirmar con la identidad auditora que el trail
quedó intacto (el runtime no puede leer su propio estado, y eso es parte de la
separación):

```bash
aws cloudtrail get-trail-status --name intrale-kernel-kms --region us-east-2 \
  --query '{IsLogging:IsLogging,TimeStopped:TimeLoggingStopped}'
aws kms describe-key --key-id alias/intrale-kernel-store --region us-east-2 \
  --query 'KeyMetadata.{State:KeyState,Deletion:DeletionDate}'
```

#### Retención, consulta y eliminación controlada

| Qué | Decisión | Dónde se aplica |
|---|---|---|
| **Retención** | 365 días | Lifecycle del bucket (`Expiration.Days` + `NoncurrentVersionExpiration`). Cubre una revisión anual completa y ventanas mayores a los 90 días del Event history |
| **Quién consulta** | Sólo la identidad auditora | `AllowAuditorRead` en la policy + IAM. El runtime tiene deny explícito de lectura |
| **Quién puede reducirla** | Nadie fuera de una sesión administrativa | El runtime tiene deny sobre `s3:PutLifecycleConfiguration`, verificado por la matriz negativa |
| **Eliminación controlada** | Sólo admin, y sólo por vencimiento del lifecycle | Ni el runtime ni el auditor pueden `DeleteObject` / `DeleteBucket` |

La eliminación anticipada de evidencia es un **paso administrativo deliberado**,
nunca una operación de runtime ni de pipeline: exige una sesión administrativa,
y queda registrada en el propio trail. El borrado por vencimiento lo hace el
lifecycle solo, a los 365 días, sin intervención.

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

> ✅ **`kernel.cutover_window` YA EXISTE en `.pipeline/config.yaml`** (la mergeó
> #5135). Default `false`. **Sólo el booleano `true` exacto la abre**: `"true"`
> como string, `1` o la clave ausente cuentan como cerrada (fail-closed).
>
> **Qué habilita estando abierta —** `createDegradationSink` pasa a modo
> *fail-loud*: si el catálogo durable degrada a filesystem durante el arranque, el
> encendido **aborta** (suspende el dispatch escribiendo `.pipeline/.paused`) en
> vez de arrancar sobre FS con una alerta. Es lo que evita comparar filesystem
> contra filesystem mientras el write path escribe a DynamoDB.
>
> **Fuera de la ventana** (`false`, régimen normal) el boot durable vuelve a ser
> best-effort: alerta fuerte y el pipeline arranca igual. Por eso dejarla abierta
> no es "más seguro": es un estado de mantenimiento permanente que nadie mira.

### Cómo verificar si `kernel.cutover_window` quedó abierta

Esta pregunta se responde con un comando, no con un párrafo:

```bash
grep -n "cutover_window" .pipeline/config.yaml || echo "AUSENTE"
```

Salida esperada en **régimen normal** (ventana CERRADA):

```
  cutover_window: false
```

Salida que exige acción — **la ventana quedó ABIERTA**:

```
  cutover_window: true
```

Si ves `true` y no estás ejecutando un cutover, cerrala (ponela en `false`) y
corré `node .pipeline/restart.js`.

Si ves `AUSENTE`, la clave se perdió en un merge: **frená el cutover**. Sin la
clave el sink queda en best-effort y la ventana no puede declararse, que es
justo el falso verde que este paso existe para evitar.

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

## 8 · Ejecución del cutover — procedimiento y evidencia (#5208)

**Estado: EJECUTADO.** `kernel.durable` quedó en `true` y `kernel.cutover_window`
en `false` (ventana cerrada). Esta sección es el registro redactado de la corrida
real, y a la vez el procedimiento a repetir si hay que rehacerla.

> **Redacción.** Todo lo de abajo pasó por `redactSecrets` + `redactAccountIds`:
> el account-id de 12 dígitos sale como `<ACCT>` y los nombres de tabla como
> `<tabla-no-repudio>` / `<tabla-coordinacion>` (los valores reales viven en
> `.pipeline/config.yaml`, no acá). Los checksums sí van en claro: son datos
> públicos de integridad, y ocultarlos haría inverificable la evidencia.

### 8.1 · Gate de dependencias y SHA desplegable

El cutover **no puede ejecutarse** con #5204 o #5207 abiertos: sin #5204 el alta y
la lectura de `catalog#index` caen en particiones distintas, y sin #5207 se prueba
con permisos que no son los que van a producción.

```bash
gh issue view 5204 --json state,closedAt
gh issue view 5207 --json state,closedAt
git log origin/main --oneline -1
```

Verificado en la corrida: ambas `CLOSED`, y el `main` desplegable (`6508755bf`) es
el propio merge de #5207, con #5204 ya integrado.

### 8.2 · Backups verificados, FUERA del repo

Los dos backups se toman con el **mismo epoch** (§1) y a una raíz que **no está
dentro del working tree**, para que no puedan entrar al diff ni por accidente.

**Verificar** no es "ver que el directorio existe": es recalcular el checksum
canónico de cada archivo del backup y compararlo contra su `manifest.json`.

> **Ojo con la trampa.** No compares el backup contra el archivo ORIGEN: los 4
> JSON de coordinación son estado vivo y `infra-health.json` cambia entre que
> tomás el backup y que lo verificás. Un mismatch ahí es el pipeline
> funcionando, no un backup corrupto. Lo que importa es que el backup sea
> **íntegro y restaurable**, y eso se prueba contra su propio manifest.

Resultado de la corrida (checksum declarado en el manifest vs. recalculado sobre
el contenido respaldado, truncados a 18 hex para que la tabla entre en pantalla):

```
archivo                           | manifest           | recalculado        | veredicto
waves.json                        | 49da0288e5d8ed6738 | 49da0288e5d8ed6738 | OK
blocked-issues.json               | d8aa1c876a0e3b338a | d8aa1c876a0e3b338a | OK
blocked-by-infra.json             | 05df9fb6a1b4fdc658 | 05df9fb6a1b4fdc658 | OK
infra-health.json                 | 3827b6120362aa332b | 3827b6120362aa332b | OK
descriptors/intrale-platform.json | e512095384b5a60691 | e512095384b5a60691 | OK

[OK] backups INTEGROS y restaurables.
```

Y el diff no los contiene:

```bash
git status --short   # ningún path de backup, ninguna credencial
```

### 8.3 · Migrador — `migrated_count: 0` es un DIAGNÓSTICO

```bash
node .pipeline/lib/kernel-store-migrate.js      # dry-run, sin flags
```

El reporte trae una sección `--- ALCANCE DEL CUTOVER ---` que **no puede mostrar
el cero sin explicarlo**:

```
--- ALCANCE DEL CUTOVER ---
migrated_count: 0
entidades del alcance real: descriptor#self, product#<id>, catalog#index, signature#*, audit#*, claim#*
descriptores hallados: 1 (reservados: 1 · candidatos no reservados: 0)
  intrale-platform.json | projectId: intrale-platform | [RESERVADO] no se da de alta como producto
por qué el conteo da ese número:
  - 1 descriptor(es) declaran un id RESERVADO (intrale-platform): el control-plane NO es un
    tenant, así que durableRegisterProduct los rechaza por diseño.
  - las 4 fuentes de coordinación están EXCLUIDAS del cutover por #5112.
[ATENCIÓN] migrated_count es un DIAGNÓSTICO, no una medida de paridad.
```

**Por qué el cero no es un problema:** el único descriptor del repo declara el id
reservado `intrale-platform`, que es el control-plane y **no se da de alta como
producto**. No hay nada que migrar. **Por qué el cero tampoco es evidencia:**
comparar cero migrados contra un store vacío da verde sin probar nada. La
evidencia positiva la aporta §8.4, y sólo ella.

`--apply` sigue cortando con `alcance_no_implementado`, a propósito (ver "Si algo
sale mal"). No lo destrabes pasándole las 4 fuentes.

### 8.4 · Sonda positiva — la evidencia que sí prueba algo

```bash
node .pipeline/lib/kernel-cutover-probe.js \
  --project-id <tenant-controlado-no-reservado> \
  --profile <perfil-del-principal-runtime>
```

La sonda hace, en orden y fail-closed: verifica que el **principal efectivo** sea
el `kernel.runtimePrincipal` del config (con un admin todas las sondas pasan y no
se prueba nada), da de alta un producto controlado por `durableRegisterProduct`
—el único poblador—, lee por la API del kernel, lee de nuevo con
`aws dynamodb get-item --consistent-read` **por un camino separado del driver del
store**, y compara.

> **El tenant no puede ser `intrale-platform`.** Es un id reservado y el alta
> corta antes de escribir. Usá un tenant controlado no reservado.

Resultado de la corrida:

```
[OK] identidad — principal runtime efectivo verificado contra config
[OK] alta — descriptor#self en la partición del tenant · product#/catalog# en la del control-plane
[OK] comparación · descriptor#self (partición del tenant)
     PK | SK | no-vacío | schemaVersion | contenido (sha256 canónico) — coinciden
[OK] comparación · product#<tenant> (partición del control-plane)
     PK | SK | no-vacío | schemaVersion | contenido (sha256 canónico) — coinciden
[OK] comparación · catalog#index (partición del control-plane)
     PK | SK | body.version (CAS) = 1 | no-vacío (productIds) | indexa el alta
[OK] negativa cross-tenant — un contexto ajeno fue RECHAZADO; su partición está vacía
[OK] degradación — cero eventos onDegraded durante toda la sonda
```

Y la lectura consistente cruda del índice, para que la evidencia sea legible sin
interpretar el reporte de la sonda:

```json
{"Item":{"PK":{"S":"kernel-control-plane"},"SK":{"S":"catalog#index"},
  "entityType":{"S":"catalog"},"schemaVersion":{"S":"1.0"},
  "body":{"M":{"productIds":{"L":[{"S":"<tenant-controlado>"}]},"version":{"N":"1"}}}}}
```

> **`ItemCount` NO sirve como evidencia.** DynamoDB lo actualiza cada ~6 horas,
> así que `describe-table` puede seguir informando `ItemCount: 0` con ítems ya
> escritos y confirmados. Leer eso como "no se escribió nada" es un falso
> negativo. La única lectura concluyente es `get-item --consistent-read`.

### 8.5 · Reboot — alta, catálogo y lectura sobre la partición canónica

Con la ventana **abierta** (sink en fail-loud) se ejerce el mismo camino que corre
el pulpo al arrancar: `bootKernelDurable` con `buildCatalogStore` ligado a
`kernel-control-plane`.

```
config efectivo: kernel.durable = true | kernel.cutover_window = true
sink fail-loud (cutover_window abierta): true

ran      : true
fatal    : false
cap      : 2
spawned  : []
skipped  : [{"projectId":"<tenant-controlado>","reason":"inactivo"}]

particion leida por el boot   : kernel-control-plane
eventos onDegraded            : 0
sink.aborted (halt disparado) : false
```

**Cómo se lee esto.** Que el producto aparezca en `skipped` con reason
`inactivo` es el resultado CORRECTO, y es la prueba de la partición canónica: el
boot **encontró** en `kernel-control-plane` el producto que el alta escribió ahí,
y lo salteó sólo porque `durableRegisterProduct` lo deja en `onboarding` (sólo
`active` se instancia). Antes de #5204 el alta caía en la partición del tenant y
`listProducts()` devolvía vacío: el producto era invisible para el boot y el
`skipped` habría estado vacío. **Un `skipped` vacío acá es la señal de alarma**,
no un boot limpio.

### 8.5-bis · El gap que apareció al ejecutar: credenciales del runtime

La primera corrida del reboot pasó **sólo porque el ensayo inyectaba el driver a
mano**. Por el camino real del pulpo fallaba, y fallaba de la peor manera
posible: en silencio para el operador y con el flag encendido.

**Qué estaba roto.** Había dos mecanismos que no se hablaban:

| Pieza | Qué provee / qué exige |
|---|---|
| #5207 (`kernel-aws-bootstrap.js`) | Aprovisionó el principal runtime como **perfil de la AWS CLI** en la config del usuario. |
| `createAwsCliRunner` (`provisioner-infra.js`) | Exige **claves estáticas en el env** (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`) y rechaza fail-closed. `AWS_PROFILE` no le sirve. |
| `credentials.loadIntoEnv()` | **No hidrata ninguna variable `AWS_*`**: no hay descriptores `aws.*` en `ENV_DESCRIPTORS`. |
| Entorno del pipeline | Sólo define `AWS_PROFILE`, y apuntando al perfil **administrativo**. |

Verificado antes de tocar nada:

```bash
node -e "
const { buildAwsScopedEnv } = require('./.pipeline/lib/kernel-provision');
const { createAwsCliRunner } = require('./.pipeline/lib/provisioner-infra');
try { createAwsCliRunner(buildAwsScopedEnv({ AWS_PROFILE: '<perfil-admin>' }, '<region>')); }
catch (e) { console.log(e.message); }
"
# createAwsCliRunner: faltan credenciales AWS … Fail-closed: no se invoca la AWS CLI
# con credenciales vacías.
```

**Por qué importa tanto.** `buildDurableStore` se llama **dentro** de
`bootKernelDurable`, así que ese throw no rompía nada visible: caía en el catch,
salía como `stage: 'boot-durable'` y llegaba al sink de degradación. Con la
ventana **cerrada** (régimen normal) el sink es best-effort: alerta fuerte por
Telegram y **el pipeline arranca igual sobre filesystem**. O sea, mergear
`durable: true` sin cerrar este gap habría dejado el switch diciendo DynamoDB y
el sistema corriendo sobre FS, con ruido de alerta en cada arranque. Es
exactamente la degradación silenciosa que el cutover existe para eliminar.

**Cómo se cerró.** `.pipeline/lib/kernel-runtime-credentials.js` resuelve el env
AWS del runtime en este orden:

1. Claves estáticas ya presentes en el env — **gana el entorno**, cero spawns.
2. `aws configure get` sobre `kernel.runtimeProfile`, cacheado en memoria por
   perfil (el boot construye varios stores y no puede pagar dos spawns por cada uno).
3. Si no, error como **dato** con causa accionable. El módulo nunca lanza.

`pulpo.js` lo usa en `buildDurableStore` en lugar de `buildAwsScopedEnv(process.env, …)`.

> **Las claves NO entran a `process.env`.** Van sólo al env del hijo `aws`.
> Hidratar `process.env` del pulpo se las regalaría a todo agente que declare el
> scope `aws` en `build-child-env.js` — una ampliación de superficie que nadie
> pidió.

> **`kernel.runtimeProfile` ≠ `kernel.runtimePrincipal`.** El *principal* es el
> nombre IAM contra el que la sonda compara la identidad efectiva; el *profile*
> es el perfil local del que salen las claves. Y **no apuntes `runtimeProfile` al
> perfil administrativo** para destrabar un arranque: el kernel dejaría de operar
> con least-privilege y los `Deny` de la policy no se probarían nunca. Hay un
> test que falla si los dos perfiles coinciden.

Verificación del cierre, por el camino real y **sin claves en el entorno**:

```
env del proceso: AWS_ACCESS_KEY_ID presente? false | AWS_PROFILE = <perfil-admin>

ran     : true | fatal: false
skipped : [{"projectId":"<tenant-controlado>","reason":"inactivo"}]
onDegraded (boot-durable): 0
error   : (ninguno)
```


### 8.6 · Cierre de la ventana

```bash
grep -n "cutover_window" .pipeline/config.yaml
#   cutover_window: false   ← cerrada
```

La ventana se cierra **sólo con todas las sondas en verde**, y el cierre es parte
del cutover, no limpieza posterior (§5). `kernel.durable: true` sí queda
persistido y versionado: es el objetivo de la operación.

### 8.7 · Cómo re-verificar sin volver a ejecutar el cutover

```bash
node --test .pipeline/lib/__tests__/kernel-cutover-probe.test.js
node --test .pipeline/lib/__tests__/kernel-store-migrate.test.js
node .pipeline/lib/kernel-store-migrate.js
node .pipeline/lib/kernel-cutover-probe.js --project-id <tenant> --profile <runtime>
```

La sonda es **re-ejecutable** sobre un tenant ya dado de alta: en ese caso lo
declara (`el tenant YA estaba dado de alta`) y verifica el estado persistido en
vez de escribir de nuevo. Esa distinción está en el reporte a propósito — una
comparación verde sobre un alta vieja no es lo mismo que una escritura fresca, y
el operador tiene que poder verlo.

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

Si en cambio el arranque aborta con este mensaje, te falta `kernel.tableName`:

```
Arranque abortado: falta 'kernel.tableName' en .pipeline/config.yaml. El modo
durable (kernel.durable: true) no arranca sin nombre de tabla y no cae a
filesystem. Completá la clave con el nombre de la tabla y reintentá.
Detalle: docs/pipeline/runbook-cutover-durable.md
```

Es el guard de #5214 (`.pipeline/lib/kernel-durable-config-guard.js`), y aborta con
exit code **78** (`EX_CONFIG`). No es un fallo del store: corre **antes** de construir
el cliente AWS, así que no hubo ni una llamada a DynamoDB ni consumo de credenciales.

El mensaje es **constante**: sale idéntico si `kernel.tableName` está ausente, vacío
o compuesto sólo por whitespace. Eso es deliberado — no volcamos la configuración ni
el entorno para diagnosticar, así que no esperes que el texto te diga cuál de los tres
casos es. Miralo vos:

```bash
grep -nE '^\s*(durable|tableName):' .pipeline/config.yaml
```

Salida sana — la tabla de no-repudio nombrada y el switch durable apagado:

```
1689:  tableName: "intrale-kernel-state"      # requerido para el driver real (normalizeConfig lo exige)
1722:  durable: false     # default OFF -- todo sigue en FS, cero llamadas AWS
```

Completá `kernel.tableName` con el nombre de la tabla de no-repudio aprovisionada en
CA-0 (§4) — la del `descriptor#self` y los `audit#`, no la de coordinación — y
reintentá. Si todavía no la aprovisionaste, no inventes un nombre: andá a §4 primero.
El guard existe justamente para que un `tableName` de fantasía no te haga arrancar
contra una tabla que no existe, ni caer a filesystem creyendo que estás en durable.

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
- **#5135** — hermana: sink fail-loud de degradación durable y `kernel.cutover_window`. **Cerrada y mergeada.**
- **#5126** — Bloque B (épico): provisionar, migrar, verificar paridad, encender durable y ensayar el rollback.
- **#5207** — hija de #5126: infraestructura, cifrado e IAM del cutover. **Cerrada y mergeada.**
- **#5204** — partición canónica de `catalog#index`. **Cerrada y mergeada.**
- **#5208** — hija de #5126: ESTA ejecución del cutover (§8). **Cerrada.**
- `.pipeline/lib/kernel-cutover-probe.js` — la sonda positiva del cutover (§8.4).
- **#5124** — Bloque A: los `claim#` fuera de la partición de no-repudio. **Cerrada y mergeada.**
- **#5112 / #5107** — historia madre y épico de la Ola 9.4 (E2).
- `docs/pipeline/kernel-iam-policy.md` — decisión de CA-A1 y policy IAM del kernel.
- `docs/pipeline/ola-puente-kernel-multiproducto.md` — diseño del kernel multi-producto y modos del migrador.
- `docs/pipeline/spike-estado-remoto-hallazgos.md` — §2/§3/§4/§5.3, base documental del cutover.
- `docs/runbooks/credential-rotation.md` — formato de referencia de este runbook.
- `.pipeline/lib/kernel-store-migrate.js` — migrador, `backupDescriptors()` y `restoreDescriptors()`.
- `.pipeline/lib/project-bootstrap.js` — `durableRegisterProduct`, el poblador real (#4821).
