package ar.com.intrale

import com.auth0.jwt.JWT
import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

/**
 * Endpoint de historial de búsquedas de productos del cliente.
 * Ruta: /{business}/products/search-history
 *
 * GET — devuelve las últimas búsquedas del usuario
 * POST — agrega una búsqueda al historial
 * DELETE — limpia todo el historial del usuario
 */
class ProductSearchHistory(
    override val config: UsersConfig,
    override val logger: Logger,
    private val searchHistoryRepository: SearchHistoryRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    private val gson = Gson()

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val email = resolveEmail(headers) ?: return UnauthorizedException()
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()

        return when (method) {
            HttpMethod.Get.value.uppercase() -> handleGet(email, business)
            HttpMethod.Post.value.uppercase() -> handlePost(email, business, textBody)
            HttpMethod.Delete.value.uppercase() -> handleDelete(email, business)
            else -> RequestValidationException("Metodo no soportado: $method")
        }
    }

    /**
     * GET — Devuelve el historial de búsquedas recientes del usuario.
     */
    private fun handleGet(email: String, business: String): Response {
        logger.debug("Obteniendo historial de busquedas para usuario=$email negocio=$business")
        val history = searchHistoryRepository.getHistory(email, business)
        return SearchHistoryResponse(history = history, status = HttpStatusCode.OK)
    }

    /**
     * POST — Agrega una búsqueda al historial.
     * Body: { "query": "texto buscado" }
     */
    private fun handlePost(email: String, business: String, textBody: String): Response {
        val body = parseBody<AddSearchHistoryRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (body.query.isBlank()) {
            return RequestValidationException("La query no puede estar vacia")
        }

        logger.debug("Agregando busqueda='${body.query}' al historial de usuario=$email negocio=$business")
        val updatedHistory = searchHistoryRepository.addSearch(email, business, body.query)
        return SearchHistoryResponse(history = updatedHistory, status = HttpStatusCode.OK)
    }

    /**
     * DELETE — Elimina todo el historial de búsquedas del usuario.
     */
    private fun handleDelete(email: String, business: String): Response {
        logger.debug("Limpiando historial de busquedas para usuario=$email negocio=$business")
        searchHistoryRepository.clearHistory(email, business)
        return NoContentResponse()
    }

    private fun resolveEmail(headers: Map<String, String>): String? {
        val token = headers["Authorization"] ?: headers["authorization"]
        val decoded = token
            ?.removePrefix("Bearer ")
            ?.takeIf { it.isNotBlank() }
            ?.let { runCatching { JWT.decode(it) }.getOrNull() }

        return decoded?.getClaim("email")?.asString()
            ?: decoded?.subject
            ?: headers["X-Debug-User"]
    }
}
