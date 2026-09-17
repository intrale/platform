# Rebote QA de #6564 — revisión 1

El 17/09/2026 pipeline-dev verificó los dos claims de QA sobre el HEAD
`9f2ddf9a2065dd8e48becb88a042f985db917d74`. No encontró un defecto de código:
persisten dos faltantes de evidencia operativa. El resultado es rechazado,
con gravedad grave por criterios sin verificar, según el protocolo de rebote.
No corresponde reimplementar el probe ni cambiar los criterios de aceptación.

## CA-1: persistencia posterior a restart

Lectura del marker canónico con PowerShell:

```text
Get-Content C:\Workspaces\Intrale\platform\.pipeline\last-restart.json
{"timestamp":"2026-09-16T09:59:29.511Z","pid":7648}
```

La inspección de `.pipeline/restart.js` confirmó `killAll()` en la ruta
default (línea 933), `syncWithMain()` a continuación y
`annotateAndMoveOrphans` en línea 395. El sync ejecuta
`git reset --hard FETCH_HEAD` (línea 205). La cola activa incluye
`desarrollo/dev/trabajando/6564.pipeline-dev`. No se ejecutó el reinicio:
interrumpiría esta validación y alteraría el lifecycle que controla el Pulpo.
Falta una ventana operativa controlada y evidencia del catálogo posterior
al reinicio en ese mismo entorno. El smoke positivo no reemplaza esa prueba.

## CA-3: entrega en cliente Telegram

Se ejecutaron `emitAlerts` y `defaultTelegramSender` reales con directorio
temporal exclusivo y dedupe nuevo. Salida observada: `ticks: [0, 1, 0]`.
El probe real de catálogo y el de cuota corrieron en ese mismo directorio:
`cli_catalog_ok`, `model_count: 14`, `plan_quota_ok`.
La salida saneada completa está en
`.pipeline/evidence/6564/rev1-live.json` (timestamp 09:42:47 UTC).

Se inspeccionaron las dos páginas renderizadas del PDF de rechazo y
`qa/evidence/6564/screenshot-telegram.png`. La captura declara
«Cola aislada; sin entrega al cliente Telegram» y muestra un renderer del
descriptor. No constituye evidencia de recepción. La consulta
`Get-Process Telegram -ErrorAction SilentlyContinue | Measure-Object`
devolvió `Count: 0`. Esto no descarta una sesión web, pero no hay un cliente
autenticado comprobado y disponible para esta prueba.

Falta capturar el mensaje recibido en un cliente Telegram autenticado,
incluyendo evidencia visual narrada. No se enviaron alertas sintéticas
al operador ni se modificaron colas productivas para simular un incidente.

## Verificaciones adicionales

- Backup: `no-unpushed-commits`. Fetch y merge: `Already up to date.`
- `node --test .pipeline/tests/agy-plan-probe-6564.test.js .pipeline/lib/__tests__/multi-provider-model-catalog-check.test.js`:
  80 pruebas, 80 aprobadas, cero fallos y cero omisiones.
- Git Bash: `bash .pipeline/smoke-test.sh`: `SMOKE TEST OK`, pulpo 11888,
  dashboard 17420, svc-telegram 13560, HTTP 200 y 14 modelos. Advertencia:
  `last-restart.json tiene 85373s (esperado < 300)`.
- El `bash` del PATH resolvió a WSL sin `/bin/bash`; la verificación Gradle
  se relanzó con `C:\Program Files\Git\bin\bash.exe`, sin omitir tests.
  Resultado: `BUILD SUCCESSFUL in 1m 35s`; 343 tareas (168 ejecutadas,
  175 desde caché).

La implementación permanece en la rama `agent/6564-pipeline-dev` para
delivery y revisión humana. No se aplica `qa:skipped` ni se afirma
persistencia post-restart o recepción en Telegram.
