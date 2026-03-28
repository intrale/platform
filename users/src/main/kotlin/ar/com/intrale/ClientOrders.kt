package ar.com.intrale

import com.auth0.jwt.JWT
import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

class ClientOrders(
    override val config: UsersConfig,
    override val logger: Logger,
    private val repository: ClientOrderRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config, logger, jwtValidator) {

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
            HttpMethod.Get.value.uppercase() -> {
                logger.info("Listando pedidos del cliente $email en negocio $business")
                val orders = repository.listOrders(business, email)
                ClientOrderListResponse(orders = orders, status = HttpStatusCode.OK)
            }

            HttpMethod.Post.value.uppercase() -> {
                logger.info("Creando pedido para cliente $email en negocio $business")
                val request = runCatching {
                    gson.fromJson(textBody, CreateClientOrderRequest::class.java)
                }.getOrElse {
                    return RequestValidationException("Invalid request body: ${it.message}")
                }
                if (request.items.isEmpty()) {
                    return RequestValidationException("Order must contain at least one item")
                }
                val items = request.items.map { item ->
                    ClientOrderItemPayload(
                        productId = item.productId,
                        productName = item.productName,
                        name = item.productName,
                        quantity = item.quantity,
                        unitPrice = item.unitPrice,
                        subtotal = item.unitPrice * item.quantity
                    )
                }
                val total = items.sumOf { it.subtotal }
                val payload = ClientOrderPayload(
                    status = "PENDING",
                    items = items,
                    total = total,
                    notes = request.notes,
                    businessName = business
                )
                val created = repository.createOrder(business, email, payload)
                CreateClientOrderResponse(
                    orderId = created.id.orEmpty(),
                    shortCode = created.shortCode.orEmpty(),
                    status = HttpStatusCode.Created
                )
            }

            else -> RequestValidationException("Unsupported method for client orders: $method")
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
