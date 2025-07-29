package  asdo

import ext.ClientLoginService
import ext.CommKeyValueStorage
import ext.CommLoginService
import ext.ExceptionResponse
import ext.LoginResponse
import ext.StatusCodeDTO
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import kotlin.Result

class DoLogin(
    val commLogin: CommLoginService,
    val commKeyValueStorage: CommKeyValueStorage
) : ToDoLogin{

    private val logger = LoggerFactory.default.newLogger<DoLogin>()

    override suspend fun execute(
        user: String,
        password: String,
        newPassword: String?,
        name: String?,
        familyName: String?
    ): Result<DoLoginResult> {
        try {
            if (commKeyValueStorage.token == null) {
                logger.info { "token is null" }

                val result: Result<LoginResponse> = commLogin.execute(
                    user,
                    password,
                    newPassword,
                    name,
                    familyName
                )
                                        .onSuccess { response ->
                                            logger.debug { "Login successful, storing token" }
                                            commKeyValueStorage.token = response.accessToken
                                        }
                return result
                            .mapCatching {
                                    logger.debug { "Login successful, mapping response to DoLoginResult" }
                                    it.toDoLoginResult()
                                }

                            .recoverCatching { e ->
                                logger.error { "recoverCatching Error during login: ${e.message}" }
                                throw (e as? ExceptionResponse)?.toDoLoginException()
                                    ?: e.toDoLoginException()
                             }
            }
            return Result.success(commKeyValueStorage.toDoLoginResult())
        } catch (e: Exception) {
            logger.error { "Error during login execution: ${e.message}" }
            return Result.failure(e.toDoLoginException())
        }
    }
}

data class StatusCode (val value: Int, val description: String?)
data class DoLoginResult(val statusCode: StatusCode, val accessToken: String? = null)
data class DoLoginException(val statusCode: StatusCode, override val message: String?): Throwable(message)

fun LoginResponse.toDoLoginResult(): DoLoginResult =
    DoLoginResult(
        statusCode = StatusCode(statusCode.value, statusCode.description),
        accessToken = accessToken
    )

fun ExceptionResponse.toDoLoginException(): DoLoginException = DoLoginException(
    statusCode = StatusCode(statusCode.value, statusCode.description),
    message = message ?: "Error desconocido durante el inicio de sesión"
)

fun CommKeyValueStorage.toDoLoginResult(): DoLoginResult = DoLoginResult(
    statusCode = StatusCode(200, "Token almacenado exitosamente"),
    accessToken = this.token
)

fun Throwable.toDoLoginException(): DoLoginException = DoLoginException(
    statusCode = StatusCode(500, "Internal Server Error"),
    message = message ?: "Error desconocido durante la operación"
)