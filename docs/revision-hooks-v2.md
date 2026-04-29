# Revisión de Hooks y Scripts — Modelo Operativo V2

> Sesión de diseño Leito + Claudio, 2026-03-27.
> Objetivo: revisar cada hook/script activo, evaluar necesidad, simplificación y eliminación con foco en eficiencia de tokens.

## Decisiones tomadas

### 1. `branch-guard.js` (PreToolUse → Bash, 94 líneas)
- **Función:** Impide push directo a main/master
- **Determinístico:** Sí, 100%. No necesita a Claude.
- **Consume tokens:** No
- **Decisión: MANTENER** — pequeño, crítico, barato

### 2. `worktree-guard.js` (PreToolUse → Bash/Edit/Write, 239 líneas)
- **Función:** Impide escribir código si estás parado en main (prevención temprana)
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: MANTENER** — complementa branch-guard (este frena la escritura, aquel frena el push)

### 3. `delivery-gate.js` (PreToolUse → Bash, 306 líneas)
- **Función:** Valida que se hayan ejecutado todos los gates (po, tester, security, review, ux, qa, builder) antes de crear PR
- **Determinístico:** Sí
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — en el nuevo modelo, el barrendero garantiza el orden de fases via filesystem. Si una historia llega a fase 6 (entrega), es porque ya pasó todas las anteriores. El filesystem reemplaza este hook.

### 4. `permission-gate.js` (PreToolUse → universal, 648 líneas + 5 dependencias)
- **Función:** Intercepta cada tool use, clasifica severidad, envía pedido de permiso por Telegram, espera respuesta con reintentos y escalación
- **Determinístico:** Parcialmente (la validación sí, el aprendizaje no)
- **Consume tokens:** Sí — corre en CADA tool use
- **Decisión: ELIMINAR en V2** — reemplazar por auto-aprobación total de permisos

#### Cambio asociado en `settings.local.json`:
- `permissions.allow`: reemplazar las 67 líneas individuales por `["*"]` (wildcard)
- `permissions.deny`: mantener los 7 denys actuales (force push, reset hard, rm -rf)
- Esto hace innecesario el hook y sus 5 dependencias auxiliares:
  - `permission-utils.js` (~682 líneas)
  - `pending-questions.js` (~207 líneas)
  - `approval-history.js` (~116 líneas)
  - `context-reader.js` (~91 líneas)
  - `telegram-message-registry.js` (~109 líneas)
- **Total eliminado: ~1,853 líneas** que dejan de ejecutarse en cada tool use

---

## Resumen parcial (hooks 1-4 de 18)

| Hook | Decisión | Líneas | Ahorro |
|------|----------|--------|--------|
| branch-guard.js | MANTENER | 94 | — |
| worktree-guard.js | MANTENER | 239 | — |
| delivery-gate.js | ELIMINAR V2 | 306 | 306 líneas |
| permission-gate.js + deps | ELIMINAR V2 | 1,853 | 1,853 líneas |
| **Total ahorro parcial** | | | **~2,159 líneas** |

### 5. `activity-logger.js` (PostToolUse → universal, 894 líneas)
- **Función:** Registra cada tool use en un JSONL. Pero hoy también hace: gestión de sesiones, detección de stale/zombie, lanzamiento de dashboard server, detección de estados de espera (CI/build/merge)
- **Determinístico:** Sí, 100%
- **Consume tokens:** No directamente, pero corre en cada tool use con bastante I/O
- **Decisión: MANTENER pero reducir drásticamente** — de 894 a ~150 líneas estimadas

#### Qué queda:
- Logger puro con 6 dimensiones de filtrado:
  1. **Agente** (rol: backend-dev, qa, po, etc.)
  2. **Instancia** (identificador único de esa ejecución del agente)
  3. **Issue** (historia que se está trabajando)
  4. **Fase** (en qué fase del pipeline V2 estaba: definición/desarrollo/verificación/etc.)
  5. **Tool** (qué herramienta usó — ya existe)
  6. **Target** (sobre qué archivo/comando operó — ya existe)

#### Qué se elimina:
- Gestión de sesiones (archivos en `sessions/`) — en V2 el estado está en carpetas de fases
- Detección de sesiones stale — innecesario sin sesiones
- Detección de sesiones zombie (PID muerto) — innecesario sin sesiones
- Lanzamiento de dashboard server — no es responsabilidad de un logger
- Detección de estados de espera (CI/build/merge) — no es responsabilidad de un logger
- AGENT_MAP hardcodeado de 30+ skills — se reemplaza por dato que viene del agente
- **Reducción estimada: ~744 líneas eliminadas**

#### Uso previsto del log:
- Filtrar trazas por agente, instancia o issue desde dashboard o CLI
- Base para reportes de actividad y costos

---

## Resumen parcial (hooks 1-5 de 18)

| Hook | Decisión | Líneas actuales | Líneas V2 | Ahorro |
|------|----------|----------------|-----------|--------|
| branch-guard.js | MANTENER | 94 | 94 | — |
| worktree-guard.js | MANTENER | 239 | 239 | — |
| delivery-gate.js | ELIMINAR V2 | 306 | 0 | 306 |
| permission-gate.js + deps | ELIMINAR V2 | 1,853 | 0 | 1,853 |
| activity-logger.js | SIMPLIFICAR | 894 | ~150 | ~744 |
| **Total ahorro parcial** | | | | **~2,903 líneas** |

---

### 6. `post-tool-orchestrator.js` (PostToolUse → universal, 390 líneas)
- **Función:** Dispatcher que ejecuta 4 subsistemas después de cada tool use: ensure-permissions, permission-tracker, agent-progress, session-gc
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — los 4 subsistemas quedan obsoletos:
  1. **Ensure permissions** → innecesario con `allow: ["*"]`
  2. **Permission tracker** → innecesario con `allow: ["*"]`
  3. **Agent progress** → dependía de sesiones que se eliminan
  4. **Session GC** → innecesario sin sesiones
- También elimina la dependencia residual de `permission-utils.js`

---

## Resumen parcial (hooks 1-6 de 18)

| Hook | Decisión | Líneas actuales | Líneas V2 | Ahorro |
|------|----------|----------------|-----------|--------|
| branch-guard.js | MANTENER | 94 | 94 | — |
| worktree-guard.js | MANTENER | 239 | 239 | — |
| delivery-gate.js | ELIMINAR V2 | 306 | 0 | 306 |
| permission-gate.js + deps | ELIMINAR V2 | 1,853 | 0 | 1,853 |
| activity-logger.js | SIMPLIFICAR | 894 | ~150 | ~744 |
| post-tool-orchestrator.js | ELIMINAR V2 | 390 | 0 | 390 |
| **Total ahorro parcial** | | | | **~3,293 líneas** |

---

### 7. `commander-launcher.js` (PostToolUse → universal, 451 líneas)
- **Función:** En cada tool use, verifica si el Telegram Commander y el Agent Watcher están vivos y los relanza si se cayeron
- **Determinístico:** Sí, 100%
- **Consume tokens:** No, pero corre en cada tool use (overhead de chequeo de PID)
- **Decisión: ELIMINAR en V2** — reemplazado por infraestructura de SO

#### Decisión de infraestructura asociada: Watchdog via Windows Task Scheduler

El Telegram Commander es el punto de contacto del usuario con el sistema. Debe estar **siempre disponible**, incluso cuando no hay agentes corriendo. El mecanismo actual (hook que chequea en cada tool use) no garantiza eso — si no hay agentes, nadie chequea.

**Solución:** Una tarea programada de Windows (Task Scheduler) que cada 1-2 minutos ejecuta un script PowerShell (~20 líneas) que verifica si los procesos críticos están vivos y relanza los que falten.

**Cadena de confianza:**
```
Windows Task Scheduler (inmortal, del SO)
  └─ vigila → Telegram Commander (punto de contacto del usuario)
  └─ vigila → Barrendero (motor del pipeline V2)
```

**Ventajas sobre el mecanismo actual:**
- Funciona aunque no haya ningún agente corriendo
- Funciona aunque se caiga el barrendero (el usuario se entera por Telegram y puede relanzarlo)
- Funciona tras reinicio de máquina
- No penaliza a los agentes con chequeos en cada tool use
- Es independiente del modelo operativo — no hay que cambiarlo si cambia la arquitectura

---

## Resumen parcial (hooks 1-7 de 18)

| Hook | Decisión | Líneas actuales | Líneas V2 | Ahorro |
|------|----------|----------------|-----------|--------|
| branch-guard.js | MANTENER | 94 | 94 | — |
| worktree-guard.js | MANTENER | 239 | 239 | — |
| delivery-gate.js | ELIMINAR V2 | 306 | 0 | 306 |
| permission-gate.js + deps | ELIMINAR V2 | 1,853 | 0 | 1,853 |
| activity-logger.js | SIMPLIFICAR | 894 | ~150 | ~744 |
| post-tool-orchestrator.js | ELIMINAR V2 | 390 | 0 | 390 |
| commander-launcher.js | ELIMINAR V2 | 451 | 0 | 451 |
| **Total ahorro parcial** | | | | **~3,744 líneas** |

**Nuevo componente V2:** Script watchdog para Task Scheduler (~20 líneas)

---

### 8. `health-check.js` (PostToolUse → universal, 939 líneas)
- **Función:** En cada tool use (con cooldown de 2-10 min), verifica salud del sistema: commander vivo, approvers huérfanos, bot Telegram, settings válidos, hooks presentes, worktrees muertos. Auto-repara o notifica.
- **Determinístico:** Sí, 100%
- **Consume tokens:** No, pero son 939 líneas que se evalúan periódicamente
- **Decisión: ELIMINAR en V2** — todo lo que verifica desaparece o se cubre con el watchdog del Task Scheduler:
  - Commander vivo → cubierto por watchdog (hook 7)
  - Permission-approvers huérfanos → eliminados (hook 4)
  - Bot Telegram → chequeable desde el watchdog
  - Settings JSON → con `allow: ["*"]` el riesgo de corrupción baja drásticamente
  - Hooks presentes → chequeo estático que se hace una vez al inicio, no en cada tool use
  - Worktrees muertos → en V2 con agentes persistentes no hay worktrees efímeros

