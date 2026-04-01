package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Fake del servicio de busqueda conversacional para tests.
 */
class FakeConversationalSearchService(
    private var result: ConversationalSearchResult = ConversationalSearchResult(
        suggestions = listOf(
            ProductSuggestion(
                productId = "p1",
                name = "Harina 000",
                reason = "Ingrediente basico para hacer pizza",
                price = 1500.0,
                unit = "kg",
                category = "Harinas",
                relevance = 0.95
            )
        ),
        message = "Encontre estos productos que te pueden servir para hacer pizza:",
        hasResults = true,
        confidence = 0.9
    )
) : ConversationalSearchService {
    var lastQuery: String? = null
    var lastProducts: List<ProductRecord>? = null
    var lastBusinessName: String? = null

    fun setResult(newResult: ConversationalSearchResult) {
        result = newResult
    }

    override suspend fun search(
        query: String,
        products: List<ProductRecord>,
        businessName: String
    ): ConversationalSearchResult {
        lastQuery = query
        lastProducts = products
        lastBusinessName = businessName
        return result
    }
}

class ConversationalSearchFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val tableBusiness = InMemoryDynamoDbTable<Business>(
        "business",
        TableSchema.fromBean(Business::class.java)
    ) { it.name ?: "" }
    private val productRepository = ProductRepository()
    private val fakeSearchService = FakeConversationalSearchService()
    private val gson = Gson()

    private val function = ConversationalSearchFunction(
        logger, tableBusiness, productRepository, fakeSearchService
    )

    @Test
    fun `POST con consulta valida devuelve sugerencias de productos`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "almacen" })
        productRepository.saveProduct("almacen", ProductRecord(
            id = "p1", name = "Harina 000", basePrice = 1500.0,
            unit = "kg", status = "PUBLISHED", isAvailable = true, categoryId = "Harinas"
        ))

        val body = ConversationalSearchRequest(query = "algo para hacer una pizza")

        val response = function.execute(
            business = "almacen",
            function = "conversational-search",
            headers = mapOf("X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ConversationalSearchResponse)
        val searchResponse = response as ConversationalSearchResponse
        assertTrue(searchResponse.hasResults)
        assertEquals(1, searchResponse.suggestions.size)
        assertEquals("Harina 000", searchResponse.suggestions.first().name)
        assertEquals("algo para hacer una pizza", fakeSearchService.lastQuery)
        assertEquals("almacen", fakeSearchService.lastBusinessName)
    }

    @Test
    fun `POST sin resultados devuelve mensaje amable`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "almacen" })
        productRepository.saveProduct("almacen", ProductRecord(
            id = "p1", name = "Leche", basePrice = 800.0,
            unit = "litro", status = "PUBLISHED", isAvailable = true
        ))
        fakeSearchService.setResult(ConversationalSearchResult(
            suggestions = emptyList(),
            message = "No encontre productos que coincidan con tu busqueda. Intenta con otra descripcion.",
            hasResults = false,
            confidence = 0.8
        ))

        val body = ConversationalSearchRequest(query = "necesito tornillos")

        val response = function.execute(
            business = "almacen",
            function = "conversational-search",
            headers = mapOf("X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ConversationalSearchResponse)
        val searchResponse = response as ConversationalSearchResponse
        assertFalse(searchResponse.hasResults)
        assertTrue(searchResponse.suggestions.isEmpty())
        assertTrue(searchResponse.message.contains("No encontre"))
    }

    @Test
    fun `POST a negocio inexistente devuelve NotFound`() = runBlocking {
        val body = ConversationalSearchRequest(query = "quiero algo dulce")

        val response = function.execute(
            business = "no-existe",
            function = "conversational-search",
            headers = emptyMap(),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `POST con consulta vacia devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "almacen" })

        val body = ConversationalSearchRequest(query = "")

        val response = function.execute(
            business = "almacen",
            function = "conversational-search",
            headers = emptyMap(),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con consulta muy larga devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "almacen" })

        val body = ConversationalSearchRequest(query = "a".repeat(501))

        val response = function.execute(
            business = "almacen",
            function = "conversational-search",
            headers = emptyMap(),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST sin body devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "almacen" })

        val response = function.execute(
            business = "almacen",
            function = "conversational-search",
            headers = emptyMap(),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST a negocio sin productos devuelve mensaje informativo`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "almacen-vacio" })

        val body = ConversationalSearchRequest(query = "algo para comer")

        val response = function.execute(
            business = "almacen-vacio",
            function = "conversational-search",
            headers = emptyMap(),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ConversationalSearchResponse)
        val searchResponse = response as ConversationalSearchResponse
        assertFalse(searchResponse.hasResults)
        assertTrue(searchResponse.message.contains("no tiene productos"))
    }

    @Test
    fun `POST envia solo productos publicados al servicio de busqueda`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "almacen" })
        productRepository.saveProduct("almacen", ProductRecord(
            id = "p1", name = "Publicado", basePrice = 100.0,
            unit = "unidad", status = "PUBLISHED"
        ))
        productRepository.saveProduct("almacen", ProductRecord(
            id = "p2", name = "Borrador", basePrice = 200.0,
            unit = "unidad", status = "DRAFT"
        ))

        val body = ConversationalSearchRequest(query = "algo")

        function.execute(
            business = "almacen",
            function = "conversational-search",
            headers = mapOf("X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        // Solo el producto publicado debe llegar al servicio
        assertEquals(1, fakeSearchService.lastProducts?.size)
        assertEquals("Publicado", fakeSearchService.lastProducts?.first()?.name)
    }
}
