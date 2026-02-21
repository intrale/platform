package ext.delivery

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class DeliveryOrdersSummaryDTO(
    val pending: Int = 0,
    @SerialName("inProgress")
    val inProgress: Int = 0,
    val delivered: Int = 0
)

@Serializable
data class DeliveryOrderDTO(
    val id: String = "",
    @SerialName("publicId")
    val publicId: String? = null,
    @SerialName("shortCode")
    val shortCode: String? = null,
    val businessName: String = "",
    val neighborhood: String = "",
    val status: String = "",
    @SerialName("promisedAt")
    val promisedAt: String? = null,
    @SerialName("eta")
    val eta: String? = null,
    val distance: String? = null
)

@Serializable
data class DeliveryOrderStatusUpdateRequest(
    @SerialName("orderId")
    val orderId: String,
    val status: String
)

@Serializable
data class DeliveryOrderStatusUpdateResponse(
    @SerialName("orderId")
    val orderId: String = "",
    val status: String = "",
    val message: String? = null
)
