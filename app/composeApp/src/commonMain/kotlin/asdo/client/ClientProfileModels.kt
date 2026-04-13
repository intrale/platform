package asdo.client

import ar.com.intrale.shared.client.ClientAddressDTO
import ar.com.intrale.shared.client.ClientPreferencesDTO
import ar.com.intrale.shared.client.ClientProfileDTO
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
    val language: String = "es",
    val pushNotificationsEnabled: Boolean = true,
    val pushOrderConfirmed: Boolean = true,
    val pushOrderDelivering: Boolean = true,
    val pushOrderNearby: Boolean = true,
    val pushOrderDelivered: Boolean = true
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

fun ClientPreferencesDTO.toDomain(): ClientPreferences = ClientPreferences(
    language = language,
    pushNotificationsEnabled = pushNotificationsEnabled,
    pushOrderConfirmed = pushOrderConfirmed,
    pushOrderDelivering = pushOrderDelivering,
    pushOrderNearby = pushOrderNearby,
    pushOrderDelivered = pushOrderDelivered
)

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

fun ClientPreferences.toDto(): ClientPreferencesDTO = ClientPreferencesDTO(
    language = language,
    pushNotificationsEnabled = pushNotificationsEnabled,
    pushOrderConfirmed = pushOrderConfirmed,
    pushOrderDelivering = pushOrderDelivering,
    pushOrderNearby = pushOrderNearby,
    pushOrderDelivered = pushOrderDelivered
)

fun ClientProfileData.toCache(): ClientProfileCache = ClientProfileCache(
    fullName = profile.fullName,
    email = profile.email,
    phone = profile.phone,
    defaultAddressId = profile.defaultAddressId,
    preferredLanguage = preferences.language,
    pushNotificationsEnabled = preferences.pushNotificationsEnabled,
    pushOrderConfirmed = preferences.pushOrderConfirmed,
    pushOrderDelivering = preferences.pushOrderDelivering,
    pushOrderNearby = preferences.pushOrderNearby,
    pushOrderDelivered = preferences.pushOrderDelivered
)

fun ClientProfileCache.toDomain(): ClientProfile = ClientProfile(
    fullName = fullName.orEmpty(),
    email = email.orEmpty(),
    phone = phone,
    defaultAddressId = defaultAddressId
)

fun ClientProfileCache.toPreferences(): ClientPreferences = ClientPreferences(
    language = preferredLanguage ?: "es",
    pushNotificationsEnabled = pushNotificationsEnabled,
    pushOrderConfirmed = pushOrderConfirmed,
    pushOrderDelivering = pushOrderDelivering,
    pushOrderNearby = pushOrderNearby,
    pushOrderDelivered = pushOrderDelivered
)
