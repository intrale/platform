package ar.com.intrale

import com.auth0.jwt.JWT
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.serialization.json.Json
import org.slf4j.Logger

class ClientOrders(
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

        return when (method) {
            HttpMethod.Get.value.uppercase() -> {
                logger.info("Listando pedidos del cliente $email en negocio $business")
                val orders = repository.listOrders(business, email)
                ClientOrderListResponse(orders = orders, status = HttpStatusCode.OK)
            }

            HttpMethod.Post.value.uppercase() -> {
                logger.info("Creando pedido para cliente $email en negocio $business")
                if (textBody.isBlank()) {
                    return RequestValidationException("El cuerpo del request no puede estar vacío")
                }
                val request = runCatching {
                    Json { ignoreUnknownKeys = true }.decodeFromString(
                        CreateClientOrderRequest.serializer(), textBody
                    )
                }.getOrElse {
                    return RequestValidationException("Request inválido: ${it.message}")
                }
                if (request.items.isEmpty()) {
                    return RequestValidationException("El pedido debe tener al menos un producto")
                }
                val payload = ClientOrderPayload(
                    publicId = "PED-${System.currentTimeMillis() % 100000}",
                    status = "PENDING",
                    items = request.items.map { item ->
                        ClientOrderItemPayload(
                            productId = item.productId,
                            productName = item.productName,
                            name = item.productName,
                            quantity = item.quantity,
                            unitPrice = item.unitPrice,
                            subtotal = item.quantity * item.unitPrice
                        )
                    },
                    total = request.items.sumOf { it.quantity * it.unitPrice },
                    deliveryAddress = ClientAddressPayload(
                        id = request.shippingAddressId,
                        label = "",
                        street = "",
                        number = "",
                        city = ""
                    ),
                    notes = null
                )
                val created = repository.createOrder(business, email, payload)
                logger.info("Pedido creado: ${created.id} para $email")
                ClientOrderDetailResponse(order = created, status = HttpStatusCode.Created)
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
