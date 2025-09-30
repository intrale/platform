# Smoke test de deeplinks parametrizados

Este procedimiento valida que la aplicación Android responda correctamente a deeplinks HTTPS utilizando el `deeplinkHost` suministrado por parámetros de Gradle.

## Preparación
1. Conectá un dispositivo físico o iniciá un emulador Android con la depuración habilitada.
2. Generá e instalá la build de depuración con los parámetros de branding necesarios:
   ```bash
   ./gradlew :app:composeApp:installDebug \
       -PbrandId=<identificador_de_marca> \
       -PdeeplinkHost=<host.dinamico>
   ```
   - Si omitís `-PdeeplinkHost`, se utilizará el valor por defecto `<brandId>.intrale.app`.

## Ejecución manual del smoke test
1. Abrí la actividad mediante un intent `VIEW` apuntando al host configurado:
   ```bash
   adb shell am start \
       -a android.intent.action.VIEW \
       -d "https://<host.dinamico>/test"
   ```
2. Verificá en el dispositivo que la aplicación se abra en la pantalla principal (actividad `MainActivity`).
3. Revisá los logs (`adb logcat`) para confirmar que la navegación se resolvió sin errores.

## Verificación automatizada (opcional)
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

Con esto queda cubierto el smoke test requerido para QA/CI.
