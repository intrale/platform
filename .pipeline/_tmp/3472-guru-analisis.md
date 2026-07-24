## Análisis técnico — wire-up live in-flight fallback en `pulpo.js#ejecutarClaude` (guru, fase `analisis`)

Audité la viabilidad técnica del wire-up runtime contra el estado actual del codebase (commit HEAD del worktree de pipeline). Mapeo de primitivas disponibles, gaps que el wire-up debe cerrar, dependencias y riesgos.

### Veredicto: **viable**, sin blockers técnicos

Las primitivas declaradas en #3275 ya están exportadas y son consumibles desde `pulpo.js` vía `commanderMP.*`. El wire-up es **integración + instrumentación**, no requiere nuevas APIs ni cambios de contrato. La complejidad real está en orquestar los timers y mantener la convivencia con `HARD_TIMEOUT_MS=10min` y el `SKILL_WATCHDOG_MS=60s` ya productivos.

### 1. Estado actual del codebase (verificado empíricamente)

| Pieza | Ubicación | Estado |
|------|-----------|--------|
| `decideInflightFallback()` | `lib/commander/inflight-fallback.js:289` | ✅ entregado |
| `acquireInflightLock` / `isLateResponseDuplicate` / `releaseInflightLock` | `lib/commander/inflight-fallback.js:236-265` | ✅ entregado |
| `noteInflightCompleted` / `noteLateResponseDiscarded` | `lib/commander/inflight-fallback.js:539, 583` | ✅ entregado |
| `generateRequestId({ chatId })` | `lib/commander/inflight-fallback.js:614` | ✅ entregado |
| Re-export en `commanderMP.*` | `lib/commander/multi-provider.js:923-934` | ✅ entregado |
| `resolveCommanderProviderExcluding(primary, …)` | `lib/commander/multi-provider.js` | ✅ entregado |
| `enforceDataResidency()` (SR-1 / SEC-1) | `lib/commander/multi-provider.js` | ✅ usado pre-spawn primario |
| `buildChildEnv` con `skillConfigOverride.provider` (SEC-5) | `lib/build-child-env.js` | ✅ usado pre-spawn primario |
| Detector cuota anthropic (line 7931+) | `pulpo.js#ejecutarClaude` | ✅ usado **pero limitado** |
| First-byte timer | — | ❌ **NO existe** |
| Stream-gap detector (30s sin nuevo byte) | — | ❌ **NO existe** |
| Llamada a `decideInflightFallback` desde readline | — | ❌ **NO wire-up** |
| Late-response lock + `acquireInflightLock` | — | ❌ **NO wire-up** |

### 2. Diseño técnico propuesto (orquestación de timers + readline)

El bloque crítico es `pulpo.js:7886-8056` (readline + `progressTimer` + `hardTimer` + `skillWatchdogTimer`). El wire-up agrega **dos timers + un detector de errorClass + un orquestador de re-spawn**:

```
spawn primario
  ├─ firstByteTimer (15s)            ← NUEVO
  │   └─ si no llega ningún byte → errorClass='timeout_first_byte'
  │
  ├─ rl.on('line') existente
  │   ├─ lastByteAt = Date.now()      ← NUEVO (refresca el stream-gap)
  │   ├─ detección 5xx / shape error  ← NUEVO en parser
  │   ├─ assistant/result/tool_use → idéntico al actual
  │
  ├─ streamGapTimer (poll cada 5s)   ← NUEVO
  │   └─ si Date.now() - lastByteAt > 30000 && !resolved
  │      → errorClass='timeout_no_new_bytes_30s' → trigger wire-up
  │
  ├─ proc.on('exit', code) existente
  │   └─ si code !== 0 && !lastText → errorClass='eof_premature' → trigger wire-up
  │
  └─ wire-up flow (CRÍTICO orden, SEC-4 + SEC-6):
      1. killProc primario (taskkill /T ya disponible)
      2. const decision = commanderMP.decideInflightFallback({...})
      3. if (!decision.shouldRetry) → sendTelegram(decision.cannedResponse) → finish()
      4. sendTelegramPlain(decision.noticeText)   ← UX-G1
      5. spawn secundario con buildChildEnv({skillConfigOverride: {provider: decision.secondaryProvider}})
      6. (loop interno o readline equivalente del handler del secundario)
      7. noteInflightCompleted({success, secondaryDurationMs, ...})
      8. acquireInflightLock({chatId, requestId, secondaryProvider})
      9. resolve(respuestaSecundario)

      Si llega late-response del primario después del kill (best-effort):
        if (isLateResponseDuplicate({chatId, requestId})) → noteLateResponseDiscarded(...)
```

