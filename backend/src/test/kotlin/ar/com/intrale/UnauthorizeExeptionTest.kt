package ar.com.intrale

import io.ktor.http.HttpStatusCode
import ar.com.intrale.Response
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class UnauthorizeExeptionTest {
    @Test
    fun returnsUnauthorized() {
        val ex = UnauthorizedException()
        assertEquals(HttpStatusCode.Unauthorized, ex.statusCode)
    }

    @Test
    fun isSubclassOfResponse() {
        val ex = UnauthorizedException()
        assertTrue(ex is Response)
    }
}
