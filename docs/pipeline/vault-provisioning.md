# Runbook — provisión de secretos del vault

> Split 3/3 de **#5425** — **#5466**. Herramienta:
> `.pipeline/tools/vault-provision.js`.
>
> Consume el contrato canónico de nombres (**#5464**, `validateVaultNamespace`) y
> el port de escritura (**#5465**, `vault-provisioner.js`). El diseño del vault —
> jerarquía de nombres, criterio SSM vs Secrets Manager y policy IAM — vive en
> `docs/pipeline/vault-secretos-aws.md`.
>
> **Este repositorio es público.** Acá no hay ningún `projectId`, `hostId`,
> nombre de parámetro concreto, account id, id de CMK ni ARN real. Los ejemplos
> usan placeholders `<...>`. La policy le niega al rol de runtime la capacidad de
> **enumerar** el vault; publicar el catálogo de nombres se la devolvería gratis.

## Para qué sirve

Dar de alta o rotar **un** secreto del vault, a mano, desde una terminal, sin que
el valor toque el disco, el historial del shell, la tabla de procesos ni un log.

No sirve para: leer secretos (eso es el runtime, `secret-vault.js`), para el tier
`rotating` (vive en Secrets Manager, otro flujo) ni para cargas masivas.

## 1 · Identidad: dos principales, nunca uno

El vault tiene **dos identidades separadas**, y esta herramienta usa la que el
runtime no tiene:

| Principal | Permisos | Quién lo usa |
|---|---|---|
| **Provisión** (admin) | `ssm:PutParameter` sobre el namespace, uso de la CMK | Esta CLI, a mano, en el momento del alta o de la rotación |
| **Runtime** (read-only) | `ssm:GetParameter*` sobre el namespace | El pipeline, siempre. Tiene un `Deny` **explícito** sobre `ssm:PutParameter` |

Consecuencias operativas:

- **`--profile` es obligatorio y explícito.** Sin él, el SDK usaría la cadena de
  credenciales por defecto, que en el host del pipeline es la identidad
  **read-only** del runtime. La CLI no lo permite: prefiere fallar a escribir con
  la identidad equivocada.
- **La identidad efectiva se verifica contra STS** (`aws sts get-caller-identity`)
  y se compara con `--principal`. Si no coincide — o si no se puede verificar —
  se aborta **antes** de emitir una sola llamada a SSM. Declararse «provisioning»
  no alcanza.
- **Mínimo privilegio.** La política del principal de provisión debe limitar
  `ssm:PutParameter` al namespace/tier que resuelve la validación canónica y a la
  CMK esperada. No debe ampliar `VAULT_READONLY_COMMANDS` ni los drivers de
  lectura: son otra frontera y se quedan como están.

## 2 · Invocación segura

### Requisitos previos

- Perfil AWS de **provisión** configurado localmente (`~/.aws/config`).
- Id o ARN de la **CMK** del proyecto.
- ARN del **principal de provisión**.
- La sección `vault:` de `.pipeline/config.yaml` con `prefix`, `projectId` y —
  para el tier `host` — `hostId`. La región sale de `kernel.region`.

CMK y principal pueden venir del entorno (`VAULT_PROVISION_CMK`,
`VAULT_PROVISION_PRINCIPAL`) porque **no son secretos**. El perfil **no** admite
fallback de entorno: la identidad se declara en cada invocación.

### Alta interactiva (recomendada)

```bash
node .pipeline/tools/vault-provision.js \
  --tier=shared --scope=<nombre-logico> \
  --profile=<perfil-de-provision> \
  --cmk=<id-o-arn-de-la-cmk> \
  --principal=<arn-del-principal>
```

La CLI pide el valor por terminal **con el eco deshabilitado**: no se ve, no
queda en el historial y no aparece en `ps`.

### Carga no interactiva

Sólo cuando el valor ya vive en un gestor de contraseñas y puede canalizarse
directo:

```bash
<comando-que-imprime-el-secreto> | node .pipeline/tools/vault-provision.js \
  --tier=host --scope=<nombre-logico> \
  --profile=<perfil-de-provision> \
  --cmk=<id> --principal=<arn> --stdin
```

Se descarta **un** salto de línea final (el artefacto de `echo` y de los
here-docs). Los espacios interiores y los saltos intermedios se conservan: una
clave en PEM es multilínea y es un secreto legítimo.

### Lo que NUNCA hay que hacer

| ❌ | Por qué |
|---|---|
| `--value=<secreto>` | No existe y no va a existir. Un argumento queda en `ps`, en el historial y en el log de auditoría del SO. La CLI rechaza `--value`, `--secret`, `--password`, `--token`, `--valor`, `--clave` y `--pass` con un mensaje explícito. |
| `export SECRETO=... && ... --stdin <<< "$SECRETO"` | La variable se hereda a **todo** proceso hijo y queda en el entorno de la sesión. |
| `echo "<secreto>" \| ...` | Queda en el historial del shell. Si el shell lo respeta, un espacio inicial lo evita — pero es frágil. |
| Guardar el secreto en un archivo temporal y `cat`earlo | El archivo sobrevive al proceso y suele quedar fuera de los borrados. |
| Correr la CLI con el perfil del runtime | Falla por diseño (§1), pero el intento en sí ya indica un problema de procedimiento. |

## 3 · Estados y resultado

La salida lleva **sólo** estos campos, construidos uno por uno: nombre lógico,
tier, backend, path, estado, tipo y versión. Nunca el valor, ni su longitud, ni
su hash, ni la respuesta cruda de AWS.

| Estado | Cuándo | ¿Escribe? | Versión |
|---|---|---|---|
| `creado` | El nombre no existía | Sí | Arranca en 1 |
| `sin cambios` | Ya tenía **ese mismo** valor y ya era `SecureString` | **No** | No avanza |
| `sobrescrito` | Tenía un valor distinto **y** la sobrescritura fue autorizada | Sí | Avanza |

Un parámetro preexistente que **no** sea `SecureString` está en texto plano: aunque
el valor coincida, **no** cuenta como `sin cambios`. Repararlo es sobrescribir, y
sobrescribir exige autorización.

### Confirmación de sobrescritura

Si el nombre ya existe con un valor **distinto**, la CLI muestra el path real que
se va a pisar y exige escribir literalmente:

```
sobrescribir
```

Abortan **sin escribir**: cualquier otra respuesta (incluidas `s`, `si`, `yes` y
el `Enter` pelado), el EOF, una señal, y el vencimiento del tiempo de espera
(120 s).

`--yes` saltea la pregunta y **sólo** se lee de la línea de comandos: ninguna
variable de entorno ni detección de CI la activa. Sin terminal y sin `--yes`, un
overwrite aborta — nunca se asume el consentimiento.

Una **creación** limpia no pregunta nada. Es deliberado: si preguntara siempre,
el operador aprendería a confirmar por reflejo y la pregunta dejaría de proteger.

## 4 · Códigos de salida

| Código | Significado | ¿Llegó a AWS? |
|---|---|---|
| `0` | La operación terminó — leer el **estado** informado | Depende del estado |
| `1` | Uso: argumentos ausentes, desconocidos o mal formados | No |
| `2` | Entrada: valor vacío, sólo espacios, con controles o > 4096 bytes | No |
| `3` | Identidad: la efectiva no es la de `--principal`, o no se pudo verificar | No |
| `4` | Cancelado: sobrescritura no confirmada, EOF, señal o tiempo agotado | No escribió |
| `5` | Configuración: tier, namespace o CMK inválidos | No |
| `6` | Backend: SSM falló, o la verificación posterior no cerró | Sí — ver §5 |
| `7` | Interno: falla no prevista, ya sanitizada | Indeterminado — ver §5 |

Los códigos `1`–`5` garantizan que **no se emitió ni una llamada de escritura**.
Los códigos `6` y `7` no lo garantizan: hay que verificar el estado real.

## 5 · Recuperación

### Falló con código 6 o 7: no sé si escribió

La verificación posterior de la escritura lee la metadata **sin descifrar** y
exige `Type = SecureString` y que la versión **avance**. Si falló ahí, el
parámetro puede haber quedado escrito, a medias o intacto.

1. Consultar el estado real con el **perfil de lectura**, sin descifrar:
   ```bash
   aws ssm get-parameter --name <path> --profile <perfil-lectura> \
     --query 'Parameter.{Type:Type,Version:Version,Modified:LastModifiedDate}'
   ```
2. Si `Type` **no** es `SecureString`, el valor está en texto plano: tratarlo
   como **comprometido** y aplicar §5.3 antes de cualquier otra cosa.
3. Si la versión avanzó y el tipo es correcto, la escritura impactó: reintentar
   la misma provisión debe dar `sin cambios`. Eso confirma el cierre.
4. Si nada cambió, reintentar la provisión normalmente.

### Cargué el secreto equivocado en el nombre correcto

Volver a correr la CLI con el valor correcto y confirmar la sobrescritura. La
versión anterior deja de servirse, pero **sigue existiendo en el historial de
SSM**: si el valor equivocado era un secreto real de otro sistema, aplicar §5.3.

### 5.3 · Rotación en origen — el valor expuesto es un valor comprometido

Esta es la regla que manda sobre todas las demás.

Si un secreto se expuso — se tipeó como argumento, quedó en el historial, se
escribió en texto plano, se pegó en un chat, se cargó en el nombre equivocado o
apareció en un log — **no alcanza con corregir el vault**. Hay que:

1. **Rotar el secreto en el sistema que lo emite** (el proveedor, el IdP, la
   consola de AWS, el bot de Telegram — donde sea que nazca). Un secreto expuesto
   sigue siendo válido hasta que su emisor lo invalida; borrarlo del vault no lo
   revoca.
2. **Cargar el valor nuevo** con esta CLI.
3. **Reiniciar los consumidores** para que suelten la caché en memoria del
   runtime (TTL máximo: 300 s — puede esperarse ese tiempo en vez de reiniciar).
4. **Limpiar la exposición** donde haya quedado (historial del shell, log,
   mensaje), sabiendo que la limpieza es higiene, **no** remediación: la
   remediación fue el paso 1.

El orden importa. Rotar primero y cargar después deja una ventana corta de
credencial inválida; cargar primero y rotar después deja una ventana de
credencial **comprometida pero válida**, que es mucho peor.

### Cargué un secreto en el tier equivocado

`shared` y `host` son namespaces distintos y ambos quedan escritos. Hay que:

1. Cargar el valor en el tier correcto.
2. Borrar el parámetro del tier equivocado con el perfil de provisión
   (`aws ssm delete-parameter --name <path>`).
3. Si el tier equivocado era `shared`, el secreto estuvo visible para **todos**
   los hosts del proyecto: aplicar §5.3.

### La terminal quedó sin eco

No debería pasar: la CLI restaura el eco por el camino feliz, por el de error,
por el `finally` y desde los handlers de `SIGINT`/`SIGTERM`/`SIGHUP`. Si aun así
ocurre:

```bash
stty sane
```

## 6 · Garantías verificadas por tests

`.pipeline/tools/__tests__/vault-provision.test.js` (56 casos) cubre, con
**canarios únicos** por camino:

- El canario no aparece en stdout, stderr, mensajes de error ni argumentos del
  proceso — en los caminos exitosos (`creado`, `sin cambios`, `sobrescrito`) y en
  los fallidos (identidad denegada, overwrite denegado, error de backend).
- **Cero llamadas a AWS** ante stdin vacío o con sólo espacios, valor fuera de
  tamaño, CMK ausente, tier `rotating`, nombre lógico inválido, identidad
  distinta a la declarada y región ausente.
- El eco se restaura tras éxito, error, rechazo, `Ctrl-C` y cada una de las tres
  señales.
- Sólo la confirmación exacta o `--yes` explícito autorizan una sobrescritura;
  ninguna variable de entorno de CI la habilita.
- La salida sin color, y la salida con color despojada de ANSI, son idénticas.
- El sumidero de salida suprime cualquier mensaje que contuviera el valor,
  incluso partido por secuencias ANSI.

La suite corre **sin** el SDK de AWS instalado: el cliente se carga en forma
perezosa dentro del composition root real.

```bash
npm run test:pipeline
```
