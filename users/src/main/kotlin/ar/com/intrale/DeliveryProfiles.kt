package ar.com.intrale

import io.ktor.http.HttpStatusCode

data class DeliveryProfileResponse(
    val profile: DeliveryProfilePayload? = null,
    val zones: List<DeliveryZonePayload> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class DeliveryProfileRecord(
    var profile: DeliveryProfilePayload = DeliveryProfilePayload(),
    val zones: MutableList<DeliveryZonePayload> = mutableListOf()
)

data class DeliveryAvailabilityResponse(
    val timezone: String = "UTC",
    val slots: List<DeliveryAvailabilitySlotPayload> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
