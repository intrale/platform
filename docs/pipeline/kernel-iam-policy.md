# Policy IAM del store durable del kernel (least-privilege append-only)

> Split 1/3 de #4804 — #4820. Documenta la policy IAM de mínimo privilegio que
> respalda la tabla single-table del kernel (`kernel-store.js`). Es un artefacto
> del PR (CA-5 / CA-13): la garantía de no-repudio de firmas/auditoría debe vivir
> **a nivel IAM**, no sólo por convención de código.
>
> **Actualizado por #5124** — la coordinación (claims de fase) salió de la tabla
> de no-repudio. Con eso el `Deny` pasó a ser **incondicional** y por lo tanto
> efectivo. Ver "Qué cambió en #5124" más abajo.

## Archivos

- `docs/pipeline/kernel-iam-policy.json` — policy runtime del **principal del
  driver**. Los placeholders `REGION`/`ACCOUNT`/`TABLE`/`COORD_TABLE` se resuelven
  al aplicar la policy con los valores que salen de la sección `kernel:` de
  `config.yaml` (jamás hardcodeados en el repo — CA-2 / A05).
- `.pipeline/lib/__tests__/kernel-iam-policy.test.js` — verifica la policy **como
  dato**: que el `Deny` cubra las 7 acciones de mutación y no lleve `Condition`,
  que ningún `Allow` con borrado tenga wildcard en su `Resource`, y que los
  placeholders sigan intactos. Un JSON de policy no falla al leerse: si miente,
  miente en silencio. Por eso se testea.

## Principio: dos principales distintos

| Principal | Permisos | Quién |
|-----------|----------|-------|
| **Provisioning (admin)** | `CreateTable`, gestión IAM | Paso admin explícito (`kernel-provision.js`), corrido a mano con credenciales admin. **No** es el runtime. |
| **Runtime del driver** | `PutItem`/`GetItem`/`Query`/`ConditionCheckItem` sobre la tabla de no-repudio + `Deny` de mutación sobre esa misma tabla + `Get`/`Put`/`Delete`/`ConditionCheck` sobre la tabla de **coordinación** | El proceso que instancia `createAwsCliDynamoDriver` cuando `kernel.durable: true`. |

El principal de runtime **no** lleva `CreateTable` ni gestión IAM: el
aprovisionamiento es un paso separado (least-privilege — A01).

## Dos tablas, y por qué (#5124)

| Tabla | Config | Qué guarda | Borrado |
|-------|--------|------------|---------|
| **No-repudio** | `kernel.tableName` | descriptores, catálogo, productos, `signature#*`, `audit#*` | **Nunca.** `Deny` incondicional sobre las 7 acciones de mutación. |
| **Coordinación** | `kernel.coordinationTableName` | claims de fase, cuotas, `waves`/`blocked`/`health` | **Sí**, acotado por `Resource` a esta tabla (el `release()` de un claim borra el ítem). |

La separación es por **`Resource`**, no por prefijo de clave. Es la única forma
que IAM soporta de manera nativa: el scoping por prefijo de **sort key** no
existe (ver el caveat de `LeadingKeys` abajo).

## Append-only por IAM (CA-5 / SEC-A01 — el punto más crítico)

Es importante separar **qué está enforced** de **qué es defensa en profundidad**,
en ese orden. Documentación que promete de más es peor que documentación que
falta: hace que la próxima persona no vuelva a verificar.

### Capa 1 — deny-by-default (esto SIEMPRE estuvo enforced)

**El `Allow` no concede `UpdateItem`/`DeleteItem` sobre la tabla de no-repudio.**
El runtime sólo puede crear (`PutItem`) y leer (`GetItem`/`Query`). En IAM, lo
que no se concede está denegado. Ésta es —y siempre fue— la capa que realmente
hacía inmutables a firmas y audit.

Encima, `kernel-store` escribe firmas/audit con
`ConditionExpression attribute_not_exists(...)` (error tipado
`ConditionalCheckFailedError`), de modo que un `PutItem` no puede pisar una firma
existente. Eso es convención de código, no garantía: refuerza, no sostiene.

### Capa 2 — `Deny` explícito (esto NO estaba enforced hasta #5124)

Un `Deny` explícito **siempre gana** a cualquier `Allow`. Existe justamente para
sobrevivir a *"un cambio futuro que amplíe el `Allow` por error"* — y #5125 es
literalmente una migración de datos, o sea el escenario donde alguien agrega
`BatchWriteItem` sin pensarlo dos veces.

