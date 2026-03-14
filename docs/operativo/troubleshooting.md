# Troubleshooting — Árbol de Decisión de Incidentes

**Guía rápida para diagnosticar y resolver 15+ problemas operativos comunes.**

> **Última actualización:** 2026-03-12
> **Formato:** Árbol de decisión (SI → acción | NO → siguiente nodo)

---

## Flujo Principal: Identificar el Síntoma

```
┌─────────────────────────────────────────────┐
│ ¿CUÁL ES EL SÍNTOMA PRINCIPAL?              │
├─────────────────────────────────────────────┤
│                                             │
│ A) Agente no se lanza / no continúa        │→ FLUJO A
│ B) Build/Tests fallan                      │→ FLUJO B
│ C) CI/GitHub está stuck                    │→ FLUJO C
│ D) Permisos bloqueados / seguridad         │→ FLUJO D
│ E) Telegram no responde                    │→ FLUJO E
│ F) Sprint desincronizado                   │→ FLUJO F
│ G) Comando falla con error desconocido     │→ FLUJO G
│ H) Workspace lento / disco lleno           │→ FLUJO H
│                                             │
└─────────────────────────────────────────────┘
```

---

## FLUJO A: Agente no se lanza / no continúa

```
┌─ Síntoma: Agente parado, no ejecuta siguiente tarea
│
├─ Pregunta 1: ¿La rama agent/* existe?
│  │
│  ├─ NO  → Error: Rama no creada
│  │  │
│  │  └─ Acción:
│  │     1. Ejecutar: /branch <issue> <slug>
│  │     2. Reintentar
│  │
│  └─ SÍ  → Pregunta 2
│
├─ Pregunta 2: ¿Hay 3 o más agentes activos?
│  │
│  ├─ SÍ  → Error: Límite de concurrencia alcanzado (esperar)
│  │  │
│  │  └─ Acción:
│  │     1. Ejecutar: /monitor (ver quién está activo)
│  │     2. Esperar a que termine alguno (esperado 2-5 min)
│  │     3. Verificar que se promueva automáticamente
│  │     4. Si no se promueve tras 10 min → Pregunta 3
│  │
│  └─ NO → Pregunta 3
│
├─ Pregunta 3: ¿Hay items en _queue[] que debería promover?
│  │
│  ├─ NO  → Fin (no hay más para lanzar, sprint casi completo)
│  │
│  └─ SÍ  → Error: No se promociona automáticamente
│     │
│     ├─ Acción A1: Verificar hook Stop
│     │  1. Ver logs: grep "ConcurrencyCheck:" .claude/hooks/hook-debug.log
│     │  2. ¿Hay línea con "promoted"?
│     │     - NO → Hook no se ejecutó
│     │     - SÍ → Hook ejecutó pero Start-Agente falló
│     │
│     ├─ Acción A2: Verificar Start-Agente.ps1
│     │  1. Archivo existe: test -f scripts/Start-Agente.ps1
│     │  2. Es ejecutable: ls -la scripts/Start-Agente.ps1
│     │  3. Permisos correctos (755)
│     │
│     ├─ Acción A3: Lanzar manualmente
│     │  1. Obtener número siguiente: jq '.agentes | length' scripts/sprint-plan.json
│     │  2. Lanzar: Start-Agente.ps1 <numero>
│     │  3. Esperar 10s y verificar: ps aux | grep -i claude
│     │
│     └─ Acción A4: Si sigue fallando
│        1. Revisar permisos de .claude/hooks/
│        2. Revisar si worktree padre existe: git worktree list
│        3. Ejecutar: /ops --fix (auto-reparar entorno)
│        4. Reintentar lanzamiento manual
```

---

## FLUJO B: Build/Tests fallan

