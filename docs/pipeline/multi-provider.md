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
10. [Parser robusto de errores in-flight del Commander (#3434)](#10-parser-robusto-de-errores-in-flight-del-commander-3434) — receta para agregar provider, threat model, anti-patterns.
11. [Fallback in-flight del Commander (#3275)](#11-fallback-in-flight-del-commander-3275) — gate UX, dedupe, tests.
12. [Sherlock verifier — timeout y providers (#3484)](#12-sherlock-verifier--timeout-y-providers-3484) — opción B spawn-CLI, timeout cap, soft-timeout, audit enriquecido. §12.8 cubre swap intra-provider para preservar adversariality (#3501).
13. [Alerta y switch preventivo por cuota de proveedor (#4282)](#13-alerta-y-switch-preventivo-por-cuota-de-proveedor-4282) — resiliencia anticipatoria: avisa y degrada el primary antes de reventar la cuota.
14. [Documentación operativa multi-provider (post-ola N+1)](#14-documentación-operativa-multi-provider-post-ola-n1) — smoke test reproducible, telemetría, health en vivo, failover con evidencia y comparación pre/post ola N+1 (#4405).
15. [Criterio de permanencia de proveedores (#6145)](#15-criterio-de-permanencia-de-proveedores-6145) — quién se queda: marca candidatos a baja, nunca da de baja.
16. [Criterio de admisión de proveedores (#6562)](#16-criterio-de-admisión-de-proveedores-6562) — quién entra: CLI que edita archivos + consumo verificable + términos sin entrenamiento, guardrail fail-closed en el boot y en el dashboard.
17. [Plan de rollback — re-alta de un proveedor dado de baja (#6563)](#17-plan-de-rollback--re-alta-de-un-proveedor-dado-de-baja-6563) — cómo volver a habilitar un proveedor retirado con excepción temporal, nunca "para siempre".
18. [Techo de cuota contratada por proveedor (#6559)](#18-techo-de-cuota-contratada-por-proveedor-6559) — el haber del libro contable: `plan`/`periodo`/`techo`/`unidad`/`reposicion` por proveedor activo, guardrail fail-closed en el boot y lectura programática para saldo y ritmo (#6560).
19. [Saldo, ritmo y proyección de agotamiento de cuota (#6560)](#19-saldo-ritmo-y-proyección-de-agotamiento-de-cuota-6560) — el balance del libro contable: ledger de muestras, fórmula única (`computeQuotaBalance`), `/api/dash/quota-balance` y las cuatro series derivadas para el auditor (#6809).
20. [Auditor calidad-precio por agente (#6793)](#20-auditor-calidad-precio-por-agente-6793) — corrida semanal desde el Pulpo, veredicto cerrado por skill, como máximo un mensaje por corrida; nunca cambia un modelo solo.

> **Convención:** todos los paths `.pipeline/...` son relativos a la raíz del repo (`C:\Workspaces\Intrale\platform\`). Todos los comandos asumen Node.js 21 disponible en PATH.

---

## 1. Agregar un proveedor nuevo

> **Estado actual (2026-09-16, post [#6563](https://github.com/intrale/platform/issues/6563)):** el plantel es de **tres proveedores LLM** — `anthropic`, `openai-codex` y `antigravity` (launcher `agy` de Antigravity, encendido en #6857) — más `deterministic` para los skills sin LLM. Los proveedores gratuitos `cerebras`, `nvidia-nim` y `kimi-moonshot` (y los remanentes `ollama`/`groq` del código) fueron dados de baja en #6563 por el criterio de admisión de [§16](#16-criterio-de-admisión-de-proveedores-6562). Esta sección describe el procedimiento end-to-end para dar de alta un proveedor sin leer código fuente; para **volver a habilitar uno retirado**, ver [§17](#17-plan-de-rollback--re-alta-de-un-proveedor-dado-de-baja-6563).

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
| 11 | `.pipeline/agent-models.json` | Declarar `admission` con las **tres condiciones de admisión** ([§16](#16-criterio-de-admisión-de-proveedores-6562)): `cli_edits_files`, `reports_usage`, `terms_no_training`. Si alguna no se cumple, el boot rechaza referenciarlo en el ruteo con un mensaje que nombra la condición. |

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
  "permissions_mode": "bypassPermissions",
  "capabilities": ["agentic-tool-use"],
  "admission": {
    "cli_edits_files": true,
    "reports_usage": true,
    "terms_no_training": true
  }
}
```

**Claves:**

- `launcher` — alias del binario CLI. Debe estar en `ALLOWED_LAUNCHERS` (`claude`, `codex`, `antigravity`, `node`). El schema deriva su enum por inyección programática, no por copia literal: editar la constante en JS basta.
- `model` — modelo por default si el skill no sobreescribe.
- `spawn_args_template` — argv que recibe el child. Las llaves `{user_prompt}`, `{system_file}`, `{script_path}`, `{issue}`, `{trabajando_path}`, `{model}` son los **únicos placeholders válidos** (`ALLOWED_PLACEHOLDERS`). Sustitución 1:1 a elemento del argv — **nunca concatenación shell**.
- `output_parser` — normalizador del output. Valores: `anthropic-stream-json`, `openai-sse`, `antigravity-stream-json`, `none` (deterministic).
- `quota_error_types` — strings que el detector de cuota (`lib/quota-exhausted.js`) marca como "cuota agotada" para este provider. Cada item cross-validado contra la **meta-allowlist** en `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER` ([#3077](https://github.com/intrale/platform/issues/3077) SEC-2, defensa anti supply-chain).

  > **Shapes que entiende el handler `openai-sse`** ([#5978](https://github.com/intrale/platform/issues/5978)). El discriminador se lee de campos de **control**, nunca de texto libre ni del canal de contenido del modelo, y sólo matchea si el provider **declaró** ese tipo:
  >
  > | Shape | Ejemplo | Campo leído |
  > |---|---|---|
  > | SSE canónico | `{"event":"error","data":{"error":{"type":"rate_limit_exceeded"}}}` | `data.error.type` |
  > | `response.error` | `{"type":"response.error","error":{"type":"quota_exceeded"}}` | `error.type` |
  > | **Desnudo** | `{"error":{"status":402,"message":"Payment required…","code":"insufficient_quota"}}` | `error.type` → `error.code` |
  >
  > El shape **desnudo** es el que devuelven varios OpenAI-compat al agotarse el crédito (lo devolvía Cerebras, retirado en #6563; el handler se conserva porque `openai-sse` sigue siendo el parser de Codex). Antes de #5978 era invisible para el detector: el 402 no seteaba flag de cuota, el resolver seguía eligiendo el provider muerto, y cada relanzamiento quemaba un reintento **del issue** hasta rebotarlo como *"Huérfano tras 3 reintentos"*. Al agregar un provider OpenAI-compat nuevo, verificá con qué shape reporta el agotamiento antes de confiar en el failover.
- `resets_at_cap_max_days` — cap superior del `resets_at` cuando el provider reporta cuota agotada (cuotas semanales = 7, mensuales = 31). Aplicado en `capResetsAt()` para evitar "drenado natural" falso por un `reset_at` lejano malicioso ([#3077](https://github.com/intrale/platform/issues/3077) SEC-6).
- `supports_tool_use` — `true` / `false` / `"limited"`. Define paridad funcional cross-provider.
- `prompt_caching` — capacidades de cache (`supported`, `auto`, `ttl_seconds_default`, `ttl_seconds_extended`). Necesario para normalizar costos cross-provider.
- `credentials_env` — env vars que **deben existir al boot del pulpo** si algún skill referencia este provider. Cada item validado contra `ALLOWED_CREDENTIAL_ENV_VARS` ([#3080](https://github.com/intrale/platform/issues/3080) SEC-3, anti-exfiltración de `PATH`/`AWS_SECRET_ACCESS_KEY` por declaración). **Cuando `auth_mode` es `"oauth"` este campo es opcional e informativo** — no se exige la key al boot ni se inyecta al child (ver abajo).
- `auth_mode` — `"oauth"` | `"api_key"` (default `"api_key"` si está ausente). Declara **cómo** autentica el provider ([#3361](https://github.com/intrale/platform/issues/3361), generalizado por [#4306](https://github.com/intrale/platform/issues/4306)). Los providers OAuth/CLI login (`anthropic` → Claude Max, `openai-codex` → ChatGPT Plus vía `codex login`, `antigravity` → cuenta Google) autentican vía login interactivo del CLI; su token vive en stores locales (`~/.claude/.credentials.json`, `~/.codex`, cuenta Google) y **nunca pasa por una env var**. Por eso, con `auth_mode: "oauth"`: (a) el pre-check de credenciales (`credentials-precheck.js`) y el boot validator (`agent-models-validate.js`) **bypassean** la exigencia de `credentials_env`; (b) `build-child-env.js` **no exige ni inyecta** la key al env del child (env-isolation). Un provider HTTP por API key pelada (como lo eran `cerebras` y `nvidia-nim` hasta su baja en [#6563](https://github.com/intrale/platform/issues/6563); hoy no queda ninguno en el plantel) **NO** lleva `auth_mode` (queda `api_key` por default) y sigue exigiendo su key. **Coherencia fail-closed:** `agent-models-validate.js` rechaza al cargar (`error`, no warning) un provider `oauth` cuyo `launcher` no sea de login CLI (`claude` / `codex` / `antigravity`) — un provider HTTP/local marcado `oauth` correría sin credencial.
- `permissions_mode` — modo de permisos del CLI. Mapeado a la matriz capability×(provider, mode) de [`docs/pipeline-multi-provider/permission-mapping.md`](../pipeline-multi-provider/permission-mapping.md).
- `admission` — declaración de las **tres condiciones de admisión** ([#6562](https://github.com/intrale/platform/issues/6562), [§16](#16-criterio-de-admisión-de-proveedores-6562)): `cli_edits_files`, `reports_usage`, `terms_no_training`. Fail-closed: campo ausente = no cumple. `non_llm: true` exime a los ejecutores sin LLM; `exception { reason, until, issue }` mantiene temporalmente en el ruteo a uno que no cumple. Un proveedor referenciado por el ruteo que no declare las tres en `true` rompe el boot y el guardado desde el dashboard con un mensaje `[provider-admission]` que nombra la condición incumplida.

### 1.3 Dónde se inyectan las API keys y cómo rotarlas

**Ubicación canónica:** `~/.claude/secrets/telegram-config.json` (fuera del repo, inmune a checkouts y pulls).

**Schema parcial (placeholders, NO valores reales):**

```json
{
  "bot_token": "<TELEGRAM_BOT_TOKEN>",
  "chat_id": "<TELEGRAM_CHAT_ID>",
  "anthropic_api_key": "<ANTHROPIC_API_KEY o vacío si usás OAuth/MAX>",
  "openai_api_key": "<OPENAI_API_KEY>"
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
| antigravity | `gemini-3.8-flash-high` | — | chat, tools, vision, reasoning | — (licencia Antigravity) | — | perf |
| antigravity | `gemini-3.8-flash-medium` | — | chat, tools, vision | — | — | telegram-sherlock |
| antigravity | `gemini-3.8-flash-low` | — | chat, tools, vision | — | — | sin asignar |
| antigravity | `gemini-3.7-flash-medium` | — | chat, tools, vision | — | — | alternativo del provider (#3501) |
| antigravity | *(+10 ids más: `gemini-3.7-flash-{high,low}`, `gemini-3.6-flash-*`, `gemini-3.1-pro-*`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`)* | — | — | — | — | ver §8.10 |

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

4. **Tests:** correr `node --test ".pipeline/lib/__tests__/*.test.js"` — la forma con directorio falla con `MODULE_NOT_FOUND` en Node 24/Windows; la suite completa se corre con `npm run test:pipeline` (no hay tests específicos del catálogo todavía; agregar uno smoke que valide forma `{id, label, capabilities, cost_per_1m, context_window}`).

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

### 3.6 Clasificador HTTP cross-provider de errores (#3486)

Antes de [#3486](https://github.com/intrale/platform/issues/3486) la decisión "¿este código HTTP del provider debería disparar fallback?" estaba duplicada en tres archivos:

- `lib/multi-provider/completion-client.js` — matriz statusCode→reason para el camino HTTP OpenAI-compat (hoy la lista de providers HTTP está **vacía**: Cerebras y NVIDIA NIM se retiraron en #6563 y el shim HTTP de AI Studio en #6861; `antigravity` va por spawn CLI, ver [§12](#12-sherlock-verifier--timeout-y-providers-3484)).
- `lib/multi-provider/live-ping.js` — un `interpret(status, bodyExcerpt)` por provider, con regex literales duplicados.
- `lib/commander/provider-error-parser.js` — path `transport: 'api'` con su propia matriz para 401/403/429/5xx.

Cualquier cambio sutil (agregar 402 = quota_exhausted, ajustar el regex de "insufficient_quota") requería actualizar los tres en sincronía. El refactor de #3486 introdujo **`lib/http-error-classifier.js`** como fuente única.

#### Contrato

```js
const { classifyHttpError } = require('.pipeline/lib/http-error-classifier');

// Función pura, sin I/O. No lanza excepciones.
classifyHttpError(statusCode, responseBody, provider) → {
  category:          'success' | 'billing' | 'rate_limit' | 'auth' | 'transient' | 'unknown',
  reason:            'ok' | 'quota_exhausted' | 'rate_limited' | 'invalid_credentials'
                     | 'forbidden' | 'server_error' | 'unclassified',
  isQuotaError:      boolean,
  httpStatus:        number | null,
  classifierVersion: '1.0',
  detail?:           string  // opcional, redactado, capeado a 512 bytes
}
```

#### Matriz

| HTTP status | category | reason | isQuotaError |
|---|---|---|---|
| 2xx | success | ok | false |
| 401 | auth | invalid_credentials | false |
| 403 | auth | forbidden | false |
| 402 | billing | quota_exhausted | **true** |
| 429 + body matches `QUOTA_BODY_PATTERN` | billing | quota_exhausted | **true** |
| 429 (sin match de quota) | rate_limit | rate_limited | **true** |
| 5xx | transient | server_error | false |
| null / NaN / "abc" / fuera de [100, 599] | unknown | unclassified | false |
| Otros 4xx (404, 422, …) | unknown | unclassified | false |

#### Defensas de seguridad incorporadas

- **SR-1 (CWE-1333 ReDoS)**: body truncado a `MAX_BODY_BYTES` (16KB) ANTES de aplicar regex. Patrones con alternation literal, sin `.*` libre, sin nested quantifiers. Auditable por grep.
- **SR-2 (CWE-117 / CWE-532)**: `detail` opcional pasa por `lib/redact.js#redactSensitive` y se capea a `DETAIL_MAX_BYTES` (512 bytes). El output NO incluye raw body completo. El `category`/`reason` son códigos canónicos, nunca fragmentos del body.
- **SR-4 (CWE-285)**: 401/403 → siempre `isQuotaError: false`. No hay excepción por provider. Esto evita enmascarar credenciales inválidas como cuota agotada (degrade silencioso de integridad).
- **SR-5 (CWE-20)**: inputs null/no-numéricos caen a `unknown` sin lanzar. El parámetro `provider` es **informativo** (logging/hints) y **NO** altera la matriz HTTP base. Un atacante que pueda manipular el string `provider` (config envenenada) no puede forzar que un 401 se reclasifique como 200.
- **SR-7**: cero npm nuevas. Solo `node:` stdlib.

#### Cómo agregar un provider nuevo

**NO se modifica el clasificador.** Trabaja solo sobre `statusCode` + regex sobre body acotado. El parámetro `provider` no entra en la matriz. Si el provider nuevo devuelve un marcador de quota que no matchea `QUOTA_BODY_PATTERN`, se agrega al regex centralizado (no en cada call site).

#### Lo que el clasificador NO reemplaza

- **`quota_error_types` en `agent-models.json`** sigue siendo `required` en el schema y cubre el **canal CLI** (claude-code/codex via stream-json o stderr donde no hay HTTP status visible al wrapper). Cross-validado contra `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER` en `quota-exhausted.js` (defensa SEC-2 de [#3077](https://github.com/intrale/platform/issues/3077) contra adulteración de `agent-models.json`).
- **El hint humanizado del mensaje Telegram** se compone aparte vía `getQuotaHint(provider)` en `provider-exhaustion-pause.js` ([#3498](https://github.com/intrale/platform/issues/3498)). Desde el refactor de #3498 ese helper se **deriva automáticamente** de `agent-models.json#providers.<id>.quota_error_types` con cap defensivo de 5 elementos, sanitización por elemento y fallback `'quota_exhausted'` (o `'quota_exhausted (config indisponible)'` si el JSON no carga). **Agregar un patrón nuevo es ahora un PR de un solo archivo (`agent-models.json`)**; el mensaje Telegram refleja el cambio al próximo restart del Pulpo, sin tocar la tabla manual `KNOWN_HINTS_BY_PROVIDER` (eliminada). El clasificador HTTP da la `category` operativa; el hint humano se compone aparte y vive en el panel del operador.

#### Consumidores actuales

| Consumer | Cómo lo usa | Shape externo que mantiene |
|---|---|---|
| `completion-client.js` | Llama `classifyHttpError(statusCode, bodyText, provider)`. Mapea `category=auth` → `type: 'auth_error'`, resto → `type: 'http_error'`. | `{type, reason, statusCode, detail?}` (contrato Sherlock) |
| `live-ping.js` | Vía helper `_classifyForLivePing(provider, status, bodyExcerpt)`. Aplica overrides legacy (openai: 429 plain → `quota_exhausted`). | `{ok, reason, provider, statusCode, latency_ms}` |
| `provider-error-parser.js` | Solo en `transport: 'api'`, como **última red de salvataje** cuando el parser estructural (canal JSON) no matcheó pero hay `status` extraído del body. Mapeo `category → errorClass` en `_mapClassifierToErrorClass`. | `{errorClass, retriable, shouldFallback, raw, evidence}` |

#### Tests

`lib/__tests__/http-error-classifier.test.js` cubre 37 casos: happy path (2xx, 402, 429-quota, 429-rate), validación de inputs (null, NaN, "abc", string-numérico, fuera de rango), permisos (401/403 nunca como cuota), edge cases (5xx, 400-Gemini, body 100KB, Buffer, objeto malformado), info-leak (detail redactado y capeado), inmutabilidad del provider param, audit metadata (`classifierVersion` presente en todo retorno), y ReDoS-safety del regex de quota (1MB adversarial en <50ms).

### 3.7 Propagación del modelo al proceso hijo (#6272)

Declarar un modelo en `agent-models.json` no alcanzaba para que el agente lo usara.
Hasta #6272 el pipeline **resolvía** el modelo (`effective.model` en
`lib/agent-launcher.js`) y lo **logueaba**, pero nunca lo pasaba al hijo: Anthropic
jamás recibía `--model`, y `CODEX_MODEL` / `ANTIGRAVITY_MODEL` (y las variables de los
proveedores gratuitos entonces vigentes) nunca se seteaban para agentes (sólo las
completaban `lib/sherlock-verifier.js` y `lib/commander/glitch-retry.js`). Resultado:
todos los proveedores corrían con el **default de su CLI**, no con lo declarado.

#### Canales por proveedor

La política vive en [`.pipeline/lib/model-propagation.js`](../../.pipeline/lib/model-propagation.js)
(módulo puro: no lee env, no lee disco, no loguea). El launcher aplica la decisión.

| Proveedor | Launcher | Canal | Cómo llega |
|---|---|---|---|
| `anthropic` | `claude` | argv | `['--model', id]` — dos elementos separados del array |
| `openai-codex` | `codex` | env | `CODEX_MODEL` → el handler la traduce a `-m <id>` |
| `antigravity` | `antigravity` | env | `ANTIGRAVITY_MODEL` → `--model <id>`. **Única fuente** que lee el handler (#6334 → #6858 → #6861) |
| `deterministic` | `node` | — | no aplica (Node puro, sin LLM) |

Los nombres de las variables viven en `PROVIDER_MODEL_ENV`
([`lib/build-child-env.js`](../../.pipeline/lib/build-child-env.js)), constante de
código con el mismo criterio que `PROVIDER_STATIC_ENV` (#4880): scopeada al
proveedor activo, **jamás** derivada de `processEnv` ni de input del operador.

La inyección ocurre en `agent-launcher.js`, no dentro de `buildChildEnv`, a
propósito: `pipeline.env_isolation_enabled` sigue en `false`, así que hoy ningún
agente pasa por esa rama y la propagación habría quedado como código muerto.
El launcher recibe el env ya construido por cualquiera de los dos caminos del
pulpo y le agrega la variable ahí.

#### Precedencia de la variable de modelo en `antigravity` (#6334 → #6858 → #6861)

`ANTIGRAVITY_MODEL` es la **única** variable de entorno que el handler lee para
decidir el `--model` del CLI. La propaga exclusivamente `PROVIDER_MODEL_ENV`
([`lib/build-child-env.js`](../../.pipeline/lib/build-child-env.js)); ninguna otra
variable del entorno del operador llega al handler. El nombre se eligió nuevo en
#6861 a propósito: la variable con prefijo del binario que se leía hasta #6858
había quedado envenenada (un export viejo en el entorno del operador pisaba el
modelo del pulpo en silencio, #6334), y reusarla habría reactivado ese export.

Regla vigente (`providers/antigravity.js::resolveModelFromEnv`):

| Env del hijo | `--model` que corre | `modelTrace` |
|---|---|---|
| `ANTIGRAVITY_MODEL=X` | `X` | `{ applied:true, model:X, source:'ANTIGRAVITY_MODEL' }` |
| ninguna (o vacía) | *(sin flag: default del CLI)* | `{ applied:false, source:'cli-default' }` |

La traza nunca puede afirmar un modelo distinto del que corrió: el string del
`modelTrace` es literalmente el que va en argv. El sufijo del id
(`-high/-medium/-low`) es el único canal de esfuerzo; el handler nunca pasa
`--effort`. Guardrails: `tests/antigravity-model-env-4869.test.js` (el handler lee
sólo `ANTIGRAVITY_MODEL`) y `tests/model-propagation.test.js` (paridad
`PROVIDER_MODEL_ENV['antigravity']` ↔ `MODEL_ENV_VAR` del handler).

**Caída a un proveedor de respaldo:** se propaga el modelo del proveedor
**efectivo**, nunca el del primario. El launcher usa `effective.provider` /
`effective.model`, que en un fallback vienen del `resolveImpl` que inyecta el
pulpo con `dispatchResolution.{provider,model}`.

#### Flag de rollout — apagado por default

```yaml
pipeline:
  model_propagation:
    enabled: false          # kill-switch duro; false ⇒ 'off' sin mirar el resto
    default_mode: 'off'     # off | dry-run | on
    by_provider: {}         # granularidad por PROVEEDOR   → { anthropic: 'dry-run' }
    by_skill: {}            # granularidad por ACTOR/skill → { guru: 'on' }
```

Precedencia: `by_skill` > `by_provider` > `default_mode` > `off`. El más específico
gana, así se puede prender un actor sin prender a su proveedor entero. Un valor de
modo con typo se **ignora** y cae al siguiente nivel: un error de tipeo nunca
enciende la propagación.

| Modo | Qué hace |
|---|---|
| `off` | No se toca nada. El objeto que recibe `child_process.spawn` es byte-idéntico al previo al cambio. Sin traza (cero ruido). |
| `dry-run` | Calcula todo (whitelist + catálogo) y loguea con prefijo `[dry-run]` el modelo que **se habría** pasado y por qué canal, sin alterar el comando. |
| `on` | Propaga. |

> **No encender antes de que #6271 esté entregado.** Sin la resolución corregida,
> prender esto sólo repartiría el literal legacy a los cinco proveedores. El
> encendido escalonado y el rollback son scope de **#6274**.

#### Defensa del valor

Dos whitelists, por canal:

- **argv** (`MODEL_ARG_WHITELIST`, la misma de `commander/glitch-retry.js` — SR-A.1):
  `^[A-Za-z0-9._\-\[\]]{1,64}$`. Estricta porque `detectLauncher` de Anthropic
  puede devolver `shell:true` (tiers cmd-shim / path-fallback) y ahí un
  metacaracter escala a `cmd.exe`.
- **env** (`MODEL_ENV_WHITELIST`): agrega **sólo** la barra `/`, porque hay
  catálogos con ids namespaced (`vendor/model`; era el caso de NVIDIA NIM,
  retirado en #6563, y se conserva para no cerrar la puerta a un catálogo así).
  La `/` no es metacaracter de `cmd.exe`, y los providers de este canal corren
  `shell:false`.

Orden de validación: `typeof` → cap de longitud → whitelist. Si algo no valida, el
flag/env **se omite** con una `reason` tipada (`not_a_string`,
`length_out_of_range`, `failed_whitelist`), el agente arranca heredando el default
del CLI y queda traza. **El spawn nunca se aborta.** `buildSpawn` de Anthropic
revalida por su cuenta: es la última frontera antes de argv y no confía en su caller.

El id rechazado **no se imprime crudo** en el log (vector: alguien pone una API key
en `model` y termina en Telegram o en un PDF); se muestra saneado y recortado.

#### Validación contra catálogo

Antes del spawn, el id declarado se cruza contra `ALLOWED_MODELS_BY_LAUNCHER`
(`lib/agent-models-validate.js`) — la **misma** tabla que ya valida el boot, no un
catálogo nuevo. Un id fuera de la lista se reporta como **error de configuración**
(mensaje que enumera los válidos, igual formato que el validador) y **no** propaga,
pero el agente arranca igual: es un error de config, no una muerte de agente.

> **Ojo con la asimetría:** `ALLOWED_MODELS_BY_LAUNCHER` indexa por **launcher**,
> mientras que `multi-provider/model-catalog.js` indexa por **provider**. No son
> intercambiables — un provider puede reusar el launcher de otro (lo hacía
> `kimi-moonshot` con `claude`, retirado en #6563). El cruce mapea provider →
> launcher leyendo `providers.<p>.launcher`.

#### Guardrail anti-regresión

`tests/model-propagation.test.js` enumera la tabla **real** de handlers
(`PROVIDER_HANDLERS`) y falla si un provider nuevo o modificado:

- no declara canal de modelo (ni `ARG_MODEL_PROVIDERS` ni `PROVIDER_MODEL_ENV`), o
- declara canal pero no lo propaga de verdad al objeto que recibe `spawn`, o
- declara en `PROVIDER_MODEL_ENV` una variable que su `buildSpawn` no lee, o
- declara los dos canales a la vez.

```bash
node --test .pipeline/tests/model-propagation.test.js
```

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

Esta tabla refleja la **fuente autoritativa**: la memoria `project_multi-provider-per-agent-order` (sign-off Leo 2026-05-15). El archivo `.pipeline/agent-models.json` es la fuente vigente; #6860 actualiza las filas afectadas por Antigravity con el sign-off del 2026-09-18. El resto conserva aquí su referencia histórica. Los tests en `lib/__tests__/agent-models-validate.test.js` actúan como drift detector — si la tabla cambia, los tests fallan y avisan.

Convenciones:
- **Gemini EXCLUIDO**: credenciales, estrategia e integridad de `main`, incluso con código público. Auditoría de security del **2026-09-16**: **la exclusión se mantiene** para Antigravity consumer, también en plan pago. Ver §4.4.1 para fuentes, vigencia y criterio de cierre.
- **Gemini incluido**: evaluadores que redactan y validan sin credenciales de infraestructura; canal Telegram con aceptación explícita de privacidad de Leo. La capacidad de vision de PO/UX queda pendiente en #7314.
- Cuando un fallback aparece con `model_override` específico, es porque el `model` default del provider no es adecuado para ese skill (ej. `qa` necesita `gpt-5` con vision, no `gpt-5-codex` text-only).

> **Nota #3353 (mayo 2026):** `groq` fue descontinuado por política de bloqueos
> arbitrarios del proveedor. Las cadenas de fallback debajo ya no lo incluyen.
>
> **Nota #6563 (2026-09-16):** `cerebras`, `nvidia-nim` y `kimi-moonshot` fueron dados
> de baja (criterio de admisión §16). Las cadenas se recortaron **por eliminación del
> eslabón**, sin reordenar lo que queda: el orden canónico del sign-off se conserva.
> La tabla de abajo es el estado **vigente** de `agent-models.json` (modelos incluidos;
> `sonnet-4-6`/`gpt-5.5`/`gemini-3.8-*` son los ids reales verificados en #6858 y
> 2026-06-04). Sumar `antigravity` a los skills que hoy quedan con dos eslabones es
> decisión del orden canónico (sign-off del operador) y del auditor #6809, no de #6563.

| Skill | Primary | Fallback 1 | Fallback 2 | Notas |
|-------|---------|------------|------------|-------|
| `backend-dev` | anthropic / opus-4-7 | openai-codex / gpt-5.5 | — | Gemini **EXCLUIDO** (toca secrets/prod) |
| `pipeline-dev` | anthropic / opus-4-7 | openai-codex / gpt-5.5 | — | Gemini **EXCLUIDO** (toca secrets/prod) |
| `android-dev` | anthropic / opus-4-7 | openai-codex / gpt-5.5 | — | Gemini **EXCLUIDO**: escribe código que va a main (#6860) |
| `web-dev` | anthropic / opus-4-7 | openai-codex / gpt-5.5 | — | Gemini **EXCLUIDO**: escribe código que va a main (#6860) |
| `security` | anthropic / opus-4-7 | openai-codex / gpt-5.5 | — | Gemini **EXCLUIDO** (gate pre-merge sensible) |
| `qa` | anthropic / sonnet-4-6 | openai-codex / gpt-5.4 | — | Gemini **EXCLUIDO**: el child carga credenciales AWS (#6860) |
| `review` | anthropic / sonnet-4-6 | openai-codex / gpt-5.5 | — | Gemini **EXCLUIDO** (lee diffs con secrets/JWT) |
| `po` | anthropic / sonnet-4-6 | antigravity / gemini-3.1-pro-low | openai-codex / gpt-5.4 | Redacta y valida; Google antes de Codex (Decisión 2, sign-off #6860). Vision pendiente de #7314 |
| `ux` | anthropic / sonnet-4-6 | antigravity / gemini-3.1-pro-low | openai-codex / gpt-5.4 | Redacta y valida; Google antes de Codex (Decisión 2, sign-off #6860). Vision pendiente de #7314 |
| `doc` | anthropic / sonnet-4-6 | openai-codex / gpt-5.5 | — | Gemini **EXCLUIDO** (estrategia de producto) |
| `planner` | anthropic / sonnet-4-6 | openai-codex / gpt-5.5 | — | Gemini **EXCLUIDO** (roadmap/estrategia) |
| `guru` | anthropic / sonnet-4-6 | openai-codex / gpt-5.5 | — | Gemini **EXCLUIDO** (fragmentos código) |
| `architect` | anthropic / sonnet-4-6 | openai-codex / gpt-5.5 | antigravity / gemini-3.1-pro-high | Diseña sobre código público, sin secrets — Pro-high (#6860) |
| `ops` | anthropic / sonnet-4-6 | openai-codex / gpt-5.5 | — | Gemini **EXCLUIDO sí o sí** (procesa API keys / AWS creds / Cognito) |
| `perf` | anthropic / sonnet-4-6 | openai-codex / gpt-5.5 | antigravity / gemini-3.8-flash-high | Analiza builds sin credenciales — Flash-high (#6860) |
| `auth` | anthropic / sonnet-4-6 | openai-codex / gpt-5.5 | — | Gemini **EXCLUIDO** (config interna del entorno) |
| `refinar` | anthropic / sonnet-4-6 | openai-codex / gpt-5.4 | — | Gemini **EXCLUIDO** (backlog/estrategia) |
| `telegram-commander` | anthropic / sonnet-4-6 | openai-codex / gpt-5.4 | antigravity / claude-sonnet-4-6 | Chat del operador — Sonnet vía Google (Decisión 1, sign-off #6860); modo reducido mientras billing sea free (#7338) |
| `telegram-sherlock` | anthropic / haiku-4-5 | openai-codex / gpt-5.4-mini | antigravity / gemini-3.8-flash-medium | Verificador — sube de Flash-low; familia distinta del Commander (#3501, #6860) |

> **Sobre "sonnet-4-7" vs "sonnet-4-6":** el JSON canónico usa `claude-sonnet-4-6` desde el 2026-06-04 (sign-off Leo; `claude-sonnet-4-7` no existe en el catálogo de Anthropic y el CLI lo rechazaba). Cualquier cambio de modelo en `ALLOWED_MODELS_BY_LAUNCHER.claude` requiere review humano.

> **Sobre `tester` y `build` (deterministic):** la memoria `project_multi-provider-per-agent-order` originalmente proponía `build` con un free provider y `tester`=claude-sonnet como primary LLM. Sin embargo, **ambos skills son determinísticos** — corren como Node scripts (`.pipeline/skills-deterministicos/{build,tester}.js`) y la allowlist hardcoded `DETERMINISTIC_SKILLS = ['build', 'tester', 'linter', 'delivery']` en `resolve-provider.js` fuerza spawn determinístico ignorando lo que diga `agent-models.json`. Declararlos con LLM declarativo y `fallbacks[]` en el JSON crea **drift entre fuentes de verdad** (mismo patrón del incidente #3157 que costó $2.72/h en builds). Por eso `agent-models.json` los declara con la forma mínima `{provider: deterministic}` igual que `linter` y `delivery`, y `deterministic-skills-coherence.test.js` lo enforce. Si alguna vez se introduce una variante LLM-augmented (ej. `tester --from-gherkin`), se trata como un skill nuevo con su propia entrada, no se mezcla con el determinístico.

### 4.4.1 Matriz modelo×agente sobre Antigravity — sign-off Leo 2026-09-18 (#6860)

> **La conclusión caduca si `agy --version` ≠ 1.2.5** o cambian las fuentes contractuales. La auditoría de security del 2026-09-16 se realizó con 1.2.4; guru re-verificó la instalación con 1.2.5 el 2026-09-17. Desarrollo comprobó nuevamente 1.2.5 en los spawns del 2026-09-18 UTC. El gate security conserva la firma de la re-verificación contractual.

#### Caducidad del pin: política (b) — decisión del operador (Leo, 19/9/2026, #7371)

Contexto: `agy` se auto-actualizó a 1.2.7 el 18/9 22:09 (tercera vez en tres semanas) y el gate `cli_contract_mismatch` (origen: #7322, cuando 1.2.4 rechazaba `--print`) sacó a Antigravity de toda cascada **en silencio** durante la ventana de reposo de Anthropic, con Codex en cuota real ≥90 %: Commander mudo ~5 h. La regla de caducidad de arriba (origen: auditoría de TOS de #6860) es correcta; lo que falló es que se disparaba sin aviso y sin dueño de la remediación.

1. **Política (b), en una frase:** una versión del CLI **por encima de `max_tested_version`** es **advertencia, no bloqueo**: el probe hace el round-trip real igual y, si el catálogo responde, el provider queda **verde** con `cli_probe.detail: version_above_tested` y sigue en la cascada. El rojo durable `cli_contract_mismatch` queda **sólo** para `version_below_min`, `version_major_above_tested` y `version_unparseable`; un fallo del round-trip sigue siendo `cli_license_unavailable`.
2. **Riesgo aceptado, con fecha:** entre el bump del binario y el cierre de #7343 el pipeline **opera con auditoría de TOS vencida**. Es un riesgo **aceptado por el operador el 19/9/2026** (el control pasa de preventivo a detectivo). Para que no sea invisible: el panel muestra la fila SANO con la nota "⚠ versión X fuera del rango probado (pin Y) · auditoría de TOS pendiente" y el health-cron emite una alerta Telegram propia (`version_above_tested`, ⚠️ en cabecera, con versión, pin, consecuencia y acción) con dedup por `versión|pin` y **recordatorio cada 24 h sin tope** mientras persista; la única forma de silenciarla es cerrar el ciclo (re-verificar TOS y subir el pin), que cambia la key. Un mismo `detail` con una versión nueva (1.2.8) vuelve a alertar.
3. **La matriz de exclusiones de esta sección es invariante respecto de la versión del CLI** (REQ-SEC-A): `android-dev`, `web-dev`, `qa`, `security`, `review`, `ops` y el resto de los EXCLUIDOS siguen **sin eslabón `antigravity`** con cualquier versión. La política (b) relaja el gate de versión, **no** el perímetro de qué skills usan Google; "Antigravity está sano" nunca se reinterpreta como "se puede abrir a más skills".
4. **Alcance: mismo major.** La advertencia cubre saltos compatibles por semver (`1.2.5 → 1.2.7`, `1.2.x → 1.3.0`). Un **salto de major** (`1.x → 2.0.0`) es cambio contractual (flags, comportamiento, potencialmente TOS) y **sigue siendo rojo durable** `cli_contract_mismatch` con `detail: version_major_above_tested`, sin round-trip (REQ-SEC-C, decisión conservadora del arquitecto; ampliarla requiere cambiar esta línea y un caso de test, nunca queda implícito).
5. **Referencias y dueños:** #6860 (origen de la regla de caducidad), #7322 (origen de `cli_contract_mismatch`), **#7343** (tarea de re-verificación de TOS con la versión nueva y bump del pin — pasa de recomendación a **tarea de cierre del riesgo aceptado**, ya no es prerequisito para usar el provider), **#7287** (control preventivo: frenar el auto-update del binario), #7375 (hash del binario en el snapshot), épico #7376 (generalización a claude/codex).

El pin vive en **una única fuente**: `AGY_CLI_CONTRACT` en `.pipeline/lib/multi-provider/agy-catalog-probe.js` (`secrets-rw.js` lo importa por identidad; absorbe #7320). Pin operativo vigente: **1.2.7** (subido el 19/9/2026 por PR #7372 como mitigación inmediata, round-trip `agy models` verificado OK). La re-verificación contractual con 1.2.7 queda **pendiente** en #7343; este bloque no la reemplaza.

**TOS: la exclusión se mantiene.** Cuenta `authMethod=consumer`, no Enterprise. Los [términos de Antigravity](https://antigravity.google/terms) permiten retener interacciones para mejorar tecnologías y su revisión humana; pagar la licencia no acredita ausencia de entrenamiento. La [FAQ](https://antigravity.google/docs/faq/) remite a ajustes para el opt-out y [Plans](https://antigravity.google/docs/plans/) describe cuota/modelos. La auditoría también registró los hilos [168429](https://discuss.ai.google.dev/t/how-can-i-completely-opt-out-of-the-use-of-my-data-for-model-training/168429) y [125236](https://discuss.ai.google.dev/t/antigravity-data-training-opt-out/125236), sin confirmación de staff sobre el alcance del toggle de la IDE en el CLI. Fuente de la conclusión y evidencia local: comentario de security en #6860 (2026-09-16) y validación de guru (2026-09-17). Términos y FAQ consultados nuevamente durante desarrollo el 2026-09-18 UTC; no se declara `terms_no_training: true`.

Cierre verificable para levantar la exclusión: **(a)** Workspace/Enterprise/GCP con DPA y fuente contractual, o **(b)** confirmación escrita de Google de que el opt-out cubre el CLI consumer, captura fechada del opt-out de la cuenta y re-verificación en cada cambio de versión. Cambiar de familia de modelo dentro de Google no elimina este requisito.

[Sign-off de Leo](https://github.com/intrale/platform/issues/6860#issuecomment-5723188265), registrado antes de aplicar la matriz: **“Decisión 1: sí”**; **“Decisión 2: sí, Google antes que Codex (Opción A recomendada)”**. La primera acepta que Commander/Sherlock ruteen por Antigravity consumer con retención y revisión humana. La segunda coloca Google como primer respaldo de PO/UX, excepción al orden global Claude → Codex → Google.

| Skill | Modelo en antigravity | Posición | Bucket (dato de cuota, no criterio de asignación) | Justificación |
|---|---|---|---|---|
| android-dev | **EXCLUIDO** | Sin eslabón Google | — | Escribe código que llega a main; conserva sólo Codex (NVIDIA dado de baja en #6563). |
| web-dev | **EXCLUIDO** | Sin eslabón Google | — | Escribe código que llega a main; conserva sólo Codex (NVIDIA dado de baja en #6563). |
| qa | **EXCLUIDO** | Sin eslabón Google | — | El child recibe credenciales AWS; conserva sólo Codex. |
| po | gemini-3.1-pro-low | 1º respaldo, antes de Codex (`fallbacks[0]`) | Gemini | Redacta y valida; Pro-low aporta criterio sin consumir el bucket Claude. Vision pendiente de #7314. |
| ux | gemini-3.1-pro-low | 1º respaldo, antes de Codex (`fallbacks[0]`) | Gemini | Redacta y valida; comparte el criterio de PO sin credenciales de infraestructura. Vision pendiente de #7314. |
| architect | gemini-3.1-pro-high | 2º respaldo, después de Codex (`fallbacks[1]`) | Gemini | Diseña a partir de código público; mayor razonamiento para arquitectura. |
| perf | gemini-3.8-flash-high | 2º respaldo, después de Codex (`fallbacks[1]`) | Gemini | Analiza builds sin secrets y preserva la cuota Claude. |
| telegram-commander | claude-sonnet-4-6 | 2º respaldo, después de Codex (`fallbacks[1]`) | Claude | Mantiene el piso de calidad del operador bajo el consentimiento de privacidad para Google. |
| telegram-sherlock | gemini-3.8-flash-medium | 2º respaldo, después de Codex (`fallbacks[1]`) | Gemini | Sube desde Flash-low y conserva familia distinta del Commander (#3501). |
| Sin skill | claude-opus-4-6-thinking — no asignado | — | Claude | Comparte cuota con Sonnet; no hay un caso de uso que justifique su mayor consumo. |
| Sin skill | gpt-oss-120b-medium — no asignado | — | Claude/GPT | Sin caso de uso que lo justifique; consumiría el bucket compartido con Sonnet (Cerebras, que lo ofrecía, fue dado de baja en #6563). |

Los defaults `gemini-3.8-flash-medium` y alternativo `gemini-3.7-flash-medium` no cambian. El sufijo del ID es el único canal de esfuerzo: no se añade `--effort`. No cambian `billing`, `admission` ni la excepción de admisión (reasignada a #6564 por #6563, vence el 2026-12-31). Commander **sigue en modo reducido** mientras `billing: free`; #6564 cerró sin cambiarlo y #7338 registra el seguimiento del flip. Esta matriz no promete una activación inmediata del chat.

**Evidencia de tool_use (CA-5), 2026-09-18 UTC, agy 1.2.5.** Por modelo se ejecutó `node .pipeline/tests/smoke/antigravity-add-dir.smoke.js --model <id>`, con instrumentación efímera del resultado para registrar `usage`. El smoke usa `provider.buildSpawn` y `--add-dir`, crea un repo temporal y verifica contenido exacto `6859-OK`, presencia en git status y scratch sin archivos nuevos. Los temporales se eliminan después del PASS.

| Modelo | Status / exit | Duración ms | input / output / thinking / cache_read | Archivo creado y comprobado |
|---|---|---:|---|---|
| gemini-3.1-pro-low | PASS / 0 | 17007 | 7609 / 832 / 665 / 20209 | agy-6859-wt-NfWlnX/marca-6859-1789696910819.txt |
| gemini-3.1-pro-high | PASS / 0 | 13687 | 15518 / 679 / 497 / 12133 | agy-6859-wt-vgb0Qx/marca-6859-1789696928007.txt |
| gemini-3.8-flash-high | PASS / 0 | 22817 | 88333 / 1965 / 1328 / 0 | agy-6859-wt-N91jpu/marca-6859-1789696941841.txt |
| gemini-3.8-flash-medium | PASS / 0 | 11471 | 27023 / 537 / 336 / 0 | agy-6859-wt-CkaRm8/marca-6859-1789696964724.txt |
| claude-sonnet-4-6 | PASS / 0 | 11334 | 16107 / 300 / 0 / 14663 | agy-6859-wt-njmEA2/marca-6859-1789696976337.txt |

Los contadores son los reportados por el CLI; esta pasada observó cache_read distinto de cero en Pro y Sonnet, por lo que la observación histórica de caché cero no se generaliza a todos los modelos. No constituyen medición del precio ni del consumo de cuota del plan.

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

#### 5.3.1 El `pattern_matched` es lo que REPORTÓ el provider, no una adivinanza ([#7161](https://github.com/intrale/platform/issues/7161))

El `error_type` que resuelve el detector (`_detectAnthropic` / `_detectOpenAI`) **viaja en el veredicto del parser** (`errorType`) hasta el punto que persiste el flag. El escritor lo revalida contra la allowlist del provider (SR-7 no se relaja) y recién ahí lo escribe.

Sólo cuando **no** hay tipo propagado ni tipo re-derivable del `evidence` se cae al *default safe* = `allowlist[0]`, y ese degradado **deja traza** en el log (`error_type degradado a default (<tipo>) para <provider> — motivo=<...>`). Un `pattern_matched` sin esa traza es un tipo que el provider reportó de verdad.

> **Incidente que fija la regla.** El frame de control de codex con cuenta ChatGPT (`turn.failed` con el límite en `error.message`) no trae `error.type`. Antes se descartaba el tipo correcto (`usage_limit_reached`), el escritor lo re-adivinaba, no encontraba candidato y caía a `insufficient_quota` — que significa "sin crédito/billing" y gatea 24h. Resultado: codex apagado ~19h de más sobre un cap rolling que se libera en una hora.

#### 5.3.2 Cap rolling de codex: el gate dura lo que el CLI anuncia

El límite de la cuenta ChatGPT es **rolling**, y el propio mensaje de control dice cuándo se libera:

```
You've hit your usage limit. Upgrade to Pro ... or try again at Sep 10th, 2026 1:00 AM.
```

Esa fecha se parsea (hora **local** del host: el mensaje no trae zona horaria) y viaja como `resetsAt` hasta `setFlag`. Para `usage_limit_reached` el escritor garantiza que el gate **nunca** degrada al fallback semanal ni al cap por proveedor:

| Caso | `resets_at` persistido |
|---|---|
| Fecha anunciada y usable (entre +5 min y +24 h) | la anunciada |
| Sin fecha en el mensaje | `now + 1 h` |
| Fecha basura, en el pasado o a más de 24 h | `now + 1 h` |

La ventana de 1 h es auto-correctora: si al drenarla codex sigue capado, el próximo intento vuelve a setear el flag.

**Kill-switch operacional** (si por bug el flag queda persistente):

```bash
rm .pipeline/quota-exhausted.json
```

→ desbloquea el pipeline en el spawn siguiente. Documentar el motivo en commit / Telegram.

#### 5.3.3 Créditos de reset de codex y reconciliación en vivo del flag ([#7185](https://github.com/intrale/platform/issues/7185))

Codex (plan ChatGPT) otorga cada tanto **créditos de reset de límite de uso** (en el TUI: `/usage` → *Redeem usage limit reset*). El pipeline los canjea solo cuando conviene, y aprovecha la misma lectura para corregir el flag de cuota con evidencia fresca.

**Módulos:** [`lib/codex-reset-credit.js`](../../.pipeline/lib/codex-reset-credit.js) (decisiones) + [`lib/codex-app-server-client.js`](../../.pipeline/lib/codex-app-server-client.js) (JSON-RPC 2.0 por stdio contra `codex app-server`, spawn **efímero**: el proceso termina al cerrar stdin, sin daemon ni proceso residente; timeout duro + `kill()` en el camino de falla).

**Dónde corre:** en el mismo gancho que el reconciliador de #7181 (`pulpo.js`, justo antes de `resolveSpawnWithFallback`), **fire-and-forget**: no bloquea el spawn; su efecto impacta en el siguiente. Throttle persistido de 5 min, un solo barrido en vuelo. Sin slot de `openai-codex` en `quota-exhausted.json` → `noop` sin tocar disco ni spawnear nada.

Una sola lectura de `account/rateLimits/read` alimenta dos ramas:

| Rama | Regla | Qué hace |
|---|---|---|
| **Reconciliación en vivo** (CA-9…CA-12) | Ventana gobernante del snapshot (`pickGoverningWindow`, la más consumida). Si el backend publica `ordinaryUsageAllowed: true`, la ventana está `< 100 %` y no hay `rateLimitReachedType` → el flag ya no es cierto → `shortenResetsAt` a *ahora* (drena). Sin permiso publicado, regla literal: acortar sólo si el `resetsAt` observado es anterior al del flag. | **Sólo acorta, nunca alarga.** Un snapshot al 100 % no toca el flag. Backoff: como mucho un drenado en vivo por hora (si el flag reaparece, el CLI y el snapshot no coinciden — no se insiste). |
| **Canje** (CA-1…CA-7) | Sólo si el flag sigue vigente y lo agotado es la **ventana semanal** (`secondary`, 10080 min). El cap rolling de 5 h **no** se canjea: se libera solo. Fuente de la ventana: snapshot en vivo, con los rollouts locales (#7181) como respaldo; si no se puede determinar → no canjea. | `account/rateLimitResetCredit/consume` con `idempotencyKey` (UUID) **persistido antes de llamar** y reusado en reintentos (`alreadyRedeemed` = éxito, jamás un segundo crédito). Un intento lógico por agotamiento (clave `detected_at`); `max_per_week` por **semana de codex** (medida por el `resetsAt` semanal observado al canjear, no por calendario). Tras `outcome: reset` → `clearFlag({provider:'openai-codex'})` (drena sólo ese slot) + Telegram con créditos restantes. |

**Nombres reales del schema** (codex-cli 0.154.0; el issue los nombra distinto): `rateLimits.primary/secondary.{usedPercent, windowDurationMins, resetsAt}` (`resetsAt` en **segundos** epoch) y `rateLimitResetCredits.{availableCount, credits|null}` a nivel raíz. `credits: null` = sólo se conoce el conteo → se canjea sin `creditId` y el backend elige; con filas, hace falta una `status: available` + `resetType: codexRateLimits` (fail-closed ante filas inelegibles). Los schemas salen de `codex app-server generate-json-schema --out <dir>` (`v2/GetAccountRateLimitsResponse.json`, `v2/ConsumeAccountRateLimitResetCreditParams.json`, `v2/ConsumeAccountRateLimitResetCreditResponse.json`).

**Fail-safe:** app-server caído, timeout, error JSON-RPC (sin login) o schema distinto → **fail-open del flag** (queda como está) y **fail-closed del crédito** (no se consume). Una sola lectura fallida corta ambas ramas. Nunca se canjea ni se drena "por las dudas".

**Telegram (contrato UX, un solo mensaje por evento):**

| Situación | Mensaje |
|---|---|
| Canje exitoso | *"Canjee un reset de codex: la cuota semanal quedo liberada. Creditos de reset restantes: N. …"* — reemplaza al `restored` genérico (el notifier suprime el siguiente `onFlagCleared` por 2 min). |
| Semanal agotada otra vez, crédito ya usado esta semana | *"Codex sin cuota semanal otra vez y el credito de reset ya se uso esta semana. Reset semanal estimado: HH:MM …"* — una vez por agotamiento. |
| Drenado por reconciliación en vivo | variante de `restored`: *"Cuota codex restaurada antes de lo previsto: la ventana semanal esta al N% segun snapshot en vivo."* |
| `noCredit` / `nothingToReset` / cap de 5 h | **silencio** (audit log + `pulpo.log`). |
| App-server sin respuesta ≥ 1 h de barridos consecutivos | **una** alerta: *"No pude consultar el app-server de codex en la ultima hora; el flag de cuota sigue su curso."* |

Nada de la respuesta del app-server (`accountId`, `title`/`description` de créditos, `error.message`) llega a logs ni a Telegram.

**Trazabilidad:** cada decisión deja una línea `♻️ codex: …` en `pulpo.log` (canje, skip por `max_per_week`, skip por cap de 5 h, noop por fallo, flag acortado/drenado) y una entrada en `.pipeline/logs/quota-detector-*.log` (`resets_at_shortened` con `source=codex_app_server:<ventana>`, `reset_credit_redeemed`, `reset_credit_skipped`, `reset_credit_consume_failed`, `codex_app_server_unavailable`). Estado en `.pipeline/state/codex-reset-credit.json` (`last_run_ms`, `attempts` por `detected_at` con `idempotency_key`/`outcome`, `redemptions` con `weekly_resets_at`, racha de fallos).

**Config** (`config.yaml` → `quota_detector.codex_reset_credit`):

```yaml
codex_reset_credit:
  enabled: true      # false apaga las DOS ramas (canje y reconciliación en vivo)
  max_per_week: 1    # canjes por semana de codex
  notify: true       # Telegram; false = sólo audit + pulpo.log
```

**Kill-switch operacional:**

```bash
# config.yaml → quota_detector.codex_reset_credit.enabled: false
rm .pipeline/state/codex-reset-credit.json
```

> **Incidente que fija la regla (2026-09-11, 08:42 → 09:42).** Dos spawns escribieron el flag de codex hasta el 15/09 (semanal al 100 %) con un crédito de reset sin usar. El operador lo canjeó a mano minutos después, pero el reconciliador de #7181 sólo lee rollouts y no había rollout nuevo — el flag impedía el spawn que lo generaría. Anthropic en reposo, el resto gateado: codex era la única pata viva y el pipeline quedó parado 1 h por un flag que ya no era cierto. La lectura en vivo cierra ese caso y el canje evita que el crédito se desperdicie.

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

### 6.1 Tabla resumen: skills → provider → modelo → cadena (al 2026-09-18, post #6860)

| Skill | Provider | Modelo efectivo | Cadena de fallback (modelo por eslabón) | Tipo |
|-------|----------|-----------------|------------------------------------------|------|
| backend-dev | anthropic | claude-opus-4-7 | anthropic → openai-codex (gpt-5.5) | LLM |
| pipeline-dev | anthropic | claude-opus-4-7 | anthropic → openai-codex (gpt-5.5) | LLM |
| android-dev | anthropic | claude-opus-4-7 | anthropic → openai-codex (gpt-5.5) | LLM |
| web-dev | anthropic | claude-opus-4-7 | anthropic → openai-codex (gpt-5.5) | LLM |
| build | deterministic | — | — | Node puro |
| tester | deterministic | — | — | Node puro |
| security | anthropic | claude-opus-4-7 | anthropic → openai-codex (gpt-5.5) | LLM |
| qa | anthropic | claude-sonnet-4-6 | anthropic → openai-codex (gpt-5.4) | LLM |
| review | anthropic | claude-sonnet-4-6 | anthropic → openai-codex (gpt-5.5) | LLM |
| po | anthropic | claude-sonnet-4-6 | anthropic → antigravity (gemini-3.1-pro-low) → openai-codex (gpt-5.4) | LLM |
| ux | anthropic | claude-sonnet-4-6 | anthropic → antigravity (gemini-3.1-pro-low) → openai-codex (gpt-5.4) | LLM |
| doc | anthropic | claude-sonnet-4-6 | anthropic → openai-codex (gpt-5.5) | LLM |
| planner | anthropic | claude-sonnet-4-6 | anthropic → openai-codex (gpt-5.5) | LLM |
| guru | anthropic | claude-sonnet-4-6 | anthropic → openai-codex (gpt-5.5) | LLM |
| architect | anthropic | claude-sonnet-4-6 | anthropic → openai-codex (gpt-5.5) → antigravity (gemini-3.1-pro-high) | LLM |
| ops | anthropic | claude-sonnet-4-6 | anthropic → openai-codex (gpt-5.5) | LLM |
| perf | anthropic | claude-sonnet-4-6 | anthropic → openai-codex (gpt-5.5) → antigravity (gemini-3.8-flash-high) | LLM |
| auth | anthropic | claude-sonnet-4-6 | anthropic → openai-codex (gpt-5.5) | LLM |
| refinar | anthropic | claude-sonnet-4-6 | anthropic → openai-codex (gpt-5.4) | LLM |
| linter | deterministic | — | — | Node puro |
| delivery | deterministic | — | — | Node puro |
| telegram-commander | anthropic | claude-sonnet-4-6 | anthropic → openai-codex (gpt-5.4) → antigravity (claude-sonnet-4-6) | LLM |
| telegram-sherlock | anthropic | claude-haiku-4-5 | anthropic → openai-codex (gpt-5.4-mini) → antigravity (gemini-3.8-flash-medium) | LLM |

> **Exclusiones vigentes (REQ-SEC-1, §4.4.1):** `android-dev`, `web-dev` y `qa` no tienen eslabón `antigravity`. `po` y `ux` llevan Google como **primer** respaldo, antes de Codex (Decisión 2 del sign-off de #6860).

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

## 8. Hardening de free providers (#3260 + #3353)

> **Estado post-#6563 (2026-09-16):** de los tres providers free que endureció esta sección
> sólo queda **`antigravity`** (hoy vía Antigravity con licencia paga; su `billing` sigue
> declarado `free` hasta que #6564 verifique el plan). `cerebras` y `nvidia-nim` fueron dados
> de baja por el criterio de admisión (§16). Todo lo que sigue (health cron, rotación de keys,
> alertas) aplica a Gemini; las menciones a Cerebras/NVIDIA quedan como registro de diseño.
> Re-alta: §17.

Los providers free eran la **red de salvataje** del pipeline cuando se agota la cuota de Claude / Codex. El issue [#3260](https://github.com/intrale/platform/issues/3260) (ola N+5) endurece esa red con healthchecks periódicos, validación semanal de keys, panel "Health" del dashboard, alertas Telegram con dedupe + back-off, y este procedimiento operativo. NVIDIA NIM se sumó en [#3243](https://github.com/intrale/platform/issues/3243) (ola N+5). **Groq fue descontinuado en [#3353](https://github.com/intrale/platform/issues/3353)** (mayo 2026) por política inestable de restricciones del proveedor.

### Criterio de selección de free providers

- Estabilidad operativa ≥ 99.5% SLA (no bloques arbitrarios).
- Soporte técnico responsivo (< 24h respuesta).
- Política clara de restricciones (no "amenaza de bloqueo único").
- API compatible con OpenAI o documentación pública del shape de respuesta.

Groq fue descontinuado (mayo 2026) por no cumplir criterio de estabilidad operativa: la organización dueña de las keys fue bloqueada sin aviso por "organization_restricted", y el soporte ofreció "desbloqueo único" con amenaza implícita de "no habrá segundo bloqueo" — inaceptable para producción.

**Alternativas a evaluar como reemplazo:** Together AI (~6M tokens/mes free, API OpenAI-compatible) y Fireworks AI (~50K tokens/día). El issue [#3353](https://github.com/intrale/platform/issues/3353) documenta esa decisión.

### 8.1 Free tier real por provider

> **Estado (#6861):** el plantel ya no tiene ningún provider free tier ni por
> API key: `anthropic`, `openai-codex` y `antigravity` son los tres CLI con
> OAuth (`auth_mode: 'oauth'`). Si en el futuro se admite un provider por API
> key (§16), su fila va acá y la nota en `secrets-rw.js#MANAGED_KEYS[].free_tier_notes`.

| Provider | Tier | Cómo se verifica la salud | Notas |
|----------|------|---------------------------|-------|
| `antigravity` | Licencia (no es free tier; `cost_per_1m: null`, factura por licencia) | **Sin endpoint HTTP ni API key.** `probeCliProviderLive` (#6857) hace el round-trip `agy models` y clasifica en `cli_catalog_ok` / `cli_license_unavailable` / `cli_unavailable` / `cli_contract_mismatch`; cuota con `MSYS_NO_PATHCONV=1 agy -p "/usage" --output-format json`. Detalle en §8.10. | Hasta #6861 esta fila describía el healthcheck del shim de AI Studio (`GET generativelanguage…/v1beta/models` con `x-goog-api-key`). Ese endpoint **se retiró** de `live-ping.js`, junto con el patrón `API_KEY_INVALID` del clasificador; ningún módulo del pipeline manda hoy ese header. |

> `cerebras` y `nvidia-nim` se retiraron en #6563; sus filas (límites, endpoints de
> health) viven en el historial de git de este archivo y se restauran con el
> procedimiento de §17.

Cron de healthchecks: cada 15min por provider. Para los tres providers OAuth el cron no hace ningún request HTTP facturable: `ping()` los rutea por `MANAGED_KEYS[].auth_mode === 'oauth'` a la verificación por CLI antes de llegar a la tabla HTTP de `live-ping.js` (que quedó vacía). El presupuesto de **96 requests/día por provider** y la validación semanal de keys por `/models` (CA-2) sólo aplican a providers por API key, que hoy no hay. Groq fue descontinuado en #3353 y ya no se incluye en el cron.

### 8.2 Rotar una API key sin downtime (CA-5)

**El único método soportado** es la UI del dashboard o el endpoint `secrets.rotateKey()`. **Prohibido** editar `~/.claude/secrets/telegram-config.json` a mano (race condition + sin audit + sin backup atómico).

Procedimiento:

1. **Generar la nueva key en el portal del provider** por API key (hoy no hay ninguno en el plantel: los tres providers son CLI con OAuth, ver §8.10; este procedimiento aplica al que se admita por §16). NO revocar la vieja todavía.
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
- **Prueba de entrega (#6564 CA-3)**: cada alerta sale con un `_correlationId` (`mphealth-<ms>-<hex>`), así que `svc-telegram` escribe el recibo `enviado` con el `message_id` real en `servicios/telegram/recibos/<cid>.json` **sólo** cuando la API responde `ok:true` (bus de recibos #4082, fail-closed). Ésa es la evidencia de recepción aceptada por el operador: no hace falta cliente Telegram ni captura del celular. Para reproducir el disparo del 2.º tick de `plan_tier_unknown` por el canal real y esperar el recibo: `node .pipeline/tools/evidence-telegram-6564.js --real` (sin `--real` es dry-run y no toca la cola de producción).

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
- ❌ **Pasar una API key en la query string** (`?key=…`, `?api_key=…`) de una URL → queda en logs, historial y excerpts de error. `key`/`api_key` están en `SENSITIVE_QUERY_KEYS` para defense-in-depth, pero el camino correcto para cualquier provider por API key futuro es siempre un header. Hoy no aplica a nadie del plantel: `antigravity` autentica por OAuth del CLI `agy` y el pipeline no manda ninguna API key de Google a ningún endpoint (el shim de AI Studio con `x-goog-api-key` se retiró en #6861; la key residual se revoca en #7286).
- ❌ **Revocar la key vieja antes de validar la nueva con live-ping** → te quedás sin failover hasta restart.
- ❌ **Pingear endpoints de completion en el healthcheck** → consumen cuota. El cron usa solo `/v1/models` (o equivalente).
- ❌ **Bypassar el lock del cron** corriendo `runOnce` desde múltiples procesos → puede disparar abuse-detection del provider. El lock está ahí por una razón.

### 8.8 Procedimiento seguro para pasar API keys vía Telegram (#3310)

> **Contexto:** el 2026-05-17 una API key de Groq se filtró al disco del pulpo porque se pegó en plaintext en el chat de Telegram. El listener escribía el texto crudo en `commander-session.json`, `commander-history.jsonl` y `servicios/commander/pendiente/*.json` sin redacción. Issue [#3310](https://github.com/intrale/platform/issues/3310) cierra el flanco con sanitización en write-time (`sanitizer.sanitize()` aplicado antes de cualquier `appendFileSync`/`writeFileSync` de input externo) más un pre-commit hook como red de seguridad para evitar que el estado interno del pipeline llegue al repo. Groq fue descontinuado en [#3353](https://github.com/intrale/platform/issues/3353), pero la regla aplica a cualquier key.
>
> **Pero la regla operativa sigue siendo la primaria:** nunca pegues una key en el chat aunque el sanitizer esté activo. Es defensa en profundidad — la única forma robusta es no exponer el secreto al canal en primer lugar.

#### 8.8.1 Procedimiento recomendado

1. Generá / obtené la API key en el portal del provider (aplica sólo a providers por API key; `antigravity` no tiene ninguna — autentica por OAuth de `agy`).
2. **Guardá la key en un archivo local** bajo `~/.claude/secrets/` (fuera del repo):
   ```bash
   # Ejemplo genérico (reemplazar <provider> por el nombre del provider por API key)
   mkdir -p ~/.claude/secrets
   printf '%s' '<la-key>' > ~/.claude/secrets/<provider>.txt
   chmod 600 ~/.claude/secrets/<provider>.txt
   ```
3. **Por Telegram, mandá únicamente el path absoluto**, ej:
   ```
   actualizar la key de <provider>, está en ~/.claude/secrets/<provider>.txt
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

El pre-commit hook (`.husky/pre-commit` + `.pipeline/lib/precommit-secret-scan.js`) escanea el **contenido agregado de todo archivo staged** — no una lista de paths — y bloquea el commit si el sanitizer encuentra un patrón de credencial (#5244 CA-8a). El mismo escáner corre bloqueante en CI sobre el diff del PR, así que `--no-verify` no lo evita. Estos paths son, además, los que nunca deberían llegar al índice:

- `.pipeline/commander-session.json`
- `.pipeline/commander-history.jsonl`
- `.pipeline/servicios/**/*.json`

Estos archivos ya están en `.gitignore`. Si te encontrás des-ignorándolos a propósito, asumí que estás cometiendo un error — el hook va a bloquearte. Si es legítimo (ej. fixture sintético sin secrets reales), el hook tolera el commit porque el sanitizer no encuentra patrones para redactar.

#### 8.8.4 Si la key ya se filtró

Si por error pegaste una key directamente en el chat:

1. **Revocá la key inmediatamente en el portal del provider** (consola de API keys del vendor correspondiente). El sanitizer/redactor cubre el flanco a futuro, pero la key vieja sigue siendo válida hasta que la revoques upstream.
2. **Generá una nueva** y seguila el procedimiento §8.8.1.
3. **Verificá los archivos que vivieron mientras la key estaba expuesta**:
   ```bash
   grep -r "<prefijo de la key, p.ej. gsk_>" .pipeline/ 2>/dev/null | head
   ```
   Si aparece, sabés que el incidente queda registrado y sirve para correlación.
4. **Issue de scrubbing retroactivo**: si querés limpiar el historial existente, ver [#3317](https://github.com/intrale/platform/issues/3317) (necesita aprobación humana, `needs-human`).
### 8.9 NVIDIA NIM — retirado en #6563

NVIDIA NIM (`nvidia-nim`, sumado en #3243, migrado de modelo en #5887) fue **dado de baja
del ruteo el 2026-09-16** por el criterio de admisión de §16: no reportaba consumo
verificable (quota-adapter `not_implemented`) y sus términos no tenían verificación
documentada. La guía operativa que vivía acá (obtención de key en `build.nvidia.com`,
catálogo `deepseek-ai/deepseek-v4-flash-0731` / `moonshotai/kimi-k2-instruct`, hosting
topology check) se conserva en el historial de git de este archivo. Para volver a
habilitarlo, seguir §17.

### 8.10 Antigravity CLI (`antigravity`) — qué es, dónde vive, cómo se autentica, cómo verificar la licencia, catálogo (#6858, #6861)

Para un lector que no conoce la historia, esto es todo lo que hace falta saber:

1. **Qué CLI corre.** El provider `antigravity` (launcher `antigravity`,
   `output_parser: antigravity-stream-json`) lanza **Antigravity CLI**, binario
   `agy`, con `--output-format stream-json`. Hasta #6861 el provider se llamaba
   "Gemini (Google)", nombre que confundía con el Gemini CLI gratuito
   (`@google/gemini-cli`), que **no forma parte del pipeline**: no hay fallback a
   ese CLI ni a ningún endpoint HTTP (el shim a Google AI Studio se retiró en
   #6861; la key residual de AI Studio se revoca en #7286).
2. **Dónde vive el binario.** `%LOCALAPPDATA%\agy\bin\agy.exe`; se puede
   apuntar a otro con la env var `ANTIGRAVITY_BIN`
   (`detectLauncher`: `ANTIGRAVITY_BIN` → `%LOCALAPPDATA%\agy\bin\agy.exe` → PATH).
   Las otras dos variables del provider son `ANTIGRAVITY_MODEL` (§3.7) y
   `ANTIGRAVITY_PRINT_TIMEOUT` (timeout del turno `-p`). Son las únicas tres:
   las constantes `AGY_*` del código nombran el contrato del binario, no env vars.
3. **Cómo se autentica.** OAuth de la cuenta Google, iniciado con `agy`
   interactivo (`auth_mode: oauth`). **Sin API key**: el pipeline no inyecta
   ninguna credencial al proceso hijo y `credentials_env` está vacío.
4. **Cómo verificar que la licencia está activa.** Round-trip real
   `agy models` (no interactivo, no consume cuota de generación): el health-cron
   lo corre y publica `cli_catalog_ok` (verde), `cli_license_unavailable` (rojo:
   instalado pero sin sesión/licencia), `cli_unavailable` (rojo: binario
   ausente) o `cli_contract_mismatch` (rojo: versión del CLI fuera del pin). A
   mano, desde Git Bash: `MSYS_NO_PATHCONV=1 agy -p "/usage" --output-format json`
   muestra la cuota de la sesión (ver más abajo por qué la variable).


**Cuota y tier (#6564).** El tier contratado no es observable automáticamente
con `agy` 1.2.4: `/usage` expone cuota, pero no el nombre del plan, y no existe
un comando no interactivo de cuenta/plan. El operador lo confirma abriendo
`agy` interactivo y leyendo el header email + plan tier, sin copiar identidad
a evidencias ni logs. El health-cron muestra sesión + cuota efectiva mediante
`plan_check`, independiente de la salud; nunca infiere el tier por la cuota.

Para comprobar cuota manualmente desde Git Bash se usa
`MSYS_NO_PATHCONV=1 agy -p "/usage" --output-format json`. Sin esa variable,
Git Bash convierte `/usage` en una ruta y puede disparar un turno real de
aproximadamente 13.000 tokens. El probe usa Node con `shell:false` y argumento
literal. Véase [procedimiento, caché y verificación de sesión](gemini-plan-verification.md).

> **Migración 2026-09-16 (#6858, split de #6856).** Los 6 skills que conservan Gemini tras #6860
> (`po`, `ux`, `architect`, `perf`, `telegram-commander`, `telegram-sherlock`) declaraban `gemini-3-flash-preview`,
> un id del **Gemini CLI gratuito retirado** que **no existe en Antigravity**. Con el
> provider encendido, todo spawn hubiera muerto sin trabajo con `--model` inválido:
> el mismo modo de falla que la migración de NVIDIA (#5887). `gemini-2.5-flash`
> (`alternative_models`) tampoco estaba en el catálogo.

**Catálogo real** — medido con `agy models` (CLI 1.2.4, 2026-09-16). El CLI
escribe a stdout una línea `id<TAB>label` por modelo:

| id | label (tal cual lo devuelve `agy models`) | Uso en el pipeline |
|---|---|---|
| `gemini-3.8-flash-high` | Gemini 3.8 Flash (High) | perf |
| `gemini-3.8-flash-medium` | Gemini 3.8 Flash (Medium) | default del provider; telegram-sherlock |
| `gemini-3.8-flash-low` | Gemini 3.8 Flash (Low) | sin asignar |
| `gemini-3.7-flash-high` / `-medium` / `-low` | Gemini 3.7 Flash (…) | `-medium` es el `alternative_models` del provider (familia distinta al primario → Sherlock conserva adversarialidad parcial, #3501) |
| `gemini-3.6-flash-high` / `-medium` / `-low` | Gemini 3.6 Flash (…) | sin asignar |
| `gemini-3.1-pro-high` / `-low` | Gemini 3.1 Pro (…) | -high: architect; -low: po, ux |
| `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium` | (terceros bajo licencia Antigravity) | Sonnet: telegram-commander; Opus y GPT-OSS: sin asignar |

La matriz firmada de **#6860** está en §4.4.1: 6 skills, 6 ids configurados en 8 rutas; las exclusiones se deciden por provider, no por familia de modelo.

**Canal de esfuerzo — uno solo.** El sufijo `-high/-medium/-low` del id codifica
el esfuerzo de razonamiento; `agy` además expone `--effort` como flag aparte.
El pipeline usa **sólo el sufijo del id** y nunca pasa `--effort`: así el string
que muestra el dashboard y la traza es exactamente el que corrió. Verificado en
vivo: `thinking_tokens` para el mismo prompt = 100 (`-high`) / 30 (`-medium`) /
21 (`-low`).

**Las dos barreras son espejo exacto del catálogo** (por reemplazo, no por
agregado — el id viejo se quita para que ninguna reintroducción pase silenciosa).
Hasta #6861 había una tercera, `PROVIDER_MODELS_ALLOWLIST['antigravity']` en
`lib/multi-provider/completion-client.js`, que se retiró junto con el shim HTTP
de AI Studio: Antigravity es spawn puro y esa tabla quedó vacía (`{}`).

| Barrera | Archivo |
|---|---|
| `ALLOWED_MODELS_BY_LAUNCHER['antigravity']` | `lib/agent-models-validate.js` (boot del pulpo + CA-6 de la propagación) |
| `CATALOG['antigravity']` (`CATALOG_VERSION 2026-09-16.1`) | `lib/multi-provider/model-catalog.js` (Tab "3 · Catálogo" del dashboard; `cost_per_1m: null` → se renderiza `—`, Antigravity factura por licencia) |

**Verificación automática contra el CLI** — `lib/multi-provider/agy-catalog.js`
cruza `agent-models.json` (las 4 fuentes de #5888 restringidas a antigravity)
+ las dos barreras contra `agy models` **real**:

```bash
node .pipeline/lib/multi-provider/agy-catalog.js --check     # exit 1 si hay ids muertos; 2 si agy no está
node --test .pipeline/lib/__tests__/agy-catalog.test.js      # offline con fixture + en vivo si agy está instalado
bash .pipeline/smoke-test.sh                                  # paso 4: reporta (no aborta) en cada restart
```

Semántica: un id **configurado o allowlisted que el CLI no devuelve** es `dead`
→ falla. Un id **nuevo del CLI que el pipeline no adoptó** es `unlisted` → aviso,
no falla (un modelo nuevo del vendor nunca dispara rollback). El smoke test
reporta sin abortar a propósito: si el vendor retira un modelo, un fallo duro
ahí entraría en bucle de rollback sin arreglar nada.

> **Nunca** cruzar contra el catálogo de **AI Studio**
> (`GET generativelanguage.googleapis.com/v1beta/models`): ahí
> `gemini-3-flash-preview` sí existe, y cruzar contra él es exactamente lo que
> dejó pasar el defecto original. Hasta #6861 `live-ping.js` tenía ese endpoint
> como healthcheck del provider; se retiró junto con el shim (ver abajo). La
> única fuente válida es `agy models` (ver #7289 para migrar el cron de #5888).

> **Retirado en #6861 — el shim HTTP de AI Studio ya no existe.** Hasta #6861
> `completion-client.js` tenía una entrada `PROVIDER_COMPLETION_ENDPOINTS` del
> ex "Gemini (Google)" que apuntaba a
> `generativelanguage.googleapis.com/v1beta/openai/chat/completions` con API
> key en header; AI Studio no servía ningún id del catálogo de Antigravity
> (`gemini-3.8-flash-medium` → HTTP 404), así que por esa ruta **ningún**
> `complete({provider:'antigravity'})` respondía `ok=true`. En el HEAD actual
> las tres tablas quedaron vacías por reemplazo: `PROVIDER_COMPLETION_ENDPOINTS
> = {}` y `PROVIDER_MODELS_ALLOWLIST = {}` (`completion-client.js`), y
> `HTTP_COMPLETION_PROVIDERS = new Set([])` (`sherlock-verifier.js`). Antigravity
> es **spawn puro**: el Sherlock lo alcanza por `spawnAntigravityComplete`
> (`SPAWN_COMPLETION_PROVIDERS = {anthropic, openai-codex, antigravity}`), que
> reusa `agent-launcher/providers/antigravity.js` — el mismo binario `agy` y la
> misma OAuth que corren los agentes, sin API key (ver §12.1). El juez semántico
> de duplicados (`lib/semantic-dedup.js`, usado por el Commander al crear
> issues) ya corría desde #6563 por **spawn del CLI OAuth** (`openai-codex` por
> default, `anthropic` como alternativa) con la contención descrita abajo; un
> test fija que su default es servible por ese transporte. Ningún caller del
> pipeline recorre hoy un endpoint HTTP de Google.

**Contención del juez semántico por spawn (#6563, hallazgo security del rebote 1).**
Un CLI de agente no es un cliente HTTP: por default corre con bypass de
sandbox/aprobaciones, hereda el env del pulpo y tiene cwd en el repo. El prompt
del juez lleva hasta 25 títulos de issues abiertos del repo público (contenido
no confiable), así que una inyección podía convertirse en bash con GH_TOKEN /
AWS_* / *_API_KEY en la máquina del operador. `dispatchComplete` restituye el
"juez sin agencia" con tres medidas, todas fijadas por
`tests/semantic-dedup-judge-no-agency-6563.test.js`:

| Medida | codex | claude |
|--------|-------|--------|
| `sandbox: 'read-only'` | `--sandbox read-only` (nunca `--dangerously-bypass-approvals-and-sandbox`) | `--strict-mcp-config --disable-slash-commands --permission-mode dontAsk --tools ""` (`ANTHROPIC_READ_ONLY_ARGS`; sólo con launcher `shell:false`, ver abajo) |
| `envPolicy: 'minimal'` | `buildMinimalCliEnv`: `SYSTEM_ALLOWLIST` + `CLI_OAUTH_ALLOWLIST` (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`) + `CODEX_MODEL`/`CLAUDE_PROJECT_DIR`. Sin `PIPELINE_*`, sin credenciales. | ídem |
| cwd | temporal vacío (`%TEMP%/semantic-dedup-judge-*`), borrado en `finally` | ídem |

Además, cada título de candidato pasa por `detectInjection` → redact →
truncate (`safeField`), igual que el issue propuesto, y no puede fabricar
líneas extra dentro de `<datos>`.

Las dos opciones (`sandbox`, `envPolicy`) viven en
`sherlock-verifier._spawnCodexComplete/_spawnAnthropicComplete` y son
**opt-in**: el fiscal Sherlock conserva el bypass y el env heredado (filtrado
por #5462). Las tablas de políticas son cerradas: un valor desconocido se
reporta como `spawn_unavailable`, nunca degrada al default con agencia.

> Verificado en vivo el 2026-09-17: con `--tools ""` **solo**, el child de
> `claude` sigue cargando los MCP del operador (Gmail/Drive/Calendar) — el
> evento `system/init` los lista. Con `--strict-mcp-config` (sin
> `--mcp-config`) el `init` reporta `tools: []`, `mcp_servers: []`,
> `slash_commands: []` y un prompt que exige crear un archivo, correr bash y
> mandar un mail no produce ningún `tool_use`. `--bare` no sirve: exige
> `ANTHROPIC_API_KEY` (nunca lee OAuth).

**Read-only exige `shell:false` (rebote 2 de #6563, CWE-88).** `--tools ""`
depende de un argumento *vacío*. Si el launcher de `claude` cae a un tier con
`shell:true` (`cmd-shim` / `path-fallback` de `providers/anthropic.js`), Node
concatena el argv con espacio sin citar (DEP0190) y el `""` desaparece: el child
recibe `--tools --strict-mcp-config` y `--tools` se traga el flag siguiente como
valor. En vivo eso dejó al juez con los MCP del operador conectados aunque los
flags "estuvieran". Dos defensas, ambas fijadas en el mismo test:

1. **Fail-closed**: `spawnAnthropicComplete` con `sandbox: 'read-only'` rechaza
   spawnear si `spawnOpts.shell` o el launcher detectado usan shell
   (`assertNoShellForReadOnly`) → `spawn_unavailable` → el juez cae en
   `ninguna`. El fiscal Sherlock (bypass legacy) no se ve afectado.
2. **Orden**: `--tools ""` es el **último** par de `ANTHROPIC_READ_ONLY_ARGS`,
   así que ni concatenado tiene un flag de seguridad que tragarse.

**Cómo medir un modelo nuevo antes de configurarlo** (CA-4 de #6858; desde #7298
el transporte es `--input-format/--output-format stream-json` con el prompt por
stdin como NDJSON — `--print` sin valor ya no existe en agy 1.2.x):

```bash
printf '%s\n' '{"event":"user","message":{"role":"user","content":"Responde solo con la palabra OK"}}' \
  | "$LOCALAPPDATA/agy/bin/agy.exe" --input-format stream-json --output-format stream-json \
      --dangerously-skip-permissions --print-timeout 120s --model gemini-3.8-flash-low
# → NDJSON: init, step_update×3, y al final
# {"event":"result","result":{"status":"SUCCESS","response":"OK\n","usage":{"input_tokens":13038,"output_tokens":13,"thinking_tokens":12,"cache_read_tokens":0,"total_tokens":13051}}}
```

Re-medición del 2026-09-16 (rebote 1 de #6858, sobre el árbol integrado con
#7298, spawn construido por `buildSpawn` del handler — mismos args y mismo
payload que usa el pipeline): `gemini-3.8-flash-high` (30,6 s), `-medium`
(20,4 s), `-low` (21,5 s) y `gemini-3.7-flash-medium` (5,3 s) → **4/4
`status: SUCCESS`, rc=0, `modelTrace.applied=true`** con el id exacto en
`--model`. Fixture del NDJSON real: `lib/__tests__/fixtures/agy-stream-json-1.2.4.ndjson`.

`_parseAntigravityJson` desenvuelve el objeto `result` del último evento
`{"event":"result"}` y `parseTokensFromLog` lee su `usage` (`output_tokens` ya
incluye `thinking_tokens`); cae al legacy `stats.models` de 1.1.x si no está.

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

## 10. Parser robusto de errores in-flight del Commander (#3434)

> **Audiencia:** dev que necesita agregar un nuevo provider al parser, auditar el threat model, o entender el wire post-spawn del Commander.
> **Issue de origen:** [#3434](https://github.com/intrale/platform/issues/3434) — surgido del incidente 2026-05-20 cuando el Commander no rotó de provider durante el outage de cuota Anthropic.

### 10.1 Qué hace el parser

`lib/commander/provider-error-parser.js` clasifica la salida de cualquier spawn LLM del Commander en categorías estructuradas. Contrato público:

```
parseProviderError(rawOutput, ctx) → {
  errorClass: 'quota_exhausted' | 'rate_limit' | 'transient_5xx' |
              'auth' | 'permanent_failure' | 'unknown',
  retriable: boolean,
  shouldFallback: boolean,
  raw: string,        // saneado, max 200 chars
  evidence: string,   // línea/json que disparó la clasificación (saneado)
}

ctx = {
  provider: 'anthropic' | 'openai-codex' | 'antigravity',
  transport: 'api' | 'cli',
  timedOut?: boolean,
  exitCode?: number | null,
  durationMs?: number,
}
```

### 10.2 Matriz de decisión

| errorClass         | shouldFallback | retriable | ¿caller llama setFlag? | Ejemplo                                    |
|--------------------|----------------|-----------|------------------------|--------------------------------------------|
| `quota_exhausted`  | true           | false     | **sí**                 | `usage_limit_error`, `insufficient_quota`  |
| `rate_limit`       | true           | true      | **sí**                 | HTTP 429 puro sin code de allowlist        |
| `transient_5xx`    | true           | true      | NO                     | Timeout, exit code ≠0, HTTP 5xx, overloaded |
| `auth`             | true           | false     | NO                     | `authentication_error`, HTTP 401/403       |
| `permanent_failure`| true           | false     | NO                     | `context_length_exceeded`, `model_not_found` |
| `unknown`          | **false**      | false     | NO                     | Sin shape conocido y sin signals de timeout |

**Por qué `permanent_failure` tiene `shouldFallback: true`:** rotar a otro provider puede resolver el caso (otro modelo PUEDE soportar context mayor), pero NO se persiste el flag porque eso bloquearía 7 días el provider por algo que no era cuota.

### 10.3 Wire post-spawn en `multi-provider.js#runCommanderSpawn`

```javascript
const mp = require('.pipeline/lib/commander/multi-provider');

const result = mp.runCommanderSpawn({
    pipelineDir,
    provider: 'anthropic',
    transport: 'cli',
    rawOutput: stderr,         // SOLO stderr para CLI (SR-1)
    timedOut: spawnResult.timedOut,
    exitCode: spawnResult.exitCode,
    durationMs: spawnResult.durationMs,
    chatId,
    prompt,
    requestId,
    chainTried: ['anthropic'],
    primaryProvider: 'anthropic',
});

// result.errorClass, result.shouldFallback, result.flagSet, result.decision
// El siguiente dispatch consultará el flag (si fue persistido) y rotará.
```

### 10.4 Agregar un provider al parser

El parser está diseñado para extender. Para sumar soporte a un provider nuevo:

1. **Sumarlo a `KNOWN_PROVIDERS`** en `lib/commander/provider-error-parser.js`. Si el provider no aparece en esa allowlist, el parser falla cerrado (`unknown`).
2. **Confirmar shape estructural** del provider en `lib/quota-exhausted.js#_detectAnthropic` o `_detectOpenAI`, o agregar un handler nuevo si el shape es disjunto (ej. Google Gemini con `error.status: 'RESOURCE_EXHAUSTED'`).
3. **Declarar `quota_error_types`** del provider en `lib/quota-exhausted.js#KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER`. El parser usa esa allowlist para validar que `errorType` antes de devolver `quota_exhausted`.
4. **Agregar fixtures** en `lib/commander/fixtures/provider-errors/` para cada `(provider, transport, errorClass)` esperado. Marcar como `synthetic: true` si no proviene de log real, e incluir `source_url` apuntando a la doc oficial.
5. **Sumar tests** en `lib/commander/__tests__/provider-error-parser.test.js` con un caso por fixture.

### 10.5 Threat model del parser

El parser opera sobre output potencialmente adversarial. Cuatro adversarios identificados:

| Adversario                         | Vector                                                            | OWASP    | Mitigación                                                            |
|------------------------------------|-------------------------------------------------------------------|----------|-----------------------------------------------------------------------|
| Modelo del propio CLI              | Emite literalmente `Usage credits required` en su respuesta       | A04      | Wire pasa SOLO stderr (no stdout) al parser. SR-1 documentado.        |
| Usuario malicioso de Telegram      | Pide al modelo repetir strings de error para envenenar el detector | A04      | Misma defensa: stderr ≠ stdout. El modelo no controla stderr.         |
| Provider degradado                 | Devuelve HTML genérico, payload trunco, headers con API keys      | A09      | `sanitizeRawExcerpt` redacta keys multi-proveedor antes de loguear.   |
| Adversario sobre el audit log      | Inyecta CR/LF para corromper líneas JSONL                         | A03/A09  | Strip CR/LF/TAB en `sanitizeRawExcerpt`. Cap 200 chars por excerpt.   |

### 10.6 Cómo NO contribuir un detector inseguro

Anti-patterns que serán rechazados en code review:

- ❌ **Regex con `.*` libre**: causa ReDoS. Usar cuantificadores acotados explícitos (`[^\n]{0,80}` máximo).
- ❌ **Matchear contra `content`/`text` del modelo**: el modelo emite texto controlado por usuario; nunca usarlo como señal de error.
- ❌ **Inferir `provider` desde `rawOutput`**: el caller pasa el provider autoritativo. Si el parser lo infiere, el adversario controla el provider.
- ❌ **Sanitizar manualmente**: reusar `quota-exhausted.sanitizeRawExcerpt` siempre. Hay redacciones específicas (Bearer, JWT, AIza, sk-ant-) que un sanitizer ad-hoc se va a perder.
- ❌ **Persistir `errorType` fuera de `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER[provider]`**: contamina el flag. El parser y el selector retornan `null` o `unknown` si el valor no es canónico.
- ❌ **Loggear el `prompt` o `content` del modelo en el audit log**: regla SR-7 del Commander. Solo `prompt_hash` (SHA-256 truncado).
- ❌ **No cap de input antes de regex**: un stdout de 100MB puede crashear el dispatcher. Cap 64KB obligatorio (`MAX_RAW_INPUT_BYTES`).

### 10.7 Tests del parser

```bash
# Unit + integration + adversarial + regresión del incidente 2026-05-20:
node --test .pipeline/lib/commander/__tests__/provider-error-parser.test.js

# No-regresión en tests existentes del Commander:
node --test .pipeline/lib/__tests__/commander-multi-provider.test.js
node --test .pipeline/lib/__tests__/commander-llm-audit.test.js
node --test .pipeline/lib/__tests__/quota-exhausted.test.js
```

Cobertura mínima exigida (CA del issue #3434):

- **CA-1**: contrato con `timedOut/exitCode/durationMs` validado.
- **CA-2**: al menos un fixture por `(provider, transport, errorClass esperado)`.
- **CA-3**: defensa anti-DoS — input 1MB <50ms, payloads ReDoS <50ms.
- **CA-4**: sanitización via `sanitizeRawExcerpt`, matriz `errorClass × shouldFallback × setFlag` documentada.
- **CA-5**: wire post-spawn (`runCommanderSpawn`) con `setFlag` solo para quota/rate_limit.
- **CA-6**: audit log con hash-chain via `appendChained`.
- **CA-7**: documentación de receta + threat model + anti-patterns (esta sección).
- **CA-8**: regresión del incidente 2026-05-20 (timeout 600s sin output clasifica `transient_5xx`).

### 10.bis Generalización cross-skill del parser (#3576)

**Estado**: implementación core entregada en #3576 (Ola N+3, 2026-05-27). Continuación natural de #3434 (parser scoped Commander) — generaliza la clasificación post-spawn a TODOS los skills del pipeline, no solo al Commander.

#### Qué cambió

Hasta #3576 había **dos call sites inline** en `pulpo.js` que parseaban el log del spawn LLM ad-hoc:

- `pulpo.js:6122` (skills regulares): leía `<issue>-<skill>.log`, iteraba líneas, llamaba `quotaExhausted.detectQuotaError(evt, providerDef)`.
- `pulpo.js:7972` (commander): mismo loop sobre el stream `result` event del CLI Anthropic.

#3576 los reemplaza por **una llamada al hook centralizado** `dispatcher.onSpawnExit(...)` (definido en `lib/agent-launcher/dispatch-with-fallback.js`). El hook:

1. Invoca `parseProviderError` (módulo `lib/agent-launcher/provider-error-parser`) que delega a `quotaModule._detectAnthropic`/`_detectOpenAI` con la allowlist canónica.
2. Si `errorClass === 'quota_exhausted'` (o `rate_limit`), invoca `quotaExhausted.setFlag(...)` (centralizado).
3. Sanitiza `rawOutput` con `sanitizeRawExcerpt` antes de loguear/emitir (NEW-1: nada de `AKIA…`/`sk-…`/`JWT` en logs ni Telegram).
4. Emite audit log unificado con shape `{ts, skill, provider, transport, error_class, evidence, should_fallback, flag_set, hash_prev, hash_self, ...}` via `appendChained` (hash-chain SHA-256).
5. **`try/catch` envolvente, never throws** — el `child.on('exit')` lifecycle del caller NO se rompe aunque el parser/setFlag/audit explote.

#### Feature flag `PIPELINE_GENERALIZED_PARSER_ENABLED` — rollout gradual

**Default en `main`: `'0'` (OFF)**. El comportamiento legacy (inline) sigue siendo el mismo byte-identical hasta que el operador active el flag por ola.

```bash
# OFF (default): código legacy inline en pulpo.js — comportamiento previo.
unset PIPELINE_GENERALIZED_PARSER_ENABLED
# o explícitamente
export PIPELINE_GENERALIZED_PARSER_ENABLED=0

# ON: pulpo.js delega al hook onSpawnExit del dispatcher.
export PIPELINE_GENERALIZED_PARSER_ENABLED=1
```

Activación operativa: reiniciar el pulpo (`node .pipeline/restart.js`) tras setear la env var. El pulpo lee el flag por dispatch (no cachea al boot), así que el cambio toma efecto a partir del siguiente spawn.

#### Plan de rollout en 3 olas (#3576 CA-9)

El rollout es **por ola**, con paridad de 24h entre el path legacy y el generalizado antes de avanzar:

##### Ola 1 — `builder` y `tester`

Skills determinísticos en su mayoría (`commander-deterministic.js`, `tester` con runs Gradle). Menor blast-radius:

```bash
# 1. Activar para builder/tester con flag por skill (manual hoy, automatizable
#    en una iteración siguiente con un mapeo skill → flag).
export PIPELINE_GENERALIZED_PARSER_ENABLED=1
# 2. Reiniciar el pulpo.
node .pipeline/restart.js
# 3. Observar 24h. Cada spawn de builder/tester emite logs con discriminador
#    🆕 (generalized). Comparar con la última ventana legacy (🛡️).
```

##### Ola 2 — `guru` y `planner`

Output más variable que builder/tester (LLM real). Una vez Ola 1 con paridad cerrada:

```bash
# Sin cambios de env (el flag es global hoy). Esperar 24h con la flag activa
# después de que builder/tester demuestren paridad. El operador valida que
# guru/planner mantienen errorClass=quota_exhausted/transient_5xx donde el
# legacy detectaba match.
```

##### Ola 3 — `commander`

El mayor blast-radius (Telegram bot, atención al usuario). Solo cuando Olas 1+2 cerraron con cero mismatches:

```bash
# La activación es la misma env var, pero el operador verifica explícitamente
# durante 24h que el commander mantenga la detección del bug #3506
# (cli_1m_context_glitch) sin contaminar el flag de quota.
```

#### Criterio de paridad por ola

**Avanzar a la siguiente ola si `(legacy_class vs generalized_class) === 0 mismatches durante 24h`**, contra la ventana inmediatamente anterior.

El script `scripts/diff-parser-codepaths.sh` (commiteado con #3576) compara las líneas del log textual emitidas por ambos paths:

```bash
# Comparar las últimas 24h de logs del pulpo:
bash scripts/diff-parser-codepaths.sh .pipeline/logs/pulpo-$(date -u +%Y-%m-%d).log

# Output esperado: "0 mismatches" → avanzar ola. Cualquier número > 0 →
# investigar manualmente cada mismatch antes de seguir.
```

#### Audit log unificado (CA-8)

Ambos paths (legacy y generalized) emiten registros separados:

- **Legacy**: usa el audit log histórico de `quotaExhausted.appendAudit(...)` (sin hash-chain estricto).
- **Generalized**: usa `lib/audit-log.appendChained(...)` con SHA-256 chain en `.pipeline/logs/spawn-exit-YYYY-MM-DD.jsonl`.

Validar la chain post-dispatch en CI:

```bash
node -e "
const a = require('./.pipeline/lib/audit-log');
const r = a.verifyChain('.pipeline/logs/spawn-exit-2026-05-27.jsonl');
if (!r.ok) process.exit(1);
console.log('chain OK: ' + r.entriesChecked + ' entries');
"
```

#### Eliminación del legacy inline — post-rollout

**No se borra en #3576**. Issue de seguimiento se abrirá cuando:

1. Ola 3 (commander) acumule 24h continuas con cero mismatches.
2. El operador confirme explícitamente en `pipeline-stable` que el generalized path está estable.

Solo entonces se elimina el bloque legacy de `pulpo.js:6122` y `pulpo.js:7972`. Hasta entonces, el flag OFF garantiza rollback inmediato sin redeploy (cambiar env var + restart, sin patch).

#### Anti-patrones a evitar

- **No activar el flag en producción sin smoke-test previo** en un ciclo de QA E2E completo. La regresión silenciosa del parser sobre un shape inesperado puede dejar el flag de cuota desincronizado.
- **No borrar el bloque legacy "porque ya funciona"** sin las 24h de paridad cerradas por ola. La presencia del legacy ES el rollback path.
- **No mezclar olas** (ej. activar Ola 1 y Ola 3 simultáneamente). El flag es global hoy; respetar la cadena 1 → 2 → 3 con paridad 24h entre cada paso.

#### CAs verificables (#3576)

- **CA-2**: `node -e "const d = require('./.pipeline/lib/agent-launcher/dispatch-with-fallback'); console.log(typeof d.onSpawnExit)"` → `function`.
- **CA-3**: `grep -nE "codepath=(legacy|generalized)" .pipeline/pulpo.js | wc -l` ≥ 4 (ambos paths emiten log estructurado en ambos call sites).
- **CA-4**: `node -e "const a = require('./.pipeline/lib/agent-launcher/providers/anthropic'); console.log(a.detectQuotaExhausted.length)"` (sigue siendo 4-5 args; refactor backward-compat).
- **CA-7**: `ls .pipeline/lib/agent-launcher/__tests__/provider-error-parser.test.js .pipeline/lib/agent-launcher/__tests__/onSpawnExit.test.js` → ambos existen.
- **CA-8**: el audit log `.pipeline/logs/spawn-exit-*.jsonl` valida con `verifyChain`.
- **CA-9**: `grep PIPELINE_GENERALIZED_PARSER_ENABLED .pipeline/lib/agent-launcher/dispatch-with-fallback.js` matchea el flag.

---

## 11. Fallback in-flight del Commander (#3275)

**Estado**: implementación core entregada en #3275 (Ola N+2, 2026-05-21). Continuación natural de #3258 (pre-spawn) — cierra CA-3 del padre cubriendo el caso del primario que arranca OK pero **cae mid-turn**.

### 11.1 Cuándo entra en juego

- El provider primario aceptó el child y arrancó el stream (al menos un byte recibido). NO aplica si el spawn nunca emite — eso lo cubre el path pre-spawn de #3258.
- A partir de ese punto, alguna de estas señales fuerza fallback in-flight:
  - **5xx** del provider en cualquier turn post-spawn.
  - **Timeout sin nuevo byte de stdout durante 30s** desde el último output (NO desde spawn).
  - **EOF prematuro** del stream (cierre sin respuesta completa).
- El clasificador es [`.pipeline/lib/commander/provider-error-parser.js#parseProviderError`](../../.pipeline/lib/commander/provider-error-parser.js) (§10), que mapea raw output → `errorClass ∈ { transient_5xx | timeout_no_new_bytes_30s | eof_premature | rate_limit | ... }`.

### 11.2 Cuándo NO entra

- Spawn lento (sin primer byte) → eso es pre-spawn (#3258 path).
- Resultado exitoso del primario (happy path).
- Errores permanentes (`auth`, `permanent_failure`) — esos NO disparan fallback in-flight; respuesta canned al usuario y degradación del provider.

### 11.3 Decisiones operativas cerradas por PO

| Decisión | Valor adoptado | CA |
|---|---|---|
| Política de output parcial | **Descarte total**. Hash SHA-256 al audit; contenido NO se entrega ni se concatena | CA-3 |
| Detector de timeout | **Desde primer byte de stdout** (no desde spawn) | CA-1 |
| Threshold timeout in-flight | **30s** sin nuevo byte | CA-1 |
| UX al usuario | **Verbose**: `⚠️ <motivo> — reintentando con <secundario>.` | CA-5 |
| Accounting | **Ambos costos al accounting interno** (no transferible al user) | CA-10 |
| Cap de intentos | **1 fallback in-flight** (2 totales por turn) | CA-2 |
| Pre-validación credenciales | **Todas al boot del Pulpo**; provider sin cred → degraded del ranking | CA-9 |
| Audit log | **Hash-chain SHA-256 con file-lock cross-process** (`<file>.lock` O_EXCL) | CA-8 |
| Budget global | **90s SR-5** desde spawn del primario | CA-7 |
| Late-response del primario | **Descarte silencioso** + `late_response_discarded` + lock por `chat_id+request_id` | CA-4 |

### 11.4 Diagrama de secuencia (happy + failure paths)

```
Usuario ── /comando ──▶ Pulpo (ejecutarClaude)
                         │
                         ├─ sanitizeUserPrompt (SR-4)
                         ├─ resolveCommanderProvider (#3258, pre-spawn)
                         ├─ enforceDataResidency (SR-1)
                         │
                         ├─ spawn primario (anthropic, ej.)
                         │   ├─ stream OK ────────────▶ resolve(respuesta) ✅
                         │   │
                         │   └─ falla in-flight (5xx | timeout | EOF)
                         │       │
                         │       ▼
                         │   decideInflightFallback({ primaryProvider, errorClass,
                         │                            durationMs, partialOutput,
                         │                            attemptIndex: 0, requestId })
                         │       │
                         │       ├─ attemptIndex >= 1?  ── sí ──▶ cap_exhausted + canned ❌
                         │       ├─ durationMs >= 90s?  ── sí ──▶ global_budget_exceeded + canned ⏱️
                         │       ├─ secundario degraded? ── sí ──▶ all_invalid_credentials + canned ❌
                         │       └─ retornar { shouldRetry: true, secondaryProvider, noticeText UX-G1 }
                         │
                         ├─ sendTelegram(noticeText)  "⚠️ <motivo> — reintentando con X."
                         ├─ enforceDataResidency(secondary)  ◀── re-ejecutar (CA-6)
                         ├─ spawn secundario
                         │   ├─ stream OK ────────────▶ resolve(respuesta)
                         │   │                          acquireInflightLock(chatId, requestId)
                         │   │                          noteInflightCompleted(success: true) ✅
                         │   │
                         │   └─ también falla ───────▶ canned ❌
                         │                            noteInflightCompleted(success: false)
                         │
                         └─ (eventualmente) primario responde tarde
                             └─ isLateResponseDuplicate? ── sí ──▶ descartar
                                                                   noteLateResponseDiscarded ℹ️
```

### 11.5 Eventos del audit log (`commander-dispatch-YYYY-MM-DD.jsonl`)

| Evento | Payload clave | Trigger |
|---|---|---|
| `inflight_fallback_initiated` | `primary_provider`, `primary_error_class`, `partial_output_hash`, `request_id`, `chat_id_hash`, `primary_duration_ms` | Se decide intentar el secundario |
| `inflight_fallback_completed` | `primary_provider`, `secondary_provider`, `success: bool`, `secondary_duration_ms`, `secondary_tokens`, `cache_miss_due_to_provider_change` | Secundario terminó (éxito o falla) |
| `inflight_fallback_exhausted` | `cap`, `primary_provider`, `partial_output_hash` | Segundo intento también falla → canned ❌ |
| `inflight_fallback_global_timeout` | `primary_duration_ms`, `budget_ms` | Budget global 90s superado |
| `inflight_fallback_all_gated` | `chain_tried` | No hay candidato libre |
| `inflight_fallback_invalid_credentials` | `candidate_provider` | Secundario degraded por precheck |
| `inflight_fallback_resolver_error` | `error_message` | Excepción interna del resolver (fail-closed) |
| `late_response_discarded` | `primary_provider`, `partial_output_hash` | Late-response del primario llegó después del cierre del turn |

Todos los eventos viajan por la misma cadena hash-chain SHA-256 vía `lib/audit-log.js#appendChained`. El append es **read-then-write con file-lock**: `<archivo>.lock` se crea con `O_EXCL`, retry con backoff hasta 5s, lockfile >30s se considera huérfano y se sobreescribe.

### 11.6 Trade-offs y decisiones de diseño

**¿Por qué descarte total del partial output (no concatenación)?**
Security A03 (Injection output-side). Si concatenáramos los tokens parciales del primario al contexto del secundario, abriríamos vector de inyección via output hostil: un primario adversarial podría meter tokens que el secundario interpretaría como instrucciones nuevas. Descarte total elimina esa superficie. Costo: el secundario empieza desde el prompt sanitizado original, sin re-procesar (mismo SR-4 idempotente).

**¿Por qué notificación verbose (no silenciosa)?**
Transparencia operativa. Si Leo ve dos audios o latencia inusual, debe entender que hubo fallback. La regla `feedback_telegram-messages-natural.md` exige voseo argentino: `⚠️ <primario> tuvo un error del servidor — reintentando con <secundario>.` (NO `⚠️ Retrying with X` ni `[ERROR_5XX]`). El TTS de Murble **no** se dispara para el aviso intermedio (regla `feedback_audio-consolidation.md`); recién con la respuesta final del secundario.

**¿Por qué cap=1 fallback?**
Anti cost-amplification. Un primario adversarial diseñado para timeout intencional duplicaría tokens consumidos por turn si dejáramos cap > 1. Mantener cap=1 + budget 90s mantiene el peor caso acotado: ~2x el costo de un turn normal.

**¿Por qué budget 90s?**
Coincide con el límite ya documentado en `lib/commander/multi-provider.js:35-37` como primitiva reservada por #3258 para que #3275 la use. 90s es el corte superior de "el usuario todavía espera" en Telegram; pasado eso, mejor canned timeout que dejarlo colgado.

**¿Por qué pre-validar credenciales al boot (no mid-flight)?**
Si descubrimos mid-flight que el secundario no tiene credencial, el síntoma (timeout / canned response) es indistinguible de un timeout real → punto ciego diagnóstico. Pre-validar al boot devuelve un snapshot inmutable que el decisor consulta antes de elegir secundario. Costo: revocar una credencial requiere restart del Pulpo para refrescar el snapshot — política del PO acordada (no se cachea con TTL).

**¿Por qué file-lock cross-process en audit?**
Bajo `restart.js`, el pulpo viejo y el nuevo pueden solapar unos segundos. Sin lock, ambos leen el mismo `hash_prev` y escriben entries con cadena idéntica → chain rota → `verifyChain()` falla. El lock O_EXCL no requiere deps externas, es rápido (lockfile vacío) y tiene cleanup automático por staleness (>30s).

### 11.7 UX-G1 — copy en español argentino natural

| errorClass | Copy generado |
|---|---|
| `transient_5xx`, `5xx` | `⚠️ <primario> tuvo un error del servidor en medio de la respuesta — reintentando con <secundario>.` |
| `timeout_no_new_bytes_30s`, `timeout` | `⚠️ <primario> se quedó en silencio (sin nueva respuesta hace 30s) — reintentando con <secundario>.` |
| `eof_premature` | `⚠️ <primario> cortó la respuesta antes de tiempo — reintentando con <secundario>.` |
| `rate_limit` | `⚠️ <primario> pegó contra el rate-limit a mitad del turno — reintentando con <secundario>.` |

Si el secundario no soporta tool_use (hoy ninguno del plantel; lo era Cerebras, retirado en #6563), se agrega segunda línea ℹ️ (UX-G3):

```
ℹ️ Modo conversacional: el commander no puede ejecutar comandos del pipeline en este request.
```

Emojis permitidos: **solo ⚠️ y ℹ️** para el flujo in-flight, **❌** para el exhausted canned y **⏱️** para el budget-exceeded canned. Cualquier otro emoji rompe la identidad consistente del Commander (UX-G7).

### 11.8 Operativa: cómo invocar desde `ejecutarClaude` (esquema)

El módulo es decisión pura — el caller (typically `pulpo.js#ejecutarClaude`) orquesta:

```js
const inflight = require('./lib/commander/inflight-fallback');
const credPrecheck = require('./lib/commander/credentials-precheck');

// 1. Al boot del Pulpo:
const precheckRaw = credPrecheck.precheckCommanderProviderRanking({
    pipelineDir: PIPELINE,
    processEnv: process.env,
});
if (precheckRaw.allFailed) {
    log('boot', credPrecheck.formatPrecheckReport(precheckRaw));
    sendTelegramAlert('❌ Commander sin LLMs disponibles — abortando.');
    process.exit(2);
}
const precheck = credPrecheck.makePrecheckHandle(precheckRaw);

// 2. Por turn, cuando el primario falla in-flight:
const requestId = inflight.generateRequestId({ chatId });
const decision = inflight.decideInflightFallback({
    primaryProvider: resolution.provider,
    primaryErrorClass: verdict.errorClass,
    primaryDurationMs: Date.now() - spawnStart,
    primaryPartialOutput: stdoutBufferedFromPrimary,
    attemptIndex: 0,
    pipelineDir: PIPELINE,
    chatId, requestId,
    credentialsPrecheck: precheck,
    log,
});

if (!decision.shouldRetry) {
    sendTelegramPlain(decision.cannedResponse);
    return;
}

sendTelegramPlain(decision.noticeText);
// Re-ejecutar enforceDataResidency con secundario (CA-6 fail-closed)…
// Spawn secundario…
// Al entregar respuesta:
inflight.acquireInflightLock({ chatId, requestId, secondaryProvider: decision.secondaryProvider });
inflight.noteInflightCompleted({
    pipelineDir: PIPELINE,
    primaryProvider, secondaryProvider: decision.secondaryProvider,
    success: true, secondaryDurationMs, secondaryTokens, chatId, requestId,
});

// Si más tarde llega late-response del primario:
if (inflight.isLateResponseDuplicate({ chatId, requestId })) {
    inflight.noteLateResponseDiscarded({
        pipelineDir: PIPELINE, primaryProvider,
        partialOutput, chatId, requestId,
    });
    // NO entregar al user.
}
```

### 11.9 Métricas y observabilidad

Eventos en el audit log del día permiten calcular (futuro endpoint dashboard `/api/multi-provider/commander-inflight-stats`):

- `inflight_fallback_rate` — `count(inflight_fallback_initiated) / count(dispatch)` en ventana 24h.
- `inflight_fallback_success_rate` — `count(completed && success) / count(initiated)`.
- `late_response_discard_rate` — `count(late_response_discarded) / count(initiated)`.
- `cost_amplification_factor` — sum tokens primario + sum tokens secundario / sum tokens del intento exitoso solo.

### 11.10 Out of scope

- Rate-limit por `chat_id` del Commander → cubierto por **#3454** (recomendación de security pendiente de aprobación humana, no bloquea).
- Streaming concatenado de output parcial (rechazado por seguridad, CA-3).
- Cobro al usuario por failure de infra (rechazado por política, CA-10).
- Auto-degradación dinámica del ranking ante alto failure rate en ventana móvil → recomendación futura si se observa necesidad.
- **Wire-up live en `pulpo.js#ejecutarClaude`**: la primitiva está entregada y testeada; el wire-up con el readline de Anthropic (Claude CLI) requiere instrumentar el "first-byte timer" y el detector de stream gap dentro del loop sync — se entrega como follow-up dedicado para no comprometer el HARD_TIMEOUT de 10min ya en producción.

### 11.11 Tests

- `.pipeline/lib/__tests__/commander-inflight-fallback.test.js` — 28 tests cubriendo CA-1..CA-9, formato UX-G1, file-lock, late-response.
- `.pipeline/lib/__tests__/commander-multi-provider.test.js` — sin regresión.
- `.pipeline/lib/__tests__/audit-log.test.js` — sin regresión (lock es opt-in vía param `lockMaxMs:0` en tests legacy).

---

## 12. Sherlock verifier — timeout y providers (#3484)

> **Issue de origen:** [#3484](https://github.com/intrale/platform/issues/3484) — quitar timeout local y eliminar requisito cross-provider.
> **Predecesor:** [#3343](https://github.com/intrale/platform/issues/3343) Sherlock base + [#3342](https://github.com/intrale/platform/issues/3342) HTTP completion-client.

### 12.1 Decisión arquitectónica (CA-DOC-3)

Sherlock acepta dos transportes para invocar providers:

- **HTTP completion-client** (`lib/multi-provider/completion-client.js`) — para providers OpenAI-compat por API key. **Hoy la lista está vacía**: `HTTP_COMPLETION_PROVIDERS = new Set([])` (`sherlock-verifier.js`). `cerebras` y `nvidia-nim` se retiraron en #6563; el shim de AI Studio del ex "Gemini (Google)" se retiró en #6861 porque no servía ningún id del catálogo de Antigravity (404 en toda la cascada). El cliente se conserva (con tablas vacías y hook `_setProviderTablesForTesting` para mantener su cobertura) por si §16 admite un provider por API key.
- **Spawn CLI** — `SPAWN_COMPLETION_PROVIDERS = {anthropic, openai-codex, antigravity}`. Cada uno reusa el handler del `agent-launcher`: `providers/anthropic.js::buildSpawn` (prompt por stdin, `--output-format text`), `providers/openai-codex.js` (`spawnCodexComplete`, prompt como argumento, stdout JSONL de `codex exec --json`; transporte real desde PR #3792) y `providers/antigravity.js` (`spawnAntigravityComplete`, #6861: prompt por stdin como NDJSON con `--input-format stream-json`, `ANTIGRAVITY_MODEL` en el env, se lee el evento `{"event":"result"}` del stream). **Opción B** del issue #3484, elegida por: (a) reusa la infra existente y bien testeada, (b) evita refactor multi-schema del cliente HTTP para soportar APIs que no son OpenAI-compat, (c) recommendation explícita de PO y guru en la fase `criterios`.

`antigravity` llega al Sherlock por el mismo binario `agy` y la misma OAuth que corren los agentes — sin API key ni endpoint HTTP. Verificable: `_resolveSherlockProvider({ initialExcluded: ['anthropic', 'openai-codex'] })` → `{ provider: 'antigravity', transport: 'spawn' }`.

### 12.2 Cambios concretos respecto al estado pre-#3484

| Comportamiento | Pre-#3484 | Post-#3484 |
|---|---|---|
| Filtro de providers | Solo HTTP-compatible (entonces `cerebras`, `antigravity`, `nvidia-nim`) | Cualquier provider con handler implementado (HTTP o spawn) |
| Exclusión cross-provider | Forzaba provider != Commander | Removida — permite same-provider (riesgo aceptado) |
| Timeout local | Default 10s, clamp absoluto 30s | Removido — delegado a `completion-client` (90s default, 180s cap) |
| Phrasing F-5/F-6 | Genérico, jerga técnica | Empático, primera persona, invita feedback (CA-UX-3, CA-UX-4) |
| Audit log | `commanderProvider`, `sherlockProvider` | + `sameProvider`, `sameModel`, `commanderModel`, `transport` (CA-AUDIT-1) |

### 12.3 Timeout y cap defensivo

El presupuesto temporal vive en **dos lugares**:

1. **`lib/multi-provider/completion-client.js`**:
   - `DEFAULT_TIMEOUT_MS = 90_000` (90 s) — usado si el caller no pasa override.
   - `ABSOLUTE_MAX_TIMEOUT_MS = 180_000` (3 min) — cap defensivo, **no removible** por el caller. Si alguien pasa `timeoutMs: 999999`, el cliente lo clampea silenciosamente.
2. **`pulpo.js` turn handler** (`procesarTextoLibre`):
   - `SHERLOCK_SOFT_TIMEOUT_MS = 120_000` (2 min) — soft-timeout que envuelve `verify()` + reelaboración + 2da `verify()`. Si dispara, el chat recibe el mensaje **CA-UX-2** sin jerga técnica y degradamos a disclaimer F-6.

`config.yaml` mantiene `sherlock_timeout_ms` como **NO-OP** (back-compat con configs viejas). El loader lo ignora silenciosamente sin warn-spam. Removerlo en una próxima limpieza junto con los callers que lo lean.

### 12.4 Adversariality reducida (riesgo aceptado)

Pre-#3484, Sherlock garantizaba que su provider fuera distinto al del Commander para que dos modelos con biases distintos pudieran detectar contradicciones. Eso reducía la chance de un blind-spot compartido, pero en la práctica causaba fallback en cascada → timeout → F-6 silencioso constante.

Leo aprobó (voz 2026-05-22) **aceptar el riesgo de adversariality reducida** a cambio de tener Sherlock funcionando consistentemente con razonamiento de buena calidad (Anthropic Haiku 4.5). Para no perder visibilidad del riesgo, el audit log emite:

```json
{
  "event": "sherlock_verification",
  "commander_provider": "anthropic",
  "sherlock_provider": "anthropic",
  "same_provider": true,
  "same_model": false,
  "commander_model": "claude-opus-4-7",
  "sherlock_model": "claude-haiku-4-5",
  "transport": "spawn",
  "duration_ms": 47000
}
```

**Métrica a monitorear** (alert futuro, no implementado en este issue): si `same_provider:true` supera el 80% del último día, alertar al operador — significa que la chain de fallback se está agotando antes de cambiar de provider. Issue de seguimiento abierto para dashboard widget.

### 12.5 UX en Telegram (CA-UX-1, CA-UX-2)

- **CA-UX-1 — typing refresh loop**: `pulpo.js::sendChatActionTyping()` se invoca cada 4 s mientras Sherlock corre. Sin este loop el indicador "escribiendo..." de Telegram fade-out a los ~5 s y el usuario siente que el bot se colgó. POST directo a `api.telegram.org/sendChatAction` (sin pasar por `svc-telegram` porque el servicio no maneja la acción y el indicador pierde valor si se atrasa por la cola).
- **CA-UX-2 — soft-timeout 120 s**: si Sherlock + reelaboración + 2da pasada toma más de 2 min, mandamos `"Esta respuesta me está tomando más tiempo de lo normal. Te muestro la versión sin verificar — si querés, podemos revisarla juntos cuando me confirmes."` en lugar de bloquear el chat indefinidamente. La respuesta original se envía con disclaimer F-6.
- **CA-UX-3 / CA-UX-4 — phrasing**: ver `lib/sherlock-verifier.js` constantes `DISCLAIMER_F5_PERSISTENT_INCONSISTENCY` y `DISCLAIMER_F6_VERIFICATION_FAILED`.

### 12.6 Verificación operativa post-deploy

Después de un `/restart` con este cambio activo:

```bash
# El audit log debe mostrar Anthropic como sherlock_provider primario.
grep '"event":"sherlock_verification"' .pipeline/logs/commander-dispatch-*.jsonl | tail -10

# Si todo el audit log tiene sherlock_provider != anthropic, la chain de
# resolución no está agarrando el primer entry — bug. Espera-do (chain
# anthropic-first aprobada en PR #3483):
#   sherlock_provider: "anthropic"
#   transport: "spawn"
#   same_provider: true  ← porque Commander también usa anthropic hoy
```

Si en producción `transport: "spawn"` no aparece nunca, posibles causas:
1. Anthropic está gateado por cuota → Sherlock cae a antigravity (correcto, ver chain).
2. El launcher `claude` no se detecta en runtime → revisar `agent-launcher/providers/anthropic.js::detectLauncher`.
3. La chain `telegram-sherlock` en `agent-models.json` cambió → confirmar PR #3483 mergeado.

### 12.7 Tests

- `.pipeline/lib/__tests__/sherlock-verifier.test.js` — 39 tests cubriendo HTTP path, spawn path, audit enriquecido, back-compat, timeout cap, phrasing UX-3/UX-4.
- `.pipeline/lib/__tests__/completion-client.test.js` — 37 tests + nuevos casos del cap absoluto.

Correr:
```bash
node --test .pipeline/lib/__tests__/sherlock-verifier.test.js
node --test .pipeline/lib/__tests__/completion-client.test.js
```

### 12.8 Swap intra-provider para preservar adversariality (#3501)

Mejora incremental sobre §12.4. Cuando Sherlock termina usando el mismo provider y el mismo modelo que el Commander, la policy de swap intra-provider intenta diferenciar el modelo (dentro del mismo provider) antes de aceptar la coincidencia. Esto recupera adversariality parcial — un blind-spot de `claude-opus-4-7` no necesariamente coincide con el de `claude-haiku-4-5` por diferencias en distillation, training data y temperature defaults.

#### Comportamiento

| Caso | Antes (#3484) | Post-#3501 |
|---|---|---|
| `commander=anthropic/opus`, sherlock chain ofrece `anthropic/haiku` (config #3221) | `same_provider:true`, `same_model:false` — sherlock usa haiku, NO dispara swap | Igual — el `model_override` ya diferencia, swap es no-op |
| `commander=antigravity/gemini-2.0-flash`, chain ofrece `antigravity/gemini-2.0-flash` (mismo modelo) | `same_provider:true`, `same_model:true` — adversariality reducida aceptada | El resolver lee `alternative_models[]` del provider y elige `gemini-1.5-flash`; emite `sherlock_model_swap`. Resultado final: `sameModel:false` |
| `commander=openai-codex/gpt-5.4`, chain ofrece `openai-codex/gpt-5.4`, provider SIN `alternative_models` declarado | `same_provider:true`, `same_model:true` — aceptado | Igual — default-safe, política inactiva (opt-in puro) |

#### Cómo configurarlo

En `agent-models.json` se declara `alternative_models: string[]` opcional dentro de `providers.<name>`:

```json
{
  "providers": {
    "antigravity": {
      "model": "gemini-3.8-flash-medium",
      "alternative_models": ["gemini-3.7-flash-medium"]
    }
  }
}
```

Cada modelo de `alternative_models[]` debe estar en `ALLOWED_MODELS_BY_LAUNCHER` de `lib/agent-models-validate.js`. Si declarás un modelo fuera de la allowlist, el boot del pulpo aborta con exit code 2 (defensa anti-supply-chain, CA-SEC-SWAP-1).

#### Default-safe

- Provider SIN `alternative_models` → la policy es inactiva. El comportamiento es idéntico a §12.4 (acepta `same_provider:true, same_model:true` como riesgo aceptado).
- Provider CON `alternative_models` vacío después de filtrar el modelo del Commander → idem (la policy no encuentra candidato real, mantiene mismo provider).
- `anthropic` y `openai-codex` no declaran `alternative_models` porque su diferenciación de modelo ya está resuelta vía `model_override` en `skills.telegram-sherlock` (config #3221). `telegram-commander` apunta a `claude-opus-4-7`, `telegram-sherlock` a `claude-haiku-4-5` — `sameProvider:true`, `sameModel:false` sin necesidad de swap.

#### Caps defensivos

- `maxItems: 3` en el schema sobre `alternative_models[]` — anti-cost-amplification (CA-SEC-SWAP-2).
- `HARDCODED_MAX_MODEL_SWAPS = 2` en runtime — defense in depth, cap independiente del schema (CA-SEC-SWAP-3).
- El swap **NO** consume budget de reelaboración (CA-SEC-9 invariante `HARDCODED_MAX_REELABORACIONES=1` intacto). El swap ocurre dentro de la misma verificación, no es un turn nuevo (CA-SEC-SWAP-4).

#### Evento de audit `sherlock_model_swap`

Cuando dispara la policy, emite una entry adicional al JSONL del día:

```json
{
  "event": "sherlock_model_swap",
  "provider_effective": "antigravity",
  "swap_model_origen": "gemini-2.0-flash",
  "swap_model_destino": "gemini-1.5-flash",
  "swap_reason": "same_model_avoidance",
  "same_provider": true,
  "same_model": false,
  "commander_model": "gemini-2.0-flash",
  "sherlock_model": "gemini-1.5-flash",
  "transport": "http"
}
```

Filtrado típico para análisis operativo:

```bash
jq 'select(.event=="sherlock_model_swap")' .pipeline/logs/commander-dispatch-*.jsonl

# Frecuencia de swap por provider (última semana)
jq -r 'select(.event=="sherlock_model_swap") | .provider_effective' \
  .pipeline/logs/commander-dispatch-*.jsonl | sort | uniq -c
```

#### UX en Telegram (CA-11)

`lib/sherlock-verifier.js::formatVerifiedFooter()` produce una línea informativa para el caller (pulpo.js) cuando Sherlock verifica:

- Sin swap: `Verificado por: anthropic/claude-haiku-4-5`
- Con swap: `Verificado por: antigravity/gemini-1.5-flash (swap desde gemini-2.0-flash)`

Reglas UX (CA-UX-SWAP-1): UNA línea, sin emojis, sin tono celebratorio. La diferencia es informativa, no celebratoria — respeta `feedback_telegram-messages-natural.md` y `project_v3-efficiency-priority.md`.

#### Métrica de éxito (post-merge, ventana 1-2 semanas)

- `same_provider:true` mantiene el orden de magnitud actual (no se penaliza por el cambio).
- `same_model:true` cae a < 20 % del subset `same_provider:true` (objetivo del #3501).
- Evento `sherlock_model_swap` aparece al menos una vez por provider que declare `alternative_models` (prueba de que la policy se ejercita).
- Cero incidentes de boot abortado por `alternative_models` mal declarado (gracias a CA-SEC-SWAP-1).

#### Tests

- `#3501 CA-14`: anthropic opus↔haiku via config #3221 NO dispara swap (modelos ya distintos).
- `#3501 CA-15`: swap intra-provider en antigravity emite `sherlock_model_swap` con campos diferenciados.
- `#3501 CA-16 (CA-SEC-SWAP-6)`: `alternative_models` con modelo fuera de allowlist → `validate()` exit code 2.
- `#3501 CA-17`: invariante cap reelaboración=1 intacto, swap NO consume budget.
- `#3501 CA-18`: provider sin `alternative_models` → comportamiento post-#3484 preservado (default-safe, opt-in puro).
- `#3501 CA-11`: `formatVerifiedFooter` incluye `(swap desde X)` cuando aplica.

---

## 13. Alerta y switch preventivo por cuota de proveedor (#4282)

Capa de **resiliencia anticipatoria**: avisa y —opcionalmente— degrada el
proveedor primario **antes** de quedarse sin cuota, en vez de descubrirlo al
reventar (incidente del fin de semana 27-28/06, Anthropic semanal al límite).

Ortogonal al desacople kernel↔producto (Ola 8). Vive 100% en `.pipeline/`
(Node puro, sin dependencias nuevas).

### 13.1 Componentes

| Pieza | Archivo | Rol |
|---|---|---|
| Guard (núcleo) | [`.pipeline/lib/provider-quota-guard.js`](../../.pipeline/lib/provider-quota-guard.js) | Lee el slice por proveedor, clasifica contra umbrales de `config.yaml`, emite alerta anticipada (Telegram FS-queue + banner) con dedupe y —si el switch está ON— escribe el marker de degradación preventiva. |
| Config | [`.pipeline/config.yaml`](../../.pipeline/config.yaml) → `multi_provider.quota_alert` | Umbrales `<provider>.{warn,crit}` + `preventive_switch.enabled` (default **false**). |
| Ticker host | [`.pipeline/lib/quota-snapshot-integration.js`](../../.pipeline/lib/quota-snapshot-integration.js) → `evaluateProviderQuotaGuard()` | Engancha la evaluación periódica en el ciclo del snapshot (no crea cron nuevo). |
| Trigger en vivo | [`.pipeline/lib/dashboard-slices.js`](../../.pipeline/lib/dashboard-slices.js) → `quotaSlice` | El poll del dashboard (`/api/dash/quota`) corre el guard de forma idempotente reusando el slice ya normalizado (sin re-extracción). Expone `out.preventiveAlert`. |
| Banner read-only | `dashboard-slices.js` → `providerQuotaBannerSlice` | Lee el banner vigente del estado del guard. Shape mínimo. |
| Consumo del switch | [`.pipeline/lib/agent-launcher/dispatch-with-fallback.js`](../../.pipeline/lib/agent-launcher/dispatch-with-fallback.js) → `resolveSpawnWithFallback` | Si hay marker vigente, trata al primary como **soft-gated**: prefiere el primer fallback resoluble. |

**Fuente de dato (reuso, NO re-extracción):** el guard consume el shape público
por proveedor de `quotaSlice`:
`providers[p] = { provider, adapterStatus, session:{pct,confidence}, weekly:{pct,confidence} }`.
No toca snapshots crudos, tokens ni material de auth.

### 13.2 Configuración (`config.yaml`)

```yaml
multi_provider:
  quota_alert:
    defaults:            # usados si un proveedor no declara los suyos
      warn: 80
      crit: 95
    anthropic:           # umbrales por proveedor (% del límite)
      warn: 80
      crit: 95
    openai-codex:
      warn: 80
      crit: 95
    antigravity:
      warn: 80
      crit: 95
    preventive_switch:
      enabled: false           # palanca del switch preventivo (default OFF)
      marker_ttl_minutes: 90   # vigencia del marker de degradación (respaldo)
```

**Validación fail-safe (REQ-SEC-2):** cada par debe cumplir
`0 < warn < crit <= 100` numérico. Ante un valor inválido se cae a `defaults`
y se loggea, **sin romper el ticker**. `preventive_switch.enabled` solo activa
el switch con `true` literal.

### 13.3 Umbrales y niveles

- `pct >= crit` → **crit** (🔴): alerta + (si switch ON) degradación preventiva.
- `warn <= pct < crit` → **warn** (🟡): solo alerta.
- `pct < warn` → **ok**: limpia banner + marker + resetea el dedupe.

### 13.4 Gate de integridad — `confidence === 'fresh'` (REQ-SEC-4)

**Invariante duro:** ninguna acción (alerta ni switch) sobre dato
`stale`/`missing`/`parser-offline`. Un dato viejo o ausente no dispara nada.
No se resetea el estado por `stale` (evita un falso "recuperado" y el
re-alerteo posterior cuando el dato vuelve fresco en el mismo nivel).

### 13.5 Anti-flapping / histéresis (CA-8)

Dedupe por **high-water-mark**: una sola alerta por **subida** de nivel
(ok→warn, warn→crit, ok→crit). Bajar dentro de la banda (crit→warn sin tocar
`ok`) **no** re-alerta ni oscila el marker. El reset (y un nuevo ciclo de
alertas) ocurre recién al volver a `ok`. El marker preventivo se sostiene
mientras siga `crit` y se limpia al recuperar `ok`, con TTL de respaldo
anti-zombie.

### 13.6 Precedencia preventivo (soft) ↔ reactivo (hard) — REQ-SEC-3 / CA-7

| Mecanismo | Tipo | Efecto |
|---|---|---|
| `quota-exhausted.json` / `provider-exhaustion-pause` | **hard gate** | **pausa** el spawn (o salta a fallback y, si no hay, devuelve a `pendiente/`). |
| marker de degradación preventiva (#4282) | **soft gate** | **degrada**: prefiere fallback, pero **NUNCA pausa ni vacía la chain**. |

Reglas:
- El soft **solo** aplica si el primary **no** está hard-gated (el hard manda).
- El soft **nunca** fuerza el hard ni lo convierte en pausa.
- Si el soft degrada pero **no hay fallback resoluble**, se usa el **primary**
  igual (`softGatedPrimaryUsed: true`). La chain nunca queda vacía (anti-DoS
  interno).

### 13.7 Matriz de cobertura por proveedor

| Proveedor | Sesión | Semanal | Switch preventivo |
|---|---|---|---|
| `anthropic` | sí (si hay snapshot fresco) | **sí** | **sí** — el caso del incidente 27-28/06. |
| `openai-codex` | no (sin ventana de sesión 5h) | si hay dato fresco (presupuesto mensual) | si cruza `crit` con dato fresco. |
| `antigravity` / free-tier | buckets `missing` → no se alertan | idem | no aplica salvo dato fresco. |

Los buckets `missing` **no generan ruido**: el gate de `fresh` los descarta.

### 13.8 Seguridad

- **REQ-SEC-1:** la alerta/banner contienen **solo** `{provider, pct, window,
  confidence, level}` — sin API keys, tokens, JWT ni paths de credenciales.
  Defensa en profundidad: `containsSecret()` redacta el mensaje si detectara
  un patrón de secreto.
- **REQ-SEC-5:** cada degradación preventiva loggea `provider/pct/umbral/
  confidence` para trazabilidad.

### 13.9 Kill-switch / operación

- **Apagar el switch:** `preventive_switch.enabled: false` (default). Solo
  alerta, nunca degrada.
- **Apagar todo el guard:** `QUOTA_SNAPSHOT_ENABLED=false` (comparte kill-switch
  con el ciclo de snapshot; el ticker host no invoca el guard).
- **Limpiar una degradación atascada:** `rm .pipeline/.provider-preventive-degrade.json`
  (igual se auto-expira por `marker_ttl_minutes`).
- **Estado del guard:** `.pipeline/.provider-quota-guard-state.json` (dedupe +
  banner vigente).

### 13.10 Tests

[`.pipeline/lib/__tests__/provider-quota-guard.test.js`](../../.pipeline/lib/__tests__/provider-quota-guard.test.js)
(`node --test`): umbral cruzado fresh → alerta; stale/missing → no actúa;
switch off → solo alerta; switch on → marca degradación consumida por
`resolveSpawnWithFallback` (chain nunca vacía); precedencia hard↔soft;
anti-flapping; config inválida → fallback seguro; alerta sin secretos.
Cobertura del módulo nuevo: ~98% líneas / ~82% ramas / 100% funciones.

---

## 14. Documentación operativa multi-provider (post-ola N+1)

Sección **de cierre del épico multi-provider** (#3791, split D7 · #4405). Consolida,
en un solo lugar, cómo un operador **reproduce** las cuatro capas operativas que
entregaron los hijos #4401–#4404 y las **verifica sin adivinar**: smoke test,
telemetría de costo, health en vivo y failover. Todos los comandos de acá se
ejecutaron contra la implementación real en `main` y su salida está pegada desde
la ejecución (no inventada).

> **Higiene de secretos (obligatoria):** ningún comando de esta sección lleva
> keys literales. Las credenciales se hidratan con el cargador único
> [`.pipeline/lib/credentials.js`](../../.pipeline/lib/credentials.js) (fuente
> `~/.claude/secrets/credentials.json`) y se referencian por placeholder
> (`$ANTHROPIC_API_KEY`, `$OPENAI_API_KEY`, …; `antigravity` no usa API key, autentica por OAuth del CLI `agy`).
> **Regla del proyecto:** las API keys se cargan por terminal de Windows, **nunca
> por Telegram**, y viven solo en `credentials.json`. Toda evidencia (logs,
> screenshots) va **redactada** — sin JWT, `Authorization`, ni keys visibles.

### 14.1 Smoke test reproducible

El harness CLI que ejerce la matriz `skill × provider` es
[`.pipeline/tools/multi-provider-smoke-test.js`](../../.pipeline/tools/multi-provider-smoke-test.js)
(Node puro, sin deps). Building blocks DI en
[`.pipeline/lib/multi-provider/smoke-test.js`](../../.pipeline/lib/multi-provider/smoke-test.js).

**Invocación (produce: matriz de cobertura + audit hash-chain + sign-off Telegram):**

```bash
# Ayuda / flags disponibles
node .pipeline/tools/multi-provider-smoke-test.js --help

# Matriz completa (todos los skills LLM × todos los providers LLM)
node .pipeline/tools/multi-provider-smoke-test.js

# Acotar a una celda concreta (útil para diagnosticar un provider)
node .pipeline/tools/multi-provider-smoke-test.js --skill=qa --provider=antigravity

# Ensayo sin invocar providers (coverage con PASS stub) — no gasta cuota
node .pipeline/tools/multi-provider-smoke-test.js --dry-run --no-telegram --no-create-issues
```

**Requisito operativo (fail-closed):** el smoke **solo corre dentro de una ventana
de coordinación** — pausa total (`.pausa` → `.pipeline/.paused`) **o** pausa
parcial (`.pipeline/.partial-pause.json`) con `allowed_skills` incluyendo
`multi-provider-smoke-test`. Fuera de ventana aborta con `exit 2` **antes de tocar
ningún provider** (evita interferir con el pipeline productivo). Output real:

```text
[smoke-test] FATAL [smoke-test] El pipeline está 'running' sin ventana habilitada
para 'multi-provider-smoke-test'. Activar '.pausa' (halt total) O extender
'.partial-pause.json' con allowed_skills: ['multi-provider-smoke-test'].
# exit code = 2
```

**Salida esperada dentro de ventana** (ejemplo real, `--dry-run` acotado a
`qa × antigravity`; con credenciales presentes vía `credentials.js`):

```text
[smoke-test] Pipeline detenido (.pausa) — ventana segura.
[smoke-test] Matriz construida: 57 combinaciones (skills LLM × providers LLM).
[smoke-test] Tras filtros CLI: 1 combinaciones.
[smoke-test] Credenciales antigravity: OK (credenciales presentes)
[smoke-test] Skipped (--dry-run)
[smoke-test] coverage.json escrito (1 entries, summary={"pass":1,"warn":0,"fail":0,...})
{ "ok": true, "run_id": "run-...", "summary": { "pass": 1, ... },
  "coverage_path": ".../.pipeline/multi-provider-coverage.json", "fail_issues": [] }
# exit code = 0
```

**Degradado esperado:** si a un provider free le falta cuota/credencial, su celda
cae a `WARN`/`SKIPPED` (no rompe la corrida); los `FAIL` reales generan issue
automático (salvo `--no-create-issues`) con metadata segura (sin raw output del
provider). Artefactos que deja: `.pipeline/multi-provider-coverage.json` (matriz
canónica) y `.pipeline/audit/multi-provider-smoke-test-<fecha>.jsonl` (audit
hash-chain).

### 14.2 Telemetría y diagnóstico

El writer de telemetría de costo por provider es
[`.pipeline/lib/metrics/provider-cost.js`](../../.pipeline/lib/metrics/provider-cost.js)
(#4403 · D4; esquema v2 en #6558). El pulpo escribe **una línea JSON por ejecución
de agente** al cerrar su lifecycle ([`.pipeline/pulpo.js`](../../.pipeline/pulpo.js),
bloque on-exit independiente y *never-throws*). Desde #6558 también se anotan las
corridas determinísticas (`provider: "deterministic"`, tokens 0), así el archivo
tiene exactamente una línea por corrida.

**Ruta (fuente de verdad):** `.pipeline/state/provider-cost.jsonl` (resuelta por
`write-target.writePath(...)`, #7112 — no hardcodear).

> Es un **artefacto de runtime, no versionado**: no existe hasta que el pipeline
> (o el smoke) corre al menos un agente. Su ausencia con `ls` **no es un bug** —
> es el estado inicial en un checkout limpio.

#### Esquema v2 (#6558) — libro contable de cuota por proveedor

Whitelist estricta de 12 campos (asignación literal, sin spread; los numéricos
coercionados con `Number()`; los de texto sanitizados para redactar secretos y
stripear CR/LF anti log-injection):

| Campo | Tipo | Significado |
|---|---|---|
| `schema` | number | **`2`**. Versión de esquema visible; las líneas sin este campo son v1 (histórico) |
| `timestamp` | string | ISO 8601 **en UTC con sufijo `Z`**, momento de finalización de la corrida. La conversión a hora local es de quien lo muestra |
| `provider` | string | clave canónica del proveedor que **ejecutó de verdad** (`anthropic`, `openai-codex`, `antigravity`, `deterministic`) — en fallback vale el del fallback, no el declarado en el perfil del skill |
| `skill` | string | skill del agente (`backend-dev`, `guru`, …) |
| `issue` | number\|null | número de issue procesado |
| `fase` | string | fase del pipeline (`dev`, `validacion`, `verificacion`, …) |
| `tokens_in` | number | tokens de entrada (total canónico del adapter, no cacheados) |
| `tokens_out` | number | tokens de salida |
| `cache_read` | number | tokens leídos de cache (#7506); 0 si el adapter no lo informa |
| `cache_write` | number | tokens escritos a cache (#7506); 0 si el adapter no lo informa |
| `duration_ms` | number | duración de la ejecución en ms (canónico; reemplaza a `latency_ms` de v1) |
| `resultado` | string | **enum cerrado** `ganada` \| `error` \| `rebote` \| `abortada` (ver mapeo abajo) |

**Cómo se decide `resultado`** (en el handler de exit del pulpo, en este orden):

| Valor | Señal |
|---|---|
| `abortada` | el watchdog de timeout por skill mató al hijo |
| `rebote` | el detector de cuota clasificó la salida como `quota_exhausted` (el proveedor "dijo basta") — conserva el proveedor que rebotó y el timestamp |
| `ganada` | exit code 0 |
| `error` | cualquier otro exit ≠ 0 |

**Ejemplo de línea v2** (JSON válido — verificado con `JSON.parse`):

```json
{"schema":2,"timestamp":"2026-09-21T12:45:00.000Z","provider":"openai-codex","skill":"backend-dev","issue":6558,"fase":"dev","tokens_in":1234,"tokens_out":567,"cache_read":0,"cache_write":0,"duration_ms":390752,"resultado":"ganada"}
```

#### Esquema v1 (#4403, histórico) y compatibilidad

Hasta #6558 el writer emitía 7 campos:
`{ provider, skill, issue, tokens_in, tokens_out, latency_ms, status }`, **sin
timestamp** y con `provider` = el **declarado** para el skill (por eso las ~14.250
líneas históricas dicen `anthropic` aunque muchas corrieron en Codex/Gemini).

- El archivo es **append-only**: el histórico v1 **no se reescribe** ni se
  reinterpreta. Queda distinguible por la ausencia de `schema`.
- Los lectores (`readProviderCostRecords`, `readProviderCostBreakdown`,
  `readProviderCostByPeriod`) normalizan v1 → vocabulario v2 sólo en memoria
  (`latency_ms → duration_ms`; `status: ok → resultado: ganada`, `error… → error`;
  `timestamp: null`) y marcan cada registro con `reliable: false`.
- **Las líneas v1 NO se suman al bucket de ningún proveedor**: `byProvider` sólo
  agrega líneas confiables (v2). El histórico viaja aparte en
  `unreliable: { sessions, tokens_in, tokens_out }` / `hasUnreliable`, y el panel
  Costos lo muestra como "N corridas anteriores sin proveedor confiable".
- El writer sigue aceptando `latency_ms` / `status` como *input* (alias v1) y
  los persiste ya traducidos a v2; nunca emite `status` ni `latency_ms`.

**Nota de seguridad:** el archivo contiene **solo métricas** (proveedor, skill,
fase, tokens, duración, resultado). **No** guarda credenciales ni raw output del
provider. Si alguna vez apareciera material sensible en un campo de texto, es un
bug del sanitizador — reportar como hallazgo aparte.

#### Consultas (CA-4 de #6558): por proveedor y por día/semana

El entorno del pipeline es **Node puro (no hay `jq` instalado)**; el reader
canónico es el mismo módulo que consume el dashboard.

```bash
# 1) Agregación oficial por proveedor (la misma que alimenta la pantalla Costos)
node -e "const {readProviderCostBreakdown}=require('./.pipeline/lib/metrics/provider-cost'); \
  console.log(JSON.stringify(readProviderCostBreakdown({file:'.pipeline/state/provider-cost.jsonl'}),null,2));"
```

Salida (forma):

```json
{
  "hasData": true,
  "byProvider": {
    "anthropic":    { "tokens_in": 18234, "tokens_out": 2871, "cache_read": 0, "cache_write": 0, "sessions": 1, "errors": 0, "rebotes": 0, "abortadas": 0 },
    "openai-codex": { "tokens_in": 9120,  "tokens_out": 1440, "cache_read": 0, "cache_write": 0, "sessions": 2, "errors": 0, "rebotes": 1, "abortadas": 0 }
  },
  "totalSessions": 3,
  "hasUnreliable": true,
  "unreliable": { "sessions": 14262, "tokens_in": 1763977441, "tokens_out": 15818692 }
}
```

```bash
# 2) Serie por DÍA (UTC) y proveedor
node -e "const {readProviderCostByPeriod}=require('./.pipeline/lib/metrics/provider-cost'); \
  console.log(JSON.stringify(readProviderCostByPeriod({period:'day'},{file:'.pipeline/state/provider-cost.jsonl'}),null,2));"

# 3) Serie por SEMANA ISO (lunes a domingo, UTC) y proveedor — "¿por cuánto nos pasamos esta semana?"
node -e "const {readProviderCostByPeriod}=require('./.pipeline/lib/metrics/provider-cost'); \
  console.log(JSON.stringify(readProviderCostByPeriod({period:'week'},{file:'.pipeline/state/provider-cost.jsonl'}),null,2));"
```

Salida (forma): `{ period: 'week', series: { '2026-W38': { anthropic: {…}, 'openai-codex': {…} }, '2026-W39': {…} }, unreliableSessions: 14262 }`
— las claves de `series` vienen ordenadas y cada bucket tiene la misma forma que
en `byProvider`.

```bash
# 4) Sin el módulo (one-liner Node, sin deps): rebotes por cuota por proveedor y día
node -e 'const fs=require("fs"); \
  const rows=fs.readFileSync(".pipeline/state/provider-cost.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse) \
    .filter(r=>r.schema>=2); \
  const by={}; for(const r of rows){const k=r.timestamp.slice(0,10)+" "+r.provider; const b=by[k]??={corridas:0,rebotes:0,tokens:0}; \
  b.corridas++; b.tokens+=r.tokens_in+r.tokens_out; if(r.resultado==="rebote")b.rebotes++;} \
  console.log(JSON.stringify(by,null,2));'
```

El filtro `r.schema>=2` es obligatorio en consultas ad-hoc: las líneas v1 no
tienen `timestamp` ni proveedor confiable.

Degrada a `{ hasData:false, byProvider:{}, totalSessions:0, hasUnreliable:false, … }`
si el archivo falta o está vacío (never-throws).

### 14.3 Health check en tiempo real

El health honesto por provider (#4402 · D3) lo produce el cron
[`.pipeline/lib/multi-provider/health-cron.js`](../../.pipeline/lib/multi-provider/health-cron.js),
con render en
[`.pipeline/lib/multi-provider/health-screen.js`](../../.pipeline/lib/multi-provider/health-screen.js)
y alertas en
[`.pipeline/lib/multi-provider/health-alerts.js`](../../.pipeline/lib/multi-provider/health-alerts.js).

| Pieza | Cómo se consulta | Qué muestra |
|---|---|---|
| Cron (idempotente) | `tickIfDue()` llamado c/minuto por el pulpo/dashboard | pingea `/v1/models` (**no** consume cuota) cada ~5 min |
| CLI (fuerza corrida) | `node .pipeline/lib/multi-provider/health-cron.js` | corre `runOnce` (no respeta el lock) |
| Estado (dashboard lee) | `.pipeline/state/multi-provider-health.json` | snapshot `{ ts, providers[], green/yellow/red_count }` |
| Pantalla en vivo | `http://localhost:3200/multi-provider-health` | vista HTML por provider (estado, reason, latencia, key_status) |
| API de cuota | `http://localhost:3200/api/dash/quota` | slice normalizado `quotaSlice` (pct sesión/semanal por provider) |

**Cadencia:** default **5 min** con jitter aleatorio ±60s (anti-thundering-herd),
configurable en [`.pipeline/config.yaml`](../../.pipeline/config.yaml) →
`multi_provider.health.interval_minutes` (piso duro ≥60s). El primary **nunca** se
gatea por cuota en el snapshot (decisión del PO: un falso "caído" del primary sería
peor que el dato).

**Estado real** (extracto de `.pipeline/state/multi-provider-health.json`, redactado —
no lleva material de auth):

```json
{
  "ts": "2026-07-03T00:25:21.046Z",
  "green_count": 3, "yellow_count": 0, "red_count": 0,
  "providers": [
    { "provider": "anthropic", "state": "green", "reason_code": "cli_oauth_ok",
      "auth_mode": "oauth", "key_status": "absent", "quota": { "adapterStatus": "ok", "pct": 6.1 } }
  ]
}
```

> **Health honesto (#4402):** para providers con auth por login de CLI (Anthropic
> Max, Codex, Gemini) el estado sale de un probe OAuth real (`cli-oauth-probe.js`),
> no de la mera presencia de una key. Por eso `anthropic` figura `key_status:
> absent` pero `state: green` (`reason_code: cli_oauth_ok`).

#### 14.3.1 Gemini / Antigravity CLI: round-trip real y cuatro estados (#6857, #7290)

El probe ejecuta `agy --version` antes del catálogo y compara contra el pin
`AGY_CLI_CONTRACT = { min_version: '1.2.0', max_tested_version: '1.2.7' }`
(1.2.5 probado el 17/9/2026; pin subido a 1.2.7 el 19/9/2026 por #7371, ver §4.4.1).
El pin tiene **una única fuente** (`agy-catalog-probe.js`; `secrets-rw.js` lo importa
por identidad — #7371, absorbe #7320); `spec.cli_contract` permite ajustarlo en tests y
un cambio de pin invalida la cache v2. Política (b) (#7371, §4.4.1): una versión **por
encima** de `max_tested_version` con el **mismo major** sigue al round-trip y, si el
catálogo responde, queda **verde con nota** (`detail: version_above_tested`, TTL positivo,
alerta Telegram cada 24 h). Versión ilegible, `< min` o **salto de major** producen rojo
durable con TTL negativo, sin round-trip; el probe nunca actualiza el binario.


Para `antigravity` la presencia del binario no alcanza: un `agy` instalado puede
estar deslogueado o sin licencia. Hasta #6857 eso se resolvía leyendo un flag de
entorno local (`AGY_LICENSE_READY=1`) — sin round-trip al proveedor — y el flag
estaba vacío en producción con la licencia paga activa: el provider figuraba rojo
para siempre (#6225). El flag **ya no existe**. El estado sale de un round-trip
real a `agy models` (`.pipeline/lib/multi-provider/agy-catalog-probe.js`):

| Estado real | `state` | `reason_code` | Badge en `/providers` | Gatea el dispatch |
|---|---|---|---|---|
| Binario ausente (`ANTIGRAVITY_BIN` inválido, no instalado) | `red` | `cli_unavailable` | **SIN INSTALAR** | sí (durable) |
| Instalado, versión `< min`, **major distinto** o ilegible (`version_below_min` / `version_major_above_tested` / `version_unparseable`) | `red` | `cli_contract_mismatch` | **VERSIÓN NO PROBADA** | sí (durable) |
| Instalado, sin sesión/licencia (rc≠0, timeout, catálogo vacío) | `red` | `cli_license_unavailable` | **SIN LICENCIA** | sí (durable) |
| Instalado y con licencia (catálogo poblado) | `green` | `cli_catalog_ok` | **SANO** · "catálogo verificado · N modelos · hace X" | no |
| Ídem, versión `> max_tested` y **mismo major** (#7371, política b) | `green` | `cli_catalog_ok` · `detail: version_above_tested` | **SANO** · "⚠ versión X fuera del rango probado (pin Y) · auditoría de TOS pendiente · N modelos · hace X" | no · alerta Telegram `version_above_tested` cada 24 h |

Cómo funciona:

- **Binario**: se resuelve con la misma función que el launcher
  (`detectLauncher`: `ANTIGRAVITY_BIN` → `%LOCALAPPDATA%\agy\bin\agy.exe` → PATH). Ese dir
  está sólo en el PATH de **usuario**, por eso el fallback a `agy` pelado no sirve
  desde los servicios y la ubicación oficial va antes.
- **Round-trip**: `agy models` (no interactivo, no consume cuota de generación,
  ~2 s). El CLI hace `loadCodeAssist` + `fetchAvailableModels` contra
  `daily-cloudcode-pa.googleapis.com` con el token del keyring; sin red o sin
  sesión sale con rc≠0. Sano = rc 0 **y** ≥1 línea `id<TAB>label` en stdout.
  Timeout duro de 30 s (un `agy` deslogueado bloquea en OAuth, #4869).
- **Cache con TTL** en `.pipeline/state/agy-catalog-probe.json`: 15 min para un
  verde (5 min de tick × 3 < 20 min de frescura del dispatch), **4 min para un
  rojo** (menos de un tick, para que reautenticar se refleje enseguida). El
  binario se re-verifica en cada tick, con o sin cache. Un spawn real que
  termine en `authentication_rejected` (#5795) invalida la cache. "Probar ahora"
  en el dashboard fuerza el round-trip.
- **Snapshot**: los providers con round-trip llevan además `cli_probe: { kind,
  detail, cli_version, max_tested_version, model_count, models, checked_at,
  cached, launcher_kind }` (campo opcional; ausente para el resto).
  `cli_version` y `max_tested_version` (#7371) pasan por el regex estricto
  `^\d+\.\d+\.\d+$` en `cli-oauth-probe` y en `sanitizeCliProbe`: nada del
  stdout de `agy --version` llega al snapshot, al panel ni a Telegram.
  `max_tested_version` es `null` en entries de cache anteriores a #7371 (el
  panel omite el pin, no lo inventa). El catálogo real alimenta también el cruce
  de vigencia de #5888 (`catalog_check`), que antes quedaba `unavailable` por
  el short-circuit OAuth.
- **Frescura visible**: si el snapshot supera 2×TTL (30 min), el badge pasa a
  `info` · **SIN DATOS**. Un verde viejo nunca se lee como verde fresco.

Qué **no** dice el round-trip: no distingue plan pago de gratuito (#6564 sigue
vivo en esa parte) — sólo que hay una sesión con licencia capaz de listar el
catálogo. Y no valida que los modelos configurados en `agent-models.json`
existan en Antigravity (#6858); eso se ve en la columna de vigencia.

**Encendido y respawns**: no hay nada que configurar dentro del repo. La sesión
OAuth de `agy` vive en el keyring de Windows del usuario del servicio y el
binario en `%LOCALAPPDATA%`; ninguno se pierde con `reset` ni con el
`git reset --hard` de cada respawn.

**Launcher (agy ≥ 1.2)**: el prompt entra por stdin como una línea NDJSON
(`--input-format stream-json --output-format stream-json`); `--print` sin valor
dejó de existir en 1.2.x y un prompt en argv reventaría con ENAMETOOLONG
(#4529). El log del agente es NDJSON y el objeto útil es el `result` del
evento `{"event":"result"}`. La adaptación del parser de tokens/errores al
shape real (`usage.*`, `error` string) es #7288.

**Workspace: `--add-dir <cwd>` obligatorio (#6859)**. Antigravity **no trabaja
sobre el `cwd` del proceso**: tiene su propio concepto de workspace y, si no se
le declara uno, escribe en un scratch propio en
`~/.gemini/antigravity-cli/scratch/` **reportando `SUCCESS`** y afirmando haber
creado el archivo pedido. Medido en vivo tres veces con el mismo argv que arma
el pipeline (3/9 con agy 1.1.20, 16/9 con 1.2.4, 17/9 con 1.2.5): sin
`--add-dir` el directorio pedido queda vacío y el archivo aparece en el scratch;
con `--add-dir <dir>` aparece en `<dir>`. El modo de falla es el peor posible —
silencioso y con reporte de éxito: un agente despachado sin el flag "implementa"
contra un scratch fantasma y el issue rebota sin diff y sin causa visible.

Por eso `buildSpawn` del handler (`lib/agent-launcher/providers/antigravity.js`):

- Traduce el `cwd` recibido a `--add-dir <cwd>` en el argv, además de mantenerlo
  en `spawnOpts.cwd` (paridad con los demás handlers). Es el mismo `cwd` que
  manda el Pulpo: el worktree en `dev`, el ROOT del repo en las demás fases —
  mismo modelo de riesgo que Claude hoy bajo `--dangerously-skip-permissions`.
- Acepta `extraDirs: string[]` para directorios adicionales; el flag es
  repetible y se emite uno por directorio, en orden, después del `cwd`.
- **Falla fuerte sin `cwd`** (ausente, vacío, no-string o ruta relativa):
  `Error` con `code = 'AGY_WORKSPACE_REQUIRED'` y mensaje en español que incluye
  `PIPELINE_ISSUE` / `PIPELINE_SKILL` si vienen en el `env` y el path del
  scratch como pista. Los tres callers (`pulpo.js`, `sherlock-verifier.js`,
  `commander/multi-provider.js`) siempre pasan un string absoluto y capturan el
  throw, así que ningún camino vivo cambia; el que no sepa dónde trabajar falla
  visible en vez de caer al scratch.
- `--model` sigue siendo lo último del argv; los `--add-dir` van antes.

**Por qué `--add-dir` y no `--project` / `--new-project`**: ambos flags existen
en 1.2.x pero son identidad de sesión/proyecto en el estado local del CLI
(`~/.gemini/antigravity-cli/`), no scope de filesystem. Un `--new-project` por
worktree acumularía un proyecto persistente por issue sin aislamiento medible;
`--add-dir` solo alcanza para CA-1/CA-3 del issue. Decisión: **no se usan**.
`--sandbox` (restricciones de terminal) queda fuera de este alcance (SEC-7 de
#6856).

**Diagnóstico**: ante un rebote "implementé" sin diff de un agente que haya
caído a este provider, mirar el scratch antes que el log —
`node -e "console.log(require('./.pipeline/lib/agent-launcher/providers/antigravity').agyScratchDir())"`
— y el argv del spawn (tiene que contener `--add-dir`). Verificación:

```bash
node --test .pipeline/tests/antigravity-add-dir-6859.test.js        # offline: fake de agy que honra --add-dir, asserta sobre disco
node .pipeline/tests/smoke/antigravity-add-dir.smoke.js               # real: repo git temporal + archivo + git status + scratch sin cambios
```

### 14.4 Failover reproducible

La cadena de fallback vive en
[`.pipeline/lib/agent-launcher/dispatch-with-fallback.js`](../../.pipeline/lib/agent-launcher/dispatch-with-fallback.js)
(`resolveSpawnWithFallback`), con el parser de errores in-flight en
[`.pipeline/lib/agent-launcher/provider-error-parser.js`](../../.pipeline/lib/agent-launcher/provider-error-parser.js)
(#4404 · D5+D6). El gate de exclusión geográfica es
[`.pipeline/lib/data-residency-filter.js`](../../.pipeline/lib/data-residency-filter.js).

Cuando el primary no está disponible, el resolver descarta eslabones en orden y
elige el primer fallback resoluble. Razones de descarte posibles
(`SKIP_REASON_LABELS`):

| `reason` | Significado |
|---|---|
| `quota_exhausted` | sin cuota |
| `health_gate` | health rojo reciente |
| `provider_disabled` | kill-switch operativo |
| `provider_inactive_by_schedule` | fuera de horario |
| `preventive_soft_gate` | degradación preventiva por cuota (#4282) |
| `pacing_budget_red` / `pacing_budget_yellow` | crédito de ritmo semanal agotado/adelantado |
| `permission_matrix` | credenciales/permisos incompatibles |
| `same_as_primary` / `duplicate_in_chain` / `invalid_handler` | saneo de la cadena |

**Evidencia reproducible (redactada).** El formateador de producción
`formatProviderResolutionLog` emite el bloque de log que queda en
`log('lanzamiento', …)` y en la env `PROVIDER_RESOLUTION_LOG` del child. **No
incluye keys ni tokens por diseño.** Caso *primary sin cuota → cae a fallback*:

```text
🔄 backend-dev:#4405 — Resolución de provider:
  → anthropic (DESCARTADO: quota_exhausted (sin cuota) — weekly 100% (reset lun 00:00 UTC))
  ✓ openai-codex (ELEGIDO — fallback[0], model=gpt-5-codex)
  Chain evaluada: anthropic → openai-codex (2 eslabones evaluados)
```

Caso *cadena completa agotada → el issue vuelve a `pendiente/` para retry* (nunca
se pierde trabajo):

```text
🚫 guru:#4405 — Cadena completa exhausted:
  → anthropic (DESCARTADO: quota_exhausted (sin cuota) — weekly 100%)
  → openai-codex (DESCARTADO: health_gate (health rojo reciente) — 429 hace 3min)
  → antigravity (DESCARTADO: provider_inactive_by_schedule (fuera de horario) — 22:00-08:00)
  RESULTADO: all-gated, devuelvo a pendiente/ para retry
  Chain evaluada: anthropic → openai-codex → antigravity (3 eslabones evaluados)
```

> Ambos bloques se generaron con el `formatProviderResolutionLog` real. Para
> capturar tu propia evidencia sin esperar un 429 en vivo, se puede alimentar el
> formateador con un objeto `resolution` (ver la firma en el módulo) — la salida
> es idéntica a la de runtime y **ya viene redactada**.

### 14.5 Estado actual post-ola N+1 vs pre

Qué mejoró con la ola N+1 (hijos #4401–#4404, sobre los adapters reales de PRs
#3792–#3796) respecto del estado previo. `_notImplemented` describe **solo** el
comportamiento histórico (columna *pre*); **no** hay stubs vigentes en dispatch.

| Feature | Pre (ola N) | Post (ola N+1) | Evidencia |
|---|---|---|---|
| Adapters de dispatch (Codex, Gemini) | stubs que tiraban `_notImplemented` | adapters reales que hacen spawn del CLI | `.pipeline/lib/agent-launcher/providers/*.js` (comentarios "previo que tiraba `_notImplemented`") |
| Smoke test | sin harness CLI reproducible | `multi-provider-smoke-test.js` fail-closed + coverage + audit | §14.1 (output real) |
| Telemetría de costo | inexistente (`provider-cost.jsonl` no se escribía) | writer de 7 campos on-exit + slice de dashboard | §14.2 (línea real + agregación) |
| Libro contable de cuota (#6558) | 7 campos, proveedor **declarado**, sin timestamp | esquema v2: proveedor **efectivo**, `timestamp` UTC, `fase`, `resultado` (`ganada\|error\|rebote\|abortada`), `cache_read/write`; histórico v1 marcado no confiable | §14.2 (esquema v2 + consultas por día/semana) |
| Health por provider | presencia de key = "ok" (engañoso) | probe OAuth real + snapshot `state/` + pantalla en vivo | §14.3 (`multi-provider-health.json`, `reason_code: cli_oauth_ok`) |
| Failover | opaco (sin traza de por qué cayó) | `skipReasons` observables + log redactado + retry a `pendiente/` | §14.4 (bloques de `formatProviderResolutionLog`) |
| Diagnóstico de operador | leer código fuente | esta sección §14 (comandos copy-paste reproducibles) | #4405 |

**Qué falta / pendientes conocidos:** los adapters de cuota de algunos free
providers todavía reportan `adapterStatus: not_implemented` en el slice de cuota
(distinto del adapter de *dispatch*, que sí es real) — el health cae a la señal
OAuth/creds en esos casos. El seguimiento vive en los issues abiertos del épico
multi-provider; esta doc se actualiza cuando esos adapters de cuota cierren.

---

## 15. Criterio de permanencia de proveedores (#6145)

Responde, de forma recurrente y sin análisis manual, la pregunta *"¿qué proveedores de la
cadena me están costando más de lo que aportan?"* — incluida la respuesta legítima
**"ninguno"**.

El criterio **marca candidatos**; **nunca da de baja a nadie**. La baja efectiva es
siempre un PR de configuración trazable.

> La contracara — **quién entra** al ruteo — es el [criterio de admisión (§16)](#16-criterio-de-admisión-de-proveedores-6562):
> permanencia y admisión son las dos caras del mismo ciclo de vida de un proveedor.

### 15.1 Cómo se corre

```bash
# Reporte completo para el operador (tabla + conclusión + motivo por proveedor)
node .pipeline/scripts/provider-contribution-report.js --dias=30 --hasta=2026-08-21

# Tabla de 4 columnas, para terminales angostas
node .pipeline/scripts/provider-contribution-report.js --dias=30 --compacto

# JSON canónico, para pipear a jq
node .pipeline/scripts/provider-contribution-report.js --dias=30 --json

# Además, deja la evaluación en el audit append-only (hash-chain)
node .pipeline/scripts/provider-contribution-report.js --dias=30 --registrar
```

> **Fijá `--hasta` si vas a citar los números.** Sin él, `--dias=30` toma la ventana que
> termina *ahora*: mañana da otra ventana y otros números, y el "comando reproducible" deja
> de reproducir. La salida del CLI trae la línea `Regenerar:` con todos los flags que
> afectan el resultado (`--dias`, `--hasta`, `--compacto` y los overrides de umbral) ya
> armada para copiar.

Con la misma ventana, el comando produce **siempre el mismo veredicto** (test:
`el mismo comando sobre la misma ventana produce el mismo veredicto`).

Exit codes: `0` reporte emitido · `1` error explícito — configuración irresoluble o
argumento inválido, **sin defaults silenciosos** · `2` ventana sin archivos verificables
(todo queda `no evaluable`, no se decide nada).

**De dónde salen los umbrales, siempre declarado.** El CLI lee `config.yaml` por el lector
canónico del repo (`lib/config-resolver.js`) e imprime la línea
`Procedencia de los umbrales: …`. Si la configuración no resuelve, **falla con exit 1**: un
umbral que decide quién sale de la cadena no puede salir de un `catch`. Si la sección
`multi_provider.permanence` está ausente (rollout gradual), usa los defaults del módulo
**y lo dice**.

### 15.2 Fuente de datos

`.pipeline/logs/cross-provider-dispatch-*.jsonl` — append-only con hash-chain
(`hash_prev` / `hash_self`), rotación diaria, escrito por
`lib/agent-launcher/dispatch-with-fallback.js` vía `audit-log.appendChained`. La
integridad de **cada** archivo diario se verifica con `audit-log.verifyChain` antes de
alimentar el criterio; un archivo con la cadena rota se descarta y se reporta.

> **Prohibido usar `.claude/activity-log.jsonl`.** Esa fuente sólo registra `provider` en
> `session:start` / `session:end`: mide sesiones de agente ya arrancado, no intentos de
> proveedor. Daría **cero** para `antigravity`, `cerebras` y `nvidia-nim` — los tres que
> más despachan — y el criterio los daría de baja justo por aportar. Hay un test de
> policy que falla si el módulo llega a importarla.

### 15.3 Taxonomía: qué cuenta y qué no

| Evento | Cuenta como |
|---|---|
| `fallback_selected` | **aporte real** — única señal de que el proveedor resolvió el pedido |
| `fallback_health_gated` con causa de proveedor (`cupo` / `credencial`) | bloqueo, entra al denominador |
| `fallback_health_gated` con causa `observabilidad local` | **excluido del denominador** — el rojo es nuestro |
| `fallback_no_credentials` | bloqueo por `credencial` |
| `primary_inactive_by_schedule` · `fallback_provider_inactive_by_schedule` | **excluidos del denominador** — política horaria |
| `provider_disabled` · `fallback_provider_disabled` · `fallback_pacing_budget_red` | **excluidos del denominador** — kill-switch / freno de ritmo del operador (#3811, #4289) |
| `fallback_also_gated` | **excluido del denominador** — flag de cuota agotada del proveedor, con la cuenta amplificada |
| `chain_exhausted` · `gated_no_fallbacks` · `forced_provider_override*` | eventos de cadena, no imputables a ningún proveedor |

```
evaluables = intentos
             − gateos por ventana horaria
             − saltos por kill-switch / freno de ritmo del operador
             − gateos de salud por causa nuestra (observabilidad local)
             − gateos por el flag de cuota agotada (cuenta amplificada)

tasa de aporte = aportes / evaluables
```

**Los primeros tres descuentos comparten una razón:** miden una política o un bug
**nuestro**, no al proveedor.

- *Ventana horaria* — es el **~24 %** de los eventos. Incluirla mediría el horario que
  nosotros configuramos.
- *Kill-switch y freno de ritmo* — son decisiones operativas explícitas nuestras.
  `provider_disabled` y `fallback_provider_disabled` son **el mismo** kill-switch #3811
  resuelto por la misma `_isProviderDisabled()`; lo único que cambia es si el proveedor
  cayó como primario (`dispatch-with-fallback.js:1460`) o como fallback (`:1829`).
  **Tienen que clasificarse igual**: excluir sólo el primero deja un descuento vacío, dado
  que en datos reales `provider_disabled` no ocurre casi nunca y `fallback_provider_disabled`
  concentra los miles de saltos. Con el segundo dentro del denominador, apagar un proveedor
  a mano lo empuja a `candidato_baja` — la violación de REQ-SEC-3 que rebotó `security` en
  #6145: `cerebras` medía 22,7 % con el kill-switch adentro y **100 %** sin él.
- *Observabilidad local* — el rojo lo produce un flag de entorno propio, sin round-trip al
  proveedor. Es el caso `antigravity`: con sus gateos dentro del denominador su tasa daba
  7,6 %; con el denominador limpio da **100 %**. Un umbral ingenuo lo habría sacado de la
  cadena por un bug de instrumentación nuestro.

**El cuarto descuento tiene otra razón: amplificación, no política.** `fallback_also_gated`
sale de `quotaModule.shouldGateSpawn` (`dispatch-with-fallback.js:1805` → `quota-exhausted.js:1802`),
o sea el flag de **cuota agotada del propio proveedor** — no tiene nada que ver con la
ventana horaria, pese a que hasta #6145 rev-2 se lo contaba ahí. Se excluye porque el flag
queda activo durante todo el corte y **cada** intento de dispatch mientras dura emite un
evento: la cuenta mide *duración del corte × tráfico del pipeline*, no cuántas veces el
proveedor se negó. Excluirlo no deja pasar por sano a un gratuito seco: ése tiene 0 aportes
y sin muestra evaluable cae en `no evaluable`, que es lo que corresponde.

**La taxonomía es cerrada y reconcilia.** El reporte cuenta *todas* las entradas leídas, y
cualquier evento que el dispatcher agregue en el futuro y todavía no esté clasificado cae
en un bucket `fuera de taxonomía` visible, con su nombre. La propiedad
`failoverCost.reconciles` verifica que los buckets sumen exactamente el total: los
porcentajes nunca se calculan sobre un denominador que el reporte no declara.

### 15.4 Familias de bloqueo (no se mezclan)

| Familia | `health_reason` | Lectura |
|---|---|---|
| `cupo` | `quota_exhausted`, `quota_exhausted_real` | Recuperable por diseño |
| `credencial` | `invalid_credentials`, `no_key_configured`, `forbidden` | Imputable al proveedor / a la cuenta |
| `observabilidad local` | `cli_contract_mismatch`, `cli_license_unavailable`, `cli_unavailable`, `cli_binary_undeclared`, `unknown_provider` | **Bug nuestro.** Jamás imputable al proveedor |

El bloqueo por `observabilidad local` tiene **doble protección**:

1. **No entra al denominador** (§15.3), así que no le baja la tasa de aporte.
2. Si aun así el proveedor rinde poco, un bloqueo dominante `observabilidad local` le pone
   **techo `rol acotado`**: no puede ser marcado como candidato a baja sin corregir antes
   el chequeo.

### 15.5 Umbrales (`config.yaml` → `multi_provider.permanence`)

| Umbral | Default | Qué decide |
|---|---:|---|
| `enabled` | `false` | Rollout gradual |
| `window_days` | 30 | Ventana de medición (CA-1 exige ≥30) |
| `min_sample` | 200 | Intentos evaluables mínimos; por debajo ⇒ `no evaluable` |
| `min_contribution_rate` | 0.05 | Tasa bajo la cual se marca candidato |
| `max_days_without_win` | 14 | Días sin aporte real que marcan candidato |
| `min_survivors` | 1 | Proveedores **no pagos** sanos que deben sobrevivir siempre |

### 15.6 Invariantes — no configurables, cada uno con test

1. **Marca candidatos; nunca ejecuta la baja.** El audit registra `executed_action: none`.
2. **Nunca vacía la cadena que el criterio puede tocar.** Si marcar dejaría menos de
   `min_survivors` proveedores **no pagos** sanos, **no marca a ninguno** (tests: *nunca
   marca candidato al ultimo proveedor sano de la cadena* y *el invariante de cadena minima
   no lo satisfacen los pagos de forma vacua*). Hereda el invariante ya vigente para el
   soft-gate de cuota (§13.6).

   > **Los proveedores pagos NO cuentan como sobrevivientes.** Un pago es `mantener` por
   > construcción — se excluye del criterio antes que cualquier otro chequeo (invariante 3)
   > —, así que contarlo satisfaría el invariante de forma **vacua**: el contador nunca
   > bajaría de `min_survivors` y el guard no se dispararía jamás para los gratuitos. Con
   > la cadena real (2 pagos + 3 gratuitos) eso permitía proponer la baja de **los tres
   > gratuitos de una sola vez**: el incidente del 19/08 — Anthropic apagado por horario +
   > OpenAI sin cupo — pero auto-infligido y permanente. Los sobrevivientes se cuentan sólo
   > entre los proveedores que el criterio **puede marcar**.
3. **Nunca marca a un proveedor `billing: paid`.**
4. **"Sin dato" ⇒ `no evaluable`, jamás "no aporta".** Muestra chica, silencio del log,
   ventana vacía o hash-chain rota ⇒ no se decide sobre nadie. La derivación de "está
   declarado en config" falla **cerrada**: sin evidencia de declaración, el proveedor es
   `sin declarar` y por lo tanto **no puede** ser candidato a baja — nunca al revés.
5. **Bloqueo de origen local ⇒ fuera del denominador, y techo `rol acotado`.**
6. **Sólo metadatos.** Cada entrada del log se proyecta contra una whitelist cerrada;
   `raw_excerpt` y demás texto libre nunca llegan al reporte ni al audit.
7. **Read-only.** El módulo no invoca ninguna API de escritura de `fs`; la única escritura
   es opt-in (`--registrar`) y va al audit append-only.

### 15.7 Vocabulario del veredicto

Exactamente cinco literales, en español y sin abreviar. Los identificadores internos
(`rol_acotado`, `candidato_baja`, `no_evaluable`, `sin_declarar`) viven en el JSON y en el
audit, **nunca** en el texto que lee el operador.

`mantener` · `rol acotado` · `candidato a baja` · `no evaluable` · `sin declarar`

Las ausencias de medición **nunca** se escriben como `0` ni como `—`: declaran su causa
con vocabulario cerrado — `sin instrumentar (#6152)`, `sin muestra`,
`sin declarar (#6153)`, `cadena de hash rota`, `sin datos en la ventana`.

**"Sin datos" y "cadena rota" no son lo mismo** y no comparten mensaje: una ventana sin un
solo archivo que verificar dice *"no hay ni un archivo de dispatch en la ventana pedida"*,
no *"la cadena de hash no verificó (0 archivos con integridad rota)"*. Las dos frenan la
decisión, pero por razones distintas y con acciones distintas.

### 15.7.1 La columna de latencia **no** es una mediana

`multi-provider-health.json` guarda el resultado de **un** live-ping puntual, no un
agregado de la ventana: el log de dispatch **no registra latencia por invocación**. El
dato es volátil — tres observaciones del mismo proveedor (`nvidia-nim`) el mismo día
dieron **15,9 s → 2,3 s → 1,26 s** —, por eso la columna se llama *"Último live-ping (no
es mediana)"* y el reporte imprime el disclaimer completo al pie.

**Ningún veredicto ni recomendación se apoya en ese número.** La mediana real por ventana
requiere instrumentar latencia por invocación: **#6152**.

### 15.8 Equivalencia con el panel de salud

El operador cruza dos tableros en la misma decisión. Esta tabla es la traducción entre
ambos, y el antídoto contra el síntoma *"el panel no coincide con lo que el dispatcher
hace"*:

| Panel de salud (`/multi-provider-health`) | Reporte de permanencia | ¿Contradicción? | Lectura correcta |
|---|---|---|---|
| `green` / activo | mantener | no | Aporta y está sano |
| `green` / activo | candidato a baja | **no** | Está sano pero **no lo eligen**: sobra en la cadena |
| `red` por causa **local** (`cli_license_unavailable`) | mantener | **no** | El rojo es nuestro, no del proveedor. Corregir el chequeo |
| `red` por causa **del proveedor** (credencial, 4xx sostenido) | candidato a baja | no | Coinciden: evaluar la baja |
| `sin datos 24h` | no evaluable | no | Falta muestra. **Nunca** se degrada a "no aporta" |
| ausente del panel | sin declarar | no | Despacha pero no está en config (#6153) |

**Ejemplo canónico — `antigravity` (histórico, corregido en #6857).** Figuraba `red`
en el panel y `mantener` en el reporte, **simultáneamente, y eso era correcto**: el rojo
lo producía `cli-oauth-probe.js` cuando `AGY_LICENSE_READY !== '1'`, un flag de entorno
**sin round-trip al proveedor**. Mientras tanto el dispatcher lo eligió 277 veces en la
misma ventana, porque el health-gate sólo aplica con rojo fresco (<20 min) y con snapshot
viejo cae en `red_stale` → fail-open. Desde #6857 el rojo/verde sale de `agy models`
(§14.3.1) y #6225 quedó cerrado con esa entrega.

### 15.9 Registro de la decisión

Cada corrida con `--registrar` deja una entrada `provider_permanence_evaluated` en
`.pipeline/audit/provider-permanence.jsonl` (append-only, hash-chain) con la ventana, el
estado de integridad, los umbrales aplicados, el veredicto y la evidencia por proveedor, y
`executed_action: none`. Un PR posterior que ejecute una baja **referencia esa entrada**,
de modo que el flip de configuración nunca sea una edición suelta.

### 15.10 Evaluación vigente

La primera evaluación completa (ventana 2026-07-20 → 2026-08-19, 97.616 eventos, 31
archivos, hash-chain OK) está en
[`docs/pipeline/evaluacion-free-providers-6145.md`](evaluacion-free-providers-6145.md).

**Resultado: no se da de baja a ningún proveedor.** El hallazgo central es que los
gratuitos no descargan al proveedor pago — recogen trabajo que la cadena paga **ya
rechazó** (1.483 de 1.483 selecciones de gratuitos ocurrieron después de descartar
`anthropic` **y** `openai-codex`). Darlos de baja no alivia al pago: convierte esos
dispatches en `chain_exhausted`.

### 15.11 Tests

```bash
node --test .pipeline/lib/multi-provider/__tests__/provider-contribution.test.js   # 26 tests
node --test .pipeline/tests/provider-permanence-6145.test.js                       # 12 tests
```

---

## 16. Criterio de admisión de proveedores (#6562)

Es la otra cara de [§15](#15-criterio-de-permanencia-de-proveedores-6145): la permanencia
decide **quién se queda**; la admisión decide **quién entra**. El programa *Contabilidad y
balanceo de cuota por proveedor* depende de que todos los proveedores activos sean
contables: uno que no reporta consumo no sólo no aporta, **entorpece** la selección porque
ocupa un lugar en la cadena sin que se sepa qué queda en él.

### 16.1 La regla

Un proveedor es admisible al ruteo sólo si cumple **las tres** condiciones. El vocabulario
de esta tabla es el mismo que usa la declaración en `agent-models.json` y el mensaje del
guardrail, para ir del error al campo y del campo a esta doc sin traducir.

| # | Condición | Campo en `admission` | Rótulo cuando falla | Por qué |
|---|---|---|---|---|
| 1 | **CLI local capaz de editar archivos** — no una API pelada de chat | `cli_edits_files` | *su CLI no edita archivos* | Un proveedor que no puede editar el repo no puede ejecutar fases de desarrollo. |
| 2 | **Reporta consumo verificable** — cuánto se lleva gastado del período, no sólo "te pasaste" | `reports_usage` | *no reporta consumo verificable* | Sin esto no hay contabilidad posible ni balanceo. |
| 3 | **Términos que no entrenen con nuestro código** — política ya vigente ([data-residency](../pipeline-multi-provider/data-residency.md)) | `terms_no_training` | *sus términos entrenan con el código* | El código fuente y los secretos del pipeline no alimentan modelos de terceros. |

**"Activo en el ruteo"** = referenciado por `default_provider`, por algún `skills.<s>.provider`
o por algún `skills.<s>.fallbacks[]`. Un proveedor declarado en `providers` pero no
referenciado puede no cumplir sin romper la carga; en cuanto se lo referencia, el guardrail
lo evalúa.

### 16.2 Declaración por proveedor

Cada bloque `providers.<name>` declara las tres condiciones de forma **explícita y
fail-closed**: un campo ausente vale *no declaró* (no cumple) y el mensaje lo distingue de
*declaró false*. Nunca se infiere del launcher ni del nombre.

```json
"admission": {
  "cli_edits_files": true,
  "reports_usage": true,
  "terms_no_training": true
}
```

- `cli_edits_files: true` exige `capabilities: ["agentic-tool-use"]` en el mismo bloque:
  declarar que edita archivos sin la capability de ejecución es una contradicción y rompe la
  carga (una sola verdad, no dos).
- Las condiciones **sin verificación documentada se declaran `false`**, nunca `true` por
  omisión.
- **Exención explícita para ejecutores sin LLM** (`deterministic`, launcher `node`):

  ```json
  "admission": { "non_llm": true }
  ```

  Sólo es válida con `output_parser: "none"`; un proveedor LLM no puede eximirse marcándose
  `non_llm`. La exención vive en la declaración del proveedor, **no** en un caso especial
  escondido en el código (`if (key === 'deterministic')` está prohibido).
- **Excepción temporal** para mantener en el ruteo a un proveedor que hoy no cumple, con
  motivo, vencimiento e issue que la resuelve:

  ```json
  "admission": {
    "cli_edits_files": true,
    "reports_usage": false,
    "terms_no_training": false,
    "exception": { "reason": "plan pago pendiente de verificación en #6564", "until": "2026-12-31", "issue": 6564 }
  }
  ```

  `until` es inclusivo (UTC). **Vencida la fecha, el boot vuelve a rechazar** al proveedor.
  La vigencia está capeada a `ADMISSION_EXCEPTION_MAX_DAYS` (120 días) desde el día de la
  validación: no existe la excepción eterna. Una excepción malformada (motivo vacío, fecha
  sin formato `YYYY-MM-DD`) es error y no habilita nada.

### 16.3 Guardrail

Vive en `validateProviderAdmission` ([`.pipeline/lib/agent-models-validate.js`](../../.pipeline/lib/agent-models-validate.js)),
dentro de `validateCrossReferences`. Como ese mismo `validate()` lo invocan **el boot del
Pulpo** (fail-fast, `exit 2`) y **el write path del dashboard** (`agent-models-rw.writeConfig`
valida antes de tocar disco), las dos formas de "activar un proveedor" comparten el mismo
gate sin duplicar lógica.

Mensaje en tres partes, todas las condiciones incumplidas en **un solo error por proveedor**:

```
problema: #/providers/nvidia-nim/admission [provider-admission] el proveedor "nvidia-nim" no es
          admisible en el ruteo: no reporta consumo verificable (admission.reports_usage: declaró
          false); sus términos entrenan con el código (admission.terms_no_training: no declaró).
          Está activado en #/skills/android-dev/fallbacks/2, #/skills/web-dev/fallbacks/2, …
solución: en providers.nvidia-nim.admission declarar en true sólo las condiciones que de verdad
          se cumplen (cli_edits_files, reports_usage, terms_no_training); si alguna no se cumple,
          quitar "nvidia-nim" de default_provider / skills.*.provider / fallbacks[], o registrar
          admission.exception { reason, until, issue } con vencimiento — ver docs/pipeline/multi-provider.md §16
```

Otros errores del mismo guardrail, todos con prefijo `[provider-admission]`:

| Situación | Path del error |
|---|---|
| `non_llm: true` con `output_parser` distinto de `none` | `#/providers/<x>/admission/non_llm` |
| `cli_edits_files: true` sin `agentic-tool-use` en `capabilities` | `#/providers/<x>/admission/cli_edits_files` |
| Excepción malformada | `#/providers/<x>/admission/exception` |
| Excepción más larga que el cap | `#/providers/<x>/admission/exception/until` |
| Excepción vencida | `#/providers/<x>/admission` (el mensaje nombra la fecha de vencimiento) |

Verificación manual:

```bash
node .pipeline/lib/agent-models-validate.js          # OK / lista de errores accionables
node .pipeline/validate-agent-models.js              # CLI humanizado (#3089)
```

### 16.4 Evaluación vigente (medición 2026-09-16, actualizada post-#6563)

Los proveedores configurados, evaluados contra las tres condiciones. Las columnas repiten
literalmente lo declarado en `agent-models.json`. Fuente de la medición: tabla del issue
#6562 (estado al 25/08/2026), `capabilities` / `supports_tool_use` del JSON, los
quota-adapters de `.pipeline/lib/quota-adapters/` (`antigravity` devuelve
`not_implemented`) y la [tabla de TOS](../pipeline-multi-provider/data-residency.md).

| Proveedor | Edita archivos | Reporta consumo | Términos sin entrenamiento | Veredicto | Cómo sigue |
|---|---|---|---|---|---|
| `anthropic` | sí | sí, real | sí | **admisible** | — |
| `openai-codex` | sí | sí, real | sí | **admisible** | — |
| `antigravity` | sí (CLI `agy` de Antigravity) | no (adapter `not_implemented`; parser de `usage.*` es #7288) | no (licencia paga de Antigravity sin verificación documentada todavía) | no admisible — excepción vigente | #6564 verifica el plan pago y documenta términos; excepción hasta 2026-12-31 |
| `deterministic` | n/a | n/a | n/a | exento (sin LLM) | `non_llm: true` |

**Retirados en #6563 (2026-09-16):** `nvidia-nim` (no reportaba consumo, términos sin
verificar), `cerebras` (API pelada sin tool_use, no reportaba consumo) y `kimi-moonshot`
(sin tool_use por el endpoint compatible, sin quota-adapter). Ya no existen en
`agent-models.json` ni en el código; la re-alta se hace por §17.

**Decisión registrada:** `antigravity` es el único proveedor del plantel que sigue en las
cadenas **únicamente** por `admission.exception`, ahora atada a #6564 (plan pago de Gemini).
Si #6564 no cierra antes del 2026-12-31, el boot del Pulpo rechaza la configuración con el
mensaje de §16.3 — es fail-closed a propósito: la excepción se extiende editando la fecha en
un PR trazable (cap `ADMISSION_EXCEPTION_MAX_DAYS`), nunca se ignora en silencio. Ninguna
excepción del JSON referencia a #6563.

**Pendiente (recomendación #7285):** cross-validar `reports_usage` contra el quota-adapter
real (`not_implemented` ⇒ no puede declarar `true`). Hoy la declaración es manual.
**Pendiente (recomendación #7304):** preaviso de vencimiento de `admission.exception`.

### 16.5 Tests

```bash
node --test .pipeline/tests/provider-admission-6562.test.js    # Gherkin 1:1 + fail-closed + excepción + policy JSON/doc
node --test .pipeline/lib/__tests__/agent-models-validate.test.js
```

---

## 17. Plan de rollback — re-alta de un proveedor dado de baja (#6563)

La baja de #6563 **no es un `git revert`**: es una re-alta con excepción temporal. Así el
rollback vence solo (cap de 120 días, §16.2) y obliga a decidir de nuevo; nunca reinstala
un proveedor "para siempre" ni salta el guardrail de admisión. El procedimiento sirve para
cualquiera de los retirados (`cerebras`, `nvidia-nim`, `kimi-moonshot`) y para el caso en
que la cadena de tres resulte insuficiente.

### 17.1 Qué se restaura y de dónde

Todo lo removido vive en el commit de la baja. `SHA_BAJA` es el merge commit del PR de
#6563 en `main`; `SHA_BAJA^` es el estado inmediatamente anterior, con el proveedor
completo.

| Pieza | Path (estado en `SHA_BAJA^`) |
|---|---|
| Bloque de configuración | `providers.<x>` en `.pipeline/agent-models.json` (+ los `fallbacks[]` de cada skill donde iba) |
| Adapter de launcher | `.pipeline/lib/agent-launcher/providers/<x>.js` (+ `runners/<x>-runner.js` para `cerebras`/`nvidia-nim`) y su registro en `resolve-provider.js` |
| Quota-adapter | `.pipeline/lib/quota-adapters/<x>.js` + switch/allowlist en `quota-adapters/index.js`. **Sólo `cerebras` y `nvidia-nim`**: `kimi-moonshot` nunca tuvo quota-adapter ni runner (su cuota se detectaba por `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER`) |
| Allowlists del validador | `ALLOWED_LAUNCHERS`, `ALLOWED_MODELS_BY_LAUNCHER`, `ALLOWED_CREDENTIAL_ENV_VARS` en `.pipeline/lib/agent-models-validate.js`; `enum` informativo de `launcher` en `agent-models.schema.json`; `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER` en `lib/quota-exhausted.js` |
| Secretos | `secrets-manifest.json`, `lib/credentials.js`, `lib/secret-scopes.js`, `kernel-bootstrap/motor-9.1-secret-allowlist.json` |
| Superficie del operador | filas en `views/dashboard/{providers,onboarding-wizard,home,multi-provider}.js`; tokens `--provider-<x>*` (`assets/design-tokens.css`) y símbolo `ic-provider-<x>` (`assets/icons/sprite.svg`) |

### 17.2 Comandos

```bash
# 0. Precondiciones: rama nueva desde main, pipeline en ventana segura.
export PATH="/c/Workspaces/gh-cli/bin:$PATH"
git fetch origin && git switch -c agent/<issue-nuevo>-realta-<x> origin/main
# SHA_BAJA = merge del PR que CERRÓ #6563. Se lee de GitHub (linked PR), no del texto
# de los commits: `git log --grep '#6563'` también matchea #7295 y #7307, que sólo lo
# mencionan, y `tail -1` devolvería el más antiguo (9867dc9c0, criterio de admisión).
SHA_BAJA=$(gh api graphql -f query='{ repository(owner:"intrale", name:"platform") {
  issue(number:6563) { closedByPullRequestsReferences(first:10) {
    nodes { number merged mergeCommit { oid } } } } } }' \
  --jq '.data.repository.issue.closedByPullRequestsReferences.nodes[] | select(.merged) | .mergeCommit.oid' \
  | head -1)
# Sanidad fail-closed: el merge de la baja BORRA los adapters retirados. Si el SHA no
# los borra, no es ese commit y el resto del plan restauraría un estado equivocado.
git diff --diff-filter=D --name-only "$SHA_BAJA^" "$SHA_BAJA" \
  | grep -q '^\.pipeline/lib/agent-launcher/providers/cerebras\.js$' \
  || { echo "SHA_BAJA='$SHA_BAJA' no es el merge de la baja de #6563"; exit 1; }
X=nvidia-nim                                                          # proveedor a re-habilitar

# 1. Backup del JSON vivo (misma convención que la UI del dashboard, §1.3).
cp .pipeline/agent-models.json ".pipeline/agent-models.json.bak-$(date +%Y%m%d-%H%M%S)"

# 2. Restaurar adapter (+ quota-adapter y runner, sólo si existían) desde el estado previo.
#    El adapter de launcher es obligatorio para los tres. El quota-adapter y el runner
#    existían sólo para cerebras y nvidia-nim: kimi-moonshot nunca tuvo ninguno de los dos
#    (ver tabla 17.1), y un `git checkout` de un path inexistente aborta con `pathspec did
#    not match`; por eso se comprueba la existencia antes de restaurar.
git checkout "$SHA_BAJA^" -- ".pipeline/lib/agent-launcher/providers/$X.js"
for f in ".pipeline/lib/quota-adapters/$X.js" ".pipeline/lib/agent-launcher/runners/$X-runner.js"; do
  if git cat-file -e "$SHA_BAJA^:$f" 2>/dev/null; then git checkout "$SHA_BAJA^" -- "$f";
  else echo "sin $f en SHA_BAJA^ (esperado para kimi-moonshot)"; fi
done

# 3. Volver a registrar el proveedor en las allowlists y el registro de handlers.
#    Ver el diff exacto de la baja para cada archivo y aplicarlo al revés:
git show "$SHA_BAJA" -- \
  .pipeline/lib/agent-models-validate.js \
  .pipeline/agent-models.schema.json \
  .pipeline/lib/agent-launcher/resolve-provider.js \
  .pipeline/lib/quota-adapters/index.js \
  .pipeline/lib/quota-exhausted.js \
  .pipeline/secrets-manifest.json .pipeline/lib/credentials.js .pipeline/lib/secret-scopes.js \
  | grep -n "$X" | head -60
#    (editar a mano: reponer la entrada en ALLOWED_LAUNCHERS / ALLOWED_MODELS_BY_LAUNCHER /
#     ALLOWED_CREDENTIAL_ENV_VARS, el `case` del quota-adapter, el handler en
#     PROVIDER_HANDLERS y la env var en el manifest de secretos)

# 4. Reponer el bloque `providers.<x>` en agent-models.json desde el estado previo,
#    y agregarle la excepción de admisión con issue NUEVO (nunca #6563) y vencimiento
#    <= 120 días (ADMISSION_EXCEPTION_MAX_DAYS).
X=$X SHA_BAJA=$SHA_BAJA node - <<'EOF'
const fs = require('fs');
const { execFileSync } = require('child_process');
const X = process.env.X, SHA = process.env.SHA_BAJA;
// execFileSync, no execSync: en Windows execSync pasa por cmd.exe, donde `^` es
// carácter de escape y `git show SHA^:ruta` llega como `SHA:ruta` (estado POST-baja).
const prev = JSON.parse(execFileSync('git', ['show', `${SHA}^:.pipeline/agent-models.json`], { encoding: 'utf8' }));
const cur = JSON.parse(fs.readFileSync('.pipeline/agent-models.json', 'utf8'));
cur.providers[X] = prev.providers[X];
cur.providers[X].admission = {
  ...cur.providers[X].admission,
  exception: {
    reason: 'rollback de #6563: la cadena de tres resultó insuficiente (<motivo medido>)',
    until: '<YYYY-MM-DD, <= 120 días desde hoy>',
    issue: 0, // <numero-del-issue-nuevo>
  },
};
// Volver a colgarlo al FINAL de las cadenas donde iba (ver prev.skills.<s>.fallbacks).
for (const [skill, cfg] of Object.entries(prev.skills)) {
  const fb = (cfg.fallbacks || []).find(f => f.provider === X);
  if (fb) (cur.skills[skill].fallbacks ||= []).push(fb);
}
fs.writeFileSync('.pipeline/agent-models.json', JSON.stringify(cur, null, 2).replace(/\n/g, '\r\n') + '\r\n');
EOF

# 5. Credencial del proveedor por terminal (NUNCA por Telegram), en el store externo.
#    Ej. NVIDIA: NVIDIA_NIM_API_KEY en ~/.claude/secrets/credentials.json (§1.3).

# 6. Validar la coherencia schema -> JSON -> allowlists y la excepción (hoy y al vencimiento).
node .pipeline/lib/agent-models-validate.js
node -e "const v=require('./.pipeline/lib/agent-models-validate.js');console.log(v.validate(undefined,{now:new Date('<until>T12:00:00Z')}).ok)"

# 7. Tests del núcleo + cobertura de la cadena.
node --test .pipeline/tests/validate-agent-models.test.js .pipeline/tests/provider-admission-6562.test.js \
  ".pipeline/lib/__tests__/agent-models-validate*.test.js"
node .pipeline/lib/multi-provider/validate-chains.js
#    Matriz skill × provider en dry-run (sin spawn ni consumo de cuota). Exige ventana:
#    pipeline con `.pausa` (halt total) o `.partial-pause.json` con
#    `allowed_skills: ['multi-provider-smoke-test']`; si no, aborta con FATAL.
node .pipeline/tools/multi-provider-smoke-test.js --dry-run --no-telegram --no-create-issues

# 8. Restart y smoke test (mueve `pipeline-stable` si pasa; rollback automático si no).
node .pipeline/restart.js
bash .pipeline/smoke-test.sh

# 9. PR con `Closes #<issue-nuevo>`: CODEOWNERS exige review humana de `.pipeline/`.
```

### 17.3 Reglas

- **La excepción es obligatoria y temporal.** El guardrail (§16.3) rechaza la re-alta sin
  `admission.exception { reason, until, issue }`, con `until` a más de 120 días o con
  `issue` inexistente. Vencida, el boot vuelve a rechazar: hay que decidir de nuevo.
- **Nunca `git revert` del PR de la baja.** Reintroduciría los tres proveedores a la vez, con
  las excepciones vencidas (`until: 2026-10-31`, `issue: 6563`), y el boot fallaría igual.
- **Un proveedor por PR.** El validador exige coherencia schema → JSON → allowlists; un estado
  intermedio (adapter restaurado sin entrada en el JSON, o al revés) no arranca.
- **La superficie del operador se restaura al final**, sólo si el proveedor vuelve a estar en
  las cadenas: filas del dashboard/wizard desde `SHA_BAJA^`. Los tokens de color y el símbolo
  del sprite quedaron reservados en el sistema de diseño, así que no hace falta rediseño.
- **Salida del rollback:** o el proveedor cumple las tres condiciones de §16.1 y se le quita la
  excepción, o se vuelve a dar de baja con este mismo procedimiento al revés (el PR de #6563
  es la referencia de qué tocar).

---

## 18. Techo de cuota contratada por proveedor (#6559)

Es **el haber** del libro contable de cuota. [§14.2](#142-telemetría-y-diagnóstico) (esquema v2,
#6558) registra el **consumo** real por ejecución; esta sección declara **cuánta cuota existe**
por proveedor y por período, para que saldo, ritmo y proyección (#6560) tengan contra qué
comparar. Hasta acá el pipeline no llevaba contabilidad sino **alarmas**: sólo registraba el
evento "este proveedor dijo basta" y lo sacaba de circulación hasta la reposición. Dato que lo
motiva: el 25/08/2026 Codex estaba al 100 % agotado desde las 03:22 mientras a Claude le
sobraba el 70 %.

Programa *Contabilidad y balanceo de cuota por proveedor*: #6558 (consumo) → **#6559 (techo)** →
#6560 (saldo y ritmo) → #6561, #6565, #6809.

### 18.1 Dónde vive

`.pipeline/config.yaml` → `multi_provider.quota.<proveedor>`, hermana de `quota_alert` (que ya
indexa por proveedor con los mismos ids). Lado **kernel** (#5173): hereda de `multi_provider`
sin declaración extra en `pipeline.config.json`.

Los ids son los **canónicos** de `agent-models.json`: `anthropic`, `openai-codex`,
`antigravity`. Los alias `claude`/`codex` que acepta `multi_provider.order` **no** valen como
clave acá (se normalizan sólo al comparar contra el ruteo, ver §18.3).

### 18.2 Los cinco campos

Todos obligatorios por proveedor declarado. El schema (`lib/config-schema.js`) los tipa y cierra
los enums; los invariantes que cruzan dos campos los aplica el validador de boot (§18.3).

| Campo | Tipo | Valores válidos | Ejemplo |
|---|---|---|---|
| `plan` | texto | libre, no vacío | `"Claude Max"` |
| `periodo` | enum | `horario` · `diario` · `semanal` | `semanal` |
| `techo` | número ≥ 0 | cuota del período en la `unidad` declarada; si `unidad: porcentaje` **siempre `100`** | `100` |
| `unidad` | enum | `tokens` · `mensajes` · `creditos` · `porcentaje` | `porcentaje` |
| `reposicion` | texto con formato | según `periodo` (tabla siguiente) o `rolling` | `"dom 21:00"` |

**Formato de `reposicion`.** Es el campo más ambiguo de los cinco ("domingo 21:00" sin zona
horaria es una trampa), así que el formato es fijo y la TZ es **una sola** para todo el
pipeline: la hora local de `QUOTA_TZ_OFFSET_MIN` (default `-180`, ART, UTC-3), la misma ancla
que usa `lib/weekly-quota.js` para el reset semanal de Anthropic. No hay una segunda clave `tz`
en `config.yaml` a propósito: dos fuentes de verdad de TZ se desincronizan en silencio.

| `periodo` | Formato | Ejemplo | Significado |
|---|---|---|---|
| `semanal` | `<dia> HH:MM` con `dia ∈ lun,mar,mie,jue,vie,sab,dom` | `"dom 21:00"` | corte fijo semanal |
| `diario` | `HH:MM` | `"03:00"` | corte fijo diario |
| `horario` | `:MM` | `":00"` | minuto de corte dentro de cada hora |
| cualquiera | `rolling` | `rolling` | ventana **móvil** desde el primer uso; el corte lo informa el proveedor en `resets_at` y no hay hora fija |

**Modelo de ventana (decisión de diseño).** Los proveedores exponen **dos** ventanas (Anthropic
`five_hour` + `seven_day`; Codex rolling de horas + semanal; el panel MIZPÁ las modela como
`kind: 'short' | 'long'` en `lib/provider-quota.js`). Acá se declara **un** período por
proveedor: la **ventana larga**, que es la que agrega el libro contable por día/semana
(§14.2) y la que el panel muestra como `Sem`/`Día`. Así `periodo`/`reposicion` son
consistentes con el `resetAt` de la ventana larga del panel y el saldo de #6560 no tiene que
reconciliar dos nociones de "período". La ventana corta la sigue informando el proveedor en
`resets_at` (cap `quota_detector.resets_at_cap_max_days`). Si #6560 necesita declararla, el
bloque puede crecer a una lista sin romper el modelo plano.

**Bloque vigente** (copiable; es el que está en `config.yaml`):

```yaml
multi_provider:
  quota:
    # Claude Max: la cuota semanal se expone como % de utilización (`seven_day`);
    # reset domingo 21:00 hora local (weekly-quota.js).
    anthropic:
      plan: "Claude Max"
      periodo: semanal
      techo: 100
      unidad: porcentaje
      reposicion: "dom 21:00"
    # ChatGPT Plus: Codex expone `used_percent` de la ventana semanal
    # (`window_minutes: 10080`) con `resets_at` móvil desde el primer uso.
    openai-codex:
      plan: "ChatGPT Plus"
      periodo: semanal
      techo: 100
      unidad: porcentaje
      reposicion: rolling
    # Google One (Antigravity): ventana larga diaria (panel: long = Día). El CLI
    # `agy` todavía no reporta consumo verificable; plan y techo se confirman en #6564.
    antigravity:
      plan: "Google One"
      periodo: diario
      techo: 100
      unidad: porcentaje
      reposicion: rolling
```

### 18.3 Guardrail de arranque (fail-closed)

Un proveedor **activo** sin techo declarado **no se asume infinito**: el pulpo no arranca. El
chequeo vive en `lib/multi-provider/validate-quota-ceilings.js` (`validateQuotaCeilings(config,
agentModels)`, puro, sin I/O) y corre en el boot de `pulpo.js` junto a `validate-chains`
(#4407), después de que `agent-models.json` pasó schema + cross-refs. Es el lugar natural: ahí
están las dos fuentes (config validada y cadenas efectivas) y ya es fail-closed (`exit 2`).

- **"Activo"** = `default_provider` ∪ `skills.*.provider` ∪ `skills.*.fallbacks[].provider` de
  `agent-models.json` ∪ `multi_provider.order` (si existe), con alias normalizados
  (`claude → anthropic`, `codex → openai-codex`). **Excluye** a los proveedores sin LLM
  (`admission.non_llm: true`, hoy sólo `deterministic`): no consumen cuota y exigirles techo
  obligaría a declarar uno fantasma para que el pulpo arranque. Un proveedor dado de baja
  (#6563, §17) **no** necesita techo; si lo conserva, el bloque se valida igual para que un
  error no quede latente hasta la re-alta.
- **Un error por proveedor** (nunca un "faltan techos" genérico), con `path`, mensaje que
  **nombra al proveedor** y `fix`. Texto exacto que ve el operador en `stderr`/`pulpo.log`:

  ```
  [validate-quota] multi_provider.quota.openai-codex: proveedor activo sin techo declarado — fix: agregá plan/periodo/techo/unidad/reposicion bajo multi_provider.quota.openai-codex en .pipeline/config.yaml (ver docs/pipeline/multi-provider.md §18)
  ```

  y, con todo declarado:

  ```
  [validate-quota] Techos validados: 3 proveedores activos (anthropic, openai-codex, antigravity) — <ISO>
  ```

- **Invariantes cruzados** que también abortan: `unidad: porcentaje` con `techo ≠ 100`;
  `reposicion` que no respeta el formato del `periodo`; alguno de los 5 campos vacío.
- **Typos.** La sección es **cerrada** (a diferencia del resto de `multi_provider`): un id mal
  escrito (`anthropc`) o una clave desconocida (`tope`) salen por el camino habitual de
  `config-schema.js` (`.paused` + Telegram con sugerencia `¿quisiste decir 'anthropic'?`), no como
  "infinito silencioso". Un `periodo: mensual` o `unidad: dolares` también.
- **Si `config.yaml` no valida** (schema/parse), el cross-check se saltea con un aviso: la
  violación ya la maneja `loadConfig()` por su camino fail-closed propio (#5172/#4832) y correr
  el chequeo sobre un documento inválido sólo duplicaría el ruido.
- **Seguridad** (CA-6 de #4407): los mensajes sólo interpolan ids de proveedor, paths y fixes.
  Nunca `JSON.stringify` de un provider de `agent-models.json` (arrastra `credentials_env`).

Corrida standalone, sin arrancar el pulpo:

```bash
node .pipeline/lib/multi-provider/validate-quota-ceilings.js
# exit 0 → "[validate-quota] Techos validados: …" · exit 2 → un error por proveedor
```

### 18.4 Lectura programática (para #6560)

```js
const q = require('.pipeline/lib/multi-provider/validate-quota-ceilings');
q.getQuotaCeiling(config, 'openai-codex');
// → { provider: 'openai-codex', plan: 'ChatGPT Plus', periodo: 'semanal', techo: 100,
//     unidad: 'porcentaje', reposicion: 'rolling', rolling: true, tz_offset_min: -180 }
q.getQuotaCeiling(config, 'claude');     // alias → mismo bloque que 'anthropic'
q.getQuotaCeiling(config, 'deterministic'); // → null (sin techo: NO es infinito, es "sin dato")
q.listQuotaCeilings(config);             // { anthropic: {…}, 'openai-codex': {…}, antigravity: {…} }
q.activeProviders(agentModels, config);  // ['anthropic', 'openai-codex', 'antigravity']
```

`config` es el objeto que devuelve `loadConfig()` / `config-resolver.resolve()`. El módulo no
lee archivos: el llamador decide de dónde sale el config (hot-reload cada ~30 s en el pulpo).

### 18.5 Qué hacer cuando cambio de plan

1. Editar `plan` y, si cambia el cupo o su unidad, `techo`/`unidad` (si el proveedor pasa a
   exponer un cupo absoluto, cambiar `unidad` a `tokens`/`mensajes`/`creditos` y poner el número
   real; con `porcentaje` el techo es siempre `100`). Si cambia la ventana, `periodo` y
   `reposicion` en el mismo commit.
2. Correr `node .pipeline/lib/multi-provider/validate-quota-ceilings.js` y la suite
   (`node --test .pipeline/lib/multi-provider/__tests__/validate-quota-ceilings.test.js`
   y `.pipeline/lib/__tests__/config-schema.test.js`).
3. PR de configuración trazable (la declaración es versionada a propósito: el "cuánto tengo"
   cambia con el contrato, no con el día).
4. **Reiniciar el pulpo** al mergear: el motor corre desde el repo principal y sólo relee
   `config-schema.js` al respawn (memoria operativa: motor viejo vs config nuevo = rechazo
   falso o dashboard fail-closed).

### 18.6 Relación con la configuración que ya existía

| Ya existía | Dónde | Relación |
|---|---|---|
| `pacing.weekly_quota_pct_per_provider: 100` | `config.yaml` (pacing, `enabled: false`) | Techo implícito en % semanal **para todos**. `multi_provider.quota.<id>.techo` + `unidad` lo **supersede** por proveedor; no se borra porque `pacing` sigue apagado y conserva su propio kill-switch. |
| `quota_detector.resets_at_cap_max_days.<id>` | `config.yaml` | Cap de cuánto se cree un `resets_at` del proveedor. No es `reposicion`, pero deben ser coherentes: `periodo: semanal` ⇒ cap ≥ 7. |
| `QUOTA_TZ_OFFSET_MIN` / `lib/weekly-quota.js` | env | **Única** ancla de TZ; `reposicion` se expresa en esa hora local y `getQuotaCeiling` la devuelve como `tz_offset_min`. |
| `multi_provider.quota_alert.<id>` | `config.yaml` | Sección hermana, misma indexación por id canónico. Los umbrales `warn`/`crit` se leen en % del techo. |
| Panel de cuotas MIZPÁ (`lib/provider-quota.js`) | dashboard | `periodo` declarado = ventana `long` del panel (`Sem`/`Día`); `reposicion` = su `resetAt`. |

### 18.7 Tests

- `.pipeline/lib/multi-provider/__tests__/validate-quota-ceilings.test.js` — los dos escenarios
  Gherkin del issue (declarado ⇒ ok y legible; activo sin techo ⇒ falla nombrando al
  proveedor), exención de `deterministic`, alias `claude`/`codex`, porcentaje ⇒ 100, formato de
  `reposicion` por período, un error por campo faltante, no-fuga de `credentials_env`, y el
  `config.yaml` + `agent-models.json` reales del repo.
- `.pipeline/lib/__tests__/config-schema.test.js` — enum inválido (`periodo: mensual`,
  `unidad: dolares`), `techo` negativo, clave requerida faltante, `reposicion` con formato
  inválido, id con typo con sugerencia, clave desconocida, lado kernel, y la sección real del
  repo con los 3 proveedores.

---

## 19. Saldo, ritmo y proyección de agotamiento de cuota (#6560)

Es **el balance** del libro contable de cuota. [§14.2](#142-telemetría-y-diagnóstico) registra
el **consumo** por ejecución (#6558) y [§18](#18-techo-de-cuota-contratada-por-proveedor-6559)
declara el **techo** (#6559); esta sección cruza ambos y responde, por proveedor y período
vigente, *cuánto llevamos*, *cuánto falta*, *por cuánto nos pasamos*, *a qué ritmo* y *cuándo
se agota* — y deja persistidas las series que el auditor del modelo operativo (#6809) necesita
para concluir sobre plan/schedule/cadena sin cruzar logs a mano.

Programa *Contabilidad y balanceo de cuota por proveedor*: #6558 (consumo) → #6559 (techo) →
**#6560 (saldo y ritmo)** → #6561 (ruteo), #6565 (panel), #6809 (auditor).

### 19.1 Unidad de medida: el % que reporta el proveedor

Los tres techos declarados son `unidad: porcentaje` y #6558 registra **tokens**. No hay
conversión posible (Claude Max y ChatGPT Plus no publican el cupo en tokens), así que **el
consumo acumulado del período es el % que reporta el propio proveedor**:

| Proveedor | Fuente del % de la ventana larga | Cómo llega |
|---|---|---|
| `anthropic` | `claude -p /usage` → `metrics/anthropic-usage.json` (`weeklyPct`, `weeklyResetsAt`) | `quotaSlice` → `providers.anthropic.weekly.{pct, resetAt}` |
| `openai-codex` | rollouts `~/.codex/sessions` (`rate_limits.secondary.used_percent`, `resets_at`) | `quotaSlice` → `providers['openai-codex'].weekly.{pct, resetAt}` |
| `antigravity` | adapter `not_implemented` | `pct: null` ⇒ `confidence: missing` |

Cada muestra del ledger es "consumo acumulado reportado por el proveedor en la unidad del
techo". Con unidades absolutas (`tokens`, `mensajes`, `creditos`) la muestra es el acumulado
absoluto y, si no hay muestras, `computeQuotaBalance` cae a la suma de `provider-cost.jsonl`
v2 (sólo líneas `reliable`). Los tokens de #6558 sí son la base de la serie *trabajo ganado por
unidad de cuota* (§19.4).

### 19.2 El ledger: `state/quota-ledger.jsonl`

Antes de #6560 **no existía ninguna serie temporal de %**: todas las fuentes eran "último
valor sobreescrito". Sin serie no hay ritmo ni proyección. El ledger es append-only, una línea
por muestra, escrito por `quotaSlice` en cada poll real de `/api/dash/quota` (misma cadencia y
misma regla que el guard #4282 y el pacing #4289: nunca con `skipSideEffects`, nunca rompe el
slice):

```json
{"ts":"2026-09-21T16:20:38.335Z","provider":"anthropic","bucket":"weekly","pct":19,"reset_at":"2026-09-28T00:00:00.000Z","confidence":"fresh","source":"quota-slice","window_reset":false,"reset_motivo":null}
```

- `bucket`: `weekly` (ventana larga = `periodo` declarado en §18) o `session` (ventana corta).
- **Debounce:** se escribe si cambió el valor, si pasó el intervalo mínimo (15 min) o si hubo
  reinicio de ventana. Volumen esperado: cientos de líneas por día, no miles.
- **`window_reset: true`** marca la muestra **posterior** a un reinicio de ventana: cambio de
  `reset_at` hacia adelante o caída del acumulado ≥ 2 pts. `reset_motivo` es `credito` si hay
  un canje de #7185 (`state/codex-reset-credit.json → redemptions[].redeemed_at`) a ±15 min,
  y `reposicion` en cualquier otro caso. **La caída del % no es consumo negativo** (CA-7).
- Lectura por la **cola** del archivo (4 MB por default): un ledger que creció un año no se
  carga entero en cada poll.
- El ledger arranca vacío en cada checkout nuevo (vive en `state/`, ignorado por git). No es
  un bug: las primeras proyecciones aparecen cuando hay ≥ 3 muestras frescas en la ventana.

### 19.3 La fórmula: `computeQuotaBalance(config, samples, { now })`

`.pipeline/lib/multi-provider/quota-balance.js` es **puro** (sin I/O, `now` inyectado) y es el
**único** lugar donde vive la fórmula (CA-5): el ruteo (#6561) lo llama directo y el dashboard
(#6565) lee el slice; nadie re-deriva umbrales ni semáforos.

```js
const qb = require('.pipeline/lib/multi-provider/quota-balance');
const ledger = require('.pipeline/lib/multi-provider/quota-ledger');
const r = qb.computeQuotaBalance(config, ledger.readSamples({ pipelineDir }), { now: Date.now() });
r.providers.anthropic
// → { techo: 100, consumo: 60, saldo_pts: 40, excedente_pts: 0, balance_pts: 40,
//     ritmo_pts_por_hora: 2, agota_at: '…', agota_en_ms: 72000000,
//     cierre_periodo_at: '2026-09-28T00:00:00.000Z', cierre_en_ms: …, al_cierre_pts: -264,
//     estado: 'se_agota_antes', confidence: 'fresh', muestra_at: '…', muestras: 7,
//     ventana_movil_min: 60, min_muestras: 3, ultimo_reset: null, … }
```

| Campo | Qué es |
|---|---|
| `periodo_inicio_at` / `cierre_periodo_at` / `cierre_en_ms` | Período vigente. Reposición **fija** (`dom 21:00`, `03:00`, `:00`): último corte en hora local de `tz_offset_min` (misma aritmética que `weekly-quota.js`) y cierre = inicio + longitud. **Rolling**: el cierre es el `reset_at` que reporta el proveedor; sin `reset_at`, `cierre_periodo_at: null` (`cierre_fuente: rolling_sin_reset`). |
| `consumo` / `consumo_pct` | Acumulado del período (la muestra más reciente dentro del período; un `window_reset` observado corre el inicio efectivo). |
| `saldo_pts` / `excedente_pts` | `max(0, techo − consumo)` y `max(0, consumo − techo)`. **Puntos** del techo, no "% del %". El saldo nunca es negativo; el excedente va en campo propio (UX §3). |
| `balance_pts` | `techo − consumo` con signo: "si el período cerrara ahora, cuánto sobra o falta". |
| `ritmo_pts_por_hora` | Pendiente por mínimos cuadrados de las muestras de la **ventana móvil** (60 min) que terminan en la última muestra. `null` si `confidence ≠ fresh` o hay menos de `min_muestras` (3). Pendientes negativas o ínfimas ⇒ 0. |
| `agota_at` / `agota_en_ms` | `muestra_at + saldo / ritmo`. `null` sin ritmo, con ritmo 0 o ya excedido. |
| `al_cierre_pts` | Saldo proyectado al cierre con signo (positivo sobra, negativo falta). `null` si no hay ritmo ni cierre. |
| `confidence` | `fresh` / `stale` (última muestra > 30 min) / `missing` (sin muestras en el período). |
| `estado` | Veredicto único (UX §1): `alcanza`, `se_agota_antes`, `excedido`, `sin_datos`, `desactualizado`, `sin_proyeccion` (fresco pero sin ritmo: muestras insuficientes). |
| `ultimo_reset` | `{ at, motivo: reposicion \| credito }` del último reinicio de ventana dentro del período, o `null`. |

Reglas de honestidad (guru §6, UX §4): **nunca se proyecta sobre dato viejo**; un proveedor
sin muestras devuelve **saldo completo con `estado: sin_datos`** (CA-4) — que el ruteo debe
distinguir de "100 % libre real"; un proveedor sin techo declarado **no aparece** (no se asume
infinito). Parámetros (`ventanaMovilMin`, `minMuestras`, `staleAfterMs`, `resetDropPts`) son
opciones de la función con defaults en `quota-balance.DEFAULTS`.

### 19.4 Series derivadas: `state/quota-series.jsonl`

`.pipeline/lib/multi-provider/quota-series.js` (puro) calcula las cuatro series de CA-6 sobre
un rango; el slice las persiste **append-only con timestamp** (debounce 1 h) para que #6809
pueda leerlas sin cruzar logs:

| Serie | Fuentes | Qué devuelve |
|---|---|---|
| `gateado[provider]` — horas gateado por motivo | `logs/quota-detector-*.log` (`flag_set` → `drained_post_reset`/`cleared`/`manual_clear`/`reset_credit_redeemed`), `audit/multi-provider-health.jsonl` (`health_state_transition` a `red`), `provider-schedule.json` (ventanas OFF, vía `provider-schedule.isProviderActiveNow`) | `horas.{quota_exhausted_sesion, quota_exhausted_semanal, health, schedule, credencial, total}` + `intervalos[]`. La ventana sesión/semanal sale del `error_type` (`usage_limit_reached`/`usage_limit_error` ⇒ sesión; `insufficient_quota`/`weekly_limit_content_channel` ⇒ semanal; desconocido ⇒ por duración) hasta que #7550 la promueva a campo estructurado. `total` es la unión (sin doble conteo). |
| `cadena_agotada` — cadena agotada con trabajo elegible | `gate_blocked_spawn` (ya existía, con `issue=… fase=…` en `raw_excerpt`) → **`dispatch_resumed`** (nuevo en `pulpo.js`: se emite al limpiar un backoff de cadena agotada, mismo formato) | `horas_total`, `horas_union`, `por_fase`, `intervalos[{skill, issue, fase, desde, hasta, horas, intentos, abierto}]`. Antes el intervalo sólo vivía en `pulpo.log` y `dispatch-backoff.json` (volátil). |
| `unica_pata` — única pata viva | derivada de `gateado`: "viva" = no gateada por `schedule`/`health`/`credencial` | `horas_unica_pata`, `horas_unica_pata_gateada` (esa pata gateada por cuota), `horas_sin_patas`, `por_pata`. El caso 2026-09-11 (codex única pata, gateado ≈15 h de 26 h) sale de acá. |
| `trabajo_por_cuota[provider]` — trabajo ganado por unidad de cuota | `provider-cost.jsonl` v2 (`resultado: ganada`, `fase`) ÷ puntos consumidos del ledger en el mismo rango (deltas positivos; los `window_reset` no cuentan) | `ganadas`, `totales`, `pct_consumido`, `ganadas_por_pct`, `por_fase`. |

El schedule que se aplica es el **vigente** para todo el rango (los cambios de schedule no
quedan versionados): por eso el snapshot horario persistido es la fuente del auditor, no un
recálculo tardío.

### 19.5 Exposición: `GET /api/dash/quota-balance`

```
GET /api/dash/quota-balance?horas=24      (default 24, tope 168)
→ { ok, computed_at, horas,
    balance: { schema, computed_at, ventana_movil_min, min_muestras, providers: { anthropic: {…}, 'openai-codex': {…}, antigravity: {…} } },
    series:  { schema, ventana, gateado, cadena_agotada, unica_pata, trabajo_por_cuota } }
```

Slice `quotaBalanceSlice(state, ctx, { horas, now })` en `dashboard-slices.js`. Fail-closed:
si el config no resuelve o falta un módulo devuelve `{ ok: false, motivo, balance: { providers: {} } }`,
nunca un saldo inventado. Con `ctx.skipSideEffects` no persiste el snapshot de series. Los
tiempos van en UTC (`*_at`) y como delta (`*_en_ms`); la presentación (#6565) formatea con
`tz_offset_min`, no calcula.

### 19.6 Operación

- **Reiniciar el pulpo/dashboard al mergear** (memoria operativa #7438): el motor corre desde
  el repo principal. El ledger empieza vacío; las proyecciones aparecen tras ~15 min de polls.
- **Diagnóstico rápido:** `tail state/quota-ledger.jsonl` (¿llegan muestras?), `curl
  localhost:<dash>/api/dash/quota-balance | jq .balance.providers.anthropic.estado`.
- **Relación con lo que ya existía:** el guard #4282 y el pacing #4289 siguen leyendo el
  `pct`/`confidence` del mismo `quotaSlice`; #6560 no los reemplaza, agrega la serie y el
  balance. `provider-quota.recordSample` (seam de #4533, sin callers) sigue intacto — lo cubren
  #4948/#4543/#5018.

### 19.7 Tests

- `.pipeline/lib/multi-provider/__tests__/quota-balance.test.js` — los dos escenarios Gherkin
  del issue, CA-1..CA-4 y CA-7, reset fijo por período (semanal/diario/horario) y rolling,
  stale ⇒ sin proyección, mínimo de muestras, ventana móvil, crédito de codex, techo en tokens.
- `.pipeline/lib/multi-provider/__tests__/quota-series.test.js` — las cuatro series con
  fixtures del shape real de los logs, incluido el caso 2026-09-11.
- `.pipeline/lib/multi-provider/__tests__/quota-ledger.test.js` — whitelist, debounce,
  reinicio de ventana, ingesta desde el slice, snapshot horario, lectores.
- `.pipeline/tests/quota-balance-wiring-6560.test.js` — ruta, slice fail-closed, ingesta en
  `quotaSlice` y evento `dispatch_resumed` en `pulpo.js`.

---

## 20. Balanceo de carga entre proveedores por saldo de cuota y ritmo (#6561)

> Programa "Contabilidad y balanceo de cuota por proveedor" (4 de 10). Es la **capa de
> decisión** del libro contable: con el balance de §19 (saldo, ritmo, proyección) el
> dispatcher deja de tratar a los proveedores como un semáforo binario ("disponible /
> agotado") y prefiere al que **más saldo relativo** conserva. Caso que lo motiva (medido el
> 25/08/2026): Codex al 100 % de cuota agotada desde las 03:22 y Claude con el 70 % libre sin
> usar.

### 20.1 Dónde vive y cuándo participa

| Pieza | Dónde | Qué hace |
|---|---|---|
| Plan de balanceo (puro) | `.pipeline/lib/agent-launcher/quota-balancer.js` → `planQuotaBalance({chain, balance, policy, fase})` | Reordena la cadena declarada del skill (primario + `fallbacks[]`) por saldo relativo con umbral, desempate por orden declarado y reserva de fin de período. Sin I/O. |
| Lectura del balance | mismo módulo → `readQuotaBalanceForDispatch({config, pipelineDir, now, providers})` | Lee la cola de `state/quota-ledger.jsonl` y llama `computeQuotaBalance` (§19.3). Never-throws; caché en memoria de 30 s por `pipelineDir` para ráfagas de spawn. |
| Integración | `dispatch-with-fallback.js` → `resolveSpawnWithFallback({... config, fase})` | Un solo bloque bajo `try/catch` fail-open, entre los gates del primario y el recorrido de fallbacks. |
| Cableado | `pulpo.js` → `lanzarAgenteClaude` | Pasa `config` (el YAML parseado) y `fase`. Las sondas read-only del Commander no pasan `config` ⇒ no balancean (comportamiento previo intacto). |

El balanceo **sólo participa** cuando el llamador pasa `config` **y** hay dato fresco
(`confidence: 'fresh'`, §19.3) para **al menos dos** candidatos de la cadena. En cualquier
otro caso — ledger ausente (primer arranque), muestras viejas (`stale`), un solo candidato,
error del lector, `enabled: false` — el ruteo es **exactamente el de antes** (orden
declarado) y el log lo dice de forma explícita.

### 20.2 Política de reparto (qué manda sobre qué)

1. **Hard gates primero, siempre**: cuota agotada (`shouldGateSpawn`), kill-switch (#3811),
   horario (#3871), pacing rojo (#4289), health rojo (#3809), credencial (MP-05). Un candidato
   hard-gated se descarta aunque el plan lo rankee primero. La **capacidad por fase** está
   garantizada por `agent-models-validate.js` sobre la cadena declarada: el balanceo **no
   expande** la cadena, sólo la reordena.
2. **Soft gates previos** (#4282 degradación preventiva, #4289 amarillo) se respetan: si el
   primario ya estaba soft-gated, el balanceo no lo "rescata".
3. **Orden por agente = conjunto y desempate.** El saldo sólo reordena cuando la diferencia de
   saldo relativo (`saldo_pts / techo`, en puntos porcentuales) alcanza
   `multi_provider.balanceo.delta_min_pct` (default **15**). Por debajo, gana el orden
   declarado (anti-flapping). Empate exacto ⇒ orden declarado.
4. **Reserva de fin de período** (cambio 3): fuera de `fases_criticas` (default
   `verificacion`, `aprobacion`, `delivery`), un candidato con saldo relativo <
   `margen_reserva_pct` (default **20**) queda *reservado* y se rankea después de los no
   reservados. **Nunca es un veto**: si todos están bajo el margen se comparan igual, y si el
   reservado es el único hábil se usa.
5. **Honestidad (§19)**: un candidato sin dato fresco **no participa** y conserva su posición
   declarada; los que sí participan se reordenan entre las posiciones que ocupaban. Así
   `antigravity` (que no reporta consumo verificable) no queda ni premiado ni castigado.
6. **El balanceo prefiere, no veta.** Si el primario fue diferido sólo por saldo y ningún
   candidato mejor rankeado resuelve (o los que faltan rankean peor que él), se usa el
   primario (`balanceCede: true`). La cadena nunca se vacía por saldo.

Orden de recorrido cuando el primario está hard-gated: los fallbacks se visitan según el
ranking del plan (índices `< MAX_FALLBACK_DEPTH`), conservando el `fallback_index` declarado
en el audit.

### 20.3 Cómo leer una decisión de balanceo en el log

El bloque es el mismo de #3823 (`formatProviderResolutionLog`); el balanceo se suma como un
motivo más, con la misma voz.

**Happy path — el balanceo confirma al primario (una sola línea, con sufijo):**

```
✓ guru:#6561 provider=anthropic (primary, sin fallback necesario) (balanceo: anthropic 68 % · openai-codex 12 %, mayor saldo → orden declarado)
✓ guru:#6561 provider=anthropic (primary, sin fallback necesario) (balanceo: anthropic 40 % · openai-codex 50 %, delta < 15 → orden declarado)
✓ guru:#6561 provider=anthropic (primary, sin fallback necesario) (balanceo: degradado (sin_datos) → orden declarado)
```

La tercera línea es el **primer arranque** (ledger sin muestras) — se distingue de "saldos
parecidos" a propósito, para que nadie crea que el balanceo no funciona el primer día.

**El saldo cambió la decisión (bloque multilínea + línea `Balanceo:`):**

```
🔄 guru:#6561 — Resolución de provider:
  → anthropic (DESCARTADO: quota_balance_prefer_other (saldo relativo menor (balanceo)) — saldo 12 % · ritmo 3.1 pts/h · se agota ~2026-09-21T18:05:00.000Z — mejor: openai-codex)
  ✓ openai-codex (ELEGIDO — fallback[0], model=gpt-5-codex)
  Chain evaluada: anthropic → openai-codex (2 eslabones evaluados)
  Balanceo: regla=saldo (anthropic 12 % · openai-codex 71 %, delta 59 ≥ umbral 15 → openai-codex) · restricciones respetadas: hard-gates ✓ capacidad ✓ horario ✓ orden=desempate
```

**Reserva de fin de período (soft, el proveedor sigue hábil):**

```
  → anthropic (DESCARTADO: quota_reserve_critical (reservado para fases críticas) — fase=dev · saldo=12 % · margen=20 %)
  ...
  Balanceo: regla=reserva (anthropic 12 % · openai-codex 22 %, anthropic reservado (< 20 %, fase=dev) → openai-codex) · ...
```

**El mejor por saldo no era hábil (Gherkin 2):** el descarte lleva la restricción real
(`provider_inactive_by_schedule`, `quota_exhausted`, …) y el primario vuelve con
`⚖️↩️ … balanceo por saldo sin mejor candidato resoluble — uso el primary`.

### 20.4 Audit estructurado: `balance_by_quota`

Un evento por decisión en `logs/cross-provider-dispatch-YYYY-MM-DD.jsonl` (hash-chain de
`auditAppend`), con los candidatos completos para que el dashboard (#6565 y siguientes)
dibuje la comparación sin re-derivar:

```json
{ "event": "balance_by_quota", "skill": "guru", "issue": 6561,
  "primary_provider": "anthropic", "primary_deferred_by_balance": true,
  "elegido": "openai-codex", "regla": "saldo", "fuente": "fresh", "degradado_motivo": null,
  "umbral": 15, "margen_reserva_pct": 20, "fase": "dev", "fase_critica": false,
  "orden": ["openai-codex", "anthropic"],
  "candidatos": [
    { "provider": "anthropic", "orden_declarado": 0, "saldo_relativo": 12, "ritmo_pts_por_hora": 3.1,
      "agota_at": "2026-09-21T18:05:00.000Z", "estado": "se_agota_antes", "confidence": "fresh",
      "participa": true, "reservado": false, "motivo": "saldo relativo menor (12 % vs 71 %)" },
    { "provider": "openai-codex", "orden_declarado": 1, "saldo_relativo": 71, "ritmo_pts_por_hora": 0.8,
      "agota_at": null, "estado": "alcanza", "confidence": "fresh",
      "participa": true, "reservado": false, "motivo": "mayor saldo relativo (71 %)" }
  ] }
```

`regla` ∈ `saldo | orden | degradado | reserva`; `degradado_motivo` ∈ `deshabilitado |
sin_balance | sin_datos | desactualizado | sin_techo | un_solo_candidato | insuficiente`.
El mismo resumen viaja en el resultado de `resolveSpawnWithFallback` como `balance` (null
cuando el balanceo no participó).

### 20.5 Configuración

```yaml
multi_provider:
  balanceo:
    enabled: true                 # false ⇒ orden declarado puro (degradado: deshabilitado)
    delta_min_pct: 15             # puntos porcentuales de saldo relativo para reordenar
    fases_criticas: [verificacion, aprobacion, delivery]
    margen_reserva_pct: 20        # bajo este saldo relativo se reserva para fases críticas
```

Valores fuera de tipo/rango caen al default y se avisan en el log de lanzamiento
(`multi_provider.balanceo con valores inválidos (se usan defaults)`). El schema
(`config-schema.js`) es lenient en claves y estricto en tipos, como el resto de
`multi_provider`.

### 20.6 Operación

- **Rollout:** requiere reinicio del pulpo (el repo principal sólo se actualiza al respawn).
  Hasta que el ledger acumule ≥ 3 muestras frescas por proveedor (§19.3) el selector opera en
  modo degradado y lo dice en cada línea `✓`.
- **Sin Telegram por decisión** (UX §8): elegir un fallback por saldo **no es una degradación**
  — el primario tiene cuota, está en horario, con credencial y sin kill-switch — y por eso el
  dispatcher lo registra en el episodio de #6179 como `crossProvider: false` (modo `primario`).
  Consecuencias verificadas con el módulo real de episodio (`fallback-episode-state`) y
  `notify` capturado (tests de regresión de §20.7):
  - dos o más spawns balanceados seguidos ⇒ **0 avisos** y el archivo
    `state/fallback-episode.json` queda en modo `primario` (nunca `respaldo`);
  - si había un episodio **real** abierto (un spawn anterior con el primario hard-gateado), el
    primer spawn balanceado con el primario ya sano lo **cierra una sola vez** ("✅ volvió al
    motor principal") — coherente: el pipeline dejó de estar degradado, está balanceando — y los
    siguientes no vuelven a abrirlo (sin flapping);
  - el salto por gate real (cuota agotada, horario, kill-switch, pacing rojo, soft-gate
    preventivo) conserva su semántica: `crossProvider: true` en el episodio y aviso de
    "entra en respaldo" según la política de #6179.
- **Trazabilidad del salto por balanceo (CA-4):** cuando el primario está sano y sólo fue
  diferido por saldo, la línea de salto es `⚖️↪️ <skill>:#<issue> primary=<P> diferido por
  balanceo (sano, con menor saldo relativo), usando fallback="<F>"` (no `primary=<P> gated`), el
  audit `fallback_selected` lleva `primary_deferred_by_balance: true` y `raw_excerpt:
  "primary=<P> diferido por balanceo, fallback=<F> preferido por saldo"`, y el resultado expone
  `disqualifyReason: 'primary_quota_balance_deferred'` (literal estático, mismo criterio que
  `balancer_selected` del Commander) más `primaryBalanceDeferred: true`, así
  `_trace.resolution.reason` del pulpo no queda vacío. El `crossProvider: true` del **resultado**
  se conserva (el pulpo lo usa para args/billing del provider efectivo); sólo el avisador deja de
  leerlo como degradación.
- **Apagar de urgencia:** `multi_provider.balanceo.enabled: false` + reinicio. No hay
  kill-switch en caliente porque el balanceo nunca es causa de que un agente no se lance.

### 20.7 Tests

- `.pipeline/tests/dispatch-quota-balance-6561.test.js` — los dos Gherkin, CA-1..CA-5,
  umbral, reserva (fase crítica / no crítica / todos bajo el margen / único hábil),
  precedencia de hard y soft gates, preempción del primario, orden del plan en el recorrido,
  audit `balance_by_quota` sin secretos, degradaciones (sin config, sin ledger, stale, lector
  que tira, deshabilitado, config inválida) e integración real con `quota-ledger` +
  `quota-balance` (caso medido 25/08, caché, muestras viejas). Sección "regresión (review
  rev-1)": con `recordEpisode` activo (módulo real sobre el `pipelineDir` temporal) y `notify`
  capturado — dos spawns balanceados ⇒ 0 avisos y sin episodio en modo `respaldo`;
  trazabilidad "diferido por balanceo" + `primary_quota_balance_deferred`; el gate real sigue
  diciendo "gated" y abre episodio; episodio real abierto + spawns balanceados ⇒ se cierra una
  vez y no flapea.
- `.pipeline/tests/dispatch-skip-reasons-3823.test.js` — cobertura de los códigos nuevos
  `quota_balance_prefer_other` y `quota_reserve_critical`.

---

## Apéndice — links rápidos

- **Código:** [`.pipeline/agent-models.json`](../../.pipeline/agent-models.json), [`.pipeline/agent-models.schema.json`](../../.pipeline/agent-models.schema.json), [`.pipeline/lib/agent-models-validate.js`](../../.pipeline/lib/agent-models-validate.js), [`.pipeline/validate-agent-models.js`](../../.pipeline/validate-agent-models.js), [`.pipeline/lib/multi-provider/`](../../.pipeline/lib/multi-provider/), [`.pipeline/lib/quota-adapters/`](../../.pipeline/lib/quota-adapters/), [`.pipeline/lib/agent-launcher/`](../../.pipeline/lib/agent-launcher/).
- **Techo de cuota por proveedor (#6559):** [`.pipeline/lib/multi-provider/validate-quota-ceilings.js`](../../.pipeline/lib/multi-provider/validate-quota-ceilings.js) (validador puro + CLI + `getQuotaCeiling`), sección `multi_provider.quota` de [`.pipeline/config.yaml`](../../.pipeline/config.yaml), schema en [`.pipeline/lib/config-schema.js`](../../.pipeline/lib/config-schema.js) — ver §18.
- **Balanceo por saldo y ritmo (#6561):** [`.pipeline/lib/agent-launcher/quota-balancer.js`](../../.pipeline/lib/agent-launcher/quota-balancer.js) (plan puro + lector con caché), integración en [`dispatch-with-fallback.js`](../../.pipeline/lib/agent-launcher/dispatch-with-fallback.js) (`balance_by_quota`, `quota_balance_prefer_other`, `quota_reserve_critical`), sección `multi_provider.balanceo` de [`.pipeline/config.yaml`](../../.pipeline/config.yaml) — ver §20.
- **Saldo, ritmo y proyección (#6560):** [`.pipeline/lib/multi-provider/quota-balance.js`](../../.pipeline/lib/multi-provider/quota-balance.js) (fórmula pura), [`quota-ledger.js`](../../.pipeline/lib/multi-provider/quota-ledger.js) (serie persistida + lectores), [`quota-series.js`](../../.pipeline/lib/multi-provider/quota-series.js) (series derivadas), slice `quotaBalanceSlice` en [`dashboard-slices.js`](../../.pipeline/lib/dashboard-slices.js) → `GET /api/dash/quota-balance` — ver §19.
- **Diseño y decisiones:** [`docs/pipeline-multi-provider.md`](../pipeline-multi-provider.md) (1140 líneas, design doc v2).
- **Permission mapping (capabilities cross-provider):** [`docs/pipeline-multi-provider/permission-mapping.md`](../pipeline-multi-provider/permission-mapping.md).
- **Data residency / exclusiones:** [`docs/pipeline-multi-provider/data-residency.md`](../pipeline-multi-provider/data-residency.md).
- **Issue de esta doc:** [#3176](https://github.com/intrale/platform/issues/3176).
- **Issues de mejora futura:** [#3197](https://github.com/intrale/platform/issues/3197) (auto-gen tablas).
- **Issues cerrados relevantes:** [#3198](https://github.com/intrale/platform/issues/3198) (consumer runtime de fallbacks, mergeado 2026-05-15 — ver §2.3).
- **Épico multi-provider end-to-end (#3791):** [#4401](https://github.com/intrale/platform/issues/4401) (smoke CLI + candado free-only), [#4402](https://github.com/intrale/platform/issues/4402) (health honesto OAuth), [#4403](https://github.com/intrale/platform/issues/4403) (telemetría `provider-cost.jsonl`), [#4404](https://github.com/intrale/platform/issues/4404) (failover + data-residency), [#4405](https://github.com/intrale/platform/issues/4405) (esta doc operativa — §14).

## 20. Auditor calidad-precio por agente (#6793)

Doc completa: [`docs/pipeline/model-value-audit.md`](model-value-audit.md). Resumen operativo:

- **Qué hace**: cada `cadence_days` (7) el Pulpo corre `lib/model-value-audit` sobre los últimos `window_days` (≥ 30) y emite por skill `subir de modelo` / `bajar de modelo` / `mantener` / `sin evidencia suficiente` / `no evaluable`, con evidencia numérica. **Marca, no ejecuta**: nunca edita `agent-models.json`.
- **Cómo avisa**: como máximo **un** mensaje de Telegram por corrida (texto plano + narración), y sólo si hay un `subir`/`bajar` o un hallazgo de precios (tabla vencida o modelo sin precio, #7507). Todo `mantener` con precios al día ⇒ silencio explicado en `pulpo.log` (`model-value`).
- **Config**: sección `model_value_audit` de `config.yaml`, fail-closed (`enabled: false` de fábrica; sólo `true` exacto enciende). `enabled`/`registrar`/`publish`/`protected_skills` son de autoridad (sin override por entorno). Schema estricto: `window_days` mínimo 30, umbrales en `[0, 1]`, `publish ∈ {telegram-plain, registry, none}`.
- **Escrituras**: sólo `state/model-value-audit-cron.json` (cadencia) y, con `registrar: true`, `audit/model-value-audit.jsonl` (append-only con hash-chain). Ambas vía `write-target`.
- **Reproducir a mano**: `node .pipeline/scripts/model-value-report.js --dias=30 --hasta=YYYY-MM-DD` (el mensaje cita el comando exacto y `ref <hash8>` de su evidencia).
- **Dependencias abiertas**: #7507 (precios de `claude-opus-5`), #7506 (costo con caché), #7508 (integridad de las fuentes secundarias), #6807 (registro único de propuestas ⇒ adaptador `registry` y dedup).
- **Apagar**: `enabled: false` en archivo (≤ 1 h sin restart); sólo el audio: `audio_policy.by_event.model_value_audit: false` en `pipeline.config.json`.
