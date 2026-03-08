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
import software.amazon.awssdk.core.pagination.sync.SdkIterable
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class StubBusinessTableFonts : DynamoDbTable<Business> {
    val items = mutableListOf<Business>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<Business> = TableSchema.fromBean(Business::class.java)
    override fun tableName() = "business"
    override fun keyFrom(item: Business): Key = Key.builder().partitionValue(item.name).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: Business) { items.add(item) }
    override fun getItem(item: Business): Business? = items.find { it.name == item.name }
    override fun updateItem(item: Business): Business {
        val idx = items.indexOfFirst { it.name == item.name }
        if (idx >= 0) items[idx] = item else items.add(item)
        return item
    }
    override fun scan(): PageIterable<Business> =
        PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
}

private class StubProfileTableFonts : DynamoDbTable<UserBusinessProfile> {
    val items = mutableListOf<UserBusinessProfile>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<UserBusinessProfile> =
        TableSchema.fromBean(UserBusinessProfile::class.java)
    override fun tableName() = "profiles"
    override fun keyFrom(item: UserBusinessProfile): Key =
        Key.builder().partitionValue(item.compositeKey).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: UserBusinessProfile) { items.add(item) }
    override fun getItem(item: UserBusinessProfile): UserBusinessProfile? =
        items.firstOrNull { it.compositeKey == item.compositeKey }
    override fun scan(): PageIterable<UserBusinessProfile> =
        PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
}

class BusinessFontsFunctionTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableBusiness = StubBusinessTableFonts()
    private val tableProfiles = StubProfileTableFonts()

    private val function = BusinessFontsFunction(
        config, logger, cognito, tableBusiness, tableProfiles
    )

    private fun seedBusinessAdmin() {
        tableProfiles.items.add(UserBusinessProfile().apply {
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
    fun `GET retorna fonts vacias cuando el negocio no tiene fonts configuradas`() = runBlocking {
        tableBusiness.items.add(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/fonts",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is BusinessFontsResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response.fonts.isEmpty())
    }

    @Test
    fun `GET retorna fonts existentes del negocio`() = runBlocking {
        tableBusiness.items.add(Business().apply {
            name = "biz"
            fonts = mutableMapOf("title" to "Roboto-Bold", "body" to "Roboto-Regular")
        })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/fonts",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is BusinessFontsResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals("Roboto-Bold", response.fonts["title"])
        assertEquals("Roboto-Regular", response.fonts["body"])
    }

    @Test
    fun `PUT actualiza fonts correctamente`() = runBlocking {
        tableBusiness.items.add(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val requestBody = Gson().toJson(
            BusinessFontsRequest(
                fonts = mapOf(
                    "title" to "OpenSans-Bold",
                    "subtitle" to "OpenSans-Regular",
                    "body" to "Roboto-Regular",
                    "button" to "Lato-Bold"
                )
            )
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/fonts",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = requestBody
        )

        assertTrue(response is BusinessFontsResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals("OpenSans-Bold", response.fonts["title"])
        assertEquals("OpenSans-Regular", response.fonts["subtitle"])
        assertEquals("Roboto-Regular", response.fonts["body"])
        assertEquals("Lato-Bold", response.fonts["button"])
        assertEquals("OpenSans-Bold", tableBusiness.items.first().fonts["title"])
    }

    @Test
    fun `PUT con tipo de fuente invalido retorna error de validacion`() = runBlocking {
        tableBusiness.items.add(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val requestBody = Gson().toJson(
            BusinessFontsRequest(fonts = mapOf("invalid_type" to "Roboto-Bold"))
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/fonts",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = requestBody
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT con body vacio retorna error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/fonts",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `usuario no autorizado retorna UnauthorizedException`() = runBlocking {
        tableBusiness.items.add(Business().apply { name = "biz" })
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val response = function.securedExecute(
            business = "biz",
            function = "business/fonts",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `GET con negocio inexistente retorna fonts vacias`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/fonts",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is BusinessFontsResponse)
        assertTrue(response.fonts.isEmpty())
    }

    @Test
    fun `PUT con negocio inexistente retorna ExceptionResponse`() = runBlocking {
        seedBusinessAdmin()

        val requestBody = Gson().toJson(BusinessFontsRequest(fonts = mapOf("title" to "Roboto-Bold")))

        val response = function.securedExecute(
            business = "biz",
            function = "business/fonts",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = requestBody
        )

        assertTrue(response is ExceptionResponse)
    }
}
