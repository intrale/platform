# multi-provider-coverage — harness `multi-provider-smoke-test` (#3680)

> **Doc canónico regenerable.** Cada run del harness escribe
> `.pipeline/multi-provider-coverage.json` con la matriz canónica del último
> run. Este doc anota leyenda, advertencias, criterios pendientes y el
> contrato operativo. Hijo A del épico #3669; el hijo B (#3681) entrega el
> widget visual del dashboard sobre este mismo JSON.

---

## TL;DR

El harness invoca cada combinación `(skill × provider)` declarada en
`.pipeline/agent-models.json` (excluyendo skills determinísticos) y produce
una matriz con estados **PASS / WARN / FAIL / SKIPPED / N/A** + bucket
discreto de latencia. El run deja:

- `.pipeline/multi-provider-coverage.json` — matriz canónica (último run).
- `.pipeline/audit/multi-provider-smoke-test-YYYY-MM-DD.jsonl` — hash-chain
  SHA-256 (raw output **nunca** persistido; sólo `evidence_hash`).
- Cola Telegram (`.pipeline/servicios/telegram/pendiente/<ts>-smoke-test-signoff.json`)
  con summary y `tts: true` para narración.
- Issue automático por cada FAIL (labels `bug area:pipeline tipo:recomendacion needs-human priority:high`),
  body con metadata segura (sin raw output del provider — REQ-SEC-10).

---

## Uso

### Pre-requisitos operativos

1. **Ventana de pausa válida (CA-A15)**: el harness aborta si el pipeline
   está corriendo productivo. Antes de ejecutar:
   ```bash
   # Opción A — halt total
   touch .pipeline/.pausa

   # Opción B — pausa parcial con allowed_skills (ruling 3 PO)
   # Editar .pipeline/.partial-pause.json:
   {
     "allowed_issues": [],
     "allowed_skills": ["multi-provider-smoke-test"],
     "created_at": "...",
     "source": "operator"
   }
   ```
   El campo `allowed_skills` es **co-existente** con `allowed_issues`. El
   pre-check del harness valida que su skill esté en una de las dos vías
   (sin sentinels mágicos en `allowed_issues`).

2. **Issues dummy 9999 y 10000 libres**: el harness usa esos números como
   referencia sintética y aborta si existen issues reales con esos números.
   Verificación previa:
   ```bash
   gh api repos/intrale/platform/issues/9999 --jq '.number' && echo "TAKEN" || echo "OK"
   ```

3. **Credenciales presentes** (opcional, sólo para evitar SKIPPED masivos):
   `~/.claude/secrets/credentials.json` con keys para los providers que
   querés probar. Anthropic se autentica por OAuth de la CLI (no env var).

### Ejecución

```bash
# Matriz completa
node .pipeline/tools/multi-provider-smoke-test.js

# Filtrar a un único skill
node .pipeline/tools/multi-provider-smoke-test.js --skill=guru

# Filtrar a un único provider
node .pipeline/tools/multi-provider-smoke-test.js --provider=cerebras

# Filtrar a una combinación específica
node .pipeline/tools/multi-provider-smoke-test.js --skill=qa --provider=gemini-google

# Dry-run (sin invocar providers — útil para validar shape sin gastar quota)
node .pipeline/tools/multi-provider-smoke-test.js --dry-run

# Sin sign-off Telegram ni issues automáticos
node .pipeline/tools/multi-provider-smoke-test.js --no-telegram --no-create-issues
```

Exit codes:

| Code | Significado |
|------|-------------|
| 0    | OK — coverage.json escrito y validado contra schema. |
| 2    | Pre-check falló (ventana, dummy issues, agent-models inválido). |
| 3    | Cap excedido mid-run (`spawns_per_run` o `per_combination`). |
| 4    | Schema validación falló — coverage.json malformado, NO se escribió. |
| 5    | IO al escribir coverage.json. |

---

## Leyenda de estados

| Estado    | Significado                                                           |
|-----------|-----------------------------------------------------------------------|
| **PASS**  | `exit_code == 0`, output well-formed, latencia ≤ 2× baseline Anthropic, sin warnings. |
| **WARN**  | `exit_code == 0` pero latencia 2-5× baseline, divergencia vs baseline, o warnings en stderr. También `errorClass == 'unknown'` (R5 — diagnóstico, no gate productivo). |
| **FAIL**  | `exit_code != 0`, timeout, quota_exhausted, auth error, parser detectó `permanent_failure`, o paths bloqueados por data-residency. |
| **SKIPPED** | Credencial del provider ausente/placeholder (`isPlaceholderOrEmpty`). NO es FAIL — el provider no es responsable. |
| **N/A**   | Combinación no aplica por diseño (`refinar × non-anthropic`, providers fuera del fallback chain del skill, restricciones de data-residency a nivel de policy). |

Latencia se reporta sólo en buckets discretos (CA-A7 / REQ-SEC-9):
`<=100ms`, `<=500ms`, `<=2s`, `<=10s`, `>10s`. **Nunca en ms absolutos**
(timing oracle).

