# Pipeline de Eficiencia — scripts/pipeline/

Orquestador automático que ejecuta tareas mecánicas (entorno, tests, seguridad, build y delivery) como scripts externos, reduciendo el consumo de tokens de Claude ~44% al delegarle solo el razonamiento.

## Flujo general

```
pre-flight → Claude (razonamiento) → run-tests → security-scan → build-check → auto-delivery
```

Cada etapa registra su resultado en `scripts/logs/` y emite una transición de rol al dashboard via `emit-transition.js`.

## Scripts

| Script | Reemplaza | Descripción |
|--------|-----------|-------------|
| `emit-transition.js` | — | Módulo utilitario compartido. Registra transiciones de roles en la sesión activa del dashboard y resultados de gates en `scripts/logs/`. No se ejecuta directamente. |
| `pre-flight.js` | `/ops` (parte mecánica) | Verifica el entorno antes de lanzar Claude: JAVA_HOME, git, node, herramientas. Aborta el agente si detecta errores críticos (exit 1). |
| `run-tests.js` | `/tester` (parte mecánica) | Ejecuta `./gradlew check`, parsea resultados JUnit XML y genera `scripts/logs/test-result.json`. Omite los tests automáticamente si el diff no contiene código fuente (`.kt`, `.kts`, `.java`, `.gradle`). |
| `security-scan.js` | `/security` (parte mecánica) | Escanea el diff por secrets (AWS keys, JWT, private keys), archivos prohibidos (`.env`, `.pem`, `credentials.json`) y patrones OWASP básicos. Genera `scripts/logs/security-result.json`. |
| `build-check.js` | `/builder` (parte mecánica) | Ejecuta `./gradlew build`. Con `--verify` agrega `verifyNoLegacyStrings`, `validateComposeResources` y `scanNonAsciiFallbacks`. Genera `scripts/logs/build-result.json`. |
| `auto-delivery.js` | `/delivery` (parte mecánica) | Lee `agent-done.json`, hace commit + rebase + push + PR + merge squash en GitHub. Limpia el worktree si el merge es exitoso. Envía reporte a Telegram. |
| `agent-runner.js` | Orquestador manual | Coordina el pipeline completo: lanza los scripts en orden, pasa los resultados entre etapas y registra diagnósticos en `scripts/logs/agent-<issue>-diag.json`. |

## Control via `pipeline_mode`

El campo `pipeline_mode` en `scripts/sprint-plan.json` controla el comportamiento del runner:

| Valor | Comportamiento |
|-------|---------------|
| `scripts` | Pipeline completo: pre-flight + Claude + tests + security + build + delivery como scripts. **Modo recomendado.** |
| `hybrid` | Pre-flight como script; Claude maneja el post-pipeline via skills (`/tester`, `/security`, etc.). Modo de transición gradual. |
| `skills` | Solo lanza Claude directamente, sin wrapping de scripts. Compatibilidad con sprints anteriores. |

Ejemplo de `sprint-plan.json`:

```json
{
  "pipeline_mode": "scripts",
  "sprint": "SPR-031"
}
```

## Gates y bloqueo

- `run-tests` y `security-scan` son **gates bloqueantes**: si fallan, el pipeline aborta antes de build y delivery.
- `build-check` y `auto-delivery` no son bloqueantes (el pipeline reporta el fallo pero continúa con el diagnóstico).
- Los resultados de cada gate se persisten en `scripts/logs/` para consulta post-ejecución.

## Protocolo para agentes Claude

Al finalizar el trabajo, el agente debe escribir `agent-done.json` en el directorio raíz del worktree antes de que `auto-delivery.js` se ejecute:

```json
{
  "summary": "Descripción breve del cambio",
  "pr_title": "tipo: título del PR",
  "pr_body": "Detalle técnico. Closes #<issue>",
  "commit_type": "feat | fix | docs | chore | test | refactor",
  "files_changed": ["ruta/al/archivo.kt"]
}
```

`auto-delivery.js` busca este archivo en el worktree, `/tmp/agent-done.json` y `scripts/logs/agent-done.json` (en ese orden).

## Ejemplo de uso directo

```bash
# Ejecutar el pipeline completo para un agente del issue #1234
node scripts/pipeline/agent-runner.js \
  --workdir /path/to/worktree \
  --prompt-file /tmp/prompt-1234.txt \
  --model claude-sonnet-4-6 \
  --issue 1234 \
  --agent-num 1 \
  --slug "mi-feature" \
  --branch "agent/1234-mi-feature" \
  --log-file /tmp/agent-1234.log

# Ejecutar solo el pre-flight (verificación de entorno)
node scripts/pipeline/pre-flight.js

# Ejecutar solo el scan de seguridad sobre el diff actual
node scripts/pipeline/security-scan.js Claude DeliveryManager /path/to/worktree
```

## Logs generados

| Archivo | Contenido |
|---------|-----------|
| `scripts/logs/pre-flight-result.json` | Estado del entorno (errores, warnings) |
| `scripts/logs/test-result.json` | Resultados JUnit: total, passed, failed, skipped |
| `scripts/logs/security-result.json` | Findings por severidad (critical, high, medium) |
| `scripts/logs/build-result.json` | Estado de cada tarea Gradle |
| `scripts/logs/agent-<issue>-diag.json` | Diagnóstico completo del pipeline por agente |
