package asdo.client

import ar.com.intrale.shared.client.CreateClientOrderItemRequestDTO
import ar.com.intrale.shared.client.CreateClientOrderRequestDTO
import ext.client.CommClientOrdersService
import ext.client.CommNotificationService
import ext.client.toClientException
import kotlinx.datetime.Clock
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoGetClientOrders(
    private val service: CommClientOrdersService
) : ToDoGetClientOrders {

    private val logger = LoggerFactory.default.newLogger<DoGetClientOrders>()

    override suspend fun execute(): Result<List<ClientOrder>> = runCatching {
        logger.info { "Obteniendo pedidos del cliente" }
        service.listOrders().getOrThrow().map { it.toDomain() }
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener pedidos del cliente" }
        throw throwable.toClientException()
    }
}

class DoGetClientOrderDetail(
    private val service: CommClientOrdersService
) : ToDoGetClientOrderDetail {

    private val logger = LoggerFactory.default.newLogger<DoGetClientOrderDetail>()

    override suspend fun execute(orderId: String): Result<ClientOrderDetail> = runCatching {
        logger.info { "Obteniendo detalle del pedido $orderId" }
        service.fetchOrderDetail(orderId).getOrThrow().toDomain()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener detalle del pedido $orderId" }
        throw throwable.toClientException()
    }
}

class DoCreateOrder(
    private val service: CommClientOrdersService,
    private val notificationService: CommNotificationService
) : ToDoCreateOrder {

    private val logger = LoggerFactory.default.newLogger<DoCreateOrder>()

    override suspend fun execute(
        items: List<CreateOrderItemData>,
        addressId: String,
        paymentMethodId: String
    ): Result<CreateOrderResult> = runCatching {
        logger.info { "Creando pedido con ${items.size} items, dirección=$addressId, pago=$paymentMethodId" }
        service.createOrder(
            items = items,
            shippingAddressId = addressId,
            paymentMethodId = paymentMethodId
        ).getOrThrow().let { dto ->
            val result = CreateOrderResult(
                orderId = dto.id,
                publicId = dto.publicId,
                shortCode = dto.shortCode,
                total = dto.total
            )
            notificationService.addNotification(
                ClientNotification(
                    id = "notif-${Clock.System.now().toEpochMilliseconds()}",
                    type = NotificationType.ORDER_CREATED,
                    title = "Pedido #${result.shortCode} creado",
                    body = "Tu pedido fue recibido y esta siendo procesado",
                    isRead = false,
                    timestamp = Clock.System.now().toString(),
                    orderId = result.orderId
                )
            )
            result
        }
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al crear pedido" }
        throw throwable.toClientException()
    }
}

class DoRepeatOrder : ToDoRepeatOrder {

    private val logger = LoggerFactory.default.newLogger<DoRepeatOrder>()

    override suspend fun execute(order: ClientOrderDetail): Result<RepeatOrderResult> = runCatching {
        logger.info { "Repitiendo pedido ${order.id} con ${order.items.size} items" }
        val addedItems = mutableListOf<ClientOrderItem>()
        val skippedItems = mutableListOf<ClientOrderItem>()
        order.items.forEach { item ->
            if (item.id != null) {
                addedItems.add(item)
            } else {
                logger.info { "Item '${item.name}' sin ID, omitido" }
                skippedItems.add(item)
            }
        }
        logger.info { "Pedido repetido: ${addedItems.size} agregados, ${skippedItems.size} omitidos" }
        RepeatOrderResult(addedItems = addedItems, skippedItems = skippedItems)
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al repetir pedido ${order.id}" }
        throw throwable.toClientException()
    }
}
