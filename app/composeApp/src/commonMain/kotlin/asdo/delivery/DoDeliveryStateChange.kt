package asdo.delivery

import ext.delivery.CommDeliveryStateService
import ext.delivery.toDeliveryException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoDeliveryStateChange(
    private val stateService: CommDeliveryStateService
) : ToDoDeliveryStateChange {

    private val logger = LoggerFactory.default.newLogger<DoDeliveryStateChange>()

    override suspend fun execute(
        orderId: String,
        newState: DeliveryState
    ): Result<DeliveryStateChangeResult> = runCatching {
        logger.info { "Cambiando estado de entrega del pedido $orderId a $newState" }
        stateService.changeState(orderId, newState.toApiString())
            .getOrThrow()
            .toDomain()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al cambiar estado de entrega del pedido $orderId" }
        throw throwable.toDeliveryException()
    }
}
