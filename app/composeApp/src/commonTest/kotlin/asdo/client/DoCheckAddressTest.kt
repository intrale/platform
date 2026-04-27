package asdo.client

import ar.com.intrale.shared.client.ZoneCheckResponse
import ext.client.CommZoneCheckService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Tests para [DoCheckAddress] — issue #2422.
 *
 * Cubre los CA verificables a nivel unitario:
 * - CA-6: rango Konform de lat/lng + cap de shippingCost.
 * - CA-7: el log nunca contiene lat/lng en este caso de uso (revisión
 *         por inspección del código, no automatizable acá).
 * - CA-13: pruebas obligatorias del flujo Do.
 */
class DoCheckAddressTest {

    private fun fakeService(result: Result<ZoneCheckResponse>): CommZoneCheckService =
        object : CommZoneCheckService {
            override suspend fun checkZone(
                latitude: Double,
                longitude: Double
            ): Result<ZoneCheckResponse> = result
        }

    @Test
    fun `checkAddress retorna ok cuando el servicio devuelve inZone=true`() = runTest {
        val response = ZoneCheckResponse(
            inZone = true,
            shippingCost = 1500.0,
            etaMinutes = 30,
            zoneId = "z1",
        )
        val sut = DoCheckAddress(fakeService(Result.success(response)))

        val result = sut.execute(ZoneCheckCoordinates(-34.6, -58.4))

        assertTrue(result.isSuccess)
        val ok = result.getOrThrow()
        assertTrue(ok.inZone)
        assertEquals(1500.0, ok.shippingCost)
        assertEquals(30, ok.etaMinutes)
        assertEquals("z1", ok.zoneId)
    }

    @Test
    fun `checkAddress retorna inZone=false cuando el servicio asi responde`() = runTest {
        val response = ZoneCheckResponse(inZone = false)
        val sut = DoCheckAddress(fakeService(Result.success(response)))

        val result = sut.execute(ZoneCheckCoordinates(0.0, 0.0))

        assertTrue(result.isSuccess)
        assertFalse(result.getOrThrow().inZone)
    }

    @Test
    fun `checkAddress mapea a exception cuando el servicio falla`() = runTest {
        val sut = DoCheckAddress(
            fakeService(Result.failure(RuntimeException("boom")))
        )

        val result = sut.execute(ZoneCheckCoordinates(-34.6, -58.4))

        assertTrue(result.isFailure)
        val error = result.exceptionOrNull()
        assertIs<ZoneCheckException.Network>(error)
    }

    @Test
    fun `checkAddress rechaza coordenadas fuera de rango -90,90 latitude`() = runTest {
        val sut = DoCheckAddress(fakeService(Result.success(ZoneCheckResponse(inZone = true))))

        val tooHigh = sut.execute(ZoneCheckCoordinates(91.0, 0.0))
        val tooLow = sut.execute(ZoneCheckCoordinates(-91.0, 0.0))

        assertIs<ZoneCheckException.Invalid>(tooHigh.exceptionOrNull())
        assertIs<ZoneCheckException.Invalid>(tooLow.exceptionOrNull())
    }

    @Test
    fun `checkAddress rechaza coordenadas fuera de rango -180,180 longitude`() = runTest {
        val sut = DoCheckAddress(fakeService(Result.success(ZoneCheckResponse(inZone = true))))

        val tooHigh = sut.execute(ZoneCheckCoordinates(0.0, 181.0))
        val tooLow = sut.execute(ZoneCheckCoordinates(0.0, -181.0))

        assertIs<ZoneCheckException.Invalid>(tooHigh.exceptionOrNull())
        assertIs<ZoneCheckException.Invalid>(tooLow.exceptionOrNull())
    }

    @Test
    fun `checkAddress rechaza NaN e Infinity en lat o lng`() = runTest {
        val sut = DoCheckAddress(fakeService(Result.success(ZoneCheckResponse(inZone = true))))

        val nanLat = sut.execute(ZoneCheckCoordinates(Double.NaN, 0.0))
        val infLat = sut.execute(ZoneCheckCoordinates(Double.POSITIVE_INFINITY, 0.0))
        val negInfLng = sut.execute(ZoneCheckCoordinates(0.0, Double.NEGATIVE_INFINITY))

        assertIs<ZoneCheckException.Invalid>(nanLat.exceptionOrNull())
        assertIs<ZoneCheckException.Invalid>(infLat.exceptionOrNull())
        assertIs<ZoneCheckException.Invalid>(negInfLng.exceptionOrNull())
    }

    @Test
    fun `checkAddress rechaza shippingCost fuera de 0,100000`() = runTest {
        val negative = ZoneCheckResponse(inZone = true, shippingCost = -1.0)
        val tooHigh = ZoneCheckResponse(inZone = true, shippingCost = 100_001.0)

        val sutNeg = DoCheckAddress(fakeService(Result.success(negative)))
        val sutHigh = DoCheckAddress(fakeService(Result.success(tooHigh)))

        val rNeg = sutNeg.execute(ZoneCheckCoordinates(-34.6, -58.4))
        val rHigh = sutHigh.execute(ZoneCheckCoordinates(-34.6, -58.4))

        assertIs<ZoneCheckException.OutOfRange>(rNeg.exceptionOrNull())
        assertIs<ZoneCheckException.OutOfRange>(rHigh.exceptionOrNull())
    }

    @Test
    fun `checkAddress acepta limite superior 100000 e inferior 0`() = runTest {
        val zero = ZoneCheckResponse(inZone = true, shippingCost = 0.0)
        val cap = ZoneCheckResponse(inZone = true, shippingCost = 100_000.0)

        val sutZero = DoCheckAddress(fakeService(Result.success(zero)))
        val sutCap = DoCheckAddress(fakeService(Result.success(cap)))

        assertTrue(sutZero.execute(ZoneCheckCoordinates(-34.6, -58.4)).isSuccess)
        assertTrue(sutCap.execute(ZoneCheckCoordinates(-34.6, -58.4)).isSuccess)
    }

    @Test
    fun `isWellFormed devuelve false para NaN Infinity y rangos invalidos`() {
        assertFalse(ZoneCheckCoordinates(Double.NaN, 0.0).isWellFormed())
        assertFalse(ZoneCheckCoordinates(0.0, Double.POSITIVE_INFINITY).isWellFormed())
        assertFalse(ZoneCheckCoordinates(91.0, 0.0).isWellFormed())
        assertFalse(ZoneCheckCoordinates(0.0, -181.0).isWellFormed())
        assertTrue(ZoneCheckCoordinates(-34.6, -58.4).isWellFormed())
        assertTrue(ZoneCheckCoordinates(0.0, 0.0).isWellFormed())
    }
}
