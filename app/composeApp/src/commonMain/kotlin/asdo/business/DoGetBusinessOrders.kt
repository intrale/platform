package asdo.business

import ext.business.CommGetBusinessOrdersService
import ext.business.toBusinessException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoGetBusinessOrders(
    private val service: CommGetBusinessOrdersService
) : ToGetBusinessOrders {

    private val logger = LoggerFactory.default.newLogger<DoGetBusinessOrders>()

    override suspend fun execute(businessId: String): Result<List<BusinessOrder>> {
        return try {
            logger.info { "Obteniendo pedidos del negocio $businessId" }
            service.listOrders(businessId)
                .mapCatching { dtos -> dtos.map { it.toDomain() } }
                .recoverCatching { e ->
                    logger.error(e) { "Fallo al obtener pedidos del negocio $businessId" }
                    throw (e as? ext.business.BusinessExceptionResponse)?.toBusinessException()
                        ?: e.toBusinessException()
                }
        } catch (e: Exception) {
            logger.error(e) { "Error inesperado al obtener pedidos del negocio $businessId" }
            Result.failure(e.toBusinessException())
        }
    }
}
