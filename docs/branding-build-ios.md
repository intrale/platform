# Build iOS con parámetros de branding dinámicos

Este procedimiento permite compilar el cliente iOS inyectando la configuración de marca
(identificador, sufijos de bundle, nombre visible y endpoints) sin necesidad de mantener
`schemes` por cada marca. La generación del archivo `Branding.xcconfig` se realiza en
runtime antes de invocar `xcodebuild`.

## Plantilla de parámetros

El repositorio incorpora `ios/BrandingTemplate.xcconfig` como base con valores por defecto:

```
BRAND_ID = default
BUNDLE_ID_SUFFIX = default
BRAND_NAME = Default
DEEPLINK_HOST = default.intrale.app
BRANDING_ENDPOINT = https://branding.intrale.app/default
BRANDING_PREVIEW_VERSION =
PRODUCT_BUNDLE_IDENTIFIER = ar.com.intrale.platform.$(BUNDLE_ID_SUFFIX)
DISPLAY_NAME = $(BRAND_NAME)
```

La plantilla no se modifica directamente. El pipeline genera `ios/Branding.xcconfig` a
partir de este archivo aplicando los parámetros recibidos.

## Script de generación

El script `ios/scripts/generate_branding_xcconfig.py` aplica el siguiente flujo:

1. Lee la plantilla conservando comentarios y orden de claves.
2. Reemplaza los valores mediante variables de entorno o parámetros `--set KEY=VALUE`.
3. Valida que `BRAND_ID`, `DEEPLINK_HOST` y `BRANDING_ENDPOINT` no sean vacíos y que
   `BUNDLE_ID_SUFFIX` no contenga espacios ni puntos duplicados.
4. Emite `ios/Branding.xcconfig` listo para ser consumido por el proyecto Xcode y muestra
   en consola el resumen de parámetros finales.

Se puede ejecutar de forma aislada:

```bash
BRAND_ID=acme \
BUNDLE_ID_SUFFIX=acme \
BRAND_NAME="Acme" \
DEEPLINK_HOST=acme.intrale.app \
BRANDING_ENDPOINT="https://api.intrale.app/branding/acme" \
BRANDING_PREVIEW_VERSION=latest \
python ios/scripts/generate_branding_xcconfig.py \
  --template ios/BrandingTemplate.xcconfig \
  --output ios/Branding.xcconfig
```

## Wrapper de xcodebuild

Para CI/CD se incluye `ios/scripts/xcodebuild_with_branding.sh`, que automatiza el flujo:

1. Detecta parámetros `KEY=VALUE` compatibles con branding dentro de los argumentos
   entregados a `xcodebuild` y los exporta como variables de entorno.
2. Ejecuta el script anterior para regenerar `Branding.xcconfig` antes de compilar.
3. Inyecta el `-xcconfig ios/Branding.xcconfig` a la invocación de `xcodebuild` cuando el
   comando original no lo especifica.

Ejemplo de uso para una build Release:

```bash
./ios/scripts/xcodebuild_with_branding.sh \
  -scheme IntraleApp \
  -configuration Release \
  BRAND_ID=acme \
  BUNDLE_ID_SUFFIX=acme \
  BRAND_NAME="Acme" \
  DEEPLINK_HOST=acme.intrale.app \
  BRANDING_ENDPOINT="https://api.intrale.app/branding/acme" \
  BRANDING_PREVIEW_VERSION=latest
```

El wrapper mantiene intactos el resto de los parámetros (`-destination`, `-archivePath`,
 etc.) por lo que puede integrarse en los workflows existentes. Si el proyecto ya define
`Branding.xcconfig` como *Base Configuration* no es necesario pasar `-xcconfig` manualmente.

## Script de Pre-Build para Xcode

Para automatizar la generación dentro del propio proyecto Xcode se incluye el script
`ios/scripts/prebuild_generate_branding.sh`. Este script está pensado para ejecutarse en
una fase **Run Script** configurada como *Pre-build* y aplica el siguiente flujo:

1. Valida que la variable de entorno `BRAND_ID` esté presente. Si falta, aborta la build
   con un mensaje claro.
2. Lee, cuando están disponibles, los valores de `BUNDLE_ID_SUFFIX`, `BRAND_NAME`,
   `DEEPLINK_HOST`, `BRANDING_ENDPOINT`, `BRANDING_PREVIEW_VERSION`,
   `PRODUCT_BUNDLE_IDENTIFIER` y `DISPLAY_NAME`.
3. Invoca `generate_branding_xcconfig.py` para renderizar `ios/Branding.xcconfig` a partir
   de la plantilla.
4. Reporta la ruta del archivo generado para facilitar el diagnóstico en los logs.

Ejemplo de configuración de la fase Run Script:

```bash
export BRAND_ID=${BRAND_ID:?Debe definirse BRAND_ID}
export BRAND_NAME="Intrale Demo"
export BUNDLE_ID_SUFFIX=demo
"${SRCROOT}/../ios/scripts/prebuild_generate_branding.sh"
```

Al ejecutarse antes de `Compile Sources`, el proyecto siempre utilizará la versión más
reciente de `Branding.xcconfig` sin requerir intervención manual.

## Validaciones esperadas en CI

- Los logs de `xcodebuild` deben listar las variables inyectadas en `OTHER_CFLAGS` o en el
  entorno, confirmando que el wrapper propagó los parámetros.
- El archivo `ios/Branding.xcconfig` debe regenerarse en cada ejecución del pipeline con
  los valores solicitados antes de que inicie la compilación.
- No se versiona el resultado final porque está ignorado vía `.gitignore`.
