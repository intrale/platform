package ar.com.intrale.geo

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Vertice geografico (lat, lng) con precision truncada a 6 decimales (~0.11m,
 * suficiente para delivery urbano y mitigacion de PII excesiva — ver auditoria
 * Security en #2415).
 */
data class Vertex(
    val lat: Double,
    val lng: Double,
) {
    init {
        require(lat in -90.0..90.0) { "latitude fuera de rango [-90,90]: $lat" }
        require(lng in -180.0..180.0) { "longitude fuera de rango [-180,180]: $lng" }
    }

    /** Devuelve un Vertex con coordenadas truncadas a 6 decimales. */
    fun truncated(): Vertex = Vertex(round6(lat), round6(lng))
}

/**
 * Caja envolvente axis-aligned (AABB) usada para descartar zonas en O(1)
 * antes del ray casting O(V).
 */
data class BoundingBox(
    val minLat: Double,
    val maxLat: Double,
    val minLng: Double,
    val maxLng: Double,
) {
    fun contains(p: Vertex): Boolean =
        p.lat in minLat..maxLat && p.lng in minLng..maxLng

    fun expand(other: BoundingBox): BoundingBox = BoundingBox(
        minLat = min(minLat, other.minLat),
        maxLat = max(maxLat, other.maxLat),
        minLng = min(minLng, other.minLng),
        maxLng = max(maxLng, other.maxLng),
    )

    val width: Double get() = maxLng - minLng
    val height: Double get() = maxLat - minLat

    companion object {
        fun ofPolygon(polygon: List<Vertex>): BoundingBox {
            require(polygon.isNotEmpty()) { "poligono vacio" }
            var minLat = polygon[0].lat
            var maxLat = polygon[0].lat
            var minLng = polygon[0].lng
            var maxLng = polygon[0].lng
            for (v in polygon) {
                if (v.lat < minLat) minLat = v.lat
                if (v.lat > maxLat) maxLat = v.lat
                if (v.lng < minLng) minLng = v.lng
                if (v.lng > maxLng) maxLng = v.lng
            }
            return BoundingBox(minLat, maxLat, minLng, maxLng)
        }

        fun ofCircle(centerLat: Double, centerLng: Double, radiusMeters: Double): BoundingBox {
            // Aproximacion equirectangular: 1 grado lat ~= 111_000 m;
            // 1 grado lng ~= 111_000 * cos(lat) m. Valida para radios < 50km en zona habitada.
            val latDelta = radiusMeters / 111_000.0
            val lngDelta = radiusMeters / (111_000.0 * cos(centerLat * PI / 180.0))
            return BoundingBox(
                minLat = max(-90.0, centerLat - latDelta),
                maxLat = min(90.0, centerLat + latDelta),
                minLng = max(-180.0, centerLng - lngDelta),
                maxLng = min(180.0, centerLng + lngDelta),
            )
        }
    }
}

/** Trunca a 6 decimales (~11cm de precision; suficiente para delivery + privacidad). */
fun round6(value: Double): Double = round(value * 1_000_000.0) / 1_000_000.0

/**
 * Distancia Haversine en metros entre dos puntos (lat,lng) en grados.
 */
fun haversineMeters(a: Vertex, b: Vertex): Double {
    val r = 6_371_000.0 // radio medio terrestre en metros
    val dLat = (b.lat - a.lat) * PI / 180.0
    val dLng = (b.lng - a.lng) * PI / 180.0
    val lat1 = a.lat * PI / 180.0
    val lat2 = b.lat * PI / 180.0
    val h = sin(dLat / 2).let { it * it } + cos(lat1) * cos(lat2) * sin(dLng / 2).let { it * it }
    val c = 2 * atan2(sqrt(h), sqrt(1 - h))
    return r * c
}
