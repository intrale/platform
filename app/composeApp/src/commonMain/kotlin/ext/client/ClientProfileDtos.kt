package ext.client

import ext.dto.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class ClientProfileDTO(
    val id: String? = null,
    val fullName: String = "",
    val email: String = "",
    val phone: String? = null,
    val defaultAddressId: String? = null
)

@Serializable
data class ClientAddressDTO(
    val id: String? = null,
    val label: String = "",
    val line1: String = "",
    val city: String = "",
    val state: String? = null,
    val zip: String? = null,
    val country: String? = null,
    val isDefault: Boolean = false
)

@Serializable
data class ClientPreferencesDTO(
    val language: String = "es"
)

@Serializable
data class ClientProfileResponse(
    val statusCode: StatusCodeDTO? = null,
    val profile: ClientProfileDTO? = null,
    val preferences: ClientPreferencesDTO? = null
)

@Serializable
data class ClientAddressResponse(
    val statusCode: StatusCodeDTO? = null,
    val addresses: List<ClientAddressDTO>? = null
)
