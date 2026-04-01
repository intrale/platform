package ar.com.intrale

import com.auth0.jwt.interfaces.DecodedJWT
import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Fake del servicio de vision para tests.
 */
class FakeVisionStockCountService(
    private var result: StockCountResult = StockCountResult(
        products = listOf(
            IdentifiedProduct(name = "Coca-Cola 500ml", quantity = 12, confidence = 0.95, matchedProductId = "0"),
            IdentifiedProduct(name = "Sprite 500ml", quantity = 8, confidence = 0.85)
        ),
        unrecognizedCount = 2,
        processingTimeMs = 3500,
        notes = "Foto con buena iluminacion"
    )
) : VisionStockCountService {
    var lastImageBase64: String? = null
    var lastMediaType: String? = null
    var lastKnownProducts: List<ProductSummary>? = null

    fun setResult(newResult: StockCountResult) {
        result = newResult
    }

    override suspend fun countStock(
        imageBase64: String,
        mediaType: String,
        knownProducts: List<ProductSummary>
    ): StockCountResult {
        lastImageBase64 = imageBase64
        lastMediaType = mediaType
        lastKnownProducts = knownProducts
        return result
    }
}

class StockCountFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val tableBusiness = InMemoryDynamoDbTable<Business>(
        "business",
        TableSchema.fromBean(Business::class.java)
    ) { it.name ?: "" }
    private val productRepository = ProductRepository()
    private val fakeVisionService = FakeVisionStockCountService()
    private val gson = Gson()

    // Config y JwtValidator fake para tests
    private val fakeConfig = UsersConfig(
        region = "us-east-1",
        accessKeyId = "test",
        secretAccessKey = "test",
        awsCognitoUserPoolId = "pool-id",
        awsCognitoClientId = "client-id",
        tableBusiness = tableBusiness
    )

    private val fakeJwtValidator = object : JwtValidator {
        override fun validate(token: String): DecodedJWT {
            return mockk(relaxed = true)
        }
    }

    private val function = StockCountFunction(
        config = fakeConfig,
        logger = logger,
        tableBusiness = tableBusiness,
        productRepository = productRepository,
        visionService = fakeVisionService,
        jwtValidator = fakeJwtValidator
    )

    private val validHeaders = mapOf(
        "Authorization" to "Bearer test-token",
        "X-Http-Method" to "POST"
    )

    // Imagen base64 minima valida (1x1 pixel JPEG)
    private val sampleImageBase64 = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//"

    @Test
    fun `POST con imagen valida devuelve productos identificados`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "kiosco" })

        productRepository.saveProduct("kiosco", ProductRecord(
            name = "Coca-Cola 500ml",
            basePrice = 1500.0,
            unit = "unidad",
            status = "PUBLISHED",
            isAvailable = true
        ))

        val body = StockCountRequest(
            imageBase64 = sampleImageBase64,
            mediaType = "image/jpeg"
        )

        val response = function.execute(
            business = "kiosco",
            function = "business/stock-count",
            headers = validHeaders,
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is StockCountResponse)
        val stockResponse = response as StockCountResponse
        assertEquals(2, stockResponse.products.size)
        assertEquals(12, stockResponse.products[0].quantity)
        assertEquals("Coca-Cola 500ml", stockResponse.products[0].name)
        assertEquals(2, stockResponse.unrecognizedCount)
        assertEquals("Foto con buena iluminacion", stockResponse.notes)
    }

    @Test
    fun `POST sin token devuelve Unauthorized`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "kiosco" })

        val rejectingValidator = object : JwtValidator {
            override fun validate(token: String): DecodedJWT {
                throw IllegalArgumentException("Token invalido")
            }
        }

        val securedFunction = StockCountFunction(
            config = fakeConfig,
            logger = logger,
            tableBusiness = tableBusiness,
            productRepository = productRepository,
            visionService = fakeVisionService,
            jwtValidator = rejectingValidator
        )

        val body = StockCountRequest(imageBase64 = sampleImageBase64)

        val response = securedFunction.execute(
            business = "kiosco",
            function = "business/stock-count",
            headers = mapOf("Authorization" to "Bearer bad-token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `POST a negocio inexistente devuelve NotFound`() = runBlocking {
        val body = StockCountRequest(imageBase64 = sampleImageBase64)

        val response = function.execute(
            business = "no-existe",
            function = "business/stock-count",
            headers = validHeaders,
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `POST con imagen vacia devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "kiosco" })

        val body = StockCountRequest(imageBase64 = "")

        val response = function.execute(
            business = "kiosco",
            function = "business/stock-count",
            headers = validHeaders,
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con tipo de imagen no soportado devuelve error`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "kiosco" })

        val body = StockCountRequest(
            imageBase64 = sampleImageBase64,
            mediaType = "image/bmp"
        )

        val response = function.execute(
            business = "kiosco",
            function = "business/stock-count",
            headers = validHeaders,
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST sin body devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "kiosco" })

        val response = function.execute(
            business = "kiosco",
            function = "business/stock-count",
            headers = validHeaders,
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con metodo GET devuelve MethodNotAllowed`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "kiosco" })

        val body = StockCountRequest(imageBase64 = sampleImageBase64)

        val response = function.execute(
            business = "kiosco",
            function = "business/stock-count",
            headers = mapOf("Authorization" to "Bearer test-token", "X-Http-Method" to "GET"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.MethodNotAllowed, response.statusCode)
    }

    @Test
    fun `POST con autoUpdate actualiza stock de productos matcheados`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "kiosco" })

        val saved = productRepository.saveProduct("kiosco", ProductRecord(
            name = "Coca-Cola 500ml",
            basePrice = 1500.0,
            unit = "unidad",
            status = "PUBLISHED",
            isAvailable = true,
            stockQuantity = 5
        ))

        // El fake retorna matchedProductId="0" para Coca-Cola
        val body = StockCountRequest(
            imageBase64 = sampleImageBase64,
            mediaType = "image/jpeg",
            autoUpdate = true
        )

        val response = function.execute(
            business = "kiosco",
            function = "business/stock-count",
            headers = validHeaders,
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is StockCountResponse)
        val stockResponse = response as StockCountResponse
        // El primer producto deberia estar marcado como updated
        assertTrue(stockResponse.products[0].updated)
    }

    @Test
    fun `POST envia productos conocidos al servicio de vision`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "kiosco" })

        productRepository.saveProduct("kiosco", ProductRecord(
            name = "Fanta 500ml",
            basePrice = 1200.0,
            unit = "unidad",
            status = "PUBLISHED",
            isAvailable = true
        ))
        productRepository.saveProduct("kiosco", ProductRecord(
            name = "Agua Mineral",
            basePrice = 800.0,
            unit = "unidad",
            status = "DRAFT",
            isAvailable = true
        ))

        val body = StockCountRequest(
            imageBase64 = sampleImageBase64,
            mediaType = "image/jpeg"
        )

        function.execute(
            business = "kiosco",
            function = "business/stock-count",
            headers = validHeaders,
            textBody = gson.toJson(body)
        )

        // Solo productos PUBLISHED deben enviarse al servicio de vision
        assertEquals(1, fakeVisionService.lastKnownProducts?.size)
        assertEquals("Fanta 500ml", fakeVisionService.lastKnownProducts?.first()?.name)
    }

    @Test
    fun `POST cuando vision falla devuelve InternalServerError`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "kiosco" })

        val failingService = object : VisionStockCountService {
            override suspend fun countStock(
                imageBase64: String,
                mediaType: String,
                knownProducts: List<ProductSummary>
            ): StockCountResult {
                throw RuntimeException("Vision service unavailable")
            }
        }

        val failFunction = StockCountFunction(
            config = fakeConfig,
            logger = logger,
            tableBusiness = tableBusiness,
            productRepository = productRepository,
            visionService = failingService,
            jwtValidator = fakeJwtValidator
        )

        val body = StockCountRequest(
            imageBase64 = sampleImageBase64,
            mediaType = "image/jpeg"
        )

        val response = failFunction.execute(
            business = "kiosco",
            function = "business/stock-count",
            headers = validHeaders,
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.InternalServerError, response.statusCode)
    }
}
