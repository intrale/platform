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

    companion object {
        const val DEFAULT_OFFSET = 0
        const val DEFAULT_LIMIT = 20
        const val MAX_LIMIT = 100
    }

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

        val offset = headers["X-Query-offset"]?.toIntOrNull()?.coerceAtLeast(0) ?: DEFAULT_OFFSET
        val limit = headers["X-Query-limit"]?.toIntOrNull()?.coerceIn(1, MAX_LIMIT) ?: DEFAULT_LIMIT
        val category = headers["X-Query-category"]
        val search = headers["X-Query-search"]

        logger.debug("Consultando productos publicados para negocio=$business offset=$offset limit=$limit category=$category search=$search")

        val result = productRepository.listPublishedProductsPaginated(
            business = business,
            offset = offset,
            limit = limit,
            category = category,
            search = search
        )

        logger.debug("Productos publicados encontrados: ${result.total} en negocio=$business (pagina: ${result.items.size} items)")

        val payloads = result.items.map { it.toClientPayload() }
        val etag = computeETag(payloads)

        val ifNoneMatch = headers["If-None-Match"]
        if (ifNoneMatch != null && ifNoneMatch == etag) {
            logger.debug("ETag coincide ($etag), retornando 304 Not Modified para negocio=$business")
            return NotModifiedResponse(headers = mapOf("ETag" to etag))
        }

        return ClientProductListResponse(
            products = payloads,
            pagination = PaginationMetadata(
                total = result.total,
                offset = result.offset,
                limit = result.limit,
                hasMore = result.hasMore
            ),
            status = HttpStatusCode.OK,
            headers = mapOf("ETag" to etag)
        )
    }

    internal fun computeETag(products: List<ClientProductPayload>): String {
        val json = gson.toJson(products)
        val digest = MessageDigest.getInstance("MD5")
        val hash = digest.digest(json.toByteArray(Charsets.UTF_8))
        return "\"" + hash.joinToString("") { "%02x".format(it) } + "\""
    }
}
