# Auditoría LLM del Pulpo (CA-1 / issue #3259)

> Última pasada: 2026-05-17 — `pipeline-dev` con `git rev-parse HEAD` sobre la rama `agent/3259-pipeline-dev`.

## Objetivo

Validar empíricamente que el **único** punto donde el Pulpo (`.pipeline/pulpo.js`) invoca un LLM es el spawn del agente para la fase activa, y que ese spawn pasa por la cadena de fallbacks multi-provider (`#3198 — lib/agent-launcher/dispatch-with-fallback.js`). El resto de la lógica del orquestador (intake, dispatch, transición de fases, gestión de worktrees, allowlist, rebote classifier, dependency parser) corre en **Node puro sin tokens**.

## Metodología

Grep mecánico sobre `.pipeline/pulpo.js` + `.pipeline/lib/**/*.js` filtrando por palabras clave de invocación a LLM (`spawn`, `claude.exe`, `lanzarAgenteClaude`, `anthropic`, `openai`, `gemini`, `groq`, `cerebras`) y revisión manual de cada hit para clasificar:

| Clase | Significado |
|-------|-------------|
| **A — invocación LLM real** | El path crítico spawnea un binario que consume tokens. |
| **B — referencia textual** | Comentario / nombre de función / constante. Sin tokens. |
| **C — detector / clasificador** | Lectura/escritura de flags y estado. Sin tokens. |
| **D — child env / launcher** | Construcción del env del child antes del spawn. Sin tokens. |

## Resultados

### Clase A — invocaciones LLM (path crítico)

Solo **una** función `pulpo.js:lanzarAgenteClaude(skill, issue, trabajando, pipeline, fase, config, extraEnv)` (línea ~4992). Su comportamiento:

1. **Gate determinístico pre-spawn** (#2974 → `lib/quota-exhausted.js`):
   - Lee `quota-exhausted.json` con `shouldGateSpawn(skill, { provider })`. Si el flag activo coincide con el provider del skill, deja el archivo en `pendiente/` y NO spawnea.
2. **Cadena de fallbacks multi-provider** (#3198 → `lib/agent-launcher/dispatch-with-fallback.js`):
   - Si el primary queda gated, itera `skill.fallbacks[]` de `agent-models.json` con cap `MAX_FALLBACK_DEPTH=5` y anti-cycle.
   - Cada attempt audita con hash-chain SHA-256 (`lib/audit-log.js`).
3. **Si `dispatchResolution.gated === true`** (primary + todos los fallbacks gated):
   - El archivo vuelve a `pendiente/`.
   - **#3259 nuevo**: aplica label `provider-exhaustion-pause`, encola Telegram, persiste marker de dedupe (CA-9), audita con hash-chain (`lib/provider-exhaustion-pause.js`).
   - Brazo de retry destraba cuando algún provider de la chain se libera (CA-10).
4. **Si `dispatchResolution.gated === false`**:
   - Spawn del child con `CLAUDE_LAUNCHER` (anthropic) o el launcher resuelto (`openai-codex`, `groq`, `gemini-google`, `cerebras`) según el handler del fallback.
   - Env aislado por skill via `lib/build-child-env.js` (#3085) — allowlist mínima, scope per-provider.

**Conclusión CA-1 / CA-2 / CA-3:**
- El Pulpo **no invoca LLM directamente**. Toda invocación pasa por `lanzarAgenteClaude → resolveSpawnWithFallback`.
- La cadena de fallbacks ya estaba en main (#3198). Este issue (#3259) cierra los gaps operacionales: label, Telegram, healthcheck, dashboard card, chaos test, doc.
- Las decisiones del orquestador (intake/dispatch/transiciones) son 100% determinísticas. No hay un brazo del pulpo que llame a un modelo para decidir routing.

### Clase B — referencias textuales

Comentarios y nombres legacy (no invocan LLM):

- `pulpo.js:163 — detectClaudeLauncher()`: detecta la ubicación del binario `claude.exe` (Node CLI o nativo). Devuelve struct con `cmd`/`args`/`shell`. **Sin spawn**.
- `pulpo.js:201 — CLAUDE_LAUNCHER`: constante con el resultado de detectClaudeLauncher. **Sin spawn**.
- `pulpo.js:6879 — usa CLAUDE_LAUNCHER.cmd` solo cuando `lanzarAgenteClaude` arma `spawn(CLAUDE_LAUNCHER.cmd, args, opts)` para el provider Anthropic. Path crítico ya cubierto por Clase A.
- `pulpo.js:8742 — log('Claude launcher: ...')` arranque: logea qué launcher detectó. Informativo.
- `pulpo.js:1184–1224 — MAX_EST_CPU / MAX_EST_MEM`: caps de recursos por proceso `claude.exe`. **Sin spawn**.

> Recomendación #3277 (no bloquea este issue): renombrar `lanzarAgenteClaude → lanzarAgenteLLM` para reflejar la realidad post multi-provider.

### Clase C — detectores y clasificadores (Node puro)

- `lib/quota-exhausted.js` (#2974/#3077): detector de cuota agotada. Match estructural sobre el JSON stream del CLI (NO substring sobre texto libre). Persiste flag con scope per-provider.
- `lib/rebote-classifier.js`: clasifica rebotes por shape de YAML. Sin LLM.
- `lib/dep-comment-parser.js`: regex sobre comentarios GH para extraer dependencias. Sin LLM.
- `lib/routing-classifier.js`: deriva el skill por labels del issue (mapping deterministic). Sin LLM.
- `lib/admission-gate.js` (#3175): aplica label de admisión a issues sin label. GraphQL + filtro determinístico.

### Clase D — child env / launcher

- `lib/build-child-env.js` (#3085): construye el env del child con allowlist mínima. NO invoca LLM; pre-spawn.
- `lib/agent-launcher/resolve-provider.js`: resuelve `{ provider, model, handler }` desde `agent-models.json`. Lookup determinístico.
- `lib/agent-launcher/dispatch-with-fallback.js` (#3198): consumer runtime de `skill.fallbacks[]`. Decide qué provider arrancar antes del spawn. Sin LLM.

## Veredicto

- **CA-1 ✅**: la única invocación LLM del Pulpo es `lanzarAgenteClaude → resolveSpawnWithFallback`. Documentada arriba.
- **CA-2 ✅**: esa invocación enruta por `dispatch-with-fallback.js` y respeta `skill.fallbacks[]`. Verificado por test `dispatch-with-fallback.test.js` y `chaos-claude-down.test.js`.
- **CA-3 ✅**: intake, dispatch, transición de fases, worktree management y allowlist son Node puro. No hay llamado a LLM en el path crítico de orquestación. Verificado por inspección código + chaos test (CA-7).

## Anti-regresión

Para que un futuro PR no introduzca una invocación LLM oculta en el Pulpo:

1. Cualquier `spawn(...)` que invoque un launcher de IA debe pasar por `dispatch-with-fallback.js`.
2. Tests bloqueantes:
   - `tests/dispatch-with-fallback.test.js` — happy path + fallbacks + chain agotada.
   - `tests/chaos-claude-down.test.js` — Anthropic caído + reportExhaustion + tryResume.
3. Memoria operativa: `project_v3-efficiency-priority` (eficiencia tokens > autonomía total).

> Si necesitás auditar en otro momento, corré `grep -rn "spawn|exec|claude|llm|anthropic|openai" .pipeline/pulpo.js .pipeline/lib/` y clasificá cada hit con la tabla de arriba.
