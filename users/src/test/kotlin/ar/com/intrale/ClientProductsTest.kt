package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ClientProductsTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("la-carne")
    private val productRepository = ProductRepository()
    private val jwtValidator = LocalJwtValidator()
    private val token = jwtValidator.generateToken("cliente@lacarne.com")

    private val function = ClientProducts(
        config = config,
        logger = logger,
        productRepository = productRepository,
        jwtValidator = jwtValidator
    )

    private fun seedProduct(
        business: String = "la-carne",
        name: String,
        status: String = "DRAFT",
        basePrice: Double = 1000.0
    ): ProductRecord {
        return productRepository.saveProduct(
            business,
            ProductRecord(
                name = name,
                basePrice = basePrice,
                unit = "kg",
                categoryId = "cat-1",
                status = status,
                isAvailable = true
            )
        )
    }

    @Test
    fun `GET retorna lista vacia cuando no hay productos publicados`() = runBlocking {
        seedProduct(name = "Asado en borrador", status = "DRAFT")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is ClientProductListResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response.products.isEmpty())
    }

    @Test
    fun `GET retorna solo productos publicados`() = runBlocking {
        seedProduct(name = "Chorizo colorado", status = "PUBLISHED", basePrice = 800.0)
        seedProduct(name = "Asado borrador", status = "DRAFT", basePrice = 2500.0)

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is ClientProductListResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals(1, response.products.size)
        assertEquals("Chorizo colorado", response.products.first().name)
        assertEquals("PUBLISHED", response.products.first().status)
    }

    @Test
    fun `GET no devuelve productos de otro negocio`() = runBlocking {
        seedProduct(business = "otro-negocio", name = "Producto ajeno", status = "PUBLISHED")
        seedProduct(business = "la-carne", name = "Producto propio", status = "PUBLISHED")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is ClientProductListResponse)
        assertEquals(1, response.products.size)
        assertEquals("Producto propio", response.products.first().name)
    }

    @Test
    fun `cambio de DRAFT a PUBLISHED hace visible el producto`() = runBlocking {
        val product = seedProduct(name = "Empanadas x12", status = "DRAFT")

        val beforeResponse = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        ) as ClientProductListResponse
        assertTrue(beforeResponse.products.isEmpty())

        productRepository.updateProduct(
            "la-carne",
            product.id,
            product.copy(status = "PUBLISHED")
        )

        val afterResponse = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        ) as ClientProductListResponse
        assertEquals(1, afterResponse.products.size)
        assertEquals("Empanadas x12", afterResponse.products.first().name)
    }

    @Test
    fun `cambio de PUBLISHED a DRAFT oculta el producto`() = runBlocking {
        val product = seedProduct(name = "Milanesa de pollo", status = "PUBLISHED")

        val beforeResponse = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        ) as ClientProductListResponse
        assertEquals(1, beforeResponse.products.size)

        productRepository.updateProduct(
            "la-carne",
            product.id,
            product.copy(status = "DRAFT")
        )

        val afterResponse = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        ) as ClientProductListResponse
        assertTrue(afterResponse.products.isEmpty())
    }

    @Test
    fun `GET sin token retorna UnauthorizedException`() = runBlocking {
        val response = function.execute(
            business = "la-carne",
            function = "products",
            headers = mapOf("X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `metodo no soportado retorna error`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "POST"),
            textBody = Gson().toJson(mapOf("name" to "test"))
        )

        assertTrue(response is RequestValidationException)
    }
}
