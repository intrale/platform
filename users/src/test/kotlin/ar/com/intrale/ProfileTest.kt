package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class ProfileTest {
    @Test
    fun `valores se asignan correctamente`() {
        val profile = Profile("CLIENT")
        assertEquals("CLIENT", profile.name)
    }

    @Test
    fun `objetos iguales tienen igualdad estructural`() {
        val p1 = Profile("CLIENT")
        val p2 = Profile("CLIENT")
        assertEquals(p1, p2)
    }

    @Test
    fun `copy permite modificar campos`() {
        val p1 = Profile("CLIENT")
        val copy = p1.copy(name = "ADMIN")
        assertNotEquals(p1.name, copy.name)
        assertEquals("ADMIN", copy.name)
    }

    @Test
    fun `toString refleja los valores`() {
        val profile = Profile("CLIENT")
        val esperado = "Profile(name=CLIENT)"
        assertEquals(esperado, profile.toString())
    }
}
