package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class UsersConfigTest {
    private val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")

    @Test
    fun `valores se asignan correctamente`() {
        assertEquals(setOf("biz"), config.businesses)
        assertEquals("us-east-1", config.region)
        assertEquals("key", config.accessKeyId)
        assertEquals("secret", config.secretAccessKey)
        assertEquals("pool", config.awsCognitoUserPoolId)
        assertEquals("client", config.awsCognitoClientId)
    }

    @Test
    fun `objetos iguales tienen igualdad estructural`() {
        val c1 = config
        val c2 = config.copy()
        assertEquals(c1, c2)
    }

    @Test
    fun `copy permite modificar campos`() {
        val copy = config.copy(region = "us-west-2")
        assertNotEquals(config.region, copy.region)
        assertEquals("us-west-2", copy.region)
        assertEquals(config.accessKeyId, copy.accessKeyId)
    }

    @Test
    fun `toString refleja los valores`() {
        val esperado = "UsersConfig(businesses=[biz], region=us-east-1, accessKeyId=key, secretAccessKey=secret, awsCognitoUserPoolId=pool, awsCognitoClientId=client)"
        assertEquals(esperado, config.toString())
    }
}
