# Rotación y auditoría del vault

CloudTrail Event history es la fuente autoritativa de accesos al vault.
`.pipeline/logs/vault-access-audit.jsonl` es un complemento diagnóstico
encadenado, no un reemplazo del rastro de AWS.

Alcance: este documento cubre la **política de rotación** y la **auditoría de
accesos**. La rehidratación transparente de la credencial en el spawn del agente
(y el `resetVaultCache()` público que la acompaña) pertenece a **#5440** y no
está implementada acá.

## Clasificación

Cada secreto cae en **exactamente una** de tres categorías:

- **(a) rotación automática habilitada** — existe una función que cambia la
  credencial *también en el emisor*, no sólo el valor guardado.
- **(b) rotación manual con vencimiento y recordatorio activo** — la credencial
  la emite un tercero, se rota a mano y el cron de
  `credential-rotation-cron.js` avisa antes del vencimiento.
- **(c) rotado por el emisor, o no rotable** — el ciclo de vida lo controla el
  proveedor, o el dato no es un secreto rotable por calendario.

### Categoría por secreto (las 13 variables de `ENV_MAPPING`)

| Scope del vault | Variable | Cat. | Justificación |
|---|---|---|---|
| `telegram.bot_token` | `TELEGRAM_BOT_TOKEN` | **(b)** | Token emitido por BotFather. Se revoca y se re-emite a mano; ninguna API permite que el vault lo cambie del lado de Telegram. |
| `telegram.chat_id` | `TELEGRAM_CHAT_ID` | **(c)** | Identificador de destino, no credencial. Cambia sólo si cambia el chat. |
| `telegram.leo_operator_chat_id` | `TELEGRAM_LEO_OPERATOR_CHAT_ID` | **(c)** | Ídem: identificador del operador. |
| `providers.openai.api_key` | `OPENAI_API_KEY` | **(b)** | API key de tercero: se crea la sustituta en el panel, se actualiza el vault y recién ahí se revoca la anterior. |
| `providers.anthropic.api_key` | `ANTHROPIC_API_KEY` | **(c)** | El pipeline autentica con OAuth de Claude Max, no con API key. El cron ya la excluye por el sentinel `N/A (OAuth Max)`. |
| `providers.google.api_key` | `GEMINI_API_KEY` | **(b)** | API key de AI Studio, rotación manual en el panel del emisor. |
| `providers.cerebras.api_key` | `CEREBRAS_API_KEY` | **(b)** | Ídem, panel de Cerebras Cloud. |
| `providers.nvidia.api_key` | `NVIDIA_NIM_API_KEY` | **(b)** | Ídem, panel de NVIDIA build. |
| `providers.moonshot.api_key` | `ANTHROPIC_AUTH_TOKEN` | **(b)** | Token de Moonshot servido por la variable compatible con Anthropic; rotación manual en su consola. |
| `google_drive.oauth_client_id` | `GOOGLE_OAUTH_CLIENT_ID` | **(c)** | Identificador público del cliente OAuth, no es secreto. |
| `google_drive.oauth_client_secret` | `GOOGLE_OAUTH_CLIENT_SECRET` | **(b)** | Se rota desde la consola de Google Cloud y obliga a repetir el consentimiento. |
| `google_drive.oauth_refresh_token` | `GOOGLE_OAUTH_REFRESH_TOKEN` | **(c)** | Lo emite y lo revoca Google; el ciclo de vida no lo controla el pipeline. |
| `google_drive.drive_folder_id` | `GOOGLE_DRIVE_FOLDER_ID` | **(c)** | Identificador de carpeta, no credencial. |

**La categoría (a) está vacía, y eso es el resultado correcto — no un pendiente.**
Ningún secreto del vault lo emite Intrale: habilitar una función de rotación
"single user" de Secrets Manager sobre un token de tercero generaría un valor
nuevo del lado del vault que el emisor nunca conoce, y todos los agentes
fallarían a la vez. Se habilitará rotación automática el día que exista un
secreto cuyo emisor sea el propio proyecto. Además, la rotación automática se
cobra por secreto: encenderla sin que rote nada de verdad es costo sin control.

