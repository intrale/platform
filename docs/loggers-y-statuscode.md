# Uso obligatorio de loggers y estructura de respuestas

Este documento establece las reglas para implementar `org.slf4j.Logger` en todas las clases nuevas y define el modelo estándar de respuestas de servicio con `statusCode`.

## Inicialización de loggers

Cada clase debe declarar un logger utilizando `LoggerFactory` para registrar pasos relevantes y errores. Esto permite un seguimiento unificado en los distintos módulos.

```kotlin
import org.slf4j.Logger
import org.slf4j.LoggerFactory

class EjemploService {
    private val logger: Logger = LoggerFactory.getLogger(EjemploService::class.java)

    fun procesar() {
        logger.info("Inicio del proceso")
        // ... lógica del servicio
        logger.info("Fin del proceso")
    }
}
```

## Modelo de respuesta con `statusCode`

Las funciones de servicio deben devolver objetos que incluyan un `statusCode` compuesto por un código numérico y una descripción. Esto facilita el manejo de resultados y errores desde los clientes.

```kotlin
data class StatusCode(val value: Int, val description: String?)

data class Resultado<T>(val statusCode: StatusCode, val data: T?)
```

Un ejemplo de construcción de la respuesta es el siguiente:

```kotlin
fun login(...): Resultado<String> {
    return try {
        val token = autenticarUsuario(...)
        Resultado(StatusCode(200, "Autenticación exitosa"), token)
    } catch (e: Exception) {
        logger.error("Error de autenticación", e)
        Resultado(StatusCode(401, e.message), null)
    }
}
```

Relacionado con #147.
