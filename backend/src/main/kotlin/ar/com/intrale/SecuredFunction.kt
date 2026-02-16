package ar.com.intrale

import org.slf4j.Logger

/**
 * Funcion segurizada
 * Previo a la ejecucion valida si el usuario tiene un token valido para ejecutar
 */
abstract class SecuredFunction(
    open val config: Config,
    open val logger: Logger,
    open val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : Function {

    override suspend fun execute(business: String, function: String, headers: Map<String, String>, textBody: String): Response {
        val token = headers["Authorization"]

        try {
            jwtValidator.validate(token ?: throw IllegalArgumentException("Token faltante"))
            return securedExecute(business, function, headers, textBody)
        } catch (e: Exception) {
            logger.warn("Token invalido: ${e.message}")
            return UnauthorizedException()
        }
    }

    abstract suspend fun securedExecute(business: String, function: String, headers: Map<String, String>, textBody: String): Response;
}
