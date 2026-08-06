# Matriz empírica IAM/KMS del runtime durable (#5211)

> Evidencia del mínimo privilegio del principal runtime **contra AWS real**, no
> contra el JSON del repo. Corrida del **2026-08-06**, perfil `kernel-runtime`,
> `us-east-2`. Todo output va redactado: account-id como `<ACCOUNT>`, UUID de la
> CMK como `<CMK_ID>`.
>
> Reproducible: `node .pipeline/lib/kernel-iam-verify.js`
> En un gate: `node .pipeline/lib/kernel-iam-verify.js --strict` (exit 1 si CA-3
> no está cerrado).

## Estado, en una línea

**CA-2 cerrado. CA-3 NO cerrado.** Nada está autorizado indebidamente —cero
hallazgos abiertos— pero **8 de los controles de CA-3 dependen hoy de
`implicitDeny`**, y un `implicitDeny` se deshace con un `Allow` de más sin que
nadie se entere. La policy vigente en AWS **no es** el artefacto de este repo:
faltan aplicarle los cuatro `Deny` que #5211 entrega.

Cerrar CA-3 requiere una acción de operador (§6). No la puede hacer un agente:
aplicar la policy exige gestión IAM que el runtime no tiene, a propósito.

---

## 1. Por qué esta matriz fue reescrita (leer antes de confiar en la anterior)

La versión previa de este documento **afirmaba un estado de AWS que AWS no
tenía**. Decía que todo el control plane estaba en `implicitDeny` y que ninguna
fila podía atribuirle un `explicitDeny` a `policy/IntraleKernelStore`. Tres
probes crudos la contradecían:

```
$ aws dynamodb list-tables --profile kernel-runtime
AccessDeniedException ... dynamodb:ListTables ... with an explicit deny in an
identity-based policy: arn:aws:iam::<ACCOUNT>:policy/IntraleKernelStore

$ aws iam list-attached-user-policies --user-name intrale-kernel-runtime --profile kernel-runtime
AccessDenied ... iam:ListAttachedUserPolicies ... with an explicit deny in an
identity-based policy: arn:aws:iam::<ACCOUNT>:policy/IntraleKernelStore
```

**La causa raíz no fue un error de tipeo.** El estado aplicado se **dedujo**
leyendo el artefacto de `origin/main` en vez de **leerlo** de AWS, y esa
deducción se escribió a mano en dos lugares: acá y en `CONTROL_PLANE_PROBES`.
Cuando se leyó el documento real (`iam:GetPolicyVersion`, versión `v3`),
apareció el statement que explicaba todo y que el artefacto no modelaba:

```json
{
  "Sid": "DenyEverythingOutsideKernelTables",
  "Effect": "Deny",
  "NotAction": ["sts:GetCallerIdentity"],
  "NotResource": [
    "arn:aws:dynamodb:REGION:ACCOUNT:table/TABLE",
    "arn:aws:dynamodb:REGION:ACCOUNT:table/COORD_TABLE",
    "arn:aws:kms:REGION:ACCOUNT:key/CMK_KEY_ID"
  ]
}
```

Un catch-all que deniega **todo lo que no sea** una de las dos tablas o la CMK.
Con eso, cada observación cierra — y aparece un efecto contraintuitivo que es el
hallazgo central de esta pasada (§3).

**Qué cambió para que no vuelva a pasar:** este documento ya no describe el
estado aplicado de memoria. `kernel-iam-verify.js` lee la policy adjunta, la
compara contra el artefacto y evalúa los controles no ejecutables sobre el
documento real. Si no puede leerlo, la fila sale `desconocido` — nunca con un
resultado supuesto. Ver §7.

## 2. Principal verificado (CA-1)

```
$ aws sts get-caller-identity --profile kernel-runtime
{
    "UserId": "<REDACTED>",
    "Account": "<ACCOUNT>",
    "Arn": "arn:aws:iam::<ACCOUNT>:user/intrale-kernel-runtime"
}
```

Es el runtime, no una identidad privilegiada. Las dos tablas, observadas con el
perfil administrativo (el runtime no puede leer su propio estado de PITR — que
es exactamente lo que CA-3 pide):

| Tabla | Rol | Estado | PITR | Deletion protection |
|---|---|---|---|---|
| `intrale-kernel-state` | no-repudio (append-only) | ACTIVE | ENABLED (35 d) | `true` |
| `intrale-kernel-coordination` | coordinación (claims de fase) | ACTIVE | — | — |

