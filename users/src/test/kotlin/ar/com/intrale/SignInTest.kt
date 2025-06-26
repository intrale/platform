package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals

class SignInTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")
    private val signIn = SignIn(config, logger, CognitoIdentityProviderClient { region = "us-east-1" })

    @Test
    fun validRequestPassesValidation() {
        val req = SignInRequest("user@test.com", "pass", "new", "name", "last")
        val resp = signIn.requestValidation(req)
        assertEquals(null, resp)
    }

    @Test
    fun emptyBodyReturnsError() = runBlocking {
        val resp = signIn.execute("biz", "signin", emptyMap(), "")
        assertEquals("Request body not found", (resp as RequestValidationException).message)
    }
}
