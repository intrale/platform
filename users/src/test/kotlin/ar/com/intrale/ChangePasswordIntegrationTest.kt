package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.ChangePasswordResponse
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import io.ktor.http.HttpStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals

class ChangePasswordIntegrationTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")

    @Test
    fun `cambio exitoso de contrasena`() = runBlocking {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.changePassword(any()) } returns ChangePasswordResponse {}
        coEvery { cognito.close() } returns Unit
        val change = ChangePassword(config, logger, cognito)

        val response = change.securedExecute(
            business = "biz",
            function = "changePassword",
            headers = mapOf("Authorization" to "token"),
            textBody = "{\"oldPassword\":\"old\",\"newPassword\":\"new\"}"
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        coVerify(exactly = 1) { cognito.changePassword(any()) }
    }

    @Test
    fun `token faltante retorna no autorizado`() = runBlocking {
        val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
        val change = ChangePassword(config, logger, cognito)

        val response = change.securedExecute(
            business = "biz",
            function = "changePassword",
            headers = emptyMap(),
            textBody = "{\"oldPassword\":\"old\",\"newPassword\":\"new\"}"
        )

        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
        coVerify(exactly = 0) { cognito.changePassword(any()) }
    }
}
