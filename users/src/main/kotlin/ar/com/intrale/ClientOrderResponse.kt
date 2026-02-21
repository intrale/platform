package ar.com.intrale

import io.ktor.http.HttpStatusCode

data class ClientOrderItemPayload(
    val productId: String = "",
    val productName: String = "",
    val quantity: Int = 1,
    val unitPrice: Double = 0.0,
    val subtotal: Double = 0.0
)

data class ClientOrderPayload(
    val id: String = "",
    val shortCode: String? = null,
    val status: String = "pending",
    val items: List<ClientOrderItemPayload> = emptyList(),
    val total: Double = 0.0,
    val deliveryAddress: ClientAddressPayload? = null,
    val notes: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

data class ClientOrderListResponse(
    val orders: List<ClientOrderPayload> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class ClientOrderDetailResponse(
    val order: ClientOrderPayload? = null,
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
