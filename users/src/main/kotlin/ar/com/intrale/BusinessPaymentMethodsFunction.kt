package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

data class PaymentMethodRecord(
    val id: String = "",
    val name: String = "",
    val type: String = "",
    val description: String? = null,
    val isCashOnDelivery: Boolean = false,
    val enabled: Boolean = false,
    val integrationData: Map<String, String?> = emptyMap()
)

data class UpdatePaymentMethodsRequest(
    val paymentMethods: List<PaymentMethodRecord> = emptyList()
)

class BusinessPaymentMethodsResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val paymentMethods: List<Map<String, Any?>> = emptyList(),
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

class BusinessPaymentMethodsFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableBusiness: DynamoDbTable<Business>,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    private val gson = Gson()

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando business/payment-methods para negocio=$business")

        requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: return UnauthorizedException()

        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()

        return when (method) {
            HttpMethod.Get.value.uppercase() -> handleGet(business)
            HttpMethod.Put.value.uppercase() -> handlePut(business, textBody)
            else -> RequestValidationException("Metodo no soportado: $method")
        }
    }

    private fun handleGet(business: String): Response {
        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)
        val methods = deserializePaymentMethods(existing?.paymentMethodsJson)
        logger.debug("Retornando ${methods.size} medios de pago para negocio=$business")
        return buildResponse(methods)
    }

    private val validPaymentTypes = setOf("CASH", "TRANSFER", "MERCADOPAGO", "DIGITAL_WALLET")

    private fun handlePut(business: String, textBody: String): Response {
        val body = parseBody<UpdatePaymentMethodsRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (body.paymentMethods.isEmpty()) {
            return RequestValidationException("Debe indicar al menos un medio de pago")
        }

        val invalidTypes = body.paymentMethods.map { it.type.uppercase() }.filter { it !in validPaymentTypes }
        if (invalidTypes.isNotEmpty()) {
            return RequestValidationException("Tipo de medio de pago no válido: ${invalidTypes.joinToString()}")
        }

        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado")

        existing.paymentMethodsJson = gson.toJson(body.paymentMethods)
        tableBusiness.updateItem(existing)

        logger.debug("Medios de pago actualizados para negocio=$business")
        return buildResponse(body.paymentMethods, HttpStatusCode.OK)
    }

    private fun deserializePaymentMethods(json: String?): List<PaymentMethodRecord> {
        if (json.isNullOrBlank()) return defaultPaymentMethods()
        return try {
            val type = object : TypeToken<List<PaymentMethodRecord>>() {}.type
            gson.fromJson(json, type) ?: defaultPaymentMethods()
        } catch (e: Exception) {
            logger.error("Error deserializando medios de pago", e)
            defaultPaymentMethods()
        }
    }

    private fun defaultPaymentMethods(): List<PaymentMethodRecord> = listOf(
        PaymentMethodRecord(id = "cash", name = "Efectivo", type = "CASH", isCashOnDelivery = true, enabled = true),
        PaymentMethodRecord(id = "transfer", name = "Transferencia", type = "TRANSFER", enabled = false),
        PaymentMethodRecord(id = "mercadopago", name = "Mercado Pago", type = "MERCADOPAGO", enabled = false)
    )

    private fun buildResponse(
        methods: List<PaymentMethodRecord>,
        status: HttpStatusCode = HttpStatusCode.OK
    ): BusinessPaymentMethodsResponse {
        val list = methods.map { pm ->
            mapOf(
                "id" to pm.id,
                "name" to pm.name,
                "type" to pm.type,
                "description" to pm.description,
                "isCashOnDelivery" to pm.isCashOnDelivery,
                "enabled" to pm.enabled,
                "integrationData" to pm.integrationData
            )
        }
        return BusinessPaymentMethodsResponse(paymentMethods = list, status = status)
    }
}
