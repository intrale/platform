# Implementación #4805 — Activación de producto (onboarding→activo)

## Qué se hizo
Se cerró el último eslabón de la cadena de alta: activar un producto desde la UI del dashboard y dejarlo listo para arrancar su primera ola, sin edición manual de estado.

### Cambios (todos en `.pipeline/`)
- **`lib/project-descriptor.js`** — nuevo `transitionStatus({descriptorPath, from, to})`: writer atómico dueño del estado (write a `*.tmp` + `renameSync`, jamás in-place), máquina de estados estricta (`onboarding→active` única arista válida), validación fail-closed del descriptor (== "descriptor completo", detalla campos faltantes) y recompute de `integrity.checksum`. Guardia anti-TOCTOU/anti doble-activación (status actual debe ser `from`). Exports: `transitionStatus`, `isValidStatusEdge`, `STATUS_TRANSITIONS`.
- **`lib/product-control-request.js`** — `enqueueActivate(args, deps)`: acción durable dedicada (no efímera como start/pause). Encola + audita hash-chained (`action=activate`) reusando `auditAndEnqueue`; `isSafeId` fail-closed.
- **`dashboard.js`** — `POST /api/product/activate`: guard `_productGuardRejected()` reusado (gate loopback/Origin + CSRF double-submit), prohibido GET, body ≤16KB, delega en `enqueueActivate`.
- **`views/dashboard/estado-productos.js`** — botón "Activar" (glyph ⏻, token `--in-brand`) habilitado sólo en `onboarding`; "Arrancar" habilitado para activo-sin-ola (`unknown`); client script sin confirm destructivo para Activar (start/pause sí confirman).

### Entrada al supervisor (CA-8)
Automática, sin código nuevo: `kernel-supervisor.bootProducts()` ya instancia 1 pipeline por producto `active` idempotente y omite `onboarding`/`archived`. Verificado por test (flip onboarding→active entre dos reconciliaciones).

## Mapeo de criterios
CA-1 (activación UI), CA-2 (máquina de estados estricta), CA-3 (descriptor incompleto fail-closed server-side), CA-4 (Arrancar habilitado tras activar, con confirm), CA-5 (anti-replay vía CSRF/action-token del endpoint + máquina de estados), CA-6 (isSafeId + guard CSRF), CA-7 (persistencia atómica anti-TOCTOU), CA-8 (supervisor automático), CA-9 (audit hash-chained action=activate).

## Tests
- 149 tests en los 4 módulos tocados; suite completa `.pipeline` verde (6527 pass, 0 fail).

## Nota QA
Toca superficie VISIBLE del dashboard (`estado-productos.js`): `qa:skipped` NO aplica. Requiere evidencia visual de render en verificacion (botones Activar/Arrancar, estados habilitado/deshabilitado, feedback éxito/rechazo).
