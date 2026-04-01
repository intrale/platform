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
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Fake del servicio de onboarding por voz para tests.
 */
class FakeVoiceOnboardingService(
    private var response: OnboardingStepResult = OnboardingStepResult(
        message = "Entendi! Tenes una pizzeria.",
        nextStep = OnboardingStep.PRODUCTS,
        accumulatedContext = AccumulatedOnboardingContext(businessName = "Mi Pizzeria"),
        confidence = 0.9
    )
) : VoiceOnboardingService {
    var lastTranscript: String? = null
    var lastStep: OnboardingStep? = null

    fun setResponse(result: OnboardingStepResult) {
        response = result
    }

    override suspend fun processStep(
        transcript: String,
        step: OnboardingStep,
        accumulatedContext: AccumulatedOnboardingContext?
    ): OnboardingStepResult {
        lastTranscript = transcript
        lastStep = step
        return response
    }
}

class VoiceOnboardingFunctionTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("test-biz")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableBusiness = InMemoryDynamoDbTable<Business>(
        "business",
        TableSchema.fromBean(Business::class.java)
    ) { it.name ?: "" }
    private val tableProfiles = InMemoryDynamoDbTable<UserBusinessProfile>(
        "profiles",
        TableSchema.fromBean(UserBusinessProfile::class.java)
    ) { it.compositeKey ?: "" }
    private val productRepository = ProductRepository()
    private val categoryRepository = CategoryRepository()
    private val fakeService = FakeVoiceOnboardingService()
    private val gson = Gson()

    private val function = VoiceOnboardingFunction(
        config, logger, cognito, tableProfiles, tableBusiness,
        productRepository, categoryRepository, fakeService
    )

    private fun seedBusinessAdmin() {
        tableProfiles.putItem(UserBusinessProfile().apply {
            email = "admin@biz.com"
            business = "test-biz"
            profile = PROFILE_BUSINESS_ADMIN
            state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "admin@biz.com" })
        }
    }

    // --- Tests de securedExecute ---

    @Test
    fun `POST con transcript valido devuelve respuesta del asistente`() = runBlocking {
        seedBusinessAdmin()

        val body = VoiceOnboardingRequest(
            transcript = "Tengo una pizzeria en Palermo",
            step = OnboardingStep.BUSINESS_TYPE
        )

        val response = function.securedExecute(
            business = "test-biz",
            function = "business/voice-onboarding",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is VoiceOnboardingResponse)
        val voiceResponse = response as VoiceOnboardingResponse
        assertEquals("Entendi! Tenes una pizzeria.", voiceResponse.message)
        assertEquals("PRODUCTS", voiceResponse.nextStep)
        assertEquals(0.9, voiceResponse.confidence)
        assertEquals("Tengo una pizzeria en Palermo", fakeService.lastTranscript)
        assertEquals(OnboardingStep.BUSINESS_TYPE, fakeService.lastStep)
    }

    @Test
    fun `POST con transcript vacio devuelve error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val body = VoiceOnboardingRequest(transcript = "", step = OnboardingStep.BUSINESS_TYPE)

        val response = function.securedExecute(
            business = "test-biz",
            function = "business/voice-onboarding",
            headers = mapOf("Authorization" to "token"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con transcript muy largo devuelve error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val body = VoiceOnboardingRequest(
            transcript = "a".repeat(2001),
            step = OnboardingStep.BUSINESS_TYPE
        )

        val response = function.securedExecute(
            business = "test-biz",
            function = "business/voice-onboarding",
            headers = mapOf("Authorization" to "token"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST sin body devuelve error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "test-biz",
            function = "business/voice-onboarding",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `usuario no autorizado recibe UnauthorizedException`() = runBlocking {
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val body = VoiceOnboardingRequest(
            transcript = "Mi negocio se llama La Pizzeria",
            step = OnboardingStep.BUSINESS_TYPE
        )

        val response = function.securedExecute(
            business = "test-biz",
            function = "business/voice-onboarding",
            headers = mapOf("Authorization" to "token"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is UnauthorizedException)
    }

    // --- Tests de isConfirmation ---

    @Test
    fun `isConfirmation detecta textos afirmativos en espanol`() {
        assertTrue(function.isConfirmation("Si, confirmo"))
        assertTrue(function.isConfirmation("dale"))
        assertTrue(function.isConfirmation("OK"))
        assertTrue(function.isConfirmation("perfecto, todo bien"))
        assertTrue(function.isConfirmation("esta bien"))
        assertTrue(function.isConfirmation("De acuerdo"))
        assertTrue(function.isConfirmation("Listo"))
        assertTrue(function.isConfirmation("Adelante"))
    }

    @Test
    fun `isConfirmation rechaza textos no afirmativos`() {
        assertFalse(function.isConfirmation("no"))
        assertFalse(function.isConfirmation("cambiar el nombre"))
        assertFalse(function.isConfirmation("quiero modificar los horarios"))
        assertFalse(function.isConfirmation("agregame mas productos"))
    }

    // --- Tests de handleConfirmation ---

    @Test
    fun `handleConfirmation sin contexto retorna error de validacion`() {
        val result = function.handleConfirmation("test-biz", null)
        assertTrue(result is RequestValidationException)
    }

    @Test
    fun `handleConfirmation crea categorias y productos correctamente`() {
        tableBusiness.putItem(Business().apply { name = "test-biz" })

        val context = AccumulatedOnboardingContext(
            businessDescription = "Pizzeria artesanal",
            address = "Av. Corrientes 1234",
            phone = "11-5555-1234",
            categories = listOf(
                ExtractedCategory(name = "Pizzas", description = "Pizzas artesanales"),
                ExtractedCategory(name = "Bebidas", description = "Gaseosas y cervezas")
            ),
            products = listOf(
                ExtractedProduct(
                    name = "Pizza Muzzarella",
                    shortDescription = "Clasica",
                    basePrice = 5000.0,
                    unit = "unidad",
                    category = "Pizzas"
                ),
                ExtractedProduct(
                    name = "Coca Cola",
                    shortDescription = "500ml",
                    basePrice = 1500.0,
                    unit = "unidad",
                    category = "Bebidas"
                )
            ),
            schedules = listOf(
                ExtractedSchedule(day = "Lunes", isOpen = true, openTime = "18:00", closeTime = "23:00"),
                ExtractedSchedule(day = "Martes", isOpen = true, openTime = "18:00", closeTime = "23:00")
            )
        )

        val result = function.handleConfirmation("test-biz", context)
        assertTrue(result is VoiceOnboardingConfirmResponse)
        val response = result as VoiceOnboardingConfirmResponse
        assertEquals(2, response.categoriesCreated)
        assertEquals(2, response.productsCreated)
        assertTrue(response.schedulesSaved)
        assertTrue(response.businessUpdated)

        // Verificar persistencia en repos
        val categories = categoryRepository.listCategories("test-biz")
        assertEquals(2, categories.size)
        assertTrue(categories.any { it.name == "Pizzas" })
        assertTrue(categories.any { it.name == "Bebidas" })

        val products = productRepository.listProducts("test-biz")
        assertEquals(2, products.size)
        assertTrue(products.any { it.name == "Pizza Muzzarella" })
        assertTrue(products.any { it.name == "Coca Cola" })

        // Verificar negocio actualizado
        val updatedBiz = tableBusiness.getItem(Business().apply { name = "test-biz" })
        assertEquals("Pizzeria artesanal", updatedBiz?.description)
        assertEquals("Av. Corrientes 1234", updatedBiz?.address)
        assertEquals("11-5555-1234", updatedBiz?.phone)
    }

    @Test
    fun `handleConfirmation ignora entidades con nombre vacio`() {
        val context = AccumulatedOnboardingContext(
            categories = listOf(
                ExtractedCategory(name = "Valida"),
                ExtractedCategory(name = "")
            ),
            products = listOf(
                ExtractedProduct(name = "Producto real", basePrice = 100.0),
                ExtractedProduct(name = "")
            )
        )

        val result = function.handleConfirmation("empty-cats", context)
        assertTrue(result is VoiceOnboardingConfirmResponse)
        val response = result as VoiceOnboardingConfirmResponse
        assertEquals(1, response.categoriesCreated)
        assertEquals(1, response.productsCreated)
    }

    @Test
    fun `handleConfirmation con contexto vacio no crea nada pero no falla`() {
        val result = function.handleConfirmation("no-data", AccumulatedOnboardingContext())
        assertTrue(result is VoiceOnboardingConfirmResponse)
        val response = result as VoiceOnboardingConfirmResponse
        assertEquals(0, response.categoriesCreated)
        assertEquals(0, response.productsCreated)
        assertFalse(response.schedulesSaved)
        assertFalse(response.businessUpdated)
    }

    @Test
    fun `CONFIRM con texto afirmativo persiste entidades`() = runBlocking {
        seedBusinessAdmin()
        tableBusiness.putItem(Business().apply { name = "test-biz" })

        val body = VoiceOnboardingRequest(
            transcript = "Si, confirmo todo",
            step = OnboardingStep.CONFIRM,
            accumulatedContext = AccumulatedOnboardingContext(
                categories = listOf(ExtractedCategory(name = "General")),
                products = listOf(
                    ExtractedProduct(name = "Producto 1", basePrice = 100.0)
                )
            )
        )

        val response = function.securedExecute(
            business = "test-biz",
            function = "business/voice-onboarding",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is VoiceOnboardingConfirmResponse)
        val confirmResponse = response as VoiceOnboardingConfirmResponse
        assertEquals(1, confirmResponse.categoriesCreated)
        assertEquals(1, confirmResponse.productsCreated)
    }
}
