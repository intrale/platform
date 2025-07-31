package asdo

import ext.CommPasswordRecoveryService
import ext.ExceptionResponse
import ext.PasswordRecoveryResponse
import ext.toExceptionResponse

class DoConfirmPasswordRecovery(private val service: CommPasswordRecoveryService) : ToDoConfirmPasswordRecovery {
    override suspend fun execute(email: String, code: String, password: String): Result<DoConfirmPasswordRecoveryResult> {
        return try {
            service.confirm(email, code, password)
                .mapCatching { it.toDoConfirmPasswordRecoveryResult() }
                .recoverCatching { e ->
                    throw (e as? ExceptionResponse)?.toDoConfirmPasswordRecoveryException()
                        ?: e.toDoConfirmPasswordRecoveryException()
                }
        } catch (e: Exception) {
            Result.failure(e.toDoConfirmPasswordRecoveryException())
        }
    }
}

data class ConfirmPasswordRecoveryStatusCode(val value: Int, val description: String?)

data class DoConfirmPasswordRecoveryResult(val statusCode: ConfirmPasswordRecoveryStatusCode)

data class DoConfirmPasswordRecoveryException(val statusCode: ConfirmPasswordRecoveryStatusCode, override val message: String?) : Throwable(message)

fun PasswordRecoveryResponse.toDoConfirmPasswordRecoveryResult() = DoConfirmPasswordRecoveryResult(
    ConfirmPasswordRecoveryStatusCode(statusCode.value, statusCode.description)
)

fun ExceptionResponse.toDoConfirmPasswordRecoveryException() = DoConfirmPasswordRecoveryException(
    ConfirmPasswordRecoveryStatusCode(statusCode.value, statusCode.description),
    message ?: "Error desconocido durante la confirmación de contraseña"
)

fun Throwable.toDoConfirmPasswordRecoveryException() = DoConfirmPasswordRecoveryException(
    ConfirmPasswordRecoveryStatusCode(500, "Internal Server Error"),
    message ?: "Error desconocido durante la operación"
)
