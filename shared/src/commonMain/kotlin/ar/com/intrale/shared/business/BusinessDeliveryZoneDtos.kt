package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
enum class BusinessDeliveryZoneType { RADIUS, POSTAL_CODES }

@Serializable
data class BusinessDeliveryZoneDTO(
    val businessId: String = "",
    val type: BusinessDeliveryZoneType = BusinessDeliveryZoneType.RADIUS,
    val radiusKm: Double = 0.0,
    val postalCodes: List<String> = emptyList()
)

@Serializable
data class UpdateBusinessDeliveryZoneRequest(
    val type: BusinessDeliveryZoneType,
    val radiusKm: Double = 0.0,
    val postalCodes: List<String> = emptyList()
)

@Serializable
data class GetBusinessDeliveryZoneResponse(
    val statusCode: StatusCodeDTO,
    val deliveryZone: BusinessDeliveryZoneDTO
)

@Serializable
data class UpdateBusinessDeliveryZoneResponse(
    val statusCode: StatusCodeDTO,
    val deliveryZone: BusinessDeliveryZoneDTO
)
