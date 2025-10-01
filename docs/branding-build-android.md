# Build dinámico de Android por marca

Este documento describe cómo ejecutar el build dinámico para Android en el proyecto multiplataforma, qué parámetros admite y cómo funciona la política de fallbacks cuando el branding remoto no está disponible. Está pensado para desarrolladores y pipelines de CI que necesitan generar artefactos listos para publicar o para validar previas.

## Parámetros Gradle disponibles

Todos los comandos se ejecutan desde la raíz del repositorio con `./gradlew`. El build lee parámetros usando `-P<nombre>=<valor>` y aplica los siguientes valores por defecto:

| Parámetro | Obligatorio | Descripción | Default |
|-----------|-------------|-------------|---------|
| `brandId` | ✅ | Identificador canónico de la marca. Se usa para componer `applicationId`, nombres de carpetas y para resolver el branding remoto. | `intrale` (fallback automático si no se especifica). |
| `appIdSuffix` | ⛔ | Sufijo adicional para el `applicationId`. Se normaliza (sin puntos iniciales). | `brandId` |
| `brandName` | ⛔ | Nombre de la marca para mostrar en la app. | `brandId` con la primera letra capitalizada |
| `deeplinkHost` | ⛔ | Host para deeplinks configurado en el `AndroidManifest`. | `<brandId>.intrale.app` |
| `brandingEndpoint` | ⛔ | Endpoint HTTP que devuelve el JSON de branding. Puede incluir placeholders `{brandId}` o `%s`. | No definido → se usan solo los recursos locales |
| `brandingPreviewVersion` | ⛔ | Cadena opcional para pedir una versión preview al endpoint remoto. | No definido |

> 🔎 El script de Gradle registra los parámetros efectivos en la consola al inicio del build para facilitar auditorías. 【F:app/composeApp/build.gradle.kts†L30-L74】

### Configuración persistente para entornos locales

Para no repetir banderas en cada comando se puede definir la marca por defecto de dos maneras:

1. **Variable de entorno**

   ```bash
   export BRAND_ID=intrale
   ```

Gradle prioriza el parámetro explícito (`-PbrandId`), luego la variable `BRAND_ID`, después `local.properties` y finalmente usa `intrale` como fallback. 【F:app/composeApp/build.gradle.kts†L30-L52】

2. **Archivo `local.properties`**

   Agregar la propiedad al archivo en la raíz del repo (no se versiona, pero sirve para desarrollos locales):

   ```properties
   brandId=intrale
   ```

   Las propiedades locales también pueden definir `appIdSuffix`, `brandName`, `deeplinkHost`, `brandingEndpoint` y `brandingPreviewVersion`. 【F:app/composeApp/build.gradle.kts†L35-L48】

## Comandos típicos

### Build para publicar (Android App Bundle)

```bash
./gradlew :app:composeApp:bundleRelease \
  -PbrandId=intrale \
  -PbrandingEndpoint="https://branding.intrale.app/brands/{brandId}" \
  -PbrandingPreviewVersion=stable
```

- Genera `app/composeApp/build/outputs/bundle/release/composeApp-release.aab` listo para Play Console.
- El pipeline debería guardar además el JSON y los íconos generados en `app/composeApp/build/generated/branding/<brandId>/`. 【F:app/composeApp/build.gradle.kts†L297-L318】

### Build de validación rápida (APK/Debug)

```bash
./gradlew :app:composeApp:assembleDebug \
  -PbrandId=demo \
  -PbrandingEndpoint="https://branding.intrale.app/brands/%s" \
  -PbrandingPreviewVersion=qa
```

- Produce `app/composeApp/build/outputs/apk/debug/composeApp-debug.apk` con sufijo de aplicación derivado de la marca. 【F:app/composeApp/build.gradle.kts†L232-L259】
- Útil para smoke tests y validaciones locales; respeta los mismos parámetros de branding.

### Sin endpoint remoto (modo offline)

```bash
./gradlew :app:composeApp:assembleDebug -PbrandId=staging
```

- El build continúa usando el nombre local (`brandName`) y generando íconos placeholder. Es el modo recomendado cuando el endpoint remoto está caído o se trabaja sin VPN.

## Secuencia interna del build

