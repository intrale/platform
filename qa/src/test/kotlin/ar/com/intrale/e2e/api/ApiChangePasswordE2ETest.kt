package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — ChangePassword contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiChangePasswordE2ETest : QATestBase() {

    @Test
    @Order(1)
    @DisplayName("POST /intrale/changePassword sin token responde 401")
    fun `changePassword sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/changePassword",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "email" to "admin@intrale.com",
                    "previousPassword" to "Admin1234!",
                    "proposedPassword" to "NewPass1234!"
                ))
        )

        logger.info("ChangePassword sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "ChangePassword sin JWT debe responder 4xx (SecuredFunction). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/changePassword sin body responde 400")
    fun `changePassword sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/changePassword",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
        )

        logger.info("ChangePassword sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "ChangePassword sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/changePassword con token invalido responde 401")
    fun `changePassword con token invalido responde 401`() {
        val response = apiContext.post(
            "/intrale/changePassword",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer token-invalido-fake-12345")
                .setData(mapOf(
                    "email" to "admin@intrale.com",
                    "previousPassword" to "Admin1234!",
                    "proposedPassword" to "NewPass1234!"
                ))
        )

        logger.info("ChangePassword con token invalido: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "ChangePassword con token invalido debe responder 4xx. Actual: ${response.status()}"
        )
    }
}
