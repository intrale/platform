package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class PasswordRecoveryRequestTest {
    @Test
    fun `valores se asignan correctamente`() {
        val req = PasswordRecoveryRequest("user@test.com")
        assertEquals("user@test.com", req.email)
    }

    @Test
    fun `objetos iguales tienen igualdad estructural`() {
        val req1 = PasswordRecoveryRequest("user@test.com")
        val req2 = PasswordRecoveryRequest("user@test.com")
        assertEquals(req1, req2)
    }

    @Test
    fun `copy permite modificar campos`() {
        val req = PasswordRecoveryRequest("user@test.com")
        val copy = req.copy(email = "other@test.com")
        assertNotEquals(req.email, copy.email)
        assertEquals("other@test.com", copy.email)
    }

    @Test
    fun `objetos con diferente email no son iguales`() {
        val req1 = PasswordRecoveryRequest("user@test.com")
        val req2 = PasswordRecoveryRequest("other@test.com")
        assertNotEquals(req1, req2)
    }

    @Test
    fun `toString refleja los valores`() {
        val req = PasswordRecoveryRequest("user@test.com")
        val esperado = "PasswordRecoveryRequest(email=user@test.com)"
        assertEquals(esperado, req.toString())
    }
}
