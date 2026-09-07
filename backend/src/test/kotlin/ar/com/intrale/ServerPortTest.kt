package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Cobertura de la resolucion del puerto de escucha del servidor embebido.
 * Reemplaza la validacion que antes solo ejercitaba el job e2e-qa (#6362).
 */
class ServerPortTest {

    @Test
    fun `un valor numerico valido resuelve a ese puerto`() {
        assertEquals(8080, resolveServerPort("8080"))
    }

    @Test
    fun `la variable ausente cae al puerto por defecto`() {
        assertEquals(DEFAULT_PORT, resolveServerPort(null))
    }

    @Test
    fun `un valor no numerico cae al puerto por defecto`() {
        assertEquals(DEFAULT_PORT, resolveServerPort("no-es-un-numero"))
    }

    @Test
    fun `un valor vacio o solo espacios cae al puerto por defecto`() {
        assertEquals(DEFAULT_PORT, resolveServerPort(""))
        assertEquals(DEFAULT_PORT, resolveServerPort("   "))
    }

    @Test
    fun `un valor numerico con espacios alrededor se normaliza`() {
        assertEquals(8080, resolveServerPort("  8080  "))
    }

    @Test
    fun `el puerto por defecto se mantiene en 80 para no alterar el comportamiento historico`() {
        assertEquals(80, DEFAULT_PORT)
    }

    @Test
    fun `la variable de entorno consultada es PORT`() {
        assertEquals("PORT", ENV_PORT)
    }
}
