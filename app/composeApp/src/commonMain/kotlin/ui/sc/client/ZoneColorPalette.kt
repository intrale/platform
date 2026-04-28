package ui.sc.client

import androidx.compose.ui.graphics.Color

/**
 * Paleta daltonic-safe de hasta 6 colores (UX-3 del issue #2423).
 *
 * Cumple WCAG AA sobre tile claro de OSMDroid. Si hay >6 zonas se
 * recicla la paleta — la lista textual y los chips ayudan a desambiguar.
 */
object ZoneColorPalette {
    val colors: List<Color> = listOf(
        Color(0xFF1F77B4), // azul acero
        Color(0xFFFF7F0E), // naranja
        Color(0xFF2CA02C), // verde bosque
        Color(0xFFD62728), // rojo ladrillo
        Color(0xFF9467BD), // violeta
        Color(0xFF8C564B), // marron
    )

    fun colorFor(index: Int): Color = colors[index.mod(colors.size)]

    fun colorsFor(count: Int): List<Color> = List(count) { colorFor(it) }
}
