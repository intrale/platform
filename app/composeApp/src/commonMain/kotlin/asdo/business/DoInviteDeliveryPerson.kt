package asdo.business

import ext.business.BusinessExceptionResponse
import ext.business.CommInviteDeliveryPersonService
import ext.business.toBusinessException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoInviteDeliveryPerson(
    private val service: CommInviteDeliveryPersonService
) : ToDoInviteDeliveryPerson {

    private val logger = LoggerFactory.default.newLogger<DoInviteDeliveryPerson>()

    override suspend fun execute(businessId: String, email: String): Result<String> {
        return try {
            logger.info { "Invitando repartidor $email al negocio $businessId" }
            service.invite(businessId, email)
                .mapCatching { dto -> dto.message }
                .recoverCatching { e ->
                    logger.error(e) { "Fallo al invitar repartidor $email" }
                    throw (e as? BusinessExceptionResponse)?.toBusinessException()
                        ?: e.toBusinessException()
                }
        } catch (e: Exception) {
            logger.error(e) { "Error inesperado al invitar repartidor $email" }
            Result.failure(e.toBusinessException())
        }
    }
}
