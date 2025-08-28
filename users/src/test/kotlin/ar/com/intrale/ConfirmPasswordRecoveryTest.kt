package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals

class ConfirmPasswordRecoveryTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val confirm = ConfirmPasswordRecovery(config, logger, CognitoIdentityProviderClient { region = config.region })

    @Test
    fun validRequestPassesValidation() {
        val req = ConfirmPasswordRecoveryRequest("user@test.com", "123456", "newPass")
        val resp = confirm.requestValidation(req)
        assertEquals(null, resp)
    }
}
