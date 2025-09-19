package asdo.auth

import ext.storage.CommKeyValueStorage
import ext.auth.CommTwoFactorSetupService
import ext.auth.ExceptionResponse
import ext.auth.TwoFactorSetupResponse
import ext.auth.toExceptionResponse

class DoTwoFactorSetup(
    private val service: CommTwoFactorSetupService,
    private val storage: CommKeyValueStorage
) : ToDoTwoFactorSetup {
    override suspend fun execute(): Result<DoTwoFactorSetupResult> {
        return try {
            val token = storage.token ?: return Result.failure(Exception("Token no encontrado"))
            service.execute(token)
                .mapCatching { it.toDoTwoFactorSetupResult() }
                .recoverCatching { e ->
                    throw (e as? ExceptionResponse)?.toDoTwoFactorSetupException()
                        ?: e.toDoTwoFactorSetupException()
                }
        } catch (e: Exception) {
            Result.failure(e.toDoTwoFactorSetupException())
        }
    }
}

data class TwoFactorSetupStatusCode(val value: Int, val description: String?)

data class DoTwoFactorSetupResult(val statusCode: TwoFactorSetupStatusCode, val otpAuthUri: String)

data class DoTwoFactorSetupException(
    val statusCode: TwoFactorSetupStatusCode,
    override val message: String?
) : Throwable(message)

fun TwoFactorSetupResponse.toDoTwoFactorSetupResult() = DoTwoFactorSetupResult(
    TwoFactorSetupStatusCode(statusCode.value, statusCode.description),
    otpAuthUri
)

fun ExceptionResponse.toDoTwoFactorSetupException() = DoTwoFactorSetupException(
    TwoFactorSetupStatusCode(statusCode.value, statusCode.description),
    message ?: "Error desconocido durante la configuración"
)

fun Throwable.toDoTwoFactorSetupException() = DoTwoFactorSetupException(
    TwoFactorSetupStatusCode(500, "Internal Server Error"),
    message ?: "Error desconocido durante la operación"
)

