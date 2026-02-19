package ar.com.intrale

import com.auth0.jwt.JWT
import com.auth0.jwt.interfaces.DecodedJWT
import org.slf4j.LoggerFactory

/**
 * JwtValidator para entorno local (Moto/Docker).
 * Decodifica el JWT sin verificar firma criptográfica — Moto firma con
 * su propia clave RSA que no se puede obtener vía JWKS estándar.
 * SOLO debe usarse cuando LOCAL_MODE=true.
 */
class LocalJwtValidator(private val config: UsersConfig) : JwtValidator {

    private val logger = LoggerFactory.getLogger("ar.com.intrale")

    override fun validate(token: String): DecodedJWT {
        logger.warn("JWT validado en modo LOCAL — sin verificación criptográfica")

        val decoded: DecodedJWT = JWT.decode(token)

        val tokenUse = decoded.getClaim("token_use").asString()
        if (tokenUse != "access") {
            throw IllegalArgumentException("Token no es un access_token")
        }

        val clientIdFromToken = decoded.getClaim("client_id").asString()
        if (clientIdFromToken != config.awsCognitoClientId) {
            throw IllegalArgumentException("ClientId invalido")
        }

        return decoded
    }
}