```
┌─ Síntoma: Agent invoca /tester o /builder y reporta error
│
├─ Pregunta 1: ¿Es error de compilación Kotlin?
│  │
│  ├─ SÍ  → Error: Sintaxis o dependencia de build
│  │  │
│  │  └─ Acción:
│  │     1. Leer mensaje de error completo (no solo título)
│  │     2. Buscar en logs: grep -A 5 "error:" .gradle/build.log
│  │     3. Causas comunes:
│  │        - Import faltante → Agregar import
│  │        - Tipo incorrecto → Revisar tipos
│  │        - Dependencia versionada mal → Actualizar version
│  │     4. Invocar /guru para investigar patrón
│  │     5. Arreglar código
│  │     6. Reintentar: /builder
│  │
│  └─ NO  → Pregunta 2
│
├─ Pregunta 2: ¿Es error de test (test fallan)?
│  │
│  ├─ SÍ  → Error: Test assertion failure
│  │  │
│  │  └─ Acción:
│  │     1. Leer assertion que falló (esperado vs actual)
│  │     2. Causas comunes:
│  │        - Lógica del test anticuada (código cambió)
│  │        - Mock incorrecto (stub no retorna lo esperado)
│  │        - Estado compartido entre tests (orden matters)
│  │     3. Invocar /guru para investigar por qué falla
│  │     4. Arreglar test O código (según sea necesario)
│  │     5. Reintentar: /tester
│  │
│  └─ NO  → Pregunta 3
│
├─ Pregunta 3: ¿Es error de dependencia de proyecto?
│  │
│  ├─ SÍ  → Error: Gradle no encuentra jar, librería versionada mal
│  │  │
│  │  └─ Acción:
│  │     1. Ejecutar limpie: ./gradlew clean
│  │     2. Relanzar build: ./gradlew build
│  │     3. Si sigue fallando, ver si es problema de red
│  │        (Gradle descarga desde Maven Central)
│  │     4. Invocar /guru para investigar dependencia
│  │     5. Actualizar build.gradle si es necesario
│  │
│  └─ NO  → Acción B (Error desconocido)
│
└─ Acción B: Error desconocido
   1. Copiar mensaje de error completo
   2. Buscar en logs: grep -i "error\|exception" .gradle/*.log
   3. Ejecutar: /ops (diagnosticar entorno)
   4. Invocar: /guru (investigar patrón raro)
   5. Ejecutar: /security (¿hay problema de seguridad?)
```

---

## FLUJO C: CI/GitHub está stuck

```
┌─ Síntoma: GitHub Actions no responde, CI "running" >1h, PR no se mergea
│
├─ Pregunta 1: ¿La rama tiene PR abierto?
│  │
│  ├─ NO  → Error: No hay PR creado (falta /delivery)
│  │  │
│  │  └─ Acción:
│  │     1. Ejecutar: /delivery (crear PR)
│  │     2. Revisar: gh pr list --repo intrale/platform (buscar PR)
│  │
│  └─ SÍ  → Pregunta 2
│
├─ Pregunta 2: ¿GitHub Actions está ejecutando workflow?
│  │
│  ├─ NO  → Error: Workflow no se triggeró
│  │  │
│  │  └─ Acción:
│  │     1. Revisar: .github/workflows/ (existe workflow?)
│  │     2. Revisar: event trigger (push, pull_request, etc)
│  │     3. Re-trigger manualmente en web: GitHub → Actions → Re-run
│  │
│  └─ SÍ  → Pregunta 3
│
├─ Pregunta 3: ¿Workflow está en estado "running"?
│  │
│  ├─ NO (success/failure) → Pregunta 4
│  │
│  └─ SÍ  → Error: Workflow stuck en "running"
│     │
│     └─ Acción C1:
│        1. Ver cuánto tiempo lleva: gh run view <run-id> --repo intrale/platform
│        2. Si >30 min:
│           a. Cancelar workflow: gh run cancel <run-id> --repo intrale/platform
│           b. Esperar 30s
│           c. Re-run: gh run rerun <run-id> --repo intrale/platform
│        3. Si >1 hora: Posible deadlock en GitHub
│           a. Mergear manualmente: gh pr merge <PR_NUMBER> --repo intrale/platform --auto
│           b. Ejecutar tests localmente: ./gradlew test
│           c. Si tests pasan, mergear
│
├─ Pregunta 4: ¿Workflow pasó (success)?
│  │
│  ├─ SÍ  → Error: CI pasó pero PR no se mergeó
│  │  │
│  │  └─ Acción:
│  │     1. Verificar auto-merge habilitado: gh pr view <PR_NUMBER> --repo intrale/platform | grep -i merge
│  │     2. Mergear manualmente: gh pr merge <PR_NUMBER> --repo intrale/platform --auto
│  │     3. Si falla merge:
│  │        - Conflictos → Resolver en agent branch, push
│  │        - Permisos → Revisar si usuario tiene permisos
│  │        - Branch rules → Revisar policy de main
│  │
│  └─ NO → Error: Workflow falló
│     │
│     └─ Acción C2:
│        1. Ver logs: gh run view <run-id> --repo intrale/platform --log
│        2. Buscar línea "FAILED" o "ERROR"
│        3. Leer error completo
│        4. Arreglar:
│           a. Si es test: Arreglar test, push, re-trigger workflow
│           b. Si es build: Arreglar build, push
│           c. Si es infra: Revisar GitHub secrets, .yml configuration
│        5. Invocar: /guru (si es error confuso)
```

