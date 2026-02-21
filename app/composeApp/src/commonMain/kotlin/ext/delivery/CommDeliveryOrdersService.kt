package ext.delivery

import kotlinx.datetime.LocalDate

interface CommDeliveryOrdersService {
    suspend fun fetchSummary(date: LocalDate): Result<DeliveryOrdersSummaryDTO>
    suspend fun fetchActiveOrders(): Result<List<DeliveryOrderDTO>>
    suspend fun fetchAvailableOrders(): Result<List<DeliveryOrderDTO>>
    suspend fun updateOrderStatus(orderId: String, newStatus: String): Result<DeliveryOrderStatusUpdateResponse>
}
