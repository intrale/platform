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

    @Test
    fun `GET retorna header ETag en la respuesta`() = runBlocking {
        seedProduct(name = "Chorizo", status = "PUBLISHED", basePrice = 800.0)

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is ClientProductListResponse)
        val etag = response.responseHeaders["ETag"]
        assertTrue(etag != null && etag.isNotBlank(), "La respuesta debe incluir header ETag")
        assertTrue(etag!!.startsWith("\"") && etag.endsWith("\""), "ETag debe estar entre comillas")
    }

    @Test
    fun `GET con If-None-Match coincidente retorna 304 Not Modified`() = runBlocking {
        seedProduct(name = "Morcilla", status = "PUBLISHED", basePrice = 500.0)

        val firstResponse = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        )
        assertTrue(firstResponse is ClientProductListResponse)
        val etag = firstResponse.responseHeaders["ETag"]!!

        val secondResponse = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET", "If-None-Match" to etag),
            textBody = ""
        )

        assertTrue(secondResponse is NotModifiedResponse)
        assertEquals(HttpStatusCode.NotModified, secondResponse.statusCode)
        assertEquals(etag, secondResponse.responseHeaders["ETag"])
    }

    @Test
    fun `GET con If-None-Match distinto retorna 200 con datos`() = runBlocking {
        seedProduct(name = "Vacío", status = "PUBLISHED", basePrice = 1500.0)

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET", "If-None-Match" to "\"etag-viejo\""),
            textBody = ""
        )

        assertTrue(response is ClientProductListResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals(1, response.products.size)
    }

    @Test
    fun `ETag cambia al publicar un producto nuevo`() = runBlocking {
        seedProduct(name = "Entraña", status = "PUBLISHED", basePrice = 1200.0)

        val firstResponse = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        ) as ClientProductListResponse
        val firstEtag = firstResponse.responseHeaders["ETag"]!!

        seedProduct(name = "Matambre", status = "PUBLISHED", basePrice = 900.0)

        val secondResponse = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        ) as ClientProductListResponse
        val secondEtag = secondResponse.responseHeaders["ETag"]!!

        assertTrue(firstEtag != secondEtag, "ETag debe cambiar cuando se agrega un producto publicado")
    }

    @Test
    fun `ETag cambia al despublicar un producto`() = runBlocking {
        val product = seedProduct(name = "Bife de chorizo", status = "PUBLISHED", basePrice = 2000.0)

        val firstResponse = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        ) as ClientProductListResponse
        val firstEtag = firstResponse.responseHeaders["ETag"]!!

        productRepository.updateProduct("la-carne", product.id, product.copy(status = "DRAFT"))

        val secondResponse = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        ) as ClientProductListResponse
        val secondEtag = secondResponse.responseHeaders["ETag"]!!

        assertTrue(firstEtag != secondEtag, "ETag debe cambiar cuando se despublica un producto")
    }

    @Test
    fun `computeETag es determinista para la misma lista de productos`() {
        val payloads = listOf(
            ClientProductPayload(id = "1", name = "Test", basePrice = 100.0, status = "PUBLISHED", isAvailable = true)
        )
        val etag1 = function.computeETag(payloads)
        val etag2 = function.computeETag(payloads)
        assertEquals(etag1, etag2, "computeETag debe ser determinista")
    }
}
