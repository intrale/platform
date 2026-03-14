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

private class StubProfileTableProducts : DynamoDbTable<UserBusinessProfile> {
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

class BusinessProductsTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("la-carne")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableProfiles = StubProfileTableProducts()
    private val productRepository = ProductRepository()
    private val categoryRepository = CategoryRepository()

    private val function = BusinessProducts(
        config = config,
        logger = logger,
        cognito = cognito,
        tableProfiles = tableProfiles,
        productRepository = productRepository,
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

    private fun seedSaler(email: String = "saler@lacarne.com") {
        tableProfiles.items.add(UserBusinessProfile().apply {
            this.email = email
            this.business = "la-carne"
            this.profile = PROFILE_SALER
            this.state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "saler"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = email })
        }
    }

    private fun productRequestJson(
        name: String = "Asado de tira",
        basePrice: Double = 2500.0,
        unit: String = "kg",
        categoryId: String = "cat-1",
        status: String = "DRAFT",
        shortDescription: String? = null,
        isAvailable: Boolean = true
    ): String = Gson().toJson(mapOf(
        "name" to name,
        "basePrice" to basePrice,
        "unit" to unit,
        "categoryId" to categoryId,
        "status" to status,
        "shortDescription" to shortDescription,
        "isAvailable" to isAvailable
    ))

    @Test
    fun `GET lista productos vacia cuando no hay productos`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/products",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is ProductListResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response.products.isEmpty())
    }

    @Test
    fun `POST crea producto con datos validos`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/products",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = productRequestJson()
        )

        assertTrue(response is ProductResponse)
        assertEquals(HttpStatusCode.Created, response.statusCode)
        assertNotNull(response.product)
        assertEquals("Asado de tira", response.product!!.name)
        assertEquals("la-carne", response.product!!.businessId)
        assertTrue(response.product!!.id.isNotEmpty())
    }

    @Test
    fun `POST producto aparece en el listado posterior`() = runBlocking {
        seedBusinessAdmin()

        function.securedExecute(
            business = "la-carne",
            function = "business/products",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = productRequestJson(name = "Empanadas x12")
        )

        val listResponse = function.securedExecute(
            business = "la-carne",
            function = "business/products",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(listResponse is ProductListResponse)
        assertEquals(1, listResponse.products.size)
        assertEquals("Empanadas x12", listResponse.products.first().name)
    }

    @Test
    fun `PUT actualiza producto existente`() = runBlocking {
        seedBusinessAdmin()

        val createResponse = function.securedExecute(
            business = "la-carne",
            function = "business/products",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = productRequestJson(name = "Chorizo", basePrice = 800.0)
        ) as ProductResponse
        val productId = createResponse.product!!.id

        val updateResponse = function.securedExecute(
            business = "la-carne",
            function = "business/products/$productId",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT",
                "X-Function-Path" to "business/products/$productId"),
            textBody = productRequestJson(name = "Chorizo colorado", basePrice = 900.0, status = "PUBLISHED")
        )

        assertTrue(updateResponse is ProductResponse)
        assertEquals(HttpStatusCode.OK, updateResponse.statusCode)
        assertEquals("Chorizo colorado", updateResponse.product!!.name)
        assertEquals("PUBLISHED", updateResponse.product!!.status)
        assertEquals(900.0, updateResponse.product!!.basePrice)
    }

    @Test
    fun `DELETE elimina producto existente`() = runBlocking {
        seedBusinessAdmin()

        val createResponse = function.securedExecute(
            business = "la-carne",
            function = "business/products",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = productRequestJson(name = "Producto a eliminar")
        ) as ProductResponse
        val productId = createResponse.product!!.id

        val deleteResponse = function.securedExecute(
            business = "la-carne",
            function = "business/products/$productId",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "DELETE",
                "X-Function-Path" to "business/products/$productId"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.NoContent, deleteResponse.statusCode)

        val listResponse = function.securedExecute(
            business = "la-carne",
            function = "business/products",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        ) as ProductListResponse
        assertTrue(listResponse.products.isEmpty())
    }

    @Test
    fun `POST sin nombre retorna error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/products",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = productRequestJson(name = "")
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con precio cero retorna error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/products",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = productRequestJson(basePrice = 0.0)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `usuario sin perfil retorna UnauthorizedException`() = runBlocking {
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/products",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `Saler puede listar y crear productos`() = runBlocking {
        seedSaler()

        val createResponse = function.securedExecute(
            business = "la-carne",
            function = "business/products",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = productRequestJson(name = "Producto del saler")
        )

        assertTrue(createResponse is ProductResponse)
        assertEquals(HttpStatusCode.Created, createResponse.statusCode)
    }

    @Test
    fun `DELETE de producto inexistente retorna 404`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/products/no-existe",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "DELETE",
                "X-Function-Path" to "business/products/no-existe"),
            textBody = ""
        )

        assertTrue(response is ExceptionResponse)
        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }
}
