# #4200 — Rediseño DESCANSO (centro de mando MIZPÁ · Ola 7.1)

## Qué cambió
- Cabecera: se reemplazó el header viejo (`in-header-logo "i"` + título plano) por la **barra de marca MIZPÁ** (logo escudo + tagline «Que el Señor vigile» Génesis 31:49 + selector multiproyecto Intrale · 1/3), copia verbatim del patrón de las hermanas ya mergeadas (Ops/Bloqueados/Home).
- **Miga de pan** `⋯ Más › 🌙 Descanso` (Descanso es tab secundario, vive en el popover).
- **Banner de misión** diagnóstico (reemplaza el cartel fino `#rm-status`): tag de estado + lectura automática en lenguaje natural + 4 tiles (Ventana actual · Descanso/semana Xh·Y% · Próxima apertura · En cola por descanso).

## Ya estaba (no requirió cambio)
- Calendario 7 días × 24h, bloques editables con snap 30 min y línea AHORA: entregado por #4185 (EP8-H11) en `buildTimeline()`. CA-1/2/3 ya satisfechos.

## Datos
- Horas/semana: computadas client-side desde `scheduleState` con `expandPeriod` (no hay campo server-side).
- Cola por descanso: alimentada por `wouldPauseSkills` del slice `/api/rest-mode` (skills LLM gateados).

## Verificación
- `node --check` OK. `node --test` descanso+gesture+nav-tabs: 35/35 verde (4 tests nuevos para cabecera MIZPÁ, breadcrumb y banner).
- Render real verificado a string (marca, tagline, selector, breadcrumb, banner, timeline).

## Seguridad
- Banner construido con `createElement` + `textContent` (FE-SEC-1, sin innerHTML). Sin nueva interpolación SSR de datos externos.