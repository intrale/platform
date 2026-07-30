# Runbook: rotación de credenciales del pipeline V3

> Lo abriste **bajo presión** (recordatorio T-1 o T-0). Mantén la calma:
> los pasos están numerados, son cortos, y al final hay una checklist de
> verificación + sección "si algo sale mal".

## Ubicación canónica de credenciales (#3311)

Desde #3311 todas las credenciales del proyecto viven en un **único archivo**:

```
~/.claude/secrets/credentials.json
```

**Estructura**:

```json
{
  "_note": "...",
  "_version": 1,
  "telegram":  { "bot_token": "...", "chat_id": "..." },
  "providers": {
    "openai":   { "api_key": "..." },
    "anthropic":{ "api_key": "..." },
    "google":   { "api_key": "..." },
    "groq":     { "api_key": "..." },
    "cerebras": { "api_key": "..." },
    "nvidia":   { "api_key": "..." }
  },

  // #5217 — namespaces que NO pasan por ENV_MAPPING (ver más abajo)
  "google_drive": {
    "oauth_client_id":     "...",
    "oauth_client_secret": "...",
    "oauth_refresh_token": "...",
    "drive_folder_id":     "..."
  },
  "r2": {
    "account_id":        "...",   // sin provisionar
    "access_key_id":     "...",
    "secret_access_key": "...",
    "bucket":            "..."
  }
}
```

