package ar.com.intrale

import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

class ClientProducts(
    override val config: UsersConfig,
    override val logger: Logger,
    private val productRepository: ProductRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()

        if (method != HttpMethod.Get.value.uppercase()) {
            return RequestValidationException("Metodo no soportado: $method")
        }

        logger.debug("Consultando productos publicados para negocio=$business")
        val products = productRepository.listPublishedProducts(business)
        logger.debug("Productos publicados encontrados: ${products.size} en negocio=$business")
        return ClientProductListResponse(
            products = products.map { it.toClientPayload() },
            status = HttpStatusCode.OK
        )
    }
}
