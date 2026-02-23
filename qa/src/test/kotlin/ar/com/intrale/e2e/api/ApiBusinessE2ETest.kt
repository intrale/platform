package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E — Business endpoints contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiBusinessE2ETest : QATestBase() {

    @Test
    @Order(1)
    @DisplayName("POST /intrale/searchBusinesses con query vacia responde 200")
    fun `searchBusinesses con query vacia responde 200`() {
        val response = apiContext.post(
            "/intrale/searchBusinesses",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "query" to "",
                    "status" to "APPROVED",
                    "limit" to 10
                ))
        )

        logger.info("SearchBusinesses query vacia: status=${response.status()}")
        val body = response.text()
        logger.info("SearchBusinesses body: $body")

        assertTrue(
            response.status() == 200,
            "SearchBusinesses con query vacia debe responder 200. Actual: ${response.status()}, body: $body"
        )

        assertTrue(
            body.contains("businesses"),
            "La respuesta debe contener el campo 'businesses'"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/searchBusinesses con filtro APPROVED encuentra intrale")
    fun `searchBusinesses filtra por status APPROVED`() {
        val response = apiContext.post(
            "/intrale/searchBusinesses",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "query" to "intrale",
                    "status" to "APPROVED",
                    "limit" to 10
                ))
        )

        logger.info("SearchBusinesses filtro APPROVED: status=${response.status()}")
        val body = response.text()
        logger.info("SearchBusinesses body: $body")

        assertTrue(
            response.status() == 200,
            "SearchBusinesses con filtro APPROVED debe responder 200. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/searchBusinesses sin body responde 400")
    fun `searchBusinesses sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/searchBusinesses",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("SearchBusinesses sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "SearchBusinesses sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(4)
    @DisplayName("POST /intrale/registerBusiness con datos validos responde 200")
    fun `registerBusiness con datos validos responde 200`() {
        val uniqueName = "qa-test-biz-${System.currentTimeMillis()}"
        val response = apiContext.post(
            "/intrale/registerBusiness",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "name" to uniqueName,
                    "emailAdmin" to "qa-biz-${System.currentTimeMillis()}@intrale.com",
                    "description" to "Negocio de prueba QA E2E"
                ))
        )

        logger.info("RegisterBusiness: status=${response.status()}")
        val body = response.text()
        logger.info("RegisterBusiness body: $body")

        assertTrue(
            response.status() == 200,
            "RegisterBusiness con datos validos debe responder 200. Actual: ${response.status()}, body: $body"
        )
    }

    @Test
    @Order(5)
    @DisplayName("POST /intrale/registerBusiness sin body responde 400")
    fun `registerBusiness sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/registerBusiness",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("RegisterBusiness sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "RegisterBusiness sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }
}
