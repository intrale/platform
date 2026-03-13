# Sistema de Memoria de Agentes Claude

Ubicación: `~/.claude/projects/C--Workspaces-Intrale-platform/memory/`

## Índice (MEMORY.md ≤ 50 líneas)

El archivo `MEMORY.md` es un **índice puro** — solo contiene enlaces a archivos individuales.
El sistema carga solo las primeras 200 líneas; mantenerlo como índice garantiza contexto completo en cada sesión.

## Archivos de memoria

| Archivo | Tipo | Contenido |
|---------|------|-----------|
| `java-build.md` | reference | JAVA_HOME, JDKs disponibles |
| `github-cli.md` | reference | gh CLI 2.86.0, setup, fallback |
| `bash-limitations.md` | reference | Limitaciones Bash en Windows/MSYS2 |
| `mcp-config.md` | reference | Context7 MCP global |
| `project-conventions.md` | project | Idioma, backlogs P V2, ramas, PR assignee |
| `agents-models.md` | reference | Modelos Claude por skill (#1244) |
| `hooks-config.md` | reference | Hooks configurados + severidades de permisos |
| `permissions.md` | reference | Sistema auto-healing (50 allow + 7 deny) |
| `telegram.md` | reference | Bot Telegram, hooks automáticos, lección API key |
| `sprint-management.md` | project | Tamaño sprint, concurrencia, carry-over |
| `pipeline-scheduling.md` | project | Escalonamiento QA E2E |
| `worktrees-claude-copy.md` | reference | .claude/ como copia, permisos, cleanup |
| `worktrunk.md` | reference | Worktrunk git-wt y funciones dev-* |
| `android-emulator.md` | reference | AVD virtualAndroid, snapshot qa-ready |
| `arquitectura.md` | reference | Mapa completo del proyecto |
| `user-style.md` | user | Trato informal (Leito/Claudito) |
| `qa-operativo-lessons.md` | feedback | QA operativo: verificar ejecución real |
| `qa-process.md` | feedback | Proceso QA pre/post implementación |
| `reportes.md` | feedback | Reportes PDF obligatorios |
| `feedback_qa-obligatorio.md` | feedback | QA con video antes de cerrar tarea |
| `feedback_branch-before-code.md` | feedback | Crear rama ANTES de codear |
| `feedback_todowrite.md` | feedback | TodoWrite desde inicio de sesión |
| `feedback_use-agents.md` | feedback | Usar skills del proyecto |
| `feedback_tests-post-merge.md` | feedback | Re-ejecutar tests post-merge |
| `feedback_carry-over-prioridad.md` | feedback | Carry-over primero en el siguiente sprint |

## Regla de mantenimiento

- **NUNCA escribir contenido directamente en MEMORY.md** — solo enlaces
- Al agregar nueva memoria, crear el archivo individual y agregar el enlace al índice
- El límite de 200 líneas que carga el sistema es automático — el índice debe caber en ese límite
