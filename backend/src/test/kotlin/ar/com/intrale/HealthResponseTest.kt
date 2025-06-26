package ar.com.intrale

import io.ktor.http.*
import kotlin.test.Test
import kotlin.test.assertEquals

class HealthResponseTest {
    @Test
    fun defaultValuesAreOk() {
        val resp = HealthResponse()
        assertEquals(HttpStatusCode.OK, resp.statusCode)
        assertEquals("UP", resp.status)
    }
}
