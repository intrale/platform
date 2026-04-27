package ui.sc.business.zones

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Tests del helper interno formatZoneCost (#2420 UX seccion 12 — copy argentino).
 *
 * Reglas:
 * - 0 -> "Gratis" (UX seccion 11 edge case)
 * - $ <numero> con punto separador miles, sin decimales (UX seccion 12)
 */
class FormatZoneCostTest {

    @Test
    fun `cost 0 muestra Gratis`() {
        assertEquals("Gratis", formatZoneCost(0L))
    }

    @Test
    fun `cost 1500 pesos formatea con separador miles argentino`() {
        // 1500 pesos = 150_000 centavos
        assertEquals("$ 1.500", formatZoneCost(1_500_00L))
    }

    @Test
    fun `cost 100 pesos sin separador`() {
        assertEquals("$ 100", formatZoneCost(100_00L))
    }

    @Test
    fun `cost grande 12345 pesos`() {
        assertEquals("$ 12.345", formatZoneCost(12_345_00L))
    }

    @Test
    fun `cost 1 millon`() {
        // 1.000.000 pesos = 100_000_000 centavos
        assertEquals("$ 1.000.000", formatZoneCost(100_000_000L))
    }
}
