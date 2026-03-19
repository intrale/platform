package asdo.business

import ext.business.CommUpdateBusinessOrderStatusService
import ext.business.toBusinessException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoUpdateBusinessOrderStatus(
    private val service: CommUpdateBusinessOrderStatusService
) : ToUpdateBusinessOrderStatus {

    private val logger = LoggerFactory.default.newLogger<DoUpdateBusinessOrderStatus>()

    override suspend fun execute(
        businessId: String,
        orderId: String,
        newStatus: BusinessOrderStatus,
        reason: String?
    ): Result<BusinessOrderStatusUpdateResult> {
        return try {
            logger.info { "Actualizando estado del pedido $orderId a $newStatus" }
            service.updateOrderStatus(businessId, orderId, newStatus.name, reason)
                .mapCatching { dto ->
                    BusinessOrderStatusUpdateResult(
                        orderId = dto.orderId,
                        newStatus = dto.newStatus.toBusinessOrderStatus(),
                        updatedAt = dto.updatedAt
                    )
                }
                .recoverCatching { e ->
                    logger.error(e) { "Fallo al actualizar estado del pedido $orderId" }
                    throw (e as? ext.business.BusinessExceptionResponse)?.toBusinessException()
                        ?: e.toBusinessException()
                }
        } catch (e: Exception) {
            logger.error(e) { "Error inesperado al actualizar estado del pedido $orderId" }
            Result.failure(e.toBusinessException())
        }
    }
}
