package ext.client

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class ClientExceptionResponse(
    val statusCode: StatusCodeDTO = StatusCodeDTO(500, "Internal Server Error"),
    override val message: String? = null
) : Throwable(message)

fun Throwable.toClientException(): ClientExceptionResponse = when (this) {
    is ClientExceptionResponse -> this
    else -> ClientExceptionResponse(message = message ?: "Error inesperado")
}
