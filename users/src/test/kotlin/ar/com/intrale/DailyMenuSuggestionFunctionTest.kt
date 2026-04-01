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
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class DailyMenuSuggestionFunctionTest {
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
    private val productRepository = ProductRepository()
    private val orderRepository = ClientOrderRepository()
    private val menuRepository = DailyMenuRepository()
    private val fakeAiService = FakeAiResponseService(
        AiResponseResult(
            answer = """{"title":"Milanesa con pure","description":"Clasico argentino","items":[{"product_id":"p1","product_name":"Milanesa","description":"Con pure de papa","suggested_price":3500.0}],"reasoning":"Es el plato mas vendido y hay stock"}""",
            confidence = 0.9,
            escalated = false
        )
    )

    private val function = DailyMenuSuggestionFunction(
        config = config,
        logger = logger,
        cognito = cognito,
        tableBusiness = tableBusiness,
        tableProfiles = tableProfiles,
        productRepository = productRepository,
        orderRepository = orderRepository,
        menuRepository = menuRepository,
        aiService = fakeAiService
    )

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

    private fun setupBusiness(name: String = "restaurante", menuEnabled: Boolean = true) {
        tableBusiness.putItem(Business().apply {
            this.name = name
            dailyMenuEnabled = menuEnabled
            description = "Restaurante de comida casera"
        })
    }

    private fun setupProducts(business: String = "restaurante") {
        productRepository.saveProduct(business, ProductRecord(
            id = "p1", name = "Milanesa", basePrice = 3000.0, unit = "plato",
            status = "PUBLISHED", isAvailable = true, stockQuantity = 10
        ))
        productRepository.saveProduct(business, ProductRecord(
            id = "p2", name = "Pure de papa", basePrice = 1500.0, unit = "porcion",
            status = "PUBLISHED", isAvailable = true, stockQuantity = 15
        ))
        productRepository.saveProduct(business, ProductRecord(
            id = "p3", name = "Ensalada mixta", basePrice = 1200.0, unit = "porcion",
            status = "PUBLISHED", isAvailable = true, stockQuantity = 8
        ))
    }

    @Test
    fun `genera sugerencia nueva cuando no hay pendiente`() = runBlocking {
        setupBusiness()
        setupProducts()

        val response = function.generateNewSuggestion(
            "restaurante",
            tableBusiness.getItem(Business().apply { name = "restaurante" })!!
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DailyMenuSuggestionResponse)
        val menuResponse = response as DailyMenuSuggestionResponse
        assertNotNull(menuResponse.suggestion)
        assertEquals("PENDING", menuResponse.suggestion!!.status)
        assertEquals("Milanesa con pure", menuResponse.suggestion!!.title)
    }

    @Test
    fun `falla sin productos publicados`() = runBlocking {
        setupBusiness()

        val response = function.generateNewSuggestion(
            "restaurante",
            tableBusiness.getItem(Business().apply { name = "restaurante" })!!
        )

        assertEquals(HttpStatusCode.UnprocessableEntity, response.statusCode)
    }

    @Test
    fun `falla sin productos con stock disponible`() = runBlocking {
        setupBusiness()
        productRepository.saveProduct("restaurante", ProductRecord(
            id = "p1", name = "Milanesa", basePrice = 3000.0, unit = "plato",
            status = "PUBLISHED", isAvailable = false, stockQuantity = 0
        ))

        val response = function.generateNewSuggestion(
            "restaurante",
            tableBusiness.getItem(Business().apply { name = "restaurante" })!!
        )

        assertEquals(HttpStatusCode.UnprocessableEntity, response.statusCode)
    }

    @Test
    fun `IA escalada retorna mensaje para armado manual`() = runBlocking {
        setupBusiness()
        setupProducts()
        fakeAiService.setResponse(AiResponseResult(answer = "", confidence = 0.2, escalated = true))

        val response = function.generateNewSuggestion(
            "restaurante",
            tableBusiness.getItem(Business().apply { name = "restaurante" })!!
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DailyMenuSuggestionResponse)
        val menuResponse = response as DailyMenuSuggestionResponse
        assertTrue(menuResponse.message.contains("manualmente"))
    }

    @Test
    fun `menu deshabilitado retorna Forbidden`() = runBlocking {
        setupBusiness(menuEnabled = false)
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.Forbidden, response.statusCode)
    }

    @Test
    fun `negocio inexistente retorna NotFound`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `buildMenuPrompt incluye productos y menus recientes`() {
        val products = listOf(
            ProductRecord(id = "p1", name = "Milanesa", basePrice = 3000.0, unit = "plato",
                status = "PUBLISHED", isAvailable = true, stockQuantity = 10),
            ProductRecord(id = "p2", name = "Pure", basePrice = 1500.0, unit = "porcion",
                status = "PUBLISHED", isAvailable = true)
        )
        val recentMenus = listOf(
            DailyMenuSuggestion(
                businessName = "restaurante",
                date = "2026-03-31",
                title = "Pollo al horno",
                items = listOf(DailyMenuItem(productId = "p3", productName = "Pollo")),
                status = "APPROVED"
            )
        )

        val prompt = function.buildMenuPrompt(products, recentMenus, emptyList())

        assertTrue(prompt.contains("Milanesa"))
        assertTrue(prompt.contains("Pure"))
        assertTrue(prompt.contains("NO REPETIR"))
        assertTrue(prompt.contains("Pollo al horno"))
    }

    @Test
    fun `parseMenuSuggestion parsea JSON valido`() {
        val json = """{"title":"Menu del dia","description":"Combo especial","items":[{"product_id":"p1","product_name":"Milanesa","description":"Con papas","suggested_price":3500.0}],"reasoning":"Mas vendido"}"""

        val result = function.parseMenuSuggestion(json)

        assertEquals("Menu del dia", result.title)
        assertEquals(1, result.items.size)
        assertEquals("Milanesa", result.items.first().productName)
        assertEquals(3500.0, result.items.first().suggestedPrice)
    }

    @Test
    fun `parseMenuSuggestion maneja JSON invalido gracefully`() {
        val result = function.parseMenuSuggestion("esto no es JSON valido")

        assertEquals("Menu del dia", result.title)
        assertTrue(result.description.isNotBlank())
    }
}
