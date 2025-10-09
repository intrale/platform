package ext.branding

import ext.storage.ResourceCache

class ResourceCacheManager(
    private val cache: ResourceCache = ResourceCache()
) {
    fun loadOrNull(key: String, expectedHash: String?): ResourceCache.CachedResource? {
        val cached = cache.load(key) ?: return null
        return if (expectedHash == null || cached.hash == expectedHash) cached else null
    }

    fun save(key: String, bytes: ByteArray, hash: String) {
        cache.save(key, bytes, hash)
    }

    fun evict(key: String) {
        cache.evict(key)
    }

    fun clear() {
        cache.clear()
    }
}
