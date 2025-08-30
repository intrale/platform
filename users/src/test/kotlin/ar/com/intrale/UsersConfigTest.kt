package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals

class UsersConfigTest {
    @Test
    fun `calcula negocios aprobados dinamicamente`() {
        val table = DummyBusinessTable().apply {
            items.add(
                Business(
                    name = "bizName",
                    publicId = "biz",
                    state = BusinessState.APPROVED
                )
            )
            items.add(
                Business(
                    name = "pendingName",
                    publicId = "pending",
                    state = BusinessState.PENDING
                )
            )
        }
        val config = UsersConfig(
            region = "us-east-1",
            accessKeyId = "key",
            secretAccessKey = "secret",
            awsCognitoUserPoolId = "pool",
            awsCognitoClientId = "client",
            tableBusiness = table
        )
        assertEquals(setOf("biz", "intrale"), config.businesses())
    }
}
