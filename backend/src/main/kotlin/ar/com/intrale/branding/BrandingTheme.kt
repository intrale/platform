package ar.com.intrale.branding

import java.time.Instant

data class BrandingTheme(
    val businessId: String,
    val version: Int,
    val status: ThemeStatus,
    val metadata: Map<String, String>,
    val assets: List<BrandingAsset>,
    val updatedAt: Instant,
    val publishedAt: Instant? = null,
    val publishedBy: String? = null
) {
    init {
        require(businessId.isNotBlank()) { "El businessId no puede ser vacío" }
        require(version > 0) { "La versión debe ser positiva" }
    }

    fun isDraft(): Boolean = status == ThemeStatus.DRAFT

    fun asPublished(timestamp: Instant, userId: String): BrandingTheme = copy(
        status = ThemeStatus.PUBLISHED,
        publishedAt = timestamp,
        publishedBy = userId,
        updatedAt = timestamp
    )

    fun asDraft(timestamp: Instant): BrandingTheme = copy(
        status = ThemeStatus.DRAFT,
        updatedAt = timestamp,
        publishedAt = null,
        publishedBy = null
    )
}
