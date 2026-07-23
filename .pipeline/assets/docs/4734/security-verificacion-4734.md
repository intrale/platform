## Reporte de auditoría de seguridad — issue #4734

**Veredicto:** sin hallazgos

**Alcance auditado:** commit `973fb5d76` (rama `agent/4734-pipeline-dev`), diff vs merge-base `origin/main` (`4b40c271a`). 2 archivos, +339/-19: `.pipeline/lib/eta-wave.js` y `.pipeline/test-wave-velocity-eta.js`. Cambio de infra Node.js (unificación del ETA de ola: EWMA + ventanas de reposo de proveedor). No toca `SecuredFunction`, JWT/Cognito ni endpoints autenticados.

### Hallazgos
Sin hallazgos.

Verificaciones empíricas sobre las líneas agregadas del diff:

- **[A03 Injection]** grep `eval(`/`exec(`/`execSync`/`child_process`/`innerHTML`/`new Function`/`document.write`/`dangerouslySet`/`spawn` sobre líneas `+` → **0 coincidencias**. Solo 2 `require()` internos (`./provider-schedule`, `./rest-mode-window`) best-effort en try/catch que degradan a `null` (`eta-wave.js:59-60`). Los insumos (`wave-progress.jsonl`, `provider-schedule.json`) son archivos de estado internos del pipeline, no input externo controlable por un atacante.
- **[A03 XSS]** este commit no toca `mission-ola-eta.js` ni el render del dashboard; el diff es aritmético (EWMA, ventanas temporales, proyección de reposo). Sin materialización de HTML.
- **[A02/A05 Secrets]** grep `password`/`secret`/`token`/`api_key`/`AKIA`/`Bearer`/`-----BEGIN`/`Authorization` sobre líneas `+` → **0 coincidencias**. No maneja credenciales.
- **[A06 Dependencias]** `package.json`/`yarn.lock`/`package-lock` no figuran en el diff → sin deps npm nuevas. Se reutilizan módulos internos ya presentes.
- **[A08 Integridad de datos]** `_streamWaveProgress` (`eta-wave.js:740-757`) parsea JSONL por línea con try/catch (`JSON.parse` L753), valida `typeof rec.ts === 'number' && Number.isFinite(rec.ts)` (L756) y `typeof rec.avancePct === 'number' && Number.isFinite(rec.avancePct)` (L757); líneas corruptas → skip sin abortar; archivo ausente → `[]` (L744). Validación `Number.isFinite` también en `spanMs`/`effectiveSpanMs`/`velocity`/`computeMs`/`etaMs`/slopes (L974, L992, L1010, L1017, L1051). Sin `NaN`/`Infinity`/negativos al render (fallback explícito).
- **[DoS]** loops acotados: `_offOverlapMs` `while cursor<t1 && guard<WAVE_OFF_SCAN_MAX_SEGMENTS(500)` (`eta-wave.js:822`); `_projectRestForward` `for i<WAVE_REST_PROJECTION_MAX_ITERS(8)` (`eta-wave.js:1061`). División protegida por `WAVE_MIN_DELTA_MS`.
- **[Timezone/DST]** delegado 100% en `rest-mode-window`/`provider-schedule` (ya validados con `America/Argentina/Buenos_Aires`); no reimplementa parsing horario.
- **Auth/authz** — N/A: sin endpoints, JWT ni `SecuredFunction` en scope.

Tests `node .pipeline/test-wave-velocity-eta.js` → **16/16 verdes**.

Los requisitos de seguridad no bloqueantes de la fase análisis (sin deps npm, parseo defensivo de JSONL, timezone delegado, sin secrets hardcodeados) están **todos cumplidos**.

### Remediación
No aplica — sin hallazgos.

---
> Nota: el rechazo del agente `review` (fase aprobación) sobre este mismo commit es de **cobertura funcional del contrato** (CA-1/CA-3/CA-8: migración de unidad `%/hora`, convergencia de `etaSource`, tests faltantes), **no** de seguridad. Fuera del scope de esta auditoría.
