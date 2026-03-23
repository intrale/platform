package asdo.business

import ar.com.intrale.shared.business.BusinessDeliveryPersonDTO
import ext.business.BusinessExceptionResponse
import ext.business.CommListBusinessDeliveryPeopleService
import ext.business.toBusinessException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoListBusinessDeliveryPeople(
    private val service: CommListBusinessDeliveryPeopleService
) : ToDoListBusinessDeliveryPeople {

    private val logger = LoggerFactory.default.newLogger<DoListBusinessDeliveryPeople>()

    override suspend fun execute(businessId: String): Result<List<BusinessDeliveryPerson>> {
        return try {
            logger.info { "Listando repartidores del negocio $businessId" }
            service.listDeliveryPeople(businessId)
                .mapCatching { dtos -> dtos.map { it.toDomain() } }
                .recoverCatching { e ->
                    logger.error(e) { "Fallo al listar repartidores del negocio $businessId" }
                    throw (e as? BusinessExceptionResponse)?.toBusinessException()
                        ?: e.toBusinessException()
                }
        } catch (e: Exception) {
            logger.error(e) { "Error inesperado al listar repartidores del negocio $businessId" }
            Result.failure(e.toBusinessException())
        }
    }
}

private fun BusinessDeliveryPersonDTO.toDomain() = BusinessDeliveryPerson(
    email = email,
    fullName = fullName,
    status = status.toBusinessDeliveryPersonStatus()
)
