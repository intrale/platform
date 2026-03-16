package ar.com.intrale.shared

import kotlinx.serialization.Serializable

@Serializable
data class StatusCodeDTO(val value: Int, val description: String?)

@Serializable
data class ExceptionResponse(
    val statusCode: StatusCodeDTO,
    override val message: String? = null
) : Throwable(message)

fun Exception.toExceptionResponse(): ExceptionResponse = ExceptionResponse(
    statusCode = StatusCodeDTO(500, "Internal Server Error"),
    message = this.message ?: "An unexpected error occurred"
)
