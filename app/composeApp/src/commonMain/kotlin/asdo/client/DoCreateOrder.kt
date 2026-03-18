package asdo.client

import ar.com.intrale.shared.client.ClientOrderItemDTO
import ar.com.intrale.shared.client.CreateOrderRequestDTO
import ext.client.CommClientOrdersService
import ext.client.toClientException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoCreateOrder(
    private val service: CommClientOrdersService
) : ToDoCreateOrder {

    private val logger = LoggerFactory.default.newLogger<DoCreateOrder>()

    override suspend fun execute(request: CreateOrderInput): Result<CreateOrderOutput> = runCatching {
        logger.info { "Creando pedido con ${request.items.size} productos" }

        val dto = CreateOrderRequestDTO(
            items = request.items.map { item ->
                ClientOrderItemDTO(
                    productId = item.productId,
                    productName = item.productName,
                    name = item.productName,
                    quantity = item.quantity,
                    unitPrice = item.unitPrice,
                    subtotal = item.unitPrice * item.quantity
                )
            },
            addressId = request.addressId,
            notes = request.notes,
            paymentMethod = request.paymentMethod
        )

        val response = service.createOrder(dto).getOrThrow()
        val order = response.order
            ?: throw IllegalStateException("La respuesta no contiene datos del pedido")

        CreateOrderOutput(
            orderId = order.id.orEmpty(),
            shortCode = order.shortCode.orEmpty(),
            status = order.status,
            total = order.total
        )
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al crear pedido" }
        throw throwable.toClientException()
    }
}
