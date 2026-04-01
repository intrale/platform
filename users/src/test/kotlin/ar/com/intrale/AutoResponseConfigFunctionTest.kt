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

class AutoResponseConfigFunctionTest {
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

    private val function = AutoResponseConfigFunction(
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
    fun `GET devuelve configuracion actual desactivada por defecto`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/auto-response-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is AutoResponseConfigResponse)
        assertFalse((response as AutoResponseConfigResponse).autoResponseEnabled)
    }

    @Test
    fun `PUT activa las respuestas automaticas`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val body = UpdateAutoResponseConfigRequest(enabled = true)

        val response = function.securedExecute(
            business = "biz",
            function = "business/auto-response-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = Gson().toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is AutoResponseConfigResponse)
        assertTrue((response as AutoResponseConfigResponse).autoResponseEnabled)

        // Verificar que se persisitio en la tabla
        val stored = tableBusiness.getItem(Business().apply { name = "biz" })
        assertTrue(stored!!.autoResponseEnabled)
    }

    @Test
    fun `PUT desactiva las respuestas automaticas`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "biz"
            autoResponseEnabled = true
        })
        seedBusinessAdmin()

        val body = UpdateAutoResponseConfigRequest(enabled = false)

        val response = function.securedExecute(
            business = "biz",
            function = "business/auto-response-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = Gson().toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertFalse((response as AutoResponseConfigResponse).autoResponseEnabled)
    }

    @Test
    fun `usuario no autorizado recibe UnauthorizedException`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val response = function.securedExecute(
            business = "biz",
            function = "business/auto-response-config",
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
            function = "business/auto-response-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `PUT sin body devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/auto-response-config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }
}
