package asdo.client

/**
 * Modelo de dominio para la estimacion de tiempo de entrega.
 * Mapea DeliveryTimeEstimationDTO del shared module a un formato listo para UI.
 */
data class DeliveryTimeEstimation(
    val estimatedMinutes: Int,
    val minMinutes: Int,
    val maxMinutes: Int,
    val confidence: Double,
    val displayText: String,
    val factors: DeliveryEstimationFactors = DeliveryEstimationFactors()
)

/**
 * Factores visibles al cliente que influyen en la estimacion.
 */
data class DeliveryEstimationFactors(
    val activeOrders: Int = 0,
    val distanceKm: Double? = null,
    val hourOfDay: Int = 0,
    val dayOfWeek: Int = 0,
    val historicalAvgMinutes: Double? = null
)

/**
 * Obtiene la estimacion de tiempo para un pedido existente.
 * Usado en pantallas de seguimiento post-creacion del pedido.
 */
interface ToDoGetDeliveryTimeEstimation {
    suspend fun execute(orderId: String): Result<DeliveryTimeEstimation>
}

/**
 * Calcula una estimacion preliminar antes de confirmar el pedido,
 * para mostrar "Tu pedido llegara en ~X minutos" durante el checkout.
 */
interface ToDoCalculateDeliveryTimeEstimation {
    suspend fun execute(
        deliveryLatitude: Double? = null,
        deliveryLongitude: Double? = null,
        deliveryAddress: String? = null
    ): Result<DeliveryTimeEstimation>
}

/**
 * Registra el tiempo real de entrega (estimado vs real) para mejorar el modelo.
 */
interface ToDoRecordActualDeliveryTime {
    suspend fun execute(
        orderId: String,
        estimatedMinutes: Int,
        actualMinutes: Int,
        activeOrdersAtTime: Int = 0,
        distanceKm: Double? = null,
        hourOfDay: Int = 0,
        dayOfWeek: Int = 0
    ): Result<Unit>
}
