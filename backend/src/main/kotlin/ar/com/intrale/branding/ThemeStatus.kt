package ar.com.intrale.branding

enum class ThemeStatus {
    DRAFT,
    PUBLISHED;

    companion object {
        fun from(value: String): ThemeStatus = entries.firstOrNull { it.name.equals(value, ignoreCase = true) }
            ?: throw IllegalArgumentException("Estado de tema desconocido: $value")
    }
}
