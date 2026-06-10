# Canonical Facts — árbitro determinístico de Sherlock (#3895)

> Núcleo/cimiento del épico [#3894](https://github.com/intrale/platform/issues/3894)
> (validación determinística de Commander y Sherlock contra hechos canónicos).
> Hija 1/3. Las hijas 2 (audit JSONL) y 3 (métricas) dependen de este módulo.

## Por qué existe

Sherlock (`sherlock-verifier.js`) es el verificador adversarial del Commander.
Antes de este módulo podía **contradecir de forma especulativa**: si no lograba
probar lo contrario, igual marcaba una inconsistencia. Eso genera rebotes falsos
y ruido en el pipeline.

`canonical-facts.js` invierte la lógica: para cada **claim** (afirmación que el
Commander emite sobre el estado del sistema) existe **una fuente canónica** —
un comando determinístico contra git / gh / heartbeat / filesystem. Sherlock
**ejecuta** esa fuente y:

| Resultado del canónico | status            | Acción de Sherlock                                  |
|------------------------|-------------------|-----------------------------------------------------|
| Coincide con el claim  | `consistent`      | NO contradice.                                      |
| Discrepa del claim     | `inconsistent`    | Contradice citando el árbitro determinístico (CA-3).|
| No se pudo ejecutar    | `not_verifiable`  | No concluyente. **NUNCA** contradice (CA-2/SEC-5).  |

El canónico es el **árbitro determinístico**: cuando Commander y Sherlock
discrepan, manda el resultado del canónico, no la opinión del LLM.

## Matriz claim → fuente → comando

Todos los claims son **aserciones positivas** (el claim afirma `expected = true`
por defecto). `argsBuilder` valida cada param **adentro** (SEC-1) y **lanza** si
no pasa la allowlist; siempre retorna `string[]` para `execFile` (sin shell).

| claim                  | source       | comando (args de `execFile`)                                          | params         | parse → value                                  |
|------------------------|--------------|-----------------------------------------------------------------------|----------------|------------------------------------------------|
| `entregable_en_main`   | `git`        | `git branch --all --merged origin/main --list *agent/<issue>-*`       | `issue`        | ¿hay ramas? (rama del agente mergeada a main)  |
| `issue_cerrado`        | `github-api` | `gh issue view <issue> --json state,closed`                           | `issue`        | `closed === true \|\| state === 'CLOSED'`      |
| `pr_mergeado`          | `github-api` | `gh pr view <pr> --json state,mergedAt`                               | `pr`           | `!!mergedAt`                                    |
| `proceso_vivo`         | `heartbeat`  | `process.kill(pid, 0)` (sin shell-out)                                | `pid`          | ¿el PID existe en la máquina?                  |
| `rama_contiene_commits`| `git`        | `git branch --all --list *agent/<issue>-*`                            | `issue`        | ¿existe la rama agent/<issue>-*?               |
| `workflow_paso`        | `github-api` | `gh run view <runId> --json conclusion,status,headSha`               | `runId`, `sha?`| `status === 'completed' && conclusion === 'success'` |

> `origin/main` (NO `main` local): el main local puede estar stale y reportar
> falsos negativos (ver nota técnica de #3846).

## API

```js
const { CANONICAL_FACTS, resolveClaim } = require('./.pipeline/lib/canonical-facts');

// Diccionario crudo: { [claimKey]: { source, argsBuilder, parse } }
CANONICAL_FACTS.pr_mergeado.argsBuilder({ pr: 1732 });
// → ['pr', 'view', '1732', '--json', 'state,mergedAt']

// Resolución end-to-end (ejecuta la fuente y compara contra el claim):
const r = await resolveClaim('pr_mergeado', { pr: 1732, expected: true }, {
  gitImpl, ghApi, processCheck, fsImpl,   // inyectables (default: impls del verificador independiente)
  cwd: repoRoot, timeoutMs: 200,
});
// r === { value: true, status: 'consistent', source: 'github-api' }
```

`resolveClaim(claimKey, params, impls)` → `{ value, status, source }` con
`status ∈ {'consistent','inconsistent','not_verifiable'}`. `params.expected`
permite invertir la aserción (default `true`).

## Consumo desde el pipeline

- **`sherlock-independent-verifier.js`** (`collectIndependentEvidence`): consume
  el diccionario como tabla de resolución para los 3 claims nuevos
  (`rama_contiene_commits` siempre; `pr_mergeado` sobre PRs descubiertos o
  `opts.prNumber`; `workflow_paso` si `opts.runId`). Respeta el budget por-source
  (`sourceBudget()` / `budgetLeft()`). Los `not_verifiable` **no** generan finding
  (ni evidencia ni contradicción).
- **`sherlock-verifier.js`** (`verify` + `buildFiscalPrompt`): resuelve los claims
  derivables del issue (`entregable_en_main`, `rama_contiene_commits`,
  `issue_cerrado`), inyecta la sección `<canonical_facts>` en el prompt fiscal con
  la instrucción de inversión, y expone el resultado en el shape de retorno:
  - `canonicalFacts: [{ issue, claim, status, value, source }]`
  - `notVerifiable: [{ issue, claim }]` (campo **separado** — no rompe el schema
    `validateFiscalResponse`, que conserva `allowedKeys=['verdict','reason','inconsistencies']`
    y el cap `MAX_INCONSISTENCIES=5`).

## Invariantes

### SEC-1 — anti-inyección (A03:2021)
- Cada `argsBuilder` valida **adentro** con allowlist y **lanza** si falla:
  - `issue` / `pr` / `runId` / `pid` → entero estricto vía `normalizeIssueNumber()`
    (rechaza `"5;rm"`, backticks, `$(...)`, saltos de línea).
  - `sha` → `^[0-9a-f]{7,40}$`.
  - branch → patrón `agent/<issue>-*` **derivado del issue**, NUNCA crudo del claim.
- Retorno **siempre `string[]`** para `execFile` (sin shell).
- **Prohibido** `execSync`, concatenación de strings, y `--jq <expr>` derivado del
  claim (un `--jq` malicioso es ejecución de código en `gh`).

### SEC-5 — fail-open observable (A04 Insecure Design)
- `parse()` envuelve el parseo en `try/catch` y mapea cualquier excepción a
  `{ status: 'not_verifiable' }` — un stdout malformado/truncado **nunca** lanza
  (evita DoS por crash).
- `resolveClaim()` es fail-open total: build/exec/parse que falle → `not_verifiable`,
  **nunca** una excepción propagada y **nunca** una contradicción especulativa.
- Timeout duro por `execFile` respetando el budget (`<500ms` total / `~200ms` por source).

### Tri-estado `not_verifiable`
Un canónico no ejecutable (permiso/herramienta/parse/timeout) es **no concluyente**,
no una contradicción. Se expone en un campo separado para preservar el contrato
del LLM y la observabilidad (el logueo completo se entrega en la hija 2).

## Tests

- `.pipeline/lib/__tests__/canonical-facts.test.js` — los 6 claims → `argsBuilder`
  retorna `string[]` válido; params maliciosos (`;rm`, backticks, `$(...)`, sha
  no-hex, branch cruda) → el builder **lanza, no ejecuta nada**; `parse()` con
  stdout malformado → `not_verifiable` sin throw; tri-estado de `resolveClaim`.
  Cobertura ≥80% (≈94% líneas).
- `.pipeline/lib/__tests__/sherlock-verifier.test.js` (extendida) — coincide → NO
  contradice; discrepa → inconsistente; no ejecutable → `not_verifiable`.

Ejecutar:

```bash
node --test .pipeline/lib/__tests__/canonical-facts.test.js
node --test .pipeline/lib/__tests__/sherlock-verifier.test.js
node --test .pipeline/lib/__tests__/sherlock-independent-verifier.test.js
```
