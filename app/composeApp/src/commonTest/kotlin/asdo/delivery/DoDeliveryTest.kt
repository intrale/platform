package asdo.delivery

import ar.com.intrale.shared.delivery.*
import ext.delivery.CommDeliveryProfileService
import ext.delivery.CommDeliveryOrdersService
import ext.delivery.CommDeliveryAvailabilityService
import ext.delivery.CommDeliveryStateService
import ext.delivery.DeliveryExceptionResponse
import ext.delivery.toDeliveryException
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeDeliveryProfileService(
    private val fetchResult: Result<DeliveryProfileResponse> = Result.success(
        DeliveryProfileResponse(
            profile = DeliveryProfileDTO(fullName = "Driver Test", email = "driver@test.com"),
            zones = listOf(DeliveryZoneDTO(id = "z1", name = "Zona Norte"))
        )
    ),
    private val updateResult: Result<DeliveryProfileResponse> = Result.success(
        DeliveryProfileResponse(
            profile = DeliveryProfileDTO(fullName = "Driver Updated", email = "driver@test.com"),
            zones = emptyList()
        )
    )
) : CommDeliveryProfileService {
    override suspend fun fetchProfile() = fetchResult
    override suspend fun updateProfile(profile: DeliveryProfileDTO) = updateResult
}

private class FakeDeliveryAvailabilityService(
    private val fetchResult: Result<DeliveryAvailabilityDTO> = Result.success(
        DeliveryAvailabilityDTO(timezone = "America/Argentina/Buenos_Aires", slots = emptyList())
    ),
    private val updateResult: Result<DeliveryAvailabilityDTO> = Result.success(
        DeliveryAvailabilityDTO(timezone = "America/Argentina/Buenos_Aires", slots = emptyList())
    )
) : CommDeliveryAvailabilityService {
    override suspend fun fetchAvailability() = fetchResult
    override suspend fun updateAvailability(config: DeliveryAvailabilityDTO) = updateResult
}

// region DoGetDeliveryProfile

class DoGetDeliveryProfileTest {

    @Test
    fun `obtener perfil exitoso retorna datos del repartidor`() = runTest {
        val sut = DoGetDeliveryProfile(FakeDeliveryProfileService())

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertEquals("Driver Test", result.getOrThrow().profile.fullName)
        assertEquals(1, result.getOrThrow().zones.size)
    }

    @Test
    fun `obtener perfil fallido retorna DeliveryExceptionResponse`() = runTest {
        val sut = DoGetDeliveryProfile(FakeDeliveryProfileService(fetchResult = Result.failure(RuntimeException("Error"))))

        val result = sut.execute()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }
}

// endregion

// region DoUpdateDeliveryProfile

class DoUpdateDeliveryProfileTest {

    @Test
    fun `actualizar perfil exitoso retorna datos actualizados`() = runTest {
        val sut = DoUpdateDeliveryProfile(FakeDeliveryProfileService())

        val result = sut.execute(DeliveryProfile(fullName = "Updated", email = "driver@test.com"))

        assertTrue(result.isSuccess)
        assertEquals("Driver Updated", result.getOrThrow().profile.fullName)
    }

    @Test
    fun `actualizar perfil fallido retorna DeliveryExceptionResponse`() = runTest {
        val sut = DoUpdateDeliveryProfile(
            FakeDeliveryProfileService(updateResult = Result.failure(RuntimeException("Error")))
        )

        val result = sut.execute(DeliveryProfile())

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }
}

// endregion

// region DoGetDeliveryAvailability

class DoGetDeliveryAvailabilityTest {

    @Test
    fun `obtener disponibilidad exitoso retorna config`() = runTest {
        val sut = DoGetDeliveryAvailability(FakeDeliveryAvailabilityService())

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertEquals("America/Argentina/Buenos_Aires", result.getOrThrow().timezone)
    }

    @Test
    fun `obtener disponibilidad fallido retorna DeliveryExceptionResponse`() = runTest {
        val sut = DoGetDeliveryAvailability(
            FakeDeliveryAvailabilityService(fetchResult = Result.failure(RuntimeException("Error")))
        )

        val result = sut.execute()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }
}

// endregion

// region DoUpdateDeliveryAvailability

class DoUpdateDeliveryAvailabilityTest {

    @Test
    fun `actualizar disponibilidad exitoso retorna config`() = runTest {
        val sut = DoUpdateDeliveryAvailability(FakeDeliveryAvailabilityService())

        val result = sut.execute(DeliveryAvailabilityConfig(timezone = "UTC"))

        assertTrue(result.isSuccess)
    }

    @Test
    fun `actualizar disponibilidad fallido retorna DeliveryExceptionResponse`() = runTest {
        val sut = DoUpdateDeliveryAvailability(
            FakeDeliveryAvailabilityService(updateResult = Result.failure(RuntimeException("Error")))
        )

        val result = sut.execute(DeliveryAvailabilityConfig())

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }
}

// endregion DoUpdateDeliveryAvailability

