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

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

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
                logger.info("Creando pedido del cliente $email en negocio $business")
                createOrder(business, email, textBody)
            }

            else -> RequestValidationException("Unsupported method for client orders: $method")
        }
    }

    private fun createOrder(business: String, email: String, textBody: String): Response {
        val request = runCatching {
            json.decodeFromString(
                ar.com.intrale.shared.client.CreateOrderRequestDTO.serializer(),
                textBody
            )
        }.getOrElse {
            logger.error("Error al parsear request de creación de pedido: ${it.message}")
            return RequestValidationException("Invalid request body: ${it.message}")
        }

        if (request.items.isEmpty()) {
            return RequestValidationException("El pedido debe contener al menos un producto")
        }

        val total = request.items.sumOf { it.subtotal }
        val payload = ClientOrderPayload(
            publicId = "",
            businessName = business,
            status = "PENDING",
            items = request.items.map { item ->
                ClientOrderItemPayload(
                    id = item.id,
                    productId = item.productId,
                    productName = item.productName,
                    name = item.name.ifBlank { item.productName },
                    quantity = item.quantity,
                    unitPrice = item.unitPrice,
                    subtotal = item.subtotal
                )
            },
            total = total,
            notes = request.notes,
            itemCount = request.items.sumOf { it.quantity }
        )

        val created = repository.createOrder(business, email, payload)
        logger.info("Pedido creado: ${created.id} (shortCode=${created.shortCode})")

        return ClientOrderDetailResponse(
            order = created,
            status = HttpStatusCode.Created
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
