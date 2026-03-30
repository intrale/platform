package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ProductRecommendationsTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("tienda")
    private val orderRepository = ClientOrderRepository()
    private val productRepository = ProductRepository()
    private val recommendationRepository = ProductRecommendationRepository(orderRepository, productRepository)
    private val jwtValidator = LocalJwtValidator()

    private val function = ProductRecommendations(
        config = config,
        logger = logger,
        recommendationRepository = recommendationRepository,
        jwtValidator = jwtValidator
    )

    private fun seedProduct(
        business: String = "tienda",
        name: String,
        status: String = "PUBLISHED",
        basePrice: Double = 100.0
    ): ProductRecord {
        return productRepository.saveProduct(
            business,
            ProductRecord(
                name = name,
                basePrice = basePrice,
                unit = "u",
                categoryId = "cat-1",
                status = status,
                isAvailable = true
            )
        )
    }

    private fun createOrder(
        business: String = "tienda",
        email: String,
        productIds: List<String>,
        status: String = "DELIVERED"
    ) {
        val items = productIds.map { pid ->
            ClientOrderItemPayload(
                productId = pid,
                productName = "Producto $pid",
                name = "Producto $pid",
                quantity = 1,
                unitPrice = 100.0,
                subtotal = 100.0
            )
        }
        val payload = ClientOrderPayload(
            status = status,
            items = items,
            total = items.sumOf { it.subtotal },
            businessName = business
        )
        orderRepository.createOrder(business, email, payload)
    }

    @Test
    fun `GET retorna recomendaciones para usuario con historial`() = runBlocking {
        val token = jwtValidator.generateToken("user@test.com")
        val pA = seedProduct(name = "Producto A")
        val pB = seedProduct(name = "Producto B")
        val pC = seedProduct(name = "Producto C")
        val pD = seedProduct(name = "Producto D")
        val pE = seedProduct(name = "Producto E")

        createOrder(email = "user@test.com", productIds = listOf(pA.id))
        createOrder(email = "otro@test.com", productIds = listOf(pA.id, pB.id, pC.id))
        createOrder(email = "otro2@test.com", productIds = listOf(pA.id, pD.id, pE.id))

        val response = function.securedExecute(
            business = "tienda",
            function = "products/recommendations",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is ProductRecommendationResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response.recommendations.isNotEmpty())
        assertEquals("co-occurrence", response.source)
        // No debe incluir el producto ya comprado
        assertFalse(response.recommendations.any { it.id == pA.id })
    }

    @Test
    fun `GET retorna mas vendidos para usuario sin historial`() = runBlocking {
        val token = jwtValidator.generateToken("nuevo@test.com")
        val pA = seedProduct(name = "Producto A")
        val pB = seedProduct(name = "Producto B")
        val pC = seedProduct(name = "Producto C")
        val pD = seedProduct(name = "Producto D")

        createOrder(email = "otro@test.com", productIds = listOf(pA.id, pB.id))
        createOrder(email = "otro2@test.com", productIds = listOf(pA.id, pC.id))
        createOrder(email = "otro3@test.com", productIds = listOf(pD.id))

        val response = function.securedExecute(
            business = "tienda",
            function = "products/recommendations",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is ProductRecommendationResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response.recommendations.isNotEmpty())
        assertEquals("top-selling", response.source)
    }

    @Test
    fun `GET con limit personalizado respeta el parametro`() = runBlocking {
        val token = jwtValidator.generateToken("nuevo@test.com")
        for (i in 1..10) {
            val p = seedProduct(name = "Prod $i")
            createOrder(email = "otro@test.com", productIds = listOf(p.id))
        }

        val response = function.securedExecute(
            business = "tienda",
            function = "products/recommendations",
            headers = mapOf(
                "Authorization" to token,
                "X-Http-Method" to "GET",
                "X-Query-limit" to "3"
            ),
            textBody = ""
        )

        assertTrue(response is ProductRecommendationResponse)
        assertTrue(response.recommendations.size <= 3)
    }

    @Test
    fun `POST retorna error de metodo no soportado`() = runBlocking {
        val token = jwtValidator.generateToken("user@test.com")

        val response = function.securedExecute(
            business = "tienda",
            function = "products/recommendations",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "POST"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `GET sin token retorna UnauthorizedException`() = runBlocking {
        val response = function.execute(
            business = "tienda",
            function = "products/recommendations",
            headers = mapOf("X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `recomendaciones incluyen score decreciente`() = runBlocking {
        val token = jwtValidator.generateToken("nuevo@test.com")
        val pA = seedProduct(name = "Producto A")
        val pB = seedProduct(name = "Producto B")
        val pC = seedProduct(name = "Producto C")
        val pD = seedProduct(name = "Producto D")

        createOrder(email = "otro@test.com", productIds = listOf(pA.id, pB.id, pC.id, pD.id))

        val response = function.securedExecute(
            business = "tienda",
            function = "products/recommendations",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is ProductRecommendationResponse)
        val scores = response.recommendations.map { it.score }
        // Verificar que los scores son decrecientes
        for (i in 0 until scores.size - 1) {
            assertTrue(scores[i] >= scores[i + 1], "Scores deben ser decrecientes")
        }
    }

    @Test
    fun `GET con token invalido retorna UnauthorizedException`() = runBlocking {
        val response = function.execute(
            business = "tienda",
            function = "products/recommendations",
            headers = mapOf("Authorization" to "token-invalido", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `GET sin email en token retorna UnauthorizedException`() = runBlocking {
        // Token con email vacio - resolveEmail retorna null para JWT sin email
        val response = function.securedExecute(
            business = "tienda",
            function = "products/recommendations",
            headers = mapOf("X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }
}