### Referencia por tipo

| Tipo | Ejemplos | Rotación | Plazo |
|---|---|---|---|
| API key o token de tercero | Anthropic, OpenAI, Gemini, Cerebras, NVIDIA, Moonshot, Telegram | Manual: revocar en el emisor, crear reemplazo y actualizar el vault | 90 días como máximo; recordatorios T-14, T-7, T-3, T-1 y T-0 |
| OAuth administrado por tercero | refresh token de Google Drive | No crear una Lambda: el emisor controla refresh y revocación | Vigilar revocación y repetir consentimiento cuando corresponda |
| Identificador no secreto | chat IDs, client ID, folder ID | No rota por calendario; cambia con el recurso | Revisar anualmente y al cambiar el recurso |
| Secreto con emisor controlado por Intrale | Ninguno actualmente | Automática sólo si una función actualiza también al emisor | Según criticidad y después de probar el ciclo completo |

La lista de secretos con rotación automática es actualmente vacía. Guardar
un token de tercero en Secrets Manager no lo vuelve rotable: cambiar sólo el
valor almacenado invalida consumidores sin actualizar al emisor.

## Rotación manual

1. Crear la credencial sustituta en el proveedor sin revocar la anterior.
2. Actualizar el vault con el rol de provisión, nunca con el rol de runtime.
3. Validar un acceso controlado sin imprimir el valor.
4. Revocar la credencial anterior en el proveedor.
5. Actualizar `last_rotated` y `expires_at` en `docs/secrets-inventory.md`.

La rehidratación transparente durante el spawn pertenece a #5440. Hasta que
ese issue cierre, una rotación se coordina con el reinicio operativo del Pulpo.

### Recordatorio de vencimiento

`credential-rotation-cron.js` lee `docs/secrets-inventory.md` y avisa en T-14,
T-7, T-3, T-1 y T-0. Reglas del inventario:

- **Sin fila no hay recordatorio.** La tabla tiene una fila por cada una de las
  13 variables de `ENV_MAPPING`; el test `inventario real · conserva exactamente
  las 13 variables de ENV_MAPPING` falla si alguien agrega un scope al vault y se
  olvida de la fila.
- Una credencial de categoría **(c)** se declara con el sentinel
  `N/A (<razón>)` en `last_rotated`/`expires_at`. El cron la excluye **con log**,
  no en silencio.
- Una credencial de categoría **(b)** todavía sin fechas se marca
  `_pendiente registrar_`. No desaparece del control: genera un recordatorio
  `METADATA-PENDIENTE` una vez por día hasta que se completen las fechas.
- Cuando varias credenciales caen en el **mismo threshold en el mismo tick**,
  sale **un** mensaje consolidado con la lista, no uno por credencial. Con 13
  filas cargadas, un mensaje por fila convertiría el recordatorio en spam y el
  operador dejaría de leerlo.

## Auditoría y alertas

