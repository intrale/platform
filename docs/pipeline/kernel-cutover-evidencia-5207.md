# Cutover durable — evidencia consolidada del paraguas (#5207)

> **Qué es este documento.** #5207 es el *paraguas* de un split: el trabajo
> funcional lo entregaron #5210 (tablas), #5211 (IAM/KMS) y #5212 (CloudTrail y
> fail-closed), las tres cerradas y mergeadas. Lo que quedaba pendiente no era
> reimplementar nada, sino **demostrar los 5 criterios de aceptación contra el
> HEAD actual con evidencia redactada y reproducible**, y cerrar los huecos que
> aparecieran al intentarlo.
>
> Aparecieron dos. Están documentados en la §6.

- **Verificado sobre:** `origin/main` @ `8d782c0b7` + los cambios de esta entrega
- **Fecha:** 2026-09-04
- **Estado del fail-safe:** `kernel.durable: false` (`.pipeline/config.yaml:1747`)

---

## 1. Las tres identidades AWS en juego

Confundirlas invalida la evidencia, así que van primero. Ninguna puede probar lo
que prueban las otras dos:

| Perfil | Principal | Para qué se usa |
|---|---|---|
| `kernel-runtime` | `user/intrale-kernel-runtime` | El runtime durable real. Prueba lo que **NO** puede hacer (pruebas negativas). |
| `intrale` | `user/claude-code` | Admin de **sólo lectura**. Prueba que los controles **están**. Nunca muta nada. |
| — | — | Ningún paso de esta verificación usa credenciales administrativas de escritura. |

La separación es el punto: el runtime no puede leer PITR ni la CMK —y ese
`AccessDenied` es *en sí mismo* la evidencia del mínimo privilegio del CA de
IAM—, así que el control se lee con la otra identidad. Aflojarle permisos al
runtime para que pudiera auditarse a sí mismo habría destruido el control que se
quería demostrar.

## 2. CA-1 · Dos tablas, policy y principal runtime confirmados

```
$ aws sts get-caller-identity            # perfil intrale
{ "Arn": "arn:aws:iam::<ACCOUNT-ID>:user/claude-code" }

$ aws sts get-caller-identity --profile kernel-runtime
{ "Arn": "arn:aws:iam::<ACCOUNT-ID>:user/intrale-kernel-runtime" }
```

Sin exposición de account-id ni credenciales: toda salida pasa por
`redactAwsEvidence`, que enmascara los 12 dígitos y trunca el UUID de la CMK
conservando el prefijo correlacionable.

Las dos tablas son **distintas** y así lo exige el código: `readKernelTablesConfig`
falla cerrado si `kernel.tableName === kernel.coordinationTableName`, porque la
inmutabilidad append-only es de la tabla de no-repudio y coordinación necesita
`DeleteItem` para liberar claims.

## 3. CA-2 · Outputs redactados de cada control

Reproducible con `node .pipeline/lib/kernel-table-verify.js`:

| Control | Observado | Identidad |
|---|---|---|
| Existencia + status de ambas tablas | `ACTIVE` / `ACTIVE` | `kernel-runtime` |
| SSE | `ENABLED` · tipo `KMS` (ambas) | `kernel-runtime` |
| Deletion protection | `true` (ambas) | `kernel-runtime` |
| PITR — no-repudio | `ENABLED`, retención **35 días** | `intrale` |
| PITR — coordinación | `DISABLED` — postura deliberada (tabla efímera) | `intrale` |
| TTL — coordinación | `DISABLED` — ver §4 | `intrale` |
| Propiedad de la CMK | `KeyManager: CUSTOMER`, `Enabled` | `intrale` |
| Alias de la CMK | `alias/intrale-kernel-store` | `intrale` |

`KeyManager: CUSTOMER` es el dato decisivo: un `describe-table` **no distingue**
una CMK propia de la clave `aws/dynamodb` administrada por AWS. Sin leerlo, "SSE
tipo KMS" no prueba que la clave sea nuestra.

### CloudTrail — postura del destino

Reproducible con `node .pipeline/lib/kernel-cloudtrail-provision.js --verify`.
Los 11 controles de `verifyDestinationPosture` en verde:

```
trailLogging: true               managementEventsReadWrite: true
trailRegion: true                bucketPrivate: true
logFileValidation: true          bucketEncrypted: true
tlsOnly: true                    destinationKeySeparateFromCmk: true
retentionDeclared: true          runtimeDeniedOnDestination: true
auditorAccessSeparated: true
posturaCompleta = true
```

`destinationKeySeparateFromCmk` y `runtimeDeniedOnDestination` son los dos que
importan para no-repudio: el destino de auditoría **no** se cifra con la misma
CMK que audita (si no, perder la clave se llevaría también su propio rastro), y
el runtime tiene `Deny` explícito para escribir, borrar o siquiera leer el rastro
que él mismo genera.

