package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ChatFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val validator = LocalJwtValidator()
    private val repository = ChatMessageRepository()

    private fun createFunction(
        translationService: TranslationService = FakeTranslationService()
    ) = ChatFunction(config, logger, repository, translationService, validator)

    private fun authHeaders(
        email: String,
        method: String = "GET",
        role: String = "business",
        extras: Map<String, String> = emptyMap()
    ): Map<String, String> = mapOf(
        "Authorization" to validator.generateToken(email),
        "X-Http-Method" to method,
        "X-Chat-Role" to role
    ) + extras

    @Test
    fun `GET messages retorna lista vacia cuando no hay mensajes`() = runBlocking {
        val fn = createFunction()
        val email = "biz@test.com"

        val response = fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders(email, extras = mapOf("X-Query-orderId" to "order-1")),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ChatMessagesListResponse)
        val list = response as ChatMessagesListResponse
        assertEquals("order-1", list.orderId)
        assertTrue(list.messages.isEmpty())
    }

    @Test
    fun `GET messages sin orderId retorna error de validacion`() = runBlocking {
        val fn = createFunction()
        val email = "biz@test.com"

        val response = fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders(email),
            textBody = ""
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `POST envia un mensaje sin traduccion cuando el idioma es igual`() = runBlocking {
        val fakeTranslation = FakeTranslationService(detectedLanguage = "es")
        val fn = createFunction(fakeTranslation)
        val email = "biz@test.com"

        val response = fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders(email, method = "POST", role = "business"),
            textBody = """{"orderId":"order-1","text":"Tu pedido esta listo"}"""
        )

        assertEquals(HttpStatusCode.Created, response.statusCode)
        assertTrue(response is ChatSendMessageResponse)
        val sendResponse = response as ChatSendMessageResponse
        assertEquals("Tu pedido esta listo", sendResponse.message.originalText)
        assertEquals("es", sendResponse.message.originalLanguage)
        assertNull(sendResponse.message.translatedText)
        assertFalse(sendResponse.wasTranslated)
        assertEquals(1, fakeTranslation.callCount)
    }

    @Test
    fun `POST envia un mensaje con traduccion cuando el idioma difiere`() = runBlocking {
        val fakeTranslation = FakeTranslationService(
            detectedLanguage = "en",
            translatedText = "Tu pedido esta listo",
            targetLanguage = "es"
        )
        val fn = createFunction(fakeTranslation)
        val email = "driver@test.com"

        val response = fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders(email, method = "POST", role = "delivery"),
            textBody = """{"orderId":"order-1","text":"Your order is ready"}"""
        )

        assertEquals(HttpStatusCode.Created, response.statusCode)
        val sendResponse = response as ChatSendMessageResponse
        assertEquals("Your order is ready", sendResponse.message.originalText)
        assertEquals("en", sendResponse.message.originalLanguage)
        assertEquals("Tu pedido esta listo", sendResponse.message.translatedText)
        assertTrue(sendResponse.wasTranslated)
    }

    @Test
    fun `POST sin body retorna error de validacion`() = runBlocking {
        val fn = createFunction()
        val email = "biz@test.com"

        val response = fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders(email, method = "POST"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `POST sin orderId retorna error de validacion`() = runBlocking {
        val fn = createFunction()
        val email = "biz@test.com"

        val response = fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders(email, method = "POST"),
            textBody = """{"orderId":"","text":"Hola"}"""
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `POST sin texto retorna error de validacion`() = runBlocking {
        val fn = createFunction()
        val email = "biz@test.com"

        val response = fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders(email, method = "POST"),
            textBody = """{"orderId":"order-1","text":""}"""
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `POST y luego GET retorna el mensaje enviado`() = runBlocking {
        val fakeTranslation = FakeTranslationService(detectedLanguage = "es")
        val fn = createFunction(fakeTranslation)
        val email = "biz@test.com"

        // Enviar mensaje
        fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders(email, method = "POST", role = "business"),
            textBody = """{"orderId":"order-1","text":"Tu pedido esta listo"}"""
        )

        // Consultar mensajes
        val response = fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders(email, extras = mapOf("X-Query-orderId" to "order-1")),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val list = response as ChatMessagesListResponse
        assertEquals(1, list.messages.size)
        assertEquals("Tu pedido esta listo", list.messages[0].originalText)
        assertEquals("business", list.messages[0].senderRole)
    }

    @Test
    fun `conversacion bidireccional guarda mensajes de ambos roles`() = runBlocking {
        val fakeTranslation = FakeTranslationService(detectedLanguage = "es")
        val fn = createFunction(fakeTranslation)

        // Negocio envia mensaje
        fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders("biz@test.com", method = "POST", role = "business"),
            textBody = """{"orderId":"order-1","text":"Tu pedido esta listo"}"""
        )

        // Repartidor envia mensaje
        fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders("driver@test.com", method = "POST", role = "delivery"),
            textBody = """{"orderId":"order-1","text":"Voy en camino"}"""
        )

        // Consultar todos los mensajes
        val response = fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders("biz@test.com", extras = mapOf("X-Query-orderId" to "order-1")),
            textBody = ""
        )

        val list = response as ChatMessagesListResponse
        assertEquals(2, list.messages.size)
        assertEquals("business", list.messages[0].senderRole)
        assertEquals("delivery", list.messages[1].senderRole)
    }

    @Test
    fun `rol invalido retorna error de validacion`() = runBlocking {
        val fn = createFunction()
        val email = "biz@test.com"

        val response = fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "POST",
                "X-Chat-Role" to "admin"
            ),
            textBody = """{"orderId":"order-1","text":"Hola"}"""
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `metodo no soportado retorna error de validacion`() = runBlocking {
        val fn = createFunction()
        val email = "biz@test.com"

        val response = fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders(email, method = "DELETE"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `sin token retorna no autorizado`() = runBlocking {
        val fn = createFunction()

        val response = fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = mapOf("X-Http-Method" to "GET", "X-Chat-Role" to "business"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
    }

    @Test
    fun `determina idioma objetivo basado en mensajes previos del otro rol`() = runBlocking {
        // Simular que el negocio habla español y el repartidor habla inglés
        val fakeTranslationEs = FakeTranslationService(detectedLanguage = "es")
        val fn = createFunction(fakeTranslationEs)

        // Negocio envia mensaje en español
        fn.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders("biz@test.com", method = "POST", role = "business"),
            textBody = """{"orderId":"order-1","text":"Tu pedido esta listo"}"""
        )

        // Ahora simular repartidor que habla inglés
        val fakeTranslationEn = FakeTranslationService(
            detectedLanguage = "en",
            translatedText = "Tu pedido esta listo",
            targetLanguage = "es"
        )
        val fn2 = ChatFunction(config, logger, repository, fakeTranslationEn, validator)

        fn2.securedExecute(
            business = "biz",
            function = "chat/messages",
            headers = authHeaders("driver@test.com", method = "POST", role = "delivery"),
            textBody = """{"orderId":"order-1","text":"I'm on my way"}"""
        )

        // El target language para el repartidor debe ser "es" (idioma del negocio)
        assertEquals("es", fakeTranslationEn.lastTargetLanguage)
    }
}