---

## Schema y validación

- **Ubicación**: `.pipeline/multi-provider-coverage.schema.json` (sibling del
  JSON, **no** `.pipeline/schemas/`). Decisión PO ruling 2: alinear con
  convención existente de `agent-models.schema.json` y
  `data-residency-exclusions.schema.json`.
- **Versión Ajv**: 2020-12.
- **Validación**: fail-fast en cada run del harness antes del write atómico
  (`tmp + rename`). Si valida en false → exit 4 + coverage.json NO se escribe.

---

## FORCE_PROVIDER_OVERRIDE (CRÍTICO)

> ⚠️ **`FORCE_PROVIDER_OVERRIDE` NO debe setearse manualmente en runtime
> productivo. Uso exclusivo del harness `multi-provider-smoke-test` via env
> override del spawn child.**

### Defensas en profundidad

1. **Allowlist hardcoded** (CA-A10) en
   `.pipeline/lib/agent-launcher/dispatch-with-fallback.js`:
   ```js
   const FORCED_OVERRIDE_ALLOWED_SKILLS = ['multi-provider-smoke-test'];
   ```
   Cualquier otro skill con el flag → ignorar + audit warning.

2. **Per-spawn env** (CA-A8): el dispatcher lee el flag **sólo** de
   `opts.env` (env del spawn child), nunca de `process.env`. El caller
   (harness) tiene que pasarlo explícito.

3. **Boot validator** (CA-A9) en `pulpo.js` y `restart.js`: si
   `process.env.FORCE_PROVIDER_OVERRIDE` está presente al arrancar el
   pulpo padre → exit 2 + mensaje accionable. Escape hatch:
   `PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE=1` (sólo emergencias documentadas).

4. **Audit dedicado** (CA-A11) hash-chain SHA-256 con
   `event: 'forced_provider_override'`:
   ```json
   {
     "event": "forced_provider_override",
     "skill": "multi-provider-smoke-test",
     "forced_provider": "cerebras",
     "primary_provider_bypassed": "anthropic",
     "source": "smoke-test"
   }
   ```

### Si ves "FORCE_PROVIDER_OVERRIDE prohibido en runtime productivo" en boot

- Unset la variable y reintentar:
  - Windows: `set FORCE_PROVIDER_OVERRIDE=`
  - bash/zsh: `unset FORCE_PROVIDER_OVERRIDE`
- Si es una emergencia documentada (debugging, rollback): activa el escape
  hatch con `set PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE=1` y documentá la
  razón al cerrar el incidente.

---

## Caps inquebrantables (CA-A14)

| Cap | Valor | Justificación |
|-----|-------|---------------|
| `MAX_SPAWNS_PER_RUN` | 60 | Cota global por run. |
| `MAX_PER_COMBINATION` | 1 | No re-ejecutar la misma celda dentro de un run. |
| `CONCURRENCY` | 1 | Spawns serializados — un provider a la vez. |
| `TIMEOUT_PER_SPAWN_MS` | 60000 | 60s máximo por invocación. |

Cualquier exceso → exit 3 + audit `event: 'cap_exceeded'`.

---

## Audit log

- **Archivo**: `.pipeline/audit/multi-provider-smoke-test-YYYY-MM-DD.jsonl`
  (rotación diaria; cada run anclado con `run_id` único en cada entry para
  correlacionar — mitiga R7).
- **Schema por entry** (CA-A17, orden canónico):
  ```json
  {
    "ts": "2026-05-30T12:34:56.789Z",
    "run_id": "run-1717068896789-a1b2c3d4",
    "event": "spawn_dry_run | cell_skipped | cell_na | cap_exceeded | data_residency_blocked | ...",
    "skill": "guru",
    "provider": "gemini-google",
    "model": "gemini-2.0-flash",
    "exit_code": 0,
    "latency_bucket": "<=2s",
    "status": "PASS",
    "raw_excerpt_hash": "sha256:<hex64>",
    "hash_prev": "<GENESIS o hash anterior>",
    "hash_self": "sha256:<hex>"
  }
  ```
- **Raw output NUNCA persistido** (CA-A17). Sólo `raw_excerpt_hash` (SHA-256).
- **Verificación de cadena**: `node -e "console.log(require('./.pipeline/lib/audit-log').verifyChain('./.pipeline/audit/multi-provider-smoke-test-YYYY-MM-DD.jsonl'))"`.

---

## Sign-off Telegram (CA-A18 / CA-A19)

El run encola un archivo en `.pipeline/servicios/telegram/pendiente/` con
shape:

```json
{
  "type": "multi_provider_smoke_test_signoff",
  "run_id": "run-…",
  "summary": { "pass": 42, "warn": 3, "fail": 1, "skipped": 4, "na": 8, "total_combinations": 58 },
  "warn_details": ["skill × provider: razón corta", "…"],
  "fail_details": ["skill × provider: error_class", "…"],
  "fail_issues": [{ "number": 3700, "url": "https://github.com/...", "title": "…" }],
  "run_audit_log": ".pipeline/audit/multi-provider-smoke-test-2026-05-30.jsonl",
  "coverage_json": ".pipeline/multi-provider-coverage.json",
  "tts": true,
  "tts_text": "Smoke test multi-provider terminó: …"
}
```

