package ar.com.intrale.shared.delivery

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class DeliveryOrderItemDTO(
    val name: String = "",
    val quantity: Int = 1,
    val notes: String? = null
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
    val eta: String? = null,
    val distance: String? = null,
    val address: String? = null,
    @SerialName("addressNotes")
    val addressNotes: String? = null,
    val items: List<DeliveryOrderItemDTO> = emptyList(),
    val notes: String? = null,
    @SerialName("customerName")
    val customerName: String? = null,
    @SerialName("customerPhone")
    val customerPhone: String? = null,
    @SerialName("paymentMethod")
    val paymentMethod: String? = null,
    @SerialName("collectOnDelivery")
    val collectOnDelivery: Boolean? = null,
    @SerialName("assignedTo")
    val assignedTo: String? = null,
    @SerialName("createdAt")
    val createdAt: String? = null,
    @SerialName("updatedAt")
    val updatedAt: String? = null,
    @SerialName("businessAddress")
    val businessAddress: String? = null,
    @SerialName("businessLatitude")
    val businessLatitude: Double? = null,
    @SerialName("businessLongitude")
    val businessLongitude: Double? = null,
    @SerialName("customerLatitude")
    val customerLatitude: Double? = null,
    @SerialName("customerLongitude")
    val customerLongitude: Double? = null
)

@Serializable
data class DeliveryOrdersSummaryDTO(
    val pending: Int = 0,
    @SerialName("inProgress")
    val inProgress: Int = 0,
    val delivered: Int = 0
)

@Serializable
data class DeliveryOrderStatusUpdateRequest(
    @SerialName("orderId")
    val orderId: String,
    val status: String,
    val reason: String? = null
)

@Serializable
data class DeliveryOrderStatusUpdateResponse(
    @SerialName("orderId")
    val orderId: String = "",
    val status: String = "",
    val message: String? = null
)
