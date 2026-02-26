package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — Business Management (reviewBusiness, assignProfile) contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiBusinessManagementE2ETest : QATestBase() {

    // ── reviewBusiness ──────────────────────────────────────────────────

    @Test
    @Order(1)
    @DisplayName("POST /intrale/reviewBusiness sin token responde 401")
    fun `reviewBusiness sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/reviewBusiness",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "businessName" to "qa-nonexistent",
                    "status" to "APPROVED"
                ))
        )

        logger.info("reviewBusiness sin token: status=${response.status()}")
        assertTrue(
            response.status() == 401,
            "reviewBusiness sin token debe responder 401. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/reviewBusiness sin body responde 400")
    fun `reviewBusiness sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/reviewBusiness",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("reviewBusiness sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "reviewBusiness sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/reviewBusiness con business inexistente responde error")
    fun `reviewBusiness con business inexistente responde error`() {
        val response = apiContext.post(
            "/intrale/reviewBusiness",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "businessName" to "qa-nonexistent-${System.currentTimeMillis()}",
                    "status" to "APPROVED"
                ))
        )

        logger.info("reviewBusiness business inexistente: status=${response.status()}")
        val body = response.text()
        logger.info("reviewBusiness body: $body")

        assertTrue(
            response.status() in 400..499,
            "reviewBusiness con business inexistente debe responder 4xx. Actual: ${response.status()}, body: $body"
        )
    }

    // ── assignProfile ───────────────────────────────────────────────────

    @Test
    @Order(4)
    @DisplayName("POST /intrale/assignProfile sin token responde 401")
    fun `assignProfile sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/assignProfile",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "email" to "qa-user@intrale.com",
                    "businessName" to "intrale",
                    "profile" to "ADMIN"
                ))
        )

        logger.info("assignProfile sin token: status=${response.status()}")
        assertTrue(
            response.status() == 401,
            "assignProfile sin token debe responder 401. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(5)
    @DisplayName("POST /intrale/assignProfile sin body responde 400")
    fun `assignProfile sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/assignProfile",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("assignProfile sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "assignProfile sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }
}
