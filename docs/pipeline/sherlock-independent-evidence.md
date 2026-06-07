# Sherlock — Evidencia independiente (#3846)

> Cómo Sherlock recolecta evidencia ground-truth contra fuentes de verdad
> reales (filesystem, git, GitHub API, heartbeats) en lugar de heredar las
> asunciones del `systemState` que le pasa el Commander.

## Qué problema resuelve

Sherlock (`.pipeline/lib/sherlock-verifier.js`) es el verificador adversarial
del Commander de Telegram. Su trabajo es **refutar** el análisis del Commander
contrastándolo con "el estado real del sistema".

El problema: hasta el #3846, ese "estado real" **ERA** el `systemState` que el
propio Commander observó. Y ese snapshot derivaba de los mismos marcadores del
pipeline (`waves.json`, heartbeats, archivos de fase
`.pipeline/desarrollo/dev/procesado/<issue>.*`) que el Commander ya había leído
para construir su análisis. Resultado: Sherlock solo podía detectar
incoherencias **internas** entre la respuesta y el snapshot, nunca refutar las
premisas de fondo.

### El ciclo perverso (caso #3722, 2026-06-06/07)

```
Commander: "¿Está #3722 hecho?"
  → Lee: waves.json, archivos de fase (procesado/3722.backend-dev)
  → Dice: "Sí, procesado + aprobado"

Sherlock: "Verificá eso contra el estado real"
  → Recibe systemState = {3722: "procesado/aprobado"}
  → Contrasta respuesta ("hecho") vs systemState ("procesado")
  → Cero contradicciones → Verdict: "ok"
  → NUNCA chequea si escape-html.js existe en disco o si la rama está en main
```

