# Buenas prácticas de strings (Android/Compose MPP)

Relacionado con #304.

## Motivación

Tras el crash observado en Android al decodificar recursos de Compose (`Base64.decodeImpl`), se definió una política más robusta
para acceder a strings compartidos entre plataformas. El objetivo es garantizar que un recurso corrupto o mal empaquetado no
rompa la composición y que siempre exista un texto ASCII seguro disponible como respaldo.

## Reglas generales

1. **Android primero**: cuando exista un `androidId` en `strings.xml`, siempre debe preferirse la ruta nativa (`Context.getString`).
   Compose es un fallback.
2. **Encapsular el acceso**: ningún flujo debe invocar `org.jetbrains.compose.resources.stringResource(...)` directamente fuera de
   `ui/util/ResStrings`. Toda nueva lógica multiplataforma debe pasar por `resString(...)`.
3. **Fallback obligatorio**: todas las llamadas deben proveer `fallbackAsciiSafe` (sin tildes ni caracteres fuera de ASCII). Usar
   el helper `fb(...)` para normalizar.
4. **Resiliencia ante fallos**: si el decoder de Compose arroja una excepción, `resString(...)` debe atrapar el error y retornar el
   fallback sin romper la UI.

## Ejemplos de uso

```kotlin
// ✅ Correcto: prioriza Android, mantiene Compose y fallback ASCII-safe
automationLabel = resString(
    androidId = androidStringId("two_factor_setup"),
    composeId = two_factor_setup,
    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Configurar autenticacion en dos pasos"),
)

// ❌ Incorrecto: llama directo a Compose y no entrega fallback
val text = stringResource(two_factor_setup)
```

## Logging y métricas

Cuando se retorna el fallback, `ResStrings` registra el evento mediante `logFallback(...)`, incluyendo el identificador del
recurso y un contador acumulado. Esto permite auditar problemas de empaquetado sin afectar la experiencia del usuario final.

## Kill-switch temporal

Si un bundle de Compose se distribuye con claves corruptas, se puede habilitar un _kill-switch_ (por ejemplo, desde `BuildConfig` o
propiedades de gradle) para forzar el uso del fallback en claves específicas mientras se publica un hotfix del recurso. Este
switch debe respetar las reglas anteriores: nunca exponer `stringResource` directamente y siempre delegar en `resString(...)`.
