package ar.com.intrale

import com.eatthepath.otp.TimeBasedOneTimePasswordGenerator
import com.google.gson.Gson
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import org.apache.commons.codec.binary.Base32
import java.time.Instant
import javax.crypto.spec.SecretKeySpec
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class E2ETwoFactorTest : E2ETestBase() {

    private val knownSecret = Base32().encodeToString("12345678901234567890".toByteArray())

    @Test
    fun `setup de segundo factor genera URI y persiste secreto`() {
        seedBusiness("intrale")
        val email = "user@test.com"
        configureCognitoGetUser(email)

        e2eTest { client ->
            val response = client.post("/intrale/2fasetup") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(email))
                setBody("{}")
            }
            assertEquals(HttpStatusCode.OK, response.status)
            val body = response.bodyAsText()
            assertTrue(body.contains("otpauth://totp/"), "Debe contener URI TOTP")

            val user = tableUsers.items.find { it.email == email }
            assertTrue(user != null, "Debe existir el usuario en la tabla")
            assertTrue(!user.secret.isNullOrBlank(), "Debe tener secret guardado")
        }
    }

    @Test
    fun `verificacion de segundo factor con codigo valido`() {
        seedBusiness("intrale")
        val email = "user@test.com"
        configureCognitoGetUser(email)

        // Seedear usuario con secret conocido
        tableUsers.putItem(User(email = email, secret = knownSecret))

        e2eTest { client ->
            // Generar TOTP valido con el mismo secret
            val generator = TimeBasedOneTimePasswordGenerator()
            val key = SecretKeySpec(Base32().decode(knownSecret), "HmacSHA1")
            val code = String.format("%06d", generator.generateOneTimePassword(key, Instant.now()))

            val response = client.post("/intrale/2faverify") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(email))
                setBody(Gson().toJson(TwoFactorVerifyRequest(code)))
            }
            assertEquals(HttpStatusCode.OK, response.status)
        }
    }

    @Test
    fun `verificacion de segundo factor con codigo invalido retorna error`() {
        seedBusiness("intrale")
        val email = "user@test.com"
        configureCognitoGetUser(email)

        tableUsers.putItem(User(email = email, secret = knownSecret))

        e2eTest { client ->
            val response = client.post("/intrale/2faverify") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(email))
                setBody(Gson().toJson(TwoFactorVerifyRequest("000000")))
            }
            assertEquals(HttpStatusCode.InternalServerError, response.status)
            val body = response.bodyAsText()
            assertTrue(body.contains("Invalid Two Factor Code"), "Debe indicar codigo invalido")
        }
    }
}
