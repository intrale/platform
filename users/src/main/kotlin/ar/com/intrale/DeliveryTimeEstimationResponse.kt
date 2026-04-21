package ar.com.intrale

import io.ktor.http.HttpStatusCode

/**
 * Factores que contribuyen a la estimacion.
 */
data class EstimationFactorsPayload(
    val activeOrders: Int = 0,
    val distanceKm: Double? = null,
    val hourOfDay: Int = 0,
    val dayOfWeek: Int = 0,
    val historicalAvgMinutes: Double? = null
)

/**
 * Respuesta con la estimacion de tiempo de entrega.
 */
data class DeliveryTimeEstimationResponse(
    val estimatedMinutes: Int = 0,
    val minMinutes: Int = 0,
    val maxMinutes: Int = 0,
    val confidence: Double = 0.0,
    val displayText: String = "",
    val factors: EstimationFactorsPayload = EstimationFactorsPayload(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Request para registrar el tiempo real de entrega.
 */
data class RecordActualTimeRequest(
    val orderId: String = "",
    val actualMinutes: Int = 0
)

/**
 * Respuesta al registrar el tiempo real de entrega.
 */
data class RecordActualTimeResponse(
    val orderId: String = "",
    val estimatedMinutes: Int = 0,
    val actualMinutes: Int = 0,
    val deviationMinutes: Int = 0,
    val message: String = "",
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
