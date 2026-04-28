package asdo.client

import ar.com.intrale.shared.client.BusinessZoneDTO
import ar.com.intrale.shared.client.BusinessZoneTypeDTO
import ar.com.intrale.shared.client.LatLngDTO
import ar.com.intrale.shared.client.ZoneBoundingBoxDTO
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * Tests del sanitizador de zonas (issue #2423 — Hija B del split #2417).
 *
 * Cubre Security A03/A09: descarte de coordenadas fuera de rango,
 * costos negativos, nombres invalidos, poligonos sin minimos vertices.
 */
class BusinessZoneSanitizerTest {

    private fun polygonZone(
        zoneId: String = "z1",
        cost: Double = 500.0,
        name: String? = "Zona Test",
        polygon: List<LatLngDTO> = listOf(
            LatLngDTO(lat = -34.6, lng = -58.4),
            LatLngDTO(lat = -34.6, lng = -58.3),
            LatLngDTO(lat = -34.7, lng = -58.3),
        ),
    ): BusinessZoneDTO = BusinessZoneDTO(
        businessId = "intrale",
        zoneId = zoneId,
        type = BusinessZoneTypeDTO.POLYGON,
        shippingCost = cost,
        name = name,
        polygon = polygon,
    )

    @Test
    fun `Konform descarta zona con lat fuera de rango`() {
        val dto = polygonZone(
            polygon = listOf(
                LatLngDTO(lat = 91.0, lng = 0.0),
                LatLngDTO(lat = 92.0, lng = 0.0),
                LatLngDTO(lat = 93.0, lng = 0.0),
            ),
        )
        assertNull(BusinessZoneSanitizer.sanitize(dto))
    }

    @Test
    fun `Konform descarta zona con lon fuera de rango`() {
        val dto = polygonZone(
            polygon = listOf(
                LatLngDTO(lat = 0.0, lng = 181.0),
                LatLngDTO(lat = 0.0, lng = 182.0),
                LatLngDTO(lat = 0.0, lng = 183.0),
            ),
        )
        assertNull(BusinessZoneSanitizer.sanitize(dto))
    }

    @Test
    fun `Konform descarta zona con costo negativo`() {
        val dto = polygonZone(cost = -1.0)
        assertNull(BusinessZoneSanitizer.sanitize(dto))
    }

    @Test
    fun `zoneName invalido se sustituye por fallback Zona`() {
        val dto = polygonZone(name = "<script>alert('x')</script>")
        val sanitized = BusinessZoneSanitizer.sanitize(dto)
        assertNotNull(sanitized)
        assertEquals("Zona", sanitized.name)
    }

    @Test
    fun `zoneName se trunca a 40 caracteres`() {
        val longName = "Z".repeat(60)
        val dto = polygonZone(name = longName)
        val sanitized = BusinessZoneSanitizer.sanitize(dto)
        assertNotNull(sanitized)
        assertEquals(40, sanitized.name.length)
    }

    @Test
    fun `poligono con menos de 3 vertices se descarta`() {
        val dto = polygonZone(
            polygon = listOf(
                LatLngDTO(lat = -34.6, lng = -58.4),
                LatLngDTO(lat = -34.6, lng = -58.3),
            ),
        )
        assertNull(BusinessZoneSanitizer.sanitize(dto))
    }

    @Test
    fun `circulo sin centro se descarta`() {
        val dto = BusinessZoneDTO(
            zoneId = "c1",
            type = BusinessZoneTypeDTO.CIRCLE,
            shippingCost = 500.0,
            radiusMeters = 1000.0,
            // sin centerLat/centerLng
        )
        assertNull(BusinessZoneSanitizer.sanitize(dto))
    }

    @Test
    fun `bounding box todo cero se trata como vacio`() {
        val raw = ZoneBoundingBoxDTO(0.0, 0.0, 0.0, 0.0)
        assertNull(BusinessZoneSanitizer.sanitizeBoundingBox(raw))
    }
}
