package ui.sc.delivery

import asdo.delivery.DeliveryOrder
import asdo.delivery.DeliveryOrderStatus
import asdo.delivery.DeliveryOrderStatusUpdateResult
import asdo.delivery.ToDoGetAvailableDeliveryOrders
import asdo.delivery.ToDoTakeDeliveryOrder
import ext.delivery.DeliveryExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val sampleAvailableOrders = listOf(
    DeliveryOrder(id = "a1", label = "AV-1", businessName = "Pizzeria", neighborhood = "Palermo", status = DeliveryOrderStatus.PENDING, eta = "12:00"),
    DeliveryOrder(id = "a2", label = "AV-2", businessName = "Farmacia", neighborhood = "Norte", status = DeliveryOrderStatus.PENDING, eta = null),
)

private class FakeGetAvailableOrders(
    private val result: Result<List<DeliveryOrder>> = Result.success(sampleAvailableOrders)
) : ToDoGetAvailableDeliveryOrders {
    override suspend fun execute(): Result<List<DeliveryOrder>> = result
}

private class FakeTakeDeliveryOrder(
    private val result: Result<DeliveryOrderStatusUpdateResult> = Result.success(
        DeliveryOrderStatusUpdateResult(orderId = "a1", newStatus = DeliveryOrderStatus.IN_PROGRESS)
    )
) : ToDoTakeDeliveryOrder {
    override suspend fun execute(orderId: String): Result<DeliveryOrderStatusUpdateResult> = result
}

class AvailableOrdersViewModelTest {

    @Test
    fun `loadAvailableOrders exitoso muestra lista de pedidos`() = runTest {
        val viewModel = AvailableOrdersViewModel(
            getAvailableOrders = FakeGetAvailableOrders(),
            takeOrder = FakeTakeDeliveryOrder()
        )

        viewModel.loadAvailableOrders()

        assertEquals(AvailableOrdersStatus.Loaded, viewModel.state.status)
        assertEquals(2, viewModel.state.orders.size)
        assertEquals("a1", viewModel.state.orders[0].id)
    }

    @Test
    fun `loadAvailableOrders sin pedidos muestra estado Empty`() = runTest {
        val viewModel = AvailableOrdersViewModel(
            getAvailableOrders = FakeGetAvailableOrders(Result.success(emptyList())),
            takeOrder = FakeTakeDeliveryOrder()
        )

        viewModel.loadAvailableOrders()

        assertEquals(AvailableOrdersStatus.Empty, viewModel.state.status)
        assertTrue(viewModel.state.orders.isEmpty())
    }

    @Test
    fun `loadAvailableOrders con error muestra estado Error`() = runTest {
        val viewModel = AvailableOrdersViewModel(
            getAvailableOrders = FakeGetAvailableOrders(Result.failure(RuntimeException("Sin conexion"))),
            takeOrder = FakeTakeDeliveryOrder()
        )

        viewModel.loadAvailableOrders()

        assertEquals(AvailableOrdersStatus.Error, viewModel.state.status)
        assertTrue(viewModel.state.errorMessage != null)
    }

    @Test
    fun `takeOrder exitoso elimina el pedido de la lista y marca takeSuccess`() = runTest {
        val viewModel = AvailableOrdersViewModel(
            getAvailableOrders = FakeGetAvailableOrders(),
            takeOrder = FakeTakeDeliveryOrder()
        )
        viewModel.loadAvailableOrders()
        assertEquals(2, viewModel.state.orders.size)

        viewModel.takeOrder("a1")

        assertEquals(1, viewModel.state.orders.size)
        assertEquals("a2", viewModel.state.orders[0].id)
        assertTrue(viewModel.state.takeSuccess)
        assertNull(viewModel.state.takingOrderId)
        assertEquals(AvailableOrdersStatus.Loaded, viewModel.state.status)
    }

    @Test
    fun `takeOrder exitoso con ultimo pedido lleva a estado Empty`() = runTest {
        val singleOrder = listOf(
            DeliveryOrder(id = "a1", label = "AV-1", businessName = "Biz", neighborhood = "Centro", status = DeliveryOrderStatus.PENDING, eta = null)
        )
        val viewModel = AvailableOrdersViewModel(
            getAvailableOrders = FakeGetAvailableOrders(Result.success(singleOrder)),
            takeOrder = FakeTakeDeliveryOrder()
        )
        viewModel.loadAvailableOrders()

        viewModel.takeOrder("a1")

        assertEquals(AvailableOrdersStatus.Empty, viewModel.state.status)
        assertTrue(viewModel.state.orders.isEmpty())
        assertTrue(viewModel.state.takeSuccess)
    }

    @Test
    fun `takeOrder con conflicto 409 elimina pedido y marca alreadyTakenOrderId`() = runTest {
        val conflict = DeliveryExceptionResponse(
            statusCode = StatusCodeDTO(409, "Conflict"),
            message = "Pedido ya tomado"
        )
        val viewModel = AvailableOrdersViewModel(
            getAvailableOrders = FakeGetAvailableOrders(),
            takeOrder = FakeTakeDeliveryOrder(Result.failure(conflict))
        )
        viewModel.loadAvailableOrders()
        assertEquals(2, viewModel.state.orders.size)

        viewModel.takeOrder("a1")

        assertEquals(1, viewModel.state.orders.size)
        assertEquals("a1", viewModel.state.alreadyTakenOrderId)
        assertNull(viewModel.state.takingOrderId)
        assertFalse(viewModel.state.takeSuccess)
    }

    @Test
    fun `takeOrder con error generico marca takeError`() = runTest {
        val viewModel = AvailableOrdersViewModel(
            getAvailableOrders = FakeGetAvailableOrders(),
            takeOrder = FakeTakeDeliveryOrder(Result.failure(RuntimeException("Error de red")))
        )
        viewModel.loadAvailableOrders()

        viewModel.takeOrder("a1")

        assertTrue(viewModel.state.takeError != null)
        assertNull(viewModel.state.takingOrderId)
        assertFalse(viewModel.state.takeSuccess)
        assertEquals(2, viewModel.state.orders.size)
    }

    @Test
    fun `clearFeedback limpia takeSuccess takeError y alreadyTakenOrderId`() = runTest {
        val viewModel = AvailableOrdersViewModel(
            getAvailableOrders = FakeGetAvailableOrders(),
            takeOrder = FakeTakeDeliveryOrder()
        )
        viewModel.loadAvailableOrders()
        viewModel.takeOrder("a1")
        assertTrue(viewModel.state.takeSuccess)

        viewModel.clearFeedback()

        assertFalse(viewModel.state.takeSuccess)
        assertNull(viewModel.state.takeError)
        assertNull(viewModel.state.alreadyTakenOrderId)
    }
}
