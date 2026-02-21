package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminCreateUserResponse
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import aws.sdk.kotlin.services.cognitoidentityprovider.model.UsernameExistsException
import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class RegisterSalerTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val table = InMemoryDynamoDbTable.forProfile()
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val registerSaler = RegisterSaler(config, logger, cognito, table)

    private val adminHeaders = mapOf("Authorization" to "token")

    private fun seedAdmin() {
        table.putItem(UserBusinessProfile().apply {
            email = "admin@biz.com"
            business = "biz"
            profile = PROFILE_BUSINESS_ADMIN
            state = BusinessState.APPROVED
        })
    }

    private fun mockCognitoGetUser(email: String = "admin@biz.com") {
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(
                AttributeType { name = EMAIL_ATT_NAME; value = email }
            )
        }
    }

    @Test
    fun `registro exitoso retorna OK y persiste perfil`() = runBlocking {
        seedAdmin()
        mockCognitoGetUser()
        coEvery { cognito.adminCreateUser(any()) } returns AdminCreateUserResponse {}

        val body = Gson().toJson(RegisterSalerRequest("saler@test.com"))
        val response = registerSaler.securedExecute("biz", "registerSaler", adminHeaders, body)

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val saved = table.items.firstOrNull { it.email == "saler@test.com" }
        assertNotNull(saved)
        assertEquals(PROFILE_SALER, saved.profile)
        assertEquals(BusinessState.APPROVED, saved.state)
        assertEquals("biz", saved.business)
        coVerify(exactly = 1) { cognito.adminCreateUser(any()) }
    }

    @Test
    fun `body vacio retorna BadRequest`() = runBlocking {
        val response = registerSaler.securedExecute("biz", "registerSaler", adminHeaders, "")
        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `email invalido retorna BadRequest`() = runBlocking {
        seedAdmin()
        mockCognitoGetUser()

        val body = Gson().toJson(RegisterSalerRequest("invalid"))
        val response = registerSaler.securedExecute("biz", "registerSaler", adminHeaders, body)

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
        coVerify(exactly = 0) { cognito.adminCreateUser(any()) }
    }

    @Test
    fun `usuario sin perfil admin retorna Unauthorized`() = runBlocking {
        mockCognitoGetUser()

        val body = Gson().toJson(RegisterSalerRequest("saler@test.com"))
        val response = registerSaler.securedExecute("biz", "registerSaler", adminHeaders, body)

        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
        coVerify(exactly = 0) { cognito.adminCreateUser(any()) }
    }

    @Test
    fun `saler ya aprobado retorna Conflict`() = runBlocking {
        seedAdmin()
        mockCognitoGetUser()
        table.putItem(UserBusinessProfile().apply {
            email = "saler@test.com"
            business = "biz"
            profile = PROFILE_SALER
            state = BusinessState.APPROVED
        })

        val body = Gson().toJson(RegisterSalerRequest("saler@test.com"))
        val response = registerSaler.securedExecute("biz", "registerSaler", adminHeaders, body)

        assertEquals(HttpStatusCode.Conflict, response.statusCode)
        coVerify(exactly = 0) { cognito.adminCreateUser(any()) }
    }

    @Test
    fun `UsernameExistsException en Cognito no impide el registro`() = runBlocking {
        seedAdmin()
        mockCognitoGetUser()
        coEvery { cognito.adminCreateUser(any()) } throws UsernameExistsException {}

        val body = Gson().toJson(RegisterSalerRequest("saler@test.com"))
        val response = registerSaler.securedExecute("biz", "registerSaler", adminHeaders, body)

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val saved = table.items.firstOrNull { it.email == "saler@test.com" }
        assertNotNull(saved)
        assertEquals(BusinessState.APPROVED, saved.state)
    }

    @Test
    fun `error generico de Cognito retorna InternalServerError`() = runBlocking {
        seedAdmin()
        mockCognitoGetUser()
        coEvery { cognito.adminCreateUser(any()) } throws RuntimeException("Cognito unavailable")

        val body = Gson().toJson(RegisterSalerRequest("saler@test.com"))
        val response = registerSaler.securedExecute("biz", "registerSaler", adminHeaders, body)

        assertEquals(HttpStatusCode.InternalServerError, response.statusCode)
        coVerify(exactly = 1) { cognito.adminCreateUser(any()) }
    }

    @Test
    fun `saler pendiente permite nuevo registro`() = runBlocking {
        seedAdmin()
        mockCognitoGetUser()
        coEvery { cognito.adminCreateUser(any()) } returns AdminCreateUserResponse {}
        table.putItem(UserBusinessProfile().apply {
            email = "saler@test.com"
            business = "biz"
            profile = PROFILE_SALER
            state = BusinessState.PENDING
        })

        val body = Gson().toJson(RegisterSalerRequest("saler@test.com"))
        val response = registerSaler.securedExecute("biz", "registerSaler", adminHeaders, body)

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val saved = table.items.firstOrNull { it.email == "saler@test.com" }
        assertNotNull(saved)
        assertEquals(BusinessState.APPROVED, saved.state)
    }
}
