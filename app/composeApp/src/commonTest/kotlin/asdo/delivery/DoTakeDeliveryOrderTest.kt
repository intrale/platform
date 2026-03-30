package asdo.delivery

import ar.com.intrale.shared.delivery.DeliveryOrderStatusUpdateResponse
import ext.delivery.CommDeliveryOrdersService
import ext.delivery.DeliveryExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeDeliveryOrdersServiceForTake(
    private val availableResult: Result<List<ar.com.intrale.shared.delivery.DeliveryOrderDTO>> = Result.success(emptyList()),
    private val takeResult: Result<DeliveryOrderStatusUpdateResponse> = Result.success(
        DeliveryOrderStatusUpdateResponse(orderId = "order-1", status = "assigned", message = "Pedido tomado")
    )
) : CommDeliveryOrdersService {
    override suspend fun fetchSummary(date: kotlinx.datetime.LocalDate) =
        Result.failure<ar.com.intrale.shared.delivery.DeliveryOrdersSummaryDTO>(NotImplementedError())
    override suspend fun fetchActiveOrders() =
        Result.failure<List<ar.com.intrale.shared.delivery.DeliveryOrderDTO>>(NotImplementedError())
    override suspend fun fetchAvailableOrders() = availableResult
    override suspend fun updateOrderStatus(orderId: String, newStatus: String, reason: String?) =
        Result.failure<DeliveryOrderStatusUpdateResponse>(NotImplementedError())
    override suspend fun fetchOrderDetail(orderId: String) =
        Result.failure<ar.com.intrale.shared.delivery.DeliveryOrderDTO>(NotImplementedError())
    override suspend fun takeOrder(orderId: String) = takeResult
    override suspend fun fetchHistoryOrders() =
        Result.failure<List<ar.com.intrale.shared.delivery.DeliveryOrderDTO>>(NotImplementedError())
}

class DoGetAvailableDeliveryOrdersTest {

    @Test
    fun `execute retorna lista de pedidos disponibles mapeados al dominio`() = runTest {
        val dto = ar.com.intrale.shared.delivery.DeliveryOrderDTO(
            id = "order-1",
            businessName = "Pizzeria",
            neighborhood = "Palermo",
            status = "pending"
        )
        val service = FakeDeliveryOrdersServiceForTake(
            availableResult = Result.success(listOf(dto))
        )

        val sut = DoGetAvailableDeliveryOrders(service)
        val result = sut.execute()

        assertTrue(result.isSuccess)
        val orders = result.getOrThrow()
        assertEquals(1, orders.size)
        assertEquals("order-1", orders[0].id)
        assertEquals("Pizzeria", orders[0].businessName)
        assertEquals(DeliveryOrderStatus.PENDING, orders[0].status)
    }

    @Test
    fun `execute retorna lista vacía cuando no hay pedidos`() = runTest {
        val service = FakeDeliveryOrdersServiceForTake(
            availableResult = Result.success(emptyList())
        )

        val sut = DoGetAvailableDeliveryOrders(service)
        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow().isEmpty())
    }

    @Test
    fun `execute envuelve errores como DeliveryExceptionResponse`() = runTest {
        val service = FakeDeliveryOrdersServiceForTake(
            availableResult = Result.failure(RuntimeException("Sin conexion"))
        )

        val sut = DoGetAvailableDeliveryOrders(service)
        val result = sut.execute()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }
}

class DoTakeDeliveryOrderTest {

    @Test
    fun `execute retorna resultado de tomar pedido exitoso`() = runTest {
        val service = FakeDeliveryOrdersServiceForTake(
            takeResult = Result.success(
                DeliveryOrderStatusUpdateResponse(orderId = "order-1", status = "assigned")
            )
        )

        val sut = DoTakeDeliveryOrder(service)
        val result = sut.execute("order-1")

        assertTrue(result.isSuccess)
        val taken = result.getOrThrow()
        assertEquals("order-1", taken.orderId)
        assertEquals(DeliveryOrderStatus.IN_PROGRESS, taken.newStatus)
    }

    @Test
    fun `execute envuelve errores de servicio como DeliveryExceptionResponse`() = runTest {
        val service = FakeDeliveryOrdersServiceForTake(
            takeResult = Result.failure(
                DeliveryExceptionResponse(
                    statusCode = StatusCodeDTO(409, "Conflict"),
                    message = "Pedido ya tomado"
                )
            )
        )

        val sut = DoTakeDeliveryOrder(service)
        val result = sut.execute("order-1")

        assertTrue(result.isFailure)
        val error = result.exceptionOrNull()
        assertTrue(error is DeliveryExceptionResponse)
        assertEquals(409, (error as DeliveryExceptionResponse).statusCode.value)
    }
}
