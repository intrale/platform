# Guía de Monitoreo — Sistema Operativo Intrale Platform

**Cómo interpretar, diagnosticar y actuar sobre el estado del sistema.**

> **Última actualización:** 2026-03-12
> **Enfoque:** Monitoreo proactivo + auto-reparación + alertas remota via Telegram

---

## 1. Tres Niveles de Monitoreo

### Nivel 1: PASIVO (Telegram Heartbeat)

**Qué es:** Notificaciones automáticas cada 10-30 minutos al Telegram channel

**Información recibida:**
```
STATUS OPERATIVO — SPR-024
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Agentes activos: 3/3 (slots completos)
En cola: 0 pendientes
Completados: 5/8 (62.5%)

Subsistemas:
✓ Branch guard       OK (protegiendo main)
✓ CI monitor        OK (2 builds en progreso)
✓ Telegram commander activo (PID 12345)
✓ Agent watcher     activo (PID 12346)
⚠ Scrum health      2 inconsistencias detectadas

Últimas acciones:
• Agent 3 (#1456) lanzado hace 2h
• Agent 1 (#1450) terminó hace 45min
• PR #1267 mergeado (CI pasó)

Próximo chequeo: en 10 minutos
```

**Cómo actuar:**
- Verde (✓) → Sin acción necesaria
- Amarillo (⚠) → Verificar con `/ops` o `/scrum audit`
- Rojo (✗) → Acción inmediata requerida

### Nivel 2: ACTIVO (Comandos Remotos)

**Qué es:** Ejecutar comandos desde Telegram sin acceso a terminal

**Comandos disponibles:**
```
/monitor          Dashboard detallado del sprint
/ops             Health-check del entorno (JAVA, Node, gh, hooks)
/ghostbusters    Cazar fantasmas: procesos, worktrees, sesiones, locks, logs, QA
/scrum audit     Auditar sincronización Project V2
/help            Listar comandos disponibles
```

**Ejemplo de uso:**
```
Usuario en Telegram: /monitor
↓
telegram-commander.js lee comando
↓
Ejecuta /monitor skill
↓
Genera dashboard con:
  • Estado de agentes (activos, esperando, completados)
  • Progreso del sprint (3/8 completados = 37.5%)
  • Slots disponibles
  • Próximo en cola
↓
Responde con screenshot o tabla en Telegram
```

### Nivel 3: INTERNO (Logs y State Files)

**Qué es:** Análisis técnico de archivos de estado para debugging

**Archivos principales:**
```
.claude/activity-log.jsonl     ← Log continuo (Monitor lee esto)
.claude/hooks/hook-debug.log   ← Debug de hooks (último 500 líneas)
scripts/sprint-plan.json       ← Plan + agentes + cola + métrica
.claude/hooks/scrum-health-history.jsonl ← Historial de salud
.claude/sessions/*.json        ← Metadatos de sesiones
```

---

## 2. Monitoreo por Subsistema

### 2.1 AGENTES (concurrency, promotion, lifecycle)

**Qué monitorear:**
- ¿Hay siempre 3 agentes activos (o menos si casi terminan)?
- ¿Se promueven automáticamente de _queue[] cuando termina uno?
- ¿Hay agentes en estado "waiting" (esperando CI)?

**Cómo monitorear:**
```bash
# Terminal local
cat scripts/sprint-plan.json | jq '.agentes[] | {numero, issue, status}'

# Telegram
/monitor
  → "Agentes activos: 3/3"
  → "En cola: 1 pendiente"
  → "Esperando CI: 1 (Agent 2, hace 15min)"
```

**Umbrales de alerta:**
- Agentes activos < 2 (cuando debería haber >2) → Investigar
- Agente en "waiting" >30min → Posible CI stuck
- Cola >5 items → Sprint muy grande o agentes lentos
- Ningún agente activo (durante sprint abierto) → CRÍTICO

**Auto-reparación:**
- agent-watcher.js detecta agente zombie (30+ min inactivo) → Marca dead
- agent-concurrency-check.js promueve automáticamente
- Si ambos fallan → Manual: `/ops` + `Start-Agente.ps1 <numero>`

### 2.2 CI MONITOR (GitHub Actions polling)

**Qué monitorear:**
- ¿Los builds se lanzan después de cada push?
- ¿El monitor notifica status (✓ pass / ✗ fail)?
- ¿Los PRs se mergean automáticamente cuando CI pasa?

