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

**Editar el archivo**: abrir con tu editor preferido y modificar el JSON. Editarlo
**no alcanza**: el proceso del Pulpo ya corriendo conserva en su `process.env` la
credencial con la que arrancó. Cómo cerrar para que el material nuevo entre en
juego —hoy, con reinicio— está en [Cierre de toda
rotación](#cierre-de-toda-rotación-5802).

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

## Cierre de toda rotación (#5802)

Cada procedimiento de este runbook termina en este paso. **Qué hacés al cerrar
depende de tres gates de rollout**, y hoy los tres están **cerrados**: mientras
siga así, toda rotación cierra **reiniciando el pipeline**. El camino sin
reinicio ya está implementado, pero es el **destino del rollout**, no el estado
actual — no lo sigas hasta haber verificado los gates con el comando de acá abajo.

### Precondición: verificá los gates antes de elegir camino

El camino sin reinicio se apoya en piezas que existen en el código pero viven
**detrás de gates de rollout fail-closed**: sólo el booleano `true` exacto los
abre (`lib/attempt-credential-snapshot.js#isSnapshotEnabled`,
`lib/credential-retry-wiring.js` → `credential_retry_enabled`), y **no hay
override** por variable de entorno ni por `config.local`. Con cualquiera de los
tres cerrado **ninguna de esas piezas corre**: el env base sigue siendo
`process.env` por referencia, no se emite una sola llamada al vault y no se
emite un solo evento de retry.

```bash
node .pipeline/check-credential-rotation-gates.js
```

| Los tres gates | Camino de cierre |
|---|---|
| Alguno en `false` o **ausente** (← estado actual) | [Camino A — con reinicio](#camino-a--gates-cerrados-estado-vigente) |
| Los tres en `true` | [Camino B — sin reinicio](#camino-b--gates-abiertos-destino-del-rollout) |

Los gates son `pipeline.credential_snapshot_enabled`,
`pipeline.credential_retry_enabled` y `vault.enabled`, todos en
`.pipeline/config.yaml`. Si la clave **no existe** en el config, el gate está
cerrado: fail-closed cubre también la ausencia. En el repo de producción las dos
claves `credential_*_enabled` todavía no están escritas y `vault.enabled` es
`false`, así que el camino vigente es el A.

### Camino A — gates cerrados (estado vigente)

Con los gates cerrados **no hay ninguna pieza que invalide material en caliente**.
`loadIntoEnv()` corre una sola vez, en el boot de `pulpo.js`: mientras ese proceso
siga vivo, su `process.env` conserva la credencial con la que arrancó y **se la
copia a cada agente que spawnea**, sin vencimiento y sin evento. Editar el store
no cambia nada para el proceso ya corriendo. Por eso el reinicio no es opcional:
**es el único mecanismo de invalidación disponible hoy**.

1. Poné la key nueva en el store (el paso de cada provider más abajo).
2. `node .pipeline/restart.js` — recién acá el material nuevo entra en juego.
3. Revocá la vieja en la consola del proveedor.
4. Verificá con la [checklist](#verificación-sin-imprimir-material).

> **Si la key está comprometida el orden se invierte**: revocar primero, después
> reiniciar. Ver ["La key fue comprometida"](#la-key-fue-comprometida-necesito-invalidación-inmediata).

Los agentes en vuelo se pierden: es el costo conocido de esta ventana y la razón
por la que el camino B existe. No hay forma de evitarlo con los gates cerrados.

### Camino B — gates abiertos (destino del rollout)

**Sólo aplica si el comando de la precondición devolvió `GATES ABIERTOS`.** Si no
lo verificaste en esta misma rotación, no estás en este camino.

Tres contratos in-process reemplazan al reinicio cuando los gates se abren:

| Pieza | Qué hace | Dónde vive |
|---|---|---|
| Caché versionada por ámbito | TTL de **300 s como tope duro**. La lectura **no** refresca la vigencia, así que una entrada vence sola aunque el pipeline lance agentes sin parar. | `lib/credentials.js` (#5797) |
| `resetVaultCache(scope)` | Invalidación **acotada** a un ámbito, con verificación positiva: devuelve `{ scope, invalidadas }`. Bumpea la generación **antes** de borrar, así una lectura en vuelo de la generación vieja no repuebla la caché ya limpia. | `lib/credentials.js` (#5797) |
| Snapshot por lanzamiento + retry único | Cada lanzamiento pide su propio material. Si el provider rechaza la credencial, el coordinador invalida el ámbito, re-resuelve **una** vez y reintenta **una** vez. El segundo rechazo falla cerrado. | `lib/credential-auth-retry.js` (#5794) |

En criollo: con los gates abiertos, **los lanzamientos nuevos leen material nuevo
por su cuenta** — como muy tarde a los 300 s, y de inmediato si un lanzamiento se
cruza con la key vieja ya revocada (el rechazo dispara la invalidación acotada y
la re-resolución, sin intervención tuya).

El procedimiento entonces es:

1. Poné la key nueva en el store.
2. Revocá la vieja en la consola del proveedor.
3. **Nada más.** Verificá con la [checklist](#verificación-sin-imprimir-material).

### Qué señales esperar (diagnóstico)

> Aplica al **camino B**. Con los gates cerrados el coordinador de retry no está
> cableado y **ninguna de estas señales se emite nunca**: su ausencia no dice
> nada sobre la rotación.

Los eventos que emite el coordinador son el vocabulario cerrado por el que
ruteás. Buscalos en `.pipeline/logs/pulpo.log`:

| Señal | Qué significa | Qué hacer |
|---|---|---|
| _(ninguna)_ | Lo normal. El material nuevo entró por vencimiento de TTL antes de que nadie se cruzara con la key vieja. | Nada. |
| `credential_invalidated` | Un lanzamiento se cruzó con la key vieja; el ámbito se invalidó. Trae `invalidated_entries` (cuántas entradas se fueron). | Nada — es el mecanismo funcionando. |
| `credential_reresolved` | Se emitió un snapshot nuevo para el reintento. Trae `snapshot_keys` (cuántas claves, nunca sus valores). | Nada. |
| `credential_retry_closed` | La operación falló **cerrada**. Ruteá por `reason` (tabla siguiente). | Ver tabla siguiente. |

### Motivos de cierre (rollback y escalada)

`credential_retry_closed` siempre trae un `reason` de esta tabla cerrada.
Ninguno cae en texto libre, y cada uno se remedia distinto:

| `reason` | Qué pasó | Remediación |
|---|---|---|
| `second_rejection` | Se invalidó, se re-resolvió y el provider **volvió** a rechazar. La key nueva del store no sirve. | Rollback: la rotación salió mal. Verificá que pegaste la key correcta y completa en el store, y que no revocaste la nueva por error. |
| `budget_exhausted` | El único retry de esa operación ya se había usado (típicamente en otro provider de la cadena de fallbacks). | No es un problema de la rotación en sí: la operación raíz ya venía degradada. Revisá el `operation_id` correlacionado. |
| `invalidation_failed` | No se pudo garantizar que el material viejo salió de la caché, así que no se reintentó con él. | Bug de cableado, no de credencial: el ámbito declarado no es invalidable. Escalar con el `scope` del evento. |
| `reresolution_failed` | El vault no contestó al pedir el snapshot nuevo. | Problema de acceso al store (IAM, red, perfil AWS), no de la key. Ver `aws sts get-caller-identity`. |

### Verificación (sin imprimir material)

Todo lo verificable sale de **metadata opaca**: el ámbito lógico (`scope`), el
identificador de la operación (`operation_id`), la versión opaca
(`opaque_version`), el estado y los timestamps. **Nunca** el valor.

- [ ] La vieja key revocada falla contra la API del proveedor (ver la checklist
      específica de cada provider más abajo).
- [ ] **(camino A)** El pulpo volvió a arrancar: `.pipeline/pulpo.pid` apunta a
      un proceso vivo y el log tiene un `Pulpo V2 iniciado` posterior a tu
      rotación.
- [ ] **(camino B)** En `pulpo.log` no aparece ningún `credential_retry_closed`
      en los minutos posteriores a la rotación.
- [ ] Un agente lanzado **después** de la rotación termina normalmente.
- [ ] `last_rotated` actualizado en [`docs/secrets-inventory.md`](../secrets-inventory.md)
      y commiteado.

> **Nunca** verifiques imprimiendo el valor: ni haciendo eco de la variable de
> entorno del provider, ni volcando el ambiente del proceso, ni logueando el
> `env` del snapshot. Un runbook que en su paso de diagnóstico imprime material
> es un runbook que enseña a filtrarlo: ese valor queda en el historial de la
> shell, en el scrollback de la terminal y —si estabas en una sesión grabada— en
> la evidencia.
>
> Para saber **qué** se hidrató sin ver un solo valor está
> `node .pipeline/lib/credentials.js`, que imprime nombres de variable y
> etiquetas de origen. Ésa es la herramienta de diagnóstico; no hay otra que
> haga falta.

### Rollback

Si algo salió mal, la salida es **poner la key anterior de vuelta en el store**
(si todavía no la revocaste) o **generar una tercera key** (si ya la revocaste).
En los dos casos el cierre es el mismo camino que elegiste arriba: con reinicio
si los gates están cerrados, sin reinicio si están abiertos. Una key mal pegada
no la arregla ningún reinicio — corregí el store primero.

### Qué NO hace falta, y sólo con los gates abiertos

> Todo este bloque describe el **camino B**. Con los gates cerrados el reinicio
> **sí** hace falta y es el paso 2 del camino A.

- **`node .pipeline/restart.js`** — el reinicio es la única forma de invalidar
  mientras la caché no tenga contrato de invalidación cableado. Cuando los gates
  se abran, reiniciar pasa a costar una ventana de indisponibilidad más los
  agentes en vuelo que se pierden, sin nada a cambio.
- **Matar el parque de agentes** — con los gates abiertos, un hijo ya spawneado
  sigue con el material que recibió al arrancar, y eso es correcto y **acotado**:
  su próximo request con la key revocada falla, el coordinador invalida y
  re-resuelve, y el reintento sale con la key nueva. Matar procesos para forzar
  eso tira trabajo en curso para ganar unos segundos. **Con los gates cerrados no
  hay tal acotamiento**: nada invalida al hijo, que sigue usando la credencial
  vieja hasta que muera por otra causa.

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
5. Cerrá la rotación: ver [Cierre de toda rotación](#cierre-de-toda-rotación-5802).
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
- [ ] En `.pipeline/logs/pulpo.log` no aparece ningún `credential_retry_closed`
      en los minutos posteriores a la rotación (ver [cierre de toda rotación](#cierre-de-toda-rotación-5802)).

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
5. Cerrá la rotación: ver [Cierre de toda rotación](#cierre-de-toda-rotación-5802).
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
5. Cerrá la rotación: ver [Cierre de toda rotación](#cierre-de-toda-rotación-5802).

## Gemini (Google AI Studio — free tier)

> **NO REPONER salvo que vuelva un consumidor.** El provider `gemini-google`
> autentica por OAuth con `agy` (ver `providers/gemini-google.js`: «Auth: OAuth
> via `agy`; nunca API key») y `agent-models.json` no le declara
> `credentials_env`. Ningún módulo lee `GEMINI_API_KEY`, por eso el manifiesto la
> declara `required_when: never` + `consumer_status: no_consumer`. Cargarla no
> habilita nada y el health-check no debe pedirla. Los pasos de abajo aplican
> sólo si en el futuro se recablea el provider a API key.

1. Abrí <https://aistudio.google.com/apikey> con la cuenta GCP del proyecto.
2. "Create API key" — asociar a un proyecto de Google Cloud existente o nuevo.
3. Editá `~/.claude/secrets/credentials.json`:
   ```json
   { "providers": { "google": { "api_key": "<nueva-key>" } } }
   ```
4. Verificar que la **Generative Language API** esté habilitada en el proyecto
   de GCP (sino tira 403 al primer request).
5. Revocá la vieja key desde la consola.
6. Cerrá la rotación: ver [Cierre de toda rotación](#cierre-de-toda-rotación-5802).

## Cerebras (free tier — multi-provider fallback)

1. Abrí <https://cloud.cerebras.ai/platform> y andá a "API Keys".
2. "Create API Key" — nombrá `intrale-pipeline-YYYYMMDD`. Copiar `csk-...`.
3. Editá `~/.claude/secrets/credentials.json`:
   ```json
   { "providers": { "cerebras": { "api_key": "<nueva-key>" } } }
   ```
4. Revocá la vieja key.
5. Cerrá la rotación: ver [Cierre de toda rotación](#cierre-de-toda-rotación-5802).

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
4. Cerrá la rotación: ver [Cierre de toda rotación](#cierre-de-toda-rotación-5802). (No impacta a nada hasta que se implemente #3243.)

## Moonshot Kimi (fallback multi-provider)

> _Provider **activo y cableado**: `kimi-moonshot` es el último eslabón de las
> cadenas de fallback de `review` y `po` en `agent-models.json`. Autentica por
> `auth_mode: api_key` contra el endpoint Anthropic-compat, así que su token es
> **fail-fast**: si la cadena degrada hasta Kimi y `ANTHROPIC_AUTH_TOKEN` no
> está en el env del Pulpo, el child **no arranca** (`build-child-env` corta el
> spawn). Ojo: es una var distinta de `ANTHROPIC_API_KEY` (la OAuth/Max real);
> no las mezcles._

1. Abrí <https://platform.moonshot.ai/console/api-keys> y creá una key nueva
   nombrada `intrale-pipeline-YYYYMMDD`.
2. Editá `~/.claude/secrets/credentials.json`:
   ```json
   { "providers": { "moonshot": { "api_key": "<nueva-key>" } } }
   ```
3. Revocá la vieja key desde la consola de Moonshot.
4. Cerrá la rotación: ver [Cierre de toda rotación](#cierre-de-toda-rotación-5802).

### Cómo verificar que rotaste bien (Moonshot Kimi)

- La clave está **ausente** del store mientras no la aprovisiones, y el health
  check la reporta como faltante: es un provider requerido, no opcional. No la
  declares como "no reponer" para silenciar el rojo — el rojo es correcto y
  significa que `review` y `po` se quedan sin último fallback.
- `node -e "console.log(!!require('os') && !!(JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(),'.claude','secrets','credentials.json'),'utf8')).providers||{}).moonshot)"`
  debe imprimir `true` después de rotar.

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
## Telegram (reposicion)

Para **rotar** una credencial viva, seguí el flujo del proveedor. Esta sección
cubre una credencial **ausente** en una máquina limpia.

1. Creá un bot con BotFather o recuperá el token del bot operativo.
2. Obtené el identificador del chat autorizado desde Telegram, sin publicarlo.
3. Escribí `telegram.bot_token` y `telegram.chat_id` en
   `~/.claude/secrets/credentials.json`.
4. Ejecutá `node .pipeline/lib/credentials.js` y verificá que el resumen nombre
   `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`, sin mostrar sus valores.

### Chat del operador firmante (GATE 2 y Commander)

`telegram.leo_operator_chat_id` → `TELEGRAM_LEO_OPERATOR_CHAT_ID`. **No es un
chat opcional de notificaciones**: es el allowlist de operadores autorizados a
**firmar**. Sus consumidores:

| Consumidor | Qué hace con la clave | Qué pasa si falta |
|---|---|---|
| `.pipeline/lib/operator-gate.js` | única fuente del allowlist del gate de firma **GATE 2** | fail-closed: el `Set` queda vacío y **todo callback de firma se rechaza** |
| `.pipeline/listener-telegram.js` | reusa ese mismo allowlist para el **Commander** | fail-closed: el Commander se queda sin operador autorizado |
| `.pipeline/delivery.js` | suma el chat a los firmantes autorizados del delivery | el delivery pierde ese firmante |
| `.pipeline/pulpo.js` | lo suma a los operadores del CUA | cae al chat principal como último recurso |
| `.pipeline/lib/telegram-notifier.js` | handler proactivo (#3384) | **único caso** donde el faltante sólo autodeshabilita una función opcional |

Su ausencia **no** degrada un handler: deja GATE 2 y el Commander sin ningún
firmante autorizado. Por eso se declara `required_when: service_active`, no
`never`.

Esta sección cubre la credencial **ausente** en una máquina limpia; para
**rotar** una viva, repetí los pasos con el chat nuevo y recién después retirá
el viejo.

1. Obtené el `chat.id` del chat privado 1:1 con el operador autorizado, sin
   publicarlo. En chat privado el `chat.id` coincide con el `from.id`, y por eso
   sirve como identidad de operador.
2. Escribí el dot-path `telegram.leo_operator_chat_id` en
   `~/.claude/secrets/credentials.json`.
3. Ejecutá `node .pipeline/lib/credentials.js` y verificá que el resumen nombre
   `TELEGRAM_LEO_OPERATOR_CHAT_ID`, sin mostrar su valor.
4. Verificá el gate: un callback de firma emitido desde ese chat debe ser
   aceptado, y uno desde cualquier otro chat debe ser rechazado.

## AWS (reposicion)

Para **rotar** credenciales vivas, usá el procedimiento de IAM correspondiente.
Esta sección cubre credenciales **ausentes** en una máquina limpia.

1. Solicitá al administrador un acceso de mínimo privilegio para el servicio.
2. Escribí los dot-paths `aws.access_key_id`, `aws.secret_access_key`,
   `aws.region` y `aws.profile` en `~/.claude/secrets/credentials.json`.
3. No agregues nombres de tablas: hoy no tienen consumidor operativo.
4. Las claves AWS permanecen `deferred`; `node .pipeline/lib/credentials.js`
   no debe informar variables AWS hidratadas. Un `AWS_PROFILE` ya presente en
   la terminal conserva precedencia sobre cualquier configuración durable.

## Google Drive (reposicion)

Para **rotar** una credencial viva, ver el flujo específico de OAuth. Esta
sección cubre credenciales **ausentes** en una máquina limpia.

1. En Google Cloud Console creá o seleccioná un cliente OAuth de aplicación.
2. Completá la autorización y obtené las credenciales requeridas sin copiarlas
   a issues, logs ni documentación.
3. Escribí `google_drive.oauth_client_id`,
   `google_drive.oauth_client_secret`, `google_drive.oauth_refresh_token` y
   `google_drive.drive_folder_id` en `~/.claude/secrets/credentials.json`.
4. Ejecutá `node .pipeline/lib/credentials.js`: las cuatro
   (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
   `GOOGLE_OAUTH_REFRESH_TOKEN`, `GOOGLE_DRIVE_FOLDER_ID`) **NO** deben figurar
   como hidratadas: desde #5217 son `hydration: "deferred"` y quedan fuera de
   `ENV_MAPPING` a propósito (CA-6). El comando lista **nombres** de variable,
   nunca valores.

   > Esto cambió respecto de #5242, que las declaró `eager`. En aquel momento el
   > nivel *store* de `qa-video-share.js` resolvía vía `loadIntoEnv`, así que
   > sacarlas del env global rompía la subida de evidencia. Hoy el consumidor las
   > lee con `resolveScopedRefs` (namespace directo del JSON, sin `process.env`),
   > y hidratarlas sólo expondría un refresh token de Google en el ambiente de
   > todo agente hijo sin que nadie lo lea de ahí. Para comprobar que resuelven,
   > usá el paso 5, no la salida de hidratación.
5. Verificá el consumo real: `qa/scripts/qa-video-share.js` resuelve estas
   credenciales con precedencia `env` > store (`~/.claude/secrets/credentials.json`)
   > legacy. Si el log dice `credenciales de Google Drive no configuradas`,
   el mensaje nombra cuál falta y en qué orden se consultaron las fuentes.
6. Aviso al operador: el store externo es la fuente canónica **porque sobrevive
   al `git reset --hard` de cada respawn**. No repongas estas claves en
   `.claude/hooks/telegram-config.json`: ese archivo está trackeado en un repo
   público y su purga está pendiente en #5226.

## Cloudflare R2 (reposicion)

Para **rotar** credenciales vivas, usá el panel de tokens de Cloudflare. Esta
sección cubre variables **ausentes** en una máquina limpia.

1. Creá un token R2 de mínimo privilegio desde el panel de Cloudflare.
2. Configurá `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` y
   `R2_BUCKET` como variables de entorno del operador.
3. La fuente declarada de R2 en el manifiesto es `env`, y es la que conviene usar:
   el consumidor consulta primero las env vars. Existe además un fallback al
   namespace `r2` del store canónico, pero **hoy no hay ninguna clave `r2.*` en
   ningún almacén** — de ahí el estado `no provisionado`. No dupliques el material
   de clave en los dos lados: elegí uno.
4. Verificá únicamente la presencia por nombre en el proceso que comparte la
   evidencia; nunca imprimas sus valores.

## Multimedia ElevenLabs (reposicion)

Para **rotar** una credencial viva, usá el panel del proveedor. Esta sección
cubre el caso **ausente** en una máquina limpia.

`ELEVENLABS_API_KEY` y `ELEVENLABS_VOICE_ID` están inventariadas, pero no
tienen consumidor activo. No deben reponerse ni hidratarse mientras su
`required_when` sea `never`.

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

Es esperado. Los childs de Claude Code corren con su propio env:
`build-child-env.js` les copia el material al spawn, y esa copia es inmutable
para ellos. Hasta que terminen su iteración actual, siguen con la vieja.

**Con los gates cerrados (estado actual) eso NO está acotado**: no hay nada que
invalide al child ni al Pulpo que lo spawneó. El Pulpo sigue repartiendo la
credencial vieja a cada agente nuevo hasta que el proceso muera. La única cota
es `node .pipeline/restart.js` — [camino A](#camino-a--gates-cerrados-estado-vigente).

Con los gates **abiertos** (#5802, [camino B](#camino-b--gates-abiertos-destino-del-rollout))
sí queda acotado y no requiere que hagas nada: la key vieja revocada falla en el
próximo request del child, el provider devuelve la señal tipada
`authentication_rejected`, y el coordinador de retry —dentro del Pulpo, sin
reiniciarlo— hace exactamente esto, una sola vez por operación raíz:

1. `credential_invalidated` — invalida **sólo** el ámbito afectado
   (`resetVaultCache(scope)`), con verificación positiva (`invalidated_entries`).
2. `credential_reresolved` — emite un snapshot nuevo, ya con la key rotada.
3. Reintenta **una** vez. Si ese reintento sale bien, el incidente se cerró solo.

Si el reintento también es rechazado, se cierra con
`credential_retry_closed` / `reason: second_rejection` — que es la señal de que
**la rotación salió mal**, no de que haga falta reiniciar. Ver [motivos de
cierre](#motivos-de-cierre-rollback-y-escalada).

#### "La key fue comprometida, necesito invalidación inmediata"

Es el peor momento posible. Antes de nada, **verificá los gates**
([precondición](#precondición-verificá-los-gates-antes-de-elegir-camino)): el
procedimiento cambia, y el de los gates cerrados es el que corre hoy.

**Con los gates cerrados (estado vigente):**

1. **Revocá la key comprometida en la consola del proveedor.** Éste es el paso
   que corta el acceso de verdad, y es inmediato. Va **primero**, antes que
   cualquier otra cosa: mientras la key siga válida en el proveedor, quien la
   robó la sigue usando.
2. **Poné la key nueva en el store.**
3. **`node .pipeline/restart.js`.** No es opcional acá. El Pulpo vivo tiene la
   credencial comprometida en su `process.env` desde el boot y **se la copia a
   cada agente que spawnea**, indefinidamente: sin snapshot por lanzamiento ni
   coordinador de retry no hay ninguna pieza que la invalide. Reiniciar es la
   única forma de sacarla de circulación interna.
4. Verificá que el proceso viejo murió (`.pipeline/pulpo.pid` apunta a un PID
   nuevo y vivo) y que el log tiene un `Pulpo V2 iniciado` posterior al paso 1.

> Si por lo que sea el paso 1 se demora o falla —la consola del proveedor no
> responde, perdiste el acceso a la cuenta—, el paso 3 **igual corta la
> propagación interna**: los agentes nuevos ya no reciben la comprometida.
> Hacelo sin esperar a que se resuelva la revocación, y seguí insistiendo con
> ella en paralelo.

**Con los gates abiertos (destino del rollout):** los pasos 1 y 2 son los mismos
y el 3 desaparece — cada child que intente usar la comprometida recibe un rechazo
del proveedor y el coordinador lo resuelve con el ciclo de arriba. La ventana
máxima de un child con material viejo es lo que tarda su request en curso.

> **No mates el parque de agentes a mano**, en ninguno de los dos casos. Matar
> `node.exe` a lo ancho tira todo el trabajo en curso —agentes a mitad de un
> issue, worktrees sin cerrar, locks huérfanos— y un Pulpo relanzado fuera de su
> ciclo es el bucle de muerte que tumbó al Commander 12 h en 2026-07.
> `restart.js` hace el corte de forma ordenada: usalo a él, no `taskkill`.

## Migración al vault: secuencia por host, convivencia y corte (#5453)

> Esto **no** es la rotación de emergencia de arriba. Es el operativo planificado
> que lleva un host desde "resuelve credenciales por archivo" hasta "resuelve por
> vault, con evidencia", y recién al final corta la ventana de bootstrap.
>
> Se corre **un host por vez**. Nadie corta hasta que **todos** los hosts pasaron.

### Quién hace qué

El coordinador ([`.pipeline/lib/vault-migration.js`](../../.pipeline/lib/vault-migration.js))
**no ejecuta** las etapas peligrosas: las **acredita**.

| Etapa | La ejecuta | El coordinador | Cómo se lo decís |
|---|---|---|---|
| `preflight` | coordinador | valida anclas, allowlist e inventario | `vault-migration-run.js preflight --host H` |
| `rotated` | **vos**, fuera de banda | registra la rotación con clave de idempotencia por ventana | `vault-migration-run.js rotate --host H --version <etiqueta>` (frase por STDIN; **nunca** por `advance`) |
| `provisioned` | **vos** (`vault-provisioner`) | registra scopes provisionados | `vault-migration-run.js provision --host H` (frase por STDIN; **nunca** por `advance`) |
| `respawned` | **vos** (`node .pipeline/restart.js`) | verifica `.pid` + proceso vivo | `vault-migration-run.js respawn --host H` |
| `coexisting` | coordinador (tick del Pulpo) | cuenta la matriz de cobertura | automático; a mano: `vault-migration-run.js observe --host H` |
| `cutover-ready` | coordinador | declara elegibilidad | automático |
| `verified` | `vault-cut-fallback.js` (#5452) | delega **una sola vez** | `vault-cut-breakglass.js` |

Rotar y respawnear **no se automatizan a propósito**: rotar emite material
irreversible, y un Pulpo que se reinicia a sí mismo dentro de su propio tick es
el bucle de muerte que tumbó al Commander 12 h en 2026-07. Por eso
`vault.migration.auto_stages` sólo admite `observe`.

### Antes de empezar (una vez, para todo el parque)

1. `vault.enabled: true` y `vault.hostId`/`vault.awsProfile` resueltos en cada host.
2. `vault.shadow_window.hosts_activos` enumera **todos** los hosts que bootean el
   pipeline. Vacía ⇒ el evaluador devuelve `no_verificado` y nada cierra.
3. `vault.required_scopes` y `vault.shared_secrets` coinciden con lo derivado del
   código (ver *Inventario cerrado contra el vault* en
   [`docs/secrets-inventory.md`](../secrets-inventory.md)).
4. `vault.migration.enabled: true` (gate de rollout del coordinador).

Si el preflight rechaza, **no sigas**: el mensaje nombra la causa exacta
(`ancla_no_vault_only`, `allowlist_vacia`, `inventario_incompleto`,
`inventario_divergente`) y todas son de config, no de la máquina.

### La herramienta: `vault-migration-run.js`

Todo lo que sigue se habla con el coordinador a través de **un solo comando**,
[`.pipeline/vault-migration-run.js`](../../.pipeline/vault-migration-run.js). Usa
el **mismo cableado** que el Pulpo
([`lib/vault-migration-wiring.js`](../../.pipeline/lib/vault-migration-wiring.js)):
lo que ves en pantalla es exactamente lo que evalúa el pipeline, no una segunda
implementación que se desincroniza.

```bash
node .pipeline/vault-migration-run.js --help
node .pipeline/vault-migration-run.js status          # dónde está cada host
```

El comando **no rota, no sube material y no corta el fallback**: *acredita* lo
que vos hiciste fuera de banda. Las dos etapas que acreditan material
irreversible (`rotate`, `provision`) exigen una **frase de confirmación por
STDIN**, nunca por argv — argv lo lee cualquier proceso del host y queda en el
historial del shell.

Códigos de salida (estables, para scriptear encima):

| Código | Significado |
|---|---|
| `0` | la etapa avanzó (o ya estaba en ese estado) |
| `10` | gate cerrado (`vault.enabled` o `vault.migration.enabled` en `false`) |
| `11` | falta la frase de confirmación por STDIN |
| `12` | uso inválido (falta `--host`, falta `--version`, comando desconocido) |
| `13` | la etapa **no** avanzó: el mensaje trae la causa |
| `14` | indeterminado |

### Secuencia por host

Para cada host, **en este orden**. El orden no es negociable: provisionar antes
de rotar deja material **ya revocado** en el vault, el host resolvería con
`source: vault`, la cobertura cerraría en verde y el secreto **no funcionaría** —
la cobertura mide *procedencia*, no *validez*, así que no puede atrapar ese caso.

En los ejemplos, `HOST` es el `hostId` tal como figura en
`vault.shadow_window.hosts_activos`.

**1. Preflight** — el coordinador valida ancla vault-only, allowlist e
inventario derivado (CA-22 / CA-25). No toca material.

```bash
node .pipeline/vault-migration-run.js preflight --host HOST
```

Si sale `13`, leé la causa y arreglá **config**, no la máquina de estados.

**2. Rotar** — la rotación en sí la hacés vos, fuera de banda, siguiendo las
secciones por provider de **este mismo runbook** (Anthropic, Gemini, Drive,
Telegram…). Al terminar, actualizá `last_rotated` en
[`docs/secrets-inventory.md`](../secrets-inventory.md) y **commiteá**. Recién
entonces acreditás la rotación:

```bash
echo "ROTACION ACREDITADA" | node .pipeline/vault-migration-run.js rotate --host HOST --version 2026-08-31-r1
```

`--version` es una **etiqueta no sensible** de esa rotación (una fecha y un
contador alcanzan). Nunca el secreto ni nada derivado de él: se persiste en el
estado del host y en el ledger de acreditaciones.

La acreditación queda registrada en
`.pipeline/state/vault-migration/acreditaciones.jsonl`, indexada por la clave de
idempotencia `<host>:rotate:<intento>:<nonce>`. **Si el proceso se cae entre
etapas y reanudás, se reusa esa misma clave y la misma etiqueta: no se te va a
pedir que rotes de nuevo, y el coordinador no va a interpretar la reanudación
como una rotación nueva.**

El `<nonce>` es aleatorio y se fija **una vez por ventana de rotación**, en el
checkpoint. Es lo que separa "reanudar un crash" de "empezar una ventana nueva":
el ledger es append-only y sobrevive a un `reset.js`, así que con una clave
constante por host la acreditación de la ventana anterior volvía a matchear y el
host cruzaba `rotated` **sin que nadie rotara nada**. Con el nonce, una ventana
nueva nunca puede reusar la acreditación de la anterior: te vuelve a pedir la
frase, que es el comportamiento correcto.

> **`advance` nunca acredita `rotate` ni `provision`.** Son las dos etapas
> irreversibles y las dos que exigen un humano, así que sólo avanzan por su
> comando explícito con la frase por STDIN. Si `advance` se traba con
> `rotacion_fallida` o `provision_fallida`, no es una falla del coordinador: es
> el gate pidiéndote la confirmación. La salida te imprime el comando exacto.

**3. Provisionar** — subí el material nuevo al vault, scope por scope, con
[`.pipeline/lib/vault-provisioner.js`](../../.pipeline/lib/vault-provisioner.js).
Cuando los tres scopes (`telegram`, `providers`, `google_drive`) estén arriba:

```bash
echo "PROVISION ACREDITADA" | node .pipeline/vault-migration-run.js provision --host HOST
```

Provisionar sin haber acreditado la rotación devuelve `etapa_fuera_de_orden` y
sale `13`. Es a propósito: es el caso que la cobertura **no puede** atrapar.

**4. Respawnear** — `node .pipeline/restart.js` **desde una terminal**, nunca
desde Git Bash. Esto es lo que abre la ventana de cobertura: `loadIntoEnv()`
hidrata una sola vez por proceso, así que un pulpo/listener/`svc-*` que sigue
vivo conserva el material **anterior** en memoria por más que el vault ya tenga
el nuevo. Después acreditás que volvieron:

```bash
node .pipeline/restart.js          # desde PowerShell/cmd, NO desde Git Bash
node .pipeline/vault-migration-run.js respawn --host HOST
```

El coordinador exige, por **cada** consumidor de larga vida (`pulpo`, `listener`,
`svc-telegram`, `svc-github`, `svc-drive`, `svc-emulador`, `svc-reconciler`,
`dashboard`): que exista su `.pid`, que se haya reescrito **después** de la
rotación, y que el PID de adentro esté vivo. Si falta uno solo sale `13` con
`respawn_incompleto` y la lista de pendientes.

**5. Convivencia** — dejar correr. A partir de acá el tick del Pulpo (cada
`vault.migration.tick_minutes`) observa solo, porque `auto_stages: [observe]`.
Para mirar el avance a mano en cualquier momento:

```bash
node .pipeline/vault-migration-run.js status
node .pipeline/vault-migration-run.js observe --host HOST   # fuerza una evaluación
```

El coordinador cuenta, por descriptor y por host, las resoluciones con
`via: vault` **posteriores al respawn**. La evidencia sanitizada de cada
transición se acumula en `.pipeline/audit/vault-migration.jsonl` (append-only,
`0600`), con el mismo modelo cerrado de campos que el resto del operativo:
nombres lógicos, conteos, timestamps y enums. Nunca valores, paths ni PIDs.

### Último punto de retorno

**El respawn del paso 4 es el último punto de retorno barato.** Hasta ahí,
volver atrás es restaurar el archivo de credenciales y respawnear otra vez.

Después del **corte** (`bootstrap_fallback: false`) ya no hay vuelta atrás por
config: la ventana al archivo está cerrada y volver a abrirla es un commit + un
respawn del parque entero. Por eso el corte exige capability firmada y evidencia
completa, y por eso nunca se hace "para ver si anda".

### Criterio de convivencia (qué esperar y qué NO)

**"Cero errores" no es éxito.** Un host apagado, o un secreto que nadie pidió,
producen cero errores y cero cobertura. El criterio es **cobertura positiva**:
cada descriptor × cada host activo, con al menos una resolución `via: vault`
posterior al último respawn, y **cero** evidencia negativa.

Causas de `not-ready` y qué hacer con cada una:

| Causa | Qué pasó | Qué hacer |
|---|---|---|
| `host_silencioso` | el host no resolvió nada en la ventana | usarlo de verdad (lanzar un agente, mandar un mensaje) |
| `cobertura_previa_al_respawn` | hay cobertura, pero de **antes** del respawn | volver a respawnear y esperar |
| `cobertura_incompleta` | faltan celdas de la matriz | ver qué descriptor falta y ejercitarlo |
| `fuente_legacy` | alguien resolvió por `file-bootstrap`/`missing`/`env` | **no cortar**: falta provisionar ese secreto |
| `allowlist_vacia` | la allowlist del operador quedó vacía | reponer el ancla; **nunca** relajar el gate |
| `estado_indeterminado` | sidecar de integridad, t0 reiniciado o hosts inválidos | revisar `.pipeline/audit/`; **nunca** interpretarlo como verde |
| `evidencia_corrupta` | una fila de evidencia traía un derivado del valor | investigar como incidente, no como bug de conteo |
| `ventana_en_curso` | la matriz está **completa y limpia**, pero todavía no pasaron las `duration_hours` desde el respawn de ese host | **esperar**. No es un defecto ni hay nada que reparar: es la única causa de esta tabla que se resuelve sola |

Una caída de cobertura **retrocede** el host de `cutover-ready` a `coexisting`.
No baja de ahí: nunca se des-rota ni se des-provisiona.

`ventana_en_curso` se evalúa **último**, a propósito. Si el host tiene un
problema real —un secreto sin migrar, una resolución por `file-bootstrap`, un
host mudo— la causa que se reporta es **esa**, porque es la accionable. Decirle
"esperá la ventana" a quien tiene un secreto sin provisionar sería mandarlo a
esperar 24 h para volver a fallar por lo mismo.

La ventana se cuenta **desde el respawn de cada host**, no desde el t0 global de
la ventana sombra: lo que hay que acreditar es la convivencia posterior al
material nuevo. Un host respawneado tarde tiene su propia espera aunque la
ventana global ya haya cerrado para los demás.

### Corte final

El corte lo ejecuta **únicamente**
[`.pipeline/lib/vault-cut-fallback.js`](../../.pipeline/lib/vault-cut-fallback.js).
El coordinador arma un snapshot **informativo**, revalida identidad, política y
cobertura *inmediatamente antes* de delegar, y el ejecutor **vuelve a validar
todo** dentro de su lock antes de persistir. Esa doble validación es la que cierra
el TOCTOU: entre "estaba listo" y "escribo" no puede colarse una caída.

Precondiciones, todas juntas:

- **todos** los hosts en `cutover-ready` (uno solo que no lo esté bloquea);
- allowlist no vacía en todos;
- capability firmada por el operador y **no vencida** (TTL de
  `vault.cut_fallback.authorization_ttl_seconds`);
- canal para publicar la evidencia (Telegram/Drive) **vivo**.

Si el fallback ya está en `false`, el corte resuelve `already-cut`: es **éxito
idempotente**, no error. No hay que "arreglar" nada.

### Break-glass, fuera de banda

Si el vault no resuelve y el parque no bootea:

1. **Nunca** se abre `bootstrap_fallback` "un ratito" sin fecha:
   `bootstrap_fallback_until` es obligatoria cuando el flag está en `true`, y
   pasada esa fecha la ventana no aplica aunque el flag siga encendido.
2. El material de emergencia se repone **por el canal fuera de banda del
   operador**, nunca por Telegram, nunca por el issue, nunca por un comentario de
   PR. (Ver la regla de API keys por terminal.)
3. Reabrir la ventana **reinicia la ventana de cobertura**: toda la evidencia
   anterior deja de contar. Es correcto y es el punto.
4. Con Drive o Telegram caídos, el operativo **no cierra por silencio**: queda
   señal local sanitizada + `needs-human`, y el fallback **se conserva**.

### Evidencia: qué se publica y qué no

La evidencia usa un modelo **cerrado** (lista blanca de campos): nombres
lógicos, conteos, timestamps ISO, etapa y causa. Lo que queda afuera **por
construcción**: valores, prefijos, hashes, nombres de env var, paths, PIDs,
namespaces del vault y account ids.

Al cerrar el operativo, adjuntar por host:

- etapa final y `N/N` de cobertura (el `N` sale de `ENV_DESCRIPTORS`, no de un
  número escrito a mano);
- cantidad de consumidores acreditados en el respawn;
- tamaño de la allowlist;
- fecha de rotación (ISO) y versión no sensible.

Si algo de eso no se puede publicar sin exponer material, **no se publica**: se
deja la señal local y se escala. Un operativo sin evidencia no está cerrado.

## Referencias

- Inventario: [`docs/secrets-inventory.md`](../secrets-inventory.md)
- Diseño multi-provider: [`docs/pipeline-multi-provider.md`](../pipeline-multi-provider.md) §6.2, §6.3, §6.10
- Validador: [`.pipeline/lib/agent-models-validate.js`](../../.pipeline/lib/agent-models-validate.js)
- Aislamiento de credenciales por proceso: [`.pipeline/lib/build-child-env.js`](../../.pipeline/lib/build-child-env.js)
