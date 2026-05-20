# Modelo de Planificación Multi-ola — Pipeline V3

> **Estado:** Diseño aprobado por Spike #3378 (mayo 2026).
> **Audiencia:** Commander (Leo), agentes `planner` / `pipeline-dev`, contribuyentes del Pulpo.
> **Naturaleza:** Diseño — la implementación se entrega en los issues hijos enumerados al final.

## 1. Resumen ejecutivo

El pipeline V3 viene operando con la convención de **"pausa parcial + allowlist"** (`.pipeline/.partial-pause.json`) como mecanismo de control de qué issues procesa el Pulpo en cada momento. Esa allowlist es, de facto, **la ola en curso**, pero hoy se arma a criterio del Commander sin trazabilidad explícita y sin visión más allá de "la próxima".

Este documento formaliza el concepto de **ola** — sin volver a la rigidez de los Sprints viejos — y expande el rol del agente `planner` para que pueda:

1. **Componer** olas con razonabilidad documentada.
2. **Mantener** un horizonte de 5-10 olas hacia adelante.
3. **Proponer** mutaciones que el Commander aplica con OK humano.

La pieza central es un nuevo artefacto, `waves.json`, que **proyecta** la allowlist a `.partial-pause.json` (sin romper los 60+ call sites del Pulpo) y registra el horizonte planeado.

---

## 2. Concepto de ola

Una **ola** es un agrupamiento de issues que el Pulpo procesa durante un período abierto e indeterminado, con un objetivo común explícito.

### 2.1 Campos obligatorios (mínimo viable — 3)

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `name` | string (≤60 chars) | Nombre humano: `"Ola N+8 — Sherlock + robustez pipeline"`. No usar `"Ola 8"` pelado. |
| `goal` | string (≤140 chars) | Objetivo en una frase, tweet-style. |
| `started_at` | ISO-8601 string | Timestamp de apertura (no de planificación). |

### 2.2 Campos opcionales

| Campo | Tipo | Uso |
|-------|------|-----|
| `hypothesis` | string libre | "Si entregamos X primero, destrabamos Y". |
| `success_metrics` | array de strings | Métricas con las que se evaluará la ola al cierre. |
| `closed_at` | ISO-8601 | Se completa al cerrar la ola (no es deadline). |
| `carry_over_from` | array de números | Olas previas que originaron issues de esta. |
| `rationale` | string libre | El "por qué" de esta composición (ver §6). |
| `confidence` | `"committed"` \| `"tentative"` | Solo la activa es `committed`. Olas planeadas son `tentative`. |
| `issues` | array de números | IDs de GitHub que componen la ola. |
| `closed_issues` | array de números | IDs cerrados durante la vida de la ola (para distinguir agregados vs. resueltos). |

### 2.3 Campos PROHIBIDOS (anti-Sprint)

| Campo | Por qué está prohibido |
|-------|------------------------|
| `due_date` | Cualquier fecha de cierre fija replica la rigidez de Sprints. |
| `target_date` | Idem. |
| `deadline` | Idem. |
| `velocity` | El velocity tracking es contabilidad de Sprint y obliga a estimar para comparar. |
| `committed_scope` | El scope no se cierra: issues pueden entrar a la ola en curso (ver §3.3). |

Cualquier PR que agregue uno de estos campos al schema debe ser rechazado en review.

---

## 3. Ciclo de vida de una ola

El ciclo es **por eventos, no por calendario**. No hay timers ni jobs de cron que abran o cierren olas.

### 3.1 Apertura

Una ola se abre **explícitamente** por uno de dos disparadores:

1. **Manual (Commander)** — Leo invoca por Telegram `/wave open N+9 "Hardening multi-provider"` y el handler delega a `lib/waves.js#openWave({number, name, goal, issues, rationale})`.
2. **Promote (planner)** — el planner propone abrir la siguiente ola (`/planner componer-ola N+9`), genera la propuesta como **comentario en GitHub** (issue del Spike o de seguimiento), el Commander la aprueba en Telegram, y la mutación se aplica con `lib/waves.js#promoteNextWave()`.