**Cómo monitorear:**
```bash
# Buscar en hook-debug.log
tail -30 .claude/hooks/hook-debug.log | grep "PostGitPush\|ci-monitor"

# Telegram (observe los cambios de estado)
"CI: Testando PR #1267..."
"CI: PASS ✓ — Mergeando automáticamente"
"CI: FAIL ✗ — Ver logs en GitHub"
```

**Umbrales de alerta:**
- CI no se lanza tras push >2min → post-git-push.js no disparó
- CI nunca termina (stuck en "running") >1h → Problema en GitHub Actions
- PR no se mergea tras CI pass → CI monitor no detectó, mergear manual

**Auto-reparación:**
- ci-monitor-bg.js reintenta polling cada 30s
- Si falla >5 veces → Alerta a Telegram
- Manual: revisar GitHub Actions en web, mergear PR manualmente si es necesario

### 2.3 SPRINT HEALTH (Project V2 sincronización)

**Qué monitorear:**
- ¿Están todas las issues en el estado correcto en Project V2?
- ¿Están los agentes marcados "Done" cuando termina el worktree?
- ¿Los PRs mergeados corresponden a issues "Done"?

**Cómo monitorear:**
```bash
# Ejecutar auditoría manual
/scrum audit
  → "Inconsistencias: 2"
  → "Issue #1456 dice 'Done' pero PR aún en 'Draft'"
  → "Issue #1457 PR mergeado pero Estado en 'In Progress'"

# O en Telegram
/scrum audit
  → Dashboard mostrando state mismatch
```

**Inconsistencias detectadas automáticamente:**

| Inconsistencia | Síntoma | Auto-reparable |
|---|---|---|
| PR mergeado pero issue "Open" | Issue no pasó a "Done" | SÍ (scrum-monitor-bg cierra) |
| Issue "Done" pero PR en Draft | PR no publicado | NO (requiere acción) |
| Agente terminado pero issue "In Progress" | Estado stale | SÍ (mueve a "Done") |
| Issue sin PR pero dice "Done" | Cambios sin entregar | NO (revisar) |
| _completed[] en sprint-plan.json ≠ Project V2 "Done" | Desincronización | SÍ (sincroniza) |

**Auto-reparación:**
- scrum-monitor-bg.js detecta inconsistencias cada 30min
- Auto-repara: "PR merged" + "issue open" → Cierra issue a "Done"
- Si no puede reparar → Alerta a Telegram para acción manual

### 2.4 PERMISSION & SECURITY

**Qué monitorear:**
- ¿Las herramientas HIGH severity requieren aprobación?
- ¿Hay intenta de acceso bloqueadas por seguridad?
- ¿Se está auditando quién aprobó qué?

**Cómo monitorear:**
```bash
# Ver decisiones de permisos
tail -50 .claude/hooks/permission-tracker.log

# Ver aprobaciones pendientes
cat .claude/hooks/pending-questions.json

# Telegram
/ops
  → "Permission gate: OK (0 pendientes)"
  → "Últimas aprobaciones: git push (3), Bash (5), rm -rf (deniegado)"
```

**Umbrales de alerta:**
- Herramienta bloqueada >5 veces en 10min → Posible ataque/error recurrente
- Aprobación PENDING >15min → Usuario no respondió, timeout
- Cambio en permission-approver.js sin notificación → Revisar cambios

### 2.5 ACTIVITY LOG (Registro temporal)

**Qué monitorear:**
- ¿Se están registrando TODAS las acciones?
- ¿La actividad del agente es coherente con el esperado?
- ¿Hay errores en los últimos eventos?

**Cómo interpretar `.claude/activity-log.jsonl`:**

```json
{"timestamp":"2026-03-12T10:30:45.123Z","tool":"Read","duration_ms":234,"task_progress":"3/5 (60%)","status":"ok"}
{"timestamp":"2026-03-12T10:31:12.456Z","tool":"Bash","input":"git push origin agent/1456","duration_ms":5000,"status":"ok","hook":"post-git-push"}
{"timestamp":"2026-03-12T10:31:15.789Z","tool":"Bash","input":"git status","duration_ms":234,"status":"ok"}
{"timestamp":"2026-03-12T10:31:45.000Z","tool":"Agent","action":"Stop","duration_min":75,"task":"1456-docs-arch"}
```

