# Sistema de clasificación de rebotes (rebote-classifier)

> **Issue:** [#3167](https://github.com/intrale/platform/issues/3167) — Curita C, Opción A robusta.
> **Módulo:** [`.pipeline/lib/rebote-classifier.js`](../../.pipeline/lib/rebote-classifier.js)
> **Tests:** [`.pipeline/lib/__tests__/rebote-classifier.test.js`](../../.pipeline/lib/__tests__/rebote-classifier.test.js) (32 unit) + [`rebote-classifier.integration.test.js`](../../.pipeline/lib/__tests__/rebote-classifier.integration.test.js) (9 integration).

## Por qué existe

El **2026-05-12** el issue #3086 (multi-provider U1) cayó a `bloqueado-humano/`
cuando en realidad esperaba que se mergeara la dependencia #3083 (S5 audit
trail). El motivo de rechazo del Guru fue interpretado por `humanBlock` como
"requiere intervención humana" cuando técnicamente era una espera mecánica:
"#3083 está OPEN — no puedo integrar sin que mergee primero".

Hasta este sprint, el Pulpo evaluaba rebotes con una cascada dispersa:

1. `precheck.classifyError(motivo) → 'infra' | 'codigo'`
2. `humanBlock.isHumanBlockReason(motivo) → boolean`
3. `routing-classifier` (motivo, faseDestino) → mismatch sí/no

`humanBlock` era el catch-all: cualquier motivo que sonara a "espera de algo"
caía a `bloqueado-humano/` y requería a un operador (Leo, en el caso real)
para hacer `gh issue edit -N --remove-label needs-human --add-label
blocked:dependencies`. Cero automatización aunque la dependencia ya cerrara.

El `rebote-classifier` introduce una clasificación declarativa, ordenada por
especificidad, con cinco categorías canónicas y mecanismos de destrabe
explícitos por cada una.

## Las 5 categorías

| Categoría | Cuándo aplica | Cuenta CB | Label aplicado | Destrabe |
|---|---|---|---|---|
| `cross_phase` | Routing mismatch: agente dice "esto es de otra fase" | No | — | Reroute automático a `definicion/analisis` |
| `dependency_block` | Espera merge/cierre de otro issue (`#NNNN`) o asset no en `main` | No | `blocked:dependencies` | `brazoDesbloqueo` (5 min) cuando todas las deps están CLOSED |
| `human_block` | Acción humana: merge manual, CODEOWNERS, decisión, credencial | No | `needs-human` | Humano remueve el label |
| `infra` | Red/timeout/DNS — error externo recuperable | No | — | Reintento automático (con cap `MAX_REBOTES_INFRA`) |
| `code` | Fallback técnico — bug del código del issue | **Sí** | — | Re-encola con `rebote_numero+1` hasta `MAX_REBOTES=3` |

**Precedencia (más específica gana):**

```
cross_phase  >  dependency_block  >  human_block  >  infra  >  code
```

## Flujo end-to-end

```
agente claude (skill) emite rejection.yaml con `motivo`
        │
        ▼
.pipeline/<pipe>/<fase>/listo/<N>.<skill>
        │
        ▼ (brazoBarrido — pulpo.js:2437)
clasificación de cada motivo:
  ├─ precheck.classifyError(motivo) → infra | codigo
  └─ classifyRebote({motivo, classifyErrorResult, isRoutingMismatch})  ◄── #3167
        │
        ▼ result.category
        │
        ├── 'dependency_block'
        │         │
        │         ▼ (pulpo.js:~2660)
        │   reportDependencyBlock({issue, dependsOn, reason, skill, phase})
        │         │
        │         ▼
        │   .pipeline/servicios/github/pendiente/
        │     ├── <N>-blocked-dependencies-block-<ts>.json   (action: 'label')
        │     └── <N>-deps-comment-<ts>.json                  (action: 'comment')
        │         │
        │         ▼ (servicio-github.js polls cola)
        │   gh issue edit <N> --add-label blocked:dependencies
        │   gh issue comment <N> --body "## Dependencias detectadas por el pipeline ..."
        │         │
        │         ▼ (brazoDesbloqueo cada ~5 min — pulpo.js:7813)
        │   for each issue con label blocked:dependencies:
        │     parseDependencyComment(comments, issue)
        │     for each dep in parsed:
        │       gh issue view <dep> --json state
        │     if all CLOSED:
        │       gh issue edit <N> --remove-label blocked:dependencies
        │       gh issue comment <N> --body "## Dependencias resueltas 🟢 ..."
        │
        ├── 'human_block'  → humanBlock.reportHumanBlock → bloqueado-humano/<N>.marker
        ├── 'infra'        → re-encola con rebote_tipo=infra (no cuenta CB)
        ├── 'cross_phase'  → mueve a definicion/analisis con rebote_tipo=routing
        └── 'code'         → re-encola con rebote_numero+1 hasta MAX_REBOTES
```

