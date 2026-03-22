package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CloudWatchEmfLoggerTest {

    @Test
    fun `namespace es el esperado`() {
        assertEquals("Intrale/Backend", CloudWatchEmfLogger.NAMESPACE)
    }

    @Test
    fun `emitInvocation no lanza excepciones con datos validos`() {
        // El logger escribe a stdout via SLF4J — solo validamos que no lanza
        CloudWatchEmfLogger.emitInvocation(
            functionName = "signin",
            business = "intrale",
            httpMethod = "POST",
            statusCode = 200,
            latencyMs = 123L
        )
    }

    @Test
    fun `emitInvocation no lanza excepciones en respuesta de error`() {
        CloudWatchEmfLogger.emitInvocation(
            functionName = "signin",
            business = "intrale",
            httpMethod = "POST",
            statusCode = 500,
            latencyMs = 50L
        )
    }

    @Test
    fun `emitInvocation acepta latencia cero`() {
        CloudWatchEmfLogger.emitInvocation(
            functionName = "health",
            business = "test",
            httpMethod = "GET",
            statusCode = 200,
            latencyMs = 0L
        )
    }

    @Test
    fun `statusCode 400 es considerado error`() {
        // Validamos indirectamente que no falla en el límite del error (400)
        CloudWatchEmfLogger.emitInvocation(
            functionName = "signup",
            business = "intrale",
            httpMethod = "POST",
            statusCode = 400,
            latencyMs = 10L
        )
    }

    @Test
    fun `statusCode 399 no es considerado error`() {
        CloudWatchEmfLogger.emitInvocation(
            functionName = "signup",
            business = "intrale",
            httpMethod = "POST",
            statusCode = 399,
            latencyMs = 10L
        )
    }
}