---

## Resumen parcial (hooks 1-8 de 18)

| Hook | Decisión | Líneas actuales | Líneas V2 | Ahorro |
|------|----------|----------------|-----------|--------|
| branch-guard.js | MANTENER | 94 | 94 | — |
| worktree-guard.js | MANTENER | 239 | 239 | — |
| delivery-gate.js | ELIMINAR V2 | 306 | 0 | 306 |
| permission-gate.js + deps | ELIMINAR V2 | 1,853 | 0 | 1,853 |
| activity-logger.js | SIMPLIFICAR | 894 | ~150 | ~744 |
| post-tool-orchestrator.js | ELIMINAR V2 | 390 | 0 | 390 |
| commander-launcher.js | ELIMINAR V2 | 451 | 0 | 451 |
| health-check.js | ELIMINAR V2 | 939 | 0 | 939 |
| **Total ahorro parcial** | | | | **~4,683 líneas** |

---

### 9. `post-git-push.js` (PostToolUse → Bash, 220 líneas)
- **Función:** Detecta `git push`, lanza monitoreo de CI (poll GitHub Actions cada 30s), marca agente como "waiting" en sprint-plan.json y promueve siguiente de cola
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — ambas funciones quedan cubiertas:
  - Monitoreo de CI → lo cubre la Fase 3 (BUILD) del pipeline, que es un script puro
  - Promoción de cola → la maneja el barrendero via filesystem

---

## Resumen parcial (hooks 1-9 de 18)

| Hook | Decisión | Líneas actuales | Líneas V2 | Ahorro |
|------|----------|----------------|-----------|--------|
| branch-guard.js | MANTENER | 94 | 94 | — |
| worktree-guard.js | MANTENER | 239 | 239 | — |
| delivery-gate.js | ELIMINAR V2 | 306 | 0 | 306 |
| permission-gate.js + deps | ELIMINAR V2 | 1,853 | 0 | 1,853 |
| activity-logger.js | SIMPLIFICAR | 894 | ~150 | ~744 |
| post-tool-orchestrator.js | ELIMINAR V2 | 390 | 0 | 390 |
| commander-launcher.js | ELIMINAR V2 | 451 | 0 | 451 |
| health-check.js | ELIMINAR V2 | 939 | 0 | 939 |
| post-git-push.js | ELIMINAR V2 | 220 | 0 | 220 |
| **Total ahorro parcial** | | | | **~4,903 líneas** |

**Nuevos componentes V2:** Script watchdog para Task Scheduler (~20 líneas)

---

### 10. `post-issue-close.js` (PostToolUse → Bash, 470 líneas)
- **Función:** Al detectar `gh issue close`, verifica labels de QA (qa:passed/qa:skipped). Si faltan, mueve a "QA Pending" y notifica por Telegram. También reconcilia sprint-plan.json.
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — ambas funciones quedan cubiertas:
  - Gate de QA → lo garantiza la Fase 4 (VERIFICACIÓN) del pipeline; si no pasó QA, la historia no avanza
  - Reconciliación de sprint-plan → no hay sprint-plan, el estado está en carpetas de fases

---

## Resumen parcial (hooks 1-10 de 18)

| Hook | Decisión | Líneas actuales | Líneas V2 | Ahorro |
|------|----------|----------------|-----------|--------|
| branch-guard.js | MANTENER | 94 | 94 | — |
| worktree-guard.js | MANTENER | 239 | 239 | — |
| delivery-gate.js | ELIMINAR V2 | 306 | 0 | 306 |
| permission-gate.js + deps | ELIMINAR V2 | 1,853 | 0 | 1,853 |
| activity-logger.js | SIMPLIFICAR | 894 | ~150 | ~744 |
| post-tool-orchestrator.js | ELIMINAR V2 | 390 | 0 | 390 |
| commander-launcher.js | ELIMINAR V2 | 451 | 0 | 451 |
| health-check.js | ELIMINAR V2 | 939 | 0 | 939 |
| post-git-push.js | ELIMINAR V2 | 220 | 0 | 220 |
| post-issue-close.js | ELIMINAR V2 | 470 | 0 | 470 |
| **Total ahorro parcial** | | | | **~5,373 líneas** |

---

### 11. `post-merge-qa.js` (PostToolUse → Bash, 310 líneas)
- **Función:** Después de un merge exitoso a main, verifica labels de QA en el issue asociado. Si faltan, agrega `qa:pending` y notifica por Telegram.
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — misma justificación que hook 10: el pipeline de fases impide que algo llegue a merge sin haber pasado QA en Fase 4 (VERIFICACIÓN)

---

## Resumen parcial (hooks 1-11 de 18)

| Hook | Decisión | Líneas actuales | Líneas V2 | Ahorro |
|------|----------|----------------|-----------|--------|
| branch-guard.js | MANTENER | 94 | 94 | — |
| worktree-guard.js | MANTENER | 239 | 239 | — |
| delivery-gate.js | ELIMINAR V2 | 306 | 0 | 306 |
| permission-gate.js + deps | ELIMINAR V2 | 1,853 | 0 | 1,853 |
| activity-logger.js | SIMPLIFICAR | 894 | ~150 | ~744 |
| post-tool-orchestrator.js | ELIMINAR V2 | 390 | 0 | 390 |
| commander-launcher.js | ELIMINAR V2 | 451 | 0 | 451 |
| health-check.js | ELIMINAR V2 | 939 | 0 | 939 |
| post-git-push.js | ELIMINAR V2 | 220 | 0 | 220 |
| post-issue-close.js | ELIMINAR V2 | 470 | 0 | 470 |
| post-merge-qa.js | ELIMINAR V2 | 310 | 0 | 310 |
| **Total ahorro parcial** | | | | **~5,683 líneas** |

---

### 12. `stop-notify.js` (Stop, 583 líneas)
- **Función:** Al terminar un agente, envía resumen a Telegram (card/texto) con issue, tareas, PR, duración. Marca sesión como "done".
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — en un flujo Kanban continuo, notificar cada finalización de agente es ruido. La información pasa a ser **consultas bajo demanda** del Telegram Commander:
  - "¿En qué estado está el issue X?" → fase actual, agente, qué falta
  - "Últimos N issues finalizados" → lista con timestamps
  - "Actividad últimos N minutos" → issues con movimiento reciente
  - "¿Qué issues están en fase X?" → filtro por fase
- Todo consultable leyendo el filesystem de fases, sin hooks ni sesiones

---

## Resumen parcial (hooks 1-12 de 18)

| Hook | Decisión | Líneas actuales | Líneas V2 | Ahorro |
|------|----------|----------------|-----------|--------|
| branch-guard.js | MANTENER | 94 | 94 | — |
| worktree-guard.js | MANTENER | 239 | 239 | — |
| delivery-gate.js | ELIMINAR V2 | 306 | 0 | 306 |
| permission-gate.js + deps | ELIMINAR V2 | 1,853 | 0 | 1,853 |
| activity-logger.js | SIMPLIFICAR | 894 | ~150 | ~744 |
| post-tool-orchestrator.js | ELIMINAR V2 | 390 | 0 | 390 |
| commander-launcher.js | ELIMINAR V2 | 451 | 0 | 451 |
| health-check.js | ELIMINAR V2 | 939 | 0 | 939 |
| post-git-push.js | ELIMINAR V2 | 220 | 0 | 220 |
| post-issue-close.js | ELIMINAR V2 | 470 | 0 | 470 |
| post-merge-qa.js | ELIMINAR V2 | 310 | 0 | 310 |
| stop-notify.js | ELIMINAR V2 | 583 | 0 | 583 |
| **Total ahorro parcial** | | | | **~6,266 líneas** |

---

### 13. `post-console-response.js` (Stop, 232 líneas)
- **Función:** Detecta preguntas de permisos respondidas en consola local y sincroniza el estado con Telegram
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — 100% dependiente del sistema de permisos por Telegram (permission-gate.js + pending-questions.js) que se elimina en hook 4. Sin permission-gate no hay preguntas pendientes que sincronizar.

---

## Resumen parcial (hooks 1-13 de 18)

| Hook | Decisión | Líneas actuales | Líneas V2 | Ahorro |
|------|----------|----------------|-----------|--------|
| branch-guard.js | MANTENER | 94 | 94 | — |
| worktree-guard.js | MANTENER | 239 | 239 | — |
| delivery-gate.js | ELIMINAR V2 | 306 | 0 | 306 |
| permission-gate.js + deps | ELIMINAR V2 | 1,853 | 0 | 1,853 |
| activity-logger.js | SIMPLIFICAR | 894 | ~150 | ~744 |
| post-tool-orchestrator.js | ELIMINAR V2 | 390 | 0 | 390 |
| commander-launcher.js | ELIMINAR V2 | 451 | 0 | 451 |
| health-check.js | ELIMINAR V2 | 939 | 0 | 939 |
| post-git-push.js | ELIMINAR V2 | 220 | 0 | 220 |
| post-issue-close.js | ELIMINAR V2 | 470 | 0 | 470 |
| post-merge-qa.js | ELIMINAR V2 | 310 | 0 | 310 |
| stop-notify.js | ELIMINAR V2 | 583 | 0 | 583 |
| post-console-response.js | ELIMINAR V2 | 232 | 0 | 232 |
| **Total ahorro parcial** | | | | **~6,498 líneas** |

---

### 14. `agent-concurrency-check.js` (Stop, 217 líneas)
- **Función:** Al terminar un agente, emite evento `agent-stopped` para que el agent-coordinator promueva el siguiente de la cola
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — no hay coordinator ni cola. Los agentes son persistentes y buscan trabajo solos en el filesystem de fases (`pendiente/`). No necesitan que nadie los "promueva".

---

## Resumen parcial (hooks 1-14 de 18)

