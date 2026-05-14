# Multi-provider — spike de 3er provider gratuito como fallback

> **Issue:** [#3200](https://github.com/intrale/platform/issues/3200) — spike research-only para evaluar un tercer provider gratuito que actúe como tercer fallback del pipeline V3, después de `anthropic` y `openai-codex`.
> **Estado:** spike documental. La validación empírica (corrida de prompts reales) queda pendiente hasta que Leo provisione las API keys de los providers shortlisteados (ver §10).
> **Audiencia:** dev del pipeline (decisiones de integración), PO (sign-off del riesgo de degradación), Leo (validación final + provisión de keys).

---

## 1. Resumen ejecutivo

| Item | Decisión propuesta |
|------|--------------------|
| Provider primario gratuito (3er fallback) | **Groq** — `llama-3.3-70b-versatile` y `qwen2.5-coder-32b` |
| Provider alterno gratuito (4to fallback) | **Google Gemini AI Studio** — `gemini-2.0-flash` |
| Skills no degradables al 3er provider | `security`, `qa`, `review` (en PRs sensibles), `audit_trail`-required |
| Skills tolerantes al 3er provider | `po`, `ux`, `guru`, `builder`, `tester`, `android-dev`, `backend-dev`, `pipeline-dev` |
| Esfuerzo estimado de integración | Medio — ~10–14 puntos de toque siguiendo la checklist de `docs/pipeline/multi-provider.md` §1.1 |
| Riesgo principal | Degradación de calidad → más rebotes → más tokens en otros providers; mitigación con detección+pausa parcial |

**Por qué Groq como primario:**

1. **Free tier sustentable y observable:** 30 RPM, 14.400 req/día por modelo, sin pedir tarjeta de crédito.
2. **API OpenAI-compatible:** reusa la mayor parte del adapter `openai-codex` (parser SSE, env var de credencial, manejo de tool calls). Esfuerzo de integración menor que un launcher CLI nuevo.
3. **Tool use nativo (function calling):** requisito mínimo según guru en #3082; descarta candidatos que parsean JSON de texto plano.
4. **Privacidad clara:** TOS explícitamente excluyen el uso de prompts del free tier para entrenar modelos (ver §4.1.3).
5. **Latencia y throughput:** LPU custom silicon → infiere a 200–500 tok/s en `llama-3.3-70b`. Mejor experiencia de iteración cuando el primario está agotado.

**Por qué Gemini como alterno** (no primario):

1. Cuota free generosa y context window enorme (1M tokens), pero **el free tier de AI Studio entrena con los prompts** (sólo opt-out en tier pago Vertex AI). Para skills sensibles eso es un go/no-go negativo.
2. CLI ya stubeado en el pipeline (`ALLOWED_LAUNCHERS` incluye `gemini`), entonces si Groq falla, switchear a Gemini cuesta menos que sumar un cuarto provider desde cero.
3. Sirve como **segunda red de seguridad** para skills donde la privacidad del prompt no es crítica (e.g. `builder`, `tester`, partes de `pipeline-dev` que no operan sobre código sensible).

---

## 2. Contexto y alcance

El pipeline V3 quedó cerrado con dos providers operativos (`anthropic` Claude Max, `openai-codex` GPT-5) más `deterministic` para scripts sin LLM ([#3082](https://github.com/intrale/platform/issues/3082) permission model, [#3176](https://github.com/intrale/platform/issues/3176) doc operativa, [#3177](https://github.com/intrale/platform/issues/3177) dashboard).

El cap mensual de Claude Max es finito y el budget de OpenAI también. Cuando el ballot del proyecto se dispare en horas pico, hace falta un tercer fallback **gratuito y estable** para no parar la cola.

### 2.1 Lo que el spike entrega (alcance cumplido)

- Filtro pre-benchmark por TOS y opt-out de training (§3).
- Tabla comparativa de 8 candidatos (§4).
- Análisis de fit por cada uno de los 11 skills del pipeline (§5).
- Riesgos identificados con mitigación concreta (§6).
- Recomendación final priorizada con justificación técnica (§7).
- Lista de issues hijos a crear para la ola N+1 de integración (§8).

### 2.2 Lo que el spike NO entrega (fuera de alcance)

- Implementación de cualquier provider en `.pipeline/lib/agent-launcher/providers/` — eso es la **ola N+1**.
- Corridas empíricas de "1 prompt por skill comparando contra Claude Sonnet baseline" — requiere API keys que Leo todavía no provisionó (ver §10).
- Modificación de `agent-models.json` o catálogo de modelos — sólo recomendación documental.
- Cambios en dashboard o quota-adapters — son parte de la ola N+1.

---

## 3. Filtro pre-benchmark (TOS y opt-out)

Por la advertencia de guru en el análisis técnico del issue, primero descartamos candidatos que entrenan con prompts del free tier sin opt-out claro. **Cualquier provider que use prompts del free tier como dato de entrenamiento queda descartado por default** para skills con `tool_use_gated`, `fine_grained_acl` o `audit_trail` — un agente puede ver código privado del repo y configs de infra.

### 3.1 Resultado del filtro

| Provider | Free tier entrena con prompts | Opt-out free tier disponible | Veredicto filtro |
|----------|:---:|:---:|---|
| Groq | ❌ No (TOS explicitan retención corta, sin training) | n/a | ✅ Pasa |
| Google Gemini (AI Studio free) | ✅ Sí | ❌ No (sólo en Vertex AI / paid) | ⚠️ Pasa con restricción: sólo para skills no-sensibles |
| DeepSeek | ✅ Sí (TOS china, retención larga) | ❌ No claro | ❌ Descartado para skills con código privado |
| Cerebras Inference | ❌ No (TOS no entrena en free) | n/a | ✅ Pasa |
| Mistral La Plateforme (free experimental) | ⚠️ Ambiguo en docs públicas | ⚠️ Sólo en tier enterprise | ⚠️ Pasa con cautela |
| OpenRouter (gateway free) | ⚠️ Depende del modelo backing — algunos sí, otros no | ⚠️ Variable | ⚠️ Pasa pero requiere whitelist por modelo |
| Together.ai (free credits) | ⚠️ TOS estándar | ⚠️ Sólo pago | ⚠️ Pasa con cautela |
| Cohere Trial | ❌ No (Trial Key TOS excluye training) | n/a | ✅ Pasa |

### 3.2 Shortlist post-filtro

Quedan en evaluación de capabilities y calidad:

- **Groq** ✅
- **Cerebras Inference** ✅
- **Cohere Trial** ✅
- **Google Gemini AI Studio** ⚠️ (restringido a skills no-sensibles)

Quedan **fuera del shortlist primario** por TOS o ambigüedad legal:

- DeepSeek (privacidad y jurisdicción)
- Mistral La Plateforme free (ambigüedad de docs)
- OpenRouter free (delegado a backing model — riesgo de cambio TOS sin aviso)
- Together.ai free (credits limitados, no es free tier sustentable)

---

## 4. Tabla comparativa (shortlist + referencias)

Datos al **2026-05-14**. Las cuotas free se relevaron de la documentación pública vigente; pueden cambiar sin aviso (ver §6.2 — Mitigación por cuota cap).

### 4.1 Shortlist (post-filtro TOS)

#### 4.1.1 Groq

| Atributo | Valor |
|----------|-------|
| Modelos free | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `qwen2.5-coder-32b`, `mixtral-8x7b-32768` |
| Cuota free | 30 RPM, 14.400 req/día (por modelo), 6.000 tokens/min |
| Tool use | ✅ Nativo (OpenAI-compatible function calling) |
| JSON mode | ✅ `response_format: { type: "json_object" }` |
| Context window | 8k (mixtral) → 128k (llama-3.3-70b) |
| Permission gating | ⚠️ Sin gate harness propio (corre como API HTTP); equivalencia capability se obtiene desde la capa harness Claude Code |
| Estabilidad | Alta — LPU silicon custom, latencia 200–500 tok/s, uptime publicado >99.5% |
| TOS opt-out training | n/a — no entrena con prompts free tier |
| CLI/launcher | API HTTP. Reusable adapter `openai-codex` (mismo SSE/JSON-stream pattern) |
| Coste over-cap | Tier pago: ~$0.59/1M input, $0.79/1M output (llama-3.3-70b) — barato pero no gratis |

#### 4.1.2 Cerebras Inference

| Atributo | Valor |
|----------|-------|
| Modelos free | `llama-3.3-70b`, `llama-3.1-8b` |
| Cuota free | 1M tokens/día, 30 RPM (developer tier) |
| Tool use | ⚠️ Soporte reciente (mid-2025); maturity menor que Groq |
| JSON mode | ✅ Soportado |
| Context window | 8k → 128k según modelo |
| Permission gating | ⚠️ Sin gate harness propio (igual que Groq) |
| Estabilidad | Alta — WSE-3 silicon, latencia 1500–2500 tok/s (lo más rápido del mercado) |
| TOS opt-out training | n/a — no entrena con prompts free tier |
| CLI/launcher | API HTTP, OpenAI-compatible |
| Coste over-cap | Tier pago disponible, ~$0.85/1M input, $1.20/1M output |

#### 4.1.3 Cohere Trial

| Atributo | Valor |
|----------|-------|
| Modelos free | `command-r-08-2024`, `command-r-plus-08-2024` |
| Cuota free | 1.000 req/mes (Trial key), 10 RPM |
| Tool use | ✅ Nativo (Cohere SDK function calling) |
| JSON mode | ✅ Soportado vía structured output |
| Context window | 128k |
| Permission gating | ⚠️ Sin gate harness propio |
| Estabilidad | Alta — uptime publicado >99.7% |
| TOS opt-out training | n/a — Trial Key TOS no incluye training |
| CLI/launcher | SDK Cohere (no es OpenAI-compatible) → adapter custom requerido |
| Coste over-cap | Tier pago: $0.50/1M input, $1.50/1M output (command-r) |
| **Limitación crítica** | **1.000 req/mes** — insuficiente para uso continuo del pipeline (sí útil como backup-de-backup) |

#### 4.1.4 Google Gemini AI Studio

| Atributo | Valor |
|----------|-------|
| Modelos free | `gemini-2.0-flash`, `gemini-2.5-pro` (preview), `gemini-1.5-flash-8b` |
| Cuota free | 15 RPM, 1.500 req/día, 1M tokens/min (flash) |
| Tool use | ✅ Nativo (function calling con responseSchema) |
| JSON mode | ✅ `responseMimeType: application/json` + schema |
| Context window | 1M tokens (flash), 2M (pro paid) |
| Permission gating | ⚠️ Sin gate harness; cliente Google define el filtro |
| Estabilidad | Muy alta (infra Google) |
| TOS opt-out training | ❌ **No** en AI Studio free; opt-out sólo en Vertex AI paid |
| CLI/launcher | `gemini` CLI ya stubeado en `ALLOWED_LAUNCHERS` |
| Coste over-cap | $0.075/1M input, $0.30/1M output (flash) — extremadamente barato |
| **Restricción** | Sólo para skills que NO procesan código sensible o secretos |

### 4.2 Descartados (referencia para auditoría)

| Provider | Motivo de descarte |
|----------|---------------------|
| DeepSeek | TOS china, free tier entrena, no hay opt-out. Skills con código privado en riesgo. |
| Mistral La Plateforme | Free tier experimental con docs ambiguas sobre training; tier sustentable es pago. |
| OpenRouter free | Modelo backing cambia disponibilidad/TOS sin aviso; ingeniería frágil. |
| Together.ai | Free credits ($5 inicial) — no es free tier sustentable, sólo onboarding. |

---

## 5. Análisis de fit por skill

> Convenciones: las capabilities requeridas vienen de `docs/pipeline-multi-provider/permission-mapping.md` §3 — matriz canónica capability×(provider, mode).
> "Fail-CLOSED" significa que si no se puede correr con el provider primario o secundario, **el skill se pausa** (modo descanso parcial sobre ese skill) hasta que se restablezca un provider tier-1, en vez de degradar.

| Skill | Capabilities requeridas | 3er fallback propuesto | Justificación |
|-------|--------------------------|------------------------|----------------|
| `po` | `tool_use_gated` | **Groq** llama-3.3-70b | Criterios de aceptación y análisis de UX toleran degradación de calidad. Tool use nativo cubre `gh issue view`. |
| `ux` | `tool_use_gated` | **Groq** llama-3.3-70b | Análisis de tendencias/benchmarking soporta degradación. Si se necesitan assets visuales, sigue siendo responsabilidad del propio agente con MCP, no del LLM. |
| `guru` | `tool_use_gated` + `fine_grained_acl` | **Groq** qwen2.5-coder-32b | Investigación técnica con Context7. Qwen-coder es competente en lectura de código y razonamiento técnico. Para análisis profundos sensibles, escalar manual a Claude. |
| `security` | `tool_use_gated` + `fine_grained_acl` + `audit_trail` | **fail-CLOSED — NO degradar** | Auditoría OWASP requiere reasoning de máximo nivel y trazabilidad reproducible. Reportes de security con falsos positivos/negativos comprometen el producto. |
| `review` | `tool_use_gated` | **Groq** qwen2.5-coder-32b (con restricción) | Code review básico tolerable. **Excepción:** PRs con labels `security:*`, `priority:critical` o que tocan `users/`, `backend/`, `.pipeline/lib/` → fail-CLOSED. |
| `builder` | `shell_access` | **Groq** llama-3.1-8b-instant | Build orchestration es lectura de logs + decisiones simples. 8b basta. **Caveat:** `builder` ya tiene un brazo `deterministic` para spawns de `./gradlew` directos; el LLM sólo decide qué tarea correr. |
| `tester` | `shell_access` | **Groq** llama-3.1-8b-instant | Idem `builder` — el LLM decide qué tests correr y parsea resultado; la ejecución es determinística. |
| `qa` | `shell_access` + `screen_record` | **fail-CLOSED — NO degradar** | QA E2E con video graba evidencia que se mergea con `qa:passed`. Si el reporte es incorrecto, se mergea código defectuoso. No-degradable. |
| `android-dev` | `tool_use_gated` + `fine_grained_acl` | **Groq** qwen2.5-coder-32b | Compose es Kotlin con buena cobertura en datasets de qwen-coder. Tool use cubre `Read`/`Edit`. Para refactors profundos o nuevos features con APIs raras → escalar manual. |
| `backend-dev` | `tool_use_gated` + `fine_grained_acl` | **Groq** qwen2.5-coder-32b | Idem `android-dev`. Ktor + Kotlin con cobertura razonable. **Caveat:** llamadas AWS-SDK específicas → escalar manual. |
| `pipeline-dev` | `tool_use_gated` + `fine_grained_acl` | **Groq** qwen2.5-coder-32b | Node.js puro tiene la cobertura más alta de los datasets de cualquier model. Riesgo bajo. |

### 5.1 Skills marcados fail-CLOSED — política operativa

Cuando `security`, `qa` (o `review` en PRs sensibles) caen al 3er fallback:

1. El pipeline no degrada al provider gratuito.
2. Emite alerta Telegram: *"⚠️ Skill `<name>` requiere provider tier-1 — pausado hasta restablecer Claude o Codex."*
3. Se invoca **pausa parcial** automática sobre el issue dependiente del skill (ya implementado vía `.partial-pause.json` — ver `docs/pipeline/pausa-parcial.md`).
4. Cuando Claude o Codex se restablecen, el issue se destraba automáticamente.

---

## 6. Riesgos y mitigaciones

### 6.1 Riesgo: calidad menor → más rebotes → mayor consumo en otros providers

**Mitigación:**

1. **Telemetría diferenciada por provider** (ya disponible vía #3177 dashboard): graficar `rebotes/issue/provider`. Si Groq dispara más de 1.5× los rebotes de Claude para el mismo skill, alertar.
2. **Circuit breaker por skill+provider**: si una combinación supera el ratio de rebote × `circuit_breaker_threshold` (default `2.0`), el pipeline marca esa combinación temporalmente unavailable y escala al alterno (Gemini para skills no sensibles, fail-CLOSED para sensibles).
3. **Métrica de costo total**: el dashboard ya muestra costo cross-provider — observar el costo "amortizado" en Claude por rebotes originados en Groq. Si el saving del free tier se compensa por costo extra en rebotes, **revisar la decisión**.

### 6.2 Riesgo: free tier cap del 3er provider también se agota

**Mitigación:**

1. **Detección por error_type** (sigue el patrón de `KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER` en `quota-exhausted.js`): Groq devuelve HTTP 429 con `error.type = "rate_limit_exceeded"` y `error.code = "rate_limit_exceeded"`. Sumar a la meta-allowlist.
2. **Cascada de fallback**: cuando Groq se agota → escalar a Gemini (alterno) para skills tolerantes → si Gemini también, **pausa parcial humano-bloqueado** (no rebote ciego).
3. **Cap por skill, no global**: que Groq se agote para `po` no debe bloquear `builder`. Usar adapters de cuota independientes por skill (extender `quota-adapters/groq.js`).

### 6.3 Riesgo: privacidad — providers free pueden cambiar TOS sin aviso

**Mitigación:**

1. **Recheck TOS trimestral** (issue recurrente con label `area:legal` cada 90 días).
2. **Whitelist explícita en `model-catalog.js`**: si un modelo desaparece o cambia TOS, falla en boot. No "auto-discover" de modelos del provider.
3. **No mandar secretos al 3er provider**: el adapter de Groq debe scrubear cualquier string que matche el patrón de secretos (AWS keys, Cognito, Telegram bot token). Reusar `lib/handoff.js` `redactSecrets`.

### 6.4 Riesgo: detección de degradación opaca para Leo

**Mitigación:**

1. **Banner en dashboard** (#3177): cuando ≥1 skill activo está corriendo en 3er provider, mostrar banner amarillo *"Pipeline operando con provider degradado: `<lista>`"*.
2. **Notificación Telegram on entry/exit**: la primera vez que un skill cae a Groq en una ventana de 1h, mandar mensaje. Misma cosa cuando vuelve a Claude/Codex.
3. **Audit trail extendido**: cada ejecución registra qué provider+modelo se usó en `agent-registry.json` (ya implementado en #3082). Filtrar por `provider != "anthropic"` da el conjunto de runs degradados para auditoría retroactiva.

### 6.5 Riesgo: tool_use nativo de Groq tiene edge cases

**Mitigación:**

1. **Sandbox test antes de promover a producción**: el adapter de Groq corre tests E2E contra un skill de prueba simulando llamadas `gh issue view`, `Read`, `Bash` antes de incluirse en `agent-models.json`.
2. **Fallback a JSON-mode**: si tool_use falla en runtime, el adapter degrada a JSON-mode y parsea el wrapper. Validado contra schema Ajv (mismo patrón que el resto del pipeline).

---

## 7. Recomendación final

### 7.1 Decisión propuesta

- **3er fallback primario:** **Groq**
  - Modelos: `llama-3.3-70b-versatile` (general), `qwen2.5-coder-32b` (skills coder), `llama-3.1-8b-instant` (builder/tester low-stakes).
  - Razón: free tier sustentable + tool use nativo + OpenAI-compatible (reuso de adapter) + TOS limpio.

- **4to fallback alterno:** **Google Gemini AI Studio** (`gemini-2.0-flash`)
  - Sólo para skills no-sensibles (`builder`, `tester`, partes de `pipeline-dev` que NO tocan secrets ni código privado de `users/`/`backend/`).
  - Razón: cuota free generosa + context 1M + CLI ya stubeado. Aceptado **a pesar** de TOS que entrena en free tier, **bajo restricción de skills**.

- **Skills no-degradables:** `security`, `qa`, `review` (en PRs sensibles), cualquier skill con capability `audit_trail`.
  - Política: **fail-CLOSED** + pausa parcial + alerta Telegram. No degradan jamás.

### 7.2 Por qué no Cerebras como primario

Cerebras tiene mejor latencia (2500 tok/s vs 500 tok/s) pero:
- Cuota free menor (1M tok/día vs 14.4k req/día).
- Tool use más nuevo (mid-2025) — menos batalla en producción.
- Mismo paradigma que Groq (OpenAI-compatible) → si Groq nos falla por TOS o quota, switch a Cerebras es trivial. Tenerlo como **primario** no aporta vs tenerlo como **swap-in**.

Recomendación operativa: **mantener Cerebras documentado como "swap-in inmediato"** (mismo adapter, sólo cambia `baseUrl` y `credentials_env`). No incluirlo en `agent-models.json` por default — incluirlo si Groq deteriora.

### 7.3 Por qué Cohere no entra

1.000 req/mes es 33/día. El pipeline produce ~80–150 ejecuciones/día en operación normal. Cohere Trial sería sostenible <1 día. Sí útil como **circuito de emergencia humano** (correr a mano vía SDK), no como tier automatizado.

---

## 8. Lista de issues hijos para la ola N+1 (a crear después del sign-off)

Ordenados por dependencia. Cada uno debe llevar label `needs-definition` o `Ready` para que el pulpo los tome ([#1244 memory](../../../.claude/projects/.../feedback_issues-creados-con-label-pipeline.md) — todo issue creado tiene que llevar label de admisión).

### 8.1 Integración Groq — 10 puntos de toque (orden estricto)

1. **`feat(pipeline): sumar groq a model-catalog.js + bump CATALOG_VERSION`**
   - Agregar entry `groq` con los 3 modelos al `CATALOG`.
   - Bump `CATALOG_VERSION` a `2026-05-15.1`.
   - Test: snapshot del catálogo en `__tests__/model-catalog.test.js`.

2. **`feat(pipeline): sumar groq a ALLOWED_LAUNCHERS + ALLOWED_OUTPUT_PARSERS + ALLOWED_CREDENTIAL_ENV_VARS`**
   - `.pipeline/lib/agent-models-validate.js`: agregar `'groq'` a launchers, `'groq-sse'` (variante OpenAI-compatible) a parsers, `GROQ_API_KEY` a env vars permitidas.

3. **`feat(pipeline): handler groq en lib/agent-launcher/providers/groq.js`**
   - `detectLauncher`, `buildSpawn`, `parseTokensFromLog`, `detectQuotaExhausted`.
   - Reusar SSE parser de `openai-codex` con override de base URL.

4. **`feat(pipeline): resolve-provider sum groq + quota-adapter groq.js`**
   - `PROVIDER_HANDLERS.groq = require('./providers/groq.js')`.
   - `quota-adapters/groq.js` con `quotaUsage(sessionData)` offline.
   - Sumar `'groq'` a `ALLOWED_PROVIDERS` de `quota-adapters/index.js`.

5. **`feat(pipeline): sumar groq error_types a KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER`**
   - `quota-exhausted.js`: `groq: ['rate_limit_exceeded', 'quota_exceeded', 'tokens_per_minute_exceeded']`.

6. **`feat(pipeline): declarar provider groq en agent-models.json`**
   - Bloque `providers.groq` con `launcher: "groq"`, `model: "llama-3.3-70b-versatile"`, `spawn_args_template`, `output_parser`, `credentials_env: ["GROQ_API_KEY"]`, `permissions_mode: "default"`.

7. **`feat(pipeline): agregar GROQ_API_KEY al schema de secrets-rw.js`**
   - Documentar dónde se rota la key.
   - Validar formato (`gsk_*`).

8. **`feat(pipeline): scrubbing de secrets en groq adapter`**
   - El adapter debe ejecutar `handoff.redactSecrets()` sobre el `system_prompt` y `user_prompt` antes de enviarlos. Test: prompt con `AWS_SECRET_ACCESS_KEY=...` → enviado redactado.

9. **`feat(dashboard): tab groq en dashboard multi-provider`**
   - Sumar a `dashboard-v2.js` el rendering del nuevo provider.
   - Banner "modo degradado" cuando ≥1 skill activo está en `groq`.

10. **`feat(pipeline): circuit breaker rebote-rate por (skill, provider)`**
    - Si `rebotes(skill, groq) / rebotes(skill, anthropic) > 2.0` en ventana de 24h → marcar `(skill, groq)` unavailable temporalmente.

### 8.2 Integración Gemini alterno (después de Groq estable)

11. **`feat(pipeline): activar provider gemini stubeado`**
    - `model-catalog.js`: agregar `gemini-2.0-flash`, `gemini-2.5-pro`.
    - Handler `providers/gemini.js` usando `gemini` CLI ya en `ALLOWED_LAUNCHERS`.
    - Whitelist explícita de skills permitidos (sólo `builder`, `tester`, low-stakes).

### 8.3 Operativos / observabilidad

12. **`feat(pipeline): política fail-CLOSED para skills no-degradables`**
    - `agent-models.json` campo nuevo `no_degrade_below: "tier-1"` por skill.
    - Si todos los tier-1 providers están unavailable y el skill tiene `no_degrade_below: tier-1`, emitir pausa parcial + alerta Telegram en vez de degradar.

13. **`feat(dashboard): banner "operando con provider degradado"`**
    - Color amarillo cuando ≥1 skill activo está en 3er fallback.
    - Lista clickeable de skills degradados.

14. **`chore(legal): recheck trimestral de TOS de providers free`**
    - Issue recurrente cada 90 días con label `area:legal`.
    - Checklist: TOS opt-out training, retención de datos, jurisdicción, cambios de cuota free.

### 8.4 Validación empírica pendiente (post-keys)

15. **`spike(pipeline): corrida empírica de 1 prompt por skill contra Groq llama-3.3-70b`**
    - Requiere API key de Groq (Leo provisiona).
    - Comparar output con Claude Sonnet baseline.
    - Documentar diffs y casos donde Groq es insuficiente.

---

## 9. Métricas de éxito post-integración

Para validar que la decisión fue correcta, monitorear durante las primeras 4 semanas post-merge:

| Métrica | Target | Acción si no se cumple |
|---------|--------|-------------------------|
| `rebote_rate(groq) / rebote_rate(claude)` por skill no-sensible | ≤ 1.5× | Bajar el modelo a `qwen2.5-coder` o subir el threshold del circuit breaker |
| `tokens_total_costo_amortizado` (incl. rebotes) | ≤ 90% del baseline pre-groq | Revisar si el saving real existe o si los rebotes compensan |
| Incidentes de skill fail-CLOSED por mes | ≥ 1 antes del trimestre | Validar que la red de seguridad funciona; si nunca dispara, revisar la matriz |
| TOS recheck completado cada 90 días | 4/año | Issue auto-creado por scheduler |

---

## 10. Validación pendiente con Leo (criterio de aceptación del issue)

Antes de cerrar #3200 y arrancar la ola N+1 de implementación, hace falta:

1. **Sign-off explícito de Leo** sobre:
   - Groq como 3er fallback primario.
   - Gemini como 4to fallback alterno (con la restricción de skills no-sensibles a pesar del TOS de training).
   - Lista de skills fail-CLOSED (`security`, `qa`, `review`-sensible).
   - Lista de issues hijos de §8 para crear en la siguiente ola.

2. **Provisión de API keys** (para la fase empírica, fuera de este spike):
   - `GROQ_API_KEY` — Leo crea cuenta en https://console.groq.com → API Keys → Create.
   - `GEMINI_API_KEY` — Leo crea cuenta en https://aistudio.google.com → Get API key.
   - Ambas se inyectan en `~/.claude/secrets/telegram-config.json` (ver `docs/pipeline/multi-provider.md` §1.3).

3. **Decisión sobre Cerebras como swap-in documentado** (no integrado por default) — confirmar que es aceptable mantenerlo "fuera de catálogo" hasta que Groq deteriore.

---

## 11. Referencias

- Issue origen: [#3200](https://github.com/intrale/platform/issues/3200)
- Permission model multi-provider: [#3082](https://github.com/intrale/platform/issues/3082), [`docs/pipeline-multi-provider/permission-mapping.md`](../pipeline-multi-provider/permission-mapping.md)
- Doc operativa multi-provider: [#3176](https://github.com/intrale/platform/issues/3176), [`docs/pipeline/multi-provider.md`](./multi-provider.md)
- Dashboard multi-provider: [#3177](https://github.com/intrale/platform/issues/3177)
- Memory `feedback_v3-bundled-instrumentation.md` — issues de migración V3 deben incluir trazabilidad
- Memory `project_v3-efficiency-priority.md` — V3 preferí bloqueado-humano a rebote automático
- Memory `feedback_issues-creados-con-label-pipeline.md` — issues nuevos llevan `needs-definition` o `Ready`
