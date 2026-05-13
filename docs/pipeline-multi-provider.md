# Pipeline multi-modelo / multi-proveedor de IA — diseño

> Issue [#2956](https://github.com/intrale/platform/issues/2956) — Investigación + diseño v1.
> Issue [#3065](https://github.com/intrale/platform/issues/3065) — **Refinamiento v2** (este documento).
> Estado: propuesta. **Este documento NO implementa código** — la implementación sale como issues hijos enumerados en §5.
> Fecha del relevamiento empírico v1: 2026-05-06. Refinamiento v2: 2026-05-07.
> Autor v1: pipeline-dev (agente). Refinamiento v2: pipeline-dev (agente) sobre análisis de guru, security, po y ux.

---

## Changelog v2 (refinamiento del 2026-05-07)

Este documento es la **versión 2** del diseño multi-proveedor. Se itera sobre la versión 1 (#2956) sin borrar nada esencial — sólo se reordena la narrativa, se cierran 3 inconsistencias estructurales detectadas por Leo y se incorporan controles de seguridad y guidelines UX.

**Inconsistencias resueltas (motivadas por #3065):**

1. **Humano en el loop como default era un cuello de botella permanente** — la versión 1 exigía aprobación humana para CUALQUIER switch de modelo o proveedor. La versión 2 separa explícitamente:
   - Switch **cross-MODELO** dentro del mismo proveedor → automático (sin barrera humana).
   - Switch **cross-PROVIDER** (TOS/DPA distinto) → con aprobación humana.
2. **Deadlock lógico aparente** — la versión 1 no declaraba quién detecta cuota agotada y manda la notificación cuando el agente que debería avisar es justamente el bloqueado. La versión 2 documenta que la detección y la notificación corren en código determinístico (Node, sin LLM): `lib/quota-exhausted.js` + `sendTelegram` + cola filesystem `servicios/telegram/`. Estos componentes ya existen y no requieren al agente bloqueado.
3. **Cross-MODELO era la dimensión secundaria, cross-PROVIDER la primaria** — la narrativa v1 trataba al proveedor como eje principal y al modelo como override. La versión 2 invierte el orden: cross-MODELO (Opus / Sonnet / Haiku por skill, todos Anthropic) es la dimensión primaria — análoga al trabajo ya hecho en `docs/agents-model-optimization.md` (#1244) — y cross-PROVIDER es la extensión opcional.

**Controles de seguridad agregados (motivados por análisis de security):**

- §6.8.2 — integridad de inputs del algoritmo de selección (`activity-log.jsonl` pasa a security-critical). Hardening pendiente: [#3067](https://github.com/intrale/platform/issues/3067).
- §6.8.3 — audit log dedicado de switches automáticos con hash chain SHA-256. Hardening pendiente: [#3068](https://github.com/intrale/platform/issues/3068).
- §6.10 extendida — disciplina anti path-traversal al generalizar el flag de cuota a granularidad provider/skill.
- §6.11 — lista hardcoded de skills no-degradables (`security`, `review`, `builder`, `tester`). Hardening pendiente: [#3066](https://github.com/intrale/platform/issues/3066).

**Guidelines UX incorporadas (motivadas por análisis de ux):** §7 extendida con plantillas de mensajes Telegram (cross-MODELO informativo, cross-PROVIDER decisorio) y formato de confirmación humana del refinamiento.

**Confirmación humana del refinamiento (CA-12 de #3065):** este documento queda bloqueado de merge hasta que Leo apruebe explícitamente el nuevo enfoque — política dual, cross-modelo primario, algoritmo autónomo. Ver §7.7.

---

## Por qué esta historia

Cuando se agota la cuota Anthropic todo el pipeline se frena. El issue [#2955](https://github.com/intrale/platform/issues/2955) cubre el fallback determinístico (skills sin LLM siguen funcionando), pero **no permite seguir produciendo trabajo que sí necesita LLM**: análisis, refinamiento, criterios, dev de código, review.

El objetivo de este diseño es que el pipeline elija **autónomamente qué modelo usar por skill**, primero dentro del proveedor actual (Opus → Sonnet → Haiku para abaratar 5× sin tocar TOS) y, sólo cuando la cuota completa del proveedor se agota, escalando con aprobación humana a otro proveedor (OpenAI/Codex, Gemini, Ollama local).

La premisa: el sistema funciona solo lo más posible. La intervención humana queda reservada para decisiones que cambian compliance — TOS, DPA, data residency — no para cambiar el modelo dentro del mismo proveedor.

Beneficios:

- **Costo bajado por skill (cross-modelo)**: usar Sonnet para skills template-driven y Haiku para tareas livianas reduce el gasto promedio sin cambiar proveedor. Ya se demostró parcialmente en `docs/agents-model-optimization.md` (#1244).
- **Continuidad (cross-provider, opcional)**: si Anthropic se queda sin cuota completa, los skills críticos pueden seguir contra OpenAI/Codex (con aprobación humana — ver §6.4 y §4.5).
- **Reducción de lock-in**: la lógica del pipeline deja de asumir que la API de Anthropic es la única forma de hablar con un agente.

---

## 1) Inventario empírico de acoplamientos a Anthropic

Verifiqué cada acoplamiento contra el código vigente en `origin/main` al 2026-05-06. La tabla refleja el estado real del repo, no supuestos del issue.

### 1.1 Hallazgo crítico — `agent-models.json` no existe

El issue original lista a `agent-models.json` como punto de partida ("formato actual: `claude-opus-4-6`, `claude-sonnet-4-6`"). **Ese archivo no existe en el repo**:

```
$ ls .pipeline/agent-models.json
ls: cannot access '.pipeline/agent-models.json': No such file or directory
```

La asignación de modelo está **hardcoded** en dos lugares:

- `.pipeline/pulpo.js:4903` → `model: 'claude-opus-4-7'`.
- `.pipeline/lib/traceability.js:11` (comentario de uso típico, también referenciado por defaults).

Implicancia: el primer entregable real del MVP es **crear** `agent-models.json` (no extenderlo), eliminar el hardcode y migrar telemetría a leer del archivo. Ese trabajo aparece como **primer issue hijo prerrequisito** en §5.

### 1.2 Tabla de acoplamientos (A1–A11) + extras detectados

| # | Acoplamiento | Archivo : línea | Específico de | Nivel |
|---|--------------|-----------------|---------------|-------|
| A1 | Detección de launcher Claude Code | `.pipeline/pulpo.js:102-127` (`detectClaudeLauncher`) — busca `@anthropic-ai/claude-code` en `APPDATA/npm/node_modules` | Claude Code CLI | crítico |
| A2 | Constante global del launcher | `.pipeline/pulpo.js:129` (`CLAUDE_LAUNCHER`) | Claude Code | crítico |
| A3 | Args de spawn LLM | `.pipeline/pulpo.js:4804` — `['-p', userPrompt, '--system-prompt-file', systemFile, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']` | Claude Code CLI | crítico |
| A4 | Parser de tokens stream-json | `.pipeline/pulpo.js:4868-4893` (`parseTokensFromLog`) — lee `obj.message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` | Formato Anthropic `stream-json` | crítico |
| A5 | Modelo en telemetría hardcoded | `.pipeline/pulpo.js:4903` y `.pipeline/lib/traceability.js:11` — `model: 'claude-opus-4-7'` | Anthropic | crítico (defecto actual) |
| A6 | Gate de cuota | `.pipeline/config.yaml:314-319` — `quota_detector.error_types: [usage_limit_error, weekly_quota_exhausted]` + `lib/quota-exhausted.js` | Plan Max Anthropic (semanal) | importante |
| A7 | Workaround bug CLI Claude | `.pipeline/pulpo.js:6235-6240` (referencia a `claude-code#25629`: CLI no termina tras `result` event) | Claude Code | importante |
| A8 | Activity log path con `.claude/` | `.pipeline/lib/traceability.js:34` → `path.join(REPO_ROOT, '.claude', 'activity-log.jsonl')` | Convención del harness Claude Code | nominal |
| A9 | Skills determinísticos hardcoded | `.pipeline/pulpo.js:4851` `DETERMINISTIC_SKILLS = new Set(['builder', 'tester', 'delivery', 'linter'])` | Hardcoded en código, no en config | importante |
| A10 | Roles agnósticos | `.pipeline/roles/*.md` (17 archivos) | NO mencionan Claude — son neutros | sin acoplamiento |
| A11 | `_base.md` | `.pipeline/roles/_base.md` | Agnóstico (texto del pipeline, no del modelo) | sin acoplamiento |

### 1.3 Acoplamientos adicionales detectados durante el análisis

| # | Acoplamiento | Archivo : línea | Implicancia |
|---|--------------|-----------------|-------------|
| A12 | `metrics/aggregator.js` consume shape Anthropic ya normalizado | `.pipeline/metrics/aggregator.js:79-87` lee `evt.{tokens_in, tokens_out, cache_read, cache_write, duration_ms, tool_calls}` | El nuevo provider DEBE alimentar el mismo shape — lo cual es correcto siempre que el adaptador haga la traducción en `parseTokensFromLog` (A4). |
| A13 | Clasificador de modo de ejecución por nombre de modelo | `.pipeline/metrics/aggregator.js:161` `classifyExecutionMode(evt.model)` decide LLM vs determinístico inferiendo del string | Habría que generalizar para que reconozca `model` de cualquier provider O — mejor — dispatching por `provider` explícito en el evento. |
| A14 | Sanitizer de logs limitado a un set de regex | `.pipeline/lib/sanitize-log-stream.js` + `.pipeline/sanitizer.js` (#2334) | El sanitizer existe y es genérico, pero su set de regex de secretos hoy está orientado a credenciales conocidas del repo. Multi-proveedor exige **extender el set** con `sk-` (OpenAI), `AIza` (Google), `claude_*`, etc. — ver §6.5. |
| A15 | `weekly-quota.js` razona en términos de "duration_ms" como proxy de cuota Max Anthropic | `.pipeline/lib/weekly-quota.js:223,242` suma `duration_ms` de `session:end` | Proxy específico del Plan Max (cuota por tiempo). OpenAI/Gemini facturan por tokens, no por minutos. La métrica de "weekly quota" debe migrar a una abstracción `quotaUsage(provider, ...)` cuando entren providers no-Anthropic. |
| A16 | Spawn env propaga `process.env` completo al child | `.pipeline/pulpo.js:4922-4933` `env: { ...process.env, PIPELINE_*, ...extraEnv }` | Hoy es benigno (un solo provider, una sola key). Multi-provider exige aislamiento por proceso (filtrar a allowlist + sólo la key del provider del skill) — ver §6.3. |

### 1.4 Conclusión del inventario

- **Superficie de cambio crítica**: 5 puntos en `pulpo.js` (A1, A2, A3, A4, A5) + `traceability.js` (A8) + `config.yaml` (A6).
- **Roles, skills (`.md`) y hooks de Claude Code** (`.claude/hooks/*.js`) **no requieren cambios funcionales**: los hooks viven en `.claude/` y solo aplican cuando Claude Code es el CLI activo; si arranca otro CLI, simplemente no corren.
- La superficie es **mucho más chica de lo que el issue sugiere** — no hay refactor masivo de SKILL.md ni de hooks.
- **Para cross-MODELO dentro de Anthropic la superficie es aún menor**: A5 (eliminar hardcode), A1/A2/A3 (NO hace falta cambiar — sigue siendo el mismo CLI), A4 (NO hace falta cambiar — sigue siendo el mismo parser stream-json). Es decir: cross-MODELO se habilita esencialmente con **un solo cambio** (A5 + crear `agent-models.json`).

---

## 2) Comparativa de proveedores candidatos (datos al 2026-05-06)

### 2.1 Tabla maestra

| Proveedor | CLI / SDK | Cuota / billing | Tool use / function calling | Streaming | Prompt caching | Latencia típica primera token | TOS / training opt-out |
|-----------|-----------|------------------|-------------------------------|-----------|----------------|---------|-------------------|
| **Anthropic Claude** | `claude` CLI + `@anthropic-ai/claude-code` (estable) + SDK | Plan Max (semanal por tiempo) + API key (mensual por tokens) | sí, tool_use blocks (XML+JSON) | sí, `stream-json` | sí, TTL 5 min default + 1 h opcional | ~600 ms (Opus), ~300 ms (Sonnet) | API: no entrena por default; Plan Max: idem |
| **OpenAI Codex / GPT-5** | `codex` CLI (madurez 2026) + SDK | API key mensual por tokens | sí, function calling JSON Schema (formato distinto) | sí, SSE | auto-cache (sin control fino) | ~500 ms (GPT-5), ~250 ms (GPT-5-mini) | API: no entrena por default si se activa opt-out enterprise |
| **Google Gemini** | `gcloud` + `@google/genai` SDK + `gemini` CLI (beta 2026-Q1) | API key + tier gratuito (entrena con prompts del tier free) | sí, formato `functionCall` propio | sí | sí, contexto explícito ($/MTok-h) | ~400 ms (Flash), ~700 ms (Pro) | Tier free: SÍ entrena. API paga: opt-out configurable |
| **Ollama (local)** | `ollama` CLI + SDK HTTP local | sin cuota (CPU/GPU local) | parcial (depende del modelo: Qwen2.5-Coder, Llama 3.x lo tienen) | sí | no nativo (cache de KV en RAM solamente) | depende del hardware (200 ms a 5 s) | datos no salen del host |
| **OpenRouter (proxy)** | SDK universal compatible OpenAI | API key + margin sobre cada provider | sí (delega al downstream) | sí | depende del downstream | +200 ms vs nativo | TOS de OpenRouter + del provider downstream |

### 2.2 Precios por proveedor (USD, mayo 2026)

> Precios públicos al 2026-05-06. Se registra fuente y se sugiere refrescar al implementar el MVP.

| Modelo | Input ($/MTok) | Output ($/MTok) | Cache write | Cache read | Fuente |
|--------|----------------|------------------|-------------|------------|--------|
| Claude Opus 4.7 | $15 | $75 | 1.25× input | 0.10× input | anthropic.com/pricing |
| Claude Sonnet 4.7 | $3 | $15 | 1.25× input | 0.10× input | anthropic.com/pricing |
| Claude Haiku 4.x | $0.80 | $4 | 1.25× input | 0.10× input | anthropic.com/pricing |
| GPT-5 | $1.25 | $10 | gratis (auto) | gratis (auto) | openai.com/pricing |
| GPT-5-Codex | $1.25 | $10 | gratis (auto) | gratis (auto) | openai.com/pricing |
| GPT-5-mini | $0.25 | $2 | gratis (auto) | gratis (auto) | openai.com/pricing |
| Gemini 2.5 Pro (≤200k tokens) | $1.25 | $10 | $0.31/MTok-h | gratis | ai.google.dev/pricing |
| Gemini 2.5 Pro (>200k tokens) | $2.50 | $15 | $0.625/MTok-h | gratis | ai.google.dev/pricing |
| Gemini 2.5 Flash | $0.30 | $2.50 | n/a | n/a | ai.google.dev/pricing |
| Ollama Qwen2.5-Coder:32b | $0 (local) | $0 | n/a | n/a | self-hosted |

**Nota sobre la dimensión primaria del diseño**: dentro del mismo proveedor (Anthropic), pasar de Opus a Sonnet ya baja ~5× el costo input ($15 → $3) y output ($75 → $15) **sin tocar TOS, DPA ni región**. Por eso el MVP prioriza cross-MODELO antes que cross-PROVIDER.

### 2.3 Costo simulado contra el consumo histórico del pipeline

El pipeline ya guarda métricas de tokens reales por sesión en `.claude/activity-log.jsonl` (eventos `session:end` con `tokens_in`, `tokens_out`, `cache_read`, `cache_write`). Ejemplo de evento real:

```json
{"event":"session:end","skill":"ux","issue":3015,"phase":"criterios",
 "model":"claude-opus-4-7","tokens_in":31,"tokens_out":784,
 "cache_read":999152,"cache_write":125905,"duration_ms":189924,"tool_calls":13}
```

El agregador `metrics/aggregator.js:87` ya estima costo USD por sesión vía `estimateCostUsd(evt.model, evt)`. Para la comparativa cross-modelo (primer paso) y cross-provider (segundo paso) del MVP, el plan es:

1. Tomar la última semana de `activity-log.jsonl` (eventos `session:end` con `model: claude-*`).
2. Para cada sesión, recalcular costo aplicando los precios de cada modelo candidato dentro del mismo proveedor (cross-MODELO).
3. **Después**, recalcular costo aplicando los precios de cada provider candidato (cross-PROVIDER, asumiendo paridad de tokens — ver §2.4).
4. Producir tabla "qué costaría correr nuestro pipeline real con cada modelo / cada proveedor" — esto va al PR de implementación, no al documento.

**Esta normalización es prerequisite del dashboard de costos cross-modelo + cross-provider** (#2891 baseline horario y trabajo derivado) — está listada como issue hijo en §5.

### 2.4 Consideraciones de paridad de calidad

Los precios no son comparables 1:1 porque la **calidad** y la **eficiencia de tokens** difieren entre modelos:

- **Opus 4.7 vs Sonnet 4.7 (mismo proveedor)**: Sonnet produce más rondas de retry en skills que requieren razonamiento profundo (review de código complejo, security). En skills template-driven (refinar issue, sizing, sumarización) Sonnet empata o supera en costo total. Por eso la decisión cross-MODELO se hace **por skill**, no global.
- **Sonnet 4.7 vs Haiku 4.x (mismo proveedor)**: Haiku para tareas livianas (linter LLM, tagging, clasificación) es ~4× más barato y suficiente. Skills críticos siguen en Sonnet/Opus.
- **Opus 4.7 vs GPT-5 (cross-provider)**: en tareas de agente (tool use complejo, plan reasoning), Opus produce menos rondas de retry → menos tokens totales. La comparativa "$/MTok" subestima el costo real de modelos menos capaces.
- **Sonnet 4.7 vs GPT-5-mini (cross-provider)**: pareja razonable de "modelo de día a día". GPT-5-mini es ~5× más barato per token; en skills cortos puede empatar en costo total.
- **Ollama local**: $0/MTok pero a costo de calidad menor (Qwen2.5-Coder:32b ≈ Sonnet 3.5 en benchmarks). Apto para skills de baja criticidad (linter LLM, tagging, sumarización rápida) — NO para `backend-dev` ni `review`.

Recomendación operativa: la elección de modelo por skill se hace **leyendo costo real (no $/MTok abstracto) + tasa de rebote del skill**. Skill que rebote más con modelo barato → falsa economía. El algoritmo concreto está en §4.3.

---

## 3) Schema propuesto de `agent-models.json` (cross-MODELO como dimensión primaria)

### 3.1 Diseño de alto nivel

El archivo vive en `.pipeline/agent-models.json` (no se crea en este issue, sale en el primer issue hijo H1). La narrativa del schema **ordena por dimensión primaria primero**:

1. **`skills` (decisión primaria)** — qué modelo usar para cada skill, con override opcional por fase. Es el equivalente conceptual de `docs/agents-model-optimization.md` (#1244) llevado a archivo de configuración consultado por el pulpo en cada lanzamiento.
2. **`providers` (pool secundario)** — definición de cada proveedor disponible (launcher, args, parser, error types, capacidades). Los modelos de `skills` apuntan a un proveedor de este pool.
3. **`default_provider`** — proveedor por default cuando un skill no resuelve a uno explícito (fallback que rara vez se usa: cada skill debería declarar su modelo).

Antecedente concreto: `docs/agents-model-optimization.md` (issue #1244) ya hizo un primer mapping skill → modelo dentro de Anthropic (Haiku para skills template-driven con ahorro ~96%, Sonnet para razonamiento). El schema de `agent-models.json` es la formalización de ese trabajo ahora con telemetría cerrando el loop.

### 3.2 Schema (extracto comentado)

```jsonc
{
  "$schema": "./agent-models.schema.json",

  // === Decisión primaria: qué modelo usa cada skill ===
  // Cada entrada referencia un modelo de `providers.<X>.models[]`.
  // El override por fase es para cuando una fase específica del pipeline
  // (ej. "analisis") requiere más razonamiento que el default del skill.
  "skills": {
    "backend-dev":  { "model": "anthropic:claude-sonnet-4-7" },
    "android-dev":  { "model": "anthropic:claude-sonnet-4-7" },
    "web-dev":      { "model": "anthropic:claude-sonnet-4-7" },
    "pipeline-dev": { "model": "anthropic:claude-sonnet-4-7" },
    "qa":           { "model": "anthropic:claude-haiku-4" },
    "refinar":      { "model": "anthropic:claude-opus-4-7" },
    "guru":         { "model": "anthropic:claude-opus-4-7", "phase_overrides": { "analisis": "anthropic:claude-opus-4-7" } },
    "po":           { "model": "anthropic:claude-sonnet-4-7" },
    "ux":           { "model": "anthropic:claude-sonnet-4-7" },
    "review":       { "model": "anthropic:claude-opus-4-7" },
    "security":     { "model": "anthropic:claude-opus-4-7" },
    "builder":      { "model": "deterministic:node" },
    "tester":       { "model": "deterministic:node" },
    "delivery":     { "model": "deterministic:node" },
    "linter":       { "model": "deterministic:node" }
  },

  // === Pool secundario: proveedores disponibles ===
  "providers": {
    "anthropic": {
      "launcher": "claude",                        // alias resuelto por launcher allowlist (§6.10)
      "spawn_args_template": [
        "-p", "{user_prompt}",
        "--system-prompt-file", "{system_file}",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "bypassPermissions",
        "--model", "{model}"                       // el modelo se pasa por flag, NO hardcodeado
      ],
      "output_parser": "anthropic-stream-json",
      "quota_error_types": ["usage_limit_error", "weekly_quota_exhausted"],
      "supports_tool_use": true,
      "prompt_caching": {
        "supported": true,
        "ttl_seconds_default": 300,
        "ttl_seconds_extended": 3600
      },
      "credentials_env": ["ANTHROPIC_API_KEY"],    // la env var debe existir al boot (§6.2)
      "permissions_mode": "bypassPermissions",
      "models": [
        "claude-opus-4-7",
        "claude-sonnet-4-7",
        "claude-haiku-4"
      ]
    },
    "openai-codex": {
      "launcher": "codex",
      "spawn_args_template": [
        "exec",
        "--prompt", "{user_prompt}",
        "--system-prompt-file", "{system_file}",
        "--stream",
        "--no-confirm",
        "--model", "{model}"
      ],
      "output_parser": "openai-sse",
      "quota_error_types": ["insufficient_quota", "rate_limit_exceeded"],
      "supports_tool_use": "limited",              // sin paridad con tool_use de Claude
      "prompt_caching": { "supported": true, "auto": true },
      "credentials_env": ["OPENAI_API_KEY"],
      "permissions_mode": "no-confirm",
      "models": [
        "gpt-5-codex",
        "gpt-5",
        "gpt-5-mini"
      ]
    },
    "deterministic": {
      "launcher": "node",
      "spawn_args_template": [
        "{script_path}",
        "{issue}",
        "--trabajando={trabajando_path}"
      ],
      "output_parser": "none",
      "quota_error_types": [],
      "supports_tool_use": false,
      "prompt_caching": { "supported": false },
      "models": ["node"]
    }
  },

  "default_provider": "anthropic"
}
```

### 3.3 Diferencia clave respecto del schema v1

En la versión 1 cada skill declaraba `{ "provider": "anthropic", "model_override": "claude-sonnet-4-7" }`. En la versión 2 cada skill declara directamente `{ "model": "anthropic:claude-sonnet-4-7" }` con formato `provider:model`. Razones:

1. **Refleja la dimensión primaria**: lo que importa por skill es el **modelo concreto**, no "provider con override de modelo". El proveedor sale del prefijo.
2. **Deja explícito el override por fase**: `phase_overrides` es de primera clase, no anidado dentro de `model_override`.
3. **Compatibilidad**: el parser puede aceptar ambos formatos en una primera pasada, con deprecation warning sobre el v1.

### 3.4 JSON Schema acompañante

Se propone publicar `docs/pipeline-multi-provider/agent-models.schema.json` en este mismo PR (anexo del documento) para que el primer issue hijo lo copie al lugar canónico (`.pipeline/agent-models.schema.json`) y lo use desde el boot del pulpo. Ver anexos al final.

### 3.5 Reglas de expansión del template (anti-injection)

`spawn_args_template` se expande **a array de argv**, nunca a string concatenado. Reglas:

1. Las claves entre `{...}` son sustituidas por valores escapados como **un solo elemento del argv**, sin pasar por shell.
2. Si una clave del template no resuelve, el boot **falla fast** — no se sustituye con string vacío silenciosamente.
3. La expansión rechaza valores que contengan caracteres de shell sin escapar (`;`, `&`, `|`, `$`, backticks) salvo que estén dentro de `user_prompt`, donde la mitigación es no usar `shell: true` en el spawn (ver §6.6).
4. `shell: false` siempre que el launcher sea binario nativo o JS directo. `shell: true` sólo permitido para `.cmd` shim Windows (caso heredado de `cmd-shim` en `detectClaudeLauncher`).

### 3.6 Externalización de `DETERMINISTIC_SKILLS`

Hoy `pulpo.js:4851` define `DETERMINISTIC_SKILLS = new Set(['builder', 'tester', 'delivery', 'linter'])` hardcoded. Con `agent-models.json`, ese set deja de existir como constante: cualquier skill cuyo `model` resuelva a un proveedor con `output_parser: "none"` y `supports_tool_use: false` se considera determinístico. Esto resuelve A9 sin tabla aparte.

### 3.7 Contrato `quota_error_types` por proveedor (#3077 / H5)

`providers.<id>.quota_error_types` es la lista de strings que `lib/quota-exhausted.js` reconoce como "cuota agotada" para ese provider. El detector usa un **dispatcher por shape estructural** según el `output_parser` del provider — NUNCA matchea por substring sobre texto libre (CWE-185 / prompt-injection):

| Provider | Output parser | Shape estructural | Ejemplos legítimos |
|---|---|---|---|
| `anthropic` | `anthropic-stream-json` | `evt.type === 'result' && evt.is_error === true && evt.error_type ∈ allowlist` | `usage_limit_error`, `weekly_quota_exhausted`, `snapshot_threshold_90` |
| `openai-codex` | `openai-sse` | `evt.event === 'error' && evt.data.error.type ∈ allowlist` (canónico)<br>`evt.type === 'response.error' && evt.error.type ∈ allowlist` (alternativo) | `insufficient_quota`, `billing_hard_limit_reached`, `tokens_exhausted` |
| `gemini` | `gemini-stream` | (reservado, adaptador no entregado) | `quota_exceeded`, `resource_exhausted` |
| `deterministic`, `ollama` | `none` | sin detección de cuota basada en eventos | `[]` |

**Tipos "externos" vs "internos"**: los strings que vienen del CLI del provider son externos (ej. `usage_limit_error`). Los strings emitidos por integraciones del propio pipeline son internos — el caso canónico es `snapshot_threshold_90`, emitido por `quota-snapshot-integration.js` cuando el snapshot real reporta `weekly_all_models_pct >= 90` (#3013). Los internos pertenecen al provider Anthropic exclusivamente y NO se propagan a OpenAI ni Gemini (#3077 SEC-8).

**Meta-allowlist** (#3077 SEC-2): cada string declarado en `quota_error_types` se cross-valida en `lib/agent-models.js.loadAndValidate()` contra `KNOWN_QUOTA_ERROR_TYPES_BY_LAUNCHER` (hardcoded). Si un PR introduce un valor opaco fuera de la meta-allowlist → boot fail-fast con mensaje accionable. Defensa anti-supply-chain. Para ampliar la meta-allowlist se requiere review humano explícito (PR a `lib/agent-models.js` + `lib/quota-exhausted.js`).

**`resets_at_cap_max_days` por provider** (#3077 SEC-6): cada provider declara su cap superior en días para el campo `resets_at` reportado por el CLI. Anthropic = 7 (cuota semanal Plan Max). OpenAI = 31 (cuota mensual). Sin esto, un evento OpenAI legítimo declarando un reset_at a 21 días sería truncado al cap default de 7 días → falso "drenado natural" en una semana. Configurable, opcional (default 7). Validado por schema en rango `[1, 366]`.

**Scoping del flag por provider** (#3077 SEC-1, SEC-5):

- `setFlag({ provider, ... })` persiste el flag con el campo `provider` indicando qué proveedor reportó la cuota agotada.
- `shouldGateSpawn(skill, { provider })` gatea SOLO si el provider del skill coincide con el provider del flag activo. Anthropic agotado NO bloquea skills configurados con OpenAI o Google.
- `clearFlag({ provider })` solo limpia si el provider matchea (un spawn exitoso de OpenAI no limpia el flag de Anthropic).
- `detectQuotaError(parsedEvent, providerDef)` matchea SOLO contra el `quota_error_types` del provider en uso; un evento Anthropic con string OpenAI (`insufficient_quota`) NO activa el flag.

**Backward-compat** (#3077 CA-14): los flags persistidos pre-#3077 no tienen el campo `provider`. Al leerlos, `validateFlagShape` los normaliza a `provider: 'anthropic'` (único provider activo antes del rediseño). Schema migración silenciosa, sin manejo manual.

**Audit log enriquecido** (#3077 SEC-7): cada línea de `.pipeline/logs/quota-detector-YYYY-MM-DD.log` incluye `provider` y `model` para debugging multi-provider. Sin estos campos era imposible saber qué proveedor disparó el flag cuando había mix de providers corriendo.

**Sanitización del `raw_excerpt`** (#3077 SEC-4): el campo `raw_excerpt` del audit log pasa por `lib/redact.js` y por una segunda capa de patrones de API keys multi-proveedor (`sk-`, `sk-ant-`, `AIza`, `ya29.`, `Bearer`, JWT) ANTES de logear. Cierra el vector "OpenAI emite eventos de error con context que contiene fragmentos de la API key o del system prompt → audit log se vuelve vector de exfiltración pasivo". S2 (#3073) generaliza esta defensa a sanitizer extendido global.

**Fuente de verdad y deprecación**: `agent-models.json` es la fuente canónica. `config.yaml:quota_detector.error_types` y `config.yaml:quota_detector.resets_at_cap_max_days` quedan como `@deprecated` para callers legacy de `detectFromResultEvent(evt, cfg)` que aún no resuelvan `providerDef`. Se eliminarán en una historia de cleanup posterior, después de migrar todos los callers a `detectQuotaError(evt, providerDef)`.

---

## 4) Plan de implementación en fases (cross-MODELO primero, cross-PROVIDER después)

### 4.1 Política dual de switch

La decisión de cambiar el modelo de un skill se divide en dos políticas distintas según qué cambia:

```
                     ┌────────────────────────────────────┐
                     │ ¿el switch cruza el límite del     │
                     │ proveedor? (Anthropic ↔ OpenAI...)  │
                     └────────────┬───────────────────────┘
                                  │
                ┌─────────────────┴─────────────────┐
                │                                   │
                NO                                  SÍ
                │                                   │
                ▼                                   ▼
   ┌──────────────────────────┐      ┌────────────────────────────┐
   │  cross-MODELO            │      │  cross-PROVIDER            │
   │  (Opus → Sonnet → Haiku) │      │  (Anthropic → OpenAI / ...) │
   │                          │      │                            │
   │  · automático            │      │  · con aprobación humana   │
   │  · sin barrera humana    │      │  · TOS / DPA distinto      │
   │  · notificación post-hoc │      │  · data residency cambia   │
   │  · algoritmo §4.3        │      │  · compliance multiplica   │
   └──────────────────────────┘      └────────────────────────────┘
```

**Política A — switch cross-MODELO (mismo proveedor): automático.**

- Cuando el algoritmo de §4.3 decide que un skill puede correr en un modelo más barato del mismo proveedor (ej. `qa` baja de Sonnet a Haiku), el switch se aplica solo, sin pedir aprobación.
- Justificación: el TOS, el DPA, la región de procesamiento y el opt-out de training son los mismos para todos los modelos del mismo proveedor (Opus/Sonnet/Haiku son todos Anthropic, mismo contrato). No hay decisión de compliance que requiera humano.
- El operador recibe una **notificación post-hoc** por Telegram (informativa, no decisoria) — formato y consolidación en §7.6.
- Caps de seguridad (§6.8.2 + §6.11): skills no-degradables (`security`, `review`, `builder`, `tester`) NO entran al algoritmo automático; máximo 1 escalón de degradación por sesión.

**Política B — switch cross-PROVIDER (proveedor distinto): con aprobación humana.**

- Cuando el algoritmo o la cuota agotada disparan un cambio de proveedor (ej. Anthropic → OpenAI/Codex), el pipeline NO aplica el switch solo.
- El detector de cuota agotada (componente determinístico, §4.2) manda una propuesta concreta a Telegram con costo estimado, link al TOS/DPA del nuevo proveedor, opt-out status y comandos para confirmar/rechazar.
- Justificación: cambiar de proveedor manda código y prompts a una empresa distinta cuyos términos legales el equipo no aprobó automáticamente. La aprobación humana es barrera intencional, no fricción accidental.
- El operador único (Leo) confirma o rechaza por mensaje a Telegram. Sólo entonces el pipeline edita `agent-models.json`.
- Plantilla del mensaje y comandos en §7.6.

### 4.2 Romper el deadlock cuota+consulta — componentes determinísticos

El gatillo del switch puede ser "se agotó la cuota del proveedor actual". Aparece la pregunta: ¿quién manda el mensaje a Telegram cuando el agente que corre con ese proveedor está bloqueado?

**Respuesta: la detección y la notificación son código determinístico Node, sin LLM. Existen hoy y ya se usan operacionalmente** — sólo faltaba declararlo explícito en el doc.

Componentes (verificados empíricamente al 2026-05-07):

| Componente | Path | Naturaleza | Función |
|-----------|------|-----------|---------|
| `quota-exhausted.js` | `.pipeline/lib/quota-exhausted.js` | Node puro, sin dependencias LLM | `detectFromResultEvent(evt, cfg)` (línea 439) parsea el `stream-json` del CLI y matchea **shape estructurado** (`type:'result' && is_error:true && error_type ∈ allowlist`). NUNCA matchea por substring sobre texto libre — resistente a prompt-injection. `setFlag()` (línea 373) persiste el flag JSON atómico (write-tmp + fsync + rename, mode 0o600). |
| Disparadores del detector | `.pipeline/pulpo.js:5121` (handler de exit del agente) y `.pipeline/pulpo.js:6306` (handler de stream del commander para `evt.type === 'result'`) | Node puro, dentro del pulpo | Llaman al detector después de que cierre el log o llegue el evento de error. NO requieren al agente bloqueado. |
| `sendTelegram` | `.pipeline/pulpo.js:6949` | Node puro, encola en filesystem | Escribe en `.pipeline/servicios/telegram/pendiente/` (filesystem-as-queue). El servicio `servicio-telegram.js` lo drena fuera del pulpo. Sin LLM en el camino. |

**Conclusión: el deadlock no existe operacionalmente.** El primer paso "notificar Telegram" NO requiere ejecución del agente bloqueado — lo hace el pulpo (Node) escribiendo un archivo, y el servicio Telegram (Node) lo drena.

**Generalización pendiente para multi-proveedor (NO es deadlock, es schema)**: hoy el flag `quota-exhausted.json` es global. Para soportar cross-MODELO automático dentro de Anthropic hay que llevarlo a granularidad `provider:model:skill` — Sonnet puede tener cuota OK aunque Opus esté agotado en weekly Plan Max. Disciplina obligatoria al hacer el cambio:

- **Single-flag con keys** (`flags: { "anthropic:opus_4_7": { ... }, "anthropic:sonnet_4_7": { ... } }`) en vez de N archivos. Reduce superficie de race + path-traversal.
- **Allowlist en código** para validar que `provider`/`model`/`skill` que se usan como key son strings conocidos del schema, NO input externo del CLI.
- **Mantener la defensa actual** sobre `errorType` (`String(opts.errorType || '').slice(0, 64)`) extendida a las nuevas keys.

Este trabajo se hace en el issue M2 (ver §5) — generalizar `quotaUsage(provider, ...)`.

### 4.3 Algoritmo de selección de modelo por agente (autónomo)

El algoritmo se ejecuta en **código del pulpo** (Node), dentro de `lanzarAgenteClaude` (post-refactor: `lib/agent-launcher.js` — issue H2), justo antes del `spawn` del child. La decisión la toma el código por skill — **sin intervención humana mientras sea cross-MODELO**.

Pseudocódigo:

```
fn elegir_modelo(skill, fase, issue):
    cfg = leer('.pipeline/agent-models.json')

    # 1) Lista de skills no-degradables: si está en la lista, usar el default tal cual
    if skill in NO_DEGRADABLE_SKILLS:           # hardcoded en código (ver §6.11)
        return cfg.skills[skill].phase_overrides[fase] OR cfg.skills[skill].model

    # 2) Default del skill, con override por fase si existe
    base = cfg.skills[skill].phase_overrides[fase] OR cfg.skills[skill].model

    # 3) Período frío: skills con < N sesiones de baseline se quedan en default conservador
    sesiones_baseline = telemetria.skill_session_count(skill, last_30d)
    if sesiones_baseline < N_BASELINE_SESSIONS:    # default conservador, ver "Período frío"
        return base

    # 4) Filtro de rebotes relevantes: solo cuentan los que indican calidad de razonamiento,
    #    NO infra/flaky (ver §6.8.2)
    rebote_rate = telemetria.skill_rebote_rate(skill, last_30d, motivo_filter='razonamiento')

    # 5) Si el skill rebota poco (< umbral), permite degradar
    if rebote_rate < REBOTE_THRESHOLD:               # config.cost_threshold[base]
        # 6) Si el costo histórico del skill > umbral del modelo actual, degradar 1 escalón
        costo_avg = telemetria.skill_avg_cost_usd(skill, last_30d)
        if costo_avg > cfg.cost_threshold[base]:
            propuesto = degradar_un_escalon(base)    # Opus → Sonnet → Haiku
            # 7) Cap de profundidad: máximo 1 escalón por sesión.
            #    Para bajar otro escalón, requiere N_CLEAN_SESSIONS sesiones limpias en el nuevo nivel.
            if no_se_degrado_en_ultimas(N_CLEAN_SESSIONS):
                base = propuesto
                audit.log_switch_automatico(skill, base, propuesto, motivo='cost_threshold')

    return base
```

**Constantes a documentar en `agent-models.json` o en config (con valores iniciales sugeridos):**

| Constante | Valor inicial sugerido | Razón |
|-----------|------------------------|-------|
| `N_BASELINE_SESSIONS` | 5 | Skills nuevos sin histórico necesitan baseline antes de habilitar el algoritmo. Valor conservador que no alarga demasiado el período frío. |
| `REBOTE_THRESHOLD` | 0.05 (5%) | Tasa de rebote por encima de la cual es indicio de que el modelo actual ya está al límite — no degradar. |
| `N_CLEAN_SESSIONS` | 10 | Sesiones en el nuevo nivel sin rebote relevante antes de habilitar otro escalón de degradación. Evita colapso de calidad por una racha de issues triviales. |
| `cost_threshold[modelo]` | a definir por modelo en config | Umbral de costo USD promedio por sesión por skill arriba del cual se evalúa degradar. Distinto por modelo. |

**Período frío (skills nuevos)**: durante las primeras `N_BASELINE_SESSIONS` sesiones, el skill corre con el `default_model` declarado en `agent-models.json` sin pasar por el algoritmo. Esto evita decisiones automáticas con datos insuficientes.

**Filtrado de rebotes**: el contador de rebote del algoritmo solo cuenta los rebotes cuyo `motivo` contiene patrones que indican calidad de razonamiento (e.g. "criterios incorrectos", "código erróneo", "interpretación equivocada"). Rebotes con `motivo` infra/flaky (e.g. "test flaky", "build infra error", "timeout de red") NO cuentan — esos son señal del entorno, no del modelo.

**Cap de profundidad**: el algoritmo nunca degrada más de 1 escalón en una sola sesión. Para bajar otro escalón requiere `N_CLEAN_SESSIONS` sesiones limpias en el nuevo nivel. Esto evita el escenario de "racha de issues triviales degrada un skill crítico hasta Haiku y después un issue complejo lo encuentra mal preparado".

**Logging del switch**: cada decisión del algoritmo (haya o no haya degradación) se registra en `.pipeline/audit/model-switches.jsonl` con hash chain SHA-256 (§6.8.3). Sin este audit log la decisión es invisible para el operador y para forensia.

### 4.4 Fase 1 MVP — cross-MODELO dentro de Anthropic

Objetivo: habilitar selección automática Opus / Sonnet / Haiku por skill, con telemetría cerrando el loop. **Ningún proveedor adicional en esta fase.**

**Criterios de salida verificables**:

- [ ] `.pipeline/agent-models.json` existe en el repo con schema validado en boot del pulpo.
- [ ] Hardcode `model: 'claude-opus-4-7'` eliminado de `pulpo.js:4903` y `traceability.js:11`. La telemetría reporta `provider` + `model` reales en cada `session:start` / `session:end`.
- [ ] El pulpo lee `agent-models.json` antes del spawn y pasa el modelo elegido por flag `--model {model}` al CLI Claude.
- [ ] Algoritmo de §4.3 implementado en código (`lib/model-selector.js` propuesto), con tests unitarios cubriendo: período frío, cap de profundidad, filtrado de rebotes, skills no-degradables.
- [ ] Lista hardcoded `NO_DEGRADABLE_SKILLS = new Set(['security', 'review', 'builder', 'tester'])` en el código del lanzador.
- [ ] Audit log `.pipeline/audit/model-switches.jsonl` con hash chain SHA-256 escribiéndose en cada decisión.
- [ ] Notificación post-hoc por Telegram cuando ocurre un switch automático (formato §7.6.1, consolidación en ventana de 5 min).
- [ ] Schema validation pre-commit hook activo.
- [ ] Documento de operaciones (`docs/operacion-pipeline.md`) actualizado con cómo cambiar el default por skill manualmente.

### 4.5 Fase 2 — cross-PROVIDER (Anthropic + OpenAI/Codex) con aprobación humana

Objetivo: habilitar OpenAI/Codex como segundo proveedor operativo cuando la cuota completa de Anthropic se agote o cuando el operador lo decida.

**Criterios de salida verificables**:

- [ ] `lanzarAgenteClaude` (~600 líneas) refactorizado a `lib/agent-launcher.js` con dispatch por provider.
- [ ] Adaptador `openai-codex` implementado: detector, args template, parser SSE, mapeo de tokens al shape común (`tokens_in`, `tokens_out`, `cache_read`, `cache_write`).
- [ ] Test E2E del pipeline con un skill de baja criticidad corriendo en `openai-codex` produciendo output válido y telemetría completa.
- [ ] Sanitizer extendido con regex para `sk-...` (OpenAI). Test de regresión que prueba que una key embebida en output NO aparece en `logs/<issue>-<skill>.log`.
- [ ] Generalización del flag `quota-exhausted.json` a single-flag con keys `provider:model:skill` (§4.2).
- [ ] Flujo de aprobación humana cross-PROVIDER implementado: detector dispara mensaje Telegram con propuesta concreta (§7.6.2), pulpo espera respuesta `/approve-switch ...` antes de aplicar.
- [ ] Audit trail dinámico (`provider`, `model`, `cli_version`, `git_sha_provider_adapter`) en cada sesión.
- [ ] Aislamiento de credenciales por proceso: `process.env` filtrado a allowlist + sólo la key del provider del skill al spawnar.
- [ ] Permission model mapping documentado en código + tests de paridad.
- [ ] Threat model adversario interno: pre-commit hook rechaza launchers fuera de allowlist; rechaza flags peligrosos; falla fast si schema inválido.
- [ ] Dashboard V3 muestra `provider:model` por agente activo y por issue procesado.
- [ ] Rejection reports incluyen `provider` + `model` + `cli_version` en el header del PDF.
- [ ] Costo normalizado en dashboard (cost_usd por skill por issue, no agregado por provider) — input para #2891 baseline.

### 4.6 Fase 3 — Extensión opcional (Ollama, Gemini)

Objetivo: agregar providers adicionales si y sólo si el negocio lo justifica.

**Criterios de salida verificables (por provider candidato)**:

- [ ] Sección de TOS / data residency aprobada por el operador (Leo).
- [ ] Adaptador implementado, parser específico, error types mapeados.
- [ ] Test E2E pasa con al menos un skill no crítico.
- [ ] Costos esperados en simulación contra `activity-log.jsonl` históricos < 90% del provider actual para el skill propuesto, O capacidad técnica única del provider (ej. ventana de contexto >1M tokens) que justifique el agregado.

Candidatos en orden de preferencia:

1. **Ollama local** — para skills no críticos de baja calidad aceptable (linter LLM, tagging). Ventaja: $0 marginal y datos no salen del host. Desventaja: calidad menor, requiere hardware GPU local.
2. **Google Gemini** — esperar a 2026-Q3 para que el ecosistema CLI estabilice. No agregar antes.

### 4.7 Decisión: NO usar OpenRouter en MVP

OpenRouter parece atajo, pero:

- Suma latencia (~200 ms extra promedio).
- Oculta diferencias de billing (margin sobre cada provider downstream).
- Dificulta DPA (TOS de OpenRouter + del provider downstream).
- Tercer parser que mantener.

Empezar con cross-MODELO Anthropic en Fase 1, agregar 1 adaptador delgado OpenAI/Codex directo a CLI nativo en Fase 2. Reevaluar OpenRouter si la demanda escala a >3 proveedores y la complejidad de mantener N adaptadores supera la ganancia de control.

---

## 5) Lista de issues hijos (no crear todavía — solo enumerar)

> **Reordenamiento v2**: la prioridad refleja la política dual. Issues que habilitan **cross-MODELO automático** (Política A) van primero. Issues que habilitan **cross-PROVIDER con aprobación humana** (Política B) van después. Cada issue lleva tag `[A]` o `[B]` para marcar a qué política pertenece.

### 5.1 Cross-MODELO automático (Política A) — Fase 1 MVP

| # | Tag | Título propuesto | Esfuerzo | Dependencias |
|---|-----|------------------|----------|---------------|
| H1 | [A] | feat(pipeline): crear `.pipeline/agent-models.json` y `agent-models.schema.json` + eliminar hardcode `model:'claude-opus-4-7'` (A5) — schema reordenado con `skills` como decisión primaria | medio | ninguna — **prerrequisito de todos** |
| H4 | [A] | refactor(pipeline): externalizar `DETERMINISTIC_SKILLS` (A9) a derivación desde `agent-models.json` (provider con `output_parser:none`) | simple | H1 |
| H6 | [A] | feat(pipeline): clasificador `classifyExecutionMode` ahora dispatching por `provider` explícito en eventos `session:end` (A13) | simple | H1 |
| H8 | [A] | feat(pipeline): `lib/model-selector.js` con algoritmo de §4.3 (período frío + cap profundidad + filtrado rebotes + skills no-degradables) — tests unitarios obligatorios | medio | H1 |
| S5 | [A] | security(pipeline): audit trail dinámico con `provider`, `model`, `cli_version`, `git_sha_provider_adapter` por sesión (fix de A5) | simple | H1 |
| S8 | [A] | security(pipeline): audit log dedicado `.pipeline/audit/model-switches.jsonl` con hash chain SHA-256 (§6.8.3) + comando de verificación de cadena | medio | H1, H8 |
| U1 | [A] | feat(dashboard-v3): mostrar `provider:model` por agente activo + columna `model_used` + histórico de switches recientes (últimos 7d) | simple | S5 |
| U2 | [A] | feat(telegram): notificación post-hoc consolidada (ventana 5 min) de switches automáticos cross-MODELO con plantilla §7.6.1 + snooze 24h | simple | H8, S5 |
| U6 | [A] | feat(rejection-reports): incluir `provider`/`model`/`cli_version` en header del PDF + indicador "degradación reciente" si hubo switch automático en últimas N sesiones del skill | simple | S5, S8 |

### 5.2 Cross-PROVIDER con aprobación humana (Política B) — Fase 2

| # | Tag | Título propuesto | Esfuerzo | Dependencias |
|---|-----|------------------|----------|---------------|
| H2 | [B] | refactor(pipeline): mover `lanzarAgenteClaude` a `lib/agent-launcher.js` con dispatch por provider | grande | H1 |
| H3 | [B] | feat(pipeline): adaptador OpenAI/Codex (launcher detector + args template + stream parser SSE + mapeo de tokens) | grande | H2 |
| H5 | [B] | feat(pipeline): generalizar `quota-detector` (A6) con tabla `quota_error_types` por proveedor | medio | H1, H3 |
| H7 | [B] | feat(pipeline): test E2E del pipeline con un skill no crítico corriendo en `openai-codex` produciendo output válido y telemetría completa | medio | H3 |
| M1 | [B] | feat(metrics): normalizar costos cross-provider en `metrics/aggregator.js` para dashboard #2891 | medio | H3 |
| M2 | [B] | feat(metrics): migrar `weekly-quota.js` (A15) de "duration_ms" como proxy a abstracción `quotaUsage(provider, model, skill)` con single-flag con keys (§4.2) | medio | H1, H3 |
| U3 | [B] | feat(telegram): plantilla decisoria cross-PROVIDER (§7.6.2) con `/approve-switch`, `/keep-blocked`, `/info-switch` + idempotencia visible | simple | H3, M2 |
| U4 | [B] | feat(pipeline): script `node .pipeline/validate-agent-models.js` que valide schema + verifique credenciales antes del boot | simple | H1 |
| U5 | [B] | feat(dashboard-v3): comparativa de costo cross-provider por skill por sprint, con alerta cuando un cambio de provider produce costo inesperado | medio | H3, S5 |
| U7 | [B] | feat(pipeline): módulo `lib/telegram-templates.js` con plantillas tipadas (cross-modelo, cross-provider, cuota agotada, modo descanso) — consistencia de tono | simple | U2, U3 |

### 5.3 Seguridad (transversal a A y B)

| # | Tag | Título propuesto | Esfuerzo | Dependencias |
|---|-----|------------------|----------|---------------|
| S1 | [B] | security(pipeline): inventario y rotación de credenciales de proveedores de IA (env vars, fail-fast en boot, política rotación ≤90 días) | medio | H1 |
| S2 | [B] | security(pipeline): sanitizer extendido con regex para API keys multi-proveedor (`sk-`, `AIza`, etc.) + tests de regresión por proveedor | medio | independiente, **valor inmediato hoy** |
| S3 | [A/B] | security(pipeline): validación schema + allowlist para `agent-models.json` (boot-time + pre-commit) — incluye disciplina anti path-traversal de §6.10 | medio | H1 |
| S4 | [B] | security(pipeline): permission model mapping cross-provider (tabla de equivalencias + tests de paridad) | medio | H3 |
| S6 | [B] | security/governance: política de TOS / data residency / DPA por proveedor (input legal/Leo) — qué archivos del repo NO deben enviarse a no-Anthropic | medio | H1 |
| S7 | [B] | security(pipeline): aislamiento de credenciales por proceso (filtrar `process.env` con allowlist + sólo la key del provider del skill) — A16 | medio | H1, H3 |

**Recomendaciones de hardening (no bloqueantes, etiquetadas `needs-human` + `tipo:recomendacion`):**

- [#3066](https://github.com/intrale/platform/issues/3066) — Skill-allowlist no-degradable hardcodeada en código (cubre §6.11). Gana relevancia con H8.
- [#3067](https://github.com/intrale/platform/issues/3067) — Integridad verificable de `activity-log.jsonl` (HMAC o hash chain) — cubre §6.8.2. Gana relevancia con H1.
- [#3068](https://github.com/intrale/platform/issues/3068) — Audit log tamper-evident de switches automáticos con verificador de cadena — cubre §6.8.3. Gana relevancia con H1+S5.

### 5.4 Resumen

**Total: 21 issues hijos enumerados**, distribuidos:

- **Política A (cross-MODELO automático, Fase 1 MVP)**: 9 issues — H1, H4, H6, H8, S5, S8, U1, U2, U6.
- **Política B (cross-PROVIDER con aprobación, Fase 2)**: 10 issues — H2, H3, H5, H7, M1, M2, U3, U4, U5, U7.
- **Seguridad transversal**: S1, S2, S3, S4, S6, S7 (6 issues, marcados [A/B] según fase de dependencia).

H1 sigue siendo **prerrequisito directo de la mayoría**.

---

## 6) Seguridad y privacidad (sección bloqueante — pedido explícito de Security)

### 6.1 Modelo de amenazas: qué cambia con multi-modelo / multi-proveedor

| Vector | Single-provider single-modelo hoy | Multi-modelo (Política A) | Multi-provider (Política B) | Impacto |
|--------|-----------------------------------|---------------------------|------------------------------|---------|
| Robo de credenciales | 1 token Anthropic | 1 token Anthropic | N tokens (Anthropic + OpenAI + ...) | Lineal en N (solo en B) |
| Exfiltración de código fuente | 1 destino (Anthropic TOS) | 1 destino (mismo TOS) | N destinos con políticas distintas | Compliance multiplica (solo en B) |
| Supply chain CLI | 1 binario (`claude`) | 1 binario (`claude`) | N binarios (`claude`, `codex`, etc.) | N puntos de update (solo en B) |
| Parsers de output | 1 parser stream-json | 1 parser stream-json | N parsers (stream-json, SSE, custom) | N parsers = N posibles bugs (solo en B) |
| Adaptadores de tool use | 0 (nativo Anthropic) | 0 (nativo Anthropic) | Traductores XML↔JSON↔function-call | Nuevo código crítico (solo en B) |
| Datos en tránsito | TLS Anthropic | TLS Anthropic | TLS a N endpoints | Hay que pinear/auditar cada uno (solo en B) |
| Configuración | Hardcode `pulpo.js` | `agent-models.json` editable | `agent-models.json` editable | Archivo de alto valor para atacante |
| **Telemetry poisoning del algoritmo** | n/a | **NUEVO** — `activity-log.jsonl` decide degradación | **NUEVO** — idem | Atacante con write infla métricas → fuerza degradación silenciosa de skill crítico |
| **Decisión automática invisible** | n/a | **NUEVO** — switches sin gating humano | n/a (B requiere humano) | Audit log dedicado obligatorio (§6.8.3) |

### 6.2 Gestión de secretos

- **Inventario completo de credenciales** por proveedor en [`docs/secrets-inventory.md`](secrets-inventory.md) (issue S1, #3080).
- **Política de rotación** ≤90 días por convención. Runbook operativo en [`docs/runbooks/credential-rotation.md`](runbooks/credential-rotation.md).
- **Almacenamiento**: prohibido poner API keys en `agent-models.json`. Sólo nombres de env vars en `credentials_env` (ej: `["ANTHROPIC_API_KEY"]`). El validador `lib/agent-models-validate.js` impone:
  - **Denylist de prefijos hardcoded** — rechaza `sk-ant-`, `sk-`, `sk-proj-`, `AIza`, `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `ya29.`, `xoxb-`, `xoxp-`, `AKIA`/`ASIA`, tokens Telegram, `claude_`. Defensa en profundidad además de `additionalProperties:false`.
  - **Allowlist `ALLOWED_CREDENTIAL_ENV_VARS`** — bloquea declaraciones tipo `PATH`, `AWS_SECRET_ACCESS_KEY` que exfiltrarían vars sensibles del operador al child del provider equivocado.
- **Boot fail-fast**: si un provider efectivamente referenciado por algún skill (incluido `default_provider`) declara `credentials_env` y la env var no está presente en `process.env`, `pulpo.js` aborta con exit 2 antes de adquirir el singleton. El mensaje no contiene valores (anti-leak).
- **Cron de rotación**: `lib/credential-rotation-cron.js` corre dentro del loop principal del pulpo cada hora (configurable vía `credential_rotation.tick_ms`). Lee el inventario, calcula T-14/T-7/T-3/T-1/T-0 contra `expires_at` (UTC), notifica al owner por Telegram con idempotencia persistida en `.pipeline/credential-reminder-state.json`. T-0 (expirada) genera ruido sostenido hasta que el operador rote y commitee `last_rotated`.

### 6.3 Aislamiento de credenciales por proceso

Hoy `pulpo.js:4922-4933` propaga `process.env` completo al child. Con multi-proveedor:

- El env del child contiene **sólo** la API key del proveedor que ese child va a usar.
- Drop de env: filtrar `process.env` a un allowlist mínimo (PATH, HOME, USERPROFILE, APPDATA, PIPELINE_*) + la key específica del provider del skill.
- Aislamiento es **obligatorio** — si OpenAI key viaja en el env de un agente Anthropic, una panic dump del CLI puede filtrarla al log.

#### Implementación entregada (issue #3085 / S7)

**Helper**: `.pipeline/lib/build-child-env.js` — función pura `buildChildEnv({ skill, processEnv, pipelineExtras, ... })` que devuelve el objeto env mínimo. Patrón idiomático del codebase (mismo estilo que `lib/handoff.js`, `lib/redact.js`, `lib/partial-pause.js`): puro, sin side-effects, con inyectables (`fsImpl`, `skillConfigOverride`) para tests.

**Estrategia de filtrado** (en orden):
1. `SYSTEM_ALLOWLIST` hardcoded — variables del sistema permitidas a TODOS los childs (PATH, SystemRoot, ComSpec, PATHEXT, NODE_*, locale, paths Windows).
2. Todas las `PIPELINE_*` del `processEnv` (siempre — son contexto del child).
3. Una sola API key del LLM, la del provider declarado por el skill (Anthropic xor OpenAI; deterministic NO recibe ninguna).
4. Scopes adicionales (`requires_credentials` en `agent-models.json` o `DEFAULT_REQUIRES_BY_SKILL` hardcoded por skill cuando el archivo no existe).
5. `SCOPES_ALWAYS_ON` — `telegram-hooks` siempre, en todos los childs (los hooks `agent-concurrency-check.js` y `worktree-guard.js` corren dentro del child y disparan alertas vía Telegram).

**Tabla de scopes** (constante exportada `CREDENTIAL_SCOPES`):

| Scope | Variables incluidas | Skills que lo declaran (defaults) |
|-------|---------------------|-----------------------------------|
| `github` | `GH_TOKEN`, `GITHUB_TOKEN` | `security`, `delivery`, `refinar`, `priorizar`, `po`, `historia`, `doc`, `scrum`, `review`, `guru`, `ux`, `planner`, `pipeline-dev`, `android-dev`, `backend-dev`, `web-dev`, `qa` |
| `aws` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_PROFILE` | `qa`, `backend-dev` |
| `gradle-android` | `JAVA_HOME`, `GRADLE_USER_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_AVD_HOME` | `builder`, `tester`, `qa`, `build`, `android-dev`, `backend-dev`, `web-dev` |
| `telegram-hooks` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | TODOS (always-on) |

**Fail-fast**: si el `provider` declarado por el skill tiene una `credentials_env` declarada (en `agent-models.json` o `PROVIDER_DEFAULT_CREDENTIAL_ENV`) y la var no está en `process.env` del pulpo, `buildChildEnv()` **throwa** con mensaje accionable en español:

> *"Skill 'X' configurado para provider 'Y', pero VAR_NAME no está en el env del pulpo. Definila como variable de entorno o cambiá el 'provider' del skill en agent-models.json. Ver docs/pipeline-multi-provider.md §5.2."*

**Rollout con flag**: `pipeline.env_isolation_enabled` en `.pipeline/config.yaml` (default `false`). Cuando `false`, el pulpo conserva el comportamiento previo (heredar `process.env` completo) — preserva regresión cero corriendo solo Anthropic. Cuando `true`, usa `buildChildEnv()`.

Plan de rollout:
1. Mergear con flag en `false` y telemetría 1 sprint (revisar el log de auditoría + skills que rompen al flippear puntualmente para test).
2. Flippear a `true` cuando se valide que ningún hook ni skill rompió por falta de credencial necesaria.
3. Después del flip, considerar mover este control a "always on" + sacar el flag.

**Audit trail** (`.pipeline/logs/env-allowlist-audit.log`): el pulpo, al boot, escribe una línea por arranque con qué keys de `process.env` quedaron fuera del allowlist (sin valores — solo nombre + hash truncado SHA-256-12). Sirve para forensia: si aparece una credencial nueva en el env del operador y nadie la mete en allowlist/scope, queda registrada. Formato humano-legible (CA-10b del UX), una variable por línea con padding alfabético + hash entre paréntesis.

**Aplicación a call sites**: el helper se invoca desde:
- `pulpo.js` línea ~4920 (spawn del agente LLM o determinístico — todos los skills).
- `pulpo.js` línea ~6210 (spawn del commander singleton — chat de Claude del operador).

Ambos respetan el flag y caen al comportamiento legacy si `env_isolation_enabled=false`.

**Cobertura de tests**: `.pipeline/tests/build-child-env.test.js` con 34 tests (CA-2 + CA-3 + CA-4 + CA-5 + CA-7 + CA-10 + tests defensivos de consistencia interna). Sin regresión sobre tests E2E del pipeline.

**Complementario al sanitizer (#2334)**: el aislamiento evita que la key llegue al child; el sanitizer evita que aparezca en logs si igual entró por otro canal. **Ninguno reemplaza al otro** — son dos capas independientes. Un agente Anthropic con env limpio igual debe sanitizar su stdout/stderr porque el LLM puede generarla por alucinación o porque el operador la pegó en un prompt.

### 6.4 Política de TOS / data residency por proveedor

> Esta política aplica solamente cuando hay cambio de proveedor (Política B). Cross-MODELO dentro del mismo proveedor (Política A) NO toca TOS/DPA — Opus, Sonnet y Haiku comparten el mismo contrato Anthropic.

**Decisión documentada en [`docs/pipeline-multi-provider/data-residency.md`](pipeline-multi-provider/data-residency.md)** (issue [S6 / #3084](https://github.com/intrale/platform/issues/3084)).

Resumen de salida:

- **Tabla por proveedor**: relevamiento al 2026-05-08 con columnas obligatorias (training opt-out, región, BAA/DPA, retención, URLs TOS/DPA, fecha verificación).
- **Lista explícita de archivos excluidos**: vive como código en [`.pipeline/data-residency-exclusions.json`](../.pipeline/data-residency-exclusions.json) (sidecar JSON validado por schema al boot).
- **Enforcement**: [`.pipeline/lib/data-residency-filter.js`](../.pipeline/lib/data-residency-filter.js) — fail-closed al boot, audit log con `path_hash` (SHA-256-12, no path crudo) en `.pipeline/audit/data-residency-filter.jsonl`.
- **Tests**: 25 casos en [`.pipeline/lib/__tests__/data-residency-filter.test.js`](../.pipeline/lib/__tests__/data-residency-filter.test.js) (CA-4 + CA-5 + glob compiler + integración con sidecar canónico).
- **Anti path-traversal**: schema rechaza prefijos absolutos, `..`, `~/`, `\\` (consistente con §6.10.1).
- **Independencia del sanitizer (§6.5)**: este filtro defiende el lado de **input** al modelo; el sanitizer defiende el **output** al log.

### 6.5 Sanitizado universal de output

**Estado: S2 ABSORBIDO en issue #3073 / PR `agent/3073-pipeline-dev`** (mayo 2026).

El sanitizer central (`.pipeline/sanitizer.js`) y el módulo satélite de filenames (`.pipeline/lib/sanitize-payload.js::FILENAME_SECRET_RE`) cubren ahora los siguientes proveedores LLM. Los placeholders son específicos por proveedor para preservar forensia ("¿qué provider hay que rotar?") y consistencia visual con los 13 placeholders previos del sanitizer.

| Proveedor | Regex (sobre texto NFC + zero-width strip + homoglyph fold) | Placeholder | Fuente del formato |
|-----------|---|---|---|
| Anthropic | `(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])` | `[REDACTED:ANTHROPIC_KEY]` | <https://docs.anthropic.com/claude/reference/getting-started-with-the-api> |
| OpenAI project | `(?<![A-Za-z0-9_-])sk-proj-[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])` | `[REDACTED:OPENAI_PROJECT_KEY]` | <https://platform.openai.com/docs/api-reference/authentication> |
| OpenAI clásico | `(?<![A-Za-z0-9_-])sk-(?!ant-\|proj-)[A-Za-z0-9]{48,}(?![A-Za-z0-9])` | `[REDACTED:OPENAI_KEY]` | <https://platform.openai.com/docs/api-reference/authentication> |
| Google OAuth access | `(?<![A-Za-z0-9_-])ya29\.[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])` | `[REDACTED:GOOGLE_OAUTH_TOKEN]` | <https://developers.google.com/identity/protocols/oauth2> |
| Google API key | `\bAIza[0-9A-Za-z_-]{35}\b` (preexistente) | `[REDACTED:GOOGLE_API_KEY]` | preexistente |
| Google OAuth refresh | `\b1//[0-9A-Za-z_-]{43,}\b` (preexistente) | `[REDACTED:GOOGLE_OAUTH_REFRESH]` | preexistente |
| GitHub | `gh[pousr]_[A-Za-z0-9]{30,}` / `github_pat_[A-Za-z0-9_]{80,}` (preexistente) | `[REDACTED:GITHUB_TOKEN]` | preexistente |

**Orden de evaluación crítico** (`.pipeline/sanitizer.js::PATTERNS`): los patrones con prefijo más específico corren ANTES que los genéricos para preservar la atribución por proveedor:

1. `sk-ant-…` (Anthropic)
2. `sk-proj-…` (OpenAI project)
3. `sk-…` clásico (OpenAI, con negative lookahead `(?!ant-|proj-)`)
4. `ya29.…` (Google OAuth access)

Si un patrón estructural anterior (`HEADER_AUTHORIZATION`, `HEADER_X_API_KEY`, `CONF_STRUCTURED`) matchea primero, el secreto queda redactado con el placeholder genérico (`BEARER_TOKEN`, `API_KEY`, `CONF_VALUE`) — es comportamiento aceptado: no leak, sólo pierde detalle de provider en algunos contextos. Para `apiKey="sk-ant-…"` el patrón Anthropic sí gana primero (preserva forensia).

**Anchors** (lookbehind/lookahead negativos sobre `[A-Za-z0-9_-]` en lugar de `\b`): se usan así porque `_` es word-char y `-` no, lo que vuelve a `\b` frágil cuando una key termina en `-` o aparece pegada a otro identificador. Los anchors explícitos garantizan match sólo cuando hay separador claro alrededor (espacio, comilla, igual, punto y coma, salto de línea, fin de string).

**Tests obligatorios** (cubiertos en `.pipeline/tests/sanitizer.test.js` + `.pipeline/tests/sanitize-payload.test.js`):

- Positivos por proveedor (Anthropic / OpenAI clásico / OpenAI project / Google OAuth access).
- Orden mixto: input con `sk-ant-X` + `sk-Y` redacta cada uno con su placeholder (no se pisan).
- Prefijo malicioso: `sk-ant-AAA` corto NO matchea como OpenAI clásico ni como Anthropic.
- Falsos positivos en código legítimo: `sk-button-primary` (Tailwind), `sk-thumbnail-default` (slug), `claude_session_id` (identificador), `ya29` suelto sin punto.
- Idempotencia: doble pasada sobre output ya saneado no altera placeholders.
- Anti-bypass: ZWSP en medio de `sk-ant-` → se redacta gracias a normalización NFC + strip de zero-width.
- Chunk-split en `createSanitizeStream`: secreto Anthropic / Google partido en 2-3 chunks → se redacta correctamente con la ventana deslizante de 256 bytes.
- Panic dump simulado: stack trace con la key como string literal y header `x-api-key` con la key → ambos casos redactados antes de tocar disco.
- Filenames de Drive (`FILENAME_SECRET_RE`): `dump-sk-ant-X.log`, `qa-${ya29}-X.txt`, `oai-sk-Y.log`, `leak-sk-proj-X.txt` → renombrados a `redacted-<hash8>.<ext>` antes del upload.

**Cobertura de salidas** (CA3 del PO):

- Logs (`logs/*.log`) — `sanitize-log-stream.js` heredan del core.
- Telegram (`text`, `caption`, filenames) — `sanitize-payload.js::sanitizeTelegramPayload` + `sanitizeDriveFilename`.
- Rejection report PDF — `rejection-report.js:1512` aplica `sanitizeReportText` antes del HTML→PDF.
- Audit trail (`lib/traceability.js`) — verificado: ningún `prompt` plaintext se persiste; los hashes son SHA-256.
- Drive (descripción, título, filenames) — `sanitize-payload.js::sanitizeDrivePayload` + `sanitizeDriveFilename`.

### 6.6 Anti command-injection del template de spawn args

- Expansión obligatoriamente a **array de argv**. Prohibido string concatenado.
- `spawn(cmd, args, { shell: false, windowsHide: true })`. Prohibido `shell: true` salvo casos específicos documentados (e.g. `.cmd` shim Windows — caso heredado en `detectClaudeLauncher`).
- Schema validation en boot rechaza templates con caracteres de shell sin escapar.
- **Test de fuzzing del template runner** (issue S3): inputs maliciosos en `user_prompt` que intenten inyectar separadores de shell → el spawn debe pasarlos como un solo argumento, NO ejecutarlos.

### 6.7 Permission model mapping

Tabla explícita de equivalencias (issue S4):

| Capacidad harness Claude | Equivalente codex | Equivalente Gemini CLI | Equivalente Ollama |
|--------------------------|-------------------|------------------------|--------------------|
| `--permission-mode bypassPermissions` (Claude Code) | `--no-confirm` | n/a (sin gating built-in) | n/a |
| `--permission-mode acceptEdits` | `--auto-edit` | n/a | n/a |
| `--permission-mode plan` | n/a (codex no tiene plan mode propio) | n/a | n/a |

Si un provider no tiene equivalente semántico para un permission mode requerido por un skill, ese skill **NO puede correr en ese provider** hasta validación manual y excepción documentada.

### 6.8 Audit trail dinámico

Hoy `pulpo.js:4903` y `lib/traceability.js:11` reportan `model: 'claude-opus-4-7'` hardcoded — **ya estamos rompiendo el audit trail con un solo provider** (sería false claim si corremos Sonnet). Multi-modelo lo amplifica.

> **Estado**: implementado por issue [#3083](https://github.com/intrale/platform/issues/3083) (S5). Esta sección documenta el contrato resultante.

Cada `session:start` registra:

- `provider` (anthropic | openai-codex | gemini | ollama | deterministic) — resuelto por `agent-models.json` (#3072). **Nunca inferido por substring del model name** (frágil + colisiona con futuros routers).
- `model` (string completo del modelo, ej. `claude-opus-4-7`, `gpt-5-codex`). Si el resolver no entregó un modelo concreto, el campo queda como `deterministic` (default explícito); **NO se inventa un modelo Claude por fallback** — el log refleja la realidad para forensia.
- `cli_version` — resuelto al boot del pulpo via `<launcher> --version`. Caché por `launcherPath` para amortizar el costo. Si el spawn falla → `'unknown'`. Si el provider es deterministic → `'n/a'`. **Nunca `null`/`undefined`** (el log siempre lleva string no-vacío).
- `git_sha_provider_adapter` — SHA del archivo del adaptador en uso (`git hash-object <adapter_path>`). `null` cuando provider es deterministic. **PROHIBIDO leerlo de env vars** (`PROVIDER_ADAPTER_SHA` y similares se ignoran): un atacante con control de spawn args podría spoofear el SHA y mentir sobre qué adaptador estaba activo.

Cada `session:end` registra: `prompt_hash` (SHA-256 del system+user prompt, **NO el contenido**), token counts (`tokens_in/out/cache_read/cache_write`), y `cost_usd_estimated` (calculado por `estimateCostUsd(provider, model, tokens)` con la tabla de `pricing.json`).

Logs de sesión append-only (`fs.appendFileSync`, **prohibidos** flags `w`/`r+`/`a+`/truncate) por al menos 30 días para forensia (`pipeline.audit_retention_days` en `config.yaml`, default 90, **clamp ≥30 hardcoded** en `lib/traceability.js` — una config maliciosa con `audit_retention_days: 1` se eleva automáticamente al piso).

#### 6.8.0 Algoritmo de hash de prompts (S5 / #3083 — CA-10)

`prompt_hash` viaja en `session:end` y es la única forma de correlacionar sesiones equivalentes en forensia. Su algoritmo está fijado y bumpear la versión requiere coordinación cross-equipo (rompe correlación histórica).

**Especificación `prompt_hash_v1`** (implementación: `lib/traceability.js:hashPromptPair`):

1. **Inputs**: `systemContent` (contenido del system prompt) y `userContent` (contenido del user prompt). Ambos son strings.
2. **Normalización**: UTF-8 NFC (`String.normalize('NFC')`). **Sin trim** (espacios en bordes son significativos para el hash). Los bytes literales se conservan.
3. **Concatenación**: `system + SOH + user`, donde `SOH` es el byte `` (Start Of Heading, ``, no imprimible). Razón: cualquier separador imprimible (`\n`, `\t`, `|`, etc.) puede aparecer en prompts en texto y crear colisiones donde dos pares distintos producen el mismo hash; SOH no aparece naturalmente en prompts editados por humanos.
4. **Hash**: SHA-256 (`crypto.createHash('sha256')`), output en **hex lowercase de 64 chars** (`.digest('hex')`).
5. **Inputs nulos**: si `systemContent` o `userContent` son `null`/`undefined` → el helper devuelve `null` (sesiones sin prompt: skills determinísticos, tests).

**Contrato de no-leak (SEC-1)**: el módulo `traceability.js` **NUNCA** recibe el contenido del prompt como parámetro a `emitSessionStart` o `emitSessionEnd`. El caller (`pulpo.js`) hashea con `hashPromptPair(systemContent, userContent)` ANTES del spawn y pasa solo el digest al handle. Defensa en profundidad contra leaks accidentales del contenido al audit log.

**Bump de versión**: cualquier cambio al algoritmo (otro separador, otro hash, otra normalización) **requiere bumpear a `prompt_hash_v2`** y exponerlo como helper nuevo (`hashPromptPairV2`). El campo en el log puede agregar `prompt_hash_version` (default `v1`) para preservar correlación histórica. No hacerlo destruye la utilidad forense del campo.

#### 6.8.1 Restricción de contenido en notificaciones post-hoc

Las notificaciones post-hoc por Telegram de switches automáticos cross-MODELO (§7.6.1) NO deben incluir:

- Payload del prompt (`user_prompt` o `system_prompt`).
- Snippets de código del repo.
- Stack traces del CLI.
- Contenido de archivos analizados por el agente.

**Solo metadata**: `skill`, `provider:model` (anterior y nuevo), `costo_estimado` del próximo issue, `motivo` (string corto del algoritmo, ej. `cost_threshold_breached`). Razón: la cola Telegram (`servicios/telegram/pendiente`) y el chat de Telegram son ambos canales con menor sensitividad de retención que el repo — no deben recibir secrets ni código fuente.

#### 6.8.2 Integridad de inputs del algoritmo de selección

Bajo el régimen automático (Política A), el algoritmo de §4.3 lee de `.claude/activity-log.jsonl` para decidir degradar o no. Eso convierte ese archivo en **input crítico de seguridad** — su integridad determina las decisiones automáticas del pipeline.

Vectores nuevos que abre el régimen:

- **Telemetry poisoning**: atacante con write access (PR malicioso, hook comprometido, supply chain de un tool) infla `tokens_in/out/duration_ms` de skills críticos → fuerza degradación silenciosa → reduce capacidad de detección.
- **Rebote suppression**: borrar entradas de rebote (`motivo:*`) baja la tasa artificialmente → habilita degradación que no debería ocurrir.
- **Cold start exploitation**: skills nuevos sin histórico (período frío de §4.3) corren con default conservador, pero la transición es ventana de riesgo si no se documenta el threshold.

**Controles obligatorios bajo el régimen automático** (algunos ya en código del algoritmo, otros como hardening pendiente):

| Control | Implementación | Estado |
|---------|----------------|--------|
| Cap de profundidad de degradación | `lib/model-selector.js` (issue H8) — máx 1 escalón por sesión, requiere `N_CLEAN_SESSIONS` para bajar otro | bloqueante para Fase 1 |
| Filtrado de rebotes infra/flaky | `lib/model-selector.js` (issue H8) — sólo cuentan rebotes con `motivo` que indique calidad de razonamiento | bloqueante para Fase 1 |
| Skills no-degradables hardcoded | `NO_DEGRADABLE_SKILLS` en código del lanzador (§6.11) | bloqueante para Fase 1 |
| Audit log dedicado de switches | `.pipeline/audit/model-switches.jsonl` con hash chain (§6.8.3) | bloqueante para Fase 1 |
| Integridad verificable de `activity-log.jsonl` | HMAC por entrada o hash chain | hardening — issue [#3067](https://github.com/intrale/platform/issues/3067), no bloqueante |

#### 6.8.3 Audit log de switches automáticos

§6.8 ya pide audit trail por sesión. Lo que el régimen automático agrega es la necesidad de un **audit log dedicado al evento de decisión** (cuándo y por qué el algoritmo cambió de modelo para un skill), separado del log por sesión.

**Especificación**:

- Archivo: `.pipeline/audit/model-switches.jsonl` (append-only).
- Modo: `0o600`.
- Cada entrada incluye:
  - `ts` — timestamp UTC ISO-8601.
  - `skill`, `phase`, `issue` — contexto del switch.
  - `from_model` / `to_model` — modelos completos (`anthropic:claude-opus-4-7` → `anthropic:claude-sonnet-4-7`).
  - `motivo` — razón del algoritmo (`cost_threshold_breached`, `phase_override`, `cold_start_default`, etc.).
  - `cost_avg_30d`, `rebote_rate_30d`, `sesiones_baseline` — snapshot de las métricas del algoritmo en el momento de la decisión.
  - `prev_hash` — SHA-256 de la entrada anterior (cadena hash).
  - `entry_hash` — SHA-256 de la entrada actual (incluyendo `prev_hash`).
- Comando de verificación: `node .pipeline/verify-audit-chain.js` — recorre el archivo, recomputa cada `entry_hash` y compara contra `prev_hash` de la siguiente entrada. Si la cadena se rompe en algún punto, falla con el offset exacto.

Sin este audit log, reconstruir forensia post-incidente requiere cruzar múltiples archivos a mano. Hardening pendiente: issue [#3068](https://github.com/intrale/platform/issues/3068).

### 6.9 Configuración como código

- `agent-models.json` bajo git con review obligatorio (CODEOWNERS cubre `.pipeline/`, ya activo).
- **Pre-commit hook** (issue S3) que valide schema (JSON Schema) y rechace `provider` desconocidos o launchers fuera de un allowlist.
- Flag de "romper el glass" para overrides de emergencia (env var `PIPELINE_PROVIDER_OVERRIDE`), con TTL y audit log obligatorio.

### 6.10 Threat model adversario interno (PR malicioso)

- Un atacante con permiso de PR puede inyectar `agent-models.json` apuntando a un launcher arbitrario (`launcher: "curl"`). **Mitigación**: allowlist hardcoded en `pulpo.js` (`ALLOWED_LAUNCHERS = new Set(['claude', 'codex', 'gemini', 'ollama', 'node'])`) + verificación de hash del binario detectado al boot (opcional, fase 3).
- Un atacante puede modificar `spawn_args_template` para incluir flags peligrosos (e.g. `--api-base http://attacker.com`). **Mitigación**: allowlist de flags por proveedor + validación schema rechaza flags fuera de allowlist.
- Un atacante puede agregar variables de env al `extraEnv` del spawn que filtren credenciales. **Mitigación**: §6.3 (allowlist de env del child).
- Un atacante puede pegar un secret literal en cualquier campo string de `agent-models.json` (ej: `permissions_mode: "sk-ant-..."`). **Mitigación** (S1, #3080): el validador walks recursivamente el JSON con denylist de prefijos públicos (`HARDCODED_SECRET_PATTERNS` en `lib/agent-models-validate.js`). El mensaje de rechazo nombra el patrón (ej: "Anthropic key (sk-ant-)") sin pegar el valor.
- Un atacante puede declarar `credentials_env: ["AWS_SECRET_ACCESS_KEY"]` en un provider para exfiltrar AWS creds al child del provider equivocado. **Mitigación** (S1, #3080): allowlist `ALLOWED_CREDENTIAL_ENV_VARS` en el validador acepta sólo nombres conocidos de credenciales LLM (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GH_TOKEN`, etc.); cualquier otra var es rechazada al boot.

#### 6.10.1 Disciplina anti path-traversal al generalizar el flag de cuota

Al pasar el flag `quota-exhausted.json` de global a granularidad `provider:model:skill` (§4.2), la construcción de keys y nombres debe seguir reglas estrictas:

- **Allowlist en código** para validar `provider`, `model` y `skill`. Los valores deben coincidir contra strings conocidos del schema cargado de `agent-models.json` (o, para `skill`, contra el set de roles registrados). Inputs que no matchean → flag NO se escribe, audit log lo registra.
- **Preferir single-flag con keys** sobre N archivos separados:
  ```jsonc
  // Preferido (un solo archivo)
  { "flags": {
      "anthropic:claude-opus-4-7": { "exhausted_at": "...", "skill": "review" },
      "anthropic:claude-sonnet-4-7": null
  }}
  ```
  vs:
  ```
  // Evitar (N archivos = N puntos de race + N puntos de path-traversal)
  .pipeline/quota-exhausted/anthropic-opus-4-7.json
  .pipeline/quota-exhausted/anthropic-sonnet-4-7.json
  ```
  Razón: un solo archivo simplifica el locking, reduce las superficies de ataque y simplifica la verificación de integridad.
- **Mantener defensa actual**: el truncado de `errorType` (`String(opts.errorType || '').slice(0, 64)` en `setFlag`) se extiende a las nuevas keys. Aunque allowlist hace el grueso, el truncado es el segundo nivel de defensa.

### 6.11 Skills no-degradables (lista hardcoded en código)

Bajo el régimen automático cross-MODELO (Política A), el algoritmo de §4.3 puede degradar un skill a un modelo más barato si el costo histórico es alto y la tasa de rebote es baja. Hay skills cuya capacidad de detección es crítica para la postura de seguridad del propio pipeline — degradarlos silenciosamente puede dejar pasar vulnerabilidades sutiles.

**Lista inicial de skills no-degradables** (default):

```js
// .pipeline/lib/agent-launcher.js (post-H2)
// NO mover a agent-models.json: cualquier cambio debe requerir PR auditable.
const NO_DEGRADABLE_SKILLS = new Set([
    'security',   // detección de vulnerabilidades
    'review',     // last gate antes de merge
    'builder',    // determinístico ya, no aplica el algoritmo
    'tester',     // determinístico ya, no aplica el algoritmo
]);
```

**Por qué hardcoded en código y NO en `agent-models.json`**:

- Cualquier cambio a esta lista representa una decisión de seguridad (relajar el gate). Debe pasar por PR con review humana (CODEOWNERS de `.pipeline/`).
- En `agent-models.json` es un archivo editable que un atacante con permiso de PR podría tocar más fácilmente.
- Los determinísticos (`builder`, `tester`) están en la lista por completitud — el algoritmo no aplica a ellos por construcción, pero dejarlos explícitos protege contra refactors futuros que confundan el flujo.

**Algoritmo cuando un skill está en la lista**: `lib/model-selector.js` retorna directamente `cfg.skills[skill].phase_overrides[fase]` o `cfg.skills[skill].model` sin pasar por la rama de degradación. El audit log (§6.8.3) registra `motivo: 'no_degradable_skill'` para que el operador pueda verificar que la lista está activa.

Hardening pendiente: issue [#3066](https://github.com/intrale/platform/issues/3066).

---

## 7) Experiencia del operador

> Sección extendida en v2 con guidelines del análisis UX. Incluye plantillas concretas de mensajes Telegram y formato de confirmación humana del refinamiento.

### 7.1 Visibilidad del provider/model en el dashboard

El dashboard V3 (`.pipeline/lib/dashboard-routes.js`, `.pipeline/lib/dashboard-slices.js`) hoy muestra qué skill está corriendo, pero no qué provider/modelo. Multi-modelo lo exige:

- Cada agente activo en el dashboard muestra `provider:model` (ej. `anthropic:opus-4-7`, `anthropic:sonnet-4-7`, `openai:gpt-5-codex`).
- **Iconografía consistente** por provider (color/badge distintivo) — facilita scaneo visual cuando hay 3+ agentes corriendo en paralelo. La paleta y los assets visuales los define UX (no este documento).
- En la tabla de issues procesados (histórico), columna `model_used` populada del audit trail dinámico (§6.8).
- **Histórico de switches recientes (últimos 7 días) accesible desde el row del skill** — útil para forensia rápida sin abrir `audit/model-switches.jsonl` (§6.8.3).
- **Indicador visual diferencial** entre cross-MODELO automático (badge neutro) y cross-PROVIDER pendiente de aprobación (badge en color de alerta) — sin cargar al operador con info redundante.

### 7.2 Feedback de cambios de provider

Cuando el operador edita `agent-models.json` y commitea (CODEOWNERS aprueba):

- Telegram notifica el cambio: *"Skill `qa` ahora corre con `openai:gpt-5-codex` en vez de `anthropic:sonnet-4-7` — costo estimado del sprint: -40% según consumo histórico"*.
- El primer issue procesado con el nuevo provider lleva tag/badge "primer run con nuevo provider" para que el operador lo revise con más atención.

### 7.3 Rejection reports — atribución de modelo y degradación reciente

Hoy un rejection report PDF no dice qué modelo lo produjo. Multi-modelo lo hace bloqueante para mejora continua:

- Cada rejection report PDF incluye en el header: `provider: anthropic | model: opus-4-7 | cli_version: x.y.z`.
- **Indicador de "degradación reciente"**: si el skill que rebotó tuvo un switch automático en las últimas N sesiones, el rejection report lo menciona explícitamente — para no atribuir el rebote a la calidad del agente cuando puede deberse a la elección del modelo. Issue U6.
- Audio narrado del rejection report menciona el modelo cuando aporta contexto (ej. *"el agente backend-dev corriendo con OpenAI Codex rechazó por..."*) — sólo cuando es relevante para que el operador entienda el motivo, no en todos los casos para no saturar.

### 7.4 UX de configuración de `agent-models.json`

El schema funciona pero la **experiencia de editar** importa:

- Schema con `description` por campo (JSON Schema lo soporta) → IDEs como VS Code muestran tooltips al hover.
- Permitir extensión `.jsonc` con comentarios para que el operador anote *por qué* eligió tal provider para tal skill.
- Script `node .pipeline/validate-agent-models.js` (issue U4) que valide schema + verifique que las credenciales de los providers configurados están disponibles en env, **antes del boot del pulpo**. Falla rápido con mensaje accionable (ej. *"provider `openai-codex` configurado pero `OPENAI_API_KEY` no está en env"*).

#### 7.4.1 Si tu commit/boot fue rechazado por `agent-models`, leé esto (#3081 CA-7)

El boot del pulpo y el pre-commit hook validan `.pipeline/agent-models.json` contra `lib/agent-models-validate.js`. Si te rechaza, mirá primero la línea `problema:` del mensaje. Acá están los 5 errores más comunes y cómo arreglarlos:

| Síntoma del mensaje | Qué pasó | Cómo se arregla |
|---|---|---|
| `launcher "X" no está en allowlist [claude, codex, gemini, ollama, node]` | El launcher declarado no es uno de los binarios permitidos | Editar el campo a uno del set, o agregar el nuevo a `ALLOWED_LAUNCHERS` en `.pipeline/lib/agent-models-validate.js` (requiere PR + review de Security: §6.6 + §6.10) |
| `placeholder "{X}" no está en allowlist` | Un `{nombre}` dentro de `spawn_args_template` no está en el set fijo `ALLOWED_PLACEHOLDERS` | Usar solo `{user_prompt, system_file, script_path, issue, trabajando_path}`. Si necesitás otro, editar `ALLOWED_PLACEHOLDERS` en el validador y revisar §3.4 |
| `flag peligroso "--api-base" / "--proxy" / ... en denylist` | El template incluye un flag que permite secuestrar el destino de red, la config o el runtime de node | Eliminar el flag. La denylist es `--api-base, --proxy, --http-proxy, --https-proxy, --config, --inspect, --inspect-brk, --require, -r, -e, --eval` (§6.10) |
| `must NOT have additional properties` con `additionalProperty: "onSpawn"` (o similar) | Hay un campo no declarado en el schema (`additionalProperties: false`) | Eliminar el campo extra. Si es legítimo, agregarlo al schema en `.pipeline/agent-models.schema.json` con tipo y description |
| `default_provider "fake" no es key de providers` o `provider "fake" no es key de providers` | Un provider referenciado en `default_provider` o en `skills.<x>.provider` no existe en la sección `providers` | Declarar el provider en la sección `providers`, o cambiar el assignment del skill |

**Reproducción local del rechazo**:

```bash
node .pipeline/lib/agent-models-validate.js
# o con archivo custom:
node .pipeline/lib/agent-models-validate.js --file ruta/a/agent-models.json
```

El comando es exactamente el mismo que corre el pre-commit hook, así que reproducís el rechazo sin tener que commitear.

**Exit codes** del validador (CA-2):

| Código | Significado | Quién lo arregla |
|---|---|---|
| `0` | OK | — |
| `1` | Excepción no controlada (stack trace) | Reportar como bug del validador |
| `2` | Config inválida | Editar `agent-models.json` siguiendo el mensaje |
| `3` | Toolchain ausente (no se pudo cargar `ajv`) | Correr `npm install` en la raíz del repo |

**Escape hatch** (sólo emergencia): si necesitás bootear el pulpo sin validar (recuperación urgente, NO uso normal), `PULPO_SKIP_AGENT_MODELS_VALIDATE=1`. Imprime un warning visible para que nadie lo deje activo por accidente.

### 7.5 Dashboard de costos cross-modelo + cross-provider

- Costos normalizados **por skill por issue** (no agregados por provider) — input directo para baseline horario #2891.
- Comparativa visual cuando un skill ha corrido con múltiples modelos en el sprint (ej. *"qa: 5 issues con sonnet ($0.40), 12 con haiku ($0.10) — 2 switches automáticos esta semana"*).
- Alerta cuando un cambio de modelo o provider produce costo inesperado (umbral configurable en `config.yaml`).

### 7.6 Plantillas de mensajes Telegram

> Plantillas iniciales para que la implementación posterior (issues U2, U3, U7) las consolide en `lib/telegram-templates.js` y mantenga consistencia de tono con el resto del pipeline (memorias `feedback_telegram-messages-natural.md` y `feedback_audio-consolidation.md`).

#### 7.6.1 Notificación post-hoc de switch cross-MODELO automático (Política A)

El operador NO participa en la decisión, pero debe tener visibilidad clara y no abrumadora.

**Plantilla de mensaje individual** (cuando ocurre un solo switch):

```
🔄 *qa* bajó a Sonnet
Motivo: skill template-driven con costo histórico arriba del umbral y tasa de rebotes baja (últimos 30d).
Stack: anthropic / claude-sonnet-4-7
Costo estimado del próximo issue: ≈ $0.05 (vs ≈ $0.25 con Opus)
```

**Plantilla consolidada** (si en una ventana de 5 min ocurren múltiples switches automáticos — coherente con `feedback_audio-consolidation.md` aplicada también a texto):

```
🔄 3 skills bajaron de modelo automáticamente
• *qa* — Sonnet → Haiku (costo prom 30d arriba del umbral, rebote 2%)
• *po* — Opus → Sonnet (skill liviano, rebote 0%)
• *ux* — Opus → Sonnet (skill template-driven, rebote 4%)

Ahorro estimado del próximo sprint: ≈ -55%
Detalle: dashboard → switches recientes
```

**Reglas de frecuencia**:

- 1 mensaje por evento de switch real. NO repetir el mismo aviso si el algoritmo confirma la elección sesión a sesión sin cambio.
- Consolidar en ventana de 5 min cuando hay múltiples switches.
- Permitir snooze opcional del flujo informativo (no del flujo crítico): el operador puede silenciar avisos de switch cross-MODELO por N horas si está concentrado, sin afectar otras alertas. Cap razonable: 24h hardcoded (analogía con `project_modo-descanso.md`).

**Restricción de contenido (§6.8.1)**: solo metadata. Prohibido incluir payload del prompt, snippets de código, stack traces o cualquier dato del request al CLI.

#### 7.6.2 Consulta decisoria de switch cross-PROVIDER (Política B)

Cuando el sistema necesita switch cross-PROVIDER (ej. cuota Anthropic agotada), la consulta debe contener TODO lo necesario para decidir sin investigar.

**Plantilla**:

```
⚠️ Cuota agotada: anthropic / claude-opus-4-7
El pipeline propone cambiar el skill *backend-dev* a OpenAI / GPT-5-codex.

Implicaciones:
 • TOS distinto: https://openai.com/policies/...
 • DPA distinto: https://openai.com/policies/dpa
 • Training opt-out activo: SÍ (configurado a nivel cuenta)
 • Región de procesamiento: US (default)

Costo estimado del próximo issue: ≈ $0.18 (vs ≈ $0.45 con Opus)

Comandos:
 • /approve-switch backend-dev openai gpt-5-codex → confirmar
 • /keep-blocked backend-dev → mantener bloqueado hasta que vuelva la cuota
 • /info-switch backend-dev → más detalles
```

**Idempotencia visible**: si el operador ya respondió, el siguiente aviso del mismo switch debe decir explícitamente *"Esperando confirmación enviada hace X min"*, no repetir la propuesta como si fuera nueva.

**Política de aprobación**: respeta `feedback_no-ask-approval.md` (memoria de equipo). La consulta cross-PROVIDER es la **excepción justificada** (TOS/DPA), no rutina. Para cross-MODELO no se pide nunca aprobación.

#### 7.6.3 Tono general

- Español técnico-natural, mismo estilo que el resto de los mensajes del pipeline.
- NO usar tecnicismos secos tipo `DEGRADE_OPUS_TO_SONNET cost_threshold_breached`.
- NO mezclar inglés en headers o bullets (ya el doc actual respeta esto).

### 7.7 Confirmación humana del refinamiento (CA-12 de #3065)

Antes de mergear este documento, Leo debe aprobar explícitamente el nuevo enfoque. Formato compacto (≤ 6 bullets) que el agente refinador presenta al PR:

**Resumen ejecutivo del refinamiento v2**:

- **Política dual de switch**: cross-MODELO (Opus/Sonnet/Haiku dentro de Anthropic) → automático sin barrera humana. Cross-PROVIDER (Anthropic → OpenAI/...) → con aprobación humana por TOS/DPA.
- **Deadlock cuota+consulta resuelto**: documentado que `lib/quota-exhausted.js` + `sendTelegram` corren en código determinístico Node, sin LLM. El componente ya existe operacionalmente — el doc lo declara explícito.
- **Cross-MODELO como dimensión primaria**: el schema reordenado pone `skills` con modelo concreto antes que `providers`. Antecedente: `docs/agents-model-optimization.md` (#1244) ya hizo este mapping; ahora se formaliza con telemetría cerrando el loop.
- **Algoritmo autónomo por agente**: pseudocódigo en §4.3 con período frío (5 sesiones), cap de profundidad (1 escalón por sesión), filtrado de rebotes infra/flaky, skills no-degradables hardcodeados (`security`, `review`, `builder`, `tester`).
- **Controles de seguridad nuevos**: §6.8.2 (integridad de inputs), §6.8.3 (audit log con hash chain), §6.10.1 (anti path-traversal), §6.11 (no-degradables hardcoded). Hardening pendiente registrado en #3066/#3067/#3068.
- **17 → 21 issues hijos** marcados [A] (cross-modelo, Fase 1) o [B] (cross-provider, Fase 2). H1 sigue siendo prerrequisito directo.

**Pregunta al operador (cerrada, sí/no/observaciones)**: *¿Aprobás este enfoque para que la implementación arranque por H1 (Fase 1, cross-modelo) sin tocar cross-provider hasta Fase 2?*

La respuesta queda registrada en el PR como comentario explícito de Leo (`/approve-design` o equivalente). Sin ese comentario, el merge queda bloqueado.

---

## 8) Recomendación final

**Fase 1 MVP — habilitar cross-MODELO automático dentro de Anthropic.** Razones:

1. **Cero superficie de cambio cross-provider**: el CLI Claude, el parser stream-json y los hooks de `.claude/` siguen igual. Todo el cambio es eliminar el hardcode de modelo + agregar el algoritmo de selección + audit log.
2. **Valor inmediato medible**: pasar skills livianos a Sonnet o Haiku abarata 4×–5× sin cambiar TOS, DPA ni región — análogo al ahorro ya cuantificado en `docs/agents-model-optimization.md` (#1244).
3. **Zero riesgo de compliance**: ningún switch cross-modelo dispara revisión legal porque todos los modelos siguen Anthropic.
4. **Camino directo a Fase 2**: la infraestructura (audit log, telemetría, plantillas Telegram) construida en Fase 1 se reusa entera para cross-PROVIDER.

**Fase 2 — agregar OpenAI/Codex como segundo proveedor con aprobación humana.** Razones:

1. **CLI maduro** (`codex` binary, UX similar a `claude`). El esfuerzo de adaptador es bajo.
2. **Tool use compatible** con function calling estable (JSON Schema), traducible al shape interno.
3. **Cubre el caso "se acabó la cuota Anthropic completa"** sin migrar a calidad inferior (Ollama) ni a stack inmaduro (Gemini CLI 2026-Q1 beta).
4. **Costo $/MTok significativamente menor que Anthropic** para skills de menor criticidad — habilita decisiones de costo informadas con la aprobación del operador.

**Descartes en Fase 1 + Fase 2**:

- **Gemini**: ecosistema CLI inmaduro al 2026-05; tier gratuito entrena con datos (riesgo de compliance); esperar a 2026-Q3 para reevaluar.
- **Ollama**: calidad menor; apto para skills no críticos (linter LLM, tagging) en fase 3, no en MVP.
- **OpenRouter**: latencia +200ms, oculta políticas downstream, dificulta DPA, tercer parser que mantener. No agrega valor mientras tengamos sólo 2 providers.

**Riesgo principal del MVP cross-MODELO**: degradación silenciosa de un skill crítico debido a métricas envenenadas o rebotes mal clasificados. Mitigación: §6.8.2 (cap de profundidad + filtrado), §6.11 (no-degradables hardcoded), §6.8.3 (audit log con hash chain).

**Riesgo principal de Fase 2 cross-PROVIDER**: tool use heterogéneo entre Anthropic y OpenAI/Codex. Mitigación: en Fase 2, los skills LLM que usan tools (TodoWrite, Skill, EnterPlanMode) **siguen en Anthropic**; sólo los skills LLM que producen texto (refinamiento, sizing, sumarización) pueden correr en OpenAI/Codex. Tool use cross-provider queda para fase 3 hardening.

---

## Anexos

- `docs/pipeline-multi-provider/agent-models.example.jsonc` — ejemplo concreto de configuración propuesta (anexo de este PR; el archivo canónico `.pipeline/agent-models.json` se crea en el issue hijo H1).
- `docs/pipeline-multi-provider/agent-models.schema.json` — JSON Schema propuesto para validación en boot del pulpo y en pre-commit (anexo de este PR; el archivo canónico se mueve a `.pipeline/agent-models.schema.json` en el issue hijo H1).

## Referencias

- Issue [#2956](https://github.com/intrale/platform/issues/2956) — historia de origen (diseño v1).
- Issue [#3065](https://github.com/intrale/platform/issues/3065) — refinamiento v2 (este documento).
- Issue [#2955](https://github.com/intrale/platform/issues/2955) — fallback determinístico (prerequisite operativo).
- Issue [#2334](https://github.com/intrale/platform/issues/2334) — sanitizer de logs (prerequisite del §6.5).
- Issue [#2891](https://github.com/intrale/platform/issues/2891) — baseline horario de costos (consumidor de §7.5).
- Issue [#1244](https://github.com/intrale/platform/issues/1244) — antecedente de optimización de modelos por skill (`docs/agents-model-optimization.md`).
- Issue [#3066](https://github.com/intrale/platform/issues/3066) — hardening: skill-allowlist no-degradable hardcodeada.
- Issue [#3067](https://github.com/intrale/platform/issues/3067) — hardening: integridad verificable de `activity-log.jsonl`.
- Issue [#3068](https://github.com/intrale/platform/issues/3068) — hardening: audit log tamper-evident de switches automáticos.
- Documento `docs/operacion-pipeline.md` — operaciones del pipeline (a actualizar en H1 con cómo cambiar provider).
- Documento `docs/agents-model-optimization.md` — antecedente concreto de cross-MODELO (no contiene `agent-models.json` aún).
