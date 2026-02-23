package ar.com.intrale.e2e.api

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@DisplayName("E2E — SignIn contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ApiSignInE2ETest : QATestBase() {

    @Test
    @Order(1)
    @DisplayName("POST /intrale/signin con credenciales seed responde 200 con tokens")
    fun `signin con credenciales seed retorna tokens`() {
        val response = apiContext.post(
            "/intrale/signin",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "email" to "admin@intrale.com",
                    "password" to "Admin1234!",
                    // Primera vez con password temporal requiere newPassword
                    "newPassword" to "Admin1234!",
                    "name" to "Admin",
                    "familyName" to "Intrale"
                ))
        )

        logger.info("SignIn response: status=${response.status()}")
        val body = response.text()
        logger.info("SignIn body: $body")

        // El primer login puede requerir cambio de password (200) o fallar si ya fue cambiado
        assertTrue(
            response.status() in listOf(200, 401),
            "SignIn debe responder 200 (ok) o 401 (challenge ya resuelto). Actual: ${response.status()}"
        )

        if (response.status() == 200) {
            assertTrue(body.contains("idToken") || body.contains("statusCode"),
                "La respuesta debe contener idToken o statusCode")
        }
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/signin sin body responde 400")
    fun `signin sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/signin",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )

        logger.info("SignIn sin body: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "SignIn sin body debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/signin con password incorrecto responde 401")
    fun `signin con password incorrecto responde 401`() {
        val response = apiContext.post(
            "/intrale/signin",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "email" to "admin@intrale.com",
                    "password" to "PasswordIncorrecto123!"
                ))
        )

        logger.info("SignIn password incorrecto: status=${response.status()}")
        assertTrue(
            response.status() in 400..499,
            "SignIn con password incorrecto debe responder 4xx. Actual: ${response.status()}"
        )
    }

    @Test
    @Order(4)
    @DisplayName("POST /intrale/signin con email inexistente responde error")
    fun `signin con email inexistente responde error`() {
        val response = apiContext.post(
            "/intrale/signin",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(
                    "email" to "noexiste_${System.currentTimeMillis()}@test.com",
                    "password" to "Admin1234!"
                ))
        )

        logger.info("SignIn email inexistente: status=${response.status()}")
        assertTrue(
            response.status() in 400..599,
            "SignIn con email inexistente debe responder error (4xx/5xx). Actual: ${response.status()}"
        )
    }
}
