package asdo.client

import ar.com.intrale.shared.client.ClientOrderDTO
import ar.com.intrale.shared.client.ClientOrderDetailDTO
import ar.com.intrale.shared.client.ClientOrderItemDTO
import ar.com.intrale.shared.client.CreateClientOrderRequestDTO
import ar.com.intrale.shared.client.CreateClientOrderResponseDTO
import ar.com.intrale.shared.client.ProductAvailabilityItemDTO
import ar.com.intrale.shared.client.SkipReason
import ext.client.ClientExceptionResponse
import ext.client.CommClientOrdersService
import ext.client.CommClientProductsAvailabilityService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val sampleOrderDTOs = listOf(
    ClientOrderDTO(
        id = "ord-1", publicId = "PUB-001", shortCode = "SC01",
        businessName = "Tienda", status = "PENDING",
        createdAt = "2025-01-01", total = 150.0, itemCount = 3
    ),
    ClientOrderDTO(
        id = "ord-2", publicId = "PUB-002", shortCode = "SC02",
        businessName = "Farmacia", status = "DELIVERED",
        createdAt = "2025-01-02", promisedAt = "2025-01-03",
        total = 200.0, itemCount = 1
    )
)

private val sampleDetailDTO = ClientOrderDetailDTO(
    id = "ord-1", publicId = "PUB-001", shortCode = "SC01",
    businessName = "Tienda", status = "PENDING",
    createdAt = "2025-01-01", total = 150.0, itemCount = 2,
    items = listOf(
        ClientOrderItemDTO(id = "item-1", name = "Producto A", quantity = 2, unitPrice = 50.0, subtotal = 100.0),
        ClientOrderItemDTO(id = "item-2", name = "Producto B", quantity = 1, unitPrice = 50.0, subtotal = 50.0)
    ),
    address = null
)

private val sampleCreateResponse = CreateClientOrderResponseDTO(
    orderId = "ord-new-1",
    shortCode = "AB23CD",
    status = "PENDING"
)

private class FakeClientOrdersService(
    private val listResult: Result<List<ClientOrderDTO>> = Result.success(sampleOrderDTOs),
    private val detailResult: Result<ClientOrderDetailDTO> = Result.success(sampleDetailDTO),
    private val createResult: Result<CreateClientOrderResponseDTO> = Result.success(sampleCreateResponse)
) : CommClientOrdersService {
    override suspend fun listOrders(): Result<List<ClientOrderDTO>> = listResult
    override suspend fun fetchOrderDetail(orderId: String): Result<ClientOrderDetailDTO> = detailResult
    override suspend fun createOrder(request: CreateClientOrderRequestDTO): Result<CreateClientOrderResponseDTO> = createResult
}

private val sampleDeliveredOrder = ClientOrderDetail(
    id = "ord-1",
    publicId = "PUB-001",
    shortCode = "SC01",
    businessName = "Tienda",
    status = ClientOrderStatus.DELIVERED,
    createdAt = "2025-01-01",
    promisedAt = null,
    total = 160.0,
    itemCount = 3,
    items = listOf(
        ClientOrderItem(id = "item-1", name = "Producto A", quantity = 2, unitPrice = 50.0, subtotal = 100.0),
        ClientOrderItem(id = "item-2", name = "Producto B", quantity = 1, unitPrice = 50.0, subtotal = 50.0),
        ClientOrderItem(id = null, name = "Producto sin ID", quantity = 1, unitPrice = 10.0, subtotal = 10.0)
    ),
    address = null
)

// region DoGetClientOrders

class DoGetClientOrdersTest {

    @Test
    fun `obtener pedidos exitoso retorna lista de pedidos mapeados`() = runTest {
        val sut = DoGetClientOrders(FakeClientOrdersService())

        val result = sut.execute()

        assertTrue(result.isSuccess)
        val orders = result.getOrThrow()
        assertEquals(2, orders.size)
        assertEquals("ord-1", orders[0].id)
        assertEquals("PUB-001", orders[0].publicId)
        assertEquals(ClientOrderStatus.PENDING, orders[0].status)
        assertEquals(150.0, orders[0].total)
    }

