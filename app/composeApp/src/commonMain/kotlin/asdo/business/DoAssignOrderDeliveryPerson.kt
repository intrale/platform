package asdo.business

import ext.business.CommAssignOrderDeliveryPersonService
import ext.business.BusinessExceptionResponse
import ext.business.toBusinessException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoAssignOrderDeliveryPerson(
    private val service: CommAssignOrderDeliveryPersonService
) : ToDoAssignOrderDeliveryPerson {

    private val logger = LoggerFactory.default.newLogger<DoAssignOrderDeliveryPerson>()

    override suspend fun execute(
        businessId: String,
        orderId: String,
        deliveryPersonEmail: String?
    ): Result<BusinessOrder> {
        return try {
            logger.info { "Asignando repartidor $deliveryPersonEmail al pedido $orderId del negocio $businessId" }
            service.assignDeliveryPerson(businessId, orderId, deliveryPersonEmail)
                .mapCatching { dto -> dto.toDomain() }
                .recoverCatching { e ->
                    logger.error(e) { "Fallo al asignar repartidor al pedido $orderId" }
                    throw (e as? BusinessExceptionResponse)?.toBusinessException()
                        ?: e.toBusinessException()
                }
        } catch (e: Exception) {
            logger.error(e) { "Error inesperado al asignar repartidor al pedido $orderId" }
            Result.failure(e.toBusinessException())
        }
    }
}
