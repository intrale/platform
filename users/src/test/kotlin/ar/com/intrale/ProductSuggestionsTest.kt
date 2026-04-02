package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ProductSuggestionsTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("la-carne")
    private val productRepository = ProductRepository()
    private val jwtValidator = LocalJwtValidator()
    private val token = jwtValidator.generateToken("cliente@lacarne.com")

    private val function = ProductSuggestions(
        config = config,
        logger = logger,
        productRepository = productRepository,
        jwtValidator = jwtValidator
    )

    private fun seedProduct(
        business: String = "la-carne",
        name: String,
        status: String = "PUBLISHED",
        isAvailable: Boolean = true,
        stockQuantity: Int? = null
    ): ProductRecord {
        return productRepository.saveProduct(
            business,
            ProductRecord(
                name = name,
                basePrice = 1000.0,
                unit = "kg",
                categoryId = "cat-1",
                status = status,
                isAvailable = isAvailable,
                stockQuantity = stockQuantity
            )
        )
    }

    @Test
    fun `GET con query de 2 caracteres retorna sugerencias`() = runBlocking {
        seedProduct(name = "Asado de tira")
        seedProduct(name = "Asado americano")
        seedProduct(name = "Chorizo colorado")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products/suggestions",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET", "X-Query-q" to "as"),
            textBody = ""
        )

        assertTrue(response is ProductSuggestionsResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals(2, response.suggestions.size)
        assertEquals("as", response.query)
        assertTrue(response.suggestions.all { it.name.contains("Asado", ignoreCase = true) })
    }

    @Test
    fun `GET con query de 1 caracter retorna error de validacion`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "products/suggestions",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET", "X-Query-q" to "a"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `GET sin query retorna error de validacion`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "products/suggestions",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `GET filtra productos sin stock`() = runBlocking {
        seedProduct(name = "Asado con stock", stockQuantity = 5)
        seedProduct(name = "Asado sin stock", stockQuantity = 0)

        val response = function.securedExecute(
            business = "la-carne",
            function = "products/suggestions",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET", "X-Query-q" to "asado"),
            textBody = ""
        )

        assertTrue(response is ProductSuggestionsResponse)
        assertEquals(1, response.suggestions.size)
        assertEquals("Asado con stock", response.suggestions.first().name)
    }

    @Test
    fun `GET filtra productos no disponibles`() = runBlocking {
        seedProduct(name = "Asado disponible", isAvailable = true)
        seedProduct(name = "Asado no disponible", isAvailable = false)

        val response = function.securedExecute(
            business = "la-carne",
            function = "products/suggestions",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET", "X-Query-q" to "asado"),
            textBody = ""
        )

        assertTrue(response is ProductSuggestionsResponse)
        assertEquals(1, response.suggestions.size)
        assertEquals("Asado disponible", response.suggestions.first().name)
    }

    @Test
    fun `GET filtra productos no publicados`() = runBlocking {
        seedProduct(name = "Asado publicado", status = "PUBLISHED")
        seedProduct(name = "Asado borrador", status = "DRAFT")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products/suggestions",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET", "X-Query-q" to "asado"),
            textBody = ""
        )

        assertTrue(response is ProductSuggestionsResponse)
        assertEquals(1, response.suggestions.size)
        assertEquals("Asado publicado", response.suggestions.first().name)
    }

    @Test
    fun `GET prioriza coincidencia al inicio del nombre`() = runBlocking {
        seedProduct(name = "Lomo de asado")
        seedProduct(name = "Asado de tira")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products/suggestions",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET", "X-Query-q" to "asado"),
            textBody = ""
        )

        assertTrue(response is ProductSuggestionsResponse)
        assertEquals(2, response.suggestions.size)
        // El que empieza con "asado" debe venir primero
        assertEquals("Asado de tira", response.suggestions.first().name)
    }

    @Test
    fun `GET respeta el limite de sugerencias`() = runBlocking {
        for (i in 1..15) {
            seedProduct(name = "Producto $i")
        }

        val response = function.securedExecute(
            business = "la-carne",
            function = "products/suggestions",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET", "X-Query-q" to "producto", "X-Query-limit" to "5"),
            textBody = ""
        )

        assertTrue(response is ProductSuggestionsResponse)
        assertEquals(5, response.suggestions.size)
    }

    @Test
    fun `GET no retorna productos de otro negocio`() = runBlocking {
        seedProduct(business = "la-carne", name = "Asado propio")
        seedProduct(business = "otro-negocio", name = "Asado ajeno")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products/suggestions",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET", "X-Query-q" to "asado"),
            textBody = ""
        )

        assertTrue(response is ProductSuggestionsResponse)
        assertEquals(1, response.suggestions.size)
        assertEquals("Asado propio", response.suggestions.first().name)
    }

    @Test
    fun `metodo POST no soportado retorna error`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "products/suggestions",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "POST"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `GET sin token retorna UnauthorizedException`() = runBlocking {
        val response = function.execute(
            business = "la-carne",
            function = "products/suggestions",
            headers = mapOf("X-Http-Method" to "GET", "X-Query-q" to "asado"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `GET con productos con stock null los incluye como disponibles`() = runBlocking {
        seedProduct(name = "Asado sin control stock", stockQuantity = null)

        val response = function.securedExecute(
            business = "la-carne",
            function = "products/suggestions",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET", "X-Query-q" to "asado"),
            textBody = ""
        )

        assertTrue(response is ProductSuggestionsResponse)
        assertEquals(1, response.suggestions.size)
    }
}
