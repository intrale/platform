# CLAUDE.md — Intrale Platform

## Proyecto

Monorepo Kotlin: backend Ktor + app Compose Multiplatform (Android, iOS, Desktop/JVM, Web/Wasm).

## Stack y versiones

- **Kotlin** 2.2.21 | **Java** 21 (toolchain obligatorio)
- **Ktor** 2.3.9 (backend), 3.0.0-wasm2 (app client)
- **Compose Multiplatform** 1.8.2
- **DI**: Kodein 7.22.0 | **Validación**: Konform 0.6.1
- **Testing**: kotlin-test + MockK 1.13.10 + kotlinx-coroutines-test
- **AWS**: SDK Java 2.25.28, Cognito Kotlin 1.2.28

## Estructura de módulos

```
platform/
├── backend/          # Servidor HTTP Ktor, runtime serverless
├── users/            # Extensión: usuarios, perfiles, 2FA (depende de backend)
├── app/composeApp/   # Frontend multiplataforma
├── tools/            # forbidden-strings-processor (KSP)
├── buildSrc/         # Plugins y tareas Gradle custom
├── docs/             # Documentación técnica
└── agents/           # Reglas para agentes automatizados
```

## Comandos de build esenciales

```bash
./gradlew clean build                # Build completo con todas las verificaciones
./gradlew check                      # Tests + verificaciones
./gradlew :backend:run               # Levantar backend embebido
./gradlew :app:composeApp:run        # App escritorio (JVM)
./gradlew :app:composeApp:wasmJsBrowserDevelopmentRun  # App web (Wasm)
./gradlew :app:composeApp:installDebug                 # App Android (flavor client)
./gradlew :app:composeApp:assembleBusinessDebug        # APK Intrale Negocios (APP_TYPE=BUSINESS)
./gradlew :app:composeApp:assembleDeliveryDebug        # APK Intrale Repartos (APP_TYPE=DELIVERY)
./gradlew :users:shadowJar           # JAR para Lambda AWS
./gradlew verifyNoLegacyStrings      # Verificar strings legacy
./gradlew :app:composeApp:validateComposeResources     # Validar resource packs
./gradlew :app:composeApp:scanNonAsciiFallbacks        # Verificar fallbacks ASCII
```

## Arquitectura del App (capas)

### `asdo/` — Lógica de negocio (acciones)
- Interfaz: `ToDo[Action]` (ej: `ToDoLogin`)
- Implementación: `Do[Action]` (ej: `DoLogin`)
- Resultado: `Do[Action]Result` / Excepción: `Do[Action]Exception`

### `ext/` — Servicios externos
- Interfaz: `Comm[Service]` (ej: `CommLoginService`)
- Implementación: `Client[Service]` (ej: `ClientLoginService`)

### `ui/` — Interfaz de usuario
- `cp/` componentes, `ro/` router/navegación, `sc/` pantallas y ViewModels, `th/` tema

### Patrón de error en Do (obligatorio)
```kotlin
override suspend fun execute(...): Result<DoXXXResult> {
    return try {
        service.execute(...)
            .mapCatching { it.toDoXXXResult() }
            .recoverCatching { e ->
                throw (e as? ExceptionResponse)?.toDoXXXException()
                    ?: e.toDoXXXException()
            }
    } catch (e: Exception) {
        Result.failure(e.toDoXXXException())
    }
}
```

### ViewModels
- Extienden `androidx.lifecycle.ViewModel`
- Estado: `var state by mutableStateOf([Feature]UIState())`
- Validación con Konform DSL
- UI state como data class anidada: `[Feature]UIState`

## Arquitectura del Backend

- Ruta dinámica: `/{business}/{function...}`
- Funciones implementan `Function` o `SecuredFunction` (JWT via Cognito)
- Se registran en Kodein con tag: `bindSingleton<Function>(tag = "signin") { SignIn(...) }`
- Respuestas extienden `Response` con `statusCode: HttpStatusCode`

## Reglas de strings (CRITICO)

**NUNCA usar directamente:**
- `stringResource(...)` fuera de `ui/util/ResStrings`
- `Res.string.*`, `R.string.*`, `getString(...)`
- El KSP processor bloquea la compilación si se detectan

