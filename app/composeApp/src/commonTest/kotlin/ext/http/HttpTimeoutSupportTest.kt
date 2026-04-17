package ext.http

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Issue #2285 — Tests unitarios del soporte de timeout.
 *
 * Verifican que:
 *  - `isHttpTimeout()` detecta la excepcion directa y en la cadena de `cause`.
 *  - No hay falsos positivos para excepciones arbitrarias.
 *  - Las constantes cumplen los limites de seguridad (CA-1, CA-2).
 */
class HttpTimeoutSupportTest {

    // Imitaciones locales — reproducimos `simpleName` para evitar dependencia
    // directa en clases plataforma-especificas (Darwin/OkHttp/Java) desde commonTest.
    private class HttpRequestTimeoutException(message: String) : RuntimeException(message)
    private class HttpConnectTimeoutException(message: String) : RuntimeException(message)
    private class HttpSocketTimeoutException(message: String) : RuntimeException(message)
    private class ConnectTimeoutException(message: String) : RuntimeException(message)
    private class SocketTimeoutException(message: String) : RuntimeException(message)
    private class UnrelatedException(message: String) : RuntimeException(message)

    @Test
    fun `isHttpTimeout detecta HttpRequestTimeoutException directa`() {
        val ex = HttpRequestTimeoutException("Request timeout for url /business/signin")
        assertTrue(ex.isHttpTimeout())
    }

    @Test
    fun `isHttpTimeout detecta HttpConnectTimeoutException directa`() {
        val ex = HttpConnectTimeoutException("Connect timeout")
        assertTrue(ex.isHttpTimeout())
    }

    @Test
    fun `isHttpTimeout detecta HttpSocketTimeoutException directa`() {
        val ex = HttpSocketTimeoutException("Socket timeout")
        assertTrue(ex.isHttpTimeout())
    }

    @Test
    fun `isHttpTimeout detecta ConnectTimeoutException de engine`() {
        val ex = ConnectTimeoutException("Engine connect timeout")
        assertTrue(ex.isHttpTimeout())
    }

    @Test
    fun `isHttpTimeout detecta SocketTimeoutException de engine`() {
        val ex = SocketTimeoutException("Engine socket timeout")
        assertTrue(ex.isHttpTimeout())
    }

    @Test
    fun `isHttpTimeout detecta timeout anidado en cause`() {
        val timeout = HttpRequestTimeoutException("Request timeout")
        val wrapper = RuntimeException("Error al ejecutar login", timeout)
        assertTrue(wrapper.isHttpTimeout())
    }

    @Test
    fun `isHttpTimeout retorna false para excepciones no relacionadas`() {
        val ex = UnrelatedException("Business error")
        assertFalse(ex.isHttpTimeout())
    }

    @Test
    fun `mensaje user-facing es generico y sin info tecnica`() {
        val msg = HTTP_TIMEOUT_USER_MESSAGE
        // CA-2 / CA-4: sin URLs, headers, JWT ni palabra "timeout" en ingles.
        assertFalse(msg.contains("http", ignoreCase = true), "mensaje contiene 'http'")
        assertFalse(msg.contains("://"), "mensaje contiene URL")
        assertFalse(msg.contains("timeout", ignoreCase = true), "mensaje contiene 'timeout'")
        assertFalse(msg.contains("Bearer", ignoreCase = true), "mensaje contiene 'Bearer'")
        assertFalse(msg.contains("Authorization", ignoreCase = true), "mensaje contiene 'Authorization'")
        // Accionable en espanol.
        assertTrue(msg.contains("servidor"), "mensaje debe mencionar servidor")
        assertTrue(msg.contains("de nuevo") || msg.contains("nuevo"), "mensaje debe sugerir reintentar")
    }

    @Test
    fun `constantes de timeout cumplen los limites de seguridad`() {
        // CA-1: los valores no superan 30s / 15s / 30s (evita DoS client-side).
        assertEquals(30_000L, HttpTimeoutsConfig.HTTP_REQUEST_TIMEOUT_MS)
        assertEquals(15_000L, HttpTimeoutsConfig.HTTP_CONNECT_TIMEOUT_MS)
        assertEquals(30_000L, HttpTimeoutsConfig.HTTP_SOCKET_TIMEOUT_MS)
    }

    @Test
    fun `status code de timeout corresponde a RFC 7231 Request Timeout`() {
        assertEquals(408, HTTP_TIMEOUT_STATUS_CODE)
        assertEquals("Request Timeout", HTTP_TIMEOUT_STATUS_DESCRIPTION)
    }
}