---

## FLUJO D: Permisos bloqueados / Seguridad

```
┌─ Síntoma: Comando denegado, "Permission denied", HIGH severity block
│
├─ Pregunta 1: ¿Qué comando fue bloqueado?
│  │
│  ├─ git push origin main → Error: branch-guard (correcto, es protección)
│  │  │
│  │  └─ Acción:
│  │     1. NO intentar ignorar protección (--no-verify, etc.)
│  │     2. Crear rama: /branch <issue> <slug>
│  │     3. Trabajar en rama, push a rama
│  │
│  ├─ rm -rf build/ → Error: HIGH severity, requiere Telegram approval
│  │  │
│  │  └─ Acción:
│  │     1. Revisar telegram-commander activo: ps aux | grep commander
│  │     2. Verificar Telegram (¿notificación llegar?):
│  │        - SÍ → Presionar "✅ Aprobar" en Telegram
│  │        - NO → Telegram offline (ver FLUJO E)
│  │     3. Si espera >15 min, timeout automático → Denegar
│  │     4. Usar /cleanup --run en su lugar (tiene autorización pre-built)
│  │
│  └─ Otro comando → Pregunta 2
│
├─ Pregunta 2: ¿Quién solicitó el permiso?
│  │
│  ├─ Usuario real (yo) → Pregunta 3
│  │
│  └─ Agente IA → Acción D1 (Investigar por qué agente pide algo riesgoso)
│
├─ Pregunta 3: ¿El comando es seguro?
│  │
│  ├─ SÍ  → Acción D2 (Aprobar en Telegram)
│  │
│  └─ NO  → Acción D3 (Denegar en Telegram)
│
├─ Acción D1: Agente pide comando riesgoso
│  │
│  └─ Cause: Agente en estado confundido o bug
│     1. Leer issue del agente: gh issue view <issue_number>
│     2. Revisar qué intenta hacer el agente (repo master? Rama main?)
│     3. Denegar permiso en Telegram
│     4. Parar agente manualmente
│     5. Invocar: /guru (diagnosticar por qué agente pidió eso)
│
├─ Acción D2: Aprobar permiso en Telegram
│  │
│  └─ Presionar botón "✅ Aprobar" en Telegram
│     1. Comando se ejecuta
│     2. Auditar después: grep "APPROVED" .claude/hooks/permission-tracker.log
│
└─ Acción D3: Denegar permiso
   │
   └─ Presionar "❌ Denegar" en Telegram
      1. Comando se bloquea
      2. Agente recibe error de permiso
      3. Investigar por qué lo pidió (probablemente bug)
```

---

## FLUJO E: Telegram no responde