**Siempre usar:**
```kotlin
resString(
    androidId = androidStringId("clave"),
    composeId = clave,
    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Texto sin tildes ni especiales"),
)
```
- Fallback DEBE ser ASCII-safe (usar helper `fb(...)`)
- Prefijo `RES_ERROR_PREFIX` en fallbacks visibles
- NO importar `kotlin.io.encoding.Base64` en capa UI

## Logging (obligatorio en toda clase)

**Backend:**
```kotlin
val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
```

**App:**
```kotlin
private val logger = LoggerFactory.default.newLogger<NombreClase>()
```

Todas las respuestas de servicio deben incluir `statusCode` con valor numérico y descripción.

## Testing

- Framework: kotlin-test + MockK + runTest
- Nombres de test: backtick descriptivo en español
  ```kotlin
  @Test
  fun `loadProfile actualiza el estado con los datos del caso de uso`() = runTest { ... }
  ```
- Fakes: prefijo `Fake[Interface]` (ej: `FakeGetProfile`)
- NUNCA saltar tests (`-x test`, `--exclude-task test`)
- Verificación obligatoria antes de marcar Ready

## Ramas y PRs

| Contexto       | Formato                          | Base           |
|----------------|----------------------------------|----------------|
| Agentes IA     | `agent/<issue>-<slug>`           | `origin/main`  |
| Feature manual | `feature/<desc>`                 | `develop`      |
| Bugfix manual  | `bugfix/<desc>`                  | `develop`      |
| Docs manual    | `docs/<desc>`                    | `develop`      |
| Refactor       | `refactor/<desc>`                | `develop`      |

- PR title: descriptivo y conciso
- Body: detalles técnicos + `Closes #<n>`
- Asignar a: `leitolarreta`
- NO auto-merge

## Gate de QA obligatorio antes de merge (CRITICO)

**NUNCA** mergear un PR a `main` sin completar el ciclo de validación:

```
QA E2E (/qa) → Tester cobertura (/tester) → PO acceptance (/po validar)
```

### Labels requeridos antes de merge

| Label | Significado | Quién lo asigna |
|-------|-------------|-----------------|
| `qa:passed` | QA E2E ejecutado con evidencia de video | Agente /qa |
| `qa:skipped` | Cambio puro de infra/hooks sin impacto en producto de usuario | Dev + justificación escrita |

**NUNCA** mergear con label `qa:pending`.

**NUNCA** marcar una tarea o issue como `completed` sin QA E2E + evidencia. Si falta validación → escalar a `/qa`, `/tester` y `/po` hasta resolución.

### Tipos de issue y criterio QA

| Tipo | Labels indicativos | Gate requerido |
|------|--------------------|----------------|
| Feature / Enhancement con UI | `app:client`, `app:business`, `app:delivery` | QA E2E con video obligatorio |
| Feature backend (API/endpoint) | `area:backend` | QA E2E API obligatorio |
| Bug con impacto en usuario | `bug` + cualquier `app:*` | QA E2E obligatorio |
| Infra / hooks internos | `area:infra`, `tipo:infra` sin `app:*` | `qa:skipped` con justificación |
| Documentación pura | `docs` | `qa:skipped` con justificación |

### Protocolo cuando QA/Tester/PO encuentran defectos

1. QA reporta defecto → issue `qa:failed`
2. Developer corrige (`/backend-dev`, `/android-dev`, etc.)
3. Re-ejecutar ciclo completo: QA → Tester → PO
4. Solo cuando todos aprueban → `qa:passed` → merge

### Verificación antes de /delivery

Antes de invocar `/delivery`, el agente DEBE verificar:
```bash
export PATH="/c/Workspaces/gh-cli/bin:$PATH"
gh pr view --json labels --jq '.labels[].name' | grep -E "qa:passed|qa:skipped"
```
Si no existe ninguno de los dos labels → **BLOQUEAR merge** y escalar a `/qa`.

## Lanzamiento de agentes (CRITICO)

**SIEMPRE** lanzar agentes de sprint via `Start-Agente.ps1`. **NUNCA** crear worktrees manualmente ni lanzar `claude -p` directo.

```bash
# Lanzar todos los agentes del sprint
powershell.exe -NonInteractive -File scripts/Start-Agente.ps1 all

# Lanzar un agente específico
powershell.exe -NonInteractive -File scripts/Start-Agente.ps1 1

# Relanzar con worktree limpio
powershell.exe -NonInteractive -File scripts/Start-Agente.ps1 1 -Force
```

