# Multi-provider — guía operativa

> **Audiencia:** dev del pipeline o operador que necesita agregar / cambiar / rotar / diagnosticar proveedores de IA del pipeline V3.
> **No es** documento de diseño: para el "por qué" del rediseño multi-provider ver [`docs/pipeline-multi-provider.md`](../pipeline-multi-provider.md) (diseño v2 + decisiones arquitectónicas).
> **Issue de origen:** [#3176](https://github.com/intrale/platform/issues/3176) — documentación canónica operativa de la ola N+1 multi-provider.

---

## Mapa rápido

1. [Agregar un proveedor nuevo](#1-agregar-un-proveedor-nuevo) — 6 puntos de toque coordinados.
2. [Default del pipeline y fallbacks](#2-default-del-pipeline-y-fallbacks) — qué provider corre cuando no hay override.
3. [Modelos disponibles por proveedor](#3-modelos-disponibles-por-proveedor) — catálogo + cómo agregar/quitar.
4. [Configuración por agente](#4-configuración-por-agente) — bloque `skills.<name>` paso a paso.
5. [Información operativa](#5-información-operativa) — validación, audit trail, cuota, diagnóstico.
6. [Referencia rápida](#6-referencia-rápida) — tabla resumen + diagrama de dispatch.
7. [Security considerations](#7-security-considerations) — gestión de keys, CSRF, audit trail, fallbacks reales.
8. [Hardening de free providers](#8-hardening-de-free-providers-3260) — secrets, alerts, telemetry.
9. [Modo degradado del Commander (sin LLM)](#9-modo-degradado-del-commander-sin-llm) — `/quota`, cooldown destructivo, gate texto libre.

> **Convención:** todos los paths `.pipeline/...` son relativos a la raíz del repo (`C:\Workspaces\Intrale\platform\`). Todos los comandos asumen Node.js 21 disponible en PATH.

---

## 1. Agregar un proveedor nuevo

> **Estado actual:** el pipeline tiene tres providers operativos (`anthropic`, `openai-codex`, `deterministic`) y dos provistos como stubs para futura activación (`gemini`, `ollama`). Esta sección describe el procedimiento end-to-end para que un dev nuevo pueda dar de alta un proveedor sin leer código fuente.

### 1.1 Checklist de 6 puntos de toque

Cada paso es **obligatorio**. Si saltás uno, el boot del pulpo aborta con mensaje accionable o el dispatch a runtime degrada a fallback de regresión cero. El orden importa.

| # | Archivo | Acción |
|---|---------|--------|
| 1 | `.pipeline/lib/agent-models-validate.js` | Sumar el alias del CLI a `ALLOWED_LAUNCHERS`. |
| 2 | `.pipeline/lib/agent-models-validate.js` | Sumar el parser stream/SSE/JSONL a `ALLOWED_OUTPUT_PARSERS`. |
| 3 | `.pipeline/lib/agent-models-validate.js` | Sumar la env var de credencial a `ALLOWED_CREDENTIAL_ENV_VARS`. |
| 4 | `.pipeline/lib/quota-exhausted.js` | Sumar el provider + sus `error_types` a `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER`. |
| 5 | `.pipeline/lib/multi-provider/model-catalog.js` | Agregar la lista de modelos del provider al `CATALOG`, bumpear `CATALOG_VERSION`. |
| 6 | `.pipeline/lib/agent-launcher/providers/<provider>.js` | Implementar el handler (`detectLauncher`, `buildSpawn`, `parseTokensFromLog`, `detectQuotaExhausted`). |
| 7 | `.pipeline/lib/agent-launcher/resolve-provider.js` | Sumar la línea al objeto `PROVIDER_HANDLERS` (tabla hardcoded, **no** require dinámico). |
| 8 | `.pipeline/lib/quota-adapters/<provider>.js` | Implementar `quotaUsage(sessionData)` (cálculo offline, sin red). |
| 9 | `.pipeline/lib/quota-adapters/index.js` | Sumar el nombre del provider a `ALLOWED_PROVIDERS`. |
| 10 | `.pipeline/agent-models.json` | Declarar el bloque `providers.<name>` con `launcher`, `model`, `spawn_args_template`, `output_parser`, `quota_error_types`, `prompt_caching`, `credentials_env`, `permissions_mode`. |

> **Por qué tantos puntos de toque:** el pipeline aplica **defensa en profundidad** ([#3080](https://github.com/intrale/platform/issues/3080), [#3081](https://github.com/intrale/platform/issues/3081), [#3085](https://github.com/intrale/platform/issues/3085)). El JSON declara la intención, pero cada allowlist hardcoded existe para que un atacante con permiso de PR **no pueda** introducir un launcher arbitrario editando solo el JSON. Si querés evitar esta fricción, [#3197](https://github.com/intrale/platform/issues/3197) propone auto-generación de tablas; sigue abierto.

### 1.2 Esquema de configuración del bloque `providers.<name>`

Estructura literal aceptada por el schema Ajv 2020-12 ([`.pipeline/agent-models.schema.json`](../../.pipeline/agent-models.schema.json) — `$defs.providerDef`):

```json
{
  "launcher": "claude",
  "model": "claude-opus-4-7",
  "spawn_args_template": [
    "-p", "{user_prompt}",
    "--system-prompt-file", "{system_file}",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions"
  ],
  "output_parser": "anthropic-stream-json",
  "quota_error_types": ["usage_limit_error", "weekly_quota_exhausted", "snapshot_threshold_90"],
  "resets_at_cap_max_days": 7,
  "supports_tool_use": true,
  "prompt_caching": {
    "supported": true,
    "ttl_seconds_default": 300,
    "ttl_seconds_extended": 3600
  },
  "credentials_env": ["ANTHROPIC_API_KEY"],
  "permissions_mode": "bypassPermissions"
}
```

**Claves:**

- `launcher` — alias del binario CLI. Debe estar en `ALLOWED_LAUNCHERS` (`claude`, `codex`, `gemini`, `ollama`, `node`). El schema deriva su enum por inyección programática, no por copia literal: editar la constante en JS basta.
- `model` — modelo por default si el skill no sobreescribe.
- `spawn_args_template` — argv que recibe el child. Las llaves `{user_prompt}`, `{system_file}`, `{script_path}`, `{issue}`, `{trabajando_path}`, `{model}` son los **únicos placeholders válidos** (`ALLOWED_PLACEHOLDERS`). Sustitución 1:1 a elemento del argv — **nunca concatenación shell**.
- `output_parser` — normalizador del output. Valores: `anthropic-stream-json`, `openai-sse`, `gemini-stream`, `ollama-jsonl`, `none` (deterministic).
- `quota_error_types` — strings que el detector de cuota (`lib/quota-exhausted.js`) marca como "cuota agotada" para este provider. Cada item cross-validado contra la **meta-allowlist** en `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER` ([#3077](https://github.com/intrale/platform/issues/3077) SEC-2, defensa anti supply-chain).
- `resets_at_cap_max_days` — cap superior del `resets_at` cuando el provider reporta cuota agotada (cuotas semanales = 7, mensuales = 31). Aplicado en `capResetsAt()` para evitar "drenado natural" falso por un `reset_at` lejano malicioso ([#3077](https://github.com/intrale/platform/issues/3077) SEC-6).
- `supports_tool_use` — `true` / `false` / `"limited"`. Define paridad funcional cross-provider.
- `prompt_caching` — capacidades de cache (`supported`, `auto`, `ttl_seconds_default`, `ttl_seconds_extended`). Necesario para normalizar costos cross-provider.
- `credentials_env` — env vars que **deben existir al boot del pulpo** si algún skill referencia este provider. Cada item validado contra `ALLOWED_CREDENTIAL_ENV_VARS` ([#3080](https://github.com/intrale/platform/issues/3080) SEC-3, anti-exfiltración de `PATH`/`AWS_SECRET_ACCESS_KEY` por declaración).
- `permissions_mode` — modo de permisos del CLI. Mapeado a la matriz capability×(provider, mode) de [`docs/pipeline-multi-provider/permission-mapping.md`](../pipeline-multi-provider/permission-mapping.md).

### 1.3 Dónde se inyectan las API keys y cómo rotarlas

**Ubicación canónica:** `~/.claude/secrets/telegram-config.json` (fuera del repo, inmune a checkouts y pulls).

**Schema parcial (placeholders, NO valores reales):**

```json
{
  "bot_token": "<TELEGRAM_BOT_TOKEN>",
  "chat_id": "<TELEGRAM_CHAT_ID>",
  "anthropic_api_key": "<ANTHROPIC_API_KEY o vacío si usás OAuth/MAX>",
  "openai_api_key": "<OPENAI_API_KEY>",
  "elevenlabs_api_key": "<ELEVENLABS_API_KEY>"
}
```

**Boot del pulpo** ([#3172](https://github.com/intrale/platform/issues/3172) / H3 multi-provider): lee este JSON al arrancar y hidrata las env vars correspondientes en el process del pulpo. Los child agents heredan `process.env` filtrado por `build-child-env.js` (allowlist `SYSTEM_ALLOWLIST` + la env de credenciales del provider del skill, **nunca todas las keys**).

**Rotación de keys — dos caminos:**

#### Camino A — UI dashboard (recomendado para ops día-a-día)

1. Levantar el dashboard: `node .pipeline/dashboard.js` (si no corre ya).
2. Abrir `http://localhost:8080/dashboard.html#multi-provider`.
3. Pestaña **1 · Proveedores**.
4. Click "Rotar key" en el provider deseado.
5. Pegar el nuevo valor en el modal y confirmar.
6. El backend hace **write atómico + backup pre-save** en `~/.claude/secrets/backups/` (retención 30, ver `secrets-rw.js`).
7. El archivo en disco queda con permisos `0600` (best-effort en Windows).
8. Audit chain registra `{type: "api_key_rotation", provider, jsonField, fingerprint, autor}` en `.pipeline/audit/api-key-rotations.jsonl`.

> **Anthropic key NO es rotable por UI.** El input aparece deshabilitado (`editable: false`) porque Claude Code usa OAuth / MAX login, no API key. Rotarla acá rompe el child env. Si necesitás rotar OAuth, hacelo desde `claude login` en CLI.

#### Camino B — edición manual del archivo (uso puntual)

```bash
# 1. Backup manual (la UI hace esto automático)
cp ~/.claude/secrets/telegram-config.json ~/.claude/secrets/backups/telegram-config.$(date -u +%Y%m%dT%H%M%SZ).json

# 2. Editar
${EDITOR:-vim} ~/.claude/secrets/telegram-config.json

# 3. Validar JSON
node -e "JSON.parse(require('fs').readFileSync(process.env.HOME + '/.claude/secrets/telegram-config.json'))"

# 4. Restart del pulpo (no hot-reload de secrets — el pulpo cachea al boot)
node .pipeline/restart.js
```

**Marca de revocación sin borrar:** si querés invalidar una key sin borrar el campo, escribí el valor `REVOKED`, `PLACEHOLDER`, `MOVED`, `EXAMPLE`, `REPLACE` o `CHANGE_ME` (case insensitive). El módulo `secrets-rw.js` los detecta como placeholder via `PLACEHOLDER_RE` y reporta `status: 'placeholder'` en la UI.

### 1.4 Cómo hacerlo desde la UI del dashboard

El panel **Multi-Provider** del dashboard ([#3177](https://github.com/intrale/platform/issues/3177), [#3196](https://github.com/intrale/platform/pull/3196)) tiene 4 tabs operativos. Para dar de alta un provider nuevo desde la UI:

1. **Tab "1 · Proveedores"** → rotar la API key del nuevo provider (sólo si el provider ya está declarado en `agent-models.json`).
2. **Tab "2 · Por agente"** → asignar skills al nuevo provider.
3. **Tab "3 · Catálogo"** → verificar que los modelos del provider aparezcan listados.
4. **Tab "6 · Permission overrides"** → si el provider degrada capabilities (caso típico de codex sin `tool_use_gated`), crear override con TTL y justificación.

> **Caveat:** el panel **no permite registrar un provider nuevo desde la UI**. Para eso editás `agent-models.json` (Camino B de [§1.3](#13-dónde-se-inyectan-las-api-keys-y-cómo-rotarlas)) o usás `PUT /api/multi-provider/config` con CSRF. El panel sí permite modificar providers existentes (default, fallbacks, model overrides por skill).

> **Por qué la UI no es one-click para "provider nuevo":** los 6+ puntos de toque de [§1.1](#11-checklist-de-6-puntos-de-toque) viven en código JS hardcoded (allowlists). Un PR review + tests es el gate correcto para sumar un launcher / parser / quota-error-types nuevo; la UI no puede acortarlo sin debilitar la defensa en profundidad.

---

## 2. Default del pipeline y fallbacks

### 2.1 Default del pipeline

El campo raíz `default_provider` de [`.pipeline/agent-models.json`](../../.pipeline/agent-models.json) define el provider usado para **cualquier skill que no tenga override**.

```json
{
  "default_provider": "anthropic",
  ...
}
```

**Reglas:**

- `default_provider` **debe existir** como clave en `providers` (validación cruzada en `validateCrossReferences`).
- Si ningún skill tiene override, todos los skills LLM corren contra el default.
- Si un skill aparece en `skills.<name>.provider`, ese valor **gana** sobre el default.

### 2.2 Default por agente (override de skill)

Cada skill se declara en el bloque `skills.<name>` con un campo `provider`. Esto sobreescribe el `default_provider` solo para ese skill.

```json
{
  "skills": {
    "guru":         { "provider": "anthropic" },
    "qa":           { "provider": "openai-codex" },
    "backend-dev":  { "provider": "anthropic", "model_override": "claude-sonnet-4-6" },
    "build":        { "provider": "deterministic" }
  }
}
```

### 2.3 Fallbacks

Cada skill **puede** declarar una lista ordenada `fallbacks[]` de providers alternativos.

```json
{
  "skills": {
    "qa": {
      "provider": "openai-codex",
      "fallbacks": ["anthropic"]
    }
  }
}
```

**Validaciones cruzadas** (`agent-models-validate.js`):

- Cada item de `fallbacks[]` debe existir como clave en `providers`.
- Un fallback no puede duplicar el `provider` primario (sería ruido).
- Strings vacíos o no-string → rechazo con `fix:` accionable.

> #### Estado actual de fallbacks (#3198 ✅ cerrado — failover automático ACTIVO)
>
> El campo `skills.<name>.fallbacks[]` está soportado end-to-end:
>
> - **Schema + UI**: declarable en `agent-models.json` y editable desde el dashboard (#3177).
> - **Validación al boot**: `agent-models-validate.js` (cada item existe como provider, no duplica el primario, anti-cycle estático).
> - **Consumer en runtime**: `lib/agent-launcher/dispatch-with-fallback.js` ([fuente](../../.pipeline/lib/agent-launcher/dispatch-with-fallback.js)) — itera la chain cuando el primary está gated. Implementado y mergeado por [#3198](https://github.com/intrale/platform/issues/3198) (2026-05-15).
>
> **El "fallback" hoy cubre dos planos**:
>
> 1. **Regresión cero** (`resolveProviderForSkill` en `resolve-provider.js`): si `agent-models.json` no existe / no parsea / el skill no está declarado → `provider: 'anthropic', model: 'claude-opus-4-7'`. Inalterado por #3198.
> 2. **Failover cross-provider** (`resolveSpawnWithFallback` en `dispatch-with-fallback.js`): si el primary está gated por cuota agotada, itera `skills.<x>.fallbacks[]` en orden y devuelve el primer candidato disponible. Caps de seguridad: `MAX_FALLBACK_DEPTH = 5`, `Set` anti-cycle en runtime, skip de fallbacks que comparten el provider gated.
>
> Cada decisión cross-provider se loguea en `logs/cross-provider-dispatch-YYYY-MM-DD.jsonl` (hash-chain SHA-256, redactado) y dispara notificación Telegram post-hoc via `servicios/telegram/pendiente/` (filesystem queue, sin LLM en el camino). Detalle operativo completo en [`docs/pipeline-multi-provider.md`](../pipeline-multi-provider.md) §3.9.
>
> **Cuándo PUEDE NO haber failover** (comportamiento esperado, no bug):
>
> - El skill no declara `fallbacks` o el array está vacío → si el primary está gated, archivo a `pendiente/` (legacy).
> - Toda la chain (primary + fallbacks) está gated → archivo a `pendiente/`.
> - El skill está en `DETERMINISTIC_SKILLS` (allowlist hardcoded) → corre Node puro, sin LLM, sin necesidad de fallback.
>
> **Inspeccionar / desactivar en operación**:
>
> - Ver decisiones: `tail -n 50 logs/cross-provider-dispatch-$(date -u +%F).jsonl | jq .`
> - Kill switch por skill: vaciar `skills.<x>.fallbacks[]` desde el dashboard (`[]`) → cae a comportamiento pre-#3198.
> - Forzar provider primario alternativo: cambiar `skills.<x>.provider` desde el dashboard + `node .pipeline/restart.js`.

### 2.4 Reglas de precedencia

Cuando el pulpo va a spawn un skill, el dispatcher (`resolveProviderForSkill`) aplica este orden:

```
1. ¿El skill está en la allowlist `DETERMINISTIC_SKILLS`? (hardcoded en providers/deterministic.js)
   → SÍ: provider = 'deterministic', source = 'deterministic-allowlist'.
   → NO: continuar.

2. ¿Existe `.pipeline/agent-models.json` y parsea?
   → NO: provider = 'anthropic', model = 'claude-opus-4-7', source = 'fallback-no-config' (o 'fallback-read-error').

3. ¿`skills.<skill>` existe en el JSON?
   → NO: provider = 'anthropic', model = (defaults.model || legacy), source = 'fallback-skill-not-found'.

4. provider = skills.<skill>.provider, model = (skills.<skill>.model_override || providers.<provider>.model).
   source = 'agent-models'. Validar provider contra tabla hardcoded PROVIDER_HANDLERS.
```

> **Implicancia:** el `default_provider` raíz **no se aplica explícitamente en runtime**. El dispatcher prefiere el `provider` del skill o cae directo a `'anthropic'` por compat. Esto está documentado en el código como decisión consciente — ver comentario CA-2 de `resolve-provider.js`.

### 2.5 Cómo configurarlo desde la UI del dashboard

| Configuración | Tab dashboard | Acción |
|---------------|---------------|--------|
| `default_provider` raíz | **1 · Proveedores** | Card "Default provider" → select. |
| `skills.<name>.provider` | **2 · Por agente** | Click en el provider de la fila del skill → select. |
| `skills.<name>.model_override` | **2 · Por agente** | Click en el modelo de la fila → select del catálogo. |
| `skills.<name>.fallbacks[]` | **2 · Por agente** | Botón "Fallbacks" en la fila → modal con orden. |

Cualquier cambio dispara:

1. **Preview de diff** (modal "Preview de cambios") — muestra qué skills cambian.
2. Confirmación → `PUT /api/multi-provider/config` con CSRF token.
3. Schema validation server-side (`agent-models-validate.js`).
4. Write atómico + backup en `.pipeline/audit/agent-models-backups/<ISO-ts>.json`.
5. UI muestra botón "Reload pipeline" — click ejecuta `restart.js` (el pulpo no hot-reloads la config; cachea al boot).

---

## 3. Modelos disponibles por proveedor

### 3.1 Listado por defecto (estado actual del catálogo)

> **Fuente de verdad en código:** [`.pipeline/lib/multi-provider/model-catalog.js`](../../.pipeline/lib/multi-provider/model-catalog.js). `CATALOG_VERSION` indica la versión vigente.

| Provider | Modelo | Context | Capabilities | Costo input USD / 1M | Costo output USD / 1M | Recomendado para |
|----------|--------|---------|--------------|----------------------|------------------------|------------------|
| anthropic | `claude-opus-4-7` | 1.000.000 | chat, tools, vision, reasoning, cache | 15.00 | 75.00 | guru, po, review, planner, security, qa |
| anthropic | `claude-sonnet-4-6` | 200.000 | chat, tools, vision, cache | 3.00 | 15.00 | backend-dev, android-dev, web-dev, pipeline-dev, ux, refinar |
| anthropic | `claude-haiku-4` | 200.000 | chat, tools, cache | 0.25 | 1.25 | linter, delivery |
| openai-codex | `gpt-5-codex` | 256.000 | chat, tools, cache | 2.50 | 10.00 | backend-dev, pipeline-dev |
| openai-codex | `gpt-5` | 256.000 | chat, tools, vision, cache | 5.00 | 20.00 | guru, qa |
| deterministic | `deterministic` | 0 | (sin LLM) | 0 | 0 | build, tester, linter, delivery |

> **Importante:** esta tabla se mantiene **a mano** y puede desactualizarse si el catálogo cambia sin que el doc se actualice. Para el estado canónico siempre consultá el archivo de código o la **Tab "3 · Catálogo"** del dashboard. El issue [#3197](https://github.com/intrale/platform/issues/3197) propone auto-generar esta tabla — sigue abierto.

### 3.2 Cómo agregar un modelo al catálogo

1. **Editar [`.pipeline/lib/multi-provider/model-catalog.js`](../../.pipeline/lib/multi-provider/model-catalog.js)** — agregar entrada en el array del provider correspondiente:

   ```js
   {
       id: 'claude-sonnet-5',
       label: 'Claude Sonnet 5',
       capabilities: ['chat', 'tools', 'vision', 'cache'],
       cost_per_1m: { input: 4.00, output: 18.00 },
       context_window: 1_000_000,
       release_date: '2026-08',
       recommended_for: ['backend-dev', 'pipeline-dev'],
   },
   ```

2. **Bumpear `CATALOG_VERSION`** — convención `YYYY-MM-DD.N` (cache busting del front).

3. **Si el modelo no existe en la allowlist del validador**, agregarlo a `ALLOWED_MODELS_BY_LAUNCHER` en [`.pipeline/lib/agent-models-validate.js`](../../.pipeline/lib/agent-models-validate.js).

   > **Nota:** al 2026-05-14 esta allowlist está mencionada en comentarios pero **no implementada como constante**. La validación efectiva de `model` y `model_override` la hace el schema vía el campo libre `minLength: 1`. Si el issue [#3197](https://github.com/intrale/platform/issues/3197) o un PR de seguridad sucesivo materializa la constante, este paso se vuelve obligatorio.

4. **Tests:** correr `node --test .pipeline/lib/__tests__/` (no hay tests específicos del catálogo todavía; agregar uno smoke que valide forma `{id, label, capabilities, cost_per_1m, context_window}`).

5. **PR + review** (CODEOWNERS `.pipeline/lib/` = `@leitolarreta`).

### 3.3 Cómo quitar un modelo del catálogo

> **Cuidado:** si algún skill tiene `model_override` apuntando al modelo a remover, el boot del pulpo aborta. Verificá ANTES:

```bash
grep -E "\"model_override\":\s*\"<modelo-a-quitar>\"" .pipeline/agent-models.json
```

1. Si hay matches → migrar los skills al modelo de reemplazo (preferentemente la misma familia) **antes** de tocar el catálogo.
2. Quitar la entrada de `CATALOG` en `model-catalog.js`.
3. Bumpear `CATALOG_VERSION`.
4. Si el modelo estaba en `ALLOWED_MODELS_BY_LAUNCHER` (cuando se materialice), removerlo también.
5. Commit + review.

### 3.4 Capabilities por modelo

El campo `capabilities[]` del catálogo enumera **propiedades funcionales del modelo** (`chat`, `tools`, `vision`, `reasoning`, `cache`). Es **distinto** de las capabilities de permisos (file_read, bash, etc.) que viven en la matriz capability×(provider, mode) — esa otra tabla se documenta en [`docs/pipeline-multi-provider/permission-mapping.md`](../pipeline-multi-provider/permission-mapping.md).

### 3.5 Restricción de modelos por agente

No existe un campo `allowedModels[]` por skill en el schema vigente. La restricción se hace por:

- **`model_override`** explícito en `skills.<name>` (positivo: este modelo).
- **Ausencia de `model_override`** → cae al `providers.<provider>.model` default.
- **Validación lazy** del modelo contra la allowlist `ALLOWED_MODELS_BY_LAUNCHER` (cuando se materialice, ver [§3.2.3](#32-cómo-agregar-un-modelo-al-catálogo)).

Si necesitás una restricción más fina ("este skill solo puede usar Haiku o Sonnet, nunca Opus"), abrir issue de seguridad — hoy se hace por convención + review.

---

## 4. Configuración por agente

### 4.1 Esquema completo del bloque `skills.<name>`

```json
{
  "skills": {
    "<skill-name>": {
      "provider": "<provider-name>",
      "model_override": "<model-id-opcional>",
      "fallbacks": [
        "<provider-legacy>",
        { "provider": "<provider-name>", "model_override": "<model-id>" }
      ]
    }
  }
}
```

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `provider` | string | sí | Debe existir como clave en `providers`. |
| `model_override` | string | no | Modelo específico que sobreescribe el `model` default del provider. |
| `fallbacks` | array de `string` o `{provider, model_override}` | no | Lista ordenada de providers alternativos. Consumido por `dispatch-with-fallback.js` cuando el primary está gated por cuota (#3198, ver [§2.3](#23-fallbacks)). Desde **#3221** acepta dos shapes (backward-compatible): (a) string suelto con el nombre del provider (usa el `model` default del provider), o (b) objeto `{provider, model_override}` que pinea el modelo concreto del provider para ese skill — necesario cuando, por ejemplo, `qa` quiere `gpt-5` (vision) y no el `gpt-5-codex` default de `openai-codex`. Cross-validación en `lib/agent-models-validate.js`: cada provider del fallback debe existir en `providers[]`, no puede duplicar el primario, y el `model_override` debe estar en `ALLOWED_MODELS_BY_LAUNCHER` del launcher apuntado. |

### 4.2 Skills determinísticos (sin LLM)

Los skills **`build`, `tester`, `linter`, `delivery`** corren sin LLM. La asignación canónica es `provider: 'deterministic'`. La allowlist hardcoded vive en `providers/deterministic.js` — **siempre prevalece** sobre lo que diga `agent-models.json` (defensa contra config corrupta).

```json
{
  "skills": {
    "build":    { "provider": "deterministic" },
    "tester":   { "provider": "deterministic" },
    "linter":   { "provider": "deterministic" },
    "delivery": { "provider": "deterministic" }
  }
}
```

### 4.3 Ejemplos completos para 3 agentes representativos

#### Ejemplo 1 — guru (análisis técnico) con Opus por defecto

```json
{
  "skills": {
    "guru": { "provider": "anthropic" }
  }
}
```

Resuelve a `provider: 'anthropic', model: 'claude-opus-4-7'` (default del provider).

#### Ejemplo 2 — backend-dev con Sonnet (override por costo)

```json
{
  "skills": {
    "backend-dev": {
      "provider": "anthropic",
      "model_override": "claude-sonnet-4-6"
    }
  }
}
```

Resuelve a `provider: 'anthropic', model: 'claude-sonnet-4-6'` (5× más barato que Opus para tareas template-driven).

#### Ejemplo 3 — qa con codex como primario y fallback declarado

```json
{
  "skills": {
    "qa": {
      "provider": "openai-codex",
      "fallbacks": ["anthropic"]
    }
  }
}
```

Resuelve a `provider: 'openai-codex', model: 'gpt-5-codex'`. Si OpenAI agota cuota, el dispatcher itera `fallbacks: ["anthropic"]` (#3198 — consumer runtime activo) y, si Anthropic está disponible, spawnea con `provider: 'anthropic'` automáticamente; si toda la chain está gated, el archivo va a `pendiente/` esperando reset ([§2.3](#23-fallbacks)).

### 4.4 Orden canónico por agente — sign-off Leo 2026-05-15 (#3221)

Esta tabla refleja la **fuente autoritativa**: la memoria `project_multi-provider-per-agent-order` (sign-off Leo 2026-05-15). El archivo `.pipeline/agent-models.json` carga este orden 1:1. Los tests en `lib/__tests__/agent-models-validate.test.js` actúan como drift detector — si la tabla cambia, los tests fallan y avisan.

Convenciones:
- **Gemini EXCLUIDO**: el skill toca código fuente / secrets / estrategia. TOS AI Studio entrena con prompts free → riesgo de fuga.
- **Gemini incluido**: el skill procesa multimodal (video QA, screenshots, mockups) y/o no toca código sensible.
- Cuando un fallback aparece con `model_override` específico, es porque el `model` default del provider no es adecuado para ese skill (ej. `qa` necesita `gpt-5` con vision, no `gpt-5-codex` text-only).

| Skill | Primary | Fallback 1 | Fallback 2 | Fallback 3 | Fallback 4 | Notas |
|-------|---------|------------|------------|------------|------------|-------|
| `backend-dev` | claude / opus-4-7 | openai-codex / gpt-5-codex | groq / qwen2.5-coder-32b | cerebras / llama-3.3-70b | — | Gemini **EXCLUIDO** (toca secrets/prod) |
| `pipeline-dev` | claude / opus-4-7 | openai-codex / gpt-5-codex | groq / qwen2.5-coder-32b | cerebras / llama-3.3-70b | — | Gemini **EXCLUIDO** (toca secrets/prod) |
| `android-dev` | claude / opus-4-7 | openai-codex / gpt-5-codex | groq / qwen2.5-coder-32b | gemini-google / gemini-2.0-flash | cerebras / llama-3.3-70b | Cliente Android — Gemini OK |
| `web-dev` | claude / opus-4-7 | openai-codex / gpt-5-codex | groq / qwen2.5-coder-32b | gemini-google / gemini-2.0-flash | cerebras / llama-3.3-70b | Cliente web — Gemini OK |
| `security` | claude / opus-4-7 | openai-codex / gpt-5-codex | groq / qwen2.5-coder-32b | cerebras / llama-3.3-70b | — | Gemini **EXCLUIDO** (gate pre-merge sensible) |
| `qa` | claude / opus-4-7 | openai-codex / gpt-5 | gemini-google / gemini-2.0-flash | groq / llama-3.3-70b-versatile | cerebras / llama-3.3-70b | Vision multimodal (video) — Gemini **incluido** porque solo procesa output de emulador, no secrets |
| `review` | claude / sonnet-4-7 | openai-codex / gpt-5-codex | groq / qwen2.5-coder-32b | cerebras / llama-3.3-70b | — | Gemini **EXCLUIDO** (lee diffs con secrets/JWT) |
| `po` | claude / opus-4-7 | openai-codex / gpt-5 | gemini-google / gemini-2.0-flash | groq / llama-3.3-70b-versatile | cerebras / llama-3.3-70b | Vision (video QA + screenshots) — Gemini OK por TOS |
| `ux` | claude / opus-4-7 | openai-codex / gpt-5 | gemini-google / gemini-2.0-flash | groq / llama-3.3-70b-versatile | cerebras / llama-3.3-70b | Vision (mockups/screenshots) — Gemini OK |
| `doc` | claude / sonnet-4-7 | openai-codex / gpt-5-codex | groq / llama-3.3-70b-versatile | cerebras / llama-3.3-70b | — | Gemini **EXCLUIDO** (estrategia de producto) |
| `planner` | claude / sonnet-4-7 | openai-codex / gpt-5-codex | groq / llama-3.3-70b-versatile | cerebras / llama-3.3-70b | — | Gemini **EXCLUIDO** (roadmap/estrategia) |
| `guru` | claude / sonnet-4-7 | openai-codex / gpt-5-codex | groq / qwen2.5-coder-32b | cerebras / llama-3.3-70b | — | Gemini **EXCLUIDO** (fragmentos código) |
| `ops` | claude / sonnet-4-7 | openai-codex / gpt-5-codex | groq / qwen2.5-coder-32b | cerebras / llama-3.3-70b | — | Gemini **EXCLUIDO sí o sí** (procesa API keys / AWS creds / Cognito) |
| `perf` | claude / sonnet-4-7 | openai-codex / gpt-5-codex | gemini-google / gemini-2.0-flash | groq / qwen2.5-coder-32b | cerebras / llama-3.3-70b | Sin secrets — Gemini OK |
| `auth` | claude / sonnet-4-7 | openai-codex / gpt-5-codex | groq / qwen2.5-coder-32b | cerebras / llama-3.3-70b | — | Gemini **EXCLUIDO** (config interna del entorno) |

> **Sobre la nota "sonnet-4-7" vs "sonnet-4-6" de la memoria:** la memoria original escribió `sonnet-4-6` para varios skills; el catálogo `ALLOWED_MODELS_BY_LAUNCHER` declara `claude-sonnet-4-7` siguiendo la convención del cluster (4-7 para Opus, 4-5 para Haiku). El JSON canónico usa `claude-sonnet-4-7` (modelo validado en la allowlist). Si Anthropic libera `claude-sonnet-4-6` en algún momento, agregarlo a `ALLOWED_MODELS_BY_LAUNCHER.claude` requiere review humano.

> **Sobre `tester` y `build` (deterministic):** la memoria `project_multi-provider-per-agent-order` originalmente proponía `build`=groq y `tester`=claude-sonnet como primary LLM. Sin embargo, **ambos skills son determinísticos** — corren como Node scripts (`.pipeline/skills-deterministicos/{build,tester}.js`) y la allowlist hardcoded `DETERMINISTIC_SKILLS = ['build', 'tester', 'linter', 'delivery']` en `resolve-provider.js` fuerza spawn determinístico ignorando lo que diga `agent-models.json`. Declararlos con LLM declarativo y `fallbacks[]` en el JSON crea **drift entre fuentes de verdad** (mismo patrón del incidente #3157 que costó $2.72/h en builds). Por eso `agent-models.json` los declara con la forma mínima `{provider: deterministic}` igual que `linter` y `delivery`, y `deterministic-skills-coherence.test.js` lo enforce. Si alguna vez se introduce una variante LLM-augmented (ej. `tester --from-gherkin`), se trata como un skill nuevo con su propia entrada, no se mezcla con el determinístico.

### 4.5 Pasos para hacer lo mismo desde la UI del dashboard

1. Abrir `http://localhost:8080/dashboard.html#multi-provider`.
2. Tab **2 · Por agente**.
3. Localizar el skill en la grilla (search por nombre).
4. Cambios disponibles:
   - **Provider:** select de la fila → elegir nuevo.
   - **Model:** select del catálogo según provider elegido.
   - **Fallbacks:** botón "Fallbacks" → modal con orden drag-and-drop.
   - **NON_DEGRADABLE banner rojo:** indica que el skill está protegido — no se puede asignar un provider con menos capabilities que las requeridas (ver `NON_DEGRADABLE_SKILLS` en `permission-validator.js`).
5. Click "Guardar" → modal de diff.
6. Confirmar diff → write atómico + reload manual del pipeline.

---

## 5. Información operativa

### 5.1 Validar la configuración

**CLI humanizado** ([`#3170`](https://github.com/intrale/platform/issues/3170)):

```bash
node .pipeline/validate-agent-models.js
```

Salida happy path (≤ 5 líneas):

```
✅ Schema agent-models.json válido
✅ Cross-validations OK (providers, skills, fallbacks, quota_error_types)
✅ Credenciales env: todas las requeridas presentes
✅ Sin secrets hardcoded detectados
```

**Flags útiles:**

```bash
node .pipeline/validate-agent-models.js --help    # ayuda + exit codes
node .pipeline/validate-agent-models.js --quiet   # 1 línea para CI
node .pipeline/validate-agent-models.js --no-env  # saltea check de env vars (útil en pre-commit local sin .env real)
```

**Exit codes** (mapeo accionable):

| Code | Causa | Acción del operador |
|------|-------|---------------------|
| 0 | OK | nada |
| 1 | Schema inválido o cross-refs rotos | editar `agent-models.json`, releer mensaje con `path` + `fix:` |
| 2 | Env var de credencial faltante | exportar la env var o quitar el provider del JSON |
| 3 | Secret hardcoded detectado en algún campo | reemplazar el literal por `${VAR_NAME}` |
| 4 | Path inválido / archivo no encontrado | verificar cwd y existencia de `.pipeline/agent-models.json` |

### 5.2 Audit trail

El pipeline mantiene **dos audit logs independientes** con propiedades distintas:

#### 5.2.1 Switches de provider/model — `.pipeline/logs/quota-detector-<YYYY-MM-DD>.log`

Línea de log estructurado JSON cada vez que el detector marca cuota agotada. Campos canónicos:

```json
{
  "ts": "2026-05-14T19:09:16.000Z",
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "pattern_matched": "usage_limit_error",
  "resets_at": "2026-05-15T00:00:00.000Z",
  "raw_excerpt": "<sanitizado, ≤200 chars>"
}
```

Lectura:

```bash
# Hoy
cat .pipeline/logs/quota-detector-$(date -u +%Y-%m-%d).log

# Último switch a cualquier provider
grep '"provider":"openai-codex"' .pipeline/logs/quota-detector-*.log | tail -1
```

#### 5.2.2 Audit chain SHA-256 — `.pipeline/audit/<type>.jsonl`

Append-only con hash chain ([#3082](https://github.com/intrale/platform/issues/3082) S4 + [#3068](https://github.com/intrale/platform/issues/3068) refinamiento). Cada línea trae `hash_prev` + `hash_self` para detección de tampering.

Archivos canónicos:

| Archivo | Qué registra |
|---------|--------------|
| `.pipeline/audit/api-key-rotations.jsonl` | Cada rotación de API key vía UI/API. |
| `.pipeline/audit/permission-overrides.jsonl` | Cada override de permission con TTL + revocación. |
| `.pipeline/audit/agent-models-backups/<ISO-ts>.json` | Backup pre-save del JSON antes de cada PUT (retención 30). |

Verificar integridad de la chain:

```bash
node -e "console.log(JSON.stringify(require('./.pipeline/lib/audit-log').verifyChain('./.pipeline/audit/api-key-rotations.jsonl')))"
```

Output esperado:

```json
{"ok":true,"entriesChecked":42}
```

Si la chain está rota:

```json
{"ok":false,"entriesChecked":12,"brokenAt":12,"reason":"hash_prev mismatch: esperaba 'abc123…' pero la entry trae 'def456…'"}
```

→ alerta de tampering, investigar forensicamente.

### 5.3 Cuando un proveedor se queda sin cuota

El **quota-detector cross-provider** ([`.pipeline/lib/quota-exhausted.js`](../../.pipeline/lib/quota-exhausted.js), [#3077](https://github.com/intrale/platform/issues/3077)):

1. Observa el log stream del child (stream-json / SSE según provider).
2. Matchea `error.type` contra los `quota_error_types` del bloque del provider en `agent-models.json`.
3. Cross-valida contra `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER` ([#3077](https://github.com/intrale/platform/issues/3077) SEC-2).
4. Persiste flag JSON en `.pipeline/quota-exhausted.json`:

   ```json
   {
     "exhausted": true,
     "provider": "anthropic",
     "model": "claude-opus-4-7",
     "resets_at": "2026-05-15T00:00:00.000Z",
     "detected_at": "2026-05-14T19:09:16.123Z",
     "pattern_matched": "usage_limit_error"
   }
   ```

5. El pulpo consulta `shouldGateSpawn(skill, { provider })` antes de cada spawn LLM.
6. **Scope per-provider** ([#3077](https://github.com/intrale/platform/issues/3077) SEC-1): si el flag activo es del provider X y un skill corre con provider Y, el spawn pasa. **Cuando Anthropic se agota, los skills configurados con OpenAI siguen corriendo.**
7. Cuando `Date.now() > resets_at`, la lectura defensiva devuelve `exhausted: false` y el módulo borra el flag (drenado natural).

**Kill-switch operacional** (si por bug el flag queda persistente):

```bash
rm .pipeline/quota-exhausted.json
```

→ desbloquea el pipeline en el spawn siguiente. Documentar el motivo en commit / Telegram.

### 5.4 Métricas expuestas

| Métrica | Archivo | Cómo verla |
|---------|---------|------------|
| Quota usage % por provider | `.pipeline/metrics-history.jsonl` | Dashboard tab "Métricas" o `lib/weekly-quota.js` CLI |
| Costo estimado por skill | `.pipeline/metrics/cost-by-skill.json` | Dashboard tab "Cost Tracker" ([#1244](https://github.com/intrale/platform/issues/1244)) |
| Switches automáticos cross-modelo | `.pipeline/audit/model-switches.jsonl` ([#3068](https://github.com/intrale/platform/issues/3068)) | `cat .pipeline/audit/model-switches.jsonl \| jq '.'` |
| Eventos cross-provider | `.pipeline/logs/quota-detector-*.log` | `grep "provider" -r .pipeline/logs/quota-detector-*` |

Endpoint REST del dashboard:

```bash
curl http://localhost:8080/api/metrics/quota | jq '.'
```

### 5.5 Diagnóstico de errores frecuentes

| Síntoma | Causa probable | Acción |
|---------|----------------|--------|
| Boot del pulpo aborta con `INVALID_CONFIG` | Schema inválido | Correr `node .pipeline/validate-agent-models.js` — leer mensaje `path` + `fix:`. |
| Boot del pulpo aborta con `TOOLCHAIN_MISSING` | `ajv` no instalado | `npm install ajv@^8` desde la raíz del repo. |
| Boot del pulpo aborta con "credenciales faltantes" | Env var de credencial no exportada | Verificar `~/.claude/secrets/telegram-config.json` + rerun. |
| Spawn de skill devuelve "Provider desconocido" | `skills.<x>.provider` apunta a un nombre fuera de `PROVIDER_HANDLERS` | Cambiar a `anthropic`, `openai-codex` o `deterministic`. |
| Skill con `provider: 'openai-codex'` lanza "no implementado" | Stub aún no completado por [#3076](https://github.com/intrale/platform/issues/3076) | Cambiar temporal a `anthropic` o esperar entrega. |
| Dashboard devuelve 403 `missing_csrf_token` en PUT | Cliente no pidió `/api/multi-provider/csrf-token` antes | Verificar fetch del cliente, el token vive 4h. |
| Dashboard devuelve 403 `csrf_mismatch` | Header `X-CSRF-Token` no matchea cookie `mp_csrf` | Recargar la página para sincronizar token + cookie. |
| `quota_error_types` rechazado al boot | Item fuera de `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER` | Quitar el `error_type` o agregarlo a la meta-allowlist (decisión de seguridad, requiere PR review). |
| Catálogo de modelos vacío en el dashboard | `CATALOG_VERSION` cambió y el front cacheó | Forzar reload (Ctrl+F5) — el endpoint `/api/multi-provider/catalog` no se cachea pero el client sí. |

---

## 6. Referencia rápida

### 6.1 Tabla resumen: skills → provider → modelo (al 2026-05-14)

| Skill | Provider | Modelo efectivo | Tipo |
|-------|----------|-----------------|------|
| guru | anthropic | claude-opus-4-7 | LLM |
| security | anthropic | claude-opus-4-7 | LLM |
| po | anthropic | claude-opus-4-7 | LLM |
| ux | anthropic | claude-opus-4-7 | LLM |
| planner | anthropic | claude-opus-4-7 | LLM |
| review | anthropic | claude-opus-4-7 | LLM |
| refinar | anthropic | claude-opus-4-7 | LLM |
| backend-dev | anthropic | claude-opus-4-7 | LLM |
| android-dev | anthropic | claude-opus-4-7 | LLM |
| web-dev | anthropic | claude-opus-4-7 | LLM |
| pipeline-dev | anthropic | claude-opus-4-7 | LLM |
| qa | anthropic | claude-opus-4-7 | LLM |
| tester | deterministic | — | Node puro |
| build | deterministic | — | Node puro |
| linter | deterministic | — | Node puro |
| delivery | deterministic | — | Node puro |

> **Verificar el estado canónico:** `cat .pipeline/agent-models.json` o **Tab "2 · Por agente"** del dashboard.

### 6.2 Diagrama del flujo de dispatch

```
                ┌──────────────────────────────────────────────────────┐
                │ pulpo.js detecta archivo en pendiente/               │
                │  → mueve a trabajando/                               │
                │  → identifica skill por nombre del archivo           │
                └────────────────────┬─────────────────────────────────┘
                                     │
                                     ▼
                ┌──────────────────────────────────────────────────────┐
                │ resolveProviderForSkill(skill, { pipelineDir })      │
                │                                                      │
                │  1. ¿skill ∈ DETERMINISTIC_SKILLS?                   │
                │     → SÍ: provider='deterministic'                   │
                │                                                      │
                │  2. Lectura defensiva de agent-models.json           │
                │     ↳ archivo no existe / parse error                │
                │        → provider='anthropic', model=legacy          │
                │                                                      │
                │  3. skills.<skill>.provider                          │
                │     ↳ no declarado → fallback 'anthropic'            │
                │     ↳ declarado    → lookup en PROVIDER_HANDLERS     │
                │                                                      │
                │  Output: { provider, model, handler, mode, source }  │
                └────────────────────┬─────────────────────────────────┘
                                     │
                                     ▼
                ┌──────────────────────────────────────────────────────┐
                │ shouldGateSpawn(skill, { provider })                 │
                │                                                      │
                │  ↳ flag activo de OTRO provider → pasa               │
                │  ↳ flag activo de ESTE provider → gate, no spawn     │
                │  ↳ sin flag                     → pasa               │
                └────────────────────┬─────────────────────────────────┘
                                     │
                                     ▼
                ┌──────────────────────────────────────────────────────┐
                │ handler.buildSpawn({                                 │
                │   user_prompt, system_file, model, ...               │
                │ })                                                   │
                │                                                      │
                │  Expansión 1:1 de spawn_args_template                │
                │  Filtrado de env por SYSTEM_ALLOWLIST                │
                │  Inyección de la credencial del provider del skill   │
                └────────────────────┬─────────────────────────────────┘
                                     │
                                     ▼
                          ┌───────────────────┐
                          │ child_process.    │
                          │   spawn(...)      │
                          └─────────┬─────────┘
                                    │
                                    ▼
                ┌──────────────────────────────────────────────────────┐
                │ Loop de eventos del child:                           │
                │  • output_parser normaliza tokens/usage              │
                │  • detector de cuota chequea error.type              │
                │  • traceability registra (provider, model,           │
                │    cli_version, git_sha)                             │
                │  • watchdog mata si heartbeat se pierde              │
                └────────────────────┬─────────────────────────────────┘
                                     │
                                     ▼
                ┌──────────────────────────────────────────────────────┐
                │ on-exit: pulpo mueve trabajando/ → listo/            │
                │  → próxima fase evalúa resultado YAML                │
                └──────────────────────────────────────────────────────┘
```

### 6.3 Atajos de comandos

```bash
# Validar config
node .pipeline/validate-agent-models.js

# Levantar dashboard
node .pipeline/dashboard.js

# Restart del pipeline (post cambio de config)
node .pipeline/restart.js

# Verificar chain de audit
node -e "console.log(JSON.stringify(require('./.pipeline/lib/audit-log').verifyChain('./.pipeline/audit/api-key-rotations.jsonl')))"

# Desbloquear flag de cuota colgado
rm .pipeline/quota-exhausted.json && node .pipeline/restart.js

# Backup manual de secrets
cp ~/.claude/secrets/telegram-config.json ~/.claude/secrets/backups/telegram-config.$(date -u +%Y%m%dT%H%M%SZ).json
```

---

## 7. Security considerations

> **Esta sección es obligatoria.** Sin estos controles, un operador puede rotar una key mal, deshabilitar CSRF por desconocimiento, asumir un failover que no existe, o exfiltrar la key del provider equivocado. Los gates de seguridad ya están **implementados** en código — esta sección documenta su existencia para que la operación no los degrade.

### 7.1 Gestión de API keys

- **Almacenamiento canónico:** `~/.claude/secrets/telegram-config.json`. **Nunca en el repo, nunca commiteado.** Cualquier `git status` que muestre este archivo es una alerta — debería estar fuera del worktree.
- **`GET /api/multi-provider/keys` nunca devuelve el valor completo** — solo `status` (`present` / `absent` / `placeholder`), `masked` preview (primeros 6 + últimos 4) y `fingerprint` SHA-256 (primeros 16 chars). Esto se verifica server-side; cualquier client que muestre la key completa significa que la API se rompió.
- **`POST /api/multi-provider/keys/:provider` rota** con write atómico + backup pre-save en `~/.claude/secrets/backups/` (retención 30).
- **Permisos en disco `0600`** — solo el usuario que corre el pulpo lo puede leer. En Windows es best-effort (la API `setFileSecurity` no es trivial sin nativos).
- **Patrón de revocación sin borrar:** valores `REVOKED|PLACEHOLDER|MOVED|EXAMPLE|REPLACE|CHANGE_ME` (case-insensitive) son detectados como placeholder. El operador puede invalidar una key dejando trazabilidad sin remover el campo.
- **Anthropic key NO se rota por UI.** El input está deshabilitado (`editable: false`) porque Claude Code usa OAuth/MAX login, no API key. Si la doc te sugiere lo contrario, hay un bug — abrir issue.

### 7.2 CSRF + DNS rebinding mitigation

Los endpoints mutating del dashboard (`POST`, `PUT`, `DELETE` bajo `/api/multi-provider/`) usan **double-submit cookie**:

1. Cliente pide `GET /api/multi-provider/csrf-token`.
2. Server devuelve `{ csrf_token }` y setea cookie `mp_csrf=<token>; SameSite=Strict; Path=/api/multi-provider`.
3. En cada PUT/POST/DELETE, el cliente envía header `X-CSRF-Token: <token>` leído de la cookie.
4. Server compara header vs cookie. Si NO matchean → 403.

**Por qué mitiga DNS rebinding:** un atacante que apunta DNS de `attacker.com` a `127.0.0.1` puede invocar el dashboard desde el browser de la víctima, pero **no puede leer la cookie** de un origen distinto (Same-Origin Policy del browser). Sin cookie no hay header → 403.

**Atributos del token:** per-process, TTL 4h, rotación natural en cada restart del pulpo.

> **NO deshabilites CSRF** "porque molesta para automatizar scripts". Si necesitás automatización contra el dashboard, pedí el token primero con `curl` y reusalo con header + cookie. Sin CSRF el dashboard queda expuesto a cross-origin desde el browser de cualquier víctima en la misma red local.

### 7.3 Audit trail

| Evento | Archivo | Campos | Verificación |
|--------|---------|--------|--------------|
| Cuota agotada detectada | `.pipeline/logs/quota-detector-<YYYY-MM-DD>.log` | `ts, provider, model, pattern_matched, resets_at, raw_excerpt` | `tail -n 100 .pipeline/logs/quota-detector-*.log` |
| API key rotation | `.pipeline/audit/api-key-rotations.jsonl` | `type, provider, jsonField, fingerprint, autor, created_at, hash_prev, hash_self` | `node -e "console.log(JSON.stringify(require('./.pipeline/lib/audit-log').verifyChain('./.pipeline/audit/api-key-rotations.jsonl')))"` |
| Permission override creado / revocado | `.pipeline/audit/permission-overrides.jsonl` | `type, skill, provider, mode_requerido, mode_otorgado, capabilities_diff, justificacion, ttl_horas, autor, hash_prev, hash_self` | mismo comando contra ese archivo |
| Switch de provider/model en runtime | `.pipeline/audit/model-switches.jsonl` ([#3068](https://github.com/intrale/platform/issues/3068)) | `provider, model, cli_version, git_sha, motivo` | mismo comando |

**Sanitización obligatoria:** el campo `raw_excerpt` del quota-detector pasa por [`.pipeline/lib/redact.js`](../../.pipeline/lib/redact.js) antes de escribirse (CA-11 de [#3077](https://github.com/intrale/platform/issues/3077)) — sin esto, una key del provider podría filtrarse al log.

**Retención:** los `.jsonl` son **append-only**. Para rotar / archivar, mover el archivo + arrancar nueva chain con `GENESIS`. Documentar el motivo en commit.

### 7.4 Threat model del dashboard

- **Default: local-only.** El dashboard escucha en `127.0.0.1:8080`. CSRF asume Same-Origin Policy del browser — válido para acceso local.
- **Si se expone a LAN/Internet** (NO hagas esto sin checklist):
  - Reverse proxy con autenticación (basic auth + TLS).
  - IP allowlist en el proxy.
  - WAF que filtre headers maliciosos.
  - Revisar `secrets-rw.js` masking para asegurar que no haya endpoint que devuelva keys completas.
- **Quien accede al filesystem donde viven las keys** (`~/.claude/secrets/`) **= quien tiene acceso efectivo a TODOS los providers**. No hay encriptación at-rest — el control es el control del usuario del SO.

### 7.5 Fallbacks: estado real vs aspiracional

| Funcionalidad | Soportado en schema | Soportado en UI | Consumido en runtime |
|---------------|:-------------------:|:---------------:|:--------------------:|
| Declarar `fallbacks[]` por skill | ✅ | ✅ | ✅ |
| Validación cruzada de items contra `providers` | ✅ | ✅ | n/a |
| Failover automático cross-provider en cuota agotada | ✅ | ✅ | ✅ |

**Lectura para operadores:** desde [#3198](https://github.com/intrale/platform/issues/3198) (mergeado 2026-05-15), declarar `fallbacks[]` en `agent-models.json` **sí dispara failover automático** cuando el provider primario está gated. La continuidad de servicio efectiva proviene de tres mecanismos complementarios:

- **Scope per-provider del quota-detector** ([#3077](https://github.com/intrale/platform/issues/3077) SEC-1): si Anthropic se agota, los skills con `provider: 'openai-codex'` siguen corriendo sin necesidad de cambiar nada.
- **Consumer runtime de fallbacks** (#3198): para skills cuyo primary está gated, el dispatcher itera `skills.<x>.fallbacks[]` en orden y spawnea con el primer candidato disponible. Caps `MAX_FALLBACK_DEPTH=5` + anti-cycle + audit log con hash-chain + notificación Telegram post-hoc.
- **Cambio manual del operador**: editar `agent-models.json` reasignando primaries críticos sigue disponible como override explícito.

Caveat: declarar `fallbacks[]` no es magia. Si toda la chain (primary + fallbacks) está gated en simultáneo, el archivo cae a `pendiente/` esperando reset — sin failover infinito.

Implementado por: [#3198](https://github.com/intrale/platform/issues/3198) (consumer runtime de fallbacks). Detalle operativo: [`docs/pipeline-multi-provider.md`](../pipeline-multi-provider.md) §3.9.

### 7.6 Reglas inquebrantables para los ejemplos de esta doc

- **NUNCA** incluir API keys reales en ejemplos. Siempre placeholders: `sk-ant-PLACEHOLDER`, `sk-proj-XXXXX`.
- **NUNCA** incluir fingerprints SHA-256 reales (facilitan matching contra dumps filtrados).
- **NUNCA** incluir paths absolutos de prod si la doc se publica externamente.
- **Capturas del dashboard** deben tomarse con keys placeholder activas — verificar en el screenshot que la masked preview muestra placeholder o key sintética.
- **Pegar JSON con valores reales** en issues, PRs o comentarios públicos viola estas reglas — usar la masked preview o fingerprint.

### 7.7 Glosario de issues de hardening relacionados

| Issue | Aporte de seguridad |
|-------|----------------------|
| [#3072](https://github.com/intrale/platform/issues/3072) (H1) | `agent-models.json` canónico + schema. |
| [#3074](https://github.com/intrale/platform/issues/3074) (H2) | `resolve-provider.js` con tabla hardcoded (defensa path-traversal). |
| [#3077](https://github.com/intrale/platform/issues/3077) (H5) | Quota-detector cross-provider con scope per-provider + redact. |
| [#3080](https://github.com/intrale/platform/issues/3080) (S1) | Inventario y rotación de credenciales + denylist de secrets hardcoded. |
| [#3081](https://github.com/intrale/platform/issues/3081) (S3) | Sandboxing del JSON + allowlists hardcoded compartidas con el pre-commit hook. |
| [#3082](https://github.com/intrale/platform/issues/3082) (S4) | Matriz capability×(provider, mode) + permission overrides con TTL. |
| [#3084](https://github.com/intrale/platform/issues/3084) (S6) | Verificación de firma/integridad de inputs (data-residency). |
| [#3171](https://github.com/intrale/platform/issues/3171) (S5) | Audit trail dinámico con `cli_version` + `git_sha`. |
| [#3187](https://github.com/intrale/platform/issues/3187) (S4 b) | Permission mapping cross-provider + tests de paridad. |

---

## 8. Hardening de free providers (#3260)

Los providers free (Groq, Gemini-Google, Cerebras, NVIDIA-NIM cuando mergee #3243) son la **red de salvataje** del pipeline cuando se agota la cuota de Claude / Codex. El issue [#3260](https://github.com/intrale/platform/issues/3260) (ola N+5) endurece esa red con healthchecks periódicos, validación semanal de keys, panel "Health" del dashboard, alertas Telegram con dedupe + back-off, y este procedimiento operativo.

### 8.1 Free tier real por provider

> **Fuente:** documentación oficial verificada al 2026-05-17. Si un provider cambia los límites, actualizar acá y bumpear la nota en `secrets-rw.js#MANAGED_KEYS[].free_tier_notes`.

| Provider | RPM | RPD | Tokens/día | Endpoint usado en healthcheck | Notas |
|----------|----:|----:|-----------:|--------------------------------|-------|
| `groq` | 30 | 14400 | depende del modelo (~500K) | `GET https://api.groq.com/openai/v1/models` | Body 401/403 sin detalle propietario. 429 con `insufficient_quota` ⇒ `quota_exhausted`. |
| `gemini-google` | 15 | 1500 | 1M tokens | `GET https://generativelanguage.googleapis.com/v1beta/models` | Auth con header `x-goog-api-key` (la key NUNCA en query string — `key` ya está en `SENSITIVE_QUERY_KEYS`). 400 con `API_KEY_INVALID` ⇒ `invalid_credentials`. |
| `cerebras` | 30 | sin cap docu | ~60K tokens/min | `GET https://api.cerebras.ai/v1/models` | Free tier sólo modelos llama-* (sin Mistral). 429 con `insufficient` ⇒ `quota_exhausted`. |
| `nvidia-nim` | TBD | TBD | TBD | TBD (sumar cuando mergee #3243) | Card "muted" en el panel Health hasta que el provider esté declarado. |

Cron de healthchecks: cada 15min × 4 providers = **384 requests/día por provider**, holgadamente dentro de cualquier free tier conocido. La validación semanal de keys (CA-2) reusa el mismo endpoint `/models` (no consume cuota).

### 8.2 Rotar una API key sin downtime (CA-5)

**El único método soportado** es la UI del dashboard o el endpoint `secrets.rotateKey()`. **Prohibido** editar `~/.claude/secrets/telegram-config.json` a mano (race condition + sin audit + sin backup atómico).

Procedimiento:

1. **Generar la nueva key en el portal del provider** (Groq Console / Google AI Studio / Cerebras dashboard). NO revocar la vieja todavía.
2. **Rotar vía UI del dashboard:**
   - Abrir `http://localhost:8080/dashboard.html#multi-provider`.
   - Tab **1 · Proveedores** → click "Rotar key" en el provider afectado.
   - Pegar la nueva key. Confirmar.
   - El backend hace: backup atómico en `~/.claude/secrets/backups/`, write atómico 0600, audit entry en `audit/api-key-rotations.jsonl` (hash chain).
3. **Verificar con live-ping desde la UI** — botón "Ping" en la fila del provider. Status `authenticated` significa key nueva válida.
4. **Recién entonces revocar la key vieja en el portal del provider** (out-of-band — `secrets-rw.js` no puede hacer esto por vos, cada provider tiene su propio mecanismo). Si la revocás antes de validar la nueva con live-ping, te quedás sin failover hasta el próximo restart del pulpo.

**Si fallás el live-ping post-rotación:**

- Revisar el backup: `~/.claude/secrets/backups/telegram-config.<TS>.json` (último archivo).
- Recuperar la key vieja manualmente y re-rotarla por la UI.
- El pulpo cachea las keys al boot; restart con `node .pipeline/restart.js` si la rotación inicial dejó env vars rotas.

### 8.3 Recuperación cuando 2+ free providers caen en simultáneo (CA-5)

El cron emite alerta Telegram `Multi-Down` cuando 3+ free providers están en rojo simultáneamente. Procedimiento de respuesta:

1. **Abrir el dashboard, tab "5 · Health"** — confirmar qué providers están rojos y con qué `reason_code`.
2. **Diferenciar la causa**:
   - `invalid_credentials` / `forbidden`: problema de key — verificar el portal del provider, posiblemente cambió la policy o se vencen las keys del free tier. Rotar (sección 8.2).
   - `quota_exhausted`: hit del límite diario — verificar contador en cada portal; esperar reset o agregar pago al provider.
   - `rate_limited`: throttling temporal — los siguientes ticks deberían volver a verde solos. Si persiste >1h, aumentar jitter o investigar tráfico anómalo.
   - `network_error` / `timeout`: conectividad — `ping`/`traceroute` a los hosts y revisar firewall.
3. **Si el pipeline está caído por exhausted (Claude + Codex también)**: verificar que al menos UN free provider esté verde. Si todos rojos, el pulpo encola en `pendiente/` esperando reset; no hay "fallback al fallback" implementado en esta historia.
4. **Audit log**: las transiciones quedan registradas en `audit/multi-provider-health.jsonl` (hash chain). `node .pipeline/lib/audit-log.js verify <file>` valida la integridad.

### 8.4 Panel "Health" del dashboard

- **URL**: `http://localhost:8080/dashboard.html#multi-provider` → tab **5 · Health**.
- **Datos**: read-only del snapshot persistido (`state/multi-provider-health.json`). NO dispara pings sintéticos al abrir.
- **KPIs**: contadores verdes / amarillos / rojos.
- **Por provider**: estado, reason code, latencia, rate-limit-hit últimas 24h, status de la key, timestamp del último check.
- **Botón "Forzar tick"**: dispara `POST /api/multi-provider/health/run` (con CSRF). Útil para diagnóstico inmediato post-rotación. Respeta el lock — si otro proceso está corriendo el cron, devuelve `skipped`.

### 8.5 Alertas Telegram (CA-4 / SR-4 / SR-5)

El cron emite a Telegram cuando:

- Un provider entra en estado **rojo** y permanece >10 min (dedup window).
- **3+ free providers** están en rojo simultáneamente (Multi-Down).
- Una API key responde **401 / 403** (transición a `invalid_credentials`).

Garantías:

- **Payload metadata-only**: `{ provider, state, reason_code, observed_at }`. Nunca incluye API key, fingerprint, masked, body excerpt, headers ni stack trace con paths.
- **Dedupe 10 min**: misma combinación `provider+state` no se reenvía dentro de la ventana.
- **Back-off exponencial**: si el estado rojo persiste, alertas cada 30 / 60 / 120 / 240 min (cap 4h) — sin flood.
- **Persistencia del dedupe**: `~/.claude/secrets/telegram-alerts-dedup.json` (0600). Sobrevive restarts del pulpo.

Para silenciar todas las alertas durante una maintenance window: borrar el archivo `.../telegram-alerts-dedup.json` y crearlo con `{ "alerts": { "__SUPPRESSED_UNTIL__": <unix-ms> } }` no es soportado todavía — la solución actual es cortar el bot de Telegram. Ver issue de mejora si esto se vuelve recurrente.

### 8.6 Comandos útiles

```bash
# Forzar un healthcheck inmediato (sin esperar al cron):
node .pipeline/lib/multi-provider/health-cron.js

# Inspeccionar el snapshot actual:
cat .pipeline/state/multi-provider-health.json | jq .

# Verificar la integridad del audit log:
node -e "console.log(require('./.pipeline/lib/audit-log').verifyChain('.pipeline/audit/multi-provider-health.jsonl'))"

# Inspeccionar dedupe de alertas (qué pares provider+state están suprimidos):
cat ~/.claude/secrets/telegram-alerts-dedup.json | jq .

# Listar providers gestionados + free tier notes:
node -e "console.log(JSON.stringify(require('./.pipeline/lib/multi-provider/secrets-rw').listKeys(), null, 2))"
```

### 8.7 Anti-patrones a evitar

- ❌ **Editar `telegram-config.json` con `vi`** durante rotación → race con writes del pulpo, sin backup, sin audit. Siempre usar la UI o `secrets.rotateKey()`.
- ❌ **Pasar Gemini key como `?key=AIza…`** en URLs → aunque está en `SENSITIVE_QUERY_KEYS` para defense-in-depth, el header `x-goog-api-key` es el camino correcto (lo que el pipeline hace internamente).
- ❌ **Revocar la key vieja antes de validar la nueva con live-ping** → te quedás sin failover hasta restart.
- ❌ **Pingear endpoints de completion en el healthcheck** → consumen cuota. El cron usa solo `/v1/models` (o equivalente).
- ❌ **Bypassar el lock del cron** corriendo `runOnce` desde múltiples procesos → puede disparar abuse-detection del provider. El lock está ahí por una razón.

### 8.8 Procedimiento seguro para pasar API keys vía Telegram (#3310)

> **Contexto:** el 2026-05-17 una API key de Groq se filtró al disco del pulpo porque se pegó en plaintext en el chat de Telegram. El listener escribía el texto crudo en `commander-session.json`, `commander-history.jsonl` y `servicios/commander/pendiente/*.json` sin redacción. Issue [#3310](https://github.com/intrale/platform/issues/3310) cierra el flanco con sanitización en write-time (`sanitizer.sanitize()` aplicado antes de cualquier `appendFileSync`/`writeFileSync` de input externo) más un pre-commit hook como red de seguridad para evitar que el estado interno del pipeline llegue al repo.
>
> **Pero la regla operativa sigue siendo la primaria:** nunca pegues una key en el chat aunque el sanitizer esté activo. Es defensa en profundidad — la única forma robusta es no exponer el secreto al canal en primer lugar.

#### 8.8.1 Procedimiento recomendado

1. Generá / obtené la API key en el portal del provider (Groq Console, Google AI Studio, Cerebras dashboard, NVIDIA build.nvidia.com, etc.).
2. **Guardá la key en un archivo local** bajo `~/.claude/secrets/` (fuera del repo):
   ```bash
   # Ejemplo: agregar GROQ key
   mkdir -p ~/.claude/secrets
   printf '%s' '<la-key>' > ~/.claude/secrets/groq.txt
   chmod 600 ~/.claude/secrets/groq.txt
   ```
3. **Por Telegram, mandá únicamente el path absoluto**, ej:
   ```
   actualizar groq key, está en ~/.claude/secrets/groq.txt
   ```
4. El commander (cuando se cablee `8.8.2`) leerá el archivo desde disco, validará el path contra la whitelist, hará la rotación vía `secrets.rotateKey()` y devolverá confirmación. La key nunca toca el canal.

> **Regla inquebrantable:** aunque el sanitizer redacte un paste accidental, **nunca** pegues el contenido literal de una key en el chat — ni en mensaje de texto, ni como caption de foto, ni como nota de voz transcrita. El audit log archiva mensajes 24h y backups del pulpo viven 7 días.

#### 8.8.2 Validación del path (defensa contra path traversal)

Cuando se implemente el handler que lee el archivo apuntado por el mensaje (issue de seguimiento), DEBE aplicar las siguientes verificaciones **antes** de cualquier `fs.readFileSync`:

| Check | Implementación |
|-------|----------------|
| Canonicalización | `path.resolve(input)` para resolver `..`, `./`, alias del shell. NUNCA usar el path crudo del mensaje. |
| Whitelist de directorios | El path resuelto DEBE comenzar con `path.resolve(os.homedir(), '.claude', 'secrets') + path.sep`. Cualquier otro prefijo → rechazo. |
| Tipo de archivo | `fs.statSync(p).isFile()` + tamaño máximo razonable (ej. 4KB — las keys son <500 bytes; cualquier cosa más grande es sospechoso). |
| Permisos | Opcional: validar que el archivo sea `0600` o más restrictivo. Warning si está demasiado abierto, pero no bloquea. |
| Rechazo loggeable | Si el path no pasa la whitelist, logguear el intento **pasando el path por `sanitize()` antes** (el path malicioso podría contener un secreto disfrazado de path). Mensaje al usuario en español natural: *"ese path no está permitido, usá uno bajo `~/.claude/secrets/`"*. |

Patrón de referencia:

```js
const path = require('path');
const os = require('os');
const fs = require('fs');
const { sanitize } = require('.pipeline/sanitizer');

const SECRETS_ROOT = path.resolve(os.homedir(), '.claude', 'secrets');

function readSecretFromPath(rawPath) {
  const resolved = path.resolve(rawPath);
  if (!resolved.startsWith(SECRETS_ROOT + path.sep)) {
    // Path traversal o whitelist mismatch — logueamos sanitizando.
    log('commander', `Rechazo path fuera de whitelist: ${sanitize(resolved)}`);
    throw new Error(`Path no autorizado: usá uno bajo ${SECRETS_ROOT}`);
  }
  const st = fs.statSync(resolved);
  if (!st.isFile()) throw new Error('El path apunta a algo que no es un archivo regular');
  if (st.size > 4096) throw new Error('Archivo demasiado grande para ser una API key');
  return fs.readFileSync(resolved, 'utf8').trim();
}
```

> **Defensa en profundidad adicional:** el listener ya sanitiza el `msg.text` antes de escribir a disco (#3310 CA-1), así que aunque el path malicioso contenga un secreto pegado al lado (`/etc/passwd gsk_<52 chars>`), el secret se redacta antes del log. La validación de path traversal protege el flanco distinto de "exfiltrar contenido arbitrario del filesystem leyendo archivos fuera de la whitelist".

#### 8.8.3 Lista de archivos NO commiteables (CA-5 — defensa final)

El pre-commit hook (`.husky/pre-commit` + `.pipeline/lib/precommit-secret-scan.js`) bloquea automáticamente commits que toquen estos paths con contenido que matchee un patrón de credencial:

- `.pipeline/commander-session.json`
- `.pipeline/commander-history.jsonl`
- `.pipeline/servicios/**/*.json`

Estos archivos ya están en `.gitignore`. Si te encontrás des-ignorándolos a propósito, asumí que estás cometiendo un error — el hook va a bloquearte. Si es legítimo (ej. fixture sintético sin secrets reales), el hook tolera el commit porque el sanitizer no encuentra patrones para redactar.

#### 8.8.4 Si la key ya se filtró

Si por error pegaste una key directamente en el chat:

1. **Revocá la key inmediatamente en el portal del provider** (Groq Console → Settings → API Keys → Delete). El sanitizer/redactor cubre el flanco a futuro, pero la key vieja sigue siendo válida hasta que la revoques upstream.
2. **Generá una nueva** y seguila el procedimiento §8.8.1.
3. **Verificá los archivos que vivieron mientras la key estaba expuesta**:
   ```bash
   grep -r "<prefijo de la key, p.ej. gsk_>" .pipeline/ 2>/dev/null | head
   ```
   Si aparece, sabés que el incidente queda registrado y sirve para correlación.
4. **Issue de scrubbing retroactivo**: si querés limpiar el historial existente, ver [#3317](https://github.com/intrale/platform/issues/3317) (necesita aprobación humana, `needs-human`).

---

## 9. Modo degradado del Commander (sin LLM)

> **Issue origen:** [#3253](https://github.com/intrale/platform/issues/3253) (path **(a)** — modo degradado).
> **Builds upon:** [#3257](https://github.com/intrale/platform/issues/3257) (commander determinístico — separar status/listado/snapshot del flujo LLM).
> **Documentos relacionados:** [`docs/pipeline/resiliencia-cuota-claude.md`](./resiliencia-cuota-claude.md) (spike #3251 que detectó el SPoF).

El Telegram Commander es el **único canal humano↔pipeline** mientras el pulpo corre. Originalmente `ejecutarClaude` era el camino obligatorio para resolver cualquier mensaje del chat → si Claude caía, el operador perdía `/status`, `/ghostbusters`, `/restart` y todo control remoto en plena ventana de outage.

El modo degradado garantiza que un set de comandos críticos **NUNCA pasa por el LLM**: viven en `.pipeline/lib/commander-deterministic.js` y resuelven con lectura de filesystem + render de plantilla MarkdownV2. Es la red de seguridad para diagnosticar y corregir el pipeline cuando Claude está caído.

### 9.1 Comandos disponibles sin LLM

El router `commander-deterministic.js` (función `classify`) usa **allowlist explícita** en `DETERMINISTIC_SLASH`. Los siguientes comandos jamás invocan a Claude:

| Comando | Qué hace | Handler |
|---------|----------|---------|
| `/status` | Tablero completo del pipeline | `cmdStatus` (pulpo.js, legacy) |
| `/quota` | Estado del flag de cuota Claude (read-only, ver §9.2) | `buildDefaultHandlers.quota` (#3253) |
| `/snapshot` | Snapshot de la ola actual | `buildDefaultHandlers.snapshot` |
| `/listado [filtro]` | Issues por fase del pipeline | `buildDefaultHandlers.listado` |
| `/allowlist` | Pausa parcial actual | `buildDefaultHandlers.allowlist` |
| `/tail <archivo>` | Últimas 30 líneas de un log permitido (allowlist) | `buildDefaultHandlers.tail` |
| `/dashboard-up` / `/dashboard-down` | Levantar / bajar el dashboard | `buildDefaultHandlers.dashboard-*` |
| `/salud` | Health del pulpo (lock + last tick + errores) | `buildDefaultHandlers.salud` |
| `/procesos` | Procesos Node activos del pipeline | `buildDefaultHandlers.procesos` |
| `/descanso` | Ventana de modo descanso | `buildDefaultHandlers.descanso` |
| `/actividad`, `/ghostbusters`, `/pausar`, `/reanudar`, `/pause-partial`, `/costos`, `/limpiar`, `/restart`, `/bloqueados`, `/unblock`, `/help`, `/start`, `/stop` | Handlers legacy en `pulpo.js` (switch case) | `cmdXxx` |

> **Regla:** todo comando en `DETERMINISTIC_SLASH` se resuelve sin spawn de Claude. El router devuelve `delegated_to_llm` SOLO para texto libre y para los dos comandos del set `LLM_SLASH` (`/intake`, `/proponer`).

### 9.2 `/quota` (read-only)

Lee `.pipeline/quota-exhausted.json` y muestra un resumen con campos **whitelisteados**:

```
🔴 Claude · cuota agotada

Provider:  anthropic
Desde:     hace 47m 12s (2026-05-17T03:45:12.000Z)
Resetea:   en 13m (2026-05-17T05:45:12.000Z)
Motivo:    usage_limit_error

━━━━━━━━━━━━━━━━━━━━

Comandos disponibles sin LLM:
/status · /ghostbusters · /restart · /pausar · /quota · /help
```

**Garantías de seguridad** (CA-S1, CA-S2 del issue):

- **Read-only.** Cualquier argumento (`clear`, `reset`, `delete`, `force`, etc.) se rechaza con `invalid_args` en `ARG_SCHEMAS.quota.allow()` *antes* de llegar al handler. El archivo nunca se modifica desde Telegram.
- **Whitelist estricta** de campos: `provider`, `pattern_matched` (renombrado a `reason-kind`), `detected_at`, `resets_at`. Nunca emite el JSON crudo, paths absolutos, ni metadata interna del flag.
- **JSON corrupto → safe-default:** si el archivo no parsea, responde "cuota disponible" sin echo del contenido raw.

Para destrabar el flag manualmente (operación de consola, NO disponible desde Telegram):

```bash
rm .pipeline/quota-exhausted.json
```

### 9.3 Cooldown destructivo (60s)

Los comandos potencialmente costosos están protegidos por un **cooldown ≥ 60s por chat × comando** (módulo `lib/commander/destructive-cooldown.js`). Mitiga:

- Pulsado accidental doble en mobile (Telegram en android no diferencia bien tap simple vs doble).
- Loops upstream que disparan `/restart` repetido y dejan el pulpo en estado inconsistente.
- Operador en pánico martillando `/ghostbusters`.

**Comandos en cooldown por default:**

| Comando | Default cooldown |
|---------|-----------------|
| `/restart` | 60s |
| `/limpiar` | 60s |
| `/ghostbusters` | 60s |
| `/reset` (reservado a futuro) | 60s |

**Diferencia con el rate-limit token-bucket** (`lib/commander/rate-limit.js`, CA-11 #3257):

| | Rate limit | Cooldown destructivo |
|--|------------|---------------------|
| **Granularidad** | Por chat_id | Por (chat_id, command) |
| **Modelo** | Token bucket (10 burst, 30/min) | Ventana fija de 60s |
| **Aplica a** | TODOS los comandos determinísticos | SOLO comandos destructivos |
| **Mensaje** | "Calma, pibe — esperá un toque" | "⏳ /restart en cooldown. Reintentar en Xs." |

El cooldown corre **después** del rate-limit, no en lugar de.

### 9.4 Gate de cuota para texto libre (anti-prompt-injection)

Cuando `quotaNotifier.getState().active === true` y llega un mensaje libre (texto largo o slash-command desconocido), el commander responde con texto canned literal **sin interpolar el input del usuario**. Esto cierra el vector de prompt-injection vía mensajes del chat (un atacante con acceso al bot token no podría inducir respuestas escritas con su payload, porque el flujo nunca lo invoca al LLM).

Texto canned (definido en `lib/quota-notifier.js` → `QUOTA_COPY.cannedFreeText`):

```
Cuota Anthropic agotada hasta las HH:MM.
Pipeline operando en modo determinístico.
Comandos disponibles: /status /metrics /dashboard /intake /pause /ghostbusters /restart /limpiar.
```

- Debounce 2 minutos para evitar spam-self del bot ante flujos chatty.
- Logueo del input usuario pasa por `redact()` antes de persistir en `commander-history.jsonl`.

### 9.5 Extender la lista de comandos sin LLM

Si necesitás sumar un comando nuevo al modo degradado:

1. Sumarlo a `DETERMINISTIC_SLASH` en `commander-deterministic.js`.
2. Si lleva args, declarar el schema en `ARG_SCHEMAS[<command>]` con `allow(args)`, `usage`, `allowedValues`, `hint`.
3. Implementar el handler en `buildDefaultHandlers` (handler-level NO debe importar `pulpo.js`; recibe `{ args, message, intent }` y devuelve string MarkdownV2).
4. Crear el template en `lib/commander/templates/<command>.md` con sintaxis Handlebars-básica (`{{var}}`, `{{#if}}`, `{{#each}}`).
5. Si es destructivo (mata procesos, modifica filesystem), sumarlo a `DEFAULT_DESTRUCTIVE_COMMANDS` en `destructive-cooldown.js` o pasarlo via `opts.destructiveCommands` del dispatcher.
6. Cubrirlo con tests `node --test` en `lib/__tests__/`.
7. Actualizar este documento (§9.1) + `cmdHelp` en `pulpo.js`.

### 9.6 Limitaciones explícitas (qué NO hace el modo degradado)

- **No procesa texto libre.** Si Claude está caído y mandás "andá a fijarte qué pasa con #1234", recibís el canned response, no análisis.
- **No crea issues.** `/intake` y `/proponer` clasifican como `LLM_SLASH` — requieren Claude (#3250 SEC-5 + provider activo === anthropic). Si Claude está caído, esos comandos también caen al gate.
- **No reemplaza alertas.** El modo degradado es manual: requiere que el operador envíe el comando. Para alertas activas (PagerDuty-style) hay un canal separado vía `quotaNotifier` (recordatorios A→B→C→D, ver `lib/quota-notifier.js`).
- **No es defensa de seguridad por sí solo.** El cooldown destructivo y el `/quota` read-only son **UX guards**. La auth real está en `listener-telegram.js:144` (allowlist hardcoded de `chat.id`).

### 9.7 Verificación operativa

```bash
# Tests unitarios del modo degradado:
node --test .pipeline/lib/__tests__/commander-quota-cooldown.test.js
node --test .pipeline/lib/__tests__/commander-router.test.js

# Smoke E2E (issue #3253 CA-8): simula flag activo, dispara /quota, /status,
# /restart x2, verifica que NINGÚN spawn LLM se dispara durante el flujo:
npm run smoke:commander
```

El smoke usa fixture aislado en `.pipeline/tests/fixtures/quota-exhausted.json` y un pipeline temporal en `os.tmpdir()` — **nunca toca el estado real** del pipeline (CA-S6).

---

## Apéndice — links rápidos

- **Código:** [`.pipeline/agent-models.json`](../../.pipeline/agent-models.json), [`.pipeline/agent-models.schema.json`](../../.pipeline/agent-models.schema.json), [`.pipeline/lib/agent-models-validate.js`](../../.pipeline/lib/agent-models-validate.js), [`.pipeline/validate-agent-models.js`](../../.pipeline/validate-agent-models.js), [`.pipeline/lib/multi-provider/`](../../.pipeline/lib/multi-provider/), [`.pipeline/lib/quota-adapters/`](../../.pipeline/lib/quota-adapters/), [`.pipeline/lib/agent-launcher/`](../../.pipeline/lib/agent-launcher/).
- **Diseño y decisiones:** [`docs/pipeline-multi-provider.md`](../pipeline-multi-provider.md) (1140 líneas, design doc v2).
- **Permission mapping (capabilities cross-provider):** [`docs/pipeline-multi-provider/permission-mapping.md`](../pipeline-multi-provider/permission-mapping.md).
- **Data residency / exclusiones:** [`docs/pipeline-multi-provider/data-residency.md`](../pipeline-multi-provider/data-residency.md).
- **Issue de esta doc:** [#3176](https://github.com/intrale/platform/issues/3176).
- **Issues de mejora futura:** [#3197](https://github.com/intrale/platform/issues/3197) (auto-gen tablas).
- **Issues cerrados relevantes:** [#3198](https://github.com/intrale/platform/issues/3198) (consumer runtime de fallbacks, mergeado 2026-05-15 — ver §2.3).
