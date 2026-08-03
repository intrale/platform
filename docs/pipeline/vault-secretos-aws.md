# Provisión del vault de secretos en AWS — diseño

> Split 1/3 de #5338 — **#5351**. Épico: #5215.
>
> Define **dónde vive cada credencial del pipeline**, con qué política de acceso y
> a qué costo. Es un **artefacto de diseño con placeholders**: no se aplica en la
> cuenta hasta que cierre **#5211** (mínimo privilegio IAM/KMS).
>
> **Este repositorio es público.** Por eso acá no hay ningún `projectId`, `hostId`,
> nombre de parámetro concreto, account id, región de la cuenta ni cadena de
> resolución de credenciales. La policy le niega al rol de host la capacidad de
> **enumerar** el vault (§ Restricción 2); publicar el catálogo de nombres le
> devolvería gratis exactamente esa capacidad.

## Archivos

- `docs/pipeline/vault-iam-policy.json` — policy del **rol de runtime del host**.
  Placeholders `REGION`/`ACCOUNT`/`PROJECT`/`HOST`/`CMK_ID`, resueltos recién al
  aplicarla (§ Aplicación). Nunca se commitean valores reales — invariante A05.
- `.pipeline/lib/__tests__/vault-iam-policy.test.js` — verifica la policy **y este
  documento** como dato. Un JSON de policy no falla al leerse: si miente, miente
  en silencio. Cada aserción está mapeada a un criterio de aceptación de #5351.
