package asdo.delivery

import ext.delivery.CommDeliveryProfileService
import ext.delivery.DeliveryProfileDTO
import ext.delivery.toDeliveryException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoGetDeliveryProfile(
    private val profileService: CommDeliveryProfileService
) : ToDoGetDeliveryProfile {

    private val logger = LoggerFactory.default.newLogger<DoGetDeliveryProfile>()

    override suspend fun execute(): Result<DeliveryProfileData> = runCatching {
        logger.info { "Obteniendo perfil de repartidor" }
        val response = profileService.fetchProfile().getOrThrow()
        DeliveryProfileData(
            profile = (response.profile ?: DeliveryProfileDTO()).toDomain(),
            zones = response.zones.map { it.toDomain() }
        )
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener perfil de repartidor" }
        throw throwable.toDeliveryException()
    }
}

class DoUpdateDeliveryProfile(
    private val profileService: CommDeliveryProfileService
) : ToDoUpdateDeliveryProfile {

    private val logger = LoggerFactory.default.newLogger<DoUpdateDeliveryProfile>()

    override suspend fun execute(profile: DeliveryProfile): Result<DeliveryProfileData> = runCatching {
        logger.info { "Actualizando perfil de repartidor" }
        val response = profileService.updateProfile(profile.toDto()).getOrThrow()
        DeliveryProfileData(
            profile = (response.profile ?: profile.toDto()).toDomain(),
            zones = response.zones.map { it.toDomain() }
        )
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al actualizar perfil de repartidor" }
        throw throwable.toDeliveryException()
    }
}
