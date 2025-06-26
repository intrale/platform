package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals

class ExceptionResponseTest {
    @Test
    fun returnsInternalServerError() {
        val resp = ExceptionResponse("boom")
        assertEquals(HttpStatusCode.InternalServerError, resp.statusCode)
        assertEquals("boom", resp.message)
    }
}
