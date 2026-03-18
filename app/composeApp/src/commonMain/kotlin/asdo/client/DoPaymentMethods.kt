package asdo.client

import ext.client.CommPaymentMethodsService
import ext.client.toClientException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoGetPaymentMethods(
    private val service: CommPaymentMethodsService
) : ToDoGetPaymentMethods {

    private val logger = LoggerFactory.default.newLogger<DoGetPaymentMethods>()

    override suspend fun execute(): Result<List<PaymentMethod>> = runCatching {
        logger.info { "Obteniendo medios de pago del negocio" }
        service.listPaymentMethods().getOrThrow().map { it.toDomain() }
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener medios de pago" }
        throw throwable.toClientException()
    }
}