## 3. El hallazgo: `explicitDeny` afuera, `implicitDeny` sobre lo que importa

El catch-all deniega por `NotResource`. Consecuencia directa y fácil de leer al
revés: **la misma acción da resultados distintos según el recurso**, y da el
resultado *peor* justamente sobre el recurso que hay que proteger.

El par de probes que lo demuestra, ejecutado en esta pasada:

```
### UpdateContinuousBackups sobre la tabla de EVIDENCIA
### (Enabled=true: PITR ya esta ENABLED, si estuviera autorizado es no-op)
$ aws dynamodb update-continuous-backups --table-name intrale-kernel-state \
    --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true --profile kernel-runtime
AccessDeniedException ... dynamodb:UpdateContinuousBackups on resource:
arn:aws:dynamodb:us-east-2:<ACCOUNT>:table/intrale-kernel-state
BECAUSE NO IDENTITY-BASED POLICY ALLOWS the dynamodb:UpdateContinuousBackups action

### La MISMA accion sobre una tabla FUERA del alcance
$ aws dynamodb update-continuous-backups --table-name intrale-kernel-canary-5211-nonexistent ...
AccessDeniedException ... WITH AN EXPLICIT DENY in an identity-based policy:
arn:aws:iam::<ACCOUNT>:policy/IntraleKernelStore
```

Apagar PITR sobre la tabla de evidencia —el control más importante de CA-3,
porque deja la evidencia destruible por otra vía y vuelve irrelevante el
append-only del plano de datos— está hoy **sólo en `implicitDeny`**.

Y acá está la trampa: **una matriz que hubiera probado sólo la segunda fila
habría reportado el control como verificado.** Es el principio que este mismo
documento ya declaraba —"un `AccessDenied` sobre un control no se cuenta como
control verificado"— incumplido en su propia evidencia. Por eso ahora cada probe
declara su `alcance` y los que importan corren **in-scope**.

## 4. CA-2 — Allow en coordinación, Deny en no-repudio

Los diez probes de plano de datos, todos en su expectativa:

| Probe | Espera | Observado | |
|---|---|---|---|
| `coord-get-item` — lectura de claims | allow | `allowed` | ✅ |
| `coord-put-item` — toma de claim | allow | `conditionFailed` (autorizado) | ✅ |
| `coord-delete-item` — release de claim | allow | `conditionFailed` (autorizado) | ✅ |
| `nonrepudio-get-item` — lectura de evidencia | allow | `allowed` | ✅ |
| `nonrepudio-put-item` — append de firma/audit | allow | `conditionFailed` (autorizado) | ✅ |
| `nonrepudio-update-item` | deny | **explicitDeny** | ✅ |
| `nonrepudio-delete-item` | deny | **explicitDeny** | ✅ |
| `nonrepudio-batch-write-item` | deny | **explicitDeny** | ✅ |
| `nonrepudio-transact-write-items` | deny | **explicitDeny** | ✅ |
| `nonrepudio-partiql-delete` | deny | **explicitDeny** | ✅ |

Los cinco caminos de escritura sobre no-repudio dan `explicit deny` de
`policy/IntraleKernelStore`, producido por `DenyMutateNonRepudiation`, que **sí**
está aplicado desde #5124. Muestra textual:

```
$ aws dynamodb update-item --table-name intrale-kernel-state \
    --key '{"PK":{"S":"canary-5211"},"SK":{"S":"probe"}}' ... --profile kernel-runtime
An error occurred (AccessDeniedException) when calling the UpdateItem operation:
User: arn:aws:iam::<ACCOUNT>:user/intrale-kernel-runtime is not authorized to perform:
dynamodb:UpdateItem on resource: arn:aws:dynamodb:us-east-2:<ACCOUNT>:table/intrale-kernel-state
with an explicit deny in an identity-based policy: arn:aws:iam::<ACCOUNT>:policy/IntraleKernelStore
```

`TransactWriteItems` merece mención: el mensaje delata que AWS lo evalúa como
`dynamodb:DeleteItem` — el `Deny` lo alcanza por la acción subyacente, no por el
nombre del verbo del CLI.

### Ningún probe dejó residuo