**Campos clave:**
- `timestamp` — Cuándo pasó
- `tool` — Qué herramienta (Read, Edit, Bash, etc.)
- `duration_ms/duration_min` — Cuánto tardó
- `status` — ok / error
- `task_progress` — % completado (si está usando TaskCreate)
- `hook` — Qué hook disparó (si aplica)

**Umbrales de alerta:**
- Event de error → Revisar message
- Herramienta tarda >5x lo esperado → Posible hang
- Gaps sin eventos >5min → Sesión inactive, ¿proceso stuck?

---

## 3. Diagnóstico de Incidentes Comunes

### Incidente: "Agente no se promueve de la cola"

**Síntomas:**
- Cola tiene items pero no se lanzan
- Agentes = 2 cuando debería haber 3
- Última línea de hook-debug.log hace >10 minutos

**Diagnosis:**
```bash
# 1. Verificar si hay espacio
cat scripts/sprint-plan.json | jq '{agentes: .agentes | length, queue: ._queue | length, limit: .concurrency_limit}'

# 2. Verificar si agent-concurrency-check.js se ejecutó
grep "ConcurrencyCheck:" .claude/hooks/hook-debug.log | tail -5

# 3. Verificar si agent-watcher detectó el problema
grep "Watcher:" .claude/hooks/agent-watcher.log | tail -10
```

**Causas posibles:**
1. Hook Stop no disparó (sesión anterior no terminó correctamente) → `/ops` + reinicio
2. Start-Agente.ps1 no existe o no tiene permisos → Verificar archivo
3. sprint-plan.json corrupto (JSON inválido) → reparar manualmente o restaurar de backup
4. agent-watcher muerto → Lanzar manualmente: `node .claude/hooks/agent-watcher.js`

**Acción correctiva:**
```bash
# Verificar si hay proceso colgado
ps aux | grep -i agent

# Matar proceso que cuelga (si aplica)
kill -9 <PID>

# Lanzar siguiente manualmente
Start-Agente.ps1 4

# Verificar que se lanzó
sleep 5 && ps aux | grep -i claude
```

### Incidente: "CI stuck en 'running' más de 1 hora"

**Síntomas:**
- Telegram muestra "CI: Testando..." hace >1h
- Agent en "waiting" status
- PR no se mergea

**Diagnosis:**
```bash
# 1. Verificar si ci-monitor-bg sigue vivo
cat .claude/hooks/ci-monitor-bg.pid && ps aux | grep <PID>

# 2. Ver últimos logs del monitor
tail -20 .claude/hooks/ci-monitor-bg.log

# 3. Revisar GitHub Actions en web
gh run list --repo intrale/platform --limit 5
```

**Causas posibles:**
1. GitHub Actions workflow stuck (hang interno de GitHub) → Cancelar en web, re-run
2. ci-monitor-bg.js se quedó sin procesar respuesta → Matar y relanzar
3. Red issue → Revisar conectividad `curl -I https://api.github.com`

**Acción correctiva:**
```bash
# 1. Matar ci-monitor-bg
kill -9 $(cat .claude/hooks/ci-monitor-bg.pid) 2>/dev/null

# 2. Cancelar workflow en GitHub (en web)
gh run cancel <run-id> --repo intrale/platform

# 3. Re-trigger o mergear manualmente
gh pr merge <PR_NUMBER> --repo intrale/platform --auto

# 4. Relanzar ci-monitor si es necesario
node .claude/hooks/ci-monitor-bg.js &
```

### Incidente: "Sprint desincronizado (Project V2 vs sprint-plan.json)"

**Síntomas:**
- Telegram: "Inconsistencias: 5"
- `/scrum audit` muestra discrepancias
- Issues con estado incorrecto en Project V2

**Diagnosis:**
```bash
# 1. Ver inconsistencias detectadas
cat .claude/hooks/scrum-health-history.jsonl | tail -5 | jq '.inconsistencies'

# 2. Comparar plan vs Project V2
gh api graphql -F query='query { organization(login: "intrale") { projectV2(number: 1) { items(first: 20) { nodes { content { ... on Issue { number } } } } } } }' 2>/dev/null

# 3. Verificar qué quiere reparar scrum-monitor-bg
grep "auto-repair\|inconsistency" .claude/hooks/hook-debug.log | tail -10
```

