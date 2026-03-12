# Registry de Hooks — Inventario Completo

**Referencia técnica de TODOS los hooks registrados en el sistema operativo.**

> **Última actualización:** 2026-03-12
> **Total de hooks:** 52+
> **Configuración:** `.claude/settings.json`

---

## 1. Event: Notification

**Cuándo dispara:** Ante cualquier evento importante (usuario final, agente, sistema)

### notify-telegram.js
- **Propósito:** Enviar notificación a Telegram (bot token + chat ID)
- **Scripts invocados:** API Telegram HTTP POST
- **Estado que toca:**
  - `.claude/hooks/telegram-outbox.json` — queue de mensajes pendientes
  - `.claude/hooks/telegram-message-registry.json` — historial de mensajes (para ediciones)
- **Timeout:** 15s
- **Falla crítica?:** NO (mensaje perdido, pero no detiene agente)

---

## 2. Event: Stop

**Cuándo dispara:** Claude Code termina una sesión (agente finaliza)

### stop-notify.js
- **Propósito:** Notificar que agente terminó (éxito/fracaso)
- **Scripts invocados:** notify-telegram.js (indirectamente)
- **Estado que toca:** `.claude/sessions/*.json` (actualiza last_activity_ts)
- **Timeout:** 15s
- **Falla crítica?:** NO

### post-console-response.js
- **Propósito:** Procesar respuesta final de Claude (registrar output, errores)
- **Scripts invocados:** activity-logger.js (indirectamente)
- **Estado que toca:** `.claude/activity-log.jsonl`, `.claude/hooks/hook-debug.log`
- **Timeout:** 10s
- **Falla crítica?:** NO

### agent-concurrency-check.js ⭐⭐⭐ CRÍTICO
- **Propósito:** Promocionar siguiente agente de _queue[] si hay capacidad
- **Scripts invocados:**
  - sprint-sync.js (sincronizar roadmap con GitHub)
  - Start-Agente.ps1 (lanzar siguiente agente si hay)
  - notify-telegram.js (notificar promoción)
- **Estado que toca:**
  - `scripts/sprint-plan.json` — ACTUALIZACIÓN CENTRAL (mueve agentes de _queue a agentes[], marca como done)
  - `.claude/hooks/hook-debug.log` — log detallado
  - `.claude/hooks/agent-watcher.log` — comunicación con watcher
