# Forbidden Strings Processor (KSP)

Este módulo agrega un **Symbol Processor** de KSP que impide compilar si se utilizan APIs antiguas de acceso a strings.

## Qué bloquea
- `org.jetbrains.compose.resources.stringResource(...)`
- `androidx.compose.ui.res.stringResource(...)`
- `android.content.Context.getString(...)`
- `android.content.res.Resources.getString(...)`
- Cualquier referencia a `R.string.*`

## Mensaje de error
El build se detiene con un error indicando el símbolo prohibido, la ruta del archivo y la línea exacta. El mensaje siempre incluye la sugerencia:

```
➡️ Migra a: L10n.t(S.AlgunaClave)
Si necesitás interpolación: L10n.t(S.XYZ, args = mapOf("clave" to valor))
```

## Configuración
Agregá el módulo como dependencia de KSP en cada target y en `kspCommonMainMetadata`.

```
ksp {
    arg("forbidden.i18n.allowTests", "false")
}
```

Para permitir los usos en tests ejecutá Gradle con:

```
./gradlew -Pforbidden.i18n.allowTests=true <tarea>
```
