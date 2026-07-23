# Policy IAM del store durable del kernel (least-privilege append-only)

> Split 1/3 de #4804 — #4820. Documenta la policy IAM de mínimo privilegio que
> respalda la tabla single-table del kernel (`kernel-store.js`). Es un artefacto
> del PR (CA-5 / CA-13): la garantía de no-repudio de firmas/auditoría debe vivir
> **a nivel IAM**, no sólo por convención de código.

## Archivo

- `docs/pipeline/kernel-iam-policy.json` — policy runtime del **principal del
  driver** (el que ejecuta `PutItem`/`GetItem`/`Query`). Los placeholders
  `REGION`/`ACCOUNT`/`TABLE` se resuelven al aplicar la policy con los valores
  que salen de la sección `kernel:` de `config.yaml` (jamás hardcodeados en el
  repo — CA-2 / A05).

## Principio: dos principales distintos

| Principal | Permisos | Quién |
|-----------|----------|-------|
| **Provisioning (admin)** | `CreateTable`, gestión IAM | Paso admin explícito (`kernel-provision.js`), corrido a mano con credenciales admin. **No** es el runtime. |
| **Runtime del driver** | Sólo `PutItem`/`GetItem`/`Query`/`ConditionCheckItem` (Allow) + `Deny` append-only | El proceso que instancia `createAwsCliDynamoDriver` cuando `kernel.durable: true`. |

El principal de runtime **no** lleva `CreateTable` ni gestión IAM: el
aprovisionamiento es un paso separado (least-privilege — A01).

## Append-only por IAM (CA-5 / SEC-A01 — el punto más crítico)

La integridad append-only de `signature#*` y `audit#*` se sostiene por **dos
capas** independientes de la convención de código:

1. **El Allow no concede `UpdateItem`/`DeleteItem`.** El runtime sólo puede
   crear (`PutItem`) y leer (`GetItem`/`Query`). Sobre firmas/audit, además,
   `kernel-store` escribe con `ConditionExpression attribute_not_exists(...)`
   (error tipado `ConditionalCheckFailedError`), de modo que un `PutItem` no
   puede pisar una firma existente.
2. **`Deny` explícito** sobre `UpdateItem`/`DeleteItem` para las claves
   `signature#*`/`audit#*`. En IAM, un `Deny` explícito **siempre gana** a
   cualquier `Allow` (aunque un cambio futuro amplíe el Allow por error, el
   `Deny` lo bloquea). Por eso el `Deny` es la garantía dura de no-repudio.

## Caveat técnico honesto sobre `dynamodb:LeadingKeys`

`dynamodb:LeadingKeys` en IAM condiciona por el valor de la **partition key
(PK)**, no por la sort key (SK). En el schema del kernel, `signature#*`/`audit#*`
son prefijos de **SK**; la PK es el `projectId`. IAM **no** ofrece una condición
nativa por prefijo de SK.

Consecuencia práctica y por qué la policy sigue siendo correcta para esta
fundación:

- La capa **primaria** de append-only es (1): el runtime simplemente **no tiene**
  `UpdateItem`/`DeleteItem` en su `Allow`. Eso ya hace inmutables a firmas y
  audit por falta de permiso, independientemente de la SK.
- El `Deny` (2) queda documentado como defensa-en-profundidad y como ancla
  explícita de la intención (CA-5). Su `Condition` por `LeadingKeys` debe
  revisarse/afinarse en las partes 2/3 de #4804, cuando se cablee el runtime que
  sí necesite `DeleteItem` acotado (p. ej. release de `claim#*`): en ese momento
  la separación fina se resuelve por **PK dedicada** (LeadingKeys por partición)
  y/o por un principal separado para operaciones de coordinación, no mezclando
  firmas/audit con claims en el mismo principal.

En esta entrega (flag `kernel.durable: false`) **no hay runtime activo**: la
policy es un artefacto documental/de bootstrap, sin blast radius.

## Aplicación (paso admin, fuera del boot del pulpo)

```bash
# Con credenciales AWS admin en el ambiente (scope `aws`) y kernel.tableName
# definido en config.yaml:
node .pipeline/lib/kernel-provision.js     # crea la tabla + evidencia round-trip

# La policy se adjunta al rol/usuario de runtime con los valores reales:
#   REGION  → kernel.region
#   TABLE   → kernel.tableName
#   ACCOUNT → account-id de la cuenta destino (nunca commiteado)
```