- `docs/pipeline/inventario-credenciales.md` — **fuente** del universo de secretos
  que se clasifica acá (producido por el spike #5216). Es el archivo *tracked*;
  este diseño **no** depende del entregable sensible de #5216, que está
  gitignored y no sobrevive un `git clean -xfd`.

## Principio: dos principales distintos

| Principal | Permisos | Quién |
|---|---|---|
| **Provisión (admin)** | `ssm:PutParameter`, `secretsmanager:CreateSecret`/`PutSecretValue`, gestión de la CMK y de IAM | Paso admin explícito, corrido a mano con credenciales admin al dar de alta o rotar un secreto. **No** es el runtime. |
| **Runtime del host** | Sólo lectura de su propio prefijo + el prefijo compartido, más el `kms:Decrypt` acotado que esa lectura necesita | El proceso del pipeline que hidrata credenciales al arrancar. Es el que lleva `vault-iam-policy.json`. |

El `Deny` de escritura de la policy es del rol de **runtime**. Un `Deny` explícito
gana siempre: si alcanzara al principal de provisión trabaría la carga inicial del
vault y toda rotación posterior. Por eso son **dos principales distintos** y el de
provisión **no lleva esta policy**. Escrito acá porque es el error que un operador
apurado comete al "simplificar" adjuntando la misma policy a los dos.

## Jerarquía de nombres (D3)

```
/intrale/PROJECT/shared/<scope>          <- SSM Parameter Store · membresía ENUMERADA por secreto
/intrale/PROJECT/hosts/HOST/<scope>      <- SSM Parameter Store · legible SÓLO por el rol de ese host
intrale/PROJECT/rotating/<scope>         <- Secrets Manager · sólo lo que rota fuera del rol de provisión
```

Dos detalles que no son cosméticos:

- **La barra inicial discrimina el servicio.** Los nombres de Parameter Store son
  jerarquías con `/` inicial; los de Secrets Manager no lo llevan. Esa diferencia
  —que es convención de la propia AWS— alcanza para que el driver de la hija 2
  elija servicio sin un campo extra en el descriptor (§ `path#namespace`).
- **`shared/` no es un destino por omisión.** Cada secreto que cae ahí tiene su
  membresía justificada en la tabla de clasificación. La pregunta que decide no es
  *"¿lo usan varios hosts?"* sino *"¿un host comprometido que lo lee amplía el
  daño más allá de sí mismo?"*. Si la respuesta es sí y el secreto puede emitirse
  por host, va a `hosts/HOST/`.

### Placeholders y de dónde sale cada valor

Convención **SCREAMING**, la misma ya commiteada y testeada en
`kernel-iam-policy.json`. Una sola convención por entregable: estos cinco tokens
aparecen igual en el `.json` y en este `.md`.

| Placeholder | Fuente del valor | Notas |
|---|---|---|
| `REGION` | región de la cuenta destino, sección `kernel:` de la config del pipeline | La misma región del store durable de #5210: la CMK es regional y compartida. |
| `ACCOUNT` | account id de la cuenta destino | **Nunca** commiteado. Sale del paso admin. |
| `PROJECT` | `projectId` del producto (mismo identificador que usa el kernel) | Un vault por proyecto; el reparto kernel/producto lo cierra #5219. |
| `HOST` | `hostId` del host que corre el pipeline | Un valor por host. Dos hosts ⇒ dos policies materializadas, no una con dos `HOST`. |
| `CMK_ID` | id de la CMK del kernel, **ya provisionada por #5210** | No se crea una CMK nueva: se reutiliza y por eso su costo mensual no se suma de nuevo (§ Costo). |

## Criterio de destino: cuatro, no dos

El binario "Secrets Manager vs Parameter Store" manda configuración no secreta a
`SecureString` y distorsiona el costo, porque **cada lectura de un `SecureString`
es un `kms:Decrypt` facturado**. Los destinos son cuatro:

| # | Destino | Regla que lo ubica ahí | Costo que dispara |
|---|---|---|---|
| **(a)** | **Secrets Manager** — `intrale/PROJECT/rotating/<scope>` | El valor cambia **sin que lo escriba el rol de provisión**: rotación automatizada de AWS, o un tercero que lo refresca en su propio ciclo. | secreto/mes + llamadas API + `kms:Decrypt` |
| **(b)** | **PS `SecureString`** — `/intrale/PROJECT/{shared,hosts/HOST}/<scope>` | Es secreto y **no** cumple (a). | **`kms:Decrypt` por lectura** |
| **(c)** | **PS `String`** | Configuración **no secreta**: identificadores, regiones, nombres de recurso, allowlists de ids. | sin KMS |
| **(d)** | **Fuera del vault** | Es efímero (se emite por sesión y no se guarda) **o** es la raíz de confianza que abre el vault (§ Raíz de confianza) **o** lo gestiona un almacén externo que el vault no reemplaza. | — |

### La trampa de (a): "rotación programada" no es lo mismo que "rota sola"

`docs/secrets-inventory.md` fija una política de rotación **≤ 90 días para toda
credencial activa**, y `credential-rotation-cron.js` la recuerda por Telegram. Leer
la regla (a) como *"tiene rotación programada"* mandaría **las 33 filas** de dueño
`kernel` a Secrets Manager, a USD 0,40 cada una por mes, para no ganar nada: esa
rotación la ejecuta una persona, que escribe el valor nuevo con el rol de
provisión — exactamente lo que Parameter Store ya soporta.

Lo que Secrets Manager aporta y Parameter Store no es el caso en que **el valor
cambia por fuera del camino de escritura del pipeline**. Por eso (a) está redactada
así, y por eso hoy tiene **un solo** ocupante.

### Sub-regla: la mitad identificadora de un par de credenciales

Un par credencial (`client_id`/`client_secret`, `access_key_id`/`secret_access_key`)
tiene una mitad que no es secreta por sí sola. Aun así se guarda en el **mismo
destino** que la mitad secreta: son una **unidad de rotación**, y separarlas
habilita rotaciones parciales que dejan el par descalzado sin ningún error visible
hasta el próximo uso. El sobrecosto es un `Decrypt` extra por lectura, cuantificado
en § Costo, y es la única excepción a la regla (c).

## Clasificación secreto → destino

Universo: el inventario público de #5216. Conteo verificado en esta pasada sobre
`docs/pipeline/inventario-credenciales.md`:

```
$ awk '...extraer identificador + dueño de cada fila de tabla...' docs/pipeline/inventario-credenciales.md | wc -l
43        # filas con dueño declarado
   33  kernel      -> clasificadas abajo, todas
   10  producto    -> diferidas a #5219, enumeradas abajo, todas
```

> **Discrepancia con el conteo de referencia, resuelta.** Los criterios de
> aceptación citan «7 filas de dueño `producto`». Ese número sale de un
> `grep '| producto |'` que **no matchea las tres filas donde el dueño está en
> negrita** (`| **producto** |`). El conteo real es **10**, y las diez están
> listadas. Recortar a 7 para que cerrara contra la cifra citada sería
> precisamente la omisión silenciosa que el criterio prohíbe.
>
> ```
> $ grep -c '| producto |'   docs/pipeline/inventario-credenciales.md   ->  7
> $ grep -c '| \*\*producto\*\* |' docs/pipeline/inventario-credenciales.md -> 3
> ```

### Telegram

| Identificador | Destino | Regla | Ubicación y membresía |
|---|---|---|---|
| `telegram.bot_token` | **(b)** | secreto que no rota fuera del rol de provisión | `shared/` — hay **un** bot para todo el pipeline; un token por host obligaría a registrar N bots ante Telegram sin reducir el daño (todos hablan por el mismo bot). |
| `telegram.chat_id` | **(c)** | identificador de destino, no secreto | `shared/` — mismo canal para todos los hosts. |
| `telegram.leo_operator_chat_id` | **(c)** | identificador de destino, no secreto | `shared/` — identidad del operador, común a todos los hosts. |
| `TELEGRAM_ALLOWED_USER_IDS` | **(c)** | allowlist de ids, no secreto | `shared/` — es un control de **integridad**, no de confidencialidad: importa que nadie lo escriba, y de eso se ocupa el `Deny`, no el cifrado. |
| `bot_token` / `chat_id` (config versionada) | **(b)** + **(c)** | consolidación, **no** alta nueva | Es la copia duplicada de las dos primeras filas en un archivo versionado. Resuelve contra la misma entrada; la copia se retira en #5217/#5226. |

### Providers de IA

| Identificador | Destino | Regla | Ubicación y membresía |
|---|---|---|---|
| `providers.openai.api_key` | **(b)** | secreto que no rota fuera del rol de provisión | `shared/` — la clave es de la **cuenta** del provider y la cuota también; emitir una por host multiplicaría los puntos de rotación sin acotar el blast radius. |
| `providers.anthropic.api_key` | **(b)** | ídem | `shared/`. El pipeline se autentica con OAuth Max: el alta puede terminar declarándose N/A (decisión de #5217). |
| `providers.moonshot.api_key` | **(b)** | ídem | `shared/` — misma membresía. |
| `providers.google.api_key` | **(b)** | ídem | `shared/` — misma membresía. |
| `providers.cerebras.api_key` | **(b)** | ídem | `shared/` — misma membresía. |
| `providers.nvidia.api_key` | **(b)** | ídem | `shared/` — misma membresía. |
| `openai_api_key` / `anthropic_api_key` (respaldo ad-hoc) | **(b)** | consolidación, **no** alta nueva | Almacén adicional no declarado en el épico; resuelve contra las dos entradas de arriba y se elimina en #5217. |

### Google Drive / OAuth

| Identificador | Destino | Regla | Ubicación y membresía |
|---|---|---|---|
| `google_drive.oauth_client_id` | **(b)** | sub-regla de la mitad identificadora | `shared/`. *Alternativa considerada:* (c), porque Google expone el `client_id` en la URL de autorización y no lo trata como secreto. **Descartada** para no partir la unidad de rotación del par OAuth: se rotan juntos o quedan descalzados. |
| `google_drive.oauth_client_secret` | **(b)** | secreto que no rota fuera del rol de provisión | `shared/` — un solo proyecto OAuth para todo el pipeline. |
| `google_drive.oauth_refresh_token` | **(a)** | **lo emite un tercero con ciclo de refresh**: Google lo renueva y puede invalidarlo sin que nadie lo escriba desde el rol de provisión | `rotating/` — **el único ocupante de Secrets Manager hoy**. |
| `google_drive.drive_folder_id` | **(c)** | identificador de carpeta, no secreto | `shared/` — un destino de evidencia para todos los hosts. |
| `GOOGLE_CREDENTIALS_PATH` | **(c)** | es un **path** local, no una credencial | `shared/`. El **material apuntado** (JSON de service account) sí es secreto; su alta como (b) es alcance de #5217, no de esta clasificación. Se anota para que no quede como cobertura implícita. |

### Cloudflare R2

| Identificador | Destino | Regla | Ubicación y membresía |
|---|---|---|---|
| `R2_ACCOUNT_ID` | **(c)** | identificador de cuenta, se usa para armar el endpoint | `shared/`. |
| `R2_ACCESS_KEY_ID` | **(b)** | sub-regla de la mitad identificadora | `shared/` — par con la fila siguiente. |
| `R2_SECRET_ACCESS_KEY` | **(b)** | secreto que no rota fuera del rol de provisión | `shared/` — un bucket para todo el pipeline. |
| `R2_BUCKET` | **(c)** | nombre de recurso, no secreto | `shared/`. |

### AWS

| Identificador | Destino | Regla | Ubicación y membresía |
|---|---|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` (scope del pipeline) | **(d)** | raíz de confianza (las dos primeras) + efímero (el token de sesión) | § Raíz de confianza. |
| `aws.access_key_id` / `aws.secret_access_key` | **(d)** | raíz de confianza | Copia durable de la fila anterior; se retira junto con ella al pasar a credenciales de vida corta. |
| `aws.region` / `aws.profile` | **(d)** | se necesitan **para alcanzar el vault** | Guardarlos adentro del vault que abren es el mismo ciclo de arranque que las credenciales: viven en el bootstrap del host. |
| `aws.table_name` / `aws.coordination_table_name` | **(c)** | nombres de recurso, no secretos | `shared/` — las tablas del kernel son del proyecto, no del host. |
| Perfiles del CLI | **(d)** | almacén externo que el vault no reemplaza | El inventario ya los marca como alcance **parcial** de #5217: el vault los **declara**, no los absorbe. |

### GitHub

| Identificador | Destino | Regla | Ubicación y membresía |
|---|---|---|---|
| `GH_TOKEN` / `GITHUB_TOKEN` (scope del pipeline) | **(b)** | secreto que no rota fuera del rol de provisión | **`hosts/HOST/`** — es el único del inventario que gana algo real siendo por host: el audit log de GitHub queda atribuido al host, y un host comprometido se revoca sin frenar a los demás. *Transición:* mientras exista un único token, se escribe el **mismo valor** en el prefijo de cada host —nunca en `shared/`—, para que el corte a un token por host no obligue a tocar el driver de la hija 2. |
| Token del credential helper de git | **(d)** | almacén externo que el vault no reemplaza | El keyring del sistema operativo ya es durable y externo al repo; el inventario lo declara fuera de #5217. |
| `GITHUB_TOKEN` (scripts de intake) | **(b)** | consolidación, **no** alta nueva | Resuelve contra la entrada de `hosts/HOST/`. |
| `secrets.GITHUB_TOKEN` (CI) | **(d)** | **efímero**: GitHub lo emite y lo revoca por job | No se almacena. |

### Multimedia / voz

| Identificador | Destino | Regla | Ubicación y membresía |
|---|---|---|---|
| `multimedia.elevenlabs_api_key` | **(b)** | secreto que no rota fuera del rol de provisión | `shared/` — clave de cuenta, misma membresía que los providers de IA. |
| `multimedia.elevenlabs_voice_id` | **(c)** | identificador de voz, no secreto | `shared/`. |

### Distribución y CI — filas de dueño `kernel`

| Identificador | Destino | Regla | Ubicación y membresía |
|---|---|---|---|
| Secret de `security-sast.yml` | **(d)** | almacén externo que el vault no reemplaza | Secret de GitHub Actions: durable por definición y fuera del alcance de #5217. |
| Secret de `admission-gate.yml` | **(d)** | ídem | Ídem. |

### Filas de dueño `producto` — **diferidas a #5219**

Ninguna se clasifica acá. El namespaceado por `projectId` es alcance de #5219 y
clasificarlas ahora fijaría una jerarquía antes de que exista el reparto. Se
enumeran las **diez**, para que la suma cierre:

| Identificador | Sección del inventario | Por qué se difiere |
|---|---|---|
| `ANTHROPIC_API_KEY` (backend) | Providers de IA | dueño `producto` — #5219 |
| `REGION_VALUE` / `ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` (backend) | AWS | dueño `producto` — #5219 |
| `USER_POOL_ID` / `CLIENT_ID` (Cognito) | AWS | dueño `producto` — #5219 |
| `DYNAMODB_ENDPOINT` / `COGNITO_ENDPOINT` | AWS | **no son credenciales.** #5216 los excluye explícitamente; se listan para que la suma cierre, **no** se clasifican como secretos. |
| Secrets de `main.yml` | Distribución y CI | dueño `producto`, secrets de CI — #5219 |
| Secrets de `distribute-web.yml` | Distribución y CI | ídem |
| Secrets de `distribute-android.yml` | Distribución y CI | ídem |
| Secrets de `distribute-ios.yml` | Distribución y CI | ídem |
| Secrets de `distribute-desktop.yml` | Distribución y CI | ídem |
| `pr-checks.yml` (sin secrets) | Distribución y CI | sin credenciales que clasificar |

**Cierre de la suma:** 33 `kernel` (todas con destino) + 10 `producto`
(todas enumeradas como diferidas) = **43 filas**, el total del inventario.

Reparto de las 33 de `kernel` por destino — una fila puede aportar a dos destinos
cuando agrupa identificadores heterogéneos (`aws.region`/`aws.profile` van a (d) y
`aws.*_table_name` a (c)):

| Destino | Filas | Entradas nuevas en el vault |
|---|---|---|
| (a) Secrets Manager | 1 | 1 secreto |
| (b) PS `SecureString` | 13 | 10 entradas nuevas + 3 consolidaciones |
| (c) PS `String` | 9 | 9 (más de un parámetro en las filas que agrupan) |
| (d) fuera del vault | 8 | 0 |

### Nota sobre `ENV_MAPPING`

Si se cruza esta clasificación contra el `ENV_MAPPING` de
`.pipeline/lib/credentials.js`, el número correcto de entradas es **13** — no 17.
La cifra 17 circuló en una revisión previa de la receta de #5338 y es incorrecta:
sale de contar líneas del `Object.freeze`, que son mayoría comentarios.

De todos modos `ENV_MAPPING` **no** es el universo de esta clasificación: omite
las credenciales de mayor impacto (AWS, R2, GitHub). El universo es el inventario
de #5216.

## Raíz de confianza fuera del vault

**Las credenciales AWS del host no son un secreto del vault.** Guardar adentro del
vault la credencial que abre ese mismo vault es un ciclo de arranque imposible; y
listarla como "cubierta por el vault" da la ilusión falsa de que le aplican el
`Deny` de escritura y el `kms:Decrypt` acotado, cuando en realidad es la identidad
que los evalúa.

### Mecanismo de identidad elegido: credenciales de vida corta

El rol de runtime del host se asume con **credenciales de vida corta**. Opciones
aceptadas, en orden de preferencia según dónde corra el host:

| Opción | Cuándo aplica | Qué entrega |
|---|---|---|
| **Instance profile** | el host corre sobre cómputo de AWS | credencial rotada por AWS, sin material persistido en el filesystem |
| **IAM Roles Anywhere** | host fuera de AWS con certificado X.509 | sesión temporal a partir de un certificado con CA propia |
| **SSO / identity center** | host operado por una persona | sesión temporal atada a la identidad del operador, con caducidad de sesión |

No es una elección teórica: el inventario ya registra `AWS_SESSION_TOKEN` entre
las variables del scope del pipeline, o sea que **el host hoy ya opera con
credenciales de sesión**. Lo que falta no es el mecanismo, es hacerlo el único
camino y retirar la copia estática.

**Descartadas, y por qué:**

- **Access key estática de larga duración en el filesystem.** No caduca sola, no
  deja rastro de qué sesión la usó, y sobrevive a cualquier compromiso del host
  hasta que alguien la rota a mano. Es el modo de falla que el épico existe para
  cerrar.
- **Credencial del vault guardada en el propio vault.** Ciclo de arranque
  imposible (arriba).
- **Rol compartido entre hosts.** Anula `hosts/HOST/`: si dos hosts asumen el
  mismo rol, el `Resource` de la policy no puede distinguirlos y el aislamiento
  por host que justifica toda la jerarquía deja de existir.

### Estado transitorio con access key estática — condiciones

Si por restricción operativa el corte a credenciales de vida corta no puede ser
inmediato, la access key estática se acepta como **riesgo aceptado** sólo con las
**tres patas juntas**. Sin las tres, no se acepta:

1. **Acotada** a `ssm:GetParameter` sobre **su propio** prefijo de host — nunca
   `shared/`, nunca `GetParametersByPath`, nunca Secrets Manager.
2. **Registrada** en `docs/secrets-inventory.md` con el esquema real de esa tabla
   (`provider`, `env_var`, `owner`, `last_rotated`, `expires_at`, `account_id`,
   `rotation_runbook_url`, `revocation_endpoint`), que es el insumo del cron de
   rotación. Sin la fila, el vencimiento no dispara ningún recordatorio.
3. **Con fecha de caducidad e issue de retiro** referenciado en la fila. Un
   "riesgo aceptado" sin fecha es una omisión con mejor redacción.

> **Este diseño elige la opción de vida corta.** Por lo tanto **no** se agrega
> ninguna fila a `docs/secrets-inventory.md` en esta entrega, y ese archivo no
> aparece en el diff. Si en la aplicación (#5211) se activara el estado
> transitorio, las tres patas son condición de la aplicación, no de este diseño.

## La policy, restricción por restricción

Cada restricción dice **por qué** existe y **qué se rompe** si se afloja.

### Restricción 1 — dos statements de lectura, disjuntos

`VaultReadHostScoped` sobre `…:parameter/intrale/PROJECT/hosts/HOST/*` y
`VaultReadSharedScoped` sobre `…:parameter/intrale/PROJECT/shared/*`.

**No puede existir un `Allow` cuyo `Resource` sea el prefijo de proyecto a secas**
(`…:parameter/intrale/PROJECT/*`). Si se afloja así, `GetParametersByPath` con
`--recursive` sobre ese prefijo le entrega a **cada host el vault de todos sus
pares**: el aislamiento por host desaparece en un carácter, y la policy sigue
pareciendo acotada porque no tiene ningún `Resource: "*"`.

El `Deny` de la Restricción 5 **sí** usa el prefijo de proyecto, y legítimamente:
denegar de más es seguro, permitir de más no. Por eso la aserción del test filtra
por `Effect === 'Allow'`; sin ese filtro el test se rompe contra su propia policy
correcta.

### Restricción 2 — el rol de host no puede enumerar

`ssm:DescribeParameters` y `secretsmanager:ListSecrets` **no admiten permisos a
nivel de recurso**: concederlos es concederlos sobre *todo* el vault de la cuenta.
Por eso están ausentes, y por eso el catálogo de nombres no se publica en este
documento (§ intro): la policy le niega al host descubrir qué existe, y el `.md`
no puede devolverle esa capacidad por otra vía.

**Lo que se rompe si se afloja:** un host comprometido pasa de "puede leer lo que
sabe pedir" a "puede inventariar todo el vault del proyecto y de los demás
proyectos de la cuenta". Es la diferencia entre una fuga acotada y un mapa completo.

**Consecuencia operativa asumida:** un `AccessDenied` no se puede desambiguar
listando. Por eso existe la tabla de § Diagnóstico — sin ella el operador queda
ciego, y la tabla es parte del precio de esta restricción.

### Restricción 3 — `kms:Decrypt` acotado, en **dos** statements

La CMK **es compartida con el store durable de #5210**. El `Deny` de no-repudio de
#5210 protege a nivel DynamoDB; a nivel KMS no protege nada. Un `kms:Decrypt` sin
`Condition` sobre esa CMK le daría al rol de host la capacidad de descifrar
material del store durable.

Por eso cada statement KMS lleva `Condition` con **las dos** claves:

- `kms:ViaService` — sólo a través del servicio que corresponde (`ssm` o
  `secretsmanager`), nunca por llamada directa a KMS ni vía otro servicio.
- `kms:EncryptionContext:PARAMETER_ARN` / `:SecretARN` — sólo sobre material cuyo
  contexto de cifrado cae dentro del prefijo del proyecto. Para SSM el valor es
  una **lista de dos patrones** (host y shared), que IAM evalúa en **OR**.

**Por qué dos statements y no uno.** Las condiciones de un mismo statement se
evalúan en **AND**. Un `Decrypt` originado en SSM trae `PARAMETER_ARN` pero **no**
trae `SecretARN`: un statement único con las dos claves no matchearía nunca y el
vault quedaría inutilizable, con un `AccessDenied` que parece de permisos de
lectura y manda a diagnosticar al lugar equivocado. Son
`VaultDecryptViaSsm` y `VaultDecryptViaSecretsManager`, separados.

### Restricción 4 — el rol de runtime no escribe

Ausente del `Allow`: `ssm:PutParameter`, `ssm:DeleteParameter`,
`ssm:DeleteParameters`, `ssm:LabelParameterVersion`,
`secretsmanager:PutSecretValue`, `secretsmanager:UpdateSecret`,
`secretsmanager:DeleteSecret`. Son **siete** caminos de escritura, no uno: denegar
sólo `PutParameter` deja seis puertas abiertas. Escribir en el vault es del rol de
provisión (§ Principio).

### Restricción 5 — el `Deny` cubre cada acción con el `Resource` de **su** servicio

`VaultDenyWriteSsm` deniega las cuatro acciones de SSM sobre el prefijo SSM del
proyecto; `VaultDenyWriteSecretsManager` deniega las tres de Secrets Manager sobre
el prefijo de Secrets Manager.

**Por qué no un único `Deny` con los siete.** Un `Deny` matchea sólo cuando la
acción **y** el recurso caen dentro del statement. Un `Deny` que enumera
`secretsmanager:PutSecretValue` con un `Resource` de SSM **no deniega nada**: es
un `Deny` inerte, que se lee perfecto y no protege. Es literalmente la lección de
`kernel-iam-policy.md` (la `Condition` de `LeadingKeys` que no matcheaba nunca) y
el motivo por el que esa policy se testea como dato.

### Restricción 6 — ningún `Allow` con `Resource: "*"`, todo statement con `Sid`

El `Sid` es trazabilidad: sin él, un `AccessDenied` en CloudTrail no se puede
atribuir a una decisión de diseño.

> **Sobre los `*` de la policy.** Acá el `*` final **no** es un aflojamiento: en
> SSM y Secrets Manager el scoping *es* por prefijo, y el ARN de un secreto de
> Secrets Manager además lleva un sufijo aleatorio que hace imposible escribirlo
> literal. Lo que se prohíbe es `Resource: "*"` y los prefijos que abarcan todo el
> servicio (`:parameter/*`, `:secret:*`). Portar tal cual la aserción
> "ningún `*` en el `Resource`" de `kernel-iam-policy.test.js` —que es correcta
> para DynamoDB, donde el ARN de tabla sí es literal— haría fallar el test contra
> una policy de vault perfectamente correcta.

## Cómo se expresa un path de Parameter Store en `path#namespace`

Necesario para que la hija 2 sea implementable **sin tocar el parser**.

`parseSecretRef` (en `.pipeline/lib/credentials.js`) parte la referencia en dos:
el lado izquierdo del `#` admite `/`, el lado derecho **no** (su clase de
caracteres es `[A-Za-z0-9._:-]`). Y `kernel-store.js` valida el **namespace** —el
lado derecho— contra una allowlist.

La regla, entonces:

```
/intrale/PROJECT/hosts/HOST  #  <scope>      -> parámetro /intrale/PROJECT/hosts/HOST/<scope>
/intrale/PROJECT/shared      #  <scope>      -> parámetro /intrale/PROJECT/shared/<scope>
intrale/PROJECT/rotating     #  <scope>      -> secreto   intrale/PROJECT/rotating/<scope>
```

- **Todo el prefijo jerárquico va del lado izquierdo.** Un path de cuatro
  segmentos entra entero: `/` está permitido ahí.
- **El `<scope>` es el namespace**, y por eso **no puede contener `/`**. Es la
  misma unidad que ya se enumera en la allowlist: el scope es lo que se autoriza,
  el prefijo es dónde está guardado.
- **El nombre completo se reconstruye** concatenando `path + '/' + namespace`.
- **La barra inicial elige el servicio**: con `/` ⇒ Parameter Store; sin `/` y
  empezando por `intrale/` ⇒ Secrets Manager. Con `~/` ⇒ archivo local (el camino
  actual, que sigue funcionando sin cambios).

Corolario para la hija 2: **no hay que aflojar el patrón del namespace para
admitir barras.** Aflojarlo rompería la allowlist —un `namespace` con `/` podría
apuntar fuera del scope autorizado— y es exactamente la defensa anti-IDOR que el
kernel ya tiene escrita.

### Punto de entrada canónico para quien NO lee — #5464

El tramo de provisión (#5425) resuelve el **mismo** nombre lógico que el runtime,
pero corre en otro proceso, con otra identidad y con un port de escritura propio.
Para que no termine copiando los regex ni concatenando el path a mano,
`secret-vault.js` exporta `validateVaultNamespace(...)`:

```js
const { validateVaultNamespace } = require('.pipeline/lib/secret-vault');

validateVaultNamespace({ prefix, projectId, hostId, scope, tier });
// -> { tier, service: 'ssm'|'secretsmanager', path, root, prefix, projectId, hostId, scope }  (congelado)
```

- **No es una segunda implementación.** Es un envoltorio *puro* sobre
  `buildParameterPath`, que sigue siendo el único lugar donde vive el esquema y
  el único que corre `SEGMENT_RE` / `PREFIX_RE`. Mismos argumentos, mismos
  errores (`VaultConfigError` con la clave de config) y misma semántica de
  `root`; lo único que agrega es el descriptor enriquecido.
- **`service` sale de `VAULT_TIER_SERVICE`**, declarado una sola vez y cubierto
  por test contra `VAULT_TIERS`: un tier nuevo sin destino declarado rompe la
  suite en vez de mandar el pedido al servicio equivocado.
- **Los regex no se exportan a propósito.** Exportarlos habilitaría justamente la
  copia que este punto de entrada viene a evitar.
- **No amplía privilegios.** Es una función sin I/O, sin ambiente y sin driver:
  `VAULT_READONLY_COMMANDS` queda idéntica y ningún driver de este módulo expone
  escritura. Con qué verbo se escribe es decisión del provisionador, fuera de
  `secret-vault.js`.

## Costo por escenario

Precios de lista públicos de AWS para la región de referencia de precios
(`us-east-1`; no es la región del vault, que es `REGION`). **No verificados contra
la cuenta** — ver gap G-3.

| Concepto | Precio de lista |
|---|---|
| Secrets Manager — almacenamiento | USD 0,40 por secreto por mes |
| Secrets Manager — API | USD 0,05 por cada 10.000 llamadas |
| Parameter Store standard | sin cargo (almacenamiento y throughput standard) |
| KMS — requests | USD 0,03 por cada 10.000 (`Decrypt` incluido) |
| KMS — CMK | USD 1,00 por mes — **ya costeada por #5210**, compartida, no se suma |

### Volumen medido

```
$ find .pipeline/logs -maxdepth 1 -name "*-*.attempt-*.log" -mtime -1 | wc -l
109                     # lanzamientos de agente en 24 h
$ find .pipeline/logs -maxdepth 1 -name "*-*.attempt-*.log" -mtime -7 | wc -l
710                     # en 7 días  ->  ~101/día  ->  ~3.000/mes
```

Cada hidratación completa de credenciales lee, como **cota superior**, las 13
entradas `SecureString` ⇒ 13 `kms:Decrypt`. Sin caché, una hidratación por
lanzamiento de agente ⇒ **~39.000 `Decrypt`/mes por host**.

### Escenarios

| Escenario | `Decrypt`/mes | KMS | Secrets Manager | PS | **Total incremental/mes** |
|---|---|---|---|---|---|
| **Hoy** — 1 host, sin caché | ~39.000 | USD 0,12 | USD 0,40 + ≤0,05 API | USD 0,00 | **≈ USD 0,57** |
| **5 hosts**, sin caché | ~195.000 | USD 0,60 | USD 0,40 + ≤0,10 API | USD 0,00 | **≈ USD 1,10** |
| **Hoy con caché de sesión** — hidratar una vez por arranque del host (~30/mes) y no por agente | ~390 | USD 0,03 | USD 0,40 + ≤0,05 API | USD 0,00 | **≈ USD 0,48** |

### El driver, atribuido

**La única palanca que el operador puede mover es el volumen de `kms:Decrypt`.**
El costo de Secrets Manager es fijo por tener el secreto: no se optimiza sin sacar
el secreto del servicio, y hoy es un solo secreto que está ahí por una razón
técnica (§ criterio (a)). Parameter Store standard no cuesta nada.

Con honestidad sobre el punto de cruce: **hoy, con un host, el rubro más caro es
el secreto de Secrets Manager, no los `Decrypt`.** El `Decrypt` lo supera arriba de
**~133.000 lecturas/mes** (USD 0,40 ÷ USD 0,03 por bloque de 10.000), es decir a
partir de **~3,4 hosts** al ritmo medido — y desde ahí crece lineal con la flota
mientras el resto queda plano.

Los tres números están **por debajo de USD 2/mes**: a esta escala el costo no es
un criterio de decisión. La razón para poner caché de sesión es reducir superficie
—menos lecturas, menos ventanas donde el material está en claro en memoria— y el
ahorro es un efecto secundario. Presentar un total sin esta atribución escondería
justamente eso.

## Gaps con `verified: null`

Disciplina de `kernel-table-verify.js`: un `AccessDenied` **no es un hallazgo, es
un gap**. `null` significa "no sé", y es un estado legítimo; marcarlos `true`
sería el verde falso que esa disciplina existe para impedir.

| Id | Control | `verified` | Por qué no se puede observar | Qué lo cerraría |
|---|---|---|---|---|
| **G-1** | `kms:DescribeKey` sobre la CMK — confirmar que la clave existe, es simétrica y tiene rotación habilitada | `null` | el perfil acotado del pipeline recibe `AccessDenied`; la policy de runtime tampoco concede `DescribeKey` (y no debe) | #5211, con un principal con lectura de KMS |
| **G-2** | `kms:ListAliases` — confirmar que el alias apunta a la CMK esperada | `null` | ídem G-1 | #5211 |
| **G-3** | Costo real facturado | `null` | requiere Cost Explorer sobre la cuenta; acá sólo hay precios de lista y un volumen medido en el host | un mes de facturación tras aplicar |
| **G-4** | Enforcement efectivo de la policy (que `AccessDenied` ocurra donde el diseño dice) | `null` | la policy **no está aplicada**: es un artefacto de diseño | #5211 al aplicarla, con las pruebas negativas de § Aplicación |
| **G-5** | Registro en CloudTrail del intento denegado | `null` | la auditoría de la CMK todavía no está configurada | #5212 |
| **G-6** | B3.2 de #5353 — principal **distinguible por host**: `sts get-caller-identity` devuelve un principal distinto e identificable desde cada uno de los dos hosts | `null` | hay principals IAM no-root operativos, pero ninguno tiene concedido el prefijo del vault; la identidad por host todavía no existe como tal | #5211, al aplicar una policy por `HOST` |
| **G-7** | B3.3 de #5353 (= CA-5 de #5338) — **multi-host**: dos hosts leen el mismo secreto compartido, sin copiar archivos entre máquinas | `null` | no hay nada aprovisionado que leer: `ssm:DescribeParameters` y `secretsmanager:ListSecrets` deniegan para los dos perfiles del host | #5211, tras el paso admin de § Aplicación |
| **G-8** | B3.4 de #5353 (= CA-3 de #5338) — **aislamiento**: un host que intenta leer el namespace ajeno es denegado | `null` | hoy el `AccessDenied` saldría porque **ninguna** policy concede nada (y para `kernel-runtime`, por un `Deny` explícito de `IntraleKernelStore`), no porque el aislamiento funcione | #5211 — y sólo cuenta con el **control positivo** de G-9 en la misma corrida |
| **G-9** | B3.6 de #5353 — **control positivo obligatorio**: la prueba negativa de G-8 sólo vale si el mismo host lee **su propio** namespace con ÉXITO en la misma corrida | `null` | ídem G-8 | #5211. Sin esto, un `AccessDenied` genérico se firmaría como "aislamiento verificado" siendo un falso positivo |

> **G-6 a G-9 los aporta #5353** (integración del vault en `credentials.js`). El
> **lado código** de B3 sí quedó cerrado y testeado ahí, sin AWS y con driver
> inyectado (B3-A.1 el namespace sale de config, B3-A.2 la denegación es
> fail-closed con la variable sin setear, B3-A.3 un `hostId` inválido falla
> nombrando `vault.hostId`). Lo que viaja acá como gap es exclusivamente el
> **lado cuenta**, que no es observable hasta que #5211 aplique la policy.
> Estos cuatro gaps **no bloquean #5353**; bloquean el cierre del épico #5215.

```jsonc
// Forma en que estos gaps deben viajar a cualquier reporte automatizado.
// Ningún gap puede salir con verified: true; el fusible de kernel-table-verify
// (assertNoUnverifiedClaims) tira en vez de imprimir un verde falso.
"gaps": [
  { "id": "G-1", "control": "kms:DescribeKey",           "verified": null, "blockedBy": "#5211" },
  { "id": "G-2", "control": "kms:ListAliases",           "verified": null, "blockedBy": "#5211" },
  { "id": "G-3", "control": "costo real facturado",      "verified": null, "blockedBy": "#5211" },
  { "id": "G-4", "control": "enforcement IAM",           "verified": null, "blockedBy": "#5211" },
  { "id": "G-5", "control": "auditoría CloudTrail",      "verified": null, "blockedBy": "#5212" },
  { "id": "G-6", "control": "principal por host",        "verified": null, "blockedBy": "#5211" },
  { "id": "G-7", "control": "lectura multi-host",        "verified": null, "blockedBy": "#5211" },
  { "id": "G-8", "control": "aislamiento de namespace",  "verified": null, "blockedBy": "#5211" },
  { "id": "G-9", "control": "control positivo de G-8",   "verified": null, "blockedBy": "#5211" }
]
```

## Aplicación (paso admin, fuera del boot del pipeline)

**Bloqueado por #5211.** Nada de esto se corre hasta que ese issue cierre.

Con credenciales admin, se resuelven los cinco placeholders de la tabla de §
Jerarquía y se adjunta la policy al rol de runtime de **cada** host (una policy
materializada por `HOST`, no una con varios).

Al resolver los placeholders, **tres reglas que no se negocian**:

- **Un `HOST` por policy.** Colar dos hosts con un `*` en ese segmento reabre
  exactamente el agujero de la Restricción 1.
- **`CMK_ID` es la CMK ya provisionada por #5210.** Crear una segunda CMK agrega
  USD 1/mes y, peor, dos claves donde el diseño asume una: las condiciones de
  `EncryptionContext` de la Restricción 3 dejarían de cubrir la mitad del material.
- **El `Deny` no alcanza al principal de provisión.** Adjuntar esta policy también
  al rol admin "por prolijidad" traba toda escritura y con eso el alta y la
  rotación de secretos.

Pruebas negativas mínimas tras aplicar (cierran G-4). Ninguna imprime un valor:

```bash
# 1. El host lee su propio prefijo -> OK (se pide el NOMBRE, no el valor)
aws ssm get-parameter --name "/intrale/PROJECT/hosts/HOST/SCOPE" --with-decryption \
  --query 'Parameter.Name' --output text

# 2. El host lee el prefijo de OTRO host -> debe dar AccessDeniedException
aws ssm get-parameter --name "/intrale/PROJECT/hosts/OTRO_HOST/SCOPE" --with-decryption \
  --query 'Parameter.Name' --output text

# 3. El host intenta enumerar -> debe dar AccessDeniedException (Restricción 2)
aws ssm describe-parameters --max-results 1

# 4. El host intenta escribir -> debe dar AccessDeniedException (Restricciones 4 y 5)
aws ssm put-parameter --name "/intrale/PROJECT/hosts/HOST/SCOPE" --value "x" \
  --type SecureString --overwrite

# 5. El host intenta descifrar material del store durable de #5210 -> AccessDenied
#    (la CMK es la misma; lo que corta es kms:ViaService de la Restricción 3)
```

## Runbook — rotación de la credencial de sesión del host

Se corre **en emergencia, con el pipeline abajo**. Por eso las precondiciones van
afuera del bloque copiable: pegar un bloque entero sin leerlas es el modo de falla
más común.

**Impacto:** el pipeline **no puede hidratar credenciales** mientras dure. Los
agentes en vuelo terminan; los nuevos no arrancan.
**Duración estimada:** 10–15 minutos, dominados por la propagación de IAM.
**Quién puede correrlo:** sólo quien tenga el principal de **provisión**.

### Precondiciones

1. El pipeline está **detenido**. Rotar con agentes en vuelo deja procesos con
   una sesión revocada y errores que parecen de red.
2. Hay acceso al mecanismo de identidad elegido (§ Raíz de confianza) **antes** de
   revocar lo anterior. Ésta es la precondición que evita el rollback del paso 3.
3. Está identificado el `hostId` afectado. Rotar la sesión del host equivocado
   deja **dos** hosts caídos en vez de cero.

### Regla de higiene — vale para todos los pasos

**Ninguna salida de estos comandos se pega en un issue, un PR, un comentario, un
log del pipeline ni un mensaje de Telegram.** La redacción automática del pipeline
no cubre lo que una persona copia y pega a mano. Los comandos están escritos para
imprimir **metadata** (nombres, ARNs, identidades), nunca valores; si se necesita
inspeccionar un valor, se hace en una terminal y no se persiste en ningún lado.

### Pasos

**Paso 1 — verificar la identidad vigente.**

```bash
aws sts get-caller-identity --query 'Arn' --output text
```
*Verificación:* el ARN devuelto es el del rol de runtime del host que se va a
rotar. Si no lo es, **detenerse**: se está por rotar otra cosa.

**Paso 2 — emitir la sesión nueva** con el mecanismo de § Raíz de confianza
(instance profile, Roles Anywhere o SSO, según dónde corra el host).

*Verificación:* repetir el Paso 1 en una terminal nueva y confirmar que devuelve
el mismo rol con una sesión distinta.

**Paso 3 — probar la lectura con la sesión nueva, antes de revocar la vieja.**

```bash
aws ssm get-parameter --name "/intrale/PROJECT/hosts/HOST/SCOPE" --with-decryption \
  --query 'Parameter.Name' --output text
```
*Verificación:* devuelve el **nombre** del parámetro. Si devuelve
`AccessDeniedException`, ir a § Diagnóstico **antes** de seguir.

**Paso 4 — revocar la sesión anterior.** Recién ahora, con el Paso 3 en verde.

*Verificación:* con la sesión vieja, el comando del Paso 3 devuelve
`ExpiredTokenException` o `AccessDeniedException`.

**Paso 5 — levantar el pipeline y confirmar una hidratación completa.**

*Verificación:* el arranque no reporta credenciales faltantes. El loader lista
**nombres** de variable, nunca valores.

### Rollback

| Falla en | Qué quedó a medias | Cómo se sale |
|---|---|---|
| Paso 2 | nada cambió | reintentar; la sesión vieja sigue vigente |
| Paso 3 | sesión nueva emitida y **sin acceso**, sesión vieja **todavía vigente** | **no revocar nada**: seguir con la vieja y diagnosticar. Es la razón por la que el Paso 4 va después del 3. |
| Paso 4 | vieja revocada y nueva verificada | no hay rollback y no hace falta: el Paso 3 ya probó la nueva |
| Paso 5 | credencial OK, pipeline no levanta | el problema no es de credenciales; revertir el arranque, no la rotación |

> **El único estado sin salida** es revocar la credencial vieja antes de probar la
> nueva: queda el vault inaccesible y la identidad para arreglarlo, revocada. El
> orden de los pasos 3 y 4 existe exactamente para eso y no se invierte.

## Diagnóstico — síntoma → causa probable → comando

Con la Restricción 2 aplicada, un `AccessDenied` **no distingue** si lo rechazó
`ssm:GetParameter` o el `kms:Decrypt` posterior, y enumerar está denegado por
diseño. Sin esta tabla el operador queda ciego.

| Síntoma | Causa probable | Comando de desambiguación |
|---|---|---|
| `AccessDeniedException` en **toda** lectura, incluso del propio prefijo | **Placeholder sin resolver** en el ARN de la policy aplicada (`REGION`/`ACCOUNT`/`PROJECT`/`HOST`/`CMK_ID` quedó literal) | `aws iam get-role-policy --role-name ROL --policy-name POLICY --query 'PolicyDocument' \| grep -oE 'REGION\|ACCOUNT\|PROJECT\|HOST\|CMK_ID'` — cualquier salida es el bug. |
| La lectura **sin** `--with-decryption` funciona y **con** `--with-decryption` falla | **`EncryptionContext` que no matchea**: falló el `kms:Decrypt`, no el `ssm:GetParameter` | `aws ssm get-parameter --name "…" --query 'Parameter.Name' --output text` (sin descifrar) y luego el mismo con `--with-decryption`. Si sólo falla el segundo, el problema está en la Restricción 3, no en la 1. |
| Un parámetro que "existe" da `AccessDenied` sólo desde un host | El nombre pedido cae en **`hosts/` de otro host** | `aws sts get-caller-identity --query 'Arn' --output text` y comparar el `hostId` del rol contra el segmento `hosts/<hostId>/` del nombre pedido. Si difieren, la policy funcionó como debe. |
| `ParameterNotFound` (no `AccessDenied`) | **El secreto todavía no existe**: el prefijo está permitido pero no hay alta | Que devuelva `ParameterNotFound` y no `AccessDeniedException` ya es el diagnóstico: el permiso está bien y falta el alta, que es del rol de **provisión**. |
| `AccessDenied` al intentar `describe-parameters` | **Esperado, no es un bug** — Restricción 2 | Ninguno: es el comportamiento diseñado. Si esto *funciona*, la policy está mal aplicada. |

## Handoff

- **Hija 2 — `.pipeline/lib/secret-vault.js`.** El driver de lectura. Todo lo que
  necesita para no rediseñar está en § `path#namespace` (el esquema de referencia
  sin tocar el parser) y § Jerarquía (la barra inicial como discriminador de
  servicio). No debe aflojar la clase de caracteres del namespace.
- **Hija 3 — `.pipeline/lib/credentials.js`.** ✅ **Entregada (#5353).** La
  integración en el cliente, con el gate `vault.enabled` cerrado. Ver §
  Encendido del gate.
- **#5211 — mínimo privilegio IAM/KMS.** Aplica esta policy. Las pruebas negativas
  de § Aplicación cierran G-4; el `kms:DescribeKey` de un principal con lectura de
  KMS cierra G-1 y G-2.
- **#5212 — auditoría CloudTrail de la CMK.** Cierra G-5.
- **#5217 — migración al store único.** Ejecuta las altas de la tabla de
  clasificación y retira las tres filas marcadas *consolidación*.
- **#5219 — reparto kernel/producto.** Toma las diez filas de dueño `producto`
  diferidas acá.

Mientras la policy no esté aplicada, este documento es un artefacto de diseño sin
blast radius: no hay ningún permiso concedido ni ningún secreto en la cuenta.

## Encendido del gate (`vault.enabled: true`) — #5353

«El código es correcto» y «la cuenta está lista» son dos verdades distintas, con
dueños distintos. #5353 entrega la primera con el gate **cerrado**: con
`vault.enabled: false` (default commiteado en `config.yaml`) el comportamiento
del pipeline es idéntico al previo y **no se emite una sola llamada AWS** — el
módulo `secret-vault.js` ni siquiera se carga.

Poner `vault.enabled: true` es una decisión de operación, y **no se aprueba sin
esta lista completa**:

0. ⛔ **BLOQUEANTE ABIERTO — de dónde saca el vault sus PROPIAS credenciales AWS.**
   Hoy **no hay respuesta**, y encender el gate sin cerrarlo deja el pipeline con
   **cero credenciales**. Es el huevo-y-la-gallina del vault: para leer el vault
   hacen falta credenciales AWS, y hoy viven en el archivo que el vault viene a
   reemplazar. Verificado sobre `HEAD c10524e4d`:

   - `ENV_DESCRIPTORS` (`credentials.js`) **no tiene ni una entrada del scope
     `aws`** ⇒ `loadIntoEnv()` nunca hidrata `AWS_ACCESS_KEY_ID` /
     `AWS_SECRET_ACCESS_KEY` al ambiente.
   - `createAwsCliVaultRunner` (`secret-vault.js`) hace fail-closed si esas dos
     no están ⇒ con el gate abierto, `vault.error = VAULT_CONFIG_INVALID` y las
     **13** variables salen en `missing`.
   - No hay escape en runtime: la ventana de bootstrap se desactiva justamente
     por haber error del vault (B1.2), así que ni encendiéndola se recupera. La
     única salida es editar `config.yaml` a mano y reiniciar.
   - Incoherencia adicional: `AWS_PROFILE` **sí** está en el allowlist de
     `build-child-env.js`, y `~/.aws/{config,credentials,login}` muestra que la
     autenticación real de este host es **por perfil (`aws login`)** — pero el
     guard exige las dos variables de clave estática, así que rechaza el único
     mecanismo de auth que el host tiene. El propio mensaje de error sugiere
     «Remediación: `aws login`», que **no** satisface el guard que lo emitió.

   Cerrar esto es una decisión de criterio (¿el vault se autentica por perfil?
   ¿por rol de instancia? ¿las claves del vault son el único secreto que sigue
   viviendo en archivo, y con qué blast radius?), del mismo rango que B1/B2/B3 y
   **no la cierra el dev por su cuenta**. Seguimiento: #5393.
1. **#5211 cerrado** — la policy IAM aplicada por host. Sin esto no hay nada que
   leer y todo secreto sale fail-closed.
2. **#5212 cerrado** — auditoría CloudTrail de la CMK (G-5).
3. **Altas hechas** — los 13 valores de `ENV_DESCRIPTORS`
   (`.pipeline/lib/credentials.js`) provisionados según la tabla de §
   Clasificación: doce en `shared/` de Parameter Store y
   `google_drive.oauth_refresh_token` en `rotating/` de Secrets Manager.
4. **El ancla poblada** — `telegram.leo_operator_chat_id` (B2.5b). Es la única
   fuente de la allowlist de firmantes del gate del operador
   (`operator-gate.js`), y con el gate abierto se resuelve **exclusivamente**
   desde el vault, sin fallback. Encender sin poblarla deja al operador sin
   poder firmar nada. Verificación: `resolveOperatorAllowlist(env).size >= 1`
   tras el boot — se reporta **el tamaño**, jamás el contenido.
5. **`vault.hostId` seteado** al `os.hostname()` de la máquina. Se commitea
   vacío a propósito (CA-29); con el gate abierto, vacío o inválido falla
   nombrando la clave.
6. **`vault.required_scopes`** declara `telegram`, `providers` y `google_drive`,
   y `vault.shared_secrets` la membresía que corresponda. El vault sólo resuelve
   scopes declarados: uno faltante es fail-closed, no una lectura silenciosa.
7. **G-6 a G-9 verificados** con control positivo en la misma corrida (B3.6).
8. **El ancla no se apaga desde el ambiente** (B2.7 — rev-1 de la auditoría de
   seguridad). El régimen del ancla depende de `vault.enabled`, así que quien
   pueda elegir **qué `config.yaml` es la autoridad** puede apagar el control
   entero — y eso es exactamente la capacidad que B2 asume en el adversario
   (poder escribir variables de entorno). Dos invariantes lo cierran, y las dos
   se verifican en `credentials-vault-5353.test.js`:

   - La raíz de la config la fija el **código** (`REPO_ROOT`), igual que hace
     `pulpo.js`. `PIPELINE_REPO_ROOT`, `PIPELINE_DIR_OVERRIDE` y
     `PIPELINE_STATE_DIR` **no** eligen la autoridad para `credentials.js`.
     Antes sí lo hacían: bastaba apuntar una de ellas a una carpeta vacía para
     que el gate se leyera como apagado y el chat id preseteado en el ambiente
     sobreviviera como firmante del gate del operador.
   - «No se pudo leer la config» **no es** «el vault está apagado». Es un estado
     propio (`result.vault.indeterminado: true`) y ante él las **anclas** fallan
     cerradas: se descartan del ambiente y se cuentan en `missing`. Las 12
     no-ancla siguen el camino del gate cerrado, idéntico al actual. Colapsar
     los dos estados es fail-open disfrazado, el mismo razonamiento que B1.2
     aplica al error de red del driver.

   Verificación al encender: `result.vault.indeterminado === false` en el boot.
   Si sale `true`, el `config.yaml` que manda no se está leyendo y el gate del
   operador quedó **sin firmantes** a propósito — se repara la config, no se
   repuebla la variable a mano.

La ventana de bootstrap (`vault.bootstrap_fallback` +
`bootstrap_fallback_until`) existe para el punto 3 y **sólo** para eso: permite
encender el gate antes de terminar todas las altas. Nunca se activa por un error
del driver, nunca alcanza al ancla, y caduca sola. No es un mecanismo de
resiliencia — si el vault falla, el pipeline degrada fail-closed y lo narra.
