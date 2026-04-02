package ext.storage.model

import kotlinx.serialization.Serializable

@Serializable
data class ClientProfileCache(
    val fullName: String? = null,
    val email: String? = null,
    val phone: String? = null,
    val defaultAddressId: String? = null,
    val preferredLanguage: String? = null,
    val pushNotificationsEnabled: Boolean = true,
    val pushOrderConfirmed: Boolean = true,
    val pushOrderDelivering: Boolean = true,
    val pushOrderNearby: Boolean = true,
    val pushOrderDelivered: Boolean = true
)
