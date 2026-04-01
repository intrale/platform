package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.LoggerFactory
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class TranslateCatalogFunctionTest {

    private val logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val tableBusiness = mockk<DynamoDbTable<Business>>()
    private val productRepository = ProductRepository()
    private val translationService = FakeTranslationService()
    private val translationCache = TranslationCacheRepository()

    private val function = TranslateCatalogFunction(
        logger = logger,
        tableBusiness = tableBusiness,
        productRepository = productRepository,
        translationService = translationService,
        translationCache = translationCache
    )

    private fun setupBusiness(name: String = "test-business") {
        val business = Business().apply {
            this.name = name
            this.businessId = "biz-123"
            this.description = "Negocio de prueba"
        }
        every { tableBusiness.getItem(any<Business>()) } returns business
    }

    private fun setupProducts(business: String = "test-business") {
        productRepository.saveProduct(business, ProductRecord(
            id = "prod-1",
            name = "Empanadas de carne",
            shortDescription = "Empanadas caseras de carne cortada a cuchillo",
            basePrice = 500.0,
            unit = "docena",
            categoryId = "cat-1",
            status = "PUBLISHED",
            isAvailable = true
        ))
        productRepository.saveProduct(business, ProductRecord(
            id = "prod-2",
            name = "Medialunas",
            shortDescription = "Medialunas de manteca recien horneadas",
            basePrice = 200.0,
            unit = "docena",
            categoryId = "cat-1",
            status = "PUBLISHED",
            isAvailable = true,
            isFeatured = true
        ))
    }

    @Test
    fun `traduce catalogo al ingles correctamente`() = runBlocking {
        setupBusiness()
        setupProducts()
        translationService.nextResult = Result.success(listOf(
            "Beef empanadas",
            "Homemade beef empanadas hand-cut",
            "Croissants",
            "Freshly baked butter croissants"
        ))

        val request = TranslateCatalogRequest(targetLocale = "en")
        val response = function.execute(
            "test-business", "translate-catalog",
            mapOf("X-Http-Method" to "POST"),
            gson.toJson(request)
        )

        assertTrue(response is TranslateCatalogResponse)
        val translated = response as TranslateCatalogResponse
        assertEquals(2, translated.products.size)
        assertTrue(translated.translated)
        assertEquals("en", translated.targetLocale)

        val first = translated.products.first { it.id == "prod-1" }
        assertEquals("Beef empanadas", first.name)
        assertEquals("Empanadas de carne", first.originalName)
        assertEquals("Homemade beef empanadas hand-cut", first.shortDescription)
        assertEquals("Empanadas caseras de carne cortada a cuchillo", first.originalDescription)
        assertTrue(first.translated)
        assertEquals(500.0, first.basePrice)
        assertEquals("docena", first.unit)
    }

    @Test
    fun `devuelve productos sin traducir cuando locale es espanol`() = runBlocking {
        setupBusiness()
        setupProducts()

        val request = TranslateCatalogRequest(targetLocale = "es")
        val response = function.execute(
            "test-business", "translate-catalog",
            mapOf("X-Http-Method" to "POST"),
            gson.toJson(request)
        )

        assertTrue(response is TranslateCatalogResponse)
        val result = response as TranslateCatalogResponse
        assertFalse(result.translated)
        assertEquals("es", result.targetLocale)
        assertEquals(2, result.products.size)
        assertFalse(result.products.first().translated)
    }

    @Test
    fun `usa cache para traducciones repetidas`() = runBlocking {
        setupBusiness()
        setupProducts()

        // Primera vez: traduce via servicio
        translationService.nextResult = Result.success(listOf(
            "Beef empanadas", "Homemade beef empanadas",
            "Croissants", "Butter croissants"
        ))

        val request = TranslateCatalogRequest(targetLocale = "en")
        function.execute("test-business", "translate-catalog",
            mapOf("X-Http-Method" to "POST"), gson.toJson(request))

        assertEquals(1, translationService.callCount)

        // Segunda vez: debe usar cache
        translationService.nextResult = Result.success(emptyList())
        val response = function.execute("test-business", "translate-catalog",
            mapOf("X-Http-Method" to "POST"), gson.toJson(request))

        // No deberia haber llamado al servicio de nuevo
        assertEquals(1, translationService.callCount)

        assertTrue(response is TranslateCatalogResponse)
        val result = response as TranslateCatalogResponse
        assertEquals(2, result.products.size)
        assertEquals("Beef empanadas", result.products.first { it.id == "prod-1" }.name)
    }

    @Test
    fun `retorna error cuando negocio no existe`() = runBlocking {
        every { tableBusiness.getItem(any<Business>()) } returns null

        val request = TranslateCatalogRequest(targetLocale = "en")
        val response = function.execute(
            "nonexistent", "translate-catalog",
            mapOf("X-Http-Method" to "POST"),
            gson.toJson(request)
        )

        assertTrue(response is ExceptionResponse)
        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `retorna error cuando locale no es soportado`() = runBlocking {
        setupBusiness()

        val request = TranslateCatalogRequest(targetLocale = "zh")
        val response = function.execute(
            "test-business", "translate-catalog",
            mapOf("X-Http-Method" to "POST"),
            gson.toJson(request)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `retorna error cuando falta targetLocale`() = runBlocking {
        setupBusiness()

        val response = function.execute(
            "test-business", "translate-catalog",
            emptyMap(),
            ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `resuelve locale desde header Accept-Language`() = runBlocking {
        setupBusiness()
        setupProducts()
        translationService.nextResult = Result.success(listOf(
            "Beef empanadas", "Homemade beef empanadas",
            "Croissants", "Butter croissants"
        ))

        val response = function.execute(
            "test-business", "translate-catalog",
            mapOf("Accept-Language" to "en-US,en;q=0.9,es;q=0.8"),
            ""
        )

        assertTrue(response is TranslateCatalogResponse)
        val result = response as TranslateCatalogResponse
        assertEquals("en", result.targetLocale)
        assertTrue(result.translated)
    }

    @Test
    fun `resuelve locale desde query parameter`() = runBlocking {
        setupBusiness()
        setupProducts()
        translationService.nextResult = Result.success(listOf(
            "Empanadas de carne", "Empanadas caseiras de carne cortada a faca",
            "Medialunas", "Croissants de manteiga recem assados"
        ))

        val response = function.execute(
            "test-business", "translate-catalog",
            mapOf("X-Query-locale" to "pt"),
            ""
        )

        assertTrue(response is TranslateCatalogResponse)
        val result = response as TranslateCatalogResponse
        assertEquals("pt", result.targetLocale)
    }

    @Test
    fun `maneja fallo del servicio de traduccion con fallback`() = runBlocking {
        setupBusiness()
        setupProducts()
        translationService.nextResult = Result.failure(RuntimeException("API no disponible"))

        val request = TranslateCatalogRequest(targetLocale = "en")
        val response = function.execute(
            "test-business", "translate-catalog",
            mapOf("X-Http-Method" to "POST"),
            gson.toJson(request)
        )

        assertTrue(response is TranslateCatalogResponse)
        val result = response as TranslateCatalogResponse
        // Debe devolver productos sin traducir como fallback
        assertEquals(2, result.products.size)
        result.products.forEach { product ->
            assertFalse(product.translated)
            assertEquals(product.name, product.originalName)
        }
    }

    @Test
    fun `traduce solo productos especificos por ID`() = runBlocking {
        setupBusiness()
        setupProducts()
        translationService.nextResult = Result.success(listOf(
            "Beef empanadas", "Homemade beef empanadas"
        ))

        val request = TranslateCatalogRequest(
            targetLocale = "en",
            productIds = listOf("prod-1")
        )
        val response = function.execute(
            "test-business", "translate-catalog",
            mapOf("X-Http-Method" to "POST"),
            gson.toJson(request)
        )

        assertTrue(response is TranslateCatalogResponse)
        val result = response as TranslateCatalogResponse
        assertEquals(1, result.products.size)
        assertEquals("prod-1", result.products.first().id)
    }

    @Test
    fun `respeta paginacion con offset y limit`() = runBlocking {
        setupBusiness()
        // Agregar varios productos
        for (i in 1..10) {
            productRepository.saveProduct("test-business", ProductRecord(
                id = "prod-$i",
                name = "Producto $i",
                shortDescription = "Descripcion $i",
                basePrice = i * 100.0,
                unit = "unidad",
                categoryId = "cat-1",
                status = "PUBLISHED",
                isAvailable = true
            ))
        }

        // Mock traducciones para 3 productos
        translationService.nextResult = Result.success(listOf(
            "Product 1", "Description 1",
            "Product 2", "Description 2",
            "Product 3", "Description 3"
        ))

        val request = TranslateCatalogRequest(targetLocale = "en", offset = 0, limit = 3)
        val response = function.execute(
            "test-business", "translate-catalog",
            mapOf("X-Http-Method" to "POST"),
            gson.toJson(request)
        )

        assertTrue(response is TranslateCatalogResponse)
        val result = response as TranslateCatalogResponse
        assertEquals(3, result.products.size)
        assertNotNull(result.pagination)
        assertTrue(result.pagination!!.hasMore)
        assertEquals(10, result.pagination!!.total)
    }

    @Test
    fun `devuelve lista vacia cuando no hay productos publicados`() = runBlocking {
        setupBusiness()
        // No agregar productos

        val request = TranslateCatalogRequest(targetLocale = "en")
        val response = function.execute(
            "test-business", "translate-catalog",
            mapOf("X-Http-Method" to "POST"),
            gson.toJson(request)
        )

        assertTrue(response is TranslateCatalogResponse)
        val result = response as TranslateCatalogResponse
        assertEquals(0, result.products.size)
        assertFalse(result.translated)
    }

    @Test
    fun `precios y unidades no se modifican en la traduccion`() = runBlocking {
        setupBusiness()
        setupProducts()
        translationService.nextResult = Result.success(listOf(
            "Beef empanadas", "Homemade empanadas",
            "Croissants", "Butter croissants"
        ))

        val request = TranslateCatalogRequest(targetLocale = "en")
        val response = function.execute(
            "test-business", "translate-catalog",
            mapOf("X-Http-Method" to "POST"),
            gson.toJson(request)
        )

        assertTrue(response is TranslateCatalogResponse)
        val result = response as TranslateCatalogResponse
        val prod1 = result.products.first { it.id == "prod-1" }
        assertEquals(500.0, prod1.basePrice)
        assertEquals("docena", prod1.unit)
        val prod2 = result.products.first { it.id == "prod-2" }
        assertEquals(200.0, prod2.basePrice)
        assertEquals("docena", prod2.unit)
    }
}

/**
 * Fake del servicio de traduccion para tests.
 */
class FakeTranslationService : TranslationService {
    var nextResult: Result<List<String>> = Result.success(emptyList())
    var callCount: Int = 0

    override suspend fun translateBatch(
        texts: List<String>,
        targetLocale: String,
        sourceLocale: String
    ): Result<List<String>> {
        callCount++
        return nextResult
    }
}
