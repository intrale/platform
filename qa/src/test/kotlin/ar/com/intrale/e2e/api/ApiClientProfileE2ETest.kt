package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — Client Profile contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiClientProfileE2ETest : QATestBase() {

    @Test
    @Order(1)
    @DisplayName("POST /intrale/client/profile sin token responde 401")
    fun `client profile sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/client/profile",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to "admin@intrale.com"))
        )

        logger.info("Client profile sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Client profile sin JWT debe responder 4xx (SecuredFunction). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/client/profile con token invalido responde 401")
    fun `client profile con token invalido responde 401`() {
        val response = apiContext.post(
            "/intrale/client/profile",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer token-invalido-fake-12345")
                .setData(mapOf("email" to "admin@intrale.com"))
        )

        logger.info("Client profile con token invalido: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Client profile con token invalido debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/client/profile sin body responde 400")
    fun `client profile sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/client/profile",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
        )

        logger.info("Client profile sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Client profile sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }
}
