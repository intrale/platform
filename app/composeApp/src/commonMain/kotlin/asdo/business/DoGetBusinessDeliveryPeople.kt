package asdo.business

import ar.com.intrale.shared.business.DeliveryPersonSummaryDTO
import ext.business.BusinessExceptionResponse
import ext.business.CommGetBusinessDeliveryPeopleService
import ext.business.toBusinessException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoGetBusinessDeliveryPeople(
    private val service: CommGetBusinessDeliveryPeopleService
) : ToDoGetBusinessDeliveryPeople {

    private val logger = LoggerFactory.default.newLogger<DoGetBusinessDeliveryPeople>()

    override suspend fun execute(businessId: String): Result<List<DeliveryPersonSummary>> {
        return try {
            logger.info { "Obteniendo repartidores del negocio $businessId" }
            service.listDeliveryPeople(businessId)
                .mapCatching { dtos -> dtos.map { it.toDomain() } }
                .recoverCatching { e ->
                    logger.error(e) { "Fallo al obtener repartidores del negocio $businessId" }
                    throw (e as? BusinessExceptionResponse)?.toBusinessException()
                        ?: e.toBusinessException()
                }
        } catch (e: Exception) {
            logger.error(e) { "Error inesperado al obtener repartidores del negocio $businessId" }
            Result.failure(e.toBusinessException())
        }
    }
}

private fun DeliveryPersonSummaryDTO.toDomain() = DeliveryPersonSummary(
    email = email,
    fullName = fullName
)
