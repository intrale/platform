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
- **Excluido de git** por regla explícita en `.gitignore`

El flag `sensible: true` excluye el artefacto del canal de publicación
automática, pero **no** lo excluye de git por sí solo: la regla de `.gitignore` es
la contención efectiva y se agregó **antes** de generar el artefacto.

## Issues derivados

| Issue | Qué toma de este inventario |
|---|---|
| [#5217](https://github.com/intrale/platform/issues/5217) | Las credenciales marcadas "sí" en la columna de alcance |
| [#5218](https://github.com/intrale/platform/issues/5218) | El detalle por consumidor registrado en el entregable sensible |
| [#5219](https://github.com/intrale/platform/issues/5219) | El reparto kernel / producto de este documento |
| [#5220](https://github.com/intrale/platform/issues/5220) | Los mecanismos de filtración detectados durante el barrido |
| [#5222](https://github.com/intrale/platform/issues/5222) | Las brechas de cobertura del escaneo de secretos en pre-commit |
