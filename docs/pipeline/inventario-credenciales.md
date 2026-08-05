# Inventario de credenciales del pipeline y del producto

> **Versión pública reducida.** Este documento contiene **sólo metadata de
> planificación**: identificador, servicio, dueño, durabilidad y si la credencial
> entra en el alcance de la migración al store único (#5217).
>
> **Deliberadamente NO contiene**: puntos de lectura (`archivo:línea`), cadenas de
> resolución, descripción de criticidad, ni modos de falla de ningún consumidor.
> Este repositorio es **público**: esa información es un mapa de superficie de
> ataque, no documentación. Vive exclusivamente en el entregable sensible (ver
> [§ Entregable detallado](#entregable-detallado)).
>
> Tampoco contiene ningún valor de secreto, prefijo, hash ni "primeros 4 chars".

Producido por el spike **#5216**, parte del épico **#5215** (vault de secretos del
pipeline). Relevamiento hecho sobre `HEAD 097c6c3e`.

## Relación con `docs/secrets-inventory.md`

Los dos documentos son complementarios y **no se solapan**. División de alcance:

| Documento | Responde |
|---|---|
| [`docs/secrets-inventory.md`](../secrets-inventory.md) | **Metadata de rotación**: quién es el owner, cuándo se rotó por última vez, cuándo vence, contra qué cuenta se rota y con qué runbook. Es el insumo del cron `credential-rotation-cron.js`. |
| `docs/pipeline/inventario-credenciales.md` (este archivo) | **Ubicación, durabilidad y alcance de migración**: qué credenciales existen, quién es su dueño (kernel o producto), si sobreviven a un respawn del entorno, y si entran en #5217. |

Si una credencial se da de alta, se agrega a **ambos**: acá para planificar su
migración, allá para programar su rotación.

## Método del relevamiento

El barrido se hizo **por evidencia, no por memoria**. Cada credencial listada
tiene al menos un punto de lectura real verificado en el código (registrado en el
entregable sensible, no acá).

**Árboles cubiertos (8):** `.pipeline/`, `.claude/hooks/`, `qa/scripts/`,
`scripts/`, `backend/`, `users/`, `app/composeApp/`, `.github/workflows/`.
**Además:** variables de entorno propagadas a los procesos hijos de los agentes y
perfiles de configuración externos al repo (`~/.claude/`, `~/.aws/`, credential
helper de git).

**Exclusiones fijas del barrido** — `_tmp/`, `.claude/worktrees/`,
`node_modules/`, `.git/`.

*Motivo:* esos directorios son **copias** del repositorio. Replican los mismos
consumidores y producen puntos de lectura falsos que apuntan a árboles muertos,
lo que vuelve el inventario inauditable. Medición sobre el repo vivo con la unión
de los identificadores relevados: **847 coincidencias sin exclusiones vs 152 con
exclusiones** — el 82% del resultado crudo era ruido de copias. Esas copias son
superficie del issue **#5220**, no del pipeline vivo.

**Criterio de durabilidad** — se clasificó por método objetivo, sin ejecutar un
`reset --hard` destructivo:

- **volátil** — el archivo que la contiene está versionado en el repo (`git ls-files`
  lo devuelve), por lo que se pisa en cada respawn del entorno.
- **durable** — vive fuera del árbol del repositorio, o es un secret de CI
  gestionado del lado de GitHub.

> La clasificación `durable` indica **dónde está guardada**, no que la credencial
> esté sana. Una credencial puede estar correctamente guardada en un almacén
> durable y aun así no llegar a su consumidor. El detalle de esos casos está en el
> entregable sensible y es insumo de #5217 y #5218.

## Inventario

### Telegram

| Identificador | Servicio | Dueño | Durabilidad | ¿Entra en #5217? |
|---|---|---|---|---|
| `telegram.bot_token` | Telegram Bot API | kernel | durable | **sí** — unificación de fuentes |
| `telegram.chat_id` | Telegram Bot API | kernel | durable | **sí** — unificación de fuentes |
| `telegram.leo_operator_chat_id` | Telegram (identidad del operador) | kernel | durable | **sí** — alta pendiente en el store |
| `TELEGRAM_ALLOWED_USER_IDS` | Telegram (allowlist de emisores) | kernel | volátil | **sí** — sólo existe como variable de entorno |
| `bot_token` / `chat_id` (config versionada) | Telegram Bot API | kernel | **volátil** | **sí** — es el grupo más numeroso del inventario |

### Providers de IA

| Identificador | Servicio | Dueño | Durabilidad | ¿Entra en #5217? |
|---|---|---|---|---|
| `providers.openai.api_key` | OpenAI | kernel | durable | **sí** — unificación de fuentes |
| `providers.anthropic.api_key` | Anthropic | kernel | durable | **sí** — decidir alta o declarar N/A (el pipeline usa OAuth Max) |
| `providers.moonshot.api_key` | Kimi / Moonshot | kernel | durable | **sí** — alta pendiente en el store |
| `providers.google.api_key` | Google AI Studio / Gemini | kernel | durable | **sí** |
| `providers.cerebras.api_key` | Cerebras Cloud | kernel | durable | **sí** |
| `providers.nvidia.api_key` | NVIDIA NIM | kernel | durable | **sí** |
| `openai_api_key` / `anthropic_api_key` (respaldo ad-hoc) | OpenAI / Anthropic | kernel | durable | **sí** — almacén adicional no declarado en el épico; absorber o eliminar |
| `ANTHROPIC_API_KEY` (backend) | Anthropic | **producto** | volátil | **sí** — dueño producto, namespaceado en #5219 |

### Google Drive / OAuth

| Identificador | Servicio | Dueño | Durabilidad | ¿Entra en #5217? |
|---|---|---|---|---|
| `google_drive.oauth_client_id` | Google OAuth (Drive) | kernel | durable | **sí** — caso testigo del épico |
| `google_drive.oauth_client_secret` | Google OAuth (Drive) | kernel | durable | **sí** — caso testigo del épico |
| `google_drive.oauth_refresh_token` | Google OAuth (Drive) | kernel | durable | **sí** — caso testigo del épico |
| `google_drive.drive_folder_id` | Google Drive (carpeta destino) | kernel | durable | **sí** |
| `GOOGLE_CREDENTIALS_PATH` | Google Drive (service account) | kernel | volátil | **sí** |

> **Actualización (#5172).** El caso testigo quedó cerrado del lado del consumo:
> las cuatro claves `google_drive.*` ya están en el `ENV_MAPPING` de
> `.pipeline/lib/credentials.js` y se hidratan como `GOOGLE_OAUTH_CLIENT_ID`,
> `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` y
> `GOOGLE_DRIVE_FOLDER_ID`. Antes vivían **sólo** en el archivo versionado
> `.claude/hooks/telegram-config.json`, cuya copia commiteada no las contiene:
> cada respawn con `git reset --hard` las borraba y `qa-video-share` abortaba con
> "Google Drive no configurado", perdiendo la evidencia de QA. `qa-video-share`
> resuelve ahora con precedencia `env > store > legacy` y
> `scripts/google-drive-oauth-setup.js` persiste en el store externo, no en el repo.

### Cloudflare R2

| Identificador | Servicio | Dueño | Durabilidad | ¿Entra en #5217? |
|---|---|---|---|---|
| `R2_ACCOUNT_ID` | Cloudflare R2 | kernel | **volátil** | **sí** — no existe en ningún almacén, requiere alta |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 | kernel | **volátil** | **sí** — no existe en ningún almacén, requiere alta |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 | kernel | **volátil** | **sí** — no existe en ningún almacén, requiere alta |
| `R2_BUCKET` | Cloudflare R2 | kernel | **volátil** | **sí** — no existe en ningún almacén, requiere alta |

### AWS

| Identificador | Servicio | Dueño | Durabilidad | ¿Entra en #5217? |
|---|---|---|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` (scope del pipeline) | AWS CLI / DynamoDB | kernel | volátil | **sí** |
| `aws.access_key_id` / `aws.secret_access_key` | AWS | kernel | durable | **sí** — requiere trabajo de cableado, no sólo de almacenamiento |
| `aws.region` / `aws.profile` / `aws.table_name` / `aws.coordination_table_name` | AWS (configuración) | kernel | durable | **sí** — mismo tratamiento que las claves de arriba |
| Perfiles del CLI (`intrale`, `kernel-runtime`, `default`) | AWS CLI | kernel | durable | **parcial** — el vault no reemplaza `~/.aws`, pero debe declararlo |
| `REGION_VALUE` / `ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` | AWS DynamoDB (backend) | **producto** | **volátil** | **sí** — dueño producto |
| `USER_POOL_ID` / `CLIENT_ID` | AWS Cognito (backend) | **producto** | **volátil** | **sí** — dueño producto |
| `DYNAMODB_ENDPOINT` / `COGNITO_ENDPOINT` | Overrides de entorno local | producto | volátil | **no** — no son credenciales, sólo endpoints de desarrollo |

### GitHub

| Identificador | Servicio | Dueño | Durabilidad | ¿Entra en #5217? |
|---|---|---|---|---|
| `GH_TOKEN` / `GITHUB_TOKEN` (scope del pipeline) | GitHub API / Projects V2 | kernel | durable | **sí** |
| Token resuelto por el credential helper de git | GitHub API | kernel | durable | **no** — el keyring del sistema ya es durable y externo al repo; se declara para completitud |
| `GITHUB_TOKEN` (scripts de intake) | GitHub REST | kernel | volátil | **sí** |
| `secrets.GITHUB_TOKEN` (CI) | GitHub Actions | kernel | durable | **no** — token efímero por job, lo gestiona GitHub |

### Multimedia / voz

| Identificador | Servicio | Dueño | Durabilidad | ¿Entra en #5217? |
|---|---|---|---|---|
| `multimedia.elevenlabs_api_key` | ElevenLabs (TTS) | kernel | durable | **sí** — decidir si aplica o darla de baja |
| `multimedia.elevenlabs_voice_id` | ElevenLabs (identificador de voz, no secreto) | kernel | durable | **sí** — mismo tratamiento |

### Distribución y CI

Todos son secrets de GitHub Actions: **durables** por definición (no viven en el
filesystem local, sobreviven cualquier respawn del entorno) y **fuera del alcance
de #5217** (el vault local no los reemplaza). Se listan para completitud del
inventario.

| Workflow | Servicio | Dueño |
|---|---|---|
| `main.yml` — 8 secrets | AWS Lambda, Cognito, DynamoDB (deploy backend) | producto |
| `distribute-web.yml` — 6 secrets | AWS S3 + CloudFront, Telegram | producto |
| `distribute-android.yml` — 5 secrets | Firebase App Distribution, Telegram | producto |
| `distribute-ios.yml` — 11 secrets | Apple / App Store Connect, Telegram | producto |
| `distribute-desktop.yml` — 2 secrets | Telegram | producto |
| `security-sast.yml` — 1 secret | OWASP Dependency Check | kernel |
| `admission-gate.yml` — 1 secret | GitHub Actions | kernel |
| `pr-checks.yml` — ninguno | usa credenciales de desarrollo contra servicios locales | producto |

### Aplicación cliente

**No consume credenciales.** Se verificó que no hay `google-services.json`,
keystores, certificados ni perfiles de aprovisionamiento versionados: la firma y
la distribución se resuelven íntegramente con secrets de CI.

## Reparto kernel / producto

Todas las credenciales quedaron asignadas; ninguna quedó `indeterminado`.

- **kernel** (compartidas por todos los productos): Telegram, providers de IA del
  pipeline, Google Drive/OAuth, Cloudflare R2, AWS del pipeline, GitHub,
  multimedia.
- **producto** (por `projectId`, insumo del namespaceado de #5219): la clave de
  Anthropic del backend, las credenciales de AWS/Cognito del servicio desplegado
  y todos los secrets de distribución.

El mecanismo de resolución namespaceada por producto **ya existe** en el pipeline
y está en uso; #5219 lo extiende al resto del inventario.

## Entregable detallado

El inventario completo —con puntos de lectura verificados, cadenas de resolución,
criticidad y modos de falla por consumidor— es un **entregable sensible** y **no
está versionado**.

- **Ubicación:** `.pipeline/assets/docs/5216/pipeline-dev-dev-5216.md`
- **Registrado en:** `.pipeline/deliverables/5216.json`, con `sensible: true`
- **Excluido de git** por regla explícita, verificada con `git check-ignore` ⇒ `rc=0`

El flag `sensible: true` excluye el artefacto del canal de publicación
automática, pero **no** lo excluye de git por sí solo: la regla de ignore es la
contención efectiva.

**Dónde tiene que existir esa regla.** El pipeline escribe los entregables en el root
donde corre (`PIPELINE_REPO_ROOT`), que **no** es el worktree del agente. Una regla de
`.gitignore` que viaja en la rama sólo protege donde ese commit está checkouteado, así
que **hasta el merge no protege el root vivo** — que es justamente donde el artefacto se
materializa. Por eso la contención es doble:

- `.gitignore` (versionado) — durabilidad una vez mergeado, para cualquier checkout.
- `.git/info/exclude` del root vivo — cobertura inmediata, desde antes de que el artefacto
  exista. Vive dentro de `.git/`, así que sobrevive el `reset --hard` y el `clean` que el
  root vivo hace en cada respawn.

**Guardas contra re-commit (#5463).** El inventario de paths sensibles dejó de estar
duplicado entre `.gitignore` y el scanner de `.husky/pre-commit`: ambos —más la suite
`.pipeline/lib/__tests__/credential-path-guards.test.js`— derivan de
`.pipeline/lib/sensitive-paths.js`. Un alta se hace en ese módulo y las tres capas la
heredan; el test falla si alguna se desalinea, si un path del inventario queda trackeado
(`git ls-files`) o si `.env.example` deja de estar permitido.

Verificar `check-ignore` únicamente en el worktree del agente da un **falso positivo de
contención**: da `rc=0` ahí mientras el artefacto queda expuesto en el root vivo.

## Issues derivados

| Issue | Qué toma de este inventario |
|---|---|
| [#5217](https://github.com/intrale/platform/issues/5217) | Las credenciales marcadas "sí" en la columna de alcance |
| [#5218](https://github.com/intrale/platform/issues/5218) | El detalle por consumidor registrado en el entregable sensible |
| [#5219](https://github.com/intrale/platform/issues/5219) | El reparto kernel / producto de este documento |
| [#5220](https://github.com/intrale/platform/issues/5220) | Los mecanismos de filtración detectados durante el barrido, y la purga/rotación de la exposición vigente |
| [#5226](https://github.com/intrale/platform/issues/5226) | El destrackeo del archivo de configuración de hooks que hoy tiene secretos vivos (ver nota de CA-15 abajo) |
| [#5222](https://github.com/intrale/platform/issues/5222) | Las brechas de cobertura del escaneo de secretos en pre-commit |

### Nota de CA-15 — hay una exposición de secretos real y vigente

El barrido encontró **secretos vivos en una ubicación indebida**: un archivo de
configuración trackeado por git, no cubierto por ninguna regla de ignore, cuya working
copy contiene valores reales que la copia commiteada no tiene. La clasificación se hizo
**sólo por forma** (presencia, longitud, match contra el patrón de placeholder), sin
imprimir ni almacenar ningún valor.

Este spike **no lo remedia** (CA-14/CA-15): el destrackeo y la rotación son de
[#5226](https://github.com/intrale/platform/issues/5226) y
[#5220](https://github.com/intrale/platform/issues/5220). La ubicación exacta y la
clasificación por clave están en el entregable sensible, no acá.

> Una versión anterior de este documento y del reporte a #5220 concluyó lo contrario
> ("ningún valor de secreto en ubicación indebida"). Esa conclusión se emitió corriendo
> el barrido sobre una **copia commiteada** en lugar del entorno vivo, y quedó
> **retractada** en la pasada rev-1. El método de la sección correspondiente se corrigió:
> los veredictos sobre estado vivo sólo valen si se verifican en el root donde corre el
> pipeline.
