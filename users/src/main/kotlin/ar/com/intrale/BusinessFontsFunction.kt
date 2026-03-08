package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class BusinessFontsFunction(
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
        logger.debug("Iniciando business/fonts para negocio=$business")

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
            ?: return BusinessFontsResponse(fonts = emptyMap())
        logger.debug("Retornando fonts para negocio=$business: ${existing.fonts}")
        return BusinessFontsResponse(fonts = existing.fonts.toMap())
    }

    private fun handlePut(business: String, textBody: String): Response {
        val body = parseBody<BusinessFontsRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        val allowedTypes = setOf("title", "subtitle", "body", "button")
        val invalidKeys = body.fonts.keys.filter { it !in allowedTypes }
        if (invalidKeys.isNotEmpty()) {
            return RequestValidationException(
                "Tipos de fuente invalidos: ${invalidKeys.joinToString()}. Permitidos: ${allowedTypes.joinToString()}"
            )
        }

        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado")

        existing.fonts.clear()
        existing.fonts.putAll(body.fonts)
        tableBusiness.updateItem(existing)

        logger.debug("Fonts actualizadas para negocio=$business: ${existing.fonts}")
        return BusinessFontsResponse(
            fonts = existing.fonts.toMap(),
            status = HttpStatusCode.OK
        )
    }
}
