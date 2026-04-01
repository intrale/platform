package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertNotNull
import kotlin.test.assertFalse

/**
 * Fake del generador de promos para tests.
 */
class FakePromoGeneratorService(
    private var defaultPromo: GeneratedPromo = GeneratedPromo(
        promoType = "DISCOUNT_PERCENT",
        discountPercent = 20,
        promoText = "20% OFF por tiempo limitado!",
        reason = "Producto sin ventas recientes",
        suggestedDurationDays = 7
    )
) : PromoGeneratorService {
    var lastProduct: LowRotationProduct? = null
    var callCount = 0

    override suspend fun generatePromo(
        businessName: String,
        product: LowRotationProduct
    ): GeneratedPromo {
        lastProduct = product
        callCount++
        return defaultPromo.copy(promoText = "${product.productName} con 20% OFF!")
    }
}

class BusinessAutoPromosFunctionTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("panaderia")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableBusiness = InMemoryDynamoDbTable<Business>(
        "business",
        TableSchema.fromBean(Business::class.java)
    ) { it.name ?: "" }
    private val tableProfiles = InMemoryDynamoDbTable<UserBusinessProfile>(
        "userbusinessprofile",
        TableSchema.fromBean(UserBusinessProfile::class.java)
    ) { it.compositeKey }
    private val productRepository = ProductRepository()
    private val orderRepository = ClientOrderRepository()
    private val promoRepository = PromoSuggestionRepository()
    private val analyzer = LowRotationAnalyzer(productRepository, orderRepository)
    private val fakePromoGenerator = FakePromoGeneratorService()
    private val gson = Gson()

    private val function = BusinessAutoPromosFunction(
        config, logger, cognito, tableBusiness, tableProfiles,
        analyzer, fakePromoGenerator, promoRepository, productRepository
    )

    private fun seedBusinessAdmin() {
        tableProfiles.putItem(UserBusinessProfile().apply {
            email = "admin@biz.com"
            business = "panaderia"
            profile = PROFILE_BUSINESS_ADMIN
            state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "admin@biz.com" })
        }
    }

    private val authHeaders = mapOf("Authorization" to "token", "X-Http-Method" to "GET")

    @Test
    fun `GET config retorna configuracion por defecto`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "panaderia"
            lowRotationThresholdDays = 7
            autoPromoEnabled = false
        })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos/config",
            headers = authHeaders,
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is LowRotationConfigResponse)
        val configResponse = response as LowRotationConfigResponse
        assertEquals(7, configResponse.thresholdDays)
        assertFalse(configResponse.autoPromoEnabled)
    }

    @Test
    fun `PUT config actualiza umbral de baja rotacion`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "panaderia"
            lowRotationThresholdDays = 7
            autoPromoEnabled = false
        })
        seedBusinessAdmin()

        val body = LowRotationConfigRequest(thresholdDays = 14, enabled = true)

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos/config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is LowRotationConfigResponse)
        val configResponse = response as LowRotationConfigResponse
        assertEquals(14, configResponse.thresholdDays)
        assertTrue(configResponse.autoPromoEnabled)

        // Verificar que se persistio
        val stored = tableBusiness.getItem(Business().apply { name = "panaderia" })
        assertEquals(14, stored!!.lowRotationThresholdDays)
        assertTrue(stored.autoPromoEnabled)
    }

    @Test
    fun `PUT config con umbral invalido devuelve error`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "panaderia" })
        seedBusinessAdmin()

        val body = LowRotationConfigRequest(thresholdDays = 0, enabled = true)

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos/config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT config con umbral mayor a 90 devuelve error`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "panaderia" })
        seedBusinessAdmin()

        val body = LowRotationConfigRequest(thresholdDays = 91, enabled = true)

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos/config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `GET lista sugerencias genera promos para productos con baja rotacion`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "panaderia"
            lowRotationThresholdDays = 7
        })
        seedBusinessAdmin()

        // Crear productos sin ventas
        productRepository.saveProduct("panaderia", ProductRecord(
            name = "Pan lactal",
            basePrice = 2500.0,
            unit = "unidad",
            status = "PUBLISHED",
            categoryId = "pan"
        ))
        productRepository.saveProduct("panaderia", ProductRecord(
            name = "Medialunas",
            basePrice = 800.0,
            unit = "docena",
            status = "PUBLISHED",
            categoryId = "facturas"
        ))

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos",
            headers = authHeaders,
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is PromoSuggestionsResponse)
        val suggestionsResponse = response as PromoSuggestionsResponse
        assertEquals(2, suggestionsResponse.suggestions.size)
        assertTrue(suggestionsResponse.suggestions.all { it.status == "PENDING" })
        assertEquals(2, fakePromoGenerator.callCount)
    }

    @Test
    fun `GET lista sugerencias retorna existentes sin regenerar`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "panaderia"
            lowRotationThresholdDays = 7
        })
        seedBusinessAdmin()

        // Pre-cargar sugerencia pendiente
        promoRepository.save("panaderia", PromoSuggestion(
            productId = "p1",
            productName = "Pan lactal",
            promoType = "DISCOUNT_PERCENT",
            discountPercent = 20,
            promoText = "Pan lactal 20% OFF!",
            reason = "Sin ventas",
            status = "PENDING",
            daysSinceLastSale = 10,
            createdAt = "2026-03-31T10:00:00Z"
        ))

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos",
            headers = authHeaders,
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is PromoSuggestionsResponse)
        val suggestionsResponse = response as PromoSuggestionsResponse
        assertEquals(1, suggestionsResponse.suggestions.size)
        assertEquals(0, fakePromoGenerator.callCount) // No genero nuevas
    }

    @Test
    fun `GET lista sin productos publicados retorna vacio`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "panaderia"
            lowRotationThresholdDays = 7
        })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos",
            headers = authHeaders,
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is PromoSuggestionsResponse)
        val suggestionsResponse = response as PromoSuggestionsResponse
        assertTrue(suggestionsResponse.suggestions.isEmpty())
    }

    @Test
    fun `POST review aprueba promo y aplica precio al producto`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "panaderia" })
        seedBusinessAdmin()

        // Crear producto
        val product = productRepository.saveProduct("panaderia", ProductRecord(
            name = "Pan lactal",
            basePrice = 2000.0,
            unit = "unidad",
            status = "PUBLISHED",
            categoryId = "pan"
        ))

        // Crear sugerencia pendiente
        val suggestion = promoRepository.save("panaderia", PromoSuggestion(
            productId = product.id,
            productName = "Pan lactal",
            promoType = "DISCOUNT_PERCENT",
            discountPercent = 20,
            promoText = "Pan lactal 20% OFF!",
            reason = "Sin ventas",
            status = "PENDING",
            daysSinceLastSale = 10,
            createdAt = "2026-03-31T10:00:00Z"
        ))

        val body = ReviewPromoRequest(action = "approve")

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos/${suggestion.id}/review",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ReviewPromoResponse)
        val reviewResponse = response as ReviewPromoResponse
        assertEquals("APPROVED", reviewResponse.suggestion?.status)
        assertTrue(reviewResponse.productUpdated)

        // Verificar precio promocional aplicado al producto
        val updatedProduct = productRepository.getProduct("panaderia", product.id)
        assertNotNull(updatedProduct?.promotionPrice)
        assertEquals(1600.0, updatedProduct!!.promotionPrice!!, 0.01)
    }

    @Test
    fun `POST review rechaza promo correctamente`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "panaderia" })
        seedBusinessAdmin()

        val suggestion = promoRepository.save("panaderia", PromoSuggestion(
            productId = "p1",
            productName = "Pan lactal",
            promoType = "DISCOUNT_PERCENT",
            discountPercent = 20,
            promoText = "Pan lactal 20% OFF!",
            reason = "Sin ventas",
            status = "PENDING",
            createdAt = "2026-03-31T10:00:00Z"
        ))

        val body = ReviewPromoRequest(action = "reject")

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos/${suggestion.id}/review",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ReviewPromoResponse)
        val reviewResponse = response as ReviewPromoResponse
        assertEquals("REJECTED", reviewResponse.suggestion?.status)
        assertFalse(reviewResponse.productUpdated)
    }

    @Test
    fun `POST review con accion invalida devuelve error`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "panaderia" })
        seedBusinessAdmin()

        val suggestion = promoRepository.save("panaderia", PromoSuggestion(
            productId = "p1", productName = "Pan", status = "PENDING", createdAt = "2026-03-31T10:00:00Z"
        ))

        val body = ReviewPromoRequest(action = "invalid")

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos/${suggestion.id}/review",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST review a promo ya aprobada devuelve Conflict`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "panaderia" })
        seedBusinessAdmin()

        val suggestion = promoRepository.save("panaderia", PromoSuggestion(
            productId = "p1", productName = "Pan", status = "APPROVED", createdAt = "2026-03-31T10:00:00Z"
        ))

        val body = ReviewPromoRequest(action = "approve")

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos/${suggestion.id}/review",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.Conflict, response.statusCode)
    }

    @Test
    fun `POST review a promo inexistente devuelve NotFound`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "panaderia" })
        seedBusinessAdmin()

        val body = ReviewPromoRequest(action = "approve")

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos/inexistente/review",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `POST review sin body devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "panaderia" })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos/id/review",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT config sin body devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "panaderia" })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos/config",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `usuario no autorizado recibe UnauthorizedException`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "panaderia" })
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `negocio inexistente devuelve NotFound`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos",
            headers = authHeaders,
            textBody = ""
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `POST review con texto modificado aplica el cambio`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "panaderia" })
        seedBusinessAdmin()

        val product = productRepository.saveProduct("panaderia", ProductRecord(
            name = "Medialunas",
            basePrice = 1000.0,
            unit = "docena",
            status = "PUBLISHED",
            categoryId = "facturas"
        ))

        val suggestion = promoRepository.save("panaderia", PromoSuggestion(
            productId = product.id,
            productName = "Medialunas",
            promoType = "DISCOUNT_PERCENT",
            discountPercent = 20,
            promoText = "Texto original",
            reason = "Sin ventas",
            status = "PENDING",
            createdAt = "2026-03-31T10:00:00Z"
        ))

        val body = ReviewPromoRequest(
            action = "approve",
            modifiedPromoText = "Medialunas frescas 30% OFF!",
            modifiedDiscountPercent = 30,
            startDate = "2026-04-01T00:00:00Z",
            endDate = "2026-04-07T00:00:00Z"
        )

        val response = function.securedExecute(
            business = "panaderia",
            function = "business/auto-promos/${suggestion.id}/review",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ReviewPromoResponse)
        val reviewResponse = response as ReviewPromoResponse
        assertEquals("Medialunas frescas 30% OFF!", reviewResponse.suggestion?.promoText)
        assertEquals(30, reviewResponse.suggestion?.discountPercent)
        assertNotNull(reviewResponse.suggestion?.startDate)
        assertNotNull(reviewResponse.suggestion?.endDate)

        // Verificar que el descuento modificado se aplico al producto
        val updatedProduct = productRepository.getProduct("panaderia", product.id)
        assertEquals(700.0, updatedProduct!!.promotionPrice!!, 0.01)
    }
}
