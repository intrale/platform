package asdo.delivery

interface ToDoDeliveryStateChange {
    suspend fun execute(orderId: String, newState: DeliveryState): Result<DeliveryStateChangeResult>
}
