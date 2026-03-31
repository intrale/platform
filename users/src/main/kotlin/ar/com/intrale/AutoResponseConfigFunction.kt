package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Request para activar/desactivar respuestas automaticas.
 */
data class UpdateAutoResponseConfigRequest(
    val enabled: Boolean = false
)

/**
 * Respuesta con la configuracion actual de respuestas automaticas.
 */
class AutoResponseConfigResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val autoResponseEnabled: Boolean = false,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Endpoint protegido para que el administrador del negocio active/desactive
 * las respuestas automaticas con IA.
 *
 * GET /{business}/business/auto-response-config -> Estado actual
 * PUT /{business}/business/auto-response-config -> Activar/desactivar
 */
class AutoResponseConfigFunction(
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
        logger.debug("Iniciando business/auto-response-config para negocio=$business")

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
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        logger.debug("Retornando config auto-response para negocio=$business: enabled=${existing.autoResponseEnabled}")
        return AutoResponseConfigResponse(autoResponseEnabled = existing.autoResponseEnabled)
    }

    private fun handlePut(business: String, textBody: String): Response {
        val body = parseBody<UpdateAutoResponseConfigRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        existing.autoResponseEnabled = body.enabled
        tableBusiness.updateItem(existing)

        logger.info("Respuestas automaticas ${if (body.enabled) "activadas" else "desactivadas"} para negocio=$business")
        return AutoResponseConfigResponse(
            autoResponseEnabled = body.enabled
        )
    }
}
