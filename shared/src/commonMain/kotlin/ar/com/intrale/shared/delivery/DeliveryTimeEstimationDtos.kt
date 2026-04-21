package ar.com.intrale.shared.delivery

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Request para obtener la estimacion de tiempo de entrega de un pedido.
 */
@Serializable
data class DeliveryTimeEstimationRequestDTO(
    @SerialName("orderId")
    val orderId: String? = null,
    @SerialName("businessId")
    val businessId: String = "",
    @SerialName("deliveryLatitude")
    val deliveryLatitude: Double? = null,
    @SerialName("deliveryLongitude")
    val deliveryLongitude: Double? = null,
    @SerialName("deliveryAddress")
    val deliveryAddress: String? = null
)

/**
 * Respuesta con la estimacion de tiempo de entrega.
 */
@Serializable
data class DeliveryTimeEstimationDTO(
    @SerialName("estimatedMinutes")
    val estimatedMinutes: Int = 0,
    @SerialName("minMinutes")
    val minMinutes: Int = 0,
    @SerialName("maxMinutes")
    val maxMinutes: Int = 0,
    @SerialName("confidence")
    val confidence: Double = 0.0,
    @SerialName("displayText")
    val displayText: String = "",
    @SerialName("factors")
    val factors: DeliveryEstimationFactorsDTO = DeliveryEstimationFactorsDTO()
)

/**
 * Factores que contribuyen a la estimacion de tiempo.
 */
@Serializable
data class DeliveryEstimationFactorsDTO(
    @SerialName("activeOrders")
    val activeOrders: Int = 0,
    @SerialName("distanceKm")
    val distanceKm: Double? = null,
    @SerialName("hourOfDay")
    val hourOfDay: Int = 0,
    @SerialName("dayOfWeek")
    val dayOfWeek: Int = 0,
    @SerialName("historicalAvgMinutes")
    val historicalAvgMinutes: Double? = null
)

/**
 * Respuesta compartida de estimacion de tiempo.
 */
@Serializable
data class DeliveryTimeEstimationResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val estimation: DeliveryTimeEstimationDTO? = null
)

/**
 * Registro de estimacion vs tiempo real para aprendizaje.
 */
@Serializable
data class DeliveryTimeRecordDTO(
    @SerialName("orderId")
    val orderId: String = "",
    @SerialName("business")
    val business: String = "",
    @SerialName("estimatedMinutes")
    val estimatedMinutes: Int = 0,
    @SerialName("actualMinutes")
    val actualMinutes: Int? = null,
    @SerialName("distanceKm")
    val distanceKm: Double? = null,
    @SerialName("activeOrdersAtTime")
    val activeOrdersAtTime: Int = 0,
    @SerialName("hourOfDay")
    val hourOfDay: Int = 0,
    @SerialName("dayOfWeek")
    val dayOfWeek: Int = 0,
    @SerialName("createdAt")
    val createdAt: String? = null
)
