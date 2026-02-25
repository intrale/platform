package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — Profiles contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiProfilesE2ETest : QATestBase() {

    @Test
    @Order(1)
    @DisplayName("POST /intrale/profiles sin token responde 401")
    fun `profiles sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/profiles",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to "admin@intrale.com"))
        )

        logger.info("Profiles sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Profiles sin JWT debe responder 4xx (SecuredFunction). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/profiles con token invalido responde 401")
    fun `profiles con token invalido responde 401`() {
        val response = apiContext.post(
            "/intrale/profiles",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer token-invalido-fake-12345")
                .setData(mapOf("email" to "admin@intrale.com"))
        )

        logger.info("Profiles con token invalido: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Profiles con token invalido debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /business-inexistente/profiles responde error")
    fun `profiles con business inexistente responde error`() {
        val response = apiContext.post(
            "/business-no-existe-${System.currentTimeMillis()}/profiles",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to "admin@intrale.com"))
        )

        logger.info("Profiles business inexistente: status=${response.status()}")
        assertTrue(
            response.status() in 400..599,
            "Profiles con business inexistente debe responder error. Actual: ${response.status()}"
        )
    }
}