> **Dos formas de consumir el store, y no son intercambiables (#5217):**
>
> | Mecanismo | Qué hace | Quién lo usa |
> |---|---|---|
> | `loadIntoEnv()` | itera `ENV_MAPPING` y escribe en el **`process.env` global** | Telegram + API keys de IA |
> | `resolveScopedRefs()` | lee **un namespace puntual** del JSON, sin tocar `process.env` | Google Drive, R2, brokering por producto |
>
> Drive y R2 **no están en `ENV_MAPPING` a propósito**: `loadIntoEnv()` se
> invoca en el boot de `pulpo.js` y `restart.js`, así que todo lo que entre ahí
> lo hereda **cada proceso hijo de cada agente**, incluidos los de providers de
> IA de terceros. Credenciales que usa un solo consumidor puntual se resuelven
> bajo demanda. Agregarlas a `ENV_MAPPING` es una regresión de mínimo privilegio.

**Cómo se carga**: `.pipeline/lib/credentials.js#loadIntoEnv()` se invoca al
boot de `pulpo.js` y `restart.js`, mapea cada path a su env var canónica
(`providers.groq.api_key` → `GROQ_API_KEY`, etc.) y popula `process.env`.
`telegram-secrets.js` también lee este archivo para sus consumidores legacy.

**Precedencia**:
1. `process.env` ya seteado (no se sobrescribe — `setx` sigue funcionando como override manual)
2. `~/.claude/secrets/credentials.json` (canónico)
3. `~/.claude/secrets/telegram-config.json` (legacy flat, fallback con warning)
4. `<repo>/.claude/hooks/telegram-config.json` (legacy committed, último recurso)

**Editar el archivo**: abrir con tu editor preferido y modificar el JSON.
Después correr `node .pipeline/restart.js` para que el pipeline reinicie con
las nuevas credenciales hidratadas.

**Verificar qué se hidrata** (sin imprimir valores):

```bash
node .pipeline/lib/credentials.js
```

Devuelve `source` (canonical/legacy/none), `hydrated` (nombres de env vars
hidratadas) y `skipped_*` (las que ya estaban en env o tenían placeholder).

## Contexto general

- **Por qué rotar**: política `≤ 90 días` por convención (ver
  [`docs/pipeline-multi-provider.md`](../pipeline-multi-provider.md) §6.2).
- **Qué archivo refleja el estado**: [`docs/secrets-inventory.md`](../secrets-inventory.md).
- **Qué cron monitorea**: `lib/credential-rotation-cron.js` corre dentro de
  `pulpo.js`. Lee `last_rotated`/`expires_at` del inventario y notifica al
  owner por Telegram. **El cron NO toca env vars ni archivos: vos rotás, vos
  commiteás**.

## Anthropic

> _Provider opcional — sólo aplica si activaste Vision multimedia directo
> (no via CLI Claude). Sin `anthropic_api_key` en `credentials.json`, Vision
> sigue funcionando via OAuth Max del CLI (ver `multimedia.js:213`)._

1. Abrí <https://console.anthropic.com/settings/keys> con la cuenta que figura
   en `account_id` del inventario.
2. Generá una **nueva key** (botón "Create Key"), nombrá con `intrale-pipeline-v3-YYYYMMDD`.
3. Editá `~/.claude/secrets/credentials.json`:
   ```json
   { "providers": { "anthropic": { "api_key": "<nueva-key>" } } }
   ```
4. Revocá la **vieja** key desde la misma consola (botón "Revoke").
5. `node .pipeline/restart.js` para que el pipeline recargue con la key nueva.
6. Actualizá `last_rotated` en [`docs/secrets-inventory.md`](../secrets-inventory.md)
   con la fecha de hoy en formato ISO `YYYY-MM-DD`. Commiteá.

### Cómo verificar que rotaste bien (Anthropic)

- [ ] La vieja key revocada falla con `401 Unauthorized` en cualquier intento
      de uso (probar con `curl -H "x-api-key: <vieja>" https://api.anthropic.com/v1/messages` → debería devolver 401).
- [ ] El pulpo arranca **sin** mensaje `[FATAL]` (probar `node .pipeline/pulpo.js`
      hasta que loguee `Pulpo V2 iniciado` y matarlo con Ctrl+C — el boot
      fail-fast valida `credentials_env` antes de adquirir el singleton).
- [ ] El commit con `last_rotated` actualizado está pusheado a `main` y aparece
      en `git log --oneline docs/secrets-inventory.md`.
- [ ] Telegram recibió mensaje de "Pipeline reiniciado" tras el restart manual.

## OpenAI (codex)

> _Provider opcional — sólo aplica si tenés `OPENAI_API_KEY` declarada y un
> skill asignado a `openai-codex` en `agent-models.json`._

1. Abrí <https://platform.openai.com/api-keys> con la cuenta `account_id`.
2. Generá una nueva key (botón "Create new secret key"), nombrá con
   `intrale-pipeline-v3-YYYYMMDD`. Limitá scope a `Codex` si corresponde.
3. Editá `~/.claude/secrets/credentials.json`:
   ```json
   { "providers": { "openai": { "api_key": "<nueva-key>" } } }
   ```
4. Revocá la vieja key desde la misma consola (botón "Revoke key").
5. `node .pipeline/restart.js`.
6. Actualizá `last_rotated` en `docs/secrets-inventory.md`. Commiteá.

### Cómo verificar que rotaste bien (OpenAI)

- [ ] Vieja key revocada falla con `401` (probar con `curl -H "Authorization: Bearer <vieja>" https://api.openai.com/v1/models`).
- [ ] El pulpo arranca sin `[FATAL]` (CA-2).
- [ ] Commit pusheado con `last_rotated` actualizado.

## Groq (free tier — multi-provider fallback)

> _Free tier, regla `feedback_free-providers-rule`. Nunca pago._

1. Abrí <https://console.groq.com> y andá a "API Keys".
2. "Create API Key" — nombrá `intrale-pipeline-YYYYMMDD`. Copiar `gsk_...`
   (se muestra una sola vez).
3. Editá `~/.claude/secrets/credentials.json`:
   ```json
   { "providers": { "groq": { "api_key": "<nueva-key>" } } }
   ```
4. Revocá la vieja key en la misma página.
5. `node .pipeline/restart.js`.

## Gemini (Google AI Studio — free tier)

1. Abrí <https://aistudio.google.com/apikey> con la cuenta GCP del proyecto.
2. "Create API key" — asociar a un proyecto de Google Cloud existente o nuevo.
3. Editá `~/.claude/secrets/credentials.json`:
   ```json
   { "providers": { "google": { "api_key": "<nueva-key>" } } }
   ```
4. Verificar que la **Generative Language API** esté habilitada en el proyecto
   de GCP (sino tira 403 al primer request).
5. Revocá la vieja key desde la consola.
6. `node .pipeline/restart.js`.

## Cerebras (free tier — multi-provider fallback)

1. Abrí <https://cloud.cerebras.ai/platform> y andá a "API Keys".
2. "Create API Key" — nombrá `intrale-pipeline-YYYYMMDD`. Copiar `csk-...`.
3. Editá `~/.claude/secrets/credentials.json`:
   ```json
   { "providers": { "cerebras": { "api_key": "<nueva-key>" } } }
   ```
4. Revocá la vieja key.
5. `node .pipeline/restart.js`.

## NVIDIA NIM (preparada para #3243 — Ola N+5)

> _Provider declarado pero todavía no consumido. La key vive en `credentials.json`
> y se hidrata a `NVIDIA_NIM_API_KEY`, pero ningún `agent-models.json` la usa
> hasta que #3243 entre en producción._

1. Abrí <https://build.nvidia.com> y elegí cualquier modelo (sugerido:
   DeepSeek V4-Pro o Kimi K2.6). Click "Get API Key".
2. Editá `~/.claude/secrets/credentials.json`:
   ```json
   { "providers": { "nvidia": { "api_key": "<nueva-key>" } } }
   ```
