package asdo.client

import kotlin.math.cos
import kotlin.math.PI

/**
 * Util puro (sin Android Context) para calcular el bounding box que
 * contiene la union de todas las zonas saneadas.
 *
 * Se mantiene separado del [BusinessZoneSanitizer] para tests dedicados
 * y reutilizacion en otras pantallas si surgen.
 *
 * Issue: #2423 — Hija B del split #2417.
 */
object BoundingBoxCalculator {

    /** Aproximacion: 1 grado de latitud == ~111.32 km en cualquier punto. */
    private const val LATITUDE_DEGREE_METERS = 111_320.0

    fun compute(zones: List<SanitizedBusinessZone>): SanitizedBoundingBox? {
        if (zones.isEmpty()) return null

        var minLat = Double.POSITIVE_INFINITY
        var maxLat = Double.NEGATIVE_INFINITY
        var minLng = Double.POSITIVE_INFINITY
        var maxLng = Double.NEGATIVE_INFINITY

        zones.forEach { zone ->
            when (zone.type) {
                ZoneShape.POLYGON -> zone.polygon.forEach { p ->
                    if (p.lat < minLat) minLat = p.lat
                    if (p.lat > maxLat) maxLat = p.lat
                    if (p.lng < minLng) minLng = p.lng
                    if (p.lng > maxLng) maxLng = p.lng
                }
                ZoneShape.CIRCLE -> {
                    val center = zone.center ?: return@forEach
                    val radius = zone.radiusMeters ?: return@forEach
                    val (latDelta, lngDelta) = circleDeltas(center.lat, radius)
                    val cMinLat = center.lat - latDelta
                    val cMaxLat = center.lat + latDelta
                    val cMinLng = center.lng - lngDelta
                    val cMaxLng = center.lng + lngDelta
                    if (cMinLat < minLat) minLat = cMinLat
                    if (cMaxLat > maxLat) maxLat = cMaxLat
                    if (cMinLng < minLng) minLng = cMinLng
                    if (cMaxLng > maxLng) maxLng = cMaxLng
                }
                ZoneShape.UNKNOWN -> Unit
            }
        }

        if (minLat == Double.POSITIVE_INFINITY || maxLat == Double.NEGATIVE_INFINITY) return null
        if (minLng == Double.POSITIVE_INFINITY || maxLng == Double.NEGATIVE_INFINITY) return null

        // Clamp final por defensa: no debiera salir de rango porque las zonas
        // ya estan saneadas, pero los deltas del circulo podrian acercarse
        // a los bordes.
        return SanitizedBoundingBox(
            minLat = minLat.coerceIn(-90.0, 90.0),
            maxLat = maxLat.coerceIn(-90.0, 90.0),
            minLng = minLng.coerceIn(-180.0, 180.0),
            maxLng = maxLng.coerceIn(-180.0, 180.0),
        )
    }

    private fun circleDeltas(centerLat: Double, radiusMeters: Double): Pair<Double, Double> {
        val latDelta = radiusMeters / LATITUDE_DEGREE_METERS
        val lngDegreeMeters = LATITUDE_DEGREE_METERS * cos(centerLat * PI / 180.0)
        val lngDelta = if (lngDegreeMeters > 0.0) radiusMeters / lngDegreeMeters else latDelta
        return latDelta to lngDelta
    }
}
