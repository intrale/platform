# Matriz empírica IAM/KMS del runtime durable (#5211)

> Evidencia de que el mínimo privilegio del principal runtime **está aplicado en
> AWS**, no sólo escrito en el repo. Corrida del **2026-08-06** con el perfil
> `kernel-runtime` sobre `us-east-2`. Todos los outputs van redactados: el
> account-id sale como `<ACCOUNT>` y el UUID de la CMK como `<CMK_ID>`.
>
> Reproducible: `node .pipeline/lib/kernel-iam-verify.js`

## Por qué esta matriz existe

`kernel-iam-policy.test.js` verifica que el JSON del repo **diga** lo correcto.
No puede verificar lo único que importa en producción: que AWS esté **aplicando**
esa policy sobre el principal real. Un JSON impecable en `docs/` y una policy
distinta adjunta al usuario es un estado posible y completamente silencioso.

Esta matriz es la contraparte empírica. Las dos se necesitan.

## Principal verificado (CA-1)

```
$ aws sts get-caller-identity --profile kernel-runtime
{
    "UserId": "<REDACTED>",
    "Account": "<ACCOUNT>",
    "Arn": "arn:aws:iam::<ACCOUNT>:user/intrale-kernel-runtime"
}
```

Las dos tablas y su cifrado, observados con ese mismo principal:

| Tabla | Rol | Estado | SSE |
|---|---|---|---|
| `intrale-kernel-state` | no-repudio (append-only) | ACTIVE | KMS · CMK compartida |
| `intrale-kernel-coordination` | coordinación (claims de fase) | ACTIVE | KMS · CMK compartida |

## CA-2 — Allow en coordinación, AccessDenied en no-repudio

Ejecutado por `kernel-iam-verify.js`: **13/13 probes en su expectativa**.

| Probe | Espera | Resultado observado |
|---|---|---|
| `coord-get-item` — lectura de claims | allow | `allowed` |
| `coord-put-item` — toma de claim | allow | `conditionFailed` (autorizado) |
| `coord-delete-item` — release de claim | allow | `conditionFailed` (autorizado) |
| `nonrepudio-get-item` — lectura de evidencia | allow | `allowed` |
| `nonrepudio-put-item` — append de firma/audit | allow | `conditionFailed` (autorizado) |
| `nonrepudio-update-item` | deny | **explicitDeny** |
| `nonrepudio-delete-item` | deny | **explicitDeny** |
| `nonrepudio-batch-write-item` | deny | **explicitDeny** |
| `nonrepudio-transact-write-items` | deny | **explicitDeny** |
| `nonrepudio-partiql-delete` | deny | **explicitDeny** |
| `ddb-list-tables` | deny | **explicitDeny** |
| `kms-describe-key` (uso directo de la CMK) | deny | implicitDeny |
| `iam-list-attached-user-policies` | deny | **explicitDeny** |

Los cinco caminos de escritura sobre no-repudio dan `explicit deny` de
`policy/IntraleKernelStore`. Muestra textual de uno:

```
$ aws dynamodb update-item --table-name intrale-kernel-state \
    --key '{"PK":{"S":"canary-5211"},"SK":{"S":"probe"}}' ... --profile kernel-runtime
An error occurred (AccessDeniedException) when calling the UpdateItem operation:
User: arn:aws:iam::<ACCOUNT>:user/intrale-kernel-runtime is not authorized to perform:
dynamodb:UpdateItem on resource: arn:aws:dynamodb:us-east-2:<ACCOUNT>:table/intrale-kernel-state
with an explicit deny in an identity-based policy: arn:aws:iam::<ACCOUNT>:policy/IntraleKernelStore
```

`TransactWriteItems` merece mención aparte: el mensaje delata que AWS lo evalúa
como `dynamodb:DeleteItem`, o sea que el `Deny` lo alcanza por la acción
subyacente y no por el nombre del verbo del CLI.

### Ningún probe dejó residuo

