package ar.com.intrale

import ar.com.intrale.geo.TokenBucketRateLimiter
import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ZonesCheckFunctionTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val tableZones = StubZonesTable()

    private fun newFunction(
        rateLimiter: TokenBucketRateLimiter = TokenBucketRateLimiter(
            capacity = 10,
            refillPerSecond = 0.0,
            clock = { 0L },
        ),
    ): ZonesCheckFunction = ZonesCheckFunction(
        config = config,
        logger = logger,
        tableZones = tableZones,
        rateLimiter = rateLimiter,
    )

    private fun seedSquarePolygon(zoneId: String = "zn_sqr") {
        // Cuadrado entre lat [0,1] y lng [0,1] en Buenos Aires
        val coords = listOf(
            mapOf("lat" to 0.0, "lng" to 0.0),
            mapOf("lat" to 0.0, "lng" to 1.0),
            mapOf("lat" to 1.0, "lng" to 1.0),
            mapOf("lat" to 1.0, "lng" to 0.0),
        )
        tableZones.items.add(DeliveryZoneEntity().apply {
            this.businessId = "biz"
            this.zoneId = zoneId
            this.type = "POLYGON"
            this.shippingCost = 450.0
            this.estimatedTimeMinutes = 35
            this.currency = "ARS"
            this.coordsJson = Gson().toJson(coords)
            this.boundingBoxJson = Gson().toJson(
                mapOf("minLat" to 0.0, "maxLat" to 1.0, "minLng" to 0.0, "maxLng" to 1.0)
            )
        })
    }

    @Test
    fun `punto dentro del poligono devuelve inZone true con costo`(): Unit = runBlocking {
        seedSquarePolygon()
        val response = newFunction().execute(
            "biz", "zones/check",
            mapOf("X-Forwarded-For" to "1.2.3.4"),
            Gson().toJson(ZoneCheckRequest(lat = 0.5, lng = 0.5))
        )
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ZoneCheckResponse)
        assertTrue(response.inZone)
        assertEquals(450.0, response.shippingCost)
        assertEquals(35, response.estimatedTimeMinutes)
        assertEquals("ARS", response.currency)
        assertNotNull(response.zoneId)
    }

    @Test
    fun `punto fuera del poligono devuelve inZone false con OUT_OF_COVERAGE`() = runBlocking {
        seedSquarePolygon()
        val response = newFunction().execute(
            "biz", "zones/check",
            mapOf("X-Forwarded-For" to "1.2.3.4"),
            Gson().toJson(ZoneCheckRequest(lat = 5.0, lng = 5.0))
        )
        assertTrue(response is ZoneCheckResponse)
        assertFalse(response.inZone)
        assertEquals("OUT_OF_COVERAGE", response.reason)
        assertNull(response.shippingCost)
    }

    @Test
    fun `negocio sin zonas devuelve NO_ZONES_DEFINED`() = runBlocking {
        val response = newFunction().execute(
            "biz", "zones/check",
            mapOf("X-Forwarded-For" to "1.2.3.4"),
            Gson().toJson(ZoneCheckRequest(lat = 0.5, lng = 0.5))
        )
        assertTrue(response is ZoneCheckResponse)
        assertFalse(response.inZone)
        assertEquals("NO_ZONES_DEFINED", response.reason)
    }

    @Test
    fun `zona CIRCLE matchea cuando el punto esta dentro del radio`() = runBlocking {
        tableZones.items.add(DeliveryZoneEntity().apply {
            businessId = "biz"
            zoneId = "zn_circle"
            type = "CIRCLE"
            centerLat = 0.0
            centerLng = 0.0
            radiusMeters = 1500.0
            shippingCost = 200.0
            estimatedTimeMinutes = 20
            currency = "ARS"
            boundingBoxJson = Gson().toJson(
                mapOf("minLat" to -0.02, "maxLat" to 0.02, "minLng" to -0.02, "maxLng" to 0.02)
            )
        })
        val response = newFunction().execute(
            "biz", "zones/check",
            mapOf("X-Forwarded-For" to "1.2.3.4"),
            // ~110m al norte del centro → dentro del radio de 1500m
            Gson().toJson(ZoneCheckRequest(lat = 0.001, lng = 0.0))
        )
        assertTrue(response is ZoneCheckResponse)
        assertTrue(response.inZone)
        assertEquals(200.0, response.shippingCost)
    }

    @Test
    fun `15 requests con capacidad 10 devuelven 5 con 429 (rate limit)`() = runBlocking {
        seedSquarePolygon()
        val function = newFunction()
        var rateLimitedCount = 0
        var allowedCount = 0
        repeat(15) {
            val response = function.execute(
                "biz", "zones/check",
                mapOf("X-Forwarded-For" to "9.9.9.9"),
                Gson().toJson(ZoneCheckRequest(lat = 0.5, lng = 0.5))
            )
            if (response.statusCode == HttpStatusCode.TooManyRequests) rateLimitedCount++
            else if (response.statusCode == HttpStatusCode.OK) allowedCount++
        }
        assertEquals(10, allowedCount, "permitidos esperados=10, actuales=$allowedCount")
        assertEquals(5, rateLimitedCount, "rate-limited esperados=5, actuales=$rateLimitedCount")
    }

    @Test
    fun `IP spoofing en X-Forwarded-For - el rate limit usa el ULTIMO valor`() = runBlocking {
        seedSquarePolygon()
        val limiter = TokenBucketRateLimiter(capacity = 1, refillPerSecond = 0.0, clock = { 0L })
        val function = newFunction(rateLimiter = limiter)

        // Atacante envia primero "1.1.1.1" como IP spoofeada en el primer slot;
        // pero el ULTIMO valor (real, lo agrega API Gateway) es "10.0.0.1".
        val r1 = function.execute(
            "biz", "zones/check",
            mapOf("X-Forwarded-For" to "1.1.1.1, 2.2.2.2, 10.0.0.1"),
            Gson().toJson(ZoneCheckRequest(lat = 0.5, lng = 0.5))
        )
        assertEquals(HttpStatusCode.OK, r1.statusCode)

        // Misma IP real (10.0.0.1) ahora cambia el header pero la IP real sigue siendo 10.0.0.1
        // → debe ser rate-limiteado
        val r2 = function.execute(
            "biz", "zones/check",
            mapOf("X-Forwarded-For" to "8.8.8.8, 10.0.0.1"),
            Gson().toJson(ZoneCheckRequest(lat = 0.5, lng = 0.5))
        )
        assertEquals(HttpStatusCode.TooManyRequests, r2.statusCode)
    }

    @Test
    fun `latitud invalida devuelve BadRequest`() = runBlocking {
        seedSquarePolygon()
        val response = newFunction().execute(
            "biz", "zones/check",
            mapOf("X-Forwarded-For" to "1.2.3.4"),
            Gson().toJson(ZoneCheckRequest(lat = 91.0, lng = 0.0))
        )
        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `body vacio devuelve BadRequest`() = runBlocking {
        val response = newFunction().execute(
            "biz", "zones/check",
            mapOf("X-Forwarded-For" to "1.2.3.4"),
            ""
        )
        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `resolveClientIp toma el ultimo valor de X-Forwarded-For`() {
        val ip = ZonesCheckFunction.resolveClientIp(
            mapOf("X-Forwarded-For" to "1.1.1.1, 2.2.2.2, 10.0.0.1")
        )
        assertEquals("10.0.0.1", ip)
    }

    @Test
    fun `resolveClientIp lower-case header tambien funciona`() {
        val ip = ZonesCheckFunction.resolveClientIp(
            mapOf("x-forwarded-for" to "1.1.1.1")
        )
        assertEquals("1.1.1.1", ip)
    }

    @Test
    fun `resolveClientIp sin XFF devuelve unknown`() {
        val ip = ZonesCheckFunction.resolveClientIp(emptyMap())
        assertEquals("unknown", ip)
    }
}
