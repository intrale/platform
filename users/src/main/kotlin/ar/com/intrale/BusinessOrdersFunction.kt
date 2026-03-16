package ar.com.intrale

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

class BusinessOrdersFunction(
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
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()

        return when (method) {
            HttpMethod.Get.value.uppercase() -> {
                logger.info("Listando pedidos del negocio $business")
                val items = repository.listAllOrdersForBusiness(business)
                val payloads = items.map { item ->
                    BusinessOrderPayload(
                        id = item.order.id ?: "",
                        shortCode = item.order.shortCode,
                        clientEmail = item.clientEmail,
                        status = item.order.status.uppercase(),
                        total = item.order.total,
                        createdAt = item.order.createdAt,
                        updatedAt = item.order.updatedAt
                    )
                }
                BusinessOrderListResponse(orders = payloads)
            }

            else -> RequestValidationException("Unsupported method for business orders: $method")
        }
    }
}
