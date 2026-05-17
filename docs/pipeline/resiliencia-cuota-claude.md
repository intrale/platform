# Resiliencia del pipeline ante corte de cuota Claude

**Spike de validación** · Issue [#3251](https://github.com/intrale/platform/issues/3251) · Ejecutado 2026-05-16 · Worktree `platform.agent-3251-pipeline-dev`.

Este documento responde la pregunta operacional: **¿Qué pasa con el pipeline V3 si la cuota Anthropic se agota un sábado a la madrugada?** El esquema multi-provider (issues #3198, #3221, #3233, #3235) declara fallbacks por skill, pero hasta este spike nunca lo habíamos probado en runtime. La conclusión corta es que la red de respaldo es una **ilusión de cobertura**: el dispatcher rutea correctamente al fallback, pero los handlers reales son stubs y el Telegram Commander es un punto único de falla.

> El alcance del spike es investigación. **No se entregan fixes acá**. Los hallazgos se materializan como issues hijos al cierre (CA-8).

## Veredicto ejecutivo

De los 7 componentes del pipeline con relevancia LLM medidos, **3 sobreviven sin Claude** (Pulpo core, listener-telegram, skills determinísticos) y **4 mueren** (handlers stub openai-codex/groq/gemini-google/cerebras + Telegram Commander). Los issues críticos son la falta de runtime real en los handlers de fallback ([#3198](https://github.com/intrale/platform/issues/3198) / [#3076](https://github.com/intrale/platform/issues/3076)) y el hardcode de `provider: 'anthropic'` en `ejecutarClaude` del Commander.

## Matriz de resultados (CA-1) — ordenada por severidad operacional

| Componente | Comportamiento observado | Impacto operacional | Acción de mitigación | Issue de seguimiento |
|---|---|---|---|---|
| **Telegram Commander** (`pulpo.js:6800 ejecutarClaude`) | `spawn(CLAUDE_LAUNCHER.cmd, ...)` directo a Claude Code CLI. NO llama `resolveSpawnWithFallback`. `env-isolation` hardcodea `provider: 'anthropic'`. Detector de cuota hardcodea `cmdProvider = 'anthropic'`. | `[CRÍTICO]` El único canal humano↔pipeline queda mudo cuando Claude cae. Sin `/ghostbusters`, `/reset` ni pausa remota desde Telegram. Ventana ciega para el operador hasta que vuelva Claude. | (a) Path mínimo en `ejecutarClaude` que use `resolveSpawnWithFallback` para el skill virtual `commander`. (b) Modo degradado sin LLM: comandos pre-definidos (`/status`, `/ghostbusters`, `/reset`, `/pause`) parseados con regex y servidos vía filesystem queue, sin spawnear Claude. | [#3253](https://github.com/intrale/platform/issues/3253) (abierto por este spike, `priority:critical`) |
| **Handler `openai-codex`** (`providers/openai-codex.js`) | Stub `_notImplemented`. Dispatcher SÍ lo selecciona como fallback (log `↪️ doc:#3251 primary=anthropic gated, usando fallback="openai-codex" (índice 0)`), pero `handler.buildSpawn()` tira: `Provider "openai-codex" no está implementado todavía (operación: buildSpawn).` | `[CRÍTICO]` La red de respaldo del 80% de los skills (todos los que ponen `openai-codex` primero en `fallbacks[]`) está apagada. El archivo de trabajo rebota a `pendiente/` con motivo claro, NO crashea el pulpo, pero NO se ejecuta el agente. | Entrega real del wrapper Codex CLI según diseño de [#3076](https://github.com/intrale/platform/issues/3076). Mientras tanto, evitar mensajes engañosos: el dispatcher emite event `fallback_selected` antes del throw, dando la falsa sensación de cobertura. | [#3076](https://github.com/intrale/platform/issues/3076) (existente) + [#3255](https://github.com/intrale/platform/issues/3255) (recomendación de mensajería) |
| **Handler `groq`** (`providers/groq.js`) | Stub `_notImplemented`. Mismo patrón: selección del dispatcher + throw en buildSpawn. | `[CRÍTICO]` Segundo en la cadena de fallback para la mayoría de skills (después de `openai-codex`). Si Claude + Codex caen, el siguiente intento también muere. | Entrega real del wrapper Groq (REST OpenAI-compat) por [#3198](https://github.com/intrale/platform/issues/3198). | [#3198](https://github.com/intrale/platform/issues/3198) (existente) |
| **Handler `gemini-google`** (`providers/gemini-google.js`) | Stub `_notImplemented`. Idem. | `[ALTO]` Tercero en cadena para `android-dev`, `web-dev`, `qa`, `po`, `ux`, `perf`. | Entrega real del wrapper Gemini por [#3198](https://github.com/intrale/platform/issues/3198). | [#3198](https://github.com/intrale/platform/issues/3198) |
| **Handler `cerebras`** (`providers/cerebras.js`) | Stub `_notImplemented`. Idem. | `[ALTO]` Último en cadena para casi todos los skills. Sería el último cartucho antes de quedarse sin red. | Entrega real del wrapper Cerebras por [#3198](https://github.com/intrale/platform/issues/3198). | [#3198](https://github.com/intrale/platform/issues/3198) |
| **Dispatcher `resolveSpawnWithFallback`** (`dispatch-with-fallback.js:227`) | ✅ Selecciona correctamente el primer fallback no-gateado del array `fallbacks[]` cuando el primario está marcado por `quota-exhausted.json`. Emite event audit `fallback_selected`, notifica via filesystem queue Telegram y devuelve `{provider, model, handler, source:'fallback', crossProvider:true}`. Logs reales obtenidos durante E1 y E2 más abajo. | `[BAJO]` La lógica de dispatch funciona como diseñada. Su efecto operacional es nulo porque los handlers downstream son stubs, pero la rama está lista para cuando #3198/#3076 entreguen runtime. | Ninguna acción de mitigación en el dispatcher en sí. Evaluar agregar warning preventivo al boot del pulpo si detecta que `fallbacks[]` apunta a handlers stub. | [#3254](https://github.com/intrale/platform/issues/3254) (recomendación abierta por este spike) |
| **Detector estructurado de cuota** (`quota-exhausted.js:_detectAnthropic`) | ✅ Matchea correctamente el shape real del stream-json de Anthropic (`evt.type === 'result' && evt.is_error === true && evt.error_type ∈ ['usage_limit_error', 'weekly_quota_exhausted', 'snapshot_threshold_90']`). El flag `.pipeline/quota-exhausted.json` se escribe con `provider`, `model`, `resets_at`, `pattern_matched`. | `[BAJO]` Funciona. La causa real ("usage_limit_error") queda registrada y el dashboard puede mostrarla — no cae a "error genérico". | Ninguna. Pre-condición para que el resto del flow funcione. | — |
| **Pulpo core loop** (intake/outtake/dispatch, `pulpo.js` minus `ejecutarClaude`) | ✅ Es Node + filesystem-como-estado. Las 5 referencias a Claude en `pulpo.js` viven en `detectClaudeLauncher` (detector pasivo), `ejecutarClaude` (Commander), `_brazoCommanderInner` (Commander) y `cmdProponer` (Commander/historias). El intake desde GitHub, el outtake hacia las carpetas de fase, la promoción y los rebotes son decisiones determinísticas. | `[N/A]` El Pulpo NO consume tokens. CA-3 cerrado: no es SPoF de Claude. | Ninguna. Punto fuerte del diseño. | — |
| **`listener-telegram.js`** (long-polling Telegram) | ✅ Node + `https` + filesystem queue puros. Cero `require` de Claude/Anthropic/OpenAI. | `[N/A]` Inmune al corte de Claude. Sigue escribiendo `servicios/telegram/pendiente/*.json` mientras llegan mensajes; el Commander los procesa cuando vuelva Claude. | Ninguna. El backlog se acumula en filesystem y se drena al recuperarse. | — |
| **Skills determinísticos** (`build`, `tester`, `linter`, `delivery`) | ✅ Node puro (`.pipeline/skills-deterministicos/*.js`). El handler `deterministic` ignora flag de cuota en el dispatcher (línea 269 de `dispatch-with-fallback.js`). | `[N/A]` Siguen ejecutando sin Claude. El pipeline puede compilar, testear, mergear y empaquetar sin red LLM. | Ninguna. Diseño correcto, ya validado en producción. | — |

> **Lectura clave**: la columna `[CRÍTICO]` arriba muestra el costo real de no probar la red de respaldo antes. La fila más severa, **Telegram Commander como SPoF**, es la que rompe la primitiva más básica del modo degradado — el operador queda sin canal de control durante el outage, que es exactamente cuando más lo necesita.

## Evidencia empírica (logs textuales del spike)

El harness `.pipeline/tools/spike-3251-cuota-claude.js` corre los 5 escenarios sin spawnear agentes reales (CA-7: minimizar tokens). Usa el dispatcher real, el módulo de cuota real y los handlers reales (incluidos stubs) para observar comportamiento end-to-end.

### E1 — Claude API key inválida (cuota tipo "credenciales") → fallback selección + buildSpawn

```
setFlag result: { exhausted: true, provider: 'anthropic',
  model: 'claude-opus-4-7', resets_at: '2026-05-16T17:06:00.369Z',
  detected_at: '2026-05-16T16:06:00.370Z', pattern_matched: 'credit_balance_too_low' }
[log/lanzamiento] ↪️ doc:#3251 primary=anthropic gated, usando fallback="openai-codex" (índice 0)
resolveSpawnWithFallback("doc"):
  provider=openai-codex  model=gpt-5-codex  source=fallback
  gated=false  fallbackUsed={ index: 0, provider: 'openai-codex' }
  chainTried=[anthropic → openai-codex]  crossProvider=true

Probando handler.buildSpawn() del fallback resuelto:
  🛑 buildSpawn throw: [agent-launcher/openai-codex] Provider "openai-codex" no está implementado todavía (operación: buildSpawn).
```

**Lectura:** el dispatcher hace su trabajo (selección, audit, notificación) pero el handler downstream aborta. Ilusión de cobertura confirmada.

### E2 — Rate limited 429 → mismo patrón, sin retry loop

```
[log/lanzamiento] ↪️ guru:#3251 primary=anthropic gated, usando fallback="openai-codex" (índice 0)
  provider=openai-codex  source=fallback  gated=false
  chainTried=[anthropic → openai-codex]
  🛑 buildSpawn de openai-codex throw: [agent-launcher/openai-codex] Provider "openai-codex" no está implementado todavía (operación: buildSpawn).
```

**Lectura:** el flag se evalúa una sola vez por intento; no hay retry loop infinito. El watchdog del pulpo trata el throw como infra failure y mueve el archivo a `pendiente/` con motivo accionable. ✅

### E3 — Cuota mensual exhausta (shape real Anthropic) → flag con causa real

```
detectQuotaError: matched=true  errorType=usage_limit_error
quota-exhausted.json:
  pattern_matched=usage_limit_error  provider=anthropic
  resets_at=2026-05-16T22:06:00.371Z
```

**Lectura:** el detector estructurado matchea el shape real del stream-json (`evt.type === 'result' && evt.is_error === true && evt.error_type === 'usage_limit_error'`). El dashboard tiene la causa real disponible — no es "error genérico". ✅

### E4 — Pulpo orquestador sin LLM en su core loop

```
Referencias LLM en pulpo.js: 5
Llamadas LLM por función contenedora:
  detectClaudeLauncher: 1   (detector pasivo, no consume tokens)
  cmdProponer: 1            (proposición de historias del Commander)
  ejecutarClaude: 1         (Commander)
  _brazoCommanderInner: 2   (Commander)
```

**Lectura:** las 5 referencias caen en funciones del Commander/historias. El core loop (intake desde GitHub, dispatch a fases, ejecución del watchdog, promoción a `procesado/`, rebotes) es Node + filesystem. **CA-3 cerrado**: el Pulpo NO es SPoF de Claude. ✅

### E5 — Telegram Commander hardcoded a Anthropic

```
commander → spawn directo de CLAUDE_LAUNCHER:                       true
commander → env-isolation hardcodea provider 'anthropic':           true
commander → quota-detector hardcodea cmdProvider 'anthropic':       true
commander → usa resolveSpawnWithFallback:                           false
veredicto:                                                          SPoF confirmado
```

**Lectura:** confirma el hallazgo pre-spike de guru. `ejecutarClaude` (líneas 6800-6912 de `pulpo.js`) NO pasa por el dispatcher de fallback. Tres puntos hardcodean Anthropic: el spawn (línea 6847-6856), la env-isolation (líneas 6832), y el detector de cuota del Commander (líneas 6925-6940). **CA-4 cerrado con veredicto (a): bug crítico confirmado**. 🛑

## Pre-condiciones validadas (CA-2)

- **agent-models.json** carga **20 skills** en runtime (delta vs "17" mencionado en CA-2 del PO: refleja iteraciones posteriores al sign-off Leo 2026-05-15 / [#3236](https://github.com/intrale/platform/issues/3236); reportado como nota, no falla CA-2).
- 16 skills usan `anthropic` como primary con fallbacks declarados. 4 (`build`, `tester`, `linter`, `delivery`) son `deterministic`.
- Tabla hardcoded de providers en `resolve-provider.js`: `anthropic, openai-codex, gemini-google, groq, cerebras, deterministic` — los 6 cargan, pero 4 son stubs.

```
backend-dev    primary=anthropic      fallbacks=[openai-codex,groq,cerebras]
pipeline-dev   primary=anthropic      fallbacks=[openai-codex,groq,cerebras]
android-dev    primary=anthropic      fallbacks=[openai-codex,groq,gemini-google,cerebras]
web-dev        primary=anthropic      fallbacks=[openai-codex,groq,gemini-google,cerebras]
build          primary=deterministic  fallbacks=[(none)]
tester         primary=deterministic  fallbacks=[(none)]
security       primary=anthropic      fallbacks=[openai-codex,groq,cerebras]
qa             primary=anthropic      fallbacks=[openai-codex,gemini-google,groq,cerebras]
review         primary=anthropic      fallbacks=[openai-codex,groq,cerebras]
po             primary=anthropic      fallbacks=[openai-codex,gemini-google,groq,cerebras]
ux             primary=anthropic      fallbacks=[openai-codex,gemini-google,groq,cerebras]
doc            primary=anthropic      fallbacks=[openai-codex,groq,cerebras]
planner        primary=anthropic      fallbacks=[openai-codex,groq,cerebras]
guru           primary=anthropic      fallbacks=[openai-codex,groq,cerebras]
ops            primary=anthropic      fallbacks=[openai-codex,groq,cerebras]
perf           primary=anthropic      fallbacks=[openai-codex,gemini-google,groq,cerebras]
auth           primary=anthropic      fallbacks=[openai-codex,groq,cerebras]
refinar        primary=anthropic      fallbacks=[(none)]
linter         primary=deterministic  fallbacks=[(none)]
delivery       primary=deterministic  fallbacks=[(none)]
```

## Plan de mitigación priorizado (CA-5)

### Prioridad CRÍTICA — issue hijo abierto por este spike

1. **[#3253](https://github.com/intrale/platform/issues/3253) — [pipeline] Telegram Commander es SPoF en Claude — habilitar multi-provider o modo degradado sin LLM.**
   Mitigación mínima viable (orden de costo creciente):
   - **(a) Modo degradado sin LLM**: comandos pre-definidos parseados con regex en `_brazoCommanderInner` (`/status`, `/ghostbusters`, `/reset`, `/pause`, `/quota`). Si llega un mensaje que no matchea regex, responder con texto fijo "Claude está caído, comandos disponibles: …". Cero tokens, cero dependencia LLM, canal de control siempre vivo. **→ Entregado por #3253 path (a)** — ver [`docs/pipeline/multi-provider.md` §9 — Modo degradado del Commander](./multi-provider.md#9-modo-degradado-del-commander-sin-llm) para detalle operativo (`/quota`, cooldown destructivo 60s, gate texto libre anti-prompt-injection, tests + smoke).
   - **(b) Multi-provider real**: `ejecutarClaude` pasa por `resolveSpawnWithFallback({ skill: 'commander', ... })`. Requiere agregar `commander` como skill en `agent-models.json` con su propia `fallbacks[]`. Bloqueado por #3076/#3198 (handlers reales).
   - Recomendación: empezar por (a) — desbloquea hoy. (b) se hace cuando #3198 entrega runtime.

### Prioridad CRÍTICA — issues existentes a cerrar antes de confiar en la red

2. **[#3076](https://github.com/intrale/platform/issues/3076)** — H3 multi-provider entrega del wrapper Codex CLI real. Sin esto, el primer fallback de la mayoría de skills es decorativo.
3. **[#3198](https://github.com/intrale/platform/issues/3198)** — runtime real de groq / gemini-google / cerebras. Sin esto, el resto de la cadena de fallback es decorativa.

### Prioridad ALTA — issues hijos no bloqueantes abiertos por este spike

4. **[#3254](https://github.com/intrale/platform/issues/3254) — [recomendación][pipeline] warning preventivo al boot si `fallbacks[]` apunta a handlers stub.** El pulpo podría detectar al cargar `agent-models.json` que un fallback declarado apunta a un handler stub y emitir un warning visible en logs + Telegram. Hoy la red declara cobertura que no existe; un warning explícito al boot evita la ilusión. (Etiquetado `needs-human` + `priority:low` por protocolo del PO.)
5. **[#3255](https://github.com/intrale/platform/issues/3255) — [recomendación][pipeline] dispatcher debe distinguir fallback stub al loggear `fallback_selected`.** Cuando `resolveSpawnWithFallback` selecciona un fallback que va a tirar `_notImplemented`, el log debería matizar con `(STUB — va a fallar)` o saltar al siguiente sin gastar el slot. Ahora mismo el operador ve "fallback ok" y el archivo aparece de nuevo en `pendiente/` minutos después sin contexto claro. (Etiquetado `needs-human` + `priority:low`.)

### Prioridad MEDIA

6. **[recomendación][pipeline] plantilla reutilizable de reportes de spike con audio narrado.** Detectado por UX en fase criterios. No bloqueante; lo dejamos registrado para próximos spikes si el formato de este resulta útil.

## Trazabilidad de tokens del propio spike (CA-7)

El harness corre con Node puro: **cero tokens de pipeline consumidos**. No spawneó agentes reales (no se ejecutaron `doc`, `guru`, ni ningún skill LLM). La validación E1-E5 se hace contra las funciones `setFlag`, `resolveSpawnWithFallback`, `detectQuotaError` directamente. El costo de tokens del propio agente que escribió este spike (`pipeline-dev` LLM) es la única partida — instrumentación detallada vive en `.pipeline/metricas/` si está habilitada.

**Hallazgo no bloqueante:** la captura per-escenario de tokens no está instrumentada en `.pipeline/metricas/` (solo agrega tokens por agente, no por escenario de prueba). Si en futuras corridas multi-provider queremos calibrar costo por proveedor + por escenario, hay que agregar un campo `scenario_id` al schema de métricas. Lo dejamos como mejora futura (no se abre issue ahora, va al backlog del próximo refactor de métricas).

## Reproducibilidad

```bash
cd C:\Workspaces\Intrale\platform.agent-3251-pipeline-dev
node .pipeline/tools/spike-3251-cuota-claude.js
```

Output completo del run: en stdout. El harness limpia el flag `.pipeline/quota-exhausted.json` entre escenarios y al final. Aplica todos los guardrails de security definidos en la fase criterios:

- Keys sintéticas obvias (`spike-3251` en `agent` y `rawExcerpt`).
- Scope local (no se exporta `ANTHROPIC_API_KEY` globalmente; el Commander queda vivo durante todo el spike).
- Cleanup automático del flag entre escenarios.
- Audit log local desactivado (`auditLogEnabled: false`) para no contaminar `.pipeline/logs/` con un evento sintético.

## Conclusión

El spike confirma de forma empírica el riesgo que la lectura previa de código ya sospechaba: tenemos infraestructura completa de fallback (config + validación + UI + dispatcher + audit + Telegram queue) pero el **kilómetro final está apagado**. Los handlers stub son honestos (`_notImplemented` con mensaje accionable), pero el efecto sistémico es engañoso: los logs dicen "fallback ok" mientras los archivos de trabajo rebotan a `pendiente/` y el operador, sin Commander, ni siquiera puede preguntarle al pipeline qué pasó.

Las dos acciones que más mueven la aguja son **(a) modo degradado del Commander sin LLM** (alto valor, bajo costo, desbloquea hoy) y **(b) cerrar #3076 + #3198** (alto valor, costo mayor, condición necesaria para que la red de respaldo sea real).