### Permisos Allow/Deny diferenciados

Reproducible con `node .pipeline/lib/kernel-iam-verify.js`. 19 probes ejecutados
contra AWS con el principal runtime real:

- **Allow donde debe:** lectura/escritura de coordinación (incluido `DeleteItem`),
  lectura de no-repudio y `PutItem` de evidencia — el runtime **sí** escribe firmas.
- **Deny explícito donde debe:** `UpdateItem`, `DeleteItem`, `BatchWriteItem`,
  `TransactWriteItems` y PartiQL `DELETE` sobre `signature#*` / `audit#*`.
- Ninguna operación quedó autorizada indebidamente (**0 controles abiertos**).

Todo probe mutante viaja con una condición imposible: se prueba la *autorización*
sin llegar a mutar nada.

## 4. Por qué coordinación no tiene PITR ni TTL

No es un olvido, y conviene dejarlo escrito porque un `DISABLED` en una tabla
siempre parece un hallazgo:

- **PITR `DISABLED`** — coordinación es efímera: sólo guarda claims de fase vivos.
  Restaurarla a un punto del pasado reinstalaría claims ya liberados, que es peor
  que perderla. La tabla que necesita recuperabilidad es la de no-repudio, y ahí
  PITR está `ENABLED` con 35 días.
- **TTL `DISABLED`** — el espacio de claves es acotado y los claims se
  **sobrescriben** en vez de apilarse, así que no hay acumulación que expirar. Un
  TTL agregaría una segunda ruta de borrado sin resolver ningún problema real.
  El vencimiento es por *lease de aplicación*, no por TTL.

Detalle completo en `kernel-tablas-cutover-5210.md` §4.

## 5. CA-3 y CA-4 · Arranque

**CA-3 — `durable: false` completa una fase desde filesystem.** Verificado por
partida doble: el test `CA-5: con durable:false el bootstrap resuelve por
filesystem y no instancia el store` y el smoke test del pipeline en vivo
(`=== SMOKE TEST OK ===`, pulpo + dashboard + telegram arriba, dashboard HTTP
200). El camino durable está gateado por `durable === true` y el store se carga
*lazy*: con el flag apagado no se construye driver ni se emite una sola llamada
a DynamoDB.

**CA-4 — fail-closed sin fallback.** Ejecutado, no leído:

```
[ausente]     -> ABORTA | code: KERNEL_DURABLE_CONFIG_INVALID | exit: 78 | reason: missing
[vacio]       -> ABORTA | code: KERNEL_DURABLE_CONFIG_INVALID | exit: 78 | reason: empty
[whitespace]  -> ABORTA | code: KERNEL_DURABLE_CONFIG_INVALID | exit: 78 | reason: whitespace
[valido]      -> OK (no aborta)
[durable off] -> OK (no aborta)

Arranque abortado: falta 'kernel.tableName' en .pipeline/config.yaml. El modo
durable (kernel.durable: true) no arranca sin nombre de tabla y no cae a
filesystem. Completá la clave con el nombre de la tabla y reintentá.
Detalle: docs/pipeline/runbook-cutover-durable.md
```

Exit 78 = `EX_CONFIG` de sysexits(3). El mensaje es **constante** para las tres
variantes (la variante viaja en el campo estructurado `reason`, no en el texto)
para no volcar configuración, y coincide carácter por carácter con el texto del
runbook: quien copia el error del log y lo busca en la doc, lo encuentra.

## 6. Los dos huecos que aparecieron al verificar

Consolidar no fue sólo pegar outputs. Al ejecutar las herramientas contra HEAD
aparecieron dos defectos reales, ambos corregidos en esta entrega:

### 6.1 La verificación de CloudTrail estaba rota (fallo mudo)

`kernel-cloudtrail-provision --verify` abortaba con:

```
kernel-cloudtrail-provision: aws s3api list-objects-v2 falló:
```

...y nada después. La causa no era AWS: el bucket del trail acumula desde
2026-08-05 y su listado completo ya pesa **1.108.628 bytes**, por encima del
`maxBuffer` de 1 MiB que `spawnSync` usa por defecto. Al desbordar, Node devuelve
`status: null` y **no llena `stderr`** — el detalle queda en `result.error.code`
(`ENOBUFS`), que `runAws` no miraba.

Es el peor modo de falla para una herramienta de auditoría: un error mudo se lee
como "AWS denegó" y manda a investigar permisos por un desborde local de buffer.

Corregido en tres capas, porque subir el buffer solo mueve la pared de sitio:

1. `runAws` ahora inspecciona `result.error` y reporta `ENOBUFS`/`ENOENT` con
   diagnóstico, en vez de interpolar un `stderr` vacío.
2. `maxBuffer` explícito de 64 MiB.
3. **Fix de raíz:** el listado se acota por prefijo de día (`YYYY/MM/DD` en UTC,
   como particiona CloudTrail), moviendo el filtro al servidor.

Post-fix: postura completa `true` y 83 objetos listados en la ventana de 24 h.

**Precisión sobre `NextToken` (corregida tras el review del 2026-09-05).** El
bucle de paginación de `listPrefixPaginado` **no** fue lo que arregló este fallo,
y la redacción anterior de este párrafo afirmaba lo contrario. Sin
`--max-items`/`--page-size`, el AWS CLI pagina internamente y devuelve todas las
claves en una sola salida **sin emitir `NextToken`** — por eso el síntoma era una
salida gigante que desbordaba el buffer, no un listado corto. El bucle queda como
cinturón para que agregar mañana un `--max-items` (o migrar al SDK, que sí corta
en 1000 y sí emite el token) no reintroduzca un listado incompleto en silencio,
que es el modo de falla más peligroso acá: "no encontré el evento" indistinguible
de "el control nunca se ejerció".

### 6.1.b El tope de la ventana recortaba el presente

Detectado por el mismo review, ejecutando el módulo. `trailDayPrefixes` recorría
desde `desde` hacia adelante y cortaba al llegar a 32 días, o sea que descartaba
el extremo **reciente**: con `--since` de 60 días devolvía los 32 días más
viejos y **dejaba fuera el día de hoy**, justo donde está el evento recién
emitido. `verifyKmsEventsFromTrail` no encontraba nada y `--verify` salía con
exit 2 ("falta evidencia, reintentar") cuando reintentar no podía servir nunca.

Corregido en `trailDayWindow`: el recorte se hace desde el extremo **viejo**
(últimos `MAX_DIAS_VENTANA` hasta `hasta`, con el presente siempre incluido) y el
truncamiento se **reporta** por `stderr`, para que acotar la ventana pedida no
sea una decisión silenciosa. Cubierto por
`kernel-cloudtrail-listado-5207.test.js` §2.b.

### 6.2 El CA-2 no era demostrable por herramienta

PITR, propiedad de la CMK y TTL quedaban como *gap no verificado* porque el
perfil runtime no puede leerlos. Correcto por mínimo privilegio, pero dejaba al
CA-2 cerrándose a mano con comandos pegados en un issue — sin reproducibilidad y
sin fusible.

`kernel-table-verify` ahora hace una **segunda pasada** con
`kernel.iamAdminProfile` (el mismo perfil admin de sólo lectura que
`kernel-iam-verify` ya usaba para detectar drift). El fail-closed no se aflojó:

- Sin perfil admin configurado → todo sigue siendo gap.
- Si el admin también deniega → el control vuelve a `null` ("no sé").
- Si el output es válido pero **no trae el campo** del control → sigue sin cerrarse.
  Un HTTP 200 no es una observación.
- El fusible `assertNoUnverifiedClaims` ya no prohíbe `verified: true` de plano:
  prohíbe un `true` **sin la evidencia y la identidad que la leyó**. La regla de
  fondo es la misma de #5210; lo que cambió es que ahora existe una identidad
  legítima capaz de observar.

De 7 gaps quedan 2, ambos legítimos: CloudTrail (se prueba mejor con
`--verify`, que valida 11 controles de postura en vez de un `lookup-events` que
devuelve 200 y parece probar lo mismo) y rotación de la CMK, que el perfil admin
tampoco pudo leer en esa corrida.

### 6.3 Observar un control no es demostrarlo (rebote rev-1)

El review del 2026-09-05 encontró que la segunda pasada de §6.2 marcaba
`verified: true` apenas lograba **observar** el control, sin mirar si el valor
observado **cumplía**. Ejecutado sobre un ambiente adverso —PITR `DISABLED` en la
tabla de no-repudio, la clave `aws/dynamodb` en lugar de una CMK propia, rotación
apagada— el módulo producía `gapsPendientes: 1`, todos los controles en verde y
una sección titulada *"el control queda igual demostrado"*.

Es el modo de falla que #5210 cerró (*"no pude verlo" ≠ "está bien"*) corrido un
casillero: *"lo vi" ≠ "cumple"*. Y pesa más, porque este artefacto es lo que
firma un operador.

**Ahora cada control declara su postura esperada** (`POSTURAS` en
`kernel-table-verify.js`) y `verified: true` exige las dos cosas: evidencia
observada **y** que satisfaga la postura.

