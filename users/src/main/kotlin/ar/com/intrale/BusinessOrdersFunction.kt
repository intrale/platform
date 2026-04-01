package ar.com.intrale


import ar.com.intrale.shared.business.BusinessOrderDetailDTO
import ar.com.intrale.shared.business.BusinessOrderItemDTO
import ar.com.intrale.shared.business.BusinessOrderStatusUpdateRequestDTO
import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

data class BusinessOrderItem(
    val clientEmail: String,
    val order: ClientOrderPayload
)

data class BusinessOrderListResponse(
    val orders: List<BusinessOrderPayload> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class BusinessOrderAssignResponse(
    val orderId: String = "",
    val deliveryPersonEmail: String? = null,
    val message: String? = null,
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class DeliveryPersonListResponse(
    val deliveryPeople: List<DeliveryPersonSummaryPayload> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class DeliveryPersonSummaryPayload(
    val email: String = "",
    val fullName: String = ""
)

data class AssignOrderRequest(
    val orderId: String = "",
    val deliveryPersonEmail: String? = null
)
data class BusinessOrderDetailResponse(
    val order: BusinessOrderDetailDTO? = null,
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class BusinessOrderStatusUpdateResponse(
    val orderId: String = "",
    val newStatus: String = "",
    val updatedAt: String = "",
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
class BusinessOrdersFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val repository: ClientOrderRepository,
    private val deliveryProfileRepository: DeliveryProfileRepository,
    private val productRepository: ProductRepository = ProductRepository(),
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config, logger, jwtValidator) {

    private val gson = Gson()
    companion object {
        private val VALID_TRANSITIONS: Map<String, List<String>> = mapOf(
            "PENDING" to listOf("PREPARING", "CANCELLED"),
            "PREPARING" to listOf("DELIVERING", "CANCELLED"),
            "DELIVERING" to listOf("DELIVERED")
        )
    }

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()
        val subPath = function.removePrefix("business/orders").trimStart('/')

        return when {
            method == HttpMethod.Get.value.uppercase() && subPath == "delivery-people" -> {
                logger.info("Listando repartidores del negocio {}", business)
                val records = deliveryProfileRepository.listByBusiness(business)
                val summaries = records.map { record ->
                    DeliveryPersonSummaryPayload(
                        email = record.profile.email,
                        fullName = record.profile.fullName
                    )
                }
                DeliveryPersonListResponse(deliveryPeople = summaries)
            }

            method == HttpMethod.Get.value.uppercase() -> {
                logger.info("Listando pedidos del negocio {}", business)
                val items = repository.listAllOrdersForBusiness(business)
                val payloads = items.map { item ->
                    BusinessOrderPayload(
                        id = item.order.id ?: "",
                        shortCode = item.order.shortCode,
                        clientEmail = item.clientEmail,
                        status = item.order.status.uppercase(),
                        total = item.order.total,
                        assignedDeliveryPersonEmail = item.order.assignedDeliveryPersonEmail,
                        createdAt = item.order.createdAt,
                        updatedAt = item.order.updatedAt
                    )
                }
                BusinessOrderListResponse(orders = payloads)
            }

            method == HttpMethod.Put.value.uppercase() && subPath == "assign" -> {
                logger.info("Asignando repartidor a pedido del negocio {}", business)
                val request = try {
                    gson.fromJson(textBody, AssignOrderRequest::class.java)
                } catch (e: Exception) {
                    return RequestValidationException("Body invalido para asignacion de repartidor")
                }

                if (request.orderId.isBlank()) {
                    return RequestValidationException("orderId es requerido")
                }

                val updated = repository.assignDeliveryPerson(
                    business = business,
                    orderId = request.orderId,
                    deliveryPersonEmail = request.deliveryPersonEmail
                ) ?: return RequestValidationException("Pedido no encontrado: " + request.orderId)

                BusinessOrderAssignResponse(
                    orderId = updated.id ?: "",
                    deliveryPersonEmail = updated.assignedDeliveryPersonEmail,
                    message = if (request.deliveryPersonEmail != null) "Repartidor asignado" else "Repartidor desasignado"
                )
            }

            method == HttpMethod.Get.value.uppercase() && subPath.isNotBlank() -> {
                logger.info("Consultando detalle del pedido $subPath en negocio $business")
                val item = repository.getBusinessOrder(business, subPath)
                    ?: return ExceptionResponse("Order not found", HttpStatusCode.NotFound)

                val detail = BusinessOrderDetailDTO(
                    id = item.order.id ?: "",
                    shortCode = item.order.shortCode,
                    clientEmail = item.clientEmail,
                    status = item.order.status.uppercase(),
                    total = item.order.total,
                    items = item.order.items.map { i ->
                        BusinessOrderItemDTO(
                            id = i.id,
                            name = i.name.ifBlank { i.productName },
                            quantity = i.quantity,
                            unitPrice = i.unitPrice,
                            subtotal = i.subtotal
                        )
                    },
                    deliveryAddress = item.order.deliveryAddress?.let {
                        it.street + " " + it.number + ", " + it.city
                    },
                    deliveryCity = item.order.deliveryAddress?.city,
                    deliveryReference = item.order.deliveryAddress?.reference,
                    createdAt = item.order.createdAt,
                    updatedAt = item.order.updatedAt
                )
                BusinessOrderDetailResponse(order = detail)
            }

            method == HttpMethod.Put.value.uppercase() && subPath == "status" -> {
                val request = try {
                    Gson().fromJson(textBody, BusinessOrderStatusUpdateRequestDTO::class.java)
                } catch (e: Exception) {
                    logger.error("Error al parsear request de actualizacion de estado: ${e.message}")
                    return RequestValidationException("Invalid request body")
                }

                if (request.orderId.isBlank() || request.newStatus.isBlank()) {
                    return RequestValidationException("orderId and newStatus are required")
                }

                val currentItem = repository.getBusinessOrder(business, request.orderId)
                    ?: return ExceptionResponse("Order not found", HttpStatusCode.NotFound)

                val currentStatus = currentItem.order.status.uppercase()
                val allowedTransitions = VALID_TRANSITIONS[currentStatus] ?: emptyList()

                if (request.newStatus.uppercase() !in allowedTransitions) {
                    logger.info("Transicion de estado invalida: $currentStatus -> ${request.newStatus}")
                    return RequestValidationException(
                        "Invalid status transition from $currentStatus to ${request.newStatus}. Allowed: ${allowedTransitions.joinToString(", ")}"
                    )
                }

                if (request.newStatus.uppercase() == "CANCELLED" && request.reason.isNullOrBlank()) {
                    return RequestValidationException("A reason is required when cancelling an order")
                }

                logger.info("Actualizando estado del pedido ${request.orderId} de $currentStatus a ${request.newStatus}")
                val updated = repository.updateOrderStatus(business, request.orderId, request.newStatus.uppercase(), request.reason)
                    ?: return ExceptionResponse("Failed to update order status", HttpStatusCode.InternalServerError)

                // Descontar stock automaticamente al pasar a PREPARING
                if (request.newStatus.uppercase() == "PREPARING") {
                    deductStockForOrder(business, currentItem.order)
                }

                BusinessOrderStatusUpdateResponse(
                    orderId = request.orderId,
                    newStatus = updated.order.status.uppercase(),
                    updatedAt = updated.order.updatedAt ?: ""
                )
            }

            else -> RequestValidationException("Unsupported method for business orders: " + method + " (" + subPath + ")")
        }
    }

    /**
     * Descuenta stock automaticamente para todos los items de un pedido.
     * Loguea alertas de stock bajo pero no bloquea la operacion.
     */
    private fun deductStockForOrder(business: String, order: ClientOrderPayload) {
        val items = order.items.mapNotNull { item ->
            if (item.productId.isBlank()) return@mapNotNull null
            StockDeductionItem(productId = item.productId, quantity = item.quantity)
        }

        if (items.isEmpty()) {
            logger.debug("Pedido ${order.id} sin items con productId para descontar stock")
            return
        }

        val result = productRepository.deductStockBatch(business, items)

        if (result.lowStockAlerts.isNotEmpty()) {
            logger.warn(
                "Alerta de stock bajo tras pedido ${order.id}: {}",
                result.lowStockAlerts.joinToString { "${it.name} (stock: ${it.stockQuantity}/${it.minStock})" }
            )
        }

        if (result.errors.isNotEmpty()) {
            logger.warn("Errores al descontar stock del pedido ${order.id}: {}", result.errors)
        }

        logger.info("Stock descontado para pedido ${order.id}: ${result.updatedProducts.size} productos actualizados")
    }
}
