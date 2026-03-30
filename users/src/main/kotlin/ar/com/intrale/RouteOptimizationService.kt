package ar.com.intrale

import org.slf4j.Logger
import org.slf4j.LoggerFactory
import kotlin.math.*

/**
 * Servicio de optimización de rutas para repartidores.
 * Implementa un algoritmo nearest-neighbor sobre coordenadas geográficas
 * para ordenar paradas minimizando la distancia total del recorrido.
 *
 * Evolución futura: integrar API de distancias de Google Maps o IA
 * para mayor precisión con tráfico y sentido de calles.
 */
class RouteOptimizationService {

    val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")

    /**
     * Representa una parada con coordenadas para el algoritmo.
     */
    data class Stop(
        val orderId: String,
        val address: String,
        val latitude: Double,
        val longitude: Double,
        val customerName: String?,
        val promisedAt: String?
    )

    /**
     * Resultado de la optimización con el orden de paradas y métricas.
     */
    data class OptimizationResult(
        val orderedStops: List<StopWithDistance>,
        val totalDistanceKm: Double,
        val estimatedSavingsPercent: Double,
        val googleMapsUrl: String?
    )

    data class StopWithDistance(
        val stop: Stop,
        val distanceFromPreviousKm: Double
    )

    /**
     * Optimiza el orden de entrega usando nearest-neighbor.
     * @param stops Lista de paradas con coordenadas válidas
     * @param currentLat Latitud actual del repartidor (punto de partida)
     * @param currentLng Longitud actual del repartidor
     * @return Resultado con paradas ordenadas y métricas
     */
    fun optimize(
        stops: List<Stop>,
        currentLat: Double?,
        currentLng: Double?
    ): OptimizationResult {
        if (stops.isEmpty()) {
            return OptimizationResult(
                orderedStops = emptyList(),
                totalDistanceKm = 0.0,
                estimatedSavingsPercent = 0.0,
                googleMapsUrl = null
            )
        }

        if (stops.size == 1) {
            val dist = if (currentLat != null && currentLng != null) {
                haversineKm(currentLat, currentLng, stops[0].latitude, stops[0].longitude)
            } else 0.0
            return OptimizationResult(
                orderedStops = listOf(StopWithDistance(stops[0], dist)),
                totalDistanceKm = dist,
                estimatedSavingsPercent = 0.0,
                googleMapsUrl = buildGoogleMapsUrl(stops, currentLat, currentLng)
            )
        }

        // Calcular distancia original (orden recibido)
        val originalDistance = calculateTotalDistance(stops, currentLat, currentLng)

        // Nearest-neighbor desde la posición actual del repartidor
        val optimized = nearestNeighbor(stops, currentLat, currentLng)
        val optimizedDistance = optimized.sumOf { it.distanceFromPreviousKm }

        val savings = if (originalDistance > 0) {
            ((originalDistance - optimizedDistance) / originalDistance * 100).coerceAtLeast(0.0)
        } else 0.0

        val orderedStops = optimized.map { it.stop }
        logger.info("Ruta optimizada: ${orderedStops.size} paradas, " +
                "distancia total ${String.format("%.2f", optimizedDistance)} km, " +
                "ahorro estimado ${String.format("%.1f", savings)}%")

        return OptimizationResult(
            orderedStops = optimized,
            totalDistanceKm = round(optimizedDistance * 100) / 100,
            estimatedSavingsPercent = round(savings * 10) / 10,
            googleMapsUrl = buildGoogleMapsUrl(orderedStops, currentLat, currentLng)
        )
    }

    /**
     * Algoritmo nearest-neighbor: en cada paso elige la parada más cercana.
     */
    internal fun nearestNeighbor(
        stops: List<Stop>,
        startLat: Double?,
        startLng: Double?
    ): List<StopWithDistance> {
        val remaining = stops.toMutableList()
        val result = mutableListOf<StopWithDistance>()

        var currentLat = startLat ?: stops[0].latitude
        var currentLng = startLng ?: stops[0].longitude

        // Si no hay posición inicial, la primera parada es la primera de la lista
        if (startLat == null || startLng == null) {
            val first = remaining.removeFirst()
            result.add(StopWithDistance(first, 0.0))
            currentLat = first.latitude
            currentLng = first.longitude
        }

        while (remaining.isNotEmpty()) {
            var nearestIdx = 0
            var nearestDist = Double.MAX_VALUE

            for (i in remaining.indices) {
                val dist = haversineKm(currentLat, currentLng, remaining[i].latitude, remaining[i].longitude)
                if (dist < nearestDist) {
                    nearestDist = dist
                    nearestIdx = i
                }
            }

            val nearest = remaining.removeAt(nearestIdx)
            result.add(StopWithDistance(nearest, round(nearestDist * 100) / 100))
            currentLat = nearest.latitude
            currentLng = nearest.longitude
        }

        return result
    }

    /**
     * Calcula la distancia total de un recorrido en el orden dado.
     */
    internal fun calculateTotalDistance(
        stops: List<Stop>,
        startLat: Double?,
        startLng: Double?
    ): Double {
        if (stops.isEmpty()) return 0.0

        var total = 0.0
        var prevLat = startLat ?: stops[0].latitude
        var prevLng = startLng ?: stops[0].longitude

        val startIdx = if (startLat == null || startLng == null) 1 else 0
        for (i in startIdx until stops.size) {
            total += haversineKm(prevLat, prevLng, stops[i].latitude, stops[i].longitude)
            prevLat = stops[i].latitude
            prevLng = stops[i].longitude
        }

        return total
    }

    /**
     * Fórmula de Haversine para distancia entre dos puntos geográficos en km.
     */
    internal fun haversineKm(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val earthRadiusKm = 6371.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a = sin(dLat / 2).pow(2) +
                cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) *
                sin(dLon / 2).pow(2)
        val c = 2 * atan2(sqrt(a), sqrt(1 - a))
        return earthRadiusKm * c
    }

    /**
     * Genera una URL de Google Maps con las paradas en orden optimizado.
     */
    internal fun buildGoogleMapsUrl(
        orderedStops: List<Stop>,
        startLat: Double?,
        startLng: Double?
    ): String? {
        if (orderedStops.isEmpty()) return null

        val baseUrl = "https://www.google.com/maps/dir/"
        val parts = mutableListOf<String>()

        // Punto de partida (posición actual del repartidor)
        if (startLat != null && startLng != null) {
            parts.add("$startLat,$startLng")
        }

        // Paradas en orden optimizado
        orderedStops.forEach { stop ->
            parts.add("${stop.latitude},${stop.longitude}")
        }

        return baseUrl + parts.joinToString("/")
    }
}
