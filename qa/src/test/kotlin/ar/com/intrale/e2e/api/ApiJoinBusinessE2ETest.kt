package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — Join Business endpoints contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiJoinBusinessE2ETest : QATestBase() {

    @Test
    @Order(1)
    @DisplayName("POST /intrale/requestJoinBusiness sin token responde 401")
    fun `requestJoinBusiness sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/requestJoinBusiness",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("placeholder" to "test"))
        )

        logger.info("requestJoinBusiness sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "requestJoinBusiness sin JWT debe responder 4xx (SecuredFunction). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/requestJoinBusiness sin body responde 400")
    fun `requestJoinBusiness sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/requestJoinBusiness",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("requestJoinBusiness sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "requestJoinBusiness sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/reviewJoinBusiness sin token responde 401")
    fun `reviewJoinBusiness sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/reviewJoinBusiness",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "email" to "delivery@intrale.com",
                    "decision" to "APPROVED"
                ))
        )

        logger.info("reviewJoinBusiness sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "reviewJoinBusiness sin JWT debe responder 4xx (SecuredFunction). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(4)
    @DisplayName("POST /intrale/reviewJoinBusiness sin body responde 400")
    fun `reviewJoinBusiness sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/reviewJoinBusiness",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("reviewJoinBusiness sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "reviewJoinBusiness sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }
}
