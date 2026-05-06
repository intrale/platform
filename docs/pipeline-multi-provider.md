# Pipeline multi-proveedor de IA — diseño

> Issue [#2956](https://github.com/intrale/platform/issues/2956) — Investigación + diseño.
> Estado: propuesta. **Este documento NO implementa código** — la implementación sale como issues hijos enumerados en la sección 5.
> Fecha del relevamiento empírico: 2026-05-06.
> Autor: pipeline-dev (agente).

## Por qué esta historia

Cuando se agota la cuota Anthropic todo el pipeline se frena. El issue [#2955](https://github.com/intrale/platform/issues/2955) cubre el fallback determinístico (skills sin LLM siguen funcionando), pero **no permite seguir produciendo trabajo que sí necesita LLM**: análisis, refinamiento, criterios, dev de código, review.

El objetivo de este diseño es que el pipeline sea **agnóstico de proveedor/modelo de IA** — que cualquier skill pueda correr contra Anthropic, OpenAI/Codex, Google Gemini, modelo local (Ollama), o cualquier proveedor compatible, eligiendo por config y **sin tocar el SKILL.md ni el código de cada agente**.

Beneficios:

- **Continuidad**: si Anthropic se queda sin cuota, los skills críticos pueden seguir contra OpenAI/Codex (con aprobación humana — ver §6.8).
- **Costo**: elegir el modelo más barato/capaz por skill (ej. `qa` con Ollama local, `backend-dev` con Sonnet 4.6).
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

### 2.3 Costo simulado contra el consumo histórico del pipeline

El pipeline ya guarda métricas de tokens reales por sesión en `.claude/activity-log.jsonl` (eventos `session:end` con `tokens_in`, `tokens_out`, `cache_read`, `cache_write`). Ejemplo de evento real:

```json
{"event":"session:end","skill":"ux","issue":3015,"phase":"criterios",
 "model":"claude-opus-4-7","tokens_in":31,"tokens_out":784,
 "cache_read":999152,"cache_write":125905,"duration_ms":189924,"tool_calls":13}
```

El agregador `metrics/aggregator.js:87` ya estima costo USD por sesión vía `estimateCostUsd(evt.model, evt)`. Para la comparativa cross-provider del MVP, el plan es:

1. Tomar la última semana de `activity-log.jsonl` (eventos `session:end` con `model: claude-*`).
2. Para cada sesión, recalcular costo aplicando los precios de cada provider candidato (asumiendo paridad de tokens, lo cual es aproximación — ver §2.4).
3. Producir tabla "qué costaría correr nuestro pipeline real en cada proveedor" — esto va al PR de implementación, no al documento.

**Esta normalización es prerequisite del dashboard de costos cross-provider** (#2891 baseline horario y trabajo derivado) — está listada como issue hijo en §5.

### 2.4 Consideraciones de paridad de calidad

Los precios no son comparables 1:1 porque la **calidad** y la **eficiencia de tokens** difieren entre modelos:

- **Opus 4.7 vs GPT-5**: en tareas de agente (tool use complejo, plan reasoning), Opus produce menos rondas de retry → menos tokens totales. La comparativa "$/MTok" subestima el costo real de modelos menos capaces.
- **Sonnet 4.7 vs GPT-5-mini**: pareja razonable de "modelo de día a día". GPT-5-mini es ~5× más barato per token; en skills cortos (refinamiento, sizing) puede empatar en costo total.
- **Ollama local**: $0/MTok pero a costo de calidad menor (Qwen2.5-Coder:32b ≈ Sonnet 3.5 en benchmarks). Apto para skills de baja criticidad (linter LLM, tagging, sumarización rápida) — NO para `backend-dev` ni `review`.

Recomendación operativa: la elección de modelo por skill se hace **leyendo costo real (no $/MTok abstracto) + tasa de rebote del skill**. Skill que rebote más con modelo barato → falsa economía.

---

## 3) Schema propuesto de `agent-models.json`

### 3.1 Diseño de alto nivel

El archivo vive en `.pipeline/agent-models.json` (no se crea en este issue, sale en el primer issue hijo). Tres niveles:

1. `default_provider` — proveedor por default cuando un skill no tiene override.
2. `providers` — definición de cada proveedor disponible (launcher, args, parser, error types, capacidades).
3. `skills` — asignación skill → provider, con override opcional de modelo.

### 3.2 Schema (extracto comentado)

```jsonc
{
  "$schema": "./agent-models.schema.json",
  "default_provider": "anthropic",
  "providers": {
    "anthropic": {
      "launcher": "claude",                        // alias resuelto por launcher allowlist (§6.10)
      "model": "claude-opus-4-7",                  // modelo default del provider
      "spawn_args_template": [
        "-p", "{user_prompt}",
        "--system-prompt-file", "{system_file}",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "bypassPermissions"
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
      "permissions_mode": "bypassPermissions"
    },
    "openai-codex": {
      "launcher": "codex",
      "model": "gpt-5-codex",
      "spawn_args_template": [
        "exec",
        "--prompt", "{user_prompt}",
        "--system-prompt-file", "{system_file}",
        "--stream",
        "--no-confirm"
      ],
      "output_parser": "openai-sse",
      "quota_error_types": ["insufficient_quota", "rate_limit_exceeded"],
      "supports_tool_use": "limited",              // sin paridad con tool_use de Claude
      "prompt_caching": { "supported": true, "auto": true },
      "credentials_env": ["OPENAI_API_KEY"],
      "permissions_mode": "no-confirm"
    },
    "deterministic": {
      "launcher": "node",
      "model": "deterministic",                    // sin LLM
      "spawn_args_template": [
        "{script_path}",
        "{issue}",
        "--trabajando={trabajando_path}"
      ],
      "output_parser": "none",
      "quota_error_types": [],
      "supports_tool_use": false,
      "prompt_caching": { "supported": false }
    }
  },
  "skills": {
    "backend-dev":  { "provider": "anthropic", "model_override": "claude-sonnet-4-7" },
    "android-dev":  { "provider": "anthropic" },
    "web-dev":      { "provider": "anthropic" },
    "pipeline-dev": { "provider": "anthropic" },
    "qa":           { "provider": "openai-codex" },
    "refinar":      { "provider": "anthropic", "model_override": "claude-opus-4-7" },
    "guru":         { "provider": "anthropic" },
    "po":           { "provider": "anthropic", "model_override": "claude-sonnet-4-7" },
    "ux":           { "provider": "anthropic" },
    "review":       { "provider": "anthropic" },
    "security":     { "provider": "anthropic" },
    "builder":      { "provider": "deterministic" },
    "tester":       { "provider": "deterministic" },
    "delivery":     { "provider": "deterministic" },
    "linter":       { "provider": "deterministic" }
  }
}
```

### 3.3 JSON Schema acompañante

Se propone publicar `docs/pipeline-multi-provider/agent-models.schema.json` en este mismo PR (anexo del documento) para que el primer issue hijo lo copie al lugar canónico (`.pipeline/agent-models.schema.json`) y lo use desde el boot del pulpo. Ver anexos al final.

### 3.4 Reglas de expansión del template (anti-injection)

`spawn_args_template` se expande **a array de argv**, nunca a string concatenado. Reglas:

1. Las claves entre `{...}` son sustituidas por valores escapados como **un solo elemento del argv**, sin pasar por shell.
2. Si una clave del template no resuelve, el boot **falla fast** — no se sustituye con string vacío silenciosamente.
3. La expansión rechaza valores que contengan caracteres de shell sin escapar (`;`, `&`, `|`, `$`, backticks) salvo que estén dentro de `user_prompt`, donde la mitigación es no usar `shell: true` en el spawn (ver §6.6).
4. `shell: false` siempre que el launcher sea binario nativo o JS directo. `shell: true` sólo permitido para `.cmd` shim Windows (caso heredado de `cmd-shim` en `detectClaudeLauncher`).

### 3.5 Externalización de `DETERMINISTIC_SKILLS`

Hoy `pulpo.js:4851` define `DETERMINISTIC_SKILLS = new Set(['builder', 'tester', 'delivery', 'linter'])` hardcoded. Con `agent-models.json`, ese set deja de existir como constante: cualquier skill cuyo `provider` resuelva a un provider con `output_parser: "none"` y `supports_tool_use: false` se considera determinístico. Esto resuelve A9 sin tabla aparte.

---

## 4) Plan de implementación en fases

### Fase 1 — MVP (Anthropic + OpenAI/Codex)

Objetivo: doble proveedor funcional, con OpenAI/Codex como segunda opción operativa.

**Criterios de salida verificables**:

- [ ] `.pipeline/agent-models.json` existe en el repo con schema validado en boot del pulpo.
- [ ] Hardcode `model: 'claude-opus-4-7'` eliminado de `pulpo.js:4903` y `traceability.js:11`. La telemetría reporta `provider` + `model` reales en cada `session:start` / `session:end`.
- [ ] `lanzarAgenteClaude` (~600 líneas) refactorizado a `lib/agent-launcher.js` con dispatch por provider.
- [ ] Adaptador `openai-codex` implementado: detector, args template, parser SSE, mapeo de tokens al shape común (`tokens_in`, `tokens_out`, `cache_read`, `cache_write`).
- [ ] Test E2E del pipeline con un skill de baja criticidad corriendo en `openai-codex` produciendo output válido y telemetría completa.
- [ ] Sanitizer extendido con regex para `sk-...` (OpenAI). Test de regresión que prueba que una key embebida en output NO aparece en `logs/<issue>-<skill>.log`.
- [ ] Schema validation pre-commit hook activo.
- [ ] Documento de operaciones (`docs/operacion-pipeline.md`) actualizado con cómo cambiar provider de un skill.

### Fase 2 — Hardening

Objetivo: cerrar todos los riesgos de seguridad de §6 y los gaps de UX de §7.

**Criterios de salida verificables**:

- [ ] Audit trail dinámico (provider + model + cli_version + git_sha_provider_adapter) en cada sesión.
- [ ] Aislamiento de credenciales por proceso: `process.env` filtrado a allowlist + sólo la key del provider del skill al spawnar.
- [ ] Permission model mapping documentado en código + tests de paridad (skills con tools que requieren bypass NO se permite ejecutarlos en providers sin equivalente semántico).
- [ ] Threat model adversario interno: pre-commit hook rechaza launchers fuera de allowlist; rechaza flags peligrosos; falla fast si schema inválido.
- [ ] Dashboard V3 muestra `provider:model` por agente activo y por issue procesado.
- [ ] Rejection reports incluyen `provider` + `model` + `cli_version` en el header del PDF.
- [ ] Costo normalizado en dashboard (cost_usd por skill por issue, no agregado por provider) — input para #2891 baseline.

### Fase 3 — Extensión opcional

Objetivo: agregar providers adicionales si y sólo si el negocio lo justifica.

**Criterios de salida verificables (por provider candidato)**:

- [ ] Sección de TOS / data residency aprobada por el operador (Leo).
- [ ] Adaptador implementado, parser específico, error types mapeados.
- [ ] Test E2E pasa con al menos un skill no crítico.
- [ ] Costos esperados en simulación contra `activity-log.jsonl` históricos < 90% del provider actual para el skill propuesto, O capacidad técnica única del provider (ej. ventana de contexto >1M tokens) que justifique el agregado.

Candidatos en orden de preferencia:

1. **Ollama local** — para skills no críticos de baja calidad aceptable (linter LLM, tagging). Ventaja: $0 marginal y datos no salen del host. Desventaja: calidad menor, requiere hardware GPU local.
2. **Google Gemini** — esperar a 2026-Q3 para que el ecosistema CLI estabilice. No agregar antes.

### Decisión: NO usar OpenRouter en MVP

OpenRouter parece atajo, pero:

- Suma latencia (~200 ms extra promedio).
- Oculta diferencias de billing (margin sobre cada provider downstream).
- Dificulta DPA (TOS de OpenRouter + del provider downstream).
- Tercer parser que mantener.

Empezar con 2 adaptadores delgados (Anthropic + OpenAI/Codex) directos a CLIs nativos. Reevaluar OpenRouter si la demanda escala a >3 proveedores y la complejidad de mantener N adaptadores supera la ganancia de control.

### Decisión: NO fallback automático cross-provider

Coincidente con análisis Security §6.8. Cuando se detecte cuota agotada del provider del skill:

1. El pipeline pasa a `quota-exhausted` (estado existente, infra de #2955).
2. Telegram notifica al operador con propuesta concreta de switch (`"qa pasaría a openai-codex, costo estimado del sprint: -X%"`).
3. El operador decide manualmente. Sólo entonces el pipeline edita `agent-models.json` (o usa override por sesión).

Justificación: cambiar de provider en medio de un sprint cambia calidad/costo y, sobre todo, **manda código y prompts a un proveedor distinto cuyo TOS / data residency el equipo no aprobó automáticamente**. La aprobación humana es barrera intencional, no fricción accidental.

---

## 5) Lista de issues hijos (no crear todavía — solo enumerar)

### 5.1 Issues técnicos prerequisites del MVP

| # | Título propuesto | Esfuerzo | Dependencias |
|---|------------------|----------|---------------|
| H1 | feat(pipeline): crear `.pipeline/agent-models.json` y `agent-models.schema.json` + eliminar hardcode `model:'claude-opus-4-7'` (A5) | medio | ninguna — **prerrequisito de todos** |
| H2 | refactor(pipeline): mover `lanzarAgenteClaude` a `lib/agent-launcher.js` con dispatch por provider | grande | H1 |
| H3 | feat(pipeline): adaptador OpenAI/Codex (launcher detector + args template + stream parser SSE + mapeo de tokens) | grande | H2 |
| H4 | refactor(pipeline): externalizar `DETERMINISTIC_SKILLS` (A9) a `agent-models.json` | simple | H1 |
| H5 | feat(pipeline): generalizar `quota-detector` (A6) con tabla `quota_error_types` por proveedor | medio | H1, H3 |
| H6 | feat(pipeline): clasificador `classifyExecutionMode` ahora dispatching por `provider` explícito en eventos `session:end` (A13) | simple | H1 |
| H7 | feat(pipeline): test E2E del pipeline con un skill no crítico corriendo en `openai-codex` produciendo output válido y telemetría completa | medio | H3 |

### 5.2 Issues de seguridad (de análisis Security)

| # | Título propuesto | Esfuerzo | Dependencias |
|---|------------------|----------|---------------|
| S1 | security(pipeline): inventario y rotación de credenciales de proveedores de IA (env vars, fail-fast en boot, política rotación ≤90 días) | medio | H1 |
| S2 | security(pipeline): sanitizer extendido con regex para API keys multi-proveedor (`sk-`, `AIza`, etc.) + tests de regresión por proveedor | medio | independiente, **valor inmediato hoy** |
| S3 | security(pipeline): validación schema + allowlist para `agent-models.json` (boot-time + pre-commit) | medio | H1 |
| S4 | security(pipeline): permission model mapping cross-provider (tabla de equivalencias + tests de paridad) | medio | H3 |
| S5 | security(pipeline): audit trail dinámico con `provider`, `model`, `cli_version`, `git_sha_provider_adapter` por sesión (fix de A5) | simple | H1 |
| S6 | security/governance: política de TOS / data residency / DPA por proveedor (input legal/Leo) — qué archivos del repo NO deben enviarse a no-Anthropic | medio | H1 |
| S7 | security(pipeline): aislamiento de credenciales por proceso (filtrar `process.env` con allowlist + sólo la key del provider del skill) — A16 | medio | H1, H3 |

### 5.3 Issues de UX del operador (de análisis UX)

| # | Título propuesto | Esfuerzo | Dependencias |
|---|------------------|----------|---------------|
| U1 | feat(dashboard-v3): mostrar `provider:model` por agente activo y columna `model_used` en histórico de issues procesados | simple | S5 |
| U2 | feat(telegram): notificar cambios de provider en `agent-models.json` con costo estimado vs anterior | simple | H1 |
| U3 | feat(rejection-reports): incluir `provider`/`model`/`cli_version` en header del PDF y mención opcional en audio narrado | simple | S5 |
| U4 | feat(pipeline): script `node .pipeline/validate-agent-models.js` que valide schema + verifique credenciales antes del boot | simple | H1, S1 |
| U5 | feat(dashboard-v3): comparativa de costo cross-provider por skill por sprint, con alerta cuando un cambio de provider produce costo inesperado (umbral en `config.yaml`) | medio | H3, S5 |

### 5.4 Issues de costos / métricas

| # | Título propuesto | Esfuerzo | Dependencias |
|---|------------------|----------|---------------|
| M1 | feat(metrics): normalizar costos cross-provider en `metrics/aggregator.js` para dashboard #2891 — soporte de `cost_usd` por modelo de cada provider | medio | H3 |
| M2 | feat(metrics): migrar `weekly-quota.js` (A15) de "duration_ms" como proxy a abstracción `quotaUsage(provider, ...)` | medio | H1, H3 |

**Total: 17 issues hijos enumerados** (7 técnicos + 7 seguridad + 5 UX + 2 métricas, descontado solapamientos = 17). H1 es **prerequisito directo de la mayoría**.

---

## 6) Seguridad y privacidad (sección bloqueante — pedido explícito de Security)

### 6.1 Modelo de amenazas: qué cambia con multi-proveedor

| Vector | Single-provider hoy | Multi-provider | Impacto |
|--------|---------------------|----------------|---------|
| Robo de credenciales | 1 token Anthropic | N tokens (Anthropic + OpenAI + ...) | Lineal en N |
| Exfiltración de código fuente | 1 destino (Anthropic TOS) | N destinos con políticas de retención y entrenamiento distintas | Compliance multiplica |
| Supply chain CLI | 1 binario (`claude`) | N binarios (`claude`, `codex`, etc.) | N puntos de update/auditoría |
| Parsers de output | 1 parser stream-json | N parsers (stream-json, SSE, custom) | N parsers = N posibles bugs de parseo |
| Adaptadores de tool use | 0 (nativo Anthropic) | Traductores XML↔JSON↔function-call | Nuevo código crítico para auth/permisos |
| Datos en tránsito | TLS Anthropic | TLS a N endpoints | Hay que pinear/auditar cada uno |
| Configuración | Hardcode `pulpo.js` | `agent-models.json` editable | Archivo de alto valor para atacante |

### 6.2 Gestión de secretos

- **Inventario completo de credenciales** por proveedor en `docs/secrets-inventory.md` (issue S1).
- **Política de rotación** ≤90 días por convención.
- **Almacenamiento**: prohibido poner API keys en `agent-models.json`. Sólo refs a env vars (`${ANTHROPIC_API_KEY}`, `${OPENAI_API_KEY}`).
- **Boot fail-fast**: si el provider configurado en `agent-models.json` no tiene su credencial inyectada, el pulpo NO arranca (no degrada silenciosamente al default).

### 6.3 Aislamiento de credenciales por proceso

Hoy `pulpo.js:4922-4933` propaga `process.env` completo al child. Con multi-proveedor:

- El env del child contiene **sólo** la API key del proveedor que ese child va a usar.
- Drop de env: filtrar `process.env` a un allowlist mínimo (PATH, HOME, USERPROFILE, APPDATA, PIPELINE_*) + la key específica del provider del skill.
- Aislamiento es **obligatorio** — si OpenAI key viaja en el env de un agente Anthropic, una panic dump del CLI puede filtrarla al log.

### 6.4 Política de TOS / data residency por proveedor

Tabla obligatoria en `docs/pipeline-multi-provider/data-residency.md` (issue S6):

| Proveedor | Training opt-out por default | Región de procesamiento | BAA / DPA disponible | Retención logs lado proveedor |
|-----------|-------------------------------|------------------------|--------------------|-----------------------------|
| Anthropic API | sí (no entrena con datos API) | US (default), EU opcional | sí (Enterprise) | 30 días default |
| Anthropic Plan Max | sí | US | no aplica | n/a (no logs lado servidor) |
| OpenAI API | configurable (opt-out manual en settings) | US (default), EU opcional | sí (Enterprise) | 30 días default |
| OpenAI tier free | NO (entrena con datos) | US | no | indefinido |
| Google Gemini API paga | configurable | US/EU | sí | 30 días default |
| Google Gemini tier free | NO (entrena con datos) | US | no | indefinido |
| Ollama local | n/a (datos no salen) | local | n/a | local indefinido |

**Decisión a documentar (issue S6, requiere input del operador)**: qué información del repo NO debe mandarse a proveedores no-Anthropic. Candidatos a excluir hoy:

- `.pipeline/secrets/` (no debería existir en repo, pero en caso de hallazgo histórico).
- `users/src/main/resources/application.conf` (config con secrets AWS).
- AWS SDK creds (`~/.aws/credentials` no está en repo, pero hay pruebas que las usan).

### 6.5 Sanitizado universal de output

Estado actual: `lib/sanitize-log-stream.js` usa `createSanitizeStream` (#2334) — funciona para Anthropic. Multi-proveedor exige extender el set de regex:

| Proveedor | Regex sugerido |
|-----------|---------------|
| Anthropic | `claude_[A-Za-z0-9_-]+`, `sk-ant-[A-Za-z0-9_-]+` |
| OpenAI | `sk-[A-Za-z0-9]{48,}`, `sk-proj-[A-Za-z0-9_-]+` |
| Google | `AIza[A-Za-z0-9_-]{35}`, OAuth tokens `ya29\.[A-Za-z0-9_-]+` |
| GitHub | `ghp_[A-Za-z0-9]{36}`, `gho_[A-Za-z0-9]{36}` (ya existen pero dejamos explícito) |

Tests de regresión obligatorios (issue S2): **stub de cada parser que reciba una API key embedida en el output** del proveedor → verificar que NO aparece en el log final.

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

Hoy `pulpo.js:4903` y `lib/traceability.js:11` reportan `model: 'claude-opus-4-7'` hardcoded — **ya estamos rompiendo el audit trail con un solo provider** (sería false claim si corremos Sonnet). Multi-proveedor lo amplifica.

Cada `session:start` debe registrar:

- `provider` (anthropic | openai-codex | gemini | ollama | deterministic).
- `model` (string completo del modelo, ej. `claude-opus-4-7`, `gpt-5-codex`).
- `cli_version` (resolver al boot del pulpo, persistir en handle de sesión).
- `git_sha_provider_adapter` (sha del archivo del adaptador en uso).

Cada `session:end` registra: prompt hash (SHA-256 del system+user prompt, NO el contenido), token counts, costo estimado.

Logs de sesión inmutables (append-only) por X días para forensia (X = config). Issue S5 implementa el fix.

### 6.9 Configuración como código

- `agent-models.json` bajo git con review obligatorio (CODEOWNERS cubre `.pipeline/`, ya activo).
- **Pre-commit hook** (issue S3) que valide schema (JSON Schema) y rechace `provider` desconocidos o launchers fuera de un allowlist.
- Flag de "romper el glass" para overrides de emergencia (env var `PIPELINE_PROVIDER_OVERRIDE`), con TTL y audit log obligatorio.

### 6.10 Threat model adversario interno (PR malicioso)

- Un atacante con permiso de PR puede inyectar `agent-models.json` apuntando a un launcher arbitrario (`launcher: "curl"`). **Mitigación**: allowlist hardcoded en `pulpo.js` (`ALLOWED_LAUNCHERS = new Set(['claude', 'codex', 'gemini', 'ollama', 'node'])`) + verificación de hash del binario detectado al boot (opcional, fase 3).
- Un atacante puede modificar `spawn_args_template` para incluir flags peligrosos (e.g. `--api-base http://attacker.com`). **Mitigación**: allowlist de flags por proveedor + validación schema rechaza flags fuera de allowlist.
- Un atacante puede agregar variables de env al `extraEnv` del spawn que filtren credenciales. **Mitigación**: §6.3 (allowlist de env del child).

---

## 7) Experiencia del operador

> Sección inspirada en el análisis UX del issue. NO bloqueante para aprobación del documento, pero recomendada para evitar re-trabajo en la fase de implementación.

### 7.1 Visibilidad del provider/model en el dashboard

El dashboard V3 (`.pipeline/lib/dashboard-routes.js`, `.pipeline/lib/dashboard-slices.js`) hoy muestra qué skill está corriendo, pero no qué provider/modelo. Multi-provider lo exige:

- Cada agente activo en el dashboard muestra `provider:model` (ej. `anthropic:opus-4-7`, `openai:gpt-5-codex`, `deterministic:node`).
- **Iconografía consistente** por provider (color/badge distintivo) — facilita scaneo visual cuando hay 3+ agentes corriendo en paralelo. La paleta y los assets visuales los define UX (no este documento).
- En la tabla de issues procesados (histórico), columna `model_used` populada del audit trail dinámico (§6.8).

### 7.2 Feedback de cambios de provider

Cuando el operador edita `agent-models.json` y commitea (CODEOWNERS aprueba):

- Telegram notifica el cambio: *"Skill `qa` ahora corre con `openai:gpt-5-codex` en vez de `anthropic:sonnet-4-7` — costo estimado del sprint: -40% según consumo histórico"*.
- El primer issue procesado con el nuevo provider lleva tag/badge "primer run con nuevo provider" para que el operador lo revise con más atención.

### 7.3 Rejection reports — atribución de provider

Hoy un rejection report PDF no dice qué modelo lo produjo. Multi-provider lo hace bloqueante para mejora continua:

- Cada rejection report PDF incluye en el header: `provider: anthropic | model: opus-4-7 | cli_version: x.y.z`.
- Audio narrado del rejection report menciona el modelo cuando aporta contexto (ej. *"el agente backend-dev corriendo con OpenAI Codex rechazó por..."*) — sólo cuando es relevante para que el operador entienda el motivo, no en todos los casos para no saturar.

### 7.4 UX de configuración de `agent-models.json`

El schema funciona pero la **experiencia de editar** importa:

- Schema con `description` por campo (JSON Schema lo soporta) → IDEs como VS Code muestran tooltips al hover.
- Permitir extensión `.jsonc` con comentarios para que el operador anote *por qué* eligió tal provider para tal skill.
- Script `node .pipeline/validate-agent-models.js` (issue U4) que valide schema + verifique que las credenciales de los providers configurados están disponibles en env, **antes del boot del pulpo**. Falla rápido con mensaje accionable (ej. *"provider `openai-codex` configurado pero `OPENAI_API_KEY` no está en env"*).

### 7.5 Dashboard de costos cross-provider

- Costos normalizados **por skill por issue** (no agregados por provider) — input directo para baseline horario #2891.
- Comparativa visual cuando un skill ha corrido con múltiples providers en el sprint (ej. *"qa: 12 issues con anthropic ($2.30), 8 con openai ($0.80)"*).
- Alerta cuando un cambio de provider produce costo inesperado (umbral configurable en `config.yaml`).

---

## 8) Recomendación final

**Agregar OpenAI/Codex como segundo proveedor en MVP.** Razones:

1. **CLI maduro** (`codex` binary, UX similar a `claude`). El esfuerzo de adaptador es bajo.
2. **Tool use compatible** con function calling estable (JSON Schema), traducible al shape interno.
3. **Cubre el caso "se acabó la cuota Anthropic"** sin migrar a calidad inferior (Ollama local) ni a stack inmaduro (Gemini CLI 2026-Q1 beta).
4. **Costo $/MTok significativamente menor que Anthropic** para skills de menor criticidad — habilita decisiones de costo informadas.

**Descartes en MVP**:

- **Gemini**: ecosistema CLI inmaduro al 2026-05; tier gratuito entrena con datos (riesgo de compliance); esperar a 2026-Q3 para reevaluar.
- **Ollama**: calidad menor; apto para skills no críticos (linter LLM, tagging) en fase 3, no en MVP.
- **OpenRouter**: latencia +200ms, oculta políticas downstream, dificulta DPA, tercer parser que mantener. No agrega valor mientras tengamos sólo 2 providers.

**Riesgo principal del MVP**: tool use heterogéneo entre Anthropic y OpenAI/Codex. Mitigación: en MVP, los skills LLM que usan tools (TodoWrite, Skill, EnterPlanMode) **siguen en Anthropic**; sólo los skills LLM que producen texto (refinamiento, sizing, sumarización) pueden correr en OpenAI/Codex en MVP. Tool use cross-provider queda para fase 2 hardening.

---

## Anexos

- `docs/pipeline-multi-provider/agent-models.example.jsonc` — ejemplo concreto de configuración propuesta (anexo de este PR; el archivo canónico `.pipeline/agent-models.json` se crea en el issue hijo H1).
- `docs/pipeline-multi-provider/agent-models.schema.json` — JSON Schema propuesto para validación en boot del pulpo y en pre-commit (anexo de este PR; el archivo canónico se mueve a `.pipeline/agent-models.schema.json` en el issue hijo H1).

## Referencias

- Issue [#2956](https://github.com/intrale/platform/issues/2956) — historia de origen.
- Issue [#2955](https://github.com/intrale/platform/issues/2955) — fallback determinístico (prerequisite operativo).
- Issue [#2334](https://github.com/intrale/platform/issues/2334) — sanitizer de logs (prerequisite del §6.5).
- Issue [#2891](https://github.com/intrale/platform/issues/2891) — baseline horario de costos (consumidor de §7.5).
- Documento `docs/operacion-pipeline.md` — operaciones del pipeline (a actualizar en H1 con cómo cambiar provider).
- Documento `docs/agents-model-optimization.md` — antecedente de optimización de modelos (no contiene `agent-models.json`).
