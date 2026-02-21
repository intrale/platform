package ext.delivery

interface CommDeliveryStateService {
    suspend fun changeState(orderId: String, newState: String): Result<DeliveryStateChangeResponse>
}
