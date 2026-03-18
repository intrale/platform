package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class BusinessConfigFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableBusiness: DynamoDbTable<Business>,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando business/config para negocio=$business")

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
            ?: return BusinessConfigResponse(config = emptyMap())

        val configMap = mapOf(
            "name" to (existing.name ?: ""),
            "address" to (existing.address ?: ""),
            "phone" to (existing.phone ?: ""),
            "email" to (existing.emailAdmin ?: ""),
            "logoUrl" to (existing.logoUrl ?: "")
        )
        logger.debug("Retornando config para negocio=$business")
        return BusinessConfigResponse(config = configMap)
    }

    private fun handlePut(business: String, textBody: String): Response {
        val body = parseBody<BusinessConfigRequestBody>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (body.name.isBlank()) {
            return RequestValidationException("El nombre comercial es obligatorio")
        }

        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado")

        existing.address = body.address
        existing.phone = body.phone
        existing.emailAdmin = body.email
        existing.logoUrl = body.logoUrl
        tableBusiness.updateItem(existing)

        val configMap = mapOf(
            "name" to (existing.name ?: ""),
            "address" to (existing.address ?: ""),
            "phone" to (existing.phone ?: ""),
            "email" to (existing.emailAdmin ?: ""),
            "logoUrl" to (existing.logoUrl ?: "")
        )
        logger.debug("Config actualizada para negocio=$business")
        return BusinessConfigResponse(
            config = configMap,
            status = HttpStatusCode.OK
        )
    }
}

/** Body del request PUT para actualizar configuracion del negocio */
data class BusinessConfigRequestBody(
    val name: String = "",
    val address: String = "",
    val phone: String = "",
    val email: String = "",
    val logoUrl: String = ""
)
