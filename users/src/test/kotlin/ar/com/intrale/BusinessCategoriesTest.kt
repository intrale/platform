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
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

private class StubProfileTableCategories : DynamoDbTable<UserBusinessProfile> {
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

class BusinessCategoriesTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("la-carne")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableProfiles = StubProfileTableCategories()
    private val categoryRepository = CategoryRepository()

    private val function = BusinessCategories(
        config = config,
        logger = logger,
        cognito = cognito,
        tableProfiles = tableProfiles,
        categoryRepository = categoryRepository
    )

    private fun seedBusinessAdmin(email: String = "admin@lacarne.com") {
        tableProfiles.items.add(UserBusinessProfile().apply {
            this.email = email
            this.business = "la-carne"
            this.profile = PROFILE_BUSINESS_ADMIN
            this.state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = email })
        }
    }

    private fun categoryRequestJson(
        name: String = "Carnes",
        description: String? = null
    ): String = Gson().toJson(mapOf(
        "name" to name,
        "description" to description
    ))

    @Test
    fun `GET lista categorias vacia cuando no hay categorias`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/categories",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is CategoryListResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response.categories.isEmpty())
    }

    @Test
    fun `POST crea categoria con datos validos`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/categories",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = categoryRequestJson()
        )

        assertTrue(response is CategoryResponse)
        assertEquals(HttpStatusCode.Created, response.statusCode)
        assertNotNull(response.category)
        assertEquals("Carnes", response.category!!.name)
        assertEquals("la-carne", response.category!!.businessId)
        assertTrue(response.category!!.id!!.isNotEmpty())
    }

    @Test
    fun `POST categoria aparece en el listado posterior`() = runBlocking {
        seedBusinessAdmin()

        function.securedExecute(
            business = "la-carne",
            function = "business/categories",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = categoryRequestJson(name = "Bebidas")
        )

        val listResponse = function.securedExecute(
            business = "la-carne",
            function = "business/categories",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(listResponse is CategoryListResponse)
        assertEquals(1, listResponse.categories.size)
        assertEquals("Bebidas", listResponse.categories.first().name)
    }

    @Test
    fun `PUT actualiza categoria existente`() = runBlocking {
        seedBusinessAdmin()

        val createResponse = function.securedExecute(
            business = "la-carne",
            function = "business/categories",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = categoryRequestJson(name = "Postres")
        ) as CategoryResponse
        val categoryId = createResponse.category!!.id

        val updateResponse = function.securedExecute(
            business = "la-carne",
            function = "business/categories/$categoryId",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT",
                "X-Function-Path" to "business/categories/$categoryId"),
            textBody = categoryRequestJson(name = "Postres y Dulces", description = "Tortas y facturas")
        )

        assertTrue(updateResponse is CategoryResponse)
        assertEquals(HttpStatusCode.OK, updateResponse.statusCode)
        assertEquals("Postres y Dulces", updateResponse.category!!.name)
        assertEquals("Tortas y facturas", updateResponse.category!!.description)
    }

    @Test
    fun `DELETE elimina categoria existente`() = runBlocking {
        seedBusinessAdmin()

        val createResponse = function.securedExecute(
            business = "la-carne",
            function = "business/categories",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = categoryRequestJson(name = "Categoria a eliminar")
        ) as CategoryResponse
        val categoryId = createResponse.category!!.id

        val deleteResponse = function.securedExecute(
            business = "la-carne",
            function = "business/categories/$categoryId",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "DELETE",
                "X-Function-Path" to "business/categories/$categoryId"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.NoContent, deleteResponse.statusCode)

        val listResponse = function.securedExecute(
            business = "la-carne",
            function = "business/categories",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        ) as CategoryListResponse
        assertTrue(listResponse.categories.isEmpty())
    }

    @Test
    fun `POST sin nombre retorna error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/categories",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = categoryRequestJson(name = "")
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `usuario sin perfil retorna UnauthorizedException`() = runBlocking {
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/categories",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `DELETE de categoria inexistente retorna 404`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/categories/no-existe",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "DELETE",
                "X-Function-Path" to "business/categories/no-existe"),
            textBody = ""
        )

        assertTrue(response is ExceptionResponse)
        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }
}
