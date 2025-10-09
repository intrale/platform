package ext.storage

class ResourceCache {
    private val store = mutableMapOf<String, CachedResource>()

    fun load(key: String): CachedResource? = store[key]

    fun save(key: String, content: ByteArray, hash: String) {
        store[key] = CachedResource(content, hash)
    }

    fun evict(key: String) {
        store.remove(key)
    }

    fun clear() {
        store.clear()
    }

    data class CachedResource(
        val bytes: ByteArray,
        val hash: String
    )
}
