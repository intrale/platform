package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DailyMenuConfigFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("restaurante")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableBusiness = InMemoryDynamoDbTable<Business>(
        "business",
        TableSchema.fromBean(Business::class.java)
    ) { it.name ?: "" }
    private val tableProfiles = InMemoryDynamoDbTable<UserBusinessProfile>(
        "profiles",
        TableSchema.fromBean(UserBusinessProfile::class.java)
    ) { it.compositeKey ?: "" }

    private val function = DailyMenuConfigFunction(config, logger, cognito, tableBusiness, tableProfiles)

    private fun seedBusinessAdmin() {
        tableProfiles.putItem(UserBusinessProfile().apply {
            email = "admin@rest.com"
            business = "restaurante"
            profile = PROFILE_BUSINESS_ADMIN
            state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "admin@rest.com" })
        }
    }

    @Test
    fun `GET devuelve configuracion desactivada por defecto`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "restaurante" })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DailyMenuConfigResponse)
        assertFalse((response as DailyMenuConfigResponse).dailyMenuEnabled)
        assertEquals(8, response.suggestionHour)
    }

    @Test
    fun `PUT activa el menu del dia con hora personalizada`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "restaurante" })
        seedBusinessAdmin()

        val body = UpdateDailyMenuConfigRequest(enabled = true, suggestionHour = 7)

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = Gson().toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DailyMenuConfigResponse)
        assertTrue((response as DailyMenuConfigResponse).dailyMenuEnabled)
        assertEquals(7, response.suggestionHour)

        val stored = tableBusiness.getItem(Business().apply { name = "restaurante" })
        assertTrue(stored!!.dailyMenuEnabled)
        assertEquals(7, stored.dailyMenuSuggestionHour)
    }

    @Test
    fun `PUT con hora invalida devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "restaurante" })
        seedBusinessAdmin()

        val body = UpdateDailyMenuConfigRequest(enabled = true, suggestionHour = 25)

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = Gson().toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `usuario no autorizado recibe UnauthorizedException`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "restaurante" })
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu-config",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `GET a negocio inexistente devuelve NotFound`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `PUT sin body devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "restaurante" })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }
}
