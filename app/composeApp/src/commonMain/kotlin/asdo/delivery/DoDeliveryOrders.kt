package asdo.delivery

import ext.delivery.CommDeliveryOrdersService
import ext.delivery.toDeliveryException
import kotlinx.datetime.LocalDate
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoGetActiveDeliveryOrders(
    private val ordersService: CommDeliveryOrdersService
) : ToDoGetActiveDeliveryOrders {

    private val logger = LoggerFactory.default.newLogger<DoGetActiveDeliveryOrders>()

    private val statusPriority = listOf(
        DeliveryOrderStatus.PENDING,
        DeliveryOrderStatus.IN_PROGRESS
    )

    override suspend fun execute(): Result<List<DeliveryOrder>> = runCatching {
        logger.info { "Obteniendo pedidos activos del repartidor" }
        ordersService.fetchActiveOrders().getOrThrow()
            .map { it.toDomain() }
            .filterNot { it.status == DeliveryOrderStatus.DELIVERED }
            .sortedWith(compareBy(
                { statusPriority.indexOf(it.status).let { idx -> if (idx >= 0) idx else Int.MAX_VALUE } },
                { it.eta.orEmpty() }
            ))
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener pedidos activos" }
        throw throwable.toDeliveryException()
    }
}

class DoGetDeliveryOrdersSummary(
    private val ordersService: CommDeliveryOrdersService
) : ToDoGetDeliveryOrdersSummary {

    private val logger = LoggerFactory.default.newLogger<DoGetDeliveryOrdersSummary>()

    override suspend fun execute(date: LocalDate): Result<DeliveryOrdersSummary> = runCatching {
        logger.info { "Obteniendo resumen de pedidos para $date" }
        ordersService.fetchSummary(date).getOrThrow().toDomain()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener resumen de pedidos" }
        throw throwable.toDeliveryException()
    }
}

class DoUpdateDeliveryOrderStatus(
    private val ordersService: CommDeliveryOrdersService
) : ToDoUpdateDeliveryOrderStatus {

    private val logger = LoggerFactory.default.newLogger<DoUpdateDeliveryOrderStatus>()

    override suspend fun execute(
        orderId: String,
        newStatus: DeliveryOrderStatus,
        reason: String?
    ): Result<DeliveryOrderStatusUpdateResult> = runCatching {
        logger.info { "Actualizando estado del pedido $orderId a $newStatus" }
        ordersService.updateOrderStatus(orderId, newStatus.toApiString(), reason)
            .getOrThrow()
            .toDomain()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al actualizar estado del pedido $orderId" }
        throw throwable.toDeliveryException()
    }
}

class DoGetDeliveryOrderDetail(
    private val ordersService: CommDeliveryOrdersService
) : ToDoGetDeliveryOrderDetail {

    private val logger = LoggerFactory.default.newLogger<DoGetDeliveryOrderDetail>()

    override suspend fun execute(orderId: String): Result<DeliveryOrderDetail> = runCatching {
        logger.info { "Obteniendo detalle del pedido $orderId" }
        ordersService.fetchOrderDetail(orderId).getOrThrow().toDetailDomain()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener detalle del pedido $orderId" }
        throw throwable.toDeliveryException()
    }
}

<<<<<<< HEAD
class DoGetAvailableDeliveryOrders(
    private val ordersService: CommDeliveryOrdersService
) : ToDoGetAvailableDeliveryOrders {

    private val logger = LoggerFactory.default.newLogger<DoGetAvailableDeliveryOrders>()

    override suspend fun execute(): Result<List<DeliveryOrder>> = runCatching {
        logger.info { "Obteniendo pedidos disponibles para tomar" }
        ordersService.fetchAvailableOrders().getOrThrow()
            .map { it.toDomain() }
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener pedidos disponibles" }
        throw throwable.toDeliveryException()
    }
}

class DoTakeDeliveryOrder(
    private val ordersService: CommDeliveryOrdersService
) : ToDoTakeDeliveryOrder {

    private val logger = LoggerFactory.default.newLogger<DoTakeDeliveryOrder>()

    override suspend fun execute(orderId: String): Result<DeliveryOrderStatusUpdateResult> = runCatching {
        logger.info { "Tomando pedido $orderId" }
        ordersService.takeOrder(orderId).getOrThrow().toDomain()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al tomar pedido $orderId" }
        throw throwable.toDeliveryException()
    }
}

class DoGetDeliveryOrderHistory(
    private val ordersService: CommDeliveryOrdersService
) : ToDoGetDeliveryOrderHistory {

    private val logger = LoggerFactory.default.newLogger<DoGetDeliveryOrderHistory>()

    override suspend fun execute(): Result<List<DeliveryOrder>> = runCatching {
        logger.info { "Obteniendo historial de pedidos del repartidor" }
        ordersService.fetchHistoryOrders().getOrThrow()
            .map { it.toDomain() }
            .filter { it.status == DeliveryOrderStatus.DELIVERED || it.status == DeliveryOrderStatus.NOT_DELIVERED }
            .sortedByDescending { it.eta.orEmpty() }
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener historial de pedidos" }
        throw throwable.toDeliveryException()
    }
}
