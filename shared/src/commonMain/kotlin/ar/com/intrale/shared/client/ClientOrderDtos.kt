package ar.com.intrale.shared.client

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class ClientOrderItemDTO(
    val id: String? = null,
    val productId: String = "",
    val productName: String = "",
    val name: String = "",
    val quantity: Int = 0,
    val unitPrice: Double = 0.0,
    val subtotal: Double = 0.0
)

@Serializable
data class ClientOrderDTO(
    val id: String? = null,
    val publicId: String = "",
    val shortCode: String? = null,
    val businessName: String = "",
    val status: String = "",
    val items: List<ClientOrderItemDTO> = emptyList(),
    val total: Double = 0.0,
    val deliveryAddress: ClientAddressDTO? = null,
    val notes: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val promisedAt: String? = null,
    val itemCount: Int = 0
)

@Serializable
data class ClientOrderStatusEventDTO(
    val status: String = "",
    val timestamp: String = "",
    val message: String? = null
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
    val address: ClientAddressDTO? = null,
    val paymentMethod: String? = null,
    val statusHistory: List<ClientOrderStatusEventDTO> = emptyList(),
    val businessMessage: String? = null,
    val businessPhone: String? = null
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

@Serializable
data class ClientOrderRequest(
    val orderId: String? = null
)
