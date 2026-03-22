package ar.com.intrale

import io.ktor.http.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class HealthResponseTest {

    @Test
    fun `estado por defecto es UP y statusCode OK`() {
        val resp = HealthResponse()
        assertEquals(HttpStatusCode.OK, resp.statusCode)
        assertEquals("UP", resp.status)
    }

    @Test
    fun `timestamp no es nulo ni vacio`() {
        val resp = HealthResponse()
        assertNotNull(resp.timestamp)
        assertTrue(resp.timestamp.isNotBlank())
    }

    @Test
    fun `timestamp tiene formato ISO-8601`() {
        val resp = HealthResponse()
        // Formato esperado: 2026-03-22T10:00:00Z (contiene T y termina en Z)
        assertTrue(resp.timestamp.contains("T"), "El timestamp debe contener 'T': ${resp.timestamp}")
        assertTrue(resp.timestamp.endsWith("Z"), "El timestamp debe terminar en 'Z': ${resp.timestamp}")
    }

    @Test
    fun `uptimeMs es mayor o igual a cero`() {
        val resp = HealthResponse()
        assertTrue(resp.uptimeMs >= 0, "uptimeMs debe ser >= 0: ${resp.uptimeMs}")
    }

    @Test
    fun `runtime contiene version de java`() {
        val resp = HealthResponse()
        assertNotNull(resp.runtime)
        assertTrue(resp.runtime.startsWith("java-"), "runtime debe empezar con 'java-': ${resp.runtime}")
    }
}
