package ui.sc.business.zones

import ar.com.intrale.shared.business.DeliveryZoneDTO
import ar.com.intrale.shared.business.GeoPointDTO
import asdo.business.delivery.DoListDeliveryZonesException
import asdo.business.delivery.ListDeliveryZonesOutput
import asdo.business.delivery.ToDoListDeliveryZones
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private fun zone(id: String, cost: Long, name: String = id) = DeliveryZoneDTO(
    id = id,
    name = name,
    points = listOf(
        GeoPointDTO(-34.6, -58.3),
        GeoPointDTO(-34.6, -58.4),
        GeoPointDTO(-34.7, -58.4)
    ),
    costCents = cost
)

private class FakeListZones(
    private val result: Result<ListDeliveryZonesOutput>
) : ToDoListDeliveryZones {
    var calls = 0
        private set

    override suspend fun execute(businessId: String): Result<ListDeliveryZonesOutput> {
        calls += 1
        return result
    }
}

class DeliveryZonesViewModelTest {

    @Test
    fun `loadZones exitoso ordena por costo ascendente`() = runTest {
        val zones = listOf(
            zone("z-1", 1_000_00L, "Caro"),
            zone("z-2", 500_00L, "Barato"),
            zone("z-3", 750_00L, "Medio")
        )
        val vm = DeliveryZonesViewModel(
            toDoListZones = FakeListZones(Result.success(ListDeliveryZonesOutput(zones, fromCache = false))),
            loggerFactory = testLoggerFactory
        )

        vm.loadZones("biz-1")

        assertEquals(DeliveryZonesStatus.Loaded, vm.state.status)
        assertEquals(listOf("z-2", "z-3", "z-1"), vm.state.zones.map { it.id })
    }

    @Test
    fun `loadZones empate de costo desempata por nombre alfabetico`() = runTest {
        val zones = listOf(
            zone("z-1", 500_00L, "Zeta"),
            zone("z-2", 500_00L, "Alfa")
        )
        val vm = DeliveryZonesViewModel(
            toDoListZones = FakeListZones(Result.success(ListDeliveryZonesOutput(zones, fromCache = false))),
            loggerFactory = testLoggerFactory
        )

        vm.loadZones("biz-1")

        assertEquals(listOf("z-2", "z-1"), vm.state.zones.map { it.id })
    }

    @Test
    fun `loadZones lista vacia entra en estado Empty`() = runTest {
        val vm = DeliveryZonesViewModel(
            toDoListZones = FakeListZones(Result.success(ListDeliveryZonesOutput(emptyList(), fromCache = false))),
            loggerFactory = testLoggerFactory
        )

        vm.loadZones("biz-1")

        assertEquals(DeliveryZonesStatus.Empty, vm.state.status)
        assertTrue(vm.state.zones.isEmpty())
    }

    @Test
    fun `loadZones desde cache marca LoadedFromCache`() = runTest {
        val zones = listOf(zone("z-1", 100_00L))
        val vm = DeliveryZonesViewModel(
            toDoListZones = FakeListZones(Result.success(ListDeliveryZonesOutput(zones, fromCache = true))),
            loggerFactory = testLoggerFactory
        )

        vm.loadZones("biz-1")

        val status = vm.state.status
        assertTrue(status is DeliveryZonesStatus.LoadedFromCache, "esperaba LoadedFromCache, fue $status")
        assertTrue((status as DeliveryZonesStatus.LoadedFromCache).isOffline)
    }

    @Test
    fun `loadZones con businessId nulo entra en MissingBusiness`() = runTest {
        val vm = DeliveryZonesViewModel(
            toDoListZones = FakeListZones(Result.success(ListDeliveryZonesOutput(emptyList(), fromCache = false))),
            loggerFactory = testLoggerFactory
        )

        vm.loadZones(null)

        assertEquals(DeliveryZonesStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `loadZones con businessId vacio entra en MissingBusiness`() = runTest {
        val vm = DeliveryZonesViewModel(
            toDoListZones = FakeListZones(Result.success(ListDeliveryZonesOutput(emptyList(), fromCache = false))),
            loggerFactory = testLoggerFactory
        )

        vm.loadZones("   ")

        assertEquals(DeliveryZonesStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `loadZones con failure setea estado Error y mensaje`() = runTest {
        val vm = DeliveryZonesViewModel(
            toDoListZones = FakeListZones(
                Result.failure(DoListDeliveryZonesException(message = "boom", httpStatus = 500))
            ),
            loggerFactory = testLoggerFactory
        )

        vm.loadZones("biz-1")

        assertEquals(DeliveryZonesStatus.Error, vm.state.status)
        assertNotNull(vm.state.errorMessage)
        assertTrue(vm.state.errorMessage!!.contains("boom"))
    }

    @Test
    fun `selectZone actualiza selectedZoneId`() = runTest {
        val vm = DeliveryZonesViewModel(
            toDoListZones = FakeListZones(Result.success(ListDeliveryZonesOutput(emptyList(), fromCache = false))),
            loggerFactory = testLoggerFactory
        )

        vm.selectZone("z-42")

        assertEquals("z-42", vm.state.selectedZoneId)
    }

    @Test
    fun `clearError vuelve a Idle y limpia mensaje`() = runTest {
        val vm = DeliveryZonesViewModel(
            toDoListZones = FakeListZones(
                Result.failure(DoListDeliveryZonesException(message = "boom"))
            ),
            loggerFactory = testLoggerFactory
        )

        vm.loadZones("biz-1")
        vm.clearError()

        assertEquals(DeliveryZonesStatus.Idle, vm.state.status)
        assertNull(vm.state.errorMessage)
    }
}
