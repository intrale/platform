package ar.com.intrale

import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

/**
 * Endpoint de sugerencias de búsqueda de productos.
 * Ruta: /{business}/products/suggestions?q=texto&limit=10
 *
 * Requiere autenticación (SecuredFunction).
 * Retorna productos publicados y disponibles que coincidan con la query.
 * Mínimo 2 caracteres para buscar.
 */
class ProductSuggestions(
    override val config: UsersConfig,
    override val logger: Logger,
    private val productRepository: ProductRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    /**
     * Sanitiza valores para logging, eliminando caracteres de control
     * que podrían usarse para log injection (CWE-117).
     */
    private fun sanitizeForLog(value: String): String = value.replace(Regex("[\\r\\n\\t]"), " ")

    companion object {
        const val MIN_QUERY_LENGTH = 2
        const val DEFAULT_SUGGESTION_LIMIT = 10
        const val MAX_SUGGESTION_LIMIT = 20
    }

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

        val query = headers["X-Query-q"]?.trim() ?: ""
        val limit = headers["X-Query-limit"]?.toIntOrNull()
            ?.coerceIn(1, MAX_SUGGESTION_LIMIT)
            ?: DEFAULT_SUGGESTION_LIMIT

        if (query.length < MIN_QUERY_LENGTH) {
            return RequestValidationException(
                "La query debe tener al menos $MIN_QUERY_LENGTH caracteres"
            )
        }

        logger.debug("Buscando sugerencias de productos para query='${sanitizeForLog(query)}' limit=$limit negocio=${sanitizeForLog(business)}")

        val queryLower = query.lowercase()

        // Buscar productos publicados Y disponibles que coincidan
        val suggestions = productRepository.listPublishedProducts(business)
            .filter { it.isAvailable && (it.stockQuantity == null || it.stockQuantity > 0) }
            .filter { it.name.lowercase().contains(queryLower) }
            .sortedWith(
                // Priorizar: 1) coincidencia al inicio, 2) alfabético
                compareByDescending<ProductRecord> { it.name.lowercase().startsWith(queryLower) }
                    .thenBy { it.name.lowercase() }
            )
            .take(limit)
            .map { it.toSuggestionPayload() }

        logger.debug("Sugerencias encontradas: ${suggestions.size} para query='${sanitizeForLog(query)}' en negocio=${sanitizeForLog(business)}")

        return ProductSuggestionsResponse(
            suggestions = suggestions,
            query = query,
            total = suggestions.size,
            status = HttpStatusCode.OK
        )
    }
}
