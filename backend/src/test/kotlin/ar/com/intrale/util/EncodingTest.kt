package ar.com.intrale.util

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class EncodingTest {

    @Test
    fun `decodeBase64OrNull devuelve texto valido`() {
        val original = "Dashboard"
        val encoded = java.util.Base64.getEncoder().encodeToString(original.toByteArray())

        val decoded = decodeBase64OrNull(encoded)

        assertEquals(original, decoded)
    }

    @Test
    fun `decodeBase64OrNull retorna null si no es base`() {
        val decoded = decodeBase64OrNull("Texto plano")

        assertNull(decoded)
    }

    @Test
    fun `decodeBase64OrNull ignora cadenas invalidas`() {
        val decoded = decodeBase64OrNull("Zm9vYmFy==\n")

        assertNull(decoded)
    }

    @Test
    fun `decodeBase64OrNull acepta cadenas vacias`() {
        val decoded = decodeBase64OrNull("")

        assertEquals("", decoded)
    }

    @Test
    fun `decodeBase64OrNull retorna null si contiene retorno de carro`() {
        val decoded = decodeBase64OrNull("Zm9v\rYmFy")

        assertNull(decoded)
    }

    @Test
    fun `decodeBase64OrNull retorna null si longitud no es multiplo de 4`() {
        val decoded = decodeBase64OrNull("Zm9vY")

        assertNull(decoded)
    }

    @Test
    fun `decodeBase64OrNull retorna null con caracteres invalidos`() {
        val decoded = decodeBase64OrNull("Zm9v!@#$")

        assertNull(decoded)
    }

    @Test
    fun `decodeBase64OrNull maneja espacios alrededor`() {
        val original = "test"
        val encoded = java.util.Base64.getEncoder().encodeToString(original.toByteArray())

        val decoded = decodeBase64OrNull("  $encoded  ")

        assertEquals(original, decoded)
    }
}
