# Verificación del rebote #5113 — 2026-09-10

El rechazo de infraestructura sólo registra salida 1. La pasada anterior dejó
rev-8 (`a2cddcc78`) commiteada y pusheada. Sus 29 regresiones específicas se
ejecutaron nuevamente y pasaron. El archivo procesado conserva el rechazo de QA:
alerta con payload inválido, ausencia de `.paused` y referencia al flag del kernel.

La corrección adapta la llamada a `notifyTelegram` a su contrato estructurado,
inyecta el halt exclusivo en filesystem y selecciona el copy de estado operativo
del mockup 60 dentro del sink existente. El template del catálogo conserva su
comportamiento anterior. La pausa previa no se sobrescribe; el rate-limit de
Telegram no limita la aplicación del halt.

## Evidencia ejecutada

- `node --test .pipeline/tests/*.js`: 2242 pass, 0 fail, 3 skipped declarados por
  las pruebas; sin filtros ni exclusiones agregadas por el agente.
- Suite final `*5113.test.js` en `lib/__tests__` y `tests`: 172 pass, 0 fail.
- Wiring nuevo y `durable-cutover.test.js`: 55 pass, 0 fail.
- `node .pipeline/lib/operational-state-lint.js --check`: 646 archivos, 0 violations.
- `bash .pipeline/smoke-test.sh`: OK; procesos activos y dashboard HTTP 200.
  Advertencia no bloqueante: el último restart tiene más de 300 segundos.

## Ensayo visual narrado

[Video](ensayo.mp4), [captura](preview.png), [salida real](probe.json) y
[guion](narracion.txt). H.264 + AAC, 39,4 segundos. La captura fue inspeccionada.

`node docs/pipeline/evidence/5113-retry/capture.cjs` reproduce el ensayo con
driver controlado, backend/sink/notificador reales y una cola temporal aislada.
Se observa `degraded:true`, un mensaje encolado y `.paused` creado. Las pruebas
automatizadas cubren además ventana cerrada, pausa previa y alertas repetidas.

La vista muestra el texto del dropfile; no es una captura del cliente Telegram
ni acredita entrega externa. El audio narra esa limitación. No se solicitó
`qa:skipped`. La evidencia no acredita cutover de producción ni los bloques B/C
del issue, que permanecen fuera de este PR-1 conforme al alcance del PO.
