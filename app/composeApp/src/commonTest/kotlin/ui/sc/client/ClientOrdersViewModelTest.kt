package ui.sc.client

import asdo.client.ClientOrder
import asdo.client.ClientOrderAddress
import asdo.client.ClientOrderDetail
import asdo.client.ClientOrderItem
import asdo.client.ClientOrderStatus
import asdo.client.RepeatOrderResult
import asdo.client.ToDoGetClientOrders
import asdo.client.ToDoGetClientOrderDetail
import asdo.client.ToDoRepeatOrder
import kotlin.test.BeforeTest
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

private class FakeRepeatOrder(
    private val result: Result<RepeatOrderResult> = Result.success(
        RepeatOrderResult(addedItems = emptyList(), skippedItems = emptyList())
    )
) : ToDoRepeatOrder {
    override suspend fun execute(order: ClientOrderDetail): Result<RepeatOrderResult> = result
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
        // Ordenados por fecha descendente: 2025-01-02 primero
        assertEquals("PUB-002", viewModel.state.orders[0].publicId)
        assertEquals("PUB-001", viewModel.state.orders[1].publicId)
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

    @Test
    fun `selectFilter filtra pedidos por estado`() = runTest {
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadOrders()
        assertEquals(2, viewModel.state.orders.size)

        viewModel.selectFilter(ClientOrderStatus.PENDING)

        assertEquals(ClientOrdersStatus.Loaded, viewModel.state.status)
        assertEquals(1, viewModel.state.orders.size)
        assertEquals("ord-1", viewModel.state.orders[0].id)
        assertEquals(ClientOrderStatus.PENDING, viewModel.state.selectedFilter)
    }

    @Test
    fun `selectFilter sin coincidencias muestra Empty`() = runTest {
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadOrders()

        viewModel.selectFilter(ClientOrderStatus.CANCELLED)

        assertEquals(ClientOrdersStatus.Empty, viewModel.state.status)
        assertTrue(viewModel.state.orders.isEmpty())
        assertEquals(ClientOrderStatus.CANCELLED, viewModel.state.selectedFilter)
    }

    @Test
    fun `selectFilter null muestra todos los pedidos`() = runTest {
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadOrders()
        viewModel.selectFilter(ClientOrderStatus.PENDING)
        assertEquals(1, viewModel.state.orders.size)

        viewModel.selectFilter(null)

        assertEquals(ClientOrdersStatus.Loaded, viewModel.state.status)
        assertEquals(2, viewModel.state.orders.size)
        assertNull(viewModel.state.selectedFilter)
    }

    @Test
    fun `loadOrders ordena por fecha descendente`() = runTest {
        val unorderedOrders = listOf(
            ClientOrder(
                id = "old", publicId = "PUB-OLD", shortCode = "OLD",
                businessName = "Tienda", status = ClientOrderStatus.DELIVERED,
                createdAt = "2025-01-01", promisedAt = null, total = 50.0, itemCount = 1
            ),
            ClientOrder(
                id = "new", publicId = "PUB-NEW", shortCode = "NEW",
                businessName = "Tienda", status = ClientOrderStatus.PENDING,
                createdAt = "2025-06-15", promisedAt = null, total = 300.0, itemCount = 2
            ),
            ClientOrder(
                id = "mid", publicId = "PUB-MID", shortCode = "MID",
                businessName = "Tienda", status = ClientOrderStatus.CONFIRMED,
                createdAt = "2025-03-10", promisedAt = null, total = 100.0, itemCount = 1
            )
        )
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(Result.success(unorderedOrders)),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadOrders()

        assertEquals(ClientOrdersStatus.Loaded, viewModel.state.status)
        assertEquals(3, viewModel.state.orders.size)
        assertEquals("new", viewModel.state.orders[0].id)
        assertEquals("mid", viewModel.state.orders[1].id)
        assertEquals("old", viewModel.state.orders[2].id)
    }

    @Test
    fun `clearError limpia el mensaje de error`() = runTest {
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(Result.failure(RuntimeException("Fallo"))),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadOrders()
        assertNotNull(viewModel.state.errorMessage)

        viewModel.clearError()

        assertNull(viewModel.state.errorMessage)
    }
}

private val deliveredOrderForRepeat = ClientOrderDetail(
    id = "ord-delivered", publicId = "PUB-DEL", shortCode = "DEL01",
    businessName = "Tienda", status = ClientOrderStatus.DELIVERED,
    createdAt = "2025-01-01", promisedAt = null, total = 150.0, itemCount = 2,
    items = listOf(
        ClientOrderItem(id = "item-1", name = "Producto A", quantity = 2, unitPrice = 50.0, subtotal = 100.0),
        ClientOrderItem(id = "item-2", name = "Producto B", quantity = 1, unitPrice = 50.0, subtotal = 50.0)
    ),
    address = null
)

