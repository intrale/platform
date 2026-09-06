## Reporte de auditoría de seguridad — issue #6746

**Veredicto:** sin hallazgos

**Alcance auditado:** rama `agent/6746-pipeline-dev` @ `e1d229e85`, diff `origin/main...HEAD` (6 archivos, 1148+/24-):
`.pipeline/lib/infra-noprogress.js` (nuevo, 275) · `.pipeline/lib/__tests__/infra-noprogress.test.js` (nuevo, 683) ·
`.pipeline/pulpo.js` (+197/-24) · `.pipeline/config.yaml` (+6) · `.pipeline/lib/config-schema.js` (+4) ·
`.pipeline/lib/__tests__/fixtures/config-snapshot-pre-particion.json` (golden regenerado).

### Hallazgos

**Sin hallazgos.** Ninguna vulnerabilidad explotable en el diff. Detalle de lo verificado empíricamente:

| # | Vector | Resultado |
|---|---|---|
| 1 | **A01 Broken Access Control — SEC-5/CA-2, estado propiedad del Pulpo** | ✅ `shouldEscalate()` decide sólo con el JSONL, `config` y `fase`. Cero lecturas de work-file. El contador NO deriva de `rebote_tipo`/`rebote_numero_infra`/`diff_hash_previo` (`infra-noprogress.js:207-241`). |
| 2 | **A01 — SEC-C.1, writer no invocable por un agente** | ✅ `grep -E "exec\|spawn\|eval\|writeFileSync\|appendFileSync\|unlinkSync\|child_process\|http\|fetch" infra-noprogress.js` ⇒ **0 matches**. Sin shebang, sin `require.main === module`. El único `appendFileSync` vive en `pulpo.js:645` (proceso del Pulpo). |
| 3 | **A03 Injection — comando (RIESGO-3)** | ✅ El módulo no ejecuta procesos. Se reusa `convergence.computeDiffHash`, que valida `/^\d+$/` **antes** de interpolar y usa comando git fijo (`convergence-detector.js:57-59, 82`). CA-4 cumplido: no se rodó un hash nuevo. |
| 4 | **A03 — forja de registros en el JSONL (SEC-C.2 / RIESGO-7)** | ✅ `buildRecord` arma un objeto whitelisteado y lo pasa por `JSON.stringify` (nunca concatena) + `normalizeFase` hace strip de todo lo que no sea `[a-zA-Z_-]`. Un `\n` en `fase` no puede forjar un renglón (T9c verde). |
| 5 | **A03 — path traversal en el `unlinkSync` NUEVO de `pulpo.js:5279`** | ✅ No explotable. `issue` sale de `issueFromFile`, que es un componente de nombre de archivo: no puede contener `/` ni `\`, y todo nombre que empiece con `.` lo descarta `listWorkFiles` (`pulpo.js:1935`). El sufijo (`.noprogreso-notified`) es literal. |
| 6 | **A08 Deserialización insegura / prototype pollution** | ✅ `JSON.parse` por línea + guarda `!rec \|\| typeof rec !== 'object' \|\| Array.isArray(rec)` y chequeo estricto de tipo por campo (`Number.isInteger`, `typeof === 'string'`, `HASH_RE`). Línea corrupta ⇒ `continue`, no ciega ni dispara el breaker (T10 verde). |
| 7 | **A02 Exposición de datos sensibles — secretos en el diff** | ✅ Ninguno. El único match del scanner es el fixture `[REDACTED]` del test T9b, que asserta justamente que SEC-F **descarta** el texto libre. El JSONL no tiene campo `motivo`. |
| 8 | **A02 — fuga por el comentario público de GitHub** | ✅ La rama `noprogreso` reusa `bloqueCausaRaiz`, que aplica `sanitizePipelineText` al motivo igual que la rama preexistente (`pulpo.js:5200-5211`). El Telegram de la rama nueva ni siquiera incluye el motivo. `hashCorto` son 12 hex de un sha256 de diff: sin valor para un atacante. |
| 9 | **A02 — el JSONL nuevo no llega al repo** | ✅ `git check-ignore -v .pipeline/audit/infra-noprogress.jsonl` ⇒ `.gitignore:376:.pipeline/audit/`. |
| 10 | **A04 Diseño inseguro — bypass del breaker vía work-file** | ✅ `escaladoPorNoProgreso` AND-ea con `reboteInfraCount < MAX_REBOTES_INFRA`, y `reboteInfraCount` sí sale del work-file. Verificado que **no abre ventana**: el rango complementario (`>= 20`) lo cubre el cap duro de `pulpo.js:5316`, que escala igual. Fijar `rebote_numero_infra: 20` no apaga el breaker: dispara el otro. |
| 11 | **A04 — regresión del auto-promotor de convergencia (#4160), el riesgo más caro de CA-5** | ✅ CA-5 saca el gate `if (!esReboteDeInfra)` y ahora los YAML de rebote infra llevan `diff_hash_previo`. Verificado en `rebote-counter.js:70-76` que la rama `tipoPrevio === 'infra'` hace `continue` **antes** de leer `diff_hash_previo`, así que `diffHashPrevio` que consume `decideAutoPromote` no cambia. T12c lo blinda con fakes. `auto_promote_on_convergence: true` está activo en prod, así que esta no-regresión importaba. |
| 12 | **A06 Dependencias con CVEs** | ✅ N/A — `package.json`/lockfile sin cambios; el módulo sólo usa `node:fs`, `node:path` y un lib interno. |
| 13 | **A05 Misconfiguration (RIESGO-1)** | ✅ `config.yaml` y `config-schema.js` en el **mismo commit**. `resolver.resolve() + validateConfig()` sobre la config real ⇒ `valid=true, errores=0, noprogreso_max=2`. `additionalProperties:false` sigue estricto (T13b). |
| 14 | **Fail-open deliberado (SEC-A/SEC-E)** | ✅ Las 3 compuertas (`phaseRunsInIssueWorktree`, `HASH_RE`+`known`, `degraded`) caen hacia **no escalar**. Correcto para este control: es de costo/disponibilidad, y un falso positivo parkea un issue sano. No copió el `return Infinity` de `auto-recheck-counter` (RIESGO-4). |

**Evidencia de tests** (ejecutados en esta pasada, no citados de la fase dev):
- `node --test .pipeline/lib/__tests__/infra-noprogress.test.js` ⇒ **32 pass / 0 fail**.
- Suites adyacentes de no-regresión (`credential-path-guards`, `config-partition-parity`, `config-partition-rollback`, `rebote-counter*`, `convergence*`) ⇒ **66 pass / 0 fail**.
- Tests aislados en `mkdtempSync` — `.pipeline/audit/` real quedó sin `infra-noprogress.jsonl` y `git status` limpio.

### Observaciones de hardening (NO bloquean — ruido, sin defecto explotable)

- **O-1 · `infra-noprogress.jsonl` no usa `lib/jsonl-rotation.js`.** Crece sin límite; al superar `MAX_LINES = 20000` el breaker queda fail-open de forma permanente (sólo lo delata el log de CA-UX-6). Además `countSameHash` hace `readFileSync` del archivo **entero antes** del chequeo de `MAX_LINES`, así que el cap no acota memoria. **Ya cubierto por #6075** ("Rotar los .jsonl append-only del pipeline por el mecanismo unico jsonl-rotation") — no se crea issue duplicado; corresponde sumar este archivo a su alcance.
- **O-2 · CA-5 amplía levemente la superficie de #6741.** Antes, un work-file de rebote infra **físicamente no tenía** `diff_hash_previo`; ahora lo lleva. Bajo el hueco que #6741 va a cerrar (el agente controla el contenido del work-file y `moveFile` es un `renameSync` puro), un agente que borrara `rebote_tipo` pero conservara `diff_hash_previo` podría aportar un hash al auto-promotor de convergencia — cosa que antes no podía. **No es explotable con el código actual** (el Pulpo siempre escribe `rebote_tipo` en `yamlOut`, `pulpo.js:5817`) y #6741 es el dueño del fix. Se deja constancia para su alcance.
- **O-3 · RIESGO-2 residual, acotado.** Un rebote infra ahora paga **2 invocaciones extra de `git` por barrido** (la del gate en `pulpo.js:5130` y la de CA-5 en `:5842`, que antes estaba gateada por `if (!esReboteDeInfra)`). No es un DoS: `computeDiffHash` usa `execSync` con `timeout` explícito (5 s para `worktree list`, 10 s para `git diff`) y `windowsHide`, así que el peor caso está acotado y no puede colgar el tick indefinidamente. Sólo se paga cuando `esReboteDeInfra === true` (CA-PO-5): un issue sano no paga nada.
- **O-4 · La justificación de no-regresión de CA-5 es correcta pero INCOMPLETA (hallazgo propio de esta auditoría).** El dev fundamentó la no-regresión sólo en `rebote-counter.js:70-76` (`continue` sobre `rebote_tipo === 'infra'` antes de leer `diff_hash_previo`). Verifiqué que existe una segunda ruta, **en código del propio Pulpo y sin manipulación del agente**: `reencolarInfraBloqueados` (`pulpo.js:1383-1387`) hace `delete cleaned.rebote_tipo` sobre los work-files infra de `pendiente/` cuando se recupera la conectividad, pero **no borra `diff_hash_previo`** — que antes de este cambio no existía en esos archivos y ahora sí. Tras el strip, `contarRebotes` clasifica ese archivo como `'codigo'` y puede tomar su hash como `diffHashPrevio` para el auto-promotor de convergencia (`auto_promote_on_convergence: true` en prod).

  **Por qué NO bloquea** (verificado, no asumido): el impacto práctico es nulo o benigno. (a) `decideAutoPromote` exige además `hasNewObservation === false`, o sea que la observación actual ya figure en `prevMotivos` — un motivo de infra no matchea un rechazo de producto, así que no se fabrica una promoción falsa. (b) El archivo infra lleva `rebote_numero` **sin incrementar** (`pulpo.js:5770`), y `contarRebotes` usa `>` estricto, así que sólo puede ganarle a un archivo de código del mismo número. (c) Los rebotes de infra no tocan el código, de modo que el hash que dona es el mismo que donaría el archivo de código. No hay escenario en que promueva algo que antes no promovía.

  **Hardening propuesto:** que `reencolarInfraBloqueados` borre `diff_hash_previo` junto con `rebote_tipo`, para que un archivo infra desmarcado no pueda donar hash al carril de convergencia. Se registró como **#6776** (recomendación independiente pendiente de triaje humano).
