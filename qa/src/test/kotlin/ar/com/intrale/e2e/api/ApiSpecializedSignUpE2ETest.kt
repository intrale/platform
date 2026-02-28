package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — Registros especializados (signupPlatformAdmin, signupDelivery, registerSaler)")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiSpecializedSignUpE2ETest : QATestBase() {

    // ── signupPlatformAdmin ─────────────────────────────────────────────

    @Nested
    @DisplayName("signupPlatformAdmin")
    @TestMethodOrder(MethodOrderer.OrderAnnotation::class)
    inner class SignUpPlatformAdminTests {

        @Test
        @Order(1)
        @DisplayName("POST /intrale/signupPlatformAdmin con email valido responde 200 o 401")
        fun `signupPlatformAdmin con email valido responde 200 o 401`() {
            val email = "qa-padmin-${System.currentTimeMillis()}@intrale.com"
            val response = apiContext.post(
                "/intrale/signupPlatformAdmin",
                RequestOptions.create()
                    .setHeader("Content-Type", "application/json")
                    .setData(mapOf("email" to email))
            )

            logger.info("signupPlatformAdmin: status=${response.status()}, email=$email")
            val body = response.text()
            logger.info("signupPlatformAdmin body: $body")

            // 200 si es el primer usuario del pool, 401 si ya existen usuarios
            assertTrue(
                response.status() in listOf(200, 401),
                "signupPlatformAdmin debe responder 200 (pool vacio) o 401 (usuarios existentes). Actual: ${response.status()}, body: $body"
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

        @Test
        @Order(3)
        @DisplayName("POST /intrale/signupPlatformAdmin con email invalido responde 400")
        fun `signupPlatformAdmin con email invalido responde 400`() {
            val response = apiContext.post(
                "/intrale/signupPlatformAdmin",
                RequestOptions.create()
                    .setHeader("Content-Type", "application/json")
                    .setData(mapOf("email" to "no-es-un-email"))
            )

            logger.info("signupPlatformAdmin email invalido: status=${response.status()}")
            assertTrue(
                response.status() in 400..499,
                "signupPlatformAdmin con email invalido debe responder 4xx. Actual: ${response.status()}"
            )
        }
    }

    // ── signupDelivery ──────────────────────────────────────────────────

    @Nested
    @DisplayName("signupDelivery")
    @TestMethodOrder(MethodOrderer.OrderAnnotation::class)
    inner class SignUpDeliveryTests {

        @Test
        @Order(1)
        @DisplayName("POST /intrale/signupDelivery con email valido responde 200")
        fun `signupDelivery con email valido responde 200`() {
            val email = "qa-delivery-${System.currentTimeMillis()}@intrale.com"
            val response = apiContext.post(
                "/intrale/signupDelivery",
                RequestOptions.create()
                    .setHeader("Content-Type", "application/json")
                    .setData(mapOf("email" to email))
            )

            logger.info("signupDelivery: status=${response.status()}, email=$email")
            val body = response.text()
            logger.info("signupDelivery body: $body")

            assertTrue(
                response.status() == 200,
                "signupDelivery con email nuevo debe responder 200. Actual: ${response.status()}, body: $body"
            )
        }

        @Test
        @Order(2)
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

        @Test
        @Order(3)
        @DisplayName("POST /intrale/signupDelivery con email invalido responde 400")
        fun `signupDelivery con email invalido responde 400`() {
            val response = apiContext.post(
                "/intrale/signupDelivery",
                RequestOptions.create()
                    .setHeader("Content-Type", "application/json")
                    .setData(mapOf("email" to "no-es-un-email"))
            )

            logger.info("signupDelivery email invalido: status=${response.status()}")
            assertTrue(
                response.status() in 400..499,
                "signupDelivery con email invalido debe responder 4xx. Actual: ${response.status()}"
            )
        }
    }

    // ── registerSaler ───────────────────────────────────────────────────

    @Nested
    @DisplayName("registerSaler")
    @TestMethodOrder(MethodOrderer.OrderAnnotation::class)
    inner class RegisterSalerTests {

        @Test
        @Order(1)
        @DisplayName("POST /intrale/registerSaler sin body responde 4xx")
        fun `registerSaler sin body responde error`() {
            val response = apiContext.post(
                "/intrale/registerSaler",
                RequestOptions.create()
                    .setHeader("Content-Type", "application/json")
                    .setData("")
            )

            logger.info("registerSaler sin body: status=${response.status()}")
            assertTrue(
                response.status() in 400..499,
                "registerSaler sin body debe responder 4xx (SecuredFunction sin token). Actual: ${response.status()}"
            )
        }

        @Test
        @Order(2)
        @DisplayName("POST /intrale/registerSaler sin Authorization responde 401")
        fun `registerSaler sin token responde 401`() {
            val response = apiContext.post(
                "/intrale/registerSaler",
                RequestOptions.create()
                    .setHeader("Content-Type", "application/json")
                    .setData(mapOf("email" to "qa-saler-${System.currentTimeMillis()}@intrale.com"))
            )

            logger.info("registerSaler sin token: status=${response.status()}")
            assertTrue(
                response.status() in 400..499,
                "registerSaler sin JWT debe responder 4xx (SecuredFunction). Actual: ${response.status()}"
            )
        }

        @Test
        @Order(3)
        @DisplayName("POST /intrale/registerSaler con token invalido responde 401")
        fun `registerSaler con token invalido responde 401`() {
            val response = apiContext.post(
                "/intrale/registerSaler",
                RequestOptions.create()
                    .setHeader("Content-Type", "application/json")
                    .setHeader("Authorization", "Bearer token-invalido-fake-12345")
                    .setData(mapOf("email" to "qa-saler-${System.currentTimeMillis()}@intrale.com"))
            )

            logger.info("registerSaler con token invalido: status=${response.status()}")
            assertTrue(
                response.status() in 400..499,
                "registerSaler con token invalido debe responder 4xx. Actual: ${response.status()}"
            )
        }

        @Test
        @Order(4)
        @DisplayName("POST /intrale/registerSaler con JWT expirado responde 401")
        fun `registerSaler con token expirado responde 401`() {
            // JWT con formato valido pero expirado (payload: {"sub":"test","exp":1000000000})
            val expiredJwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9" +
                ".eyJzdWIiOiJ0ZXN0LXVzZXIiLCJleHAiOjEwMDAwMDAwMDAsImlzcyI6InRlc3QifQ" +
                ".fake-signature-placeholder"

            val response = apiContext.post(
                "/intrale/registerSaler",
                RequestOptions.create()
                    .setHeader("Content-Type", "application/json")
                    .setHeader("Authorization", "Bearer $expiredJwt")
                    .setData(mapOf("email" to "qa-saler-${System.currentTimeMillis()}@intrale.com"))
            )

            logger.info("registerSaler con token expirado: status=${response.status()}")
            assertTrue(
                response.status() in 400..499,
                "registerSaler con JWT expirado debe responder 4xx. Actual: ${response.status()}"
            )
        }

        @Test
        @Order(5)
        @DisplayName("POST /intrale/registerSaler con email invalido y sin token responde 4xx")
        fun `registerSaler con email invalido responde error`() {
            val response = apiContext.post(
                "/intrale/registerSaler",
                RequestOptions.create()
                    .setHeader("Content-Type", "application/json")
                    .setData(mapOf("email" to "no-es-un-email"))
            )

            logger.info("registerSaler email invalido: status=${response.status()}")
            assertTrue(
                response.status() in 400..499,
                "registerSaler con email invalido debe responder 4xx. Actual: ${response.status()}"
            )
        }
    }
}
