package ar.com.intrale.shared.delivery

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Parada en la ruta de entrega, con coordenadas opcionales para optimización.
 */
@Serializable
data class RouteStopDTO(
    @SerialName("orderId")
    val orderId: String = "",
    val address: String = "",
    val latitude: Double? = null,
    val longitude: Double? = null,
    @SerialName("customerName")
    val customerName: String? = null,
    @SerialName("promisedAt")
    val promisedAt: String? = null
)

/**
 * Request para optimizar la ruta de entrega del repartidor.
 */
@Serializable
data class RouteOptimizationRequestDTO(
    val stops: List<RouteStopDTO> = emptyList(),
    @SerialName("currentLatitude")
    val currentLatitude: Double? = null,
    @SerialName("currentLongitude")
    val currentLongitude: Double? = null
)

/**
 * Parada optimizada con posición en el recorrido y distancia al punto anterior.
 */
@Serializable
data class OptimizedStopDTO(
    val position: Int = 0,
    @SerialName("orderId")
    val orderId: String = "",
    val address: String = "",
    val latitude: Double? = null,
    val longitude: Double? = null,
    @SerialName("customerName")
    val customerName: String? = null,
    @SerialName("promisedAt")
    val promisedAt: String? = null,
    @SerialName("distanceFromPrevious")
    val distanceFromPrevious: Double = 0.0
)

/**
 * Respuesta con la ruta optimizada.
 */
@Serializable
data class RouteOptimizationResponseDTO(
    val stops: List<OptimizedStopDTO> = emptyList(),
    @SerialName("totalDistanceKm")
    val totalDistanceKm: Double = 0.0,
    @SerialName("estimatedSavingsPercent")
    val estimatedSavingsPercent: Double = 0.0,
    @SerialName("googleMapsUrl")
    val googleMapsUrl: String? = null
)
