# Dashboard Server — Documentación Técnica

**Archivo**: `.claude/dashboard-server.js` (~4700 líneas)
**Puerto**: 3100 (default, configurable con `--port`)
**Inicio**: `node .claude/dashboard-server.js [--port 3100]`
**Auto-stop**: Se cierra si no hay sesiones activas por 30 minutos

## Arquitectura

### Resolución de rutas
Resuelve REPO_ROOT via `git rev-parse --git-common-dir` para funcionar tanto en el repo principal como en worktrees de agentes.

### Dependencias
- `http`, `fs`, `path`, `zlib` (built-in Node.js)
- `puppeteer` (opcional, para screenshots — fallback a `docs/qa/node_modules`)
- `.claude/hooks/permission-utils.js` (clasificación de severidad de permisos)

### Constantes principales
```javascript
DEFAULT_PORT = 3100
SSE_INTERVAL_MS = 5000           // broadcast cada 5s
ACTIVE_THRESHOLD_MS = 5 * 60000  // < 5min = active
IDLE_THRESHOLD_MS = 15 * 60000   // 5-15min = idle
AUTO_STOP_MS = 30 * 60000        // 30min sin sesiones = auto-stop
DATA_CACHE_MS = 2000             // TTL del cache de datos
```

---

## Rutas HTTP

### Páginas HTML

| Ruta | Descripción | Query params |
|------|-------------|--------------|
| `/` | Dashboard completo (todas las secciones) | `?theme=dark\|light`, `?mock=1`, `?nosse=1` |
| `/overview` | Solo panel Ejecución & Agentes | `?theme=` |
| `/flow` | Solo Flujo de agentes (grafo SVG) | `?theme=` |
| `/activity` | Actividad en vivo + Permisos + Métricas | `?theme=` |
| `/roadmap` | Gantt del roadmap (sprints) | `?theme=` |
| `/cicd` | CI/CD runs (GitHub Actions) | `?theme=` |
| `/logs` | Visor de logs en vivo con filtro por agente | `?theme=` |

### APIs JSON

| Ruta | Descripción | Query params |
|------|-------------|--------------|
| `/api/status` | Estado consolidado (sesiones, tareas, CI, alertas) | — |
| `/api/activity` | Actividad ligera (polling para feeds externos) | `?since=ISO8601` |
| `/api/history` | Historial de sesiones y métricas por sprint | `?sprint=SPR-NNN` |
| `/api/logs` | Logs de agentes | `?agents=1` (lista), `?agent=ID&n=50` (log) |

### Screenshots (Puppeteer)

| Ruta | Descripción | Query params |
|------|-------------|--------------|
| `/screenshot` | Screenshot PNG completo | `?w=375&h=640`, `?route=/flow` |
| `/screenshots` | Screenshots divididos top/bottom (base64 JSON) | `?w=600&h=800` |
| `/screenshots/sections` | Screenshots por sección semántica (base64 JSON) | `?w=390` |

### Otros

| Ruta | Descripción |
|------|-------------|
| `/events` | SSE (Server-Sent Events) para auto-refresh |
| `/health` | Health check (`{ status: "ok", uptime, port }`) |

---

## Sistema de Paneles

### Atributos `data-panel`

| Panel | Contenido |
|-------|-----------|
| `exec` | Sprint: agentes activos, cola, completados, fallidos |
| `sessions` | Flujo de agentes (grafo SVG force-directed) |
| `activity` | Feed de actividad en vivo + tabla de permisos |
| `metrics` | KPIs semanales + tabla histórica de agentes |
| `roadmap` | Gantt chart de sprints (5 sprints visibles) |
| `ci` | Tabla de CI/CD runs (últimas 5 ejecuciones) |

### Filtrado por sección (client-side)

Las rutas de sección (`/overview`, `/flow`, etc.) renderizan TODOS los paneles pero ocultan los irrelevantes con JavaScript:

```javascript
var pm = {
  overview: ['exec'],
  flow:     ['sessions'],
  activity: ['activity', 'metrics'],
  roadmap:  ['roadmap'],
  cicd:     ['ci']
};

document.querySelectorAll("[data-panel]").forEach(function(el) {
  if (ps.indexOf(el.getAttribute("data-panel")) === -1)
    el.style.display = "none";
});
```

Adicionalmente, `kpi-row` y `alerts-panel` solo se muestran en `overview`.

---

## Recolección de Datos (`collectData()`)

### Fuentes de datos

| Archivo | Datos |
|---------|-------|
| `scripts/sprint-plan.json` | Agentes activos, cola, completados |
| `scripts/roadmap.json` | Sprints y épocas |
| `.claude/sessions/*.json` | Sesiones activas |
| `.claude/sessions-archive/SPR-NNN/` | Sesiones archivadas |
| `.claude/activity-log.jsonl` | Historial de tool calls |
| `.claude/hooks/agent-metrics.json` | Métricas históricas de agentes |
| `.claude/hooks/agent-registry.json` | Agentes activos en tiempo real |
| `.claude/hooks/pending-questions.json` | Permisos pendientes |
| `.claude/hooks/approval-history.json` | Patrones de aprobación |
| Git (`git log`, `git branch`) | Branch actual, últimos commits |
| GitHub CLI (`gh run list`) | CI runs |