```
┌─ Síntoma: Envío comando pero no hay respuesta, heartbeat desaparece
│
├─ Pregunta 1: ¿El bot está en el grupo/chat?
│  │
│  ├─ NO  → Error: Bot no está invitado
│  │  │
│  │  └─ Acción:
│  │     1. Ir a Telegram
│  │     2. Buscar @Intrale_claude_bot
│  │     3. Agregar al chat/grupo
│  │     4. Esperar 10s y enviar /help
│  │
│  └─ SÍ  → Pregunta 2
│
├─ Pregunta 2: ¿El commander sigue vivo?
│  │
│  ├─ NO  → Error: Proceso comando muerto
│  │  │
│  │  └─ Acción E1:
│  │     1. Ver si hay proceso: ps aux | grep telegram-commander
│  │     2. Matar si está colgado: kill -9 <PID>
│  │     3. Verificar lock: cat .claude/hooks/telegram-commander.lock
│  │     4. Matar: kill -9 <PID_FROM_LOCK>
│  │     5. Borrar lock: rm .claude/hooks/telegram-commander.lock
│  │     6. Relanzar: node .claude/hooks/commander-launcher.js
│  │     7. Esperar 5s y enviar /help en Telegram
│  │
│  └─ SÍ  → Pregunta 3
│
├─ Pregunta 3: ¿Token de Telegram es válido?
│  │
│  ├─ NO  → Error: Token expirado o incorrecto
│  │  │
│  │  └─ Acción E2:
│  │     1. Obtener nuevo token: @BotFather → /newtoken → crear nuevo
│  │     2. Actualizar: nano .claude/hooks/telegram-config.json
│  │     3. Guardar nuevo bot_token
│  │     4. Reiniciar commander: kill -9 <PID> + re-launch
│  │
│  └─ SÍ  → Pregunta 4
│
├─ Pregunta 4: ¿Hay conectividad a API de Telegram?
│  │
│  ├─ NO  → Error: Problema de red
│  │  │
│  │  └─ Acción E3:
│  │     1. Verificar conectividad: curl -I https://api.telegram.org/
│  │     2. Si falla (no "200 OK"), hay problema de red:
│  │        - VPN activado? (podría estar bloqueando)
│  │        - Firewall rule? (check: `ipconfig /flushdns` en Windows)
│  │        - ISP blocking Telegram?
│  │     3. Opción: Usar proxy HTTP si ISP bloquea
│  │        - Agregar en telegram-config.json: "proxy": "http://ip:puerto"
│  │        - Reiniciar commander
│  │
│  └─ SÍ  → Pregunta 5
│
└─ Pregunta 5: ¿Chat ID es correcto?
   │
   ├─ NO  → Error: Chat ID incorrecto
   │  │
   │  └─ Acción:
   │     1. Obtener chat ID correcto:
   │        - Enviar /start al @Intrale_claude_bot (sin ser agente)
   │        - Bot responde con tu chat ID
   │     2. Actualizar: nano .claude/hooks/telegram-config.json
   │     3. Actualizar chat_id
   │     4. Reiniciar commander
   │
   └─ SÍ  → Error desconocido
      │
      └─ Acción E4:
         1. Ver logs del commander: tail -100 .claude/hooks/telegram-commander.log
         2. Buscar línea con error
         3. Invocar: /guru (investigar error específico)
         4. Ejecutar: /ops (diagnosticar entorno)
```

---

## FLUJO F: Sprint desincronizado

