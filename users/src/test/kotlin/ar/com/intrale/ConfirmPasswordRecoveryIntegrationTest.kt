package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.ConfirmForgotPasswordResponse
import aws.sdk.kotlin.services.cognitoidentityprovider.model.NotAuthorizedException
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import io.ktor.http.HttpStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals

class ConfirmPasswordRecoveryIntegrationTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")

    @Test
    fun `confirmacion exitosa de password`() = runBlocking {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.confirmForgotPassword(any()) } returns ConfirmForgotPasswordResponse {}
        coEvery { cognito.close() } returns Unit
        val confirm = ConfirmPasswordRecovery(config, logger, cognito)

        val response = confirm.execute(
            business = "biz",
            function = "confirmPasswordRecovery",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"code\":\"123456\",\"password\":\"newPass\"}"
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        coVerify(exactly = 1) { cognito.confirmForgotPassword(any()) }
    }

    @Test
    fun `credenciales invalidas retornan no autorizado`() = runBlocking {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.confirmForgotPassword(any()) } throws NotAuthorizedException { message = "Invalid" }
        coEvery { cognito.close() } returns Unit
        val confirm = ConfirmPasswordRecovery(config, logger, cognito)

        val response = confirm.execute(
            business = "biz",
            function = "confirmPasswordRecovery",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"code\":\"123456\",\"password\":\"newPass\"}"
        )

        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
        coVerify(exactly = 1) { cognito.confirmForgotPassword(any()) }
    }

    @Test
    fun `error inesperado retorna error interno`() = runBlocking {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.confirmForgotPassword(any()) } throws RuntimeException("fail")
        coEvery { cognito.close() } returns Unit
        val confirm = ConfirmPasswordRecovery(config, logger, cognito)

        val response = confirm.execute(
            business = "biz",
            function = "confirmPasswordRecovery",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"code\":\"123456\",\"password\":\"newPass\"}"
        )

        assertEquals(HttpStatusCode.InternalServerError, response.statusCode)
        coVerify(exactly = 1) { cognito.confirmForgotPassword(any()) }
    }
}

