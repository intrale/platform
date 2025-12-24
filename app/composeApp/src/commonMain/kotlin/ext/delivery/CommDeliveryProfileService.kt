package ext.delivery

interface CommDeliveryProfileService {
    suspend fun fetchProfile(): Result<DeliveryProfileResponse>
    suspend fun updateProfile(profile: DeliveryProfileDTO): Result<DeliveryProfileResponse>
}
