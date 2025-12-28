package ui.util

import kotlin.math.abs
import kotlin.math.roundToInt

fun formatPrice(value: Double, unit: String? = null): String {
    val normalizedUnit = unit?.takeIf { it.isNotBlank() }.orEmpty()
    val formatted = value.toTwoDecimals()
    return if (normalizedUnit.isBlank()) {
        "$$formatted"
    } else {
        "$$formatted / $normalizedUnit"
    }
}

private fun Double.toTwoDecimals(): String {
    val scaled = (this * 100).roundToInt()
    val integerPart = scaled / 100
    val decimalPart = abs(scaled % 100)
    return buildString {
        append(integerPart)
        append('.')
        append(decimalPart.toString().padStart(2, '0'))
    }
}