En ambos casos, el módulo `lib/waves.js`:
- Valida invariantes (caps de seguridad, ver §7).
- Archiva la ola anterior a `.pipeline/waves/<N-1>.json` (si existía).
- Reescribe `waves.json` con la nueva `active_wave`.
- Regenera `.partial-pause.json` como **proyección** (issues activos).
- Loguea la mutación en `logs/waves.jsonl` vía `lib/audit-log.appendChained()`.

> **Nunca** se abre una ola por automatismo. La apertura siempre exige acción humana o agente con OK humano.

### 3.2 Cierre

Una ola se cierra cuando se cumple **uno** de estos criterios:

1. **Por estado** — todos los issues de `active_wave.issues` (menos los que pasaron a `closed_issues`) están `closed` en GitHub. El Pulpo detecta la condición en su loop principal y notifica al Commander vía Telegram (`/wave ready-to-close N+8`). La ola no se cierra sola: requiere OK del Commander.
2. **Por decisión del Commander** — Leo invoca `/wave close N+8 [reason]`. Útil cuando la ola se interrumpe (cambio de prioridades, descubrimiento de bug crítico que reordena el plan).

**No existe** cierre por timeout, por fecha, ni por velocity. Si una ola lleva 3 semanas sin cerrar, eso es una señal de planificación (issues mal dimensionados o demasiados carry-overs), no de gestión por calendario.

### 3.3 Agregar un issue a la ola en curso

Operación de primer ciudadano. No es excepcional, es esperable.

