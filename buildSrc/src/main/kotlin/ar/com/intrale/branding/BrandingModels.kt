package ar.com.intrale.branding

data class BrandingEnvelope(
    val version: Int,
    val schemaVersion: Int,
    val payload: BrandingConfigMinimal
)

data class BrandingConfigMinimal(
    val appName: String,
    val palette: BrandingPalette? = null,
    val typography: BrandingTypography? = null
)

data class BrandingPalette(
    val primary: String,
    val onPrimary: String,
    val surface: String? = null,
    val onSurface: String? = null,
    val primaryVariant: String? = null
)

data class BrandingTypography(
    val headline: String? = null,
    val body: String? = null,
    val caption: String? = null
)