**Causas posibles:**
1. PR se mergeó pero issue no pasó a "Done" → scrum-monitor-bg lo repara automáticamente
2. Cambio manual en Project V2 sin actualizar sprint-plan.json → Sincronizar
3. Issue cerrada fuera de Intrale pipeline → Verificar en web, actualizar manualmente

**Acción correctiva:**
```bash
# 1. Si scrum-monitor-bg no ejecutó, hacerlo manualmente
node .claude/hooks/health-check-sprint.js --auto-repair

# 2. Si aún hay inconsistencias, sincronizar manualmente
gh pr list --repo intrale/platform --state merged --limit 20 --json number,mergedAt,baseRefName

# 3. Para cada PR mergeado, actualizar issue a "Done" en Project V2
gh issue edit <issue_number> --repo intrale/platform --state closed
```

### Incidente: "Telegram commander no responde comandos"

**Síntomas:**
- Escribo `/monitor` en Telegram pero no hay respuesta
- Heartbeat no se envía
- Telegram command queue acumulándose

**Diagnosis:**
```bash
# 1. Verificar si commander está vivo
cat .claude/hooks/telegram-commander.lock
ps aux | grep $(cat .claude/hooks/telegram-commander.lock)

# 2. Ver logs del commander
tail -50 .claude/hooks/telegram-commander.log

# 3. Verificar conexión a Telegram API
curl -I https://api.telegram.org/

# 4. Verificar config
cat .claude/hooks/telegram-config.json | jq '.bot_token, .chat_id'
```

**Causas posibles:**
1. Commander está muerto → Relanzar
2. Token de Telegram expirado o inválido → Actualizar telegram-config.json
3. Chat ID incorrecto → Verificar en Telegram (buscar @Intrale_claude_bot)
4. Red bloqueada → Verificar conectividad, proxy
5. Heartbeat frecuencia demasiado alta → Ajustar WATCHER_POLL_INTERVAL

**Acción correctiva:**
```bash
# 1. Matar proceso viejo
kill -9 $(cat .claude/hooks/telegram-commander.lock) 2>/dev/null
rm .claude/hooks/telegram-commander.lock

# 2. Relanzar commander
node .claude/hooks/commander-launcher.js &

# 3. Verificar en Telegram
# (Esperar 10s y enviar /help)

# 4. Si aún no responde, ver logs
tail -100 .claude/hooks/telegram-commander.log
```

---

## 4. Tabla de Umbrales

| Métrica | Amarillo (⚠) | Rojo (✗) | Acción |
|---------|-------------|---------|--------|
| Agentes activos | <2 cuando esperado ≥3 | 0 durante sprint | `/ops` + reinicio |
| Agente en "waiting" | >15 min | >30 min | Revisar CI, posible cancelar |
| Cola pendiente | >5 items | >10 items | Sprint demasiado grande, replanificar |
| CI en "running" | >30 min | >60 min | Cancelar workflow en GitHub |
| Scrum inconsistencies | >1 | >3 | `/scrum audit` + auto-repair |
| Hook-debug.log size | >1 MB | >2 MB | `/ghostbusters --logs --run` |
| Activity-log entries | >1000 | >5000 | `/ghostbusters --logs --run` |
| Telegram no responde | >5 seg | >30 seg | Reiniciar commander |
| Branch-guard trigger | >5 veces/día | >10 veces/día | Revisar si alguien intenta push a main |

---

## 5. Comandos de Diagnóstico Útiles

### Health-check rápido
```bash
/ops
# Retorna: JAVA, Node, gh CLI, hooks, disco, procesos
```

### Auditar sprint
```bash
/scrum audit
# Retorna: inconsistencias, estado de issues, Project V2 status
```

### Cazar fantasmas (limpiar workspace)
```bash
/ghostbusters
# Retorna: dry-run con lo que se limpiaría (procesos, worktrees, sesiones, locks, logs, QA)
# Ejecutar con --run para limpiar realmente
```

### Ver activity log en tiempo real
```bash
tail -f .claude/activity-log.jsonl | jq '.tool, .status'
```

### Monitorear un agente específico
```bash
ISSUE=1456
tail -f .claude/hooks/hook-debug.log | grep "agent.*$ISSUE"
```

---

**Documento de monitoreo operativo** — Actualizar cuando cambien métricas o umbrales.
**Última actualización:** 2026-03-12