**Antes de #5124 esta capa no aportaba nada**, por dos motivos independientes:

1. Estaba condicionada por `dynamodb:LeadingKeys` con patrones
   `signature#*`/`audit#*`, que **no matchean nunca** (ver caveat abajo).
2. Denegaba **2** acciones (`UpdateItem`, `DeleteItem`) de las **7** que en
   DynamoDB permiten borrar o pisar un ítem.

Nada dependía de esa capa —la 1 hacía todo el trabajo—, así que no hubo
vulnerabilidad explotable; pero la doc afirmaba una garantía que no existía.

Hoy el `Deny` es **incondicional** sobre `table/TABLE` y cubre las 7 acciones:

| Camino de escritura | Acción IAM |
|---|---|
| `UpdateItem` | `dynamodb:UpdateItem` |
| `DeleteItem` | `dynamodb:DeleteItem` |
| `BatchWriteItem` con `DeleteRequest` | `dynamodb:BatchWriteItem` |
| `TransactWriteItems` con `Delete`/`Update` | `dynamodb:TransactWriteItems` |
| PartiQL `UPDATE` | `dynamodb:PartiQLUpdate` |
| PartiQL `DELETE FROM` | `dynamodb:PartiQLDelete` |
| PartiQL `INSERT` | `dynamodb:PartiQLInsert` |

Verificado que un `Deny` sin `Condition` no rompe nada legítimo: tras retirar
`claim()`, `kernel-store.js` **no invoca `deleteItem` en ningún lado** (hay un
test que lo afirma sobre la fuente), no hay ningún `updateItem`, y `ensureTable()`
no crea tabla con el driver real, así que tampoco hace falta `CreateTable`.

## Caveat técnico sobre `dynamodb:LeadingKeys` — resuelto en #5124

`dynamodb:LeadingKeys` condiciona por el valor de la **partition key (PK)**, no
por la sort key (SK). En el schema del kernel, `signature#*`/`audit#*`/`claim#*`
son prefijos de **SK**; la PK es el `projectId`. IAM **no** ofrece —ni ofrecía—
una condición nativa por prefijo de SK. La `Condition` original, por lo tanto,
no podía matchear jamás.

Esta sección ya documentaba el problema con honestidad y anticipaba la salida
("PK dedicada … y/o un principal separado para operaciones de coordinación").
**#5124 cerró el loop, por la tercera vía: separación por `Resource`.**

- **Descartado — PK dedicada (`<projectId>#coord`).** El contrato de datos
  (`.pipeline/contracts/kernel-store.schema.json`) fija
  `PK.pattern = ^[a-z0-9][a-z0-9-]{1,63}$` (no admite `#`), y `kernel-store.js`
  exige `raw.PK === contextProjectId` como chequeo **anti-IDOR**. Se pagarían dos
  defensas reales a cambio de un scoping por prefijo de SK que IAM no ofrece de
  ninguna forma. **Prohibido parchear el `pattern` del schema para colar `#`.**
- **Adoptado — separación por `Resource`.** IAM scopea por **tabla** de forma
  nativa. Los claims se mudaron a la tabla de coordinación, la de no-repudio dejó
  de contener claims, y con eso el `Deny` no necesita `Condition`. Un `Deny` sin
  condición es trivialmente efectivo y **no puede volver a quedar inerte** por un
  cambio de schema.

> La versión anterior de esta sección prometía, para las partes 2/3 de #4804, un
> `DeleteItem` acotado sobre la misma tabla para el *"release de `claim#*`"*. **Ese
> futuro ya no llega y no debe intentarse:** no hay forma de acotar `DeleteItem`
> por prefijo de SK, así que concederlo sobre la tabla de no-repudio lo concedería
> sobre firmas y audit también. El `DeleteItem` legítimo del release vive ahora en
> el `Allow` de la tabla de coordinación.

## Qué cambió en #5124 (Opción B′-1)

`claim()` se **retiró** de `kernel-store.js`. La coordinación vive en
`kernel-coordination-store.js`, que ya corría sobre tabla dedicada. Motivos:

1. **Hace efectivo el `Deny`** — es el punto de arriba.
2. **Arregla un modo de falla permanente.** El claim viejo escribía
   `claimedUntil` anidado en `body` pero lo referenciaba como atributo top-level
   en su `ConditionExpression`. Contra DynamoDB real, comparar un atributo
   inexistente da `false`: la condición colapsaba a
   `attribute_not_exists(PK) OR false` y **fallaba para todo claim existente**,
   cayendo a un `deleteItem` desnudo que el `Allow` no concedía →
   `AccessDeniedException`. En criollo: **el primer agente que muriera con un
   claim tomado dejaba esa fase trabada para siempre.**
3. **Elimina el TOCTOU y la dependencia del reloj del cliente.** El camino viejo
   era read-then-delete comparando contra `Date.now()` local: drift de NTP entre
   dos hosts alcanzaba para robar un lease **vigente**. El coordination store
   reclama por `compareAndSet` sobre **versión** (fencing token), inmune al drift,
   y su `release()` es un delete condicional por ownership.
4. **Cero cambios al contrato de datos.** El invariante `PK === projectId` queda
   intacto, y con él `assertSameProject`, `keyOf` y el chequeo anti-IDOR de
   `validateItemOnRead`. El diff del schema es vacío.

### Patrón de reemplazo — cómo se toma un claim de fase

No reinventar el claim sobre la tabla de no-repudio. El patrón es:

```js
const { describeClaimFailure } = require('./kernel-coordination-store');

const key = `phase-${phase}`;                 // p.ej. 'phase-dev'
const res = await coord.claim(key, { owner: instanceId, leaseMs });
if (!res.ok) {
  // NUNCA interpolar res.owner/res.expiresAt a mano: la rama de conflicto de
  // versión no los devuelve y el mensaje sale "tomada por undefined".
  log(describeClaimFailure(key, res));        // "fase dev tomada por inst-a, lease vence en 42s"
  return;
}
// …trabajo de la fase…
await coord.release(key, { expectedOwner: instanceId });
```

`phase-<fase>` es una clave válida: `assertSafeKey` exige `isSafeId`
(`^[a-z0-9][a-z0-9-]{1,63}$`) y rechaza las reservadas (`waves`/`blocked`/`health`).

> El `entityType: "claim"` y `claimBody` **siguen en el schema** a propósito: se
> necesitan para poder **leer** ítems legacy escritos antes de esta separación.
> Nada los escribe ya. Su retiro del schema es alcance de la migración (#5125).

## Aplicación (paso admin, fuera del boot del pulpo)

**Desde #5124 son DOS tablas.** Aprovisionar sólo la de no-repudio deja el
pipeline aparentemente sano: el boot no falla, y el fail-closed aparece recién
**al primer claim de fase**, en runtime, cuando ya hay trabajo en vuelo.

```bash
# Con credenciales AWS admin en el ambiente (scope `aws`) y kernel.tableName /
# kernel.coordinationTableName definidos en .pipeline/config.yaml:
node .pipeline/lib/kernel-provision.js     # crea la tabla + evidencia round-trip

# La policy se adjunta al rol/usuario de runtime con los valores reales:
#   REGION      → kernel.region
#   TABLE       → kernel.tableName               (no-repudio; sin borrado)
#   COORD_TABLE → kernel.coordinationTableName   (coordinación; con borrado)
#   ACCOUNT     → account-id de la cuenta destino (nunca commiteado)
```

Al resolver los placeholders, **dos reglas que no se negocian**:

- **ARNs literales.** Escribir `table/TABLE*` "por comodidad" en el `Allow` de
  coordinación hace que ese wildcard vuelva a alcanzar `table/TABLE`: el borrado
  queda concedido sobre firmas y audit, y toda la separación se deshace en una
  línea con apariencia de estar resuelta.
- **Simétricamente, el `Deny` tampoco puede llevar `Resource` amplio.** Alcanzaría
  la tabla de coordinación y, como el `Deny` siempre gana, el `release()` de un
  claim quedaría bloqueado para siempre — el mismo bug, del otro lado.

Ambas reglas están cubiertas por assertions en `kernel-iam-policy.test.js`.

### Handoff al cutover (#5126)

`kernel-provision.js` lee hoy **sólo** `cfg.tableName` y crea **una** tabla. El
cutover tiene que contemplar **dos**: aprovisionar la segunda tabla y ampliar el
provisioner es alcance de #5126 (requiere credenciales AWS), no de #5124. Queda
escrito acá para que #5126 no arranque con una premisa incompleta.

Mientras `kernel.durable: false` (default) **no hay runtime activo**: la policy es
un artefacto documental/de bootstrap, sin blast radius.
