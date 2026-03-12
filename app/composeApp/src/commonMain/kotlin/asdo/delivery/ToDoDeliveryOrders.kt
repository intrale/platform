package asdo.delivery

import kotlinx.datetime.LocalDate

interface ToDoGetActiveDeliveryOrders {
    suspend fun execute(): Result<List<DeliveryOrder>>
}

interface ToDoGetDeliveryOrdersSummary {
    suspend fun execute(date: LocalDate): Result<DeliveryOrdersSummary>
}

interface ToDoUpdateDeliveryOrderStatus {
    suspend fun execute(orderId: String, newStatus: DeliveryOrderStatus, reason: String? = null): Result<DeliveryOrderStatusUpdateResult>
}

interface ToDoGetDeliveryOrderDetail {
    suspend fun execute(orderId: String): Result<DeliveryOrderDetail>
}
