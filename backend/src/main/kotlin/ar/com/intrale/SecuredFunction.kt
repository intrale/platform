package ar.com.intrale

import com.auth0.jwk.JwkProviderBuilder
import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import com.auth0.jwt.interfaces.DecodedJWT
import org.slf4j.Logger
import java.net.URI
import java.security.interfaces.RSAPublicKey
import java.util.concurrent.TimeUnit

/**
 * Funcion segurizada
 * Previo a la ejecucion valida si el usuario tiene un token valido para ejecutar
 */
abstract class SecuredFunction(open val config: Config, open val logger: Logger) : Function {

    override suspend fun execute(business: String, function: String, headers: Map<String, String>, textBody: String): Response {
        val token = headers["Authorization"]

        val region = config.region
        val userPoolId = config.awsCognitoUserPoolId

        val issuer = "https://cognito-idp.$region.amazonaws.com/$userPoolId"
        val jwksUrl = "$issuer/.well-known/jwks.json"

        try {
            val provider = JwkProviderBuilder(URI(jwksUrl).toURL())
                .cached(10, 24, TimeUnit.HOURS)
                .build()

            val jwt: DecodedJWT = JWT.decode(token)
            val jwk = provider.get(jwt.keyId)
            val algorithm = Algorithm.RSA256(jwk.publicKey as RSAPublicKey, null)

            val verifier = JWT.require(algorithm)
                .withIssuer(issuer)
                //.withAudience(config.awsCognitoClientId) // El app client ID de Cognito
                .build()

            val decodedJWT = verifier.verify(token) // Lanza excepción si no es válido

            val tokenUse = decodedJWT.getClaim("token_use").asString()
            if (tokenUse != "access") {
                logger.warn("Token no es un access_token")
                return UnauthorizedException()
            }

            // Validación manual del client_id
            val clientIdFromToken = decodedJWT.getClaim("client_id").asString()
            if (clientIdFromToken != config.awsCognitoClientId) {
                logger.warn("ClientId inválido")
                return UnauthorizedException()
            }

            return securedExecute(business, function, headers, textBody) // Token válido
        } catch (e: Exception) {
            logger.warn("Token inválido: ${e.message}")
            return UnauthorizedException()
        }
    }

    abstract suspend fun securedExecute(business: String, function: String, headers: Map<String, String>, textBody: String): Response;
}