| Hook | Decisión | Líneas actuales | Líneas V2 | Ahorro |
|------|----------|----------------|-----------|--------|
| branch-guard.js | MANTENER | 94 | 94 | — |
| worktree-guard.js | MANTENER | 239 | 239 | — |
| delivery-gate.js | ELIMINAR V2 | 306 | 0 | 306 |
| permission-gate.js + deps | ELIMINAR V2 | 1,853 | 0 | 1,853 |
| activity-logger.js | SIMPLIFICAR | 894 | ~150 | ~744 |
| post-tool-orchestrator.js | ELIMINAR V2 | 390 | 0 | 390 |
| commander-launcher.js | ELIMINAR V2 | 451 | 0 | 451 |
| health-check.js | ELIMINAR V2 | 939 | 0 | 939 |
| post-git-push.js | ELIMINAR V2 | 220 | 0 | 220 |
| post-issue-close.js | ELIMINAR V2 | 470 | 0 | 470 |
| post-merge-qa.js | ELIMINAR V2 | 310 | 0 | 310 |
| stop-notify.js | ELIMINAR V2 | 583 | 0 | 583 |
| post-console-response.js | ELIMINAR V2 | 232 | 0 | 232 |
| agent-concurrency-check.js | ELIMINAR V2 | 217 | 0 | 217 |
| **Total ahorro parcial** | | | | **~6,715 líneas** |

---

### 15. `scrum-monitor-bg.js` (Stop, 279 líneas)
- **Función:** Cada 30 minutos chequea salud del sprint: issues con PR mergeado pero abiertos, status incorrectos, zombies en roadmap. Auto-repara inconsistencias menores, alerta por Telegram las críticas.
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — no hay sprints, hay Kanban. La consistencia del estado la garantiza el filesystem de fases + el barrendero. No hay estado duplicado que pueda quedar inconsistente.

---

## Resumen parcial (hooks 1-15 de 18)

| Hook | Decisión | Líneas actuales | Líneas V2 | Ahorro |
|------|----------|----------------|-----------|--------|
| branch-guard.js | MANTENER | 94 | 94 | — |
| worktree-guard.js | MANTENER | 239 | 239 | — |
| delivery-gate.js | ELIMINAR V2 | 306 | 0 | 306 |
| permission-gate.js + deps | ELIMINAR V2 | 1,853 | 0 | 1,853 |
| activity-logger.js | SIMPLIFICAR | 894 | ~150 | ~744 |
| post-tool-orchestrator.js | ELIMINAR V2 | 390 | 0 | 390 |
| commander-launcher.js | ELIMINAR V2 | 451 | 0 | 451 |
| health-check.js | ELIMINAR V2 | 939 | 0 | 939 |
| post-git-push.js | ELIMINAR V2 | 220 | 0 | 220 |
| post-issue-close.js | ELIMINAR V2 | 470 | 0 | 470 |
| post-merge-qa.js | ELIMINAR V2 | 310 | 0 | 310 |
| stop-notify.js | ELIMINAR V2 | 583 | 0 | 583 |
| post-console-response.js | ELIMINAR V2 | 232 | 0 | 232 |
| agent-concurrency-check.js | ELIMINAR V2 | 217 | 0 | 217 |
| scrum-monitor-bg.js | ELIMINAR V2 | 279 | 0 | 279 |
| **Total ahorro parcial** | | | | **~6,994 líneas** |

---

### 16. `pr-cleanup.js` (Stop, 507 líneas)
- **Función:** Busca PRs de ramas `agent/*` con más de 4 horas, CI verde, sin conflictos ni labels de bloqueo, y los mergea automáticamente con squash.
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — el merge es parte de la Fase 6 (ENTREGA) del pipeline. El agente de delivery se encarga. Si el pipeline funciona, no quedan PRs huérfanos que limpiar.

---

## Resumen parcial (hooks 1-16 de 18)

| Hook | Decisión | Líneas actuales | Líneas V2 | Ahorro |
|------|----------|----------------|-----------|--------|
| branch-guard.js | MANTENER | 94 | 94 | — |
| worktree-guard.js | MANTENER | 239 | 239 | — |
| delivery-gate.js | ELIMINAR V2 | 306 | 0 | 306 |
| permission-gate.js + deps | ELIMINAR V2 | 1,853 | 0 | 1,853 |
| activity-logger.js | SIMPLIFICAR | 894 | ~150 | ~744 |
| post-tool-orchestrator.js | ELIMINAR V2 | 390 | 0 | 390 |
| commander-launcher.js | ELIMINAR V2 | 451 | 0 | 451 |
| health-check.js | ELIMINAR V2 | 939 | 0 | 939 |
| post-git-push.js | ELIMINAR V2 | 220 | 0 | 220 |
| post-issue-close.js | ELIMINAR V2 | 470 | 0 | 470 |
| post-merge-qa.js | ELIMINAR V2 | 310 | 0 | 310 |
| stop-notify.js | ELIMINAR V2 | 583 | 0 | 583 |
| post-console-response.js | ELIMINAR V2 | 232 | 0 | 232 |
| agent-concurrency-check.js | ELIMINAR V2 | 217 | 0 | 217 |
| scrum-monitor-bg.js | ELIMINAR V2 | 279 | 0 | 279 |
| pr-cleanup.js | ELIMINAR V2 | 507 | 0 | 507 |
| **Total ahorro parcial** | | | | **~7,501 líneas** |

---

### 17. `auto-review-bg.js` (Stop, 620 líneas)
- **Función:** Cada 60 minutos busca PRs abiertos hace más de 24 horas sin review. Ejecuta análisis estático (strings prohibidos, loggers faltantes, tests ausentes) y postea hallazgos como comentario en el PR.
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — el code review es parte de la Fase 5 (APROBACIÓN) del pipeline, donde el agente `/review` lo hace como paso obligatorio. No debería haber PRs huérfanos sin review.

---

## Resumen parcial (hooks 1-17 de 18)

| Hook | Decisión | Líneas actuales | Líneas V2 | Ahorro |
|------|----------|----------------|-----------|--------|
| branch-guard.js | MANTENER | 94 | 94 | — |
| worktree-guard.js | MANTENER | 239 | 239 | — |
| delivery-gate.js | ELIMINAR V2 | 306 | 0 | 306 |
| permission-gate.js + deps | ELIMINAR V2 | 1,853 | 0 | 1,853 |
| activity-logger.js | SIMPLIFICAR | 894 | ~150 | ~744 |
| post-tool-orchestrator.js | ELIMINAR V2 | 390 | 0 | 390 |
| commander-launcher.js | ELIMINAR V2 | 451 | 0 | 451 |
| health-check.js | ELIMINAR V2 | 939 | 0 | 939 |
| post-git-push.js | ELIMINAR V2 | 220 | 0 | 220 |
| post-issue-close.js | ELIMINAR V2 | 470 | 0 | 470 |
| post-merge-qa.js | ELIMINAR V2 | 310 | 0 | 310 |
| stop-notify.js | ELIMINAR V2 | 583 | 0 | 583 |
| post-console-response.js | ELIMINAR V2 | 232 | 0 | 232 |
| agent-concurrency-check.js | ELIMINAR V2 | 217 | 0 | 217 |
| scrum-monitor-bg.js | ELIMINAR V2 | 279 | 0 | 279 |
| pr-cleanup.js | ELIMINAR V2 | 507 | 0 | 507 |
| auto-review-bg.js | ELIMINAR V2 | 620 | 0 | 620 |
| **Total ahorro parcial** | | | | **~8,121 líneas** |

---

### 18. `notify-telegram.js` (Notification, 447 líneas)
- **Función:** Reenvía notificaciones nativas de Claude Code (waiting for input, task completed, error, long process finished) a Telegram con niveles de urgencia y contexto de sesión
- **Determinístico:** Sí, 100%
- **Consume tokens:** No — solo corre cuando Claude emite una Notification
- **Decisión: ELIMINAR en V2** — con permisos auto-aprobados y agentes persistentes, los agentes no se quedan bloqueados esperando input. Las notificaciones de error o completitud se consultan bajo demanda desde el Telegram Commander (decidido en hook 12). No se necesita notificación push.
- Dependencias que también se eliminan: `context-reader.js`, `permission-utils.js`, `telegram-message-registry.js` (ya marcadas para eliminación en hook 4)

---

## Resumen final — 18 hooks revisados

| # | Hook | Decisión | Líneas actuales | Líneas V2 | Ahorro |
|---|------|----------|----------------|-----------|--------|
| 1 | branch-guard.js | MANTENER | 94 | 94 | — |
| 2 | worktree-guard.js | MANTENER | 239 | 239 | — |
| 3 | delivery-gate.js | ELIMINAR V2 | 306 | 0 | 306 |
| 4 | permission-gate.js + deps | ELIMINAR V2 | 1,853 | 0 | 1,853 |
| 5 | activity-logger.js | SIMPLIFICAR | 894 | ~150 | ~744 |
| 6 | post-tool-orchestrator.js | ELIMINAR V2 | 390 | 0 | 390 |
| 7 | commander-launcher.js | ELIMINAR V2 | 451 | 0 | 451 |
| 8 | health-check.js | ELIMINAR V2 | 939 | 0 | 939 |
| 9 | post-git-push.js | ELIMINAR V2 | 220 | 0 | 220 |
| 10 | post-issue-close.js | ELIMINAR V2 | 470 | 0 | 470 |
| 11 | post-merge-qa.js | ELIMINAR V2 | 310 | 0 | 310 |
| 12 | stop-notify.js | ELIMINAR V2 | 583 | 0 | 583 |
| 13 | post-console-response.js | ELIMINAR V2 | 232 | 0 | 232 |
| 14 | agent-concurrency-check.js | ELIMINAR V2 | 217 | 0 | 217 |
| 15 | scrum-monitor-bg.js | ELIMINAR V2 | 279 | 0 | 279 |
| 16 | pr-cleanup.js | ELIMINAR V2 | 507 | 0 | 507 |
| 17 | auto-review-bg.js | ELIMINAR V2 | 620 | 0 | 620 |
| 18 | notify-telegram.js | ELIMINAR V2 | 447 | 0 | 447 |
| | **TOTAL** | | **8,051** | **~483** | **~7,568** |

## Lo que sobrevive en V2 (hooks en settings.json)

Solo **3 hooks** quedan registrados:

| Evento | Matcher | Hook | Líneas |
|--------|---------|------|--------|
| PreToolUse | Bash | branch-guard.js | 94 |
| PreToolUse | Bash/Edit/Write | worktree-guard.js | 239 |
| PostToolUse | universal | activity-logger.js (simplificado) | ~150 |

