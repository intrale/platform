package ar.com.intrale

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Endpoint público para que la app cliente lea los medios de pago habilitados.
 * Retorna sólo los métodos con enabled=true.
 */
class ClientPaymentMethods(
    private val tableBusiness: DynamoDbTable<Business>,
    private val logger: Logger
) : Function {

    private val gson = Gson()

    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Listando medios de pago habilitados para negocio=$business")

        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)

        val allMethods: List<PaymentMethodRecord> = existing?.paymentMethodsJson
            ?.let { json ->
                runCatching {
                    val type = object : TypeToken<List<PaymentMethodRecord>>() {}.type
                    gson.fromJson<List<PaymentMethodRecord>>(json, type)
                }.getOrNull()
            }
            ?: DEFAULT_PAYMENT_METHODS

        val enabledMethods = allMethods.filter { it.enabled }
        logger.debug("Retornando ${enabledMethods.size} medios de pago habilitados para negocio=$business")
        return ClientPaymentMethodsResponse(paymentMethods = enabledMethods)
    }
}
