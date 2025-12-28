package ext.delivery

import ext.dto.StatusCodeDTO
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class DeliveryExceptionResponse(
    val statusCode: StatusCodeDTO = StatusCodeDTO(500, "Internal Server Error"),
    override val message: String? = null
) : Throwable(message)

fun Throwable.toDeliveryException(): DeliveryExceptionResponse = when (this) {
    is DeliveryExceptionResponse -> this
    else -> DeliveryExceptionResponse(message = message ?: "Error inesperado")
}

fun String.toDeliveryException(): DeliveryExceptionResponse =
    runCatching { Json.decodeFromString(DeliveryExceptionResponse.serializer(), this) }
        .getOrElse { DeliveryExceptionResponse(message = this) }
