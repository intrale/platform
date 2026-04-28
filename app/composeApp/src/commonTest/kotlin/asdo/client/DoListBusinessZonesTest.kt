package asdo.client

import ar.com.intrale.shared.client.BusinessZoneDTO
import ar.com.intrale.shared.client.BusinessZoneTypeDTO
import ar.com.intrale.shared.client.LatLngDTO
import ar.com.intrale.shared.client.ListBusinessZonesResponse
import ext.client.CommListBusinessZonesService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Tests del caso de uso `DoListBusinessZones` (issue #2423).
 *
 * Cubre los CA-10 obligatorios:
 * - listZones retorna la lista cuando el servicio responde
 * - listZones mapea a exception cuando el servicio falla
 */
class DoListBusinessZonesTest {

    private fun fakeService(result: () -> Result<ListBusinessZonesResponse>): CommListBusinessZonesService =
        object : CommListBusinessZonesService {
            override suspend fun listZones(businessId: String): Result<ListBusinessZonesResponse> = result()
        }

    private fun validZone(): BusinessZoneDTO = BusinessZoneDTO(
        zoneId = "z1",
        type = BusinessZoneTypeDTO.POLYGON,
        shippingCost = 500.0,
        name = "Zona Norte",
        polygon = listOf(
            LatLngDTO(lat = -34.55, lng = -58.47),
            LatLngDTO(lat = -34.55, lng = -58.44),
            LatLngDTO(lat = -34.58, lng = -58.44),
        ),
    )

    @Test
    fun `listZones retorna la lista cuando el servicio responde`() = runTest {
        val response = ListBusinessZonesResponse(zones = listOf(validZone()))
        val service = fakeService { Result.success(response) }
        val do_ = DoListBusinessZones(service)

        val result = do_.execute("intrale")

        assertTrue(result.isSuccess, "deberia ser success")
        val data = result.getOrThrow()
        assertEquals(1, data.zones.size)
        assertEquals("Zona Norte", data.zones.first().name)
    }

    @Test
    fun `listZones mapea a exception cuando el servicio falla`() = runTest {
        val service = fakeService { Result.failure(RuntimeException("network down")) }
        val do_ = DoListBusinessZones(service)

        val result = do_.execute("intrale")

        assertTrue(result.isFailure, "deberia ser failure")
        val ex = result.exceptionOrNull()
        assertTrue(ex is DoListBusinessZonesException, "deberia ser DoListBusinessZonesException, fue ${ex?.let { it::class.simpleName }}")
    }

    @Test
    fun `listZones descarta zonas con coords fuera de rango sin romper`() = runTest {
        val invalidZone = BusinessZoneDTO(
            zoneId = "bad",
            type = BusinessZoneTypeDTO.POLYGON,
            shippingCost = 100.0,
            polygon = listOf(
                LatLngDTO(lat = 999.0, lng = 0.0),
                LatLngDTO(lat = 999.0, lng = 0.0),
                LatLngDTO(lat = 999.0, lng = 0.0),
            ),
        )
        val response = ListBusinessZonesResponse(zones = listOf(invalidZone, validZone()))
        val service = fakeService { Result.success(response) }
        val do_ = DoListBusinessZones(service)

        val result = do_.execute("intrale")

        assertTrue(result.isSuccess)
        val data = result.getOrThrow()
        assertEquals(1, data.zones.size, "solo la zona valida debe quedar")
    }

    @Test
    fun `listZones devuelve lista vacia cuando el backend responde vacio`() = runTest {
        val response = ListBusinessZonesResponse(zones = emptyList())
        val service = fakeService { Result.success(response) }
        val do_ = DoListBusinessZones(service)

        val result = do_.execute("intrale")

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow().zones.isEmpty())
    }
}