## Convención estructurada para agentes (`rebote_categoria`)

Los agentes Claude pueden **emitir un hint estructurado** en el motivo para
saltarse el pattern matching y declarar directamente la categoría. Es el
formato **preferido** cuando el agente tiene certeza:

```yaml
resultado: rechazado
rebote_categoria: dependency_block
depende_de: [3083, 3084]
motivo: |
  U1 multi-provider necesita el audit trail unificado de #3083 (S5) y
  los flags de #3084 (H6) ya mergeados a `main` para poder integrar.
```

El classifier reconoce el hint en `STRUCTURED_DEPENDENCY_HINT` y `STRUCTURED_DEPS_LIST`
y lo prioriza sobre la heurística de patrones de texto.

**Skills que actualmente emiten el hint:**
- `guru` — sección "FORMATO DE REBOTES" en [`.pipeline/roles/guru.md`](../../.pipeline/roles/guru.md)
- Cualquier skill puede adoptarlo; sólo requiere agregar la nota al prompt.

## Patrones de detección (heurística text-based)

Cuando el agente NO emite el hint estructurado, el classifier intenta detectar
`dependency_block` con regex acotadas. La lista vive en `DEPENDENCY_PATTERNS`
(issues con `#N`) y `DEPENDENCY_ASSET_PATTERNS` (assets/recursos sin `#N`).

### Cómo agregar un nuevo patrón

1. Abrí `.pipeline/lib/rebote-classifier.js`, sección "PATRONES DEPENDENCY_BLOCK".
2. Agregá la regex al array `DEPENDENCY_PATTERNS` **al final** (los patrones
   más específicos primero — orden importa para minimizar falsos positivos).
3. Criterios anti-ReDoS:
   - Sin quantifiers anidados (`(a+)+`).
   - Sin alternaciones que matcheen el mismo prefijo (`(foo|food)`).
   - Quantifiers acotados (`{0,80}`, no `*` libre dentro de grupos opcionales).
   - El número de issue **siempre** captura en `m[1]`.
4. Agregá un test unitario en `rebote-classifier.test.js` con el motivo real
   que la regex debe atrapar + un control negativo similar que NO debe matchear.
5. Corré `node .pipeline/lib/__tests__/rebote-classifier.test.js` (32+1 OK).

## Brazo de desbloqueo automático

El loop ya existe pre-#3167 (`brazoDesbloqueo` en `pulpo.js:7813`, encadenado
al ciclo principal del Pulpo en `pulpo.js:8430` con sus pares barrido,
intake, huérfanos). Se hizo `async` en #2801 para no bloquear el event loop
durante las llamadas a `gh`.

### Ciclo de un tick del brazo

1. **Guard de re-entry** (`_unblockRunning` con watchdog `UNBLOCK_WEDGE_TIMEOUT_MS`).
2. **Respeta pausa parcial** (`partialPause.getPipelineMode()`): si modo `paused`
   sale; si `partial_pause` filtra issues fuera del allowlist.
3. `gh issue list --label "blocked:dependencies" --state open --json number,title,labels --limit 50`.
4. Por cada issue bloqueado:
   - `gh issue view <N> --json comments` → `parseDependencyComment(commentsArray, N)`.
   - Si parser retorna `null` (no marker) → **fail-closed**, skip ciclo, NO toca labels.
   - Si retorna `[]` (marker vacío) → registra sin deps en mapa.
   - Si retorna `[deps...]` → consulta `gh issue view <dep> --json state` para
     cada una; si todas son `CLOSED` → desbloquea.
5. **Desbloqueo:**
   - `gh issue edit <N> --remove-label blocked:dependencies`
   - `gh issue comment <N> --body "## Dependencias resueltas 🟢 ..."`
   - Telegram: `🪢→🟢 #<N> destrabado automáticamente (deps cerradas: #X,#Y)`
