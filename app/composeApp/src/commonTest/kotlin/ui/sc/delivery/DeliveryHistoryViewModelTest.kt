package ui.sc.delivery

import asdo.delivery.DeliveryOrder
import asdo.delivery.DeliveryOrderStatus
import asdo.delivery.ToDoGetDeliveryOrderHistory
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val sampleHistoryOrders = listOf(
    DeliveryOrder(id = "h1", label = "PUB-10", businessName = "Almacen Don Julio", neighborhood = "Palermo", status = DeliveryOrderStatus.DELIVERED, eta = "2026-03-20 14:30"),
    DeliveryOrder(id = "h2", label = "PUB-11", businessName = "La Buena Mesa", neighborhood = "Villa Crespo", status = DeliveryOrderStatus.NOT_DELIVERED, eta = "2026-03-19 20:15"),
    DeliveryOrder(id = "h3", label = "PUB-12", businessName = "Farmacia Sur", neighborhood = "San Telmo", status = DeliveryOrderStatus.DELIVERED, eta = "2026-03-18 11:00"),
)

private class FakeGetDeliveryOrderHistory(
    private val result: Result<List<DeliveryOrder>> = Result.success(sampleHistoryOrders)
) : ToDoGetDeliveryOrderHistory {
    override suspend fun execute(): Result<List<DeliveryOrder>> = result
}

class DeliveryHistoryViewModelTest {

    @Test
    fun `loadHistory exitoso muestra lista de pedidos historicos`() = runTest {
        val viewModel = DeliveryHistoryViewModel(
            getOrderHistory = FakeGetDeliveryOrderHistory()
        )

        viewModel.loadHistory()

        assertEquals(DeliveryHistoryStatus.Loaded, viewModel.state.status)
        assertEquals(3, viewModel.state.orders.size)
        assertEquals("PUB-10", viewModel.state.orders[0].label)
    }

    @Test
    fun `loadHistory vacio muestra Empty`() = runTest {
        val viewModel = DeliveryHistoryViewModel(
            getOrderHistory = FakeGetDeliveryOrderHistory(Result.success(emptyList()))
        )

        viewModel.loadHistory()

        assertEquals(DeliveryHistoryStatus.Empty, viewModel.state.status)
        assertTrue(viewModel.state.orders.isEmpty())
    }

    @Test
    fun `loadHistory con error muestra Error con mensaje`() = runTest {
        val viewModel = DeliveryHistoryViewModel(
            getOrderHistory = FakeGetDeliveryOrderHistory(Result.failure(RuntimeException("Sin conexion")))
        )

        viewModel.loadHistory()

        assertEquals(DeliveryHistoryStatus.Error, viewModel.state.status)
        assertTrue(viewModel.state.errorMessage != null)
    }

    @Test
    fun `loadHistory solo muestra pedidos DELIVERED y NOT_DELIVERED`() = runTest {
        val viewModel = DeliveryHistoryViewModel(
            getOrderHistory = FakeGetDeliveryOrderHistory()
        )

        viewModel.loadHistory()

        viewModel.state.orders.forEach { order ->
            assertTrue(
                order.status == DeliveryOrderStatus.DELIVERED || order.status == DeliveryOrderStatus.NOT_DELIVERED,
                "El pedido ${order.id} tiene estado ${order.status} que no es historico"
            )
        }
    }

    @Test
    fun `clearError limpia el mensaje de error`() = runTest {
        val viewModel = DeliveryHistoryViewModel(
            getOrderHistory = FakeGetDeliveryOrderHistory(Result.failure(RuntimeException("Error")))
        )

        viewModel.loadHistory()
        assertTrue(viewModel.state.errorMessage != null)

        viewModel.clearError()
        assertNull(viewModel.state.errorMessage)
    }
}
