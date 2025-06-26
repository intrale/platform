package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TwoFactorSetupResponseTest {
    @Test
    fun `constructor asigna otpAuthUri y status OK`() {
        val resp = TwoFactorSetupResponse("otp://uri")
        assertEquals("otp://uri", resp.otpAuthUri)
        assertEquals(HttpStatusCode.OK, resp.statusCode)
    }

    @Test
    fun `hereda de Response`() {
        val resp = TwoFactorSetupResponse("otp://uri")
        assertTrue(resp is Response)
    }
}
