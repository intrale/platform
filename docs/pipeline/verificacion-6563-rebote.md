# Verificación del rebote de #6563 — 2026-09-16

Pipeline Developer retomó la rama `agent/6563-pipeline-dev` después del watchdog.
El backup informó `no-unpushed-commits` y el merge con `origin/main` informó
`Already up to date.`. No se reimplementó la baja.

El log de la primera pasada termina con `Background tasks still running after
600s; terminating.`. El trabajo había quedado dividido entre tareas sin cierre;
los commits posteriores ya contienen la baja, los ajustes de tests y las docs.
Esta pasada ejecutó las verificaciones con concurrencia limitada y agregó dos
regresiones sobre el plantel, la cobertura y la admisión futura de Gemini.

## Evidencia obtenida en esta pasada

- `node .pipeline/lib/agent-models-validate.js`: OK.
- `node .pipeline/lib/multi-provider/validate-chains.js`: 23 skills validados.
- `validate(undefined, {now: new Date('2026-11-01T00:00:00Z')})`: `ok: true`,
  `errors: []`. Gemini conserva `billing: free`, excepción #6564 hasta 2026-12-31.
- `buildMatrixFromAgentModels`: tres proveedores LLM, 19 skills, 47 combinaciones
  elegibles; todos los skills LLM incluyen Codex. Es cobertura estructural,
  no prueba de disponibilidad ni invocación real de los proveedores.
- `node --test --test-concurrency=4 --test-timeout=90000 --test-reporter=tap`
  sobre los tests modificados respecto de `origin/main`: 2062 pass, 0 fail.
- Mismo comando sobre `.pipeline/tests/*.js`: 2351 pass, 0 fail, 3 skipped,
  duración 170306 ms. Las omisiones las declara la suite, sin flags de exclusión.
- `node --test --test-reporter=tap .pipeline/tests/provider-retirement-6563.test.js`:
  2 pass, 0 fail. Se agregó después de iniciar la suite general.
- `bash ./gradlew check --no-daemon`: `BUILD SUCCESSFUL in 2m 45s`;
  `343 actionable tasks: 168 executed, 175 from cache`.
- `bash .pipeline/smoke-test.sh`: `=== SMOKE TEST OK ===`; Pulpo PID 11888,
  dashboard PID 17420, Telegram PID 13560, HTTP 200, catálogo agy válido.

Las cuentas de las suites se superponen; no representan un total de tests únicos.
Los logs de esta pasada están en `.pipeline/tmp-6563-{changed,suite}.tap`,
`.pipeline/tmp-6563-gradle.log` y `.pipeline/tmp-6563-smoke.log` del worktree.
El reporte de coverage dry-run heredado se preservó como evidencia temporal;
no se publica como medición de ejecuciones reales en el JSON operativo.

## Reclamos del rechazo anterior

`git ls-tree -r --name-only HEAD` confirmó la eliminación de los adapters y
quota-adapters retirados. El default de semantic-dedup es `openai-codex` y el
conjunto HTTP de Sherlock conserva Gemini. El diff de la guía contra main es
414 líneas (258 altas, 156 bajas), incluida la sección 17 de rollback.

## Pendiente de CA-6

El smoke resolvió el runtime canónico `C:/Workspaces/Intrale/platform/.pipeline`.
Ese checkout tiene HEAD `009fcf5e1bd5bc2616b3d00abb24a457fe2fe6d5` y su
`last-restart.json` registra `2026-09-16T09:59:29.511Z`. Por lo tanto el smoke
no acredita arranque ni despacho de esta rama. No hubo restart productivo ni
despacho real posterior de este código durante la pasada.

`restart.js` sincroniza main, termina procesos y relanza servicios. Ejecutarlo
sobre el worktree no proporciona un entorno aislado de verificación. La revisión
humana exigida para `.pipeline/` y la integración corresponden a delivery; esta
pasada no abrió PR ni desplegó. El veredicto queda rechazado por CA-6 pendiente:
falta el registro de arranque y la decisión de un despacho real del commit integrado.
Tampoco se asignó `qa:skipped`: el cambio incluye superficie del operador.
