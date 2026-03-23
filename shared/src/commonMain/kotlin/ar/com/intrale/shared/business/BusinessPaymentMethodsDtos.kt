package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class BusinessPaymentMethodDTO(
    val id: String = "",
    val name: String = "",
    val type: String = "",
    val enabled: Boolean = true,
    val isCashOnDelivery: Boolean = false,
    val description: String? = null
)

@Serializable
data class UpdatePaymentMethodRequestDTO(
    val id: String = "",
    val name: String = "",
    val type: String = "",
    val enabled: Boolean = true,
    val isCashOnDelivery: Boolean = false,
    val description: String? = null
)

@Serializable
data class UpdateBusinessPaymentMethodsRequest(
    val paymentMethods: List<UpdatePaymentMethodRequestDTO> = emptyList()
)

@Serializable
data class GetBusinessPaymentMethodsResponse(
    val statusCode: StatusCodeDTO,
    val paymentMethods: List<BusinessPaymentMethodDTO>
)

@Serializable
data class UpdateBusinessPaymentMethodsResponse(
    val statusCode: StatusCodeDTO,
    val paymentMethods: List<BusinessPaymentMethodDTO>
)
