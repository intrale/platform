package asdo.client

import ext.client.CommClientOrdersService
import ext.client.toClientException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoGetClientOrders(
    private val ordersService: CommClientOrdersService
) : ToDoGetClientOrders {

    private val logger = LoggerFactory.default.newLogger<DoGetClientOrders>()

    override suspend fun execute(): Result<List<ClientOrder>> = runCatching {
        logger.info { "Obteniendo pedidos del cliente" }
        ordersService.listOrders().getOrThrow()
            .map { it.toDomain() }
            .sortedByDescending { it.createdAt }
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener pedidos del cliente" }
        throw throwable.toClientException()
    }
}

class DoGetClientOrderDetail(
    private val ordersService: CommClientOrdersService
) : ToDoGetClientOrderDetail {

    private val logger = LoggerFactory.default.newLogger<DoGetClientOrderDetail>()

    override suspend fun execute(orderId: String): Result<ClientOrderDetail> = runCatching {
        logger.info { "Obteniendo detalle del pedido $orderId" }
        ordersService.fetchOrderDetail(orderId).getOrThrow().toDomain()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener detalle del pedido $orderId" }
        throw throwable.toClientException()
    }
}