Todo probe mutante de plano de datos viaja con `ConditionExpression:
attribute_exists(PK)` sobre una clave canario que no existe. IAM evalúa la
autorización **antes** que la condición, así que el probe distingue Allow de Deny
sin poder escribir nada. Verificación posterior sobre ambas tablas: sin ítems
`canary-5211*`.

## 5. CA-3 — El runtime no administra tablas, CMK, policies ni PITR

`✅` = `explicitDeny` (sobrevive a un `Allow` futuro) · `⏳` = denegado hoy, pero
sólo por `implicitDeny`.

### 5.1 Probado contra AWS

| Control | Alcance | Observado | |
|---|---|---|---|
| `dynamodb:ListTables` | cuenta | **explicitDeny** | ✅ |
| `iam:ListAttachedUserPolicies` | cuenta | **explicitDeny** | ✅ |
| `iam:AttachUserPolicy` (ARN inexistente) | cuenta | **explicitDeny** | ✅ |
| `dynamodb:UpdateContinuousBackups` (tabla ajena) | out-scope | **explicitDeny** | ✅ |
| `dynamodb:DeleteTable` (tabla inexistente) | out-scope | **explicitDeny** | ✅ |
| `dynamodb:UpdateContinuousBackups` — **apagar PITR de la evidencia** | in-scope | implicitDeny | ⏳ |
| `dynamodb:UpdateTable` — deletion protection de la evidencia | in-scope | implicitDeny | ⏳ |
| `dynamodb:CreateTable` | in-scope | implicitDeny | ⏳ |
| `kms:DescribeKey` — uso directo de la CMK | in-scope | implicitDeny | ✅ (ver nota) |

> **Nota sobre `kms:DescribeKey`.** Es la única fila de CA-3 que se da por buena
> con `implicitDeny`, y la excepción es de diseño: `DescribeKey` no es una acción
> de administración. La garantía de que la CMK no se use fuera de DynamoDB la da
> la condición `kms:ViaService` de la **key policy**, más el hecho de que la
> identity policy no concede un solo `kms:` (hay un test que falla si alguien
> agrega `kms:Decrypt`). Exigir `explicitDeny` acá obligaría a meter `DescribeKey`
> en un `Deny`, que es justo el efecto colateral que analiza **#5660**.

### 5.2 Evaluado sobre la policy aplicada (no ejecutable)

Estas operaciones no tienen variante inocua: intentarlas contra el recurso real
**es** el incidente que previenen. No se ejecutan — y **tampoco se declaran a
mano**: se evalúan con la semántica de IAM sobre el documento que devuelve
`iam:GetPolicyVersion`.

| Control | Alcance | Evaluado | Statement | |
|---|---|---|---|---|
| `dynamodb:DeleteTable` sobre la tabla de evidencia | in-scope | implicitDeny | ninguno | ⏳ |
| `kms:ScheduleKeyDeletion` | in-scope | implicitDeny | ninguno | ⏳ |
| `kms:DisableKey` | in-scope | implicitDeny | ninguno | ⏳ |
| `kms:PutKeyPolicy` | in-scope | implicitDeny | ninguno | ⏳ |
| `iam:CreateAccessKey` | cuenta | **explicitDeny** | `DenyEverythingOutsideKernelTables` | ✅ |

Cada clasificación de esta tabla se contrastó además con un probe crudo donde
existía variante segura, y el evaluador reproduce **las 19 observaciones reales**
(test `kernel-iam-drift.test.js`).

### Por qué `implicitDeny` no alcanza

`implicitDeny` significa "falta un `Allow`". Está denegado hoy — pero se deshace
con que alguien agregue un `Allow` de más, y nadie se entera. Un `Deny` explícito
gana sobre cualquier `Allow` futuro.

No es académico acá: **apagar PITR o deletion protection deja la evidencia de
no-repudio destruible por otra vía**. El append-only del plano de datos no vale
nada si el runtime puede tirar la tabla entera.

## 6. Drift artefacto ↔ AWS, y el paso de operador

Comparación automática contra la versión `v3`, hoy adjunta al principal:

```
- Sólo en el artefacto — endurecimiento pendiente de aplicar:
  DenyDynamoDbControlPlane, DenyDynamoDbAccountLevelControlPlane,
  DenyKmsAdministration, DenyIamSelfAdministration
- Sólo en la policy aplicada: (ninguno)
- Mismo Sid, contenido distinto: (ninguno)
```