#### Compatibilidad con `HARD_TIMEOUT_MS=10min` (preocupación explícita del issue)

El budget de in-flight es **90s totales** (`DEFAULT_BUDGET_MS` hardcoded). El primario consume `primaryDurationMs` del budget; el secundario tiene `budgetRemainingMs` disponible. El `hardTimer` global de 10min **NO se reinicia**: si el ciclo completo (primario + fallback + entrega) excede 10min (por ejemplo, primario lento de 60s + secundario lento de 60s = 120s — sigue muy por debajo), el `hardTimer` no se dispara. **Conclusión: no hay riesgo de regresión del HARD_TIMEOUT** porque 90s < 600s.

#### Compatibilidad con `SKILL_WATCHDOG_MS=60s`

El watchdog de Skill (`/doc`/`/planner`) corre **por turn**. Si el primario emite `tool_use` Skill y arma watchdog, pero falla 5xx antes del `tool_result`, el watchdog ve `pendingSkillCalls.size > 0` indefinidamente. **Acción requerida en el wire-up:** al disparar fallback in-flight, **limpiar `pendingSkillCalls`** (el secundario va a re-spawnear su propia skill call si corresponde, con su propio watchdog). Esto es un detalle de integración, no un blocker.

### 3. Dependencias e interacciones cruzadas

- **`lib/agent-launcher/providers/anthropic.js:150`**: el filtro `line.startsWith('{')` descarta plain-text del CLI (incidente Leo 2026-05-26, Ola N+10). Ya tiene issue dedicado #3563. **No es blocker del wire-up** pero su fix ELEVA la calidad de la señal `errorClass` que llega a `decideInflightFallback` (más casos detectados como `rate_limit` en vez de degradar a `eof_premature`).

- **Hash-chain del audit log** (`commander-dispatch-YYYY-MM-DD.jsonl` vía `lib/audit-log.js#appendChained`): el wire-up debe **emitir audit events en orden estricto** (`inflight_fallback_initiated` → spawn → `inflight_fallback_completed` → `acquireInflightLock`) para preservar consistencia con CA-12 (métricas). SEC-6 lo cubre como requisito.

- **`buildChildEnv`** con `skillConfigOverride.provider`: ya usado pre-spawn primario en `pulpo.js:7662`. El wire-up reusa esa función con `provider=decision.secondaryProvider` para SEC-5 (no leakear `ANTHROPIC_API_KEY` al child de openai-codex). Patrón conocido.

- **`commanderMP.safeBuildSpawn`** (line 7714): hoy la rama non-Anthropic (línea 7713-7781) tiene su propio loop sin inflight fallback. **El scope del issue es la rama Anthropic** (readline stream-json). Sin embargo, la **rama non-Anthropic carece del mismo cinturón** (si openai-codex fallback ALSO falla mid-flight, no hay segundo intento) — gap residual, ver recomendación #1 abajo.

### 4. Riesgos técnicos identificados

| ID | Riesgo | Mitigación |
|----|--------|-----------|
| **R-1** | Concurrent turn isolation: si dos usuarios Telegram disparan turns simultáneos, `lastByteAt` y `firstByteTimer` son por-closure de `ejecutarClaude`, OK. Lock por `chatId+requestId` evita cross-talk. | Generar `requestId` con `generateRequestId({chatId, now})` al inicio de `ejecutarClaude`. Verificable con concurrent chaos test (CA-13). |
| **R-2** | Race condition: el child del primario puede emitir output entre `killProc` y `taskkill /T` (window de ms). | `acquireInflightLock` se llama DESPUÉS de entregar la respuesta del secundario. `isLateResponseDuplicate` en `rl.on('line')` del primario (si sigue vivo) corta el flow. Probar con `setTimeout(() => primaryEmit, 50)` post-kill. |
| **R-3** | Cost amplification cross-provider: si secundario es openai-codex pago y el primario falla 100% en una ventana de 5min, costo se duplica. | `MAX_INFLIGHT_FALLBACKS=1` hardcoded ✅. Sin opt-in dinámico (SEC-3). |
| **R-4** | Cache miss cuando secundario ≠ primario: ningún provider cachea cross-vendor. | `noteInflightCompleted.cacheMissDueToProviderChange=true` cuando `secondaryProvider !== primaryProvider`. Métrica observable. |
| **R-5** | Errores transient del secundario que no son `5xx` (ej: 401 por API key rotada): el wire-up NO debe re-disparar otro fallback (cap=1). | Después del secundario, en caso de fallo, responder canned con `cannedInflightExhaustedResponse({requestId})`. Audit `inflight_fallback_completed{success:false}`. |
| **R-6** | Stream-gap timer vs. tool_use legítimo: una tool Bash que tarda 25s sin emitir bytes podría confundirse con stream gap. | El stream del Claude CLI emite `tool_use` y `tool_result` continuamente (líneas JSON), no es silencio real. Stream gap de 30s sólo se da con CLI muerto / endpoint no responde. Probar con tool larga en test. |

