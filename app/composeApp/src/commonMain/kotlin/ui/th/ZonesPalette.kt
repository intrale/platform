package ui.th

import androidx.compose.ui.graphics.Color
import kotlin.math.pow

/**
 * Paleta de 10 colores para zonas de delivery — split 1 #2420 (CA-4-L).
 *
 * Definida en la seccion 6 del analisis UX (criterios). Se asigna por indice
 * de creacion modulo 10. La 11ava zona reusa color 0 (consideracion #2421).
 *
 * - `light` / `dark`: color base (100% opacidad) para light vs dark theme.
 * - `fillAlpha`: 0.35f por spec (CA-4-L "Fill al 35% opacidad").
 * - `strokeAlpha`: 1.0f por spec ("stroke al 100%").
 * - El stroke se renderea como variante oscura del color base — cumple WCAG AA
 *   (>= 3:1 contraste contra blanco light y contra `#1A1A1A` del map_style_dark).
 *
 * NOTA: NO usar `androidx.compose.ui.graphics.Color` para fines fuera de UI.
 * Esta paleta es UI-only; la asignacion de indice <-> color es deterministica
 * para que el chip de la lista coincida con el polygon en el mapa (CA-3-L).
 */
data class ZoneColor(
    val light: Color,
    val dark: Color,
    val strokeLight: Color,
    val strokeDark: Color
) {
    companion object {
        const val FILL_ALPHA: Float = 0.35f
        const val STROKE_ALPHA: Float = 1.0f
    }
}

object ZonesPalette {

    /**
     * 10 colores en el orden exacto definido por la spec UX (#2420 CA-4-L,
     * seccion 6 del analisis UX): azul Intrale, coral, violeta, verde azulado,
     * ambar, rosa, indigo, lima oscuro, naranja oscuro, gris azulado.
     *
     * Stroke de cada color = variante 200 mas oscura (WCAG AA verificado).
     */
    // Convencion de strokes (CA-4-L de #2420):
    //
    // - strokeLight: variante 800-900 del color base (mas oscura que el fill).
    //   Garantiza contraste >= 3:1 contra el background blanco del light theme,
    //   donde el polygon se rendere a 35% alpha sobre mapa estilo claro.
    //
    // - strokeDark: variante 200-300 del color base (mas clara que el fill).
    //   En el dark mode el mapa usa #1A1A1A como base — un stroke oscuro queda
    //   indistinguible. Material Design recomienda usar tonos 200 para emphasis
    //   en superficies oscuras. Cada strokeDark cumple WCAG AA 3:1 vs #1A1A1A.
    val colors: List<ZoneColor> = listOf(
        // 0 - Azul Intrale
        ZoneColor(
            light = Color(0xFF1E88E5),
            dark = Color(0xFF64B5F6),
            strokeLight = Color(0xFF0D47A1),
            strokeDark = Color(0xFF90CAF9)
        ),
        // 1 - Coral
        ZoneColor(
            light = Color(0xFFFF7043),
            dark = Color(0xFFFF8A65),
            strokeLight = Color(0xFFBF360C),
            strokeDark = Color(0xFFFFAB91)
        ),
        // 2 - Violeta
        ZoneColor(
            light = Color(0xFF8E24AA),
            dark = Color(0xFFBA68C8),
            strokeLight = Color(0xFF4A148C),
            strokeDark = Color(0xFFCE93D8)
        ),
        // 3 - Verde azulado (teal)
        ZoneColor(
            light = Color(0xFF00897B),
            dark = Color(0xFF4DB6AC),
            strokeLight = Color(0xFF004D40),
            strokeDark = Color(0xFF80CBC4)
        ),
        // 4 - Ambar (strokeLight a Orange 900 para superar 3:1 vs blanco)
        ZoneColor(
            light = Color(0xFFFFB300),
            dark = Color(0xFFFFD54F),
            strokeLight = Color(0xFFE65100),
            strokeDark = Color(0xFFFFE082)
        ),
        // 5 - Rosa
        ZoneColor(
            light = Color(0xFFD81B60),
            dark = Color(0xFFF06292),
            strokeLight = Color(0xFF880E4F),
            strokeDark = Color(0xFFF48FB1)
        ),
        // 6 - Indigo
        ZoneColor(
            light = Color(0xFF3949AB),
            dark = Color(0xFF7986CB),
            strokeLight = Color(0xFF1A237E),
            strokeDark = Color(0xFF9FA8DA)
        ),
        // 7 - Lima oscuro
        ZoneColor(
            light = Color(0xFF7CB342),
            dark = Color(0xFFAED581),
            strokeLight = Color(0xFF33691E),
            strokeDark = Color(0xFFC5E1A5)
        ),
        // 8 - Naranja oscuro
        ZoneColor(
            light = Color(0xFFF4511E),
            dark = Color(0xFFFF8A65),
            strokeLight = Color(0xFFBF360C),
            strokeDark = Color(0xFFFFCCBC)
        ),
        // 9 - Gris azulado
        ZoneColor(
            light = Color(0xFF546E7A),
            dark = Color(0xFF90A4AE),
            strokeLight = Color(0xFF263238),
            strokeDark = Color(0xFFB0BEC5)
        )
    )

    val size: Int get() = colors.size

    /**
     * Asigna color por indice de creacion. Modulo size para soportar > 10 zonas
     * (CA-4-L: "colores liberados al eliminar" — implementado en split 2).
     */
    fun colorAt(index: Int): ZoneColor {
        require(index >= 0) { "El indice de zona debe ser >= 0, recibido: $index" }
        return colors[index % size]
    }
}

/**
 * Selecciona el color base segun el modo claro/oscuro del sistema.
 */
fun ZoneColor.fillFor(isDark: Boolean): Color =
    (if (isDark) dark else light).copy(alpha = ZoneColor.FILL_ALPHA)

fun ZoneColor.strokeFor(isDark: Boolean): Color =
    if (isDark) strokeDark else strokeLight

/**
 * Calcula la luminancia relativa de un color segun WCAG 2.1 (formula sRGB).
 *
 * Usada por ZonesPaletteTest para verificar contraste >= 3:1 contra los
 * backgrounds canonicos (blanco light y `#1A1A1A` dark map).
 */
fun Color.relativeLuminance(): Double {
    fun channel(c: Float): Double {
        val cs = c.toDouble()
        return if (cs <= 0.03928) cs / 12.92 else ((cs + 0.055) / 1.055).pow(2.4)
    }
    return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
}

/**
 * Ratio de contraste WCAG entre dos colores (>= 3:1 para AA con stroke gruesos).
 */
fun contrastRatio(a: Color, b: Color): Double {
    val la = a.relativeLuminance()
    val lb = b.relativeLuminance()
    val lighter = maxOf(la, lb)
    val darker = minOf(la, lb)
    return (lighter + 0.05) / (darker + 0.05)
}
