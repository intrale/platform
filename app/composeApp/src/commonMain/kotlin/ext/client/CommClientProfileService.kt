package ext.client

import ar.com.intrale.shared.client.ClientAddressDTO
import ar.com.intrale.shared.client.ClientPreferencesDTO
import ar.com.intrale.shared.client.ClientProfileDTO
import ar.com.intrale.shared.client.ClientProfileResponse

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
    suspend fun markDefault(addressId: String): Result<ClientAddressDTO>
}
