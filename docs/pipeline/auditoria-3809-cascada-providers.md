# Anexo #3809 — Degradación en cascada de la cadena de providers de Sherlock

> **Naturaleza:** ANEXO de la auditoría maestra
> [`auditoria-3803-multi-provider.md`](./auditoria-3803-multi-provider.md). NO la
> reemplaza ni la duplica: extiende el barrido del 2026-06-02 con el incidente
> puntual del **2026-06-03** (F-6 por fallos simultáneos) y lo mapea a los items
> `MP-NN` ya tipificados. Para el detalle de cada `MP-NN`, ir al doc maestro.
> **Fecha:** 2026-06-03 · **Scope:** spike de diagnóstico + instrumentación
> aditiva + blindajes opt-in (1 PR). Verificado empíricamente contra HEAD.

---

## 1. El incidente (2026-06-03)

Sherlock colapsó con un **F-6** ("no pude verificar") cuando los 5 eslabones de
la cadena fallaron en una ventana de ~5–10 min, **cada uno por un motivo
distinto**:

| # | Eslabón del incidente | Motivo observado |
|---|----------------------|------------------|
| 1 | Anthropic (Opus) | JSON con schema inválido (`schema_violation`) |
| 2 | OpenAI-Codex | proceso hijo murió al spawnear (`spawn_exit`) |
| 3 | Cerebras | rechazo por modelo inválido (`invalid_model`) |
| 4 | Gemini | sin cuota (reintentable) |
| 5 | NVIDIA NIM | cola agotada tras los anteriores |

La sospecha del issue era una **"causa común subyacente"**. El spike la
**refuta**: no hubo un único disparador. Lo que hubo fue **coincidencia temporal
de fallos independientes sin degradación grácil** — una debilidad **estructural**
de la cascada, no un bug puntual de config o credencial.

---

## 2. Mapeo eslabón → `MP-NN` → estado en HEAD