6. **Auto-cierre del paraguas** (label `split`): si el issue era un paraguas
   `split` con todas las hijas cerradas, el brazo lo cierra con `gh issue
   close --reason completed`.

### Intervalo y configuración

- Intervalo del loop principal del Pulpo: configurable en `.pipeline/config.yaml`
  → `pulpo.tick_interval_ms`. Default: 30 segundos.
- Intervalo específico del barrido de desbloqueo: `UNBLOCK_INTERVAL_MS`.
  Default: 5 minutos (cada N ticks, no en cada uno, para no exceder el rate
  limit de `gh`).

### Idempotencia

- El servicio-github es deduper-aware: si encola dos `label` con la misma
  combinación issue+label, sólo aplica uno.
- Si una segunda invocación del brazoBarrido detecta el mismo `dependency_block`
  ANTES de que el servicio-github procese la cola, ambos archivos se encolan
  con timestamps distintos pero el resultado es idempotente: GitHub no duplica
  labels y el comment dedup se hace por la regla del propio servicio.

## Cómo intervenir manualmente

| Necesidad | Comando |
|---|---|
| Forzar destrabe de un issue | `gh issue edit <N> --remove-label blocked:dependencies` (el pipeline reentra en próximo intake) |
| Forzar bloqueo humano (override) | `gh issue edit <N> --add-label needs-human` (precedencia sobre `blocked:dependencies` porque el intake del Pulpo excluye `needs-human`) |
| Mover entre categorías | Solo cambiar labels — el pipeline se acomoda en el próximo ciclo |
| Inspeccionar deps detectadas | `cat .pipeline/blocked-issues.json` |
| Forzar reparseo (después de cambiar el marker) | Eliminar `.pipeline/blocked-issues.json` — el brazo reconstruye en el próximo ciclo |

## Cómo extender el sistema

### Nueva categoría (ej: `quota_block`)

1. Agregar el ramo al switch de `classifyRebote` en `rebote-classifier.js`,
   respetando la precedencia (más específica primero).
2. Definir el side effect:
   - ¿Aplica label? Agregar la constante (`QUOTA_LABEL`).
   - ¿Tiene autounlock? Definir mecanismo (`source`, `label`, `note`).
   - ¿Cuenta para el circuit breaker?
