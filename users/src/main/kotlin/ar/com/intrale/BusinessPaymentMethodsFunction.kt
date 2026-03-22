package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

internal val DEFAULT_PAYMENT_METHODS: List<PaymentMethodRecord> = listOf(
    PaymentMethodRecord(id = "cash", name = "Efectivo", type = "CASH", enabled = true, isCashOnDelivery = true),
    PaymentMethodRecord(id = "transfer", name = "Transferencia", type = "TRANSFER", enabled = false),
    PaymentMethodRecord(id = "mercadopago", name = "Mercado Pago", type = "DIGITAL_WALLET", enabled = false)
)

data class PaymentMethodRecord(
    val id: String = "",
    val name: String = "",
    val type: String = "",
    val enabled: Boolean = false,
    val description: String? = null,
    val isCashOnDelivery: Boolean = false
)

data class UpdatePaymentMethodsRequest(
    val paymentMethods: List<PaymentMethodRecord> = emptyList()
)

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
        val methods = existing?.paymentMethodsJson?.toPaymentMethods() ?: DEFAULT_PAYMENT_METHODS
        logger.debug("Retornando ${methods.size} medios de pago para negocio=$business")
        return BusinessPaymentMethodsResponse(paymentMethods = methods)
    }

    private fun handlePut(business: String, textBody: String): Response {
        val body = parseBody<UpdatePaymentMethodsRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (body.paymentMethods.isEmpty()) {
            return RequestValidationException("Debe configurar al menos un medio de pago")
        }

        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado")

        existing.paymentMethodsJson = gson.toJson(body.paymentMethods)
        tableBusiness.updateItem(existing)

        logger.debug("Medios de pago actualizados para negocio=$business")
        return BusinessPaymentMethodsResponse(
            paymentMethods = body.paymentMethods,
            status = HttpStatusCode.OK
        )
    }

    private fun String.toPaymentMethods(): List<PaymentMethodRecord> =
        runCatching {
            val type = object : TypeToken<List<PaymentMethodRecord>>() {}.type
            gson.fromJson<List<PaymentMethodRecord>>(this, type) ?: DEFAULT_PAYMENT_METHODS
        }.getOrDefault(DEFAULT_PAYMENT_METHODS)
}