- **Timeout:** 20s
- **Falla crítica?:** SÍ — si falla, cola se bloquea
- **Lógica:**
  1. Detectar si la sesión que termina es de sprint (rama agent/*)
  2. Remover agente de agentes[] si está
  3. Marcar en _completed[]
  4. Contar agentes activos (status != "waiting")
  5. Si hay espacio (activos < limit) Y cola no vacía:
     - Mover primera de _queue[] a agentes[]
     - Lanzar Start-Agente.ps1

### scrum-monitor-bg.js ⭐ SALUD DEL SPRINT
- **Propósito:** Auditar salud del sprint (Project V2 sincronizado, issues correctas)
- **Scripts invocados:**
  - health-check-sprint.js (ejecutar auditoría)
  - scrum-auto-corrections.js (auto-reparar inconsistencias menores)
  - notify-telegram.js (alerta si hay problemas)
- **Estado que toca:**
  - `scripts/sprint-plan.json` — lectura/escritura de estado
  - `.claude/hooks/scrum-health-history.jsonl` — append historial
  - `.claude/hooks/scrum-monitor-state.json` — estado del monitor
  - GitHub Project V2 (lectura de estado de issues)
- **Timeout:** 60s
- **Falla crítica?:** NO (diagnostica pero no bloquea)
- **Ciclo:** Ejecutado cada 30min tras cada Stop

### pr-cleanup.js
- **Propósito:** Limpiar PRs viejas (cerradas, merged) del workspace
- **Scripts invocados:** GitHub API (eliminar ramas remotas)
- **Estado que toca:** Git branches (delete remote branches)
- **Timeout:** 120s
- **Falla crítica?:** NO (limpieza no crítica)

---

## 3. Event: PreToolUse

**Cuándo dispara:** Antes de ejecutar cualquier herramienta (Read, Edit, Bash, WebSearch, etc.)

### Matcher: "Bash" (ejecutar comando bash)

#### branch-guard.js ⭐⭐ BLOQUEA MAIN
- **Propósito:** Bloquear `git push origin main` (protección absoluta)
- **Scripts invocados:** NADA (solo bloquea)
- **Estado que toca:** `.claude/hooks/branch-guard.log`
- **Timeout:** 5s
- **Falla crítica?:** SÍ — si no dispara, se puede hacer push accidental a main
- **Lógica:**
  1. Detectar patrón `git push origin main` o `git push` (cuando rama=main)
  2. SI → Error fatal, bloquear
  3. NO → Permitir

#### worktree-guard.js ⭐ ALERTA DE RAMA
- **Propósito:** Alerta si se edita código en rama protegida (main, develop)
- **Scripts invocados:** notify-telegram.js (envía alerta)
- **Estado que toca:** `.claude/hooks/worktree-guard.log`
- **Timeout:** 5s
- **Falla crítica?:** NO (solo alerta)
- **Lógica:**
  1. Detectar rama actual
  2. Si es main/develop → Alerta a Telegram
  3. Si es agent/* → OK

#### delivery-gate.js ⭐⭐ PRE-DELIVERY
- **Propósito:** Bloquear `/delivery` si hay cambios sin stagear o tests rotos
- **Scripts invocados:** health-check.js (verificar estado antes de entregar)
- **Estado que toca:** `.claude/hooks/delivery-gate.log`
- **Timeout:** 30s
- **Falla crítica?:** SÍ — protege contra merges incompletos
- **Condiciones de bloqueo:**
  - Cambios sin stagear (git status --porcelain muestra diferencias)
  - Tests fallando (si hay suite)
  - Build roto (si aplica)
  - Sin cambios en absoluto (nada que entregar)

### Matcher: "Edit" (editar archivo)

#### worktree-guard.js
- (Mismo comportamiento que con Bash)

### Matcher: "Write" (escribir archivo)

#### worktree-guard.js
- (Mismo comportamiento que con Bash)

### Matcher: "" (todas las herramientas)

#### permission-gate.js ⭐⭐⭐ CONTROL DE ACCESO
- **Propósito:** Autorizar herramienta según severidad (auto-allow, Telegram approval, HIGH denial)
- **Scripts invocados:**
  - permission-approver.js (lógica de decisión)
  - notify-telegram.js (enviar aprobación a usuario)
- **Estado que toca:**
  - `.claude/hooks/pending-questions.json` — queue de decisiones pendientes
  - `.claude/hooks/permission-memory.json` — historial de aprobaciones
  - `.claude/hooks/permission-tracker.log` — auditoría de acceso
- **Timeout:** 1830s (30.5 min, esperando respuesta Telegram)
- **Falla crítica?:** SÍ — si no dispara, sin control de acceso
- **Severidades:**
  - AUTO_ALLOW: TaskCreate, TaskUpdate, Skill, EnterPlanMode → Aprueban sin Telegram
  - LOW: WebFetch, WebSearch, Bash simple → Auto-aprueban
  - MEDIUM: git push, curl POST → Auto-aprueban (MEDIUM ≥ desde #1302)
  - HIGH: rm -rf, git reset --hard, destructivos → Requieren aprobación manual

---

## 4. Event: PostToolUse

**Cuándo dispara:** Después de ejecutar cualquier herramienta

### Matcher: "Bash" (tras comando bash)

#### post-git-push.js ⭐⭐⭐ ORQUESTA CI
- **Propósito:** Detectar `git push`, marcar agente "waiting", promocionar cola, lanzar CI monitor
- **Scripts invocados:**
  - ci-monitor-bg.js (lanza en background)
  - Start-Agente.ps1 (promueve siguiente de cola)
  - notify-telegram.js (notifica CI status)
- **Estado que toca:**
  - `scripts/sprint-plan.json` — marca agente como waiting, promueve cola
  - `.claude/hooks/ci-monitor-bg.pid` — PID del monitor
  - GitHub Actions (lectura de status)
- **Timeout:** No espera (lanza background)
- **Falla crítica?:** NO (CI monitor es best-effort)
- **Lógica:**
  1. Detectar patrón `git push`
  2. Extraer rama de salida (git rev-parse --abbrev-ref HEAD)
  3. Encontrar agente en sprint-plan.json por rama
  4. Marcar agente como status="waiting"
  5. Contar activos, si hay espacio, promover siguiente de _queue[]
  6. Lanzar ci-monitor-bg.js en proceso background

### Matcher: "" (todas las herramientas)

#### ensure-permissions.js
- **Propósito:** Registrar permiso otorgado (para auditoría)
- **Scripts invocados:** permission-tracker.js
- **Estado que toca:** `.claude/hooks/permission-tracker.log`
- **Timeout:** Inmediato
- **Falla crítica?:** NO (solo auditoría)

#### permission-tracker.js
- **Propósito:** Registrar cambios de estado de permisos
- **Scripts invocados:** NADA
- **Estado que toca:** `.claude/hooks/permission-tracker.log`, `.claude/hooks/permissions-baseline.json`
- **Timeout:** Inmediato
- **Falla crítica?:** NO

#### activity-logger.js ⭐ REGISTRO TEMPORAL
- **Propósito:** Registrar TODA actividad en `.claude/activity-log.jsonl` (1 línea = 1 evento)
- **Scripts invocados:** NADA
- **Estado que toca:** `.claude/activity-log.jsonl` (append-only)
- **Timeout:** Inmediato
- **Falla crítica?:** NO (si falla, pierde 1 evento)
- **Datos registrados:**
  - timestamp, tool name, input summary, output summary, duration
  - Task progress (si está usando TaskCreate/TaskUpdate)
  - Permiso otorgado/denegado
  - Error si ocurrió

---

## 5. Event: PermissionRequest

**Cuándo dispara:** Herramienta solicita acceso a recurso (Telegram command, web access, etc.)

### permission-approver.js
- **Propósito:** Decidir si auto-aprobar o enviar a Telegram para decisión remota
- **Scripts invocados:** telegram-commander.js (si requiere decisión remota)
- **Estado que toca:** `.claude/hooks/pending-questions.json`, `.claude/hooks/approval-history.json`
- **Timeout:** Hasta que usuario responda en Telegram
- **Falla crítica?:** NO (timeout = deny)

---

## 6. Subsistemas Background (No son hooks, pero son críticos)

### agent-watcher.js ⭐⭐⭐ SUPERVISOR INDEPENDIENTE
- **Lanzado por:** Start-Agente.ps1 all (proceso background)
- **PID file:** `.claude/hooks/agent-watcher.pid`
- **Log:** `.claude/hooks/agent-watcher.log`
- **Ciclo:** Cada 60s (configurable: WATCHER_POLL_INTERVAL)
- **Propósito:** Detectar agentes muertos, promover automáticamente
- **Estado que toca:**
  - `scripts/sprint-plan.json` (lectura/escritura)
  - `.claude/hooks/agent-watcher.pid` (singleton)
  - `.claude/hooks/agent-watcher.log`
- **Falla crítica?:** NO (fallback si agent-concurrency-check falla)
- **Detección de muerte:**
  - Worktree existe pero PID muerto
  - Sesión Claude no-activa >30min
  - Worktree sin cambios >1 hora
- **Acción:** Marcar como dead, remover de agentes[], promover siguiente

### ci-monitor-bg.js ⭐⭐ MONITOREO CI
- **Lanzado por:** post-git-push.js
- **PID file:** `.claude/hooks/ci-monitor-bg.pid`
- **Log:** `.claude/hooks/ci-monitor-bg.log`
- **Ciclo:** Cada 30s (polling GitHub Actions)
- **Propósito:** Pollear CI, notificar status, auto-mergear si pasa
- **Estado que toca:**
  - GitHub Actions (lectura)
  - GitHub PR (lectura/escritura para merge)
  - `.claude/hooks/ci-monitor-bg.pid`
- **Falla crítica?:** NO (agente sigue esperando)
- **Transiciones:**
  - running → notificar "CI en progreso"
  - success → auto-mergear (si config), notificar ✓
  - failure → notificar ✗, mostrar errores

### scrum-monitor-bg.js ⭐ AUDITOR SPRINT
- **Lanzado por:** Hook Stop (si es intervalo de 30min)
- **PID file:** `.claude/hooks/scrum-monitor-bg.pid`
- **Log:** `.claude/hooks/hook-debug.log`
- **Ciclo:** Cada 30min (configurable)
- **Propósito:** Auditar salud del sprint, auto-reparar inconsistencias
- **Estado que toca:**
  - `scripts/sprint-plan.json` (lectura/escritura)
  - GitHub Project V2 (lectura)
  - `.claude/hooks/scrum-health-history.jsonl` (append)
  - `.claude/hooks/scrum-monitor-state.json`
- **Falla crítica?:** NO (diagnostica)
- **Auto-reparaciones:**
  - PR merged → Issue a "Done" (lectura GitHub, escritura Project V2)
  - Issue "Done" → Validar PR exists (si no, alerta)
  - Agent terminado → Estado en plan coincida con realidad

### telegram-commander.js ⭐⭐ DAEMON PERSISTENTE
- **Lanzado por:** commander-launcher.js (hook personalizado al iniciar Claude)
- **PID file:** `.claude/hooks/telegram-commander.lock`
- **Log:** `.claude/hooks/telegram-commander.log`
- **Ciclo:** Cada 10-300s (heartbeat adaptativo según actividad)
- **Propósito:** Recibir comandos remotos, ejecutarlos, responder
- **Estado que toca:**
  - `.claude/hooks/telegram-config.json` (lectura)
  - `.claude/hooks/telegram-message-registry.json` (registro de mensajes)
  - `.claude/hooks/telegram-outbox.json` (queue de envíos)
  - `.claude/hooks/heartbeat-state.json` (frecuencia adaptativa)
- **Falla crítica?:** NO (solo comandos remotos)
- **Comandos disponibles:**
  - `/monitor` — Dashboard sprint actual
  - `/ops` — Health-check entorno
  - `/cleanup` — Limpiar workspace
  - `/help` — Lista de comandos
  - `/scrum audit` — Auditar sprint
- **Heartbeat:** Envía screenshot del Monitor cada X minutos (adaptativo)

---

## 7. Tabla de Dependencias Entre Scripts

```
agent-concurrency-check.js
  ├─→ sprint-sync.js (sincronizar roadmap)
  ├─→ Start-Agente.ps1 (lanzar siguiente)
  └─→ notify-telegram.js (notificar)

post-git-push.js
  ├─→ ci-monitor-bg.js (lanzar en background)
  ├─→ Start-Agente.ps1 (promover cola)
  └─→ notify-telegram.js (notificar)

scrum-monitor-bg.js
  ├─→ health-check-sprint.js (ejecutar auditoría)
  ├─→ scrum-auto-corrections.js (auto-reparar)
  └─→ notify-telegram.js (alerta crítica)

ci-monitor-bg.js
  └─→ notify-telegram.js (status CI)

telegram-commander.js
  ├─→ /monitor (invoca skill)
  ├─→ /ops (invoca skill)
  ├─→ /cleanup (invoca skill)
  └─→ notify-telegram.js (responder usuario)

activity-logger.js
  └─→ (ninguna, solo append a .jsonl)

permission-gate.js
  ├─→ permission-approver.js (tomar decisión)
  └─→ telegram-commander.js (si requiere aprobación remota)
```

---

## 8. Checklist de Referencia Rápida

- [ ] ¿Cola no se promueve? → Revisar agent-concurrency-check.js logs
- [ ] ¿Agente no se lanza tras Stop? → Verificar Start-Agente.ps1 existe, permisos
- [ ] ¿CI no detectado? → Revisar post-git-push.js se disparó, ci-monitor-bg.js logs
- [ ] ¿Sprint desincronizado? → Ejecutar `scrum-monitor-bg.js --audit --repair`
- [ ] ¿Comandos Telegram no responden? → Verificar telegram-commander.js activo (PID)
- [ ] ¿Permisos bloqueados? → Revisar permission-gate.js logs, aprobaciones pendientes
- [ ] ¿Rama protegida por error? → Verificar branch-guard.js regex patterns

---

**Documento de referencia técnica** — Actualizar cuando se agreguen/cambien hooks.
**Última actualización:** 2026-03-12
