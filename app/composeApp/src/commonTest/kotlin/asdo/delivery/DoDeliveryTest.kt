package asdo.delivery

import ext.delivery.*
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

private class FakeDeliveryOrdersService(
    private val activeResult: Result<List<DeliveryOrderDTO>> = Result.success(sampleOrderDTOs),
    private val summaryResult: Result<DeliveryOrdersSummaryDTO> = Result.success(sampleSummaryDTO),
    private val availableResult: Result<List<DeliveryOrderDTO>> = Result.success(emptyList())
) : CommDeliveryOrdersService {
    override suspend fun fetchActiveOrders() = activeResult
    override suspend fun fetchSummary(date: LocalDate) = summaryResult
    override suspend fun fetchAvailableOrders() = availableResult
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
