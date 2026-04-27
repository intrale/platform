package asdo.business.delivery

import ar.com.intrale.shared.business.DeliveryZoneDTO
import ar.com.intrale.shared.business.GeoPointDTO
import ext.business.CommDeliveryZonesCache
import ext.business.CommDeliveryZonesService
import ext.business.InMemoryDeliveryZonesCache
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private fun zone(
    id: String,
    name: String = id,
    cost: Long = 100_00L,
    minutes: Int? = null
) = DeliveryZoneDTO(
    id = id,
    name = name,
    points = listOf(
        GeoPointDTO(-34.6, -58.3),
        GeoPointDTO(-34.6, -58.4),
        GeoPointDTO(-34.7, -58.4)
    ),
    costCents = cost,
    estimatedMinutes = minutes
)

private val sampleZones = listOf(
    zone(id = "z-1", name = "Centro", cost = 1_000_00L, minutes = 30),
    zone(id = "z-2", name = "Microcentro", cost = 500_00L, minutes = 20),
    zone(id = "z-3", name = "Caballito", cost = 1_500_00L)
)

// ── Fakes ────────────────────────────────────────────────────────────────────

private class FakeService(
    private val result: Result<List<DeliveryZoneDTO>>
) : CommDeliveryZonesService {
    var calls = 0
        private set
    var lastBusinessId: String? = null
        private set

    override suspend fun list(businessId: String): Result<List<DeliveryZoneDTO>> {
        calls += 1
        lastBusinessId = businessId
        return result
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

class DoListDeliveryZonesTest {

    @Test
    fun `execute exitoso retorna zonas frescas con fromCache=false y refresca cache`() = runTest {
        val service = FakeService(Result.success(sampleZones))
        val cache = InMemoryDeliveryZonesCache()
        val useCase = DoListDeliveryZones(service, cache, testLoggerFactory)

        val result = useCase.execute("biz-1")

        assertTrue(result.isSuccess)
        val output = result.getOrThrow()
        assertEquals(3, output.zones.size)
        assertFalse(output.fromCache)
        // El cache fue actualizado.
        assertEquals(sampleZones, cache.read("biz-1"))
        assertEquals("biz-1", service.lastBusinessId)
    }

    @Test
    fun `execute con backend caido y cache poblado retorna fromCache=true`() = runTest {
        val service = FakeService(Result.failure(RuntimeException("network down")))
        val cache = InMemoryDeliveryZonesCache().apply {
            write("biz-1", sampleZones)
        }
        val useCase = DoListDeliveryZones(service, cache, testLoggerFactory)

        val result = useCase.execute("biz-1")

        assertTrue(result.isSuccess)
        val output = result.getOrThrow()
        assertEquals(3, output.zones.size)
        assertTrue(output.fromCache)
    }

    @Test
    fun `execute con backend caido y cache vacio retorna failure de dominio`() = runTest {
        val service = FakeService(Result.failure(RuntimeException("network down")))
        val cache = InMemoryDeliveryZonesCache()
        val useCase = DoListDeliveryZones(service, cache, testLoggerFactory)

        val result = useCase.execute("biz-1")

        assertTrue(result.isFailure)
        val error = result.exceptionOrNull()
        assertTrue(error is DoListDeliveryZonesException, "esperaba DoListDeliveryZonesException, fue ${error?.let { it::class.simpleName }}")
    }

    @Test
    fun `execute con backend exitoso lista vacia retorna ok con fromCache=false`() = runTest {
        val service = FakeService(Result.success(emptyList()))
        val cache = InMemoryDeliveryZonesCache()
        val useCase = DoListDeliveryZones(service, cache, testLoggerFactory)

        val result = useCase.execute("biz-1")

        assertTrue(result.isSuccess)
        val output = result.getOrThrow()
        assertTrue(output.zones.isEmpty())
        assertFalse(output.fromCache)
    }

    @Test
    fun `execute multi-tenant cache por businessId`() = runTest {
        val cache = InMemoryDeliveryZonesCache()
        val zonesA = listOf(zone(id = "a"))
        val zonesB = listOf(zone(id = "b1"), zone(id = "b2"))

        val service = FakeService(Result.success(zonesA))
        DoListDeliveryZones(service, cache, testLoggerFactory).execute("biz-A")

        val serviceB = FakeService(Result.success(zonesB))
        DoListDeliveryZones(serviceB, cache, testLoggerFactory).execute("biz-B")

        assertEquals(zonesA, cache.read("biz-A"))
        assertEquals(zonesB, cache.read("biz-B"))
    }

    @Test
    fun `execute clear borra cache de todos los negocios`() = runTest {
        val cache = InMemoryDeliveryZonesCache()
        cache.write("biz-A", sampleZones)
        cache.write("biz-B", sampleZones)

        cache.clear()

        assertTrue(cache.read("biz-A").isEmpty())
        assertTrue(cache.read("biz-B").isEmpty())
    }
}
