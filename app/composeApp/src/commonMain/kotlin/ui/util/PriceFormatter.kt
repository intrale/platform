package ui.util

import kotlin.text.format

fun formatPrice(value: Double, unit: String? = null): String {
    val normalizedUnit = unit?.takeIf { it.isNotBlank() }.orEmpty()
    val formatted = "%,.2f".format(value)
    return if (normalizedUnit.isBlank()) {
        "$$formatted"
    } else {
        "$$formatted / $normalizedUnit"
    }
}
