package ext.client

import ext.dto.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class ClientOrderDTO(
    val id: String? = null,
    val publicId: String = "",
    val shortCode: String = "",
    val businessName: String = "",
    val status: String = "",
    val createdAt: String = "",
    val promisedAt: String? = null,
    val total: Double = 0.0,
    val itemCount: Int = 0
)

@Serializable
data class ClientOrderDetailDTO(
    val id: String? = null,
    val publicId: String = "",
    val shortCode: String = "",
    val businessName: String = "",
    val status: String = "",
    val createdAt: String = "",
    val promisedAt: String? = null,
    val total: Double = 0.0,
    val itemCount: Int = 0,
    val items: List<ClientOrderItemDTO> = emptyList(),
    val address: ClientAddressDTO? = null
)

@Serializable
data class ClientOrderItemDTO(
    val id: String? = null,
    val name: String = "",
    val quantity: Int = 0,
    val unitPrice: Double = 0.0,
    val subtotal: Double = 0.0
)

@Serializable
data class ClientOrdersResponse(
    val statusCode: StatusCodeDTO? = null,
    val orders: List<ClientOrderDTO>? = null
)

@Serializable
data class ClientOrderDetailResponse(
    val statusCode: StatusCodeDTO? = null,
    val order: ClientOrderDetailDTO? = null
)
