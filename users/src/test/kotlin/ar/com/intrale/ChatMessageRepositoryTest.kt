package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ChatMessageRepositoryTest {

    private val repository = ChatMessageRepository()

    @Test
    fun `saveMessage guarda un mensaje y lo retorna con id generado`() {
        val message = repository.saveMessage(
            business = "biz",
            orderId = "order-1",
            senderEmail = "driver@test.com",
            senderRole = "delivery",
            originalText = "Estoy llegando",
            originalLanguage = "es",
            translatedText = null,
            translatedLanguage = null
        )

        assertTrue(message.id.isNotBlank())
        assertEquals("order-1", message.orderId)
        assertEquals("driver@test.com", message.senderEmail)
        assertEquals("delivery", message.senderRole)
        assertEquals("Estoy llegando", message.originalText)
        assertEquals("es", message.originalLanguage)
        assertNull(message.translatedText)
        assertNotNull(message.createdAt)
    }

    @Test
    fun `saveMessage guarda un mensaje con traduccion`() {
        val message = repository.saveMessage(
            business = "biz",
            orderId = "order-1",
            senderEmail = "driver@test.com",
            senderRole = "delivery",
            originalText = "I am arriving",
            originalLanguage = "en",
            translatedText = "Estoy llegando",
            translatedLanguage = "es"
        )

        assertEquals("I am arriving", message.originalText)
        assertEquals("en", message.originalLanguage)
        assertEquals("Estoy llegando", message.translatedText)
        assertEquals("es", message.translatedLanguage)
    }

    @Test
    fun `getMessages retorna mensajes ordenados cronologicamente`() {
        repository.saveMessage("biz", "order-1", "biz@test.com", "business",
            "Hola", "es", null, null)
        repository.saveMessage("biz", "order-1", "driver@test.com", "delivery",
            "Hello", "en", "Hola", "es")
        repository.saveMessage("biz", "order-1", "biz@test.com", "business",
            "Tu pedido esta listo", "es", null, null)

        val messages = repository.getMessages("biz", "order-1")
        assertEquals(3, messages.size)
        assertEquals("Hola", messages[0].originalText)
        assertEquals("Hello", messages[1].originalText)
        assertEquals("Tu pedido esta listo", messages[2].originalText)
    }

    @Test
    fun `getMessages retorna lista vacia cuando no hay mensajes`() {
        val messages = repository.getMessages("biz", "order-nonexistent")
        assertTrue(messages.isEmpty())
    }

    @Test
    fun `mensajes de un pedido no se mezclan con otro`() {
        repository.saveMessage("biz", "order-1", "biz@test.com", "business",
            "Mensaje 1", "es", null, null)
        repository.saveMessage("biz", "order-2", "biz@test.com", "business",
            "Mensaje 2", "es", null, null)

        val messagesOrder1 = repository.getMessages("biz", "order-1")
        val messagesOrder2 = repository.getMessages("biz", "order-2")

        assertEquals(1, messagesOrder1.size)
        assertEquals("Mensaje 1", messagesOrder1[0].originalText)
        assertEquals(1, messagesOrder2.size)
        assertEquals("Mensaje 2", messagesOrder2[0].originalText)
    }

    @Test
    fun `mensajes de un negocio no se mezclan con otro`() {
        repository.saveMessage("biz-a", "order-1", "biz@test.com", "business",
            "Mensaje A", "es", null, null)
        repository.saveMessage("biz-b", "order-1", "biz@test.com", "business",
            "Mensaje B", "es", null, null)

        val messagesA = repository.getMessages("biz-a", "order-1")
        val messagesB = repository.getMessages("biz-b", "order-1")

        assertEquals(1, messagesA.size)
        assertEquals("Mensaje A", messagesA[0].originalText)
        assertEquals(1, messagesB.size)
        assertEquals("Mensaje B", messagesB[0].originalText)
    }

    @Test
    fun `getUserLanguagePreference retorna el idioma del ultimo mensaje del usuario`() {
        repository.saveMessage("biz", "order-1", "driver@test.com", "delivery",
            "Hello", "en", null, null)

        val pref = repository.getUserLanguagePreference("driver@test.com")
        assertEquals("en", pref)
    }

    @Test
    fun `getUserLanguagePreference retorna español por defecto`() {
        val pref = repository.getUserLanguagePreference("unknown@test.com")
        assertEquals("es", pref)
    }

    @Test
    fun `messageCount retorna la cantidad correcta`() {
        assertEquals(0, repository.messageCount("biz", "order-1"))

        repository.saveMessage("biz", "order-1", "biz@test.com", "business",
            "Hola", "es", null, null)
        repository.saveMessage("biz", "order-1", "driver@test.com", "delivery",
            "Hola", "es", null, null)

        assertEquals(2, repository.messageCount("biz", "order-1"))
    }
}