// region DoGetActiveDeliveryOrders

private val sampleOrderDTOs = listOf(
    DeliveryOrderDTO(id = "o1", publicId = "PUB-1", businessName = "Pizzeria", neighborhood = "Centro", status = "pending", eta = "12:00"),
    DeliveryOrderDTO(id = "o2", publicId = "PUB-2", businessName = "Farmacia", neighborhood = "Norte", status = "inprogress", eta = "11:30"),
    DeliveryOrderDTO(id = "o3", shortCode = "SC3", businessName = "Panaderia", neighborhood = "Sur", status = "delivered", eta = "10:00"),
)

private val sampleSummaryDTO = DeliveryOrdersSummaryDTO(pending = 3, inProgress = 2, delivered = 5)

private val sampleOrderDetailDTO = DeliveryOrderDTO(
    id = "o1",
    publicId = "PUB-1",
    businessName = "Pizzeria",
    neighborhood = "Centro",
    status = "pending",
    eta = "12:00",
    distance = "2.5 km",
    address = "Av. Corrientes 1234",
    addressNotes = "Piso 3, Depto B",
    items = listOf(
        DeliveryOrderItemDTO(name = "Pizza Grande", quantity = 2, notes = "Sin cebolla"),
        DeliveryOrderItemDTO(name = "Empanadas", quantity = 6)
    ),
    notes = "Tocar timbre 3B",
    customerName = "Juan Pérez",
    customerPhone = "+5491112345678",
    createdAt = "2026-02-20T10:00:00Z",
    updatedAt = "2026-02-20T10:30:00Z"
)

private class FakeDeliveryOrdersService(
    private val activeResult: Result<List<DeliveryOrderDTO>> = Result.success(sampleOrderDTOs),
    private val summaryResult: Result<DeliveryOrdersSummaryDTO> = Result.success(sampleSummaryDTO),
    private val availableResult: Result<List<DeliveryOrderDTO>> = Result.success(emptyList()),
    private val historyResult: Result<List<DeliveryOrderDTO>> = Result.success(sampleOrderDTOs),
    private val updateStatusResult: Result<DeliveryOrderStatusUpdateResponse> = Result.success(
        DeliveryOrderStatusUpdateResponse(orderId = "o1", status = "inprogress")
    ),
    private val orderDetailResult: Result<DeliveryOrderDTO> = Result.success(sampleOrderDetailDTO)
) : CommDeliveryOrdersService {
    override suspend fun fetchActiveOrders() = activeResult
    override suspend fun fetchSummary(date: LocalDate) = summaryResult
    override suspend fun fetchAvailableOrders() = availableResult
    override suspend fun fetchHistoryOrders() = historyResult
    override suspend fun updateOrderStatus(orderId: String, newStatus: String, reason: String?) = updateStatusResult
    override suspend fun fetchOrderDetail(orderId: String) = orderDetailResult
    override suspend fun takeOrder(orderId: String): Result<DeliveryOrderStatusUpdateResponse> =
        Result.failure(NotImplementedError("takeOrder not implemented in fake"))
}

class DoGetActiveDeliveryOrdersTest {

    @Test
    fun `obtener pedidos activos exitoso mapea y filtra delivered`() = runTest {
        val sut = DoGetActiveDeliveryOrders(FakeDeliveryOrdersService())

        val result = sut.execute()

        assertTrue(result.isSuccess)
        val orders = result.getOrThrow()
        assertEquals(2, orders.size)
        assertTrue(orders.none { it.status == DeliveryOrderStatus.DELIVERED })
        assertEquals("PUB-1", orders[0].label)
        assertEquals(DeliveryOrderStatus.PENDING, orders[0].status)
        assertEquals(DeliveryOrderStatus.IN_PROGRESS, orders[1].status)
    }

    @Test
    fun `obtener pedidos activos fallido retorna DeliveryExceptionResponse`() = runTest {
        val sut = DoGetActiveDeliveryOrders(
            FakeDeliveryOrdersService(activeResult = Result.failure(RuntimeException("Error de red")))
        )

        val result = sut.execute()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }
}

// endregion DoGetActiveDeliveryOrders

// region DoGetDeliveryOrdersSummary

class DoGetDeliveryOrdersSummaryTest {

    @Test
    fun `obtener resumen exitoso mapea correctamente`() = runTest {
        val sut = DoGetDeliveryOrdersSummary(FakeDeliveryOrdersService())

        val result = sut.execute(LocalDate(2026, 2, 20))

        assertTrue(result.isSuccess)
        val summary = result.getOrThrow()
        assertEquals(3, summary.pending)
        assertEquals(2, summary.inProgress)
        assertEquals(5, summary.delivered)
    }

    @Test
    fun `obtener resumen fallido retorna DeliveryExceptionResponse`() = runTest {
        val sut = DoGetDeliveryOrdersSummary(
            FakeDeliveryOrdersService(summaryResult = Result.failure(RuntimeException("Error")))
        )

        val result = sut.execute(LocalDate(2026, 2, 20))

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }
}