`Start-Agente.ps1` garantiza:
- Worktree aislado con `.claude/` copiado
- `Run-AgentStream.ps1` con stream-json parsing
- Pipeline post-Claude automático (tests → security → build → delivery)
- `agent-watcher.js` monitoreando agentes muertos y promoviendo de cola
- Logs en `scripts/logs/agente_N.log` con diagnóstico de muerte

**Prohibido:** crear worktrees con `git worktree add` + lanzar `claude` manualmente. Esto bypasea el pipeline post-Claude y los agentes mueren sin hacer delivery.

## Protocolo de tareas (obligatorio en toda implementación)

**Concurrencia de agentes:** máximo **3 agentes simultáneos** por sprint. El hook `agent-concurrency-check.js` (Stop event) valida el límite automáticamente y lanza el siguiente agente de la cola cuando se libera un slot.

Todo agente que implementa un issue DEBE:

1. **Verificar worktree**: confirmar que se trabaja en una rama `agent/*`, `feature/*` o `bugfix/*` — nunca en `main` ni `develop` directamente. El hook `worktree-guard.js` alerta vía Telegram si detecta escritura de código en rama protegida.
2. **Antes de codear**: crear las tareas con `TaskCreate` que mapeen los pasos del plan
3. **Al empezar cada paso**: marcar la tarea como `in_progress` con `TaskUpdate`
4. **Al terminar cada paso**: marcar la tarea como `completed` con `TaskUpdate`

Las tareas deben coincidir con los cambios reales del issue. El `/monitor` muestra el avance con checkboxes (`☐`/`☐►`/`☑`) en tiempo real.

### Sub-pasos y progreso (convención `metadata.steps`)

Cuando una tarea tiene pasos internos verificables, codificarlos en `metadata` para dar visibilidad granular:

**Al crear la tarea:**
```
TaskCreate(
  subject: "Reescribir qa-android.sh",
  activeForm: "Reescribiendo qa-android.sh…",
  metadata: {
    "steps": ["Configurar JAVA_HOME", "Agregar emulador auto", "Integrar screenrecord", "Cleanup"]
  }
)
```

**Al avanzar sub-pasos:**
```
TaskUpdate(
  taskId: "1",
  activeForm: "Reescribiendo qa-android.sh (2/4 · 50%)…",
  metadata: { "current_step": 2, "completed_steps": ["Configurar JAVA_HOME", "Agregar emulador auto"] }
)
```

**Al completar:**
```
TaskUpdate(taskId: "1", status: "completed")
```

- El `activeForm` DEBE incluir el progreso `(N/M · X%)` cuando hay sub-pasos
- Los `steps` deben ser strings cortos (< 80 chars)
- El hook `activity-logger.js` calcula `progress` automáticamente y lo persiste en la sesión
- El `/monitor` muestra barra de progreso ASCII y sub-pasos `✓`/`►`/`○` cuando están disponibles

## Android: Product Flavors

- `client` — `com.intrale.app.client[.slug]`
- `business` — `com.intrale.app.business` ("Intrale Negocios")
- `delivery` — `com.intrale.app.delivery` ("Intrale Repartos")

Dimensión compartida: `appType`

## CI/CD

- GitHub Actions en push a `main`
- Java 21 (Temurin) + Gradle
- Build completo con TODAS las verificaciones
- Deploy: `users-all.jar` → AWS Lambda `kotlinTest`
- Secrets inyectados en `users/src/main/resources/application.conf`

## Documentación

- Ubicación exclusiva: `docs/` del repo
- NO modificar `agents.md` salvo que un issue lo requiera
- Docs relevantes:
  - `docs/arquitectura-app.md` — Arquitectura frontend
  - `docs/arquitectura-backend.md` — Arquitectura backend
  - `docs/engineering/strings.md` — Sistema de strings
  - `docs/manejo-errores-do.md` — Patrón de errores
  - `docs/codex-reglas-loggers-statuscode.md` — Reglas de logging
  - `docs/buenas-practicas-recursos.md` — Recursos Compose

## Idioma

- Código: nombres en inglés
- Comentarios, docs, mensajes de validación: español
- Tests: nombres descriptivos en español (backtick)