## Nuevos componentes V2 (fuera de hooks)

| Componente | Tipo | Líneas est. | Función |
|------------|------|-------------|---------|
| Watchdog Task Scheduler | Script PS1 | ~20 | Vigila Telegram Commander + Barrendero |
| Comandos de consulta en Telegram Commander | Módulos del commander | por definir | Estado de issues, actividad reciente, filtro por fase |

## Decisiones transversales

1. **Permisos:** `settings.local.json` → `permissions.allow: ["*"]`, mantener 7 denys actuales
2. **Procesos críticos:** Telegram Commander y Barrendero vigilados por Windows Task Scheduler (no por hooks)
3. **Notificaciones:** Pasan de push (hooks) a pull (consultas bajo demanda via Telegram Commander)

---

# Parte 2: Scripts operativos

### 19. `Start-Agente.ps1` (scripts/, 971 líneas)
- **Función:** Launcher principal de agentes. Crea worktrees aislados, copia `.claude/`, lanza Claude con `Run-AgentStream.ps1`, ejecuta pipeline post-Claude (tests → security → build → delivery). Lee sprint-plan.json.
- **Determinístico:** Sí, 100%
- **Decisión: REESCRIBIR en V2** — de 971 a ~100-150 líneas estimadas. El modelo cambia: agentes persistentes que se levantan una vez y buscan trabajo continuamente. No necesita sprint-plan.json, ni pipeline post-Claude, ni delays por rate limit.

#### Responsabilidad de worktrees en V2:
- **El agente crea su propio worktree** al tomar un trabajo de `pendiente/`. Crea rama `agent/<issue>-<slug>`, codea, push.
- **El worktree NO se limpia** hasta que la historia sale completa del pipeline (Fase 6 listo). Esto permite rebotes: si un tester o reviewer encuentra un problema y la historia vuelve a Fase 2, el worktree ya existe con la rama y el historial de commits.
- **Limpieza:** recién cuando la historia se entrega (Fase 6 → listo), el worktree se elimina.

#### Flujo de rebote (defecto encontrado post-desarrollo):
```
Fase 4: Tester/Reviewer encuentra defecto
  → escribe hallazgo en el archivo de resultado de la historia
  → barrendero detecta fallo → mueve historia de vuelta a Fase 2 pendiente/
  → agente de desarrollo la toma
  → worktree sigue existiendo con la rama y commits previos
  → corrige, push
  → avanza de nuevo por Fase 3 → 4 → 5 → 6
```

**Reducción estimada: ~820 líneas**

---

### 20. `Run-AgentStream.ps1` (scripts/, 310 líneas)
- **Función:** Wrapper que ejecuta `claude` en modo stream-json, parsea la salida en tiempo real (tool calls, mensajes, resultado), muestra con colores en terminal y loguea a archivo.
- **Determinístico:** Sí, 100%
- **Decisión: ELIMINAR en V2** — el modelo de agentes persistentes no usa "ejecutar claude con un prompt y esperar que termine". El agente vive permanentemente y busca trabajo. No hay stream que parsear por tarea individual.

---

### 21. `Stop-Agente.ps1` (scripts/, 365 líneas)
- **Función:** Cierra agentes: commit + push + PR + squash-merge + limpieza de worktree. Lee sprint-plan.json.
- **Determinístico:** Sí, 100%
- **Decisión: ELIMINAR en V2** — el agente es persistente, no "se cierra". El delivery (commit/push/PR/merge) es parte del flujo del pipeline (Fase 6). La limpieza del worktree se hace cuando la historia sale completa del pipeline.

---

### 22. `Guardian-Sprint.ps1` (scripts/, 296 líneas)
- **Función:** Daemon que cada 5 minutos verifica si hay agentes activos; si no hay, relanza `/planner sprint`. Ya marcado como DEPRECADO.
- **Determinístico:** Sí, 100%
- **Decisión: ELIMINAR en V2** — agentes persistentes no mueren ni necesitan relanzamiento. No hay sprints que reiniciar.

### 23. `auto-plan-sprint.js` (scripts/, 606 líneas)
- **Función:** Planifica sprints: prioriza issues (técnicos → QA → negocio), respeta dependencias, genera sprint-plan.json.
- **Determinístico:** Sí, 100%
- **Decisión: REESCRIBIR como "Intake" en V2** — la lógica de priorización se reutiliza pero el formato cambia: en vez de generar sprint-plan.json, crea archivos en `fase1/pendiente/` del pipeline de definición. Estimado: ~150-200 líneas. Reducción: ~400 líneas.

#### Decisión de diseño: Arranque y continuidad del sistema V2

**Arranque inicial** (guía de lanzamiento / script `Launch-V2.ps1`):
```
Paso 1: Task Scheduler arranca Telegram Commander + Barrendero (automático tras reinicio)
Paso 2: Script abre N terminales con agentes persistentes por rol (backend-dev, qa, review, etc.)
Paso 3: Intake trae issues "ready" del backlog de GitHub → crea archivos en pipeline de definición
```

**Continuidad** (automática una vez arrancado):
- **Intake** como tarea programada (cada X minutos chequea issues nuevos ready) + comando manual desde Telegram Commander ("traer trabajo nuevo")
- **Barrendero** conecta fases automáticamente (todo en `listo/` de una fase → crear archivos en `pendiente/` de la siguiente)
- **Agentes** buscan trabajo continuamente en `pendiente/` de su fase

Se creará una guía de lanzamiento tipo checklist para poner el sistema operativo desde cero en 5 minutos.

---

### 24. `sprint-report.js` (scripts/, 1139 líneas)
- **Función:** Genera reportes HTML+PDF del sprint con métricas, evidencia QA, los envía a Telegram. Lee sprint-plan.json y múltiples fuentes de estado.
- **Determinístico:** Sí, 100%
- **Decisión: REESCRIBIR en V2** — se mantiene la capacidad de reportes pero adaptada a Kanban: throughput (historias completadas por período), lead time (duración inicio a fin), estado actual del pipeline. Datos del filesystem de fases + activity-logger. Estimado: ~300-400 líneas. Reducción: ~700-800 líneas.

---

### 25. `cost-report.js` (scripts/, 443 líneas)
- **Función:** Genera reportes de costos estimados (tokens → USD) por sprint, HTML+PDF, envía a Telegram. Lee agent-metrics.json y sprint-plan.json.
- **Determinístico:** Sí, 100%
- **Decisión: SIMPLIFICAR en V2** — se mantiene pero lee del activity-logger (6 dimensiones) + API de costos Anthropic. Puede integrarse como sección del reporte general (script 24) o mantenerse independiente. Estimado: ~150-200 líneas. Reducción: ~250-300 líneas.

---

### 26. `agent-coordinator.js` (.claude/hooks/, 1318 líneas)
- **Función:** Orquestador central del modelo actual. Proceso background que lee eventos, gestiona sprint-plan.json, promueve agentes de cola, detecta agentes muertos, relanza.
- **Determinístico:** Sí, 100%
- **Decisión: ELIMINAR en V2** — es la pieza central del modelo viejo, exactamente lo que V2 elimina por diseño. No hay orquestador central, no hay sprint-plan.json, no hay cola, no hay promoción. Los agentes buscan trabajo solos en el filesystem, el barrendero conecta fases.

---

### 27. `Watch-Agentes.ps1` (scripts/, 369 líneas)
- **Función:** Daemon que pollea cada 30s si los agentes terminaron. Al detectar finalización ejecuta cadena completa: Stop-Agente → reporte → proponer historias → planificar sprint → notificar Telegram.
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Estado actual:** Ya marcado como DEPRECADO en el propio script (línea 47)
- **Decisión: ELIMINAR en V2** — encarna el modelo batch ("esperar que todos terminen, cerrar, reportar, planificar siguiente"). En V2 Kanban con agentes persistentes no existe "todos terminaron". El trabajo fluye continuamente. Las partes útiles (reporte, intake) se cubren con componentes independientes.

---

### 28. `evaluate-and-release.js` (scripts/, 408 líneas)
- **Función:** Evalúa autónomamente si crear una GitHub Release. Parsea commits desde la última release, decide bump semver (major/minor/patch), crea tag y release en GitHub, notifica por Telegram.
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — innecesario por el momento. Cuando el modelo V2 esté operativo se evaluará cómo manejar releases. No tiene sentido mantener algo que depende del flujo batch viejo.

---

### 29. `reset-operations.js` (scripts/, 441 líneas)
- **Función:** "Botón rojo" — hard reset completo: mata todos los procesos, limpia worktrees, borra archivos de estado/sesiones, git pull main, reinicia infraestructura. Notifica por Telegram.
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — todavía no sabemos si el modelo V2 va a necesitar un escape hatch de este tipo. Se evalúa cuando el modelo esté operativo y se entienda qué tipo de distorsiones produce.

---

### 30. `restart-operational-system.js` (scripts/, 399 líneas)
- **Función:** Reinicio operativo "suave": resetea archivos de estado (pending-questions, health-check, agent-progress, sesiones), verifica conectividad Telegram, limpia procesos stale. Es el "reiniciar" vs el "formatear" del #29.
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — todos los archivos de estado que resetea dejan de existir en V2. El estado es el filesystem de fases, no JSONs intermedios. Si hace falta algo así, se construye cuando se entienda el nuevo modelo.

---

### 31. `cleanup-worktrees.js` (scripts/, 61 líneas)
- **Función:** Limpia worktrees huérfanos (`platform.agent-*`): desvincula junctions `.claude`, `git worktree remove --force`, `git worktree prune`.
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: ELIMINAR en V2** — el modelo de worktrees cambia completamente. Si aparecen huérfanos, un `git worktree prune` manual alcanza.

---

### 32. `report-to-pdf-telegram.js` (scripts/, 259 líneas)
- **Función:** Utilidad genérica: toma HTML (archivo, stdin o markdown), convierte a PDF, envía a Telegram. Helper que usan otros scripts para entrega de reportes.
- **Determinístico:** Sí, 100%
- **Consume tokens:** No
- **Decisión: MANTENER en V2** — pura utilidad de infraestructura. No depende del modelo operativo. Cualquier reporte futuro la necesita.

