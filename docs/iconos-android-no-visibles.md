# Recuperar visibilidad de íconos Intrale en Android

Relacionado con #250.

## 🎯 Objetivo
- Restaurar la visualización de los íconos corporativos en todos los botones y accesos que consumen `IntraleIcon`.
- Evitar regresiones agregando diagnósticos y pruebas puntuales para detectar fallas futuras en la carga de assets SVG.

## 🧠 Contexto
- El componente `IntraleIcon` se resuelve con implementaciones específicas por plataforma. En Android delega en Coil para leer archivos desde `app/composeApp/src/androidMain/assets/icons/`.【F:app/composeApp/src/androidMain/kotlin/ui/cp/IntraleIcon.android.kt†L16-L36】
- Los botones reutilizables (`IntralePrimaryButton`, `IntraleOutlinedButton`, `IntraleGhostButton`) dibujan el icono a través de `IntraleButtonContent`, por lo que cualquier falla en `IntraleIcon` deja vacíos los espacios reservados.【F:app/composeApp/src/commonMain/kotlin/ui/cp/IntraleButtonDefaults.kt†L94-L133】
- Las pantallas `Home`, `Login` y `ButtonsPreviewScreen` son los puntos actuales donde se expone el bug reportado por el equipo de negocio.【F:app/composeApp/src/commonMain/kotlin/ui/sc/Home.kt†L83-L95】【F:app/composeApp/src/commonMain/kotlin/ui/sc/Login.kt†L306-L306】【F:app/composeApp/src/commonMain/kotlin/ui/sc/ButtonsPreviewScreen.kt†L53-L66】

## 🔍 Diagnóstico preliminar
1. `IntraleIcon.android.kt` sólo dibuja la imagen cuando el `AsyncImagePainter` reporta estado `Success`; en `Error` o `Loading` se devuelve un composable vacío, provocando que el botón quede sin ícono visible.【F:app/composeApp/src/androidMain/kotlin/ui/cp/IntraleIcon.android.kt†L27-L35】
2. No existe logging ni métricas que permitan detectar rápidamente si Coil está devolviendo errores de decodificación (por ejemplo, por rutas incorrectas o assets ausentes).
3. La build Android depende de que los SVG sigan empaquetándose dentro de `androidMain/assets`. No hay una verificación automatizada que asegure la presencia y accesibilidad de los archivos antes de ejecutar la UI.

## 🔧 Cambios requeridos
### 1. Robustecer `IntraleIcon` en Android
- Reemplazar el uso directo de `rememberAsyncImagePainter` por `SubcomposeAsyncImage` (o mantener el painter pero renderizar placeholders) para manejar estados `Loading` y `Error`, mostrando un fallback visual (por ejemplo, un rectángulo con gradiente y el nombre del asset) en lugar de dejar el espacio vacío.
- Registrar en el logger de `ui.cp` el resultado de la carga (`Success`, `Error`), incluyendo el mensaje de la excepción cuando falle, para acelerar diagnósticos futuros.
- Permitir configurar un `Modifier` opcional que exponga pruebas de accesibilidad (por ejemplo `semantics`) para validar con TalkBack que el ícono tiene descripción.

### 2. Validar la existencia de assets antes de renderizar
- Agregar una función utilitaria en `androidMain` que use `AssetManager` para listar `icons/` y confirmar la presencia de los ocho SVG actuales (`ic_login.svg`, `ic_register.svg`, etc.), retornando `false` si falta alguno.
- Exponer un `LaunchedEffect` en `IntraleIcon` que, ante ausencia del archivo, emita un warning en logs y fuerce el placeholder en lugar de intentar cargar un recurso inexistente.
- Incorporar una verificación automatizada (por ejemplo, un test de instrumentación JVM con Robolectric) que valide que `AssetManager.open("icons/ic_login.svg")` no lanza excepciones.

### 3. Revisar integraciones en pantallas
- Confirmar que `IntraleButtonContent` siga aplicando `iconTint` tras los cambios y que los parámetros de `Spacing` se mantengan para no alterar el layout del botón.【F:app/composeApp/src/commonMain/kotlin/ui/cp/IntraleButtonDefaults.kt†L102-L126】
- Ajustar `Home`, `Login` y `ButtonsPreviewScreen` para mostrar un estado alternativo (mensaje o badge) cuando el loader indique error, facilitando QA manual.
- Documentar en los comentarios de `Home` y `Login` cómo reaccionar ante el placeholder para evitar confusiones en futuras regresiones.

### 4. Documentación y comunicación
- Actualizar `docs/ui/intrale-primary-button.md` con el comportamiento de fallback y los pasos para validar los íconos.
- Añadir una sección de troubleshooting en `docs/kit-iconos-boton-primario.md` con los códigos de error más comunes reportados por Coil.

## ✅ Criterios de aceptación
- Los íconos se renderizan correctamente en `ButtonsPreviewScreen`, `Home` y `Login` sobre un dispositivo Android API 24+ con build debug y release.
- Si Coil no puede cargar un SVG, la UI muestra un placeholder claro y se registra un log con el detalle del fallo.
- Los tests automatizados que consultan `AssetManager` pasan sin errores y fallan si se elimina alguno de los SVG esperados.
- QA documenta la verificación manual y adjunta captura/video en el issue.

## 📘 Notas técnicas
- Mantener la dependencia `io.coil-kt:coil-svg:2.6.0`; si se actualiza Coil, validar compatibilidad del `SvgDecoder` con rutas `file:///android_asset`.
- Considerar extraer la lógica de fallback a un helper compartido para reutilizarlo en futuros componentes que carguen íconos desde assets.
- Los placeholders deben respetar el tamaño `MaterialTheme.spacing.x3` para no romper la alineación con el texto en los botones.

## 🔬 Plan de pruebas sugerido
1. Ejecutar `./gradlew :app:composeApp:connectedDebugAndroidTest` (o su equivalente en Robolectric) para validar la apertura de assets y el renderizado del placeholder en caso de error.
2. Navegar manualmente a `ButtonsPreviewScreen` desde `Home` y confirmar:
   - Estado normal con los tres botones mostrando sus íconos.
   - Estado forzado de error (renombrar temporalmente un SVG en assets) para observar el placeholder y el log correspondiente.
3. Revisar TalkBack/VoiceOver en Android para asegurar que la descripción del ícono se lee correctamente cuando el asset carga y cuando se muestra el fallback.
