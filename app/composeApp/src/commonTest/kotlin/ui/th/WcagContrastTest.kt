package ui.th

import kotlin.math.pow
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Verifica que los pares de colores del tema Intrale usados en el Dashboard
 * cumplan el ratio de contraste WCAG AA (mínimo 4.5:1 para texto normal).
 *
 * Referencia: https://www.w3.org/TR/WCAG21/#contrast-minimum
 */
class WcagContrastTest {

    // ------------------------------------------------------------------
    // Colores del tema (hexadecimal 0xAARRGGBB — solo tomamos RGB)
    // ------------------------------------------------------------------

    // Fondos
    private val surfaceLight         = 0xFFF9F9FFL
    private val backgroundLight      = 0xFFF9F9FFL

    // Textos sobre superficie/fondo (light)
    private val onSurfaceLight       = 0xFF191C20L
    private val onSurfaceVariantLight = 0xFF44474EL
    private val primaryLight         = 0xFF415F91L
    private val onBackgroundLight    = 0xFF191C20L

    // Textos sobre superficie (dark)
    private val surfaceDark          = 0xFF111318L
    private val onSurfaceDark        = 0xFFE2E2E9L
    private val onSurfaceVariantDark  = 0xFFC4C6D0L
    private val primaryDark          = 0xFFAAC7FFL

    // ------------------------------------------------------------------
    // Tests light theme
    // ------------------------------------------------------------------

    @Test
    fun `onSurface sobre surface light cumple WCAG AA`() {
        val ratio = contrastRatio(onSurfaceLight, surfaceLight)
        assertTrue(ratio >= 4.5, "onSurface/surface light: $ratio (esperado >= 4.5:1)")
    }

    @Test
    fun `onBackground sobre background light cumple WCAG AA`() {
        val ratio = contrastRatio(onBackgroundLight, backgroundLight)
        assertTrue(ratio >= 4.5, "onBackground/background light: $ratio (esperado >= 4.5:1)")
    }

    @Test
    fun `onSurfaceVariant sobre surface light cumple WCAG AA`() {
        val ratio = contrastRatio(onSurfaceVariantLight, surfaceLight)
        assertTrue(ratio >= 4.5, "onSurfaceVariant/surface light: $ratio (esperado >= 4.5:1)")
    }

    @Test
    fun `primary sobre surface light cumple WCAG AA`() {
        val ratio = contrastRatio(primaryLight, surfaceLight)
        assertTrue(ratio >= 4.5, "primary/surface light: $ratio (esperado >= 4.5:1)")
    }

    // ------------------------------------------------------------------
    // Tests dark theme
    // ------------------------------------------------------------------

    @Test
    fun `onSurface sobre surface dark cumple WCAG AA`() {
        val ratio = contrastRatio(onSurfaceDark, surfaceDark)
        assertTrue(ratio >= 4.5, "onSurface/surface dark: $ratio (esperado >= 4.5:1)")
    }

    @Test
    fun `onSurfaceVariant sobre surface dark cumple WCAG AA`() {
        val ratio = contrastRatio(onSurfaceVariantDark, surfaceDark)
        assertTrue(ratio >= 4.5, "onSurfaceVariant/surface dark: $ratio (esperado >= 4.5:1)")
    }

    @Test
    fun `primary sobre surface dark cumple WCAG AA`() {
        val ratio = contrastRatio(primaryDark, surfaceDark)
        assertTrue(ratio >= 4.5, "primary/surface dark: $ratio (esperado >= 4.5:1)")
    }

    // ------------------------------------------------------------------
    // Utilidades WCAG
    // ------------------------------------------------------------------

    /**
     * Calcula el ratio de contraste entre dos colores (foreground / background).
     * Fórmula: (L1 + 0.05) / (L2 + 0.05) donde L1 >= L2.
     */
    private fun contrastRatio(fg: Long, bg: Long): Double {
        val l1 = relativeLuminance(fg)
        val l2 = relativeLuminance(bg)
        val lighter = maxOf(l1, l2) + 0.05
        val darker  = minOf(l1, l2) + 0.05
        return lighter / darker
    }

    /**
     * Luminancia relativa según WCAG 2.1.
     * Extrae R, G, B del color en formato 0xFFRRGGBB.
     */
    private fun relativeLuminance(colorLong: Long): Double {
        val r = ((colorLong shr 16) and 0xFF).toDouble() / 255.0
        val g = ((colorLong shr 8)  and 0xFF).toDouble() / 255.0
        val b = (colorLong          and 0xFF).toDouble() / 255.0
        return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
    }

    /**
     * Convierte canal sRGB a lineal según IEC 61966-2-1.
     */
    private fun linearize(c: Double): Double =
        if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
}
