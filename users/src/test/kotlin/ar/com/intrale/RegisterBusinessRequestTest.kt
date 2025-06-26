package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class RegisterBusinessRequestTest {
    @Test
    fun `valores se asignan correctamente`() {
        val req = RegisterBusinessRequest("Biz", "admin@biz.com", "desc")
        assertEquals("Biz", req.name)
        assertEquals("admin@biz.com", req.emailAdmin)
        assertEquals("desc", req.description)
    }

  @Test
    fun `objetos iguales tienen igualdad estructural`() {
        val req1 = RegisterBusinessRequest("Biz", "admin@biz.com", "desc")
        val req2 = RegisterBusinessRequest("Biz", "admin@biz.com", "desc")
        assertEquals(req1, req2)
    }

    @Test
    fun `copy permite modificar campos`() {
        val req = RegisterBusinessRequest("Biz", "admin@biz.com", "desc")
        val copy = req.copy(description = "otro")
        assertNotEquals(req.description, copy.description)
        assertEquals("otro", copy.description)
        assertEquals(req.name, copy.name)
        assertEquals(req.emailAdmin, copy.emailAdmin)
    }

    @Test
    fun `toString refleja los valores`() {
        val req = RegisterBusinessRequest("Biz", "admin@biz.com", "desc")
        val esperado = "RegisterBusinessRequest(name=Biz, emailAdmin=admin@biz.com, description=desc)"
        assertEquals(esperado, req.toString())
    }
}