```
┌─ Síntoma: /scrum audit muestra inconsistencias, Project V2 ≠ sprint-plan.json
│
├─ Pregunta 1: ¿Cuál es la inconsistencia exacta?
│  │
│  ├─ "PR merged but issue still OPEN" → Acción F1
│  ├─ "Issue DONE but no PR" → Acción F2
│  ├─ "Agent done but in-progress" → Acción F3
│  ├─ "Plan ≠ Project V2" → Acción F4
│  └─ Otro → Acción F5
│
├─ Acción F1: PR merged pero issue no pasó a "Done"
│  │
│  └─ Causa: scrum-monitor-bg no ejecutó o falló
│     1. Ejecutar manualmente: node .claude/hooks/health-check-sprint.js --auto-repair
│     2. Esperar 30s
│     3. Verificar: /scrum audit (¿inconsistencias desaparecieron?)
│     4. Si no: Cerrar issue manualmente
│        gh issue close <issue_number> --repo intrale/platform
│
├─ Acción F2: Issue "DONE" pero no hay PR
│  │
│  └─ Causa: Issue cerrada pero cambios no entregados
│     1. Revisar: ¿hay rama agent/* abierta? git branch -a | grep agent
│     2. Si hay rama:
│        - ¿PR existe pero no merged? → Mergear: gh pr merge <PR> --repo intrale/platform
│        - ¿No hay PR? → Crear: /delivery (desde la rama)
│     3. Si no hay rama:
│        - Issue estaba "Done" pero la rama se eliminó
│        - Revisar historial: git log --all --grep="<issue>"
│        - Si los cambios se perdieron: Acción manual required
│
├─ Acción F3: Agent "done" en sprint-plan pero "In Progress" en Project V2
│  │
│  └─ Causa: Agent terminó pero Project V2 no se actualizó
│     1. Ejecutar: node .claude/hooks/scrum-validator.js --repair-status
│     2. Esperar 30s
│     3. Verificar: /scrum audit
│     4. Si no se repara: Actualizar manualmente
│        gh api graphql -f query='mutation { updateProjectV2ItemFieldValue(...) }'
│
├─ Acción F4: sprint-plan.json ≠ Project V2
│  │
│  └─ Causa: Cambios manuales en Project V2 o en sprint-plan.json
│     1. Decidir: ¿Project V2 es verdad O plan es verdad?
│        - Si plan es correcto: Actualizar Project V2 manualmente
│        - Si Project V2 es correcto: Actualizar plan
│     2. Sincronizar:
│        node .claude/hooks/sprint-manager.js --force-sync
│     3. Verificar: /scrum audit
│
└─ Acción F5: Otro tipo de inconsistencia
   │
   └─ Acción:
      1. Leer error completo: /scrum audit
      2. Ver si es auto-reparable: node .claude/hooks/scrum-validator.js
      3. Si no: Invocar /guru (investigar problema específico)
      4. Considerar: Cierre de sprint y replanificación
```

---

## FLUJO G: Comando falla con error desconocido

```
┌─ Síntoma: Error genérico que no cae en ninguna categoría (A-F)
│
├─ Acción G1: Diagnosticar entorno
│  │
│  └─ Ejecutar: /ops
│     1. ¿Hay warnings o errores? Leerlos
│     2. Ejecutar sugerencias de /ops
│     3. Reintentar comando original
│
├─ Acción G2: Investigar patrón técnico
│  │
│  └─ Invocar: /guru "<error message>"
│     1. Copiar mensaje de error exacto
│     2. Pasar a /guru
│     3. Esperar análisis (puede llamar a otros skills)
│     4. Actuar sobre recomendaciones
│
├─ Acción G3: Buscar en logs históricos
│  │
│  └─ Buscar en activity-log:
│     cat .claude/activity-log.jsonl | grep -i "<keyword from error>"
│     1. ¿Ha pasado antes?
│     2. ¿Cuál fue la solución?
│
├─ Acción G4: Si error es en /delivery
│  │
│  └─ Ejecutar: /delivery --check
│     1. Ver si hay cambios pendientes
│     2. Ver si hay conflictos
│     3. Arreglre y reintentar /delivery
│
├─ Acción G5: Si error es en tests
│  │
│  └─ Ejecutar: /tester --verbose
│     1. Ver output completo
│     2. Arreglar test o código según sea necesario
│
├─ Acción G6: Si error es en build
│  │
│  └─ Ejecutar: /builder --verbose
│     1. Ver output completo
│     2. Ejecutar: ./gradlew clean build (limpiar y recompilar)
│
└─ Acción G7: Si nada funciona
   │
   └─ Última opción:
      1. Crear issue en GitHub con el error: gh issue create --repo intrale/platform ...
      2. Etiquetar: bug, type:infra
      3. Asignar a: leitolarreta (owner del proyecto)
      4. Parar agente actual (no continuar bloqueado)
      5. Esperar revisión manual
```

