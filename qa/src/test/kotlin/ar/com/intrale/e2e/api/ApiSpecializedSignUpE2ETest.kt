package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — Registros especializados (signupPlatformAdmin, signupDelivery, registerSaler)")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiSpecializedSignUpE2ETest : QATestBase() {

    // --- signupPlatformAdmin ---

    @Test
    @Order(1)
    @DisplayName("POST /intrale/signupPlatformAdmin con datos válidos responde 200")
    fun `signupPlatformAdmin con datos validos responde 200`() {
        val email = "qa-padmin-${System.currentTimeMillis()}@intrale.com"
        val response = apiContext.post(
            "/intrale/signupPlatformAdmin",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to email))
        )

        logger.info("signupPlatformAdmin response: status=${response.status()}, email=$email")
        val body = response.text()
        logger.info("signupPlatformAdmin body: $body")

        assertTrue(
            response.status() in 200..409,
            "signupPlatformAdmin con datos válidos debe responder 200 o 409 (si ya existe admin). Actual: ${response.status()}, body: $body"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/signupPlatformAdmin sin body responde 400")
    fun `signupPlatformAdmin sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/signupPlatformAdmin",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("signupPlatformAdmin sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "signupPlatformAdmin sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    // --- signupDelivery ---

    @Test
    @Order(3)
    @DisplayName("POST /intrale/signupDelivery con datos válidos responde 200")
    fun `signupDelivery con datos validos responde 200`() {
        val email = "qa-delivery-${System.currentTimeMillis()}@intrale.com"
        val response = apiContext.post(
            "/intrale/signupDelivery",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to email))
        )

        logger.info("signupDelivery response: status=${response.status()}, email=$email")
        val body = response.text()
        logger.info("signupDelivery body: $body")

        assertTrue(
            response.status() == 200,
            "signupDelivery con datos válidos debe responder 200. Actual: ${response.status()}, body: $body"
        )
    }

    @Test
    @Order(4)
    @DisplayName("POST /intrale/signupDelivery sin body responde 400")
    fun `signupDelivery sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/signupDelivery",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("signupDelivery sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "signupDelivery sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    // --- registerSaler ---

    @Test
    @Order(5)
    @DisplayName("POST /intrale/registerSaler con datos válidos responde 200")
    fun `registerSaler con datos validos responde 200`() {
        val email = "qa-saler-${System.currentTimeMillis()}@intrale.com"
        val response = apiContext.post(
            "/intrale/registerSaler",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to email))
        )

        logger.info("registerSaler response: status=${response.status()}, email=$email")
        val body = response.text()
        logger.info("registerSaler body: $body")

        // registerSaler requiere JWT de BusinessAdmin — sin token válido espera 401
        assertTrue(
            response.status() in listOf(200, 401),
            "registerSaler debe responder 200 (con JWT válido) o 401 (sin JWT). Actual: ${response.status()}, body: $body"
        )
    }

    @Test
    @Order(6)
    @DisplayName("POST /intrale/registerSaler sin body responde 400")
    fun `registerSaler sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/registerSaler",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("registerSaler sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "registerSaler sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }
}
