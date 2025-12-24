package ext.client

interface CommClientProfileService {
    suspend fun fetchProfile(): Result<ClientProfileResponse>
    suspend fun updateProfile(
        profile: ClientProfileDTO,
        preferences: ClientPreferencesDTO
    ): Result<ClientProfileResponse>
}

interface CommClientAddressesService {
    suspend fun listAddresses(): Result<List<ClientAddressDTO>>
    suspend fun createAddress(address: ClientAddressDTO): Result<ClientAddressDTO>
    suspend fun updateAddress(address: ClientAddressDTO): Result<ClientAddressDTO>
    suspend fun deleteAddress(addressId: String): Result<Unit>
}
