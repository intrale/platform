package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals

class BrandingResourceTest {
    @Test
    fun `stores metadata`() {
        val resource = BrandingResource(id = "logo", hash = "hash-1", contentType = "image/svg+xml")

        assertEquals("logo", resource.id)
        assertEquals("hash-1", resource.hash)
    }
}
