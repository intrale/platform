package ui.sc.client

import asdo.client.ClientOrder
import asdo.client.ClientOrderAddress
import asdo.client.ClientOrderDetail
import asdo.client.ClientOrderItem
import asdo.client.ClientOrderStatus
import asdo.client.ToDoGetClientOrders
import asdo.client.ToDoGetClientOrderDetail
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleOrders = listOf(
    ClientOrder(
        id = "ord-1", publicId = "PUB-001", shortCode = "SC01",
        businessName = "Tienda", status = ClientOrderStatus.PENDING,
        createdAt = "2025-01-01", promisedAt = null, total = 150.0, itemCount = 3
    ),
    ClientOrder(
        id = "ord-2", publicId = "PUB-002", shortCode = "SC02",
        businessName = "Farmacia", status = ClientOrderStatus.DELIVERED,
        createdAt = "2025-01-02", promisedAt = "2025-01-03", total = 200.0, itemCount = 1
    )
)

private val sampleDetail = ClientOrderDetail(
    id = "ord-1", publicId = "PUB-001", shortCode = "SC01",
    businessName = "Tienda", status = ClientOrderStatus.PENDING,
    createdAt = "2025-01-01", promisedAt = null, total = 150.0, itemCount = 2,
    items = listOf(
        ClientOrderItem(id = "item-1", name = "Producto A", quantity = 2, unitPrice = 50.0, subtotal = 100.0),
        ClientOrderItem(id = "item-2", name = "Producto B", quantity = 1, unitPrice = 50.0, subtotal = 50.0)
    ),
    address = null
)

private class FakeGetClientOrders(
    private val result: Result<List<ClientOrder>> = Result.success(sampleOrders)
) : ToDoGetClientOrders {
    override suspend fun execute(): Result<List<ClientOrder>> = result
}

private class FakeGetClientOrderDetail(
    private val result: Result<ClientOrderDetail> = Result.success(sampleDetail)
) : ToDoGetClientOrderDetail {
    override suspend fun execute(orderId: String): Result<ClientOrderDetail> = result
}

class ClientOrdersViewModelTest {

    @Test
    fun `loadOrders exitoso muestra lista de pedidos`() = runTest {
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadOrders()

        assertEquals(ClientOrdersStatus.Loaded, viewModel.state.status)
        assertEquals(2, viewModel.state.orders.size)
        assertEquals("PUB-001", viewModel.state.orders[0].publicId)
    }

    @Test
    fun `loadOrders con lista vacia muestra Empty`() = runTest {
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(Result.success(emptyList())),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadOrders()

        assertEquals(ClientOrdersStatus.Empty, viewModel.state.status)
        assertTrue(viewModel.state.orders.isEmpty())
    }

    @Test
    fun `loadOrders con error muestra Error`() = runTest {
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(Result.failure(RuntimeException("Sin conexion"))),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadOrders()

        assertEquals(ClientOrdersStatus.Error, viewModel.state.status)
        assertNotNull(viewModel.state.errorMessage)
    }

    @Test
    fun `loadOrderDetail exitoso actualiza selectedOrder`() = runTest {
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadOrderDetail("ord-1")

        assertNotNull(viewModel.state.selectedOrder)
        assertEquals("ord-1", viewModel.state.selectedOrder?.id)
        assertEquals(2, viewModel.state.selectedOrder?.items?.size)
        assertFalse(viewModel.state.loadingDetail)
    }

    @Test
    fun `loadOrderDetail con error muestra detailError`() = runTest {
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(),
            getClientOrderDetail = FakeGetClientOrderDetail(Result.failure(RuntimeException("Error"))),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadOrderDetail("ord-1")

        assertNull(viewModel.state.selectedOrder)
        assertNotNull(viewModel.state.detailError)
        assertFalse(viewModel.state.loadingDetail)
    }

    @Test
    fun `clearSelectedOrder limpia el detalle seleccionado`() = runTest {
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadOrderDetail("ord-1")
        assertNotNull(viewModel.state.selectedOrder)

        viewModel.clearSelectedOrder()

        assertNull(viewModel.state.selectedOrder)
        assertNull(viewModel.state.detailError)
    }
}
