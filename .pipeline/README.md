# .pipeline — Pipeline V3 (Intrale)

Carpeta raíz del pipeline V3 (Pulpo, dashboard, hooks, scripts Node.js). La
documentación operativa canónica vive en `docs/operacion-pipeline.md` y
`docs/pipeline-multi-provider.md`.

Este README cubre **scripts CLI** que se invocan a mano desde el host del
operador (Leo / dev del pipeline). Para arquitectura, fases, agentes y
roles, ver los `docs/` mencionados.

---

## Validators ejecutables

### `validate-agent-models.js` (#3089)

Valida `.pipeline/agent-models.json` contra el schema canónico antes de
bootear el pulpo. Útil para:

- Hooks pre-commit que tocan `agent-models.json`.
- Smoke test manual después de agregar/cambiar un provider o un skill.
- CI que valide el archivo en cada PR.

```bash
# Validación completa con check de env vars (default)
node .pipeline/validate-agent-models.js

# CI / hook: 1 línea de resumen, sin colores si no hay TTY
node .pipeline/validate-agent-models.js --quiet

# Saltea check de env vars (útil si no tenés las creds en el shell del CI)
node .pipeline/validate-agent-models.js --no-env

# Ayuda
node .pipeline/validate-agent-models.js --help
```

#### Ejemplo de salida (happy path)

```
✅ Validación OK — agent-models.json listo para el boot del pulpo.
  Providers: anthropic, openai-codex, deterministic
  Skills:    18 asignados
```

#### Ejemplo de salida (fallo — credencial faltante)

```
⛔ agent-models.json no pasó la validación.

❌ error  provider "anthropic" requiere env var ANTHROPIC_API_KEY pero no está presente en process.env
    archivo:   .pipeline/agent-models.json:27
    campo:     #/providers/anthropic/credentials_env
    categoría: credencial faltante
    sugerencia: setear ANTHROPIC_API_KEY antes de arrancar el pulpo, o cambiar agent-models.json para asignar los skills a un provider con credencial disponible. Ver docs/runbooks/credential-rotation.md

─────────────────────────────────────────────
 Resumen
─────────────────────────────────────────────
  Providers definidos:   3
  Skills asignados:      18
  Env vars verificadas:  2

  ❌ credenciales faltantes:  1

  ❌ Validación FALLÓ. Corregí los errores listados arriba.
  Salida: exit 2 (credencial faltante)
─────────────────────────────────────────────
```

#### Tabla de exit codes

| Code | Categoría             | Significado                                                                                  |
|------|-----------------------|----------------------------------------------------------------------------------------------|
| `0`  | OK                    | Validación pasada — el archivo está listo para el boot del pulpo.                            |
| `1`  | Schema inválido       | Estructura del JSON no matchea el schema canónico o cross-validations fallan.                |
| `2`  | Credencial faltante   | Una env var referenciada por un provider (`credentials_env`) no está definida en el shell.   |
| `3`  | Credencial hardcoded  | Se detectó un literal con forma de secret (`sk-ant-`, `AKIA`, JWT, etc.) en algún campo.     |
| `4`  | Path inválido         | Archivo `agent-models.json` no encontrado, schema ausente, o toolchain (`ajv`) no instalado. |

Cuando hay errores de múltiples categorías, el exit code refleja la **causa
dominante** en este orden de gravedad: hardcoded (3) → faltante (2) → schema (1) → path (4).

#### Reglas de seguridad

- El validador **nunca** imprime el valor de una env var ni de un campo
  sensible — sólo nombres y prefijos genéricos (`Anthropic key (sk-ant-)`,
  etc.). Esto vale para stdout, stderr y reportes derivados.
- El validador es **idempotente y sin side effects**: no escribe en disco,
  no muta env, no abre red. Seguro de invocar en boot del pulpo, hooks, CI.
- El schema canónico vive checked-in en `.pipeline/agent-models.schema.json` —
  nunca se descarga en runtime (anti-SSRF).

#### Convenciones de salida

- Símbolos `✅` / `❌` / `⚠️` / `ℹ️` / `⛔` son redundantes con texto en
  palabras (`ok` / `error` / `warn` / `info` / `CRÍTICO`) — accesibilidad
  TTY-only y daltonismo.
- Respeta `NO_COLOR=1` (https://no-color.org/) y `!process.stdout.isTTY`
  para suprimir escapes ANSI automáticamente en pipes / archivos / CI.
- Tono español neutro, sin imperativos secos ni emojis decorativos fuera
  del set de estado.
- Happy path silencioso (≤ 5 líneas cuando todo OK).

#### Engine subyacente

El script CLI es un **wrapper humanizado** sobre
`.pipeline/lib/agent-models-validate.js` (entregado en #3081 S3), que es la
misma engine que el boot del pulpo usa con `validateOrExit({ checkEnv: true })`.
DRY total — un cambio en la lógica de validación viaja a ambos sin drift.

Para ejecutar la validación directamente desde la engine (output en formato
"FATAL" para boot, no humanizado):

```bash
node .pipeline/lib/agent-models-validate.js
```

#### Tests

```bash
node --test .pipeline/tests/validate-agent-models.test.js
```

Cubre las CA consolidadas del issue #3089 (FUNC + SEC + UX + EXIT + TECH +
drift `VALID_PROVIDERS` ↔ `agent-models.json`).

---

### `validate-java-home.js` (#2405)

Valida que `$JAVA_HOME` esté dentro de `build.java_home_allowlist` de
`.pipeline/config.yaml`. Fail-closed (exit 78) si no matchea. Ver header
del script para detalles.

```bash
node .pipeline/validate-java-home.js [--quiet]
```

---

## Documentación canónica

- `docs/operacion-pipeline.md` — operativa del pipeline.
- `docs/pipeline-multi-provider.md` — rediseño multi-provider (#3065) y
  schema canónico de `agent-models.json`.
- `docs/pipeline-v3-handoff.md` — handoff cross-agente (#2993).
- `agents.md` — reglas para agentes automatizados.
- `CLAUDE.md` — instrucciones del repo para Claude Code.
