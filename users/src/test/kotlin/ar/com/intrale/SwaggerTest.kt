package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class SwaggerTest {
    @Test
    fun `archivo openapi existe y no esta vacio`() {
        val resource = this::class.java.classLoader.getResource("openapi.yaml")
        assertNotNull(resource)
        val text = resource.readText()
        assertTrue(text.isNotBlank())
    }
}
