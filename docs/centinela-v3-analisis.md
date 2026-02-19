# El Centinela v3 — Analisis Completo y Propuesta de Evolucion

> Documento generado el 2026-02-19 por El Sabueso + analisis de implementacion.
> Objetivo: evolucionar El Centinela de un dashboard estatico Markdown a un monitor
> multi-sesion en tiempo real con auto-refresh.

---

## 1. Estado actual (v2) — Analisis de implementacion

### 1.1 Arquitectura

```
PostToolUse hook (cualquier tool)
        │
        ▼
activity-logger.js ──► .claude/sessions/<id>.json  (per-session)
        │              .claude/session-state.json   (backward compat)
        │              .claude/activity-log.jsonl   (historico)
        ▼
/monitor (slash command) ──► Lee sessions/*.json + TaskList + git + gh
        │
        ▼
Dashboard Markdown estatico (una sola vez, no se refresca)
```

### 1.2 Formato JSON de sesion

```json
{
  "id": "5fd5c8d0",
  "full_id": "5fd5c8d0-0292-4363-8aa7-894636c7bd79",
  "type": "parent",
  "started_ts": "2026-02-19T04:47:43Z",
  "last_activity_ts": "2026-02-19T16:24:03Z",
  "action_count": 28,
  "branch": "docs/agents-automation",
  "agent_name": null,
  "skills_invoked": [],
  "sub_count": 2,
  "permission_mode": "acceptEdits",
  "status": "active"
}
```

### 1.3 Bugs y limitaciones catalogados

| Sev. | Descripcion | Archivo | Linea |
|------|-------------|---------|-------|
| ALTA | `type` nunca se recalcula si el taskdir no existe en el 1er evento | activity-logger.js | ~111 |
| ALTA | `.highwatermark` no refleja actividad reciente — liveness siempre stale | monitor.md | logica principal |
| MEDIA | `status` nunca pasa de `"active"` a `"done"` — no hay hook de cierre | activity-logger.js | ~124 |
| MEDIA | `session-state.json` puede desfasarse 1 action vs el `.json` de sesion | activity-logger.js | ~128-162 |
| MEDIA | Dashboard no se auto-refresca (one-shot Markdown) | monitor.md | arquitectura |
| MEDIA | Emojis wide (🗼🤖🔥) rompen alineacion de columnas box-drawing | monitor.md | formato |
| MEDIA | Sesion actual (`▶`) no tiene mecanismo fiable para auto-detectarse | monitor.md | ~31 |
| BAJA | "Vulcano" no tiene entrada en SKILL_AGENT_MAP | activity-logger.js | ~18-26 |
| BAJA | `TaskOutput` con `session: null` contamina el log | activity-logger.js | ~213 |
| BAJA | Cleanup corre en cada invocacion (I/O por cada tool use) | activity-logger.js | ~241 |
| INFO | `activity-log.jsonl` se mantiene pero el dashboard ya no lo usa | monitor.md | ~135 |

### 1.4 Problema principal: highwatermark vs last_activity_ts

Claude Code actualiza `~/.claude/tasks/<uuid>/.highwatermark` en momentos especificos
del ciclo de vida (inicio, ciertos hitos), **no en cada tool use**. El activity-logger
actualiza `last_activity_ts` en cada PostToolUse.

Evidencia directa: highwatermark con mtime 04:49Z, sesion activa hasta 16:24Z (11.5h de
diferencia). Con umbral de 15 min, el dashboard **siempre** muestra `○` (stale).

**Conclusion:** `last_activity_ts` del JSON de sesion debe ser la fuente **primaria** de
liveness, no el fallback. El highwatermark es util solo como indicador de que el proceso
Claude Code sigue corriendo (vs. fue cerrado abruptamente sin hook Stop).

---

## 2. Limitaciones fundamentales del enfoque actual

### 2.1 Slash commands no pueden auto-refrescarse

