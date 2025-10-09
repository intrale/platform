package ext.dto

import kotlinx.serialization.Serializable

@Serializable
data class BrandingPaletteDto(
    val primary: String = "#0053F4",
    val secondary: String = "#09101D",
    val background: String = "#FFFFFF"
)

@Serializable
data class BrandingAssetsDto(
    val logoUrl: String? = null,
    val splashImageUrl: String? = null
)

@Serializable
data class BrandingThemeDto(
    val typography: String = "Inter",
    val palette: BrandingPaletteDto = BrandingPaletteDto(),
    val assets: BrandingAssetsDto = BrandingAssetsDto(),
    val updatedAtIso: String? = null
)
