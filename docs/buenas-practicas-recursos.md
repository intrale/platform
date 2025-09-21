# Buenas prácticas para recursos de Compose

Este módulo utiliza `compose.resources` para empaquetar strings, fuentes y assets en archivos `.cvr` codificados en Base64. Para evitar regresiones como las que bloqueaban el acceso al Dashboard, seguí estas recomendaciones:

## Validación obligatoria en build/CI

- Ejecutá `./gradlew :app:composeApp:validateComposeResources` siempre antes de compilar. El pipeline de Gradle ya la encadena automáticamente a todas las tareas de compilación, pero podés correrla manualmente tras editar `strings.xml` u otros recursos.
- Si la validación detecta Base64 inválido o packs incompletos, el build falla con un error indicando el archivo y la línea problemática.
- Ante un fallo, corregí el recurso y volvé a generar los collectors con `./gradlew :app:composeApp:generateResourceAccessorsForCommonMain` antes de intentar compilar otra vez.

## Orden de tareas y dependencias

- Los compiladores de `commonMain`, Android, Desktop e iOS dependen ahora de:
  1. `generateExpectResourceCollectorsForCommonMain`
  2. `prepareComposeResourcesTaskForCommonMain`
  3. `generateResourceAccessorsForCommonMain`
  4. `validateComposeResources`
- No elimines estas dependencias: garantizan que los packs `.cvr` se encuentren completos y validados antes de compilar cualquier target multiplataforma.

## Fallback seguro en runtime

- Todas las pantallas consumen `safeString(Res.string.xxx)` en lugar de `stringResource`. Si Compose no puede decodificar un string, se registra un error `[RES_FALLBACK]` y se muestra un placeholder (`—`) sin romper la navegación.
- Revisá los logs de CI buscando `[RES_FALLBACK]` para detectar rápidamente placeholders en producción y programar la corrección del recurso.

## Checklist al editar recursos

1. Modificá o agregá tus strings en `app/composeApp/src/commonMain/composeResources/values/`.
2. Ejecutá `./gradlew :app:composeApp:validateComposeResources` para asegurarte de que el pack generado sea consistente.
3. Corré `./gradlew :app:composeApp:check` para verificar tests y evitar placeholders accidentales.
4. Revisa manualmente la app (login → dashboard) confirmando que no aparecen `—` ni logs `[RES_FALLBACK]` inesperados.

Documentá cualquier edge case en este archivo para que el equipo pueda mantener la estabilidad de los recursos.
