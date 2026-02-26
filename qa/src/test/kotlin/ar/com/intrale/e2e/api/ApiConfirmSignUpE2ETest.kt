package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — ConfirmSignUp contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiConfirmSignUpE2ETest : QATestBase() {

    @Test
    @Order(1)
    @DisplayName("POST /intrale/confirmSignUp sin body responde 400")
    fun `confirmSignUp sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/confirmSignUp",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("ConfirmSignUp sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "ConfirmSignUp sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/confirmSignUp con código inválido responde error")
    fun `confirmSignUp con codigo invalido responde error`() {
        val response = apiContext.post(
            "/intrale/confirmSignUp",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "email" to "admin@intrale.com",
                    "code" to "000000"
                ))
        )

        val body = response.text()
        logger.info("ConfirmSignUp código inválido: status=${response.status()}, body=$body")
        assertTrue(
            response.status() in 400..599,
            "ConfirmSignUp con código inválido debe responder error (4xx/5xx). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/confirmSignUp con email inexistente responde error")
    fun `confirmSignUp con email inexistente responde error`() {
        val response = apiContext.post(
            "/intrale/confirmSignUp",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "email" to "noexiste_${System.currentTimeMillis()}@test.com",
                    "code" to "123456"
                ))
        )

        val body = response.text()
        logger.info("ConfirmSignUp email inexistente: status=${response.status()}, body=$body")
        assertTrue(
            response.status() in 400..599,
            "ConfirmSignUp con email inexistente debe responder error (4xx/5xx). Actual: ${response.status()}"
        )
    }
}
