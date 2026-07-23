# Auditoría integral end-to-end multi-provider (#3803)

> **Estado:** barrido completo — fase de documentación. NO se aplicó ningún fix todavía.
> Esta es la lista maestra de cuestiones detectadas para ir resolviendo de a poco.
> Fecha del barrido: 2026-06-02.
> Método: 5 auditores en paralelo (cadena de fallback, orquestador Commander/Sherlock,
> health/conectores, config de modelos por agente, cobertura/smoke) + verificación
> adversarial manual de los hallazgos críticos y contradictorios.

## Cómo leer esta tabla

- **ID** estable (`MP-NN`) para referenciar cada cuestión en los fixes posteriores.
- **Estado de verificación:**
  - `CONFIRMADO` — verificado contra el código real con archivo:línea.
  - `A CONFIRMAR` — reportado por un auditor, plausible, falta confirmación fina.
  - `REFUTADO` — un auditor lo reportó pero la verificación manual lo desmiente (se deja registrado para no perder tiempo re-investigándolo).

---

## 🔴 Severidad ALTA

### MP-01 · F-6 espurio: el soft-timeout del orquestador (120s) era MENOR que el presupuesto del cliente (180s) — ✅ CORREGIDO (#3803, 2026-06-02)
- **Estado:** CORREGIDO
- **Archivo:** `.pipeline/pulpo.js` soft-timeout del turn handler (`SHERLOCK_SOFT_TIMEOUT_MS`) + guard `sherlockResolved`
- **Qué pasaba:** El orquestador envolvía TODO el bloque Sherlock en un `Promise.race` contra un reloj hardcoded de **120s**. Pero el `completion-client` le concede a cada request de Sherlock hasta **180s** (`ABSOLUTE_MAX_TIMEOUT_MS`), y el bloque puede hacer 2 verify + 1 reelaboración. Resultado: en cualquier verificación legítimamente lenta (cascada cruzando providers), el reloj de 120s ganaba la carrera y disparaba el F-6 "no pude verificar" **aunque el verdict real fuese OK**. Era la causa raíz del F-6 recurrente que reaparecía turno a turno.
- **Corrección rumbo doble:** (1) el soft-timeout pasó a **420s** (cubre 2×180s + reelaboración) y es **configurable** vía `sherlock_soft_timeout_ms`; (2) se agregó el flag `sherlockResolved`: el disclaimer F-6 lo decide **el verdict real de Sherlock, nunca el reloj** — si el bloque resolvió, jamás se pisa un OK con un F-6 espurio.
- **Nota de auditoría (qué falló en el barrido inicial):** la versión previa de este doc afirmaba que "el reloj de 120s ya quedó inerte". Eso era **incorrecto**: el código tenía el `Promise.race` de 120s plenamente activo. Ese error de lectura es la razón por la que MP-01/MP-02 no entró en el PR #3803 (commit `57ee9593`, que sí entregó MP-04/MP-12/MP-05): se trató el F-6 como puro camino de cascada-degradada. El path de cascada-degradada sigue vivo y se trackea aparte (ver nota MP-03/MP-03b abajo).

### MP-02 · Reconciliar el presupuesto de tiempo de la cascada con el cutoff del orquestador — ✅ CORREGIDO (junto a MP-01)
- **Estado:** CORREGIDO (junto a MP-01)
- **Archivo:** `.pipeline/lib/sherlock-verifier.js` + `.pipeline/lib/multi-provider/completion-client.js` (presupuesto per-request) + `.pipeline/pulpo.js` (cutoff del orquestador)
- **Qué pasaba:** Sherlock y el cliente corren sin timeout local (decisión deliberada); el presupuesto se delega al cliente (180s per-request). El único corte de release era el soft-timeout del orquestador, que estaba por DEBAJO de ese presupuesto → mataba la cascada antes de tiempo (MP-01).
- **Cómo se reconcilió:** el cutoff del orquestador ahora es ≥ al worst-case del cliente (420s > 2×180s) y solo libera el chat (mensaje UX-2) cuando **NO hubo veredicto**. Se preserva el contrato "sin reloj que mate la cascada" + la garantía UX "el chat no queda colgado para siempre".

