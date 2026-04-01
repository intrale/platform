package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Request de busqueda conversacional de productos.
 */
data class ConversationalSearchRequest(
    val query: String = ""
)

/**
 * Respuesta con sugerencias de productos encontradas por IA.
 */
class ConversationalSearchResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val suggestions: List<ProductSuggestion> = emptyList(),
    val message: String = "",
    val hasResults: Boolean = true,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Endpoint publico (no requiere autenticacion) para busqueda conversacional
 * de productos. El cliente escribe en lenguaje natural lo que necesita
 * y el agente IA devuelve productos relevantes del catalogo.
 *
 * Ruta: POST /{business}/conversational-search
 */
class ConversationalSearchFunction(
    private val logger: Logger,
    private val tableBusiness: DynamoDbTable<Business>,
    private val productRepository: ProductRepository,
    private val searchService: ConversationalSearchService
) : Function {

    private val gson = Gson()

    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando busqueda conversacional para negocio=$business")

        // Verificar que el negocio existe
        val key = Business().apply { name = business }
        val businessEntity = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        // Parsear request
        val request = parseBody<ConversationalSearchRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (request.query.isBlank()) {
            return RequestValidationException("La consulta no puede estar vacia")
        }

        if (request.query.length > 500) {
            return RequestValidationException("La consulta no puede superar los 500 caracteres")
        }

        // Obtener productos publicados del negocio
        val products = productRepository.listPublishedProducts(business)

        if (products.isEmpty()) {
            logger.debug("Negocio=$business sin productos publicados")
            return ConversationalSearchResponse(
                suggestions = emptyList(),
                message = "Este negocio aun no tiene productos publicados.",
                hasResults = false
            )
        }

        // Ejecutar busqueda conversacional con IA
        return try {
            val result = searchService.search(
                query = request.query,
                products = products,
                businessName = business
            )

            logger.debug("Busqueda conversacional para negocio=$business: ${result.suggestions.size} sugerencias (confidence=${result.confidence})")

            ConversationalSearchResponse(
                suggestions = result.suggestions,
                message = result.message,
                hasResults = result.hasResults
            )
        } catch (e: Exception) {
            logger.error("Error en busqueda conversacional para negocio=$business", e)
            ConversationalSearchResponse(
                suggestions = emptyList(),
                message = "No pudimos procesar tu busqueda en este momento. Intenta de nuevo.",
                hasResults = false
            )
        }
    }
}
