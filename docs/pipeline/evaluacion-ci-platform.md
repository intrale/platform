# Evaluación completa del CI de `platform` — qué se conserva y qué se pierde (#7658)

> Primera historia de la **Ola Poda del CI**. Spike de análisis: **no cambia ningún workflow**. La ejecución va en #7659 (Security SAST), #7660 (resto de la poda) y #7661 (medición continua). La privatización es #7662.
>
> Datos agregados: [`evidence/7658/actions-usage-summary.json`](evidence/7658/actions-usage-summary.json) (corrida `--by-job`) · reglas de ahorro: [`evidence/7658/pricing.json`](evidence/7658/pricing.json) · antecedente: [`costo-privatizar-repos-7594.md`](costo-privatizar-repos-7594.md).

**Ventana medida:** 30 días, del **27/08/2026 al 25/09/2026** (UTC), corrida del 26/09/2026 con `node scripts/measure-actions-billing.js --repos platform --days 30 --by-job`. **Alcance real:** **16 workflows y 38 jobs** en `.github/workflows/` al 26/09/2026 (el issue original listaba 13; la Ola Licenciamiento sumó `authorship-main-audit`, `contribution-agreement` y `license-header-lint`).

Rótulos que se usan en todo el documento:

- Una cifra sin rótulo sale **medida** de runs reales de la ventana.
- **(proyectado)** va al lado de toda cifra que no sale de runs reales, con su fórmula en la nota de la fila.
- **[protege main]**: la fila cambia lo que agrega `pr-status`, el único check requerido por los rulesets. **[seguridad]**: la fila toca un control de seguridad o de integridad del pipeline. **[fija]**: la fila no se vota.
- Los minutos son **facturables por mes** (ceil por job × multiplicador del runner: Linux 1, Windows 2, macOS 10), sin decimales.

---

## 1. Resumen

| | Minutos facturables por mes |
|---|---:|
| CI actual medido (13 workflows con historia en la ventana) | **15.167** |
| + workflows nuevos sin 30 días de historia (proyectado) | **651** (proyectado) |
| **CI actual con los 16 workflows** | **15.818** (proyectado) |
| Ahorro si se aprueban las 8 propuestas votables | **12.447** (incluye 936 proyectado) |
| **CI reducido** | **3.371** (proyectado) |

- La reducción es del **79 %**. Security SAST explica **12.154 min (80 %)** del total medido y **OWASP Dependency Check**, él solo, **10.334 min (68 %)**.
- **Ninguna propuesta cambia lo que agrega `pr-status`**: todos los jobs de `pr-checks.yml` se conservan. Lo que protege `main` hoy sigue igual.
- #7594 midió 18.008 min en la ventana 24/08–22/09. La diferencia con esta medición sale casi toda de Security SAST (14.703 → 12.154 min con la misma cantidad de runs, 333 contra 329), porque en esta ventana bajaron los tiempos de OWASP.
- Referencia para #7662: el plan Free incluye 2.000 min por mes y Team 3.000. El CI reducido (3.371, proyectado) queda **cerca de la cuota de Team**, no adentro.

---

## 2. Tabla de decisión

Una fila por cambio, ordenadas de mayor a menor ahorro. Se usan siempre los mismos cinco verbos: *Conservar en PR · Mover a schedule · Mover a demanda · Consolidar · Eliminar*.

