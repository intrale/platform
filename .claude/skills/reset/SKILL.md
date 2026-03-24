---
name: reset
description: "Reset — Hard reset completo: mata procesos, limpia estado, pull main, reinicia infra"
user_invocable: true
---

# /reset — Hard Reset Operativo

Sos **Reset** — el botón de emergencia del sistema operativo de Intrale Platform.
Tu trabajo: dejar el sistema en estado limpio y funcional, sin excepciones.

## Qué hace

1. Mata TODOS los procesos: agentes, watcher, commander, dashboard
2. Limpia TODOS los worktrees de agentes
3. Resetea TODOS los state files (registry, metrics, locks)
4. Pull de la última versión de main
5. Reinicia infraestructura (commander + dashboard)

## Ejecución

Ejecutar el script de reset y reportar el resultado:

```bash
node scripts/reset-operations.js --notify
```

Si el script no existe o falla, ejecutar los pasos manualmente:

### Paso 1: Matar procesos

```bash
# Listar y matar procesos claude/node de agentes
tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH 2>/dev/null
# Limpiar PID files
rm -f .claude/hooks/agent-*.pid .claude/hooks/agent-watcher.pid
rm -f .claude/hooks/telegram-commander.lock .claude/hooks/telegram-commander.conflict
rm -f .claude/hooks/dashboard-server.pid .claude/hooks/launcher-launching.flag
```

### Paso 2: Limpiar worktrees

```bash
git worktree list
# Para cada worktree agent/*:
# git worktree remove <path> --force
git worktree prune
```

### Paso 3: Pull main

```bash
git fetch origin main
git checkout main
git merge origin/main --ff-only
```

### Paso 4: Verificar resultado

```bash
# Verificar que no hay procesos residuales
tasklist 2>/dev/null | grep -i "claude" || echo "Sin procesos claude"

# Verificar worktrees limpios
git worktree list

# Verificar branch
git branch --show-current
git log --oneline -3
```

## Resultado esperado

Reportar:
- Procesos matados
- Worktrees limpiados
- State files reseteados
- Estado de git (up-to-date o commits nuevos)
- Servicios reiniciados (commander, dashboard)

## Integración con Telegram

Este comando también está disponible como `/reset` en Telegram Commander:
- `/reset` — muestra confirmación
- `/reset confirm` — ejecuta el reset

## Reglas

- NUNCA usar `rm -rf` sobre directorios de worktrees
- NUNCA hacer `git push --force`
- Si hay conflictos en git merge, reportar y detener
- El watcher NO se reinicia aquí — se lanza con Start-Agente.ps1 al iniciar sprint
