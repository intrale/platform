package ext.delivery

import ar.com.intrale.shared.delivery.DeliveryAvailabilityDTO

interface CommDeliveryAvailabilityService {
    suspend fun fetchAvailability(): Result<DeliveryAvailabilityDTO>
    suspend fun updateAvailability(config: DeliveryAvailabilityDTO): Result<DeliveryAvailabilityDTO>
}
