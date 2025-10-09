package ext.branding

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ResourceCacheManagerTest {
    @Test
    fun `returns cached resource when hash matches`() {
        val manager = ResourceCacheManager()
        manager.save("logo", byteArrayOf(1, 2, 3), "hash-1")

        val cached = manager.loadOrNull("logo", "hash-1")

        assertEquals("hash-1", cached?.hash)
    }

    @Test
    fun `evicts cache entries`() {
        val manager = ResourceCacheManager()
        manager.save("logo", byteArrayOf(1, 2, 3), "hash-1")
        manager.evict("logo")

        val cached = manager.loadOrNull("logo", null)

        assertNull(cached)
    }
}