3. Revocá la vieja key desde la consola de NVIDIA.
4. `node .pipeline/restart.js` (no impacta a nada hasta que se implemente #3243).

## GitHub (token de gh CLI / `GH_TOKEN`)

> _Aplica si rotás `GH_TOKEN` o `GITHUB_TOKEN` usadas por skills LLM para
> postear en issues / leer PRs._

1. Abrí <https://github.com/settings/tokens?type=beta> con la cuenta del
   inventario.
2. Generá un nuevo **fine-grained token** con scopes:
   `Contents: read+write`, `Issues: read+write`, `Pull requests: read+write`,
   `Metadata: read`. Expiry: 90 días.
3. Actualizá la env var del operador:
   ```bash
   export GH_TOKEN="<nuevo-token>"
   gh auth login --with-token <<< "<nuevo-token>"
   ```
4. Revocá el viejo token desde la misma consola.
5. Actualizá `last_rotated` en `docs/secrets-inventory.md`. Commiteá.

### Cómo verificar que rotaste bien (GitHub)

- [ ] `gh auth status` confirma el nuevo token activo.
- [ ] Viejo token revocado falla en `gh issue view 1` con `Bad credentials`.
- [ ] Pulpo arranca y procesa `intake` sin errores `gh CLI`.
- [ ] Commit pusheado con `last_rotated`.

## Google Drive (OAuth — evidencia de QA)

> _Aplica cuando vence o se revoca el `refresh_token` de Drive y
> `qa-video-share.js` deja de subir la evidencia de video._

**Dónde vive**: namespace `google_drive` de `credentials.json` (ver estructura
arriba). **No** en `.claude/hooks/telegram-config.json` — ese archivo está
trackeado en git, un `reset --hard` restauraría la versión sin credenciales y la
subida se caería en silencio (es el bug que cerró #5217).

1. Abrí <https://console.cloud.google.com/apis/credentials> con la cuenta del
   inventario y ubicá el OAuth Client ID de tipo *Desktop app*.
2. Re-autorizá:
   ```bash
   node scripts/google-drive-oauth-setup.js <client_id>
   ```
   El **client secret NO se pasa por argumento**: se pide por prompt (sin eco) o
   se toma de `GOOGLE_OAUTH_CLIENT_SECRET`. Los argumentos son visibles en la
   tabla de procesos del SO y quedan en el historial del shell (CWE-214).
3. El script también pide el **Drive folder ID** de la carpeta de QA (o lo toma
   de `GOOGLE_DRIVE_FOLDER_ID`). Dejarlo vacío conserva el que ya esté guardado.
   Si `google_drive.drive_folder_id` no resuelve en ninguna fuente, la evidencia
   se sube a la **raíz** del Drive en vez de la carpeta de QA: no rompe la
   subida, pero `qa-video-share.js` lo avisa por consola. No es secreto, pero sí
   parte de la provisión — antes sólo podía setearse a mano en el archivo
   trackeado del repo, o sea que se perdía en cada respawn.
4. El script persiste en el store canónico con backup pre-save, escritura
   atómica y `0600`, y te lista **los nombres** de las claves escritas.
5. Actualizá `last_rotated` en `docs/secrets-inventory.md`. Commiteá.

> **Si el store está corrupto**, `writeCanonicalPaths` **aborta sin escribir** en
> vez de degradar el archivo a `{}` — si escribiera, se perderían Telegram y
> todos los providers de IA de una sola vez. Reparalo a mano o restaurá el
> backup más reciente de `~/.claude/secrets/backups/` antes de reintentar.

### Cómo verificar que rotaste bien (Drive)

- [ ] El script imprimió `Guardado en el store canónico: ~/.claude/secrets/credentials.json`.
- [ ] `git status --porcelain .claude/hooks/telegram-config.json` **sin salida**
      (ningún secreto quedó en el archivo del repo).
- [ ] Una corrida de `qa-video-share.js` sube la evidencia sin emitir
      `Google Drive no configurado`.
- [ ] Sobrevive al respawn: tras `git reset --hard` + `git clean -fd`, la subida
      sigue funcionando sin intervención humana.

## Cloudflare R2 (sin provisionar)

R2 está **cableado pero no provisionado**: el consumidor lee el namespace `r2`
del store, y hoy **no existe ninguna clave `r2.*` en ningún almacén**. Por eso
los mensajes al operador dicen `no provisionado` y no `no configurado` — son
estados distintos:

| Estado | Qué significa | Cómo se resuelve |
|---|---|---|
| `no configurado` | falta escribir el valor | editar el store canónico |
| `no provisionado` | la credencial no existe en ningún lado | crear las credenciales en Cloudflare, y recién ahí escribirlas |

Darlas de alta requiere crear un API token de R2 en Cloudflare y escribir
`r2.account_id`, `r2.access_key_id`, `r2.secret_access_key` y `r2.bucket` en
`credentials.json`. Es trabajo humano; ningún criterio del pipeline depende de
que R2 suba.

## AWS y GitHub: ya son durables, no se duplican en el store

Estas dos **no se migran** al store canónico (#5217 · CA-15). No es un pendiente:
ya se resuelven por mecanismos externos al repo y persistentes a los respawns.
Duplicar el material de clave dentro de `credentials.json` agregaría una copia
más para custodiar y rotar, sin ningún beneficio.

| Credencial | Dónde vive realmente | Cómo se rota |
|---|---|---|
| AWS | perfiles de `~/.aws/credentials` + `~/.aws/config` (fuera del repo) | por AWS CLI / consola IAM; el pipeline los consume vía perfil |
| GitHub | credential helper del sistema (`git credential fill`) y `gh auth` | ver la sección **GitHub** de este runbook |

Notas:

- El namespace `aws` que aparezca en `credentials.json` es de **brokering por
  producto** (`resolveScopedRefs`), no la fuente que usa el AWS CLI.
- `GH_TOKEN` / `GITHUB_TOKEN` **ya están** en
  `ALLOWED_CREDENTIAL_ENV_VARS` (`.pipeline/lib/agent-models-validate.js`). Esa
  lista **no se amplía** con credenciales de cloud: existe justamente para
  impedir que un `agent-models.json` declare `AWS_SECRET_ACCESS_KEY` como env de
  un provider de IA de terceros (refinamiento Security #3 de #3080).

## Si algo sale mal

### "Revoqué la vieja antes de tener la nueva, el pulpo no arranca"

Setear la env var con la **nueva** key generada en el paso 2. Si todavía no
generaste la nueva, generala ahora — la vieja revocada no se puede "des-revocar".
El pulpo va a arrancar en cuanto la env var apunte a una key válida.

### "El commit a `secrets-inventory.md` lo rechaza un hook"

NO usar `--no-verify`. Leer el mensaje del hook: probablemente detecta que
filtraste el secret literal por error en el archivo. Sacar el valor, dejar
sólo metadata, recommittear.

### "Telegram me sigue mandando T-7 después de rotar"

El estado de recordatorios persiste en `.pipeline/credential-reminder-state.json`.
Si el cron leyó el inventario antes de tu commit, la entrada del threshold
ya marcado queda con la fecha vieja. Para forzar refresco:

```bash
node -e "const f='.pipeline/credential-reminder-state.json'; const s=JSON.parse(require('fs').readFileSync(f,'utf8')); delete s['ANTHROPIC_API_KEY']; require('fs').writeFileSync(f, JSON.stringify(s, null, 2));"
```

Reemplazá `ANTHROPIC_API_KEY` por la env var que rotaste. El próximo tick
recalcula thresholds desde cero, y como `expires_at` ahora está a 90 días,
no dispara nada.

### "El pulpo dice `[FATAL] credentials_env ausente: ANTHROPIC_API_KEY`"

Es el boot fail-fast (CA-2). Significa que `agent-models.json` declara que
algún skill usa `anthropic` pero `process.env.ANTHROPIC_API_KEY` está vacía.
Setear la env var en la terminal donde corre el pulpo y reintentar.

### "Después de rotar, los agentes ya activos siguen usando la vieja"

Es esperado: los childs de Claude Code corren con su propio env (`build-child-env.js`
les copia la key al spawn). Hasta que terminen su iteración actual, siguen
con la vieja. **Eso es correcto** — la vieja key revocada va a fallar al
siguiente request, el child cae con cuota agotada o auth error, y el pipeline
lo reagenda con la key nueva en el próximo spawn.

Si necesitás invalidación inmediata (ej: la key fue comprometida), **matar
el pulpo entero** con `taskkill /F /IM node.exe` o `pkill node`, esperar 30s,
relanzar `node .pipeline/pulpo.js`. Los childs spawneados con la key vieja
mueren con el padre.

## Referencias

- Inventario: [`docs/secrets-inventory.md`](../secrets-inventory.md)
- Diseño multi-provider: [`docs/pipeline-multi-provider.md`](../pipeline-multi-provider.md) §6.2, §6.3, §6.10
- Validador: [`.pipeline/lib/agent-models-validate.js`](../../.pipeline/lib/agent-models-validate.js)
- Aislamiento de credenciales por proceso: [`.pipeline/lib/build-child-env.js`](../../.pipeline/lib/build-child-env.js)
