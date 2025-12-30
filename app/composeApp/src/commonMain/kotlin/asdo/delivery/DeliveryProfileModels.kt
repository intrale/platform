package asdo.delivery

import ext.delivery.DeliveryAvailabilityDTO
import ext.delivery.DeliveryAvailabilitySlotDTO
import ext.delivery.DeliveryProfileDTO
import ext.delivery.DeliveryVehicleDTO
import ext.delivery.DeliveryZoneDTO
import kotlinx.datetime.DayOfWeek

data class DeliveryProfile(
    val fullName: String = "",
    val email: String = "",
    val phone: String? = null,
    val vehicle: DeliveryVehicle = DeliveryVehicle()
)

data class DeliveryVehicle(
    val type: String = "",
    val model: String = "",
    val plate: String? = null
)

data class DeliveryZone(
    val id: String = "",
    val name: String = "",
    val description: String? = null
)

data class DeliveryProfileData(
    val profile: DeliveryProfile = DeliveryProfile(),
    val zones: List<DeliveryZone> = emptyList()
)

enum class DeliveryAvailabilityMode { BLOCK, CUSTOM }

enum class DeliveryAvailabilityBlock { MORNING, AFTERNOON, NIGHT }

data class DeliveryAvailabilitySlot(
    val dayOfWeek: DayOfWeek,
    val mode: DeliveryAvailabilityMode,
    val block: DeliveryAvailabilityBlock? = null,
    val start: String? = null,
    val end: String? = null,
)

data class DeliveryAvailabilityConfig(
    val timezone: String = "",
    val slots: List<DeliveryAvailabilitySlot> = emptyList()
)

fun DeliveryProfileDTO.toDomain(): DeliveryProfile = DeliveryProfile(
    fullName = fullName,
    email = email,
    phone = phone,
    vehicle = vehicle.toDomain()
)

fun DeliveryVehicleDTO.toDomain(): DeliveryVehicle = DeliveryVehicle(
    type = type,
    model = model,
    plate = plate
)

fun DeliveryZoneDTO.toDomain(): DeliveryZone = DeliveryZone(
    id = id,
    name = name,
    description = description
)

fun DeliveryAvailabilityDTO.toDomain(): DeliveryAvailabilityConfig = DeliveryAvailabilityConfig(
    timezone = timezone,
    slots = slots.mapNotNull { it.toDomain() }
)

fun DeliveryAvailabilitySlotDTO.toDomain(): DeliveryAvailabilitySlot? {
    val day = dayOfWeek.toDayOfWeekOrNull() ?: return null
    val mode = mode.toDeliveryAvailabilityModeOrNull() ?: return null
    val blockValue = block?.toDeliveryAvailabilityBlockOrNull()
    return DeliveryAvailabilitySlot(
        dayOfWeek = day,
        mode = mode,
        block = blockValue,
        start = start,
        end = end
    )
}

fun DeliveryProfile.toDto(): DeliveryProfileDTO = DeliveryProfileDTO(
    fullName = fullName,
    email = email,
    phone = phone,
    vehicle = vehicle.toDto()
)

fun DeliveryVehicle.toDto(): DeliveryVehicleDTO = DeliveryVehicleDTO(
    type = type,
    model = model,
    plate = plate
)

fun DeliveryAvailabilityConfig.toDto(): DeliveryAvailabilityDTO = DeliveryAvailabilityDTO(
    timezone = timezone,
    slots = slots.map { it.toDto() }
)

fun DeliveryAvailabilitySlot.toDto(): DeliveryAvailabilitySlotDTO = DeliveryAvailabilitySlotDTO(
    dayOfWeek = dayOfWeek.name.lowercase(),
    mode = mode.name,
    block = block?.name,
    start = start,
    end = end
)

private fun String.toDayOfWeekOrNull(): DayOfWeek? = runCatching {
    DayOfWeek.valueOf(this.uppercase())
}.getOrNull()

private fun String.toDeliveryAvailabilityModeOrNull(): DeliveryAvailabilityMode? = runCatching {
    DeliveryAvailabilityMode.valueOf(this.uppercase())
}.getOrNull()

private fun String.toDeliveryAvailabilityBlockOrNull(): DeliveryAvailabilityBlock? = runCatching {
    DeliveryAvailabilityBlock.valueOf(this.uppercase())
}.getOrNull()
