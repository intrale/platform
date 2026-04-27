package ar.com.intrale.geo

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class HaversineTest {

    @Test
    fun `distancia entre dos puntos identicos es cero`() {
        val p = Vertex(-34.6037, -58.3816) // Buenos Aires
        assertEquals(0.0, haversineMeters(p, p), absoluteTolerance = 0.001)
    }

    @Test
    fun `distancia conocida entre Buenos Aires y Cordoba es aproximadamente 645km`() {
        val ba = Vertex(-34.6037, -58.3816)
        val cba = Vertex(-31.4201, -64.1888)
        val distance = haversineMeters(ba, cba)
        // La distancia real es ~645 km. Toleramos +/- 5 km por aproximacion del modelo esferico.
        assertTrue(distance in 640_000.0..650_000.0, "distancia inesperada: $distance m")
    }

    @Test
    fun `punto en el centro de un circulo se considera DENTRO`() {
        val center = Vertex(-34.6037, -58.3816)
        assertTrue(ZoneGeometry.isPointInCircle(center.lat, center.lng, 1000.0, center))
    }

    @Test
    fun `punto exactamente en el radio se considera DENTRO (convencion borde)`() {
        // Caminamos ~100m al norte y verificamos con radio 100m + tolerancia
        val center = Vertex(0.0, 0.0)
        val pointAt100m = Vertex(0.0009, 0.0) // ~100m al norte de (0,0)
        val distance = haversineMeters(center, pointAt100m)
        // Usamos como radio la distancia exacta para forzar el caso "borde".
        assertTrue(ZoneGeometry.isPointInCircle(center.lat, center.lng, distance, pointAt100m))
    }

    @Test
    fun `punto fuera del radio se considera FUERA`() {
        val center = Vertex(-34.6037, -58.3816)
        val far = Vertex(-31.4201, -64.1888) // Cordoba, ~645 km
        assertFalse(ZoneGeometry.isPointInCircle(center.lat, center.lng, 10_000.0, far))
    }

    @Test
    fun `bounding box de un circulo cubre el area esperada`() {
        val center = Vertex(0.0, 0.0)
        val radius = 1000.0 // 1 km
        val bb = BoundingBox.ofCircle(center.lat, center.lng, radius)
        // El centro debe estar dentro
        assertTrue(bb.contains(center))
        // Un punto a ~500m al norte tambien (dentro de la caja, dentro del circulo)
        assertTrue(bb.contains(Vertex(0.0045, 0.0)))
        // Un punto a 5km al norte debe quedar fuera de la caja
        assertFalse(bb.contains(Vertex(0.045, 0.0)))
    }
}
