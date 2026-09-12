# Precedencia de órdenes de caducidad (#7206, CA-C6)

El worker GitHub conserva en `servicios/github/gate-order-precedence/`
la generación más reciente por número y target (`issue` o `pr`). Aplica a
órdenes `gate-caducidad-sello` de asignación o remoción de `qa:passed`,
`qa:pending` y `qa:skipped`. La generación es el timestamp UTC original al
final del nombre: `-YYYYMMDDHHmmssSSS.json` (productor actual) o epoch de
13 dígitos. No depende del prefijo, mtime ni fecha del reintento.

El recibo se persiste mediante reemplazo atómico antes de invocar GitHub.
Una orden anterior se descarta con `discarded: superseded-gate-order` y
`superseded_by`, incluso después de reiniciar el worker o reintentar una
mutación parcialmente aplicada. La misma generación puede completar sus
acciones y reintentos; una generación posterior puede volver a cerrar QA.
Los productores deben usar una generación posterior para un nuevo veredicto;
órdenes del mismo milisegundo pertenecen a una misma generación, no a dos
veredictos opuestos. Timestamp ausente/inválido o recibo corrupto fallan antes
de la API y siguen el circuito normal de retry/fallido.

El recibo es estado durable del worker: su limpieza durante la existencia de
órdenes antiguas elimina la protección contra reintentos. El diseño conserva
el supuesto actual de un único worker consumidor de la cola GitHub.

La re-ratificación de la parte C debe encolar `qa:passed` con ese mismo origen
y timestamp posterior, para issue y PR por separado, después de verificar el
sello vigente. Este cambio no implementa esa consulta ni modifica la autoridad
del gate de delivery: resuelve la ejecución fuera de orden de sus entregables.
Las mutaciones siguen pasando por el reconciliador de labels existente.

Verificación: `node --test .pipeline/test/servicio-github-gate-labels.test.js
.pipeline/lib/__tests__/gate-order-precedence.test.js`. Cubre prefijos inversos,
retry tras reinicio, fallo parcial de API, caducidad posterior, aislamiento por
destino, retractaciones y estado inválido.
