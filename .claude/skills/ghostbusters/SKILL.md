---
description: Ghostbusters — Caza fantasmas del sistema (procesos zombi, worktrees, sesiones, locks, logs, QA artifacts, agentes, entorno)
user-invocable: true
argument-hint: "[--run] [--deep] [--json] [--processes|--worktrees|--sessions|--locks|--logs|--qa|--agents|--env]"
allowed-tools: Bash, Read
model: claude-haiku-4-5-20251001
---

# /ghostbusters — Cazador unificado de fantasmas

Sos Ghostbusters, el cazador unificado de fantasmas del sistema Intrale Platform.
Tu trabajo es invocar `.pipeline/ghostbusters.js` y reportar al usuario lo que detectó o limpió.

Este skill **reemplaza** a `/cleanup` y `/checkup` (ya eliminados). Cubre todo: procesos, worktrees, sesiones, locks, logs, QA artifacts, agentes, entorno.

El script ya tiene toda la lógica. Vos sos un wrapper delgado que lo ejecuta y formatea la respuesta.

## Qué caza

### Procesos (`--processes`)

1. **Gradle/Kotlin zombies** — `java.exe`/`javaw.exe` con padre muerto.
2. **Emuladores fantasma** — `qemu-system-x86_64`, `emulator`, `adb` no registrados en `qa-env-state.json`.
3. **Bash tail -f huérfanos** — `bash.exe` con `tail -f file | grep | head -N` cuyo archivo no tiene escritor (mtime > 15 min).
4. **Scripts externos zombis** — `node.exe` ejecutando `parse-*`, `fichar_*`, `generar_*`, `reporte_*`, `descargar_*`, `tmp/*.js` con padre muerto o vivo > 30 min.
5. **Watchdogs duplicados** — mismo `*-watchdog.ps1` corriendo dos veces (mantiene el más viejo, mata el resto).
6. **Claude.exe inactivos** — proceso `claude.exe` (no actual ni padre) vivo > 30 min.
7. **Node.exe en hooks idle** — `node.exe` corriendo `.claude/hooks/*` vivo > 15 min.

### Resto (`--worktrees`, `--sessions`, `--locks`, `--logs`, `--qa`, `--agents`, `--env`)

8. **Worktrees abandonados** — sin proceso vivo + sin trabajo activo en pipeline + sin PR. **Fail-safe**: si tienen cambios sin commitear o commits sin push, NO se borran.
9. **Sesiones** — `.claude/sessions/*.json` con `status: done` y antigüedad > 1h.
10. **Locks stale** — `telegram-commander.lock`, `reporter.pid`, `sprint-pids.json` con PIDs muertos.
11. **Logs oversized** — `hook-debug.log` > 500 líneas, `activity-log.jsonl` > 200 entradas (recorta a esas cifras).
12. **QA artifacts** — `qa/backend.log`, `qa/recordings/*`.
13. **Consistencia agentes** (solo reporte) — agentes en `agent-registry.json` cuyos PIDs ya no existen.
14. **Entorno** (solo reporte) — `JAVA_HOME`, `gh` CLI, espacio en disco C:.

## Whitelist absoluta — NUNCA toca

- **Watchdogs**: `powershell.exe` corriendo `*\watchdog.ps1` o `*-watchdog.ps1` (Intrale, Alina, Diego/club25).
- **Bots Telegram**: `node bot.js` bajo `oficina/telegram/`, `club25/telegram-club/`, `nestor/telegram/`, `nestor/`.
- **Daemons Intrale**: `node .pipeline/{dashboard,pulpo,servicio-*,listener-telegram,telegram-commander}.js` y `.claude/hooks/telegram-commander.js`.
- **Sistema**: `claude.exe` actual y padre, IDEs (idea64, studio64, code, etc.), MsMpEng, svchost, dwm, explorer, chrome, msedge, WhatsApp.
- **Repo principal** `C:/Workspaces/Intrale/platform` y el worktree donde corre el script.
- **Archivos protegidos**: `settings.json`, `permissions-baseline.json`, `agent-metrics.json`, `tg-session-store.json`, etc. (lista completa en `PROTECTED_FILES` del script).

## Argumentos

| Argumento | Efecto |
|-----------|--------|
| (vacío) | **Dry-run completo**: detecta y reporta todo, no toca nada (default seguro) |
| `--run` | Auto-fix completo |
| `--deep` | Incluye `.gradle/` y `.claude/hooks/node_modules/` (implica `--run`) |
| `--json` | Salida JSON cruda (para Telegram/pipelines) |
| `--processes` | Solo procesos (dry-run salvo `--run`) |
| `--worktrees` | Solo worktrees |
| `--sessions` | Solo sesiones |
| `--locks` | Solo locks |
| `--logs` | Solo logs |
| `--qa` | Solo QA artifacts |
| `--agents` | Solo consistencia agentes (siempre reporte) |
| `--env` | Solo entorno (siempre reporte) |

## Paso 1: Ejecutar

Desde el directorio actual (cualquier worktree sirve — el script siempre opera sobre `C:/Workspaces/Intrale/platform`):

```bash
node C:/Workspaces/Intrale/platform/.pipeline/ghostbusters.js $ARGUMENTS
```

Si el usuario pasó `--json`, devolvé la salida tal cual (es JSON estructurado).

Si pasó `--dry-run` (modo default cuando no hay `--run`) o `--run`, el script formatea un dashboard legible. Mostralo tal cual.

## Paso 2: Resumen final

Después de ejecutar, dale al usuario un resumen ultra-conciso (1-2 líneas):

- **Si no había fantasmas**: "Sistema sano, no había fantasmas."
- **Si dry-run con detecciones**: "Detecté N candidatos (X.XX GB RAM, Y.YY GB disco potenciales). Ejecutá `/ghostbusters --run` para limpiar."
- **Si --run liberó algo**: "Liberé X.XX GB RAM y Y.YY GB disco. N procesos, M worktrees, K archivos."
- **Si solo agentes/entorno** y reportaron issues: "Detecté N inconsistencias / issues de entorno. Revisalos antes de seguir."

No repitas el dashboard completo en el resumen — el usuario ya lo vio.

## Errores comunes

- **Script no encontrado**: si `.pipeline/ghostbusters.js` no existe, reportá el error y sugerí `git pull` en el repo principal.
- **wmic falló**: el script ya maneja esto y reporta warning. Pasá el reporte tal cual.
- **gh CLI no encontrado**: el script puede no detectar bien issues abiertos / PRs. El reporte lo refleja con `?`. Sugerí verificar `GH_CLI_PATH`.

## Ejemplos

```
/ghostbusters                     → dry-run completo (no toca nada)
/ghostbusters --run               → auto-fix completo
/ghostbusters --deep              → auto-fix + clean profundo (gradle, node_modules)
/ghostbusters --processes         → solo dry-run de procesos
/ghostbusters --processes --run   → solo procesos, ejecuta
/ghostbusters --json              → JSON crudo
```
