## Reporte de auditoría de seguridad — issue #4507

**Veredicto:** sin hallazgos

**Alcance auditado:** rama `agent/4507-pipeline-dev` (diff vs `origin/main`). Enforcement de entregable obligatorio de `android-dev` en cierre de fase `dev`, excepción explícita `entregable_no_aplica` y fix de clobber por clave idempotente `agente::fase`. Archivos con superficie de seguridad:
- `.pipeline/lib/deliverable-index.js` (nueva API `upsertDeliverableException`, helper `redactAndTruncateMotivo`, normalización `resolvePipelineDir`)
- `.pipeline/lib/deliverable-notify.js` (render del motivo de excepción en Telegram)
- `.pipeline/lib/android-dev-deliverable-guard.js` (decisión pura, sin side effects)
- `.pipeline/pulpo.js` (barrido de cierre)

Fuera de alcance (no tocados): backend Ktor, app Compose, endpoints, auth JWT/Cognito, `redact.js`, `sanitize-payload.js`.

### Hallazgos

Sin hallazgos.

Revisión OWASP:
- **[A01] Broken Access Control** — N/A. Código interno del pipeline sin superficie de autenticación/autorización. El flag `sensible` que rutea el canal del reporte de security se preserva (no modificado).
- **[A02] Cryptographic / Sensitive Data Exposure** — OK. El `motivo` de excepción es texto autor-agente que llega crudo del YAML y se disponibiliza por Telegram. Se redacta en **dos** puntos independientes (defense-in-depth):
  - Índice: `deliverable-index.js` `redactAndTruncateMotivo()` = `redactSecretValue` (AWS/JWT/provider keys) + `redactSensitive` (emails/URLs/PII).
  - Notificación: `deliverable-notify.js:1078-1096` `buildPreview()` aplica la misma composición antes de renderizar.
  - **Verificación empírica:** `redactAndTruncateMotivo("...AKIAIOSFODNN7EXAMPLE... jwt eyJhbGciOiJIUzI1NiJ9....")` → ambos secretos a `[REDACTED]`. Test unitario `#4507 · buildPreview redacta secrets del motivo de excepción` confirma el path de Telegram.
- **[A03] Injection** — OK. Sin `eval`/`child_process`/`exec`/`execSync`/`spawn` en el diff (grep = NONE). `resolvePipelineDir` normaliza con `path.resolve` + `path.basename` sobre `pipelineRoot` interno (nunca input de red). Sin SQL/command/XSS.
- **[A05] Security Misconfiguration** — OK. `pipelineRoot: ROOT → PIPELINE` corrige el índice para que el manifest `fase/sensible` no quede vacío (refuerza trazabilidad #4255 + gate sensible #4514). Cap de `motivo` a 2048 chars con marcador de truncado (anti log/index bloat).
- **[A06] Vulnerable Components** — OK. Sin dependencias nuevas.
- **Secrets hardcodeados** — OK. Grep de `AKIA|Bearer|token=|password=|api_key=` sobre archivos no-test del diff = NONE. `4507.json` sin secretos.

**Tests de respaldo:** 61 pass — `deliverable-notify` (36), `deliverable-index` (10), `android-dev-deliverable-guard` (12), `deliverable-closure-clobber.integration` (3). Incluye caso explícito de redacción de secret en el path de excepción.

### Observación no bloqueante (no genera issue)

Free-text `password=<plaintext>` de baja entropía no es cubierto por las heurísticas de `redact.js`. Es comportamiento **pre-existente** de una lib **no tocada** por este cambio, y la doctrina de handoff ya indica no escribir secrets a propósito. No es defecto introducido por #4507 y clasifica como ruido → no se abre issue de recomendación.
