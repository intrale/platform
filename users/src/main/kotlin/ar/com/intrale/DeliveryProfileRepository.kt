package ar.com.intrale

import java.util.concurrent.ConcurrentHashMap

class DeliveryProfileRepository {

    private val profiles = ConcurrentHashMap<String, DeliveryProfileRecord>()
    private val availability = ConcurrentHashMap<String, DeliveryAvailabilityPayload>()

    private fun key(business: String, email: String) = "${business.lowercase()}#${email.lowercase()}"

    fun getProfile(business: String, email: String): DeliveryProfileRecord {
        return profiles.getOrPut(key(business, email)) {
            DeliveryProfileRecord(
                profile = DeliveryProfilePayload(email = email)
            )
        }.copy(
            zones = profiles[key(business, email)]?.zones?.map { it.copy() }?.toMutableList() ?: mutableListOf()
        )
    }

    fun updateProfile(
        business: String,
        email: String,
        profile: DeliveryProfilePayload
    ): DeliveryProfileRecord {
        val record = profiles.getOrPut(key(business, email)) {
            DeliveryProfileRecord(profile = DeliveryProfilePayload(email = email))
        }
        record.profile = record.profile.copy(
            fullName = profile.fullName.ifBlank { record.profile.fullName },
            email = email,
            phone = profile.phone ?: record.profile.phone,
            vehicle = DeliveryVehiclePayload(
                type = profile.vehicle.type.ifBlank { record.profile.vehicle.type },
                model = profile.vehicle.model.ifBlank { record.profile.vehicle.model },
                plate = profile.vehicle.plate ?: record.profile.vehicle.plate
            )
        )
        return getProfile(business, email)
    }

    fun listByBusiness(business: String): List<DeliveryProfileRecord> {
        val prefix = business.lowercase() + "#"
        return profiles.entries
            .filter { (k, _) -> k.startsWith(prefix) }
            .map { (_, record) -> record.copy() }
    }

    fun toggleStatus(business: String, email: String, newStatus: DeliveryPersonStatus): DeliveryProfileRecord {
        val record = profiles.getOrPut(key(business, email)) {
            DeliveryProfileRecord(profile = DeliveryProfilePayload(email = email))
        }
        record.status = newStatus
        return record.copy()
    }

    fun invite(business: String, email: String): DeliveryProfileRecord {
        return profiles.getOrPut(key(business, email)) {
            DeliveryProfileRecord(
                profile = DeliveryProfilePayload(email = email),
                status = DeliveryPersonStatus.PENDING
            )
        }.copy()
    }

    fun getAvailability(business: String, email: String): DeliveryAvailabilityPayload {
        return availability.getOrDefault(key(business, email), DeliveryAvailabilityPayload(timezone = "UTC"))
    }

    fun updateAvailability(
        business: String,
        email: String,
        payload: DeliveryAvailabilityPayload
    ): DeliveryAvailabilityPayload {
        val normalized = payload.copy(
            timezone = payload.timezone.trim(),
            slots = payload.slots.map { slot ->
                slot.copy(
                    dayOfWeek = slot.dayOfWeek.lowercase(),
                    mode = slot.mode.uppercase(),
                    block = slot.block?.uppercase()
                )
            }
        )
        availability[key(business, email)] = normalized
        return normalized
    }
}