| # | Cambio propuesto | Ahorro (min/mes) | Qué se pierde | ¿Afecta a `pr-status`/`main`? | ¿Control de seguridad? | Decisión del operador |
|---|---|---:|---|---|---|---|
| 1 | **Mover a schedule** *OWASP Dependency Check*: corrida diaria sobre `main` y, además, por PR **sólo** si el PR toca dependencias (opción **b**, ver §4) | **9.545** (69 proyectado) | Una vulnerabilidad nueva publicada contra una dependencia que ya está en `main` se ve al día siguiente, no en el PR. Los PR que no tocan dependencias dejan de mostrar el reporte OWASP. | No | **[seguridad]** | |
| 2 | **Conservar en PR** el *Admission Gate*, pero **salteando** los issues que ya nacen con `needs-definition` o `Ready` (filtro `if:`; un job salteado no consume minutos) | **867** (proyectado) | Nada de detección: en 30 días el gate etiquetó **0 de 867 issues**, porque todos nacieron con label. Los issues sin label se siguen etiquetando igual. | No | **[seguridad]** | |
| 3 | **Mover a schedule** *Semgrep*: corrida diaria sobre `main` | **645** | El PR deja de avisar un hallazgo nuevo de Semgrep. El aviso llega al día siguiente, en el reporte diario y en la pestaña Security. | No | **[seguridad]** | |
| 4 | **Mover a schedule** *detect-secrets*: corrida diaria sobre `main` | **476** | El inventario amplio de "posibles secretos" (unos 3.800 candidatos que nadie revisa) deja de correr en cada PR. El control que frena un secreto en el PR (*Secret scan*, fila 9) se conserva. | No | **[seguridad]** | |
| 5 | **Consolidar** los 4 lints de `.pipeline` (`ghost-artifact`, `operational-state`, `test-env`, `write-target`) en un solo workflow `pull_request` con un solo job | **440** | En el PR se ve un check en lugar de cuatro. Para saber qué lint falló hay que abrir el log (cada lint va en un paso propio y todos corren aunque falle uno). | No | **[seguridad]** (`write-target-lint`) | |
| 6 | **Eliminar** *Runtime state guard* | **205** | Duplica al *Secret scan*: corre el mismo escáner sobre el mismo diff, pero con la copia del PR (que el autor puede editar). Se pierde la cobertura de los PR contra ramas que no son `main` ni `develop`. | No | **[seguridad]** · requiere revisión de security | |
| 7 | **Eliminar** *Publicar reporte SAST en PR* | **205** | El comentario automático del PR con el resumen de OWASP, Semgrep y detect-secrets. El resumen pasa al informe de la corrida diaria. Depende de que se aprueben las filas 1, 3 y 4. | No | No | |
| 8 | **Mover a demanda** la *Distribución Desktop* (MSI + Deb) | **64** | El instalador de escritorio deja de publicarse solo en cada merge que toca `app/`. Hay que dispararlo a mano antes de un release. Es el único uso de Windows (×2). | No | No | |
| 9 | **Conservar en PR** *Secret scan (blocking)* — piso de seguridad (cuesta 284 min/mes) | 0 | — | No | **[seguridad] [fija]** | *no se vota* |
| 10 | **Conservar en PR** *Contribution Agreement* mientras `platform` sea público. Se elimina **sólo** junto con la decisión de privatizar (#7662); cuesta 205 min/mes (proyectado) | 0 | — | No | **[seguridad] [fija]** | *no se vota* |
| | **Total si se aprueban las filas 1 a 8** | **12.447** | | | | |

**Cómo aprobar.** Comentá en #7658 con este formato: `Apruebo: 1, 2, 4 · Rechazo: 3 (conservar)`.

- **Sólo cuenta el comentario de `leitolarreta`** (o de un aprobador que él designe por escrito en el issue). El comentario de un agente o de un tercero no aprueba nada, y el issue sigue con `needs-human`.
- Si se rechaza una fila, esa fila pasa a **Conservar** y el total se recalcula antes de cerrar: **CI reducido = 15.818 − Σ ahorro de las filas aprobadas**. Por ejemplo, rechazar la fila 3 deja el CI reducido en 3.371 + 645 = 4.016 (proyectado).
- La fila 7 sólo tiene sentido si se aprueban la 1, la 3 y la 4. Si alguna se rechaza, la 7 se reduce en proporción o pasa a Conservar.

---

## 3. Inventario por workflow y por job

Columnas: **Job** (key del YAML · nombre en la API, que es el `name:` si existe) · **Disparador y filtros** · **Runner** · **Runs** (ejecuciones del job en 30 días; entre paréntesis, las veces que quedó *skipped*) · **Crudos / Fact.** (minutos crudos y facturables) · **p50/p95** (facturables por ejecución) · **Ruleset** (¿requerido por los rulesets de `main`?) · **pr-status** (¿lo agrega?) · **Seg.** (¿control de seguridad o integridad?) · **Qué protege** · **Detección** (fallas en 30 días y hallazgos agregados) · **Qué se pierde si sale del PR**.

Rulesets activos de `platform` (26/09): `main-required-checks` (único check requerido: **`pr-status`**), `protect-main` y `protect-stable` (borrado, fast-forward, PR obligatorio, historia lineal y revisión de Copilot, sin checks). Por eso la columna **Ruleset** dice "sí" sólo en `pr-status`.

### 3.1 `pr-checks.yml` — *PR Checks* (769 min)

Disparadores: `pull_request` a `main`/`develop` (205 runs) · `schedule` diario 06:00 UTC (30 runs) · `workflow_dispatch` (1). `permissions: contents: read, pull-requests: read`. Los filtros por módulo los resuelve `detect-changes` (`dorny/paths-filter`): `backend/**`, `app/**`, `users/**`, `tools/**`, `shared` (`build.gradle.kts`, `settings.gradle.kts`, `gradle/**`, `buildSrc/**`, `gradle.properties`) y `deps` (`**/*.gradle.kts`, `gradle/libs.versions.toml`, `**/package*.json`, `config/licenses/**`, `NOTICE`, `docs/legal/**`, `scripts/licenses/**`).

| Job | Disparador y filtros | Runner | Runs | Crudos / Fact. | p50/p95 | Ruleset | pr-status | Seg. | Qué protege | Detección | Qué se pierde si sale del PR |
|---|---|---|---:|---:|---|---|---|---|---|---|---|
| `detect-changes` | sólo `pull_request` | Linux | 205 (31) | 48 / 205 | 1/1 | no | sí (needs) | no | Decide qué módulos compilar y testear | 0 fallas (es un clasificador) | Sin él, todos los checks corren siempre (más caro) o ninguno |
| `verify-strings` | `app` o `shared` | Linux | 5 (231) | 4 / 6 | 1/2 | no | **sí** | no | Strings legacy prohibidos (`verifyNoLegacyStrings`) | 0 fallas | El merge de un string prohibido en `app/` |
| `check-backend` | `backend` o `shared` | Linux | 5 (231) | 8 / 11 | 2/3 | no | **sí** | no | Compilación, tests y cobertura Kover de `backend` | 0 fallas | La única compilación y los únicos tests de `backend` antes del merge |
| `check-users` | `users`, `backend` o `shared` | Linux | 5 (231) | 14 / 17 | 3/4 | no | **sí** | no | Compilación, tests y Kover de `users` (lo que va a Lambda) | 0 fallas | Tests de `users` antes del deploy a Lambda |
| `check-app` | `app` o `shared` | Linux | 5 (231) | 75 / 77 | 15/17 | no | **sí** | no | Compilación, tests y Kover de `app/composeApp` | 0 fallas | Tests de la app multiplataforma antes del merge |
| `check-tools` | `tools` o `shared` | Linux | 5 (231) | 6 / 8 | 2/2 | no | **sí** | no | El procesador KSP de strings prohibidos | 0 fallas | El guardián de strings en compilación |
| `check-licenses` | `deps`, `schedule`, `workflow_dispatch` | Linux | 11 (7) | 25 / 31 | 2/6 | no | **sí** | no | Licencias de dependencias de terceros y drift del `NOTICE` (#7592) | **4 fallas** | Que entre una dependencia con licencia no permitida |
| `e2e-qa` | `backend`, `users`, `shared`, `schedule`, `workflow_dispatch` | Linux | 36 (200) | 154 / 172 | 5/5 | no | **sí** | no | E2E de API contra DynamoDB local + Cognito (moto) | **2 fallas** | La única prueba E2E automática del backend |
| `authorship-trailer` · *Autoría del PR (trailer)* | `pull_request` desde `agent/*` | Linux | 6 (2) | 1 / 6 | 1/1 | no | **sí** | **sí** (autoría) | Trailer de autoría del squash de agentes (#7632) | 0 fallas | Trazabilidad de autoría de los PR de agentes |
| `pr-status` | siempre (`if: always()`) | Linux | 236 | 12 / 236 | 1/1 | **sí (único)** | es el rollup | no | Rollup de los 8 jobs de arriba: es lo que frena el merge a `main` | **6 fallas** (reflejan las 4 de `check-licenses` y las 2 de `e2e-qa`) | Todo el gate de merge |

Propuesta: **Conservar en PR todo el workflow.** Los `check-*` y `verify-strings` no fallaron en 30 días (escenario "job sin evidencia de valor"), pero juntos cuestan 119 min por mes, sólo corren cuando cambia su módulo y son lo único que compila y testea el producto antes del merge. Sacarlos cambia lo que protege `main` **[protege main]** por un ahorro chico. Se descartó `concurrency: cancel-in-progress`: ahorra 8 min medidos (regla `pr-checks-concurrency` de #7594).

### 3.2 `security-sast.yml` — *Security SAST* (12.154 min)

Disparadores: `pull_request` a `main`/`develop` (205 runs) · `push` a `main` (124). **Sin filtro de `paths`.** `permissions: contents: read, pull-requests: write, security-events: write`. Los jobs `dependency-check`, `semgrep` y `detect-secrets` corren con `continue-on-error: true` (modo warning): **un run verde no significa cero hallazgos**, así que la detección se contó desde los artefactos y no desde el color del run (ver §3.2.1).

| Job | Disparador y filtros | Runner | Runs | Crudos / Fact. | p50/p95 | Ruleset | pr-status | Seg. | Qué protege | Detección | Qué se pierde si sale del PR |
|---|---|---|---:|---:|---|---|---|---|---|---|---|
| `dependency-check` · *OWASP Dependency Check* | sólo `pull_request` | Linux | 205 (124) | 10.231 / **10.334** | 24/247 | no | no | **sí** | Dependencias con vulnerabilidades conocidas (NVD) | 0 fallas (warning). Artefactos: el mismo inventario en **todas** las corridas (175 dependencias vulnerables); **41 de 113 corridas sin reporte** | El aviso en el PR de una dependencia vulnerable nueva. Ver opciones en §4 |
| `semgrep` · *Semgrep Static Analysis* | sólo `pull_request` | Linux | 205 (124) | 639 / 765 | 4/4 | no | no | **sí** | Patrones de código inseguro (SAST) y alimenta la pestaña Security | 0 fallas (warning). Artefactos: 123 a 127 avisos por corrida, todos nivel *warning* | El aviso en el PR de un hallazgo nuevo; la pestaña Security se actualiza por día y no por PR |
| `detect-secrets` · *detect-secrets Scan* | sólo `pull_request` | Linux | 205 (124) | 460 / 566 | 3/3 | no | no | **sí** | Inventario heurístico de posibles secretos en todo el árbol | 0 fallas (warning). Artefactos: 3.798 a 3.837 candidatos por corrida, sin revisar | El inventario por PR. Frenar un secreto sigue a cargo de `secret-scan` |
| `secret-scan` · *Secret scan (blocking)* | `pull_request` + `push` | Linux | 283 | 164 / 284 | 1/1 | no | no | **sí** | Bloquea secretos en el diff, con el escáner **de la base** (confiable) | **3 fallas** (bloqueantes) | **[fija]** Un secreto en un PR público queda expuesto en el push; un escaneo diario llega tarde |
| `sast-report` · *Publicar reporte SAST en PR* | sólo `pull_request` | Linux | 205 (124) | 25 / 205 | 1/1 | no | no | no | Comenta en el PR el resumen de los 3 escaneos | 0 fallas | El comentario con el resumen en el PR |

#### 3.2.1 Evidencia de detección de Security SAST (agregada)

Fuente: todos los artefactos vigentes del 12/09 al 26/09/2026 (la retención es de 14 días). Se bajaron a un directorio temporal fuera del repo, se contaron y no se versionaron. **Por diseño, sólo se publican agregados**: no hay CVE, paquetes, `archivo:línea` ni fragmentos.

| Escáner | Artefactos | Hallazgos por corrida | Lectura |
|---|---:|---|---|
| OWASP Dependency Check | 113 | 72 con reporte: **175 dependencias vulnerables** en todas; entre 2.820 y 3.135 vulnerabilidades. En la corrida con más hallazgos, por CVSS v3: crítica 409 · alta 1.866 · media 857 · baja 3. **41 sin reporte** (el scan falló) | Es deuda acumulada que no cambia entre PRs, así que la corrida por PR no suma información nueva. El 36 % de las corridas ni siquiera produce reporte (#6391) |
| Semgrep | 114 | 123 a 127, todos de nivel *warning* | Línea base constante: ningún PR sumó o sacó más de 4 avisos |
| detect-secrets | 114 | 3.798 a 3.837 candidatos | Inventario heurístico que nadie revisa. El control efectivo es `secret-scan` (3 bloqueos reales en 30 días) |

### 3.3 `admission-gate.yml` — *Admission Gate* (1.014 min)

Disparadores: `issues: opened` (867 runs) · `pull_request_target: opened` (145). `permissions: issues: write, pull-requests: write, contents: read`. **No hace checkout de código del PR**; usa `github-script` y `.pipeline/lib/admission-gate.js` desde la base.

| Job | Disparador y filtros | Runner | Runs | Crudos / Fact. | p50/p95 | Ruleset | pr-status | Seg. | Qué protege | Detección | Qué se pierde si sale del PR |
|---|---|---|---:|---:|---|---|---|---|---|---|---|
| `apply-admission-label` | issue o PR abierto (salvo el bot) | Linux | 1.012 | 108 / 1.014 | 1/1 | no | no | **sí** (integridad) | Que ningún issue o PR entre al pipeline sin `needs-definition`/`Ready` | 0 fallas. Etiquetó **0 de 867 issues** y **142 de 145 PRs** (se contó el comentario fijo que publica al etiquetar) | Sin él, un PR o un issue sin label quedaría fuera del pipeline hasta el barrido del reconciler |

### 3.4 `contribution-agreement.yml` — *Contribution Agreement* (0 medido · 205 proyectado)

Disparadores: `pull_request_target` (`opened`, `synchronize`, `reopened`) · `issue_comment: created`. `permissions: {}` a nivel workflow; `evaluate` pide `contents: read, pull-requests: read, issues: write, statuses: write`. Existe desde el 25/09: en la ventana sólo hay 6 runs de `issue_comment`, todos salteados (0 min).

| Job | Disparador y filtros | Runner | Runs | Crudos / Fact. | p50/p95 | Ruleset | pr-status | Seg. | Qué protege | Detección | Qué se pierde si sale del PR |
|---|---|---|---:|---:|---|---|---|---|---|---|---|
| `evaluate` | PR o comentario en un PR | Linux | 0 (6) | 0 / **205** (proyectado) | 1/1 | no | no | **sí** | Que todo aporte externo a un repo público tenga el acuerdo de contribución firmado | Sin historia suficiente | **[fija]** La cobertura legal de los aportes externos mientras el repo sea público |
| `record-signature` | sólo si `evaluate` detecta una firma | Linux | 0 (6) | 0 / 0 (proyectado) | — | no | no | **sí** | Registra la firma del acuerdo | Sin historia suficiente | El registro de la firma |

Fórmula del proyectado: p50 de los runs reales del 26/09 (`evaluate` tarda 9 s, o sea 1 min facturable) × 205 eventos de PR en 30 días (los mismos que disparan *Runtime state guard*, que usa los mismos tipos de evento). Los runs por `issue_comment` se saltean en el job y no consumen minutos.

### 3.5 `authorship-main-audit.yml` — *Auditoría de autoría en main* (7 medido · 124 proyectado)

Disparador: `push` a `main`. `permissions: contents: read`. Es informativo: nunca falla el run. Existe desde el 24/09.

| Job | Disparador y filtros | Runner | Runs | Crudos / Fact. | p50/p95 | Ruleset | pr-status | Seg. | Qué protege | Detección | Qué se pierde si sale del PR |
|---|---|---|---:|---:|---|---|---|---|---|---|---|
| `authorship-main-audit` · *Auditoría de autoría (main)* | `push` a `main` | Linux | 7 | 1 / 7 · **124** (proyectado) | 1/1 | no | no | **sí** (autoría) | Avisa si entró a `main` un squash de `agent/*` sin trailer (merge manual) | 0 avisos en 12 runs | No corre en PR |

Fórmula del proyectado: 1 min × 124 pushes a `main` en 30 días (los mismos que dispararon *Security SAST* por `push`, que no tiene filtro de `paths`).

### 3.6 `license-header-lint.yml` — *License Header Lint* (329 proyectado)

Disparadores: `pull_request` a `main`/`develop` · `push` a `main`. **Sin filtro de `paths`, a propósito** (un fuente nuevo puede entrar por cualquier directorio). `permissions: contents: read`. Es advisory: no está en `pr-status`. Existe desde el 26/09, fuera de la ventana.

| Job | Disparador y filtros | Runner | Runs | Crudos / Fact. | p50/p95 | Ruleset | pr-status | Seg. | Qué protege | Detección | Qué se pierde si sale del PR |
|---|---|---|---:|---:|---|---|---|---|---|---|---|
| `license-header-lint` · *License header lint (…)* | PR + push, sin `paths` | Linux | 0 en ventana (9 el 26/09) | 0 / **329** (proyectado) | 1/1 | no | no | no | Encabezado de copyright en los fuentes (#7591) | **4 fallas en 9 runs** del 26/09 | Un fuente sin encabezado entra sin aviso |

Fórmula del proyectado: 1 min (el run real del 26/09 tarda 24 s) × 329 eventos en 30 días (205 PR + 124 push, los mismos disparadores que *Security SAST*). Propuesta: **Conservar en PR**. No se suma a la consolidación de la fila 5 porque sus disparadores son distintos (sin `paths`).

### 3.7 Lints de `.pipeline` (1.046 min)

Todos son `pull_request` (hacen checkout del head y ejecutan `node .pipeline/lib/*.js` de la copia del PR). **Ninguno** es `pull_request_target` ni usa secretos. Ninguno está en `pr-status`.

| Workflow · Job | Disparador y filtros | Permisos | Runner | Runs | Crudos / Fact. | p50/p95 | Ruleset | pr-status | Seg. | Qué protege | Detección | Qué se pierde si sale del PR |
|---|---|---|---|---:|---:|---|---|---|---|---|---|---|
| `ghost-artifact-lint.yml` · *Ghost artifact lint (isMarkerArtifact required)* | PR `main`/`develop` + push `main`; `paths: .pipeline/**` | **sin bloque** (hereda el default del repo) | Linux | 291 | 95 / 292 | 1/1 | no | no | no | Artefactos marcadores del pipeline que quedan huérfanos | **65 fallas** (22 %, el lint que más detecta) | El aviso de artefactos fantasma antes del merge |
| `operational-state-lint.yml` · *Operational state lint (envoltorio requerido, enforce)* | ídem + `.github/CODEOWNERS` | `contents: read` | Linux | 291 | 106 / 292 | 1/1 | no | no | no | Escrituras de estado operativo sin el envoltorio requerido | **5 fallas** | Estado operativo escrito por fuera del envoltorio |
| `test-env-lint.yml` · *Test env lint (process.env fuera del helper)* | PR + push; `paths: .pipeline/**` | **sin bloque** | Linux | 191 | 62 / 191 | 1/1 | no | no | no | Tests que tocan `process.env` fuera del helper | **12 fallas** | Tests que contaminan el entorno de otros tests |
| `write-target-lint.yml` · *Write target lint (…)* | PR + push; `paths: .pipeline/**` | `contents: read` | Linux | 66 | 31 / 66 | 1/1 | no | no | **sí** (integridad) | Escrituras de tests contra el `.pipeline` productivo | **1 falla** | Un test que escriba sobre el pipeline real |
| `runtime-state-guard.yml` · `runtime-state-guard` | **todo** `pull_request` (sin ramas ni `paths`) | `contents: read` | Linux | 205 | 60 / 205 | 1/1 | no | no | **sí** | Secretos y estado runtime en el diff (`precommit-secret-scan.js --range`) | **3 fallas** (las mismas 3 que `secret-scan`) | Ver fila 6: lo cubre `secret-scan` para `main` y `develop` |

**Consolidación (fila 5), límite de confianza (req. 3 de security):** el workflow consolidado conserva el disparador `pull_request` (+ `push` a `main`) con `paths: .pipeline/**` y `.github/CODEOWNERS`, **ejecuta código del PR igual que hoy**, y declara `permissions: contents: read`. Eso es **más restrictivo** que hoy, porque `ghost-artifact-lint` y `test-env-lint` heredan el default del repo (#5192). No se mezcla con `admission-gate` ni con `contribution-agreement` (`pull_request_target`). *Runtime state guard* no entra en la consolidación: tiene otros disparadores (sin `paths` y sin `push`) y la fila 6 propone eliminarlo. Ahorro medido con la regla `pipeline-lints-consolidate`: 841 → 401 min.

### 3.8 `main.yml` — *CI-CD Plataforma* (56 min)

Disparadores: `push` a `main` con `paths` `backend/**`, `users/**`, `buildSrc/**`, `gradle/**`, `*.gradle.kts`, `gradle.properties`, `settings.gradle.kts` · `repository_dispatch` · `workflow_dispatch`.

| Job | Disparador y filtros | Runner | Runs | Crudos / Fact. | p50/p95 | Ruleset | pr-status | Seg. | Qué protege | Detección | Qué se pierde si sale del PR |
|---|---|---|---:|---:|---|---|---|---|---|---|---|
| `deploy-lambda` | ver arriba | Linux | 2 | 56 / 56 | 28/28 | no | no | no | Build de `users-all.jar` y deploy a Lambda | 0 fallas | No corre en PR. Es el deploy: se conserva |

### 3.9 Distribución (`distribute-*.yml`)

Todos corren por `push` a `main` con `paths` `app/**`, `buildSrc/**`, `gradle/**`, `*.gradle.kts`, `gradle.properties`, `settings.gradle.kts` y por `workflow_dispatch`, salvo iOS, que es sólo `workflow_dispatch`. En la ventana corrieron 2 veces cada uno (iOS, ninguna).

| Workflow · Job | Runner | Runs | Crudos / Fact. | p50/p95 | Ruleset | pr-status | Seg. | Qué protege | Detección | Qué se pierde si sale del PR |
|---|---|---:|---:|---|---|---|---|---|---|---|
| Android · *Build & Distribute — client* (matrix) | Linux | 2 | 9 / 10 | 5/5 | no | no | no | APK de prueba en Firebase App Distribution | **1 falla** | No corre en PR |
| Android · *Build & Distribute — business* (matrix) | Linux | 2 | 9 / 10 | 5/5 | no | no | no | ídem | **1 falla** | ídem |
| Android · *Build & Distribute — delivery* (matrix) | Linux | 2 | 10 / 11 | 5/6 | no | no | no | ídem | 0 fallas | ídem |
| Android · `notify` · *Notificar resultado* | Linux | 2 | 0 / 2 | 1/1 | no | no | no | Aviso del resultado | 0 fallas | ídem |
| Desktop · `build-msi` · *Build MSI (Windows)* | **Windows ×2** | 2 | **25 / 52** | 24/28 | no | no | no | Instalador MSI | 0 fallas | Fila 8: pasa a demanda |
| Desktop · `build-deb` · *Build Deb (Linux)* | Linux | 2 | 7 / 8 | 3/5 | no | no | no | Paquete Deb | 0 fallas | Fila 8 |
| Desktop · `create-release` · *Crear GitHub Release* | Linux | 2 | 1 / 2 | 1/1 | no | no | no | Release en GitHub | 0 fallas | Fila 8 |
| Desktop · `notify` · *Notificar resultado* | Linux | 2 | 0 / 2 | 1/1 | no | no | no | Aviso | 0 fallas | Fila 8 |
| iOS · `distribute-client` · *TestFlight — Intrale (client)* | **macOS ×10** | 0 | 0 / 0 | — | no | no | no | Build en TestFlight | Sin runs | Ya es a demanda |
| iOS · `distribute-business` · *TestFlight — Intrale Negocios (business)* | **macOS ×10** | 0 | 0 / 0 | — | no | no | no | ídem | Sin runs | ídem |
| iOS · `distribute-delivery` · *TestFlight — Intrale Repartos (delivery)* | **macOS ×10** | 0 | 0 / 0 | — | no | no | no | ídem | Sin runs | ídem |
| iOS · `notify` · *Notificar resultado* | Linux | 0 | 0 / 0 | — | no | no | no | Aviso | Sin runs | ídem |
| Web · *Build & Deploy — Web/Wasm → S3 + CloudFront* | Linux | 2 | 20 / 22 | 10/12 | no | no | no | Deploy de la app web | **2 fallas en 2 runs** | No corre en PR |
| Web · `notify` · *Notificar resultado* | Linux | 2 | 0 / 2 | 1/1 | no | no | no | Aviso | 0 fallas | ídem |

Los minutos crudos y los facturables de macOS y Windows se muestran por separado en `billable_by_os` y `raw_by_os` de la evidencia. Costo por release, medido sobre el último run completado de cada uno: Desktop 21 min (USD 0,11) · Android 10 min (USD 0,06) · Web 11 min (USD 0,07) · Lambda 28 min (USD 0,17) · iOS **sin runs completados**, no medible (cada minuto de macOS consume 10 de la cuota).

**Hallazgo colateral, fuera del alcance de la poda:** la distribución Web falló en sus 2 corridas de la ventana y la Android en 2 de 6 jobs de flavor. No cambia ninguna propuesta, pero conviene un issue aparte para revisarlo.

### 3.10 Control de cobertura

| Workflow | Jobs (`runs-on`) |
|---|---:|
| `pr-checks.yml` | 10 |
| `security-sast.yml` | 5 |
| `distribute-desktop.yml`, `distribute-ios.yml` | 4 + 4 |
| `contribution-agreement.yml`, `distribute-android.yml`, `distribute-web.yml` | 2 + 2 + 2 |
| `admission-gate`, `authorship-main-audit`, `ghost-artifact-lint`, `license-header-lint`, `main`, `operational-state-lint`, `runtime-state-guard`, `test-env-lint`, `write-target-lint` | 1 × 9 |
| **Total: 16 workflows** | **38** |

Coincide con `grep -c "runs-on" .github/workflows/*.yml` al 26/09/2026. Las matrices de Android aparecen en la API como tres jobs (*Build & Distribute — client/business/delivery*) de una sola key `build-and-distribute`: se agregan por `job.name` tal cual, sin normalizar.

---

## 4. OWASP Dependency Check: las tres opciones (req. 5 de security)

Hoy cuesta 10.334 min por mes y corre en los 205 runs de PR. Los archivos de dependencias son `gradle/libs.versions.toml`, `**/*.gradle.kts` y `buildSrc/**`. En la ventana, **1 de 149 PRs** (0,7 %) tocó alguno (`gh pr list` de los PRs creados entre el 26/08 y el 26/09).

| Opción | Costo después (min/mes) | Ahorro | Ventana de exposición | Qué se pierde |
|---|---:|---:|---|---|
| **(a)** Por PR sólo con filtro `paths` de dependencias | 69 (proyectado) | 10.265 (proyectado) | Un PR que suma una dependencia vulnerable se detecta en el PR. Una vulnerabilidad **nueva** contra una dependencia que ya está en `main` **no se detecta nunca**, hasta que alguien toque las dependencias | La vigilancia continua de lo que ya está en `main` |
| **(b)** Schedule diario + por PR que toca dependencias **(recomendada)** | 789 (69 proyectado) | 9.545 | PR de dependencias: se detecta en el PR. Vulnerabilidad nueva publicada contra lo que ya está en `main`: **hasta 1 día** | El reporte en los PR que no tocan dependencias, que hoy no aporta información (ver §3.2.1) |
| **(c)** Schedule diario puro | 720 | 9.614 | **Una dependencia con CVE puede estar en `main` hasta 1 día** antes del reporte, también si la trajo un PR | La detección en el PR que agrega la dependencia |

Fórmulas: (c) sale de la regla `owasp-schedule` (p50 del job, 24 min × 1 corrida por día × 30). La parte de PR de (a) y (b) es 10.334 × 1/149 = 69 (proyectado; fracción de PRs, no de runs). **Recomendación: (b).** Cuesta 69 min más que (c) y conserva la detección donde importa, que es el PR que cambia las dependencias. Con cualquiera de las tres, **mientras el job siga en modo warning**, la exposición real dura hasta que alguien lea el reporte. Eso lo resuelve la reconciliación de §5, no el disparador.

---

## 5. Reconciliación de issues abiertos

| Issue | Qué pide | Recomendación | Motivo |
|---|---|---|---|
| #6610 | Graduar Security SAST a check con veto en `main` | **Re-alcanzar** | Con 175 dependencias vulnerables, unos 125 avisos de Semgrep y unos 3.800 candidatos de detect-secrets **en todas** las corridas, darle veto a los tres escaneos frena todos los PRs. Nuevo alcance: sumar `secret-scan` (el único bloqueante y confiable) al rollup requerido y, para OWASP, vetar sólo en la opción (b) los PR de dependencias con umbral sobre dependencias **nuevas** |
| #5253 | Sacar del modo warning los 3 jobs | **Re-alcanzar** | Mismo motivo que #6610. Primero hay que bajar la línea base (triage de las 175 dependencias) y después gatear sólo el disparo por PR de dependencias de la opción (b). Semgrep y detect-secrets quedan en schedule, informativos |
| #6615 | Los 3 jobs nunca reportan rojo | **Cerrar** (duplicado de #5253 re-alcanzado) | El diagnóstico es correcto y quedó medido en §3.2.1. La acción es la misma que la de #5253 |
| #6391 | Aprovisionar `NVD_API_KEY` y medir 3 corridas | **Mantener** (prioridad alta) | **41 de 113 corridas no generaron reporte.** Con una sola corrida diaria, que esa corrida no falle es todavía más importante |
| #6368 | Mirror propio del datafeed NVD | **Cerrar** | Con 1 corrida por día y API key, el rate limit anónimo deja de ser un problema. Un mirror propio es infraestructura para mantener sin necesidad |
| #6396 | Acotar el crecimiento de la caché NVD por corrida | **Re-alcanzar a #7659** | Pasa de 205 corridas a unas 30 por mes. Se resuelve al reescribir el job del schedule |
| #6574 | Acotar la key de caché NVD | **Re-alcanzar a #7659** | Mismo motivo que #6396. Conviene resolverlos juntos |
| #6367 | Doble cacheo de `~/.gradle` en Security SAST | **Re-alcanzar a #7659** | El job se reescribe para el schedule, y es el momento de sacar el doble cacheo |
| #6378 | Pinnear por SHA las actions de Security SAST | **Mantener** (dentro de #7659) | Sigue vigente: `actions/checkout@v4`, `setup-java@v4`, `setup-gradle@v3`, `cache@v4`, `upload-sarif@v3`, `upload/download-artifact@v4` y `github-script@v7` siguen con tag mutable. El riesgo de la cadena de suministro no depende del disparador |
| #6407 | Estado de la credencial NVD en el comentario del PR | **Cerrar** | Si se aprueba la fila 7, no hay comentario en el PR. El estado ya se escribe en el step summary, que pasa a ser el informe de la corrida diaria |
| #6544 | Alinear la magnitud del summary OWASP con la degradación medida | **Re-alcanzar a #7659** | Aplica al summary de la corrida diaria, no al PR |
| #6614 | Promover `runtime-state-guard` a check requerido | **Re-alcanzar** | Si se aprueba la fila 6, el candidato a requerido es `secret-scan`, que corre el mismo escáner desde la base (confiable) y no desde la copia del PR |
| #6265 | Sumar los lints del pipeline a los checks requeridos | **Re-alcanzar a #7660** | Si se aprueba la fila 5, el que se evalúa es el workflow consolidado (un solo check) |
| #5192 | Declarar `permissions` mínimas en los workflows que heredan el token | **Mantener** | `ghost-artifact-lint` y `test-env-lint` siguen sin bloque `permissions`. La consolidación de la fila 5 lo resuelve para esos dos |
| #5252 / #7008 | Checks obligatorios en `main` | **Cerrar** (verificar) | El ruleset `main-required-checks` ya exige `pr-status` (verificado el 26/09 contra la API de rulesets) |
| #6594 | Blindar `github.head_ref` en el push de evidencias | **Cerrar** | Ese paso ya no existe: `e2e-qa` sube la evidencia con `upload-artifact`, y el único uso de `head_ref` en `pr-checks.yml` entra por `env:` |
| #2753 | CVE scan de las dependencias del cliente Compose | **Re-alcanzar a #7659** | Queda cubierto si el schedule de OWASP (`dependencyCheckAggregate`) incluye `app/composeApp`. Hay que verificarlo al implementar |
| #6648 | La entrega se rinde esperando una CI de 17 min | **Mantener** | La poda baja el tiempo de CI de cada PR, porque OWASP tiene p95 de 247 min facturables por run, pero el presupuesto de espera de delivery se ajusta aparte |
| #7659 · #7660 · #7661 · #7662 | Ejecución de la ola | **Mantener** | #7659 ejecuta las filas 1, 3, 4 y 7. #7660, las filas 2, 5, 6 y 8. #7661 mide el CI reducido. #7662 decide la fila 10 |

---

## 6. Pérdidas atadas a privatizar (req. 7 de security)

Ninguna de las filas 1 a 8 **supone** que `platform` sea privado: todas valen también con el repo público. Estas pérdidas aparecen **recién al privatizar** (#7662):

| Control gratuito en repo público | ¿Lo cubre un workflow propio? | Qué pasa al privatizar sin GHAS |
|---|---|---|
| Secret scanning + **push protection** del servidor | En parte: `secret-scan` bloquea en el PR, pero no en el `push` a una rama | Se pierde la push protection |
| Code scanning (pestaña Security, `upload-sarif` de Semgrep) | Semgrep corre igual, pero el SARIF no se puede subir | Se pierde la pestaña Security; el reporte queda sólo en el artefacto |
| Dependency review / Dependabot alerts | En parte: OWASP (opción b) | Dependency review requiere GHAS en repos privados |
| Minutos de Actions sin costo | — | El CI reducido (3.371, proyectado) pasa a consumir cuota (Team incluye 3.000) |
| `Contribution Agreement` **[fija]** | — | Deja de hacer falta y se elimina **junto con** la privatización, no antes |

---

## 7. Método y reproducibilidad

- **Medición:** `scripts/measure-actions-billing.js --by-job` (#7658) agrega, por workflow, el conteo de runs por evento (`events`) y, por job, `runs`, `failures`, `skipped`, minutos crudos y facturables por sistema operativo y p50/p95 por ejecución (`jobs_detail`). Sin `--by-job`, la salida es idéntica a la de #7594. El desglose sólo expone claves de la allowlist `JOB_DETAIL_KEYS`, que un test verifica.
- **Ahorros medidos:** `estimateOptimizations` sobre los runs reales con las reglas de `evidence/7658/pricing.json` (`owasp-schedule`, `semgrep-schedule`, `detect-secrets-schedule`, `pipeline-lints-consolidate`). **Eliminar** = `billable_min` del job. **Filtro `if:`** del Admission Gate = runs por `issues` × 1 min (proyectado). **Filtro `paths`** de OWASP = fracción de PRs que tocan dependencias × costo del job (proyectado).
- **Detección:** `failures` por job en la ventana. Para Security SAST, conteo de los artefactos (SARIF de Semgrep, reporte HTML de OWASP, baseline de detect-secrets), bajados a un directorio temporal fuera del repo y publicados sólo como agregados. Admission Gate: búsqueda del comentario fijo que el gate publica al etiquetar.
- **Seguridad de la evidencia:** `docs/pipeline/evidence/7658/` tiene sólo `actions-usage-summary.json` y `pricing.json`. Las respuestas crudas (`--raw`), los logs y los artefactos nunca entran al repo (el script se niega a escribir `--raw` dentro del repo, y un test lo cubre).
- **Para repetir la medición:**
  ```bash
  node scripts/measure-actions-billing.js --repos platform --days 30 --by-job \
       --pricing docs/pipeline/evidence/7658/pricing.json --out docs/pipeline/evidence/7658 \
       --release-workflows distribute-ios.yml,distribute-desktop.yml,distribute-android.yml,distribute-web.yml,main.yml
  ```
