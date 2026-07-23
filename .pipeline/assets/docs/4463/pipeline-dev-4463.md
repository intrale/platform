# #4463 — Encabezado común compartido del dashboard (pills CPU/RAM + uptime Pulpo)

## Qué se hizo
Se extrajo un módulo compartido **`header-meta.js`** (espejo de `nav-tabs.js`) que emite
las pastillas del encabezado (CPU/RAM, uptime del Pulpo + hora) y centraliza su hidratación.
Consumido por las 4 ventanas del issue: **Inicio, Pipeline, Roadmap, Providers**.

## Causa raíz corregida
Cada ventana armaba su propio `<div class="in-header-meta">`. Los satélites, Providers y
Roadmap **no mostraban** las pills de CPU/RAM ni uptime del Pulpo → header inconsistente.

## API del módulo
- `renderHeaderMetaSsr({ withMode })` → markup SSR con IDs invariantes
  (`hdr-resources`, `hdr-pulpo`, `hdr-clock`) + `hdr-mode` opcional.
- `headerPillsClientScript()` → hidratación compartida (umbrales `in-pill-ok/warn/bad`),
  uptime autocontenido (portable a vistas sin `fmtDur`). Sólo `textContent`/`classList`/`title`.
- `headerPillsPollClientScript()` → poller standalone para vistas sin ticker propio (Providers).

## Diseño / seguridad
- Reusa tokens y clases de `theme.css` (`.in-pill*`, `--in-ok/warn/bad`) — sin colores ad-hoc.
- SEC-1/FE-SEC-4: sin `innerHTML` sobre datos de `/api/dash/header`. Endpoint sin cambios.
- IDs literales preservados → snapshot R-G1 de `home.test.js` verde.

## Verificación
- 29 tests nuevos: `header-meta.test.js` + `header-meta-consistency.test.js`.
- Suite completa del dashboard: **450/450 verde**.
- `dashboard-routes.js` carga sin errores (todas las vistas requeridas).

## QA
`qa:skipped` — feature interna de dashboard (`area:infra`, sin `app:*`).
