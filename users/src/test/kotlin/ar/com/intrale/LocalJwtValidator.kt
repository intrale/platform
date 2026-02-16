package ar.com.intrale

import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import com.auth0.jwt.interfaces.DecodedJWT
import java.security.KeyPairGenerator
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.util.Date

/**
 * JwtValidator local para tests E2E.
 * Genera y valida JWTs con un par de claves RSA generado en memoria.
 */
class LocalJwtValidator(
    private val clientId: String = "test-client-id"
) : JwtValidator {

    private val keyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    private val publicKey = keyPair.public as RSAPublicKey
    private val privateKey = keyPair.private as RSAPrivateKey
    private val algorithm = Algorithm.RSA256(publicKey, privateKey)
    private val issuer = "https://cognito-idp.us-east-1.amazonaws.com/test-pool"

    fun generateToken(
        email: String,
        tokenUse: String = "access",
        overrideClientId: String = clientId
    ): String {
        return JWT.create()
            .withIssuer(issuer)
            .withClaim("token_use", tokenUse)
            .withClaim("client_id", overrideClientId)
            .withClaim("email", email)
            .withSubject(email)
            .withIssuedAt(Date())
            .withExpiresAt(Date(System.currentTimeMillis() + 3600_000))
            .sign(algorithm)
    }

    override fun validate(token: String): DecodedJWT {
        val verifier = JWT.require(algorithm)
            .withIssuer(issuer)
            .build()

        val decoded = verifier.verify(token)

        val tokenUse = decoded.getClaim("token_use").asString()
        if (tokenUse != "access") {
            throw IllegalArgumentException("Token no es un access_token")
        }

        val tokenClientId = decoded.getClaim("client_id").asString()
        if (tokenClientId != clientId) {
            throw IllegalArgumentException("ClientId invalido")
        }

        return decoded
    }
}
