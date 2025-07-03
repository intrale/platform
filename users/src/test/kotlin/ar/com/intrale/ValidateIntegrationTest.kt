package ar.com.intrale

import com.auth0.jwk.Jwk
import com.auth0.jwk.JwkProvider
import com.auth0.jwk.JwkProviderBuilder
import com.auth0.jwt.JWT
import com.auth0.jwt.JWTVerifier
import com.auth0.jwt.algorithms.Algorithm
import com.auth0.jwt.interfaces.DecodedJWT
import io.ktor.http.HttpStatusCode
import io.mockk.*
import kotlinx.coroutines.runBlocking
import org.slf4j.Logger
import org.slf4j.helpers.NOPLogger
import java.security.interfaces.RSAPublicKey
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ValidateIntegrationTest {
    private val logger: Logger = NOPLogger.NOP_LOGGER
    private val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")

    @Test
    fun `token inválido retorna Unauthorized`() = runBlocking {
        val validate = Validate(config, logger)
        val resp = validate.execute("biz", "validate", emptyMap(), "")
        assertTrue(resp is UnauthorizedException)
    }

    @Test
    fun `token válido retorna OK`() = runBlocking {
        mockkConstructor(JwkProviderBuilder::class)
        val provider = mockk<JwkProvider>()
        every { anyConstructed<JwkProviderBuilder>().build() } returns provider
        val jwk = mockk<Jwk>()
        val publicKey = mockk<RSAPublicKey>()
        every { provider.get(any()) } returns jwk
        every { jwk.publicKey } returns publicKey

        mockkStatic(JWT::class)
        val decoded = mockk<DecodedJWT>()
        every { JWT.decode(any<String>()) } returns decoded
        every { decoded.keyId } returns "kid"

        val verifier = mockk<JWTVerifier>()
        every { JWT.require(any<Algorithm>()) } returns mockk {
            every { withIssuer(any<String>()) } returns this
            every { build() } returns verifier
        }
        every { verifier.verify(any<String>()) } returns decoded
        every { decoded.getClaim("token_use").asString() } returns "access"
        every { decoded.getClaim("client_id").asString() } returns "client"

        val validate = Validate(config, logger)
        val resp = validate.execute("biz", "validate", mapOf("Authorization" to "token"), "")

        assertEquals(HttpStatusCode.OK, resp.statusCode)

        unmockkAll()
    }
}
