package ui.sc.delivery

import asdo.delivery.DeliveryOrder
import asdo.delivery.DeliveryOrderStatus
import asdo.delivery.ToDoGetActiveDeliveryOrders
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val sampleDomainOrders = listOf(
    DeliveryOrder(id = "o1", label = "PUB-1", businessName = "Pizzeria", neighborhood = "Centro", status = DeliveryOrderStatus.PENDING, eta = "12:00"),
    DeliveryOrder(id = "o2", label = "PUB-2", businessName = "Farmacia", neighborhood = "Norte", status = DeliveryOrderStatus.IN_PROGRESS, eta = "11:30"),
)

private class FakeGetActiveOrdersForDashboard(
    private val result: Result<List<DeliveryOrder>> = Result.success(sampleDomainOrders)
) : ToDoGetActiveDeliveryOrders {
    override suspend fun execute(): Result<List<DeliveryOrder>> = result
}

class DeliveryOrdersViewModelTest {

    @Test
    fun `loadOrders exitoso muestra lista`() = runTest {
        val viewModel = DeliveryOrdersViewModel(
            getActiveOrders = FakeGetActiveOrdersForDashboard()
        )

        viewModel.loadOrders()

        assertEquals(DeliveryOrdersStatus.Loaded, viewModel.state.status)
        assertEquals(2, viewModel.state.orders.size)
        assertEquals("PUB-1", viewModel.state.orders[0].label)
    }

    @Test
    fun `loadOrders vacio muestra Empty`() = runTest {
        val viewModel = DeliveryOrdersViewModel(
            getActiveOrders = FakeGetActiveOrdersForDashboard(Result.success(emptyList()))
        )

        viewModel.loadOrders()

        assertEquals(DeliveryOrdersStatus.Empty, viewModel.state.status)
        assertTrue(viewModel.state.orders.isEmpty())
    }

    @Test
    fun `loadOrders con error muestra Error`() = runTest {
        val viewModel = DeliveryOrdersViewModel(
            getActiveOrders = FakeGetActiveOrdersForDashboard(Result.failure(RuntimeException("Sin conexion")))
        )

        viewModel.loadOrders()

        assertEquals(DeliveryOrdersStatus.Error, viewModel.state.status)
        assertTrue(viewModel.state.errorMessage != null)
    }
}
