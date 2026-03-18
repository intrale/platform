package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import java.security.MessageDigest

class ClientProducts(
    override val config: UsersConfig,
    override val logger: Logger,
    private val productRepository: ProductRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    private val gson = Gson()

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

        val payloads = products.map { it.toClientPayload() }
        val etag = computeETag(payloads)

        val ifNoneMatch = headers["If-None-Match"]
        if (ifNoneMatch != null && ifNoneMatch == etag) {
            logger.debug("ETag coincide ($etag), retornando 304 Not Modified para negocio=$business")
            return NotModifiedResponse(headers = mapOf("ETag" to etag))
        }

        return ClientProductListResponse(
            products = payloads,
            status = HttpStatusCode.OK,
            headers = mapOf("ETag" to etag)
        )
    }

    internal fun computeETag(products: List<ClientProductPayload>): String {
        val json = gson.toJson(products)
        val digest = MessageDigest.getInstance("MD5")
        val hash = digest.digest(json.toByteArray(Charsets.UTF_8))
        return "\"${hash.joinToString("") { "%02x".format(it) }}\""
    }
}
