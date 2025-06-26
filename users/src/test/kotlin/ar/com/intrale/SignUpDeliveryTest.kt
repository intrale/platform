package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals

class SignUpDeliveryTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = UsersConfig(
        businesses = setOf("test"),
        region = "us-east-1",
        accessKeyId = "key",
        secretAccessKey = "secret",
        awsCognitoUserPoolId = "pool",
        awsCognitoClientId = "client"
    )
    private val cognito = CognitoIdentityProviderClient {
        region = config.region
    }

    @Test
    fun profileIsDelivery() {
        val signup = SignUpDelivery(config, logger, cognito)
        assertEquals(PROFILE_DELIVERY, signup.getProfile())
    }
}
