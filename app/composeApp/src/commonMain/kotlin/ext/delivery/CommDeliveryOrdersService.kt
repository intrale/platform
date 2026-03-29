package ext.delivery

import ar.com.intrale.shared.delivery.DeliveryOrderDTO
import ar.com.intrale.shared.delivery.DeliveryOrderStatusUpdateResponse
import ar.com.intrale.shared.delivery.DeliveryOrdersSummaryDTO
import kotlinx.datetime.LocalDate

interface CommDeliveryOrdersService {
    suspend fun fetchSummary(date: LocalDate): Result<DeliveryOrdersSummaryDTO>
    suspend fun fetchActiveOrders(): Result<List<DeliveryOrderDTO>>
    suspend fun fetchAvailableOrders(): Result<List<DeliveryOrderDTO>>
    suspend fun fetchHistoryOrders(): Result<List<DeliveryOrderDTO>>
    suspend fun updateOrderStatus(orderId: String, newStatus: String, reason: String? = null): Result<DeliveryOrderStatusUpdateResponse>
    suspend fun fetchOrderDetail(orderId: String): Result<DeliveryOrderDTO>
    suspend fun takeOrder(orderId: String): Result<DeliveryOrderStatusUpdateResponse>
}
