package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertNotNull

class RequestTest {
    @Test
    fun canInstantiate() {
        val req = Request()
        assertNotNull(req)
    }
}