### 5. Módulos afectados (estimación de superficie)

```
.pipeline/pulpo.js                                  ~150 LOC modificadas en ejecutarClaude
                                                     (block 7886-8056, agregando ~80 LOC nuevas)

.pipeline/lib/commander/inflight-fallback.js        SIN cambios (primitiva cerrada)
.pipeline/lib/commander/multi-provider.js           SIN cambios (re-exports OK)
.pipeline/lib/agent-launcher/providers/anthropic.js SIN cambios (#3563 separado)

NUEVO opcional (recomendado para reducir LOC en pulpo.js):
.pipeline/lib/commander/inflight-wire.js            ~120 LOC — orquestador del flow,
                                                     reusable también para rama non-Anthropic
.pipeline/lib/commander/__tests__/inflight-wire.test.js  ~250 LOC — integration tests con fake spawn

.pipeline/lib/__tests__/commander-inflight-fallback.test.js  +chaos test CA-13
```

### 6. Recomendación de criterios de aceptación (para fase `criterios`)

Sugiero al PO incorporar como CA además de los CA-1..CA-9 originales del issue:

- **CA-S1** (de SEC-2): el secundario recibe `promptForLLM` sanitizado del módulo, prohibido concatenar `primaryPartialOutput`.
- **CA-S2** (de SEC-4): `killProc` del primario es **previo** al spawn del secundario, no en paralelo.
- **CA-S3** (de SEC-5): `buildChildEnv({skillConfigOverride: {provider: decision.secondaryProvider}})` recalcula el env, no se reutiliza `cleanEnv` del primario.
- **CA-S4** (de SEC-6): audit emitido en orden estricto `initiated` → spawn → `completed` → `acquireInflightLock`.
- **CA-S5**: el `requestId` se genera **una sola vez** al inicio de `ejecutarClaude` y se reusa en initiated/completed/lock — atómico por turn.
- **CA-S6**: en el spawn del secundario se aplica `enforceDataResidency({provider: secondaryProvider})` antes de spawnear (SEC-1).
- **CA-S7**: `pendingSkillCalls.clear()` al disparar fallback in-flight (cleanup del Skill watchdog).
- **CA-S8** (test chaos): test de carga 100 turns concurrentes con 10%/5%/2% transient failures que verifica:
  - ningún turn entrega respuesta duplicada;
  - audit log es hash-chain consistente (`verifyChain` OK);
  - métrica `inflight_fallback_rate` cae dentro del rate inyectado ±2%.

### 7. Recomendaciones de mejora futura (issues separados, pendientes de aprobación humana)

Durante el análisis identifiqué **2 oportunidades complementarias** que NO bloquean este wire-up pero conviene registrar como issues independientes:

- **#guru**: Aplicar el mismo wire-up de in-flight fallback a la **rama non-Anthropic** de `ejecutarClaude` (línea 7713-7781). Hoy si un fallback ya activo (openai-codex) cae mid-flight, no hay segunda chance — sólo el timeout de 90s y canned response. Independiente de la rama Anthropic.
- **#guru**: Implementar **señal D del detector multi-señal** (Leo 2026-05-26): aggregator de "%fallos en ventana 5min" sobre `commander-dispatch-*.jsonl` que dispare auto-quarantine + alerta Telegram cuando supere 70% en mismo provider. Es defensa en profundidad por encima del per-turn wire-up.

(La señal A `exit codes <15s` y señal E `stderr plain-text parse` ya están cubiertas por #3563 y #3564 abiertos por security.)

### Veredicto final

**aprobado** para que pase a la fase `criterios`. El wire-up es **integración mecánica** con primitiva ya entregada, sin nuevas APIs, sin breaking changes, y con riesgo acotado por los `MAX_INFLIGHT_FALLBACKS=1` + `DEFAULT_BUDGET_MS=90s` hardcoded. La complejidad real es la coordinación de timers (first-byte 15s + stream-gap 30s + hard 10min + skill-watchdog 60s) que es manejable con el modelo de timers de Node existente en `ejecutarClaude`.

Recomiendo al PO que la fase `criterios` incorpore los **CA-S1..CA-S8** complementarios listados en §6 para que el dev los implemente desde el primer commit (alineado con `feedback_v3-bundled-instrumentation.md`).

---
_Análisis emitido por agente `guru` durante fase `analisis` de #3472 (pipeline V3, 2026-05-26)._
