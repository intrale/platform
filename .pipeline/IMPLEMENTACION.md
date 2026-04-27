# Implementación Pipeline V3

> **Nomenclatura (2026-04-27, #2801):** Los archivos físicos no llevan sufijo de versión. Renombres aplicados: `dashboard-v2.js` → `dashboard.js`, `launch-v2.ps1` → `launch.ps1`, `lib/v3-*` → `lib/dashboard-*`, `views/v3/` → `views/dashboard/`. La versión queda conceptual (V3 = pipeline determinístico + métricas extendidas) pero no aparece en filenames.

## Estado de V2 (pre-V3): COMPLETADA

## Documentación de diseño
- Diseño completo: docs/pipeline-v2-diseno.md
- Revisión hooks/scripts + decisiones: docs/revision-hooks-v2.md

## Cómo arrancar el sistema

```powershell
powershell -File .pipeline/launch.ps1
```

O manualmente:
```bash
node .pipeline/pulpo.js &              # Pulpo (barrido + lanzamiento + intake)
node .pipeline/listener-telegram.js &   # Listener Telegram
node .pipeline/dashboard.js &        # Dashboard web
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

### F7 — Dashboard
- Fecha: 2026-03-27
- `dashboard.js` en puerto 3200
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
- `launch.ps1` — script de lanzamiento completo + registro en Task Scheduler

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
| Dashboard | `.pipeline/dashboard.js` | Node.js | ~250 |
| Servicio Telegram | `.pipeline/servicio-telegram.js` | Node.js | ~80 |
| Servicio GitHub | `.pipeline/servicio-github.js` | Node.js | ~80 |
| Servicio Drive | `.pipeline/servicio-drive.js` | Node.js | ~50 |
| Watchdog | `.pipeline/watchdog.ps1` | PowerShell | ~30 |
| Launch | `.pipeline/launch.ps1` | PowerShell | ~40 |
| Config | `.pipeline/config.yaml` | YAML | ~60 |
| Roles | `.pipeline/roles/*.md` | Markdown | ~15 archivos |

---

# Pipeline V3 — Skills determinísticos

## Estado: EN CURSO (arrancó 2026-04-22)

## Motivación

Reporte de eficiencia de tokens v2 (`docs/qa/reporte-eficiencia-tokens-v2-2026-04-22.pdf`)
identificó que todo skill se trata hoy como monolito LLM, aunque cada uno tiene 3 fases:
preparación (100% determinística), razonamiento (LLM) y entrega (100% determinística).
Estamos pagando Opus/Haiku para hacer pasos mecánicos (`./gradlew assembleXDebug`,
`git reset --hard main`, `gh pr merge`, agrupar data del activity-log, etc).

Directiva de Leo (2026-04-22): migración **quirúrgica, sin romper el V2**, uno a uno.
No tocar skills creativos (dev/qa/po) donde el LLM aporta valor real a la calidad.

## Nomenclatura

Los skills existentes se clasifican en 2 tipos según su implementación:

- **Skill determinístico** — corre con Node puro (0 tokens LLM). Reemplaza el `claude.exe` por un script en `.pipeline/skills-deterministicos/<skill>.js`.
- **Skill LLM** — corre con `claude.exe` y modelo Claude (flujo V2 clásico). Se mantiene para skills creativos.

No hay palabra nueva más allá del adjetivo. El vocabulario del pipeline (pulpo, fases, ventanas, rebotes, circuit breaker, markers) **se conserva intacto**.

## Tag de arranque

- `v3-workers-deterministicos-start` — snapshot del V2 estable antes del primer merge V3 (tag histórico; mantenemos el nombre del tag pese al cambio de nomenclatura).
- V2 sigue operativo en paralelo hasta que cada skill determinístico se valide.

## Principio de trazabilidad (INNEGOCIABLE)

La capa de observabilidad del V2 **no se toca**. Los skills determinísticos deben aparecer en los mismos sistemas de monitoreo que los skills LLM, sin excepciones:

- **Markers de fase** — `pendiente/`, `trabajando/`, `listo/`, `rebotado/` (contrato idéntico).
- **Heartbeat** — archivo `agent-<pid>.heartbeat` cada 30s (watchdog del Pulpo no los distingue).
- **Activity log** — `.claude/activity-log.jsonl` con eventos `session:start`, `tool:call`, `session:end` y metadata del skill + issue + fase.
- **Dashboard v2** — aparecen como agentes activos con progreso (sub-pasos `metadata.steps`), ruta en el grafo, colores por fase.
- **Telegram notifications** — mismos hooks (`notify-telegram.js` para inicio/fin/rebote).
- **agent-registry** — registro idéntico al skill LLM.
- **Rejection reports** — mismo formato PDF + audio narrado si la fase rebota.

La **única diferencia observable**: el campo `tokens_in/tokens_out = 0` y `model = "deterministic"` en el activity-log (para que las métricas de costo reflejen el ahorro).

## Métricas extendidas V3 — distribuidas en cada migración (directiva 2026-04-22)

El consumo de tokens pasa a ser el KPI central. Se trackea con granularidad:

- Por **agente/skill** (ej: `android-dev`, `builder`, `qa`).
- Por **fase** (ej: `definicion`, `dev`, `build`, `qa`).
- Por **issue de punta a punta** (suma de todos los agentes que tocaron el issue).

Métricas requeridas por agente:

- **Tokens consumidos** (input + output + cache_read + cache_write).
- **Tiempo de ejecución** (wall-clock entre `session:start` y `session:end`).
- **TTS generado** — segundos de audio + caracteres enviados al TTS (por agente/fase). Permite estimar costo OpenAI TTS y detectar agentes verbosos.

### Regla de oro (Leo, 2026-04-22)

La **instrumentación de tokens/tiempo/TTS NO se implementa como issue separado por skill**. Cada issue de migración (builder, reset, cleanup, monitor, cost, branch, delivery) DEBE incorporar como parte de su scope:

1. Emisión de `session:start` y `session:end` con `tokens_in/out`, `cache_read/write`, `model`, `phase`, `issue` y `duration_ms`.
2. Wrapper de TTS (si el skill lo usa) que emita evento `tts:generated` con `chars`, `audio_seconds`, `provider`, `voice`.
3. Verificación de aparición en dashboard + endpoints `/metrics/*` como criterio de aceptación.

Motivo: evitar tener que volver a tocar cada skill para "agregarle" trazabilidad después. Sale completo del primer commit.

El issue **#2477** queda como issue **transversal de convención + capa común**: define el schema de eventos, implementa el helper compartido (`.pipeline/lib/traceability.js`, `.pipeline/lib/tts-logger.js`), el agregador (`aggregator.js`), el dashboard `Consumo` y los endpoints. Pero la instrumentación concreta de cada skill viaja en su propio issue de migración.

## Roadmap de migración (orden acordado con Leo)

Cada migración = un issue + un PR. Respetan siempre ventanas, colas, concurrencia y
circuit breaker del Pulpo — solo cambia *qué* ejecuta el Pulpo cuando libera el slot.

| Orden | Skill | Issue | Por qué primero | Estado |
|-------|-------|-------|-----------------|--------|
| 1 | `builder` | #2476 | 100% mecánico: gradle → parse → reporte | En curso |
| 2 | `reset` | — | Mata procesos + reset main + restart.js (ya existe) | Pendiente |
| 3 | `cleanup` | — | Filtros por path del proyecto | Pendiente |
| 4 | `monitor` | — | Abrir dashboard, ya casi determinístico | Pendiente |
| 5 | `cost` | — | Leer activity-log, agrupar, calcular | Pendiente |
| 6 | `branch` | — | Convenciones de ramas | Pendiente |
| 7 | `delivery` | — | 95% determinístico, PR body podría usar Haiku | Pendiente |

Issues transversales:

- **#2477 Métricas extendidas V3** — convención + capa común (schema, helpers `traceability.js` y `tts-logger.js`, agregador, dashboard `Consumo`, endpoints `/metrics/*`). NO instrumenta skills — cada skill se instrumenta dentro de su propio issue de migración.

## Estructura nueva

```
.pipeline/skills-deterministicos/
├── builder.js       # Skill determinístico (reemplaza claude.exe + skill LLM builder)
├── reset.js
├── cleanup.js
└── ...
```

El Pulpo detecta si un skill tiene implementación determinística en `.pipeline/skills-deterministicos/<skill>.js`:
- Si existe → lanza `node .pipeline/skills-deterministicos/<skill>.js <issue>` (0 tokens).
- Si no existe → sigue lanzando `claude.exe` con el skill (V2 clásico).

## Feedback de errores

Skills determinísticos que encuentran errores no triviales **rebotan al skill LLM
correspondiente** (builder → android-dev/backend-dev) vía el rebote estándar del
Pulpo. Los errores clasificables (OOM, network, timeout) se reintentan sin LLM.

## Convención de commits

- `v3(builder): ...`
- `v3(cleanup): ...`
- etc.

## Dashboard

El header muestra `V3` desde 2026-04-22 (decisión Leo: la etapa actual del pipeline y dashboard es V3, independientemente de cuántos skills determinísticos haya migrados). El indicador adicional `mixto` se enciende cuando hay skills determinísticos conviviendo con skills LLM.

## Plantilla obligatoria para issues de migración (a partir de 2026-04-22)

Todo issue de migración de skill (reset, cleanup, monitor, cost, branch, delivery, futuros) DEBE incluir en su body:

1. **Sección "Migración a skill determinístico"** — qué pasos del skill son mecánicos vs creativos.
2. **Sección "Trazabilidad de tokens/tiempo"** — cómo emite `session:start` / `session:end` con `tokens=0`, `model="deterministic"`, `phase`, `issue`, `duration_ms`. Usa `lib/traceability.js` del #2477.
3. **Sección "Trazabilidad de TTS"** — si el skill genera audio, cómo envuelve la llamada con `lib/tts-logger.js` para emitir `tts:generated` con `chars`, `audio_seconds`, `provider`, `voice`.
4. **Criterios de aceptación de métricas** — verificar que el skill aparece en dashboard `Consumo`, endpoint `/metrics/agents` y endpoint `/metrics/issues/:n`.

No se acepta migración de skill que no contemple estos 4 puntos en su scope original.

