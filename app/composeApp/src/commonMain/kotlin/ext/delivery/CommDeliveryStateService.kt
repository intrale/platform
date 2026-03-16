package ext.delivery

import ar.com.intrale.shared.delivery.DeliveryStateChangeResponse

interface CommDeliveryStateService {
    suspend fun changeState(orderId: String, newState: String): Result<DeliveryStateChangeResponse>
}
