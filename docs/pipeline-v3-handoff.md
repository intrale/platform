# Handoff cross-agente del pipeline V3

> Issue de origen: [#2993](https://github.com/intrale/platform/issues/2993). Esta doc describe el módulo `.pipeline/lib/handoff.js`, su integración con el pulpo, el contrato con los agentes, las garantías de seguridad, las claves de configuración, la telemetría expuesta al dashboard y el modo de operación / debugging.

## Qué problema resuelve

Cada issue del pipeline pasa por varias fases (`analisis → criterios → sizing → validacion → dev → build → verificacion → linteo → aprobacion → entrega`). Un mismo issue puede ser tomado por agentes distintos con **system prompts distintos** y, en muchos casos, **modelos LLM distintos** (Opus para guru, Sonnet para po, Haiku para builder, etc.). El caching automático del CLI de Claude tiene un pool por **(modelo, system prompt)**: agentes distintos no comparten ese caché aunque trabajen sobre el mismo issue.

Resultado: cada agente que arranca vuelve a leer todo el contexto del issue (body + comments) desde cero, paga tokens por ese material ya procesado y, sobre todo, vuelve a sacar conclusiones que ya sacó el agente anterior.

El handoff cross-agente es un **artefacto markdown liviano por issue** donde cada agente, al cerrar fase, deja una sección descriptiva de **lo que hizo y lo relevante que descubrió**. El próximo agente recibe ese resumen ya inyectado en su `userPrompt` por el pulpo.

## Qué NO es

- **No es** un caché técnico del SDK de Anthropic. El CLI de Claude Code ya tiene su propio prompt-caching automático (TTL 1h). El handoff es ortogonal.
- **No es** una fuente de verdad. Es **informativo**: cualquier decisión de aprobado/rechazado tiene que apoyarse en verificación empírica contra issue/código/output real (paso 7.5 + sección "Handoff cross-agente" de `roles/_base.md`).
- **No es** un dump del issue. Es un resumen procesado por el agente que lo escribió.

## Arquitectura

```
┌──────────────────────────┐                  ┌──────────────────────────┐
│   Agente N (skill A)     │                  │    Agente N+1 (skill B)  │
│   fase: analisis         │                  │    fase: criterios       │
│                          │                  │                          │
│ 1. lee userPrompt        │                  │ 1. lee userPrompt        │
│ 2. trabaja               │                  │    ← <handoff_externo>   │
│ 3. escribe resultado     │                  │       guru analizó X...  │
│ 4. appendSection(...)    │                  │       </handoff_externo> │
│    ↓                     │                  │ 2. trabaja               │
└──────────┼───────────────┘                  └──────────┬───────────────┘
           │                                             ↑
           ▼                                             │
   .pipeline/handoff/<issue>.md ────── readHandoff() ────┘
   (append-only por skill                   (pulpo.js antes
    último-write-by-skill)                   del spawn)
           │
           ├── audit ──► .pipeline/logs/handoff-audit.jsonl
           └── telemetry ──► .claude/activity-log.jsonl  (session:end +
                                                          handoff_in_tokens)
```

### Componentes

| Componente | Responsabilidad |
|---|---|
| `.pipeline/lib/handoff.js` | API pública: `readHandoff`, `appendSection`, `sanitize`, `validateSchema`, `buildPromptBlock`, `resolveConfig`, `shouldInject`. Implementa todas las garantías de seguridad. |
| `.pipeline/pulpo.js` (`lanzarAgenteClaude`) | Antes del spawn: si `handoff.enabled` y la fase está en `inject_in_phases`, inyecta `buildPromptBlock(issue)` al `userPrompt`. Pasa `PIPELINE_HANDOFF_PATH` y `PIPELINE_HANDOFF_ENABLED` al env del hijo. En `child.on('exit')`: lee `readHandoff(issue)` para reportar `handoff_out_bytes` en la telemetría. |
| `.pipeline/roles/_base.md` (paso 7.5) | Contrato con los agentes: si `PIPELINE_HANDOFF_ENABLED=1`, el agente escribe su sección invocando `appendSection(issue, skill, contenido)` ANTES de salir. |
| `.pipeline/lib/traceability.js` | Agrega los campos `handoff_in_tokens`, `handoff_out_bytes`, `handoff_sections_in` al evento `session:end` del activity-log (CA-C1 — solo contadores, jamás contenido). |
| `.pipeline/lib/dashboard-slices.js` (`handoffMetricsSlice`) | Agrega los eventos del activity-log y devuelve hit rate, tokens ahorrados 24h, bytes acumulados 7d, USD/mes estimado y sparkline 7d. |
| `.pipeline/lib/dashboard-routes.js` | Expone `/api/dash/handoff-metrics` y alias `/api/handoff-metrics`. |

### Formato del archivo `<issue>.md`

```markdown
## guru · 2026-05-06T16:01:03.412Z
guru analizó la viabilidad técnica del scope refinado. Confirmó que el punto
de inserción en pulpo.js (~4636) es limpio y que el stack soporta todos los
requisitos. Identificó RT-1..RT-5 como riesgos mitigables dentro del scope.

## security · 2026-05-06T15:51:57.118Z
security identificó la categoría OWASP A03 (prompt injection cross-agente)
como vector principal. Levantó 7 CAs blocker (CA-SEC-1..CA-SEC-7). El handoff
queda APROBADO desde seguridad si esos CAs viajan al diseño.

## po · 2026-05-06T16:13:05.882Z
po consolidó CAs en 4 bloques (A funcionalidad / B seguridad / C telemetría /
D operación). Reusa `lib/redact.js` y `metrics-history.jsonl`. Sin
modificaciones en lógica de skills.
```

### Headers

`## <skill> · <ISO-8601 timestamp UTC>` — match estricto contra `SECTION_HEADER_RE`. El cuerpo NO puede contener headers `#`/`##` adicionales (el módulo los escapa con `\#` defensivamente).

### Política "último write por skill"

Si `guru` escribe dos veces sobre el mismo issue (rebote, rev-2, ...), la segunda invocación reemplaza la sección anterior de `guru`. Las secciones de `po`, `security`, etc. se conservan sin tocar. Mitiga RT-1 (crecimiento sin tope).

## Garantías de seguridad

| CA | Mitigación | Ubicación |
|---|---|---|
| **CA-B1** prompt injection | Denylist hardcoded en `INJECTION_PATTERNS` (en + es). Detección al **escribir** (trunca + audita) y al **leer** (idem, defensa en profundidad). El contenido se inyecta envuelto en `<handoff_externo>` con instructivo explícito de no-autoritatividad. | `lib/handoff.js` → `detectInjection`, `sanitize`, `buildPromptBlock` |
| **CA-B2** schema validado | `## <skill> · <ISO>` único formato aceptado. Headers `#`/`##` en body → escape automático + flag de error. Archivo sin secciones parseables → `validateSchema` devuelve `valid: false` y el módulo cae al fallback (handoff vacío). | `lib/handoff.js` → `validateSchema`, `appendSection` |
| **CA-B3** secrets/PII | Pipeline de redacción que reusa `lib/redact.js` + patrones extra: AWS keys (`AKIA...`), JWT (`eyJ...`), Anthropic (`sk-ant-...`), OpenAI (`sk-...`), GitHub PAT (`ghp_...`, `github_pat_...`), Slack (`xox[abprs]-...`), Google API (`AIza...`), `password=`/`token=` genéricos. Reemplazo por `[REDACTED:<tipo>]`. | `lib/handoff.js` → `sanitize` |
| **CA-B4** path traversal | `validateIssueId` exige `/^\d+$/` con `> 0`; `validateSkillId` exige `/^[a-z][a-z0-9_-]{0,40}$/`. Cualquier otra cosa → throw inmediato. | `lib/handoff.js` |
| **CA-B5** atomic + locking | Lock por issue (archivo `.lock` con PID, stale lock detection). Write atómico: write-to-temp + `rename`. Timeout 5s. | `lib/handoff.js` → `acquireLock`, `appendSection` |
| **CA-B6** tope de tamaño | Default `max_section_kb: 10`. Sobre eso, trunc por bytes (UTF-8 safe) con marcador `[TRUNCATED:section_too_large]`. | `lib/handoff.js` → `appendSection` |
| **CA-B7** auditoría + kill-switch | `.pipeline/logs/handoff-audit.jsonl` registra `{ts, event, issue, skill, bytes, truncated, injection_hits, redacted}` SIN contenido. `kill_switch: true` en config force-disables enabled (puede activarse desde dashboard, no requiere reboot). | `lib/handoff.js` → `appendAudit`; `config.yaml` → `handoff.kill_switch` |
| **CA-A4** fallback obligatorio | Schema corrupto / archivo ilegible → `readHandoff` devuelve `{text:'', sections:[], stats: empty}` + audit. El agente cae al flujo normal (`gh issue view`). El handoff jamás bloquea. | `lib/handoff.js` → `readHandoff` |
| **CA-A5** validez temporal | `retention_days: 30` (default). Secciones con `created_at` más viejo se ignoran al leer. Audita `read_sections_expired`. | `lib/handoff.js` → `readHandoff` |
| **CA-C1** telemetría sin contenido | `session:end` registra solo `handoff_in_tokens` (estimado), `handoff_out_bytes` (size de la sección escrita) y `handoff_sections_in` (cantidad de secciones inyectadas). Jamás texto, jamás hash. | `lib/traceability.js`, `lib/handoff.js` → `estimateTokens` |

## Configuración (`config.yaml`)

```yaml
handoff:
  enabled: false                # ROLLOUT GRADUAL — default OFF
  kill_switch: false            # override total (true → enabled forzado a false)
  max_section_kb: 10            # tope por skill (clamped a [1, 100])
  retention_days: 30            # validez por sección (clamped a [1, 365])
  inject_in_phases:             # whitelist explícita de fases que reciben inyección
    - validacion
    - criterios
    - sizing
    - verificacion
    - aprobacion
    - entrega
```

### Activación recomendada

1. Mergear con `enabled: false`. Verificar smoke test + tests unitarios.
2. Activar en una fase aislada para reducir blast radius:
   ```yaml
   handoff:
     enabled: true
     inject_in_phases: [verificacion]
   ```
3. Observar `/api/handoff-metrics` y `cat .pipeline/logs/handoff-audit.jsonl | jq .` durante ≥3 días.
4. Si aparece `injection_blocked` u otra anomalía → `kill_switch: true` y revisar logs.
5. Ampliar `inject_in_phases` progresivamente.

### Kill-switch operacional

Cualquiera de estos corta el handoff de inmediato sin restart:

- Editar `config.yaml`: `handoff.enabled: false` o `handoff.kill_switch: true`.
- Endpoint del dashboard (futuro): toggle del kill-switch en UI.
- Rollback inmediato: `git revert <commit-de-2993>` y push.

## Endpoint del dashboard

`GET /api/handoff-metrics` (alias de `/api/dash/handoff-metrics`):

```json
{
  "enabled": true,
  "kill_switch": false,
  "sample_window": "7d",
  "sample_size": 240,
  "hit_rate_pct": 73.5,
  "fallback_pct": 26.5,
  "tokens_in_24h": 145000,
  "bytes_out_7d": 380000,
  "usd_saved_estimate_monthly": 13.05,
  "sparkline": [
    {"day":"2026-04-30","pct":68.2,"total":34,"with_handoff":23},
    ...
  ],
  "updated_at": "2026-05-06T16:30:00.000Z"
}
```

Refresh cada 30s desde el cliente (el endpoint es stateless).

## Cómo lo usa el agente (paso 7.5 de `roles/_base.md`)

```js
const handoff = require('.pipeline/lib/handoff');

// al cerrar fase, ANTES de salir, DESPUÉS de escribir el YAML:
if (process.env.PIPELINE_HANDOFF_ENABLED === '1') {
    handoff.appendSection(
        process.env.PIPELINE_ISSUE,
        process.env.PIPELINE_SKILL,
        `${process.env.PIPELINE_SKILL} analizó X y encontró Y. ` +
        `Decidió Z. El próximo agente debería verificar W.`
    );
}
```

Reglas inquebrantables (replicadas en `_base.md` para agentes humanos/LLM):

1. **Narrativa en tercera persona**, jamás imperativo. ❌ "hacé X". ✅ "guru analizó X".
2. **Sin secrets / tokens** (el módulo redacta, pero conviene no escribir a propósito).
3. **Máximo 10KB** por sección. Sobre eso, trunc automático.
4. **El handoff NO es autoritativo**: el próximo agente verifica empíricamente igual.
5. Si fuiste matado por watchdog, gateado por cuota o nunca trabajaste → **NO escribas**.

## Debugging

### El handoff no se inyecta al próximo agente

```bash
# 1. ¿Está activo?
grep -A5 "^handoff:" .pipeline/config.yaml

# 2. ¿La fase está en inject_in_phases?
grep -A8 "^handoff:" .pipeline/config.yaml | grep "<fase>"

# 3. ¿Existe el archivo?
cat .pipeline/handoff/<issue>.md

# 4. ¿Está pasando el schema validator?
node -e "const h=require('./.pipeline/lib/handoff'); const out=h.readHandoff('<issue>'); console.log(JSON.stringify(out, null, 2));"

# 5. ¿Qué dice el audit?
tail -20 .pipeline/logs/handoff-audit.jsonl | jq .
```

### Una sección parece haber sido truncada

```bash
# 1. ¿Trunc por tamaño?
grep "TRUNCATED:section_too_large" .pipeline/handoff/<issue>.md

# 2. ¿Trunc por inyección?
grep "TRUNCATED:prompt_injection" .pipeline/handoff/<issue>.md

# 3. Revisar audit para entender por qué.
grep "<issue>" .pipeline/logs/handoff-audit.jsonl | jq .
```

### El audit dice `injection_blocked` pero no entiendo por qué

```bash
grep "injection_blocked" .pipeline/logs/handoff-audit.jsonl | jq .patterns
```

El campo `patterns` lista los snippets que matchearon. Si fue un falso positivo (caso legítimo confundido con inyección), abrir issue para refinar las regex en `INJECTION_PATTERNS`. Los patrones son intencionalmente conservadores: solo imperativos que invierten el modelo de confianza.

### El widget muestra 0% hit rate aún con feature activo

- ¿Hay events `session:end` con `handoff_in_tokens > 0` en `.claude/activity-log.jsonl`?
  ```bash
  tail -100 .claude/activity-log.jsonl | jq 'select(.event=="session:end" and .handoff_in_tokens > 0)'
  ```
- ¿La fase del agente está en `inject_in_phases`? Si no, el pulpo no inyecta y `handoff_in_tokens` queda en 0.
- ¿El archivo `<issue>.md` existe en `.pipeline/handoff/`? Si no, no hay nada que inyectar (esperable en los primeros runs).

### Race condition con file lock

Si dos agentes cierran fase **al mismo tiempo** sobre el mismo issue (caso real: tester+security+qa en `verificacion`), el lock por issue (CA-B5) serializa los writes. Timeout default 5s — si excede, el segundo escritor falla con `lock timeout` (audit log: `event: write_failed`). En la práctica, las secciones son chicas (<10KB) y el RMW dura <50ms, así que un timeout indica un proceso colgado, no contención normal.

## Limitaciones conocidas

- **Distinto modelo, mismo handoff**: si `guru` corre Opus y `po` corre Sonnet, ambos leen el mismo handoff inyectado en su userPrompt (no hay caché por modelo). El ahorro proviene de **menos tokens cargados** (resumen vs. body completo), no de hit-rate de caché del SDK.
- **Sin historial de revisiones**: la política "último write por skill" no preserva versiones anteriores de la sección de un mismo skill. Si necesitás historial, leé `git log` del archivo (los handoffs no se commitean, así que en la práctica solo está la última versión).
- **Sin compresión**: cada sección se guarda en plano. Para issues con muchas fases, el archivo puede crecer. Mitigaciones: `max_section_kb` por skill + `retention_days` para expirar viejos.
- **No es transaccional cross-issue**: el lock es por issue. Cosas como "actualizar handoff de #X y #Y atómicamente" no existen — no es necesario, los handoffs son por issue.

## Issues de hardening relacionados (no bloquean #2993)

- [#3016](https://github.com/intrale/platform/issues/3016) — Detector reusable de prompt injection para wrappers del pipeline. Si se aprueba, migrar `INJECTION_PATTERNS` de `lib/handoff.js` al módulo central.
- [#3017](https://github.com/intrale/platform/issues/3017) — Filtro reusable de secrets/PII. Si se aprueba, los `SECRET_PATTERNS` de `lib/handoff.js` se mueven allá.
- [#3018](https://github.com/intrale/platform/issues/3018) — Baseline de eficiencia de contexto por issue. Daría datos para validar el ROI real del handoff (CA-D3).
- [#3019](https://github.com/intrale/platform/issues/3019) — Módulo unificado de retention-policy. Reemplazaría la lógica de retention que vive hoy dentro de `lib/handoff.js`.

## Historial

- **#2993** — Implementación inicial: módulo `lib/handoff.js`, integración `pulpo.js`, telemetría, widget dashboard, contrato `_base.md` paso 7.5, doc inicial.
