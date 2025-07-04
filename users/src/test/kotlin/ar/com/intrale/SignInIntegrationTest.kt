package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.*
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals

class SignInIntegrationTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")

    @Test
    fun `ingreso exitoso`() = runBlocking {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminInitiateAuth(any()) } returns AdminInitiateAuthResponse {
            authenticationResult = AuthenticationResultType {
                idToken = "id"
                accessToken = "access"
                refreshToken = "refresh"
            }
        }
        coEvery { cognito.adminGetUser(any()) } returns AdminGetUserResponse {
            username = "user@test.com"
            userAttributes = listOf(AttributeType { name = BUSINESS_ATT_NAME; value = "biz" })
        }
        coEvery { cognito.close() } returns Unit
        val signIn = SignIn(config, logger, cognito)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"pass\"}"
        )

        assertEquals(io.ktor.http.HttpStatusCode.OK, resp.statusCode)
        coVerify(exactly = 1) { cognito.adminInitiateAuth(any()) }
        coVerify(exactly = 1) { cognito.adminGetUser(any()) }
    }

    @Test
    fun `cambio de contrasena requerido`() = runBlocking {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminInitiateAuth(any()) } returnsMany listOf(
            AdminInitiateAuthResponse { challengeName = ChallengeNameType.NewPasswordRequired; session = "sess" },
            AdminInitiateAuthResponse { authenticationResult = AuthenticationResultType { idToken = "id"; accessToken = "access"; refreshToken = "refresh" } }
        )
        coEvery { cognito.adminRespondToAuthChallenge(any()) } returns AdminRespondToAuthChallengeResponse {}
        coEvery { cognito.adminUpdateUserAttributes(any()) } returns AdminUpdateUserAttributesResponse {}
        coEvery { cognito.adminGetUser(any()) } returns AdminGetUserResponse {
            username = "user@test.com"
            userAttributes = listOf(AttributeType { name = BUSINESS_ATT_NAME; value = "biz" })
        }
        coEvery { cognito.close() } returns Unit
        val signIn = SignIn(config, logger, cognito)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"old\",\"newPassword\":\"new\",\"name\":\"John\",\"familyName\":\"Doe\"}"
        )

        assertEquals(io.ktor.http.HttpStatusCode.OK, resp.statusCode)
        coVerify(exactly = 2) { cognito.adminInitiateAuth(any()) }
        coVerify(exactly = 1) { cognito.adminRespondToAuthChallenge(any()) }
        coVerify(exactly = 1) { cognito.adminUpdateUserAttributes(any()) }
    }

    @Test
    fun `credenciales invalidas retornan no autorizado`() = runBlocking {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminInitiateAuth(any()) } throws NotAuthorizedException { }
        coEvery { cognito.close() } returns Unit
        val signIn = SignIn(config, logger, cognito)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"bad\"}"
        )

        assertEquals(io.ktor.http.HttpStatusCode.Unauthorized, resp.statusCode)
    }
}
