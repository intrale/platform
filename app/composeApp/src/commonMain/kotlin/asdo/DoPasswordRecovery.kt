package asdo

import ext.CommPasswordRecoveryService
import ext.ExceptionResponse
import ext.PasswordRecoveryResponse
import ext.toExceptionResponse

class DoPasswordRecovery(private val service: CommPasswordRecoveryService) : ToDoPasswordRecovery {
    override suspend fun execute(email: String): Result<DoPasswordRecoveryResult> {
        return try {
            service.recovery(email)
                .mapCatching { it.toDoPasswordRecoveryResult() }
                .recoverCatching { e ->
                    throw (e as? ExceptionResponse)?.toDoPasswordRecoveryException()
                        ?: e.toDoPasswordRecoveryException()
                }
        } catch (e: Exception) {
            Result.failure(e.toDoPasswordRecoveryException())
        }
    }
}

data class PasswordRecoveryStatusCode(val value: Int, val description: String?)

data class DoPasswordRecoveryResult(val statusCode: PasswordRecoveryStatusCode)

data class DoPasswordRecoveryException(val statusCode: PasswordRecoveryStatusCode, override val message: String?) : Throwable(message)

fun PasswordRecoveryResponse.toDoPasswordRecoveryResult() = DoPasswordRecoveryResult(
    PasswordRecoveryStatusCode(statusCode.value, statusCode.description)
)

fun ExceptionResponse.toDoPasswordRecoveryException() = DoPasswordRecoveryException(
    PasswordRecoveryStatusCode(statusCode.value, statusCode.description),
    message ?: "Error desconocido durante la recuperación de contraseña"
)

fun Throwable.toDoPasswordRecoveryException() = DoPasswordRecoveryException(
    PasswordRecoveryStatusCode(500, "Internal Server Error"),
    message ?: "Error desconocido durante la operación"
)
