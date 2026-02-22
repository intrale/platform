package ui.sc.client

import asdo.client.ClientOrder
import asdo.client.ClientOrderDetail
import asdo.client.ClientOrderItem
import asdo.client.ClientOrderStatus
import asdo.client.ToDoGetClientOrderDetail
import asdo.client.ToDoGetClientOrders
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleOrders = listOf(
    ClientOrder(
        id = "o1",
        label = "PED-001",
        businessName = "Pizzeria Roma",
        status = ClientOrderStatus.PENDING,
        createdAt = "2026-02-20T10:00:00",
        promisedAt = "2026-02-20T11:00:00",
        total = 2500.0,
        itemCount = 3
    ),
    ClientOrder(
        id = "o2",
        label = "PED-002",
        businessName = "Farmacia Norte",
        status = ClientOrderStatus.DELIVERED,
        createdAt = "2026-02-19T15:00:00",
        promisedAt = null,
        total = 1800.0,
        itemCount = 2
    ),
    ClientOrder(
        id = "o3",
        label = "PED-003",
        businessName = "Panaderia Sur",
        status = ClientOrderStatus.CANCELLED,
        createdAt = "2026-02-18T09:00:00",
        promisedAt = null,
        total = 500.0,
        itemCount = 1
    )
)

private val sampleOrderDetail = ClientOrderDetail(
    id = "o1",
    label = "PED-001",
    businessName = "Pizzeria Roma",
    status = ClientOrderStatus.PENDING,
    createdAt = "2026-02-20T10:00:00",
    promisedAt = "2026-02-20T11:00:00",
    total = 2500.0,
    itemCount = 3,
    items = listOf(
        ClientOrderItem(id = "i1", name = "Pizza Grande", quantity = 1, unitPrice = 1500.0, subtotal = 1500.0),
        ClientOrderItem(id = "i2", name = "Empanada", quantity = 4, unitPrice = 250.0, subtotal = 1000.0)
    ),
    address = null
)

private class FakeGetClientOrders(
    private val result: Result<List<ClientOrder>> = Result.success(sampleOrders)
) : ToDoGetClientOrders {
    override suspend fun execute(): Result<List<ClientOrder>> = result
}

private class FakeGetClientOrderDetail(
    private val result: Result<ClientOrderDetail> = Result.success(sampleOrderDetail)
) : ToDoGetClientOrderDetail {
    override suspend fun execute(orderId: String): Result<ClientOrderDetail> = result
}

class ClientOrdersViewModelTest {

    private fun createViewModel(
        getClientOrders: ToDoGetClientOrders = FakeGetClientOrders(),
        getClientOrderDetail: ToDoGetClientOrderDetail = FakeGetClientOrderDetail()
    ): ClientOrdersViewModel = ClientOrdersViewModel(
        getClientOrders = getClientOrders,
        getClientOrderDetail = getClientOrderDetail,
        loggerFactory = testLoggerFactory
    )

    @Test
    fun `loadOrders exitoso muestra lista de pedidos`() = runTest {
        val viewModel = createViewModel()

        viewModel.loadOrders()

        assertEquals(ClientOrdersStatus.Loaded, viewModel.state.status)
        assertEquals(3, viewModel.state.orders.size)
        assertEquals("PED-001", viewModel.state.orders[0].label)
    }

    @Test
    fun `loadOrders vacio muestra Empty`() = runTest {
        val viewModel = createViewModel(
            getClientOrders = FakeGetClientOrders(Result.success(emptyList()))
        )

        viewModel.loadOrders()

        assertEquals(ClientOrdersStatus.Empty, viewModel.state.status)
        assertTrue(viewModel.state.orders.isEmpty())
    }

    @Test
    fun `loadOrders con error muestra Error`() = runTest {
        val viewModel = createViewModel(
            getClientOrders = FakeGetClientOrders(Result.failure(RuntimeException("Sin conexion")))
        )

        viewModel.loadOrders()

        assertEquals(ClientOrdersStatus.Error, viewModel.state.status)
        assertTrue(viewModel.state.errorMessage != null)
    }

    @Test
    fun `selectFilter filtra pedidos por estado pendiente`() = runTest {
        val viewModel = createViewModel()

        viewModel.loadOrders()
        viewModel.selectFilter(ClientOrderStatus.PENDING)

        assertEquals(ClientOrdersStatus.Loaded, viewModel.state.status)
        assertEquals(1, viewModel.state.orders.size)
        assertEquals(ClientOrderStatus.PENDING, viewModel.state.orders[0].status)
        assertEquals(ClientOrderStatus.PENDING, viewModel.state.selectedFilter)
    }

    @Test
    fun `selectFilter null muestra todos los pedidos`() = runTest {
        val viewModel = createViewModel()

        viewModel.loadOrders()
        viewModel.selectFilter(ClientOrderStatus.PENDING)
        viewModel.selectFilter(null)

        assertEquals(ClientOrdersStatus.Loaded, viewModel.state.status)
        assertEquals(3, viewModel.state.orders.size)
        assertNull(viewModel.state.selectedFilter)
    }

    @Test
    fun `selectFilter con estado sin resultados muestra Empty`() = runTest {
        val viewModel = createViewModel()

        viewModel.loadOrders()
        viewModel.selectFilter(ClientOrderStatus.IN_PROGRESS)

        assertEquals(ClientOrdersStatus.Empty, viewModel.state.status)
        assertTrue(viewModel.state.orders.isEmpty())
    }

    @Test
    fun `loadOrderDetail exitoso carga el detalle`() = runTest {
        val viewModel = createViewModel()

        viewModel.loadOrderDetail("o1")

        assertFalse(viewModel.state.detailLoading)
        assertNull(viewModel.state.detailError)
        assertEquals("o1", viewModel.state.selectedOrderDetail?.id)
        assertEquals(2, viewModel.state.selectedOrderDetail?.items?.size)
    }

    @Test
    fun `loadOrderDetail con error muestra mensaje de error`() = runTest {
        val viewModel = createViewModel(
            getClientOrderDetail = FakeGetClientOrderDetail(
                Result.failure(RuntimeException("Pedido no encontrado"))
            )
        )

        viewModel.loadOrderDetail("o1")

        assertFalse(viewModel.state.detailLoading)
        assertTrue(viewModel.state.detailError != null)
        assertNull(viewModel.state.selectedOrderDetail)
    }

    @Test
    fun `clearOrderDetail limpia el detalle seleccionado`() = runTest {
        val viewModel = createViewModel()

        viewModel.loadOrderDetail("o1")
        viewModel.clearOrderDetail()

        assertNull(viewModel.state.selectedOrderDetail)
        assertNull(viewModel.state.detailError)
        assertFalse(viewModel.state.detailLoading)
    }

    @Test
    fun `clearError limpia el mensaje de error`() = runTest {
        val viewModel = createViewModel(
            getClientOrders = FakeGetClientOrders(Result.failure(RuntimeException("Error")))
        )

        viewModel.loadOrders()
        assertTrue(viewModel.state.errorMessage != null)

        viewModel.clearError()

        assertNull(viewModel.state.errorMessage)
    }
}
