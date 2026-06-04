# Auditoría: compatibilidad cadenas de fallback ↔ matriz de permisos

> Fecha: 2026-06-04 · Origen: sesión Telegram Commander (Leo) · Pipeline en halt total durante el análisis.
> Disparador: la Fase 2 de la prueba multi-provider falló al spawnear `guru` en Codex con un rechazo
> `fail-CLOSED` del validador de permisos. Leo pidió revisar **todas** las cadenas, validar que el
> orden sea compatible con la matriz de capabilities y explicar cada incompatibilidad.

## Método

Cross-validación determinística usando el **código real** del pipeline (no a ojo):
`resolve-provider.resolvePermissionMode()` para el mode de cada provider, `permission-validator.validateSpawn()`
para el veredicto, y `skills-metadata.loadAllSkillsMetadata()` para los `required_permissions` de cada skill.
Se evaluó cada enlace `(skill, provider)` de cada cadena (primario + fallbacks).

## Resultado: 50 de 69 enlaces FALLAN

Los 19 que pasan son los **primarios en Anthropic** (`bypassPermissions`, presente en la matriz) más los
skills determinísticos (que el gate saltea por diseño). **Todo fallback más allá de Claude está roto.**

## Causa raíz (3 defectos)

### 1. Nombre de mode inválido para Codex (typo de configuración)
En `agent-models.json`, el bloque `openai-codex` declara `"permissions_mode": "bypassPermissions"` —
que es vocabulario de **Claude Code**. La matriz de Codex solo conoce `full-auto` / `no-confirm` / `default`
(el `spawn_args_template` de Codex usa `--full-auto`). Resultado: `mode_unknown` → `fail-CLOSED`.
Es un copy-paste del bloque de Anthropic. **Fix:** `permissions_mode` de `openai-codex` → `full-auto`.

### 2. Free providers ausentes de la matriz canónica
`CAPABILITY_MATRIX` (en `permission-validator.js`) solo define `anthropic`, `openai-codex` y `deterministic`.
`gemini-google`, `cerebras` y `nvidia-nim` **no existen** en la matriz → cualquier skill que caiga a ellos
da `mode_unknown` aunque el nombre de mode sea correcto. Requiere agregar las celdas con sets conservadores
+ doc (`permission-mapping.md`) + test de paridad + CODEOWNERS (gobernanza del archivo).

### 3. Matriz conservadora de Codex vs. skills `tool_use_gated` (gap semántico real, NO typo)
Codex `full-auto` concede `{file_read, file_write_repo, bash, network_out, child_spawn}` pero **NO**
`tool_use_gated` ni `long_running_watcher` (excluidos a propósito hasta verificación empírica — CA-19 / #3076).
Por eso, **aun corrigiendo el typo (#1)**, los skills que escriben código quedan sin fallback viable a Codex:
`backend-dev, pipeline-dev, android-dev, web-dev, ux, perf, review, qa, po, security` (y `qa`/`tester`
suman `long_running_watcher`). El instinto de Leo aplica acá con más fuerza que en Guru: es absurdo que
`backend-dev` no pueda degradar a Codex cuando Codex claramente lee/escribe/ejecuta. La incógnita real es
si `full-auto` concede gated tools — empíricamente los ejecuta. **Acción:** CA-19 — verificar y extender
la celda de Codex.

## El caso Guru (lo que Leo señaló)

Guru pide `file_read, bash, child_spawn, network_out`. Codex `full-auto` concede los 4. **Guru SÍ puede
correr en Codex** — lo único que lo frena es el defecto #1 (typo de mode). No hay limitación de capability real.

## Impacto post-fix #1 (solo corregir el typo de Codex)

Pasan a tener fallback Codex funcional: `guru, doc, planner, refinar, ops, auth, telegram-commander,
telegram-sherlock`. **Siguen sin fallback** todos los `tool_use_gated` (defecto #3) y todas las colas a
free providers (defecto #2).

## Hallazgo adicional: el boot solo valida primarios

`validateAllSkillsAtBoot` itera el provider **primario** de cada skill, no los enlaces de la cadena de
fallback. Por eso este 50/69 quedó invisible hasta que un fallback real se disparó (kill-switch, 03-04/06).
La corrección debe sumar cobertura de cadena al boot + a los tests de paridad.

## Plan de corrección recomendado (engineering, con tests de paridad)

El portero es **fail-CLOSED bajo CODEOWNERS + tests de paridad**: no se parchea suelto. Propuesta de split:

| # | Trabajo | Toca | Size |
|---|---------|------|------|
| A | Typo mode Codex en `agent-models.json` + cobertura de cadena en `validateAllSkillsAtBoot` + parity test | config + validator | Simple |
| B | CA-19: verificar empíricamente Codex `full-auto` y extender su celda (`tool_use_gated`, `long_running_watcher`) | matriz + doc + parity | Medio |
| C | Agregar `gemini-google`/`cerebras`/`nvidia-nim` a la matriz con sets conservadores | matriz + doc + parity | Medio |
| D | Reconciliar orden de cadenas vs `required_permissions`: podar enlaces muertos (p.ej. free provider sin `tool_use_gated` en cadena de dev) | config | Simple |

## Corrección de política: confiar en la cadena del operador (2026-06-04)

> Decisión de Leo (operador). Cierra los 6 fallos restantes de la auditoría.

Los 6 fallos que quedaban tras los fixes #1/#2/#3 NO eran incompatibilidades de capability
(todos reportaban `missing: -`, es decir el provider concedía **todo** lo requerido). Eran
rechazos del portón `FULL_TRUST_PROVIDERS = {anthropic}` introducido en #3820: bloqueaba a los
skills `NON_DEGRADABLE` (`security`, `review`, `builder`, `tester`, `backend-dev`) en Codex/free
**aunque el provider fuera técnicamente capaz**, sólo por no ser "de confianza plena".

**Esa regla está mal.** El orden de la cadena de fallback lo configura el operador en
`agent-models.json`; si pone un provider en la lista, es una decisión deliberada y el portero
debe confiar en ella. El validador valida **capacidad técnica** (¿concede los tools que el skill
necesita?), no calidad ni jerarquía de confianza del provider.

**Cambio aplicado** (`permission-validator.js`):
- Eliminado `FULL_TRUST_PROVIDERS` y el portón a nivel provider en `validateSpawn`.
- `NON_DEGRADABLE_SKILLS` se conserva pero ahora SÓLO con semántica capability-based: estos
  skills críticos siguen sin correr con capabilities faltantes y sin admitir override que los
  degrade (caso `codex/default` read-only → fail-CLOSED).

**Resultado:** auditoría **69/69 PASS, 0 fallos**. Suite del validador 44/44 + API multi-provider 13/13.
