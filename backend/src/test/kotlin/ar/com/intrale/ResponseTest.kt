package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals

class ResponseTest {
    @Test
    fun defaultStatusIsOk() {
        val resp = Response()
        assertEquals(HttpStatusCode.OK, resp.statusCode)
    }

    @Test
    fun customStatusIsRespected() {
        val resp = Response(HttpStatusCode.BadRequest)
        assertEquals(HttpStatusCode.BadRequest, resp.statusCode)
    }

    @Test
    fun nullStatusIsAccepted() {
        val resp = Response(null)
        assertEquals(null, resp.statusCode)
    }
}
