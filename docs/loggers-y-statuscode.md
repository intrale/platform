# Uso obligatorio de loggers y modelo de resultados

Este documento establece las reglas para implementar `org.slf4j.Logger` en todas las clases nuevas y describe el patrón de respuestas basado en `HttpStatusCode` que consumen los clientes multiplataforma mediante `Result<T>`.

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

El módulo `users` sigue este esquema en funciones como `ChangePassword`, donde se loguean las validaciones y cualquier excepción al invocar `CognitoIdentityProviderClient.changePassword`.

## Modelo de respuestas en el backend

- Todas las funciones deben devolver un subtipo de `Response`, el cual encapsula el `HttpStatusCode` enviado al cliente.
- `RequestValidationException`, `UnauthorizedException` y `ExceptionResponse` representan escenarios de validación, autenticación y fallos inesperados respectivamente.
- Las clases concretas pueden agregar datos (por ejemplo `TwoFactorSetupResponse` agrega `otpAuthUri`).

Ejemplo simplificado tomado de `ChangePassword`:

```kotlin
override suspend fun securedExecute(...): Response {
    if (textBody.isEmpty()) return RequestValidationException("Request body not found")
    val body = Gson().fromJson(textBody, ChangePasswordRequest::class.java)
    val response = requestValidation(body)
    if (response != null) return response

    val token = headers["Authorization"] ?: return UnauthorizedException()

    return try {
        cognito.changePassword(...)
        Response()
    } catch (e: Exception) {
        logger.error("Error al cambiar contraseña: ${'$'}{e.message}", e)
        ExceptionResponse(e.message ?: "Internal Server Error")
    }
}
```

El JSON resultante siempre incluye un nodo `statusCode` con `value` y `description`, lo que permite a los clientes distinguir éxitos de errores sin analizar strings.

## Consumo en la app Compose Multiplatform

Los servicios HTTP (`ClientLoginService`, `ClientChangePasswordService`, etc.) devuelven `Result<T>`, propagando tanto la respuesta exitosa como un `ExceptionResponse` serializado cuando el backend envía un error. Las capas `Do*` aplican `mapCatching`/`recoverCatching` para transformar el `Result` sin perder el `StatusCodeDTO`:

```kotlin
return commLogin.execute(...)
    .mapCatching { it.toDoLoginResult() }
    .recoverCatching { e ->
        throw (e as? ExceptionResponse)?.toDoLoginException() ?: e.toDoLoginException()
    }
```

Este enfoque unifica la forma en que se manejan los errores entre Android, iOS, escritorio y web, manteniendo la trazabilidad gracias a los logs obligatorios en el backend.
