# Intrale Platform

Monorepo Kotlin que integra un backend modular con [Ktor](https://ktor.io/) y una aplicación multiplataforma construida con [Compose Multiplatform](https://www.jetbrains.com/compose-multiplatform/). El proyecto se organiza en tres módulos principales:

- **`backend/`** — Núcleo del servidor HTTP y runtime serverless. Provee la infraestructura común (enrutamiento dinámico, inyección de dependencias con Kodein, validación JWT con AWS Cognito) que los módulos de negocio extienden. Soporta ejecución embebida con Netty y despliegue en AWS Lambda.
- **`users/`** — Módulo de negocio que extiende `backend/`. Implementa gestión de usuarios, perfiles, autenticación, recuperación de contraseña y verificación en dos pasos (2FA), respaldado por AWS Cognito y DynamoDB.
- **`app/composeApp/`** — Cliente Compose Multiplatform con código compartido entre Android, iOS, escritorio (JVM) y web (Kotlin/Wasm). Incluye lógica de negocio (`asdo/`), acceso a servicios externos (`ext/`) y la interfaz de usuario (`ui/`).

Para detalles técnicos de cada módulo consultar:
- [Arquitectura del backend](docs/arquitectura-backend.md)
- [Arquitectura de la app](docs/arquitectura-app.md)
- [Arquitectura de users](docs/arquitectura-users.md)

## Prerequisitos

| Herramienta | Versión | Notas |
|---|---|---|
| **JDK** | 21 | Configurado como toolchain obligatorio en los módulos `backend/` y `users/`. |
| **Kotlin** | 2.2.21 | Definido en `gradle.properties`. |
| **Gradle** | 8.13 | Distribuido vía wrapper (`gradle/wrapper/gradle-wrapper.properties`); no requiere instalación manual. |
| **Android Studio / SDK** | API 34, Build Tools 34.0.0 | Necesario para compilar y ejecutar la app Android. El script `init.sh` automatiza la instalación del SDK y la aceptación de licencias. |
| **Node.js** | 18+ | Requerido para tareas de desarrollo web Wasm (`wasmJsBrowserDevelopmentRun`). |
| **Xcode** | Última versión estable | Solo para compilación y ejecución en iOS. Requiere simuladores configurados. |
| **GITHUB_TOKEN** | — | Token de acceso a GitHub. Validado por `init.sh` al preparar el entorno. |

## Inicio rápido

### 1. Clonar y preparar el entorno

```bash
git clone https://github.com/intrale/platform.git
cd platform
```

Para entornos automatizados (Codex, CI) el script `init.sh` instala el Android SDK y valida el token de GitHub:

```bash
./init.sh
```

### 2. Configurar variables de entorno

El módulo `users/` requiere variables de AWS para conectarse a Cognito y DynamoDB. Pueden definirse en el entorno o en `users/src/main/resources/application.conf`:

| Variable | Descripción |
|---|---|
| `AVAILABLE_BUISNESS` | Negocios habilitados (separados por comas). |
| `REGION_VALUE` | Región AWS. |
| `ACCESS_KEY_ID` | Clave de acceso AWS. |
| `SECRET_ACCESS_KEY` | Clave secreta AWS. |
| `USER_POOL_ID` | Pool de usuarios en Cognito. |
| `CLIENT_ID` | Aplicación en Cognito. |

Referencia completa en [docs/variables-entorno.md](docs/variables-entorno.md).

### 3. Ejecutar el backend

```bash
./gradlew :backend:run
```

Inicia el servidor Netty en modo embebido. Endpoints disponibles:

- `GET /health` — Health check del servicio.
- `POST /{business}/{function}` — Ruta dinámica que canaliza todas las operaciones de negocio. El parámetro `business` identifica al negocio y `function` a la operación registrada (por ejemplo `signin`, `signup`, `changePassword`).

### 4. Ejecutar el módulo users

```bash
./gradlew :users:run
```

Levanta la misma infraestructura del backend pero con las funciones de negocio de usuarios registradas (registro, login, 2FA, perfiles, etc.). Requiere que las variables de entorno estén configuradas.

### 5. Ejecutar la app Compose Multiplatform

Cada plataforma tiene su propio comando y prerequisitos:

| Plataforma | Comando | Prerequisitos |
|---|---|---|
| **Android** | `./gradlew :app:composeApp:installDebug` | Android SDK (API 34), dispositivo o emulador conectado. |
| **Escritorio (JVM)** | `./gradlew :app:composeApp:run` | Solo JDK 21. |
| **Web (Wasm)** | `./gradlew :app:composeApp:wasmJsBrowserDevelopmentRun` | Node.js 18+. |
| **iOS** | `./gradlew :app:composeApp:linkDebugFrameworkIosX64` | Xcode con simuladores. Abrir `app/iosApp` en Xcode para ejecutar. |

## Estructura del repositorio

```
platform/
├── backend/              # Servidor HTTP Ktor, runtime serverless (Netty + Lambda)
├── users/                # Módulo de negocio: usuarios, perfiles, 2FA (extiende backend/)
├── app/
│   └── composeApp/       # Cliente Compose Multiplatform
│       └── src/
│           ├── commonMain/    # Código compartido (asdo/, ext/, ui/)
│           ├── androidMain/   # Implementaciones Android
│           ├── iosMain/       # Implementaciones iOS
│           ├── desktopMain/   # Implementaciones JVM
│           └── wasmJsMain/    # Implementaciones Web
├── buildSrc/             # Plugins y tareas Gradle custom
├── tools/                # Procesadores KSP (forbidden-strings-processor)
├── agents/               # Reglas y documentación para agentes automatizados
├── docs/                 # Documentación técnica del proyecto
│   └── engineering/      # Guías de ingeniería (strings, testing, E2E)
└── gradle/               # Wrapper y catálogo de dependencias
```

### Relación entre módulos

- **`backend/`** define la infraestructura base: enrutamiento dinámico, seguridad JWT, serialización y contratos (`Function`, `SecuredFunction`, `Response`). No contiene lógica de negocio.
- **`users/`** depende de `backend/` y registra sus funciones de negocio en Kodein DI con tags que mapean a la ruta `/{business}/{function}`. Comparte el mismo flujo de arranque tanto para ejecución local como en AWS Lambda.
- **`app/composeApp/`** es independiente del backend en compilación pero consume sus APIs en runtime. La capa `ext/` contiene los clientes HTTP que se comunican con los endpoints del backend.
- **`buildSrc/`** aporta plugins Gradle compartidos por todos los módulos (verificación de strings legacy, validación de recursos, etc.).
- **`tools/`** contiene el procesador KSP `forbidden-strings-processor` que bloquea usos de `stringResource(...)`, `Res.string.*` y otros patrones legacy en tiempo de compilación.

## Flujo de desarrollo

### Build completo

```bash
./gradlew clean build
```

Ejecuta compilación, tests y todas las verificaciones (strings legacy, recursos, etc.).

### Tests por módulo

```bash
./gradlew :backend:test
./gradlew :users:test
./gradlew :app:composeApp:test
```

### Verificaciones de calidad

```bash
# Verificar que no existan usos legacy de string resources
./gradlew verifyNoLegacyStrings

# Validar resource packs de Compose
./gradlew :app:composeApp:validateComposeResources

# Verificar fallbacks ASCII-safe
./gradlew :app:composeApp:scanNonAsciiFallbacks
```

Estas tareas también se ejecutan automáticamente como parte de `./gradlew build` y `./gradlew check`.

### Convenciones de código

- **Nombres en inglés**, comentarios y documentación en español.
- **Tests**: nombres descriptivos en español con backticks (`` `login actualiza el estado correctamente` ``).
- **Strings UI**: usar siempre `resString(...)` con fallback ASCII-safe. Ver [docs/engineering/strings.md](docs/engineering/strings.md).
- **Logging**: obligatorio en toda clase con `LoggerFactory`. Ver [docs/codex-reglas-loggers-statuscode.md](docs/codex-reglas-loggers-statuscode.md).
- **Manejo de errores**: patrón `Result<T>` en la capa `Do`. Ver [docs/manejo-errores-do.md](docs/manejo-errores-do.md).

### Ramas y pull requests

| Contexto | Formato de rama | Base |
|---|---|---|
| Codex (bots) | `codex/<issue>-<slug>` | `origin/main` |
| Feature manual | `feature/<desc>` | `develop` |
| Bugfix manual | `bugfix/<desc>` | `develop` |
| Docs manual | `docs/<desc>` | `develop` |
| Refactor | `refactor/<desc>` | `develop` |

## Recursos adicionales

- [Arquitectura del backend](docs/arquitectura-backend.md) — Flujo de arranque, ruta dinámica, contratos y ejecución serverless.
- [Arquitectura de la app](docs/arquitectura-app.md) — Capas del frontend, inyección de dependencias, navegación y ViewModels.
- [Arquitectura de users](docs/arquitectura-users.md) — Funciones de negocio, perfiles y seguridad del módulo de usuarios.
- [Variables de entorno](docs/variables-entorno.md) — Configuración requerida por cada módulo.
- [Sistema de strings](docs/engineering/strings.md) — Lineamientos para el manejo de strings multiplataforma.
- [Manejo de errores Do](docs/manejo-errores-do.md) — Patrón obligatorio de errores en la capa de negocio.
- [Reglas de logging y status codes](docs/codex-reglas-loggers-statuscode.md) — Estándares de logging y códigos de respuesta.
- [Buenas prácticas de recursos](docs/buenas-practicas-recursos.md) — Lineamientos para recursos Compose.
- [Testing](docs/engineering/testing.md) — Convenciones y herramientas de testing.
- [Tests E2E](docs/engineering/e2e-tests.md) — Guía para pruebas end-to-end.
- [`init.sh`](init.sh) — Script de preparación del entorno (Android SDK + validación de GitHub token).