// endregion DoGetDeliveryOrdersSummary

// region DoUpdateDeliveryOrderStatus

class DoUpdateDeliveryOrderStatusTest {

    @Test
    fun `actualizar estado exitoso retorna resultado mapeado`() = runTest {
        val sut = DoUpdateDeliveryOrderStatus(FakeDeliveryOrdersService())

        val result = sut.execute("o1", DeliveryOrderStatus.IN_PROGRESS)

        assertTrue(result.isSuccess)
        val updateResult = result.getOrThrow()
        assertEquals("o1", updateResult.orderId)
        assertEquals(DeliveryOrderStatus.IN_PROGRESS, updateResult.newStatus)
    }

    @Test
    fun `actualizar estado fallido retorna DeliveryExceptionResponse`() = runTest {
        val sut = DoUpdateDeliveryOrderStatus(
            FakeDeliveryOrdersService(updateStatusResult = Result.failure(RuntimeException("Error de red")))
        )

        val result = sut.execute("o1", DeliveryOrderStatus.DELIVERED)

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }
}

// endregion DoUpdateDeliveryOrderStatus

// region DoGetDeliveryOrderDetail

class DoGetDeliveryOrderDetailTest {

    @Test
    fun `obtener detalle de pedido exitoso retorna datos completos`() = runTest {
        val sut = DoGetDeliveryOrderDetail(FakeDeliveryOrdersService())

        val result = sut.execute("o1")

        assertTrue(result.isSuccess)
        val detail = result.getOrThrow()
        assertEquals("o1", detail.id)
        assertEquals("PUB-1", detail.label)
        assertEquals("Pizzeria", detail.businessName)
        assertEquals("Centro", detail.neighborhood)
        assertEquals(DeliveryOrderStatus.PENDING, detail.status)
        assertEquals("12:00", detail.eta)
        assertEquals("2.5 km", detail.distance)
        assertEquals("Av. Corrientes 1234", detail.address)
        assertEquals("Piso 3, Depto B", detail.addressNotes)
        assertEquals(2, detail.items.size)
        assertEquals("Pizza Grande", detail.items[0].name)
        assertEquals(2, detail.items[0].quantity)
        assertEquals("Sin cebolla", detail.items[0].notes)
        assertEquals("Empanadas", detail.items[1].name)
        assertEquals(6, detail.items[1].quantity)
        assertEquals("Tocar timbre 3B", detail.notes)
        assertEquals("Juan Pérez", detail.customerName)
        assertEquals("+5491112345678", detail.customerPhone)
    }

    @Test
    fun `obtener detalle de pedido fallido retorna DeliveryExceptionResponse`() = runTest {
        val sut = DoGetDeliveryOrderDetail(
            FakeDeliveryOrdersService(orderDetailResult = Result.failure(RuntimeException("Error de red")))
        )

        val result = sut.execute("o1")

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }
}

// endregion DoGetDeliveryOrderDetail

// region DoGetDeliveryOrderHistory

private val sampleHistoryDTOs = listOf(
    DeliveryOrderDTO(id = "h1", publicId = "BCX472", businessName = "Almacen Don Julio", neighborhood = "Palermo", status = "delivered", eta = "14:30", updatedAt = "2026-03-23T14:30:00Z"),
    DeliveryOrderDTO(id = "h2", publicId = "PQR789", businessName = "Farmacia Central", neighborhood = "Flores", status = "not_delivered", eta = "10:15", updatedAt = "2026-03-22T10:15:00Z"),
    DeliveryOrderDTO(id = "h3", publicId = "XYZ123", businessName = "Panaderia Sur", neighborhood = "Centro", status = "pending", eta = "09:00"),
)

class DoGetDeliveryOrderHistoryTest {

    @Test
    fun `obtener historial exitoso retorna solo pedidos finalizados ordenados`() = runTest {
        val sut = DoGetDeliveryOrderHistory(FakeDeliveryOrdersService(historyResult = Result.success(sampleHistoryDTOs)))

        val result = sut.execute()

        assertTrue(result.isSuccess)
        val orders = result.getOrThrow()
        assertEquals(2, orders.size)
        assertTrue(orders.all { it.status == DeliveryOrderStatus.DELIVERED || it.status == DeliveryOrderStatus.NOT_DELIVERED })
        assertEquals("BCX472", orders[0].label)
        assertEquals("PQR789", orders[1].label)
    }

    @Test
    fun `obtener historial fallido retorna DeliveryExceptionResponse`() = runTest {
        val sut = DoGetDeliveryOrderHistory(
            FakeDeliveryOrdersService(historyResult = Result.failure(RuntimeException("Error de red")))
        )

        val result = sut.execute()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }

    @Test
    fun `obtener historial vacio retorna lista vacia`() = runTest {
        val sut = DoGetDeliveryOrderHistory(FakeDeliveryOrdersService(historyResult = Result.success(emptyList())))

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertEquals(0, result.getOrThrow().size)
    }
}

// endregion DoGetDeliveryOrderHistory
