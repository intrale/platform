package asdo.delivery

interface ToDoGetDeliveryAvailability {
    suspend fun execute(): Result<DeliveryAvailabilityConfig>
}

interface ToDoUpdateDeliveryAvailability {
    suspend fun execute(config: DeliveryAvailabilityConfig): Result<DeliveryAvailabilityConfig>
}
