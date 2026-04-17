package shared

import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.toExceptionResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Issue #2285 — verifica que `Exception.toExceptionResponse()` sanitiza los
 * mensajes de timeout HTTP antes de propagarlos al dominio (CA-2, CA-4).
 *
 * La detecccion se hace por `simpleName` para no acoplar el modulo `shared`
 * (compartido con backend) a dependencias del cliente Ktor.
 */
class ExceptionResponseSanitizationTest {

    // Doubles locales que imitan las clases reales de Ktor por nombre.
    private class HttpRequestTimeoutException(message: String) : RuntimeException(message)
    private class HttpConnectTimeoutException(message: String) : RuntimeException(message)
    private class SocketTimeoutException(message: String) : RuntimeException(message)
    private class BusinessRuleException(message: String) : RuntimeException(message)

    @Test
    fun `toExceptionResponse sanitiza HttpRequestTimeoutException y oculta URL`() {
        val url = "https://api.intrale.com/mibusiness/signin?token=abc123"
        val ex = HttpRequestTimeoutException("Request timeout has expired [url=$url, request_timeout=30000 ms]")

        val response: ExceptionResponse = ex.toExceptionResponse()

        // CA-4: mensaje no contiene URL, query params ni "timeout" en ingles.
        val msg = response.message
        assertNotNull(msg, "message no deberia ser null")
        assertFalse(msg.contains(url), "mensaje sanitizado no debe contener la URL original: $msg")
        assertFalse(msg.contains("https://"), "mensaje no debe contener URL: $msg")
        assertFalse(msg.contains("token=abc123"), "mensaje no debe filtrar el query param: $msg")
        assertFalse(msg.contains("timeout", ignoreCase = true), "mensaje no debe contener 'timeout' en ingles: $msg")
        assertFalse(msg.contains("url=", ignoreCase = true), "mensaje no debe contener 'url=': $msg")

        // CA-2: status 408 Request Timeout.
        assertEquals(408, response.statusCode.value)
        assertEquals("Request Timeout", response.statusCode.description)
    }

    @Test
    fun `toExceptionResponse sanitiza HttpConnectTimeoutException`() {
        val ex = HttpConnectTimeoutException("Connect timeout has expired [url=https://api.intrale.com/foo, connect_timeout=15000 ms]")

        val response = ex.toExceptionResponse()

        val msg = response.message!!
        assertFalse(msg.contains("https://"))
        assertFalse(msg.contains("timeout", ignoreCase = true))
        assertEquals(408, response.statusCode.value)
    }

    @Test
    fun `toExceptionResponse sanitiza SocketTimeoutException de engine`() {
        val ex = SocketTimeoutException("Socket timeout: 30000 ms")

        val response = ex.toExceptionResponse()

        val msg = response.message!!
        assertFalse(msg.contains("timeout", ignoreCase = true))
        assertEquals(408, response.statusCode.value)
    }

    @Test
    fun `toExceptionResponse sanitiza timeout anidado como cause`() {
        val inner = HttpRequestTimeoutException("timeout [url=https://api.intrale.com/foo]")
        val outer = RuntimeException("login failed", inner)

        val response = outer.toExceptionResponse()

        val msg = response.message!!
        assertFalse(msg.contains("https://"))
        assertFalse(msg.contains("timeout", ignoreCase = true))
        assertEquals(408, response.statusCode.value)
    }

    @Test
    fun `toExceptionResponse mensaje user-facing es accionable en espanol`() {
        val ex = HttpRequestTimeoutException("Request timeout")

        val response = ex.toExceptionResponse()
        val msg = response.message!!

        assertTrue(msg.contains("servidor"), "mensaje debe mencionar servidor: $msg")
        assertTrue(msg.contains("nuevo"), "mensaje debe sugerir reintentar: $msg")
    }

    @Test
    fun `toExceptionResponse conserva mensaje original para excepciones no-timeout`() {
        val ex = BusinessRuleException("Usuario ya existe")

        val response = ex.toExceptionResponse()

        assertEquals("Usuario ya existe", response.message)
        assertEquals(500, response.statusCode.value)
    }

    @Test
    fun `toExceptionResponse usa mensaje por defecto cuando la excepcion no tiene mensaje`() {
        val ex = RuntimeException()

        val response = ex.toExceptionResponse()

        assertNotNull(response.message)
        assertEquals(500, response.statusCode.value)
    }
}
