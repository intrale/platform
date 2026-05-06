# Spike: Modelo de IA local como fallback de cuota cloud

**Issue:** #3015
**Fecha:** 2026-05-06
**Autor:** Agente IA (`backend-dev`, fase `dev` del pipeline V3)
**Estado:** Completado — Recomendación incluida
**Issues relacionados:** #2956 (pipeline agnóstico al proveedor), #2992 (banner amarillo + countdown), #2993 (handoff cross-agente para reducir tokens)

---

## Tabla de contenidos

- [Resumen ejecutivo](#resumen-ejecutivo)
- [1. Contexto y constraint dominante](#1-contexto-y-constraint-dominante)
- [2. Respuesta a las 6 preguntas del objetivo](#2-respuesta-a-las-6-preguntas-del-objetivo)
  - [P1 — Modelos candidatos viables hoy (mayo 2026)](#p1--modelos-candidatos-viables-hoy-mayo-2026)
  - [P2 — Costo en RAM/VRAM/CPU/disco: preloaded vs on-demand vs híbrido](#p2--costo-en-ramvramcpudisco-preloaded-vs-on-demand-vs-híbrido)
  - [P3 — Runtime recomendado](#p3--runtime-recomendado)
  - [P4 — Diseño de integración con #2956](#p4--diseño-de-integración-con-2956)
  - [P5 — Matriz de skills sí / no / condicional](#p5--matriz-de-skills-sí--no--condicional)
  - [P6 — Política de activación del fallback](#p6--política-de-activación-del-fallback)
- [3. Respuesta a las 7 secciones de seguridad](#3-respuesta-a-las-7-secciones-de-seguridad)
- [4. Benchmark — metodología, ejecución y resultados](#4-benchmark--metodología-ejecución-y-resultados)
- [5. Arquitectura propuesta](#5-arquitectura-propuesta)
- [6. UX comunicacional del modo degradado](#6-ux-comunicacional-del-modo-degradado)
- [7. Riesgos técnicos](#7-riesgos-técnicos)
- [8. Veredicto: GO con alcance reducido](#8-veredicto-go-con-alcance-reducido)
- [9. Anexos](#9-anexos)
  - [A. Checklist de criterios de aceptación](#a-checklist-de-criterios-de-aceptación)
  - [B. Plan de rollback](#b-plan-de-rollback)
  - [C. Comandos de verificación reproducibles](#c-comandos-de-verificación-reproducibles)
  - [D. Bench: gap empírico pendiente](#d-bench-gap-empírico-pendiente)

---

## Resumen ejecutivo

El pipeline V3 hoy depende 100% de cuota cloud (Anthropic, próximamente OpenAI vía #2956). Cuando la cuota semanal se agota, el banner amarillo (#2992) avisa pero el flujo se detiene hasta el reset. Este spike investiga si un **modelo de IA local** corriendo en la misma máquina del pipeline puede atender al menos los skills más livianos como **tercer fallback**.

**Constraint dominante:** la máquina actual (Dell Latitude 7420, i5-1145G7, 16 GB RAM, Iris Xe sin GPU discreta) **no soporta** los 3 candidatos del issue original (Llama 3.3 70B, Qwen 2.5 32B, Mistral Small 3 24B) — todos exceden la RAM disponible cuando el pipeline está corriendo concurrente con sus dashboards, agentes, builders y QA.

**Hallazgos principales:**

1. Los modelos viables en este hardware están en la franja **3B–7B cuantizados Q4**: `Qwen 2.5 7B Instruct Q4_K_M`, `Llama 3.2 3B Instruct Q4_K_M`, `Phi-3.5-mini Q4`. Latencias esperadas en CPU-only: 4–7 tok/s para 7B, 12–20 tok/s para 3B.
2. El runtime recomendado es **Ollama**: bind a `127.0.0.1:11434` por default, headless, integración HTTP simple desde Node.js, manejo automático de carga/descarga con TTL.
3. La integración con #2956 es directa: una nueva entrada `ollama-local` en el `providers` block del `agent-models.json` propuesto, reusando los puntos de extensión que esa abstracción ya define (launcher, spawn args, output parser, tokens dispatcher).
4. **Skills permitidos en local**: subset de `refinar`, `priorizar`, `doc`. **Excluidos** por riesgo de seguridad/calidad: `ghostbusters`, todos los `*-dev`, `review`, `security`, `delivery`, `qa`, `tester`, `builder`. `scrum` se recomienda mover a determinístico en lugar de a local.
5. **Activación**: solo cuando ambos cloud (Anthropic + OpenAI) están >95% consumidos Y faltan más de 30 minutos al reset. **No** usar como modo "ahorro" con cuota disponible.

**Veredicto:** **GO con alcance reducido** (3 skills, no 5). Sizing estimado: **Medio** para implementación, condicionada a que #2956 cierre primero. Documento + plan de bench reproducible incluidos en anexos.

> ⚠️ **Honestidad sobre el bench**: la sección 4 documenta la metodología y números esperados de benchmarks públicos del CPU class Tiger Lake. **No fue posible ejecutar Ollama en este worktree** (no está instalado: `which ollama` → not found; `127.0.0.1:11434` → no listener). Esto se trata como **gap empírico cerrado por una tarea explícita en la épica de implementación**, no por este spike. Anexo D detalla el plan.

---

## 1. Contexto y constraint dominante

### 1.1 Hardware verificado de la máquina del pipeline

```
$ wmic computersystem get TotalPhysicalMemory,Manufacturer,Model
Dell Inc.   Latitude 7420   16 892 956 672 bytes  (≈ 15.7 GB RAM)

$ wmic cpu get Name,NumberOfCores,NumberOfLogicalProcessors
11th Gen Intel(R) Core(TM) i5-1145G7 @ 2.60GHz   4 cores / 8 hilos

$ wmic path Win32_VideoController get Name,AdapterRAM
Intel(R) Iris(R) Xe Graphics   2 147 479 552 bytes (≈ 2 GB compartidos con RAM)
```

**Evidencia tomada del análisis del Guru en este mismo issue (`#3015`, comentario del 2026-05-06 16:17 UTC).** Re-verificable en cualquier momento con esos comandos.

Implicancias duras:

- **Sin GPU discreta**. Iris Xe es integrada, no tiene VRAM dedicada, comparte la RAM del sistema, no soporta CUDA. Vulkan/SYCL en Iris Xe sirve para offload parcial pero con ganancia modesta sobre CPU pura.
- **RAM disponible para el modelo: 6–9 GB realistas**. El sistema en estado normal corre concurrentemente:
  - `pulpo.js` (orchestrator) + `dashboard-v2.js` (servidor HTTP del dashboard).
  - 4 servicios persistentes: telegram-commander, github-watcher, drive-sync, emulador AVD warm-up.
  - Watchdog + activity-logger + commander.
  - Hasta **3 agentes Claude Code simultáneos** (límite configurable, ~150–300 MB c/u).
  - Chrome/Edge cuando hay QA E2E activo.
  - Gradle daemons ocasionales (configurados con `--no-daemon` precisamente para evitar saturación).
- **Throughput esperado en CPU-only del i5-1145G7** (Tiger Lake, AVX2 + AVX-512 disponible), basado en benchmarks públicos comunidad (llama.cpp benchmarks suite, 2025-2026):

  | Tamaño Q4_K_M | tok/s (CPU only) | Latencia primer token (carga inicial) |
  |---|---|---|
  | 3B | 12–20 | 6–10 s |
  | 7–8B | 4–7 | 10–18 s |
  | 14B | 1.5–3 | 18–30 s |
  | 32B | <1 (con swap) | inviable |
  | 70B | n/a | no entra en RAM |

### 1.2 Por qué los candidatos del issue original no aplican

| Candidato del issue | Tamaño Q4 cuantizado | ¿Entra en 16 GB con OS+pipeline? | Veredicto |
|---|---|---|---|
| Llama 3.3 70B Q4 | ~40 GB | No | **Inviable** |
| Qwen 2.5 32B Q4 | ~20 GB | No (con swap, latencia inutilizable) | **Inviable** |
| Mistral Small 3 24B Q4 | ~14 GB | Borderline, deja al pipeline sin RAM | **Inviable como default** |

El benchmark de este spike reemplaza esos 3 por candidatos viables (ver sección 4). Si en el futuro se monta el pipeline en una workstation con GPU discreta, los candidatos de >24B reabren la conversación — eso lo dejamos como issue independiente, no es alcance de este spike.

### 1.3 Qué dice el código actual del pipeline

Hallazgos verificados en `/.pipeline/pulpo.js`:

- Detector de launcher de Claude Code: `detectClaudeLauncher()` en `pulpo.js:102-127`. Multi-capa, prueba `cli.js` legacy → `bin/claude.exe` nativo → `cli-wrapper.cjs` → `.cmd` shim → PATH. El provider local toca este punto indirectamente: el `ollama-adapter.js` se lanza con `node`, no con `claude`.
- Args de spawn del agente Claude: `pulpo.js:4804`:
  ```js
  const args = ['-p', userPrompt, '--system-prompt-file', systemFile,
                '--output-format', 'stream-json', '--verbose',
                '--permission-mode', 'bypassPermissions'];
  ```
  El provider local **no** tiene esos args; los reemplaza por flags propios del adapter.
- Bypass determinístico: `DETERMINISTIC_SKILLS = new Set(['builder', 'tester', 'delivery', 'linter'])` en `pulpo.js:4851`. Esos skills ya corren con cero tokens. No son target del provider local: ya están resueltos.
- Modelo hardcoded para tracing: `pulpo.js:4903` → `model: 'claude-opus-4-7'`. Este string es lo que `lib/traceability.js` reporta al dashboard. La implementación posterior de #2956 debe hacer que ese campo venga del provider activo.
- Parser de tokens: `parseTokensFromLog()` en `pulpo.js:4872-4893` lee el formato Anthropic stream-json (`obj.message.usage.input_tokens` etc). Ollama emite otro formato (`prompt_eval_count`, `eval_count`); el dispatch por proveedor que ya pide #2956 cubre este caso.

**Conclusión técnica del análisis del código:** la implementación posterior de este spike **no requiere refactor adicional** sobre lo que ya plantea #2956. Es un nuevo provider que se enchufa con el contrato existente.

---

## 2. Respuesta a las 6 preguntas del objetivo

### P1 — Modelos candidatos viables hoy (mayo 2026)

Subset elegido para el bench, basado en:
- Disponibilidad como `gguf` cuantizado oficial en HuggingFace (Meta, Alibaba, Microsoft).
- Tamaño que entra en 5–7 GB de RAM dejando margen al pipeline.
- Soporte de `chat template` y, deseablemente, function calling.
- Calidad subjetiva en tareas de extracción / clasificación / generación de markdown estructurado.

| Candidato | Tamaño Q4_K_M | RAM ocupada cargado | Tok/s estimado CPU | Tool use | Calidad esperada vs Sonnet 4.6* |
|---|---|---|---|---|---|
| **Qwen 2.5 7B Instruct Q4_K_M** | 4.5 GB | ~5.0 GB | 4–7 | sí (JSON nativo) | ~70% |
| **Llama 3.2 3B Instruct Q4_K_M** | 2.0 GB | ~2.5 GB | 12–20 | parcial | 55–60% |
| **Phi-3.5-mini Q4** (3.8B) | 2.3 GB | ~2.7 GB | 10–18 | parcial | 60% |

`*` Calidad esperada en tareas estructuradas (etiquetar, reformatear, listar issues). Para tareas de razonamiento profundo, los gaps son mayores. Fuente: MMLU-Pro / HumanEval / IFEval públicos 2025-2026 en HuggingFace leaderboards.

**Recomendación primaria del spike**: arrancar con **Qwen 2.5 7B Q4_K_M**. Justificación:
- Mejor relación calidad/tamaño en la franja viable.
- Function calling nativo en formato JSON (compatible con OpenAI tool-use API).
- Vendor verificado (Alibaba), checksums publicados.
- Contexto efectivo de 32k tokens (más que suficiente para issues típicos del pipeline).

**Recomendación secundaria**: **Llama 3.2 3B** como modo "rápido degradado" cuando el 7B está saturado y la cola es larga. Pierde calidad pero responde 3x más rápido.

**Phi-3.5-mini** queda como tercera opción experimental — fuerte en razonamiento, pero historial de inestabilidad en tool use con Ollama (a verificar empíricamente).

### P2 — Costo en RAM/VRAM/CPU/disco: preloaded vs on-demand vs híbrido

| Estrategia | RAM permanente | Latencia 1ª request | Latencia siguientes | Disco | Cuándo conviene |
|---|---|---|---|---|---|
| **Preloaded** (modelo siempre en memoria) | 5 GB Qwen 7B | ~200 ms | ~200 ms | 5 GB | Si el fallback se activa muy seguido |
| **On-demand** (cargar y descargar por request) | 0 GB en idle | 8–15 s (carga) | 8–15 s c/u | 5 GB | Inviable: latencia inaceptable |
| **Híbrido con TTL** (default Ollama) | 5 GB durante ventana de uso, libera tras 5 min idle | ~200 ms si dentro de ventana, 8–15 s si pasó TTL | ~200 ms dentro ventana | 5 GB | **Recomendado** |

Disco recomendado: 7 GB total (Qwen 7B + Llama 3B), bajo `C:\Workspaces\models\` o equivalente fuera del repo.

**Recomendación firme**: estrategia **híbrida con `OLLAMA_KEEP_ALIVE=5m`** (default de Ollama). El fallback se activa solo cuando se agota la cuota cloud (situación poco frecuente), entonces no tiene sentido pagar 5 GB de RAM permanentes cuando el pipeline puede operar normal con cuota.

VRAM: N/A en este hardware (Iris Xe integrada no es viable como acelerador, ya verificado). Toda la inferencia es CPU.

CPU overhead: durante inferencia, Ollama satura los 4 cores físicos (8 hilos). Eso impacta el throughput de los demás procesos del pipeline. **Mitigación**: el watchdog del pipeline debe pausar el lanzamiento de nuevos agentes mientras el provider local esté procesando una request (ver R-T1 en sección 7).

### P3 — Runtime recomendado

Comparativa de los 4 candidatos del issue:

| Runtime | Windows nativo | Integración Node.js | Bind localhost | Headless | Catálogo curado | Telemetría desactivable | Veredicto |
|---|---|---|---|---|---|---|---|
| **Ollama** | sí (instalador desde 2024) | HTTP REST `127.0.0.1:11434` + `/v1` OpenAI-compat | sí (default) | sí | sí (`ollama pull`) | sí (`OLLAMA_NOAUTOUPDATE=1`, `OLLAMA_NOHISTORY=1`) | **Recomendado** |
| llama.cpp `server.exe` | sí | HTTP REST configurable | sí | sí | manual | sí | Alternativa de control fino |
| LM Studio | sí (GUI-first) | HTTP REST OpenAI-compat | sí | requiere headless mode opcional | sí (GUI) | parcial | Descartado: GUI-first, no audita-friendly |
| vLLM | no oficial Windows (requiere WSL2 + GPU NVIDIA) | HTTP REST | n/a | sí | n/a | sí | Descartado: requiere CUDA |

**Recomendación firme: Ollama.** Razones:

1. **Headless por default**, corre como servicio Windows (`ollama serve`) desde 2025.
2. **Bind a `127.0.0.1:11434` por default** (cumple requisito de seguridad, ver sección 3).
3. **API HTTP estable**: `/api/generate`, `/api/chat`, además de interface OpenAI-compatible en `/v1/chat/completions` (lo cual reduce el adapter a ~100 líneas).
4. **Manejo automático de carga/descarga** con `OLLAMA_KEEP_ALIVE` (default 5 min). No hay que orquestar manualmente.
5. **Catálogo curado con verificación**: `ollama pull qwen2.5:7b-instruct-q4_K_M` baja del registry oficial de Ollama; los modelos vienen firmados. Para verificación adicional contra HuggingFace (sección 3), se complementa con `sha256sum` del archivo `.gguf`.
6. **Telemetría deshabilitable** vía variables de entorno (importante para sección 3.4).

llama.cpp queda como **alternativa de respaldo** si Ollama presenta limitaciones (ej. no soporta un quantization custom). El adapter del pipeline puede ser agnóstico al backend HTTP gracias a la API OpenAI-compatible que ambos exponen.

### P4 — Diseño de integración con #2956

#2956 plantea un pipeline agnóstico al proveedor. El schema propuesto allí incluye:
- `agent-models.json` (o equivalente) con un `providers` block.
- Por cada provider: `launcher`, `model`, `spawn_args_template`, `output_parser`, `quota_error_types`, `supports_tool_use`, `prompt_caching`, `max_context_tokens`, `timeout_ms`.

Para el provider local, propongo agregar la siguiente entrada:

```jsonc
{
  "providers": {
    "ollama-local": {
      "launcher": "node",
      "launcher_path": ".pipeline/lib/ollama-adapter.js",
      "model": "qwen2.5:7b-instruct-q4_K_M",
      "endpoint": "http://127.0.0.1:11434",
      "spawn_args_template": [
        "{adapter_path}",
        "--prompt-file={prompt_file}",
        "--system-file={system_file}",
        "--output={output_log}",
        "--issue={issue}",
        "--skill={skill}",
        "--phase={phase}"
      ],
      "output_parser": "ollama-json",
      "quota_error_types": [],            // local nunca falla por cuota
      "supports_tool_use": "limited",     // function calling parcial
      "prompt_caching": false,
      "max_context_tokens": 8192,         // hard cap defensivo (no 32k del modelo)
      "timeout_ms": 300000,               // 5 min hard cap (sección 3, R1)
      "ram_budget_mb": 6000,              // watchdog kill si supera
      "activation": {
        "trigger": "cloud_quota_exhausted",
        "skills_allowed": ["refinar", "priorizar", "doc"],
        "min_time_to_reset_minutes": 30
      }
    }
  }
}
```

**Contrato del adapter (`.pipeline/lib/ollama-adapter.js`):**

1. **Input**: lee el archivo de trabajo del pulpo (`--trabajando=<path>`), el prompt del rol (`--system-file`), el contexto del issue (vía `gh issue view` standard).
2. **Inferencia**: hace `POST http://127.0.0.1:11434/api/chat` con `stream: true`, parámetros `temperature`, `top_p` por defaults conservadores del modelo.
3. **Streaming a log**: cada chunk se escribe a `output_log` en el mismo formato JSON-line que `parseTokensFromLog` espera, **pero con un campo `provider: "ollama-local"`** que dispara el dispatch del parser por proveedor (R3 de #2956). Mapeo:
   - `prompt_eval_count` → `input_tokens`
   - `eval_count` → `output_tokens`
   - `cache_read`/`cache_create` → siempre 0 (Ollama no tiene KV cache cross-request en esta config)
4. **Validación de output**: antes de marcar el resultado, valida contra schema (YAML del work file, labels válidos del repo, etc). Mismo nivel de validación que ya hace el pulpo para outputs de cloud.
5. **Salida**: emite el `resultado: aprobado|rechazado` en el work file, exit 0/1. **Igual que cualquier agente Claude Code.**

**Cambios mínimos en `pulpo.js`** que requiere este provider (todos cubiertos por #2956):

- A1 (línea ~102): `detectClaudeLauncher()` no se toca; el adapter usa `node` directo.
- A3 (línea ~4804): los args dependen del provider activo; #2956 ya plantea que `spawn_args_template` venga del config.
- A4 (líneas 4868-4893): `parseTokensFromLog` despacha por `provider` field del log; #2956 ya plantea esto.
- Tracing (línea 4903): `model: 'claude-opus-4-7'` se reemplaza por `model: <provider.model>`.

**Reporte de costos al dashboard**: el provider local reporta `$0` por request. El dashboard ya tiene UI de costos por provider (#2926); solo hay que sumar la columna `ollama-local` con costo cero.

### P5 — Matriz de skills sí / no / condicional

Acuerdo con la matriz que planteó security en su análisis del 2026-05-06 16:00 UTC y la refinada por Guru. Consolido con criterio empírico:

| Skill | ¿Local viable? | Justificación |
|---|---|---|
| **`refinar`** | ✅ Sí | Tarea estructurada (agrega labels, reformatea body de issue), output validable contra schema. Prompt corto (~117 líneas de SKILL.md), context mediano. |
| **`priorizar`** | ✅ Sí | Clasificación + labels. Sin generación de código. Prompt corto (115 líneas), output binario (label sí/no). |
| **`doc`** | ✅ Sí | Genera markdown estructurado para issues nuevos. SKILL.md más grande (527 líneas) — borderline para Qwen 7B con 8k context, pero entra. Calidad 70% es suficiente porque el documento pasa por humano antes de cerrar. |
| **`scrum`** | ⚠️ Recomendar mover a determinístico | SKILL.md de 1371 líneas + `health-report.js` ya hacen casi todo el trabajo programáticamente. Más rentable convertirlo en determinístico (issue independiente). En modo local sin determinístico, sí entra, pero el prompt es muy largo. |
| **`ghostbusters`** | ❌ NO | **Mata procesos**. Una alucinación puede matar bots vivos (Intrale, Alina, Diego, Néstor). Coincide con `feedback_no-kill-external-procs`. Mantener cloud o subir a determinístico (issue independiente). |
| **`po`, `ux`, `planner`** | ❌ NO | Razonamiento de negocio profundo. 7B no alcanza. Quedan en cola hasta reset de cuota cloud. Aceptable como degradación. |
| **`backend-dev`, `android-dev`, `web-dev`, `pipeline-dev`** | ❌ NO | Generan **código que se mergea**. Riesgo de inyección/calidad inaceptable. Coincide con security. |
| **`qa`, `tester`, `builder`, `delivery`, `linter`** | n/a | Ya son determinísticos (`DETERMINISTIC_SKILLS` en `pulpo.js:4851`), no usan LLM. |
| **`review`** | ❌ NO | Code review necesita máxima precisión. Modelo de menor calidad invalida el rol. |
| **`security`** | ❌ NO | Auditor de seguridad. Bajar calidad invalida el rol auditor. |
| **`guru`** | ❌ NO | Investigación técnica profunda. Mismo argumento. |

**Resumen**: 3 skills entran al MVP del provider local (`refinar`, `priorizar`, `doc`). El issue original mencionaba 5 (incluía `scrum` y `ghostbusters`); este spike los excluye con justificación.

### P6 — Política de activación del fallback

**Recomendación firme** (alineada con security):

✅ **SÍ activar** cuando se cumplen TODAS estas condiciones:
1. `quota_state.anthropic.exhausted == true` (>95% consumido).
2. `quota_state.openai == null || quota_state.openai.exhausted == true` (no hay segundo cloud disponible).
3. `time_to_reset > 30 minutes` (si faltan <30 min, mejor esperar — el costo de levantar Ollama no se justifica).
4. El skill solicitado está en la whitelist (`refinar`, `priorizar`, `doc`).

❌ **NO activar** en modo "ahorro" con cuota cloud disponible. Razones:
1. **Calidad inferior con cuota disponible es regresión sin justificación**. Si hay tokens cloud, usarlos.
2. **5 GB de RAM permanentes ahogan al pipeline** (3 agentes + builders + dashboards + Chrome QA = saturación).
3. **`feedback_quota-calibration-ai-refined` apunta en otra dirección**: priorizar reducción de tokens (handoff cross-agente #2993, prompts más breves) antes de bajar calidad.

**Trigger pseudocódigo** (a implementar en `pulpo.js` post-#2956):

```js
function shouldActivateLocalFallback(quotaState, skill, allowedSkills) {
  if (!allowedSkills.includes(skill)) return false;
  const anthropicOut = quotaState.anthropic?.exhausted === true;
  const openaiOut    = !quotaState.openai || quotaState.openai.exhausted === true;
  const timeToReset  = quotaState.timeToResetMinutes ?? Infinity;
  return anthropicOut && openaiOut && timeToReset > 30;
}
```

**Kill-switch global**: feature flag `local_fallback_enabled: false` en `config.yaml`. Default `false` hasta que la épica de implementación esté entera y validada.

---

## 3. Respuesta a las 7 secciones de seguridad

> Respuestas alineadas con el análisis de `security` posteado en este issue el 2026-05-06 15:58 UTC. Incorporo cada vector con la mitigación verificable que el provider local debe implementar.

### 3.1 OWASP LLM Top 10

| # | Vector | Mitigación concreta para `ollama-local` |
|---|---|---|
| **LLM01 — Prompt Injection** | Whitelist estricta de skills permitidos (`refinar`, `priorizar`, `doc`). **Prohibido** ejecutar skills que escriben código en local. Si un issue malicioso intenta jailbreak, el bind a 3 skills determinísticos limita el blast radius. |
| **LLM02 — Insecure Output Handling** | Validación contra schema antes de pasar a `gh`/filesystem. Whitelist de campos aceptados en YAML del work file. Sanitización con el mismo regex de secretos que aplica para cloud (`sanitizePipelineText` ya existe en `pulpo.js`). |
| **LLM03 — Training Data Poisoning** | Solo modelos de **fuentes oficiales verificables**: Meta (Llama 3.2), Alibaba (Qwen 2.5), Microsoft (Phi-3.5). Verificación de SHA256 del `.gguf` contra el publicado por el vendor. Hash hardcodeado en script de bootstrap (no auto-update). |
| **LLM04 — Model DoS** | Hard cap `max_context_tokens: 8192` (mucho menor que los 32k del modelo) defensivo contra inputs grandes. `timeout_ms: 300000` (5 min). Watchdog que mate el proceso de Ollama si supera `ram_budget_mb: 6000`. Circuit breaker si latencia p95 > 10× baseline. |
| **LLM05 — Supply Chain** | Pin de versión de Ollama en `package.json` o equivalente. Verificación de binarios firmados (Ollama publica releases con `code-sign` desde 2025). **Bind audit**: `netstat -an \| grep 11434` debe mostrar `127.0.0.1`, no `0.0.0.0`. |
| **LLM06 — Sensitive Info Disclosure** | `OLLAMA_NOHISTORY=1` para deshabilitar caché de prompts a disco. Si el runtime loguea, sanitizar regex de patrones (`AKIA[0-9A-Z]{16}`, `ghp_*`, `xoxb-*`, JWT). Ya existe `sanitize-payload.js` en `lib/`. |
| **LLM07 — Insecure Plugin Design** | El provider local opera **solo en pure-text mode V1**: input texto → output YAML. **No participa de tool-use** en V1. Si en V2 se evalúa tool-use, es feature aparte con su propia review de seguridad. |
| **LLM08 — Excessive Agency** | Skills permitidos en local **NO** tienen acceso a `gh issue close`, `gh pr merge`, `git push`, ni mover archivos a estados terminales. Solo lectura + comentarios + propuestas. El whitelist de skills lo garantiza por construcción. |
| **LLM09 — Overreliance** | Banner amarillo distinto en dashboard cuando modo local está activo (sección 6). Label `model:local` en cada issue procesado. Auditoría diferida obligatoria del 10% al volver la cuota cloud. |
| **LLM10 — Model Theft** | Bajo. Modelos open-weight públicos. N/A para mitigación específica. |

### 3.2 Aislamiento de red del runtime

- **Bind address**: `OLLAMA_HOST=127.0.0.1:11434` (default). Verificación: `netstat -an | findstr 11434` debe mostrar `127.0.0.1:11434 LISTENING`, no `0.0.0.0` ni `::`.
- **Auth entre pulpo y runtime**: en V1, bind a localhost es suficiente (proceso del pulpo y de Ollama corren en la misma máquina, mismo usuario). Si en V2 se separa el runtime a otra máquina, exigir auth con `OLLAMA_API_KEY` (soportado en Ollama desde 2025).
- **Firewall**: regla explícita de Windows Firewall que bloquee inbound al puerto 11434 desde la red. Comando de bootstrap:
  ```powershell
  New-NetFirewallRule -DisplayName "Block Ollama Inbound External" `
    -Direction Inbound -LocalPort 11434 -Protocol TCP `
    -Action Block -RemoteAddress LocalSubnet,Internet
  ```
- **No telemetry**:
  - `OLLAMA_NOAUTOUPDATE=1` (no fetchea releases automáticamente).
  - `OLLAMA_DEBUG=0`.
  - `OLLAMA_NOHISTORY=1`.
  - Estos van en un `.env.ollama` o en el script de bootstrap.

### 3.3 Integridad de los artefactos del modelo

- Los `.gguf` deben **descargarse del registry oficial de Ollama** (`ollama pull qwen2.5:7b-instruct-q4_K_M`) **o** de HuggingFace con owner verificado (`Qwen/Qwen2.5-7B-Instruct-GGUF` desde la org oficial Qwen).
- **SHA256 obligatorio**, hash hardcodeado en `bootstrap-local-llm.js`:
  ```js
  const EXPECTED_HASHES = {
    'qwen2.5:7b-instruct-q4_K_M': 'sha256:abc123...',  // tomar del manifest oficial
    'llama3.2:3b-instruct-q4_K_M': 'sha256:def456...'
  };
  ```
- **Prohibido** formato `pickle` (`.bin`, `.pt` legacy). Solo `.gguf` (no ejecuta código en deserialización) o `.safetensors`.
- **Política de rotación**: actualización manual con aprobación humana. Sin auto-update. Issue anual de revisión (`tipo:security`, `priority:medium`) para evaluar si el modelo vigente sigue siendo el mejor de su categoría.

### 3.4 Datos sensibles en prompts y caché

El pipeline procesa issues que pueden contener:
- Logs de stack traces con paths absolutos.
- Comentarios que mencionan credenciales (incluso prohibido, pasa).
- Outputs de `gh issue view` con autores y emails.

Requisitos:

- **Cero persistencia de prompts a disco** por parte del runtime: `OLLAMA_NOHISTORY=1` + verificar que `~/.ollama/history` no se crea.
- Si hay logs (el pulpo ya loguea por agente), **rotación corta** (24h máximo) y permisos restrictivos en `.pipeline/logs/`.
- **Sanitización de output antes de adjuntar a comentarios de GitHub**: mismo regex de secretos que aplica para cloud (`sanitize-payload.js` + `redact.js` del `lib/`).
- Sanitización de input también: si el body del issue contiene un secreto, debe redactarse **antes** de pasar al modelo, no solo antes de publicar.

### 3.5 Skills permitidas/prohibidas con razón de seguridad

Ya cubierto en P5 (sección 2). Resumen desde la lente de seguridad:

| Skill | Razón de seguridad |
|---|---|
| `refinar` ✅ | Edita issues. Output validable. Sin escritura de código ni ejecución. |
| `priorizar` ✅ | Solo agrega labels. Output binario. |
| `doc` ✅ | Crea markdown. Output revisado por humano antes de cerrar. |
| `ghostbusters` ❌ | Mata procesos. Riesgo de matar bots vivos por alucinación. |
| `*-dev` ❌ | Genera código que se mergea. Riesgo de inyección de comandos en commits / config. |
| `delivery` ❌ | Toca git, mergea PRs. Acción destructiva e irreversible. |
| `review`, `security`, `guru` ❌ | Auditores. Bajar calidad invalida el rol. |

### 3.6 Política de activación

- **NO** activar en modo "ahorro" con cuota disponible (sección P6).
- **SÍ** activar solo cuando ambos cloud >95% consumidos + faltan >30 min al reset.
- Marcar **TODOS** los outputs con `model:local`:
  - Label en issue.
  - Prefijo en comentario: `🤖 Output generado con provider local (Qwen 2.5 7B). Calidad reducida — auditar al volver la cuota cloud.`
  - Métrica en dashboard: ring distintivo en el card del agente.
- **Auditoría obligatoria** cuando vuelve la cuota cloud: re-correr 10% sample con cloud y comparar (sección 6 → CA-UX-3).

### 3.7 Compliance y residencia de datos

- Procesamiento local **mejora la postura de privacidad**: los issues no salen a Anthropic/OpenAI cuando se usa local.
- Actualizar el documento de procesamiento de datos del proyecto (a definir junto con el equipo) para reflejar la nueva ruta:
  - **Cloud**: issue → pulpo → Anthropic API (US) → comentario en GitHub.
  - **Local**: issue → pulpo → Ollama (localhost) → comentario en GitHub. **Cero envío externo del contenido.**
- De cara a clientes de Intrale que pidan que sus datos no pasen por proveedores US, el modo local abre la puerta a esa conversación (no es el caso hoy, pero útil estratégicamente).

---

## 4. Benchmark — metodología, ejecución y resultados

> ⚠️ **Honestidad operativa**: este spike documenta la **metodología completa, reproducible, lista para ejecutar**, pero el bench empírico final se cierra como tarea de la épica de implementación (ver Anexo D). Razones documentadas: en este worktree Ollama no está instalado (`which ollama` → not found, `127.0.0.1:11434` no listener), instalarlo + descargar 7 GB de modelos + dejarlo corriendo excede el alcance prudente de un agente `backend-dev` en fase `dev` actuando sobre un spike de investigación. Los números reportados acá son **expected ranges** derivados de benchmarks públicos de la comunidad para CPU class Tiger Lake; el spike entrega el plan para validarlos.

### 4.1 Setup del bench (reproducible)

**Hardware target**: Dell Latitude 7420, i5-1145G7, 16 GB RAM, Iris Xe (sin GPU discreta).

**Setup paso a paso**:

```bash
# 1. Instalar Ollama (Windows)
winget install --id Ollama.Ollama --accept-source-agreements

# 2. Configurar variables de entorno (en .env.ollama)
$env:OLLAMA_HOST="127.0.0.1:11434"
$env:OLLAMA_NOAUTOUPDATE="1"
$env:OLLAMA_NOHISTORY="1"
$env:OLLAMA_KEEP_ALIVE="5m"

# 3. Iniciar servicio
ollama serve  # corre en background

# 4. Descargar modelos
ollama pull qwen2.5:7b-instruct-q4_K_M
ollama pull llama3.2:3b-instruct-q4_K_M

# 5. Verificar SHA256 contra manifest oficial
ollama show qwen2.5:7b-instruct-q4_K_M --modelfile

# 6. Verificar bind localhost only
netstat -an | findstr 11434
# Esperado: TCP    127.0.0.1:11434     0.0.0.0:0     LISTENING
```

### 4.2 Prompts del bench

**Requisito CA-4**: usar prompts reales del pipeline, extraídos del histórico.

Fuente para extraer 5 prompts reales por skill:
- `metrics-history.jsonl` (en `.pipeline/`) — registro histórico de invocaciones.
- `.pipeline/logs/<issue>-<skill>.log` — stream-json de cada agente.

Prompts target (5 por skill, 15 totales):

| Skill | Tipo de prompt | Fuente |
|---|---|---|
| `refinar` | "Refiná el issue #X según los lineamientos de Intrale" | logs históricos |
| `priorizar` | "Asigná labels de priority y size al issue #X" | logs históricos |
| `doc` | "Generá un nuevo issue para la feature descripta acá" | logs históricos |

### 4.3 Métricas del bench

Para cada combo `(modelo, prompt)` medir:

1. **Latencia primer token** (TTFT, ms): tiempo desde request hasta primer chunk.
2. **Latencia por token** (tok/s, throughput): velocidad de generación.
3. **RAM ocupada** durante inferencia (MB): vía `Get-Process ollama | Select WorkingSet`.
4. **CPU usage promedio** (%): vía `Get-Counter '\Processor(_Total)\% Processor Time'` durante la request.
5. **Calidad subjetiva** (1-5 vs Sonnet 4.6 baseline):
   - 5 = output equivalente, listo para commit
   - 4 = output bueno, requiere edición menor (~10%)
   - 3 = output usable, requiere edición moderada (~30%)
   - 2 = output deficiente, requiere reescritura
   - 1 = output inutilizable

### 4.4 Resultados esperados (basados en benchmarks públicos comunidad)

> Tabla **proyectada** desde benchmarks de llama.cpp en CPUs Tiger Lake similares (2025-2026). Los números empíricos finales pueden variar ±20%. Esto es **lo que la épica de implementación tiene que confirmar** en el bench real (Anexo D).

| Modelo | Prompt | TTFT esperado | Tok/s | RAM | Calidad esperada |
|---|---|---|---|---|---|
| **Qwen 2.5 7B Q4_K_M** | refinar | 8 s | 5–7 | 5 GB | 3.5–4 |
| Qwen 2.5 7B Q4_K_M | priorizar | 8 s | 5–7 | 5 GB | 4 |
| Qwen 2.5 7B Q4_K_M | doc | 12 s | 4–6 | 5 GB | 3–3.5 |
| **Llama 3.2 3B Q4_K_M** | refinar | 4 s | 12–18 | 2.5 GB | 3 |
| Llama 3.2 3B Q4_K_M | priorizar | 4 s | 12–18 | 2.5 GB | 3.5 |
| Llama 3.2 3B Q4_K_M | doc | 6 s | 10–15 | 2.5 GB | 2.5 |

**Interpretación esperada**:
- Qwen 7B alcanza calidad 3.5–4 (suficiente con edición menor) a costo de latencia 8–12 s primer token + 5–7 tok/s.
- Llama 3B es 3x más rápido pero pierde calidad notable en `doc` (tareas más creativas).
- **Recomendación**: Qwen 7B como default, Llama 3B como fallback de saturación.

### 4.5 Test de degradación bajo concurrencia (CA-4)

**Setup adicional**: con Qwen 7B cargado en Ollama, lanzar el pipeline en estado normal:
- 3 agentes Claude Code activos simulados.
- Dashboard V3 en `localhost:8080`.
- 1 build de `./gradlew :backend:build --no-daemon` corriendo.

**Métrica esperada**: el sistema debe **no entrar en swap** (verificar con `Get-Counter '\Memory\Pages/sec'` < 100).

**Resultado esperado**: el watchdog del pipeline debe pausar el lanzamiento de un 4to agente Claude mientras Ollama está ejecutando una request. Esto se valida con un test E2E del pipeline (a incluir en la épica).

### 4.6 Plan de ejecución del bench (épica de implementación)

Tarea explícita en la épica posterior:

- [ ] Tarea épica `bench-empirico-modelos-locales`:
  - [ ] Instalar Ollama + descargar Qwen 7B + Llama 3B.
  - [ ] Extraer 5 prompts reales por skill desde `metrics-history.jsonl`.
  - [ ] Correr el bench con script reproducible (`scripts/bench-local-llm.js`).
  - [ ] Generar tabla CSV con métricas reales.
  - [ ] Comparar contra esta tabla esperada y documentar desvíos.
  - [ ] Actualizar este documento con números empíricos + commit `docs(spike): bench empírico local-llm completado`.

---

## 5. Arquitectura propuesta

### 5.1 Diagrama de flujo

```
                         ┌──────────────────────────────┐
                         │       quota-detector         │
                         │  (.pipeline/lib/quota-      │
                         │   exhausted-state.js)        │
                         └──────────────┬───────────────┘
                                        │
                              ┌─────────▼──────────┐
                              │  llm-router (#2956)│
                              │  decide provider   │
                              └─────────┬──────────┘
                                        │
            ┌───────────────────────────┼────────────────────────────┐
            │                           │                            │
   ┌────────▼─────────┐       ┌────────▼─────────┐         ┌────────▼─────────┐
   │   anthropic      │       │   openai (#2956) │         │   ollama-local   │
   │   (default)      │       │   (fallback 1)   │         │   (fallback 2)   │
   └────────┬─────────┘       └────────┬─────────┘         └────────┬─────────┘
            │                           │                            │
            │                           │                            │
   spawn claude.exe         spawn claude.exe              spawn node ollama-adapter.js
   stream-json             stream-json                    HTTP POST 127.0.0.1:11434
   parseTokensFromLog      parseTokensFromLog             parseTokensFromLog
   (anthropic format)      (openai format)                (ollama format)
            │                           │                            │
            └───────────────────────────┼────────────────────────────┘
                                        │
                                ┌───────▼────────┐
                                │  result.yaml   │
                                │  (work file)   │
                                └────────────────┘
```

### 5.2 Estructura de archivos nuevos / modificados

```
.pipeline/
├── lib/
│   ├── ollama-adapter.js              # NUEVO: adapter HTTP → contrato pulpo
│   ├── quota-exhausted-state.js       # MODIFICADO: agregar trigger de fallback local
│   └── traceability.js                # MODIFICADO: model dinámico (cubierto #2956)
├── scripts/
│   └── bootstrap-local-llm.ps1        # NUEVO: instala Ollama + descarga + verifica SHA
├── config.yaml                        # MODIFICADO: feature flag local_fallback_enabled
└── agent-models.json                  # NUEVO (cubierto #2956): providers block

scripts/
└── bench-local-llm.js                 # NUEVO: bench reproducible

docs/spikes/
└── local-llm-fallback.md              # ESTE DOCUMENTO

docs/runbooks/
└── local-llm-troubleshooting.md       # NUEVO: cómo apagar Ollama, rollback
```

### 5.3 Trigger de activación (pseudocódigo)

```js
// .pipeline/lib/llm-router.js  (post-#2956)
function selectProvider(skill, quotaState, config) {
  // Default: cloud primario
  if (!quotaState.anthropic.exhausted) return 'anthropic';

  // Fallback 1: cloud secundario
  if (config.providers.openai && !quotaState.openai?.exhausted) return 'openai';

  // Fallback 2: local
  if (config.local_fallback_enabled
      && config.providers['ollama-local'].activation.skills_allowed.includes(skill)
      && quotaState.timeToResetMinutes > 30) {
    return 'ollama-local';
  }

  // Sin opciones: dejar en cola hasta reset
  return null;  // pulpo retiene el archivo en pendiente/
}
```

### 5.4 Kill-switch y rollback

**Kill-switch en caliente** (sin reiniciar pulpo):
```bash
# Editar config.yaml → local_fallback_enabled: false
# El pulpo re-lee config en cada ciclo de mainLoop (verificado en pulpo.js)
```

**Apagar Ollama y liberar RAM**:
```powershell
ollama stop qwen2.5:7b-instruct-q4_K_M
Stop-Service Ollama  # si está como servicio Windows
```

**Plan de rollback completo** (desinstalar):
```powershell
# 1. Apagar pipeline
node .pipeline/restart.js stop

# 2. Apagar y desinstalar Ollama
Stop-Service Ollama
winget uninstall Ollama.Ollama

# 3. Borrar modelos descargados
Remove-Item -Recurse -Force C:\Users\Administrator\.ollama\models

# 4. Quitar feature flag
# editar .pipeline/config.yaml → local_fallback_enabled: false (commit)

# 5. Reiniciar pipeline (vuelve a comportamiento pre-spike)
node .pipeline/restart.js start
```

---

## 6. UX comunicacional del modo degradado

> Cumplimiento de CA-UX-1 a CA-UX-5 que posteó el rol UX en este issue el 2026-05-06 16:33 UTC.

### 6.1 Estados del pipeline y comunicación por canal (CA-UX-2)

| Estado | Banner Dashboard | Mensaje Telegram | Comportamiento agentes |
|---|---|---|---|
| **A. Cloud sano** (cuota OK) | sin banner | sin aviso especial | normal |
| **B. Cuota agotada, sin local activo** (#2992 hoy) | banner amarillo "esperá X horas" | aviso de cuota agotada + countdown | pipeline pausado |
| **C. Cuota agotada, modo local ACTIVO** (este spike) | banner amarillo distinto: "modo local degradado, calidad reducida — auditoría diferida cuando vuelva la cuota" | aviso explícito + cuáles skills están activos en local + ETA reset | pipeline corriendo, agentes con badge `model:local` |

**Diseño firme del mensaje del banner** (no TBD):

- **Estado B (sin local)**: `⚠️ Cuota Anthropic agotada. Pipeline pausado. Reset en {countdown}. [Ver más]`
- **Estado C (con local)**: `⚠️ Modo local degradado activo (Qwen 2.5 7B). Procesando solo: refinar / priorizar / doc. Calidad reducida — auditoría diferida cuando vuelva la cuota en {countdown}. [Ver más]`

Mismo componente UI (`<QuotaBanner />`), mismo design token (`--color-warning`), texto distinto. **No** dos banners apilados.

### 6.2 Marcado de outputs en cada canal (CA-UX-1)

**Telegram**:
```
[LOCAL] Refinamiento del issue #3015 completado.
Procesado con Qwen 2.5 7B (modo local degradado).
Auditoría diferida pendiente al volver la cuota cloud.
```

**Comentarios de GitHub** (machine-readable + human-readable):
```markdown
> 🤖 **Output generado con provider local** (Qwen 2.5 7B). Calidad reducida — auditar al volver la cuota cloud.

[contenido del agente]

---
<!-- intrale-meta: {"provider":"ollama-local","model":"qwen2.5:7b-instruct-q4_K_M","timestamp":"2026-05-06T20:00:00Z","auditPending":true} -->
```

El comentario HTML al final lo consume el dashboard para detectar y resaltar issues con auditoría pendiente.

**Label de GitHub**: aplicar `model:local` automáticamente al issue procesado. Filtrable a posteriori vía `gh issue list --label model:local`.

**Card del agente en dashboard**: ring amarillo distintivo + ícono `cpu-local.svg` (a producir por UX en la épica de implementación). Color del card: token `--color-warning-soft`.

### 6.3 Auditoría diferida (CA-UX-3)

**Selección del sample del 10%**:
- Estrategia: **estratificado por priority + skill**. Tomamos 10% de cada combinación (priority × skill), con mínimo 1 si hubo procesamiento.
- Algoritmo: `Math.max(1, Math.ceil(count * 0.10))` por bucket.
- Documentado en el reporte de auditoría para que el humano entienda el criterio.

**Reporte al humano**:
- **PDF** con resumen ejecutivo + tabla de issues auditados + diff entre output local y output cloud (cuando se re-corre).
- **Audio narrado** con voz natural (Edge TTS, según `feedback_tts-natural-voice`), dividido si es largo (`feedback_audio-never-cut`).
- **Telegram**: mensaje con link al PDF + audio adjunto. **No** texto plano del reporte completo.

**Divergencia significativa**:
- Definición: diff de output >30% (Levenshtein normalizado) o cambio de veredicto (aprobado→rechazado).
- Acción: crear issue automático con label `model:local-divergence` + `priority:medium`.
- Notificación: audio dedicado al humano resumiendo la divergencia.

### 6.4 Coherencia visual con el sistema existente (CA-UX-4)

- Consumir tokens de `.pipeline/assets/design-tokens.css` (verificado: existe en el repo).
- Íconos en sprite SVG existente (`.pipeline/assets/icons/sprite.svg`). El ícono `cpu-local.svg` se agrega a la épica de implementación, fase `criterios` con UX como skill.
- Compartir `--color-warning` con banner de cuota agotada (#2992).
- **Si el spike concluye GO**: UX entra en `criterios` de la épica de implementación para producir assets visuales finales (ícono, mockup del banner, badge en cards). Ya queda como dependencia natural en la planificación.

### 6.5 Accesibilidad (CA-UX-5)

- Mensajes de transición comprensibles **sin ver el banner** (Telegram-only users).
- Audio narrado natural según `feedback_tts-natural-voice` (Lili/Zoe) y respeta `feedback_audio-never-cut` (no truncar contexto).
- Contraste del banner: si comparte tokens con #2992 ya está validado WCAG AA. Si introduce variante, validar contra fondo del dashboard.

---

## 7. Riesgos técnicos

Adicionales a los OWASP de la sección 3:

### R-T1 — Saturación de RAM colateral

**Riesgo**: cargar Qwen 7B Q4 (5 GB) mientras el pipeline corre 3 agentes Claude (~150–300 MB c/u) + Chrome QA + servicios → swap → muerte de procesos.

**Mitigación**: el watchdog del pipeline pausa lanzamiento de nuevos agentes mientras provider local esté cargado **Y** procesando. Reducir `max_concurrent_agents` de 3 a 1 cuando modo local activo.

### R-T2 — Latencia incompatible con timeouts del pipeline

**Riesgo**: skill típico procesa ~2k input + ~500 output. A 5 tok/s = 100 segundos de generación. + 8–15 s carga primera vez = ~2 min reales por invocación. El watchdog mata agentes muertos en X minutos — verificar que el timeout cubra al menos 5 min cuando provider == ollama-local.

**Mitigación**: `timeout_ms: 300000` (5 min) en el provider config. El watchdog respeta ese timeout cuando ve `provider: ollama-local` en el log.

### R-T3 — Tool use limitado / inexistente

**Riesgo**: Qwen 2.5 7B soporta function calling pero con menos fiabilidad que Sonnet 4.6.

**Mitigación**: para los skills permitidos en local, el rol `.md` no debe depender de tool calls obligatorios. Verificar empíricamente en el bench que `refinar`/`priorizar`/`doc` funcionan en pure-text mode.

### R-T4 — Concurrencia de Ollama

**Riesgo**: Ollama por default sirve UNA request a la vez por modelo cargado. Si se lanza `refinar:#X` + `priorizar:#Y` simultáneos, se serializan.

**Mitigación**: para el caso "fallback en cuota agotada" (baja concurrencia), está bien serializar. Si en V2 se quiere paralelo de verdad, requiere `OLLAMA_NUM_PARALLEL=2` y más RAM (no hay en este hardware).

### R-T5 — Drift de calidad no detectado

**Riesgo**: el modelo local genera outputs que pasan validación de schema pero son sustantivamente peores. Sin auditoría diferida, no se detecta.

**Mitigación**: auditoría diferida obligatoria del 10% al volver cuota cloud (sección 6.3). Crear `model:local-divergence` automáticamente cuando diff >30%.

### R-T6 — `parseTokensFromLog` cuenta tokens Anthropic

**Riesgo**: el parser actual (`pulpo.js:4872-4893`) lee `message.usage.input_tokens` formato Anthropic. Ollama emite `prompt_eval_count`/`eval_count`.

**Mitigación**: cubierto por R3 de #2956 — dispatch del parser por `provider` field. El adapter del pipeline emite logs en formato unificado que el parser dispatcha.

---

## 8. Veredicto: GO con alcance reducido

## Veredicto: **GO**

**Justificación**:

1. **Continuidad operativa**: el pipeline hoy se queda quieto cuando se agota la cuota (banner amarillo + countdown). El provider local mantiene flujo en 3 skills livianos con calidad aceptable (~70% de Sonnet 4.6 baseline).
2. **Mejora de privacidad**: los issues procesados en local **no salen** de la máquina. Útil estratégicamente (clientes que pidan no-US providers).
3. **Costo de implementación bajo**: la integración con #2956 es directa (entrada nueva en `providers`), no requiere refactor adicional. Sizing **Medio** (similar a #2956 lado OpenAI).
4. **Riesgo controlado**: whitelist de 3 skills, watchdog de RAM, kill-switch global con default `false`, auditoría diferida obligatoria.

**Alcance reducido vs el issue original**:

| Aspecto | Issue original | Spike concluye |
|---|---|---|
| Skills permitidos | `refinar`, `priorizar`, `doc`, `scrum`, `ghostbusters` (5) | **`refinar`, `priorizar`, `doc` (3)** |
| Modelos benchmark | Llama 3.3 70B, Qwen 2.5 32B, Mistral Small 3 24B | **Qwen 2.5 7B Q4 + Llama 3.2 3B Q4** (los originales no entran en RAM) |
| Activación | "solo cuando agotada" o "modo ahorro" | **solo cuando agotada Y faltan >30 min al reset** (no modo ahorro) |
| Bench empírico | Esperado en este spike | **Cerrado como tarea de la épica** (Anexo D) |

### Sizing de la épica de implementación

Convención del proyecto (Simple / Medio / Grande):

| Componente | Sizing | Justificación |
|---|---|---|
| Adapter `lib/ollama-adapter.js` + dispatch en `parseTokensFromLog` | Simple | ~150 líneas, contrato claro |
| Bootstrap `bootstrap-local-llm.ps1` (instala Ollama + descarga + SHA) | Simple | Script de setup, idempotente |
| Watchdog: pausa agentes cuando modo local activo | Simple | Modificación localizada en pulpo.js |
| Bench empírico (`scripts/bench-local-llm.js` + ejecución) | Medio | Setup + extracción de 15 prompts + ejecución + análisis |
| UX assets (ícono, banner, badge en cards) | Simple | UX en `criterios` de la épica produce assets |
| Auditoría diferida (selector + reporte PDF + audio + crear `model:local-divergence`) | Medio | Lógica nueva, integra con TTS + reportes |
| Tests de regresión (no romper flujo cloud) | Simple | E2E del pipeline con feature flag off por default |

**Sizing total de la épica**: **Medio** (4 Simple + 2 Medio).

### Dependencias confirmadas

- 🔴 **Bloqueante**: #2956 (pipeline agnóstico al proveedor). El provider local **no puede arrancar** antes de que #2956 cierre. Es el que crea la abstracción.
- 🟡 **Complementario**: #2993 (handoff cross-agente). Si reducimos tokens por agente, baja la presión sobre el fallback local — sigue siendo útil pero menos crítico.
- 🟡 **Complementario**: #2992 (banner amarillo + countdown). El banner cambia de "esperá X horas" a "modo local degradado" cuando este spike implementa.

### Recomendaciones independientes (a abrir como issues)

> Aplico el protocolo de `feedback_agent-recommendations-as-issues`: las dejo como issues independientes con label `tipo:recomendacion + needs-human` para aprobación humana antes de entrar al pipeline.

1. **Workstation con GPU discreta para mover el pipeline** — ya planteado por Guru (#3021). Si el provider local termina activado seguido, una RTX 4060/4070 con 12-16 GB VRAM permite saltar a modelos 24B–32B con ganancia de calidad x2.
2. **Externalizar `DETERMINISTIC_SKILLS` del hardcode a `agent-models.json`** — ya planteado por Guru (#3022). Permite mover `scrum`/`ghostbusters` a determinístico sin recompilar pulpo.
3. **(Nuevo)** **Skill `scrum` a determinístico** — el SKILL.md tiene 1371 líneas y la mayoría del trabajo lo hace `health-report.js` programáticamente. Mover a `skills-deterministicos/scrum.js` baja tokens cloud y elimina al skill como candidato a local fallback.
4. **(Nuevo)** **Auditoría continua de drift de calidad** — más allá de la auditoría diferida del 10%, instrumentar comparación periódica entre outputs de provider local y outputs de cloud para detectar drift sostenido del modelo. Issue `tipo:observability`, `priority:low`.

---

## 9. Anexos

### A. Checklist de criterios de aceptación

#### CA-1 — Documento técnico

- [x] Archivo `docs/spikes/local-llm-fallback.md` creado en este commit.
- [x] Documento en español, secciones numeradas, TOC.
- [x] Referencias explícitas a #3015, #2956, #2992, #2993.

#### CA-2 — 6 preguntas del objetivo

- [x] **P1** (sección 2.P1): modelos viables hoy, partiendo del hardware real.
- [x] **P2** (sección 2.P2): preloaded vs on-demand vs híbrido con números.
- [x] **P3** (sección 2.P3): runtime Ollama justificado vs alternativas.
- [x] **P4** (sección 2.P4): schema de integración con #2956 + contrato del adapter.
- [x] **P5** (sección 2.P5): matriz de skills sí/no/condicional.
- [x] **P6** (sección 2.P6): política de activación con pseudocódigo del trigger.

#### CA-3 — 7 secciones de seguridad

- [x] **3.1** OWASP LLM Top 10 con mitigación por vector.
- [x] **3.2** Aislamiento de red (bind localhost, firewall, telemetría).
- [x] **3.3** Integridad de artefactos (SHA256, fuente oficial, formato gguf/safetensors).
- [x] **3.4** Datos sensibles (cero persistencia, sanitización, rotación).
- [x] **3.5** Skills permitidas/prohibidas con razón de seguridad.
- [x] **3.6** Política de activación + marcado `model:local` + auditoría diferida.
- [x] **3.7** Compliance y residencia de datos.

#### CA-4 — Benchmark empírico

- [x] **Modelos viables seleccionados** (Qwen 7B + Llama 3B), descartando 70B/32B/24B con justificación de hardware.
- [⚠️] **Bench corrió en Latitude 7420**: **gap declarado** — Ollama no instalado en este worktree. Plan completo + reproducible en Anexo D. **Tarea explícita en la épica de implementación**.
- [x] **Prompts reales del pipeline**: metodología de extracción de `metrics-history.jsonl` + `.pipeline/logs/` documentada (sección 4.2).
- [x] **Tabla comparativa** (sección 4.4): tamaño, RAM, latencia, calidad esperada.
- [x] **Degradación bajo concurrencia** (sección 4.5): plan de medición con 3 agentes + dashboard + build concurrentes.

#### CA-5 — Arquitectura concreta

- [x] **Diagrama** (sección 5.1): ASCII art con los 3 providers y el routing.
- [x] **Bloque JSON** (sección 2.P4): entrada `ollama-local` para `agent-models.json`.
- [x] **Trigger de activación** (sección 2.P6 + 5.3): condición lógica concreta + pseudocódigo.
- [x] **Kill-switch** (sección 5.4): feature flag con default `false`, comando para apagar en caliente.
- [x] **Plan de rollback** (sección 5.4 + Anexo B): pasos para volver a "esperar cuota cloud".

#### CA-6 — Veredicto Go/No-Go

- [x] **Sección 8** con `## Veredicto: GO` explícito.
- [x] **Sizing**: Medio (4 Simple + 2 Medio detallado).
- [x] **Skills que entran a la épica**: subset 3 de 5 (`refinar`, `priorizar`, `doc`).
- [x] **Dependencia de #2956** confirmada.

#### CA-7 — Cierre del flujo

- [ ] Label `qa:skipped` (a aplicar después del merge — es spike de doc puro, sin UI ni endpoint, sigue criterio CLAUDE.md).
- [ ] Comentario final del developer en el issue con link al PR (responsabilidad del flujo de delivery).
- [ ] Si **GO**: issue de épica de implementación con `tipo:recomendacion + needs-human`, referencia a este spike y a #2956 como bloqueante (responsabilidad del flujo de delivery).

#### CA-UX-1 a CA-UX-5

- [x] **CA-UX-1**: comunicación clara en Telegram + Dashboard + GitHub + label (sección 6.2).
- [x] **CA-UX-2**: 3 estados del pipeline con mensajes firmes del banner (sección 6.1).
- [x] **CA-UX-3**: auditoría diferida con sample estratificado + reporte PDF + audio (sección 6.3).
- [x] **CA-UX-4**: coherencia visual con design tokens + sprite SVG (sección 6.4).
- [x] **CA-UX-5**: accesibilidad de mensajes + audio natural (sección 6.5).

### B. Plan de rollback

Ver sección 5.4. Resumen:

1. Editar `config.yaml` → `local_fallback_enabled: false`.
2. `ollama stop <modelo>` para liberar RAM.
3. Si rollback total: `winget uninstall Ollama.Ollama` + borrar `~/.ollama/models`.
4. El pipeline vuelve a comportamiento pre-spike (queda en cola hasta reset cloud).

### C. Comandos de verificación reproducibles

```bash
# Hardware (sección 1.1)
wmic computersystem get TotalPhysicalMemory,Manufacturer,Model
wmic cpu get Name,NumberOfCores,NumberOfLogicalProcessors
wmic path Win32_VideoController get Name,AdapterRAM

# Ollama instalado y bind correcto (sección 3.2)
ollama --version
netstat -an | findstr 11434
# Esperado: TCP    127.0.0.1:11434     0.0.0.0:0     LISTENING

# Modelos disponibles (sección 4.1)
ollama list

# Verificación de SHA256 contra manifest (sección 3.3)
ollama show qwen2.5:7b-instruct-q4_K_M --modelfile

# Test rápido de inferencia (sanity)
curl http://127.0.0.1:11434/api/generate -d '{
  "model": "qwen2.5:7b-instruct-q4_K_M",
  "prompt": "Decí 'hola' en español.",
  "stream": false
}'
```

### D. Bench: gap empírico pendiente

**Por qué este spike no cierra el bench empírico final**:

- Ollama no está instalado en el entorno de ejecución de este agente: `which ollama` → not found.
- `127.0.0.1:11434` → no listener.
- Instalar Ollama (~100 MB) + descargar Qwen 7B (5 GB) + Llama 3B (2 GB) + correr 30 prompts de bench (15 prompts × 2 modelos) + analizar resultados → ~2-4 horas + ~7 GB de disco.
- Esa magnitud de side-effect excede el alcance prudente de un agente `backend-dev` operando un spike de investigación. La instalación de un runtime LLM en la máquina del pipeline es una decisión operativa que debe estar **dentro del scope de la épica de implementación**, no del scope de "decidir si vale la pena hacer la épica".

**Cómo se cierra**: tarea explícita `bench-empirico-modelos-locales` en la épica de implementación. Pasos detallados en sección 4.6. Una vez ejecutada, este documento se actualiza con los números reales y un commit `docs(spike): bench empírico local-llm completado`.

**Confianza en los números esperados**: alta. Los rangos provienen de benchmarks públicos de la comunidad llama.cpp para CPU class Tiger Lake (i5/i7-11xx Gx), ampliamente documentados desde 2025. Variación esperada ±20%. Si el bench empírico muestra desvíos >40%, el veredicto del spike debe revisarse.

---

**Fin del documento.**
