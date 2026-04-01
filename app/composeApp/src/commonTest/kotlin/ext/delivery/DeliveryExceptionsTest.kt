package ext.delivery

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DeliveryExceptionsTest {

    @Test
    fun `Throwable toDeliveryException con DeliveryExceptionResponse devuelve el mismo`() {
        val original = DeliveryExceptionResponse(message = "Error original")
        val result = original.toDeliveryException()
        assertTrue(result === original)
    }

    @Test
    fun `Throwable toDeliveryException con RuntimeException envuelve el mensaje`() {
        val exception = RuntimeException("Error de red")
        val result = exception.toDeliveryException()
        assertEquals("Error de red", result.message)
    }

    @Test
    fun `Throwable toDeliveryException con excepcion sin mensaje usa fallback`() {
        val exception = RuntimeException()
        val result = exception.toDeliveryException()
        assertEquals("Error inesperado", result.message)
    }

    @Test
    fun `String toDeliveryException con JSON valido lo parsea`() {
        val json = """{"statusCode":{"value":404,"description":"Not Found"},"message":"Pedido no encontrado"}"""
        val result = json.toDeliveryException()
        assertEquals("Pedido no encontrado", result.message)
        assertEquals(404, result.statusCode.value)
    }

    @Test
    fun `String toDeliveryException con string plano lo usa como mensaje`() {
        val plainText = "Error inesperado del servidor"
        val result = plainText.toDeliveryException()
        assertEquals("Error inesperado del servidor", result.message)
    }
}