| Eslabón #3809 | Item maestro | Estado en `main` (HEAD 2026-06-03) |
|---|---|---|
| Anthropic → `schema_violation` | **MP-12** | **ABIERTO → CERRADO por este PR** (retry 1×) |
| OpenAI-Codex → `spawn_exit` | parser `spawn_exit` (`sherlock-verifier.js`) | clasificado; sin retry dedicado (se cascadea) |
| Cerebras → `invalid_model` | **MP-04** | ✅ CORREGIDO (#3804, allowlist config-aware) |
| Gemini → sin cuota | gate de cuota | funciona como diseñado (reintentable) |
| NVIDIA NIM → cola agotada | — | consecuencia, no causa |
| F-6 espurio por reloj 120s | **MP-01/MP-02** | ✅ CORREGIDO (#3806, soft-timeout 420s + `sherlockResolved`) |
| Pre-check credenciales skills | **MP-05** | ✅ CORREGIDO (#3804, `dispatch-with-fallback.js`) |
| Health-cron no influye en spawn | **MP-09** | **ABIERTO → CERRADO por este PR** (health-gate fail-open) |

---

## 3. Causa raíz (CA-2): **combinación estructural**

La evidencia respalda la respuesta **"combinación estructural"** aceptada por el
PO, no un culpable único:

1. **Falta de retry ante `schema_violation` (MP-12):** un hipo transitorio de
   contrato (Opus devolviendo un payload truncado/raro) mataba el intento sin
   reintentar → se perdía un eslabón sano.
2. **Falta de health-gate (MP-09):** los providers conocidos-rojos se intentaban
   igual, gastando eslabones de la cascada en spawns condenados.
3. **`invalid_model` terminal (MP-04, ya corregido):** antes del #3804, un modelo
   declarado en config pero ausente de la allowlist estática (caso
   `cerebras → gpt-oss-120b`) cortaba un eslabón sano. Ya no aplica en HEAD.

Cuando estos tres caen en una ventana de presión (post-boot, cuota agotada en
uno, drift de modelo en otro), los eslabones se acumulan y el veredicto queda
`aborted` → F-6. Con MP-04 ya cerrado y MP-12 + MP-09 cerrados por este PR, el
`aborted` solo debería ocurrir si **todos** los providers están realmente caídos
a la vez (F-6 legítimo).

---

## 4. Reproducción (CA-1)

El branch `FORCE_PROVIDER_OVERRIDE` de `resolveSpawnWithFallback()`
(`dispatch-with-fallback.js`, allowlist `multi-provider-smoke-test`) permite
forzar un provider concreto **sin tocar credenciales reales**. Para reproducir el
patrón de cascada degradada en ambiente controlado, los tests determinísticos lo
ejercitan sin red:

```bash
# Patrón de cascada por schema_violation en TODA la chain (genera el aborted/F-6):
node --test .pipeline/lib/__tests__/sherlock-verifier.test.js \
  --test-name-pattern "schema_violation en TODA la chain"

# Retry MP-12 (schema transitoria → éxito sin degradar; y cap de 1 retry):
node --test .pipeline/lib/__tests__/sherlock-verifier.test.js \
  --test-name-pattern "MP-12"

# Health-gate MP-09 (rojo fresco gatea; rojo viejo/verde/sin-dato no — fail-open):
node --test .pipeline/tests/health-gate-3809.test.js
```

Estos tests reemplazan el spike manual: reproducen cada eslabón del incidente con
fakes inyectables (sin spawnear binarios ni consumir tokens), de forma que un
tercero los corre y observa el patrón.

---

## 5. Auditoría de config de modelos (CA-6)

**Pregunta:** ¿`cerebras → gpt-oss-120b` queda cubierto por el fix config-aware
(MP-04) o el caché por `mtimeMs` puede desfasarse?

**Verificado empíricamente contra HEAD:**

- `agent-models.json` declara `providers.cerebras.model = "gpt-oss-120b"`.
- `PROVIDER_MODELS_ALLOWLIST.cerebras` (`completion-client.js:140-145`) lista
  **solo** variantes `llama*` → `gpt-oss-120b` **NO** está en la allowlist
  hardcodeada.
- `getConfiguredModels()` (`completion-client.js:193-233`) deriva el modelo desde
  `providers.cerebras.model` y `isAllowedModel()` (`:239-246`) lo acepta vía la
  rama config-aware.
- **Prueba funcional:** `complete({provider:'cerebras', model:'gpt-oss-120b', pipelineDir:'./.pipeline'})`
  devuelve `error.type: http_error` (intenta el request real), **NO**
  `invalid_model` → confirmado que la validación de modelo lo deja pasar.

**Riesgo residual del caché (`:186-231`):** `getConfiguredModels()` cachea por
`statSync().mtimeMs` del `agent-models.json`. `statSync` se ejecuta en **cada**
`complete()`, así que un edit de config que **cambie el mtime** invalida el caché
correctamente. El único desfase posible es un edit que **no cambie el mtime**
(filesystem con resolución de mtime degradada o restore que preserva timestamps)
→ Cerebras podría volver a `invalid_model` terminal hasta el próximo cambio de
mtime o reinicio. **Severidad baja** (escenario improbable). Mitigación futura
posible: invalidación explícita del caché en un hook de edición de config. No se
implementa en este PR (no fue contribuyente del incidente: en HEAD el modelo está
cubierto).

---

## 6. Instrumentación (CA-4) — estado y gaps cerrados

La mayor parte **ya existía** (verificado): `resolveSpawnWithFallback()` emite
eventos a `cross-provider-dispatch-*.jsonl` (`gated_no_fallbacks`,
`fallback_also_gated`, `fallback_no_credentials`, `fallback_selected`,
`chain_exhausted`, `depth_exceeded`…) y `onSpawnExit()` clasifica `errorClass` +
evidence + flag de cuota a `spawn-exit-*.jsonl`.

**Gap cerrado por este PR:** evento de audit **`fallback_health_gated`** (provider
salteado por health-gate, con `health_state` / `health_reason` / `health_age_ms`).

**Redacción (REQ-SEC-1/2/3):** todo `raw_excerpt` de los audit nuevos pasa por
`quotaModule.sanitizeRawExcerpt` (mismo invariante que el resto del dispatcher).
Los campos nuevos (`fallback_provider`, `health_state`, `health_reason`) son
enums/nombres lógicos, **nunca** valores de credenciales. El pre-check de
credenciales (MP-05) sigue reportando **presencia booleana + nombre lógico**, no
el valor. Test `C1` de `health-gate-3809.test.js` asserta que los audit entries
no contienen `*_API_KEY`, `Authorization` ni `*_token`.

---

## 7. Blindajes (CA-5) — propuestos e implementados

### Implementados en este PR

| Blindaje | Item | Esfuerzo | Estado |
|---|---|---|---|
| **Retry `schema_violation` 1×** en la cascada de Sherlock | MP-12 | Simple | ✅ Implementado |
| **Health-gate fail-open** de fallbacks rojo-fresco | MP-09 | Medio | ✅ Implementado |

**Retry MP-12** (`sherlock-verifier.js`): ante `schema_violation`, se reintenta el
**mismo** provider **una sola vez** antes de excluirlo y cascadear. Cap de 1 retry
por provider (`schemaRetried` Set) → sin loop infinito, latencia/tokens acotados.

**Health-gate MP-09** (`dispatch-with-fallback.js`): `resolveSpawnWithFallback()`
consulta `state/multi-provider-health.json` y saltea un **fallback** solo si tiene
`state==="red"` **fresco y confiable** (`last_checked_at` dentro de
`HEALTH_FRESHNESS_MS = 20min`). **FAIL-OPEN** ante incertidumbre: sin entrada,
rojo viejo, sin timestamp, reloj desfasado o snapshot ilegible → **NO** gatea
(preserva la cobertura de la cascada). **Solo aplica a fallbacks**, nunca al
primario (gatear el primario cambiaría el happy path y un falso rojo dejaría al
pipeline sin arranque).

> ⚠️ **Dos políticas opuestas a propósito** (no unificar):
> - **Health-gate (MP-09) = FAIL-OPEN:** ante duda, NO gatea. Objetivo: no reducir
>   cobertura por un rojo transitorio.
> - **Validación de modelos at-request (REQ-SEC-4) = FAIL-CLOSED:** modelo fuera de
>   allowlist+config → `invalid_model`, no se intenta el request. Objetivo:
>   defensa contra config degradada que habilite un modelo/endpoint no previsto.

### Propuesto (NO implementado en este PR)

| Blindaje | Esfuerzo | Nota |
|---|---|---|
| **Detector de degradación simultánea** (3+ eslabones fallan en <2min → alerta) | Medio | Componente genuinamente nuevo. Daría observabilidad temprana del patrón de cascada. Requiere ventana deslizante sobre los audit `.jsonl` + alerta Telegram. Se deja como trabajo futuro referenciable. |
| **Invalidación explícita del caché de `getConfiguredModels`** | Simple | Solo si el escenario mtime-sin-cambio (sección 5) se confirma como real en producción. |

---

## 8. Verificación

```bash
node --test .pipeline/tests/dispatch-with-fallback.test.js \
            .pipeline/tests/health-gate-3809.test.js \
            .pipeline/lib/__tests__/sherlock-verifier.test.js \
            .pipeline/lib/__tests__/completion-client.test.js \
            .pipeline/lib/__tests__/sherlock-soft-timeout-mp01.test.js
# → 145 pass / 0 fail (HEAD 2026-06-03)
```

**Gate de QA:** issue de **infra pura** (`area:infra`, sin `app:*`) → `qa:skipped`
con justificación. Sin UI ni endpoint de producto. Validado por tests unitarios +
verificación estructural de redacción.