    @Test
    fun `obtener pedidos con lista vacia retorna lista vacia`() = runTest {
        val sut = DoGetClientOrders(
            FakeClientOrdersService(listResult = Result.success(emptyList()))
        )

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow().isEmpty())
    }

    @Test
    fun `obtener pedidos fallido retorna ClientExceptionResponse`() = runTest {
        val sut = DoGetClientOrders(
            FakeClientOrdersService(listResult = Result.failure(RuntimeException("Error de red")))
        )

        val result = sut.execute()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }
}

// endregion

// region DoGetClientOrderDetail

class DoGetClientOrderDetailTest {

    @Test
    fun `obtener detalle exitoso retorna pedido con items mapeados`() = runTest {
        val sut = DoGetClientOrderDetail(FakeClientOrdersService())

        val result = sut.execute("ord-1")

        assertTrue(result.isSuccess)
        val detail = result.getOrThrow()
        assertEquals("ord-1", detail.id)
        assertEquals("Tienda", detail.businessName)
        assertEquals(2, detail.items.size)
        assertEquals("Producto A", detail.items[0].name)
        assertEquals(2, detail.items[0].quantity)
        assertEquals(50.0, detail.items[0].unitPrice)
        assertEquals(100.0, detail.items[0].subtotal)
    }

    @Test
    fun `obtener detalle fallido retorna ClientExceptionResponse`() = runTest {
        val sut = DoGetClientOrderDetail(
            FakeClientOrdersService(detailResult = Result.failure(RuntimeException("Error de red")))
        )

        val result = sut.execute("ord-1")

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }
}

// endregion

// region DoRepeatOrder

private class FakeAvailabilityService(
    private val availabilityResult: Result<List<ProductAvailabilityItemDTO>> = Result.success(emptyList())
) : CommClientProductsAvailabilityService {
    override suspend fun checkAvailability(productIds: List<String>): Result<List<ProductAvailabilityItemDTO>> =
        availabilityResult
}

/** Helper para crear un servicio que marca todos los productos como disponibles */
private fun allAvailableService(productIds: List<String>) = FakeAvailabilityService(
    availabilityResult = Result.success(
        productIds.map { ProductAvailabilityItemDTO(productId = it, available = true) }
    )
)

class DoRepeatOrderTest {

    @Test
    fun `repetir pedido con items con ID todos disponibles agrega todos al resultado`() = runTest {
        val orderWithAllIds = sampleDeliveredOrder.copy(
            items = listOf(
                ClientOrderItem(id = "item-1", name = "Producto A", quantity = 2, unitPrice = 50.0, subtotal = 100.0),
                ClientOrderItem(id = "item-2", name = "Producto B", quantity = 1, unitPrice = 50.0, subtotal = 50.0)
            )
        )
        val sut = DoRepeatOrder(allAvailableService(listOf("item-1", "item-2")))

        val result = sut.execute(orderWithAllIds)

        assertTrue(result.isSuccess)
        val repeatResult = result.getOrThrow()
        assertEquals(2, repeatResult.addedItems.size)
        assertTrue(repeatResult.skippedItems.isEmpty())
        assertEquals("item-1", repeatResult.addedItems[0].id)
        assertEquals("item-2", repeatResult.addedItems[1].id)
    }

    @Test
    fun `repetir pedido omite items sin ID con motivo UNKNOWN_PRODUCT`() = runTest {
        val sut = DoRepeatOrder(allAvailableService(listOf("item-1", "item-2")))

        val result = sut.execute(sampleDeliveredOrder)

        assertTrue(result.isSuccess)
        val repeatResult = result.getOrThrow()
        assertEquals(2, repeatResult.addedItems.size)
        assertEquals(1, repeatResult.skippedItems.size)
        assertEquals("Producto sin ID", repeatResult.skippedItems[0].item.name)
        assertEquals(SkipReason.UNKNOWN_PRODUCT, repeatResult.skippedItems[0].reason)
    }

