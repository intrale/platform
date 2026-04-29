# Arquitectura Operativa — Intrale Platform

**Documento central de referencia para entender cómo funciona el sistema operativo del proyecto.**

> **Premisa Principal:** Este documento explica cómo interactúan entre sí los agentes IA especializados y cómo se involucran proactivamente en el proceso de desarrollo, desde la planificación inicial hasta el monitoreo post-merge.

**Última actualización:** 2026-03-11
**Estado:** Activo (SPR-024 cerrado, SPR-025 pendiente)

---

## 1. Visión General: El Ecosistema de Agentes

El sistema operativo de Intrale Platform está diseñado como un **ecosistema de agentes orquestados** que trabajan juntos de forma **proactiva y autónoma**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    ECOSISTEMA DE AGENTES                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Usuario solicita feature/bug fix (CLI o Telegram)             │
│         ↓                                                       │
│  Planner: analiza, prioriza, crea sprint-plan.json             │
│         ↓                                                       │
│  Start-Agente.ps1 lanza 3 agentes máximo en paralelo           │
│         ↓                                                       │
│  Agentes especializados trabajan en worktrees aislados:        │
│    • Agent 1 (issue A) implementa feature                      │
│    • Agent 2 (issue B) implementa bug fix                      │
│    • Agent 3 (issue C) documenta cambios                       │
│         ↓                                                       │
│  Al terminar cada agente:                                       │
│    1. Hook Stop dispara agent-concurrency-check.js             │
│    2. Si hay capacidad, promociona automáticamente siguiente   │
│         de la cola (_queue[] → agentes[])                       │
│    3. Start-Agente.ps1 lanza el nuevo agente en paralelo       │
│         ↓                                                       │
│  Mientras el agente trabaja, otros sistemas monitorean:        │
│    • telegram-commander: espera comandos remotos               │
│    • scrum-monitor-bg: verifica salud del sprint c/30min       │
│    • agent-watcher: detecta agentes terminados, promueve cola  │
│    • ci-monitor-bg: pollea GitHub Actions tras cada push       │
│         ↓                                                       │
│  Cuando agente hace git push (delivery):                        │
│    1. Hook PostToolUse marca agente como "waiting"             │
│    2. Libera slot para promover siguiente de cola              │
│    3. ci-monitor-bg pollea GitHub Actions → notifica Telegram  │
│    4. Cuando CI pasa, agente continúa (merge auto)             │
│         ↓                                                       │
│  Al finalizar todas las historias del sprint:                  │
│    Scrum cierra sprint, genera métricas, notifica velocity     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Ciclo de Vida Completo de un Agente

### Fase 1: PLANIFICACIÓN (Planner)

**Agente involucrado:** `/planner`

1. Planner analiza issues abiertos (prioritario, dependencias, tamaño)
2. Selecciona top N historias accionables (default 7-10)
3. Valida dependencias con `/po` (Product Owner)
4. Crea `scripts/sprint-plan.json` con estructura:
   - `agentes[]` — Primeros 3 (lanzados por Start-Agente.ps1)
   - `_queue[]` — Restantes (4 a N, promovidos automáticamente)
   - `_completed[]` — Historial de agentes terminados
   - `concurrency_limit: 3` — máximo de agentes simultáneos

**Archivo generado:**
```json
{
  "sprint_id": "SPR-025",
  "agentes": [
    { "numero": 1, "issue": 1456, "slug": "docs-arch", "titulo": "...", "stream": "E", "size": "M" },
    { "numero": 2, "issue": 1457, "slug": "hooks-inventory", "titulo": "...", "stream": "E", "size": "S" },
    { "numero": 3, "issue": 1458, "slug": "monitoring-guide", "titulo": "...", "stream": "E", "size": "M" }
  ],
  "_queue": [
    { "numero": 4, "issue": 1459, "slug": "troubleshooting", "titulo": "...", "stream": "E", "size": "S" }
  ],
  "_completed": [],
  "total_stories": 4
}
```

### Fase 2: EJECUCIÓN PARALELA (Agentes especializados)

