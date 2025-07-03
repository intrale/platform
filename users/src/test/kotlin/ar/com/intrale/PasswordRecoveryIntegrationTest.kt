package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.ForgotPasswordResponse
import aws.sdk.kotlin.services.cognitoidentityprovider.model.NotAuthorizedException
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import io.ktor.http.HttpStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals

class PasswordRecoveryIntegrationTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")

    @Test
    fun `recuperacion exitosa solicita cognito`() = runBlocking {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.forgotPassword(any()) } returns ForgotPasswordResponse { }
        coEvery { cognito.close() } returns Unit
        val recovery = PasswordRecovery(config, logger, cognito)

        val response = recovery.execute(
            business = "biz",
            function = "passwordRecovery",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\"}"
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        coVerify(exactly = 1) { cognito.forgotPassword(any()) }
    }

    @Test
    fun `cognito retorna no autorizado`() = runBlocking {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.forgotPassword(any()) } throws NotAuthorizedException { }
        coEvery { cognito.close() } returns Unit
        val recovery = PasswordRecovery(config, logger, cognito)

        val response = recovery.execute(
            business = "biz",
            function = "passwordRecovery",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\"}"
        )

        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
        coVerify(exactly = 1) { cognito.forgotPassword(any()) }
    }

    @Test
    fun `error inesperado retorna internal server error`() = runBlocking {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.forgotPassword(any()) } throws RuntimeException("fail")
        coEvery { cognito.close() } returns Unit
        val recovery = PasswordRecovery(config, logger, cognito)

        val response = recovery.execute(
            business = "biz",
            function = "passwordRecovery",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\"}"
        )

        assertEquals(HttpStatusCode.InternalServerError, response.statusCode)
        coVerify(exactly = 1) { cognito.forgotPassword(any()) }
    }
}
