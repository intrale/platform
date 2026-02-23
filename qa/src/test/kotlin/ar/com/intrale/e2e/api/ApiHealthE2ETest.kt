package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@DisplayName("E2E — Routing y conectividad basica")
class ApiHealthE2ETest : QATestBase() {

    @Test
    @DisplayName("POST /intrale/signin con body vacio responde 400 (backend vivo)")
    fun `backend responde a signin con body vacio`() {
        val response = apiContext.post(
            "/intrale/signin",
            com.microsoft.playwright.options.RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("{}")
        )

        logger.info("Connectivity check: status=${response.status()}")
        assertEquals(400, response.status(),
            "POST /intrale/signin con {} debe responder 400 (validacion). Confirma que el backend esta vivo.")
    }

    @Test
    @DisplayName("POST /intrale/funcion-inexistente responde 500 (function not found)")
    fun `funcion inexistente responde 500`() {
        val response = apiContext.post(
            "/intrale/ruta-que-no-existe-${System.currentTimeMillis()}",
            com.microsoft.playwright.options.RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("{}")
        )

        logger.info("Unknown function response: status=${response.status()}")
        assertTrue(
            response.status() in listOf(404, 500),
            "Una funcion inexistente debe responder 404 o 500 (actual: ${response.status()})"
        )
    }

    @Test
    @DisplayName("GET / sin business responde error")
    fun `raiz sin business responde error`() {
        val response = apiContext.get("/")

        logger.info("Root response: status=${response.status()}")
        assertTrue(
            response.status() in 400..599,
            "La raiz sin business debe responder con error (actual: ${response.status()})"
        )
    }
}
