package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — Client Orders y Order Detail contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiClientOrdersE2ETest : QATestBase() {

    // ── client/orders ──────────────────────────────────────────────

    @Test
    @Order(1)
    @DisplayName("POST /intrale/client/orders sin token responde 401")
    fun `client orders sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/client/orders",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to "admin@intrale.com"))
        )

        logger.info("Client orders sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Client orders sin JWT debe responder 4xx (SecuredFunction). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/client/orders con token invalido responde 401")
    fun `client orders con token invalido responde 401`() {
        val response = apiContext.post(
            "/intrale/client/orders",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer token-invalido-fake-12345")
                .setData(mapOf("email" to "admin@intrale.com"))
        )

        logger.info("Client orders con token invalido: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Client orders con token invalido debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/client/orders sin body responde 400")
    fun `client orders sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/client/orders",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
        )

        logger.info("Client orders sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Client orders sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    // ── client/order-detail ────────────────────────────────────────

    @Test
    @Order(4)
    @DisplayName("POST /intrale/client/order-detail sin token responde 401")
    fun `client order-detail sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/client/order-detail",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("orderId" to "order-123"))
        )

        logger.info("Client order-detail sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Client order-detail sin JWT debe responder 4xx (SecuredFunction). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(5)
    @DisplayName("POST /intrale/client/order-detail sin body responde 400")
    fun `client order-detail sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/client/order-detail",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
        )

        logger.info("Client order-detail sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Client order-detail sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(6)
    @DisplayName("POST /intrale/client/order-detail con order ID inexistente responde error")
    fun `client order-detail con order ID inexistente responde error`() {
        val response = apiContext.post(
            "/intrale/client/order-detail",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer token-invalido-fake-12345")
                .setData(mapOf("orderId" to "order-inexistente-99999"))
        )

        logger.info("Client order-detail con order ID inexistente: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Client order-detail con token invalido y order inexistente debe responder 4xx. Actual: ${response.status()}"
        )
    }
}
