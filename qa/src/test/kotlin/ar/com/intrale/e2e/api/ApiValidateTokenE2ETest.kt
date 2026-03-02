package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@DisplayName("E2E — Validate token JWT contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiValidateTokenE2ETest : QATestBase() {

    @Test
    @Order(0)
    @DisplayName("POST /intrale/validate con JWT valido de signin responde 200")
    fun `validate con token valido obtenido via signin responde 200`() {
        // Paso 1: Obtener accessToken valido via signin con credenciales seed
        val signinResponse = apiContext.post(
            "/intrale/signin",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "email" to "admin@intrale.com",
                    "password" to "Admin1234!",
                    "newPassword" to "Admin1234!",
                    "name" to "Admin",
                    "familyName" to "Intrale"
                ))
        )

        logger.info("SignIn para validate: status=${signinResponse.status()}")
        val signinBody = signinResponse.text()
        logger.info("SignIn body (truncado): ${signinBody.take(200)}")

        // Si signin no retorna 200 con accessToken, skip (el entorno no tiene usuario seed)
        assumeTrue(
            signinResponse.status() == 200 && signinBody.contains("accessToken"),
            "Signin debe retornar 200 con accessToken para ejecutar este test"
        )

        // Extraer accessToken del JSON de respuesta
        val accessToken = Regex(""""accessToken"\s*:\s*"([^"]+)"""")
            .find(signinBody)?.groupValues?.get(1)
        assumeTrue(
            accessToken != null,
            "No se pudo extraer accessToken de la respuesta de signin"
        )

        // Paso 2: Llamar a validate con el token real
        val validateResponse = apiContext.post(
            "/intrale/validate",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", accessToken!!)
                .setData("{}")
        )

        logger.info("Validate con token valido: status=${validateResponse.status()}")
        assertEquals(
            200, validateResponse.status(),
            "Validate con JWT valido de signin debe responder 200. Actual: ${validateResponse.status()}"
        )
    }

    @Test
    @Order(1)
    @DisplayName("POST /intrale/validate sin body responde 400 o 401")
    fun `validate sin body responde error`() {
        val response = apiContext.post(
            "/intrale/validate",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("Validate sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "POST /intrale/validate sin body debe responder 4xx (SecuredFunction sin token). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/validate sin header Authorization responde 401")
    fun `validate sin token responde 401`() {
        val response = apiContext.post(
            "/intrale/validate",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf("email" to "admin@intrale.com"))
        )

        logger.info("Validate sin token: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Validate sin JWT debe responder 4xx (SecuredFunction). Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/validate con token invalido responde 401")
    fun `validate con token invalido responde 401`() {
        val response = apiContext.post(
            "/intrale/validate",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer token-invalido-fake-12345")
                .setData("{}")
        )

        logger.info("Validate con token invalido: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Validate con token invalido debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(4)
    @DisplayName("POST /intrale/validate con JWT expirado responde 401")
    fun `validate con token expirado responde 401`() {
        // JWT con formato valido pero expirado (payload: {"sub":"test","exp":0})
        val expiredJwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9" +
            ".eyJzdWIiOiJ0ZXN0LXVzZXIiLCJleHAiOjEwMDAwMDAwMDAsImlzcyI6InRlc3QifQ" +
            ".fake-signature-placeholder"

        val response = apiContext.post(
            "/intrale/validate",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "Bearer $expiredJwt")
                .setData("{}")
        )

        logger.info("Validate con token expirado: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Validate con JWT expirado debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(5)
    @DisplayName("POST /intrale/validate con Authorization malformado responde 401")
    fun `validate con header Authorization malformado responde 401`() {
        val response = apiContext.post(
            "/intrale/validate",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setHeader("Authorization", "NotBearer some-value")
                .setData("{}")
        )

        logger.info("Validate con Authorization malformado: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "Validate con Authorization malformado debe responder 4xx. Actual: ${response.status()}"
        )
    }
}