Todo probe mutante viaja con `ConditionExpression: attribute_exists(PK)` sobre
una clave canario que no existe. IAM evalúa la autorización **antes** que la
condición, así que el probe distingue Allow de Deny sin poder escribir nada.
Verificación posterior sobre ambas tablas: sin ítems `canary-5211*`.

## CA-3 — El runtime no administra tablas, CMK, policies ni PITR

Estos probes **no** los ejecuta el verificador: no admiten una condición que los
vuelva reversibles. Si el `Deny` regresara, el probe **es** el incidente (tabla
borrada, PITR apagado, escalada de privilegio). Se corrieron a mano el
2026-08-06 y quedan declarados en `CONTROL_PLANE_PROBES` con esta evidencia.

| Acción intentada | Resultado | Tipo |
|---|---|---|
| `dynamodb:CreateTable` | AccessDenied | **explicitDeny** · `policy/IntraleKernelStore` |
| `dynamodb:DeleteTable` | AccessDenied | implicitDeny |
| `dynamodb:UpdateTable` (apagar deletion protection) | AccessDenied | implicitDeny |
| `dynamodb:UpdateContinuousBackups` (apagar PITR) | AccessDenied | implicitDeny |
| `kms:ScheduleKeyDeletion` | AccessDenied | implicitDeny |
| `kms:DisableKey` | AccessDenied | implicitDeny |
| `kms:GetKeyPolicy` | AccessDenied | implicitDeny |
| `iam:AttachUserPolicy` (AdministratorAccess) | AccessDenied | **explicitDeny** · `policy/IntraleKernelStore` |

### El endurecimiento que trajo #5211

`implicitDeny` significa "falta un `Allow`". Está denegado hoy — pero se deshace
con que alguien agregue un `Allow` de más, y nadie se entera. Un `Deny` explícito
gana sobre cualquier `Allow` futuro.

Esa diferencia no es académica acá: **apagar PITR o deletion protection deja la
evidencia de no-repudio destruible por otra vía**. El append-only del plano de
datos no vale nada si el runtime puede tirar la tabla entera.

Por eso `kernel-iam-policy.json` suma dos statements: `DenyDynamoDbControlPlane`
(sobre `table/*` de la cuenta+región, para que tampoco pueda administrar una
tabla que se cree mañana) y `DenyKmsAdministration` + `DenyIamSelfAdministration`.

> **Pendiente del operador:** estos statements están en el artefacto versionado.
> Aplicarlos a `policy/IntraleKernelStore` requiere un principal con gestión IAM
> — el perfil `claude-code` no la tiene (`iam:ListAttachedUserPolicies` denegado),
> a propósito. Hasta que se apliquen, cuatro filas de arriba siguen en
> `implicitDeny`. La matriz vuelve a correrse después para confirmar el cambio.

## Hallazgo: dónde vive realmente el permiso de la CMK

La observación que abrió #5211 fue `grep -c "kms:" kernel-iam-policy.json` → **0**.
La lectura intuitiva era "faltan statements KMS en la identity policy".

Los probes muestran otra cosa:

- El runtime **escribe y lee** una tabla cifrada con CMK sin un solo statement
  `kms:` en su identity policy (round-trip put→get verificado).
- Y al mismo tiempo `kms:DescribeKey` **directo** le da AccessDenied.

Las dos cosas juntas sólo se explican de una forma, confirmada leyendo la key
policy con el perfil admin: la autorización vive en la **key policy de la CMK**,
statement `RuntimeUseViaDynamoDBOnly`, condicionada por
`kms:ViaService = dynamodb.<region>.amazonaws.com`. El descifrado ocurre como
efecto de una operación DynamoDB; cualquier uso directo de la clave cae.

**El diseño estaba bien; lo que faltaba era versionarlo.** Ese permiso no tenía
representación en el repo: nadie podía revisarlo en un PR ni notar que se
aflojara. Lo cierra `docs/pipeline/kernel-kms-key-policy.json`.

