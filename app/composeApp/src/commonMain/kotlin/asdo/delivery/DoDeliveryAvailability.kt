package asdo.delivery

import ext.delivery.CommDeliveryAvailabilityService
import ext.delivery.toDeliveryException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoGetDeliveryAvailability(
    private val availabilityService: CommDeliveryAvailabilityService
) : ToDoGetDeliveryAvailability {

    private val logger = LoggerFactory.default.newLogger<DoGetDeliveryAvailability>()

    override suspend fun execute(): Result<DeliveryAvailabilityConfig> = runCatching {
        logger.info { "Obteniendo disponibilidad de repartidor" }
        val dto = availabilityService.fetchAvailability().getOrThrow()
        dto.toDomain()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener disponibilidad" }
        throw throwable.toDeliveryException()
    }
}

class DoUpdateDeliveryAvailability(
    private val availabilityService: CommDeliveryAvailabilityService
) : ToDoUpdateDeliveryAvailability {

    private val logger = LoggerFactory.default.newLogger<DoUpdateDeliveryAvailability>()

    override suspend fun execute(config: DeliveryAvailabilityConfig): Result<DeliveryAvailabilityConfig> = runCatching {
        logger.info { "Actualizando disponibilidad de repartidor" }
        val dto = availabilityService.updateAvailability(config.toDto()).getOrThrow()
        dto.toDomain()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al actualizar disponibilidad" }
        throw throwable.toDeliveryException()
    }
}
