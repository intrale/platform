package ar.com.intrale

import com.auth0.jwt.JWT
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import org.slf4j.LoggerFactory

/**
 * Endpoint de recomendaciones de productos personalizadas.
 *
 * Ruta: GET /{business}/products/recommendations
 * Headers: Authorization (JWT), X-Query-limit (opcional)
 *
 * Devuelve productos recomendados basados en el historial de compras del usuario.
 * Para usuarios sin historial, devuelve los productos mas vendidos del negocio.
 */
class ProductRecommendations(
    override val config: UsersConfig,
    override val logger: Logger,
    private val recommendationRepository: ProductRecommendationRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    companion object {
        const val DEFAULT_LIMIT = 8
        const val MAX_LIMIT = 20
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

        val email = resolveEmail(headers) ?: return UnauthorizedException()

        val limit = headers["X-Query-limit"]?.toIntOrNull()?.coerceIn(1, MAX_LIMIT) ?: DEFAULT_LIMIT

        logger.debug("Calculando recomendaciones para usuario=$email negocio=$business limit=$limit")

        val recommendations = recommendationRepository.getRecommendations(business, email, limit)

        val payloads = recommendations.mapIndexed { index, product ->
            val score = 1.0 - (index.toDouble() / recommendations.size.coerceAtLeast(1))
            product.toRecommendationPayload(score = score)
        }

        // Determinar fuente: si el usuario tiene historial, es co-occurrence; sino, top-selling
        val source = if (recommendationRepository.hasUserHistory(business, email)) "co-occurrence" else "top-selling"

        logger.debug("Recomendaciones generadas: ${payloads.size} productos, source=$source")

        return ProductRecommendationResponse(
            recommendations = payloads,
            source = source,
            status = HttpStatusCode.OK
        )
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
