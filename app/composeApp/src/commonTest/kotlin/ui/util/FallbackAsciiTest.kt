package ui.util

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class FallbackAsciiTest {

    @Test
    fun `fb acepta cadenas ASCII con escapes unicode`() {
        val value = fb("Autenticaci\\u00F3n")

        assertEquals("Autenticaci\\u00F3n", value)
    }

    /*@Test
    fun `fb rechaza literales con tildes directas`() {
        val accented = "Autenticaci" + '\u00F3' + "n"

        assertFailsWith<IllegalArgumentException> {
            fb(accented)
        }
    }*/

    @Test
    fun `fb retorna la cadena original cuando es ASCII`() {
        val value = fb("Autenticacion")

        assertEquals("Autenticacion", value)
    }
}
