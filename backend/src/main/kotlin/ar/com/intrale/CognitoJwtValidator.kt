package ar.com.intrale

import com.auth0.jwk.JwkProviderBuilder
import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import com.auth0.jwt.interfaces.DecodedJWT
import java.net.URI
import java.security.interfaces.RSAPublicKey
import java.util.concurrent.TimeUnit

class CognitoJwtValidator(private val config: Config) : JwtValidator {

    override fun validate(token: String): DecodedJWT {
        val region = config.region
        val userPoolId = config.awsCognitoUserPoolId

        val issuer = "https://cognito-idp.$region.amazonaws.com/$userPoolId"
        val jwksUrl = "$issuer/.well-known/jwks.json"

        val provider = JwkProviderBuilder(URI(jwksUrl).toURL())
            .cached(10, 24, TimeUnit.HOURS)
            .build()

        val jwt: DecodedJWT = JWT.decode(token)
        val jwk = provider.get(jwt.keyId)
        val algorithm = Algorithm.RSA256(jwk.publicKey as RSAPublicKey, null)

        val verifier = JWT.require(algorithm)
            .withIssuer(issuer)
            .build()

        val decodedJWT = verifier.verify(token)

        val tokenUse = decodedJWT.getClaim("token_use").asString()
        if (tokenUse != "access") {
            throw IllegalArgumentException("Token no es un access_token")
        }

        val clientIdFromToken = decodedJWT.getClaim("client_id").asString()
        if (clientIdFromToken != config.awsCognitoClientId) {
            throw IllegalArgumentException("ClientId invalido")
        }

        return decodedJWT
    }
}
