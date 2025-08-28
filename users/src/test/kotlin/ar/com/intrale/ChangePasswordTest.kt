package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import ar.com.intrale.RequestValidationException

class ChangePasswordTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val change = ChangePassword(config, logger, CognitoIdentityProviderClient { region = "us-east-1" })

    @Test
    fun validRequestPassesValidation() {
        val req = ChangePasswordRequest("old","new")
        val resp = change.requestValidation(req)
        assertEquals(null, resp)
    }

}
