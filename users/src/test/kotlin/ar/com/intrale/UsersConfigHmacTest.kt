package ar.com.intrale

import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class UsersConfigHmacTest {
    @Test
    fun `acepta clave Base64 de doscientos cincuenta y seis bits`() {
        val config = configWithKey(Base64.getEncoder().encodeToString(ByteArray(32) { 7 }))

        assertEquals(32, config.hmacKeyBytes.size)
    }

    @Test
    fun `falla con clave ausente o whitespace e indica cómo generarla`() {
        listOf("", "   ").forEach { key ->
            val exception = assertFailsWith<IllegalStateException> { configWithKey(key) }
            assertTrue(exception.message.orEmpty().contains("openssl rand -base64 32"))
        }
    }

    @Test
    fun `falla con clave decodificada menor a treinta y dos bytes`() {
        val exception = assertFailsWith<IllegalArgumentException> {
            configWithKey(Base64.getEncoder().encodeToString(ByteArray(31)))
        }

        assertTrue(exception.message.orEmpty().contains("Actual: 31"))
    }

    private fun configWithKey(key: String): UsersConfig = UsersConfig(
        region = "us-east-1",
        accessKeyId = "key",
        secretAccessKey = "secret",
        awsCognitoUserPoolId = "pool",
        awsCognitoClientId = "client",
        hmacKey = key,
        tableBusiness = DummyBusinessTable()
    )
}
