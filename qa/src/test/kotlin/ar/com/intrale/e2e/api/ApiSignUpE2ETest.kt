package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — SignUp contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiSignUpE2ETest : QATestBase() {

    private val testEmail = "qa-test-${System.currentTimeMillis()}@intrale.com"

    @Test
    @Order(1)
    @DisplayName("POST /intrale/signup con email nuevo responde 200")
    fun `signup con email nuevo responde 200`() {
        val response = apiContext.post(
            "/intrale/signup",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to testEmail))
        )

        logger.info("SignUp response: status=${response.status()}, email=$testEmail")
        val body = response.text()
        logger.info("SignUp body: $body")

        assertTrue(
            response.status() == 200,
            "SignUp con email nuevo debe responder 200. Actual: ${response.status()}, body: $body"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/signup con email duplicado responde 200 (idempotente)")
    fun `signup con email duplicado responde 200`() {
        // Primer registro
        apiContext.post(
            "/intrale/signup",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to "qa-dup-${System.currentTimeMillis()}@intrale.com"))
        )

        // Segundo registro con el mismo email de seed (ya existe)
        val response = apiContext.post(
            "/intrale/signup",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to "admin@intrale.com"))
        )

        logger.info("SignUp duplicado: status=${response.status()}")
        assertTrue(
            response.status() == 200,
            "SignUp con email existente debe ser idempotente (200). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/signup sin body responde 400")
    fun `signup sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/signup",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("SignUp sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "SignUp sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(4)
    @DisplayName("POST /intrale/signup con email invalido responde 400")
    fun `signup con email invalido responde 400`() {
        val response = apiContext.post(
            "/intrale/signup",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to "no-es-un-email"))
        )

        logger.info("SignUp email invalido: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "SignUp con email invalido debe responder 4xx. Actual: ${response.status()}"
        )
    }
}
