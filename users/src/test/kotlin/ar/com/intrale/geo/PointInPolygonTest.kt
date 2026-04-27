package ar.com.intrale.geo

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PointInPolygonTest {

    private val square = listOf(
        Vertex(0.0, 0.0),
        Vertex(0.0, 10.0),
        Vertex(10.0, 10.0),
        Vertex(10.0, 0.0),
    )

    private val concave = listOf(
        // Forma de L
        Vertex(0.0, 0.0),
        Vertex(0.0, 10.0),
        Vertex(5.0, 10.0),
        Vertex(5.0, 5.0),
        Vertex(10.0, 5.0),
        Vertex(10.0, 0.0),
    )

    @Test
    fun `punto dentro de un cuadrado se considera DENTRO`() {
        assertTrue(PointInPolygon.contains(square, Vertex(5.0, 5.0)))
    }

    @Test
    fun `punto fuera de un cuadrado se considera FUERA`() {
        assertFalse(PointInPolygon.contains(square, Vertex(15.0, 5.0)))
    }

    @Test
    fun `punto exactamente sobre un vertice se considera DENTRO`() {
        assertTrue(PointInPolygon.contains(square, Vertex(0.0, 0.0)))
        assertTrue(PointInPolygon.contains(square, Vertex(10.0, 10.0)))
    }

    @Test
    fun `punto exactamente sobre una arista se considera DENTRO`() {
        assertTrue(PointInPolygon.contains(square, Vertex(0.0, 5.0)))
        assertTrue(PointInPolygon.contains(square, Vertex(5.0, 0.0)))
        assertTrue(PointInPolygon.contains(square, Vertex(10.0, 5.0)))
    }

    @Test
    fun `punto en el hueco de un poligono concavo se considera FUERA`() {
        // El hueco de la L esta en (>5, >5)
        assertFalse(PointInPolygon.contains(concave, Vertex(8.0, 8.0)))
    }

    @Test
    fun `punto en el brazo de un poligono concavo se considera DENTRO`() {
        assertTrue(PointInPolygon.contains(concave, Vertex(2.0, 8.0)))
        assertTrue(PointInPolygon.contains(concave, Vertex(8.0, 2.0)))
    }

    @Test
    fun `bounding box descarta puntos fuera del rango sin recorrer vertices`() {
        // El cuadrado esta en [0,10] x [0,10]; el punto (-5,-5) deberia salir rapido
        assertFalse(PointInPolygon.contains(square, Vertex(-5.0, -5.0)))
    }

    @Test
    fun `poligono auto-intersectante tipo bowtie se detecta`() {
        val bowtie = listOf(
            Vertex(0.0, 0.0),
            Vertex(0.0, 10.0),
            Vertex(10.0, 0.0),
            Vertex(10.0, 10.0),
        )
        assertTrue(PointInPolygon.isSelfIntersecting(bowtie))
    }

    @Test
    fun `poligono simple no se detecta como auto-intersectante`() {
        assertFalse(PointInPolygon.isSelfIntersecting(square))
        assertFalse(PointInPolygon.isSelfIntersecting(concave))
    }

    @Test
    fun `poligono degenerado con area cero (puntos colineales) se detecta`() {
        val colinear = listOf(
            Vertex(0.0, 0.0),
            Vertex(0.0, 5.0),
            Vertex(0.0, 10.0),
        )
        // El area absoluta debe ser 0 (o casi 0)
        assertTrue(PointInPolygon.absoluteShoelaceArea(colinear) < 1e-9)
    }

    @Test
    fun `bounding box de un poligono se calcula correctamente`() {
        val bb = BoundingBox.ofPolygon(square)
        assertEquals(0.0, bb.minLat)
        assertEquals(10.0, bb.maxLat)
        assertEquals(0.0, bb.minLng)
        assertEquals(10.0, bb.maxLng)
    }

    @Test
    fun `redondeo a 6 decimales trunca correctamente coordenadas con precision excesiva`() {
        assertEquals(40.712801, round6(40.71280123456))
        assertEquals(-73.123457, round6(-73.12345678))
        assertEquals(-34.603700, round6(-34.6037000123))
    }
}
