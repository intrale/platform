package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class ReviewBusinessRegistrationRequestTest {
    @Test
    fun `valores se asignan correctamente`() {
        val req = ReviewBusinessRegistrationRequest("Biz", "approved", "123456")
        assertEquals("Biz", req.name)
        assertEquals("approved", req.decision)
        assertEquals("123456", req.twoFactorCode)
    }

    @Test
    fun `objetos iguales tienen igualdad estructural`() {
        val r1 = ReviewBusinessRegistrationRequest("Biz", "approved", "123456")
        val r2 = ReviewBusinessRegistrationRequest("Biz", "approved", "123456")
        assertEquals(r1, r2)
    }

    @Test
    fun `copy permite modificar campos`() {
        val req = ReviewBusinessRegistrationRequest("Biz", "approved", "123456")
        val copy = req.copy(decision = "rejected")
        assertNotEquals(req.decision, copy.decision)
        assertEquals("rejected", copy.decision)
        assertEquals(req.name, copy.name)
        assertEquals(req.twoFactorCode, copy.twoFactorCode)
    }

    @Test
    fun `objetos con diferente nombre no son iguales`() {
        val r1 = ReviewBusinessRegistrationRequest("Biz", "approved", "123456")
        val r2 = ReviewBusinessRegistrationRequest("Other", "approved", "123456")
        assertNotEquals(r1, r2)
    }

    @Test
    fun `toString refleja los valores`() {
        val req = ReviewBusinessRegistrationRequest("Biz", "approved", "123456")
        val esperado = "ReviewBusinessRegistrationRequest(name=Biz, decision=approved, twoFactorCode=123456)"
        assertEquals(esperado, req.toString())
    }
}
