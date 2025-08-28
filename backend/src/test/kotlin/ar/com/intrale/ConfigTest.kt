package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals

class ConfigTest {
    @Test
    fun configStoresProperties() {
        val cfg = object : Config("us-east-1", "pool", "client") {
            override fun businesses() = setOf("biz1", "biz2")
        }
        assertEquals(setOf("biz1", "biz2"), cfg.businesses())
        assertEquals("us-east-1", cfg.region)
        assertEquals("pool", cfg.awsCognitoUserPoolId)
        assertEquals("client", cfg.awsCognitoClientId)
    }
}
