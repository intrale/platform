package ar.com.intrale

import ar.com.intrale.shared.delivery.DeliveryStatusHistoryEntryDTO
import io.ktor.http.HttpStatusCode

data class DeliveryOrdersSummaryResponse(
    val pending: Int = 0,
    val inProgress: Int = 0,
    val delivered: Int = 0,
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class DeliveryOrderListResponse(
    val orders: List<DeliveryOrderPayload> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class DeliveryOrderDetailResponse(
    val id: String = "",
    val publicId: String? = null,
    val shortCode: String? = null,
    val businessName: String = "",
    val neighborhood: String = "",
    val status: String = "",
    val promisedAt: String? = null,
    val eta: String? = null,
    val distance: String? = null,
    val address: String? = null,
    val addressNotes: String? = null,
    val items: List<DeliveryOrderItemPayload> = emptyList(),
    val notes: String? = null,
    val customerName: String? = null,
    val customerPhone: String? = null,
    val paymentMethod: String? = null,
    val collectOnDelivery: Boolean? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val statusHistory: List<DeliveryStatusHistoryEntryDTO> = emptyList(),
    val responseStatus: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = responseStatus)

data class DeliveryOrderStatusUpdateResponse(
    val orderId: String = "",
    val status: String = "",
    val message: String? = null,
    val responseStatus: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = responseStatus)

data class DeliveryStateChangeResponse(
    val orderId: String = "",
    val state: String = "",
    val message: String? = null,
    val responseStatus: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = responseStatus)
