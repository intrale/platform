package ar.com.intrale.branding

data class BrandingAsset(
    val assetId: String,
    val assetType: String,
    val uri: String,
    val metadata: Map<String, String> = emptyMap()
)
