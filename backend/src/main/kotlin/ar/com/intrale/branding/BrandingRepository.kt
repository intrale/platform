package ar.com.intrale.branding

import java.time.Instant

interface BrandingRepository {
    fun putDraft(theme: BrandingTheme, allowOverwrite: Boolean = false)

    fun getPublishedTheme(businessId: String): BrandingTheme?

    fun getTheme(businessId: String, version: Int): BrandingTheme?

    fun listDrafts(businessId: String): List<BrandingTheme>

    fun publishTheme(businessId: String, version: Int, userId: String, timestamp: Instant)

    fun rollbackToVersion(businessId: String, targetVersion: Int, userId: String, timestamp: Instant)
}