`vault.access_audit` está apagado por defecto. Para el rollout se completa
`expected_principals` con los roles IAM de los hosts y luego se habilita el gate.
Una lista vacía omite el tick y lo registra en `pulpo.log`; no interpreta a todo
el mundo como atacante. `burst_threshold` ya está **calibrado** (`360
physical_read/ventana`, derivado del pico medido por la corrida de #5800): el
esquema lo exige como entero positivo siempre, así que encender el gate no puede
dejar la detección de ráfagas apagada — ver §Calibración del umbral de ráfaga
más abajo.

El tick consulta lecturas de SSM y Secrets Manager. Cada entrada del registro
tiene estos campos, y ninguno más:

| Campo | Contenido | Por qué |
|---|---|---|
| `timestamp` | Momento del evento según CloudTrail | El *cuándo* de CA-3. |
| `principal_logico` | `role/<nombre>` o `user/<nombre>` | El *quién*, consultable, sin account id ni ARN. La unidad es el **rol por host**: la sesión STS se colapsa al rol que la asumió. |
| `principal_hash` | SHA-256 del principal normalizado | Permite correlacionar la misma identidad entre entradas sin conservar la topología de la cuenta. |
| `scope_logico` | Nombre lógico del secreto pedido | El *qué*, sin el path completo del parámetro. |
| `almacen` | `parameter-store` o `secrets-manager` | Se deriva del nombre del evento, que es lo único que el rastro informa. El *tier* del vault (`rotating`/`static`) **no** es observable desde CloudTrail y por eso no se registra: inventarlo sería el mismo error que completar el scope de un `AccessDenied`. |
| `event_name` | Evento de AWS (`GetParameter`, …) | Ancla la entrada al evento del Event history. |
| `resultado` | `ok`, `denied` o `error` | El *resultado* de CA-3. |
| `causa` | Token del enum cerrado, o `null` | Nunca texto libre de AWS. |
| `evidencia` | `errorCode` redactado, o marcador cerrado del pipeline | Pasa por `redactAwsEvidence`; nunca `stderr` ni el valor del secreto. |

En un `AccessDenied`, CloudTrail puede entregar `requestParameters: null`; el
scope se registra entonces como `desconocido`, **sin inferir un nombre**.
Inferirlo mandaría a rotar la credencial equivocada.

Telegram recibe sólo un token de causa cerrado, su explicación, scope lógico y
correlation ID. ARN, account ID, IP y stderr de AWS no cruzan ese límite. El
cooldown silencia notificaciones repetidas, pero no el registro de eventos.

**El silencio del canal no significa "todo bien".** El bot de Telegram se
autentica con un secreto del propio vault, así que un vault comprometido o una
credencial revocada dejan la alerta sin salida. Por eso el registro es
fail-closed y la notificación es fail-soft: cuando el envío falla, el tick
escribe igual una entrada `VaultAuditNotification` / `resultado: error` /
`evidencia: NOTIFICACION_NO_ENVIADA` en el JSONL encadenado, y lo repite en
`pulpo.log`. Un tick que no corre también lo dice con su razón, en vez de quedar
indistinguible de "corrió y no encontró nada".

### Calibración del umbral de ráfaga

`vault.access_audit.burst_threshold` es el único número calibrado de esta
sección: los otros tres controles (allowlist de principals, rechazos de
autorización, cooldown) se derivan de la política, no de una medición.

#### Qué cuenta y qué no

La decisión de ráfaga consume **exclusivamente `physical_read`**. El vocabulario
de las tres categorías tiene una sola fuente de verdad,
`VAULT_TELEMETRY_CATEGORIES` en `.pipeline/lib/secret-vault.js` (#5803), y el
auditor la importa en vez de reescribirla.

| Categoría | ¿Entra al umbral? | Por qué |
|---|---|---|
| `physical_read` | **Sí** | Es la única resolución que sale del proceso y llega a AWS: la que factura, la que deja rastro en CloudTrail y la única que alguien puede provocar desde afuera. |
| `cache_hit` | No | La sirve la caché en memoria durante `cache_ttl_seconds`. No emite llamada a AWS y por lo tanto no aparece en el Event history: contarla mezclaría dos poblaciones distintas y ataría el umbral al hit rate. |
| `single_flight_join` | No | Es un consumidor que se colgó de una lectura física ya en vuelo. Contarla haría que un mismo acceso pese tantas veces como consumidores concurrentes tuvo. |

Dos clases más quedan fuera del numerador y se cuentan aparte como
`rechazados`: los `AccessDenied` (no leyeron ningún secreto, y ya tienen su
propio control en `authorization_failure_threshold`) y los eventos que el
evaluador no puede clasificar. Un evento desconocido o malformado se **rechaza
explícitamente y nunca se reclasifica** como lectura física: reclasificar por
defecto convertiría cualquier ruido en tráfico y correría el umbral solo.

#### Fórmula y unidades

```
burst_threshold    = ceil(pico_en_la_ventana * (1 + margen))
pico_en_la_ventana = peak_physical_reads_per_minute * lookback_min
```

| Magnitud | Unidad | De dónde sale |
|---|---|---|
| `peak_physical_reads_per_minute` | `physical_read/minute` | `.pipeline/audit/vault-load-calibration.json`, campo homónimo, publicado por la corrida productiva de #5800. |
| `lookback_min` | minutos | `vault.access_audit.lookback_min` (hoy `30`). Es la ventana que el tick consulta en cada pasada. |
| `pico_en_la_ventana` | `physical_read/ventana` | Conversión de la fila anterior a la ventana del auditor. |
| `margen` | fracción adimensional | Holgura declarada sobre el pico. Va documentada junto al número, no elegida al momento de configurar. |
| `burst_threshold` | `physical_read/ventana` | Entero seguro positivo. |

**La conversión de unidad no es opcional.** La calibración publica el pico *por
minuto*; el auditor cuenta lecturas físicas *acumuladas en `lookback_min`*.
Copiar el número por minuto directo a `burst_threshold` deja el umbral unas 30
veces por debajo del tráfico normal y produce una alerta por tick — que en la
práctica se resuelve silenciando el control.

La comparación es **estricta** (`lecturas_fisicas > burst_threshold`): un conteo
igual al umbral es carga normal. Si fuera `>=`, un umbral derivado del pico
alertaría exactamente en el pico, o sea en la carga que la calibración declaró
normal.

#### Estado actual: umbral calibrado en `360 physical_read/ventana`

`burst_threshold: 360`, derivado del pico medido por la corrida productiva de
#5800 sobre el HEAD de esta entrega. La derivación completa, con sustitución
numérica:

```
peak_physical_reads_per_minute = 6          (artefacto de la corrida)
lookback_min                   = 30         (vault.access_audit.lookback_min)

pico_ventana    = ceil(6 * 30)              = 180  physical_read/ventana
margen          = 1.0                              (100 %)
burst_threshold = ceil(180 * (1 + 1.0))     = 360  physical_read/ventana
```

`360 > 180`: el umbral **supera el pico observado** convertido a la unidad de la
ventana, que es la comparación válida. Comparar contra el pico *por minuto* sin
convertir es el error que la tabla de unidades de arriba existe para evitar.

##### Escenario de la corrida (reproducible)

| Parámetro | Valor | Por qué |
|---|---|---|
| `concurrency` | `32` | Techo de agentes concurrentes del pipeline: la suma de `concurrencia:` por rol en `.pipeline/config.yaml`, que domina a `max_concurrent_devs`. Medir con menos subdimensionaría el pico. |
| `launches` | `128` | `4 × concurrency`: cada slot se reusa varias veces dentro de la ventana. |
| `window_duration_ms` | `60000` | Ventana de un minuto, que es la unidad en la que la calibración publica el pico. |
| `bucket_ms` | `10000` | Seis buckets exactos; el pico es el bucket físico más cargado escalado a un minuto. |
| `distribution` | `sequential` | Reproducible con `sequence_seed`. |
| `unit` | `physical_read` | La única categoría que alimenta el pico. |

Resultado de la corrida, en la proyección **no sensible** del artefacto:

| Campo | Valor |
|---|---|
| `counts` | `physical_read: 1`, `cache_hit: 96`, `single_flight_join: 31`, `total_resolutions: 128` |
| `excluded_from_physical_metrics` | `cache_hit`, `single_flight_join` |
| `peak_physical_reads_per_minute` | `6` |
| `peak_unit` | `physical_read/minute` |
| `peak_basis` | `physical_reads_per_bucket: 1`, `bucket_ms: 10000` |

Los 96 `cache_hit` y los 31 `single_flight_join` son exactamente la población
que **no** entra al umbral: 127 de las 128 resoluciones nunca salieron del
proceso. Que el numerador sea `1` sobre `128` es la evidencia de que la
exclusividad del contador funciona, no un defecto de la corrida.

El artefacto `.pipeline/audit/vault-load-calibration.json` **no se versiona** —
`.gitignore` cubre `.pipeline/audit/` entero, que existe justamente para no
versionar auditoría local. Por eso la evidencia viaja **transcripta** acá y al
comentario del YAML, y sólo con campos no sensibles: nunca el `scope_logico` con
su path, ni ARN, account id, IP o salida cruda del driver.

##### Por qué el margen es `1.0` y no otro número

El margen es un **parámetro nombrado**, no una elección del momento de
configurar: una recalibración futura cambia este número con su justificación, en
vez de re-derivar todo desde cero.

- El pico viene de una corrida de carga **generada**, de ventana corta y una
  sola muestra: es un punto, no una distribución. Un margen chico sobre un punto
  sintético produce falsos positivos apenas la carga real se desvía.
- El control detecta **anomalía gruesa** (lazo de reintentos, uso indebido), no
  hace capacity planning. Una ráfaga real es de orden de magnitud, no de un
  20 %: un factor 2 la sigue detectando.
- El costo del falso positivo es asimétrico, y el propio copy de la alerta lo
  reconoce: una alerta ruidosa induce al operador a **subir el umbral a mano**,
  que es exactamente lo que ese texto prohíbe. Un umbral ruidoso se degrada solo.
- Más de `2.0` tampoco sirve: el umbral quedaría por encima del tráfico de un
  arranque completo del pipeline y el control dejaría de distinguir «ráfaga» de
  «operación normal en pico».

##### Cambiar `lookback_min` invalida este umbral

`burst_threshold` está expresado en `physical_read` **por ventana de
`lookback_min` minutos**. Bajar la ventana a 10 dejaría el umbral 3×
sobredimensionado y el control apagado de hecho, sin que nada lo avise. Si se
cambia la ventana hay que **recalcular** el umbral con la fórmula de arriba, no
ajustarlo a ojo. Un test de regresión fija los dos valores juntos
(`config-schema.test.js`, `vault-access-audit-burst-5801.test.js`).

Lo mismo si la alerta suena: se **recalibra** con una corrida nueva, no se sube
el número a mano.

##### Cómo volver a correr la calibración

Runbook completo en [`vault-calibracion-carga.md`](vault-calibracion-carga.md)
§3. La corrida exige árbol de trabajo limpio, las cuatro dependencias integradas
en HEAD y el vault resolviendo contra AWS con la identidad de **sólo lectura**
del host. Los dos valores locales del host que `.pipeline/config.yaml` commitea
vacíos a propósito por ser un repo público —el gate `vault.enabled` y el nombre
de perfil `vault.awsProfile`— los aporta el operador en su entorno; no se
commitean para correr la medición.

Los códigos de salida son estables y discriminan por número: `3` repo/HEAD,
`4` identidad/scopes, `5` escenario o acceso al vault, `7` disco. Si la corrida
no cierra, se cita el código — **no se elige un umbral sin el pico medido**.

#### Lo que el esquema garantiza

`.pipeline/lib/config-schema.js` valida `vault.access_audit` **cerrado y sin
condicionales**: `required: ['burst_threshold']`, `type: 'integer'`,
`minimum: 1`, `maximum: Number.MAX_SAFE_INTEGER` y
`additionalProperties: false`, con Ajv corriendo sin `coerceTypes`.

| `burst_threshold` | Resultado al arrancar |
|---|---|
| ausente | **`ConfigSchemaViolation`** |
| `0` o negativo | **`ConfigSchemaViolation`** |
| `"360"`, `true`, `null`, `360.5`, `NaN`, `±Infinity`, entero inseguro | **`ConfigSchemaViolation`** |
| clave desconocida bajo `access_audit` (p. ej. `burst_threshhold`) | **`ConfigSchemaViolation`** |
| entero ≥ 1 | arranca |

El `required` es **incondicional**: ya no depende de `access_audit.enabled`.
Mientras faltaba el pico medido vivía en una rama `if enabled === true`, porque
exigirlo sin el número habría dejado el pipeline sin arrancar. Con el umbral
calibrado en el mismo commit esa ventana no existe, y el estado «apagado con
umbral cero» deja de ser representable: un cero guardado esperando a que alguien
encienda el gate es la forma más silenciosa de dejar la detección apagada.

`additionalProperties: false` obliga a que las **7** claves de la sección estén
declaradas en el esquema (`enabled`, `poll_interval_min`, `lookback_min`,
`expected_principals`, `burst_threshold`, `authorization_failure_threshold`,
`cooldown_min`). Omitir una dejaría el pipeline arrancando pausado; un test de
regresión compara esa lista contra el `config.yaml` real.

El control de runtime es independiente a propósito: `evaluateAccessEvents`
**lanza** ante un umbral inválido, en vez de degradar a «no hay ráfaga». Antes
había ahí un fail-OPEN —`Number(cfg.burst_threshold || 0)` más el guard
`burstThreshold > 0 &&`— que apagaba la detección en silencio por cualquier
camino que no pasara por el esquema. `pulpo.js` envuelve el tick en `try/catch`
y registra el mensaje, así que el pipeline no se cae: queda ruidoso, que es lo
contrario del silencio anterior.

#### La ventana que se cuenta es la ventana completa

El conteo de lecturas físicas cubre **toda la ventana `lookback_min`**, no los
eventos nuevos del tick. El dedupe entre ticks sigue existiendo, pero gobierna
sólo el **rastro** y las **alertas** (no se reescriben registros ni se
renotifica): si gobernara además el conteo, el denominador dependería de la
cadencia del poll —~`poll_interval_min` en régimen, `lookback_min` en el primer
tick tras un reset de estado— y un mismo umbral se compararía contra dos
unidades distintas.

Consecuencia prevista y deseada: mientras la ráfaga siga dentro del lookback, se
vuelve a detectar en cada tick. El registro auditable repetido es la evidencia de
que el tráfico sigue; la **notificación** la deduplica `cooldown_min`.

#### Qué dice la alerta

Cuando la ráfaga se dispara, el diagnóstico va **después** de la acción y lleva
etiquetas y unidades explícitas, para que el operador pueda distinguir las dos
lecturas posibles —el umbral quedó corto, o hay tráfico que no debería existir—
que llevan a acciones opuestas:

```
Lecturas fisicas (physical_read): 9
Umbral configurado: 4 physical_read/ventana
Ventana evaluada: 30 minutos
Contexto que NO cuenta para el umbral: cache_hit=71, single_flight_join=5
```

Los tres contadores se nombran con el vocabulario del vault justamente para que
`cache_hit` y `single_flight_join` se lean como contexto y no como parte del
veredicto. Todos los valores son enteros que produce el pipeline: ninguno viene
del driver de AWS.

#### La detección se registra aunque no se notifique

Detección y notificación son dos cosas. El cooldown decide si se vuelve a
molestar al operador, **nunca** si la detección queda registrada: cada detección
deja una entrada `VaultAuditDetection` en el JSONL encadenado *antes* de
intentar el envío, con `notificada: true|false`. Sin esa separación, una ráfaga
sostenida dejaba de existir en el rastro después de la primera alerta — que es
justo el hueco por el que se esconden las ráfagas siguientes. Un fallo del canal
de Telegram tampoco revierte ni borra lo ya registrado.

## Consultar Event history

**Todo comando `aws` de este runbook va prefijado con `MSYS_NO_PATHCONV=1`.** Sin
eso, Git Bash reescribe un argumento que arranca con `/` — por ejemplo
`--name "/intrale/project/shared/providers"` — a
`C:/Program Files/Git/intrale/project/shared/providers`. El comando entonces
falla con un `ParameterNotFound` que **miente**: el parámetro existe, lo que no
existe es el nombre que MSYS inventó. Peor todavía: ese nombre apócrifo queda
registrado en el propio rastro de auditoría, así que la mentira sobrevive a la
sesión. El driver del pipeline no está afectado (invoca la CLI con
`execFileSync` sin shell); esto aplica a los comandos manuales del runbook y de
QA.

**El Event history de CloudTrail es POR REGIÓN.** Una consulta apuntada a la
región equivocada no falla: devuelve `Events: 0`, que es indistinguible de
"nadie accedió al vault". Es un falso negativo silencioso sobre la única
superficie de consulta de este runbook, así que la región **no se escribe a
mano**: sale de `kernel.region` en `config.yaml`, que es la misma que usa el
runtime (`pulpo.js` se la pasa a `runAccessAuditTick`). Cuidado con `us-east-1`:
aparece en `vault-secretos-aws.md` sólo como región de referencia de *precios*,
y **no** es la región del vault.

```bash
VAULT_REGION=$(node -e "console.log(require('./.pipeline/lib/config-resolver').resolve({pipelineDir:'.pipeline'}).kernel.region)" 2>/dev/null)
echo "$VAULT_REGION"   # verificar que imprime la región del vault antes de seguir

MSYS_NO_PATHCONV=1 aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=GetParameter --start-time 2026-08-03T00:00:00Z --end-time 2026-08-03T23:59:59Z --region "$VAULT_REGION" --output json --no-cli-pager
MSYS_NO_PATHCONV=1 aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue --start-time 2026-08-03T00:00:00Z --end-time 2026-08-03T23:59:59Z --region "$VAULT_REGION" --output json --no-cli-pager
```

Si `$VAULT_REGION` sale vacío, **parar**: `--region ""` no consulta la región
del vault y el `Events: 0` resultante no significa nada. Un `Events: 0` sólo es
evidencia de "no hubo accesos" si antes se confirmó que la región impresa es la
del vault.

Antes de adjuntar evidencia se eliminan ARN, account IDs, IPs y cualquier salida
de error cruda — usar `redactAwsEvidence` de `.pipeline/lib/kernel-table-verify.js`
en vez de recortar a mano:

```bash
node -e "const {redactAwsEvidence}=require('./.pipeline/lib/kernel-table-verify'); console.log(redactAwsEvidence(require('fs').readFileSync(0,'utf8')))" < evidencia.json
```

El complemento local se consulta y se verifica así:

```bash
node -e "console.log(require('./.pipeline/lib/audit-log').verifyChain('.pipeline/logs/vault-access-audit.jsonl'))"
node -e "for (const e of require('./.pipeline/lib/audit-log').readAll('.pipeline/logs/vault-access-audit.jsonl')) console.log(e.timestamp, e.principal_logico, e.scope_logico, e.resultado, e.causa || '-')"
```

`verifyChain` es lo que permite demostrar que el rastro local no fue editado.
Aun así **la fuente de verdad es CloudTrail**: el proceso auditado tiene permiso
de escritura sobre `.pipeline/`, así que un registro que él mismo puede borrar no
alcanza como auditoría.

Este flujo **no crea trails ni modifica event selectors**: el Event history
retiene 90 días de eventos de gestión sin costo y sin competir con #5212, que es
el dueño del trail. Dos issues configurando el mismo trail hacen que el segundo
pise los event selectors del primero.

## Retención y límites conocidos

- **90 días.** Es lo que retiene el Event history. Retención mayor exige un
  trail con bucket, que es una decisión de costo y le corresponde a #5212.
- **Latencia.** Un evento tarda minutos en aparecer en el Event history; por eso
  `lookback_min` (30) se solapa con `poll_interval_min` (10), para no perder
  eventos en el borde de la ventana.
- **`AccessDenied` sin scope.** Ver arriba: se sabe *quién* y *cuándo*, no *qué*
  se pidió.
- **Rotación transparente.** No entra acá; es #5440.
