package ui.sc.delivery

import asdo.delivery.DeliveryOrder
import asdo.delivery.DeliveryOrderStatus
import asdo.delivery.DeliveryOrderStatusUpdateResult
import asdo.delivery.ToDoGetActiveDeliveryOrders
import asdo.delivery.ToDoUpdateDeliveryOrderStatus
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val sampleDomainOrders = listOf(
    DeliveryOrder(id = "o1", label = "PUB-1", businessName = "Pizzeria", neighborhood = "Centro", status = DeliveryOrderStatus.PENDING, eta = "12:00"),
    DeliveryOrder(id = "o2", label = "PUB-2", businessName = "Farmacia", neighborhood = "Norte", status = DeliveryOrderStatus.IN_PROGRESS, eta = "11:30"),
    DeliveryOrder(id = "o3", label = "PUB-3", businessName = "Panaderia", neighborhood = "Sur", status = DeliveryOrderStatus.DELIVERED, eta = "10:00"),
)

private class FakeGetActiveOrdersForDashboard(
    private val result: Result<List<DeliveryOrder>> = Result.success(sampleDomainOrders)
) : ToDoGetActiveDeliveryOrders {
    override suspend fun execute(): Result<List<DeliveryOrder>> = result
}

private class FakeUpdateDeliveryOrderStatus(
    private val result: Result<DeliveryOrderStatusUpdateResult> = Result.success(
        DeliveryOrderStatusUpdateResult(orderId = "o1", newStatus = DeliveryOrderStatus.IN_PROGRESS)
    )
) : ToDoUpdateDeliveryOrderStatus {
    override suspend fun execute(orderId: String, newStatus: DeliveryOrderStatus): Result<DeliveryOrderStatusUpdateResult> = result
}

class DeliveryOrdersViewModelTest {

    @Test
    fun `loadOrders exitoso muestra lista`() = runTest {
        val viewModel = DeliveryOrdersViewModel(
            getActiveOrders = FakeGetActiveOrdersForDashboard(),
            updateOrderStatus = FakeUpdateDeliveryOrderStatus()
        )

        viewModel.loadOrders()

        assertEquals(DeliveryOrdersStatus.Loaded, viewModel.state.status)
        assertEquals(3, viewModel.state.orders.size)
        assertEquals("PUB-1", viewModel.state.orders[0].label)
    }

    @Test
    fun `loadOrders vacio muestra Empty`() = runTest {
        val viewModel = DeliveryOrdersViewModel(
            getActiveOrders = FakeGetActiveOrdersForDashboard(Result.success(emptyList())),
            updateOrderStatus = FakeUpdateDeliveryOrderStatus()
        )

        viewModel.loadOrders()

        assertEquals(DeliveryOrdersStatus.Empty, viewModel.state.status)
        assertTrue(viewModel.state.orders.isEmpty())
    }

    @Test
    fun `loadOrders con error muestra Error`() = runTest {
        val viewModel = DeliveryOrdersViewModel(
            getActiveOrders = FakeGetActiveOrdersForDashboard(Result.failure(RuntimeException("Sin conexion"))),
            updateOrderStatus = FakeUpdateDeliveryOrderStatus()
        )

        viewModel.loadOrders()

        assertEquals(DeliveryOrdersStatus.Error, viewModel.state.status)
        assertTrue(viewModel.state.errorMessage != null)
    }

    @Test
    fun `selectFilter filtra pedidos por estado pendiente`() = runTest {
        val viewModel = DeliveryOrdersViewModel(
            getActiveOrders = FakeGetActiveOrdersForDashboard(),
            updateOrderStatus = FakeUpdateDeliveryOrderStatus()
        )

        viewModel.loadOrders()
        viewModel.selectFilter(DeliveryOrderStatus.PENDING)

        assertEquals(DeliveryOrdersStatus.Loaded, viewModel.state.status)
        assertEquals(1, viewModel.state.orders.size)
        assertEquals(DeliveryOrderStatus.PENDING, viewModel.state.orders[0].status)
        assertEquals(DeliveryOrderStatus.PENDING, viewModel.state.selectedFilter)
    }

    @Test
    fun `selectFilter null muestra todos los pedidos`() = runTest {
        val viewModel = DeliveryOrdersViewModel(
            getActiveOrders = FakeGetActiveOrdersForDashboard(),
            updateOrderStatus = FakeUpdateDeliveryOrderStatus()
        )

        viewModel.loadOrders()
        viewModel.selectFilter(DeliveryOrderStatus.PENDING)
        viewModel.selectFilter(null)

        assertEquals(DeliveryOrdersStatus.Loaded, viewModel.state.status)
        assertEquals(3, viewModel.state.orders.size)
        assertNull(viewModel.state.selectedFilter)
    }

    @Test
    fun `updateStatus exitoso actualiza estado del pedido en lista`() = runTest {
        val viewModel = DeliveryOrdersViewModel(
            getActiveOrders = FakeGetActiveOrdersForDashboard(),
            updateOrderStatus = FakeUpdateDeliveryOrderStatus(
                Result.success(DeliveryOrderStatusUpdateResult(orderId = "o1", newStatus = DeliveryOrderStatus.IN_PROGRESS))
            )
        )

        viewModel.loadOrders()
        viewModel.updateStatus("o1", DeliveryOrderStatus.IN_PROGRESS)

        assertTrue(viewModel.state.statusUpdateSuccess)
        assertNull(viewModel.state.updatingOrderId)
        val updatedOrder = viewModel.state.orders.find { it.id == "o1" }
        assertEquals(DeliveryOrderStatus.IN_PROGRESS, updatedOrder?.status)
    }

    @Test
    fun `updateStatus con error muestra mensaje de error`() = runTest {
        val viewModel = DeliveryOrdersViewModel(
            getActiveOrders = FakeGetActiveOrdersForDashboard(),
            updateOrderStatus = FakeUpdateDeliveryOrderStatus(
                Result.failure(RuntimeException("Error de red"))
            )
        )

        viewModel.loadOrders()
        viewModel.updateStatus("o1", DeliveryOrderStatus.IN_PROGRESS)

        assertTrue(viewModel.state.statusUpdateError != null)
        assertNull(viewModel.state.updatingOrderId)
    }
}
