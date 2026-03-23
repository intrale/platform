package ar.com.intrale

import io.ktor.http.HttpStatusCode

data class DeliveryProfileResponse(
    val profile: DeliveryProfilePayload? = null,
    val zones: List<DeliveryZonePayload> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

enum class DeliveryPersonStatus { ACTIVE, INACTIVE, PENDING }

data class DeliveryProfileRecord(
    var profile: DeliveryProfilePayload = DeliveryProfilePayload(),
    val zones: MutableList<DeliveryZonePayload> = mutableListOf(),
    var status: DeliveryPersonStatus = DeliveryPersonStatus.PENDING
)

data class DeliveryAvailabilityResponse(
    val timezone: String = "UTC",
    val slots: List<DeliveryAvailabilitySlotPayload> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