- Sin curl directo a la API de Telegram.
- Sin `raw_output` ni latencias absolutas.
- `tts: true` activa narración automática por el servicio Telegram
  (memoria `feedback_status-audio.md`).

---

## Issues automáticos por FAIL (CA-A20)

Cada celda FAIL genera un issue con:

- **Labels**: `bug`, `area:pipeline`, `tipo:recomendacion`, `needs-human`,
  `priority:high`.
- **Title**: `[multi-provider-smoke-test] FAIL: <skill> × <provider>`.
- **Body**: sólo metadata cerrada (`skill`, `provider`, `model`,
  `error_class`, `latency_bucket`, `evidence_hash`, `run_id`, link al
  audit log). **Prohibido**: incluir `raw_output` del provider.

---

## Criterios pendientes para futuras iteraciones (CA-A22)

Documentados acá como deuda explícita; no entran en #3680:

1. **(a) Equivalencia semántica real entre providers**: hoy validamos shape
   sintáctico well-formed (opción C). Una equivalencia semántica
   (output1 ≈ output2 para mismo input) requiere infraestructura de
   embeddings + métricas de similitud. Va aparte cuando se priorice.
2. **(b) Extender cobertura a `refinar` con segundo provider**: hoy `refinar`
   entra a la matriz con única columna activa = `anthropic` por diseño (no
   tiene `fallbacks[]`). Si en el futuro hay un provider equivalente para
   refinement, agregarlo a `fallbacks[]` automáticamente lo incluye en la
   matriz (sin tocar este harness).
3. **(c) Reconciliación de Groq**: pendiente en #3671 (Groq descontinuado
   en #3353, pero quedan referencias históricas). No bloquea coverage.

---

## Decisiones PO heredadas del padre (rulings vinculantes)

- **Ruling 1 (CA-A1)**: el harness deriva la lista de skills LLM
  **dinámicamente** desde `agent-models.json`, NO hardcodea 15 ni 17. El
  número observado se reporta en `summary.skills_llm_count`.
- **Ruling 2 (CA-A2)**: el schema vive como **sibling** del JSON
  (`.pipeline/multi-provider-coverage.schema.json`). NO se crea
  `.pipeline/schemas/`.
- **Ruling 3 (CA-A15)**: extender `partial-pause.js` con campo opcional
  `allowed_skills: ["multi-provider-smoke-test"]` co-existente con
  `allowed_issues`. Sin sentinels mágicos. Funciones agregadas:
  `isSkillAllowed(name)` / `isSkillAllowedInState(name, state)`.

---

## Tests obligatorios

```bash
# Tests del módulo core (40 tests).
node --test .pipeline/lib/multi-provider/__tests__/smoke-test.test.js

# Tests del dispatcher con FORCE_PROVIDER_OVERRIDE (24 tests).
node --test .pipeline/tests/dispatch-with-fallback.test.js

# Tests del boot validator (6 tests).
node --test .pipeline/tests/force-provider-override-boot.test.js

# Tests de partial-pause (no-regresión por allowed_skills aditivo).
node --test .pipeline/lib/__tests__/partial-pause.test.js
```

---

## Mapa de archivos del feature

| Path | Rol |
|------|-----|
| `.pipeline/tools/multi-provider-smoke-test.js` | CLI entrypoint Node puro. |
| `.pipeline/lib/multi-provider/smoke-test.js` | Lógica pura testeable (DI). |
| `.pipeline/lib/multi-provider/__tests__/smoke-test.test.js` | Tests unitarios. |
| `.pipeline/multi-provider-coverage.json` | Matriz canónica (último run). |
| `.pipeline/multi-provider-coverage.schema.json` | Schema Ajv 2020-12. |
| `.pipeline/lib/agent-launcher/dispatch-with-fallback.js` | + rama `FORCE_PROVIDER_OVERRIDE`. |
| `.pipeline/lib/partial-pause.js` | + `allowed_skills` aditivo, `isSkillAllowed`. |
| `.pipeline/pulpo.js` | + boot validator del flag. |
| `.pipeline/restart.js` | + boot validator del flag. |
| `.pipeline/tests/dispatch-with-fallback.test.js` | + 6 tests del override. |
| `.pipeline/tests/force-provider-override-boot.test.js` | Tests del boot validator. |

---

## Out of scope (hijo B — widget dashboard #3681)

- Endpoint `/api/dash/multi-provider-coverage`.
- Widget visual en el dashboard V3.
- Mockup `.pipeline/assets/mockups/23-multi-provider-coverage-widget.svg`.
- Iconografía `ic-cell-pass`, `ic-cell-warn`, etc. al `sprite.svg`.
- CA-UX-1 a CA-UX-7 (todos).
- CA-21 a CA-31 del padre #3669.
