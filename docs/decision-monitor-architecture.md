# Decision: Monitor Architecture — Deprecar dashboard terminal

**Issue**: #1180
**Fecha**: 2026-03-03
**Estado**: Implementada

## Contexto

El sistema de monitoreo de sprints contaba con tres componentes:

| Componente | Lineas | Rol |
|------------|--------|-----|
| `dashboard.js` | 1.348 | Dashboard live de terminal (auto-refresh 5s, keyboard, PNG canvas) |
| `dashboard-server.js` | 1.047 | Servidor HTTP en `:3100` (HTML, SSE, Puppeteer screenshots, API) |
| `reporter-bg.js` | 313 | Proceso manager (arranca server + screenshots periodicos a Telegram) |
| **Total** | **2.708** | |

Al lanzar un sprint con `Start-Agente.ps1 all`, se abria automaticamente una nueva ventana PowerShell ejecutando `node dashboard.js` (funcion `Start-MonitorLive`). Simultaneamente, `activity-logger.js` (hook PostToolUse) auto-arrancaba `dashboard-server.js` en background.

## Analisis de overlap

| Capacidad | Telegram | /monitor (skill) | dashboard.js (terminal) | dashboard-server.js (web) |
|-----------|:---:|:---:|:---:|:---:|
| Agente inicia/termina | push | snapshot | live | live SSE |
| CI status | push | snapshot | live | live |
| Sub-task progress | -- | snapshot | live | live |
| Ultima accion | -- | snapshot | live | live |
| Screenshot a Telegram | via reporter | -- | PNG canvas | PNG Puppeteer |
| Zombie detection (wmic) | -- | -- | si | -- |
| Keyboard interaction | -- | -- | si (q/v/r) | -- |

**Conclusion**: `dashboard.js` (terminal) solo aportaba deteccion de zombies via `wmic` y keyboard interaction — pero requeria que alguien estuviera mirando la terminal. El patron de uso real es Telegram (celular) + `/monitor` (on-demand).

## Opciones evaluadas

| Opcion | Descripcion | Reduccion de codigo | Riesgo |
|--------|-------------|---------------------|--------|
| **A** | Status quo | 0 lineas | Ventana desperdiciada |
| **B** | Solo quitar auto-launch | 0 lineas | Minimo, pero no resuelve mantenimiento |
| **B+C** | Quitar auto-launch + deprecar terminal | **-1.348 lineas (50%)** | Bajo |
| **D** | Simplificar todo a <200 lineas | -2.500+ lineas | Alto (rompe web dashboard) |

## Decision: Opcion B+C (hibrida)

**Deprecar y eliminar `dashboard.js` (terminal) + quitar auto-launch de Start-Agente.ps1.**

### Justificacion

1. **Nadie mira la terminal**: el usuario monitorea desde Telegram (celular) durante los sprints
2. **`/monitor` cubre on-demand**: genera snapshots ASCII completos cuando se necesitan
3. **`dashboard-server.js` cubre live**: auto-arranca via `activity-logger.js`, sirve dashboard web en `:3100`, envia screenshots a Telegram
4. **50% de reduccion**: de 2.708 a 1.360 lineas mantenibles
5. **Opciones C y D puras** eran demasiado agresivas: el web dashboard tiene valor activo

### Cambios realizados

1. **Eliminado `.claude/dashboard.js`** (1.348 lineas) — dashboard terminal live, ya no existe
2. **`scripts/Start-Agente.ps1`**: eliminada funcion `Start-MonitorLive` y sus invocaciones; reemplazadas con mensaje informativo apuntando al web dashboard
3. **`.claude/hooks/reporter-bg.js`**: eliminado fallback a `dashboard.js` (solo usa `dashboard-server.js`)
4. **`.claude/skills/monitor/SKILL.md`**: actualizada seccion de ayuda y notas — web dashboard como principal, `/monitor` para on-demand
5. **Limpieza de comentarios**: eliminadas referencias obsoletas en `delivery-report.js` y `telegram-image-utils.js`

### Arquitectura resultante

```
                    Monitoreo de Sprint
 ─────────────────────────────────────────────────────

  [Auto]  activity-logger.js (PostToolUse hook)
    └──> dashboard-server.js (:3100)
           ├── HTML dashboard (dark/light theme)
           ├── SSE live stream (5s)
           ├── /screenshot (Puppeteer PNG)
           ├── /api/status (JSON para /monitor)
           └── Heartbeat periodico → Telegram (screenshots)

  [Push]  Telegram notifications
           ├── Agente inicia/termina (notify-telegram.js)
           ├── CI pass/fail (ci-monitor-bg.js)
           └── Heartbeat PNG (dashboard-server.js)

  [On-demand]  /monitor skill (Claude genera snapshot ASCII)
           └── Lee sessions/*.json + activity-log.jsonl

  [Eliminado]  dashboard.js (terminal live) — deprecado #1180
```

### Metricas

- **Antes**: 2.708 lineas en 3 archivos + funcion Start-MonitorLive
- **Despues**: 1.360 lineas en 2 archivos (dashboard-server.js + reporter-bg.js)
- **Reduccion**: 1.348 lineas (-50%), 1 archivo eliminado, 1 funcion PowerShell eliminada
