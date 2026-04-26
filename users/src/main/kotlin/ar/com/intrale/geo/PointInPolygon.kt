package ar.com.intrale.geo

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Algoritmos geometricos puros (sin dependencias externas) para verificar
 * cobertura de zonas de delivery.
 *
 * Decisiones de diseno (ver issue #2415):
 * - Ray casting con epsilon para puntos sobre vertice/arista → se consideran DENTRO.
 * - Filtro previo por bounding box AABB (O(1)) antes del ray casting (O(V)).
 * - Sin libs (jts, geotools, spatial4j) — implementacion en Kotlin puro.
 */
object PointInPolygon {

    private const val EPSILON = 1e-9

    /**
     * Verifica si un punto cae dentro de un poligono (ray casting + AABB).
     * Convencion: borde y vertice se consideran DENTRO.
     */
    fun contains(polygon: List<Vertex>, point: Vertex): Boolean {
        require(polygon.size >= 3) { "el poligono debe tener al menos 3 vertices" }

        // Filtro AABB
        val bb = BoundingBox.ofPolygon(polygon)
        if (!bb.contains(point)) return false

        // Caso punto sobre vertice
        for (v in polygon) {
            if (abs(v.lat - point.lat) < EPSILON && abs(v.lng - point.lng) < EPSILON) {
                return true
            }
        }

        // Caso punto sobre arista
        val n = polygon.size
        for (i in 0 until n) {
            val a = polygon[i]
            val b = polygon[(i + 1) % n]
            if (pointOnSegment(a, b, point)) return true
        }

        // Ray casting (rayo horizontal hacia +lng infinito)
        var inside = false
        var j = n - 1
        for (i in 0 until n) {
            val pi = polygon[i]
            val pj = polygon[j]
            val intersect = ((pi.lat > point.lat) != (pj.lat > point.lat)) &&
                (point.lng < (pj.lng - pi.lng) * (point.lat - pi.lat) / (pj.lat - pi.lat) + pi.lng)
            if (intersect) inside = !inside
            j = i
        }
        return inside
    }

    /**
     * Detecta si un poligono se auto-intersecta (algoritmo O(n^2) — aceptable
     * con maxVertices = 1000).
     */
    fun isSelfIntersecting(polygon: List<Vertex>): Boolean {
        val n = polygon.size
        if (n < 4) return false
        for (i in 0 until n) {
            val a1 = polygon[i]
            val a2 = polygon[(i + 1) % n]
            for (j in i + 1 until n) {
                // Ignorar segmentos adyacentes que comparten vertice
                if (j == i + 1) continue
                if (i == 0 && j == n - 1) continue
                val b1 = polygon[j]
                val b2 = polygon[(j + 1) % n]
                if (segmentsIntersect(a1, a2, b1, b2)) return true
            }
        }
        return false
    }

    /**
     * Calcula el area absoluta de un poligono usando la formula del shoelace.
     * Para detectar poligonos degenerados (colineales / area ~ 0).
     * Las unidades son grados al cuadrado (no metros), suficiente para detectar
     * poligonos triviales.
     */
    fun absoluteShoelaceArea(polygon: List<Vertex>): Double {
        val n = polygon.size
        if (n < 3) return 0.0
        var sum = 0.0
        for (i in 0 until n) {
            val a = polygon[i]
            val b = polygon[(i + 1) % n]
            sum += (a.lng * b.lat) - (b.lng * a.lat)
        }
        return abs(sum) / 2.0
    }

    private fun pointOnSegment(a: Vertex, b: Vertex, p: Vertex): Boolean {
        val cross = (p.lat - a.lat) * (b.lng - a.lng) - (p.lng - a.lng) * (b.lat - a.lat)
        if (abs(cross) > EPSILON) return false
        val withinLng = p.lng in min(a.lng, b.lng) - EPSILON..max(a.lng, b.lng) + EPSILON
        val withinLat = p.lat in min(a.lat, b.lat) - EPSILON..max(a.lat, b.lat) + EPSILON
        return withinLng && withinLat
    }

    private fun segmentsIntersect(a1: Vertex, a2: Vertex, b1: Vertex, b2: Vertex): Boolean {
        val d1 = direction(b1, b2, a1)
        val d2 = direction(b1, b2, a2)
        val d3 = direction(a1, a2, b1)
        val d4 = direction(a1, a2, b2)

        if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
            ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
        ) {
            return true
        }
        // Casos colineales: ignoramos (un vertice sobre la otra arista no se
        // considera auto-interseccion para no rechazar poligonos valido con
        // vertices redundantes; queda cubierto por absoluteShoelaceArea).
        return false
    }

    private fun direction(a: Vertex, b: Vertex, c: Vertex): Double =
        (c.lng - a.lng) * (b.lat - a.lat) - (b.lng - a.lng) * (c.lat - a.lat)
}
