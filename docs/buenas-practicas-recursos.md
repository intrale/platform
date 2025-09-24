# Buenas prácticas para recursos de Compose

Este módulo utiliza `compose.resources` para empaquetar strings, fuentes y assets en archivos `.cvr` codificados en Base64. Para evitar regresiones como las que bloqueaban el acceso al Dashboard, seguí estas recomendaciones:

## Auditoría periódica de catálogos

- Revisá `app/composeApp/src/commonMain/composeResources/values/strings.xml` y verificá que los textos sensibles del Dashboard sigan legibles. Las entradas auditadas al 24/09/2025 fueron:
  - `dashboard_menu_hint`
  - `semi_circular_menu_open`
  - `semi_circular_menu_close`
  - `semi_circular_menu_long_press_hint`
  - `buttons_preview`
- Regenerá los packs con:
  ```bash
  ./gradlew clean
  rm -rf app/composeApp/build/generated/compose
  ./gradlew :app:composeApp:assembleDebug
  ```
  Esto asegura que los artefactos `.cvr` reflejen los cambios y queden listos para validarse en CI.
- Si necesitás conservar artefactos generados, agregalos al `.gitignore` en lugar de commitearlos.

## Validación obligatoria en build/CI

- Ejecutá `./gradlew :app:composeApp:validateComposeResources` siempre antes de compilar. El pipeline de Gradle ya la encadena automáticamente a todas las tareas de compilación, además de `check` y `assemble`.
- `./gradlew :app:composeApp:scanNonAsciiFallbacks` se ejecuta junto con `check` y falla cuando detecta `fb("…")` con caracteres fuera del rango ASCII. Mantené los literales sanitizados para que la verificación pase en CI.
- La validación ahora falla cuando encuentra:
  - Base64 inválido en los `.cvr` generados.
  - Cadenas decodificadas que contienen caracteres no imprimibles.
  - Valores que parecen ser Base64 incrustado (por ejemplo, `U29tZQ==`).
- Ante un fallo, corregí el recurso y volvé a generar los collectors con `./gradlew :app:composeApp:generateResourceAccessorsForCommonMain` antes de intentar compilar otra vez.

## Orden de tareas y dependencias

- Los compiladores de `commonMain`, Android, Desktop e iOS dependen ahora de:
  1. `generateExpectResourceCollectorsForCommonMain`
  2. `prepareComposeResourcesTaskForCommonMain`
  3. `generateResourceAccessorsForCommonMain`
  4. `validateComposeResources`
- No elimines estas dependencias: garantizan que los packs `.cvr` se encuentren completos y validados antes de compilar cualquier target multiplataforma o ejecutar pruebas.

## Fallback seguro en runtime

- Usá `resString(composeId = …, fallbackAsciiSafe = RES_ERROR_PREFIX + fb("…"))` como helper oficial para componer textos. El helper prioriza los recursos nativos de cada plataforma, valida que el fallback sea ASCII-safe y registra en los logs `[RES_FALLBACK]` cuando aplica una cadena alternativa.
- Prefijá todos los fallbacks visibles con `RES_ERROR_PREFIX` (`⚠ `) y sanitizá el contenido legible con `fb("…")`. Así el usuario final entiende que se trata de un contenido alternativo y los analistas pueden detectarlo rápidamente en capturas o sesiones de testing.
- `safeString` se mantiene disponible para casos puntuales (por ejemplo, ViewModels que sólo muestran placeholders), pero la navegación debe migrar a `resString` + `fb` para garantizar verificaciones ASCII y logging consistente.
- La capa de UI no debe importar `kotlin.io.encoding.Base64`. Si necesitás decodificar payloads hacelo en dominio/datos con helpers dedicados (por ejemplo `decodeBase64OrNull`) y pasá los resultados ya procesados a la UI.
- Revisá los logs de CI buscando `[RES_FALLBACK]` y la métrica `total=` para saber cuántos recursos están devolviendo fallbacks.

## Checklist al editar recursos

1. Modificá o agregá tus strings en `app/composeApp/src/commonMain/composeResources/values/`.
2. Ejecutá `./gradlew :app:composeApp:validateComposeResources` para asegurarte de que el pack generado sea consistente.
3. Corré `./gradlew :app:composeApp:check` para verificar tests y evitar placeholders accidentales.
4. Revisa manualmente la app (login → dashboard) confirmando que no aparecen `—` ni logs `[RES_FALLBACK]` inesperados.

Documentá cualquier edge case en este archivo para que el equipo pueda mantener la estabilidad de los recursos.
