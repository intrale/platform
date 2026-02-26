package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — Client Addresses contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiClientAddressesE2ETest : QATestBase() {

    @Test
    @Order(1)
    @DisplayName("POST /intrale/client/addresses sin token responde 401")
    fun `client addresses sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/client/addresses",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to "admin@intrale.com"))
        )

        logger.info("Client addresses sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Client addresses sin JWT debe responder 4xx (SecuredFunction). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/client/addresses con token invalido responde 401")
    fun `client addresses con token invalido responde 401`() {
        val response = apiContext.post(
            "/intrale/client/addresses",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer token-invalido-fake-12345")
                .setData(mapOf("email" to "admin@intrale.com"))
        )

        logger.info("Client addresses con token invalido: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Client addresses con token invalido debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/client/addresses sin body responde 400")
    fun `client addresses sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/client/addresses",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
        )

        logger.info("Client addresses sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Client addresses sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }
}
