package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Request para configurar el menu del dia.
 */
data class UpdateDailyMenuConfigRequest(
    val enabled: Boolean = false,
    val suggestionHour: Int = 8
)

/**
 * Respuesta con la configuracion actual del menu del dia.
 */
class DailyMenuConfigResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val dailyMenuEnabled: Boolean = false,
    val suggestionHour: Int = 8,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Endpoint protegido para que el administrador del negocio active/desactive
 * y configure el menu del dia automatico.
 *
 * GET /{business}/business/daily-menu-config -> Estado actual
 * PUT /{business}/business/daily-menu-config -> Activar/desactivar y configurar hora
 */
class DailyMenuConfigFunction(
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
        logger.debug("Iniciando business/daily-menu-config para negocio=$business")

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

        logger.debug("Retornando config daily-menu para negocio=$business: enabled=${existing.dailyMenuEnabled}, hour=${existing.dailyMenuSuggestionHour}")
        return DailyMenuConfigResponse(
            dailyMenuEnabled = existing.dailyMenuEnabled,
            suggestionHour = existing.dailyMenuSuggestionHour
        )
    }

    private fun handlePut(business: String, textBody: String): Response {
        val body = parseBody<UpdateDailyMenuConfigRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (body.suggestionHour < 0 || body.suggestionHour > 23) {
            return RequestValidationException("La hora de sugerencia debe estar entre 0 y 23")
        }

        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        existing.dailyMenuEnabled = body.enabled
        existing.dailyMenuSuggestionHour = body.suggestionHour
        tableBusiness.updateItem(existing)

        logger.info("Menu del dia ${if (body.enabled) "activado" else "desactivado"} para negocio=$business (hora: ${body.suggestionHour})")
        return DailyMenuConfigResponse(
            dailyMenuEnabled = body.enabled,
            suggestionHour = body.suggestionHour
        )
    }
}
