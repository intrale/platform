package asdo.client

import ext.client.ClientAddressDTO
import ext.client.ClientPreferencesDTO
import ext.client.ClientProfileDTO
import ext.storage.model.ClientProfileCache

data class ClientProfile(
    val fullName: String = "",
    val email: String = "",
    val phone: String? = null,
    val defaultAddressId: String? = null
)

data class ClientAddress(
    val id: String? = null,
    val label: String = "",
    val street: String = "",
    val number: String = "",
    val reference: String? = null,
    val city: String = "",
    val state: String? = null,
    val postalCode: String? = null,
    val country: String? = null,
    val isDefault: Boolean = false
)

data class ClientPreferences(
    val language: String = "es"
)

data class ClientProfileData(
    val profile: ClientProfile = ClientProfile(),
    val addresses: List<ClientAddress> = emptyList(),
    val preferences: ClientPreferences = ClientPreferences()
)

sealed class ManageAddressAction {
    data class Create(val address: ClientAddress) : ManageAddressAction()
    data class Update(val address: ClientAddress) : ManageAddressAction()
    data class Delete(val addressId: String) : ManageAddressAction()
    data class MarkDefault(val addressId: String) : ManageAddressAction()
}

fun ClientProfileDTO.toDomain(preferences: ClientPreferencesDTO? = null): ClientProfile =
    ClientProfile(
        fullName = fullName,
        email = email,
        phone = phone,
        defaultAddressId = defaultAddressId ?: preferences?.let { _ -> defaultAddressId }
    )

fun ClientAddressDTO.toDomain(defaultId: String? = null): ClientAddress =
    ClientAddress(
        id = id,
        label = label,
        street = street,
        number = number,
        reference = reference,
        city = city,
        state = state,
        postalCode = postalCode,
        country = country,
        isDefault = isDefault || (defaultId != null && defaultId == id)
    )

fun ClientPreferencesDTO.toDomain(): ClientPreferences = ClientPreferences(language = language)

fun ClientProfile.toDto(): ClientProfileDTO = ClientProfileDTO(
    fullName = fullName,
    email = email,
    phone = phone,
    defaultAddressId = defaultAddressId
)

fun ClientAddress.toDto(): ClientAddressDTO = ClientAddressDTO(
    id = id,
    label = label,
    street = street,
    number = number,
    reference = reference,
    city = city,
    state = state,
    postalCode = postalCode,
    country = country,
    isDefault = isDefault
)

fun ClientPreferences.toDto(): ClientPreferencesDTO = ClientPreferencesDTO(language = language)

fun ClientProfileData.toCache(): ClientProfileCache = ClientProfileCache(
    fullName = profile.fullName,
    email = profile.email,
    phone = profile.phone,
    defaultAddressId = profile.defaultAddressId,
    preferredLanguage = preferences.language
)

fun ClientProfileCache.toDomain(): ClientProfile = ClientProfile(
    fullName = fullName.orEmpty(),
    email = email.orEmpty(),
    phone = phone,
    defaultAddressId = defaultAddressId
)

fun ClientProfileCache.toPreferences(): ClientPreferences = ClientPreferences(
    language = preferredLanguage ?: "es"
)
