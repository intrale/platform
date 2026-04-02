package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Fake del servicio de IA para tests.
 */
class FakeAiResponseService(
    private var response: AiResponseResult = AiResponseResult(
        answer = "Estamos abiertos de 9 a 18hs",
        confidence = 0.95,
        escalated = false
    )
) : AiResponseService {
    var lastQuestion: String? = null
    var lastContext: BusinessContext? = null

    fun setResponse(result: AiResponseResult) {
        response = result
    }

    override suspend fun generateResponse(
        context: BusinessContext,
        customerQuestion: String
    ): AiResponseResult {
        lastQuestion = customerQuestion
        lastContext = context
        return response
    }
}

class AutoResponseFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val tableBusiness = InMemoryDynamoDbTable<Business>(
        "business",
        TableSchema.fromBean(Business::class.java)
    ) { it.name ?: "" }
    private val productRepository = ProductRepository()
    private val fakeAiService = FakeAiResponseService()
    private val gson = Gson()

    private val function = AutoResponseFunction(
        logger, tableBusiness, productRepository, fakeAiService
    )

    @Test
    fun `POST con pregunta valida devuelve respuesta automatica`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "pizzeria"
            autoResponseEnabled = true
            description = "Pizzeria de barrio"
        })

        val body = AutoResponseRequest(question = "Que horarios tienen?")

        val response = function.execute(
            business = "pizzeria",
            function = "auto-response",
            headers = mapOf("X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is AutoResponseResponse)
        val autoResponse = response as AutoResponseResponse
        assertEquals("Estamos abiertos de 9 a 18hs", autoResponse.answer)
        assertTrue(autoResponse.isAutomatic)
        assertEquals(false, autoResponse.escalated)
        assertEquals("Que horarios tienen?", fakeAiService.lastQuestion)
    }

    @Test
    fun `POST escala al humano cuando IA no puede responder`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "pizzeria"
            autoResponseEnabled = true
        })
        fakeAiService.setResponse(AiResponseResult(answer = "", confidence = 0.3, escalated = true))

        val body = AutoResponseRequest(question = "Puedo pagar con criptomonedas?")

        val response = function.execute(
            business = "pizzeria",
            function = "auto-response",
            headers = mapOf("X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is EscalatedResponse)
        val escalated = response as EscalatedResponse
        assertTrue(escalated.escalated)
    }

    @Test
    fun `POST con respuestas automaticas desactivadas devuelve Forbidden`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "pizzeria"
            autoResponseEnabled = false
        })

        val body = AutoResponseRequest(question = "Que horarios tienen?")

        val response = function.execute(
            business = "pizzeria",
            function = "auto-response",
            headers = emptyMap(),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.Forbidden, response.statusCode)
    }

    @Test
    fun `POST a negocio inexistente devuelve NotFound`() = runBlocking {
        val body = AutoResponseRequest(question = "Hola")

        val response = function.execute(
            business = "no-existe",
            function = "auto-response",
            headers = emptyMap(),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `POST con pregunta vacia devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "pizzeria"
            autoResponseEnabled = true
        })

        val body = AutoResponseRequest(question = "")

        val response = function.execute(
            business = "pizzeria",
            function = "auto-response",
            headers = emptyMap(),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con pregunta muy larga devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "pizzeria"
            autoResponseEnabled = true
        })

        val body = AutoResponseRequest(question = "a".repeat(1001))

        val response = function.execute(
            business = "pizzeria",
            function = "auto-response",
            headers = emptyMap(),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST sin body devuelve error de validacion`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "pizzeria"
            autoResponseEnabled = true
        })

        val response = function.execute(
            business = "pizzeria",
            function = "auto-response",
            headers = emptyMap(),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `buildBusinessContext incluye productos publicados`() = runBlocking {
        val biz = Business().apply {
            name = "pizzeria"
            autoResponseEnabled = true
            description = "La mejor pizza"
            address = "Av. Corrientes 1234"
            phone = "1155554444"
            schedulesJson = """[{"day":"Lunes","isOpen":true,"openTime":"09:00","closeTime":"18:00"}]"""
            paymentMethodsJson = """[{"id":"cash","name":"Efectivo","type":"CASH","enabled":true}]"""
        }
        tableBusiness.putItem(biz)

        productRepository.saveProduct("pizzeria", ProductRecord(
            name = "Pizza Muzzarella",
            shortDescription = "Clasica",
            basePrice = 5000.0,
            unit = "unidad",
            status = "PUBLISHED",
            isAvailable = true
        ))

        val context = function.buildBusinessContext(biz, "pizzeria")

        assertEquals("pizzeria", context.businessName)
        assertEquals("La mejor pizza", context.description)
        assertEquals("Av. Corrientes 1234", context.address)
        assertEquals(1, context.schedules.size)
        assertEquals(1, context.paymentMethods.size)
        assertEquals(1, context.products.size)
        assertEquals("Pizza Muzzarella", context.products.first().name)
    }
}
