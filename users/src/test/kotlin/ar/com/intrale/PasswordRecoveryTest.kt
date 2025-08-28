package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals

class PasswordRecoveryTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val recovery = PasswordRecovery(config, logger, CognitoIdentityProviderClient { region = config.region })

    @Test
    fun validRequestPassesValidation() {
        val req = PasswordRecoveryRequest("user@test.com")
        val resp = recovery.requestValidation(req)
        assertEquals(null, resp)
    }
}
