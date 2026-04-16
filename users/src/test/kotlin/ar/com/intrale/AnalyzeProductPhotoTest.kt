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
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbIndex
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class StubProfileTablePhoto : DynamoDbTable<UserBusinessProfile> {
    val items = mutableListOf<UserBusinessProfile>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<UserBusinessProfile> =
        TableSchema.fromBean(UserBusinessProfile::class.java)
    override fun tableName() = "profiles"
    override fun keyFrom(item: UserBusinessProfile): Key =
        Key.builder().partitionValue(item.compositeKey).build()
    override fun index(indexName: String): DynamoDbIndex<UserBusinessProfile> =
        throw UnsupportedOperationException()
    override fun putItem(item: UserBusinessProfile) { items.add(item) }
    override fun getItem(item: UserBusinessProfile): UserBusinessProfile? =
        items.firstOrNull { it.compositeKey == item.compositeKey }
    override fun scan(): PageIterable<UserBusinessProfile> =
        PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
}

class AnalyzeProductPhotoTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("mi-negocio")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableProfiles = StubProfileTablePhoto()
    private val categoryRepository = CategoryRepository()
    private val photoAnalyzer = ProductPhotoAnalyzer(apiKey = "", model = "test")

    private val function = AnalyzeProductPhoto(
        config = config,
        logger = logger,
        cognito = cognito,
        tableProfiles = tableProfiles,
        categoryRepository = categoryRepository,
        photoAnalyzer = photoAnalyzer
    )

    private fun seedBusinessAdmin(email: String = "admin@negocio.com") {
        tableProfiles.items.add(UserBusinessProfile().apply {
            this.email = email
            this.business = "mi-negocio"
            this.profile = PROFILE_BUSINESS_ADMIN
            this.state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = email })
        }
    }

    private fun seedSaler(email: String = "saler@negocio.com") {
        tableProfiles.items.add(UserBusinessProfile().apply {
            this.email = email
            this.business = "mi-negocio"
            this.profile = PROFILE_SALER
            this.state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "saler"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = email })
        }
    }

    @Test
    fun `usuario no autorizado recibe UnauthorizedException`() = runBlocking {
        // Sin seedear ningun perfil
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "nobody"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "nobody@test.com" })
        }

        val body = Gson().toJson(mapOf("imageBase64" to "data"))
        val response = function.securedExecute(
            business = "mi-negocio",
            function = "business/products/analyze-photo",
            headers = mapOf("Authorization" to "token"),
            textBody = body
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `imagen vacia retorna RequestValidationException`() = runBlocking {
        seedBusinessAdmin()

        val body = Gson().toJson(mapOf("imageBase64" to ""))
        val response = function.securedExecute(
            business = "mi-negocio",
            function = "business/products/analyze-photo",
            headers = mapOf("Authorization" to "token"),
            textBody = body
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `body invalido retorna RequestValidationException`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "mi-negocio",
            function = "business/products/analyze-photo",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `admin puede analizar foto y recibe resultado vacio sin API key`() = runBlocking {
        seedBusinessAdmin()

        val body = Gson().toJson(mapOf("imageBase64" to "base64data", "mediaType" to "image/jpeg"))
        val response = function.securedExecute(
            business = "mi-negocio",
            function = "business/products/analyze-photo",
            headers = mapOf("Authorization" to "token"),
            textBody = body
        )

        assertTrue(response is AnalyzeProductPhotoResponse)
        val photoResponse = response as AnalyzeProductPhotoResponse
        assertEquals(HttpStatusCode.OK, photoResponse.statusCode)
        assertEquals("", photoResponse.suggestedName)
        assertEquals(0.0, photoResponse.confidence)
    }

    @Test
    fun `saler puede analizar foto`() = runBlocking {
        seedSaler()

        val body = Gson().toJson(mapOf("imageBase64" to "base64data"))
        val response = function.securedExecute(
            business = "mi-negocio",
            function = "business/products/analyze-photo",
            headers = mapOf("Authorization" to "token"),
            textBody = body
        )

        assertTrue(response is AnalyzeProductPhotoResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
    }

    @Test
    fun `AnalyzeProductPhotoRequestBody valores por defecto`() {
        val body = AnalyzeProductPhotoRequestBody()
        assertEquals("", body.imageBase64)
        assertEquals("image/jpeg", body.mediaType)
        assertTrue(body.existingCategories.isEmpty())
    }

    @Test
    fun `AnalyzeProductPhotoRequestBody con valores custom`() {
        val body = AnalyzeProductPhotoRequestBody(
            imageBase64 = "abc",
            mediaType = "image/png",
            existingCategories = listOf("A", "B")
        )
        assertEquals("abc", body.imageBase64)
        assertEquals("image/png", body.mediaType)
        assertEquals(2, body.existingCategories.size)
    }

    @Test
    fun `AnalyzeProductPhotoResponse tiene campos correctos`() {
        val response = AnalyzeProductPhotoResponse(
            suggestedName = "Torta",
            suggestedDescription = "Torta de chocolate",
            suggestedCategory = "Postres",
            confidence = 0.85,
            status = HttpStatusCode.OK
        )
        assertEquals("Torta", response.suggestedName)
        assertEquals("Torta de chocolate", response.suggestedDescription)
        assertEquals("Postres", response.suggestedCategory)
        assertEquals(0.85, response.confidence)
        assertEquals(HttpStatusCode.OK, response.statusCode)
    }
}
