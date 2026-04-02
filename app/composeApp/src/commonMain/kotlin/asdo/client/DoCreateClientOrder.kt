package asdo.client

import ar.com.intrale.shared.client.CreateClientOrderItemDTO
import ar.com.intrale.shared.client.CreateClientOrderRequestDTO
import ext.client.CommClientOrdersService
import ext.client.toClientException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoCreateClientOrder(
    private val service: CommClientOrdersService
) : ToDoCreateClientOrder {

    private val logger = LoggerFactory.default.newLogger<DoCreateClientOrder>()

    override suspend fun execute(params: CreateClientOrderParams): Result<CreateClientOrderResult> = runCatching {
        logger.info { "Creando pedido con ${params.items.size} items" }
        val request = CreateClientOrderRequestDTO(
            items = params.items.map { item ->
                CreateClientOrderItemDTO(
                    productId = item.productId,
                    productName = item.productName,
                    quantity = item.quantity,
                    unitPrice = item.unitPrice
                )
            },
            addressId = params.addressId,
            paymentMethodId = params.paymentMethodId,
            notes = params.notes
        )
        val response = service.createOrder(request).getOrThrow()
        CreateClientOrderResult(
            orderId = response.orderId,
            shortCode = response.shortCode,
            status = response.status,
            paymentUrl = response.paymentUrl,
            paymentId = response.paymentId,
            requiresPayment = response.requiresPayment
        )
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al crear pedido" }
        throw throwable.toClientException()
    }
}
