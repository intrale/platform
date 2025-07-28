# Estándar de Manejo de Errores en Clases `Do[Nombre]`

Este documento describe el patrón recomendado para el manejo de excepciones en las clases `Do[...]` del módulo `app`.

## Patrón recomendado

Las implementaciones deben envolver la ejecución del servicio en un bloque `try` y utilizar `mapCatching` junto con `recoverCatching` para transformar resultados y propagar errores de manera uniforme.

```kotlin
override suspend fun execute(...): Result<DoXXXResult> {
    return try {
        service.execute(...)
            .mapCatching { it.toDoXXXResult() }
            .recoverCatching { e ->
                throw (e as? ExceptionResponse)?.toDoXXXException()
                    ?: e.toDoXXXException()
            }
    } catch (e: Exception) {
        Result.failure(e.toDoXXXException())
    }
}
```

### Beneficios
- Trazabilidad de fallos consistente.
- Propagación segura de excepciones de dominio.
- Mayor claridad en las pruebas de casos fallidos.

Relacionado con #130
