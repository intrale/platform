package asdo.delivery

import kotlinx.datetime.LocalDate

interface ToDoGetActiveDeliveryOrders {
    suspend fun execute(): Result<List<DeliveryOrder>>
}

interface ToDoGetDeliveryOrdersSummary {
    suspend fun execute(date: LocalDate): Result<DeliveryOrdersSummary>
}

interface ToDoUpdateDeliveryOrderStatus {
    suspend fun execute(orderId: String, newStatus: DeliveryOrderStatus): Result<DeliveryOrderStatusUpdateResult>
}
