package ar.com.intrale

import io.ktor.http.HttpStatusCode
import java.time.Instant
import java.util.UUID

data class ClientProfilePayload(
    val id: String? = null,
    val fullName: String = "",
    val email: String = "",
    val phone: String? = null,
    val defaultAddressId: String? = null
)

data class ClientPreferencesPayload(
    val language: String = "es"
)

data class ClientAddressPayload(
    val id: String? = null,
    val label: String = "",
    val street: String = "",
    val number: String = "",
    val reference: String? = null,
    val city: String = "",
    val state: String? = null,
    val postalCode: String? = null,
    val country: String? = null,
    val isDefault: Boolean = false,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

data class ClientProfileResponse(
    val profile: ClientProfilePayload? = null,
    val preferences: ClientPreferencesPayload? = null,
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class ClientAddressResponse(
    val address: ClientAddressPayload? = null,
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class ClientAddressListResponse(
    val addresses: List<ClientAddressPayload> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class ClientProfileUpdateRequest(
    val profile: ClientProfilePayload? = null,
    val preferences: ClientPreferencesPayload? = null
)

data class ClientProfileRecord(
    var profile: ClientProfilePayload = ClientProfilePayload(),
    var preferences: ClientPreferencesPayload = ClientPreferencesPayload(),
    val addresses: MutableList<ClientAddressPayload> = mutableListOf()
)

class ClientProfileRepository {

    private val profiles = mutableMapOf<String, ClientProfileRecord>()

    private fun key(business: String, email: String) = "${business.lowercase()}#${email.lowercase()}"

    fun getSnapshot(business: String, email: String): ClientProfileRecord {
        val record = profiles.getOrPut(key(business, email)) {
            ClientProfileRecord(
                profile = ClientProfilePayload(
                    id = email,
                    email = email
                )
            )
        }
        normalizeDefault(record, record.profile.defaultAddressId)
        return record.copy(
            addresses = record.addresses.map { it.copy() }.toMutableList()
        )
    }

    fun updateProfile(
        business: String,
        email: String,
        profile: ClientProfilePayload,
        preferences: ClientPreferencesPayload
    ): ClientProfileRecord {
        val record = profiles.getOrPut(key(business, email)) {
            ClientProfileRecord(
                profile = ClientProfilePayload(
                    id = email,
                    email = email
                )
            )
        }
        val requestedDefault = profile.defaultAddressId?.takeIf { it.isNotBlank() }
        record.profile = record.profile.copy(
            id = profile.id ?: record.profile.id ?: email,
            fullName = profile.fullName.ifBlank { record.profile.fullName },
            email = email,
            phone = profile.phone ?: record.profile.phone,
            defaultAddressId = requestedDefault ?: record.profile.defaultAddressId
        )
        record.preferences = preferences
        normalizeDefault(record, requestedDefault ?: record.profile.defaultAddressId)
        return getSnapshot(business, email)
    }

    fun listAddresses(business: String, email: String): List<ClientAddressPayload> =
        getSnapshot(business, email).addresses

    fun createAddress(business: String, email: String, payload: ClientAddressPayload): ClientProfileRecord {
        val record = profiles.getOrPut(key(business, email)) {
            ClientProfileRecord(
                profile = ClientProfilePayload(
                    id = email,
                    email = email
                )
            )
        }
        val now = Instant.now().toString()
        val created = payload.copy(
            id = payload.id ?: UUID.randomUUID().toString(),
            createdAt = now,
            updatedAt = now
        )
        record.addresses.add(created)
        normalizeDefault(record, if (created.isDefault) created.id else null)
        return getSnapshot(business, email)
    }

    fun updateAddress(business: String, email: String, addressId: String, payload: ClientAddressPayload): ClientProfileRecord {
        val record = profiles[key(business, email)] ?: return getSnapshot(business, email)
        val index = record.addresses.indexOfFirst { it.id == addressId }
        if (index == -1) return getSnapshot(business, email)

        val existing = record.addresses[index]
        val updated = existing.copy(
            label = payload.label.ifBlank { existing.label },
            street = payload.street.ifBlank { existing.street },
            number = payload.number.ifBlank { existing.number },
            reference = payload.reference ?: existing.reference,
            city = payload.city.ifBlank { existing.city },
            state = payload.state ?: existing.state,
            postalCode = payload.postalCode ?: existing.postalCode,
            country = payload.country ?: existing.country,
            isDefault = payload.isDefault,
            updatedAt = Instant.now().toString()
        )
        record.addresses[index] = updated
        normalizeDefault(record, if (updated.isDefault) updated.id else null)
        return getSnapshot(business, email)
    }

    fun deleteAddress(business: String, email: String, addressId: String): ClientProfileRecord {
        val record = profiles[key(business, email)] ?: return getSnapshot(business, email)
        record.addresses.removeIf { it.id == addressId }
        normalizeDefault(record, record.profile.defaultAddressId)
        return getSnapshot(business, email)
    }

    fun markDefault(business: String, email: String, addressId: String): ClientProfileRecord {
        val record = profiles[key(business, email)] ?: return getSnapshot(business, email)
        normalizeDefault(record, addressId)
        return getSnapshot(business, email)
    }

    private fun normalizeDefault(record: ClientProfileRecord, preferredDefaultId: String? = null) {
        val chosenDefault = when {
            preferredDefaultId != null && record.addresses.any { it.id == preferredDefaultId } -> preferredDefaultId
            record.addresses.any { it.isDefault } -> record.addresses.first { it.isDefault }.id
            record.profile.defaultAddressId != null && record.addresses.any { it.id == record.profile.defaultAddressId } -> record.profile.defaultAddressId
            else -> record.addresses.firstOrNull()?.id
        }

        val normalized = record.addresses.map { address ->
            address.copy(isDefault = chosenDefault != null && address.id == chosenDefault)
        }
        record.addresses.clear()
        record.addresses.addAll(normalized)
        record.profile = record.profile.copy(defaultAddressId = chosenDefault)
    }
}
