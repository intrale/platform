package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ClientProductsAvailabilityTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("la-carne")
    private val productRepository = ProductRepository()
    private val jwtValidator = LocalJwtValidator()
    private val token = jwtValidator.generateToken("cliente@lacarne.com")
    private val gson = Gson()

    private val function = ClientProductsAvailability(
        config = config,
        logger = logger,
        productRepository = productRepository,
        jwtValidator = jwtValidator
    )

    private fun seedProduct(
        business: String = "la-carne",
        id: String? = null,
        name: String,
        status: String = "PUBLISHED",
        isAvailable: Boolean = true,
        stockQuantity: Int? = null
    ): ProductRecord {
        val record = ProductRecord(
            id = id ?: "",
            name = name,
            basePrice = 100.0,
            unit = "kg",
            categoryId = "cat-1",
            status = status,
            isAvailable = isAvailable,
            stockQuantity = stockQuantity
        )
        return productRepository.saveProduct(business, record)
    }

    private fun requestBody(productIds: List<String>): String =
        gson.toJson(mapOf("productIds" to productIds))

    private fun executePost(
        business: String = "la-carne",
        body: String,
        authToken: String = token
    ) = runBlocking {
        function.securedExecute(
            business = business,
            function = "client/products/availability",
            headers = mapOf(
                "Authorization" to authToken,
                "X-Http-Method" to "POST"
            ),
            textBody = body
        )
    }

    // --- Tests de productos disponibles ---

    @Test
    fun `POST retorna producto disponible cuando esta publicado y con stock`() {
        val product = seedProduct(name = "Asado", status = "PUBLISHED", isAvailable = true)

        val response = executePost(body = requestBody(listOf(product.id)))

        assertTrue(response is ProductAvailabilityResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals(1, response.items.size)
        assertTrue(response.items[0].available)
        assertNull(response.items[0].reason)
        assertEquals(product.id, response.items[0].productId)
    }

    @Test
    fun `POST retorna multiples productos disponibles`() {
        val p1 = seedProduct(name = "Chorizo", status = "PUBLISHED")
        val p2 = seedProduct(name = "Morcilla", status = "PUBLISHED")

        val response = executePost(body = requestBody(listOf(p1.id, p2.id)))

        assertTrue(response is ProductAvailabilityResponse)
        assertEquals(2, response.items.size)
        assertTrue(response.items.all { it.available })
    }

    // --- Tests de motivos de exclusion ---

    @Test
    fun `POST retorna UNKNOWN_PRODUCT para ID inexistente`() {
        val response = executePost(body = requestBody(listOf("id-no-existe")))

        assertTrue(response is ProductAvailabilityResponse)
        assertEquals(1, response.items.size)
        assertFalse(response.items[0].available)
        assertEquals("UNKNOWN_PRODUCT", response.items[0].reason)
    }

    @Test
    fun `POST retorna DISCONTINUED para producto no publicado`() {
        val product = seedProduct(name = "Producto viejo", status = "DRAFT")

        val response = executePost(body = requestBody(listOf(product.id)))

        assertTrue(response is ProductAvailabilityResponse)
        assertFalse(response.items[0].available)
        assertEquals("DISCONTINUED", response.items[0].reason)
    }

    @Test
    fun `POST retorna UNAVAILABLE para producto publicado pero no disponible`() {
        val product = seedProduct(name = "En mantenimiento", status = "PUBLISHED", isAvailable = false)

        val response = executePost(body = requestBody(listOf(product.id)))

        assertTrue(response is ProductAvailabilityResponse)
        assertFalse(response.items[0].available)
        assertEquals("UNAVAILABLE", response.items[0].reason)
    }

    @Test
    fun `POST retorna OUT_OF_STOCK para producto sin stock`() {
        val product = seedProduct(
            name = "Agotado", status = "PUBLISHED",
            isAvailable = true, stockQuantity = 0
        )

        val response = executePost(body = requestBody(listOf(product.id)))

        assertTrue(response is ProductAvailabilityResponse)
        assertFalse(response.items[0].available)
        assertEquals("OUT_OF_STOCK", response.items[0].reason)
    }

    @Test
    fun `POST retorna mix de productos disponibles y no disponibles`() {
        val available = seedProduct(name = "Disponible", status = "PUBLISHED")
        val unavailable = seedProduct(name = "No disponible", status = "DRAFT")

        val response = executePost(
            body = requestBody(listOf(available.id, unavailable.id, "fantasma"))
        )

        assertTrue(response is ProductAvailabilityResponse)
        assertEquals(3, response.items.size)

        val availableItem = response.items.first { it.productId == available.id }
        assertTrue(availableItem.available)
        assertNull(availableItem.reason)

        val discontinuedItem = response.items.first { it.productId == unavailable.id }
        assertFalse(discontinuedItem.available)
        assertEquals("DISCONTINUED", discontinuedItem.reason)

        val unknownItem = response.items.first { it.productId == "fantasma" }
        assertFalse(unknownItem.available)
        assertEquals("UNKNOWN_PRODUCT", unknownItem.reason)
    }

    // --- Tests de seguridad: aislamiento cross-business ---

    @Test
    fun `POST retorna UNKNOWN_PRODUCT para producto de otro negocio`() {
        val product = seedProduct(
            business = "otro-negocio", name = "Producto ajeno", status = "PUBLISHED"
        )

        val response = executePost(
            business = "la-carne",
            body = requestBody(listOf(product.id))
        )

        assertTrue(response is ProductAvailabilityResponse)
        assertFalse(response.items[0].available)
        assertEquals("UNKNOWN_PRODUCT", response.items[0].reason)
    }

    // --- Tests de validacion ---

    @Test
    fun `POST con lista vacia retorna error de validacion`() {
        val response = executePost(body = requestBody(emptyList()))

        assertTrue(response is RequestValidationException)
        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `POST con mas de 50 IDs retorna error de validacion`() {
        val ids = (1..51).map { "id-$it" }

        val response = executePost(body = requestBody(ids))

        assertTrue(response is RequestValidationException)
        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `POST con IDs duplicados retorna error de validacion`() {
        val response = executePost(body = requestBody(listOf("id-1", "id-1")))

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con ID vacio retorna error de validacion`() {
        val response = executePost(body = requestBody(listOf("")))

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con ID con caracteres especiales retorna error de validacion`() {
        val response = executePost(body = requestBody(listOf("id;DROP TABLE")))

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con body vacio retorna error de validacion`() {
        val response = executePost(body = "")

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con body JSON invalido retorna error de validacion`() {
        val response = executePost(body = "esto no es json")

        assertTrue(response is RequestValidationException)
    }

    // --- Tests de metodo HTTP ---

    @Test
    fun `GET retorna metodo no soportado`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = mapOf(
                "Authorization" to token,
                "X-Http-Method" to "GET"
            ),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    // --- Test de autenticacion ---

    @Test
    fun `POST sin token retorna Unauthorized`() = runBlocking {
        val response = function.execute(
            business = "la-carne",
            function = "client/products/availability",
            headers = mapOf("X-Http-Method" to "POST"),
            textBody = requestBody(listOf("id-1"))
        )

        assertTrue(response is UnauthorizedException)
    }

    // --- Test de exactamente 50 IDs (limite) ---

    @Test
    fun `POST con exactamente 50 IDs es aceptado`() {
        val ids = (1..50).map { "id-$it" }

        val response = executePost(body = requestBody(ids))

        assertTrue(response is ProductAvailabilityResponse)
        assertEquals(50, response.items.size)
    }

    // --- Test de producto con stockQuantity null (sin gestion de stock) ---

    @Test
    fun `POST retorna disponible para producto con stockQuantity null`() {
        val product = seedProduct(
            name = "Sin control de stock",
            status = "PUBLISHED",
            isAvailable = true,
            stockQuantity = null
        )

        val response = executePost(body = requestBody(listOf(product.id)))

        assertTrue(response is ProductAvailabilityResponse)
        assertTrue(response.items[0].available)
    }

    // --- Test de stock negativo ---

    @Test
    fun `POST retorna OUT_OF_STOCK para producto con stock negativo`() {
        val product = seedProduct(
            name = "Stock negativo",
            status = "PUBLISHED",
            isAvailable = true,
            stockQuantity = -1
        )

        val response = executePost(body = requestBody(listOf(product.id)))

        assertTrue(response is ProductAvailabilityResponse)
        assertFalse(response.items[0].available)
        assertEquals("OUT_OF_STOCK", response.items[0].reason)
    }
}
