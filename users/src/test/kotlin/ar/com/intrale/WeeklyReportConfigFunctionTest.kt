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
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WeeklyReportConfigFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableBusiness = InMemoryDynamoDbTable<Business>(
        "business",
        TableSchema.fromBean(Business::class.java)
    ) { it.name ?: "" }
    private val tableProfiles = InMemoryDynamoDbTable<UserBusinessProfile>(
        "profiles",
        TableSchema.fromBean(UserBusinessProfile::class.java)
    ) { it.compositeKey ?: "" }

    private val function = WeeklyReportConfigFunction(
        config, logger, cognito, tableBusiness, tableProfiles
    )

    private fun seedBusinessAdmin() {
        tableProfiles.putItem(UserBusinessProfile().apply {
            email = "admin@biz.com"
            business = "biz"
            profile = PROFILE_BUSINESS_ADMIN
            state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "admin@biz.com" })
        }
    }

    @Test
    fun `GET devuelve configuracion desactivada por defecto`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/weekly-report-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is WeeklyReportConfigResponse)
        val configResponse = response as WeeklyReportConfigResponse
        assertFalse(configResponse.enabled)
        assertNull(configResponse.contactType)
        assertNull(configResponse.contactId)
    }

    @Test
    fun `PUT activa reportes semanales con Telegram`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val body = UpdateWeeklyReportConfigRequest(
            enabled = true,
            contactType = "telegram",
            contactId = "123456789"
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/weekly-report-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = Gson().toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val configResponse = response as WeeklyReportConfigResponse
        assertTrue(configResponse.enabled)
        assertEquals("telegram", configResponse.contactType)
        assertEquals("123456789", configResponse.contactId)

        // Verificar persistencia
        val stored = tableBusiness.getItem(Business().apply { name = "biz" })
        assertTrue(stored!!.weeklyReportEnabled)
        assertEquals("telegram", stored.weeklyReportContactType)
        assertEquals("123456789", stored.weeklyReportContactId)
    }

    @Test
    fun `PUT activa reportes semanales con WhatsApp`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val body = UpdateWeeklyReportConfigRequest(
            enabled = true,
            contactType = "whatsapp",
            contactId = "+5491155551234"
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/weekly-report-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = Gson().toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val configResponse = response as WeeklyReportConfigResponse
        assertTrue(configResponse.enabled)
        assertEquals("whatsapp", configResponse.contactType)
    }

    @Test
    fun `PUT sin contactType cuando enabled da error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val body = UpdateWeeklyReportConfigRequest(enabled = true)

        val response = function.securedExecute(
            business = "biz",
            function = "business/weekly-report-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = Gson().toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT con contactType invalido da error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val body = UpdateWeeklyReportConfigRequest(
            enabled = true,
            contactType = "email",
            contactId = "test@test.com"
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/weekly-report-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = Gson().toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT desactiva reportes semanales`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "biz"
            weeklyReportEnabled = true
            weeklyReportContactType = "telegram"
            weeklyReportContactId = "123456789"
        })
        seedBusinessAdmin()

        val body = UpdateWeeklyReportConfigRequest(enabled = false)

        val response = function.securedExecute(
            business = "biz",
            function = "business/weekly-report-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = Gson().toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertFalse((response as WeeklyReportConfigResponse).enabled)
    }

    @Test
    fun `DELETE desactiva reportes y limpia configuracion`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "biz"
            weeklyReportEnabled = true
            weeklyReportContactType = "telegram"
            weeklyReportContactId = "123456789"
        })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/weekly-report-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "DELETE"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertFalse((response as WeeklyReportConfigResponse).enabled)

        val stored = tableBusiness.getItem(Business().apply { name = "biz" })
        assertFalse(stored!!.weeklyReportEnabled)
        assertNull(stored.weeklyReportContactType)
        assertNull(stored.weeklyReportContactId)
    }

    @Test
    fun `usuario no autorizado recibe UnauthorizedException`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val response = function.securedExecute(
            business = "biz",
            function = "business/weekly-report-config",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `GET a negocio inexistente devuelve NotFound`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/weekly-report-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }
}
