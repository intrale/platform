package ext.delivery

interface CommDeliveryAvailabilityService {
    suspend fun fetchAvailability(): Result<DeliveryAvailabilityDTO>
    suspend fun updateAvailability(config: DeliveryAvailabilityDTO): Result<DeliveryAvailabilityDTO>
}
