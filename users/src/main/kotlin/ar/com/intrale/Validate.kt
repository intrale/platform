package ar.com.intrale

import net.datafaker.Faker
import org.slf4j.Logger

class Validate(override val config: UsersConfig, override val logger: Logger) :
    SecuredFunction(config=config, logger=logger ) {


    override suspend fun securedExecute(business: String, function: String, headers: Map<String, String>, textBody: String): Response {
            return Response() // Token válido
    }
}