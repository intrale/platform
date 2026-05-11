# Runbook: rotación de credenciales del pipeline V3

> Lo abriste **bajo presión** (recordatorio T-1 o T-0). Mantén la calma:
> los pasos están numerados, son cortos, y al final hay una checklist de
> verificación + sección "si algo sale mal".

## Contexto general

- **Por qué rotar**: política `≤ 90 días` por convención (ver
  [`docs/pipeline-multi-provider.md`](../pipeline-multi-provider.md) §6.2).
- **Qué archivo refleja el estado**: [`docs/secrets-inventory.md`](../secrets-inventory.md).
- **Qué cron monitorea**: `lib/credential-rotation-cron.js` corre dentro de
  `pulpo.js`. Lee `last_rotated`/`expires_at` del inventario y notifica al
  owner por Telegram. **El cron NO toca env vars ni archivos: vos rotás, vos
  commiteás**.

## Anthropic

1. Abrí <https://console.anthropic.com/settings/keys> con la cuenta que figura
   en `account_id` del inventario.
2. Generá una **nueva key** (botón "Create Key"), nombrá con `intrale-pipeline-v3-YYYYMMDD`.
3. Actualizá la env var del operador:
   ```bash
   # Linux/macOS — editá ~/.zshrc o ~/.bashrc
   export ANTHROPIC_API_KEY="<nueva-key>"
   # Windows — Panel de Control → Sistema → Variables de Entorno
   #   o:  setx ANTHROPIC_API_KEY "<nueva-key>"
   ```
   Cerrá y reabrí la terminal donde corre el pulpo (sin reiniciar la terminal,
   `process.env` queda con el valor viejo).
4. Revocá la **vieja** key desde la misma consola (botón "Revoke").
5. Actualizá `last_rotated` en [`docs/secrets-inventory.md`](../secrets-inventory.md)
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
3. Actualizá la env var del operador:
   ```bash
   export OPENAI_API_KEY="<nueva-key>"
   ```
   Cerrá y reabrí la terminal del pulpo.
4. Revocá la vieja key desde la misma consola (botón "Revoke key").
5. Actualizá `last_rotated` en `docs/secrets-inventory.md`. Commiteá.

### Cómo verificar que rotaste bien (OpenAI)

- [ ] Vieja key revocada falla con `401` (probar con `curl -H "Authorization: Bearer <vieja>" https://api.openai.com/v1/models`).
- [ ] El pulpo arranca sin `[FATAL]` (CA-2).
- [ ] Commit pusheado con `last_rotated` actualizado.

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
