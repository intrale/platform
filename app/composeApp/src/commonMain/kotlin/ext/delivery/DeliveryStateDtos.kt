package ext.delivery

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class DeliveryStateChangeRequest(
    @SerialName("orderId")
    val orderId: String,
    val state: String
)

@Serializable
data class DeliveryStateChangeResponse(
    @SerialName("orderId")
    val orderId: String = "",
    val state: String = "",
    val message: String? = null
)
