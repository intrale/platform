package asdo.business

import ext.business.BusinessExceptionResponse
import ext.business.CommToggleDeliveryPersonStatusService
import ext.business.toBusinessException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoToggleDeliveryPersonStatus(
    private val service: CommToggleDeliveryPersonStatusService
) : ToDoToggleDeliveryPersonStatus {

    private val logger = LoggerFactory.default.newLogger<DoToggleDeliveryPersonStatus>()

    override suspend fun execute(
        businessId: String,
        email: String,
        newStatus: BusinessDeliveryPersonStatus
    ): Result<BusinessDeliveryPerson> {
        return try {
            logger.info { "Cambiando estado del repartidor $email a $newStatus en negocio $businessId" }
            service.toggleStatus(businessId, email, newStatus.name)
                .mapCatching { dto ->
                    BusinessDeliveryPerson(
                        email = dto.email,
                        fullName = "",
                        status = dto.newStatus.toBusinessDeliveryPersonStatus()
                    )
                }
                .recoverCatching { e ->
                    logger.error(e) { "Fallo al cambiar estado del repartidor $email" }
                    throw (e as? BusinessExceptionResponse)?.toBusinessException()
                        ?: e.toBusinessException()
                }
        } catch (e: Exception) {
            logger.error(e) { "Error inesperado al cambiar estado del repartidor $email" }
            Result.failure(e.toBusinessException())
        }
    }
}
