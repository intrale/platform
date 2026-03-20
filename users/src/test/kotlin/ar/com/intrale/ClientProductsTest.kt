package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
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
        basePrice: Double = 1000.0,
        categoryId: String = "cat-1"
    ): ProductRecord {
        return productRepository.saveProduct(
            business,
            ProductRecord(
                name = name,
                basePrice = basePrice,
                unit = "kg",
                categoryId = categoryId,
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
        assertNotNull(response.pagination)
        assertEquals(0, response.pagination!!.total)
        assertFalse(response.pagination!!.hasMore)
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
        assertEquals(1, response.pagination!!.total)
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

    // --- Tests de ETag ---

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
    fun `GET retorna header Cache-Control max-age=60 en respuesta 200`() = runBlocking {
        seedProduct(name = "Costillas", status = "PUBLISHED", basePrice = 1100.0)

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is ClientProductListResponse)
        assertEquals("max-age=60", response.responseHeaders["Cache-Control"])
    }

    @Test
    fun `GET con If-None-Match coincidente retorna Cache-Control en respuesta 304`() = runBlocking {
        seedProduct(name = "Paleta", status = "PUBLISHED", basePrice = 750.0)

        val firstResponse = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        ) as ClientProductListResponse
        val etag = firstResponse.responseHeaders["ETag"]!!

        val secondResponse = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET", "If-None-Match" to etag),
            textBody = ""
        )

        assertTrue(secondResponse is NotModifiedResponse)
        assertEquals("max-age=60", secondResponse.responseHeaders["Cache-Control"])
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

    // --- Tests de paginacion ---

    @Test
    fun `GET con offset y limit pagina correctamente`() = runBlocking {
        for (i in 1..5) {
            seedProduct(name = "Producto $i", status = "PUBLISHED", basePrice = i * 100.0)
        }

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf(
                "Authorization" to token,
                "X-Http-Method" to "GET",
                "X-Query-offset" to "0",
                "X-Query-limit" to "2"
            ),
            textBody = ""
        ) as ClientProductListResponse

        assertEquals(2, response.products.size)
        assertEquals(5, response.pagination!!.total)
        assertEquals(0, response.pagination!!.offset)
        assertEquals(2, response.pagination!!.limit)
        assertTrue(response.pagination!!.hasMore)
    }

    @Test
    fun `GET con offset avanzado retorna pagina siguiente`() = runBlocking {
        for (i in 1..5) {
            seedProduct(name = "Producto $i", status = "PUBLISHED", basePrice = i * 100.0)
        }

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf(
                "Authorization" to token,
                "X-Http-Method" to "GET",
                "X-Query-offset" to "3",
                "X-Query-limit" to "2"
            ),
            textBody = ""
        ) as ClientProductListResponse

        assertEquals(2, response.products.size)
        assertEquals(5, response.pagination!!.total)
        assertEquals(3, response.pagination!!.offset)
        assertFalse(response.pagination!!.hasMore)
    }

    @Test
    fun `GET con offset mayor al total retorna lista vacia`() = runBlocking {
        seedProduct(name = "Unico producto", status = "PUBLISHED")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf(
                "Authorization" to token,
                "X-Http-Method" to "GET",
                "X-Query-offset" to "100",
                "X-Query-limit" to "20"
            ),
            textBody = ""
        ) as ClientProductListResponse

        assertTrue(response.products.isEmpty())
        assertEquals(1, response.pagination!!.total)
        assertFalse(response.pagination!!.hasMore)
    }

    // --- Tests de filtro por categoria ---

    @Test
    fun `GET con filtro de categoria retorna solo productos de esa categoria`() = runBlocking {
        seedProduct(name = "Asado", status = "PUBLISHED", categoryId = "carnes")
        seedProduct(name = "Lechuga", status = "PUBLISHED", categoryId = "verduras")
        seedProduct(name = "Chorizo", status = "PUBLISHED", categoryId = "carnes")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf(
                "Authorization" to token,
                "X-Http-Method" to "GET",
                "X-Query-category" to "carnes"
            ),
            textBody = ""
        ) as ClientProductListResponse

        assertEquals(2, response.products.size)
        assertEquals(2, response.pagination!!.total)
        assertTrue(response.products.all { it.name in listOf("Asado", "Chorizo") })
    }

    // --- Tests de busqueda por nombre ---

    @Test
    fun `GET con filtro de busqueda retorna productos que coinciden`() = runBlocking {
        seedProduct(name = "Asado de tira", status = "PUBLISHED")
        seedProduct(name = "Chorizo colorado", status = "PUBLISHED")
        seedProduct(name = "Asado americano", status = "PUBLISHED")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf(
                "Authorization" to token,
                "X-Http-Method" to "GET",
                "X-Query-search" to "asado"
            ),
            textBody = ""
        ) as ClientProductListResponse

        assertEquals(2, response.products.size)
        assertEquals(2, response.pagination!!.total)
        assertTrue(response.products.all { it.name.contains("Asado", ignoreCase = true) })
    }

    @Test
    fun `GET con filtros combinados de categoria y busqueda`() = runBlocking {
        seedProduct(name = "Asado de tira", status = "PUBLISHED", categoryId = "carnes")
        seedProduct(name = "Asado vegano", status = "PUBLISHED", categoryId = "vegano")
        seedProduct(name = "Chorizo", status = "PUBLISHED", categoryId = "carnes")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf(
                "Authorization" to token,
                "X-Http-Method" to "GET",
                "X-Query-category" to "carnes",
                "X-Query-search" to "asado"
            ),
            textBody = ""
        ) as ClientProductListResponse

        assertEquals(1, response.products.size)
        assertEquals("Asado de tira", response.products.first().name)
    }

    @Test
    fun `GET valores por defecto de paginacion cuando no se especifican`() = runBlocking {
        seedProduct(name = "Producto test", status = "PUBLISHED")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        ) as ClientProductListResponse

        assertNotNull(response.pagination)
        assertEquals(0, response.pagination!!.offset)
        assertEquals(ClientProducts.DEFAULT_LIMIT, response.pagination!!.limit)
    }

    @Test
    fun `GET con limit mayor al maximo se ajusta al maximo`() = runBlocking {
        seedProduct(name = "Producto test", status = "PUBLISHED")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf(
                "Authorization" to token,
                "X-Http-Method" to "GET",
                "X-Query-limit" to "500"
            ),
            textBody = ""
        ) as ClientProductListResponse

        assertEquals(ClientProducts.MAX_LIMIT, response.pagination!!.limit)
    }

    @Test
    fun `GET con offset negativo se ajusta a cero`() = runBlocking {
        seedProduct(name = "Producto test", status = "PUBLISHED")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf(
                "Authorization" to token,
                "X-Http-Method" to "GET",
                "X-Query-offset" to "-5"
            ),
            textBody = ""
        ) as ClientProductListResponse

        assertEquals(0, response.pagination!!.offset)
    }

    @Test
    fun `GET con filtros y ETag coincidente retorna 304`() = runBlocking {
        seedProduct(name = "Asado premium", status = "PUBLISHED", categoryId = "carnes")
        seedProduct(name = "Lechuga fresca", status = "PUBLISHED", categoryId = "verduras")

        val firstResponse = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf(
                "Authorization" to token,
                "X-Http-Method" to "GET",
                "X-Query-category" to "carnes"
            ),
            textBody = ""
        ) as ClientProductListResponse
        val etag = firstResponse.responseHeaders["ETag"]!!

        val secondResponse = function.securedExecute(
            business = "la-carne",
            function = "products",
            headers = mapOf(
                "Authorization" to token,
                "X-Http-Method" to "GET",
                "X-Query-category" to "carnes",
                "If-None-Match" to etag
            ),
            textBody = ""
        )

        assertTrue(secondResponse is NotModifiedResponse)
        assertEquals(HttpStatusCode.NotModified, secondResponse.statusCode)
        assertEquals("max-age=60", secondResponse.responseHeaders["Cache-Control"])
    }
}
