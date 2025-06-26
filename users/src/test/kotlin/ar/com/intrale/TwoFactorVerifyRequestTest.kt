package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class TwoFactorVerifyRequestTest {
    @Test
    fun `valores se asignan correctamente`() {
        val req = TwoFactorVerifyRequest("123456")
        assertEquals("123456", req.code)
    }

    @Test
    fun `objetos iguales tienen igualdad estructural`() {
        val req1 = TwoFactorVerifyRequest("123456")
        val req2 = TwoFactorVerifyRequest("123456")
        assertEquals(req1, req2)
    }

    @Test
    fun `copy permite modificar campos`() {
        val req = TwoFactorVerifyRequest("123456")
        val copy = req.copy(code = "654321")
        assertNotEquals(req.code, copy.code)
        assertEquals("654321", copy.code)
    }

    @Test
    fun `objetos con diferente codigo no son iguales`() {
        val req1 = TwoFactorVerifyRequest("123456")
        val req2 = TwoFactorVerifyRequest("654321")
        assertNotEquals(req1, req2)
    }

    @Test
    fun `toString refleja los valores`() {
        val req = TwoFactorVerifyRequest("123456")
        val esperado = "TwoFactorVerifyRequest(code=123456)"
        assertEquals(esperado, req.toString())
    }
}