**Agentes involucrados:** `/backend-dev`, `/android-dev`, `/ios-dev`, `/web-dev`, `/desktop-dev`, `/ux`, `/qa`, `/security`, etc.

Cada agente:
1. Lee su issue con `gh issue view <N>`
2. Invoca pipeline de especialistas (`/guru` → `/review` → `/builder` → `/tester`)
3. Trabaja en worktree aislado (`platform.agent-<issue>-<slug>`)
4. Hace cambios, corre tests, valida build
5. Invoca `/delivery` para commit + PR + push

**Interacción clave:** Los agentes pueden invocar otros agentes en el pipeline:
- Agent implementa con `/backend-dev` → invoca `/builder` para validar → `/tester` para tests
- Si falla, agente pide ayuda a `/guru` para investigar el error
- Al terminar, `/review` valida el código antes de `/delivery`

### Fase 3: PROMOCIÓN AUTOMÁTICA (agent-concurrency-check + agent-watcher)

**Disparadores:**
- **Hook Stop** (ejecutado cuando el agente termina en el proceso worktree)
  - Script: `.claude/hooks/agent-concurrency-check.js`
  - Actualiza `sprint-plan.json` en el repo principal

- **Watcher externo** (ejecutado cada 60s por proceso background)
  - Script: `.claude/hooks/agent-watcher.js` (issue #1441)
  - Detecta agentes muertos en worktrees, promueve automáticamente

**Flujo de promoción:**
```
Agent 1 termina (git push finalizado)
    ↓
Hook Stop → agent-concurrency-check.js
    ↓
Busca agentes en lista:
  • Cuenta activos (status != "waiting"): 2 (agentes 2 y 3)
  • Límite: 3
  • Capacidad disponible: 1 slot
    ↓
¿Hay items en _queue[]?
  ✓ SÍ → Promocionar #4 (issue 1459) de _queue[] a agentes[]
    ↓
Actualizar sprint-plan.json
    ↓
Lanzar Start-Agente.ps1 4 (ejecuta agente #4)
```

**Si el watcher detecta un agente zombie (30+ min inactivo):**
```
agent-watcher.js (cada 60s)
    ↓
Verifica PID de agente 2 (esperado activo)
  • PID no existe o proceso muerto
  • Worktree aún registrado en git
    ↓
Marcar como muerto, remover de agentes[]
    ↓
Promover siguiente de _queue[]
```

### Fase 4: MONITOREO PASIVO (Subsistemas independientes)

Mientras los agentes trabajan, **4 sistemas monitorean en background**:

#### 4a. telegram-commander (daemon persistente)
- **Propósito:** Recibir comandos remotos via Telegram
- **Script:** `.claude/hooks/telegram-commander.js`
- **Ciclo:**
  1. Polling remoto cada 10-30s (según `heartbeat_interval` adaptativo)
  2. Si hay comando, ejecutarlo (ej: `/monitor`, `/ops`, `/ghostbusters`)
  3. Responder al usuario en Telegram con resultado
- **Proactividad:** Envía heartbeat con screenshots del Monitor cada X minutos

#### 4b. scrum-monitor-bg (ejecutado cada 30min tras cada Stop)
- **Propósito:** Verificar salud del sprint (project V2 sincronizado, issues correctos)
- **Script:** `.claude/hooks/scrum-monitor-bg.js`
- **Ciclo:**
  1. Leer estado del sprint desde Project V2
  2. Comparar con `sprint-plan.json`
  3. Detectar inconsistencias (ej: issue dice "Done" pero está en "In Progress")
  4. Auto-reparar inconsistencias menores
  5. Alertar a Telegram si detecta problemas críticos
- **Proactividad:** Genera métricas automáticas sin que se lo pida

#### 4c. agent-watcher (ejecutado cada 60s en background)
- **Propósito:** Detectar agentes muertos, promover automáticamente
- **Script:** `.claude/hooks/agent-watcher.js`
- **Diferencia con agent-concurrency-check:**
  - concurrency-check: dispara en el contexto del worktree (proceso que termina)
  - agent-watcher: proceso independiente, monitorea TODOS los agentes
- **Proactividad:** No necesita que nada dispare, corre continuamente

#### 4d. ci-monitor-bg (lanzado por post-git-push.js)
- **Propósito:** Pollear GitHub Actions tras cada push
- **Script:** `.claude/hooks/ci-monitor-bg.js` (lanzado por post-git-push.js)
- **Ciclo:**
  1. Detecta `git push` via Hook PostToolUse[Bash]
  2. Marca agente como "waiting" (espera CI)
  3. Lanza background process que:
     - Pollea GitHub Actions cada 30s
     - Muestra progreso en Telegram (building... ✓/✗)
     - Cuando termina, notifica resultado
     - Promueve siguiente de cola

---

## 3. Mapeo de Responsabilidades: Quién interactúa con quién

### Matriz de Interacciones Proactivas

| Agente A | Invoca a | Agente B | Propósito | Momento |
|----------|----------|----------|-----------|---------|
| **Planner** | → | `/po` (dependencias) | Validar orden de ejecución | Pre-sprint |
| **Planner** | → | `/doc nueva` | Crear nuevas historias si hay gaps | Pre-sprint |
| **Any Agent** | → | `/branch` | Crear rama antes de trabajar | Inicio |
| **Any Agent** | → | `/po` (acceptance) | Entender criterios del issue | Inicio |
| **Any Agent** | → | `/guru` | Investigar patrones/libs | Cuando no sabe |
| **BackendDev** | → | `/builder` | Validar build backend | Pre-delivery |
| **BackendDev** | → | `/tester` | Ejecutar tests unitarios | Pre-delivery |
| **Any Dev Agent** | → | `/security` | Auditoria de seguridad | Pre-delivery |
| **Any Dev Agent** | → | `/review` | Code review automatizado | Pre-delivery (gate) |
| **Any Dev Agent** | → | `/qa` | Tests E2E en entorno real | Pre-delivery (si UI) |
| **Any Dev Agent** | → | `/delivery` | Commit + PR + push | Final |
| **post-git-push** | → | ci-monitor-bg | Pollear CI tras push | Después de push |
| **agent-concurrency-check** | → | Start-Agente.ps1 | Lanzar siguiente agente | Tras Stop |
| **agent-watcher** | → | Start-Agente.ps1 | Promocionar cola (fallback) | Cada 60s |
| **scrum-monitor-bg** | → | `/scrum` (auto-repair) | Reparar inconsistencias | Cada 30min |
| **telegram-commander** | → | `/monitor`/`/ops` | Responder comandos | On-demand via Telegram |

### Flujo Concreto: Issue #1456 (Documentación)

```
Usuario invoca: Crear documentación de arquitectura
     ↓
/planner analiza (invoca /po dependencias para validar)
     ↓
Planner crea sprint-plan.json con:
  - #1456 como issue 1 (docs-arch, tamaño M)
  - 3 más en _queue[] (hooks-registry, monitoring-guide, troubleshooting)
     ↓
/branch crea rama agent/1456-docs-arquitectura-operativa
     ↓
Start-Agente.ps1 1 lanza Agent 1 en worktree
     ↓
Agent 1 (Doc especializado):
  1. Lee issue #1456 con gh
  2. Invoca /guru para investigar arquitectura actual
  3. Invoca /po acceptance para entender qué documentar
  4. Escribe docs/arquitectura-operativa.md
  5. Escribe docs/operativo/hooks-registry.md
  6. Escribe docs/operativo/monitoring-guide.md
  7. Escribe docs/operativo/troubleshooting.md
  8. Corre /tester para validar (si tiene tests)
  9. Invoca /review (code review de docs)
  10. Invoca /delivery para commit + PR
     ↓
post-git-push.js (Hook PostToolUse[Bash]):
  • Marca agent 1 como "waiting"
  • Lanza ci-monitor-bg en background
  • Promueve agent 4 (issue 1459) de _queue[] a agentes[]
  • Lanza Start-Agente.ps1 4
     ↓
agent-concurrency-check.js (Hook Stop):
  • Cuenta activos: 2 (agent 2 y 3) + 1 (agent 4 recién lanzado) = 3
  • Límite: 3
  • Capacidad: 0 (full)
  • Sin promoción (cola vacía)
     ↓
Agent 2, 3, 4 trabajan en paralelo
Agent 1 espera CI en "waiting"
     ↓
Cuando Agent 2 termina:
  • Hook Stop dispara
  • agent-concurrency-check busca cola
  • Cola vacía (todos en agentes[])
  • Sin promoción
     ↓
Cuando Agent 1 CI pasa (ci-monitor-bg):
  • Agente se des-espera (waiting → ok)
  • Se auto-mergea PR si está correcta
  • Lanza /scrum para cerrar si es último
     ↓
scrum-monitor-bg (cada 30min):
  • Verifica que Project V2 está sincronizado
  • Si issue #1456 está "Done", valida PR mergeado
  • Auto-repara si status != "Done"
  • Notifica a Telegram: "Sprint en progreso: 3/4 completados"
```

---

## 4. Sistema de Permisos: Aprobación Automática y Remota

**Objetivo:** Acelerar el flujo permitiendo que agentes operen de forma autónoma cuando es seguro.

### Niveles de Severidad

| Severidad | Herramientas | Comportamiento | Ejemplo |
|-----------|----------|----------------|---------|
| **AUTO_ALLOW** | TaskCreate, TaskUpdate, Skill, EnterPlanMode | Aprobadas automáticamente | `/planner sprint`, `/branch create` |
| **LOW** | WebFetch, WebSearch, Bash genérico, Read, Write en `.claude/` | Auto-aprobadas (sin Telegram) | Leer docs, grep, simple bash |
| **MEDIUM** | git push, curl POST, Bash con pipes, EditFile | Auto-aprobadas (sin Telegram) desde #1302 | `git push origin agent/*` (pero NO main) |
| **HIGH** | rm -rf, git reset --hard, destructivos, CRITICAL ops | Requiere aprobación manual via Telegram | `rm -rf build/`, `git reset` |

### Flujo de Aprobación

```
Agent invoca herramienta (ej: git push)
     ↓
permission-gate.js (Hook PreToolUse):
  • Clasifica severidad (MEDIUM)
  • Busca en permission-approver.js si es auto-allow
  • SÍ → Execute sin Telegram
  • NO → Enviar inline button a Telegram
     ↓
Usuario en Telegram:
  • Ve: "Agent solicita Bash: git push origin agent/1456-docs"
  • Botones: ✅ Aprobar | ❌ Denegar | 🔍 Ver detalles
  • Presiona ✅
     ✓ Agent continúa
     ✗ Agent detiene (error de permiso)
```

### Excepciones Críticas

- **branch-guard.js:** SIEMPRE bloquea `git push origin main` (no importa permiso)
- **worktree-guard.js:** SIEMPRE alerta si se edita en rama protegida
- **permission-tracker.js:** Audita TODAS las aprobaciones para historial

---

## 5. Estado Distribuido: Archivos de Sincronización

El sistema está descentralizado pero requiere sincronización de estado. Estos archivos son los "pulmones" del sistema:

### Archivos Críticos

| Archivo | Propósito | Quién escribe | Quién lee | Refresh |
|---------|-----------|---------------|-----------|---------|
| `scripts/sprint-plan.json` | Plan actual + agentes + cola + métricas | Planner, concurrency-check, watcher | Start-Agente, agentes, Monitor | Cada Stop/git push |
| `.claude/activity-log.jsonl` | Log de actividad en tiempo real | activity-logger.js (hook) | Monitor, tendencias | Contínuo |
| `.claude/hooks/health-check-*.json` | Estado de salud por componente | ops-check, health-check | ops-check.js, Monitor | /ops exec |
| `.claude/hooks/scrum-health-history.jsonl` | Historial de inconsistencias detectadas | scrum-monitor-bg | Análisis tendencias | Cada 30min |
| `.claude/sessions/*.json` | Metadatos de sesión Claude | Claude Code | Monitor, session-gc | Al iniciar/terminar |
| `.claude/hooks/telegram-config.json` | Config de Telegram (bot token, chat ID) | Usuario (manual) | Todos los scripts | N/A (semi-estático) |
| `.claude/settings.json` | Registro de hooks y eventos | Usuario (manual) | Claude Code runtime | Al cambiar |

### Síncronización Manual

Algunos archivos se sincronizan manualmente (no hay hook automatizado):
- `docs/` — cambios documentados por agentes
- `.claude/settings.json` — actualizaciones de hooks
- `CLAUDE.md` — reglas del proyecto

**Nota:** El sistema NO requiere sincronización con GitHub (todo es local). Solo `git push` envía cambios a origin.

---

## 6. Subsistemas de Monitoreo: El "Centro de Control"

### 6a. telegram-commander (daemon persistente)

```javascript
// Ciclo:
while (true) {
  offset = getLastMessageOffset();
  messages = fetchTelegramMessages(offset);

  for (msg in messages) {
    if (msg.text.startsWith("/")) {
      cmd = parseCommand(msg.text);
      result = executeCommand(cmd);  // ej: /monitor, /ops
      sendReply(msg.chat_id, result);
    }
  }

  sleep(heartbeat_interval); // adaptativo: 30-300s según actividad
}
```

**Comandos disponibles:**
- `/monitor` — Dashboard de Sprint actual
- `/ops` — Health-check del entorno
- `/ghostbusters` — Caza fantasmas (procesos, worktrees, sesiones, locks, logs, QA)
- `/help` — Lista de comandos

### 6b. scrum-monitor-bg (auditor automático)

```javascript
// Ejecutado cada 30min (tras cada Stop evento)
health = checkSprintHealth();
if (health.inconsistencies) {
  for (inc in health.inconsistencies) {
    if (canAutoRepair(inc)) {
      repair(inc);  // ej: mover issue de "Open" a "Done"
    } else {
      alertTelegram(inc);  // requiere acción manual
    }
  }
}
```

**Inconsistencias detectadas:**
- PR mergeado pero issue sigue en "In Progress" → Mover a "Done"
- Issue sin PR pero dice "Done" → Alerta
- Agente terminado pero en "In Progress" → Mover a "Done"
- sprint-plan.json desincronizado con PRs reales → Alert
- Agente esperado activo pero no hay worktree → Alerta

### 6c. agent-watcher (supervisor de agentes)

```javascript
// Ejecutado cada 60s en background (proceso independiente)
while (true) {
  plan = readSprintPlan();

  for (agent in plan.agentes) {
    worktree = findWorktree(agent.issue);
    if (!isProcessAlive(worktree.pid) && agent.status != "done") {
      log("Agent " + agent.numero + " is dead");
      markDead(agent);
      promoteDead(plan);
      relaunched = launchNextFromQueue(plan);
    }
  }

  sleep(60000);
}
```

**Ventaja sobre agent-concurrency-check:**
- No depende de que el Stop hook dispare en el contexto correcto
- Detecta agentes que terminan sin notificar (crash, red timeout)
- Promueve automáticamente sin intervención

### 6d. ci-monitor-bg (monitor de CI)

```javascript
// Lanzado por post-git-push.js tras cada git push
while (true) {
  status = checkGitHubActions(branch);

  if (status == "running") {
    sendTelegram("CI en progreso...");
  } else if (status == "success") {
    autoMergePR(branch);  // si está configurado
    return;
  } else if (status == "failure") {
    alertTelegram("CI failed: " + errors);
    return;
  }

  sleep(30000);
}
```

---

## 7. Diagrama de Flujo Completo: 5 Agentes en Paralelo

```
HORA 10:00 — Planner crea sprint-plan.json
┌──────────────────────────────────────────────────┐
│ agentes: [#1456, #1457, #1458]                  │
│ _queue: [#1459, #1460, #1461]                   │
│ concurrency_limit: 3                             │
└──────────────────────────────────────────────────┘
     ↓
Start-Agente.ps1 all (lanza 3 agentes)
     ├─→ Agent 1 (#1456) inicia en worktree
     ├─→ Agent 2 (#1457) inicia en worktree
     ├─→ Agent 3 (#1458) inicia en worktree
     └─→ agent-watcher lanza en background
         (monitorea cada 60s)

HORA 10:15 — Agent 1 hace git push
     │
     ├─→ Hook PostToolUse[Bash] dispara:
     │   • post-git-push.js marca agent 1 como "waiting"
     │   • Cuenta activos: 2 (agentes 2, 3) → capacidad = 1
     │   • Promociona agente 4 (#1459)
     │   • Lanza Start-Agente.ps1 4
     │   └─→ ci-monitor-bg inicia en background
     │
     └─→ AHORA HAY 4 AGENTES TRABAJANDO:
         Agent 1 (esperando CI)
         Agent 2 (implementando)
         Agent 3 (implementando)
         Agent 4 (acaba de lanzarse)

HORA 10:45 — Agent 2 termina
     │
     ├─→ Hook Stop dispara:
     │   • agent-concurrency-check.js
     │   • Cuenta: 3 activos (agentes 1[waiting], 3, 4)
     │   • Cola vacía
     │   • Sin promoción
     │
     └─→ SIGUE IGUAL: 4 agentes

HORA 11:00 — scrum-monitor-bg ejecuta (cada 30min)
     │
     └─→ Verifica salud:
         • Agent 1: esperando CI (waiting) ✓
         • Agent 2: terminado, PR sin mergear ⚠ → Auto-mergea
         • Agent 3: activo (45 min) ✓
         • Agent 4: activo (45 min) ✓

HORA 11:15 — agent-watcher detecta que Agent 1 sigue en CI (>15min)
     │
     └─→ Alerta Telegram: "Agent 1 waiting >15min, check CI"

HORA 11:30 — CI de Agent 1 pasa
     │
     ├─→ ci-monitor-bg notifica "CI PASS ✓"
     ├─→ Auto-mergea PR
     ├─→ Agent 1 se des-espera
     └─→ Cuando agente 1 detecta CI pass:
         • Invoca /scrum si es último agente
         • Invoca /delivery para actualizar
         • Termina

HORA 12:00 — Agent 3 termina
     │
     ├─→ Hook Stop dispara:
     │   • Cuenta: 2 activos (agentes 1[done], 4)
     │   • Cola vacía
     │   • Sin promoción
     │
     └─→ 3 AGENTES RESTANTES

HORA 12:30 — Agent 4 termina
     │
     ├─→ Hook Stop dispara:
     │   • Todos agentes completos
     │   • scrum-monitor-bg cierra sprint
     │   • Envía métricas a Telegram
     │   • velocity = 4/4 (100%)
     │
     └─→ SPRINT CLOSED
         Todos en _completed[]
         Ready para /planner sprint (SPR-026)
```

---

## 8. Tabla de Eventos y Hooks

| Evento | Cuándo ocurre | Hooks que se disparan | Scripts principales | Acción |
|--------|---------------|----------------------|-------------------|--------|
| **Notification** | Siempre (cualquier evento) | notify-telegram.js | Envía notificación a Telegram | Informar usuario |
| **Stop** | Claude Code termina sesión | stop-notify.js, post-console-response.js, agent-concurrency-check.js, scrum-monitor-bg.js | Notifica, promociona cola, audita sprint | Sincronizar estado |
| **PreToolUse[Bash]** | Antes de ejecutar comando bash | branch-guard.js, worktree-guard.js, delivery-gate.js | Bloquear push a main, alerta si rama mala | Prevenir errores |
| **PreToolUse** | Antes de cualquier herramienta | permission-gate.js | Pide aprobación si es HIGH severity | Controlar acceso |
| **PostToolUse[Bash]** | Después de ejecutar bash | post-git-push.js | Marca "waiting", promociona cola, lanza CI monitor | Orquestar CI |
| **PostToolUse** | Después de cualquier herramienta | ensure-permissions.js, permission-tracker.js, activity-logger.js | Audita, registra actividad | Trazabilidad |
| **PermissionRequest** | Herramienta solicita acceso | permission-approver.js | Auto-aprueba o envía a Telegram | Decisión proactiva |

---

## 9. Reglas de Operación Críticas

### 9.1 Concurrencia

- **Máximo 3 agentes simultáneos** en cualquier momento
- El 4º agente espera en _queue[]
- Cuando agente termina o entra en "waiting", se promueve automáticamente del siguiente de _queue[]
- **No hacer:** lanzar agentes manualmente sin pasar por Planner (causa desincronización)

### 9.2 Branching y Merging

- **NUNCA** trabaje en `main` directamente
- **SIEMPRE** cree rama `agent/<issue>-<slug>` con `/branch`
- **NUNCA** force-push a main (branch-guard.js lo bloquea)
- PR base SIEMPRE es `main` (no `develop`)
- Auto-merge activado si CI pasa y review aprueba

### 9.3 Logs y Auditoría

- TODOS los eventos se registran en:
  - `.claude/activity-log.jsonl` — continuo, línea por línea
  - `.claude/hooks/hook-debug.log` — ultimas 500 líneas (por limpieza)
  - `.claude/hooks/scrum-health-history.jsonl` — salud del sprint
- **No borrar** archivos de log (son historial de incidentes)
- `/monitor` y `/ops` leen estos logs para diagnosticar

### 9.4 Resincronización y Reparación

Si el sistema se desincroniza (ej: agente no se promociona):
1. Ejecutar `/ops` para diagnosticar
2. Ejecutar `/scrum audit` para verificar Project V2
3. Si falta promoción: ejecutar `Start-Agente.ps1 <numero>` manualmente
4. Si hay conflicto: ejecutar `/ghostbusters --run` para limpiar stale

---

## 10. Cómo Usar Este Documento

### Para Nuevos Agentes (Onboarding)

1. Leer **Secciones 1-2** para entender el ciclo de vida
2. Leer **Sección 3** para ver dónde encaja tu rol
3. Antes de implementar, leer **Sección 9** (reglas críticas)
4. Referencia rápida: **Tabla de Eventos (Sección 8)**

### Para Debugging de Incidentes

1. ¿Agente no se promueve? → Sección 3 (Promoción automática)
2. ¿Agente reinicia infinitamente? → Sección 6c (agent-watcher)
3. ¿CI no pasa? → Sección 6d (ci-monitor-bg)
4. ¿Sprint desincronizado? → Sección 6b (scrum-monitor-bg)
5. ¿Permiso bloqueado? → Sección 4 (Sistema de permisos)

### Para Mejorar la Arquitectura

- Cambios a hooks → Actualizar Sección 8
- Nuevos agentes → Actualizar Sección 3
- Nuevos subsistemas → Agregar Sección 6.x
- Cambios a ciclo de vida → Actualizar Sección 2

---

## 11. Referencias

- **Script de Planificación:** `/planner` (Skill)
- **Pipeline de Implementación:** `/backend-dev`, `/android-dev`, `/ios-dev`, `/web-dev`, `/desktop-dev`
- **Gates Pre-Merge:** `/tester`, `/builder`, `/security`, `/review`
- **Hooks Registry:** `.claude/settings.json` (lista completa de todos los eventos)
- **Monitoreo:** `/monitor` (dashboard en Telegram), `/ops` (health-check)
- **Limpieza:** `/ghostbusters` (procesos, worktrees, sesiones, locks, logs, QA artifacts, state files)
- **Sprint Lifecycle:** `/scrum` (metricas, audit, close sprint)

---

**Documento vivo** — Actualizar cuando cambie la arquitectura de agentes o flujo de hooks.
**Último actualizado:** 2026-03-11
**Próxima revisión recomendada:** Post SPR-025
