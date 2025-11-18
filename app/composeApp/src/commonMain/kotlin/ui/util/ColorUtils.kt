package ui.util

import androidx.compose.ui.graphics.Color
import kotlin.math.roundToInt

private val HEX_REGEX = Regex("^#[0-9a-fA-F]{6}$")

fun String.toColorOrNull(): Color? {
    if (!HEX_REGEX.matches(this)) return null
    val value = substring(1).toIntOrNull(16) ?: return null
    val red = ((value shr 16) and 0xFF) / 255f
    val green = ((value shr 8) and 0xFF) / 255f
    val blue = (value and 0xFF) / 255f
    return Color(red = red, green = green, blue = blue, alpha = 1f)
}

fun Color.toHexString(): String {
    val r = (red * 255).roundToInt().coerceIn(0, 255)
    val g = (green * 255).roundToInt().coerceIn(0, 255)
    val b = (blue * 255).roundToInt().coerceIn(0, 255)
    return buildString(7) {
        append('#')
        append(r.toString(16).padStart(2, '0').uppercase())
        append(g.toString(16).padStart(2, '0').uppercase())
        append(b.toString(16).padStart(2, '0').uppercase())
    }
}

fun String?.normalizedHexOr(default: String): String {
    val value = this?.trim().orEmpty()
    if (value.isEmpty()) return default
    val normalized = if (value.startsWith("#")) value else "#$value"
    return if (HEX_REGEX.matches(normalized)) normalized.uppercase() else default
}
