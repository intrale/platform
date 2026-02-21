package ar.com.intrale

import com.auth0.jwt.JWT
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

class ClientOrderDetail(
    override val config: UsersConfig,
    override val logger: Logger,
    private val repository: ClientOrderRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config, logger, jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val email = resolveEmail(headers) ?: return UnauthorizedException()
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()
        val segments = function.split("/").filter { it.isNotBlank() }
        val orderId = segments.getOrNull(2)

        return when (method) {
            HttpMethod.Get.value.uppercase() -> {
                if (orderId.isNullOrBlank()) {
                    return RequestValidationException("Order id is required")
                }
                logger.info("Consultando detalle del pedido $orderId para cliente $email en negocio $business")
                val order = repository.getOrder(business, email, orderId)
                    ?: return ExceptionResponse("Order not found", HttpStatusCode.NotFound)
                ClientOrderDetailResponse(order = order, status = HttpStatusCode.OK)
            }

            else -> RequestValidationException("Unsupported method for client order detail: $method")
        }
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
