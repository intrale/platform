package ar.com.intrale

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

class BusinessOrdersFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val repository: ClientOrderRepository,
    private val deliveryProfileRepository: DeliveryProfileRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config, logger, jwtValidator) {

    private val gson = Gson()

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

            else -> RequestValidationException("Unsupported method for business orders: " + method + " (" + subPath + ")")
        }
    }
}
