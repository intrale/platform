# Normalizar la generación de recursos en ComposeApp

Relacionado con #267.

## 🎯 Objetivo
- Restablecer la compilación multiplataforma corrigiendo los archivos generados por `compose.resources` para que `Res` vuelva a exponerse sin conflictos.
- Eliminar los warnings de Gradle sobre dependencias implícitas entre tareas de generación y compilación.

## 🧠 Contexto
- El módulo `app/composeApp` inyecta manualmente todo el árbol `build/generated/compose/resourceGenerator/kotlin` dentro de `commonMain`, mezclando los *actual* de cada plataforma en el mismo *source set* común.【F:app/composeApp/build.gradle.kts†L65-L70】
- La configuración de `compose.resources` habilita `publicResClass` y fuerza `generateResClass = always`, lo que provoca que el plugin genere colecciones públicas (`allDrawableResources`, `allStringResources`, etc.) para todas las plataformas.【F:app/composeApp/build.gradle.kts†L162-L165】
- El proyecto está anclado a Compose Multiplatform 1.8.2 y Kotlin Multiplatform 2.2.0; cualquier ajuste debe ser compatible con estas versiones publicadas en el catálogo de dependencias.【F:gradle/libs.versions.toml†L31-L47】
- Las pantallas comunes consumen `ui.rs.Res` para obtener cadenas y drawables, por lo que el objeto generado debe seguir disponible después de los cambios.【F:app/composeApp/src/commonMain/kotlin/ui/sc/shared/Home.kt†L37-L107】

## 🔍 Diagnóstico preliminar
1. Al mezclar los *actual* generados en `commonMain`, Kotlin detecta múltiples declaraciones de `Res.all*Resources` sin un `expect` correspondiente, provocando el fallo de `compileCommonMainKotlinMetadata` reportado en el issue.
2. La tarea `generateActualResourceCollectorsForAndroidMain` produce archivos que son consumidos por la compilación sin declarar dependencia explícita, porque los directorios se agregaron manualmente al *source set* en lugar de dejar que el plugin administre los `builtBy`.
3. En Windows el error aparece con mayor frecuencia porque las rutas generadas contienen mayúsculas/minúsculas y subcarpetas por plataforma; al compilarlas todas juntas se duplica el símbolo por cada `ActualResourceCollectors.kt`.

## 🔧 Cambios requeridos
### 1. Reconfigurar los *source sets* generados
- Retirar `kotlin.srcDir(generatedSources)` del bloque `commonMain` y permitir que el plugin registre automáticamente el código generado.
- Si se requiere acceso manual, agregar únicamente la subcarpeta de *expect* (`commonMainResourceCollectors`) y declarar `builtBy(tasks.named("generateExpectResourceCollectors"))` para mantener dependencias explícitas.
- Para cada plataforma (`androidMain`, `desktopMain`, `iosX64Main`, `wasmJsMain`) anexar su carpeta `ActualResourceCollectors` correspondiente con `builtBy(tasks.named("generateActualResourceCollectorsFor<Platform>"))` en lugar de compartir un único directorio.

### 2. Revisar las banderas de `compose.resources`
- Confirmar si `publicResClass` es estrictamente necesario; de no serlo, volver al valor por defecto para evitar que el plugin emita `all*Resources` públicos.
- Si se conserva `publicResClass`, validar que `generateResClass` pueda volver a `onDemand` y que el plugin genere los `expect` adecuados antes de compilar.

### 3. Validar los consumidores de `Res`
- Ejecutar una compilación en modo *desktop* y Android para verificar que componentes como `Home` y formularios de *Sign Up* resuelvan correctamente los `stringResource` tras el ajuste.
- Revisar si utilidades manuales como `ui/rs/DashboardStrings.kt` siguen siendo necesarias o pueden reemplazarse por las APIs que exponga el nuevo `Res`.

### 4. Actualizar documentación interna
- Documentar en `docs/variables-entorno.md` (o crear un anexo) el requisito de contar con `local.properties` válido para evitar el warning del SDK vacío observado en el log.
- Registrar en `docs/refinamiento-tareas.md` el flujo actualizado para regenerar recursos cuando se añadan nuevos assets.

## ✅ Criterios de aceptación
- `./gradlew :app:composeApp:compileCommonMainKotlinMetadata` finaliza sin errores en Windows y Linux.
- `./gradlew :app:composeApp:build` genera binarios Android, Desktop y Wasm sin advertencias de dependencias implícitas.
- El objeto `ui.rs.Res` continúa disponible para todos los *source sets* y permite navegar por los recursos desde IntelliJ/Android Studio.
- QA valida que las pantallas principales muestran strings e íconos sin placeholders inesperados.

## 📘 Notas técnicas
- Después de reconfigurar los directorios generados, limpiar la carpeta `app/composeApp/build/generated` para evitar residuos de compilaciones anteriores.
- Verificar que el wrapper de Gradle (`gradlew`) utilice la misma versión 8.9 indicada en el log del issue para reproducir y validar la solución en CI.
- Si se decide mantener `publicResClass`, evaluar la apertura de un ticket con JetBrains en caso de que el generador siga emitiendo *actual* duplicados pese a la nueva configuración.

## 🔬 Plan de pruebas sugerido
1. Ejecutar `./gradlew clean :app:composeApp:compileCommonMainKotlinMetadata --info` para confirmar que las tareas `generate*ResourceCollectors` se ejecutan antes de la compilación.
2. Lanzar `./gradlew :app:composeApp:build` y revisar que no aparezcan warnings de dependencias implícitas ni conflictos de símbolos.
3. Probar manualmente `./gradlew :app:composeApp:desktopRun` o `:android:assembleDebug` para verificar en runtime que los recursos se cargan correctamente.
