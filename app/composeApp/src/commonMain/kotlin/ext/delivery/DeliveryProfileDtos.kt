package ext.delivery

import kotlinx.serialization.Serializable

@Serializable
data class DeliveryProfileDTO(
    val fullName: String = "",
    val email: String = "",
    val phone: String? = null,
    val vehicle: DeliveryVehicleDTO = DeliveryVehicleDTO()
)

@Serializable
data class DeliveryVehicleDTO(
    val type: String = "",
    val model: String = "",
    val plate: String? = null
)

@Serializable
data class DeliveryZoneDTO(
    val id: String = "",
    val name: String = "",
    val description: String? = null
)

@Serializable
data class DeliveryProfileResponse(
    val profile: DeliveryProfileDTO? = null,
    val zones: List<DeliveryZoneDTO> = emptyList()
)

@Serializable
data class DeliveryAvailabilityDTO(
    val timezone: String = "",
    val slots: List<DeliveryAvailabilitySlotDTO> = emptyList()
)

@Serializable
data class DeliveryAvailabilitySlotDTO(
    val dayOfWeek: String,
    val mode: String,
    val block: String? = null,
    val start: String? = null,
    val end: String? = null
)
