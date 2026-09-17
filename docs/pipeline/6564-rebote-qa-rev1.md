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

## Reverificación de dev (17/09, 09:46–09:49 UTC)

El backup devolvió `no-unpushed-commits` y el merge `Already up to date.`
Sobre `2f706f18b` se volvió a leer el marker canónico:
`{"timestamp":"2026-09-16T09:59:29.511Z","pid":7648}`.
La búsqueda en restart.js volvió a confirmar `killAll`,
`annotateAndMoveOrphans` y `git reset --hard FETCH_HEAD`.
El trabajo 6564 continúa activo en `trabajando/`; no se ejecutó restart.

El probe de catálogo aislado devolvió `cli_catalog_ok`, `model_count: 14`,
`checked_at: 2026-09-17T09:46:42.932Z`. El de cuota devolvió
`plan_quota_ok` a las 09:47:29.982Z, con ambos grupos semanales.
Esto comprueba la sesión actual, sin demostrar persistencia post-reinicio.

Se inspeccionó nuevamente `qa/evidence/6564/screenshot-telegram.png`:
declara «Ticks: 0 / 1 / 0 mensajes. Cola aislada; sin entrega al cliente
Telegram». La consulta de procesos Telegram volvió a devolver cero.
Esto no descarta una sesión web; no hay cliente autenticado comprobado
ni herramientas de navegador/escritorio disponibles en esta sesión.
La captura existente sigue sin demostrar recepción real.

Pruebas focalizadas: 80 aprobadas, cero fallos. Gradle, ejecutado con Git
Bash tras fallar el launcher WSL del PATH: `BUILD SUCCESSFUL in 1m 34s`,
344 tareas (12 ejecutadas, 332 actualizadas). Smoke: `SMOKE TEST OK`,
HTTP 200, servicios activos y 14 modelos; marker con 85621 segundos.
Los logs de esta pasada quedan en `.pipeline/evidence/6564/*-current.txt`.
La suite completa `node --test .pipeline/tests/*.js` terminó con 2409
casos: 2406 aprobados, cero fallos y tres omisiones (153024,5333 ms).

Persisten los dos impedimentos de evidencia: ventana operativa de reinicio
y acceso al cliente Telegram autenticado para la captura narrada. No se
identificó un defecto funcional que justifique modificar la implementación.

## Reverificación de dev, rebote 2 (17/09, 09:51 UTC)

La rama estaba sincronizada con main y sin commits pendientes de push.
Se verificó nuevamente el marker canónico de restart:
`{"timestamp":"2026-09-16T09:59:29.511Z","pid":7648}`.
`rg -n 'killAll|annotateAndMoveOrphans|reset --hard' .pipeline/restart.js`
confirmó reset en línea 205, reubicación de huérfanos en 395 y killAll en 933.
`Test-Path $env:PIPELINE_TRABAJANDO` devolvió `True`.
No se ejecutó restart; no hay evidencia nueva de persistencia post-reinicio.

`(Get-Process Telegram -ErrorAction SilentlyContinue | Measure-Object).Count`
devolvió `0`. Esto no descarta una sesión web. La inspección visual de
`qa/evidence/6564/screenshot-telegram.png` confirmó el texto
«Ticks: 0 / 1 / 0 mensajes. Cola aislada; sin entrega al cliente Telegram».
No se comprobó acceso a un cliente autenticado ni recepción real.

Verificaciones ejecutadas en esta pasada:
- Node: 80 tests, 80 pass, 0 fail, 0 skipped (953.2152 ms).
- Git Bash, `./gradlew check --no-daemon`: BUILD SUCCESSFUL in 42s;
  344 actionable tasks: 11 executed, 333 up-to-date.
- Git Bash, `.pipeline/smoke-test.sh`: SMOKE TEST OK; pulpo 11888,
  dashboard 17420, svc-telegram 13560, HTTP 200, catálogo de 14 modelos.
  Advertencia real: last-restart.json tiene 85893s (esperado < 300).
- Logs locales: `.pipeline/evidence/6564/{focused,gradle,smoke}-rev2.txt`.

No se identificó un defecto funcional nuevo. Persisten CA-1 y CA-3 sin
verificar. Se consultó disponibilidad de ventana operativa y cliente
Telegram; no se recibió coordinación durante las verificaciones.
El resultado conserva rechazo grave e informa `rebote_categoria: human_block`,
contrato ya reconocido por `.pipeline/lib/rebote-classifier.js`, para describir
el impedimento operativo. El lifecycle permanece a cargo del Pulpo.

## Cierre de CA-1 y CA-3 tras el desbloqueo humano (17/09, 11:44 UTC)

El operador (Leo, 17/09, opción A) aceptó como evidencia de recepción de CA-3
la confirmación de entrega de la API de Telegram (`ok:true` + `message_id`),
el mismo bus de recibos (#4082) con el que se reconcilian los salientes del
Commander. Indicó además no volver a pausar por CA-1 ni CA-3.

### CA-1 · demostrado por el Commander

Reinicio real del runtime posterior al bloqueo:
`.pipeline/runtime-boot.json` → `startedAt = 2026-09-17T09:57:25.014Z`,
`sha = 009fcf5e1`. Verificación posterior sin relogin (comentario del
Commander del 17/09 11:25 UTC): `agy models` rc=0, catálogo de 14 modelos.
Reverificado en esta pasada: `runtime-boot.json` conserva ese `startedAt`.

### CA-3 · entrega real confirmada por la API de Telegram

Cambio: `defaultTelegramSender` (`health-cron.js`) estampa `_correlationId`
en el dropfile de cada alerta de salud; `svc-telegram` ya escribía el recibo
`enviado` con `message_id` para cualquier dropfile con ese campo válido.
Herramienta: `node .pipeline/tools/evidence-telegram-6564.js --real`
(reproduce el 2.º tick de `plan_tier_unknown` con `emitAlerts()` real y
espera el recibo en `servicios/telegram/recibos/`).

Salida real de la corrida:

```
[6564] alerta encolada cid=ev6564-1789645434639-ccba2f1c dropfile=1789645434641-0000-mp-health.json modo=REAL
[6564] entrega confirmada: message_id=140069 at=2026-09-17T11:44:00.210Z
```

Cruce con el log del servicio (`.pipeline/logs/svc-telegram.log`):
`[2026-09-17 11:44:00] [svc-telegram] Enviado: 1789645434641-0000-mp-health.json`.
Recibo escrito por `svc-telegram` (`servicios/telegram/recibos/ev6564-1789645434639-ccba2f1c.json`):
`{"correlationId":"ev6564-1789645434639-ccba2f1c","status":"enviado","messageIds":[140069],"at":"2026-09-17T11:44:00.210Z"}`.
Evidencia persistida: `.pipeline/evidence/6564/telegram-entrega.json`
(`grep -E "@|token|conversation_id|quotaProject"` sobre el archivo: sin matches, CA-5).
Ticks: 1.º → 0 envíos, 2.º → 1 envío (mismo texto que `telegram-sintetico.txt`).