| Control | Postura esperada | Por qué |
|---|---|---|
| PITR — no-repudio | `ENABLED` | Append-only y su contenido es la evidencia: sin PITR no hay recuperación |
| PITR — coordinación | `DISABLED` | Efímera: restaurarla reinstalaría claims ya liberados (§4) |
| TTL — coordinación | `DISABLED` | El vencimiento es por lease de aplicación, no por TTL (§4) |
| Propiedad de la CMK | `KeyManager = CUSTOMER`, habilitada | Es lo que separa una CMK propia de `aws/dynamodb` |
| Alias de la CMK | al menos uno fuera de `alias/aws/*` | Contraparte observable de `KeyManager = CUSTOMER` |
| Rotación de la CMK | `KeyRotationEnabled = true` | Sin rotación el material de la clave no cambia nunca |

Consecuencias en el artefacto:

- Un control leído que **no** cumple queda en `estado: 'observado-incumple'` con
  `verified: false`, **cuenta en `gapsPendientes`** y sale en una sección propia
  del markdown que dice que incumple — no en la de verificados.
- El JSON suma `posturasIncumplidas` y `ca2Cerrado`, para que un ambiente en rojo
  no quede disuelto en un `gapsPendientes` bajo.
- El fusible también exige `postura.cumple === true`: un verde plantado a mano con
  evidencia que incumple **aborta el render**.
- **Fail-closed sobre el catálogo:** un control observado sin postura declarada
  tampoco cierra (`observado-sin-postura`).
- El CLI sale con exit `1` si hay posturas incumplidas: ese exit code termina en
  un gate y no puede leerse como "el ambiente cumple".

**El endurecimiento no invalida la evidencia previa.** Aplicando las posturas a
los valores ya observados en §3, los cinco controles cumplen:

```
pitr-no-repudio      cumple= true | PointInTimeRecoveryStatus = ENABLED
pitr-coordinacion    cumple= true | PointInTimeRecoveryStatus = DISABLED (postura documentada · §4)
ttl-coordinacion     cumple= true | TimeToLiveStatus = DISABLED (postura documentada · §4)
cmk-propiedad        cumple= true | KeyManager = CUSTOMER, con la clave habilitada
cmk-alias            cumple= true | al menos un alias propio, fuera del espacio `alias/aws/*`
```

Si en una corrida futura la rotación se pudiera leer y estuviera apagada, la
salida es **documentar esa decisión y actualizar la postura** —como se hizo con
PITR/TTL de coordinación—, no dejar el control rotulado como demostrado.

## 7. Lo que esta entrega NO hace

- **No enciende el modo durable.** `kernel.durable: false` sigue intacto en HEAD.
- **No migra datos** ni ejecuta el cutover. Eso es alcance de #5126.
- **No muta infraestructura AWS.** Todas las herramientas usadas acá son
  read-only por construcción: `kernel-table-verify` rechaza cualquier verbo fuera
  de su allowlist *antes* de spawnear.
- **No cierra el drift IAM.** `kernel-iam-verify` reporta 4 statements `Deny`
  presentes en el artefacto versionado y ausentes de la policy `v3` hoy adjunta
  (`DenyDynamoDbControlPlane`, `DenyDynamoDbAccountLevelControlPlane`,
  `DenyKmsAdministration`, `DenyIamSelfAdministration`). Ese endurecimiento
  pendiente es lo que mantiene 7 controles en `implicitDeny` en vez de
  `explicitDeny`. **Nada está autorizado indebidamente** —0 controles abiertos—
  pero un `Allow` de más los deshace en silencio. Aplicar la policy requiere un
  principal con gestión IAM de escritura y es una decisión de operador, fuera del
  alcance de una entrega de verificación.

## 8. Cómo reproducir todo

```bash
export PATH="/c/Program Files/Amazon/AWSCLIV2:$PATH"

# CA-1 / CA-2 — tablas, PITR, CMK
node .pipeline/lib/kernel-table-verify.js

# CA-2 — CloudTrail (postura del destino)
node .pipeline/lib/kernel-cloudtrail-provision.js --verify

# CA-1 / CA-2 — matriz IAM Allow/Deny con el principal runtime real
node .pipeline/lib/kernel-iam-verify.js --strict

# CA-3 — pipeline en vivo con durable:false
bash .pipeline/smoke-test.sh

# CA-5 — suites
node --test .pipeline/lib/__tests__/kernel-*.test.js
```

## 9. Referencias

- `kernel-tablas-cutover-5210.md` — tablas y postura de retención
- `kernel-iam-matriz-5211.md`, `kernel-iam-policy.md` — matriz y policy IAM
- `kernel-kms-key-policy.json` — key policy de la CMK
- `runbook-cutover-durable.md` — procedimiento de encendido y rollback
