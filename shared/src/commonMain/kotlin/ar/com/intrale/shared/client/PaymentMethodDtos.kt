package ar.com.intrale.shared.client

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class PaymentMethodDTO(
    val id: String = "",
    val name: String = "",
    val type: String = "",
    val description: String? = null,
    @SerialName("isCashOnDelivery")
    val isCashOnDelivery: Boolean = false,
    val enabled: Boolean = true
)

@Serializable
data class PaymentMethodsResponse(
    val statusCode: StatusCodeDTO? = null,
    val paymentMethods: List<PaymentMethodDTO>? = null
)
