package ui.session

data class BusinessColorPalette(
    val backgroundPrimary: String = DEFAULT_BACKGROUND_PRIMARY,
    val screenBackground: String = DEFAULT_SCREEN_BACKGROUND,
    val primaryButton: String = DEFAULT_PRIMARY_BUTTON,
    val secondaryButton: String = DEFAULT_SECONDARY_BUTTON,
    val labelText: String = DEFAULT_LABEL_TEXT,
    val inputBackground: String = DEFAULT_INPUT_BACKGROUND,
    val headerBackground: String = DEFAULT_HEADER_BACKGROUND
) {
    fun toMap(): Map<String, String> = mapOf(
        KEY_BACKGROUND_PRIMARY to backgroundPrimary,
        KEY_SCREEN_BACKGROUND to screenBackground,
        KEY_PRIMARY_BUTTON to primaryButton,
        KEY_SECONDARY_BUTTON to secondaryButton,
        KEY_LABEL_TEXT to labelText,
        KEY_INPUT_BACKGROUND to inputBackground,
        KEY_HEADER_BACKGROUND to headerBackground
    )

    fun update(key: String, value: String): BusinessColorPalette = when (key) {
        KEY_BACKGROUND_PRIMARY -> copy(backgroundPrimary = value)
        KEY_SCREEN_BACKGROUND -> copy(screenBackground = value)
        KEY_PRIMARY_BUTTON -> copy(primaryButton = value)
        KEY_SECONDARY_BUTTON -> copy(secondaryButton = value)
        KEY_LABEL_TEXT -> copy(labelText = value)
        KEY_INPUT_BACKGROUND -> copy(inputBackground = value)
        KEY_HEADER_BACKGROUND -> copy(headerBackground = value)
        else -> this
    }

    fun normalized(): BusinessColorPalette = copy(
        backgroundPrimary = backgroundPrimary.normalizedHex(DEFAULT_BACKGROUND_PRIMARY),
        screenBackground = screenBackground.normalizedHex(DEFAULT_SCREEN_BACKGROUND),
        primaryButton = primaryButton.normalizedHex(DEFAULT_PRIMARY_BUTTON),
        secondaryButton = secondaryButton.normalizedHex(DEFAULT_SECONDARY_BUTTON),
        labelText = labelText.normalizedHex(DEFAULT_LABEL_TEXT),
        inputBackground = inputBackground.normalizedHex(DEFAULT_INPUT_BACKGROUND),
        headerBackground = headerBackground.normalizedHex(DEFAULT_HEADER_BACKGROUND)
    )

    companion object {
        const val KEY_BACKGROUND_PRIMARY = "backgroundPrimary"
        const val KEY_SCREEN_BACKGROUND = "screenBackground"
        const val KEY_PRIMARY_BUTTON = "primaryButton"
        const val KEY_SECONDARY_BUTTON = "secondaryButton"
        const val KEY_LABEL_TEXT = "labelText"
        const val KEY_INPUT_BACKGROUND = "inputBackground"
        const val KEY_HEADER_BACKGROUND = "headerBackground"

        private const val DEFAULT_BACKGROUND_PRIMARY = "#F9F9FF"
        private const val DEFAULT_SCREEN_BACKGROUND = "#EDEDF4"
        private const val DEFAULT_PRIMARY_BUTTON = "#415F91"
        private const val DEFAULT_SECONDARY_BUTTON = "#565F71"
        private const val DEFAULT_LABEL_TEXT = "#191C20"
        private const val DEFAULT_INPUT_BACKGROUND = "#FFFFFF"
        private const val DEFAULT_HEADER_BACKGROUND = "#D6E3FF"

        fun fromMap(colors: Map<String, String>?): BusinessColorPalette {
            if (colors == null) return BusinessColorPalette()
            return BusinessColorPalette(
                backgroundPrimary = colors[KEY_BACKGROUND_PRIMARY]?.normalizedHex(DEFAULT_BACKGROUND_PRIMARY)
                    ?: DEFAULT_BACKGROUND_PRIMARY,
                screenBackground = colors[KEY_SCREEN_BACKGROUND]?.normalizedHex(DEFAULT_SCREEN_BACKGROUND)
                    ?: DEFAULT_SCREEN_BACKGROUND,
                primaryButton = colors[KEY_PRIMARY_BUTTON]?.normalizedHex(DEFAULT_PRIMARY_BUTTON)
                    ?: DEFAULT_PRIMARY_BUTTON,
                secondaryButton = colors[KEY_SECONDARY_BUTTON]?.normalizedHex(DEFAULT_SECONDARY_BUTTON)
                    ?: DEFAULT_SECONDARY_BUTTON,
                labelText = colors[KEY_LABEL_TEXT]?.normalizedHex(DEFAULT_LABEL_TEXT)
                    ?: DEFAULT_LABEL_TEXT,
                inputBackground = colors[KEY_INPUT_BACKGROUND]?.normalizedHex(DEFAULT_INPUT_BACKGROUND)
                    ?: DEFAULT_INPUT_BACKGROUND,
                headerBackground = colors[KEY_HEADER_BACKGROUND]?.normalizedHex(DEFAULT_HEADER_BACKGROUND)
                    ?: DEFAULT_HEADER_BACKGROUND
            )
        }
    }
}

private fun String.normalizedHex(default: String): String {
    val trimmed = trim()
    if (trimmed.isEmpty()) return default
    val value = if (trimmed.startsWith("#")) trimmed.substring(1) else trimmed
    val isValid = value.length == 6 && value.all { it.lowercaseChar() in '0'..'9' || it.lowercaseChar() in 'a'..'f' }
    return if (isValid) "#${value.uppercase()}" else default
}
