package asdo.client

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Tests del calculador de bounding box (issue #2423).
 *
 * Cubre los casos del PO CA-2: una sola zona, multiples zonas, lista
 * vacia. Se verifica con poligonos y con circulos.
 */
class BoundingBoxCalculatorTest {

    private fun polygonZone(points: List<Pair<Double, Double>>): SanitizedBusinessZone =
        SanitizedBusinessZone(
            zoneId = "p",
            name = "Zona",
            type = ZoneShape.POLYGON,
            shippingCost = 0.0,
            currency = "ARS",
            polygon = points.map { (lat, lng) -> SanitizedLatLng(lat, lng) },
        )

    @Test
    fun `BoundingBoxCalculator devuelve bbox correcto para una sola zona`() {
        val zone = polygonZone(
            listOf(
                -34.5800 to -58.4700,
                -34.5500 to -58.4400,
                -34.5800 to -58.4400,
            ),
        )
        val bb = BoundingBoxCalculator.compute(listOf(zone))
        assertNotNull(bb)
        assertEquals(-34.5800, bb.minLat, "minLat")
        assertEquals(-34.5500, bb.maxLat, "maxLat")
        assertEquals(-58.4700, bb.minLng, "minLng")
        assertEquals(-58.4400, bb.maxLng, "maxLng")
    }

    @Test
    fun `BoundingBoxCalculator devuelve bbox correcto para multiples zonas`() {
        val zoneA = polygonZone(
            listOf(
                -34.5800 to -58.4700,
                -34.5500 to -58.4400,
                -34.5800 to -58.4400,
            ),
        )
        val zoneB = polygonZone(
            listOf(
                -34.6200 to -58.3900,
                -34.6000 to -58.3700,
                -34.6200 to -58.3700,
            ),
        )
        val bb = BoundingBoxCalculator.compute(listOf(zoneA, zoneB))
        assertNotNull(bb)
        assertEquals(-34.6200, bb.minLat, "minLat")
        assertEquals(-34.5500, bb.maxLat, "maxLat")
        assertEquals(-58.4700, bb.minLng, "minLng")
        assertEquals(-58.3700, bb.maxLng, "maxLng")
    }

    @Test
    fun `BoundingBoxCalculator devuelve null cuando no hay zonas`() {
        val bb = BoundingBoxCalculator.compute(emptyList())
        assertNull(bb)
    }

    @Test
    fun `BoundingBoxCalculator soporta zona tipo CIRCLE expandiendo radio`() {
        val circle = SanitizedBusinessZone(
            zoneId = "c",
            name = "Centro",
            type = ZoneShape.CIRCLE,
            shippingCost = 0.0,
            currency = "ARS",
            center = SanitizedLatLng(-34.6, -58.4),
            radiusMeters = 1000.0,
        )
        val bb = BoundingBoxCalculator.compute(listOf(circle))
        assertNotNull(bb)
        // El bounding box del circulo expande +/- ~0.009 grados de lat
        assertTrue(bb.minLat < -34.6, "minLat debe expandir hacia el sur")
        assertTrue(bb.maxLat > -34.6, "maxLat debe expandir hacia el norte")
        assertTrue(bb.minLng < -58.4, "minLng debe expandir hacia el oeste")
        assertTrue(bb.maxLng > -58.4, "maxLng debe expandir hacia el este")
    }
}