Los slash commands de Claude Code generan una respuesta Markdown **estatica**. No hay:
- Streaming continuo despues de la respuesta
- Loop de refresh dentro del contexto del skill
- WebSocket ni long-polling desde el skill
- Mecanismo de "live output" (issues abiertos: #4346, #22718)

Para un dashboard de monitoreo en tiempo real, el slash command `/monitor` es util como
**snapshot manual** pero no puede ser el vehiculo principal.

### 2.2 Markdown no soporta colores ANSI

El bloque triple-backtick renderiza monospace sin colores. Los emojis aportan distincion
visual pero no son equivalentes a colores reales de semaforo. Ademas, los emojis "wide"
(U+1F5FC, U+1F415, etc.) ocupan 2 columnas en terminales Unicode pero pueden ocupar 1 en
el renderer Markdown de Claude Code, rompiendo la alineacion.

### 2.3 Recoleccion de datos es multi-round

Cada ejecucion de `/monitor` requiere 4-5 rounds de tool calls:
1. Glob para listar sesiones
2. Read para cada sesion JSON
3. Bash para git info
4. Bash para gh CLI (CI)
5. Bash para stat highwatermark (por cada sesion)

Esto toma 10-20 segundos. Para un dashboard en tiempo real es inaceptable.

---

## 3. Investigacion: como lo resuelven otros proyectos

### 3.1 Proyectos de referencia directa

| Proyecto | Enfoque | Link |
|----------|---------|------|
| **disler/claude-code-hooks-multi-agent-observability** | Hooks → HTTP POST → SQLite → WebSocket → Vue dashboard | [GitHub](https://github.com/disler/claude-code-hooks-multi-agent-observability) |
| **TheAIuniversity/multi-agent-dashboard** | 68+ agentes, WebSocket + SQLite + Haiku para resumen | [GitHub](https://github.com/TheAIuniversity/multi-agent-dashboard) |
| **Frayo44/agent-view** | Gestor tmux para Claude Code, teclado-first, estado real-time | [GitHub](https://github.com/Frayo44/agent-view) |
| **hallucinogen/agent-viewer** | Kanban web para agentes Claude en tmux, auto-discovery | [GitHub](https://github.com/hallucinogen/agent-viewer) |
| **triepod-ai/multi-agent-observability-with-TTS** | Fork de disler con TTS y SessionEnd hook | [GitHub](https://github.com/triepod-ai/multi-agent-observability-with-TTS) |

### 3.2 Patrones arquitectonicos observados

**Patron A: Hook → Store → UI reactivo**
```
Hook PostToolUse ──► HTTP/File ──► SQLite/JSON ──► WebSocket ──► Browser/TUI
```
Usado por: disler, TheAIuniversity. Maximo desacoplamiento, pero requiere servidor.

**Patron B: tmux + file watching**
```
Sesiones Claude en tmux panes ──► fs.watch() ──► TUI Node.js
```
Usado por: agent-view, agent-viewer. Simple, sin servidor, pero requiere tmux.

**Patron C: Script terminal standalone**
```
setInterval() ──► Lee archivos JSON ──► ANSI render ──► stdout
```
No requiere servidor ni tmux. Maxima simplicidad. Es lo que htop/btop hacen.

### 3.3 Librerias TUI para Node.js

| Libreria | Paradigma | Ideal para |
|----------|-----------|------------|
| **Ink** (React terminal) | Declarativo JSX + Flexbox | TypeScript, componentes reutilizables |
| **neo-blessed** + contrib | Imperativo widgets | Graficas ASCII, tablas ricas, mouse |
| **ANSI puro** (sin deps) | Bajo nivel | Minimo footprint, maxima compatibilidad |
| **terminal-kit** | API mid-level | Input avanzado, 256 colores |

### 3.4 Tecnicas de auto-refresh sin parpadeo

**Metodo 1: Clear + redraw (simple, parpadea)**
```javascript
process.stdout.write('\x1B[2J\x1B[H'); // clear screen + cursor home
renderDashboard();
```

**Metodo 2: Cursor save/restore + line clear (sin parpadeo)**
```javascript
process.stdout.write('\x1B[H');           // cursor home (sin clear)
for (const line of lines) {
  process.stdout.write('\x1B[2K' + line + '\n'); // clear line + write
}
process.stdout.write('\x1B[J');           // clear remaining lines
```

**Metodo 3: fs.watch() reactivo (solo redibuja en cambio)**
```javascript
fs.watch(SESSIONS_DIR, (event, filename) => {
  if (filename?.endsWith('.json')) render();
});
```

---

## 4. Propuesta: El Centinela v3

### 4.1 Arquitectura propuesta

```
                    ┌─────────────────────────────────────┐
                    │ activity-logger.js (hook, sin cambio)│
                    │ Escribe: .claude/sessions/<id>.json  │
                    └──────────────┬──────────────────────┘
                                   │ fs.watch()
                    ┌──────────────▼──────────────────────┐
                    │ .claude/dashboard.js (script standalone)│
                    │ - Lee sessions/*.json + git + gh     │
                    │ - Render ANSI con colores            │
                    │ - Auto-refresh reactivo (fs.watch)   │
                    │ - Fallback setInterval(5s)           │
                    │ - Teclado: q=salir, v=verbose        │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │ Terminal externa (no Claude Code)     │
                    │ $ node .claude/dashboard.js           │
                    └─────────────────────────────────────┘

                    ┌─────────────────────────────────────┐
                    │ /monitor (slash command, simplificado)│
                    │ Snapshot estatico + hint de como      │
                    │ lanzar el dashboard live              │
                    └─────────────────────────────────────┘
```

### 4.2 Dos modos complementarios

#### Modo Live (dashboard.js — terminal externa)

Script Node.js puro sin dependencias externas que:
- Lee `.claude/sessions/*.json` y `activity-log.jsonl`
- Obtiene branch/commit con `execSync('git ...')`
- Obtiene CI status con `execSync('gh run list ...')`
- Renderiza con colores ANSI reales
- Se auto-refresca con `fs.watch()` + fallback `setInterval(5000)`
- Acepta input de teclado: `q` salir, `v` verbose, `r` refresh manual
- Se lanza desde cualquier terminal: `node .claude/dashboard.js`

#### Modo Snapshot (/monitor — slash command)

Se mantiene el slash command actual como snapshot rapido para cuando se necesita
un vistazo desde dentro de Claude Code. Simplificado:
- Prioriza `last_activity_ts` sobre `.highwatermark` para liveness
- Agrega hint al final: "Para monitoreo en tiempo real: `node .claude/dashboard.js`"

### 4.3 Layout del dashboard live

```
┌─ El Centinela v3 ──────────────────── 14:32:07 ─┐
│ Rama: docs/agents-automation  CI: ✅ success      │
├─ SESIONES ──────────────────────────────────────┤
│ ID       │ Agente           │Sub│ Ultima  │ Est.│
│──────────┼──────────────────┼───┼─────────┼─────│
│ 5fd5c8d0 │ El Centinela     │ 2 │ hace 1m │ [●] │
│ a3c7e912 │ Claude           │ 0 │ hace 8m │ [◐] │
│ b1d4f056 │ El Sabueso       │ 1 │ hace 2h │ [○] │
├─ TAREAS ────────────────────────────────────────┤
│ ● #1  Implementar login          Vulcano        │
│ ○ #2  Tests de login             — (◄#1)        │
│ ✓ #3  Research OAuth             Sabueso         │
├─ ALERTAS ───────────────────────────────────────┤
│ ⚠ #2 bloqueada por #1 (in_progress)              │
├─────────────────────────────────────────────────┤
│ [q] Salir  [v] Verbose  [r] Refresh  [s] Solo  │
│     sesiones  [t] Solo tareas                    │
└─────────────────────────────────────────────────┘
```

Con colores ANSI:
- `[●]` verde para activa
- `[◐]` amarillo para idle
- `[○]` gris/dim para stale
- Titulo en cyan bold
- Alertas en rojo
- Bordes en dim white

### 4.4 Mejoras al logger (activity-logger.js)

| Mejora | Descripcion |
|--------|-------------|
| Recalcular `type` | Si `type === "sub"` y ahora el taskdir existe, cambiar a `"parent"` |
| Hook Stop → `status: "done"` | Cuando el hook Stop se dispara, marcar la sesion como `"done"` |
| Throttle cleanup | Solo correr cleanup cada 100 invocaciones, no en cada una |
| Agregar Vulcano al mapa | Mapear un skill `/vulcano` si se crea, o detectar por heuristica |
| Filtrar TaskOutput | Agregarlo a la lista de tools ignorados o asignarle session correcta |

### 4.5 Mejoras al liveness

**Fuente primaria:** `last_activity_ts` del JSON de sesion (actualizado en cada PostToolUse).

**Fuente secundaria:** `.highwatermark` mtime como indicador de que el **proceso** Claude
Code sigue vivo (no solo que hubo actividad de hook). Util para detectar sesiones donde
el hook dejo de ejecutarse pero el proceso sigue (e.g. Claude esta "pensando" sin tool use).

**Nueva logica:**

```
if (last_activity_ts < 5 min)  → ● activa
if (last_activity_ts < 15 min) → ◐ idle
if (last_activity_ts < 60 min AND highwatermark < 60 min) → ○ stale
else → sesion probablemente terminada (no mostrar, o mostrar con ✗)
```

### 4.6 Manejo de emojis en columnas

**Problema:** emojis como 🗼 ocupan 2 columnas en terminales Unicode pero los string
operations de JS cuentan 2 code units. La funcion `padEnd()` no considera ancho visual.

**Solucion para el dashboard live:**

```javascript
// Usa libreria string-width o implementacion manual
function visualWidth(str) {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    // Emoji y CJK = 2 columnas
    if (cp > 0x1F000 || (cp >= 0x4E00 && cp <= 0x9FFF)) w += 2;
    else w += 1;
  }
  return w;
}

function padEndVisual(str, targetWidth) {
  const diff = targetWidth - visualWidth(str);
  return str + ' '.repeat(Math.max(0, diff));
}
```

**Solucion para el slash command (Markdown):** usar nombres sin emoji en la tabla,
y poner el emoji solo en el header o como sufijo separado por espacio.

### 4.7 Deteccion fiable de "sesion actual"

**Para el dashboard live:** no aplica (es un script externo, no una sesion Claude).

**Para el slash command:** el hook activity-logger.js ya recibe `data.session_id` en
cada invocacion. Si el skill `/monitor` dispara un tool use (e.g. Bash), el hook
registra la sesion. La sesion con `last_activity_ts` mas reciente que tenga
`/monitor` en `skills_invoked` es la sesion actual.

Alternativa mas robusta: el slash command puede leer `session-state.json` que siempre
apunta a la sesion mas reciente que disparo un hook — que seria la propia sesion del
monitor (porque el Skill tool use dispara el hook).

---

## 5. Plan de implementacion sugerido

### Fase 1: Fixes criticos al logger (30 min)
- [ ] Cambiar liveness a usar `last_activity_ts` como primario
- [ ] Recalcular `type` en cada invocacion (no solo la primera)
- [ ] Throttle cleanup (cada 100 invocaciones)
- [ ] Actualizar sesion a `"done"` desde hook Stop

### Fase 2: Dashboard live standalone (2-3h)
- [ ] Crear `.claude/dashboard.js` — script Node.js puro sin dependencias
- [ ] Implementar render ANSI con colores de semaforo
- [ ] Implementar fs.watch() + setInterval fallback
- [ ] Implementar teclado (q/v/r/s/t)
- [ ] Obtener git + CI info con execSync
- [ ] Leer tareas desde archivo (el script no tiene acceso a TaskList)

### Fase 3: Simplificar /monitor (30 min)
- [ ] Cambiar logica de liveness a `last_activity_ts`
- [ ] Agregar hint de dashboard live al final
- [ ] Eliminar stat de highwatermark (simplifica a 2-3 rounds de tools)

### Fase 4: Integracion con tareas (opcional)
- [ ] El logger escribe un snapshot de TaskList a `.claude/tasks-snapshot.json`
  cuando detecta tool TaskCreate/TaskUpdate
- [ ] El dashboard live lee ese snapshot para el panel TAREAS

---

## 6. Referencias

### Proyectos de observabilidad para Claude Code
- [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) — Hooks → SQLite → WebSocket → Vue
- [Frayo44/agent-view](https://github.com/Frayo44/agent-view) — Gestor tmux para Claude Code
- [hallucinogen/agent-viewer](https://github.com/hallucinogen/agent-viewer) — Kanban web para agentes Claude

### Librerias TUI Node.js
- [Ink](https://github.com/vadimdemedes/ink) — React para terminal
- [neo-blessed](https://github.com/embarklabs/neo-blessed) — Widgets ncurses en JS
- [cross-platform-terminal-characters](https://github.com/ehmicky/cross-platform-terminal-characters)

### Tecnicas de terminal
- [Build your own CLI with ANSI escape codes](https://www.lihaoyi.com/post/BuildyourownCommandLinewithANSIescapecodes.html)
- [ANSI escape sequences in Node.js](https://2ality.com/2025/05/ansi-escape-sequences-nodejs.html)
- [awesome-tuis](https://github.com/rothgar/awesome-tuis) — Catalogo de TUIs

### Issues relevantes de Claude Code
- [#4346 Live Streaming Text Output for CLI](https://github.com/anthropics/claude-code/issues/4346)
- [#22718 Native Terminal Streaming](https://github.com/anthropics/claude-code/issues/22718)
