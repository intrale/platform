package ar.com.intrale

import com.auth0.jwk.Jwk
import com.auth0.jwk.JwkProvider
import com.auth0.jwk.JwkProviderBuilder
import com.auth0.jwt.JWT
import com.auth0.jwt.JWTVerifier
import com.auth0.jwt.algorithms.Algorithm
import com.auth0.jwt.interfaces.Claim
import com.auth0.jwt.interfaces.DecodedJWT
import io.mockk.*
import java.security.interfaces.RSAPublicKey
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class CognitoJwtValidatorTest {

    private val config = object : Config("us-east-1", "testPool", "testClient") {
        override fun businesses() = setOf("biz")
    }

    private fun setupMocks(tokenUse: String = "access", clientId: String = "testClient"): DecodedJWT {
        mockkConstructor(JwkProviderBuilder::class)
        val provider = mockk<JwkProvider>()
        every { anyConstructed<JwkProviderBuilder>().cached(any(), any(), any()) } returns mockk {
            every { build() } returns provider
        }

        val jwk = mockk<Jwk>()
        val publicKey = mockk<RSAPublicKey>()
        every { provider.get(any()) } returns jwk
        every { jwk.publicKey } returns publicKey

        mockkStatic(JWT::class)
        val decoded = mockk<DecodedJWT>()
        every { JWT.decode(any<String>()) } returns decoded
        every { decoded.keyId } returns "kid-1"

        val verifier = mockk<JWTVerifier>()
        every { JWT.require(any<Algorithm>()) } returns mockk {
            every { withIssuer(any<String>()) } returns this
            every { build() } returns verifier
        }
        every { verifier.verify(any<String>()) } returns decoded

        val tokenUseClaim = mockk<Claim>()
        every { tokenUseClaim.asString() } returns tokenUse
        every { decoded.getClaim("token_use") } returns tokenUseClaim

        val clientIdClaim = mockk<Claim>()
        every { clientIdClaim.asString() } returns clientId
        every { decoded.getClaim("client_id") } returns clientIdClaim

        return decoded
    }

    @Test
    fun `validate retorna DecodedJWT con token valido`() {
        val decoded = setupMocks()
        val validator = CognitoJwtValidator(config)

        val result = validator.validate("valid-token")

        assertEquals(decoded, result)
        unmockkAll()
    }

    @Test
    fun `validate lanza excepcion si token_use no es access`() {
        setupMocks(tokenUse = "id")
        val validator = CognitoJwtValidator(config)

        val ex = assertFailsWith<IllegalArgumentException> {
            validator.validate("id-token")
        }
        assertEquals("Token no es un access_token", ex.message)
        unmockkAll()
    }

    @Test
    fun `validate lanza excepcion si client_id no coincide`() {
        setupMocks(clientId = "wrong-client")
        val validator = CognitoJwtValidator(config)

        val ex = assertFailsWith<IllegalArgumentException> {
            validator.validate("wrong-client-token")
        }
        assertEquals("ClientId invalido", ex.message)
        unmockkAll()
    }
}
