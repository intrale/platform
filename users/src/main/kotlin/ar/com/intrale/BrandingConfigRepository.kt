package ar.com.intrale

import java.util.concurrent.ConcurrentHashMap

class BrandingConfigRepository {
    private val storage = ConcurrentHashMap<String, BrandingThemePayload>()

    fun get(businessId: String): BrandingThemePayload? = storage[businessId]

    fun save(businessId: String, payload: BrandingThemePayload) {
        storage[businessId] = payload
    }
}
