package asdo.business

import ext.business.CommGetBusinessOrderDetailService
import ext.business.toBusinessException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoGetBusinessOrderDetail(
    private val service: CommGetBusinessOrderDetailService
) : ToGetBusinessOrderDetail {

    private val logger = LoggerFactory.default.newLogger<DoGetBusinessOrderDetail>()

    override suspend fun execute(businessId: String, orderId: String): Result<BusinessOrderDetail> {
        return try {
            logger.info { "Obteniendo detalle del pedido $orderId del negocio $businessId" }
            service.getOrderDetail(businessId, orderId)
                .mapCatching { dto -> dto.toDomain() }
                .recoverCatching { e ->
                    logger.error(e) { "Fallo al obtener detalle del pedido $orderId" }
                    throw (e as? ext.business.BusinessExceptionResponse)?.toBusinessException()
                        ?: e.toBusinessException()
                }
        } catch (e: Exception) {
            logger.error(e) { "Error inesperado al obtener detalle del pedido $orderId" }
            Result.failure(e.toBusinessException())
        }
    }
}
