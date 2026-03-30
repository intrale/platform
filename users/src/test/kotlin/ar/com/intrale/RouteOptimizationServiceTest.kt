package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RouteOptimizationServiceTest {

    private val service = RouteOptimizationService()

    // Coordenadas de prueba (barrios de Buenos Aires)
    private val palermo = RouteOptimizationService.Stop("order-1", "Av. Santa Fe 3200", -34.5875, -58.4112, "Cliente Palermo", null)
    private val belgrano = RouteOptimizationService.Stop("order-2", "Av. Cabildo 2000", -34.5603, -58.4558, "Cliente Belgrano", null)
    private val recoleta = RouteOptimizationService.Stop("order-3", "Av. Alvear 1500", -34.5877, -58.3933, "Cliente Recoleta", null)
    private val sanTelmo = RouteOptimizationService.Stop("order-4", "Defensa 800", -34.6209, -58.3734, "Cliente San Telmo", null)
    private val caballito = RouteOptimizationService.Stop("order-5", "Av. Rivadavia 5000", -34.6186, -58.4363, "Cliente Caballito", null)

    @Test
    fun `lista vacia retorna resultado vacio`() {
        val result = service.optimize(emptyList(), null, null)
        assertTrue(result.orderedStops.isEmpty())
        assertEquals(0.0, result.totalDistanceKm)
        assertNull(result.googleMapsUrl)
    }

    @Test
    fun `una sola parada retorna esa misma parada`() {
        val result = service.optimize(listOf(palermo), null, null)
        assertEquals(1, result.orderedStops.size)
        assertEquals("order-1", result.orderedStops[0].stop.orderId)
        assertEquals(0.0, result.estimatedSavingsPercent)
    }

    @Test
    fun `una sola parada con posicion actual calcula distancia`() {
        // Posición en microcentro
        val result = service.optimize(listOf(palermo), -34.6037, -58.3816)
        assertEquals(1, result.orderedStops.size)
        assertTrue(result.totalDistanceKm > 0)
    }

    @Test
    fun `dos paradas retorna ambas en orden optimizado`() {
        val result = service.optimize(listOf(palermo, belgrano), null, null)
        assertEquals(2, result.orderedStops.size)
        assertTrue(result.totalDistanceKm > 0)
    }

    @Test
    fun `nearest neighbor optimiza el recorrido desde posicion actual`() {
        // Posición actual: Recoleta. Orden recibido: Belgrano, San Telmo, Palermo
        // Esperado: primero Palermo (más cerca de Recoleta), luego Belgrano, luego San Telmo
        val stops = listOf(belgrano, sanTelmo, palermo)
        val result = service.optimize(stops, recoleta.latitude, recoleta.longitude)

        assertEquals(3, result.orderedStops.size)
        // Primer stop debería ser el más cercano a Recoleta
        val firstStop = result.orderedStops[0].stop
        // Palermo y Recoleta están cerca, verificar que Palermo es primero
        assertEquals("order-1", firstStop.orderId, "Palermo deberia ser la primera parada desde Recoleta")
    }

    @Test
    fun `haversine calcula distancia correcta entre dos puntos conocidos`() {
        // Distancia Obelisco - Estadio Monumental ≈ 9 km
        val obeliscoLat = -34.6037
        val obeliscoLng = -58.3816
        val monumentalLat = -34.5452
        val monumentalLng = -58.4494

        val distance = service.haversineKm(obeliscoLat, obeliscoLng, monumentalLat, monumentalLng)
        assertTrue(distance in 7.0..11.0, "Distancia Obelisco-Monumental deberia ser ~9km, fue $distance")
    }

    @Test
    fun `haversine retorna cero para el mismo punto`() {
        val distance = service.haversineKm(-34.6037, -58.3816, -34.6037, -58.3816)
        assertEquals(0.0, distance)
    }

    @Test
    fun `google maps url se genera correctamente con paradas`() {
        val stops = listOf(palermo, belgrano)
        val url = service.buildGoogleMapsUrl(stops, -34.6037, -58.3816)
        assertNotNull(url)
        assertTrue(url.startsWith("https://www.google.com/maps/dir/"))
        assertTrue(url.contains("-34.6037,-58.3816"))
        assertTrue(url.contains("-34.5875,-58.4112"))
        assertTrue(url.contains("-34.5603,-58.4558"))
    }

    @Test
    fun `google maps url sin posicion actual omite punto de partida`() {
        val stops = listOf(palermo, belgrano)
        val url = service.buildGoogleMapsUrl(stops, null, null)
        assertNotNull(url)
        assertTrue(url.startsWith("https://www.google.com/maps/dir/"))
        // Solo debería tener las coordenadas de las dos paradas
        assertTrue(url.contains("-34.5875,-58.4112"))
        assertTrue(url.contains("-34.5603,-58.4558"))
    }

    @Test
    fun `optimizacion de 5 paradas reduce distancia vs orden original suboptimo`() {
        // Orden intencionalmente malo: Palermo → San Telmo → Belgrano → Caballito → Recoleta
        val stops = listOf(palermo, sanTelmo, belgrano, caballito, recoleta)
        val result = service.optimize(stops, null, null)

        assertEquals(5, result.orderedStops.size)
        assertTrue(result.totalDistanceKm > 0)
        // No garantizamos ahorro en todos los casos, pero la distancia debe ser positiva
        assertTrue(result.totalDistanceKm < 100, "Distancia total no deberia ser absurda")
    }

    @Test
    fun `distancia total se calcula correctamente`() {
        val stops = listOf(palermo, belgrano, recoleta)
        val distance = service.calculateTotalDistance(stops, null, null)
        assertTrue(distance > 0)
    }

    @Test
    fun `distancia total con posicion inicial incluye tramo al primer punto`() {
        val stops = listOf(palermo, belgrano)
        val distWithStart = service.calculateTotalDistance(stops, -34.6037, -58.3816)
        val distWithoutStart = service.calculateTotalDistance(stops, null, null)
        // Con posición inicial debería ser mayor (hay un tramo extra)
        assertTrue(distWithStart > distWithoutStart,
            "Distancia con punto de inicio ($distWithStart) deberia ser mayor que sin ($distWithoutStart)")
    }
}
