package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals

class RequestValidationExceptionTest {
    @Test
    fun returnsBadRequest() {
        val ex = RequestValidationException("invalid")
        assertEquals(HttpStatusCode.BadRequest, ex.statusCode)
        assertEquals("invalid", ex.message)
    }
}
