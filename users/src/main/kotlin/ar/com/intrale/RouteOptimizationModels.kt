package ar.com.intrale

import io.ktor.http.HttpStatusCode

/**
 * Request para optimización de ruta (parseado desde JSON con Gson).
 */
data class RouteOptimizationRequest(
    val stops: List<RouteStopRequest> = emptyList(),
    val currentLatitude: Double? = null,
    val currentLongitude: Double? = null
)

data class RouteStopRequest(
    val orderId: String = "",
    val address: String = "",
    val latitude: Double? = null,
    val longitude: Double? = null,
    val customerName: String? = null,
    val promisedAt: String? = null
)

/**
 * Parada optimizada en la respuesta.
 */
data class OptimizedStopResponse(
    val position: Int = 0,
    val orderId: String = "",
    val address: String = "",
    val latitude: Double? = null,
    val longitude: Double? = null,
    val customerName: String? = null,
    val promisedAt: String? = null,
    val distanceFromPrevious: Double = 0.0
)

/**
 * Respuesta con la ruta optimizada.
 */
data class RouteOptimizationResponse(
    val stops: List<OptimizedStopResponse> = emptyList(),
    val totalDistanceKm: Double = 0.0,
    val estimatedSavingsPercent: Double = 0.0,
    val googleMapsUrl: String? = null,
    val message: String? = null,
    val responseStatus: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = responseStatus)
