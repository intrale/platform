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
el mundo como atacante. `burst_threshold: 0` mantiene la detección de ráfagas
apagada hasta medir el tráfico real de #5440.

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

## Consultar Event history

**Todo comando `aws` de este runbook va prefijado con `MSYS_NO_PATHCONV=1`.** Sin
eso, Git Bash reescribe un argumento que arranca con `/` — por ejemplo
`--name "/intrale/project/shared/providers"` — a
`C:/Program Files/Git/intrale/project/shared/providers`. El comando entonces
falla con un `ParameterNotFound` que **miente**: el parámetro existe, lo que no
existe es el nombre que MSYS inventó. Peor todavía: ese nombre apócrifo queda
registrado en el propio rastro de auditoría, así que la mentira sobrevive a la
sesión. El driver del pipeline no está afectado (invoca la CLI con `spawn` sin
shell); esto aplica a los comandos manuales del runbook y de QA.

```bash
MSYS_NO_PATHCONV=1 aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=GetParameter --start-time 2026-08-03T00:00:00Z --end-time 2026-08-03T23:59:59Z --region us-east-1 --output json --no-cli-pager
MSYS_NO_PATHCONV=1 aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue --start-time 2026-08-03T00:00:00Z --end-time 2026-08-03T23:59:59Z --region us-east-1 --output json --no-cli-pager
```

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
