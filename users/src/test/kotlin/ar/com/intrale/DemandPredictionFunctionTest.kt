package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import io.ktor.http.HttpStatusCode
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import java.time.Instant
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Fake del servicio de prediccion de demanda para tests.
 */
class FakeDemandPredictionService(
    private var response: DemandPredictionResult = DemandPredictionResult(
        topProducts = listOf(
            ProductPrediction(
                productName = "Pizza Muzzarella",
                expectedQuantity = 150,
                trend = "up",
                changePercent = 25.0,
                stockAlert = true,
                insight = "Los viernes se vende 40% mas"
            )
        ),
        summary = "Semana con alta demanda de pizzas",
        dataWeeksUsed = 4
    )
) : DemandPredictionService {
    var lastBusinessName: String? = null
    var lastSalesHistory: List<ProductDailySales>? = null

    fun setResponse(result: DemandPredictionResult) {
        response = result
    }

    override suspend fun generatePrediction(
        businessName: String,
        salesHistory: List<ProductDailySales>,
        targetWeekStart: LocalDate
    ): DemandPredictionResult {
        lastBusinessName = businessName
        lastSalesHistory = salesHistory
        return response
    }
}

class DemandPredictionFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("pizzeria")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableProfiles = InMemoryDynamoDbTable<UserBusinessProfile>(
        "profiles",
        TableSchema.fromBean(UserBusinessProfile::class.java)
    ) { it.compositeKey ?: "" }
    private val orderRepository = ClientOrderRepository()
    private val productRepository = ProductRepository()
    private val fakePredictionService = FakeDemandPredictionService()

    private val function = DemandPredictionFunction(
        config = config,
        logger = logger,
        cognito = cognito,
        tableProfiles = tableProfiles,
        orderRepository = orderRepository,
        productRepository = productRepository,
        predictionService = fakePredictionService
    )

    private fun seedBusinessAdmin() {
        tableProfiles.putItem(UserBusinessProfile().apply {
            email = "admin@pizzeria.com"
            business = "pizzeria"
            profile = PROFILE_BUSINESS_ADMIN
            state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "admin@pizzeria.com" })
        }
    }

    private fun createDeliveredOrder(business: String, email: String, items: List<ClientOrderItemPayload>) {
        val order = ClientOrderPayload(
            status = "PENDING",
            items = items,
            total = items.sumOf { it.subtotal },
            createdAt = Instant.now().toString()
        )
        val created = orderRepository.createOrder(business, email, order)
        orderRepository.updateOrderStatus(business, created.id ?: "", "DELIVERED")
    }

    @Test
    fun `GET devuelve prediccion con datos de ventas`() = runBlocking {
        seedBusinessAdmin()

        createDeliveredOrder("pizzeria", "cliente@test.com", listOf(
            ClientOrderItemPayload(
                name = "Pizza Muzzarella",
                quantity = 2,
                unitPrice = 5000.0,
                subtotal = 10000.0
            )
        ))

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/demand-prediction",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DemandPredictionResponse)
        val predResponse = response as DemandPredictionResponse
        assertEquals(1, predResponse.topProducts.size)
        assertEquals("Pizza Muzzarella", predResponse.topProducts[0]["productName"])
        assertEquals("up", predResponse.topProducts[0]["trend"])
        assertTrue(predResponse.summary.isNotEmpty())
        assertEquals("pizzeria", fakePredictionService.lastBusinessName)
    }

    @Test
    fun `GET sin datos de ventas devuelve mensaje informativo`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/demand-prediction",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DemandPredictionResponse)
        val predResponse = response as DemandPredictionResponse
        assertTrue(predResponse.topProducts.isEmpty())
        assertTrue(predResponse.summary.contains("No hay"))
    }

    @Test
    fun `usuario no autorizado recibe UnauthorizedException`() = runBlocking {
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/demand-prediction",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `buildSalesHistory agrupa ventas por producto y dia`() {
        createDeliveredOrder("pizzeria", "c1@test.com", listOf(
            ClientOrderItemPayload(name = "Pizza", quantity = 2, unitPrice = 5000.0, subtotal = 10000.0),
            ClientOrderItemPayload(name = "Empanada", quantity = 6, unitPrice = 500.0, subtotal = 3000.0)
        ))
        createDeliveredOrder("pizzeria", "c2@test.com", listOf(
            ClientOrderItemPayload(name = "Pizza", quantity = 1, unitPrice = 5000.0, subtotal = 5000.0)
        ))

        val history = function.buildSalesHistory("pizzeria")

        assertTrue(history.isNotEmpty())
        val productNames = history.map { it.productName }.distinct()
        assertTrue(productNames.contains("Pizza"))
        assertTrue(productNames.contains("Empanada"))
    }

    @Test
    fun `buildSalesHistory ignora ordenes no entregadas`() {
        val order = ClientOrderPayload(
            status = "PENDING",
            items = listOf(ClientOrderItemPayload(name = "Pizza", quantity = 2, unitPrice = 5000.0, subtotal = 10000.0)),
            total = 10000.0,
            createdAt = Instant.now().toString()
        )
        orderRepository.createOrder("pizzeria", "c1@test.com", order)

        val history = function.buildSalesHistory("pizzeria")

        assertTrue(history.isEmpty())
    }

    @Test
    fun `buildSalesHistory retorna lista vacia para negocio sin ordenes`() {
        val history = function.buildSalesHistory("negocio-nuevo")
        assertTrue(history.isEmpty())
    }
}