`#3722` reportaba `escape-html.js` "procesado y aprobado" en todas las fases,
pero el código **nunca se mergeó a main ni existía en disco**. Sherlock no lo
detectó. También se colaron **heartbeats zombi** (#3719, #3827): agentes muertos
cuyo marcador de heartbeat seguía diciendo "trabajando", bloqueando el cupo de
ejecución.

## Qué es la evidencia independiente

Es un conjunto de **hechos ground-truth** que Sherlock recolecta por su cuenta,
ANTES de armar el prompt fiscal, consultando fuentes que el Commander **no**
puede haber maquillado en su snapshot:

| Source        | Qué verifica                                                      | Detecta |
|---------------|------------------------------------------------------------------|---------|
| `filesystem`  | Existencia real de archivos de fase en disco (`procesado/`, etc.) | Marcadores fantasma |
| `git`         | Si la rama `agent/<issue>-*` está contenida en **`origin/main`**  | Entregables no mergeados |
| `github-api`  | Estado real del issue y de sus PRs (open/closed/merged) vía `gh`  | PRs reportados como merged que siguen abiertos |
| `heartbeat`   | Si el PID del heartbeat `agent-<issue>.heartbeat` existe de verdad | Heartbeats zombi |

El módulo nuevo es `.pipeline/lib/sherlock-independent-verifier.js`. Su API:

```js
const { collectIndependentEvidence, formatIndependentEvidence } =
    require('./sherlock-independent-verifier');

const evidence = await collectIndependentEvidence({
    issueNumber,     // entero — CA-SEC-10: se normaliza, nunca shell-out con input crudo
    pipelineDir,     // dir .pipeline
    // inyectables (defaults usan child_process real):
    fsImpl, gitImpl, ghApi, processCheck, repoRoot,
});
// → { ok, issueNumber, findings:[{source,kind,summary,detail}], sources:[], sourcesChecked:[], durationMs, error }

const text = formatIndependentEvidence(evidence); // → string para el prompt fiscal
```

## Cómo la usa Sherlock

En `verify()`, **solo si el caller pasó `issueNumber`**:

1. Llama `collectIndependentEvidence(...)` antes de resolver el provider.
2. Renderiza los findings con `formatIndependentEvidence(...)`.
3. **Sanitiza** el texto con `sanitizeUserPrompt` (CA-SEC-1) — los outputs de
   git/gh son input no confiable.
4. Lo inyecta en `buildFiscalPrompt(...)` como sección **`<independent_evidence>`**
   (delimitada con XML igual que `<system_state>`, preserva CA-SEC-2).
5. Emite el evento de auditoría `sherlock_independent_evidence_collected`.

El prompt fiscal reforzado le instruye al modelo:

- `<system_state>` es un snapshot pre-análisis que **puede heredar las mismas
  asunciones** que el análisis intenta defender. No es verdad absoluta.
- `<independent_evidence>` **pesa más** que el `system_state` cuando se
  contradicen.
- Procedimiento obligatorio: identificar qué **asume** el análisis del
  `system_state`, y **contravenir** cada asunción contra la evidencia real.

Ejemplo de detección esperada (caso #3722):

```
claim:         "el helper escape-html.js está listo para merge"
contradiction: "evidencia real: la rama agent/3722-* NO está en origin/main y
                no hay PR mergeado"
```

## Threat model

- **Git local stale**: el `main` local puede estar desactualizado y reportar
  falsos negativos ("el archivo no está en main") por staleness, no por
  entregable fantasma real (verificado empíricamente por guru en el #3846). Por
  eso el collector consulta **`origin/main`** (vía `--all` + `--contains`
  `*origin/main*`), **no** `main` local.
- **Git corrupto / inaccesible**: GitHub API (`gh`) es fallback. Si ambos
  fallan, el source simplemente no aporta findings (fail-open).
- **Input no confiable**: los outputs de git/gh nunca se interpolan en comandos
  (CA-SEC-10) — los argumentos derivan solo del `issueNumber` normalizado a
  entero. El texto recolectado se sanitiza con `sanitizeUserPrompt` antes de
  tocar el prompt del provider (CA-SEC-1).
- **DoS de payload**: cada finding se capea a `MAX_FINDING_DETAIL_CHARS` (600) y
  se limita a `MAX_FINDINGS` (24) findings totales (CA-SEC-10).

## Invariantes (back-compat)

- **`systemState` sigue siendo input** de `verify()`. La evidencia independiente
  **no lo reemplaza**, lo complementa.
- **Fail-open**: si `collectIndependentEvidence()` falla (sin acceso a FS/git/
  GitHub API, o lanza), Sherlock sigue funcionando **igual que antes** — sin la
  sección `<independent_evidence>`. **Nunca bloquea.**
- **Schema de salida sin cambios**: el output de Sherlock (`verdict`, `reason`,
  `inconsistencies`) es idéntico. La evidencia entra solo como **input** al
  prompt; Sherlock la contrasta en su `verdict`.
- **Sin `issueNumber` → comportamiento pre-#3846 puro**: el collector ni se
  invoca.

## Performance

Presupuesto total `<500ms` (default `DEFAULT_TOTAL_BUDGET_MS=500`), con
presupuesto por source `~200ms` (`DEFAULT_PER_SOURCE_BUDGET_MS=200`):

- `git ls-tree`/`branch --contains` es O(1) con repo local.
- GitHub API: 1-2 calls con timeout acotado.
- Filesystem: ~24 carpetas de fase máximo.
- Si un source agota el presupuesto total, los siguientes se **abandonan**
  (fail-open, no fail-closed).

## Auditoría

Eventos en el audit log canónico (`logs/commander-dispatch-YYYY-MM-DD.jsonl`):

| Evento | Cuándo |
|--------|--------|
| `sherlock_independent_evidence_collected` | El collector corrió OK |
| `sherlock_independent_evidence_failed`    | El collector falló o lanzó (fail-open) |

Payload (sin datos crudos — CA-SEC-8, solo hashes):

- `sources_checked: ['filesystem', 'git', 'github-api', 'heartbeat']`
- `findings_count: N`
- `latency_ms: T`
- `prompt_hash` (hash del análisis, nunca el texto)

## Archivos

- Módulo: `.pipeline/lib/sherlock-independent-verifier.js`
- Integración: `.pipeline/lib/sherlock-verifier.js` (`buildFiscalPrompt`, `verify`)
- Audit: `.pipeline/lib/commander/multi-provider.js` (`auditCommanderRequest` —
  campos `sources_checked` / `findings_count`)
- Tests: `.pipeline/lib/__tests__/sherlock-independent-verifier.test.js`
