# docs/secrets-inventory.md — Inventario de credenciales del pipeline V3

> Inventario **declarativo** de las credenciales que el pipeline V3 usa. Este
> documento contiene SÓLO metadata (provider, env var, owner, fechas, links).
> Acá NUNCA aparece el valor de un secret, ni un prefijo, ni los "primeros 4
> chars" — aunque suene inofensivo, los logs van a Telegram/PDFs/dashboard y un
> atacante con acceso parcial a esos canales pivota desde el prefijo.

## Documento complementario

Este archivo cubre la **metadata de rotación**. La **ubicación, durabilidad y
alcance de migración** de cada credencial viven en
[`docs/pipeline/inventario-credenciales.md`](pipeline/inventario-credenciales.md)
(producido por el spike #5216, parte del épico #5215).

| Documento | Responde |
|---|---|
| `docs/secrets-inventory.md` (este archivo) | Quién es el owner, cuándo se rotó, cuándo vence, contra qué cuenta se rota y con qué runbook. Es el insumo del cron `credential-rotation-cron.js`. |
| [`docs/pipeline/inventario-credenciales.md`](pipeline/inventario-credenciales.md) | Qué credenciales existen, si son de kernel o de producto, si sobreviven a un respawn del entorno, y si entran en la migración al store único (#5217). |

Los dos son públicos y **no se solapan**. Al dar de alta una credencial, agregarla
a **ambos**: acá para programar su rotación, allá para planificar su migración.
La restricción de contenido de este archivo (sólo metadata, nunca valores ni
prefijos) aplica igual al otro documento.

## ¿Cómo se usa?

1. Cuando se agrega un nuevo provider al pipeline (ver
   [`docs/pipeline-multi-provider.md`](pipeline-multi-provider.md)), se agrega una
   fila a la tabla.
2. El campo `expires_at` se calcula como `last_rotated + 90 días`. La política
   de rotación es **≤ 90 días** por convención.
3. El cron `lib/credential-rotation-cron.js` corre dentro de `pulpo.js` y cada
   hora compara `expires_at` contra `now()` (UTC). Notifica al `owner` por
   Telegram en T-14, T-7, T-3, T-1 días, y escala a `priority:critical` cuando
   pasa la fecha sin rotar.
4. Para rotar, seguir el runbook: [`docs/runbooks/credential-rotation.md`](runbooks/credential-rotation.md).
5. Después de rotar, **commitear** la actualización del campo `last_rotated`
   en este archivo. El cron NO toca este archivo: la fuente de verdad es git.

## Tabla de credenciales activas

| project_id | provider | env_var | owner | last_rotated | expires_at | account_id | rotation_runbook_url | revocation_endpoint |
|------------|----------|---------|-------|--------------|------------|------------|----------------------|---------------------|
| kernel | telegram-bot | `TELEGRAM_BOT_TOKEN` | leitolarreta | _pendiente registrar_ | _pendiente registrar_ | `intrale-pipeline-v3` | [runbook](pipeline/vault-rotacion-auditoria.md#rotación-manual) | https://t.me/BotFather |
| kernel | telegram-chat | `TELEGRAM_CHAT_ID` | leitolarreta | N/A (identificador) | N/A (identificador) | `intrale-pipeline-v3` | [política](pipeline/vault-rotacion-auditoria.md#clasificación) | N/A |
| kernel | telegram-operator | `TELEGRAM_LEO_OPERATOR_CHAT_ID` | leitolarreta | N/A (identificador) | N/A (identificador) | `intrale-pipeline-v3` | [política](pipeline/vault-rotacion-auditoria.md#clasificación) | N/A |
| kernel | openai-codex | `OPENAI_API_KEY` | leitolarreta | _pendiente alta_ | _pendiente alta_ | _pendiente alta_ | [runbook](runbooks/credential-rotation.md#openai) | https://platform.openai.com/api-keys |
| kernel | anthropic | `ANTHROPIC_API_KEY` | leitolarreta | N/A (OAuth Max) | N/A (OAuth Max) | `intrale-pipeline-v3` | [runbook](runbooks/credential-rotation.md#anthropic) | https://console.anthropic.com/settings/keys |
| kernel | google-ai | `GEMINI_API_KEY` | leitolarreta | _pendiente registrar_ | _pendiente registrar_ | `intrale-pipeline-v3` | [runbook](pipeline/vault-rotacion-auditoria.md#rotación-manual) | https://aistudio.google.com/app/apikey |
| kernel | cerebras | `CEREBRAS_API_KEY` | leitolarreta | _pendiente registrar_ | _pendiente registrar_ | `intrale-pipeline-v3` | [runbook](pipeline/vault-rotacion-auditoria.md#rotación-manual) | https://cloud.cerebras.ai/ |
| kernel | nvidia-nim | `NVIDIA_NIM_API_KEY` | leitolarreta | _pendiente registrar_ | _pendiente registrar_ | `intrale-pipeline-v3` | [runbook](runbooks/credential-rotation.md#nvidia-nim) | https://build.nvidia.com/settings/api-keys |
| kernel | moonshot | `ANTHROPIC_AUTH_TOKEN` | leitolarreta | _pendiente registrar_ | _pendiente registrar_ | `intrale-pipeline-v3` | [runbook](pipeline/vault-rotacion-auditoria.md#rotación-manual) | https://platform.moonshot.ai/console/api-keys |
| kernel | google-drive-client | `GOOGLE_OAUTH_CLIENT_ID` | leitolarreta | N/A (identificador) | N/A (identificador) | `intrale-pipeline-v3` | [política](pipeline/vault-rotacion-auditoria.md#clasificación) | N/A |
| kernel | google-drive-client-secret | `GOOGLE_OAUTH_CLIENT_SECRET` | leitolarreta | _pendiente registrar_ | _pendiente registrar_ | `intrale-pipeline-v3` | [runbook](pipeline/vault-rotacion-auditoria.md#rotación-manual) | https://console.cloud.google.com/apis/credentials |
| kernel | google-drive-refresh | `GOOGLE_OAUTH_REFRESH_TOKEN` | leitolarreta | N/A (OAuth administrado por tercero) | N/A (OAuth administrado por tercero) | `intrale-pipeline-v3` | [política](pipeline/vault-rotacion-auditoria.md#clasificación) | https://myaccount.google.com/permissions |
| kernel | google-drive-folder | `GOOGLE_DRIVE_FOLDER_ID` | leitolarreta | N/A (identificador) | N/A (identificador) | `intrale-pipeline-v3` | [política](pipeline/vault-rotacion-auditoria.md#clasificación) | N/A |

**Notas**:

- `project_id` es el **eje de namespace** de la credencial (#5901). Es una
  columna **obligatoria**: el cron de rotación indexa su estado por el par
  `(project_id, env_var)`, así que dos productos que compartan el nombre de
  variable no comparten casillero. **No hay default silencioso**: una celda
  ausente, vacía o con un slug que no cumpla `^[a-z0-9][a-z0-9-]{1,63}$` hace
  que la fila se excluya del cron CON rastro (`errors[]` del tick + log), no
  que se asuma `kernel`. El slug `kernel` está reservado para las credenciales
  de la plataforma (las 13 filas de hoy lo son) y se muestra al operador como
  `Kernel (plataforma)`. Ver `.pipeline/lib/safe-project-id.js`.

- `account_id` es un **identificador opaco** que el provider asocia a la cuenta
  emisora del token (ej: nombre del workspace, organization id). NO es el
  secret. Sirve para que la persona que rota sepa contra qué cuenta operar.
- `anthropic` se autentica en este entorno con **OAuth Max** (credencial de
  plan, login del CLI de Claude), **no** con `ANTHROPIC_API_KEY`. Por eso las
  celdas `last_rotated`/`expires_at` llevan el sentinel `N/A (OAuth Max)`: el
  cron de rotación reconoce el token `oauth` y **excluye** la fila (la emite con
  `applies:false` y lo loguea, en vez de descartarla en silencio). No hay API
  key que rotar, así que el recordatorio no aplica. Si a futuro se diera de alta
  una `ANTHROPIC_API_KEY` real, reemplazar el sentinel por fechas ISO reales.
- `openai-codex` está declarado en `agent-models.json` como provider opcional
  (referenciado por skills futuros vía rollout #3079). Mientras no haya skill
  asignado, NO requiere credencial inyectada y el cron no genera recordatorios.
  Cuando un skill lo use, hay que dar de alta `OPENAI_API_KEY` y completar la
  fila acá.

## Reglas inquebrantables

- **No pegar el secret**. Ni el valor, ni los primeros 4 chars, ni un screenshot
  con la key visible.
- **No pegar prefijos del secret** (ej: `sk-ant-...XYZ`). Aunque ASCII art
  sugiera ofuscación, el prefijo deja huella.
- **No screenshots de consolas con keys visibles**. Si necesitás documentar la
  consola del provider, recortar a la parte de metadata (id de cuenta, fecha
  de creación) y NUNCA a la columna que muestra el token.
- **Fuente de verdad de `last_rotated`**: el commit que actualiza este archivo.
  Ningún cron, ninguna tarea automática edita este markdown.
- **Formato de fechas**: ISO 8601 estricto `YYYY-MM-DD`. El cron parsea con
  `new Date()` y otros formatos pueden fallar silenciosamente (riesgo: el
  recordatorio no se dispara nunca).
- **Si una credencial se rotó por incidente** (no por vencimiento programado):
  igual hay que actualizar `last_rotated` con la fecha de la rotación. El
  inventario refleja el último cambio efectivo, no la programación teórica.
- **Si una credencial se revocó** (ya no se usa): borrar la fila completa **en
  el mismo PR** que remueve el provider de `agent-models.json`. No dejar
  filas huérfanas.

## Inventario cerrado contra el vault (#5453 · CA-25)

La tabla de arriba responde *"¿cuándo hay que rotar esto?"*. Esta sección
responde la otra pregunta del cutover: *"¿está TODO el inventario declarado en
el vault, o quedó algo que va a caer al archivo el día que cortemos?"*.

**El inventario no se mantiene a mano.** Los tres conjuntos que tienen que
coincidir se derivan de código y config, y el preflight de
[`.pipeline/lib/vault-migration.js`](../.pipeline/lib/vault-migration.js) los
compara en **las dos direcciones** antes de dejar arrancar una ventana de
migración:

| Conjunto | De dónde sale | Quién lo verifica |
|---|---|---|
| Descriptores lógicos | `Object.keys(ENV_DESCRIPTORS)` (`.pipeline/lib/credentials.js`) | denominador de la matriz de cobertura |
| Scopes del vault | `vaultScopePlan(ENV_DESCRIPTORS)` → primer segmento del dot-path | contra `vault.required_scopes` |
| Scopes compartidos | descriptores con `shared: true` | contra `vault.shared_secrets` |

Reglas del contraste, y por qué cada una es fail-closed:

- **Falta un scope en `required_scopes`** ⇒ `inventario_incompleto`. El vault no
  lo resolvería y ese secreto caería al archivo *sin que nadie lo note*: la
  ventana cerraría en verde con un agujero adentro.
- **Sobra un scope en `required_scopes`** ⇒ `inventario_divergente`. La allowlist
  estaría autorizando más de lo que el código pide.
- **`required_scopes: []`** ⇒ `inventario_incompleto`, **no** "todo declarado".
  Con la lista vacía la comparación se cumple *vacuamente*. Este fue el estado
  real del repo hasta #5453 y es exactamente el fail-open que la regla cierra.
- **Un scope en `shared_secrets` sin descriptor `shared: true`** ⇒
  `inventario_divergente`: saca material del namespace del host
  (`hosts/<hostId>/`) al namespace común sin que el código lo haya pedido.

### Estado declarado hoy

| Scope lógico | Backend | Compartido | Descriptores que lo componen |
|---|---|---|---|
| `telegram` | ssm | sí | `telegram.bot_token`, `telegram.chat_id`, `telegram.leo_operator_chat_id` |
| `providers` | ssm | sí | `providers.openai.api_key`, `providers.anthropic.api_key`, `providers.google.api_key`, `providers.cerebras.api_key`, `providers.nvidia.api_key`, `providers.moonshot.api_key` |
| `google_drive` | ssm + secretsmanager | sí | `google_drive.oauth_client_id`, `google_drive.oauth_client_secret`, `google_drive.oauth_refresh_token`, `google_drive.drive_folder_id` |

- **Owner de los tres scopes**: `leitolarreta` (mismo owner que las filas de la
  tabla de rotación de arriba; el vault no introduce un owner nuevo).
- **`multimedia` y `aws`** pertenecen al vocabulario de scopes pero **no tienen
  descriptor**: declararlos en `required_scopes` sería divergencia, no previsión.
- **Por qué los tres son compartidos**: son credenciales del *pipeline* (bot de
  Telegram, API keys de providers, OAuth de Drive), no de una máquina.
  Duplicarlas por host multiplicaría el trabajo de rotación por la cantidad de
  hosts sin agregar aislamiento real — el blast radius de una API key filtrada es
  el mismo esté donde esté. El namespace por host queda reservado para material
  que sí es del host (la raíz de confianza de #5426).

### Al dar de alta un descriptor nuevo

En el **mismo commit**:

1. agregar el descriptor a `ENV_DESCRIPTORS`;
2. agregar su fila a la tabla de rotación de arriba (con `owner` y fechas ISO);
3. si estrena un scope, agregarlo a `vault.required_scopes` — y a
   `vault.shared_secrets` sólo si el descriptor declara `shared: true`.

Saltarse (3) no rompe el boot: rompe la **siguiente** ventana de migración, con
`inventario_incompleto` y sin decir cuál falta hasta que alguien mire el diff.

### Qué NUNCA va en la evidencia de la migración

La evidencia que produce el coordinador usa un **modelo cerrado** (lista blanca
de campos, `sanitizeEvidence()`): nombres lógicos, conteos, timestamps ISO,
enums de etapa y de causa. Quedan afuera **por construcción**, no por
convención: valores, prefijos, hashes, nombres de env var, paths, PIDs,
namespaces del vault, account ids y cualquier otra metadata de infraestructura.
Un `rotacion_version` que llegue con pinta de material se reemplaza por el
marcador de redacción antes de salir del proceso.

## ¿Qué NO está en este archivo?

- **Detección de leaks**: este archivo es declarativo. La detección de leaks
  en archivos trackeados se hace con `gitleaks` (recomendación #3101, pendiente).
- **Audit log de uso**: qué proceso usó qué credencial cuando, eso vive en
  `.pipeline/logs/credential-rotations.log` (issue S5, pendiente).
- **PIPELINE_PROVIDER_OVERRIDE break-glass**: ese flag tiene su propio audit
  log append-only (`.pipeline/logs/credential-overrides.log`) y está fuera de
  scope de este inventario. Ver §6.9 de `docs/pipeline-multi-provider.md`.
