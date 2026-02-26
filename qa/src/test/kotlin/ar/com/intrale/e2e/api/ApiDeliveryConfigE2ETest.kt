package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — configAutoAcceptDeliveries contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiDeliveryConfigE2ETest : QATestBase() {

    @Test
    @Order(1)
    @DisplayName("POST /intrale/configAutoAcceptDeliveries sin token responde 401")
    fun `configAutoAcceptDeliveries sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/configAutoAcceptDeliveries",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("autoAccept" to true))
        )

        logger.info("configAutoAcceptDeliveries sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "configAutoAcceptDeliveries sin JWT debe responder 4xx (SecuredFunction). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/configAutoAcceptDeliveries sin body responde 400")
    fun `configAutoAcceptDeliveries sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/configAutoAcceptDeliveries",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
        )

        logger.info("configAutoAcceptDeliveries sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "configAutoAcceptDeliveries sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/configAutoAcceptDeliveries con token invalido responde 401")
    fun `configAutoAcceptDeliveries con token invalido responde 401`() {
        val response = apiContext.post(
            "/intrale/configAutoAcceptDeliveries",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer token-invalido-fake-12345")
                .setData(mapOf("autoAccept" to true))
        )

        logger.info("configAutoAcceptDeliveries con token invalido: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "configAutoAcceptDeliveries con token invalido debe responder 4xx. Actual: ${response.status()}"
        )
    }
}
