package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@DisplayName("E2E — Health y routing basico")
class ApiHealthE2ETest : QATestBase() {

    @Test
    @DisplayName("GET /intrale/health responde 200")
    fun `health endpoint responde 200`() {
        val response = apiContext.get("/intrale/health")

        logger.info("Health response: status=${response.status()}")
        assertEquals(200, response.status(), "El health endpoint debe responder 200")
    }

    @Test
    @DisplayName("GET /intrale/ruta-inexistente responde 404")
    fun `ruta inexistente responde 404`() {
        val response = apiContext.get("/intrale/ruta-que-no-existe-${System.currentTimeMillis()}")

        logger.info("404 response: status=${response.status()}")
        assertEquals(404, response.status(), "Una ruta inexistente debe responder 404")
    }

    @Test
    @DisplayName("GET / sin business responde error")
    fun `raiz sin business responde error`() {
        val response = apiContext.get("/")

        logger.info("Root response: status=${response.status()}")
        assertTrue(
            response.status() in listOf(400, 404, 405),
            "La raiz sin business debe responder con error (actual: ${response.status()})"
        )
    }
}
