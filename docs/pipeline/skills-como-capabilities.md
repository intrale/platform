# Skills como capabilities/plugins

> **Épica:** EP-OLA8-C · [#4011](https://github.com/intrale/platform/issues/4011)
> **Ola:** 8 (Definición del desacople kernel operativo ↔ producto)
> **Naturaleza:** documento de **definición**. Su salida son definiciones, criterios, contratos y un backlog de Ola 9. **No** es implementación del modelo de plugins.
> **Restricción transversal (CA-9):** el kernel operativo se construye **al lado**, en repo nuevo. El `.pipeline/` y los `.claude/skills/*` de Intrale **no se tocan** en esta épica ni en su entregable.

---

## 0. Encuadre y alcance (CA-0)

Hoy el modelo operativo (el pipeline V3: Pulpo, fases, skills, gates) y el producto (Intrale: Kotlin/Ktor/Compose/gradlew/flavors/AWS) son **una sola cosa**. El conocimiento de stack vive **inline en el texto de cada `SKILL.md`**, versionado y mezclado con el procedimiento operativo.

El objetivo de esta épica es **diseñar** cómo partir esa unidad en dos:

- Un **kernel operativo genérico** — sabe *cómo* analizar, implementar, revisar, buildear, testear y entregar, para cualquier producto.
- Un **adaptador de producto** (plugin de stack) — sabe *qué* comandos correr, *qué* frameworks usar, *qué* paths tocar para un producto concreto.

Este `~80%` del trabajo de desacople es donde se decide si el modelo "sale bien o se vuelve un pozo sin fondo" (cuerpo de la épica). El factor de riesgo dominante no es técnico sino de **adopción**: si declarar un producto nuevo es oscuro o sin feedback, el modelo no se usa aunque sea correcto.

**Skills en alcance (6):** `builder`, `backend-dev`, `android-dev`, `web-dev`, `ux`, `qa`.

**Lo que este documento NO hace:**
- No implementa el kernel ni el mecanismo de plugins.
- No modifica ningún `SKILL.md` ni `config.yaml` de Intrale.
- No crea issues de Ola 9 con label de admisión (`needs-definition`/`Ready`): el backlog de la §8 queda como definición, su admisión es un gate humano aguas abajo.

---

## 1. Frontera genérico vs específico (CA-1)

La frontera ya existe **de facto** en los skills actuales: todos comparten el mismo esqueleto (pre-flight `TaskCreate` → entender contexto → trabajar-hasta-que-pase → reportar) envolviendo specifics de stack. Formalizar esa frontera es el corazón del desacople.

Convención de columnas:
- **Genérico (el *cómo* → kernel):** procedimiento, heurística, contrato y reporte que sirven para cualquier producto.
- **Específico de stack (el *qué* → plugin/profile):** comandos, frameworks, paths, módulos y targets que cambian con el producto.

Cada fila incluye un ejemplo mínimo del *qué* (guideline G2 de UX: la tabla debe servir como onboarding, no sólo como taxonomía).

| Skill | Genérico (el *cómo* → kernel) | Específico de stack (el *qué* → plugin/profile) |
|---|---|---|
| **builder** | Registrar tareas (`metadata.steps`), determinar módulos afectados vs base, "compilar hasta que pase", parsear/clasificar fallos (syntax/import/type/resource/config), reportar veredicto, generar artefacto de cierre de fase | `JAVA_HOME=/c/Users/Administrator/.jdks/temurin-21.0.7`, binario `./gradlew`, módulos `backend\|users\|app\|tools`, mapeo módulo→tarea (`:backend:check`, `:app:composeApp:check`), `scripts/smart-build.sh`, detección de archivos compartidos (`buildSrc/`, `gradle/`, `*.gradle.kts`), verificaciones (`verifyNoLegacyStrings`, `validateComposeResources`, `scanNonAsciiFallbacks`), artefactos QA (`:users:shadowJar`, `assembleClientDebug`) |
| **backend-dev** | Pre-flight tasks, "leer el contrato antes de codear" (SDD), heurística de elección de módulo (bounded context / volumen / ciclo de vida), TDD red→green, patrón de error, convención de logging + statusCode, escribir tests, reportar, handoff | Forma/path de la spec (`docs/api/openapi.yaml`, `openapi-show-endpoint.sh`), módulos `:backend`/`:users`, framework (Ktor), persistencia (DynamoDB), auth (Cognito/`SecuredFunction`/JWT), target de deploy (Lambda `kotlinTest`), `scaffold-module.sh`, registro DI Kodein (`bindSingleton<Function>(tag=...)`), scripts `backend-*.sh` |
| **android-dev** | Decidir capa (`commonMain` vs `androidMain`), TDD, seguir convenciones de UI, reportar | `:app:composeApp` (`androidMain`/`commonMain`), Compose + Material3, product flavors (`client`/`business`/`delivery`, dimensión `appType`), packages (`com.intrale.app.client`), Coil (SVG), `ResStrings.kt`, `build.gradle.kts`, `android-install-apk.sh` |
| **web-dev** | Decidir ubicación (común vs web-only), TDD, reportar | `:app:composeApp` (`wasmJsMain`/`commonMain`), Kotlin/Wasm, PWA/service worker/manifest, Webpack, `index.html` bootstrap, browser APIs (Web Push, clipboard, `window.history`), scaffold web target |
| **ux** | Proceso de diseño (research → benchmark → propuesta → validar render vs mockup), heurística de accesibilidad, generación de mockup, veredicto pasa/rechaza | Material Design 3 + HIG platform-adaptive, Compose Multiplatform como target de implementación, Figma MCP, `ux-mockup-generator.js`, design-system del producto, paleta/branding Intrale |
| **qa** | Verificar conectividad antes de correr, localizar artefacto a probar, ejecutar E2E hasta veredicto, validar video, narrar, reportar pasa/falla | Emulador Android (AVD, `adb`, Maestro, `qa-android.sh`), APK del flavor (`composeApp-client-debug.apk`), `./gradlew :qa:test`/`:app:composeApp:desktopTest`, backend remoto (Lambda/API Gateway/DynamoDB/Cognito), `qa-find-apk.sh`, `qa-validate-video.js` |

**Lectura de la tabla:** la columna izquierda es estable entre productos — es lo que el kernel "sabe hacer". La derecha es lo que un producto nuevo aporta vía su `stack-profile`. Un autor que migra un producto nuevo aprende qué le toca aportar **leyendo la columna derecha**.

---

## 2. Contrato de capability (CA-2)

El kernel define **interfaces de capability** (verbos); el plugin de stack las **implementa**. Un skill genérico invoca verbos resueltos en runtime contra el plugin del producto activo.

### Set mínimo de verbos

| Verbo | Qué hace (genérico) | Entradas | Salidas | Errores |
|---|---|---|---|---|
| `read-contract` | Leer el contrato del producto (API spec, schema) que el dev debe respetar antes de codear | `{contract_ref, selector?}` | `{contract_text, found: bool}` | `contract-not-found`, `selector-no-match` |
| `scaffold-module` | Crear un módulo/bounded-context nuevo siguiendo la plantilla del stack | `{module_name, kind}` | `{created_paths[], manual_checklist[]}` | `module-exists`, `invalid-name` |
| `build` | Compilar el/los módulos afectados | `{scope: "auto"\|module[], clean: bool, verify: bool}` | `{ok: bool, modules[], duration_ms, failures[]}` | `compile-error`, `env-misconfigured`, `timeout` |
| `test` | Correr la suite de tests del scope | `{scope, kind: "unit"\|"all"}` | `{ok: bool, passed, failed, total}` | `test-failure`, `no-tests`, `timeout` |
| `package` | Generar el artefacto desplegable/probable (JAR, APK, bundle) | `{target}` | `{artifact_paths[], metadata}` | `package-error`, `unknown-target` |
| `e2e` | Ejecutar la verificación de extremo a extremo contra el entorno real | `{artifact_ref, env: "remote"}` | `{ok, evidence_paths[], report}` | `connectivity-failed`, `no-artifact`, `e2e-failure` |
| `deploy` | Publicar el artefacto al target del producto | `{artifact_ref, target}` | `{ok, deploy_id}` | `deploy-error`, `auth-failed`, `gate-blocked` |

### Justificación de granularidad (decisión abierta #1 de guru)

El set se eligió en el nivel **"acción operativa que una fase del pipeline necesita invocar"** — ni más fino ni más grueso:

- **Por qué no más fino** (ej. `compile-kotlin`, `run-ksp`, `validate-resources` como verbos separados): explotaría la interfaz y filtraría detalle de stack (Kotlin/KSP) al kernel, que es justo lo que queremos esconder. Esas sub-acciones son **internas a la implementación** del verbo `build` por el plugin.
- **Por qué no más grueso** (ej. un único `do-the-work`): perdería reutilización — las fases del pipeline (`dev`, `build`, `verificacion`/QA, `delivery`) consumen verbos distintos y necesitan distinguirlos para rutear, paralelizar y aplicar gates.
- **Mapeo a fases:** `read-contract`+`scaffold-module`+`build`+`test` → fase `dev`; `build`+`package` → fase `build`; `e2e` → fase QA; `deploy` → `delivery`. Esta correspondencia 1:N entre fase y verbos confirma el nivel correcto de granularidad.

### Forma de la interfaz (no shell libre — ver SEC-1)

Cada verbo se invoca con un **objeto de entrada tipado**, no con un string de shell. El plugin traduce ese objeto a una invocación concreta usando **argv arrays allowlisteados**, nunca `sh -c "<string del profile>"`:

```
build({scope: "auto", clean: false, verify: true})
  → el plugin Intrale resuelve a: ["bash", "scripts/smart-build.sh"]   (argv, sin interpolación de shell)
```

El glosario de verbos es **estable y versionado** (guideline G5 de UX): aparecen en logs, mensajes de error y docs de cada producto; renombrarlos es un breaking change del contrato.

---

## 3. Descubrimiento y aporte de plugins (CA-3)

### (a) Cómo se declara un `stack-profile`

Un producto aporta un archivo declarativo `stack-profile.{yaml,json}` con estos campos:

```yaml
profile_version: 1                 # versión del schema del contrato (compat)
product: intrale-platform
trust:
  origin: "git@github.com:intrale/platform.git"   # origen confiable declarado (SEC-2)
  integrity: "sha256:<hash del profile>"           # verificación de integridad (SEC-2)
env:
  JAVA_HOME: { secret_ref: null, value: "/c/Users/.../temurin-21.0.7" }  # paths no-secretos
modules:                           # catálogo de módulos y su mapeo a tareas
  backend:  { check: ["gradlew", ":backend:check"] }
  users:    { check: ["gradlew", ":users:check"], package: ["gradlew", ":users:shadowJar"] }
  app:      { check: ["gradlew", ":app:composeApp:check"], package: ["gradlew", ":app:composeApp:assembleClientDebug"] }
capabilities:                      # implementación de cada verbo como argv allowlisteado (SEC-1)
  read-contract: { cmd: ["bash", ".pipeline/scripts-backend/openapi-show-endpoint.sh"], contract_ref: "docs/api/openapi.yaml" }
  build:         { cmd: ["bash", "scripts/smart-build.sh"] }
  test:          { cmd: ["bash", ".pipeline/scripts-backend/backend-test.sh"] }
  e2e:           { cmd: ["bash", "qa/scripts/qa-android.sh"], env: "remote" }
  deploy:        { cmd: ["..."], target: "lambda:kotlinTest", secret_ref: "aws.kotlinTest" }   # secreto por referencia (SEC-5)
context_docs:                      # docs inyectables como CONTEXTO (dato no confiable — SEC-4)
  - "CLAUDE.md"
  - "docs/engineering/strings.md"
sandbox:
  workspace_root: "."              # raíz del jail de paths (SEC-3)
  deny_paths: [".pipeline/", "~/.claude/secrets/"]   # inaccesibles al adaptador
gates:                             # gates que el producto NO puede desactivar (SEC-6)
  require: ["qa", "review-humano-codeowners"]
```

> **Ejemplo de referencia completo (guideline G3 de UX):** el profile de Intrale debe entregarse como ejemplo comentado copiable-adaptable junto al contrato. Un contrato sin profile de referencia ejecutable se vuelve adivinanza para el autor del próximo producto.

### (b) Cómo el kernel lo descubre en runtime

1. El Pulpo/lanzador determina el **producto activo** (un solo producto por instancia de pipeline en la versión inicial).
2. Resuelve `stack-profile.{yaml,json}` desde la raíz del workspace del producto.
3. Valida el profile contra el schema del contrato (`profile_version`) **antes** de inyectarlo, produciendo mensajes accionables (campo + valor + por qué falla + cómo corregir, en español — guideline G1 de UX), no fallos crudos de shell.
4. Verifica `trust.integrity`/`trust.origin` (SEC-2) y registra qué profile/versión se resolvió (guideline G4 de UX: observabilidad, sin exponer valores de secretos).
5. Inyecta los `capabilities` como bindings a los verbos y los `context_docs` como contexto **no confiable** envuelto (SEC-4).

### (c) Cómo un producto nuevo aporta los suyos sin tocar el kernel

- El producto vive en su propio repo. Aporta **un** `stack-profile` + scripts referenciados (allowlisteados) + docs de contexto.
- El kernel **no** se modifica: el descubrimiento es por convención de path + schema. Migrar de Intrale a otro producto = cambiar el `stack-profile` apuntado, no editar el kernel.
- El skill genérico (`SKILL.md` del kernel) queda como **template + binding**: procedimiento agnóstico que invoca capabilities resueltas del profile activo. Los specifics que hoy están inline migran a referencias parametrizadas.

---

## 4. Semántica que no es config (CA-4)

No todo lo "específico de stack" es un string de comando. Hay **tres categorías** de specific, y el diseño debe clasificar cada uno para que el genérico **no quede vacío de valor** (decisión abierta #2 de guru).

| Categoría | Qué es | Dónde vive | Ejemplos del codebase |
|---|---|---|---|
| **config** | Valores declarativos: comandos, paths, nombres de módulos, targets | `stack-profile` (datos) | `JAVA_HOME`, `gradlew`, `docs/api/openapi.yaml`, mapeo módulo→tarea, flavors `client/business/delivery` |
| **plugin-código** | Lógica de stack que no se reduce a un string y necesita ejecutarse: traducción de un verbo a argv, parseo de output del stack, transitividad de build | Implementación del plugin (código del adaptador) | `smart-build.sh` (detección de módulos afectados + transitividad `backend/`→`:users:check`), parseo/clasificación de errores Gradle, validación de paths del flavor |
| **contexto-inyectable** | Conocimiento que guía el *juicio del modelo*, expresado como texto inyectado al prompt | `context_docs` del profile (dato **no confiable** — SEC-4) | patrón de error Do/Result, convención logging + statusCode, reglas de strings (`ResStrings`), convenciones de naming/test |

### Por qué el genérico NO queda vacío

El riesgo central es que toda la semántica migre al plugin y el kernel se vuelva un pasamanos sin valor. No es el caso: lo que queda en el kernel es **el cómo operativo, que es lo más difícil y lo que da el valor reutilizable**:

- **Orquestación y heurísticas de decisión** que son agnósticas de stack: *"leer el contrato antes de codear"* (SDD), *"escribir tests primero"* (TDD red→green), *"compilar hasta que pase"*, *"determinar scope afectado vs base"*. Estas son decisiones de **proceso**, no de stack — un producto Python o Go las necesita igual.
- **La heurística de elección de módulo** (bounded context / volumen / ciclo de vida — Paso 0.5 de backend-dev) es **conocimiento de arquitectura de software genérico** (Newman/Fowler), no de Kotlin. El plugin sólo aporta los nombres de módulos y el comando de scaffold; la decisión de *si* crear un módulo la toma el kernel.
- **El contrato de error, logging y reporte** son patrones de ingeniería que el kernel impone como forma; el plugin aporta la sintaxis concreta (Do/Result en Kotlin, o lo que sea en otro stack) vía contexto inyectable.
- **Los gates** (QA, review CODEOWNERS, validación de cobertura) son del kernel y **ningún plugin los desactiva** (SEC-6).

> **Criterio de aprobación (guru riesgo #2):** si esta sección estuviera ausente o fuera hand-wave, el doc no debería aprobarse. La clasificación config/código/contexto es la prueba de que el desacople tiene una línea defendible.

---

## 5. PoC en papel (CA-5)

Walkthrough sobre los dos skills propuestos, citando fragmentos reales del `SKILL.md` actual en HEAD.

### 5.1 `builder` (222 líneas)

**Hoy (inline en `.claude/skills/builder/SKILL.md`):**

```bash
# Paso 1 — Setup (línea 31)
export JAVA_HOME="/c/Users/Administrator/.jdks/temurin-21.0.7"

# Paso 2 — Build inteligente (líneas 48-50)
bash scripts/smart-build.sh 2>&1 | tail -80

# Módulo explícito (líneas 66-69)
# backend → :backend:check | users → :users:check | app → :app:composeApp:check | tools → :tools:forbidden-strings-processor:check

# Paso 3 — Verificaciones (líneas 92-106)
./gradlew verifyNoLegacyStrings
./gradlew :app:composeApp:validateComposeResources
./gradlew :app:composeApp:scanNonAsciiFallbacks
```

**Después del desacople:**

| Fragmento del SKILL actual | Destino | Categoría |
|---|---|---|
| Pre-flight `TaskCreate` + `metadata.steps` (líneas 22-26) | **Kernel** — genérico | proceso |
| "Determinar scope" / "compilar hasta que pase" (líneas 39-43, 13) | **Kernel** — genérico | proceso/heurística |
| Parseo y clasificación de errores syntax/import/type/resource/config (líneas 158-165) | **Kernel** — genérico | heurística (el plugin aporta el parser concreto del output) |
| Reporte final + veredicto (líneas 174-194) | **Kernel** — genérico | proceso |
| `JAVA_HOME=.../temurin-21.0.7` (línea 31) | **Plugin** | config (`env`) |
| `./gradlew`, mapeo módulo→tarea `:backend:check` etc. (líneas 60-69) | **Plugin** | config (`modules`) |
| `scripts/smart-build.sh` + transitividad `backend/`→`:users:check` (líneas 53-57) | **Plugin** | plugin-código (`build` capability) |
| `verifyNoLegacyStrings`, `validateComposeResources`, `scanNonAsciiFallbacks` (líneas 92-106) | **Plugin** | config (verificaciones del stack, parte del verbo `build` con `verify:true`) |
| Artefactos QA `:users:shadowJar` / `assembleClientDebug` (líneas 116-122) | **Plugin** | config (`package` capability) |

**`SKILL.md` genérico resultante (esbozo):** *"Registrá tareas. Invocá `build({scope: auto, verify: <flag>})`. Si falla, clasificá el error con el parser del plugin, leé el archivo:línea, proponé corrección. Si pasa e incluye módulos empaquetables, invocá `package`. Reportá veredicto."* — cero referencias a Gradle/Java/Kotlin.

### 5.2 `backend-dev` (279 líneas)

**Hoy (inline en `.claude/skills/backend-dev/SKILL.md`):**

```bash
# Paso 0 — SDD (líneas 36-39)
bash .pipeline/scripts-backend/openapi-show-endpoint.sh /signin
cat docs/api/openapi.yaml

# Paso 0.5 — módulos :backend / :users; scaffold (líneas 50-78)
bash .pipeline/scripts-backend/scaffold-module.sh <module-name>

# Paso 4/6 — TDD (líneas 116-120, 158-161)
bash .pipeline/scripts-backend/backend-test.sh

# Registro DI (línea 144)
bindSingleton<Function>(tag = "mi-funcion") { MiFunction(instance()) }
```

**Después del desacople:**

| Fragmento del SKILL actual | Destino | Categoría |
|---|---|---|
| Pre-flight tasks (líneas 24-28) | **Kernel** | proceso |
| "Leer la spec antes de codear" (SDD, Paso 0) | **Kernel** — el *cómo*; el *qué* (OpenAPI en `docs/api/openapi.yaml`) es plugin | proceso + config |
| Heurística de módulo: bounded context / volumen / ciclo de vida (líneas 57-79) | **Kernel** | heurística de arquitectura genérica |
| TDD red→green (Pasos 4-6) | **Kernel** | proceso |
| Patrón de error, logging + statusCode, naming de tests (líneas 240-246) | **Contexto-inyectable** | conocimiento de stack que guía juicio del modelo |
| `openapi-show-endpoint.sh` + `docs/api/openapi.yaml` (líneas 36-39) | **Plugin** | config (`read-contract`, `contract_ref`) |
| Módulos `:backend`/`:users`, target Lambda `kotlinTest` (líneas 52-54) | **Plugin** | config (`modules`, `deploy.target`) |
| Ktor / DynamoDB / Cognito / `SecuredFunction`/JWT | **Plugin** | mezcla: nombres → config; el código que los usa → plugin-código; las convenciones → contexto-inyectable |
| `scaffold-module.sh` (línea 76) | **Plugin** | plugin-código (`scaffold-module` capability) |
| Registro DI Kodein `bindSingleton<Function>(tag=...)` (línea 144) | **Contexto-inyectable** | convención del stack que el modelo debe seguir |
| Scripts `backend-test.sh`/`backend-verify.sh`/`users-shadow-jar.sh` | **Plugin** | config (`test`/`package` capabilities) |

**Observación clave del PoC:** en `backend-dev`, la **heurística de elección de módulo** (Paso 0.5) es el mejor ejemplo de CA-4: parece "específica de Intrale" pero es **arquitectura de software genérica** (cuándo separar un bounded context). Sólo los *nombres* (`:backend`, `:users`) y el *comando de scaffold* son plugin; la decisión es kernel. Esto demuestra que el genérico no queda vacío.

### 5.3 `ux` (1183 líneas) — tercer caso (opcional-recomendado)

Caso más cargado: mezcla proceso de diseño genérico (research → benchmark → propuesta → validar render vs mockup, líneas 354-413, 555+) con specifics de stack (Material Design 3 + Compose Multiplatform como target, Figma MCP, `ux-mockup-generator.js`). **Genérico:** el proceso de diseño, la heurística de accesibilidad, la generación de mockup, el veredicto pasa/rechaza. **Plugin:** MD3/HIG platform-adaptive, que el target de implementación sea Compose, el design-system y branding del producto. Confirma que el patrón escala incluso al skill más grande y mezclado.

---

## 6. Requisitos de seguridad (CA-6)

Los 6 vectores del análisis de `security` se incorporan como **requisitos no-negociables de primer orden** del contrato de capability. El modelo mueve la superficie de ataque de *código del producto* a *config del producto*; esto es exactamente lo que hay que blindar.

### SEC-1 · Ejecución de comandos por configuración (RCE) — CRÍTICO *(OWASP A03 Injection)*
Un `stack-profile` que declara comandos = shell potencialmente arbitrario con los permisos del pipeline.
- **Requisito:** la ejecución de capabilities usa **arrays argv allowlisteados** (`["gradlew", ":backend:check"]`), **nunca** `sh -c "<string del profile>"` ni concatenación libre de strings al shell. Set cerrado de verbos cuyos argumentos se validan contra el schema.
- **Requisito:** el profile vive en repo con revisión humana; nunca se ejecuta desde fuente no confiable sin gate.

### SEC-2 · Cadena de suministro de plugins — ALTO *(OWASP A08 Integrity Failures)*
El descubrimiento es carga dinámica de capacidades.
- **Requisito:** trust boundary explícito kernel↔adaptador. Origen confiable declarado (`trust.origin`), verificación de integridad (`trust.integrity`: hash/firma) del profile y de cualquier plugin-código, pin de versión. El **catálogo curado de stacks es también un control de seguridad** (decisión abierta #3), no sólo de capacidad: define quién puede registrar un stack ejecutable.

### SEC-3 · Path traversal y exfiltración vía paths del profile — ALTO *(OWASP A01/A05)*
El profile aporta paths.
- **Requisito:** sandbox/jail — todo path del profile se resuelve y valida que cae dentro de `sandbox.workspace_root`. Prohibir rutas absolutas a directorios sensibles y `..` que escape la raíz. `.pipeline/` de Intrale y `~/.claude/secrets/` **inaccesibles** al adaptador (`sandbox.deny_paths`).

### SEC-4 · Prompt injection vía contexto inyectable por-producto — ALTO *(específico de agentes LLM)*
Los `context_docs`/`CLAUDE.md` parametrizado se inyectan al prompt en runtime: canal de prompt injection de segundo orden.
- **Requisito:** tratar el contexto por-producto como **dato no confiable**, nunca como instrucción. **Reusar el patrón de #2993** ya implementado en `.pipeline/lib/handoff.js` (`detectInjection` + `redact` vía `lib/redact.js`): envoltura `<...>`, sanitización de patrones de inyección (`ignore previous`, `nuevas instrucciones`), límites de tamaño, no-autoritativo. El contexto describe el stack; no puede redefinir el procedimiento del kernel ni los gates de seguridad.

### SEC-5 · Secretos en profiles/config — MEDIO *(OWASP A07 / Hardcoded secrets)*
Targets de deploy y credenciales AWS/Cognito tienden a filtrarse a config versionada.
- **Requisito:** el contrato separa **referencias a secretos** (`secret_ref: "aws.kotlinTest"`) de **valores**. Prohibido poner valores de secretos en el profile; se resuelven en runtime desde el store unificado (`~/.claude/secrets/credentials.json` vía `.pipeline/lib/credentials.js`).

### SEC-6 · Erosión de los gates al "genericizar" — MEDIO
Si lógica con implicancias de seguridad migra a plugins por-stack, un stack nuevo podría omitir controles obligatorios.
- **Requisito:** el kernel impone un **conjunto mínimo no-negociable de gates** (`gates.require`) que ningún plugin desactiva: auth obligatorio en endpoints protegidos, validación de input, no-secrets-hardcoded, QA E2E, review CODEOWNERS. Las capabilities `deploy` y `read-contract` pasan por el gate de seguridad del **kernel**, no del plugin.

---

## 7. Riesgos y decisiones abiertas (CA-7)

| # | Decisión / Riesgo | Opciones en juego | Recomendación |
|---|---|---|---|
| 1 | **Granularidad del contrato** | (a) verbos finos por sub-acción; (b) set medio operativo (el de §2); (c) verbo único | **(b)** — 7 verbos al nivel "acción que una fase invoca". Validado por el mapeo fase→verbos. |
| 2 | **Semántica que no es config** | (a) todo a config; (b) clasificar config/plugin-código/contexto (§4); (c) todo al plugin | **(b)** — la clasificación de §4 es la línea defendible; evita el "genérico vacío". |
| 3 | **Catálogo curado de stacks** | (a) auto-servicio abierto; (b) curado con revisión humana | **(b)** — cada stack ejecutable es superficie de RCE (SEC-1/SEC-2). El catálogo es control de seguridad. Acotar el catálogo inicial (costo alto: cada stack = dev+builder+qa+gates completos). |
| 4 | **Modelo de ejecución de comandos** | (a) `sh -c` parametrizado; (b) argv-allowlist; (c) verbos cerrados con args validados | **(c) sobre (b)** — define si SEC-1 es contenible. Descartar (a). |
| 5 | **Aislamiento de ejecución** | (a) sólo validación de paths; (b) sandbox real (contenedor/usuario restringido) | Abierta para Ola 9 — empezar con (a) + `deny_paths`, evaluar (b) según riesgo del catálogo. |
| 6 | **Conocimiento de stack: prompt vs tooling** | qué se externaliza como contexto inyectable vs qué queda como juicio del modelo | El juicio sobre el framework no se parametriza trivialmente; definir en Ola 9 el límite exacto de qué va a `context_docs`. |
| 7 | **`ux` como caso límite** | el skill más grande mezcla proceso y stack | PoC adicional ya cubierto en §5.3; tratar como caso de validación del modelo en Ola 9. |

---

## 8. Backlog de Ola 9 (CA-8)

Work-items derivados, con alcance claro. **Ninguno lleva label de admisión (`needs-definition`/`Ready`) hasta el gate humano de la Ola 9.**

| ID | Título propuesto | Alcance | Depende de |
|---|---|---|---|
| OLA9-C1 | Definir el schema formal del `stack-profile` v1 | Schema versionado (`profile_version`), validador con mensajes accionables en español (G1), ejemplo de referencia Intrale comentado (G3) | §3 |
| OLA9-C2 | Implementar el runtime de capabilities con ejecución argv-allowlist | Resolver verbos → argv, set cerrado, validación de args (SEC-1/decisión #4) | §2, SEC-1 |
| OLA9-C3 | Implementar el sandbox de paths del adaptador | Jail sobre `workspace_root`, `deny_paths`, bloqueo de `..`/rutas absolutas sensibles (SEC-3) | §3 |
| OLA9-C4 | Reusar anti-injection #2993 para `context_docs` | Wrapper + `detectInjection`/`redact` sobre contexto por-producto (SEC-4) | `lib/handoff.js` |
| OLA9-C5 | Resolución de secretos por referencia | `secret_ref` → `credentials.js`, prohibición de valores en profile (SEC-5) | §3, SEC-5 |
| OLA9-C6 | Trust boundary + integridad del profile/plugin | `trust.origin`/`trust.integrity`, pin de versión, catálogo curado (SEC-2/decisión #3) | §6 |
| OLA9-C7 | Gates mínimos no-desactivables en el kernel | `gates.require` impuesto por kernel; deploy/read-contract por gate del kernel (SEC-6) | §6 |
| OLA9-C8 | Migrar `SKILL.md` de `builder` y `backend-dev` a template + binding | Extraer specifics al profile, dejar procedimiento agnóstico (PoC §5 como guía) | OLA9-C1..C2 |
| OLA9-C9 | Observabilidad de ejecución parametrizada | Registrar profile/versión resuelta y comando concreto (sin valores de secretos) en `metadata.steps`/`/monitor` (G4) | OLA9-C2 |

---

## 9. Restricción transversal (CA-9)

- El **kernel operativo se construye al lado, en un repo nuevo**. El `.pipeline/` de Intrale y los `.claude/skills/*` actuales **no se tocan** — ni en esta épica de definición ni en su entregable.
- Este documento es el **único archivo** que la épica escribe (bajo `docs/`). Los 6 `SKILL.md`, `config.yaml` y el lanzador del Pulpo son **material de sólo lectura**.
- Ningún criterio de esta épica habilita modificar el pipeline en producción. La migración real de los skills (OLA9-C8) ocurre en el repo del kernel nuevo, con su propio gate humano de Ola 9.

---

## Trazabilidad de criterios

| CA | Sección |
|---|---|
| CA-0 (doc existe y versionado) | Este archivo · §0 |
| CA-1 (frontera, ≥6 filas) | §1 |
| CA-2 (contrato de verbos + granularidad) | §2 |
| CA-3 (descubrimiento y aporte) | §3 |
| CA-4 (semántica que no es config) | §4 |
| CA-5 (PoC builder + backend-dev) | §5 |
| CA-6 (SEC-1..SEC-6) | §6 |
| CA-7 (riesgos y decisiones abiertas) | §7 |
| CA-8 (backlog Ola 9) | §8 |
| CA-9 (cero impacto `.pipeline/`) | §0, §9 |

> Documento de definición producido por el agente `pipeline-dev` para la épica EP-OLA8-C ([#4011](https://github.com/intrale/platform/issues/4011)).
