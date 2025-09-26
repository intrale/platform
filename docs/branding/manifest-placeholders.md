# Manifest placeholders de branding

Los valores visibles de la app Android y los deeplinks se parametrizan mediante *manifest placeholders* definidos en el módulo `composeApp`.

- **Archivo**: `app/composeApp/build.gradle.kts`
- **Sección**: `android > defaultConfig`
- **Placeholders**:
  - `appLabel`: se alimenta con el valor calculado de `brandName` y define el atributo `android:label` del `AndroidManifest`.
  - `deeplinkHost`: se genera a partir de la propiedad `deeplinkHost` y se utiliza en el `<data android:host=…>` del intent-filter de deeplinks.

Para verificar el wiring, ejecutar un build con los parámetros de marca correspondientes (`-PbrandId`, `-PbrandName`, `-PdeeplinkHost`) y revisar el `AndroidManifest.xml` empaquetado mediante `aapt dump badging`.