- **API:** `lib/waves.js#addIssueToActive(issueNum, {reason})`.
- **Disparadores:**
  - Bug crítico aparece (`priority:critical`) y debe procesarse junto con la ola actual.
  - Dependencia detectada por `partial-pause-deps.js` (#2893): un issue de la ola depende de otro que no estaba en la allowlist.
  - Decisión del Commander por Telegram.
- **Efectos:**
  - Append a `active_wave.issues`.
  - Re-proyección de `.partial-pause.json`.
  - Auto-inclusión de deps (si las hay) vía `partial-pause-deps.js`.
  - Log en `logs/waves.jsonl`: `{action: "add_issue", wave_number, issue, reason, actor}`.

### 3.4 Re-priorizar una ola futura

Operación trivial sobre el campo `planned_waves[]` de `waves.json`. No tiene penalización conceptual porque las olas planeadas son `confidence: "tentative"` por definición.

- **API:** `lib/waves.js#repositionPlanned(waveNumber, {newIssues, newRationale, newOrder})`.
- **Disparadores:** cambio de prioridades, gap detectado por el planner, decisión del PO.
- **Restricción:** no se puede re-priorizar la ola activa con esta API — para eso existe `addIssueToActive` (agregar) o `closeWave` (cerrar y abrir otra).

### 3.5 Carry-over entre olas

Un issue que no cierra durante su ola **no se penaliza**. El proceso:

1. Commander invoca `/wave close N+8` (manual o por estado).
2. Antes del cierre, `lib/waves.js` calcula `pending = active.issues - active.closed_issues` y propone un draft de la siguiente ola con esos issues como `carry_over_from: [N+8]`.
3. El Commander revisa la propuesta y aprueba (o reordena).
4. La nueva ola se abre con esos issues + cualquier issue nuevo que el planner sume del horizonte.

El registro del carry-over queda **explícito** en el campo `carry_over_from` de la nueva ola.

---

## 4. Artefactos y contrato técnico

### 4.1 Decisión: Opción A (proyección)

Adoptamos **Opción A** del análisis de Guru: `waves.json` es la fuente de verdad de planificación, `.partial-pause.json` es la **proyección runtime** de la ola activa.

**Justificación:**

- Los 60+ call sites del Pulpo (`getPipelineMode`, `isIssueAllowed`, etc.) **no cambian**. Cambio aditivo, no destructivo.
- La infraestructura `wave-resolver.js` ya existe con cascada `active-wave.json` → `.partial-pause.json` → scan. Sólo hay que enchufar la generación de `active-wave.json` a partir de `waves.json`.
- El módulo `partial-pause-deps.js` (#2893) sigue funcionando intacto.

Opción B (Pulpo lee `waves.json` directo, `.partial-pause.json` deprecado) queda como **futura deuda técnica** si la coexistencia genera fricción real. Issue hijo opcional.

### 4.2 Shape de `waves.json`

```json
{
  "schema_version": 1,
  "active_wave": {
    "number": 8,
    "name": "Ola N+8 — Sherlock + robustez pipeline",
    "goal": "Cerrar verifier Sherlock + 3 hardening del Pulpo",
    "started_at": "2026-05-19T19:27:00-03:00",
    "issues": [3373, 3342, 3343, 3331, 3317, 2536, 2800, 3378],
    "closed_issues": [],
    "carry_over_from": [],
    "rationale": "Sherlock arranca con HTTP completion (#3342) y core (#3343). #3373 entrega el split. Robustez del Pulpo cierra antes del próximo épico de planificación.",
    "confidence": "committed",
    "hypothesis": "Si Sherlock cierra en esta ola, el verifier queda disponible para la ola siguiente.",
    "success_metrics": [
      "Sherlock procesa >=10 issues sin falso positivo",
      "Cero rebotes de infraestructura en 7 días post-merge"
    ]
  },
  "planned_waves": [
    {
      "number": 9,
      "name": "Ola N+9 — Hardening multi-provider",
      "goal": "Cerrar deuda observability y rotación de claves",
      "issues": [3176, 3201, 3068],
      "rationale": "Carry-over de #3201 (no cerró en N+8). #3176 cierra el épico de docs operativas. #3068 consolida audit-log antes de #3378 hijos.",
      "carry_over_from": [8],
      "confidence": "tentative"
    },
    {
      "number": 10,
      "name": "Ola N+10 — Implementación multi-ola (hijos #3378)",
      "goal": "Schema + lib/waves.js + planner expandido",
      "issues": [],
      "rationale": "Placeholder. Los IDs se completan al crear los hijos del Spike #3378.",
      "carry_over_from": [],
      "confidence": "tentative"
    }
  ],
  "history_pointer": ".pipeline/waves/",
  "updated_at": "2026-05-20T08:00:00-03:00",
  "updated_by": "commander"
}
```

### 4.3 Cómo se proyecta a `.partial-pause.json`

```
waves.json.active_wave.issues  ─┐
                                ├──► lib/waves.js.project()  ──►  .partial-pause.json
partial-pause-deps (auto-deps) ─┘                                  (allowed_issues + source: "waves.js")
```

- `.partial-pause.json.source` pasa a ser siempre `"waves.js"` cuando hay ola activa (mecanismo único de mutación).
- `.partial-pause.json.note` se genera desde `waves.json.active_wave.name + goal` (preserva el patrón histórico textual).
- Si `waves.json` no existe, `wave-resolver.js` cae al modo legacy (lee `.partial-pause.json` directo) — **compatibilidad backward total**.

### 4.4 Historial: `.pipeline/waves/<N>.json`

Cuando se cierra una ola, su estado final se archiva a `.pipeline/waves/<N>.json`:

```json
{
  "number": 7,
  "name": "Ola N+7 — Dashboard V3 + métricas",
  "goal": "...",
  "started_at": "...",
  "closed_at": "...",
  "issues": [...],
  "closed_issues": [...],
  "carry_over_to": [8],
  "rationale": "...",
  "final_metrics": {
    "duration_days": 12,
    "issues_closed_in_wave": 14,
    "carry_over_count": 2
  }
}
```

Estos archivos son **append-only** (nunca se modifican post-cierre). Son insumo para reportes históricos del planner.

### 4.5 Compatibilidad con `partial-pause-deps.js` (#2893)

Cuando `partial-pause-deps.js` detecta una dep faltante y el Commander aprueba la auto-inclusión, la API correcta es:

```
addIssueToActive(depIssueNum, {reason: "auto-included by partial-pause-deps", actor: "system"})
```

— **no** edición directa de `.partial-pause.json`. El handler actual de Telegram (`commander/...` que aprueba la auto-inclusión) debe migrar a esta API en el issue hijo correspondiente.

---

## 5. Rol expandido del `planner`

### 5.1 Modos actuales (preservados)

`validar-tamaño`, `sprint`, `planificar`, `proponer`, `split`, `estado`. **Todos** siguen funcionando igual.

### 5.2 Modos nuevos

| Modo | Sintaxis | Output | Aplica mutación? |
|------|----------|--------|------------------|
| `olas` | `/planner olas` | Resumen Markdown: ola activa + horizonte completo (5-10 olas) | No |
| `horizonte [N]` | `/planner horizonte 5` | Tabla de las próximas N olas con issues + rationale | No |
| `componer-ola <N>` | `/planner componer-ola N+9` | **Propuesta** legible en formato tabla, posteada como comentario en el issue actual del Spike (#3378) o issue de seguimiento | **No** — el Commander aprueba/aplica con `/wave open` |
| `cerrar-ola [N]` | `/planner cerrar-ola N+8` | Reporte de cierre + propuesta de carry-overs | **No** — el Commander aprueba con `/wave close` |

### 5.3 Output de `componer-ola` (formato obligatorio)

Tabla Markdown con columnas: `issue`, `título`, `size`, `razonabilidad`, `dependencias`.

```markdown
## Propuesta de Ola N+9 — Hardening multi-provider

**Goal:** Cerrar deuda observability y rotación de claves
**Carry-over from:** N+8 (#3201)

| Issue | Título | Size | Razonabilidad | Dependencias |
|-------|--------|------|---------------|--------------|
| #3201 | Provider exhaustion alert | M | Carry-over de N+8, casi cerrado | — |
| #3176 | Doc operativa multi-provider | S | Cierra épico observability | #3201 |
| #3068 | Consolidar audit-log genérico | M | Bloquea hijos de #3378 | — |

**Total:** 3 issues, ~7d esfuerzo estimado, sin bloqueos cruzados.

Para aprobar: `/wave open N+9 "Hardening multi-provider"` desde Telegram.
```

### 5.4 Horizonte de planificación

El planner debe poder mantener un horizonte **mínimo de 5 olas** y **target 5-10**. La consulta `/planner horizonte 10` produce:

- Resumen de la activa.
- Tabla de N olas planeadas con: número, nombre, goal, count issues, count carry-overs, confidence.
- Banderas de riesgo: olas con muchos carry-overs, olas vacías, gaps de tema.

### 5.5 Reglas de razonabilidad (qué tiene que decir el `rationale`)

El `rationale` de una ola es texto libre, pero debe responder al menos a 3 de estas preguntas:

1. ¿Qué une a los issues de esta ola (tema, épico, capa)?
2. ¿Qué se desbloquea al cerrar esta ola?
3. ¿Por qué este orden y no otro (dependencias, riesgo, valor)?
4. ¿Qué carry-overs trae de la ola anterior y por qué no cerraron?
5. ¿Qué se posterga a la siguiente ola y por qué?

Anti-patrón: dump de IDs sin contexto. El planner no debería emitir rationale si no puede justificar 3 de estas 5 preguntas.

### 5.6 Restricciones del planner (qué NO puede hacer)

- **No aplica mutaciones** sobre `waves.json` ni `.partial-pause.json`. Sólo propone.
- **No abre ni cierra olas** por sí mismo. Siempre requiere `/wave open` o `/wave close` del Commander.
- **No re-prioriza** silenciosamente. Cualquier propuesta de re-priorización va como comentario aprobable.
- **No inventa caps**: si excede los caps del schema (§7), aborta la propuesta y reporta.

---

## 6. Ejemplos concretos

### 6.1 Ejemplo: Ola N+7 (Dashboard V3 + métricas)

Si N+7 hubiese existido bajo este modelo, su sección en `waves.json` (al cerrar) sería:

```json
{
  "number": 7,
  "name": "Ola N+7 — Dashboard V3 + métricas",
  "goal": "Cerrar UX de Dashboard V3 y reactivar /metrics",
  "started_at": "2026-04-25T10:00:00-03:00",
  "closed_at": "2026-05-08T18:30:00-03:00",
  "issues": [3340, 3370, 3371, 3372, 3374, 2800],
  "closed_issues": [3370, 3371, 3372, 3374],
  "carry_over_to": [8],
  "rationale": "Foco en cerrar la deuda de UX del Dashboard V3 que arrastrábamos desde N+5. #3340 y #2800 son épicos grandes que sabíamos no cerrarían acá; el resto son fixes acotados. Carry-over esperado: 2 issues a N+8.",
  "confidence": "committed",
  "final_metrics": {
    "duration_days": 13,
    "issues_closed_in_wave": 4,
    "carry_over_count": 2
  }
}
```

### 6.2 Ejemplo: Ola N+8 (actual, lista de 8 issues)

Snapshot de la ola en curso al momento del Spike (basado en lo que el Commander tiene hoy en `.partial-pause.json`):

```json
{
  "number": 8,
  "name": "Ola N+8 — Sherlock + robustez pipeline",
  "goal": "Cerrar Sherlock verifier + 3 robustez del Pulpo",
  "started_at": "2026-05-19T19:27:00-03:00",
  "issues": [3373, 3342, 3343, 3331, 3317, 2536, 2800, 3378],
  "closed_issues": [3379],
  "carry_over_from": [7],
  "rationale": "Sherlock (#3331) arranca con dos hijos: HTTP completion-client genérico (#3342, ya cerrado como #3379) y core del verifier (#3343). #3317 y #2536 son robustez del Pulpo que veníamos posponiendo. #2800 sigue carry-over de N+7 (Dashboard Kanban). #3378 (este Spike) cierra el modelo multi-ola que va a regir N+9 en adelante. Decisión clave: no incluir #3201 acá porque depende de #3068 que está en backlog técnico, y forzarlo retrasa Sherlock.",
  "confidence": "committed",
  "hypothesis": "Sherlock cierra en esta ola y queda como verifier disponible para N+9.",
  "success_metrics": [
    "Sherlock procesa al menos 10 issues post-merge sin falso positivo",
    "Cero rebotes de infra del Pulpo en 7 días post-N+8"
  ]
}
```

### 6.3 Escenarios de flexibilidad (CA-10)

**Escenario A — bug crítico mientras N+8 está en curso:**

> Aparece `#3400` (`priority:critical`, "Pulpo se cuelga al procesar issues con cyrillic en título"). El Commander invoca `/wave add 3400 N+8 "bug crítico bloqueante"`. El módulo `lib/waves.js.addIssueToActive(3400)` appendea a `active_wave.issues`, re-proyecta `.partial-pause.json`, loguea en `waves.jsonl`. La ola no se cierra ni se reabre; simplemente crece. Tiempo total: <2 segundos. Sin penalización.

**Escenario B — cambian prioridades, N+10 ya no aplica:**

> El roadmap pivota: la migración mobile que estaba en N+10 se posterga. El Commander invoca `/planner componer-ola N+10` con el nuevo foco. El planner propone una nueva composición. El Commander aprueba con `/wave plan N+10 "Nuevo nombre" --issues 3501,3502,3503`. Como N+10 es `confidence: tentative`, la re-priorización es sobrescritura limpia, sin trazabilidad de "scope vs. delivered" (el concepto no aplica a tentative).

**Escenario C — #3343 no cierra a tiempo en N+8:**

> El Commander decide cerrar N+8. Invoca `/wave close N+8`. `lib/waves.js.closeWave()` detecta que `#3343` sigue abierto, archiva la ola a `.pipeline/waves/8.json` con `closed_issues: [3379, 3342, 3331, 3317, 2536, 3378]` y `carry_over_to: [9]`. Propone draft de N+9 incluyendo `#3343` con `carry_over_from: [8]` y rationale autogenerado: "Carry-over de #3343 desde N+8 (no cerró por X)". El Commander revisa, agrega/quita issues, aprueba con `/wave open N+9`. Tiempo total: <5 minutos.

---

## 7. Seguridad y control

Esta sección cubre los 7 vectores OWASP identificados por `/security` en la fase de criterios. Son **requisitos** que los issues hijos de implementación deben respetar.

### 7.1 Authorization model (A01 — Broken Access Control)

- `waves.json` se muta **solo** vía `lib/waves.js`. Edición manual del JSON queda prohibida (misma política que `.partial-pause.json`).
- `lib/waves.js` se invoca desde:
  - **Handler de Telegram autenticado** (Commander/Leo via `/wave open|close|add|plan`).
  - **Agente `planner`** — **pero sólo** vía generación de propuestas (comentarios en GitHub), **nunca** aplicando mutaciones directas.
- El módulo valida el `actor` en cada mutación y rechaza si no proviene de un origen autorizado.

### 7.2 Concurrent writes / TOCTOU (A04 — Insecure Design)

Patrón **planner-propone + Commander-aplica** (mismo modelo que `partial-pause-deps.js`):

- El planner genera la propuesta como **comentario en GitHub** (texto en Markdown). No toca `waves.json`.
- El Commander aplica la propuesta vía Telegram. La aplicación pasa por `lib/waves.js`.
- `lib/waves.js` usa **rename atómico** (`fs.rename` sobre tempfile) para reescribir `waves.json`. Si dos comandos Telegram llegan simultáneos, el segundo lee el estado post-primero y aplica encima.
- No hay file-lock explícito porque el patrón "propose + apply" elimina la carrera dominante. El rename atómico cubre el resto.

### 7.3 Source-of-truth divergence (A04)

**Invariante:** `waves.json.active_wave.issues ⊇ .partial-pause.json.allowed_issues` (módulo deps auto-incluidas).

- La **única** ruta de mutación de `.partial-pause.json` cuando hay ola activa es `lib/waves.js.project()`.
- Issue hijo correspondiente debe entregar un **test de invariante** que falle si alguien mutó `.partial-pause.json` por fuera (CI rojo).
- En modo legacy (sin `waves.json`), `partial-pause.js` sigue siendo escribible directamente (backward compat).

### 7.4 Audit trail (A09 — Logging & Monitoring)

- Todas las mutaciones de `waves.json` se registran en `.pipeline/logs/waves.jsonl` con `lib/audit-log.appendChained()` (SHA-256 hash chain ya existente, **no reinventar**).
- Campos mínimos por entrada: `actor`, `action` (`open_wave` | `close_wave` | `add_issue` | `remove_issue` | `promote` | `plan_wave` | `repriorize`), `wave_number`, `diff` (snapshot del cambio), `source` (`telegram-commander` | `planner-proposal-applied` | `system`).
- Hash chain permite detectar tampering del log con `verifyChain()`.

### 7.5 DoS por planificación inflada (A04)

Caps defensivos hardcoded en `lib/waves.js`:

| Cap | Valor | Razón |
|-----|-------|-------|
| `MAX_PLANNED_WAVES` | 20 | Horizonte target es 5-10, 20 es margen de seguridad. |
| `MAX_ISSUES_PER_ACTIVE_WAVE` | 50 | Una ola con 50 issues ya es señal de mal sizing. |
| `MAX_ISSUES_TOTAL_HORIZON` | 200 | Suma de activa + planeadas. |

Cualquier mutación que excede un cap → `lib/waves.js` aborta y reporta error. No degrada silenciosamente.

### 7.6 Information disclosure en `rationale` (A03)

El campo `rationale` es texto libre y se commitea al repo (mismo trato que `.partial-pause.json`). **Prohibido** incluir:

- Credenciales (API keys, tokens, passwords).
- Datos personales de usuarios reales.
- URLs de staging/dev con tokens en el query string.
- Nombres de clientes en negociación (riesgo legal).

`lib/waves.js` debe correr `lib/redact.js` sobre `rationale` antes de persistir (defensa en profundidad) — el módulo ya redacta AWS keys, JWT, API keys, passwords.

### 7.7 Bypass del gate de aprobación humana (A04)

**Invariante:** el planner nunca aplica mutaciones por sí mismo. Las propuestas viven como **comentarios en GitHub** hasta que el Commander las aplica.

- El módulo `lib/waves.js` valida que el `actor` de cada mutación corresponda a un origen humano-aprobado (Telegram autenticado o aplicación manual de propuesta).
- Si en el futuro se agrega un modo "auto-promote", debe pasar por feature flag en `config.yaml` (`waves.auto_promote_enabled: false` por default) y requerir doble OK explícito de Leo.

### 7.8 Resumen de los 3 críticos (Security)

| Crítico | Implementación |
|---------|----------------|
| Authorization model | `lib/waves.js` única vía de mutación, valida `actor`. |
| Invariante source-of-truth | Test de invariante en CI: `partial-pause.json` ⊆ `waves.json.active_wave`. |
| No auto-apply | Planner sólo propone, mutaciones siempre con OK Commander/Leo. |

---

## 8. Diferencias con el modelo de Sprints

Sección obligatoria para que quede explícito **por qué este modelo es más ligero y flexible** que el viejo modelo de Sprints (descartado por Leo, ver memoria `feedback_no-sprint-kanban.md`).

| Eje | Sprints (viejo) | Olas (nuevo) |
|-----|-----------------|--------------|
| **Cierre** | Por calendario (2 semanas fijas). | Por estado (todos issues cerrados) o decisión Commander. |
| **Scope** | Cerrado al iniciar el Sprint. Agregar issues "rompe" el sprint. | Abierto. `addIssueToActive` es operación de primer ciudadano. |
| **Re-priorización** | Penalizada (re-planificación costosa). | Trivial. Olas planeadas son `confidence: tentative` por definición. |
| **Velocity tracking** | Métrica central, obliga a estimar para comparar entre sprints. | Inexistente. `final_metrics.issues_closed_in_wave` es descriptivo, no comparativo. |
| **Horizonte** | "El próximo Sprint" — 1 unidad hacia adelante. | 5-10 olas planeadas con `rationale` por cada una. |
| **Carry-overs** | Síntoma de fracaso ("rolled over"). | Mecanismo normal con campo dedicado `carry_over_from`. |
| **Campos obligatorios** | Fecha inicio, fecha fin, sprint goal, scope cerrado, velocity target. | `name`, `goal`, `started_at` (3). |
| **Campos prohibidos** | (N/A — todo está permitido) | `due_date`, `target_date`, `deadline`, `velocity`, `committed_scope`. |
| **Quién compone** | Sprint planning ritual (reunión humana). | Planner propone, Commander aplica. Asíncrono. |
| **Trazabilidad** | Burndown chart, retro al cierre. | `rationale` libre + audit log + archivo histórico por ola. |

**Síntesis:** las olas son una convención de **agrupamiento operativo** con trazabilidad y horizonte. Los Sprints son un **framework de compromiso** con fechas duras. Adoptamos lo primero, rechazamos lo segundo.

---

## 9. Operación: comandos del día a día

### 9.1 Por Telegram (Commander/Leo)

| Comando | Efecto |
|---------|--------|
| `/wave` | Status de la ola activa + próximas 5 planeadas. |
| `/wave open <N> "<name>" [--issues 1,2,3] [--goal "..."]` | Abre nueva ola activa. |
| `/wave close <N> [reason]` | Cierra ola activa, propone draft de carry-over. |
| `/wave add <issueN> <waveN> [reason]` | Agrega issue a una ola (activa o planeada). |
| `/wave remove <issueN> <waveN> [reason]` | Quita issue de una ola. |
| `/wave plan <N> "<name>" --issues 1,2,3 [--goal "..."]` | Crea/sobrescribe una ola planeada (tentative). |
| `/wave promote` | Promueve la próxima ola planeada a activa (cierra la actual primero). |

### 9.2 Por agente (planner)

| Comando | Efecto |
|---------|--------|
| `/planner olas` | Resumen markdown de ola activa + horizonte completo. |
| `/planner horizonte [N]` | Tabla de las próximas N olas. |
| `/planner componer-ola <N>` | Propone composición de ola N (comentario en GitHub). |
| `/planner cerrar-ola [N]` | Propone cierre con draft de carry-over. |

---

## 10. Issues hijos propuestos para implementación

> **Importante:** los issues NO se crean en este Spike. La lista se materializa cuando el Commander revisa la propuesta. El comentario de cierre del Spike repite esta lista en formato accionable.

| # | Título tentativo | Size | Depende de |
|---|------------------|------|-----------|
| H1 | `lib/waves.js`: schema + módulo de mutación + tests | M | — |
| H2 | Migración: `wave-resolver.js` lee `waves.json` antes de `.partial-pause.json` (proyección) | S | H1 |
| H3 | Handlers Telegram: `/wave open|close|add|remove|plan|promote` | M | H1, H2 |
| H4 | `planner` SKILL.md: modos `olas`, `horizonte`, `componer-ola`, `cerrar-ola` | M | H1 |
| H5 | Dashboard V3: panel "Próximas olas" (input para #2800) | M | H1, H2 |
| H6 | Test de invariante CI: `.partial-pause.json ⊆ waves.json.active_wave` | S | H1, H2 |
| H7 | Migración `partial-pause-deps.js` para usar `addIssueToActive` en vez de mutar `.partial-pause.json` | S | H1, H2 |
| H8 | Cerrar #3287 referenciando H1 (absorción del schema `active-wave.json`) | XS | H1 |
| H9 | Opcional: Opción B — Pulpo lee `waves.json` directo, deprecar `.partial-pause.json` | L | H1..H7 |
| H10 | Documentación operativa Telegram: cheatsheet `/wave` para Leo | XS | H3 |

**Dependencias explícitas:**

- H1 es bloqueante de todos los demás (es el módulo central).
- H8 absorbe #3287 (recomendación previa de guru sobre `active-wave.json`).
- H5 se entrega como input para #2800 (Dashboard Kanban) — coordinar con el dueño de ese épico.
- H9 es **opcional** y debe evaluarse después de que H1-H8 estén estables (mínimo 1 ola completa operando con el nuevo modelo).

**Tamaños usados:** XS (1 archivo, <100 LOC), S (1-2 archivos, <300 LOC), M (3-5 archivos, <800 LOC), L (épico, >5 archivos o >800 LOC). Convención del proyecto (memoria `feedback_sizing-not-time.md`).

---

## 11. Glosario rápido

| Término | Definición |
|---------|------------|
| **Ola** | Agrupamiento de issues que el Pulpo procesa durante un período abierto, con objetivo común explícito. |
| **Ola activa** | La que el Pulpo está procesando ahora (`waves.json.active_wave`). |
| **Olas planeadas** | Las que el planner propuso para el horizonte (`planned_waves[]`). Todas `confidence: tentative`. |
| **Allowlist** | Proyección runtime de `active_wave.issues` en `.partial-pause.json`. Lo que el Pulpo lee en hot path. |
| **Carry-over** | Issue que cruza de una ola a la siguiente sin penalización. |
| **Proyección** | Generar `.partial-pause.json` desde `waves.json` vía `lib/waves.js.project()`. |
| **Promote** | Cerrar la activa y abrir la siguiente planeada. |
| **Compose** | Proponer una composición de ola (modo planner). |

---

## 12. Referencias

- Issue origen: [#3378 — Spike: formalizar la planificación multi-ola del pipeline V3](https://github.com/intrale/platform/issues/3378).
- Recomendación previa absorbida: [#3287 — Esquema canónico de `active-wave.json`](https://github.com/intrale/platform/issues/3287).
- Épico consumidor del horizonte: [#2800 — Dashboard V3 Board Kanban](https://github.com/intrale/platform/issues/2800).
- Memoria operativa: `feedback_no-sprint-kanban.md`, `feedback_allowlist-no-tocar.md`, `feedback_partial-pause-empty-not-block.md`, `project_partial-pause-deps-bug.md`.
- Documentación relacionada: `docs/pipeline/pausa-parcial.md`, `docs/pipeline/telegram-commander.md`.
- Módulos existentes que el modelo reusa: `.pipeline/lib/wave-resolver.js`, `.pipeline/lib/wave-state.js`, `.pipeline/lib/wave-snapshot.js`, `.pipeline/lib/wave-renderer.js`, `.pipeline/lib/partial-pause.js`, `.pipeline/lib/partial-pause-deps.js`, `.pipeline/lib/audit-log.js`, `.pipeline/lib/redact.js`.
