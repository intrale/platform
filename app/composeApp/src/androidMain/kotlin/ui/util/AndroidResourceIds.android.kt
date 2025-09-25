package ui.util

import ar.com.intrale.R

actual fun androidStringId(name: String): Int? {
    return runCatching {
        val field = R.string::class.java.getDeclaredField(name)
        field.getInt(null)
    }.getOrNull()
}
