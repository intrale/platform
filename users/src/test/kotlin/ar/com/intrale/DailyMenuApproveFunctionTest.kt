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

class DailyMenuApproveFunctionTest {
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
    private val menuRepository = DailyMenuRepository()
    private val productRepository = ProductRepository()
    private val gson = Gson()

    private val function = DailyMenuApproveFunction(
        config, logger, cognito, tableBusiness, tableProfiles, menuRepository, productRepository
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

    private fun setupBusinessAndSuggestion(): DailyMenuSuggestion {
        tableBusiness.putItem(Business().apply {
            name = "restaurante"
            dailyMenuEnabled = true
        })
        productRepository.saveProduct("restaurante", ProductRecord(
            id = "p1", name = "Milanesa", basePrice = 3000.0, unit = "plato",
            status = "PUBLISHED", isAvailable = true
        ))
        return menuRepository.storeSuggestion("restaurante", DailyMenuSuggestion(
            businessName = "restaurante",
            title = "Menu del dia",
            description = "Milanesa con pure",
            items = listOf(DailyMenuItem(productId = "p1", productName = "Milanesa", suggestedPrice = 3500.0)),
            status = "PENDING"
        ))
    }

    @Test
    fun `aprobar sugerencia cambia estado a APPROVED`() = runBlocking {
        val suggestion = setupBusinessAndSuggestion()
        seedBusinessAdmin()

        val body = DailyMenuActionRequest(action = "approve", suggestionId = suggestion.id)

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu-approve",
            headers = mapOf("Authorization" to "token"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DailyMenuApproveResponse)
        val approveResponse = response as DailyMenuApproveResponse
        assertEquals("APPROVED", approveResponse.suggestion!!.status)
        assertTrue(approveResponse.message.contains("aprobado"))
    }

    @Test
    fun `rechazar sugerencia cambia estado a REJECTED`() = runBlocking {
        val suggestion = setupBusinessAndSuggestion()
        seedBusinessAdmin()

        val body = DailyMenuActionRequest(action = "reject", suggestionId = suggestion.id)

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu-approve",
            headers = mapOf("Authorization" to "token"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DailyMenuApproveResponse)
        val approveResponse = response as DailyMenuApproveResponse
        assertEquals("REJECTED", approveResponse.suggestion!!.status)
    }

    @Test
    fun `aprobar sugerencia ya procesada retorna Conflict`() = runBlocking {
        val suggestion = setupBusinessAndSuggestion()
        seedBusinessAdmin()
        menuRepository.updateSuggestionStatus("restaurante", suggestion.id, "APPROVED")

        val body = DailyMenuActionRequest(action = "approve", suggestionId = suggestion.id)

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu-approve",
            headers = mapOf("Authorization" to "token"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.Conflict, response.statusCode)
    }

    @Test
    fun `sugerencia inexistente retorna NotFound`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "restaurante" })
        seedBusinessAdmin()

        val body = DailyMenuActionRequest(action = "approve", suggestionId = "no-existe")

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu-approve",
            headers = mapOf("Authorization" to "token"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `accion invalida retorna error de validacion`() = runBlocking {
        val suggestion = setupBusinessAndSuggestion()
        seedBusinessAdmin()

        val body = DailyMenuActionRequest(action = "delete", suggestionId = suggestion.id)

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu-approve",
            headers = mapOf("Authorization" to "token"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `suggestionId vacio retorna error de validacion`() = runBlocking {
        setupBusinessAndSuggestion()
        seedBusinessAdmin()

        val body = DailyMenuActionRequest(action = "approve", suggestionId = "")

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu-approve",
            headers = mapOf("Authorization" to "token"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `sin body retorna error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "restaurante" })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu-approve",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `aprobar destaca productos en el catalogo`() = runBlocking {
        val suggestion = setupBusinessAndSuggestion()
        seedBusinessAdmin()

        val body = DailyMenuActionRequest(action = "approve", suggestionId = suggestion.id)

        function.securedExecute(
            business = "restaurante",
            function = "business/daily-menu-approve",
            headers = mapOf("Authorization" to "token"),
            textBody = gson.toJson(body)
        )

        val product = productRepository.getProduct("restaurante", "p1")
        assertTrue(product!!.isFeatured)
    }
}
