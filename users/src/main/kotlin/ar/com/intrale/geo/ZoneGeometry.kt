package ar.com.intrale.geo

/**
 * Helpers de alto nivel para evaluar si un punto cae dentro de una zona
 * (POLYGON o CIRCLE).
 */
object ZoneGeometry {

    /**
     * Devuelve true si el punto esta dentro de un poligono o de un circulo.
     */
    fun isPointInPolygon(polygon: List<Vertex>, point: Vertex): Boolean =
        PointInPolygon.contains(polygon, point)

    /**
     * Punto dentro de un circulo. Convencion: distancia exactamente = radio se
     * considera DENTRO (consistente con la convencion de borde para poligonos).
     */
    fun isPointInCircle(centerLat: Double, centerLng: Double, radiusMeters: Double, point: Vertex): Boolean {
        val center = Vertex(centerLat, centerLng)
        val distance = haversineMeters(center, point)
        return distance <= radiusMeters
    }
}
