package asdo.delivery

import ext.delivery.DeliveryProfileDTO
import ext.delivery.DeliveryVehicleDTO
import ext.delivery.DeliveryZoneDTO

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