Corolario que quedó blindado con un test: **no** hay que agregar `kms:Decrypt` a
la identity policy. Sería privilegio redundante y además peligroso — en la
identity policy no está atado a `ViaService`, así que habilitaría usar la CMK
fuera de DynamoDB, que es exactamente lo que hoy está cerrado.

### Endurecimiento propuesto sobre la key policy

El statement aplicado hoy condiciona sólo por `ViaService`. Como **ambas tablas
comparten la CMK**, eso deja al runtime usar la clave vía DynamoDB sobre
cualquier otra tabla de la cuenta cifrada con ella. El artefacto versionado suma
`kms:EncryptionContext:aws:dynamodb:tableName` enumerando las dos tablas.

> **Verificación obligatoria antes de aplicar.** Esta condición es la que más
> riesgo de fail-closed tiene: si el nombre de la clave de encryption context no
> fuera el correcto, el store queda **ilegible** y el pipeline cae al primer read.
> No se pudo confirmar el nombre contra CloudTrail (no hay trail configurado —
> fuera del alcance de #5211). Procedimiento: aplicar, correr
> `node .pipeline/lib/kernel-iam-verify.js` y exigir `nonrepudio-get-item` y
> `coord-get-item` en `allowed`. Si alguno da AccessDenied, revertir el statement.
> Ese probe es el canario de esta regresión.

## `PutItem` sobre no-repudio: qué garantiza IAM y qué no

El probe `nonrepudio-put-item` responde `ConditionalCheckFailedException`, **no**
AccessDenied: el runtime está autorizado a hacer `PutItem` sobre la tabla de
evidencia. Y debe estarlo — es quien escribe las firmas y el audit
(`kernel-store.js`).

El problema es que **IAM no distingue crear de pisar**. No existe condición IAM
que haga un `PutItem` insert-only. Demostrado sobre la tabla de coordinación
(la que sí admite limpieza, para no dejar residuo en la de no-repudio):

```
$ put-item PK=canary-5211 SK=probe v=1          → exit 0
$ put-item PK=canary-5211 SK=probe v=2-PISADO   → exit 0   (sin condición: PISA)
$ get-item PK=canary-5211 SK=probe --query Item.v.S
2-PISADO
$ put-item ... --condition-expression "attribute_not_exists(PK)"
ConditionalCheckFailedException
$ delete-item PK=canary-5211 SK=probe           → exit 0   (cleanup)
```

O sea, el reparto real de responsabilidades:

| Amenaza | Quién la frena |
|---|---|
| `UpdateItem` / `DeleteItem` / `BatchWriteItem` / `TransactWriteItems` / PartiQL | **IAM** — `Deny` explícito, verificado arriba |
| `PutItem` que pisa una firma ya escrita | **Código** — `attribute_not_exists(PK)` en `kernel-store.js` |

La segunda fila es la que hay que cuidar: si alguien saca esa
`ConditionExpression`, el append-only se rompe **en silencio** y ninguna policy
lo detiene. Por eso `kernel-store.test.js` incorpora un test que afirma el
**mecanismo** (que la escritura viaje con `attribute_not_exists`), no sólo el
comportamiento — un read-then-write, vulnerable a TOCTOU, pasaría el test de
colisión viejo pero no éste.

**Retirar `PutItem` no es opción**: dejaría al kernel sin poder registrar firmas.

## Qué NO prueba esta matriz

- **No prueba CloudTrail.** No hay trail configurado; la trazabilidad de las
  llamadas KMS/DynamoDB queda fuera del alcance de #5211 (explícito en el issue).
- **No prueba la key policy aplicada contra el artefacto versionado.** El perfil
  disponible no tiene `kms:ListGrants`, y `kms:GetKeyPolicy` sólo responde al
  admin. La comparación es un paso de operador.
- **No prueba PITR ni deletion protection.** El principal runtime no puede
  leerlos — que es justamente lo que CA-3 pide. Su estado está verificado en
  `kernel-tablas-cutover-5210.md` con el perfil que sí puede.

Un `AccessDenied` sobre un control **no** se cuenta como control verificado.
