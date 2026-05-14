# Permission Mapping — capability-level cross-provider

> Issue [#3082](https://github.com/intrale/platform/issues/3082) — S4 multi-provider, 21 CAs canónicos.
> Documento canónico. Cualquier flag↔flag, mode→capability, override mechanism o
> non-degradable skill que viva en el repo debe alinearse con esta doc o
> abrirse PR para actualizarla en paralelo.

---

## 1. Por qué este documento existe

El pipeline V3 está migrando a **multi-provider** ([#3065](https://github.com/intrale/platform/issues/3065)). Cada provider (Anthropic / OpenAI-Codex / Gemini / Ollama / OpenRouter) define su propio modelo de permisos:

| Provider | Flag más permisivo | Default seguro |
|----------|--------------------|----------------|
| Anthropic Claude Code | `--permission-mode bypassPermissions` | `acceptEdits` |
| OpenAI Codex CLI | `--full-auto` (también `--no-confirm` en versiones viejas) | default sin flag |
| Gemini CLI (beta 2026) | (TBD — H4) | (TBD) |
| Ollama local | (n/a — corre con permisos del usuario) | (n/a) |

Sin una tabla de equivalencias **a nivel capability**, dos flags que parecen "equivalentes" pueden conceder **conjuntos distintos** de capacidades. Ejemplo del problema real: `codex --no-confirm` documenta auto-edit y auto-run pero la doc oficial no explicita si concede `child_spawn` (spawn de subprocesos) ni `tool_use_gated` (herramientas detrás de gate del harness). Si suponemos equivalencia con `bypassPermissions` sin verificar, abrimos un vector de privilege escalation cross-provider.

---

## 2. Catálogo de capabilities {#capability-catalog}

Las capabilities son **categorías de poder** observables a nivel de syscall o API de red. NO son nombres de herramientas del harness (`Bash`, `WebFetch`) — esos son convenciones del harness Claude Code que cambian entre versiones. Una capability es un comportamiento concreto que un agente puede o no realizar.

| Capability | Descripción |
|------------|-------------|
| `file_read` | Leer archivos dentro del repo y rutas accesibles desde el cwd del agente. |
| `file_write_repo` | Crear/modificar archivos *dentro* del repo del proyecto. |
| `file_write_outside_repo` | Crear/modificar archivos fuera del repo (filesystem global, `%APPDATA%`, `/etc`, `/tmp`). |
| `bash` | Ejecutar comandos shell estándar (sin escalada de privilegios). |
| `bash_elevated` | Ejecutar con privilegios elevados (`sudo`, `runas`). Supersedes `bash`. |
| `network_out` | HTTP/HTTPS salientes a la red pública (WebFetch, WebSearch, `curl`, `gh`). |
| `network_in` | Escuchar puertos / aceptar conexiones entrantes. |
| `child_spawn` | Spawnear procesos hijos (subshells, daemons, comandos en background). |
| `long_running_watcher` | Procesos de larga duración sin output regular (watchers, listeners, sleeps largos). |
| `tool_use_gated` | Herramientas que el harness coordina detrás de un gate (Task tools, MCP servers, etc.). |

**Fuente de verdad en código**: [`.pipeline/lib/capabilities.js`](../../.pipeline/lib/capabilities.js) — la constante `KNOWN_CAPABILITIES` es un `Set` inmutable, validado por pre-commit y boot. Cualquier capability fuera de este set hace fail-fast.

### Cómo agregar una capability nueva

1. Abrí PR sumando la entrada en `.pipeline/lib/capabilities.js` con descripción humana >= 10 chars.
2. Actualizá la matriz `CAPABILITY_MATRIX` en `.pipeline/lib/permission-validator.js` declarando qué `(provider, mode)` la conceden.
3. Sumá la entrada al `enum` de `docs/skills/skill-metadata.schema.json`.
4. Documentalá en esta sección de la doc.
5. Sumá tests de paridad en `.pipeline/lib/__tests__/permission-validator.test.js` (al menos un caso `ok=true` y uno `ok=false`).
6. CODEOWNERS de `.claude/skills/` y `.pipeline/lib/` deben aprobar (`@leitolarreta`).

---

## 3. Matriz canónica capability×(provider, mode) {#capability-matrix}

**Esta tabla es la fuente de verdad.** La tabla flag↔flag (§4) es **derivada** de esta. Si dos celdas entran en conflicto, manda esta.

Leyenda: ✅ = concedida, ❌ = no concedida, ⚠️ = conservador hasta CA-19 (test empírico de codex en sandbox).

| Capability | anthropic / `bypassPermissions` | anthropic / `acceptEdits` | anthropic / `plan` | openai-codex / `full-auto` | openai-codex / `no-confirm` | openai-codex / `default` | deterministic / `native` |
|------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `file_read` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `file_write_repo` | ✅ | ✅ | ❌ | ⚠️✅ | ⚠️✅ | ❌ | ✅ |
| `file_write_outside_repo` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `bash` | ✅ | ✅ | ❌ | ⚠️✅ | ⚠️✅ | ❌ | ✅ |
| `bash_elevated` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `network_out` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `network_in` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `child_spawn` | ✅ | ✅ | ❌ | ⚠️✅ | ⚠️✅ | ❌ | ✅ |
| `long_running_watcher` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `tool_use_gated` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

**Justificaciones por celda controvertida:**

- **anthropic/plan no tiene `bash` ni `tool_use_gated`**: el harness desactiva tools de mutación y herramientas gated cuando el agente entra en `plan` mode. Empíricamente validado en Claude Code 2.1.x.
- **openai-codex/full-auto sin `tool_use_gated`**: la doc oficial de OpenAI no enumera Task tools / MCP coordinator equivalente al de Claude Code. Hasta que H3 (#3076) integre el binario y CA-19 corra el sandbox empírico, la celda queda en ❌ por **fail-CLOSED por default**.
- **openai-codex/full-auto sin `long_running_watcher`**: codex CLI tiene timeouts más cortos por default y no expone API estable para procesos persistentes.
- **deterministic/native con `file_write_outside_repo`**: los scripts Node corren con permisos del usuario que lanzó el pulpo (no hay harness restringiéndolos). La matriz lo refleja honestamente — el control de qué scripts pueden hacer qué se hace por code review, no por gate.

**Nota CA-19 (test empírico de codex en sandbox)**: las celdas ⚠️ se promueven a ✅ definitivas o se demoten a ❌ cuando se corra el test empírico bajo sandbox aislado. Hasta entonces, la postura es conservadora ([`.pipeline/lib/permission-validator.js`](../../.pipeline/lib/permission-validator.js) — `CAPABILITY_MATRIX`).

---

## 4. Tabla derivada flag↔flag {#flag-flag}

> **DERIVADA de la matriz canónica §3.** Si modificás flags acá sin actualizar §3, fail-fast en CI.

| Flag Anthropic | Flag OpenAI-Codex | Equivalencia capability |
|----------------|-------------------|--------------------------|
| `bypassPermissions` | `full-auto` (con caveat ⚠️ tool_use_gated) | parcial — codex pierde `tool_use_gated`, `long_running_watcher` |
| `acceptEdits` | (no equivalente directo) | en flujos pipeline NO interactivo, equivalente operativo a `bypassPermissions` |
| `plan` | `default` (sin flag) | aproximadamente equivalente — ambos read-only seguros |

La equivalencia **parcial** entre `bypassPermissions` y `full-auto` es por qué `NON_DEGRADABLE_SKILLS` existen (§6).

---

## 5. Esquema de skills (`required_permissions`) {#schema}

Cada `.claude/skills/<skill>/SKILL.md` debe declarar `required_permissions` en su frontmatter:

```yaml
---
description: MiSkill — descripción humana
allowed-tools: Bash, Read, Write, ...
model: claude-sonnet-4-6
required_permissions: [file_read, file_write_repo, bash, child_spawn, tool_use_gated]
---
```

**Reglas de validación** (todas auto-aplicadas):

1. **Schema canónico**: [`docs/skills/skill-metadata.schema.json`](../skills/skill-metadata.schema.json) define el `enum` válido.
2. **Pre-commit lint**: si un SKILL.md declara una capability fuera del catálogo, el commit falla.
3. **Boot del pulpo**: lee todos los SKILL.md y valida contra la matriz para el provider configurado de cada skill. Modo `warn` por default; con `PIPELINE_PERMISSION_VALIDATOR_STRICT=1` aborta el boot.
4. **At-spawn-time**: cada `launchAgent` re-valida (CA-S3) — agent-models.json puede cambiar runtime, los rebotes cross-phase cambian el skill.

### Cómo agregar un provider nuevo {#add-provider}

Checklist obligatorio:

1. Sumar entrada al `CAPABILITY_MATRIX` en `.pipeline/lib/permission-validator.js` con `(modes, capabilities granted)` justificado por evidencia empírica.
2. Agregar handler en `.pipeline/lib/agent-launcher/providers/<name>.js` siguiendo el contrato I1-I6 (ver `agent-launcher.js`).
3. Sumar el provider a `PROVIDER_HANDLERS` en `.pipeline/lib/agent-launcher/resolve-provider.js` (tabla hardcoded — NO usar `require` dinámico).
4. Actualizar `defaultsByProvider` en `resolvePermissionMode` con el mode default seguro.
5. Sumar entrada al schema `docs/pipeline-multi-provider/agent-models.schema.json` (allowlist de provider name).
6. Documentar las celdas en esta tabla §3.
7. Test empírico en sandbox de TODOS los modes del nuevo provider (igual que CA-19 para codex). Si difiere de la matriz declarada, ajustar matriz **antes** de mergear.
8. Sumar al menos un caso `paridad` en `.pipeline/lib/__tests__/permission-validator.test.js`.
9. CODEOWNERS (`@leitolarreta`) aprueba.

---

## 6. Skills no-degradables {#non-degradable}

`NON_DEGRADABLE_SKILLS` es una constante hardcoded en [`.pipeline/lib/permission-validator.js`](../../.pipeline/lib/permission-validator.js). No se lee de `agent-models.json` editable.

Lista actual:

| Skill | Razón |
|-------|-------|
| `security` | Análisis de superficie de ataque OWASP — necesita gated tools y razonamiento extendido. |
| `review` | Code review cross-file — necesita gated tools y razonamiento de larga forma. |
| `builder` | Builds Gradle reales — necesita `bash`, `child_spawn`, `long_running_watcher`. |
| `tester` | Ejecución de tests unitarios + cobertura — necesita `bash` + `child_spawn` + `tool_use_gated`. |
| `backend-dev` | Refactors arquitecturales en Ktor/AWS — sensible a errores de razonamiento. |

### Garantía operativa

Si `agent-models.json` apunta uno de estos skills a un provider que NO satisface sus capabilities (típicamente `openai-codex` que no concede `tool_use_gated` ni `long_running_watcher`), `validateSpawn` rechaza con `reason: 'non_degradable'` **sin posibilidad de override** (CA-12). El mensaje de fail-CLOSED incluye explícitamente "este skill está marcado como NON_DEGRADABLE — no admite override".

Test de regresión: [`.pipeline/lib/__tests__/permission-validator.test.js`](../../.pipeline/lib/__tests__/permission-validator.test.js) cubre el caso por cada skill de la lista contra `openai-codex/full-auto`.

---

## 7. Overrides temporales {#overrides}

Para casos genuinos donde un skill no-NON_DEGRADABLE necesita correr en un provider con capability set menor (ej. cuota Anthropic agotada y necesitamos cerrar un issue urgente con `guru` corriendo en codex), existe un mecanismo de **override temporal con audit log tamper-evident**.

### Mecanismo

- **Persistencia**: `.pipeline/audit/permission-overrides.jsonl`, append-only, con hash chain SHA-256 (mismo patrón aprobado en #3068 para `model-switches.jsonl`).
- **CLI dedicado**: edición manual del JSONL ROMPE la chain (verificación falla, override se ignora). Usar siempre el CLI:

```bash
node .pipeline/scripts/override-permission.js \
  --skill <X> \
  --provider <Y> \
  --mode-requerido <mode-original> \
  --mode-otorgado <mode-efectivo> \
  --capabilities-diff <cap1,cap2,...> \
  --justify '<motivo libre, mín 30 chars>' \
  --ttl-horas <N>      # default 24, max 168 (7 días)
  [--autor <git-user>] # default: git config user.email
  [--no-telegram]
```

- **Notificación Telegram inmediata**: la operación es atómica (escribe JSONL + encola mensaje en `servicios/telegram/pendiente/` en la misma invocación). El operador se entera antes de que el spawn con override aplicado corra.
- **TTL evaluado at-spawn-time**: la entry guarda `created_at` y `ttl_horas`. En cada spawn, `findActiveOverride` recomputa la expiración. Override expirado → fail-CLOSED automático sin notificación adicional.

### Revocación antes del TTL

```bash
node .pipeline/scripts/revoke-permission.js \
  --hash <hash_self_o_prefix_de_16+_chars> \
  --motivo '<motivo, mín 10 chars>' \
  [--autor <git-user>]
```

La revocación escribe una entry `permission_override_revocation` que apunta al `target_hash` original. La entry del override NO se mutaa (append-only). `findActiveOverride` excluye overrides cuyo hash esté revocado.

### Reglas inquebrantables

1. **Por (skill, provider) específico**: prohibido override global o por skill solo (vector de privilege escalation cross-skill).
2. **NON_DEGRADABLE no admite override**: `recordOverride` rechaza con throw si el skill está en `NON_DEGRADABLE_SKILLS`.
3. **TTL acotado**: [1, 168] horas. Más de 7 días requiere PR formal del cambio en la matriz.
4. **Justificación mín 30 chars**: forzar al autor a explicar el "por qué".
5. **Autor verificable**: leído de `git config user.email`. Si está ausente, el CLI aborta.
6. **Hash chain íntegro**: `verifyChain(file)` debe devolver `ok=true` para que el archivo sea consumido por `findActiveOverride`. Si la chain se rompe (manual edit, corrupción), todos los overrides se ignoran por defensa.

---

## 8. Mensaje de fail-CLOSED {#fail-closed-message}

Estructura asserteada por test (CA-10). Mínimo:

```
[FAIL-CLOSED] Skill 'X' no puede correr en provider 'Y' (mode 'Z').
  Capability faltante: 'C' (requerida por el skill).
  Capabilities concedidas por Y/Z: <lista>.
  Acciones posibles:
    1) Cambiar provider del skill en agent-models.json a uno que conceda 'C' (recomendado).
    2) Crear override temporal: node .pipeline/scripts/override-permission.js --skill X --provider Y --justify '<motivo>' --ttl-horas 24
    3) Consultar tabla canónica: docs/pipeline-multi-provider/permission-mapping.md#capability-matrix
```

Para skills `NON_DEGRADABLE`, el mensaje **omite** la acción de override y agrega la línea explícita "Este skill está marcado como NON_DEGRADABLE — no admite override".

**Anchors estables al doc**: el mensaje linkea `#capability-matrix`. El test de paridad assertea presencia del anchor — si renombramos la sección, los tests rompen y el dev sabe que tiene que actualizar el mensaje.

**Greppable** (G6 — UX):
- Por skill: `grep "FAIL-CLOSED.*Skill 'qa'"` matchea.
- Por capability: `grep "Capability faltante: 'tool_use_gated'"` matchea.

---

## 9. Casos extremos {#edge-cases}

### 9.1 Override expirado durante rebote cross-phase

Escenario: un issue está en medio de un rebote multi-fase (`desarrollo/validacion → desarrollo/dev → desarrollo/build`). Mientras corre, el override del skill `guru` (que autoriza correr en codex) expira a las 24h.

Comportamiento esperado: el spawn que llega **después** de la expiración rebota fail-CLOSED con motivo claro (`override expirado`). NO degrada silenciosamente al mode del provider. El agente que reciba el rebote (en `pendiente/`) tiene la información para decidir si renovar el override o cambiar de provider.

### 9.2 Forward-compat con permission-modes nuevos del CLI

Si Anthropic agrega `--permission-mode autoApprove` entre versiones del CLI y un skill lo declara, la matriz NO lo conoce → `mode_unknown` → fail-CLOSED por default (CA-S2). El dev tiene que sumar la celda a §3, sus capabilities granted, actualizar tests, y abrir PR.

NO degradamos al "mode más permisivo disponible" como fallback — esa es la trampa de seguridad clásica.

### 9.3 Hot-reload de skills (edit en runtime de SKILL.md)

El pulpo NO tiene watcher activo sobre `.claude/skills/`, pero relee `agent-models.json` para `skill_overrides` en algunos paths. La validación at-spawn-time (CA-S3) cubre el caso: cada `launchAgent` recachea por `mtime` del archivo. Si el operador edita un SKILL.md mientras hay spawns en cola, el siguiente spawn ve los nuevos `required_permissions` y revalida.

### 9.4 `PIPELINE_PERMISSION_VALIDATOR_NO_CACHE=1`

Flag de desarrollo: invalida cache de required_permissions en cada lectura. Costo: un `fs.readFileSync` extra por spawn. Útil para CI o cuando se debuggea drift entre archivo y comportamiento observado.

---

## 10. Diagrama de flujo del decisor

```
                  spawn request
                       │
                       ▼
   ┌─────────────────────────────────────┐
   │ resolveProviderForSkill(skill)      │  ← .pipeline/lib/agent-launcher/resolve-provider.js
   └──────────────┬──────────────────────┘
                  │
              provider == deterministic?
                  │
        ┌─────────┴─────────┐
        │                   │
       sí                   no
        │                   │
        ▼                   ▼
   spawn(script.js)   loadSkillMetadata(skill)  ← .pipeline/lib/skills-metadata.js
                            │
                       required_permissions
                            │
                            ▼
                    ┌────────────────────────┐
                    │ validateSpawn(...)     │  ← .pipeline/lib/permission-validator.js
                    └───────┬────────────────┘
                            │
                  capability_unknown?
                            │
                  ┌─────────┴────────┐
                  │                  │
                 sí                  no
                  │                  │
                  ▼                  ▼
            FAIL-CLOSED         missing.length == 0?
                                     │
                            ┌────────┴────────┐
                            │                 │
                           sí                no
                            │                 │
                            ▼                 ▼
                          spawn          NON_DEGRADABLE?
                                              │
                                    ┌─────────┴─────────┐
                                    │                   │
                                   sí                  no
                                    │                   │
                                    ▼                   ▼
                              FAIL-CLOSED         findActiveOverride
                              (no override)            │
                                                       │
                                              ┌────────┴────────┐
                                              │                 │
                                            null              entry
                                              │                 │
                                              ▼                 ▼
                                        FAIL-CLOSED          spawn
                                                          (source=override)
```

---

## 11. Acoplamiento con issues hermanos

- **#3065 (refinamiento v2 multi-provider)** §6.7: la tabla flag↔flag de §6.7 del doc maestro debe reescribirse para citar **esta** doc como fuente. Ver §6.7 actualizada en `docs/pipeline-multi-provider.md`.
- **#3068 (audit log tamper-evident con hash chain)**: cuando #3068 cierre y entregue `lib/audit-log.js` como módulo genérico, la implementación actual en `.pipeline/lib/audit-log.js` (este PR) se **deprecia** y los callers reusan ese. TODO marcado en el archivo.
- **#3075 (H3 — adaptador OpenAI/Codex)**: la columna `openai-codex` queda con celdas ⚠️ hasta que H3 cierre. CA-19 obliga a correr el test empírico cuando esté integrado.
- **#3108 (static analysis cross-check)**: recomendación independiente para detectar drift entre `required_permissions` declarado y tool calls reales del skill. Pendiente.
- **#3123 / #3124 (UX del CLI de override / viewer del audit log)**: mejoras DX no bloqueantes.

---

## 12. Referencias

- `.pipeline/lib/capabilities.js` — catálogo canónico (CA-5).
- `.pipeline/lib/permission-validator.js` — matriz + validador (CAs 1, 8-12, 14-15).
- `.pipeline/lib/audit-log.js` — hash chain SHA-256 (CA-13).
- `.pipeline/lib/permission-override-telegram.js` — formato Telegram natural (CA-17).
- `.pipeline/lib/skills-metadata.js` — loader de frontmatter (CA-6, CA-7).
- `.pipeline/scripts/override-permission.js` — CLI atómico (CA-16).
- `.pipeline/scripts/revoke-permission.js` — CLI de revocación.
- `docs/skills/skill-metadata.schema.json` — schema JSON del frontmatter (CA-6).
- Tests: `.pipeline/lib/__tests__/{capabilities,audit-log,permission-validator,permission-validator-integration,permission-override-telegram,skills-metadata}.test.js`.
