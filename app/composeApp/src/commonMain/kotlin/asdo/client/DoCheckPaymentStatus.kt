package asdo.client

import ext.client.CommPaymentStatusService
import ext.client.toClientException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoCheckPaymentStatus(
    private val service: CommPaymentStatusService
) : ToDoCheckPaymentStatus {

    private val logger = LoggerFactory.default.newLogger<DoCheckPaymentStatus>()

    override suspend fun execute(orderId: String): Result<PaymentStatusResult> = runCatching {
        logger.info { "Consultando estado de pago para orderId=$orderId" }
        val response = service.checkPaymentStatus(orderId).getOrThrow()
        PaymentStatusResult(
            orderId = response.orderId,
            paymentStatus = PaymentStatus.fromString(response.paymentStatus),
            paymentId = response.paymentId,
            paymentMethod = response.paymentMethod,
            paidAmount = response.paidAmount,
            failureReason = response.failureReason
        )
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al consultar estado de pago para orderId=$orderId" }
        throw throwable.toClientException()
    }
}
