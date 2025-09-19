package asdo.auth

import ext.auth.CommChangePasswordService
import ext.storage.CommKeyValueStorage
import ext.auth.ChangePasswordResponse
import ext.auth.ExceptionResponse
import ext.auth.toExceptionResponse

class DoChangePassword(
    private val service: CommChangePasswordService,
    private val storage: CommKeyValueStorage
) : ToDoChangePassword {

    override suspend fun execute(oldPassword: String, newPassword: String): Result<DoChangePasswordResult> {
        return try {
            val token = storage.token ?: return Result.failure(Exception("Token no encontrado"))
            service.execute(oldPassword, newPassword, token)
                .mapCatching { it.toDoChangePasswordResult() }
                .recoverCatching { e ->
                    throw (e as? ExceptionResponse)?.toDoChangePasswordException()
                        ?: e.toDoChangePasswordException()
                }
        } catch (e: Exception) {
            Result.failure(e.toDoChangePasswordException())
        }
    }
}

data class ChangePasswordStatusCode(val value: Int, val description: String?)

data class DoChangePasswordResult(val statusCode: ChangePasswordStatusCode)

data class DoChangePasswordException(val statusCode: ChangePasswordStatusCode, override val message: String?): Throwable(message)

fun ChangePasswordResponse.toDoChangePasswordResult() = DoChangePasswordResult(
    ChangePasswordStatusCode(statusCode.value, statusCode.description)
)

fun ExceptionResponse.toDoChangePasswordException() = DoChangePasswordException(
    ChangePasswordStatusCode(statusCode.value, statusCode.description),
    message ?: "Error desconocido durante el cambio de contraseña"
)

fun Throwable.toDoChangePasswordException() = DoChangePasswordException(
    ChangePasswordStatusCode(500, "Internal Server Error"),
    message ?: "Error desconocido durante la operación"
)
