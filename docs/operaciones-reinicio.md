# Reinicio Operativo del Sistema de Agentes

## Descripción

El reinicio operativo resetea el estado del sistema de hooks, agentes y Telegram Commander a un estado limpio. Es útil cuando el sistema queda inconsistente (archivos de estado stale, procesos huérfanos, sesiones desincronizadas).

## Métodos de ejecución

### 1. Desde terminal (directo)

```bash
node scripts/restart-operational-system.js
```

Flags disponibles:
- `--notify` — Envía reporte de estado a Telegram
- `--json` — Salida solo JSON (para integración programática)

### 2. Desde Claude Code (skill)

```
/ops reset
```

Ejecuta el script de reinicio y muestra un dashboard con el resultado.

### 3. Desde Telegram

Enviar `/restart` al bot. Responde con:
- Reporte completo del reinicio
- Botones inline para reintentar o ver log de reinicios anteriores

## Qué hace el reinicio

### State files reseteados (a `{}`)

| Archivo | Propósito |
|---------|-----------|
| `activity-logger-last.json` | Último registro de actividad |
| `health-check-state.json` | Estado del último health check |
| `health-check-history.json` | Historial de health checks |
| `health-check-components.json` | Estado de componentes |
| `agent-progress-state.json` | Progreso de agentes |
| `pending-questions.json` | Preguntas pendientes de permisos |
| `telegram-messages.json` | Registro de mensajes Telegram |
| `tg-session-store.json` | Sesión conversacional del commander |
| `tg-commander-offset.json` | Offset de polling de Telegram |
| `launcher-last-check.json` | Último check del launcher |
| `agent-metrics.json` | Métricas de agentes |
| `worktree-guard-last-alert.json` | Última alerta de worktree guard |

### Verificaciones

- **Telegram**: envía mensaje de prueba para confirmar conectividad
- **GitHub CLI**: verifica autenticación (`gh auth status`)
- **Java**: verifica JAVA_HOME y versión 21+
- **Procesos**: limpia lockfiles stale (sin matar procesos vivos)

### Qué NO hace

- No mata procesos vivos
- No borra worktrees
- No modifica `settings.json` ni `settings.local.json`
- No elimina archivos `.js` de hooks
- No toca archivos de producción ni configuración permanente

## Log de reinicios

Cada ejecución se registra en `.claude/hooks/restart-log.jsonl` con formato:

```json
{
  "timestamp": "2026-03-08T22:00:00.000Z",
  "status": "ok",
  "components": {
    "stateFiles": "ok",
    "telegram": "ok",
    "github": "ok",
    "java": "ok",
    "processes": "ok"
  },
  "errors": []
}
```

## Estados posibles

| Estado | Significado |
|--------|-------------|
| `ok` | Todo reiniciado correctamente |
| `partial` | 1-2 componentes con error (el resto OK) |
| `error` | 3+ componentes fallaron |

## Troubleshooting

- **Telegram falla**: verificar `telegram-config.json` (bot_token, chat_id)
- **GitHub CLI falla**: ejecutar `gh auth login`
- **Java falla**: verificar que existe `/c/Users/Administrator/.jdks/temurin-21.0.7`
- **Script no encontrado**: verificar que `scripts/restart-operational-system.js` existe
