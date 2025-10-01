# Build iOS con parámetros de branding dinámicos

Este procedimiento permite compilar el cliente iOS inyectando la configuración de marca
(identificador, sufijos de bundle, nombre visible y endpoints) sin necesidad de mantener
`schemes` por cada marca. La generación del archivo `Branding.xcconfig` se realiza en
runtime antes de invocar `xcodebuild` y alimenta tanto el proyecto Xcode como los scripts
de assets.

## Comandos rápidos

### Build "published" (entorno productivo)

```bash
./ios/scripts/xcodebuild_with_branding.sh \
  -scheme IntraleApp \
  -configuration Release \
  -archivePath build/IntraleApp.xcarchive \
  -allowProvisioningUpdates \
  BRAND_ID=acme \
  BUNDLE_ID_SUFFIX=acme \
  BRAND_NAME="Acme" \
  DEEPLINK_HOST=acme.intrale.app \
  BRANDING_ENDPOINT="https://api.intrale.app/branding/acme"
```

Genera `Branding.xcconfig`, refresca los assets de branding (incluido `AppIcon`) y
encadena la ejecución de `xcodebuild` utilizando los perfiles de firma configurados
automáticamente (`-allowProvisioningUpdates`).

### Build "preview" (con versión preliminar del branding)

```bash
./ios/scripts/xcodebuild_with_branding.sh \
  -scheme IntraleApp \
  -configuration Release \
  -archivePath build/IntraleApp-preview.xcarchive \
  BRAND_ID=acme \
  BUNDLE_ID_SUFFIX=acme-preview \
  BRAND_NAME="Acme Preview" \
  BRANDING_ENDPOINT="https://api.intrale.app/branding/acme" \
  BRANDING_PREVIEW_VERSION=latest
```

El parámetro `BRANDING_PREVIEW_VERSION` fuerza al script a descargar la variante de
branding indicada y a cachearla en `ios/build/branding/<brand_id>/branding.json`. Esto
permite validar cambios en contenido antes de publicarlos.

## Variables y valores por defecto

| Variable                       | Obligatoria | Valor por defecto / fallback                                           |
| ------------------------------ | ----------- | ---------------------------------------------------------------------- |
| `BRAND_ID`                     | Sí          | — (si falta, los scripts abortan)                                      |
| `BUNDLE_ID_SUFFIX`             | No          | `default` (se concatena a `ar.com.intrale.platform.`)                  |
| `BRAND_NAME`                   | No          | `Default` (utilizado como `DISPLAY_NAME` si este no se define)         |
| `DEEPLINK_HOST`                | No          | `default.intrale.app`                                                  |
| `BRANDING_ENDPOINT`            | No          | `https://branding.intrale.app/default`                                 |
| `BRANDING_PREVIEW_VERSION`     | No          | Vacío (usa la versión "published" vigente)                             |
| `PRODUCT_BUNDLE_IDENTIFIER`    | No          | Calculado como `ar.com.intrale.platform.$(BUNDLE_ID_SUFFIX)`           |
| `DISPLAY_NAME`                 | No          | Fallback: `BRAND_NAME` → iniciales de `BRAND_ID`                       |

Los valores anteriores provienen de `ios/BrandingTemplate.xcconfig` y del
post-procesamiento aplicado por los scripts de branding.

## Secuencia de scripts en el pipeline

1. **Render de `Branding.xcconfig`** — `generate_branding_xcconfig.py` toma la plantilla
   y aplica los parámetros recibidos (ya sea desde el wrapper o desde el entorno de CI).
2. **Fetch y cache del JSON de branding** — `fetch_branding_json.sh` descarga y valida
   el payload remoto; se invoca cuando `BRAND_ID` y `BRANDING_ENDPOINT` están disponibles.
3. **Generación de íconos** — `generate_app_icon.swift` crea `AppIcon.appiconset` en base a
   los datos cacheados y al nombre visible efectivo.

El script `ios/scripts/prebuild_generate_branding.sh` ejecuta la cadena completa como fase
*Run Script* dentro de Xcode. En CI es común utilizar el wrapper `xcodebuild_with_branding.sh`,
que replica el mismo orden antes de delegar en `xcodebuild`.

## Fallbacks y tolerancia a errores

- **Nombre visible:** Si `DISPLAY_NAME` no está definido, el generador de íconos utiliza
  `BRAND_NAME`; si tampoco existe, recurre a `BRAND_ID` para derivar las iniciales.
- **Logo ausente o inválido:** Cuando el JSON de branding no incluye un logo válido (MIME
  no soportado, tamaño excedido o descarga fallida) se genera un AppIcon placeholder con
  las iniciales y un color derivado determinísticamente.
- **Branding endpoint faltante:** El fetch se omite sin fallar la build, pero se registra
  una advertencia y los íconos se generan con placeholder.
- **Plantilla ausente o script no ejecutable:** Ambos scripts abortan con error explícito,
  evitando builds inconsistentes.

## Tips de firma y distribución

- **Locales:** exporta `MATCH_TYPE` o configura certificados automáticos desde Xcode. Al
  usar el wrapper, agrega `-allowProvisioningUpdates` para que Xcode gestione perfiles.
- **CI (Fastlane opcional):** si se ejecuta dentro de Fastlane, invoca el wrapper desde una
  acción `sh`. Mantén certificados en el llavero del runner (`xcode-select --print-path` y
  `security find-identity -p codesigning`) y usa `fastlane match` solo si la build
  requiere firma manual; el wrapper no interfiere con la sesión de Fastlane.
- **ExportOptions:** después de generar el `.xcarchive`, ejecuta `xcodebuild -exportArchive`
  reutilizando el mismo `Branding.xcconfig` para garantizar que los metadatos coincidan con
  la marca.

## Validaciones esperadas en CI

- Los logs de `xcodebuild` deben listar las variables inyectadas en `OTHER_CFLAGS` o en el
  entorno, confirmando que el wrapper propagó los parámetros.
- El archivo `ios/Branding.xcconfig` debe regenerarse en cada ejecución del pipeline con
  los valores solicitados antes de que inicie la compilación.
- El cache `build/branding/<brand>/branding.json` debe actualizarse cuando se especifica
  `BRANDING_PREVIEW_VERSION`.
- No se versiona el resultado final porque está ignorado vía `.gitignore`.