    @Test
    fun `repetir pedido con todos los items sin ID retorna lista vacia de agregados`() = runTest {
        val orderWithNoIds = sampleDeliveredOrder.copy(
            items = listOf(
                ClientOrderItem(id = null, name = "Sin ID 1", quantity = 1, unitPrice = 10.0, subtotal = 10.0),
                ClientOrderItem(id = null, name = "Sin ID 2", quantity = 2, unitPrice = 20.0, subtotal = 40.0)
            )
        )
        val sut = DoRepeatOrder(FakeAvailabilityService())

        val result = sut.execute(orderWithNoIds)

        assertTrue(result.isSuccess)
        val repeatResult = result.getOrThrow()
        assertTrue(repeatResult.addedItems.isEmpty())
        assertEquals(2, repeatResult.skippedItems.size)
    }

    @Test
    fun `repetir pedido vacio retorna listas vacias`() = runTest {
        val emptyOrder = sampleDeliveredOrder.copy(items = emptyList())
        val sut = DoRepeatOrder(FakeAvailabilityService())

        val result = sut.execute(emptyOrder)

        assertTrue(result.isSuccess)
        val repeatResult = result.getOrThrow()
        assertTrue(repeatResult.addedItems.isEmpty())
        assertTrue(repeatResult.skippedItems.isEmpty())
    }

    @Test
    fun `repetir pedido con producto no disponible lo marca como skipped con motivo`() = runTest {
        val order = sampleDeliveredOrder.copy(
            items = listOf(
                ClientOrderItem(id = "item-1", name = "Producto A", quantity = 2, unitPrice = 50.0, subtotal = 100.0),
                ClientOrderItem(id = "item-2", name = "Producto B", quantity = 1, unitPrice = 50.0, subtotal = 50.0)
            )
        )
        val service = FakeAvailabilityService(
            availabilityResult = Result.success(listOf(
                ProductAvailabilityItemDTO(productId = "item-1", available = true),
                ProductAvailabilityItemDTO(productId = "item-2", available = false, reason = SkipReason.OUT_OF_STOCK)
            ))
        )
        val sut = DoRepeatOrder(service)

        val result = sut.execute(order)

        assertTrue(result.isSuccess)
        val repeatResult = result.getOrThrow()
        assertEquals(1, repeatResult.addedItems.size)
        assertEquals("item-1", repeatResult.addedItems[0].id)
        assertEquals(1, repeatResult.skippedItems.size)
        assertEquals("item-2", repeatResult.skippedItems[0].item.id)
        assertEquals(SkipReason.OUT_OF_STOCK, repeatResult.skippedItems[0].reason)
    }

    @Test
    fun `repetir pedido con producto descontinuado lo marca como DISCONTINUED`() = runTest {
        val order = sampleDeliveredOrder.copy(
            items = listOf(
                ClientOrderItem(id = "item-1", name = "Producto viejo", quantity = 1, unitPrice = 100.0, subtotal = 100.0)
            )
        )
        val service = FakeAvailabilityService(
            availabilityResult = Result.success(listOf(
                ProductAvailabilityItemDTO(productId = "item-1", available = false, reason = SkipReason.DISCONTINUED)
            ))
        )
        val sut = DoRepeatOrder(service)

        val result = sut.execute(order)

        assertTrue(result.isSuccess)
        val repeatResult = result.getOrThrow()
        assertTrue(repeatResult.addedItems.isEmpty())
        assertEquals(1, repeatResult.skippedItems.size)
        assertEquals(SkipReason.DISCONTINUED, repeatResult.skippedItems[0].reason)
    }

