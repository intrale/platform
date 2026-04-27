# Defecto encontrado en issue #1915

## Resumen
La implementación NO cumple con varios criterios de aceptación del issue.

## Evidencia por criterio

### CRITERIO FALLIDO 1: "El negocio puede configurar el volumen y tipo de sonido"
La pantalla `BusinessSoundConfigScreen` se registra en el DI con `BUSINESS_SOUND_CONFIG = "businessSoundConfig"` y tiene el path `/business/sound-config`, pero NO existe ningún botón o menú en la UI que navegue a esa pantalla.

Verificación en `DashboardScreen.kt` (commit 190d2f95) — enlaces disponibles:
```
linea 232: navigate(BUSINESS_CONFIG_PATH)
linea 248: navigate(BUSINESS_SCHEDULES_PATH)
linea 256: navigate(BUSINESS_DELIVERY_ZONE_PATH)
linea 264: navigate(BUSINESS_PAYMENT_METHODS_PATH)
```
NO hay `navigate(BUSINESS_SOUND_CONFIG_PATH)` en ningún lado.

Grep de todo el commit:
```
$ git grep "BUSINESS_SOUND_CONFIG_PATH" 190d2f95
190d2f95:.../BusinessSoundConfigScreen.kt:const val BUSINESS_SOUND_CONFIG_PATH = "/business/sound-config"
```
Única aparición: la declaración del const. Cero usos.

Impacto: el usuario del negocio NO puede acceder a la pantalla de configuración de sonido desde la UI. El criterio "puede configurar" no se cumple.

### CRITERIO FALLIDO 2: "Funciona con la app en segundo plano"
La reproducción de sonido está implementada con `LaunchedEffect(alerts, config)` dentro del composable `OrderSoundAlertBanner`, que solo existe mientras `BusinessOrdersScreen` está compuesta en memoria.

`OrderSoundAlertBanner.kt` linea 67-75:
```kotlin
DisposableEffect(Unit) {
    onDispose {
        soundService.stopSound()
        soundService.release()
    }
}
```
Cuando la app va a background o el usuario navega fuera de la pantalla de pedidos, el servicio se destruye y el sonido se detiene.

NO hay:
- Foreground Service Android
- WorkManager o similar
- Notification push con sonido propio
- Polling en background

Impacto: al minimizar la app, se pierde toda alerta sonora de pedidos nuevos. El criterio "funciona con la app en segundo plano" NO se cumple.

### CRITERIO PARCIAL 3: "Al llegar un pedido nuevo, se emite un sonido distintivo"
La detección de pedidos nuevos ocurre únicamente en `BusinessOrdersViewModel.loadOrders()` (llamada manual desde UI). NO hay polling ni push real.

`BusinessOrdersViewModel.kt` diff:
```kotlin
val newOrders = BusinessOrderNotificationStore.processOrders(orders)
```
Esto se ejecuta solo cuando el usuario refresca la pantalla. Si el empleado está en otra pantalla o la app en background, nunca se entera del pedido nuevo.

## Criterios que SÍ se cumplen (nivel código)
- Sonido distintivo: ToneGenerator con 4 tipos (DEFAULT/BELL/CHIME/URGENT) — OK
- Vibración: VibrationEffect.createWaveform — OK
- Repetición cada 30s: `delay(config.repeatIntervalSeconds * 1000)` — OK (mientras screen activa)
- Mute temporal: `toggleMute()` en ViewModel — OK (pero config inaccesible via UI)

## Recomendación de corrección
1. Agregar card en `DashboardScreen` que navegue a `BUSINESS_SOUND_CONFIG_PATH`, o agregar un IconButton de configuración en el TopBar de `BusinessOrdersScreen`.
2. Implementar un Foreground Service Android (o WorkManager) que escuche eventos de pedidos nuevos cuando la app está en background.
3. Agregar polling periódico o FCM push para detectar pedidos nuevos sin depender de que el usuario esté en la pantalla de pedidos.
