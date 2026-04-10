package asdo.client

import ar.com.intrale.shared.client.SkipReason
import ext.client.CommClientOrdersService
import ext.client.CommProductAvailabilityService
import ext.client.toClientException
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

class DoRepeatOrder(
    private val availabilityService: CommProductAvailabilityService
) : ToDoRepeatOrder {

    private val logger = LoggerFactory.default.newLogger<DoRepeatOrder>()

    override suspend fun execute(order: ClientOrderDetail): Result<RepeatOrderResult> = runCatching {
        logger.info { "Repitiendo pedido ${order.id} con ${order.items.size} items" }
        val addedItems = mutableListOf<ClientOrderItem>()
        val skippedItems = mutableListOf<SkippedItem>()

        // Filtrar items sin ID (producto huérfano)
        val itemsWithId = order.items.filter { it.id != null }
        val itemsWithoutId = order.items.filter { it.id == null }

        // Items sin ID se marcan como UNKNOWN_PRODUCT
        itemsWithoutId.forEach { item ->
            logger.info { "Item '${item.name}' sin ID, omitido" }
            skippedItems.add(SkippedItem(item = item, reason = SkipReason.UNKNOWN_PRODUCT))
        }

        if (itemsWithId.isNotEmpty()) {
            // Consultar disponibilidad al backend en batch
            val productIds = itemsWithId.mapNotNull { it.id }
            val availabilityResult = availabilityService.checkAvailability(productIds)

            if (availabilityResult.isSuccess) {
                val availabilityMap = availabilityResult.getOrThrow().items.associateBy { it.productId }

                itemsWithId.forEach { item ->
                    val availability = availabilityMap[item.id]
                    if (availability == null || !availability.available) {
                        val reason = availability?.reason ?: SkipReason.UNKNOWN_PRODUCT
                        logger.info { "Item '${item.name}' no disponible: $reason" }
                        skippedItems.add(SkippedItem(item = item, reason = reason))
                    } else {
                        addedItems.add(item)
                    }
                }
            } else {
                // Si falla la consulta de disponibilidad, agregar todos los items con ID
                // (la validación final ocurre al crear el pedido)
                logger.warning { "Fallo consulta de disponibilidad, agregando todos los items con ID" }
                addedItems.addAll(itemsWithId)
            }
        }

        logger.info { "Pedido repetido: ${addedItems.size} agregados, ${skippedItems.size} omitidos" }
        RepeatOrderResult(addedItems = addedItems, skippedItems = skippedItems)
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al repetir pedido ${order.id}" }
        throw throwable.toClientException()
    }
}
