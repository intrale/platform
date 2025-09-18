# Kit de íconos de marca + botón primario animado

Relacionado con #221.

## 🎯 Objetivo
- Entregar una experiencia de botón primario alineada al branding de Intrale, combinando ícono + texto con animaciones de shimmer diagonal y rebote al presionar.
- Centralizar la carga de íconos SVG propietarios mediante un componente `IntraleIcon` reutilizable para las pantallas Compose.
- Publicar una pantalla de demostración que permita validar el comportamiento y servir como referencia de integración para el resto del equipo.

## 🧠 Contexto
- La capa de componentes reutilizables (`app/composeApp/src/commonMain/kotlin/ui/cp`) sólo expone un botón básico (`Button`) sin soporte para íconos ni animaciones.【F:app/composeApp/src/commonMain/kotlin/ui/cp/Button.kt†L1-L34】
- El proyecto Compose Multiplatform no cuenta con una carpeta de assets en `androidMain`, por lo que hoy no es posible servir íconos externos desde `file:///android_asset`.【F:app/composeApp/src/commonMain/composeResources/drawable/compose-multiplatform.xml†L1-L18】【F:app/composeApp/src/androidMain†L1-L3】
- Todas las pantallas se registran a través de `DIManager` y el router común (`CommonRouter`), por lo que cualquier demo debe agregarse al binding de `SCREENS` y exponerse en la navegación principal (por ejemplo, desde `Home`).【F:app/composeApp/src/commonMain/kotlin/DIManager.kt†L27-L108】【F:app/composeApp/src/commonMain/kotlin/ui/sc/Home.kt†L1-L88】

## 🔧 Cambios requeridos
### Gestión de assets
- Crear la carpeta `app/composeApp/src/androidMain/assets/icons/` y versionar los SVG entregados (`ic_login.svg`, `ic_register.svg`, `ic_register_business.svg`, `ic_delivery.svg`, `ic_seller.svg`, `ic_admin.svg`, `ic_recover.svg`, `ic_logout.svg`).
- Documentar en el README interno la procedencia del paquete `intrale-icons-v1.zip` y los pasos para actualizar los íconos cuando haya una nueva iteración.
- Validar si Desktop/iOS requieren assets adicionales; en caso contrario dejar explícito que, por ahora, el soporte de íconos se limita a Android.

### Configuración de dependencias
- Agregar a `androidMain` las dependencias `io.coil-kt:coil-compose:2.6.0` y `io.coil-kt:coil-svg:2.6.0` dentro de `app/composeApp/build.gradle.kts`, manteniendo el resto de targets sin cambios.
- Verificar que no existan exclusiones de recursos que impidan empaquetar los assets (`android.packaging.resources.excludes`).

### Componentes base
- Implementar `IntraleIcon` en `app/composeApp/src/commonMain/kotlin/ui/cp/IntraleIcon.kt` como declaración `expect` que expone `assetName`, `contentDesc` y `modifier`; su `actual` de Android vivirá en `app/composeApp/src/androidMain/kotlin/ui/cp/IntraleIcon.android.kt` usando `rememberAsyncImagePainter`, `ImageRequest` y `SvgDecoder` para leer desde `file:///android_asset/icons/$assetName`.
- Implementar un `actual` para Desktop/iOS (aunque sea un placeholder con `painterResource`) o dejar documentado que mostrará un recuadro vacío hasta contar con soporte multiplataforma.
- Crear `IntralePrimaryButton` en `app/composeApp/src/commonMain/kotlin/ui/cp/IntralePrimaryButton.kt` reutilizando `IntraleIcon`, aplicando:
  - Gradiente horizontal accesible definido en `ui/th/Gradients.kt` (`#0C2D6B -> #1E4CA1` en tema claro / `#0B224F -> #173B80` en tema oscuro) con esquinas de `18.dp` y ancho por defecto del 90% del contenedor.
  - Capa `Canvas` con animación shimmer diagonal controlada por `rememberInfiniteTransition` y desactivada cuando `rememberMotionPreferences().reduceMotion` sea `true`.
  - Rebote al presionar usando `pointerInput` + `detectTapGestures` y `animateFloatAsState` para escalar entre `0.98f` y `1f`.
  - Registro en logger (`LoggerFactory`) para depurar eventos de click, siguiendo el patrón del botón actual.
  - Parámetros opcionales: `enabled`, `modifier`, `loading` (si se considera necesario), `iconAsset` y `stressTestState` para el modo automático de stress test.

### Pantalla de demostración y navegación
- Crear `app/composeApp/src/commonMain/kotlin/ui/sc/ButtonsPreviewScreen.kt` con la clase `ButtonsPreviewScreen` que extienda `Screen`, defina `BUTTONS_PREVIEW_PATH` y renderice tres botones (`Ingresar`, `Registrarme`, `Salir`) usando los íconos correspondientes.
- Añadir un string `buttons_preview` a `app/composeApp/src/commonMain/composeResources/values/strings.xml` y exponerlo como título de la nueva pantalla.
- Registrar la pantalla en `DIManager`:
  - Definir una constante `BUTTONS_PREVIEW` para DI.
  - Crear el binding `bindSingleton(tag = BUTTONS_PREVIEW) { ButtonsPreviewScreen() }` y agregarlo al arreglo `SCREENS`.
- Actualizar `Home` para incluir un botón que navegue a `BUTTONS_PREVIEW_PATH`, permitiendo acceder a la demo desde la app.

### Documentación y QA
- Publicar una guía rápida en `docs/ui/intrale-primary-button.md` (o actualizar una existente) con instrucciones de uso del componente, listado de assets y snippet de integración.
- Registrar en el issue el video/gif corto que muestre el shimmer + bounce funcionando en un dispositivo Android API ≥ 24.
- Anotar pruebas manuales: carga de íconos, animaciones, comportamiento en estado `enabled/disabled` y comprobación de logs.

## ✅ Criterios de aceptación
- Los ocho SVG se empaquetan en la build Android y se cargan sin crashes en API 24+ mediante `IntraleIcon`.
- `IntralePrimaryButton` renderiza texto + ícono centrados, respeta el gradiente de marca y exhibe shimmer + rebote suave al presionar.
- La pantalla `ButtonsPreviewScreen` se puede abrir desde `Home` y muestra al menos tres ejemplos funcionales.
- Se dispone de documentación interna con instrucciones de uso y registro de pruebas manuales.
- Lint/Ktlint se ejecutan sin errores y las Previews de Compose del nuevo componente funcionan.

## 📘 Notas técnicas
- Reutilizar los helpers de logging existentes en `ui.cp` para mantener trazabilidad en clics y estados del botón.
- Considerar la creación de una sealed class o enum para mapear los nombres de íconos válidos, facilitando la validación antes de construir la URL al asset.
- Asegurar que el gradiente y los colores de texto tengan contraste AA (texto blanco sobre fondo azul) y que la tipografía utilice `FontWeight.SemiBold` de 16sp para alinear con el diseño de marketing.
- Si se detecta tearing en la animación shimmer, ajustar la duración del `tween` o limitar la frecuencia del `Canvas` mediante `snapshots`.
- Documentar en el código cualquier limitación multiplataforma para que futuros trabajos (Desktop/iOS) sepan cómo extender `IntraleIcon`.
