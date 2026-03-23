package ar.com.intrale

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class ClientPaymentMethodsResponse(
    val paymentMethods: List<Map<String, Any>> = emptyList(),
    val statusCode: Map<String, Any> = mapOf("code" to 200, "description" to "OK"),
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

class ClientPaymentMethodsFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val tableBusiness: DynamoDbTable<Business>,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    private val gson = Gson()

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Listando medios de pago habilitados para negocio=$business")

        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)
        val methods = deserializeMethods(existing?.paymentMethodsJson)
            .filter { it.enabled }

        logger.debug("Retornando ${methods.size} medios de pago habilitados para negocio=$business")
        return buildResponse(methods)
    }

    private fun deserializeMethods(json: String?): List<PaymentMethodRecord> {
        if (json.isNullOrBlank()) return defaultPaymentMethods()
        return try {
            val type = object : TypeToken<List<PaymentMethodRecord>>() {}.type
            gson.fromJson<List<PaymentMethodRecord>>(json, type) ?: defaultPaymentMethods()
        } catch (e: Exception) {
            logger.error("Error deserializando medios de pago del cliente", e)
            defaultPaymentMethods()
        }
    }

    private fun defaultPaymentMethods(): List<PaymentMethodRecord> = listOf(
        PaymentMethodRecord(id = "cash", name = "Efectivo", type = "CASH", enabled = true, isCashOnDelivery = true),
        PaymentMethodRecord(id = "transfer", name = "Transferencia", type = "TRANSFER", enabled = true, isCashOnDelivery = false)
    )

    private fun buildResponse(methods: List<PaymentMethodRecord>): ClientPaymentMethodsResponse {
        val methodMaps = methods.map { m ->
            mapOf(
                "id" to m.id,
                "name" to m.name,
                "type" to m.type,
                "enabled" to m.enabled,
                "isCashOnDelivery" to m.isCashOnDelivery,
                "description" to (m.description ?: "")
            )
        }
        return ClientPaymentMethodsResponse(paymentMethods = methodMaps)
    }
}
