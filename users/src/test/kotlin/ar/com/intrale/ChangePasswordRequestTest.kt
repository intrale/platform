package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class ChangePasswordRequestTest {
    @Test
    fun `valores se asignan correctamente`() {
        val req = ChangePasswordRequest("oldPass", "newPass")
        assertEquals("oldPass", req.oldPassword)
        assertEquals("newPass", req.newPassword)
    }

    @Test
    fun `objetos iguales tienen igualdad estructural`() {
        val req1 = ChangePasswordRequest("oldPass", "newPass")
        val req2 = ChangePasswordRequest("oldPass", "newPass")
        assertEquals(req1, req2)
    }

    @Test
    fun `copy permite modificar campos`() {
        val req = ChangePasswordRequest("oldPass", "newPass")
        val copy = req.copy(newPassword = "anotherPass")
        assertNotEquals(req.newPassword, copy.newPassword)
        assertEquals("anotherPass", copy.newPassword)
        assertEquals(req.oldPassword, copy.oldPassword)
    }
}
