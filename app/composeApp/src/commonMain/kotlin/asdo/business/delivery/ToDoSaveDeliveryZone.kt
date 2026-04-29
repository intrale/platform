package asdo.business.delivery

/**
 * Contrato del caso de uso para guardar una nueva zona de entrega circular.
 *
 * STUB temporal hasta la entrega real en #2446.
 * El contrato `suspend fun execute(draft): Result<DeliveryZone>` está acordado
 * con la fase de definición y debería mantenerse estable.
 */
interface ToDoSaveDeliveryZone {
    suspend fun execute(draft: DeliveryZoneDraft): Result<DeliveryZone>
}

/** Excepciones específicas devueltas por el caso de uso de save. */
sealed class DoSaveDeliveryZoneException(message: String) : Exception(message) {
    /** Tope de zonas alcanzado en servidor (HTTP 409). */
    class LimitReached : DoSaveDeliveryZoneException("Limite de 10 zonas alcanzado")

    /** Validaciones client-side que el servidor rechazó. */
    class ValidationFailed(message: String) : DoSaveDeliveryZoneException(message)

    /** Error de red / timeout / 5xx. */
    class Generic(message: String, override val cause: Throwable? = null) : DoSaveDeliveryZoneException(message)
}
