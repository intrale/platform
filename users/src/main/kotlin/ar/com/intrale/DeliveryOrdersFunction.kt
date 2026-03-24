package ar.com.intrale

import com.auth0.jwt.JWT
import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

class DeliveryOrdersFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val repository: DeliveryOrderRepository,
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
        val functionPath = headers["X-Function-Path"] ?: function
        val segments = functionPath.split("/").filter { it.isNotBlank() }
        // segments: ["delivery", "orders", ...subPath]
        val subPath = segments.getOrNull(2)

        return when (method) {
            HttpMethod.Get.value.uppercase() -> handleGet(business, email, subPath, segments)
            HttpMethod.Put.value.uppercase() -> handlePut(business, email, subPath, segments, textBody)
            else -> RequestValidationException("Unsupported method for delivery orders: $method")
        }
    }

    private fun handleGet(
        business: String,
        email: String,
        subPath: String?,
        segments: List<String>
    ): Response {
        return when (subPath) {
            "summary" -> {
                logger.info("Consultando resumen de pedidos para repartidor $email en negocio $business")
                repository.summary(business, email)
            }

            "active" -> {
                logger.info("Consultando pedidos activos del repartidor $email en negocio $business")
                val orders = repository.listActive(business, email)
                DeliveryOrderListResponse(orders = orders, status = HttpStatusCode.OK)
            }

            "available" -> {
                logger.info("Consultando pedidos disponibles en negocio $business")
                val orders = repository.listAvailable(business)
                DeliveryOrderListResponse(orders = orders, status = HttpStatusCode.OK)
            }

            else -> {
                // GET delivery/orders/{id}
                val orderId = subPath
                if (orderId.isNullOrBlank()) {
                    return RequestValidationException("Order id or sub-path is required")
                }
                logger.info("Consultando detalle del pedido $orderId para repartidor $email en negocio $business")
                val order = repository.getOrder(business, orderId)
                    ?: return ExceptionResponse("Order not found", HttpStatusCode.NotFound)
                DeliveryOrderDetailResponse(
                    id = order.id,
                    publicId = order.publicId,
                    shortCode = order.shortCode,
                    businessName = order.businessName,
                    neighborhood = order.neighborhood,
                    status = order.status,
                    promisedAt = order.promisedAt,
                    eta = order.eta,
                    distance = order.distance,
                    address = order.address,
                    addressNotes = order.addressNotes,
                    items = order.items,
                    notes = order.notes,
                    customerName = order.customerName,
                    customerPhone = order.customerPhone,
                    paymentMethod = order.paymentMethod,
                    collectOnDelivery = order.collectOnDelivery,
                    createdAt = order.createdAt,
                    updatedAt = order.updatedAt,
                    statusHistory = order.statusHistory ?: emptyList(),
                    responseStatus = HttpStatusCode.OK
                )
            }
        }
    }

    private fun handlePut(
        business: String,
        email: String,
        subPath: String?,
        segments: List<String>,
        textBody: String
    ): Response {
        // PUT delivery/orders/{id}/status or delivery/orders/{id}/state
        val orderId = subPath
        val action = segments.getOrNull(3)

        if (orderId.isNullOrBlank()) {
            return RequestValidationException("Order id is required")
        }

        return when (action) {
            "status" -> {
                logger.info("Actualizando status del pedido $orderId por repartidor $email en negocio $business")
                val request = runCatching {
                    Gson().fromJson(textBody, DeliveryOrderStatusUpdateRequest::class.java)
                }.getOrNull() ?: return RequestValidationException("Invalid status update payload")

                val updated = try {
                    repository.updateStatus(business, orderId, request.status, request.reason)
                        ?: return ExceptionResponse("Order not found", HttpStatusCode.NotFound)
                } catch (e: InvalidStateTransitionException) {
                    logger.warn("Transicion invalida para pedido $orderId: ${e.message}")
                    return ExceptionResponse(e.message ?: "Transicion de estado no permitida", HttpStatusCode.Conflict)
                }

                DeliveryOrderStatusUpdateResponse(
                    orderId = updated.id,
                    status = updated.status,
                    message = "Status actualizado correctamente",
                    responseStatus = HttpStatusCode.OK
                )
            }

            "state" -> {
                logger.info("Cambiando estado de entrega del pedido $orderId por repartidor $email en negocio $business")
                val request = runCatching {
                    Gson().fromJson(textBody, DeliveryStateChangeRequest::class.java)
                }.getOrNull() ?: return RequestValidationException("Invalid state change payload")

                val updated = try {
                    repository.updateState(business, orderId, request.state)
                        ?: return ExceptionResponse("Order not found", HttpStatusCode.NotFound)
                } catch (e: InvalidStateTransitionException) {
                    logger.warn("Transicion invalida para pedido $orderId: ${e.message}")
                    return ExceptionResponse(e.message ?: "Transicion de estado no permitida", HttpStatusCode.Conflict)
                }

                DeliveryStateChangeResponse(
                    orderId = updated.id,
                    state = updated.status,
                    message = "Estado de entrega actualizado correctamente",
                    responseStatus = HttpStatusCode.OK
                )
            }

            else -> RequestValidationException("Unsupported sub-path for delivery orders PUT: $action")
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
