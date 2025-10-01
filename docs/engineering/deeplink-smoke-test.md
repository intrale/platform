# Smoke test de deeplinks y applinks parametrizados

Este procedimiento valida que la aplicación responda a deeplinks/applinks utilizando el host definido en tiempo de build, tanto en Android como en iOS. Está pensado como guía rápida para QA/CI cuando se actualiza `-PdeeplinkHost` (Android) o `DEEPLINK_HOST` (iOS).

## Alcance

- Android: intent-filter HTTPS configurado desde Gradle (`BuildConfig.DEEPLINK_HOST`).
- iOS: `CFBundleURLTypes` y `NSUserActivityTypes` alimentados por `DEEPLINK_HOST`/`DEEPLINK_SCHEME` en `Branding.xcconfig`.

## Android

### Preparación
1. Conectá un dispositivo físico o iniciá un emulador Android con la depuración habilitada.
2. Generá e instalá la build de depuración con los parámetros de branding necesarios:
   ```bash
   ./gradlew :app:composeApp:installDebug \
       -PbrandId=<identificador_de_marca> \
       -PdeeplinkHost=<host.dinamico>
   ```
   - Si omitís `-PdeeplinkHost`, se utilizará el valor por defecto `<brandId>.intrale.app`.

### Ejecución manual del smoke test
1. Abrí la actividad mediante un intent `VIEW` apuntando al host configurado:
   ```bash
   adb shell am start \
       -a android.intent.action.VIEW \
       -d "https://<host.dinamico>/test"
   ```
2. Verificá en el dispositivo que la aplicación se abra en la pantalla principal (actividad `MainActivity`).
3. Revisá los logs (`adb logcat`) para confirmar que la navegación se resolvió sin errores.

### Verificación automatizada (opcional)
- Ejecutá el siguiente comando para correr únicamente la prueba instrumental que valida el intent-filter con el host dinámico:
  ```bash
  ./gradlew :app:composeApp:connectedAndroidTest \
      -PbrandId=<identificador_de_marca> \
      -PdeeplinkHost=<host.dinamico> \
      -Pandroid.testInstrumentationRunnerArguments.class=ui.deeplink.DeeplinkHostIntentFilterTest
  ```
- La prueba `DeeplinkHostIntentFilterTest` comprueba que:
  1. El `PackageManager` resuelve el deeplink hacia `MainActivity`.
  2. El `intent-filter` declara el `host` dinámico recibido en `BuildConfig`.
  3. El intent abre efectivamente la actividad esperada.

## iOS

### Preparación
1. Abrí el simulador deseado (`xcrun simctl boot "iPhone 15"`, por ejemplo) o conectá un dispositivo físico.
2. Generá la configuración de branding utilizando el wrapper de Xcode incluido en el repositorio:
   ```bash
   ./ios/scripts/xcodebuild_with_branding.sh \
       -scheme IntraleApp \
       -configuration Debug \
       -destination 'platform=iOS Simulator,name=iPhone 15' \
       BRAND_ID=<identificador_de_marca> \
       DEEPLINK_HOST=<host.dinamico> \
       DEEPLINK_SCHEME=<esquema_temporal>
   ```
   - El script regenera `ios/Branding.xcconfig` inyectando los valores anteriores antes de compilar.

### Smoke test con `CFBundleURLTypes`
1. Instalá la app generada en el simulador/dispositivo desde Xcode o con `xcrun simctl install`.
2. Ejecutá el deeplink utilizando el esquema configurado (por defecto `intrale`):
   ```bash
   xcrun simctl openurl booted "<esquema_temporal>://test"
   ```
3. Confirmá que la aplicación se active y llegue a la escena inicial sin errores en la consola de Xcode.

### Validación del host en `Info.plist`
1. Localizá la ruta del bundle resultante (por ejemplo `app/build/ios/Debug-iphonesimulator/IntraleApp.app`).
2. Ejecutá:
   ```bash
   plutil -extract CFBundleURLTypes xml1 <ruta_al_bundle>/Info.plist
   plutil -extract NSUserActivityTypes xml1 <ruta_al_bundle>/Info.plist
   ```
3. Verificá que:
   - `CFBundleURLSchemes` contenga el esquema usado en el paso anterior.
   - `NSUserActivityTypes` liste `applinks:<host.dinamico>`, demostrando que el placeholder `$(DEEPLINK_HOST)` fue reemplazado.

### Notas sobre Universal Links (`applinks`)

- Para una validación punta a punta se necesita publicar el archivo `apple-app-site-association` con el host configurado. Si el dominio todavía no lo expone, limitate al smoke test con `CFBundleURLTypes` anterior.
- Una vez disponible el dominio, podés disparar la prueba con:
  ```bash
  xcrun simctl openurl booted "https://<host.dinamico>/test"
  ```
  y revisar en la consola que la escena se active vía `NSUserActivity`.
- Documentá el resultado (éxito o bloqueo por falta de dominio) en el ticket correspondiente.

Con estas validaciones queda cubierto el smoke test requerido para QA/CI en ambas plataformas.
