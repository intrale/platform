package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class SignInRequestTest {
    @Test
    fun `valores se asignan correctamente`() {
        val req = SignInRequest("user@test.com", "pass", "newpass", "John", "Doe")
        assertEquals("user@test.com", req.email)
        assertEquals("pass", req.password)
        assertEquals("newpass", req.newPassword)
        assertEquals("John", req.name)
        assertEquals("Doe", req.familyName)
    }

    @Test
    fun `objetos iguales tienen igualdad estructural`() {
        val req1 = SignInRequest("user@test.com", "pass", "newpass", "John", "Doe")
        val req2 = SignInRequest("user@test.com", "pass", "newpass", "John", "Doe")
        assertEquals(req1, req2)
    }

    @Test
    fun `copy permite modificar campos`() {
        val req = SignInRequest("user@test.com", "pass", "newpass", "John", "Doe")
        val copy = req.copy(newPassword = "other")
        assertNotEquals(req.newPassword, copy.newPassword)
        assertEquals("other", copy.newPassword)
        assertEquals(req.email, copy.email)
        assertEquals(req.password, copy.password)
        assertEquals(req.name, copy.name)
        assertEquals(req.familyName, copy.familyName)
    }

    @Test
    fun `objetos con diferente email no son iguales`() {
        val req1 = SignInRequest("user@test.com", "pass", "newpass", "John", "Doe")
        val req2 = SignInRequest("other@test.com", "pass", "newpass", "John", "Doe")
        assertNotEquals(req1, req2)
    }

    @Test
    fun `toString refleja los valores`() {
        val req = SignInRequest("user@test.com", "pass", "newpass", "John", "Doe")
        val esperado = "SignInRequest(email=user@test.com, password=pass, newPassword=newpass, name=John, familyName=Doe)"
        assertEquals(esperado, req.toString())
    }
}
