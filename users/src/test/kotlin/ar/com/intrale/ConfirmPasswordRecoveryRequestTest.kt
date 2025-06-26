package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class ConfirmPasswordRecoveryRequestTest {
    @Test
    fun `valores se asignan correctamente`() {
        val req = ConfirmPasswordRecoveryRequest("user@test.com", "1234", "pass")
        assertEquals("user@test.com", req.email)
        assertEquals("1234", req.code)
        assertEquals("pass", req.password)
    }

    @Test
    fun `objetos iguales tienen igualdad estructural`() {
        val req1 = ConfirmPasswordRecoveryRequest("user@test.com", "1234", "pass")
        val req2 = ConfirmPasswordRecoveryRequest("user@test.com", "1234", "pass")
        assertEquals(req1, req2)
    }

    @Test
    fun `copy permite modificar campos`() {
        val req = ConfirmPasswordRecoveryRequest("user@test.com", "1234", "pass")
        val copy = req.copy(password = "newpass")
        assertNotEquals(req.password, copy.password)
        assertEquals("newpass", copy.password)
        assertEquals(req.email, copy.email)
        assertEquals(req.code, copy.code)
    }
}