class ClientOrdersViewModelRepeatOrderTest {

    @BeforeTest
    fun setUp() {
        ClientCartStore.clear()
    }

    @Test
    fun `repeatOrderFromDetail exitoso carga items al carrito`() = runTest {
        val repeatResult = RepeatOrderResult(
            addedItems = listOf(
                ClientOrderItem(id = "item-1", name = "Producto A", quantity = 2, unitPrice = 50.0, subtotal = 100.0),
                ClientOrderItem(id = "item-2", name = "Producto B", quantity = 1, unitPrice = 50.0, subtotal = 50.0)
            ),
            skippedItems = emptyList()
        )
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            repeatOrder = FakeRepeatOrder(Result.success(repeatResult)),
            loggerFactory = testLoggerFactory
        )

        viewModel.repeatOrderFromDetail(deliveredOrderForRepeat)

        assertFalse(viewModel.state.repeatOrderLoading)
        assertNotNull(viewModel.state.repeatOrderResult)
        assertEquals(2, viewModel.state.repeatOrderResult?.addedItems?.size)
        assertTrue(viewModel.state.repeatOrderResult?.skippedItems?.isEmpty() == true)
        assertEquals(2, ClientCartStore.items.value.size)
        assertEquals(2, ClientCartStore.items.value["item-1"]?.quantity)
        assertEquals(1, ClientCartStore.items.value["item-2"]?.quantity)
    }

    @Test
    fun `repeatOrderFromDetail con items omitidos refleja resultado parcial`() = runTest {
        val repeatResult = RepeatOrderResult(
            addedItems = listOf(
                ClientOrderItem(id = "item-1", name = "Producto A", quantity = 2, unitPrice = 50.0, subtotal = 100.0)
            ),
            skippedItems = listOf(
                ClientOrderItem(id = null, name = "Producto sin ID", quantity = 1, unitPrice = 10.0, subtotal = 10.0)
            )
        )
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            repeatOrder = FakeRepeatOrder(Result.success(repeatResult)),
            loggerFactory = testLoggerFactory
        )

        viewModel.repeatOrderFromDetail(deliveredOrderForRepeat)

        assertFalse(viewModel.state.repeatOrderLoading)
        assertEquals(1, viewModel.state.repeatOrderResult?.addedItems?.size)
        assertEquals(1, viewModel.state.repeatOrderResult?.skippedItems?.size)
        assertEquals(1, ClientCartStore.items.value.size)
    }

    @Test
    fun `repeatOrderFromDetail con todos los items omitidos no modifica el carrito`() = runTest {
        val repeatResult = RepeatOrderResult(
            addedItems = emptyList(),
            skippedItems = listOf(
                ClientOrderItem(id = null, name = "Sin ID", quantity = 1, unitPrice = 10.0, subtotal = 10.0)
            )
        )
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            repeatOrder = FakeRepeatOrder(Result.success(repeatResult)),
            loggerFactory = testLoggerFactory
        )

        viewModel.repeatOrderFromDetail(deliveredOrderForRepeat)

        assertFalse(viewModel.state.repeatOrderLoading)
        assertTrue(viewModel.state.repeatOrderResult?.addedItems?.isEmpty() == true)
        assertTrue(ClientCartStore.items.value.isEmpty())
    }

    @Test
    fun `repeatOrderFromDetail con error actualiza repeatOrderError`() = runTest {
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            repeatOrder = FakeRepeatOrder(Result.failure(RuntimeException("Error de red"))),
            loggerFactory = testLoggerFactory
        )

        viewModel.repeatOrderFromDetail(deliveredOrderForRepeat)

        assertFalse(viewModel.state.repeatOrderLoading)
        assertNull(viewModel.state.repeatOrderResult)
        assertNotNull(viewModel.state.repeatOrderError)
        assertTrue(ClientCartStore.items.value.isEmpty())
    }

    @Test
    fun `clearRepeatOrderResult limpia resultado y error`() = runTest {
        val repeatResult = RepeatOrderResult(
            addedItems = listOf(
                ClientOrderItem(id = "item-1", name = "Producto A", quantity = 1, unitPrice = 50.0, subtotal = 50.0)
            ),
            skippedItems = emptyList()
        )
        val viewModel = ClientOrdersViewModel(
            getClientOrders = FakeGetClientOrders(),
            getClientOrderDetail = FakeGetClientOrderDetail(),
            repeatOrder = FakeRepeatOrder(Result.success(repeatResult)),
            loggerFactory = testLoggerFactory
        )

        viewModel.repeatOrderFromDetail(deliveredOrderForRepeat)
        assertNotNull(viewModel.state.repeatOrderResult)

        viewModel.clearRepeatOrderResult()

        assertNull(viewModel.state.repeatOrderResult)
        assertNull(viewModel.state.repeatOrderError)
    }
}
