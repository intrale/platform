package asdo.auth

import ext.storage.CommKeyValueStorage
import ext.auth.CommTwoFactorVerifyService
import ext.auth.ExceptionResponse
import ext.auth.TwoFactorVerifyResponse
import ext.auth.toExceptionResponse

class DoTwoFactorVerify(
    private val service: CommTwoFactorVerifyService,
    private val storage: CommKeyValueStorage
) : ToDoTwoFactorVerify {
    override suspend fun execute(code: String): Result<DoTwoFactorVerifyResult> {
        return try {
            val token = storage.token ?: return Result.failure(Exception("Token no encontrado"))
            service.execute(code, token)
                .mapCatching { it.toDoTwoFactorVerifyResult() }
                .recoverCatching { e ->
                    throw (e as? ExceptionResponse)?.toDoTwoFactorVerifyException()
                        ?: e.toDoTwoFactorVerifyException()
                }
        } catch (e: Exception) {
            Result.failure(e.toDoTwoFactorVerifyException())
        }
    }
}

data class TwoFactorVerifyStatusCode(val value: Int, val description: String?)

data class DoTwoFactorVerifyResult(val statusCode: TwoFactorVerifyStatusCode)

data class DoTwoFactorVerifyException(
    val statusCode: TwoFactorVerifyStatusCode,
    override val message: String?
) : Throwable(message)

fun TwoFactorVerifyResponse.toDoTwoFactorVerifyResult() = DoTwoFactorVerifyResult(
    TwoFactorVerifyStatusCode(statusCode.value, statusCode.description)
)

fun ExceptionResponse.toDoTwoFactorVerifyException() = DoTwoFactorVerifyException(
    TwoFactorVerifyStatusCode(statusCode.value, statusCode.description),
    message ?: "Error desconocido durante la verificación"
)

fun Throwable.toDoTwoFactorVerifyException() = DoTwoFactorVerifyException(
    TwoFactorVerifyStatusCode(500, "Internal Server Error"),
    message ?: "Error desconocido durante la operación"
)

