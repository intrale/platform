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
./gradlew :app:composeApp:installDebug                 # App Android
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
| Codex (bots)   | `codex/<issue>-<slug>`           | `origin/main`  |
| Feature manual | `feature/<desc>`                 | `develop`      |
| Bugfix manual  | `bugfix/<desc>`                  | `develop`      |
| Docs manual    | `docs/<desc>`                    | `develop`      |
| Refactor       | `refactor/<desc>`                | `develop`      |

- PR title: descriptivo y conciso
- Body: detalles técnicos + `Closes #<n>`
- Asignar a: `leitolarreta`
- NO auto-merge

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
