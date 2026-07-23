# Inventario de frontera kernel↔producto

> **Épica:** EP-OLA8-A · Inventario de frontera kernel↔producto (issue #4009)
> **Ola:** 8 — Definición del desacople kernel operativo ↔ producto
> **Naturaleza:** documento de **definición** (no implementación). Mapea qué partes del
> modelo operativo están pegadas al producto Intrale y dónde cae la frontera.
> **Estado:** documento vivo — se revisa al entrar a la Ola 9 (implementación).

## 0. Cómo leer este documento

Hoy el **modelo operativo** (el pipeline que orquesta agentes) y el **producto** (Intrale:
backend Ktor + app Compose Multiplatform) son una sola cosa que vive en el mismo repo. El
objetivo del desacople es partirlos en dos:

- **Kernel operativo (genérico):** sirve para orquestar *cualquier* producto. No sabe nada
  de Kotlin, Gradle, flavors, Lambda ni Cognito.
- **Adaptador de producto (específico):** la parte que sabe que el producto es Intrale —
  stack, comandos de build, labels de dominio, gates de QA del producto.

Cada ítem se clasifica con **3 categorías** y un **grado de acoplamiento**:

| Categoría | Significado |
|-----------|-------------|
| **kernel** | Lógica genérica de orquestación. Debería poder mudarse al kernel sin tocar nada del producto. |
| **adaptador** | Conocimiento de producto (stack, dominio, build, auth). Vive del lado del adaptador Intrale. |
| **a-decidir** | Híbrido: mezcla regla genérica + conocimiento de producto. Hay que partirlo a nivel de sección/regla en la Ola 9. |

| Grado | Significado |
|-------|-------------|
| **bajo** | Acoplamiento marginal (1-5 referencias, o referencias cosméticas). Fácil de separar. |
| **medio** | Acoplamiento real pero localizado en secciones identificables. |
| **alto** | El ítem está estructuralmente pegado al producto. Separarlo requiere diseño explícito. |
| **alto (crítico)** | Acoplamiento alto **y** en el camino crítico del ruteo/ejecución. Top de la lista priorizada. |

> **Nota de método (CA-7):** la clasificación de skills no se hizo a ojo. Se barrió cada
> `SKILL.md` con un grep de marcadores de stack/dominio
> (`gradlew|kotlin|compose|flavor|lambda|dynamodb|cognito|ktor|wasm|app:|emulador|apk`).
> El comando y su salida completa están en la [sección 5 (Evidencia de cobertura)](#5-evidencia-de-cobertura-automatizada).
> El nº de *matches* es un **indicador de proximidad al stack**, no la clasificación final:
> la decisión combina matches + función del skill.

---

## 1. Inventario de los 28 skills

`.claude/skills/` tiene **28 entradas** (verificado: `ls .claude/skills | wc -l` = 28). De
esas, **27 son skills activos** con `SKILL.md` y **1 es el contenedor `_frozen`** (sin
`SKILL.md` propio; agrupa 3 skills congelados — ver [§1.3](#13-contenedor-_frozen)).

### 1.1. Skills acoplados al producto (candidatos a adaptador)

| Ítem (skill) | Clasificación | Grado | Nota / razón (matches de stack) |
|--------------|---------------|-------|---------------------------------|
| `web-dev` | adaptador | alto | 47 matches. Kotlin/Wasm, PWA, Webpack, browser APIs. Stack puro. |
| `android-dev` | adaptador | alto | 32 matches. Compose, flavors `client/business/delivery`, Coil, Material3. Stack puro. |
| `backend-dev` | adaptador | alto | 21 matches. Ktor, Lambda, DynamoDB, Cognito, `SecuredFunction`. Stack + auth de producto. |
| `tester` | adaptador | alto | 18 matches. Kover, kotlin-test, tareas Gradle, Gherkin sobre módulos del producto. |
| `perf` | adaptador | alto | 18 matches. Análisis de performance de builds y módulos **Gradle**. |
| `builder` | adaptador | alto | 17 matches. `gradlew`, ensamblado de APK por flavor. Comandos de build del producto. |
| `ux` | adaptador | alto | 25 matches. Componentes Compose, branding, splash/íconos por flavor, Claude Design. Produce assets del producto. |

### 1.2. Skills de orquestación (candidatos a kernel) e híbridos

| Ítem (skill) | Clasificación | Grado | Nota / razón (matches de stack) |
|--------------|---------------|-------|---------------------------------|
| `delivery` | kernel | bajo | 0 matches. Commit + push + PR. Genérico; sólo embebe convenciones Intrale (assignee, formato rama) → parametrizable. |
| `branch` | kernel | bajo | 0 matches. Gestión de ramas y protección de `main`. Git puro, genérico. |
| `cost` | kernel | bajo | 0 matches. Token cost tracker por sesión/agente. Métrica de orquestación, agnóstica de producto. |
| `handoff` | kernel | bajo | 0 matches. Postea payload de delivery en el issue. Mecanismo genérico de traspaso. |
| `reset` | kernel | bajo | 0 matches. Hard reset de la infra del pipeline. Opera sobre el kernel, no sobre el producto. |
| `ops` | kernel | bajo | 1 match. Validación/diagnóstico del entorno de ejecución. Genérico. |
| `auth` | kernel | bajo | 1 match. Permisos de **Claude Code** (no auth de producto). Genérico del harness. |
| `monitor` | kernel | bajo | 2 matches. Dashboard de semáforos multi-sesión. Orquestación pura. |
| `ghostbusters` | kernel | bajo | 2 matches. Limpieza de procesos zombi/worktrees/locks. Higiene del kernel. |
| `refinar` | a-decidir | bajo | 2 matches. Refinamiento de issues = proceso genérico, pero embebe labels y Project V2 del producto. |
| `po` | a-decidir | medio | 3 matches. Rol genérico (Product Owner) con contenido 100% flavoreado a flujos de negocio Intrale. La **plantilla de gates** es kernel; el **contenido** es producto. |
| `priorizar` | a-decidir | bajo | 5 matches. Triaje masivo = proceso genérico; las **categorías/labels** son del producto. |
| `review` | a-decidir | bajo | 7 matches. Code review = proceso genérico (kernel); las reglas que cita (strings, recursos Compose) son del producto. |
| `pipeline-dev` | kernel | medio | 7 matches. Desarrolla **el orquestador mismo** (`.pipeline/*.js`). Es el dev del kernel. Acoplado al hecho de que `.pipeline/` vive dentro del repo del producto. |
| `guru` | a-decidir | medio | 9 matches. Investigación técnica (Context7 + codebase) = mecanismo kernel; el codebase investigado es el producto. |
| `security` | a-decidir | medio | 12 matches. OWASP/auditoría = marco genérico (kernel); las referencias a Cognito/JWT/`SecuredFunction` son del producto (adaptador). |
| `planner` | a-decidir | medio | 17 matches. Planificación estratégica (Gantt, deps) = kernel; sprints/historias y stack referenciado son producto. |
| `historia` | a-decidir | medio | 18 matches. Generación de historias = plantilla genérica (kernel); labels de admisión y stack embebido = producto. |
| `doc` | a-decidir | medio | 20 matches. Gestión de backlog = proceso genérico; labels/áreas del producto embebidas en el ruteo. |
| `qa` | a-decidir | alto | 26 matches. **Híbrido fuerte** → se parte en 2 filas en [§4 (gates QA)](#4-gates-de-qa). Regla "feature con UI → E2E con video" = kernel; emulador Android + APK por flavor + edge-tts = adaptador. |

### 1.3. Contenedor `_frozen`

`.claude/skills/_frozen/` no tiene `SKILL.md` propio: es un **contenedor de skills congelados**.
Agrupa 3 skills desactivados. Se inventarían explícitamente para cerrar CA-2 (cobertura de las
28 entradas), aunque estén inactivos:

| Ítem (skill congelado) | Clasificación | Grado | Nota / razón |
|------------------------|---------------|-------|--------------|
| `_frozen/desktop-dev` | adaptador | alto | Stack del producto (Compose Desktop/JVM). Congelado. |
| `_frozen/ios-dev` | adaptador | alto | Stack del producto (Compose iOS). Congelado. |
| `_frozen/scrum` | kernel | bajo | Proceso de orquestación (zombi del pipeline V3, ver #3219). Congelado. |

> **Cobertura de skills (CA-2):** 27 skills activos + 1 contenedor `_frozen` (con sus 3 skills
> congelados clasificados) = **28 entradas, 100% cubiertas**. Coincide con `ls .claude/skills | wc -l` = 28.

---

## 2. Inventario de fuentes no-skill

### 2.1. `.pipeline/config.yaml` (1064 líneas)

El corazón del acoplamiento está en el **ruteo `label→skill`**. Aquí el kernel decide qué
agente atiende un issue según labels de **dominio del producto**.

| Ítem (archivo:sección/regla) | Clasificación | Grado | Nota / razón |
|------------------------------|---------------|-------|--------------|
| `config.yaml: dev_skill_mapping` (líneas ~110-119) | adaptador | alto (crítico) | Mapea labels de producto a skills de stack: `app:client/business/delivery → android-dev`, `area:backend → backend-dev`, `area:web → web-dev`. Es **el** punto donde el kernel conoce el producto. |
| `config.yaml: dev_routing_priority` (líneas ~124-133) | adaptador | alto (crítico) | Orden de prioridad de labels de dominio (`area:pipeline > area:infra > app:client...`). El *mecanismo* de prioridad es kernel; **la lista de labels** es producto. |
| `config.yaml: pipeline_scope_keywords` (`.pipeline/`, `pulpo.js`) | a-decidir | medio | Heurística de override por contenido. Mecanismo genérico; las keywords mezclan kernel (`pulpo.js`) y producto. |
| `config.yaml: dev_skill_mapping.default: backend-dev` | adaptador | medio | El fallback asume que "sin label de área" = backend Kotlin. Asunción de producto. |
| `config.yaml: límites de concurrencia / umbrales de recursos` (qa:1, qa_env_max_*) | a-decidir | medio | Mecanismo de throttling = kernel; los valores calibrados al hardware del QA Android (emulador + Gradle) son producto. |
| `config.yaml: artefactos QA` (línea ~805, `qa: {types:[video,document], formats:[.mp4,...]}`) | kernel | bajo | Tipos de artefacto genéricos. Reutilizable. |

### 2.2. `CLAUDE.md` (292 líneas)

**38 matches de stack** (medido). Es el documento más acoplado al producto por densidad:
prácticamente todo su contenido es conocimiento de Intrale embebido como instrucción al agente.

| Ítem (sección) | Clasificación | Grado | Nota / razón |
|----------------|---------------|-------|--------------|
| `CLAUDE.md: Stack y versiones` (Kotlin 2.2.21, Ktor, Compose, Kodein...) | adaptador | alto | Stack del producto. 100% adaptador. |
| `CLAUDE.md: Comandos de build` (`./gradlew ...`, flavors, shadowJar) | adaptador | alto | Comandos Gradle/flavor específicos del producto. |
| `CLAUDE.md: Arquitectura App / Backend` (asdo/ext/ui, `/{business}/{function}`) | adaptador | alto | Patrones de código del producto. |
| `CLAUDE.md: Reglas de strings/recursos Compose` (KSP, `resString`, fallback ASCII) | adaptador | alto | Regla de implementación del producto. |
| `CLAUDE.md: Android Product Flavors` (`client/business/delivery`) | adaptador | alto | Dominio del producto. |
| `CLAUDE.md: Ramas y PRs` (tabla `agent/<issue>-<slug>` ← `origin/main`) | a-decidir | medio | Convención de ramas = mecanismo kernel; los nombres/bases son convención adoptada. Parametrizable. |
| `CLAUDE.md: Gate de QA obligatorio` (QA E2E → Tester → PO, labels `qa:passed/skipped`) | a-decidir | alto | La **secuencia de gates** y los labels de proceso son kernel; "QA E2E con video para UI" generaliza, pero el criterio por tipo de issue cita stack del producto. |
| `CLAUDE.md: Protocolo de tareas / concurrencia de agentes` | kernel | medio | Mecanismo de orquestación (TaskCreate, hooks, límite de 3 agentes). Genérico. |
| `CLAUDE.md: Lanzamiento de agentes (Pulpo, worktrees, circuit breaker)` | kernel | medio | Descripción del kernel operativo. Genérico salvo paths del repo. |

### 2.3. `.pipeline/*.js` + hooks (`.claude/hooks/*`)

El código del orquestador es mayormente **kernel**, pero tiene convenciones hardcodeadas que
asumen el layout del repo del producto.

| Ítem (archivo:convención) | Clasificación | Grado | Nota / razón |
|---------------------------|---------------|-------|--------------|
| `.pipeline/pulpo.js`, `dashboard.js`, libs — lógica de orquestación | kernel | medio | Motor del pipeline (intake, colas, lifecycle, routing). Genérico. |
| Convención de rama `agent/*` (`branch-guard.js`, `pulpo.js`, `canonical-facts.js`, ...) | a-decidir | medio | El prefijo `agent/` y base `origin/main` están hardcodeados en múltiples JS. Mecanismo kernel; el patrón concreto debería ser config. |
| Worktrees aislados (`worktree-guard.js`, `cleanup-worktrees.js`) | a-decidir | medio | Aislamiento por worktree = mecanismo kernel; asume que el repo del producto **es** el repo donde corre el pipeline. |
| `.pipeline/` viviendo **dentro** del repo del producto (`root = C:/Workspaces/Intrale/platform`) | adaptador | alto (crítico) | Acoplamiento **estructural**: el estado del kernel (`.pipeline/`) está físicamente embebido en el repo del producto. Ver [crítico #2](#6-lista-priorizada-de-acoplamientos-críticos). |
| `agent-concurrency-check.js`, `agent-registry.js`, `activity-logger.js` | kernel | bajo | Hooks de orquestación/telemetría. Genéricos. |
| `apk-freshness.js` (hook) | adaptador | alto | Conoce el artefacto APK del producto. |

### 2.4. Gates de QA — ver [§4](#4-gates-de-qa)

Tratados en su propia sección por ser el híbrido más representativo (CA-4).

---

## 3. Frontera de secretos y auth

> Sección obligatoria (requisito de **Security**, CA-5). Es donde más duele trazar mal la
> línea: si el adaptador filtra secretos al kernel, o el kernel asume scopes del producto, la
> Ola 9 hereda una fuga de responsabilidad.

| Ítem | Clasificación | Grado | Nota / razón |
|------|---------------|-------|--------------|
| **(1a)** Mecanismo de carga de credenciales — `.pipeline/lib/credentials.js` | kernel | medio | Cargador unificado (lee `~/.claude/secrets/credentials.json`, popula `process.env`, precedencia env > json > legacy). El *mecanismo* es genérico → kernel. |
| **(1b)** Nombres / scopes de credenciales (`telegram.bot_token`, `providers.google/cerebras/...`, AWS de Intrale) | adaptador | alto | Los *qué* credenciales y sus scopes son del producto/entorno Intrale → adaptador. Mantener separado del mecanismo evita que el adaptador filtre secretos al kernel. |
| **(2)** Auth de producto en `backend-dev` — JWT / Cognito / `SecuredFunction` | adaptador | alto | Patrones de autenticación del producto. **No** son kernel: el contrato (EP-OLA8-B) no debe subirlos al kernel genérico. |
| **(3)** Redacción de secretos en handoff (#2993) — `.pipeline/lib/handoff.js` + `lib/redact.js` | kernel | bajo | Redacta AWS keys / JWT / API keys (Anthropic/OpenAI/Slack) / passwords + anti prompt-injection. Lógica genérica de higiene → **kernel**. Debe quedar del lado del kernel para proteger cualquier producto. |

**Regla de frontera (resumen):** *los mecanismos* (cargar, redactar, traspasar secretos) son
**kernel**; *los nombres, scopes y patrones de auth concretos* son **adaptador**.

---

## 4. Gates de QA

Ejemplo canónico de ítem híbrido partido a nivel de regla (CA-4). El skill `qa` (26 matches)
mezcla proceso genérico con stack Android.

| Ítem (regla) | Clasificación | Grado | Nota / razón |
|--------------|---------------|-------|--------------|
| `qa`: "feature con UI → E2E con video obligatorio" | kernel | bajo | Regla de **proceso** genérica. Aplica a cualquier producto con UI. |
| `qa`: secuencia de gates "QA E2E → Tester → PO acceptance" | kernel | bajo | Flujo de validación genérico. |
| `qa`: labels de proceso `qa:passed / qa:skipped / qa:pending` | kernel | bajo | Semántica de estado de proceso. Reutilizable. |
| `qa`: criterio "infra/docs sin `app:*` → `qa:skipped`" | a-decidir | medio | El *principio* (cambios sin impacto de usuario se saltan QA E2E) es kernel; los labels `app:*` que lo disparan son producto. |
| `qa`: ejecución con **emulador Android** (AVD, snapshot `qa-ready`, `qa-android.sh`) | adaptador | alto | Stack Android específico. |
| `qa`: **APK por flavor** (`assembleClientDebug`, etc.) como artefacto QA | adaptador | alto | Build del producto. |
| `qa`: narración **edge-tts** / Lambda AWS / Cognito en el entorno QA remoto | adaptador | alto | Infra/stack del producto. |
| `config.yaml`: umbrales `qa_env_max_cpu/mem`, `qa:1`, duración ventana QA | a-decidir | medio | Throttling = kernel; valores calibrados al emulador+Gradle = producto. |

---

## 5. Evidencia de cobertura automatizada

> Requisito CA-7: el barrido es **automatizado** (grep de marcadores), no inspección a ojo.
> Salida real ejecutada sobre el HEAD de la rama `agent/4009-inventario-frontera`.

Marcadores usados: `gradlew | kotlin | compose | flavor | lambda | dynamodb | cognito | ktor | wasm | app: | emulador | apk` (case-insensitive).

```text
$ PATTERN='gradlew|kotlin|compose|flavor|lambda|dynamodb|cognito|ktor|wasm|app:|emulador|apk'
$ for d in .claude/skills/*/; do grep -iE "$PATTERN" "$d/SKILL.md" | wc -l; done   # + wc -l por archivo
---
_frozen        (sin SKILL.md — contenedor _frozen)
android-dev    matches=32   lines=400
auth           matches=1    lines=176
backend-dev    matches=21   lines=279
branch         matches=0    lines=154
builder        matches=17   lines=222
cost           matches=0    lines=265
delivery       matches=0    lines=556
doc            matches=20   lines=575
ghostbusters   matches=2    lines=109
guru           matches=9    lines=197
handoff        matches=0    lines=103
historia       matches=18   lines=341
monitor        matches=2    lines=440
ops            matches=1    lines=228
perf           matches=18   lines=433
pipeline-dev   matches=7    lines=220
planner        matches=17   lines=1262
po             matches=3    lines=945
priorizar      matches=5    lines=116
qa             matches=26   lines=526
refinar        matches=2    lines=118
reset          matches=0    lines=93
review         matches=7    lines=318
security       matches=12   lines=347
tester         matches=18   lines=350
ux             matches=25   lines=1183
web-dev        matches=47   lines=296
---
config.yaml  matches=16  lines=1064
CLAUDE.md    matches=38  lines=292
.claude/hooks/*.js: 56 archivos, 25 con referencias a `agent/` o `worktree`
```

**Lectura de la evidencia:** la frontera se insinúa en los datos. Orquestación pura ≈ 0-2
matches (`delivery`, `branch`, `cost`, `handoff`, `reset`, `ops`, `auth`, `monitor`,
`ghostbusters` → **kernel**); stack/dominio ≈ 17-47 matches (`web-dev`, `android-dev`,
`backend-dev`, `tester`, `perf`, `builder`, `ux` → **adaptador**); la franja intermedia (3-16
matches) son los **a-decidir** que requieren partirse a nivel de sección.

**Cobertura declarada (CA-3):** 100% de las fuentes listadas en la receta — los 28 skills
(§1), `config.yaml` (§2.1), `CLAUDE.md` (§2.2), `.pipeline/*.js` + hooks (§2.3) y gates QA
(§4) están inventariados y clasificados.

---

## 6. Lista priorizada de acoplamientos críticos

> Input directo a **EP-OLA8-B (Contrato)**. Ordenados por impacto: trazar mal estos tres es lo
> que más cuesta de revertir en la Ola 9.

1. **Ruteo `label→skill` en `config.yaml` (`dev_skill_mapping` + `dev_routing_priority`).**
   Es el punto exacto donde el kernel conoce el producto: mapea labels de dominio Intrale
   (`app:client`, `area:backend`, `area:web`) a skills de stack. El contrato debe definir una
   **tabla de ruteo inyectable por el adaptador**, no hardcodeada en el kernel. *Grado: alto (crítico).*

2. **`.pipeline/` embebido dentro del repo del producto.** El estado y el código del kernel
   operativo viven físicamente en `C:/Workspaces/Intrale/platform`. Es un acoplamiento
   **estructural**: el kernel no puede orquestar otro producto sin antes salir del repo. El
   contrato debe definir cómo se separan kernel (repo propio) y producto (repo orquestado).
   *Grado: alto (crítico).*

3. **Conocimiento de stack en los skills dev/qa/ux** (`android-dev`, `backend-dev`, `web-dev`,
   `builder`, `tester`, `perf`, `qa`, `ux` — 17-47 matches). Estos 8 skills *son* el adaptador
   de producto. El contrato debe definir la **interfaz** que el kernel espera de un "skill de
   desarrollo/QA/UX" para poder enchufar adaptadores de otros stacks. *Grado: alto.*

**Críticos secundarios** (a vigilar, no top-3): la sección "Frontera de secretos y auth" (§3)
— separar mecanismo [kernel] de scopes [adaptador]; las convenciones `agent/*` + worktrees
hardcodeadas en `.pipeline/*.js` (§2.3); y `CLAUDE.md` como bloque casi-íntegro de adaptador
(§2.2).

---

## 7. Notas de alcance

- **Cero cambios productivos.** Este entregable agrega únicamente bajo `docs/desacople-kernel/`.
  No toca `.pipeline/` productivo ni código del producto (verificable con `git diff --name-only main`).
- **Documento vivo.** Se revisa al entrar a la Ola 9. La clasificación `a-decidir` es deliberada:
  marca lo que requiere diseño explícito en el contrato, no indecisión.
- **Anti scope-creep.** El entregable es clasificación + priorización. Mover/refactorizar skills
  es material de la Ola 9 (implementación), fuera de esta épica.
