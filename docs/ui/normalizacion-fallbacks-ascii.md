# Normalización de fallbacks ASCII-safe en la UI

## 🎯 Objetivo
- Eliminar mojibake en Android provocado por fallbacks con tildes directas al consumir `compose-resources`.
- Garantizar que todos los fallbacks declarados en Kotlin permanezcan en ASCII plano o utilicen escapes Unicode `\uXXXX`.
- Centralizar la recuperación de strings multiplataforma con un helper único que priorice los recursos nativos antes de aplicar fallbacks sanitizados.

## 🧠 Contexto
- Persisten errores `IllegalArgumentException` en Android cuando Compose intenta decodificar fallbacks con caracteres acentuados mal interpretados (`[RES_FALLBACK] … Base64.decode`).
- El XML ya está normalizado, pero los fallbacks escritos en Kotlin siguen usando acentos "vivos" (por ejemplo, `"Configurar autenticación en dos pasos"`).
- Las pantallas del Dashboard (menú semicircular y accesos directos) generan trazas con mojibake (`ΓÜá Configurar autenticación…`) porque el literal alternativo contiene bytes fuera de ASCII.

## 🔧 Cambios requeridos
### Utilitarios de recursos (`app/composeApp/src/commonMain/kotlin/ui/util/ResStrings.kt`)
- Reemplazar `resStringOr` por un `expect fun resString(androidId: Int?, composeId: StringResource?, fallbackAsciiSafe: String)` que delegue en implementaciones por plataforma.
- Incorporar un helper `fb(asciiSafe: String)` que haga `require` sobre el rango ASCII (0..127) y documente su uso obligatorio para todos los fallbacks.
- Mantener el contador/registro de fallbacks `[RES_FALLBACK]` reutilizando `resolveOrFallback`, pero ajustarlo para recibir `fallbackAsciiSafe` y registrar la cadena sanitizada.
- Actualizar o deprecate `safeString` para que derive en el nuevo `resString` y refuerce en el comentario que `fb("…")` es obligatorio.

### Implementaciones específicas por plataforma
- **Android (`app/composeApp/src/androidMain/kotlin/ui/util/ResStrings.android.kt`)**: crear `actual fun resString` que use `LocalContext.current.getString(androidId)` como ruta preferida, luego `stringResource(composeId)` y finalmente `fallbackAsciiSafe`. Loggear con `resStringLogger` cuando se utilice el fallback.
- **Desktop (`app/composeApp/src/desktopMain/kotlin/ui/util/ResStrings.desktop.kt`)**, **iOS (`app/composeApp/src/iosMain/kotlin/ui/util/ResStrings.ios.kt`)** y **Wasm (`app/composeApp/src/wasmJsMain/kotlin/ui/util/ResStrings.wasm.kt`)**: implementar `actual fun resString` consumiendo `stringResource(composeId)` si existe y regresando el fallback en caso de fallo. Compartir lógica mediante una función privada en `commonMain` si es necesario.
- Ajustar `app/composeApp/build.gradle.kts` si hace falta declarar dependencias entre source sets para reutilizar un archivo común (por ejemplo, crear un `nonAndroidMain` que dependa de desktop/ios/wasm) y garantizar que los compiladores encuentren la nueva implementación.

### Barrido de pantallas y componentes (módulo `app/composeApp`)
- Reemplazar todas las llamadas a `resStringOr` para utilizar el nuevo `resString` + `fb("…")`. Revisar particularmente:
  - `ui/sc/business/DashboardScreen.kt` (labels de acciones 2FA, logout, menús y descripciones con acentos).
  - `ui/cp/inputs/TextField.kt` (tooltips "Mostrar/Ocultar contraseña").
  - `ui/App.kt` (fallbacks del título y botón de navegación).
  - Pantallas de autenticación: `ui/sc/auth/Login.kt`, `ChangePasswordScreen.kt`, `PasswordRecoveryScreen.kt`, `TwoFactorVerifyScreen.kt`, `ConfirmPasswordRecoveryScreen.kt`.
  - Flujos de negocio: `ui/sc/business/RequestJoinBusinessScreen.kt`, `ReviewJoinBusinessScreen.kt`, `ReviewBusinessScreen.kt`, `RegisterNewBusinessScreen.kt`.
  - Flujos de registro compartidos: `ui/sc/signup/*.kt`, `ui/sc/shared/Home.kt`, `ui/sc/shared/ButtonsPreviewScreen.kt`.
- Convertir los literales problemáticos a:
  - ASCII puro sin tildes (por ejemplo, `"Configurar autenticacion en dos pasos"`), **o**
  - Escapes Unicode (`"Configurar autenticaci\u00F3n en dos pasos"`).
- Prefijar cada fallback visible con `RES_ERROR_PREFIX + fb("…")` para mantener la convención de advertencia.

### Verificación y tooling
- Crear `app/composeApp/src/commonTest/kotlin/ui/util/FallbackAsciiTest.kt` que valide:
  - `fb("Autenticaci\u00F3n")` acepta escapes Unicode.
  - `fb("Autenticación")` lanza `IllegalArgumentException`.
  - `fb("Autenticacion")` retorna la cadena original.
- Ampliar `ResStringsTest` para cubrir el nuevo flujo (`resString` delegando en fallback ASCII-safe y registrando métricas).
- Añadir una tarea Gradle `scanNonAsciiFallbacks` en `app/composeApp/build.gradle.kts` que inspeccione los archivos Kotlin buscando `fb("…")` y falle si detecta caracteres > 127 dentro del literal. Encadenar la tarea a `check`.
- Actualizar `docs/buenas-practicas-recursos.md` con la nueva regla: todo fallback debe usar `fb("…")` y mantenerse ASCII-safe.

## ✅ Criterios de aceptación
- No existen literales no-ASCII en los fallbacks Kotlin del módulo `composeApp`; todos pasan por `fb("…")`.
- Android prioriza `R.string.*` cuando el recurso está disponible y sólo cae en fallback ASCII-safe sin disparar `IllegalArgumentException`.
- Las pruebas unitarias nuevas pasan y la tarea `scanNonAsciiFallbacks` se ejecuta dentro de `./gradlew :app:composeApp:check`.
- En runtime (QA manual en Android) no se observan trazas `[RES_FALLBACK]` con mojibake al navegar el Dashboard ni las pantallas de 2FA.
- La documentación de buenas prácticas refleja el uso del helper y el requisito ASCII.

## 📘 Notas técnicas
- `fb("…")` debe invocarse desde el código fuente (no se debe confiar en transformar cadenas en runtime) para que `scanNonAsciiFallbacks` pueda inspeccionar los literales en tiempo de build.
- Cuando exista tanto `androidId` como `composeId`, garantizar que `stringResource` no se ejecute si ya devolvimos el string nativo de Android; reduce costos y evita recomposiciones redundantes.
- Mantener el logging `[RES_FALLBACK]` con el contador acumulado para correlacionar métricas históricas. El mensaje debe imprimir la versión ASCII-safe del fallback (sin caracteres extraños) para facilitar diagnósticos.
- Revisar `SafeString.kt` y sus usos en ViewModels para migrarlos progresivamente a `resString`, evitando rutas legacy que omitan la verificación ASCII.

---
Relacionado con #300