1. **Normalización de parámetros.** Antes de configurar el módulo Android se validan y normalizan todos los `-P`. Si `brandId` falta, Gradle adopta `intrale` automáticamente y deja un mensaje en consola. 【F:app/composeApp/build.gradle.kts†L30-L52】
2. **Sincronización de íconos base64.** La tarea `syncBrandingIcons` decodifica los assets en `docs/branding/icon-pack/*.b64` hacia los recursos nativos (Android, Web y iOS). Se ejecuta automáticamente antes de `preBuild`, pero se puede invocar manualmente con `./gradlew :app:composeApp:syncBrandingIcons`. 【F:app/composeApp/build.gradle.kts†L459-L479】【F:buildSrc/src/main/kotlin/ar/com/intrale/branding/SyncBrandingIconsTask.kt†L18-L56】
3. **Generación de recursos dinámicos.** `GenerateBrandResourcesTask` crea `strings.xml` y recursos de íconos dentro de `build/generated/branding/<brandId>/res`. También persiste una copia en `build/generated/branding/<brandId>/branding.json` cuando el endpoint responde OK. 【F:buildSrc/src/main/kotlin/ar/com/intrale/branding/GenerateBrandResourcesTask.kt†L12-L83】
4. **Registro en Android Gradle Plugin.** Los recursos generados se agregan al variant correspondiente vía `androidComponents`, por lo que no es necesario tocar `src/androidMain`. 【F:app/composeApp/build.gradle.kts†L321-L333】
5. **Validaciones adicionales.** Durante `check` se ejecutan verificaciones de fallback (`scanNonAsciiFallbacks`) para evitar caracteres inválidos en `fb("…")`. 【F:app/composeApp/build.gradle.kts†L335-L420】

## Política de fallbacks y límites

- **Nombre de la app:** si el endpoint remoto falla o devuelve `appName` vacío, se usa `brandName` como fallback y se deja un warning en consola. 【F:buildSrc/src/main/kotlin/ar/com/intrale/branding/GenerateBrandResourcesTask.kt†L49-L76】
- **Ícono:** se intenta descargar `payload.images.logo`. Si el MIME no es `png`/`jpeg`, el archivo supera 512 KB o la descarga falla, se genera un ícono placeholder con las iniciales de la marca y se registra una advertencia. 【F:buildSrc/src/main/kotlin/ar/com/intrale/branding/BrandingIconGenerator.kt†L19-L103】
- **Colores:** si no hay paleta remota, se calcula un color de fondo seguro en base al logo o se usa el fallback por defecto.
- **Tiempo de espera:** tanto el JSON como el logo tienen timeout de 10 segundos. 【F:buildSrc/src/main/kotlin/ar/com/intrale/branding/GenerateBrandResourcesTask.kt†L58-L67】【F:buildSrc/src/main/kotlin/ar/com/intrale/branding/BrandingIconGenerator.kt†L33-L87】

## Artefactos generados

| Ubicación | Contenido |
|-----------|-----------|
| `app/composeApp/build/outputs/bundle/<variant>/` | `.aab` para publicar |
| `app/composeApp/build/outputs/apk/<variant>/` | `.apk` para pruebas |
| `app/composeApp/build/generated/branding/<brandId>/res/values/strings.xml` | Nombre de app aplicado |
| `app/composeApp/build/generated/branding/<brandId>/res/mipmap-*/ic_launcher*.png` | Íconos adaptativos generados |
| `app/composeApp/build/generated/branding/<brandId>/branding.json` | Copia del JSON remoto (cuando existe) |

Estos directorios se limpian con `./gradlew :app:composeApp:clean`. Guardar los artefactos relevantes como artefactos de pipeline si se requiere auditoría.

## Depuración de errores comunes

- **No se especificó `brandId`:** se usará `intrale` como valor por defecto y el build registrará un mensaje informativo. Añadí `-PbrandId=<id>` si necesitás otra marca. 【F:app/composeApp/build.gradle.kts†L30-L52】
- **Warnings de ícono placeholder:** revisar el log para confirmar si la URL del logo es correcta y respeta límite de 512 KB y MIME permitido. 【F:buildSrc/src/main/kotlin/ar/com/intrale/branding/BrandingIconGenerator.kt†L70-L103】
- **Branding remoto inválido:** si el JSON no parsea, se usa el fallback local y se loguea el detalle. Validar la respuesta grabada en `branding.json` para reproducir el fallo.
- **Cambios en el icon pack:** ejecutar `./gradlew :app:composeApp:syncBrandingIcons --rerun-tasks` para forzar la decodificación cuando se actualizan los `.b64`.

## Próximos pasos

- Mantener este documento actualizado cuando se agreguen nuevos parámetros o variantes.
- Alinear la estructura con la guía equivalente de iOS (H1.S9) cuando esté disponible.

