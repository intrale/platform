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
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

private class StubProfileTableStock : DynamoDbTable<UserBusinessProfile> {
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

class BusinessStockFunctionTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("la-carne")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableProfiles = StubProfileTableStock()
    private val productRepository = ProductRepository()
    private val gson = Gson()

    private val function = BusinessStockFunction(
        config = config,
        logger = logger,
        cognito = cognito,
        tableProfiles = tableProfiles,
        productRepository = productRepository
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

    private fun seedProduct(
        name: String = "Asado",
        stockQuantity: Int? = 50,
        minStock: Int? = 10,
        status: String = "PUBLISHED"
    ): ProductRecord {
        return productRepository.saveProduct("la-carne", ProductRecord(
            name = name,
            basePrice = 2500.0,
            unit = "kg",
            categoryId = "cat-1",
            status = status,
            isAvailable = true,
            stockQuantity = stockQuantity,
            minStock = minStock
        ))
    }

    // --- GET Inventario ---

    @Test
    fun `GET inventario retorna productos ordenados por stock ascendente`() = runBlocking {
        seedBusinessAdmin()
        seedProduct(name = "Asado", stockQuantity = 50, minStock = 10)
        seedProduct(name = "Chorizo", stockQuantity = 5, minStock = 10)
        seedProduct(name = "Vacio", stockQuantity = 100, minStock = 20)

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is StockInventoryResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals(3, response.products.size)
        assertEquals("Chorizo", response.products[0].name)
        assertEquals(5, response.products[0].stockQuantity)
        assertEquals("Asado", response.products[1].name)
        assertEquals("Vacio", response.products[2].name)
    }

    @Test
    fun `GET inventario excluye productos sin stock gestionado`() = runBlocking {
        seedBusinessAdmin()
        seedProduct(name = "Con stock", stockQuantity = 10)
        seedProduct(name = "Sin stock gestionado", stockQuantity = null)

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is StockInventoryResponse)
        assertEquals(1, response.products.size)
        assertEquals("Con stock", response.products[0].name)
    }

    // --- GET Alertas ---

    @Test
    fun `GET alerts retorna productos con stock por debajo del minimo`() = runBlocking {
        seedBusinessAdmin()
        seedProduct(name = "Chorizo", stockQuantity = 3, minStock = 10)
        seedProduct(name = "Asado", stockQuantity = 50, minStock = 10)
        seedProduct(name = "Vacio", stockQuantity = 10, minStock = 10) // Igual al minimo: alerta

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock/alerts",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is StockAlertListResponse)
        assertEquals(2, response.alerts.size)
        assertEquals("Chorizo", response.alerts[0].productName)
        assertEquals(3, response.alerts[0].currentStock)
        assertEquals(10, response.alerts[0].minStock)
    }

    @Test
    fun `GET alerts retorna lista vacia si todos tienen stock suficiente`() = runBlocking {
        seedBusinessAdmin()
        seedProduct(name = "Asado", stockQuantity = 50, minStock = 10)

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock/alerts",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is StockAlertListResponse)
        assertTrue(response.alerts.isEmpty())
    }

    // --- PUT Ajuste manual ---

    @Test
    fun `PUT SET establece stock a un valor absoluto`() = runBlocking {
        seedBusinessAdmin()
        val product = seedProduct(name = "Asado", stockQuantity = 50)

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock/${product.id}",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(StockAdjustmentRequest(type = "SET", quantity = 75, reason = "Reposicion"))
        )