> ### ⚠️ Aplicar una policy REEMPLAZA el documento entero
>
> Esto merece un recuadro porque el razonamiento intuitivo es falso y estuvo a
> punto de causar un daño real. Aplicar es `aws iam create-policy-version`:
> **sustituye el documento completo, no se fusiona con el vigente**. Por lo
> tanto "el diff sólo agrega `Deny`, la postura sólo puede mejorar" **no vale**.
>
> El artefacto anterior **no contenía** `DenyEverythingOutsideKernelTables` ni
> `AllowIdentityCheck`. Aplicarlo habría **borrado el catch-all vigente**
> —degradando a `implicitDeny` todo lo que hoy está explícitamente denegado
> fuera de las tres ARNs— y de paso habría roto `sts:GetCallerIdentity`.
>
> El artefacto de este commit ya representa `v3` **más** los cuatro `Deny`
> nuevos, así que aplicarlo es una mejora estricta. Hay un test que falla si
> alguien vuelve a sacarle un statement vigente (`kernel-iam-drift.test.js`,
> verificado por mutación).

**Procedimiento (operador, trazado en #5661):**

1. Sustituir los placeholders de `docs/pipeline/kernel-iam-policy.json`
   (`REGION`, `ACCOUNT`, `TABLE`, `COORD_TABLE`, `CMK_KEY_ID`) por los valores
   reales.
2. `aws iam create-policy-version --policy-arn <...>:policy/IntraleKernelStore
   --policy-document file://<...> --set-as-default`
3. `node .pipeline/lib/kernel-iam-verify.js --strict` → tiene que dar **exit 0**
   y `CA-3 CERRADO`. Los `⏳` deben pasar a ✅ y el drift a "sin drift".
4. Canario de fail-closed: `nonrepudio-get-item` y `coord-get-item` deben seguir
   en `allowed`. Si alguno da AccessDenied, revertir a la versión anterior — el
   store quedó ilegible y el pipeline cae al primer read.

Mientras algún `⏳` siga en pie, **CA-3 no está cerrado** y este documento no
respalda una firma que diga lo contrario.

## 7. Qué cambió en el verificador para que la evidencia no pueda mentir

| Antes | Ahora |
|---|---|
| El resultado del control plane era un string escrito a mano (`evidenciaManual`) | Se **prueba** contra AWS o se **evalúa** sobre el documento aplicado |
| El estado aplicado se deducía del artefacto del repo | Se lee con `iam:GetPolicyVersion` y se compara automáticamente |
| No se modelaba `NotAction`/`NotResource` | El evaluador los soporta (sin eso, el catch-all es invisible) |
| `implicitDeny` contaba como control verificado (✅) | Sale `⏳ pendiente`; sólo `explicitDeny` cierra CA-3 |
| Los probes de control plane apuntaban a recursos cualesquiera | Cada probe declara `alcance`; los que importan corren **in-scope** |
| Un chequeo que no se podía correr se omitía | Sale `desconocido` y bloquea `cerrado` |

El perfil que lee la policy es **administrativo y distinto del runtime**: el
runtime tiene denegado `iam:GetPolicyVersion` a propósito —no debe poder leer su
propia policy— así que no puede auditarse a sí mismo. Se usa sólo para lectura, y
el documento se enmascara (`maskPolicyDocument`) antes de salir del módulo: sin
account-id, sin región, sin el UUID de la CMK.

## 8. Dónde vive realmente el permiso de la CMK

La observación que abrió #5211 fue `grep -c "kms:" kernel-iam-policy.json` → **0**.
La lectura intuitiva era "faltan statements KMS en la identity policy".

Los probes muestran otra cosa:

- El runtime **escribe y lee** una tabla cifrada con CMK sin un solo statement
  `kms:` en su identity policy (round-trip put→get verificado).
- Y al mismo tiempo `kms:DescribeKey` **directo** le da AccessDenied.

Las dos cosas juntas se explican de una sola forma, confirmada leyendo la key
policy con el perfil admin: la autorización vive en la **key policy de la CMK**,
statement `RuntimeUseViaDynamoDBOnly`, condicionada por
`kms:ViaService = dynamodb.<region>.amazonaws.com`. El descifrado ocurre como
efecto de una operación DynamoDB; cualquier uso directo de la clave cae.

**El diseño estaba bien; lo que faltaba era versionarlo.** Ese permiso no tenía
representación en el repo: nadie podía revisarlo en un PR ni notar que se
aflojara. Lo cierra `docs/pipeline/kernel-kms-key-policy.json`.

Corolario blindado con un test: **no** hay que agregar `kms:Decrypt` a la
identity policy. Sería privilegio redundante y peligroso — ahí no está atado a
`ViaService`, así que habilitaría usar la CMK fuera de DynamoDB.

### Endurecimiento propuesto sobre la key policy

El statement aplicado condiciona sólo por `ViaService`. Como **ambas tablas
comparten la CMK**, eso deja al runtime usar la clave vía DynamoDB sobre
cualquier otra tabla de la cuenta cifrada con ella. El artefacto versionado suma
`kms:EncryptionContext:aws:dynamodb:tableName` enumerando las dos tablas.

> **Verificación obligatoria antes de aplicar.** Es la condición con más riesgo
> de fail-closed: si el nombre de la clave de encryption context no fuera el
> correcto, el store queda **ilegible** y el pipeline cae al primer read. No se
> pudo confirmar contra CloudTrail (no hay trail configurado — fuera del alcance
> de #5211). Procedimiento: aplicar, correr el verificador y exigir
> `nonrepudio-get-item` y `coord-get-item` en `allowed`. Si alguno da
> AccessDenied, revertir. Ese probe es el canario de esta regresión.

## 9. `PutItem` sobre no-repudio: qué garantiza IAM y qué no

El probe `nonrepudio-put-item` responde `ConditionalCheckFailedException`, **no**
AccessDenied: el runtime está autorizado a hacer `PutItem` sobre la tabla de
evidencia. Y debe estarlo — es quien escribe las firmas y el audit
(`kernel-store.js`).

El problema es que **IAM no distingue crear de pisar**. No existe condición IAM
que haga un `PutItem` insert-only. Demostrado sobre la tabla de coordinación (la
que sí admite limpieza, para no dejar residuo en la de no-repudio):

```
$ put-item PK=canary-5211 SK=probe v=1          → exit 0
$ put-item PK=canary-5211 SK=probe v=2-PISADO   → exit 0   (sin condición: PISA)
$ get-item PK=canary-5211 SK=probe --query Item.v.S
2-PISADO
$ put-item ... --condition-expression "attribute_not_exists(PK)"
ConditionalCheckFailedException
$ delete-item PK=canary-5211 SK=probe           → exit 0   (cleanup)
```

El reparto real de responsabilidades:

| Amenaza | Quién la frena |
|---|---|
| `UpdateItem` / `DeleteItem` / `BatchWriteItem` / `TransactWriteItems` / PartiQL | **IAM** — `Deny` explícito, verificado en §4 |
| `PutItem` que pisa una firma ya escrita | **Código** — `attribute_not_exists(PK)` en `kernel-store.js` |

La segunda fila es la delicada: si alguien saca esa `ConditionExpression`, el
append-only se rompe **en silencio** y ninguna policy lo detecta. Por eso
`kernel-store.test.js` afirma el **mecanismo** (que la escritura viaje con
`attribute_not_exists`), no sólo el comportamiento — un read-then-write,
vulnerable a TOCTOU, pasaría el test de colisión viejo pero no éste.

**Retirar `PutItem` no es opción**: dejaría al kernel sin registrar firmas.

## 10. Qué NO prueba esta matriz

- **No prueba CloudTrail.** No hay trail configurado; la trazabilidad de las
  llamadas KMS/DynamoDB queda fuera del alcance de #5211 (explícito en el issue).
- **No prueba la key policy aplicada contra el artefacto versionado.** El drift
  automático de §6 cubre la **identity** policy. La key policy necesita
  `kms:GetKeyPolicy`, que sólo responde al admin y **no está automatizado**: sigue
  siendo un paso de operador.
- **No modela SCPs, permission boundaries ni resource policies.** El evaluador
  razona sobre una identity policy. Alcanza para afirmar "esta policy deniega
  explícitamente X"; no alcanza para afirmar que algo esté permitido de punta a
  punta.
- **No prueba PITR ni deletion protection desde el runtime.** El principal no
  puede leerlos —que es justamente lo que CA-3 pide—; su estado está en §2,
  observado con el perfil que sí puede.

Un `AccessDenied` sobre un control **no** se cuenta como control verificado. Y un
`AccessDenied` sobre el recurso equivocado, tampoco.
