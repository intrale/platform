## Reporte de auditoría de seguridad — issue #4732

**Veredicto:** sin hallazgos

**Alcance auditado:** diff `agent/4732-pipeline-dev` vs `origin/main` (commit `5f772d7a8`). Infra/pipeline Node.js, sin superficie de API/UI de producto. 4 módulos + tests:
- `.pipeline/lib/partial-pause-deps.js`
- `.pipeline/lib/gh-title-fetch.js`
- `.pipeline/lib/label-reconciler-core.js`
- `.pipeline/lib/__tests__/wave-snapshot.test.js` + tests de regresión.

### Verificación OWASP

- **[A03] Inyección — sin hallazgos.** `defaultGhRunner` usa `spawnSync(ghPath, args, ...)` con args como array, sin shell → no hay command injection. Además `fetchIssueInfo` valida `Number.isInteger(n) && n > 0` antes de spawnear (`partial-pause-deps.js:210`), cerrando la inyección de flags a `gh issue view` (defensa en profundidad, requisito security §4 del análisis).
- **[A09] Logging — sin hallazgos.** La degradación de `gh` loguea solo `#${n}` + `cause` (exit code / primer renglón de `stderr` / código de spawn), en `partial-pause-deps.js:230` y `:243`. NUNCA vuelca `process.env` ni el `env` expandido del spawn (que arrastra `GH_TOKEN`). Verificado por grep: ninguna línea añadida loguea env.
- **[A08] Integridad — mejora.** La derivación de bloqueo pasa a depender del `state` autoritativo (`CLOSED`) sobre el label residual `blocked:dependencies` (`label-reconciler-core.js:47-58`), eliminando un input envenenable como fuente de decisión.
- **[A04] Diseño (fail-safe ≠ fail-open) — sin hallazgos.** El fail-safe queda acotado a la lectura/render del caché: `resolveOpenDeps` solo bloquea con `state === 'open'` (`partial-pause-deps.js:339,342`); `unknown` nunca deriva bloqueado. `brazo-desbloqueo-core.js` **NO fue tocado** → semántica fail-closed de deps abiertas preservada. La reconciliación de `blocked:dependencies` está gateada a señal explícita de cierre (`sources.state==='CLOSED'` / `isClosed===true`); sin señal no remueve (fail-closed).
- **[A06] Dependencias — sin hallazgos.** Sin cambios en `package.json`/lockfile → sin nueva superficie de CVEs.
- **Secrets:** grep de `token|secret|password|api_key|GH_TOKEN|Bearer` en líneas añadidas → ninguno hardcodeado.

### Hallazgos
Sin hallazgos explotables.

### Evidencia empírica
- Tests de los 4 módulos: `node --test` → **97/97 pass** (incluye CA-1/CA-5 last-known-good, CA-2 CLOSED>blocked, CA-3 reconciler, guard numérico, ENOENT→transient).
- Backend/auth (`SecuredFunction`/JWT/Cognito/Konform) no aplica: el cambio no toca backend ni endpoints.
