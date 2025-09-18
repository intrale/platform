# Botón primario Intrale y set de íconos

Relacionado con #221.

## 🎯 Propósito
- Centralizar el uso de íconos de marca (acento triangular con degradado azul) dentro de Compose.
- Exponer un botón primario animado que combine ícono + texto con shimmer diagonal y rebote al presionar.
- Dejar una pantalla de referencia (`ButtonsPreviewScreen`) para validar estados y reutilizar snippet.

## 📁 Assets
- Ubicación: `app/composeApp/src/androidMain/assets/icons/`.
- Fuente original: paquete `intrale-icons-v1.zip` provisto por diseño.
- Íconos incluidos:
  - `ic_login.svg`
  - `ic_register.svg`
  - `ic_register_business.svg`
  - `ic_delivery.svg`
  - `ic_seller.svg`
  - `ic_admin.svg`
  - `ic_recover.svg`
  - `ic_logout.svg`

> 🔁 Para actualizar la librería, reemplazar los SVG manteniendo los nombres y ejecutar una build Android para validar que Coil los cargue sin errores.

## 🧩 Componentes disponibles
### `IntraleIcon`
Carga íconos SVG desde `file:///android_asset/icons/` en Android usando Coil.

```kotlin
IntraleIcon(
    assetName = "ic_login.svg",
    modifier = Modifier.size(22.dp),
    contentDesc = stringResource(Res.string.login)
)
```

> ℹ️ En Desktop/iOS/Wasm se renderiza un placeholder con el nombre del asset hasta que se provean loaders nativos.

### `IntralePrimaryButton`
Botón composable con gradiente accesible (`#0C2D6B -> #1E4CA1` en tema claro / `#0B224F -> #173B80` en tema oscuro), shimmer en loop y rebote al presionar cuando hay preferencia por animaciones.

```kotlin
IntralePrimaryButton(
    text = stringResource(Res.string.login),
    iconAsset = "ic_login.svg",
    onClick = { /* Acción */ }
)
```

Parámetros relevantes:
- `enabled`: desactiva interacciones y reduce opacidad.
- `loading`: muestra `CircularProgressIndicator` y pausa los clics.
- `iconContentDescription`: opcional para accesibilidad (por defecto usa `text`).
- `stressTestState`: controla el modo automático de stress test con métricas compartidas (por defecto está deshabilitado).

## 🖥️ Pantalla de demostración
`ButtonsPreviewScreen` se encuentra registrada en `DIManager` y accesible desde el Home. Presenta:
1. Botón "Ingresar" activo.
2. Botón "Registrarme" en estado `loading`.
3. Botón "Salir" deshabilitado.
4. Controles para habilitar el modo de stress test automático y visualizar los cuadros janky reportados por `FramePerformanceDiagnostics`.

## 🧪 Pruebas manuales
- Pixel 6 API 34 (Debug): navegación hacia `ButtonsPreviewScreen`, verificación de shimmer fluido y rebote al presionar "Ingresar".
- Validación de que cada botón muestra el ícono correcto y que el asset cambia sin pixelarse en pantallas HDPI/XXHDPI.
- Comprobación de logs en Logcat para eventos de clic y cambios de estado.

> 📹 El video/gif de respaldo puede capturarse desde Android Studio (Layout Inspector) grabando la interacción en `ButtonsPreviewScreen`.

## ♿ Accesibilidad y rendimiento
- `rememberMotionPreferences` respeta la preferencia del sistema "Reducir movimiento" en Android, Desktop, iOS y Web, pausando el shimmer y las animaciones de rebote cuando corresponde.
- `IntralePrimaryButton` expone un `stressTestState` que puede activarse desde `ButtonsPreviewScreen` (controlado por `BuildKonfig.ENABLE_BUTTON_STRESS_TEST`).
- En Android, `AndroidJankStatsMonitor` inicializa `JankStats` y reporta cuadros janky a `FramePerformanceDiagnostics` para su visualización.

## 🚧 Limitaciones actuales
- Sólo Android carga los SVG reales. En Desktop/iOS/Wasm se muestra un placeholder textual.
- Mantener la nomenclatura de archivos para evitar roturas en la demo y en cualquier pantalla que consuma `IntraleIcon`.
- El monitoreo de `JankStats` está disponible únicamente en Android.

## 🔖 Versionado en GitHub
- Gradientes accesibles: `app/composeApp/src/commonMain/kotlin/ui/th/Gradients.kt`.
- Botón primario y defaults compartidos: `app/composeApp/src/commonMain/kotlin/ui/cp/IntralePrimaryButton.kt` y `IntraleButtonDefaults.kt`.
- Preferencias de movimiento multiplataforma: `app/composeApp/src/**/kotlin/ui/accessibility/MotionPreferences*.kt`.
- Diagnóstico de cuadros janky: `app/composeApp/src/commonMain/kotlin/diagnostics/FramePerformanceDiagnostics.kt` y `app/composeApp/src/androidMain/kotlin/ui/metrics/AndroidJankStatsMonitor.kt`.
