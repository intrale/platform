package ar.com.intrale

import kotlinx.coroutines.runBlocking
import org.slf4j.LoggerFactory
import io.mockk.*
import com.auth0.jwk.JwkProvider
import com.auth0.jwk.JwkProviderBuilder
import com.auth0.jwk.Jwk
import com.auth0.jwt.JWT
import com.auth0.jwt.JWTVerifier
import com.auth0.jwt.interfaces.DecodedJWT
import com.auth0.jwt.algorithms.Algorithm
import java.security.interfaces.RSAPublicKey
import kotlin.test.Test
import kotlin.test.assertTrue

class SecuredFunctionTest {
    class DummySecuredFunction(override val config: Config) : SecuredFunction(config, LoggerFactory.getLogger("test")) {
        var called = false
        override suspend fun securedExecute(business: String, function: String, headers: Map<String, String>, textBody: String): Response {
            called = true
            return Response()
        }
    }

    @Test
    fun invalidTokenReturnsUnauthorized() {
        val cfg = object : Config("us-east-1", "pool", "client") {
            override fun businesses() = setOf("biz")
        }
        val func = DummySecuredFunction(cfg)
        val resp = runBlocking { func.execute("biz", "func", emptyMap(), "body") }
        assertTrue(resp is UnauthorizedException)
        assertTrue(!func.called)
    }

    @Test
    fun validTokenCallsSecuredExecute() {
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

        val cfg = object : Config("us-east-1", "pool", "client") {
            override fun businesses() = setOf("biz")
        }
        val func = DummySecuredFunction(cfg)
        val resp = runBlocking { func.execute("biz", "func", mapOf("Authorization" to "token"), "body") }

        assertTrue(resp is Response)
        assertTrue(func.called)

        unmockkAll()
    }
}
