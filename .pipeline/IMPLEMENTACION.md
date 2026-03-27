# Implementación Pipeline V2

## Estado: COMPLETADA

## Documentación de diseño
- Diseño completo: docs/pipeline-v2-diseno.md
- Revisión hooks/scripts + decisiones: docs/revision-hooks-v2.md

## Cómo arrancar el sistema

```powershell
powershell -File .pipeline/launch-v2.ps1
```

O manualmente:
```bash
node .pipeline/pulpo.js &              # Pulpo (barrido + lanzamiento + intake)
node .pipeline/listener-telegram.js &   # Listener Telegram
node .pipeline/dashboard-v2.js &        # Dashboard web
node .pipeline/servicio-telegram.js &   # Servicio Telegram
node .pipeline/servicio-github.js &     # Servicio GitHub
node .pipeline/servicio-drive.js &      # Servicio Drive (stub)
```

## Fases completadas

### F0 — Bloqueo del modelo V1
- Fecha: 2026-03-27
- Tag backup: `v1-pipeline-backup`
- Hooks: de 18 a 2 (branch-guard + activity-logger)
- Permisos: wildcard `["*"]` + 7 deny
- Worktree-guard: desactivado temporalmente para migración

### F1 — Estructura de carpetas + config.yaml
- Fecha: 2026-03-27
- 54 carpetas creadas en .pipeline/
- config.yaml con pipelines, concurrencia, intake, timeouts

### F2 — Pulpo v0 (barrido + lanzamiento + huérfanos)
- Fecha: 2026-03-27
- `.pipeline/pulpo.js` — ~350 líneas
- Brazos: barrido, lanzamiento, huérfanos
- Soporta builds como script puro (no Claude)

### F3 — Prompts de roles
- Fecha: 2026-03-27
- 15 archivos en `.pipeline/roles/`
- _base.md con instrucciones operativas compartidas
- Roles: po, ux, guru, security, planner, backend-dev, android-dev, web-dev, tester, qa, review, delivery, commander, build

### F4 — Integración E2E
- Fecha: 2026-03-27
- Barrido verificado: archivos en listo/ promovidos correctamente
- Lanzamiento verificado: worktree creado, agente lanzado

### F5 — Intake
- Fecha: 2026-03-27
- Brazo de intake integrado en pulpo.js
- Lee issues de GitHub por label, respeta prioridad
- Deduplicación por find en todo el pipeline

### F6 — Listener Telegram + Commander V2
- Fecha: 2026-03-27
- `listener-telegram.js` — long-polling puro, encola en servicios/commander/pendiente/
- Commander history en commander-history.jsonl
- 8 comandos: /status, /actividad, /intake, /proponer, /pausar, /reanudar, /costos, /help

### F7 — Dashboard V2
- Fecha: 2026-03-27
- `dashboard-v2.js` en puerto 3200
- KPIs: en pipeline, procesados, servicios pendientes
- Vista Kanban por fase con estado por issue
- API JSON en /api/state
- Auto-refresh cada 10s
- Dark theme

### F8 — Servicios fire-and-forget
- Fecha: 2026-03-27
- `servicio-telegram.js` — envía mensajes
- `servicio-github.js` — comentarios y labels
- `servicio-drive.js` — stub (pendiente Google Drive API)

### F9 — Watchdog Task Scheduler
- Fecha: 2026-03-27
- `watchdog.ps1` — vigila Pulpo + Listener
- `launch-v2.ps1` — script de lanzamiento completo + registro en Task Scheduler

### F10 — Limpieza final
- Fecha: 2026-03-27
- IMPLEMENTACION.md actualizado
- settings.json con 2 hooks activos
- settings.local.json con permisos wildcard

## Componentes V2

| Componente | Archivo | Tipo | Líneas est. |
|-----------|---------|------|-------------|
| Pulpo | `.pipeline/pulpo.js` | Node.js | ~400 |
| Listener Telegram | `.pipeline/listener-telegram.js` | Node.js | ~120 |
| Dashboard | `.pipeline/dashboard-v2.js` | Node.js | ~250 |
| Servicio Telegram | `.pipeline/servicio-telegram.js` | Node.js | ~80 |
| Servicio GitHub | `.pipeline/servicio-github.js` | Node.js | ~80 |
| Servicio Drive | `.pipeline/servicio-drive.js` | Node.js | ~50 |
| Watchdog | `.pipeline/watchdog.ps1` | PowerShell | ~30 |
| Launch | `.pipeline/launch-v2.ps1` | PowerShell | ~40 |
| Config | `.pipeline/config.yaml` | YAML | ~60 |
| Roles | `.pipeline/roles/*.md` | Markdown | ~15 archivos |
