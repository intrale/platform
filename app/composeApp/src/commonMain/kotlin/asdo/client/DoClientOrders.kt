package asdo.client

import ar.com.intrale.shared.client.SkipReason
import ext.client.CommClientOrdersService
import ext.client.CommClientProductsAvailabilityService
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
    private val availabilityService: CommClientProductsAvailabilityService
) : ToDoRepeatOrder {

    private val logger = LoggerFactory.default.newLogger<DoRepeatOrder>()

    override suspend fun execute(order: ClientOrderDetail): Result<RepeatOrderResult> = runCatching {
        logger.info { "Repitiendo pedido ${order.id} con ${order.items.size} items" }

        // Separar items con y sin ID
        val itemsWithId = order.items.filter { it.id != null }
        val itemsWithoutId = order.items.filter { it.id == null }

        // Items sin ID se omiten con motivo UNKNOWN_PRODUCT
        val skippedItems = itemsWithoutId.map { item ->
            logger.info { "Item '${item.name}' sin ID, omitido" }
            SkippedItem(item = item, reason = SkipReason.UNKNOWN_PRODUCT)
        }.toMutableList()

        if (itemsWithId.isEmpty()) {
            logger.info { "Pedido repetido: 0 agregados, ${skippedItems.size} omitidos" }
            return@runCatching RepeatOrderResult(addedItems = emptyList(), skippedItems = skippedItems)
        }

        // Consultar disponibilidad de los items con ID
        val productIds = itemsWithId.mapNotNull { it.id }
        val availabilityResult = availabilityService.checkAvailability(productIds)

        val addedItems = mutableListOf<ClientOrderItem>()

        if (availabilityResult.isSuccess) {
            val availabilityMap = availabilityResult.getOrThrow().associateBy { it.productId }

            itemsWithId.forEach { item ->
                val availability = availabilityMap[item.id]
                if (availability == null || availability.available) {
                    addedItems.add(item)
                } else {
                    val reason = availability.reason ?: SkipReason.UNKNOWN_PRODUCT
                    logger.info { "Item '${item.name}' no disponible: $reason" }
                    skippedItems.add(SkippedItem(item = item, reason = reason))
                }
            }
        } else {
            // Si falla la consulta de disponibilidad, agregar todos los items con ID
            // (comportamiento degradado: mejor intentar que bloquear)
            logger.warning { "Fallo al consultar disponibilidad, agregando todos los items con ID" }
            addedItems.addAll(itemsWithId)
        }

        logger.info { "Pedido repetido: ${addedItems.size} agregados, ${skippedItems.size} omitidos" }
        RepeatOrderResult(addedItems = addedItems, skippedItems = skippedItems)
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al repetir pedido ${order.id}" }
        throw throwable.toClientException()
    }
}
