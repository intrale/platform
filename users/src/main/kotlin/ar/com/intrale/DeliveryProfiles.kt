package ar.com.intrale

import io.ktor.http.HttpStatusCode

data class DeliveryVehiclePayload(
    val type: String = "",
    val model: String = "",
    val plate: String? = null
)

data class DeliveryZonePayload(
    val id: String = "",
    val name: String = "",
    val description: String? = null
)

data class DeliveryProfilePayload(
    val fullName: String = "",
    val email: String = "",
    val phone: String? = null,
    val vehicle: DeliveryVehiclePayload = DeliveryVehiclePayload()
)

data class DeliveryProfileResponse(
    val profile: DeliveryProfilePayload? = null,
    val zones: List<DeliveryZonePayload> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class DeliveryProfileUpdateRequest(
    val profile: DeliveryProfilePayload? = null
)

data class DeliveryProfileRecord(
    var profile: DeliveryProfilePayload = DeliveryProfilePayload(),
    val zones: MutableList<DeliveryZonePayload> = mutableListOf()
)

data class DeliveryAvailabilitySlotPayload(
    val dayOfWeek: String,
    val mode: String,
    val block: String? = null,
    val start: String? = null,
    val end: String? = null
)

data class DeliveryAvailabilityPayload(
    val timezone: String = "UTC",
    val slots: List<DeliveryAvailabilitySlotPayload> = emptyList()
)

data class DeliveryAvailabilityResponse(
    val timezone: String = "UTC",
    val slots: List<DeliveryAvailabilitySlotPayload> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