### MP-03 · ¿Sherlock perdió la cascada multi-provider en `verify()`? — REFUTADO
- **Estado:** REFUTADO
- **Archivo:** `.pipeline/lib/sherlock-verifier.js:49-74` (comentario #3668), evidencia: `commander-dispatch` log 2026-06-02 turno ~11:32
- **Qué pasa:** Un auditor sospechó que la refactor #3668 dejó a Sherlock invocando un único provider y cayendo al primer error. **La evidencia logueada lo desmiente:** en el turno verificado Sherlock recorre la cadena completa provider-por-provider — `anthropic → openai-codex → gemini → cerebras → nvidia-nim` (5 eslabones intentados). NO cae al primer error.
- **Conclusión:** la cascada de Sherlock está intacta. Se deja registrado para no re-investigarlo. NO es un defecto y NO condiciona nada.

### MP-04 · Modelo inválido es error terminal (allowlist estática rompe la cascada)
- **Estado:** CONFIRMADO
- **Archivo:** `.pipeline/lib/multi-provider/completion-client.js:137-160` (allowlist hardcoded), `:254-260` (early-return `invalid_model`)
- **Qué pasa:** Si un caller pide un modelo que no está en `PROVIDER_MODELS_ALLOWLIST[provider]`, el cliente retorna `invalid_model` **antes** de la request HTTP, y es un error no recuperable por la cascada. La allowlist es estática: un modelo nuevo (p.ej. otra variante de Cerebras) no figura hasta que un PR agregue el string.
- **Por qué importa:** Una config con un nombre de modelo levemente distinto al de la allowlist hace fallar al provider de forma silenciosa y non-recoverable, en vez de degradar.

### MP-05 · Sin pre-check de credenciales en skills genéricos (solo el Commander lo tiene)
- **Estado:** CONFIRMADO
- **Archivo:** `.pipeline/lib/multi-provider/completion-client.js:279-287` (`no_key_configured`), `.pipeline/lib/agent-launcher/dispatch-with-fallback.js:860-878` (gate por cuota, no por credencial), `.pipeline/lib/commander/credentials-precheck.js` (pre-check solo Commander)
- **Qué pasa:** El dispatcher elige un fallback validando el flag de cuota (`shouldGateSpawn`), pero **no** valida que la credencial del fallback esté configurada. Si el fallback no tiene key, el spawn se intenta y falla recién en runtime con `no_key_configured`, que se ve como error de red. El pre-check de credenciales existe únicamente para el Commander, no para skills.
- **Por qué importa:** Degradación no grácil: el operador ve un timeout/error de red en lugar de "credencial no configurada".

---

## 🟡 Severidad MEDIA

### MP-06 · ElevenLabs contamina el semáforo de conectores LLM
- **Estado:** ✅ RESUELTO ([#3818](https://github.com/intrale/platform/issues/3818)) — ElevenLabs fue eliminado por completo del pipeline (config, código, UI del dashboard, health-ping, credenciales, tests y docs). Ya no está en `MANAGED_KEYS` ni en `PROVIDER_PING_ENDPOINTS`, por lo que no se pinguea ni aparece en el semáforo. El falso "1 proveedor en rojo" desapareció.
- **Archivo (histórico):** `.pipeline/lib/multi-provider/secrets-rw.js` (entrada en `MANAGED_KEYS` removida), `.pipeline/lib/multi-provider/live-ping.js` (entrada en `PROVIDER_PING_ENDPOINTS` y override 429 removidos), `.pipeline/state/multi-provider-health.json` (snapshot sin el provider).
- **Qué pasaba:** ElevenLabs (TTS/STT de pago) estaba en `MANAGED_KEYS` y se pingueaba como un provider más. El health-cron lo incluía y aparecía rojo, mostrando "1 proveedor en rojo" cuando el pipeline LLM estaba 100% verde. No participaba de la cascada multi-provider (no estaba en ningún skill de `agent-models.json`).
- **Resolución:** En lugar de separarlo en una lista `MULTIMEDIA_KEYS`, se eliminó ElevenLabs como código muerto (la cadena TTS vigente es edge-tts → OpenAI). El semáforo ahora refleja sólo providers LLM reales.

### MP-07 · Dos fuentes de verdad para el listado de providers en health
- **Estado:** CONFIRMADO
- **Archivo:** `.pipeline/lib/provider-health.js:115-124` (lee de `agent-models.json`) vs `.pipeline/lib/multi-provider/health-cron.js:257-260` (lee de `secrets-rw.MANAGED_KEYS`)
- **Qué pasa:** `provider-health.js` (endpoint del dashboard) deriva los providers de `agent-models.json` y NO incluye ElevenLabs; `health-cron.js` los deriva de `MANAGED_KEYS` y SÍ lo incluye. El estado interno del Pulpo y el semáforo del dashboard pueden desalinearse.
- **Por qué importa:** Inconsistencia de fuente de verdad; relacionado con MP-06.

### MP-08 · `openai-codex` desalineado en `agent-models.json` (sin `auth_mode`/`cli_binary`)
- **Estado:** CONFIRMADO
- **Archivo:** `.pipeline/agent-models.json:40-67` (sin `auth_mode: 'oauth'`) vs `.pipeline/lib/multi-provider/secrets-rw.js:74-82` (sí tiene `auth_mode: 'oauth'`, `cli_binary: 'codex'`)
- **Qué pasa:** El health-check del CLI-OAuth (#3802) funciona **por accidente** porque lee de `secrets-rw.js`, que es la fuente correcta. Pero `agent-models.json` quedó incompleto/desalineado. Una refactor futura que confíe en `agent-models.json` se rompería.
- **Por qué importa:** Deuda de coherencia que puede morder en mantenimiento; documentar cuál es la fuente de verdad real.

### MP-09 · Health-cron observa pero NO influye en la decisión de spawn
- **Estado:** A CONFIRMAR
- **Archivo:** `.pipeline/lib/multi-provider/health-cron.js`, `.pipeline/audit/multi-provider-health.jsonl`
- **Qué pasa:** El cron pinguea providers cada ~15 min y persiste estados (verde/rojo), pero el gate de spawn no consulta ese estado: un provider marcado rojo igual se intenta. El único gate real es el de cuota (`shouldGateSpawn`).
- **Por qué importa:** Se hacen spawns condenados a fallar cuando ya sabemos que el provider está caído; falta conectar health → gate pre-spawn (similar al quota-gate). Relacionado con MP-05.

### MP-10 · `MAX_FALLBACK_DEPTH = 5` corta cadenas más largas silenciosamente
- **Estado:** CONFIRMADO
- **Archivo:** `.pipeline/lib/agent-launcher/dispatch-with-fallback.js:753-770`
- **Qué pasa:** Si un skill declara más de 5 fallbacks, la iteración corta en el 5º con `break` y reporta `source: 'all-gated'`. Los fallbacks 6+ nunca se prueban (es anti-DoS intencional), pero el operador no se entera de que su config quedó truncada.
- **Por qué importa:** Config silenciosamente ignorada. Hoy ningún skill supera 4 fallbacks, así que no muerde, pero conviene loguear el truncamiento.

### MP-11 · Smoke-test corre en dry-run: no prueba cascada real ni consumo de tokens
- **Estado:** A CONFIRMAR
- **Archivo:** `.pipeline/lib/multi-provider/smoke-test.js`, `.pipeline/audit/multi-provider-smoke-test-2026-06-01.jsonl` (eventos `spawn_dry_run`, latencias ≤100ms)
- **Qué pasa:** El último smoke-test (2026-06-01) fue 100% dry-run: valida shape sintáctico y que los providers estén registrados, pero no invoca ningún provider real, no ejercita la cascada con primario gateado, ni mide latencia/tokens reales. No se observó un modo `--run-real` en el grep inicial.
- **Por qué importa:** El smoke da "PASS" sin garantizar que la integración real (auth/endpoint/parseo de tokens) funcione. Falta un modo que spawnee al menos 1 prompt real por skill×provider.

### MP-12 · Schema-violation mata el intento sin retry (provider con contrato roto)
- **Estado:** CONFIRMADO
- **Archivo:** `.pipeline/lib/multi-provider/completion-client.js:371, 388` (`invalid_response` / `schema_drift`)
- **Qué pasa:** Si un provider responde 2xx pero el payload no matchea el shape OpenAI esperado, se retorna `invalid_response` (determinístico). Si el shim de un provider cambia el schema, cada intento falla igual. Combinado con MP-03 (si Sherlock no recorre cascada), es falla silenciosa.
- **Por qué importa:** Un cambio de contrato de un provider (p.ej. Gemini v1beta OpenAI-compat) rompe sin diagnóstico claro.

---

## 🟢 Severidad BAJA (deuda / consistencia)

### MP-13 · Cadenas de fallback heterogéneas entre skills
- **Estado:** CONFIRMADO
- **Archivo:** `.pipeline/agent-models.json` — `refinar:429-441` (2 fallbacks, sin gemini), `review:273-276`, backend-dev/pipeline-dev/security (2 fallbacks, sin gemini) vs qa/po/ux/architect/perf (3 fallbacks)
- **Qué pasa:** Algunos skills tienen 3 fallbacks (incluyen gemini-google) y otros 2 (lo omiten), sin criterio documentado. El fix de `refinar` quedó parcial respecto al Grupo B.
- **Por qué importa:** Cobertura de degradación desigual; conviene decidir si es intencional o deuda y homogeneizar.

### MP-14 · Naming inconsistente de modelos Codex (`gpt-5` vs `gpt-5-codex`)
- **Estado:** CONFIRMADO
- **Archivo:** `.pipeline/agent-models.json` — `review` usa `gpt-5-codex`; `qa`/`po`/`ux` usan `gpt-5`
- **Qué pasa:** Ambos pasan la validación de schema (los dos están en la allowlist), pero el naming dispar confunde auditorías manuales.
- **Por qué importa:** Pura mantenibilidad.

### MP-15 · Gemini CLI se cuelga en OAuth headless (timeouts de ~120s)
- **Estado:** A CONFIRMAR
- **Archivo:** `.pipeline/audit/multi-provider-health.jsonl` (transiciones green↔red de Gemini con latencias >120s)
- **Qué pasa:** El health log muestra a Gemini alternando verde/rojo con latencias de ~120s, patrón típico de OAuth interactivo sin sesión iniciada en la máquina headless del Pulpo.
- **Por qué importa:** Gemini como fallback de skills multimodales (qa/po/ux) sería poco confiable en producción sin auth persistente.

### MP-16 · Spike de Groq sin marca de descontinuado
- **Estado:** A CONFIRMAR
- **Archivo:** `docs/pipeline/multi-provider-free-tier-spike.md` (recomienda Groq), `resolve-provider.js:39-40` (Groq removido en #3353)
- **Qué pasa:** Groq fue descontinuado (#3353) pero el doc del spike sigue recomendándolo sin header de deprecación. Un dev nuevo podría re-proponerlo.
- **Por qué importa:** Deuda de documentación; agregar marca de descontinuado.

### MP-17 · Audit log de dispatch demasiado granular
- **Estado:** CONFIRMADO
- **Archivo:** `.pipeline/lib/agent-launcher/dispatch-with-fallback.js:723-972`
- **Qué pasa:** Se emite una línea de audit por cada micro-decisión (`gated_no_fallbacks`, `depth_exceeded`, `fallback_cycle_skipped`, etc.). Con muchos fallbacks gateados se infla el log sin contexto accionable.
- **Por qué importa:** Ruido operacional menor.

---

## 🎯 Indispensables para considerar el multi-provider funcionando en todos los órdenes

Esta es la lista de corte: **sin estos resueltos, NO podemos afirmar que el multi-provider
funciona end-to-end con confianza.** El resto (semáforo, smoke, deuda/consistencia) mejora
la operación pero no bloquea la afirmación de "funciona".

La raíz del F-6 recurrente (MP-01) es que **la cadena entera degrada de golpe**: cada eslabón
que falla mata el intento en vez de pasar limpio al siguiente, y cuando coinciden varios el
veredicto queda `aborted`. Por eso los tres indispensables son precisamente los que hacen que
cada eslabón degrade con gracia. Resueltos esos tres, el `aborted` solo ocurriría si TODOS los
providers están realmente caídos a la vez — y ahí el F-6 es legítimo.

| # | ID | Por qué es indispensable |
|---|-----|--------------------------|
| 1 | **MP-04** | Un modelo fuera de la allowlist estática hoy es error terminal: corta la cascada en vez de degradar al siguiente provider. Fue uno de los eslabones que tiró la cadena (cerebras `invalid_model`). |
| 2 | **MP-12** | Un provider que responde con el schema cambiado mata el intento sin retry ni degradación. Fue otro eslabón caído (schema_violation en Opus). |
| 3 | **MP-05** | Sin pre-check de credenciales en los skills (solo el Commander lo tiene): un fallback sin key falla recién en runtime como "error de red" en vez de saltearlo limpio. Tapa la degradación grácil del resto de la cadena. |

> Con esos tres cerrados, el F-6 deja de aparecer por cadena-degradada (MP-01 se cura solo: ya
> no quedan eslabones que aborten el intento). **MP-03 quedó REFUTADO** (Sherlock sí recorre la
> cascada). MP-02 (reconciliar timeouts) y el resto (MP-06 a MP-11, MP-13 a MP-17) son mejoras de
> semáforo, pruebas y deuda — importantes pero NO condicionan la afirmación "funciona en todos los
> órdenes". Se atacan después.

> Cada MP-NN se convertirá en su propio fix/issue cuando arranquemos a corregir de a poco.

---

## 🔗 Cadenas de fallback por agente (estado 2026-06-02, sign-off Leo por voz)

Fuente de verdad: `.pipeline/agent-models.json`. **Claude (Anthropic) es el primario en
TODOS los agentes que usan modelo** — ninguna cadena LLM arranca sin Claude. Los únicos
agentes sin Claude son los **deterministas** (Node puro, no llaman a ningún modelo): `build`,
`tester`, `linter`, `delivery`. No hay fallback que poner ahí porque no hay LLM.

Criterio transversal: **Gemini queda EXCLUIDO de las cadenas que procesan código fuente
sensible o secretos** (TOS de AI Studio entrena con prompts del free tier). Por eso los DEVs
de backend/pipeline/security y `review`/`refinar` no lo tienen, pero sí los de UI (android/web)
y los evaluadores (qa/po/ux).

### Grupo A — DEVs + Security (output va a `main`, MANTIENEN Opus)
*Cerebras EXCLUIDO: no soporta `tool_use`, no puede editar archivos. La cola es NVIDIA (free + tool_use).*

| Agente | Cadena |
|--------|--------|
| `backend-dev` | Opus → Codex `gpt-5-codex` → NVIDIA `deepseek-v4-pro` |
| `pipeline-dev` | Opus → Codex `gpt-5-codex` → NVIDIA |
| `security` | Opus → Codex `gpt-5-codex` → NVIDIA |
| `android-dev` | Opus → Codex `gpt-5-codex` → Gemini `2.0-flash` → NVIDIA |
| `web-dev` | Opus → Codex `gpt-5-codex` → Gemini → NVIDIA |

### Grupo B — Evaluadores (Sonnet, no escriben código de producción)
*qa/po/ux validan video por frames+capturas y redactan criterios; la visión de Sonnet iguala a Opus.*

| Agente | Cadena |
|--------|--------|
| `qa` | Sonnet → Codex `gpt-5` → Gemini → Cerebras `gpt-oss-120b` |
| `po` | Sonnet → Codex `gpt-5` → Gemini → Cerebras |
| `ux` | Sonnet → Codex `gpt-5` → Gemini → Cerebras |
| `architect` | Sonnet → Codex `gpt-5-codex` → Gemini → Cerebras |
| `perf` | Sonnet → Codex `gpt-5-codex` → Gemini → Cerebras |
| `review` | Sonnet → Codex `gpt-5-codex` → Cerebras *(sin Gemini: ve código)* |
| `refinar` | Sonnet → Codex `gpt-5` → Cerebras *(sin Gemini)* |

### Grupo C — Backlog / soporte (Sonnet)

| Agente | Cadena |
|--------|--------|
| `doc` | Sonnet → Codex `gpt-5-codex` → Cerebras |
| `planner` | Sonnet → Codex `gpt-5-codex` → Cerebras |
| `ops` | Sonnet → Codex `gpt-5-codex` → Cerebras |
| `auth` | Sonnet → Codex `gpt-5-codex` → Cerebras |
| `guru` | Sonnet → Codex `gpt-5-codex` → Cerebras → NVIDIA |

### Grupo D — Telegram (chat + verificación)

| Agente | Cadena |
|--------|--------|
| `telegram-commander` | Sonnet → Codex `gpt-5` → Gemini → Cerebras → NVIDIA |
| `telegram-sherlock` | **Haiku** → Codex `gpt-5-mini` → Gemini → Cerebras → NVIDIA |

> `telegram-sherlock` MANTIENE Haiku como primario a propósito: es el **piso de calidad del
> verificador**. Un verificador flojo aprueba cualquier cosa, así que no se baja.

### Grupo E — Deterministas (sin modelo)
`build` · `tester` · `linter` · `delivery` — código Node puro, sin cadena LLM.

### Nota de paridad — Cerebras `gpt-oss-120b` (duda de Leo, 2026-06-02)
`gpt-oss-120b` **NO tiene paridad** con Opus/Sonnet/gpt-5. Decisión asumida: es **cola**
(último o penúltimo eslabón) y solo en skills que **no requieren `tool_use`** (chat/evaluación/
verificación). En esas cadenas, abajo suyo todavía queda NVIDIA como red final real. El rol de
la cola no es "igualar al primario" sino **dar una respuesta degradada antes que un fallo total**
cuando todo lo de arriba se agotó. Queda como deuda abierta evaluar reemplazos con más paridad
si aparece un free tier mejor.

---

## 📌 Pendientes — lo que va a faltar (no bloqueante)

Los **5 indispensables ya están cerrados** (MP-01/02 en #3806, MP-04/12/05 en #3804): el
multi-provider degrada con gracia y el F-6 espurio desapareció. Lo que queda son **mejoras de
semáforo, pruebas y deuda de consistencia** — importantes para pulir la operación, pero NO
condicionan la afirmación "funciona en todos los órdenes". Se atacan de a poco:

| ID | Pendiente | Severidad |
|----|-----------|-----------|
| ~~MP-06~~ | ~~ElevenLabs (TTS de pago) contamina el semáforo LLM con un falso rojo~~ → ✅ RESUELTO (#3818) | Media |
| MP-07 | Dos fuentes de verdad para el listado de providers en health | Media |
| MP-08 | `openai-codex` desalineado en `agent-models.json` (sin `auth_mode`/`cli_binary`) | Media |
| MP-09 | Health-cron observa pero no influye en la decisión de spawn | Media |
| MP-10 | `MAX_FALLBACK_DEPTH = 5` corta cadenas más largas en silencio | Media |
| MP-11 | Smoke-test corre en dry-run: no ejercita cascada real ni tokens | Media |
| MP-13 | Cadenas heterogéneas entre skills (criterio Gemini sí/no) | Baja |
| MP-14 | Naming inconsistente de modelos Codex (`gpt-5` vs `gpt-5-codex`) | Baja |
| MP-15 | Gemini CLI se cuelga en OAuth headless (timeouts ~120s) | Baja |
| MP-16 | Spike de Groq sin marca de descontinuado | Baja |
| MP-17 | Audit log de dispatch demasiado granular | Baja |

### Deuda obsoleta de modelos en config base (validar contra catálogo real del provider)
- **Cerebras** — runtime ya corregido a `gpt-oss-120b` (`llama-3.3-70b` estaba muerto: 404, fuera
  del free tier). Pueden quedar referencias obsoletas en configs/docs base sin tocar; limpiar al pasar.
- **NVIDIA NIM** — el string `deepseek-ai/deepseek-v4-pro` configurado debería validarse contra el
  catálogo free real de NVIDIA NIM (análogo al caso Cerebras). **Leo lo marcó como no urgente** —
  se documenta para que quede registrado, no bloquea.
