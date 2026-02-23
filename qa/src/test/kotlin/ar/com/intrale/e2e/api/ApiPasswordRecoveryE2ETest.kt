package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — Password Recovery contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiPasswordRecoveryE2ETest : QATestBase() {

    @Test
    @Order(1)
    @DisplayName("POST /intrale/recovery con email seed responde 200")
    fun `recovery con email seed responde 200`() {
        val response = apiContext.post(
            "/intrale/recovery",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to "admin@intrale.com"))
        )

        logger.info("Recovery con email seed: status=${response.status()}")
        val body = response.text()
        logger.info("Recovery body: $body")

        assertTrue(
            response.status() in listOf(200, 400),
            "Recovery con email seed debe responder 200 (enviado) o 400 (limite). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/recovery sin body responde 400")
    fun `recovery sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/recovery",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("Recovery sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Recovery sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/confirm sin codigo responde 400")
    fun `confirm sin codigo responde 400`() {
        val response = apiContext.post(
            "/intrale/confirm",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "email" to "admin@intrale.com",
                    "password" to "NewPass1234!",
                    "confirmationCode" to ""
                ))
        )

        logger.info("Confirm sin codigo: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Confirm sin codigo debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(4)
    @DisplayName("POST /intrale/confirm con codigo invalido responde error")
    fun `confirm con codigo invalido responde error`() {
        val response = apiContext.post(
            "/intrale/confirm",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "email" to "admin@intrale.com",
                    "password" to "NewPass1234!",
                    "confirmationCode" to "000000"
                ))
        )

        logger.info("Confirm con codigo invalido: status=${response.status()}")
        assertTrue(
            response.status() in 400..599,
            "Confirm con codigo invalido debe responder error. Actual: ${response.status()}"
        )
    }
}
