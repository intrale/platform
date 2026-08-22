# QA estructural — issue 5821

- Rama: `agent/5821-pipeline-dev`
- Commit: `55e54a85511c89dfeeec2421cb53f2db928bb965`
- PR: https://github.com/intrale/platform/pull/5834
- Preflight UI: sin `area:dashboard` y sin cambios en `dashboard.js`, `mission-ola-eta.js` ni `views/dashboard/`.
- Sintaxis: seis archivos JavaScript válidos; `config.yaml`, fixture JSON y `watchdog.ps1` válidos; documentación existente y no vacía.
- Tests focalizados: 82 pass, 0 fail.
- Suite `.pipeline/lib/__tests__/*.test.js`: 7495 tests, 7493 pass, 0 fail, 2 skipped.

La forma literal `node --test .pipeline/lib/__tests__/` devuelve `MODULE_NOT_FOUND` con Node v24.13.1 en Windows porque interpreta el directorio como módulo. El glob funcional equivalente ejecutó la suite completa en verde.