---

### 33. Helpers Telegram: `send-telegram-doc.js` (27), `send-telegram-video.js` (29), `send-report-telegram.js` (42) — 98 líneas total
- **Función:** Tres scripts mínimos que envían archivos, videos y PDFs a Telegram via curl/https.
- **Determinísticos:** Sí, 100%
- **Consumen tokens:** No
- **Decisión: MANTENER en V2** — helpers puros de 30 líneas cada uno. No dependen de nada del modelo operativo. Utilidades de infraestructura.

---

### 34. CLIs deterministas: `cli-monitor.js` (176), `cli-ops.js` (164), `cli-scrum.js` (141), `cli-cost.js` (250), `cli-branch.js` (91), `cli-cleanup.js` (158) — 980 líneas total
- **Función:** Scripts de línea de comando (issue #1661) que reemplazan skills `/monitor`, `/ops`, `/scrum`, `/cost`, `/branch`, `/ghostbusters` sin gastar tokens. Hacen lo mismo que los skills pero 100% deterministas.
- **Determinísticos:** Sí, 100% (esa es la razón de existir)
- **Consumen tokens:** No
- **Decisión: ELIMINAR en V2** — todos dependen del modelo actual: leen `sprint-plan.json`, `sessions/`, `agent-metrics.json`, `health-check-state.json`. En V2 ninguno de esos archivos existe. Si se necesitan CLIs de diagnóstico, se construyen leyendo el filesystem de fases.

---

## Resumen final completo — 18 hooks + 16 scripts revisados

### Hooks (18)

| # | Hook | Decisión | Líneas | Ahorro |
|---|------|----------|--------|--------|
| 1 | branch-guard.js | MANTENER | 94 | — |
| 2 | worktree-guard.js | MANTENER | 239 | — |
| 3 | delivery-gate.js | ELIMINAR V2 | 306 | 306 |
| 4 | permission-gate.js + deps | ELIMINAR V2 | 1,853 | 1,853 |
| 5 | activity-logger.js | SIMPLIFICAR | 894 | ~744 |
| 6 | post-tool-orchestrator.js | ELIMINAR V2 | 390 | 390 |
| 7 | commander-launcher.js | ELIMINAR V2 | 451 | 451 |
| 8 | health-check.js | ELIMINAR V2 | 939 | 939 |
| 9 | post-git-push.js | ELIMINAR V2 | 220 | 220 |
| 10 | post-issue-close.js | ELIMINAR V2 | 470 | 470 |
| 11 | post-merge-qa.js | ELIMINAR V2 | 310 | 310 |
| 12 | stop-notify.js | ELIMINAR V2 | 583 | 583 |
| 13 | post-console-response.js | ELIMINAR V2 | 232 | 232 |
| 14 | agent-concurrency-check.js | ELIMINAR V2 | 217 | 217 |
| 15 | scrum-monitor-bg.js | ELIMINAR V2 | 279 | 279 |
| 16 | pr-cleanup.js | ELIMINAR V2 | 507 | 507 |
| 17 | auto-review-bg.js | ELIMINAR V2 | 620 | 620 |
| 18 | notify-telegram.js | ELIMINAR V2 | 447 | 447 |

### Scripts (16)

| # | Script | Decisión | Líneas | Ahorro |
|---|--------|----------|--------|--------|
| 19 | Start-Agente.ps1 | REESCRIBIR V2 | 971 | ~820 |
| 20 | Run-AgentStream.ps1 | ELIMINAR V2 | 310 | 310 |
| 21 | Stop-Agente.ps1 | ELIMINAR V2 | 365 | 365 |
| 22 | Guardian-Sprint.ps1 | ELIMINAR V2 | 296 | 296 |
| 23 | auto-plan-sprint.js | REESCRIBIR como Intake | 606 | ~400 |
| 24 | sprint-report.js | REESCRIBIR V2 | 1,139 | ~750 |
| 25 | cost-report.js | SIMPLIFICAR V2 | 443 | ~250 |
| 26 | agent-coordinator.js | ELIMINAR V2 | 1,318 | 1,318 |
| 27 | Watch-Agentes.ps1 | ELIMINAR V2 | 369 | 369 |
| 28 | evaluate-and-release.js | ELIMINAR V2 | 408 | 408 |
| 29 | reset-operations.js | ELIMINAR V2 | 441 | 441 |
| 30 | restart-operational-system.js | ELIMINAR V2 | 399 | 399 |
| 31 | cleanup-worktrees.js | ELIMINAR V2 | 61 | 61 |
| 32 | report-to-pdf-telegram.js | MANTENER | 259 | — |
| 33 | Helpers Telegram (×3) | MANTENER | 98 | — |
| 34 | CLIs deterministas (×6) | ELIMINAR V2 | 980 | 980 |

### Totales

| Categoría | Líneas actuales | Líneas V2 | Ahorro |
|-----------|----------------|-----------|--------|
| Hooks | 8,051 | ~483 | ~7,568 |
| Scripts | 8,463 | ~1,057 | ~7,406 |
| **TOTAL** | **16,514** | **~1,540** | **~14,974** |

### Lo que sobrevive en V2

**Hooks (3):**
- `branch-guard.js` (94 líneas) — impide push a main
- `worktree-guard.js` (239 líneas) — impide codear en main
- `activity-logger.js` (~150 líneas, simplificado) — log con 6 dimensiones

**Scripts que se mantienen (4):**
- `report-to-pdf-telegram.js` (259 líneas) — conversión HTML→PDF→Telegram
- `send-telegram-doc.js` (27 líneas) — enviar archivo a Telegram
- `send-telegram-video.js` (29 líneas) — enviar video a Telegram
- `send-report-telegram.js` (42 líneas) — enviar PDF a Telegram

**Scripts que se reescriben (4):**
- `Start-Agente.ps1` (~150 líneas) — launcher simplificado de agentes persistentes
- `auto-plan-sprint.js` → Intake (~200 líneas) — priorizar y crear archivos en pipeline
- `sprint-report.js` (~350 líneas) — reportes adaptados a Kanban
- `cost-report.js` (~200 líneas) — costos desde activity-logger

**Nuevos componentes V2:**
- Watchdog Task Scheduler (~20 líneas) — vigila Listener Telegram + Pulpo
- Pulpo (~100-200 líneas) — intake + barrido + lanzamiento de agentes
- Listener Telegram (~50-80 líneas) — script Node.js puro, long-polling, encola mensajes
- Comandos de consulta en Telegram Commander (~por definir)

---

## Decisiones de diseño: Telegram Commander V2

### Arquitectura

El Commander se descompone en dos piezas:

1. **Listener** — script Node.js puro (cero tokens), siempre vivo. Hace long-polling contra la API de Telegram, recibe mensajes y los escribe como archivos en `servicios/commander/pendiente/`. El watchdog del Task Scheduler lo vigila.

2. **Agente Commander** — instancia de Claude, lanzada por el Pulpo cuando hay mensajes en `pendiente/`. Procesa el mensaje, responde via Telegram, y la respuesta se guarda en el historial.

### Singleton y secuencial

El Commander es siempre **una sola instancia** (concurrencia = 1). Los mensajes se atienden secuencialmente. Razón: es una interfaz de conversación con un usuario, inherentemente secuencial. Cada mensaje depende de la respuesta del anterior.

### Contexto persistente con historial en disco

- **`commander-history.jsonl`** — cada mensaje entrante y cada respuesta saliente se registran con timestamp
- **Ventana de 24 horas** — al arrancar (o re-arrancar tras caída), se carga como contexto las últimas 24hs del historial
- **Rotación** — lo que tenga más de 24hs se descarta o archiva
- **Independiente de Claude** — es un archivo propio del modelo operativo, no depende de `--resume` ni features del SDK
- **Recuperación ante caídas** — si el Commander se cae (crash, falta de cuota, reinicio), cuando el watchdog lo relanza, carga el historial y retoma la conversación desde donde quedó
- **Trazabilidad** — queda registro de todo lo que se pidió y respondió, útil para diagnóstico y reportes

### Flujo completo

```
Windows Task Scheduler (watchdog, cada 1-2 min)
  └─ vigila → Listener Telegram (Node.js puro, cero tokens)
  │             └─ recibe mensaje → escribe en servicios/commander/pendiente/
  │             └─ guarda mensaje entrante en commander-history.jsonl
  └─ vigila → Coordinador
                └─ detecta archivo en commander/pendiente/
                └─ lanza instancia Claude "commander"
                └─ le pasa como contexto las últimas 24hs del historial
                └─ Claude procesa → genera respuesta
                └─ Listener envía respuesta a Telegram
                └─ respuesta se guarda en commander-history.jsonl
```

### Diferencias con el Commander actual

| Aspecto | V1 (actual) | V2 |
|---------|-------------|-----|
| Proceso | Singleton monolítico siempre vivo | Listener (puro) + Agente (efímero) |
| Contexto | Se pierde al reiniciar | Persistente 24hs en disco |
| Tokens en idle | Consume (Claude vivo esperando) | Cero (agente solo vive mientras procesa) |
| Recuperación | Arranca de cero | Retoma con historial |
| Vigilancia | Hook commander-launcher.js en cada tool use | Task Scheduler del SO |

### Comandos del Commander V2

**Principio de diseño:** comandos core mínimos. Todo lo que no es un comando se resuelve con texto libre (Claude interpreta).

De ~35 comandos + 27 skills actuales → **8 comandos fijos**.

| Comando | Qué hace | Reemplaza del V1 |
|---------|----------|-------------------|
| `/status` | Tablero completo del pipeline: colas por fase (pendiente/trabajando/listo), agentes activos, servicios. EL comando para saber qué pasa. | `/monitor`, `/dash-*` (×6), `/sprint`, `/status` viejo |
| `/actividad` | Timeline de movimientos recientes. Filtrable: `/actividad 30m` (últimos 30 min), `/actividad 2h`, `/actividad #732` (historial de un issue específico). Default: últimos 10 movimientos. | `/dash-activity`, parte de `/monitor` |
| `/intake` | Meter trabajo al pipeline. `/intake` trae todos los issues "ready" de GitHub. `/intake 732` mete un issue específico. | `/sprint`, parte de `/planner` |
| `/proponer` | Proponer historias nuevas. `/proponer` o `/proponer 5`. Lanza un agente efímero que analiza backlog, código y deuda técnica, y presenta propuestas para aprobar/descartar. Las aprobadas se crean como issues en GitHub. Comando manual, no automático — se invoca cuando el pipeline se queda sin trabajo. | `/historia`, `planner-propose-interactive.js` |
| `/pausar` / `/reanudar` | Pausa o reanuda el Pulpo. Útil para intervenir sin matar nada. | No existía (más limpio que `/reset`) |
| `/costos` | Reporte de consumo de tokens/USD del período. | `/cost` |
| `/help` | Lista los comandos con descripción corta. | `/help` actual |
| `/stop` | Apaga el Commander. | `/stop` actual |

**Inputs no-comando:**

| Input | Qué hace |
|-------|----------|
| Texto libre | Claude interpreta y responde. Incluye crear historias ("necesito una pantalla de X"), preguntas sobre el proyecto, instrucciones operativas. |
| Fotos | Análisis visual con Claude (vision). |
| Audio/voz | Transcripción + respuesta + TTS. |

#### Comandos eliminados y razón

| Comando(s) eliminado(s) | Razón |
|--------------------------|-------|
| `/session`, `/session clear` | No hay sesiones, hay historial de 24hs |
| `/pendientes`, `/retry` | No hay permisos por Telegram (`allow: ["*"]`) |
| `/restart`, `/reset` | No hay estado que resetear. `/pausar`+`/reanudar` cubre el caso |
| `/sprint`, `/sprint N`, `/sprint interval`, `/reset-sprint` | No hay sprints, flujo Kanban |
| `/dash-overview`, `/dash-flow`, `/dash-activity`, `/dash-roadmap`, `/dash-cicd`, `/dash-logs` | Reemplazados por `/status` y `/actividad` |
| `/limpiar` | Poco valor, se hace manual si hace falta |
| `/detalle` / `/mas` | Evaluar post-implementación si tiene sentido |
| Skills como comandos (`/po`, `/qa`, `/review`, etc.) | Los roles del pipeline los lanza el Pulpo, no el usuario |
| Skills de operaciones (`/ops`, `/ghostbusters`, `/scrum`, etc.) | Se usan desde terminal directa, no desde Telegram |
| Keywords de permisos (si/no/siempre) | No hay permisos por Telegram |

#### Flujo de `/proponer`

```
1. Usuario manda /proponer (o /proponer 5)
2. Commander responde "Analizando backlog..."
3. Pulpo lanza agente efímero "propositor"
4. Agente analiza: backlog GitHub, estado del código, deuda técnica, issues abiertos
5. Genera N propuestas → las deja en cola del Commander
6. Commander las presenta al usuario una por una
7. Usuario aprueba/descarta cada una (texto libre: "dale" / "no, esa no")
8. Aprobadas → issues creados en GitHub con label "needs-definition"
9. El intake las tomará en el siguiente ciclo → entran al pipeline de definición
```

---

## Decisiones de diseño: Formato de resultados y ciclo del barrendero

### Formato del archivo de trabajo

El archivo de trabajo es **metadata de coordinación, no contenido**. El contenido vive en GitHub (comentarios, PRs) y en el código (commits).

**Al crearse** (3 líneas):
```yaml
issue: 1732
fase: verificacion
pipeline: desarrollo
```

**Al completarse** (el agente agrega resultado):
```yaml
issue: 1732
fase: verificacion
pipeline: desarrollo
resultado: aprobado
```

**En caso de rechazo:**
```yaml
issue: 1732
fase: verificacion
pipeline: desarrollo
resultado: rechazado
motivo: "Test de login falla con credenciales expiradas. El mock no renueva el token."
```

El barrendero solo lee el campo `resultado`. Si alguno dice `rechazado`, usa `motivo` para pasárselo al developer cuando devuelve la historia a dev.

### Subcarpetas por fase: 4 estados

Cada fase tiene 4 subcarpetas:

```
fase/
  pendiente/      ← trabajo por hacer
  trabajando/     ← un agente lo tomó
  listo/          ← terminado, esperando evaluación del barrendero
  procesado/      ← el barrendero ya promovió a la fase siguiente
```

### Ciclo del barrendero

1. Recorre cada fase de cada pipeline
2. Para cada issue con **todos** sus archivos en `listo/`:
   - Lee el campo `resultado` de cada archivo
   - Si todos `aprobado` → crea archivos en `pendiente/` de la **fase siguiente**
   - Si alguno `rechazado` → crea archivo en `dev/pendiente/` con el motivo del rechazo
3. Mueve todos los archivos evaluados de `listo/` a `procesado/`

### Por qué `procesado/` y no borrar

- **Trazabilidad:** `ls verificacion/procesado/` muestra qué historias ya pasaron por verificación
- **Consulta:** un developer puede leer `verificacion/procesado/1732.tester` para ver qué encontró el tester
- **Consistencia:** el estado sigue siendo la posición del archivo en las carpetas (no su contenido)
- **Deduplicación:** el barrendero nunca reprocesa — si está en `procesado/`, ya fue promovido

---

## Decisiones de diseño: Contexto de los agentes

### Principio: contexto mínimo por rol

Cada agente recibe **solo lo que necesita** para hacer su trabajo. No se carga el CLAUDE.md general completo, no se cargan archivos de memory, no se cargan reglas de otros roles. Esto maximiza el espacio de trabajo útil del agente.

### Estructura de prompts

```
.pipeline/
  roles/
    _base.md          ← instrucciones operativas (compartido, ~30 líneas)
    po.md             ← instrucciones del PO
    ux.md             ← instrucciones del UX
    backend-dev.md    ← instrucciones del backend-dev
    tester.md         ← instrucciones del tester
    qa.md             ← instrucciones del QA
    review.md         ← instrucciones del reviewer
    security.md       ← instrucciones del auditor de seguridad
    guru.md           ← instrucciones del investigador
    planner.md        ← instrucciones del dimensionador
    android-dev.md    ← instrucciones del android dev
    web-dev.md        ← instrucciones del web dev
    delivery.md       ← instrucciones del agente de entrega
    build.md          ← instrucciones del build (script, no Claude)
    commander.md      ← instrucciones del Telegram Commander
```

### Tres capas de contexto

**Capa 1: `_base.md` — Instrucciones operativas (~30 líneas, compartido)**
- Cómo buscar trabajo en `pendiente/` de tu skill
- Cómo mover a `trabajando/` (mv atómico)
- Cómo leer el issue de GitHub (`gh issue view`)
- Cómo leer contexto de fases anteriores (`procesado/` de la fase previa)
- Cómo escribir el resultado (YAML: resultado + motivo)
- Cómo mover a `listo/`

**Capa 2: `{rol}.md` — Instrucciones del rol (específico)**
Incluye solo las secciones del CLAUDE.md general que le aplican:
- `backend-dev.md` → reglas de strings, logging, patrón Do, estructura del backend
- `po.md` → criterios de aceptación, cómo validar historias, cero reglas de código
- `tester.md` → framework de testing, convención de nombres en español, cobertura
- `qa.md` → ambiente local, emulador, video, reporte
- `review.md` → qué verificar en un diff, reglas de calidad
- etc.

**Capa 3: Contexto del trabajo (dinámico, inyectado por el Pulpo)**
- El archivo de trabajo (3-5 líneas YAML)
- El agente lee el resto por su cuenta: issue de GitHub, archivos de fases anteriores

### Qué NO recibe un agente

| Contexto excluido | Razón |
|-------------------|-------|
| CLAUDE.md completo | El PO no necesita Gradle. El tester no necesita Android flavors. |
| Archivos de memory | Son para la sesión principal, no para agentes del pipeline |
| Reglas de otros roles | El QA no necesita las reglas del backend-dev |
| Estructura completa del monorepo | Solo la parte relevante al rol |
| sprint-plan.json, sesiones, estado | No existen en V2 |

### Cómo lanza el Pulpo a cada agente

```
claude -p "$(cat .pipeline/roles/_base.md .pipeline/roles/{rol}.md)" \
       --append-context "Archivo de trabajo: {contenido del archivo YAML}"
```

El agente arranca con contexto mínimo y lee lo que necesite (issue, resultados previos) durante su ejecución.

---

## Decisiones de diseño: El Pulpo (proceso central V2)

### Nombre y concepto

El proceso central del modelo V2 se llama **Pulpo** (`pulpo.js`). Reemplaza al "coordinador" y al "barrendero" como conceptos separados. Es un único script Node.js (NO Claude, cero tokens) con múltiples brazos haciendo cosas distintas.

**No confundir** con el `agent-coordinator.js` del modelo V1 (1,318 líneas). El Pulpo es ~100-200 líneas, no tiene estado propio, y solo mira carpetas.

### Qué hace en cada ciclo de poll

El Pulpo tiene dos frecuencias de poll para no penalizar su performance con latencia de red:

- **Cada 30 segundos** (operaciones locales, milisegundos):
  - **Brazo Barrido** — recorre fases, detecta historias con todos los archivos en `listo/`, evalúa resultados → promueve a fase siguiente o devuelve a dev → mueve a `procesado/`. Calcula ETAs y deja pedidos de actualización en `servicios/github/pendiente/`.
  - **Brazo Lanzamiento** — recorre carpetas `pendiente/`, verifica concurrencia según `config.yaml`, lanza agentes si corresponde
  - **Brazo Huérfanos** — detecta archivos en `trabajando/` por más de 10 minutos sin proceso asociado → devuelve a `pendiente/`

- **Cada 5 minutos** (operación de red, 1-2 segundos):
  - **Brazo Intake** — consulta GitHub por issues con labels de entrada → crea archivos en `pendiente/` del pipeline correspondiente, ordenados por prioridad

Las escrituras a GitHub (ETAs, comentarios, labels) se delegan al servicio de GitHub (`servicios/github/`), no las hace el Pulpo directamente.

### Cómo lanza agentes

- **Asincrónico:** el Pulpo lanza el proceso Claude y sigue con su ciclo. No espera a que termine.
- En el siguiente ciclo de poll, ve el estado de las carpetas: si el archivo pasó a `listo/`, el agente terminó. Si sigue en `trabajando/`, sigue vivo.
- Para agentes de la fase `dev` (backend-dev, android-dev, web-dev), el Pulpo **crea el worktree** antes de lanzar y le pasa el path. Para los demás roles no hace falta worktree porque no modifican código.

### Vigilancia

El Pulpo es vigilado por el **watchdog del Windows Task Scheduler** (cada 1-2 minutos). Si el Pulpo se cae, el watchdog lo relanza. Como no tiene estado propio, retoma sin pérdida.

### Configuración

Todo en `.pipeline/config.yaml`: pipelines, fases, concurrencia por rol, labels de intake, timeouts.

---

## Decisiones de diseño: Dashboard V2

### Principio

El dashboard actual (`dashboard-server.js`, 4,700 líneas) es la base. Se adapta al modelo V2, no se reescribe de cero. Se mantiene la calidad visual (dark/light theme, responsive, SSE en tiempo real).

### KPIs (fila superior, 5 métricas)

| KPI V1 | KPI V2 | Cambio |
|--------|--------|--------|
| Agentes activos | **Agentes activos** | Se mantiene — cuenta agentes corriendo |
| Permisos pendientes | **Historias en pipeline** | Reemplaza — total de issues activos en cualquier fase |
| CI/CD | **CI/CD** | Se mantiene — estado del último build |
| Acciones hoy | **Throughput** | Reemplaza — historias entregadas hoy/semana |
| Alertas | **Lead time promedio** | Reemplaza — tiempo promedio de inicio a entrega |

### Paneles (5)

| # | Panel V2 | Base V1 | Cambio |
|---|----------|---------|--------|
| 1 | **Pipeline Kanban** | Ejecución & Agentes | **Reescribir** — columnas por fase (Validación→Dev→Build→Verificación→Aprobación→Entrega), cada historia como card mostrando skills completados/pendientes. Vista principal. |
| 2 | **Flujo** | Flujo de agentes (SVG) | **Adaptar** — los layers pasan a ser las fases del pipeline V2. Misma estética de grafo dirigido. |
| 3 | **Actividad** | Actividad en vivo | **Mantener** — feed de últimas acciones, lee del activity-logger simplificado. |
| 4 | **Métricas** | Uso + Métricas de agentes | **Adaptar** — throughput, lead time por historia, uso por rol. Datos de `procesado/` + activity-logger. |
| 5 | **CI/CD** | CI/CD | **Mantener** — últimos runs de GitHub Actions. |

### Paneles eliminados

| Panel V1 | Razón |
|----------|-------|
| Permisos | No hay permisos en V2 |
| Roadmap (Gantt) | No hay sprints ni roadmap |

### Data sources

| V1 | V2 |
|----|-----|
| `sprint-plan.json` | Carpetas `.pipeline/desarrollo/` |
| `roadmap.json` | Eliminado |
| `.claude/sessions/*.json` | Eliminado — no hay sesiones |
| `agent-registry.json` | Carpetas `trabajando/` = registro de agentes activos |
| `agent-metrics.json` | Carpetas `procesado/` + `activity-log.jsonl` |
| `pending-questions.json` | Eliminado |
| `approval-history.json` | Eliminado |
| `gh run list` | Se mantiene |

### Dos formas de consumir el dashboard

| Canal | Cómo funciona |
|-------|---------------|
| **Browser** | Página web en `localhost:3100` con SSE auto-refresh. Para cuando estás en la máquina. |
| **Telegram** | Screenshots bajo demanda via comandos del Commander. Para cuando estás desde el celular. |

Ambas leen los mismos datos (carpetas `.pipeline/`) y usan el mismo HTML/CSS.

### Mapeo de comandos Telegram → secciones del dashboard

| Comando | Sección que screenshotea |
|---------|--------------------------|
| `/status` | KPIs + Panel 1 (Pipeline Kanban) — la foto completa |
| `/actividad` | Panel 3 (Feed) — filtrado según parámetros (tiempo o issue) |
| `/costos` | Panel 4 (Métricas) — throughput y consumo |
| `/help`, `/stop`, `/intake`, `/proponer`, `/pausar`, `/reanudar` | Respuesta de texto, no necesitan dashboard |

### Infraestructura que se mantiene

- Servidor HTTP con rutas por sección (`/`, `/pipeline`, `/activity`, `/cicd`, etc.)
- Dark/light theme con CSS variables
- SSE para actualizaciones en tiempo real
- Screenshot por sección via Puppeteer (ruta `/screenshots/sections`)
- Diseño responsive (desktop + mobile)

---

## Decisiones de diseño: Hallazgos de revisión crítica multi-rol

> Revisión del modelo V2 desde las perspectivas de QA, Security, PO, Developer y UX. Sesión 2026-03-27.

### Hallazgo 1 (QA): Evidencia sin vínculo claro al issue

**Problema:** QA genera videos, screenshots, reportes. Se mandan a Drive via fire-and-forget pero no queda vínculo explícito con el issue.

**Decisión:** agregar campo opcional `evidencia` al YAML de resultado. Solo lo usan QA y tester.

```yaml
issue: 1732
fase: verificacion
pipeline: desarrollo
resultado: aprobado
evidencia: "https://drive.google.com/file/d/xxx (video E2E login)"
```

El Pulpo lo ignora — solo lee `resultado`. Queda en `procesado/` como trazabilidad.

### Hallazgo 2 (QA): Re-testing sin contexto de pasadas anteriores

**Problema:** cuando una historia vuelve por rechazo, el agente no sabe qué se encontró antes.

**Decisión:** agregar instrucción en `_base.md` (prompt compartido):

> "Antes de empezar tu trabajo, verificá si existen archivos de tu mismo skill en `procesado/` de tu misma fase para el mismo issue. Si existen, son resultados de una pasada anterior que fue rechazada. Leelos para entender qué se encontró antes y focalizá tu trabajo en verificar que esos problemas fueron corregidos."

Aplica a todos los roles, no solo QA. No agrega complejidad al sistema — solo una instrucción en el prompt.

### Hallazgo 3 (PO): Priorización de intake

**Problema:** en Kanban no hay sprint donde el PO ordene historias. Si hay 5 issues "ready", ¿en qué orden entran?

**Decisión:** el intake respeta labels de prioridad en GitHub:

- `priority:critical` → entra primero
- `priority:high` → segundo
- `priority:medium` → tercero (default si no tiene label)
- `priority:low` → último

El Pulpo ordena por prioridad al crear archivos en `pendiente/`. La decisión la toma el PO en GitHub con labels.

#### ETA por issue

El Pulpo calcula un ETA (fecha/hora estimada de resolución) para cada issue basándose en:
- Tamaño del issue (S/M/L) vs tiempos históricos
- Fase actual en el pipeline
- Cantidad de issues por delante en cola
- Concurrencia disponible por rol

El ETA se escribe como **comentario en el issue de GitHub** (fuente de verdad), no en archivos locales. Se actualiza solo en momentos clave:
- Cuando el issue entra al pipeline (intake)
- Cuando cambia de fase (barrido)
- Cuando la cola cambia significativamente

La escritura a GitHub se hace via **servicio fire-and-forget** (`servicios/github/`) para no penalizar al Pulpo. El dashboard también muestra el ETA leyéndolo del issue.

### Hallazgo 4 (Dev): Conflictos de merge en entrega

**Problema:** dos developers trabajan en paralelo en worktrees distintos. Ambos modifican el mismo archivo. El segundo en entregar tendrá conflictos.

**Decisión:** el agente de delivery hace rebase contra main antes de crear PR. Escenarios:

1. **Rebase limpio** → sigue normal, crea PR, mergea
2. **Conflicto simple** → el agente de delivery intenta resolverlo. Si lo logra, continúa.
3. **Conflicto complejo** → la historia vuelve a `dev/pendiente/` con motivo del conflicto

**Regla clave: el agente siempre resuelve solo.** Si rebase falla, el developer reimplementa sobre main actualizado. Cero intervención manual del usuario. Si por algún motivo excepcional no puede ni reimplementar, escala notificando por Telegram pero nunca se traba esperando.

### Hallazgo 5 (Dev): Build log largo en campo motivo

**Problema:** un build fallido genera un log de Gradle potencialmente enorme. No entra en el campo `motivo` del YAML.

**Decisión:** motivo = resumen corto + path al log completo:

```yaml
resultado: rechazado
motivo: "CompilationError en LoginScreen.kt:45. Log: .pipeline/logs/build-1732.log"
```

Los logs de build se guardan en `.pipeline/logs/`, no en el archivo de trabajo.

### Hallazgo 6 (Security): Riesgos del Pulpo y archivos YAML

**Problema:** el Pulpo tiene poder total sobre el pipeline. Los archivos YAML se confían sin validación. El historial del Commander puede contener info sensible.

**Decisión:** documentar como riesgos conocidos, no mitigar ahora. El contexto actual (máquina local, un solo usuario) hace que el riesgo sea bajo. Se reevalúa si el modelo escala a múltiples usuarios o máquinas.

### Servicio de GitHub (decisión transversal)

Las escrituras a GitHub (comentarios, labels, ETAs, PRs) se desacoplan como servicio fire-and-forget, igual que Telegram y Drive:

```
.pipeline/servicios/
  telegram/       ← mensajes a Telegram
  drive/          ← archivos a Google Drive
  github/         ← escrituras a GitHub (comentarios, labels, PRs, ETAs)
    pendiente/
    trabajando/
    listo/
    procesado/
```

| Operación | Mecanismo |
|-----------|-----------|
| **Leer** issues, PRs, labels | Directo (`gh api`) — el agente lo necesita en el momento |
| **Escribir** comentarios, labels, ETAs | Servicio fire-and-forget (`servicios/github/pendiente/`) |
| **Crear** issues, PRs | Servicio fire-and-forget |

El servicio de GitHub es un script Node.js puro (cero tokens) que procesa su cola a su ritmo. No penaliza al Pulpo ni a los agentes.

---

## Pendiente de implementación: Actualización de CLAUDE.md y settings

> Esta sección NO se ejecuta durante el diseño. Se ejecuta al momento de implementar V2, como parte del paso de migración.

### A) `settings.local.json` — cambios requeridos

**Permisos:**
- `permissions.allow` → reemplazar las ~67 reglas individuales por `["*"]` (wildcard)
- `permissions.deny` → mantener los 7 denys actuales (force push, reset hard, rm -rf, etc.)

**Hooks:**
- Eliminar los 15 hooks descartados de la configuración
- Dejar solo 3 hooks registrados:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "command": "node .claude/hooks/branch-guard.js" }] },
      { "matcher": "Bash|Edit|Write", "hooks": [{ "command": "node .claude/hooks/worktree-guard.js" }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "command": "node .claude/hooks/activity-logger.js" }] }
    ]
  }
}
```

### B) `CLAUDE.md` — secciones a actualizar

**Secciones que se mantienen sin cambios (reglas de código):**
- Stack y versiones
- Estructura de módulos
- Arquitectura del App (capas, asdo/, ext/, ui/)
- Arquitectura del Backend
- Reglas de strings (CRITICO)
- Logging
- Testing
- Android: Product Flavors
- CI/CD
- Documentación
- Idioma

**Secciones que se actualizan (modelo operativo):**

| Sección actual | Cambio |
|----------------|--------|
| "Comandos de build esenciales" | Se mantiene |
| "Ramas y PRs" | Adaptar: ya no hay `agent/` branches creadas por Start-Agente.ps1 — las crea el Pulpo |
| "Gate de QA obligatorio" | Adaptar: el gate lo garantiza la fase de Verificación del pipeline, no hooks |
| "Lanzamiento de agentes (CRITICO)" | **Reescribir completo**: ya no se usa Start-Agente.ps1, el Pulpo lanza agentes. Describir el modelo de carpetas. |
| "Protocolo de tareas" | **Reescribir**: ya no hay TaskCreate/TaskUpdate del modelo viejo. El progreso es la posición del archivo en las carpetas. |
| "Concurrencia de agentes" | Adaptar: la concurrencia se define en `.pipeline/config.yaml`, no en hooks |

**Secciones que se eliminan:**
- Referencias a `sprint-plan.json`
- Referencias a `agent-coordinator.js`
- Referencias a `Start-Agente.ps1` como launcher obligatorio
- Referencias a hooks eliminados
- Protocolo de sub-pasos con `metadata.steps`

### C) Prompts de skills (`.claude/skills/`)

Los skills que son roles del pipeline se reemplazan por los archivos en `.pipeline/roles/`:
- Los ~15 skills de pipeline (`po.md`, `ux.md`, `backend-dev.md`, etc.) migran a `.pipeline/roles/`
- Los skills de operaciones que sobreviven (`doc`, etc.) se actualizan para no referenciar sprint-plan ni sesiones
- Los skills eliminados en la consolidación se borran

### Orden de ejecución durante la migración

Reemplazado por el plan de implementación detallado abajo.

---

## Plan de implementación V2

### Fase 0: Bloqueo del modelo V1

Antes de tocar V2, dejar V1 completamente inerte.

**Paso 0.1: Backup**
```bash
git tag v1-pipeline-backup -m "Backup completo del pipeline V1 antes de migración a V2"
git push origin v1-pipeline-backup
```

**Paso 0.2: Matar procesos**
- Matar agent-coordinator si está corriendo
- Matar Telegram Commander
- Matar cualquier agente activo en worktrees
- Matar dashboard server

**Paso 0.3: Desactivar hooks**
Sacar los 15 hooks eliminados de `settings.local.json`. No borrar los archivos — solo desregistrarlos. Dejar activos solo: branch-guard, worktree-guard, activity-logger.

**Paso 0.4: Cancelar sprint**
Verificar que sprint-plan.json no dispare nada. Marcar como cancelado si no lo está.

**Verificación:** ningún proceso corriendo, ningún hook disparándose excepto los 3 que sobreviven.

---

### Fases de implementación (F1-F10)

Cada fase es independiente, verificable, y se registra en `.pipeline/IMPLEMENTACION.md` al completarse.

#### F1 — Estructura de carpetas + config.yaml
- Crear `.pipeline/` con todas las subcarpetas (definicion, desarrollo, servicios)
- Crear `.pipeline/config.yaml` con pipelines, fases, concurrencia, intake, timeouts
- Crear `.pipeline/IMPLEMENTACION.md` (archivo de progreso)
- **Depende de:** Fase 0
- **Verificación:** `find .pipeline -type d` confirma estructura completa

#### F2 — Pulpo v0 (barrido + lanzamiento, sin intake)
- Escribir `.pipeline/pulpo.js` con brazos de barrido, lanzamiento y huérfanos
- Sin brazo de intake todavía — se prueban con archivos manuales en pendiente/
- **Depende de:** F1
- **Verificación:** crear archivo manual en `pendiente/`, verificar que el Pulpo lanza agente y el barrido promueve

#### F3 — Prompts de roles
- Crear `.pipeline/roles/_base.md` con instrucciones operativas compartidas
- Crear los ~15 archivos de rol (`po.md`, `ux.md`, `backend-dev.md`, etc.)
- Incluir instrucción de leer `procesado/` para pasadas anteriores (hallazgo 2)
- **Depende de:** F1
- **Verificación:** revisión manual de cada prompt, validar que no referencian V1

#### F4 — Integración Pulpo + agentes (test E2E)
- Crear un issue de prueba en GitHub
- Meter manualmente su archivo en `desarrollo/validacion/pendiente/`
- Verificar flujo completo: Pulpo lanza agente → agente procesa → mueve a listo → Pulpo barre → promueve a siguiente fase
- Probar rechazo: un agente rechaza → Pulpo devuelve a dev
- **Depende de:** F2 + F3
- **Verificación:** issue de prueba atraviesa al menos 2 fases correctamente

#### F5 — Intake (brazo del Pulpo)
- Agregar brazo de intake a `pulpo.js`: lee GitHub cada 5 min, respeta prioridad por labels
- Calcula ETAs, delega escritura a `servicios/github/pendiente/`
- **Depende de:** F4
- **Verificación:** crear issue con label "ready" en GitHub, verificar que aparece en `pendiente/` del pipeline

#### F6 — Listener Telegram + Commander V2
- Escribir `listener-telegram.js` (Node.js puro, long-polling, encola en `servicios/commander/pendiente/`)
- Escribir `.pipeline/roles/commander.md` con los 8 comandos
- Implementar `commander-history.jsonl` con ventana de 24hs
- **Depende de:** F1 (independiente de F2-F5)
- **Verificación:** mandar mensaje por Telegram, verificar que llega a `pendiente/`, que se procesa, y que la respuesta vuelve

#### F7 — Dashboard V2
- Adaptar `dashboard-server.js`: eliminar paneles V1, agregar panel Pipeline Kanban
- Cambiar data sources: de sprint-plan.json a carpetas `.pipeline/`
- Mantener SSE, dark/light theme, responsive, screenshots
- Conectar comandos del Commander (`/status`, `/actividad`, `/costos`) con screenshots del dashboard
- **Depende de:** F1 (independiente de F2-F6)
- **Verificación:** abrir `localhost:3100`, verificar que muestra estado real de las carpetas

#### F8 — Servicios fire-and-forget
- Escribir servicio de Telegram (`servicios/telegram/` — script Node.js)
- Escribir servicio de Drive (`servicios/drive/` — script Node.js)
- Escribir servicio de GitHub (`servicios/github/` — script Node.js)
- **Depende de:** F1 (independiente del resto)
- **Verificación:** crear archivo manual en `servicios/telegram/pendiente/`, verificar que se envía

#### F9 — Watchdog Task Scheduler
- Crear script PowerShell (~20 líneas) que vigila Listener + Pulpo
- Registrar tarea en Windows Task Scheduler (cada 1-2 min)
- **Depende de:** F2 + F6
- **Verificación:** matar el Pulpo manualmente, verificar que el watchdog lo relanza

#### F10 — Limpieza final
- Actualizar `settings.local.json` definitivo (permisos `["*"]` + 3 hooks)
- Actualizar `CLAUDE.md` (secciones operativas)
- Eliminar archivos de hooks descartados
- Eliminar scripts descartados
- Eliminar archivos de estado JSON obsoletos
- Limpiar worktrees huérfanos de V1
- **Depende de:** todo lo anterior
- **Verificación:** `./gradlew clean build` pasa, pipeline E2E funciona, Commander responde

### Diagrama de dependencias

```
F0 (Bloqueo V1)
 │
 ├── F1 (Carpetas + config)
 │    │
 │    ├── F2 (Pulpo v0)
 │    │    │
 │    │    └── F4 (Integración E2E) ←── F3 (Prompts)
 │    │         │
 │    │         └── F5 (Intake)
 │    │
 │    ├── F3 (Prompts) ──────────────┘
 │    │
 │    ├── F6 (Commander V2) ─── independiente
 │    │
 │    ├── F7 (Dashboard V2) ─── independiente
 │    │
 │    └── F8 (Servicios) ────── independiente
 │
 └── F9 (Watchdog) ←── F2 + F6
      │
      └── F10 (Limpieza final) ←── todo

Parallelizable: F6, F7, F8 entre sí
```

### Archivo de progreso: `.pipeline/IMPLEMENTACION.md`

Se crea en F1 y se actualiza al final de cada fase. Formato:

```markdown
# Implementación Pipeline V2

## Estado: EN CURSO — Fase FN

## Documentación de diseño
- Diseño completo: docs/pipeline-v2-diseno.md
- Revisión hooks/scripts + decisiones: docs/revision-hooks-v2.md

## Fases completadas

### FN — Nombre de la fase ✅
- Fecha: YYYY-MM-DD
- Qué se hizo: descripción breve
- Archivos creados/modificados: lista
- Verificación: qué se probó y resultado
- Commit: hash

## Fase actual

### FN — Nombre de la fase 🔧
- Iniciada: YYYY-MM-DD
- Estado: descripción del progreso
- Pendiente: qué falta dentro de esta fase
- Notas: contexto relevante para retomar si se interrumpe

## Fases pendientes
- FN+1: descripción
- ...
```
