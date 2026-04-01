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
import kotlin.test.assertTrue

class PricingSuggestionsFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val gson = Gson()

    private val tableBusiness = InMemoryDynamoDbTable<Business>(
        "business",
        TableSchema.fromBean(Business::class.java)
    ) { it.name ?: "" }

    private val tableProfiles = InMemoryDynamoDbTable<UserBusinessProfile>(
        "profiles",
        TableSchema.fromBean(UserBusinessProfile::class.java)
    ) { it.compositeKey ?: "" }

    private val productRepository = ProductRepository()

    private val fakePricingService = FakePricingAnalysisService()

    private val function = PricingSuggestionsFunction(
        config, logger, cognito, tableBusiness, tableProfiles,
        fakePricingService, productRepository
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

    private fun seedProducts() {
        productRepository.saveProduct("biz", ProductRecord(
            name = "Pizza Grande",
            basePrice = 1500.0,
            unit = "unidad",
            categoryId = "comida",
            status = "PUBLISHED"
        ))
        productRepository.saveProduct("biz", ProductRecord(
            name = "Helado 1kg",
            basePrice = 800.0,
            unit = "kg",
            categoryId = "postres",
            status = "PUBLISHED"
        ))
    }

    private fun seedBusinessWithSuggestions(suggestions: List<StoredPricingSuggestion>) {
        val biz = Business().apply {
            name = "biz"
            pricingSuggestionsJson = gson.toJson(suggestions)
        }
        tableBusiness.putItem(biz)
    }

    @Test
    fun `GET devuelve sugerencias pendientes vacias por defecto`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/pricing-suggestions",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is PricingSuggestionsResponse)
        assertTrue((response as PricingSuggestionsResponse).suggestions.isEmpty())
    }

    @Test
    fun `POST genera sugerencias de pricing con servicio IA`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()
        seedProducts()

        fakePricingService.nextSuggestions = listOf(
            PricingSuggestion(
                productName = "Pizza Grande",
                currentPrice = 1500.0,
                suggestedPrice = 1650.0,
                changePercent = 10.0,
                reason = "Alta demanda domingos",
                dataInsight = "Vendes 2x los domingos 12-14hs",
                timeSlot = "12:00-14:00",
                dayOfWeek = "domingo"
            )
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/pricing-suggestions",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is PricingSuggestionsResponse)
        val suggestions = (response as PricingSuggestionsResponse).suggestions
        assertEquals(1, suggestions.size)
        assertEquals("Pizza Grande", suggestions[0].productName)
        assertEquals(1650.0, suggestions[0].suggestedPrice)
        assertEquals("pending", suggestions[0].status)
    }

    @Test
    fun `POST sin productos devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/pricing-suggestions",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT aprueba una sugerencia pendiente`() = runBlocking {
        val pending = StoredPricingSuggestion(
            id = "abc123",
            productName = "Pizza Grande",
            currentPrice = 1500.0,
            suggestedPrice = 1650.0,
            changePercent = 10.0,
            reason = "Alta demanda",
            dataInsight = "2x domingos",
            status = "pending",
            createdAt = "2026-04-01T10:00:00Z"
        )
        seedBusinessWithSuggestions(listOf(pending))
        seedBusinessAdmin()

        val body = PricingSuggestionDecisionRequest(
            suggestionId = "abc123",
            action = "approved"
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/pricing-suggestions",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is PricingSuggestionsResponse)
        // La sugerencia aprobada ya no esta en pendientes
        assertTrue((response as PricingSuggestionsResponse).suggestions.isEmpty())

        // Verificar que se persistio en el historial
        val stored = tableBusiness.getItem(Business().apply { name = "biz" })
        assertTrue(stored!!.pricingSuggestionsJson!!.contains("approved"))
    }

    @Test
    fun `PUT rechaza una sugerencia pendiente`() = runBlocking {
        val pending = StoredPricingSuggestion(
            id = "def456",
            productName = "Helado 1kg",
            currentPrice = 800.0,
            suggestedPrice = 640.0,
            changePercent = -20.0,
            reason = "Baja demanda",
            dataInsight = "Poco movimiento martes noche",
            status = "pending",
            createdAt = "2026-04-01T10:00:00Z"
        )
        seedBusinessWithSuggestions(listOf(pending))
        seedBusinessAdmin()

        val body = PricingSuggestionDecisionRequest(
            suggestionId = "def456",
            action = "rejected"
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/pricing-suggestions",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val stored = tableBusiness.getItem(Business().apply { name = "biz" })
        assertTrue(stored!!.pricingSuggestionsJson!!.contains("rejected"))
    }

    @Test
    fun `PUT modifica precio de una sugerencia`() = runBlocking {
        val pending = StoredPricingSuggestion(
            id = "mod789",
            productName = "Pizza Grande",
            currentPrice = 1500.0,
            suggestedPrice = 1650.0,
            changePercent = 10.0,
            reason = "Alta demanda",
            dataInsight = "2x domingos",
            status = "pending",
            createdAt = "2026-04-01T10:00:00Z"
        )
        seedBusinessWithSuggestions(listOf(pending))
        seedBusinessAdmin()

        val body = PricingSuggestionDecisionRequest(
            suggestionId = "mod789",
            action = "modified",
            modifiedPrice = 1600.0,
            scheduledStart = "2026-04-05T12:00:00Z",
            scheduledEnd = "2026-04-05T20:00:00Z"
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/pricing-suggestions",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val stored = tableBusiness.getItem(Business().apply { name = "biz" })
        assertTrue(stored!!.pricingSuggestionsJson!!.contains("modified"))
        assertTrue(stored.pricingSuggestionsJson!!.contains("1600.0"))
    }

    @Test
    fun `PUT sin body devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/pricing-suggestions",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT con action invalida devuelve error`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val body = PricingSuggestionDecisionRequest(
            suggestionId = "abc",
            action = "invalid"
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/pricing-suggestions",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT modified sin precio devuelve error`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val body = PricingSuggestionDecisionRequest(
            suggestionId = "abc",
            action = "modified",
            modifiedPrice = null
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/pricing-suggestions",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `GET history devuelve sugerencias decididas`() = runBlocking {
        val suggestions = listOf(
            StoredPricingSuggestion(
                id = "hist1",
                productName = "Pizza",
                currentPrice = 1500.0,
                suggestedPrice = 1650.0,
                changePercent = 10.0,
                reason = "Demanda alta",
                dataInsight = "2x domingos",
                status = "approved",
                createdAt = "2026-03-30T10:00:00Z",
                decidedAt = "2026-03-30T14:00:00Z"
            ),
            StoredPricingSuggestion(
                id = "hist2",
                productName = "Helado",
                currentPrice = 800.0,
                suggestedPrice = 700.0,
                changePercent = -12.5,
                reason = "Baja demanda",
                dataInsight = "Poco movimiento",
                status = "pending",
                createdAt = "2026-04-01T10:00:00Z"
            )
        )
        seedBusinessWithSuggestions(suggestions)
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/pricing-suggestions",
            headers = mapOf(
                "Authorization" to "token",
                "X-Http-Method" to "GET",
                "X-Query-history" to "true"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is PricingSuggestionsHistoryResponse)
        val history = (response as PricingSuggestionsHistoryResponse).history
        assertEquals(1, history.size)
        assertEquals("approved", history[0].status)
    }

    @Test
    fun `usuario no autorizado recibe UnauthorizedException`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val response = function.securedExecute(
            business = "biz",
            function = "business/pricing-suggestions",
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
            function = "business/pricing-suggestions",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }
}

/**
 * Implementacion fake del servicio de analisis de pricing para tests.
 */
class FakePricingAnalysisService : PricingAnalysisService {
    var nextSuggestions: List<PricingSuggestion> = emptyList()

    override suspend fun analyzePricing(
        businessName: String,
        salesData: List<SalesSlotData>,
        products: List<ProductSummary>
    ): List<PricingSuggestion> = nextSuggestions
}