        assertTrue(response is StockAdjustmentResponse)
        assertEquals(75, response.product.stockQuantity)
        assertFalse(response.belowMinimum)
    }

    @Test
    fun `PUT ADD suma stock al valor actual`() = runBlocking {
        seedBusinessAdmin()
        val product = seedProduct(name = "Chorizo", stockQuantity = 10)

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock/${product.id}",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(StockAdjustmentRequest(type = "ADD", quantity = 20, reason = "Compra a proveedor"))
        )

        assertTrue(response is StockAdjustmentResponse)
        assertEquals(30, response.product.stockQuantity)
    }

    @Test
    fun `PUT SUBTRACT resta stock y alerta si baja del minimo`() = runBlocking {
        seedBusinessAdmin()
        val product = seedProduct(name = "Vacio", stockQuantity = 15, minStock = 10)

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock/${product.id}",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(StockAdjustmentRequest(type = "SUBTRACT", quantity = 10, reason = "Merma"))
        )

        assertTrue(response is StockAdjustmentResponse)
        assertEquals(5, response.product.stockQuantity)
        assertTrue(response.belowMinimum)
        assertNotNull(response.message)
        Unit
    }

    @Test
    fun `PUT SUBTRACT no permite stock negativo`() = runBlocking {
        seedBusinessAdmin()
        val product = seedProduct(name = "Asado", stockQuantity = 3)

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock/${product.id}",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(StockAdjustmentRequest(type = "SUBTRACT", quantity = 10))
        )

        assertTrue(response is StockAdjustmentResponse)
        assertEquals(0, response.product.stockQuantity)
        assertFalse(response.product.isAvailable)
    }

    @Test
    fun `PUT SET a cero marca producto como no disponible`() = runBlocking {
        seedBusinessAdmin()
        val product = seedProduct(name = "Asado", stockQuantity = 50)

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock/${product.id}",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(StockAdjustmentRequest(type = "SET", quantity = 0))
        )

        assertTrue(response is StockAdjustmentResponse)
        assertEquals(0, response.product.stockQuantity)
        assertFalse(response.product.isAvailable)
    }

    @Test
    fun `PUT producto inexistente retorna 404`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock/no-existe",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(StockAdjustmentRequest(type = "SET", quantity = 10))
        )

        assertTrue(response is ExceptionResponse)
        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `PUT tipo invalido retorna error de validacion`() = runBlocking {
        seedBusinessAdmin()
        val product = seedProduct(name = "Asado", stockQuantity = 50)

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock/${product.id}",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(StockAdjustmentRequest(type = "INVALID", quantity = 10))
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT cantidad negativa retorna error de validacion`() = runBlocking {
        seedBusinessAdmin()
        val product = seedProduct(name = "Asado", stockQuantity = 50)

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock/${product.id}",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(StockAdjustmentRequest(type = "SET", quantity = -5))
        )

        assertTrue(response is RequestValidationException)
    }

    // --- POST Deduccion ---

    @Test
    fun `POST deduct descuenta stock de multiples productos`() = runBlocking {
        seedBusinessAdmin()
        val p1 = seedProduct(name = "Asado", stockQuantity = 50, minStock = 10)
        val p2 = seedProduct(name = "Chorizo", stockQuantity = 20, minStock = 5)

        val request = StockDeductionRequest(
            items = listOf(
                StockDeductionRequestItem(productId = p1.id, quantity = 3),
                StockDeductionRequestItem(productId = p2.id, quantity = 2)
            )
        )

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock/deduct",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(request)
        )

        assertTrue(response is StockDeductionResponse)
        assertEquals(2, response.updatedProducts.size)
        assertEquals(47, response.updatedProducts.first { it.name == "Asado" }.stockQuantity)
        assertEquals(18, response.updatedProducts.first { it.name == "Chorizo" }.stockQuantity)
        assertTrue(response.lowStockAlerts.isEmpty())
    }

    @Test
    fun `POST deduct genera alerta cuando stock baja del minimo`() = runBlocking {
        seedBusinessAdmin()
        val product = seedProduct(name = "Chorizo", stockQuantity = 12, minStock = 10)

        val request = StockDeductionRequest(
            items = listOf(StockDeductionRequestItem(productId = product.id, quantity = 5))
        )

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock/deduct",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(request)
        )

        assertTrue(response is StockDeductionResponse)
        assertEquals(1, response.lowStockAlerts.size)
        assertEquals("Chorizo", response.lowStockAlerts[0].productName)
        assertEquals(7, response.lowStockAlerts[0].currentStock)
    }

    @Test
    fun `POST deduct con lista vacia retorna error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock/deduct",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(StockDeductionRequest(items = emptyList()))
        )

        assertTrue(response is RequestValidationException)
    }

    // --- Autorizacion ---

    @Test
    fun `usuario sin perfil retorna UnauthorizedException`() = runBlocking {
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val response = function.securedExecute(
            business = "la-carne",
            function = "business/stock",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }
}
