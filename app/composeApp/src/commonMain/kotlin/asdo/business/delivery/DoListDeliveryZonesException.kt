package asdo.business.delivery

import ar.com.intrale.shared.ExceptionResponse

/**
 * Excepcion del caso de uso DoListDeliveryZones (split 1 de #2420).
 *
 * Sigue el patron del proyecto (asdo.*Exception) para que la UI pueda
 * distinguir errores de dominio de errores de transporte.
 */
class DoListDeliveryZonesException(
    override val message: String? = null,
    override val cause: Throwable? = null,
    val httpStatus: Int? = null
) : Exception(message, cause)

/**
 * Adapta un Throwable cualquiera a DoListDeliveryZonesException, preservando
 * el statusCode si proviene de un ExceptionResponse del backend.
 */
fun Throwable.toDoListDeliveryZonesException(): DoListDeliveryZonesException {
    if (this is DoListDeliveryZonesException) return this
    val httpStatus = (this as? ExceptionResponse)?.statusCode?.value
    return DoListDeliveryZonesException(
        message = message ?: "Error al listar zonas de delivery",
        cause = this,
        httpStatus = httpStatus
    )
}
