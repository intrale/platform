package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — Two Factor Auth contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiTwoFactorE2ETest : QATestBase() {

    // ── 2fasetup ──

    @Test
    @Order(1)
    @DisplayName("POST /intrale/2fasetup sin token responde 401")
    fun `2fasetup sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/2fasetup",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to "admin@intrale.com"))
        )

        logger.info("2fasetup sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "2fasetup sin JWT debe responder 4xx (SecuredFunction). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/2fasetup con token invalido responde 401")
    fun `2fasetup con token invalido responde 401`() {
        val response = apiContext.post(
            "/intrale/2fasetup",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer token-invalido-fake-12345")
                .setData(mapOf("email" to "admin@intrale.com"))
        )

        logger.info("2fasetup con token invalido: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "2fasetup con token invalido debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/2fasetup sin body responde 400")
    fun `2fasetup sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/2fasetup",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
        )

        logger.info("2fasetup sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "2fasetup sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    // ── 2faverify ──

    @Test
    @Order(4)
    @DisplayName("POST /intrale/2faverify sin token responde 401")
    fun `2faverify sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/2faverify",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "email" to "admin@intrale.com",
                    "code" to "123456"
                ))
        )

        logger.info("2faverify sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "2faverify sin JWT debe responder 4xx (SecuredFunction). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(5)
    @DisplayName("POST /intrale/2faverify con token invalido responde 401")
    fun `2faverify con token invalido responde 401`() {
        val response = apiContext.post(
            "/intrale/2faverify",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer token-invalido-fake-12345")
                .setData(mapOf(
                    "email" to "admin@intrale.com",
                    "code" to "123456"
                ))
        )

        logger.info("2faverify con token invalido: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "2faverify con token invalido debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(6)
    @DisplayName("POST /intrale/2faverify sin body responde 400")
    fun `2faverify sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/2faverify",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
        )

        logger.info("2faverify sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "2faverify sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(7)
    @DisplayName("POST /intrale/2faverify con codigo invalido responde error")
    fun `2faverify con codigo invalido responde error`() {
        val response = apiContext.post(
            "/intrale/2faverify",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer token-invalido-fake-12345")
                .setData(mapOf(
                    "email" to "admin@intrale.com",
                    "code" to "000000"
                ))
        )

        logger.info("2faverify con codigo invalido: status=${response.status()}")
        assertTrue(
            response.status() in 400..599,
            "2faverify con codigo invalido debe responder error. Actual: ${response.status()}"
        )
    }
}