---

## FLUJO H: Workspace lento / Disco lleno

```
┌─ Síntoma: Comandos tardan >10s, "No space left", operaciones hang
│
├─ Pregunta 1: ¿Disco está lleno?
│  │
│  ├─ SÍ  → Acción H1 (Limpiar espacio)
│  │
│  └─ NO  → Pregunta 2
│
├─ Pregunta 2: ¿Hay muchos worktrees antiguas?
│  │
│  ├─ SÍ  → Acción H2 (Limpiar worktrees)
│  │
│  └─ NO  → Pregunta 3
│
├─ Pregunta 3: ¿Hay procesos colgados?
│  │
│  ├─ SÍ  → Acción H3 (Matar procesos zombie)
│  │
│  └─ NO  → Pregunta 4
│
├─ Pregunta 4: ¿Logs son gigantes?
│  │
│  ├─ SÍ  → Acción H4 (Limpiar logs)
│  │
│  └─ NO  → Acción H5 (Investigar cause)
│
├─ Acción H1: Limpiar espacio
│  │
│  └─ Ejecutar:
│     /cleanup --run --deep
│     1. Elimina: worktrees sibling, logs, node_modules, .gradle cache
│     2. Espera 5min
│     3. Verifica espacio: df -h /c/Workspaces/
│     4. Si sigue lleno:
│        - Revisar qué archivo es grande: du -sh /c/Workspaces/Intrale/platform/*
│        - Eliminar manualmente si necesario
│
├─ Acción H2: Limpiar worktrees antiguas
│  │
│  └─ Ejecutar:
│     git worktree prune -v
│     /cleanup --worktrees --run
│     1. Limpia references huérfanas
│     2. Elimina directorios vacios
│
├─ Acción H3: Matar procesos zombie
│  │
│  └─ Ejecutar:
│     ps aux | grep -i "claude\|node" | grep -v grep
│     1. Identificar procesos viejos (>2 horas)
│     2. Matar: kill -9 <PID>
│     3. Verificar: ps aux | grep claude
│
├─ Acción H4: Limpiar logs
│  │
│  └─ Ejecutar:
│     /cleanup --logs --run
│     1. Recorta hook-debug.log a 500 líneas
│     2. Recorta activity-log.jsonl a 200 entradas
│     3. Libera ~100+ MB
│
└─ Acción H5: Investigar causa lentitud
   │
   └─ Posibles causes:
      1. Gradle descargando dependencias → Esperar a que termine
      2. Network latency → Verificar conectividad: ping github.com
      3. Antivirus escanear archivos → Agregar .claude/ a exclusiones
      4. Disco fragmentado → Windows: defrag C:
```

---

## Tabla de Referencias Rápidas

| Problema | Comando Diagnostic | Acción Rápida |
|----------|-------------------|---------------|
| Agente no se promueve | `grep ConcurrencyCheck .claude/hooks/hook-debug.log` | `Start-Agente.ps1 <num>` |
| CI stuck | `gh run view <run-id> --repo intrale/platform` | Cancel + re-run en GitHub |
| Telegram no responde | `ps aux \| grep commander` | Relanzar commander |
| Tests fallan | `./gradlew test --info` | Arreglar test O código |
| Build falla | `./gradlew clean build` | Investigar con `/guru` |
| Permisos bloqueados | Ver Telegram | Aprobar / Denegar en Telegram |
| Disco lleno | `df -h /c/Workspaces/` | `/cleanup --run --deep` |
| Sprint desincronizado | `/scrum audit` | `/scrum repair --auto` |

---

**Documento de troubleshooting** — Actualizar cuando se agreguen nuevos problemas comunes.
**Última actualización:** 2026-03-12
**Próxima revisión:** Post SPR-025 (ajustar umbrales según experiencia real)
