package ar.com.intrale

import net.datafaker.Faker
import org.slf4j.Logger

class Validate(override val config: UsersConfig, override val logger: Logger, override val jwtValidator: JwtValidator = CognitoJwtValidator(config)) :
    SecuredFunction(config=config, logger=logger, jwtValidator=jwtValidator) {


    override suspend fun securedExecute(business: String, function: String, headers: Map<String, String>, textBody: String): Response {
            return Response() // Token válido
    }
}