### Cache
- TTL: 2000ms
- Invalidación: si `sprint-plan.json` cambió (mtime check)
- Hit rate: ~90% en uso normal

### Clasificación de sesiones
- **sprintSessions**: rama `agent/NNNN-*` con issue en sprint-plan
- **standaloneSessions**: rama `agent/NNNN-*` pero issue fuera del sprint
- **adhocSessions**: rama `main` o sin rama

---

## SSE (Server-Sent Events)

### Broadcast cada 5 segundos
```json
{
  "reload": true,
  "ts": "ISO8601",
  "activeSessions": 3,
  "idleSessions": 1,
  "totalActions": 542,
  "ciStatus": "ok",
  "alertCount": 0,
  "pendingPermissions": 2,
  "recentActivity": [{ "tool": "Edit", "target": "file.kt", "count": 5, "ts": "..." }]
}
```

### Comportamiento del cliente
- Actualiza KPIs en vivo sin recargar
- `location.reload()` cada 30 segundos para refrescar paneles completos
- Reconexión automática después de 5 segundos si falla

### Broadcast inmediato
Un watcher verifica `sprint-plan.json` cada 1 segundo. Si el mtime cambió, dispara broadcast SSE inmediato (sin esperar los 5s).

---

## Flow Graph (`buildFlowTree`)

### Layered layout
- Layer 0: Start
- Layer 1: Agentes raíz (Agente 1, 2, ...)
- Layer 2: Discovery (PO, UX, Guru, Doc)
- Layer 3: Developers (BackendDev, AndroidDev, WebDev)
- Layer 4: Gates (Tester, QA, Security, Review)
- Layer 5: Delivery (DeliveryManager, Ops, Scrum)
- Layer 6+: Done, Error

### Numeración de edges
Formato `agentNum.stepNum` (ej: "1.1", "1.2", "2.1") — agrupados por agente raíz.

### Grid routing
Convierte a grid Manhattan → simplifica zigzags → genera Bézier SVG.

---

## Gantt Chart (`buildGanttChart`)

- 5 sprints visibles: último done + activo + 3 planeados
- Streams: A (Backend), B (Cliente), C (Negocio), D (Delivery), E (Cross)
- Ancho por sprint: 220px, alto por issue: 44px
- Dependencias como flechas Bézier curvas

---

## Screenshots (Puppeteer)

### `/screenshots/sections` — Secciones semánticas
```javascript
[
  { id: "kpis",             sel: ".kpi-row" },
  { id: "ejecucion",        sel: "[data-panel='exec']" },
  { id: "flujo",            sel: "[data-panel='sessions']" },
  { id: "actividad",        sel: "[data-panel='activity'] .feed-panel" },
  { id: "permisos",         sel: "[data-panel='activity'] .panel:last-child" },
  { id: "uso-agentes",      sel: "[data-panel='metrics'] > .panel:first-child" },
  { id: "metricas-agentes", sel: "[data-panel='metrics'] > .panel:last-child" },
  { id: "roadmap",          sel: "[data-panel='roadmap']",  customWidth: 1200 },
  { id: "ci",               sel: "[data-panel='ci']" }
]
```

- Omite secciones con height < 20px o imagen < 5KB
- `roadmap` usa viewport más ancho (1200px)

---

## Temas

### Dark (default)
```css
--bg: #0a0b10; --surface: #12141d; --text: #e2e4ed;
```

### Light
```css
--bg: #f8fafc; --surface: #ffffff; --text: #1e293b;
```

Toggle con botón en header, persiste en `localStorage`.

### Responsive
- `@media (max-width: 768px)`: KPIs 5→3 columnas, grids stack vertical
- `@media (max-width: 480px)`: KPIs 3→2 columnas, padding reducido

---

## Integración con Telegram

Se integra via `heartbeat-manager.js`:
- Envía reportes periódicos con screenshots
- Detecta y alerta si el server muere
- Mantiene PID en `.claude/hooks/dashboard-server.pid`

---

## Archivos relacionados

| Archivo | Propósito |
|---------|-----------|
| `.claude/dashboard-server.js` | Servidor principal |
| `.claude/hooks/heartbeat-manager.js` | Heartbeat + reportes Telegram |
| `.claude/hooks/permission-utils.js` | Clasificación de severidad |
| `.claude/icons/` | Iconos base64 para skills |
| `scripts/sprint-plan.json` | Plan del sprint activo |
| `scripts/roadmap.json` | Roadmap (fuente de verdad) |
| `.claude/hooks/sessions-history.jsonl` | Historial de sesiones |
