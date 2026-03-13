# Stack, Versiones y Comandos de Build

## Stack y versiones

| Componente | Versión |
|------------|---------|
| Kotlin | 2.2.21 |
| Java | 21 (toolchain obligatorio) |
| Compose Multiplatform | 1.8.2 |
| Ktor (backend) | 2.3.9 |
| Ktor (app client) | 3.0.0-wasm2 |
| Kodein DI | 7.22.0 |
| Konform | 0.6.1 |
| kotlin-test + MockK | MockK 1.13.10 |
| kotlinx-coroutines-test | (incluido en Kotlin stdlib) |
| AWS SDK Java | 2.25.28 |
| Cognito Kotlin | 1.2.28 |

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

## Java Home (entorno local Windows)

```bash
export JAVA_HOME="/c/Users/Administrator/.jdks/temurin-21.0.7"
```
