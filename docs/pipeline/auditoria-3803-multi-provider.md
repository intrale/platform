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

### MP-01 · F-6 recurrente: `verdict: 'aborted'` cuando la cadena entera de providers degrada
- **Estado:** CONFIRMADO
- **Archivo:** `.pipeline/pulpo.js:9761-9764` (F-6 por `aborted`, camino independiente), `:9789-9803` (soft-timeout, hoy inerte). Evidencia: memoria `project_sherlock-f6-chain-degraded` (2026-06-02) contra `commander-dispatch` log
- **Qué pasa:** El F-6 "no pude verificar con el verificador adversarial" se dispara cuando Sherlock devuelve `verdict: 'aborted'` porque **la cadena completa de providers cayó en el mismo turno**: schema_violation en Opus + spawn_exit en codex + cuota en gemini + invalid_model en cerebras. Sherlock recorre toda la cascada (ver MP-03, refutado) y aun así se queda sin ningún eslabón sano → aborta → F-6 legítimo pero molesto.
- **NO es el soft-timeout.** El reloj de 120s ya quedó inerte (`DEFAULT_TIMEOUT_MS = 0` en Sherlock y completion-client, ver MP-02): el camino del `aborted` es independiente del camino del timeout. La causa vieja del timeout ya está corregida.
- **Por qué importa:** Mientras los eslabones individuales no degraden con gracia (ver MP-04, MP-05, MP-12), cualquier turno con Anthropic en cuota arrastra a toda la cadena a fallar de golpe → F-6. La cura del F-6 recurrente NO es tocar el orquestador: es hacer que cada provider degrade limpio al siguiente en vez de matar el intento.

### MP-02 · Sin presupuesto total de tiempo en la cascada (Sherlock sin timeout interno + orquestador con 120s)
- **Estado:** CONFIRMADO (relacionado con MP-01)
- **Archivo:** `.pipeline/lib/sherlock-verifier.js:167-172` (`DEFAULT_TIMEOUT_MS = 0`), `.pipeline/lib/multi-provider/completion-client.js:47-55` (`DEFAULT_TIMEOUT_MS = 0`)
- **Qué pasa:** Tanto Sherlock como el completion-client corren sin timeout (decisión deliberada). Si un provider remoto se cuelga, el thread espera indefinidamente; el único corte es el soft-timeout de 120s del orquestador (MP-01), que arriba degrada a F-6 espurio. No hay un budget de tiempo que acote la cascada completa sin romper el contrato "sin reloj".
- **Por qué importa:** Tensión de diseño: "sin timeout para que aguante la cascada" choca con "el usuario no puede esperar para siempre". Hay que reconciliar MP-01 y MP-02 juntos (p.ej. timeout solo si NO hubo veredicto, o cancelar Sherlock al timeout en vez de ignorar su resultado).

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
- **Estado:** CONFIRMADO
- **Archivo:** `.pipeline/lib/multi-provider/secrets-rw.js:85-90` (en `MANAGED_KEYS`), `.pipeline/lib/multi-provider/live-ping.js:121-128`, `.pipeline/state/multi-provider-health.json` (snapshot: `red_count: 1` = ElevenLabs `no_key_configured`)
- **Qué pasa:** ElevenLabs (TTS/STT de pago) está en `MANAGED_KEYS` y se pinguea como un provider más. El health-cron lo incluye y aparece rojo, mostrando "1 proveedor en rojo" cuando el pipeline LLM está 100% verde. No participa de la cascada multi-provider (no está en ningún skill de `agent-models.json`).
- **Por qué importa:** Falso rojo recurrente que confunde el panorama. Hay que separarlo en una lista `MULTIMEDIA_KEYS` o excluirlo del health-cron de LLM.

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
