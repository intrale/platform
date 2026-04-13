package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ClientProductsAvailabilityTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("la-carne")
    private val productRepository = ProductRepository()
    private val jwtValidator = LocalJwtValidator()
    private val token = jwtValidator.generateToken("cliente@lacarne.com")

    private val function = ClientProductsAvailability(
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

    private fun postHeaders(extraHeaders: Map<String, String> = emptyMap()): Map<String, String> =
        mapOf("Authorization" to token, "X-Http-Method" to "POST") + extraHeaders

    private fun requestBody(vararg ids: String): String {
        val idsJson = ids.joinToString(",") { "\"$it\"" }
        return """{"productIds":[$idsJson]}"""
    }

    // --- Tests de disponibilidad correcta ---

    @Test
    fun `POST retorna productos disponibles cuando todos estan publicados y con stock`() = runBlocking {
        val p1 = seedProduct(name = "Asado", stockQuantity = 10)
        val p2 = seedProduct(name = "Chorizo", stockQuantity = 5)

        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = postHeaders(),
            textBody = requestBody(p1.id, p2.id)
        )

        assertTrue(response is ProductAvailabilityResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals(2, response.availability.items.size)
        assertTrue(response.availability.items.all { it.available })
        assertTrue(response.availability.items.all { it.reason == null })
    }

    @Test
    fun `POST retorna OUT_OF_STOCK para producto con stock cero`() = runBlocking {
        val product = seedProduct(name = "Vacio", stockQuantity = 0)

        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = postHeaders(),
            textBody = requestBody(product.id)
        )

        assertTrue(response is ProductAvailabilityResponse)
        val item = response.availability.items.first()
        assertFalse(item.available)
        assertEquals(ar.com.intrale.shared.client.SkipReason.OUT_OF_STOCK, item.reason)
        assertEquals("Vacio", item.name)
    }

    @Test
    fun `POST retorna DISCONTINUED para producto en estado DRAFT`() = runBlocking {
        val product = seedProduct(name = "Empanadas", status = "DRAFT")

        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = postHeaders(),
            textBody = requestBody(product.id)
        )

        assertTrue(response is ProductAvailabilityResponse)
        val item = response.availability.items.first()
        assertFalse(item.available)
        assertEquals(ar.com.intrale.shared.client.SkipReason.DISCONTINUED, item.reason)
    }

    @Test
    fun `POST retorna UNAVAILABLE para producto marcado como no disponible`() = runBlocking {
        val product = seedProduct(name = "Morcilla", isAvailable = false)

        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = postHeaders(),
            textBody = requestBody(product.id)
        )

        assertTrue(response is ProductAvailabilityResponse)
        val item = response.availability.items.first()
        assertFalse(item.available)
        assertEquals(ar.com.intrale.shared.client.SkipReason.UNAVAILABLE, item.reason)
    }

    @Test
    fun `POST retorna UNKNOWN_PRODUCT para ID inexistente`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = postHeaders(),
            textBody = requestBody("id-inexistente")
        )

        assertTrue(response is ProductAvailabilityResponse)
        val item = response.availability.items.first()
        assertFalse(item.available)
        assertEquals(ar.com.intrale.shared.client.SkipReason.UNKNOWN_PRODUCT, item.reason)
        assertEquals("", item.name)
    }

    @Test
    fun `POST retorna mezcla de disponibles y no disponibles`() = runBlocking {
        val available = seedProduct(name = "Chorizo", stockQuantity = 10)
        val outOfStock = seedProduct(name = "Bife", stockQuantity = 0)
        val draft = seedProduct(name = "Entraña", status = "DRAFT")

        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = postHeaders(),
            textBody = requestBody(available.id, outOfStock.id, draft.id, "no-existe")
        )

        assertTrue(response is ProductAvailabilityResponse)
        val items = response.availability.items
        assertEquals(4, items.size)

        val availableItem = items.first { it.productId == available.id }
        assertTrue(availableItem.available)
        assertNull(availableItem.reason)

        val outOfStockItem = items.first { it.productId == outOfStock.id }
        assertFalse(outOfStockItem.available)
        assertEquals(ar.com.intrale.shared.client.SkipReason.OUT_OF_STOCK, outOfStockItem.reason)

        val draftItem = items.first { it.productId == draft.id }
        assertFalse(draftItem.available)
        assertEquals(ar.com.intrale.shared.client.SkipReason.DISCONTINUED, draftItem.reason)

        val unknownItem = items.first { it.productId == "no-existe" }
        assertFalse(unknownItem.available)
        assertEquals(ar.com.intrale.shared.client.SkipReason.UNKNOWN_PRODUCT, unknownItem.reason)
    }

    // --- Tests de seguridad ---

    @Test
    fun `POST sin token retorna UnauthorizedException`() = runBlocking {
        val response = function.execute(
            business = "la-carne",
            function = "client/products/availability",
            headers = mapOf("X-Http-Method" to "POST"),
            textBody = requestBody("any-id")
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `POST retorna UNKNOWN_PRODUCT para producto de otro negocio (sin leak cross-business)`() = runBlocking {
        val otherProduct = seedProduct(business = "otro-negocio", name = "Producto ajeno")

        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = postHeaders(),
            textBody = requestBody(otherProduct.id)
        )

        assertTrue(response is ProductAvailabilityResponse)
        val item = response.availability.items.first()
        assertFalse(item.available)
        assertEquals(ar.com.intrale.shared.client.SkipReason.UNKNOWN_PRODUCT, item.reason)
        // No debe revelar el nombre del producto de otro negocio
        assertEquals("", item.name)
    }

    // --- Tests de validación ---

    @Test
    fun `POST con lista vacia retorna error de validacion`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = postHeaders(),
            textBody = """{"productIds":[]}"""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con mas de 50 IDs retorna error de validacion`() = runBlocking {
        val ids = (1..51).map { "id-$it" }
        val idsJson = ids.joinToString(",") { "\"$it\"" }

        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = postHeaders(),
            textBody = """{"productIds":[$idsJson]}"""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con IDs con caracteres invalidos retorna error de validacion`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = postHeaders(),
            textBody = """{"productIds":["valid-id","id con espacios"]}"""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `GET retorna error de metodo no soportado`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con body invalido retorna error de validacion`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = postHeaders(),
            textBody = "esto no es json"
        )

        assertTrue(response is RequestValidationException)
    }

    // --- Tests de producto disponible sin stock definido ---

    @Test
    fun `POST retorna disponible para producto publicado sin stock definido (null)`() = runBlocking {
        val product = seedProduct(name = "Sin control de stock", stockQuantity = null)

        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = postHeaders(),
            textBody = requestBody(product.id)
        )

        assertTrue(response is ProductAvailabilityResponse)
        val item = response.availability.items.first()
        assertTrue(item.available)
        assertNull(item.reason)
    }

    @Test
    fun `POST con IDs duplicados los deduplica`() = runBlocking {
        val product = seedProduct(name = "Duplicado")

        val response = function.securedExecute(
            business = "la-carne",
            function = "client/products/availability",
            headers = postHeaders(),
            textBody = requestBody(product.id, product.id, product.id)
        )

        assertTrue(response is ProductAvailabilityResponse)
        // Solo debe retornar 1 item (deduplicado)
        assertEquals(1, response.availability.items.size)
    }
}