    @Test
    fun `repetir pedido con fallo en servicio de disponibilidad agrega todos los items con ID`() = runTest {
        val order = sampleDeliveredOrder.copy(
            items = listOf(
                ClientOrderItem(id = "item-1", name = "Producto A", quantity = 2, unitPrice = 50.0, subtotal = 100.0),
                ClientOrderItem(id = "item-2", name = "Producto B", quantity = 1, unitPrice = 50.0, subtotal = 50.0)
            )
        )
        val service = FakeAvailabilityService(
            availabilityResult = Result.failure(RuntimeException("Error de red"))
        )
        val sut = DoRepeatOrder(service)

        val result = sut.execute(order)

        assertTrue(result.isSuccess)
        val repeatResult = result.getOrThrow()
        assertEquals(2, repeatResult.addedItems.size)
        assertTrue(repeatResult.skippedItems.isEmpty())
    }

    @Test
    fun `repetir pedido con mix de items sin ID y no disponibles`() = runTest {
        val order = sampleDeliveredOrder.copy(
            items = listOf(
                ClientOrderItem(id = "item-1", name = "Disponible", quantity = 1, unitPrice = 50.0, subtotal = 50.0),
                ClientOrderItem(id = null, name = "Sin ID", quantity = 1, unitPrice = 10.0, subtotal = 10.0),
                ClientOrderItem(id = "item-3", name = "Agotado", quantity = 1, unitPrice = 30.0, subtotal = 30.0)
            )
        )
        val service = FakeAvailabilityService(
            availabilityResult = Result.success(listOf(
                ProductAvailabilityItemDTO(productId = "item-1", available = true),
                ProductAvailabilityItemDTO(productId = "item-3", available = false, reason = SkipReason.UNAVAILABLE)
            ))
        )
        val sut = DoRepeatOrder(service)

        val result = sut.execute(order)

        assertTrue(result.isSuccess)
        val repeatResult = result.getOrThrow()
        assertEquals(1, repeatResult.addedItems.size)
        assertEquals("item-1", repeatResult.addedItems[0].id)
        assertEquals(2, repeatResult.skippedItems.size)
        // Item sin ID
        val noIdSkipped = repeatResult.skippedItems.first { it.item.name == "Sin ID" }
        assertEquals(SkipReason.UNKNOWN_PRODUCT, noIdSkipped.reason)
        // Item agotado
        val unavailableSkipped = repeatResult.skippedItems.first { it.item.name == "Agotado" }
        assertEquals(SkipReason.UNAVAILABLE, unavailableSkipped.reason)
    }
}

// endregion

// region DoCreateClientOrder

class DoCreateClientOrderTest {

    private val sampleParams = CreateClientOrderParams(
        items = listOf(
            CreateClientOrderItem(
                productId = "prod-1", productName = "Producto A",
                quantity = 2, unitPrice = 50.0
            ),
            CreateClientOrderItem(
                productId = "prod-2", productName = "Producto B",
                quantity = 1, unitPrice = 30.0
            )
        ),
        addressId = "addr-1",
        paymentMethodId = "pm-1",
        notes = "Sin cebolla"
    )

    @Test
    fun `crear pedido exitoso retorna orderId y shortCode`() = runTest {
        val sut = DoCreateClientOrder(FakeClientOrdersService())

        val result = sut.execute(sampleParams)

        assertTrue(result.isSuccess)
        val createResult = result.getOrThrow()
        assertEquals("ord-new-1", createResult.orderId)
        assertEquals("AB23CD", createResult.shortCode)
        assertEquals("PENDING", createResult.status)
    }

    @Test
    fun `crear pedido fallido retorna ClientExceptionResponse`() = runTest {
        val sut = DoCreateClientOrder(
            FakeClientOrdersService(
                createResult = Result.failure(RuntimeException("Error de red"))
            )
        )

        val result = sut.execute(sampleParams)

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }

    @Test
    fun `crear pedido sin notas envia null como notas`() = runTest {
        val paramsWithoutNotes = sampleParams.copy(notes = null)
        val sut = DoCreateClientOrder(FakeClientOrdersService())

        val result = sut.execute(paramsWithoutNotes)

        assertTrue(result.isSuccess)
    }
}

// endregion
