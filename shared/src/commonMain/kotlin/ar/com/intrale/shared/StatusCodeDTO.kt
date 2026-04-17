package ar.com.intrale.shared

import kotlinx.serialization.Serializable

@Serializable
data class StatusCodeDTO(val value: Int, val description: String?)

@Serializable
data class ExceptionResponse(
    val statusCode: StatusCodeDTO,
    override val message: String? = null
) : Throwable(message)

/**
 * Issue #2285 — CA-2 / CA-4: nombres simples de excepciones Ktor que representan timeout HTTP.
 * Detectamos por `simpleName` para no acoplar el modulo `shared` (compartido con backend)
 * a dependencias del cliente Ktor.
 */
private val HTTP_TIMEOUT_EXCEPTION_SIMPLE_NAMES = setOf(
    "HttpRequestTimeoutException",
    "HttpConnectTimeoutException",
    "HttpSocketTimeoutException",
    "ConnectTimeoutException",
    "SocketTimeoutException",
)

/** Mensaje generico, accionable y sin info sensible, usado al detectar timeouts. */
private const val HTTP_TIMEOUT_GENERIC_MESSAGE: String =
    "No pudimos conectarnos al servidor. Proba de nuevo en unos segundos."

/** Status code HTTP 408 (Request Timeout) — RFC 7231. */
private const val HTTP_TIMEOUT_STATUS_VALUE: Int = 408
private const val HTTP_TIMEOUT_STATUS_DESCRIPTION: String = "Request Timeout"

private fun Throwable.isHttpTimeoutByName(): Boolean {
    var current: Throwable? = this
    val seen = HashSet<Throwable>()
    while (current != null && seen.add(current)) {
        val name = current::class.simpleName
        if (name != null && name in HTTP_TIMEOUT_EXCEPTION_SIMPLE_NAMES) return true
        current = current.cause
    }
    return false
}

/**
 * Mapea una excepcion a `ExceptionResponse`.
 *
 * Cuando la excepcion es un timeout HTTP (detectado por simpleName), produce
 * un mensaje generico sin URLs, headers ni parametros de query (issue #2285,
 * OWASP A04 / A09). Para otros errores se conserva el mensaje original.
 */
fun Exception.toExceptionResponse(): ExceptionResponse {
    if (isHttpTimeoutByName()) {
        return ExceptionResponse(
            statusCode = StatusCodeDTO(HTTP_TIMEOUT_STATUS_VALUE, HTTP_TIMEOUT_STATUS_DESCRIPTION),
            message = HTTP_TIMEOUT_GENERIC_MESSAGE,
        )
    }
    return ExceptionResponse(
        statusCode = StatusCodeDTO(500, "Internal Server Error"),
        message = this.message ?: "An unexpected error occurred",
    )
}