3. Agregar la rama en `pulpo.js:brazoBarrido` (similar al bloque
   `if (depBlockHandled) continue;` que introdujo #3167).
4. Si requiere un nuevo loop, modelarlo sobre `brazoDesbloqueo` (re-entry
   guard, watchdog, async-no-blocking).
5. Actualizar `agents/*.md` para que los agentes puedan emitir el hint
   `rebote_categoria: quota_block`.
6. Tests: unit + integration.

### Nuevo patrón (en una categoría existente)

Ver sección "Cómo agregar un nuevo patrón" arriba.

### Cambiar el intervalo del brazo

Editar `UNBLOCK_INTERVAL_MS` en `pulpo.js` (o exponer en `config.yaml` clave
`desbloqueo.interval_min` — opción de mejora pendiente).

## Troubleshooting

### "#N tiene label `blocked:dependencies` pero no se destraba"

1. `gh issue view <N> --json comments | jq '.comments[].body' | grep "Dependencias detectadas"` —
   si no aparece, el marker se perdió. Re-encolar manualmente o quitar el label.
2. `grep "🪢" .pipeline/logs/pulpo.log | tail -20` — el log del brazo de
   desbloqueo. Buscar errores de `gh-call-timeout` o `respuesta no parseable`.
3. `cat .pipeline/blocked-issues.json` — mapa actual del brazo. Si el issue
   NO está en `blockedBy`, el parser no encontró marker (fail-closed).
4. `cat .pipeline/logs/desbloqueo.log` (si configurado) — historial reciente.

### "Un agente cayó a `bloqueado-humano/` cuando era una dep"

1. Leer el `reason.json` del marker: `.pipeline/<pipe>/<fase>/bloqueado-humano/<N>.reason.json`.
2. Identificar el patrón del motivo que NO matcheó. Posibles causas:
   - Formato nuevo no cubierto por `DEPENDENCY_PATTERNS`.
   - El agente usó otro idioma o frase ("blocked by ... not merged").
3. Agregar el patrón siguiendo la sección "Cómo agregar un nuevo patrón".
4. Escribir test con el motivo real del incidente.
5. Workaround inmediato: `gh issue edit <N> --remove-label needs-human --add-label blocked:dependencies`
   y agregar el comment con el formato esperado.

### "Brazo de desbloqueo nunca corre"

1. `grep "brazoDesbloqueo\|desbloqueo" .pipeline/logs/pulpo.log | tail -5` —
   si NUNCA hay log, el loop no está spawneado.
2. Verificar línea ~8430 de `pulpo.js`: `brazoDesbloqueo(config).catch(...)` debe
   estar dentro del setInterval del ciclo principal.
3. Verificar que el guard `_unblockRunning` no esté wedged (watchdog
   `_checkAndResetUnblockWedge` lo desbloquea solo cada `UNBLOCK_WEDGE_TIMEOUT_MS`).

### "Demasiados falsos positivos `dependency_block`"

1. Identificar los motivos que matchean por error.
2. Acotar el patrón problemático (más específico) en `DEPENDENCY_PATTERNS`.
3. Agregar test negativo: motivo similar que NO debe matchear.

## Tests

| Tipo | Comando | Cobertura |
|---|---|---|
| Unit | `node .pipeline/lib/__tests__/rebote-classifier.test.js` | 32 tests — CA-1..CA-10 + SMOKE #3086 |
| Integration | `node .pipeline/lib/__tests__/rebote-classifier.integration.test.js` | 9 tests — flujo end-to-end con cola GitHub real |
| Parser | `node .pipeline/lib/__tests__/dep-comment-parser.test.js` | 31 tests — incluye `parseDependenciesFromComment` |

Smoke con motivo real del incidente #3086: incluido en unit tests
(`SMOKE #3086: motivo realístico del guru → dependency_block con #3083`).

## Archivos clave

| Archivo | Responsabilidad |
|---|---|
| [`.pipeline/lib/rebote-classifier.js`](../../.pipeline/lib/rebote-classifier.js) | Núcleo: `classifyRebote`, `detectDependencyBlock`, `buildDependencyComment`, `reportDependencyBlock`, `sanitizeDepsList` |
| [`.pipeline/lib/dep-comment-parser.js`](../../.pipeline/lib/dep-comment-parser.js) | Parser del marker GitHub (lectura). Expone `parseDependencyComment` (null = fail-closed) y `parseDependenciesFromComment` (siempre `[]` mínimo) |
| [`.pipeline/lib/human-block.js`](../../.pipeline/lib/human-block.js) | Detección legacy + marker para `bloqueado-humano/`. Se mantiene como segunda red de defensa |
| [`.pipeline/lib/routing-classifier.js`](../../.pipeline/lib/routing-classifier.js) | Detección de cross_phase. Lo invoca el caller (pulpo.js) antes de `classifyRebote` |
| [`.pipeline/pulpo.js`](../../.pipeline/pulpo.js) (líneas ~2655–2750) | Wire-up: invoca `classifyRebote` antes de evaluar humanBlock |
| [`.pipeline/pulpo.js`](../../.pipeline/pulpo.js) (líneas 7813–8015) | `brazoDesbloqueo` — loop que destraba issues con `blocked:dependencies` cuando todas las deps cierran |
| [`.pipeline/roles/guru.md`](../../.pipeline/roles/guru.md) | Prompt del agente que más emite hints `dependency_block`. Sección "FORMATO DE REBOTES" |

## Glosario

- **CB** (Circuit Breaker): contador `rebote_numero` con cap `MAX_REBOTES=3`. Si
  un issue alcanza el cap, queda fuera de la cola hasta intervención manual.
- **Marker GitHub**: el comment con heading exacto `## Dependencias detectadas
  por el pipeline` seguido de bullets `- #N`. Es la fuente de verdad para el
  brazo de desbloqueo.
- **Hint estructurado**: el bloque `rebote_categoria: ... + depende_de: [...]`
  en el motivo crudo del agente. Atajo al pattern matching.
- **Fail-closed**: si no se puede confirmar que las deps están realmente
  cerradas, NO destrabar. Mejor pedir intervención manual que mover el issue
  con deps reales todavía abiertas.
