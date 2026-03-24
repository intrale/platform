 el tema es, si lo deshabilitamos perdemos funcionalidad actual del modelo de operacion, se puede pensar una propuesta superadora que no solo corrija el funcionamiento actual del watcher sino que tambien
mejore la operacion en lineas generales?

● Explore(Analizar watcher y scripts operativos)
  ⎿  Done (33 tool uses · 109.0k tokens · 3m 4s)
  (ctrl+o to expand)

● Excelente, tengo el panorama completo. Ahora entiendo el problema de fondo. Dejame armar la propuesta.

  ---
  Diagnóstico raíz: por qué el watcher satura

  El sistema tiene 7 componentes que compiten por el mismo estado mutable (sprint-plan.json, agent-registry.json, sesiones) sin coordinación:

  ┌──────────────────────────────────┬─────────────────┬───────────────┬───────────────┬─────────────────────┐
  │            Componente            │ Detecta zombies │ Promueve cola │ Lanza agentes │ Escribe sprint-plan │
  ├──────────────────────────────────┼─────────────────┼───────────────┼───────────────┼─────────────────────┤
  │ Start-Agente.ps1                 │ parcial         │ sí            │ sí            │ sí                  │
  ├──────────────────────────────────┼─────────────────┼───────────────┼───────────────┼─────────────────────┤
  │ agent-watcher.js                 │ sí              │ sí            │ sí            │ sí                  │
  ├──────────────────────────────────┼─────────────────┼───────────────┼───────────────┼─────────────────────┤
  │ concurrency-check.js (Stop hook) │ sí              │ sí            │ sí            │ sí                  │
  ├──────────────────────────────────┼─────────────────┼───────────────┼───────────────┼─────────────────────┤
  │ activity-logger.js (PostToolUse) │ sí              │ no            │ no            │ sí                  │
  └──────────────────────────────────┴─────────────────┴───────────────┴───────────────┴─────────────────────┘

  El problema no es solo el watcher — es que hay 4 escritores sin coordinación sobre el mismo archivo, y 3 de ellos pueden promover/lanzar agentes. Resultado: double-promotions, race conditions, y el watcher
  amplificando todo con polling cada 120s.

  ---
  Propuesta: Arquitectura Event-Driven con Coordinador Único

  La idea central: eliminar el polling del watcher y reemplazarlo con un modelo event-driven donde un único coordinador maneja todo el ciclo de vida.

  Cambios propuestos

  1. agent-coordinator.js — Reemplaza al watcher + unifica lanzamiento

  Un único proceso Node.js que:
  - No hace polling — reacciona a eventos via un archivo agent-events.jsonl (append-only)
  - Tiene lock exclusivo sobre sprint-plan.json (el único que escribe)
  - Es el único que lanza agentes (ni Start-Agente ni concurrency-check lanzan)
  - Implementa backoff exponencial en reintentos (no lineal cada 120s)
  - Tiene circuit breaker real: 3 fallos seguidos del mismo agente → marca como failed, notifica Telegram, sigue con la cola

  Flujo:
  Hook Stop → escribe evento a agent-events.jsonl → coordinator lo lee → decide → actúa

  2. Los hooks solo emiten eventos, no deciden

  ┌──────────────────────────────────┬───────────────────────────────────────────────┬────────────────────────────────────────────────────────────────┐
  │               Hook               │                   Hoy hace                    │                           Propuesta                            │
  ├──────────────────────────────────┼───────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ concurrency-check.js (Stop)      │ Detecta zombie + promueve cola + lanza agente │ Solo emite {type: "agent-stopped", session, branch, exit_code} │
  ├──────────────────────────────────┼───────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ activity-logger.js (PostToolUse) │ Heartbeat + zombie detection + dashboard      │ Solo emite {type: "heartbeat", session} + dashboard            │
  ├──────────────────────────────────┼───────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ worktree-guard.js (PreToolUse)   │ Alerta Telegram                               │ Sin cambios (es read-only, está bien)                          │
  └──────────────────────────────────┴───────────────────────────────────────────────┴────────────────────────────────────────────────────────────────┘

  3. sprint-plan.json con escritura atómica

  - Un único writer: agent-coordinator.js
  - Escritura via rename atómico: write → .tmp → rename
  - Los demás componentes solo leen
  - Elimina todas las race conditions de golpe

  4. PID tracking robusto para Windows

  Reemplazar tasklist por:
  - Heartbeat file: cada agente escribe timestamp a agent-{issue}.heartbeat cada 60s
  - Si heartbeat > 3 minutos sin actualizar → muerto (sin depender de PIDs)
  - Elimina completamente el problema de PID reuse

  5. Logs unificados con causalidad

  Un único agent-events.jsonl (append-only, event-sourced):
  {"ts":"...","type":"launched","issue":"#597","pid":1234,"by":"coordinator"}
  {"ts":"...","type":"heartbeat","issue":"#597","session":"abc123"}
  {"ts":"...","type":"stopped","issue":"#597","exit_code":0,"pr":"merged"}
  {"ts":"...","type":"promoted","issue":"#723","from":"queue","slot":2}
  {"ts":"...","type":"failed","issue":"#724","reason":"branch_exists","retry":2}

  Todo trazable, todo en un lugar, con causalidad clara.

  Diagrama del flujo propuesto

  Usuario ejecuta: Start-Agente.ps1 all
           │
           ▼
  ┌─────────────────────┐
  │  Start-Agente.ps1   │  Solo: crear worktrees + lanzar coordinator
  │  (simplificado)     │  Ya NO lanza agentes directamente
  └────────┬────────────┘
           │ spawn detached
           ▼
  ┌─────────────────────────────────────────┐
  │         agent-coordinator.js            │
  │  ┌─────────────────────────────────┐    │
  │  │  Event Loop (fs.watch)          │    │
  │  │  Lee: agent-events.jsonl        │    │
  │  │  Escribe: sprint-plan.json      │    │
  │  │  Lanza: Run-AgentStream.ps1     │    │
  │  └─────────────────────────────────┘    │
  │                                         │
  │  Responsabilidades únicas:              │
  │  • Promoción de cola                    │
  │  • Lanzamiento de agentes              │
  │  • Detección de muerte (heartbeat)     │
  │  • Circuit breaker + backoff           │
  │  • Notificaciones Telegram             │
  │  • Resource checks pre-launch          │
  └─────────────────────────────────────────┘
           ▲                    │
           │ eventos            │ lanza
           │                    ▼
  ┌────────┴──────┐    ┌──────────────────┐
  │  Hooks Claude │    │ Run-AgentStream  │
  │  (solo emiten │    │ (sin cambios)    │
  │   eventos)    │    └──────────────────┘
  └───────────────┘

  Qué ganamos

  ┌────────────────────────────────────────┬───────────────────────────────────────────────┐
  │            Problema actual             │                   Solución                    │
  ├────────────────────────────────────────┼───────────────────────────────────────────────┤
  │ 4 escritores de sprint-plan.json       │ 1 único writer (coordinator)                  │
  ├────────────────────────────────────────┼───────────────────────────────────────────────┤
  │ Double-promotion de cola               │ Solo coordinator promueve                     │
  ├────────────────────────────────────────┼───────────────────────────────────────────────┤
  │ PID reuse → falsos positivos           │ Heartbeat files, sin depender de PIDs         │
  ├────────────────────────────────────────┼───────────────────────────────────────────────┤
  │ Polling cada 120s → lag + saturación   │ Event-driven (fs.watch), reacción inmediata   │
  ├────────────────────────────────────────┼───────────────────────────────────────────────┤
  │ Watcher lanza agentes sin coordinación │ Lanzamiento centralizado                      │
  ├────────────────────────────────────────┼───────────────────────────────────────────────┤
  │ Logs en 4+ archivos                    │ Event log unificado                           │
  ├────────────────────────────────────────┼───────────────────────────────────────────────┤
  │ Reintentos lineales sin límite         │ Backoff exponencial + circuit breaker         │
  ├────────────────────────────────────────┼───────────────────────────────────────────────┤
  │ isValidGitRepo() bloqueando todo       │ Pre-check una vez al inicio, no en cada ciclo │
  └────────────────────────────────────────┴───────────────────────────────────────────────┘

  Qué NO cambia

  - Run-AgentStream.ps1 sigue igual (funciona bien)
  - worktree-guard.js sigue igual (es read-only)
  - El dashboard sigue igual
  - El flujo del usuario no cambia: Start-Agente.ps1 all sigue siendo el entry point

  Complejidad

  Esto es un refactor Grande — toca 4 archivos core. Pero el beneficio es eliminar una clase entera de bugs (race conditions, double-launches, saturación) que hoy causan sprints fallidos.