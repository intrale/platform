package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals

class SignUpTest {
    private val config = UsersConfig(setOf("test"), "us-east-1", "key", "secret", "pool", "client")
    private val cognito = CognitoIdentityProviderClient { region = config.region }
    private val signUp = SignUp(config, NOPLogger.NOP_LOGGER, cognito)

    @Test
    fun profileIsDefault() {
        assertEquals(DEFAULT_PROFILE, signUp.getProfile())
    }

    @Test
    fun emptyBodyReturnsError() = runBlocking {
        val resp = signUp.execute("biz", "signup", emptyMap(), "")
        assertEquals("Request body not found", (resp as RequestValidationException).message)
    }
}
