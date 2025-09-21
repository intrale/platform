# platform

Plataforma base de Intrale que reúne los módulos principales para el backend y la aplicación multiplataforma construida con Kotlin.

## Introducción
Este proyecto se organiza como un monorepo con arquitectura modular. Incluye servicios de backend escritos en Ktor y una aplicación basada en **Compose Multiplatform** que comparte la mayor parte de la lógica entre Android, iOS, escritorio (JVM) y web (Wasm). Para una visión detallada de cada capa, consulta `docs/arquitectura-app.md` y `docs/arquitectura-backend.md`.

## Inicio rápido
1. Clonar el repositorio:
   ```bash
   git clone https://github.com/intrale/platform.git
   cd platform
   ```
2. Ejecutar el módulo `backend` en modo embebido:
   ```bash
   ./gradlew :backend:run
   ```
3. Construir la aplicación `app` según el target requerido:
   - **Android**: instala el paquete de depuración en un dispositivo o emulador con `./gradlew :app:composeApp:installDebug`.
   - **Escritorio (JVM)**: levanta la versión de escritorio con `./gradlew :app:composeApp:run`.
   - **Web (Wasm)**: inicia el servidor de desarrollo con `./gradlew :app:composeApp:wasmJsBrowserDevelopmentRun`.
   - **iOS**: genera el framework para simulador con `./gradlew :app:composeApp:linkDebugFrameworkIosX64` y ábrelo desde `app/iosApp` en Xcode.

## Estructura de carpetas
- `backend/` - infraestructura y lógica común del servidor HTTP y el runtime serverless.
- `users/` - extensiones de negocio para gestión de usuarios, perfiles y 2FA.
- `app/` - cliente Compose Multiplatform con código compartido y targets específicos.
- `docs/` - documentación técnica de la plataforma.
- `gradle/` y archivos `*.gradle.kts` - configuración de construcción y catálogo de dependencias.
