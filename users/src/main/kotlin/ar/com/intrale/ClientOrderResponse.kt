package ar.com.intrale

import io.ktor.http.HttpStatusCode

data class ClientOrderListResponse(
    val orders: List<ClientOrderPayload> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class ClientOrderDetailResponse(
    val order: ClientOrderPayload? = null,
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class CreateClientOrderResponse(
    val orderId: String = "",
    val shortCode: String = "",
    val status: HttpStatusCode = HttpStatusCode.Created
) : Response(statusCode = status)

data class PaymentStatusResponse(
    val orderId: String = "",
    val paymentStatus: String = "PENDING",
    val paymentId: String? = null,
    val paymentMethod: String? = null,
    val paidAmount: Double? = null,
    val failureReason: String? = null,
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
