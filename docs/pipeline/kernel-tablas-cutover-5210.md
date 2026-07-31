# Tablas DynamoDB del cutover durable — evidencia y gap de verificación (#5210)

> **Alcance.** Las dos tablas del kernel **ya estaban aprovisionadas** en AWS
> cuando se abrió este trabajo (decisión del operador del 30/07 19:12). Lo que
> faltaba no era crearlas sino **probar su postura de seguridad** y documentar
> con honestidad **lo que el perfil acotado no deja probar**. Este documento es
> ese resultado.
>
> No activa persistencia durable: `kernel.durable` sigue en `false`.

Reproducir la verificación:

```bash
node .pipeline/lib/kernel-table-verify.js          # markdown
node .pipeline/lib/kernel-table-verify.js --json   # reporte estructurado
```

El verificador es **read-only por construcción**: tiene una allowlist de siete
comandos `describe`/`list`/`get`/`lookup` y rechaza cualquier otro *antes* de
spawnear. No crea tablas, no toca la CMK, no toca IAM — ese camino vive en
[#5203](https://github.com/intrale/platform/pull/5203)
(`kernel-aws-bootstrap.js`, `kernel-cmk-provision.js`) y no se reimplementa acá.

---

## 1. Configuración (CA-1)

`.pipeline/config.yaml`, sección `kernel:`

| Clave | Valor |
|---|---|
| `kernel.tableName` | `intrale-kernel-state` (no-repudio) |
| `kernel.coordinationTableName` | `intrale-kernel-coordination` (coordinación) |
| `kernel.region` | `us-east-2` |
| `kernel.durable` | `false` |

**Poblar los nombres no enciende nada.** Es la duda razonable que deja este
cambio, así que conviene ser explícito: el único switch del camino AWS es
`kernel.durable`. Con `false`, `pulpo.js` ni entra al bloque de boot durable, el
constructor del store es *lazy* y nunca se instancia un driver. Los nombres son
declarativos; `durable` es el interruptor. Hay dos tests que lo fijan
(`CA-5: config.yaml real mantiene kernel.durable en false` y
`CA-5: con durable:false el bootstrap resuelve por filesystem…`).

---

## 2. Evidencia verificable (CA-2)

Perfil `kernel-runtime`, región `us-east-2`. Account IDs y el UUID completo de la
clave KMS van enmascarados; se preservan servicio, región y nombre de recurso
porque sin eso la evidencia no probaría nada.

| Tabla | Rol | Existe | `TableStatus` | `SSEDescription.Status` | `SSEType` | `DeletionProtectionEnabled` |
|---|---|---|---|---|---|---|
| `intrale-kernel-state` | no-repudio | sí | `ACTIVE` | `ENABLED` | `KMS` | `true` |
| `intrale-kernel-coordination` | coordinación | sí | `ACTIVE` | `ENABLED` | `KMS` | `true` |

```
$ aws dynamodb describe-table --table-name intrale-kernel-state \
    --region us-east-2 --profile kernel-runtime
{
  "TableName": "intrale-kernel-state",
  "TableStatus": "ACTIVE",
  "TableArn": "arn:aws:dynamodb:us-east-2:<ACCT>:table/intrale-kernel-state",
  "BillingModeSummary": { "BillingMode": "PAY_PER_REQUEST" },
  "SSEDescription": {
    "Status": "ENABLED",
    "SSEType": "KMS",
    "KMSMasterKeyArn": "arn:aws:kms:us-east-2:<ACCT>:key/9d18ba4b-<REDACTED>"
  },
  "DeletionProtectionEnabled": true
}

$ aws dynamodb describe-table --table-name intrale-kernel-coordination \
    --region us-east-2 --profile kernel-runtime
{
  "TableName": "intrale-kernel-coordination",
  "TableStatus": "ACTIVE",
  "TableArn": "arn:aws:dynamodb:us-east-2:<ACCT>:table/intrale-kernel-coordination",
  "BillingModeSummary": { "BillingMode": "PAY_PER_REQUEST" },
  "SSEDescription": {
    "Status": "ENABLED",
    "SSEType": "KMS",
    "KMSMasterKeyArn": "arn:aws:kms:us-east-2:<ACCT>:key/9d18ba4b-<REDACTED>"
  },
  "DeletionProtectionEnabled": true
}
```

**Separación física confirmada:** dos `TableArn` distintos, misma región, sin
fallback a tabla compartida. `readKernelTablesConfig` falla *fail-closed* si
alguien llegara a apuntar las dos claves a la misma tabla.

**Ambas tablas comparten el mismo key ARN.** Es un hecho observado y vale
registrarlo porque tiene consecuencia operativa: una sola decisión sobre esa
clave afecta a las dos tablas. Ojo con la lectura de más — que exista un key ARN
concreto **no distingue** una CMK gestionada propia de la clave administrada por
AWS (`aws/dynamodb`), que también expone un ARN con UUID. Esa distinción es
exactamente lo que la sección siguiente **no** puede cerrar.

---

## 3. Gap de verificación — NO verificado (CA-3)

Estos controles **no se pudieron observar** con `kernel-runtime`. No están
verificados: no se declaran cumplidos ni incumplidos. Se documentan con el
comando exacto y el tipo de denegación.

| Control | Comando | Tipo de deny | ¿Se destraba agregando permisos? |
|---|---|---|---|
| PITR — tabla de no-repudio | `aws dynamodb describe-continuous-backups --table-name intrale-kernel-state --region us-east-2 --profile kernel-runtime` | `implicitDeny` | **Sí** — falta un `Allow` |
| PITR — tabla de coordinación | `aws dynamodb describe-continuous-backups --table-name intrale-kernel-coordination --region us-east-2 --profile kernel-runtime` | `implicitDeny` | **Sí** — falta un `Allow` |
| TTL de coordinación | `aws dynamodb describe-time-to-live --table-name intrale-kernel-coordination --region us-east-2 --profile kernel-runtime` | `implicitDeny` | **Sí** — falta un `Allow` |
| Propiedad de la CMK | `aws kms describe-key --key-id <CMK> --region us-east-2 --profile kernel-runtime` | `implicitDeny` | **Sí** — falta un `Allow` |
| Rotación de la CMK | `aws kms get-key-rotation-status --key-id <CMK> --region us-east-2 --profile kernel-runtime` | `implicitDeny` | **Sí** — falta un `Allow` |
| Alias de la CMK | `aws kms list-aliases --key-id <CMK> --region us-east-2 --profile kernel-runtime` | **`explicitDeny`** en `policy/IntraleKernelStore` | **No** |
| Rastro CloudTrail | `aws cloudtrail lookup-events --region us-east-2 --profile kernel-runtime` | **`explicitDeny`** en `policy/IntraleKernelStore` | **No** |

Mensajes crudos (redactados):

```
$ aws dynamodb describe-continuous-backups --table-name intrale-kernel-state ...
AccessDeniedException: User: arn:aws:iam::<ACCT>:user/intrale-kernel-runtime is not
  authorized to perform: dynamodb:DescribeContinuousBackups on resource:
  arn:aws:dynamodb:us-east-2:<ACCT>:table/intrale-kernel-state
  because no identity-based policy allows the action              [implicitDeny]

$ aws kms describe-key --key-id <CMK> ...
AccessDeniedException: ... not authorized to perform: kms:DescribeKey ...
  because no identity-based policy allows the action              [implicitDeny]

$ aws kms list-aliases --key-id <CMK> ...
AccessDeniedException: ... not authorized to perform: kms:ListAliases on resource: *
  with an explicit deny in an identity-based policy:
  arn:aws:iam::<ACCT>:policy/IntraleKernelStore                   [explicitDeny]

$ aws cloudtrail lookup-events --region us-east-2 ...
AccessDeniedException: ... not authorized to perform: cloudtrail:LookupEvents
  with an explicit deny in an identity-based policy:
  arn:aws:iam::<ACCT>:policy/IntraleKernelStore                   [explicitDeny]
```

### Por qué la distinción importa

No es trivia de IAM: **cambia quién puede destrabarlo y cómo**.

- **`implicitDeny`** — no hay ningún `Allow` que cubra la acción. Se resuelve
  agregando el permiso de sólo lectura al perfil.
- **`explicitDeny`** — hay un `Deny` en `policy/IntraleKernelStore`. Un `Deny`
  explícito **gana sobre cualquier `Allow`**, así que agregar permisos **no hace
  nada**: hay que editar esa policy con un principal con gestión IAM.

Tratar los dos casos igual manda al operador a una remediación que, en dos de
los siete controles, no puede funcionar.

### La regla que este documento hace cumplir

Queda **prohibido** declarar PITR, propiedad de la CMK o rastro CloudTrail como
cumplidos sin haberlos observado. No es sólo una convención escrita: el
verificador marca esos controles con `verified: null` (que significa *no sé*, y
es un estado legítimo distinto de `false`) y `assertNoUnverifiedClaims` **tira**
si alguien mutara un gap a `verified: true` — el render aborta antes de imprimir
un verde falso. Está cubierto por tests.

El destrabe de los permisos de verificación se sigue por separado; no es alcance
de este issue.

### Nota metodológica

Un `NotFoundException` **no es evidencia de permisos**. La primera corrida contra
un key ID enmascarado devolvió `NotFound`, que puede leerse como denegación y no
lo es. Hay que repetir con el ARN real tomado de `SSEDescription.KMSMasterKeyArn`
— ahí sí aparece el `AccessDeniedException`. El verificador distingue los dos
casos (`classifyDeny` devuelve `error`, no un tipo de deny) y hay un test que lo
fija.

---

## 4. Retención y borrado de la tabla de coordinación (CA-4)

La tabla de coordinación **no hereda la política de inmutabilidad** de la de
no-repudio, y eso es deliberado: necesita `DeleteItem` para liberar claims. La
separación está en
[`kernel-iam-policy.md`](kernel-iam-policy.md); acá va sólo la postura de
retención.

| Aspecto | Tabla de no-repudio | Tabla de coordinación |
|---|---|---|
| Borrado normal | **Ninguno.** `Deny` incondicional sobre las 7 acciones de mutación | **Sí**, `DeleteItem` acotado por `Resource` a esta tabla |
| TTL de DynamoDB | No debe configurarse (sería una ruta de borrado sobre evidencia) | **No configurado** — ver abajo |
| Vencimiento | No aplica | Por **lease de aplicación**, no por TTL |
| Retención | Indefinida (no-repudio) | Acotada por el conjunto de claves, no por el tiempo |

### El vencimiento es de aplicación, no de DynamoDB

`claim(key, { owner, leaseMs })` escribe `expiresAt = now + leaseMs` **dentro del
ítem** y `leaseMs > 0` es obligatorio (un lease sin vencimiento sería un lock
huérfano permanente). Cuando un claim vence, el siguiente `claim()` lo **reclama
por update optimista** — lo sobrescribe, no espera a que nadie lo borre. El
resultado es que un claim vencido nunca bloquea: el vencimiento es efectivo en el
instante en que otro proceso lo necesita, sin depender de la latencia de barrido
de un TTL.

`release(key, { expectedOwner })` hace el `DeleteItem` real, condicionado a
ownership: un proceso no puede liberar el claim de otro.

### Por qué no hay TTL configurado, y por qué está bien

DynamoDB TTL sirve para tablas que **acumulan** ítems. Esta no: el espacio de
claves es acotado (un ítem por fase/ola/health), así que los claims se
**sobrescriben** en lugar de apilarse. Sumar un TTL agregaría una segunda ruta de
borrado —con su propia latencia de barrido, que AWS no garantiza inmediata— sobre
un mecanismo que ya vence de forma determinística en el `claim()`. Sería más
superficie, no más garantía.

**Esto es una decisión de diseño documentada, no una observación.** Con
`kernel-runtime`, `dynamodb:DescribeTimeToLive` da `implicitDeny` (ver §3), así
que el estado real del TTL en AWS **no está verificado**. Si el destrabe de
permisos revelara un TTL configurado sobre la tabla de coordinación, hay que
revisar esta postura; y si apareciera uno sobre la tabla de **no-repudio**, es un
hallazgo a escalar — sería una ruta de borrado sobre evidencia append-only.

### Procedimiento de limpieza

1. **Camino normal:** el dueño del claim llama `release(key, { expectedOwner })`.
   Es el único borrado esperado en régimen.
2. **Claim colgado** (el dueño murió sin liberar): no requiere intervención. El
   lease vence y el próximo `claim()` lo reclama.
3. **Purga manual** (excepcional, sólo operador): `DeleteItem` sobre las claves de
   coordinación afectadas, con la ventana de cutover cerrada. Nunca sobre la
   tabla de no-repudio — ahí el `Deny` incondicional lo impide por diseño, y es
   la garantía que hay que preservar.

---

## 5. Qué NO cubre este documento

- Activación durable (`kernel.durable: true`) — fuera de alcance.
- IAM de runtime, auditoría CloudTrail y migración de datos — fuera de alcance.
- Aprovisionamiento de tablas y CMK — vive en #5203, no se duplica acá (CA-7).
- El destrabe de los permisos de verificación de §3 — se sigue por separado.
