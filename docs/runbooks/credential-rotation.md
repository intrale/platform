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
  "multimedia": {
    "elevenlabs_api_key":  "...",
    "elevenlabs_voice_id": "..."
  }
}
```

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
