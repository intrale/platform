package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals

class SignUpPlatformAdminTest {
    private val config = UsersConfig(setOf("test"), "us-east-1", "key", "secret", "pool", "client")
    private val cognito = CognitoIdentityProviderClient { region = config.region }
    private val signUp = SignUpPlatformAdmin(config, NOPLogger.NOP_LOGGER, cognito)

    @Test
    fun profileIsPlatformAdmin() {
        assertEquals(PROFILE_PLATFORM_ADMIN, signUp.getProfile())
    }
}
