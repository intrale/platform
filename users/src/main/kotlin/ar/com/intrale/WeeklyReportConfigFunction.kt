package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Request para configurar reportes semanales.
 */
data class UpdateWeeklyReportConfigRequest(
    val enabled: Boolean = false,
    val contactType: String? = null,
    val contactId: String? = null
)

/**
 * Respuesta con la configuracion actual de reportes semanales.
 */
class WeeklyReportConfigResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val enabled: Boolean = false,
    val contactType: String? = null,
    val contactId: String? = null,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Endpoint protegido para que el administrador del negocio configure
 * los reportes semanales ejecutivos.
 *
 * GET /{business}/business/weekly-report-config -> Estado actual
 * PUT /{business}/business/weekly-report-config -> Actualizar configuracion
 * DELETE /{business}/business/weekly-report-config -> Desactivar reportes
 */
class WeeklyReportConfigFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableBusiness: DynamoDbTable<Business>,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    companion object {
        private val VALID_CONTACT_TYPES = setOf("telegram", "whatsapp")
    }

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando business/weekly-report-config para negocio=$business")

        requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: return UnauthorizedException()

        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()

        return when (method) {
            HttpMethod.Get.value.uppercase() -> handleGet(business)
            HttpMethod.Put.value.uppercase() -> handlePut(business, textBody)
            HttpMethod.Delete.value.uppercase() -> handleDelete(business)
            else -> RequestValidationException("Metodo no soportado: $method")
        }
    }

    private fun handleGet(business: String): Response {
        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        logger.debug("Retornando config weekly-report para negocio=$business: enabled=${existing.weeklyReportEnabled}")
        return WeeklyReportConfigResponse(
            enabled = existing.weeklyReportEnabled,
            contactType = existing.weeklyReportContactType,
            contactId = existing.weeklyReportContactId
        )
    }

    private fun handlePut(business: String, textBody: String): Response {
        val body = parseBody<UpdateWeeklyReportConfigRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        // Validar tipo de contacto si se activa
        if (body.enabled) {
            if (body.contactType.isNullOrBlank()) {
                return RequestValidationException("contactType es requerido cuando se activa el reporte (telegram o whatsapp)")
            }
            if (body.contactType.lowercase() !in VALID_CONTACT_TYPES) {
                return RequestValidationException("contactType invalido: ${body.contactType}. Valores permitidos: telegram, whatsapp")
            }
            if (body.contactId.isNullOrBlank()) {
                return RequestValidationException("contactId es requerido cuando se activa el reporte")
            }
        }

        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        existing.weeklyReportEnabled = body.enabled
        existing.weeklyReportContactType = body.contactType?.lowercase()
        existing.weeklyReportContactId = body.contactId
        tableBusiness.updateItem(existing)

        logger.info("Reporte semanal ${if (body.enabled) "activado" else "desactivado"} para negocio=$business (canal=${body.contactType})")
        return WeeklyReportConfigResponse(
            enabled = body.enabled,
            contactType = body.contactType?.lowercase(),
            contactId = body.contactId
        )
    }

    private fun handleDelete(business: String): Response {
        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        existing.weeklyReportEnabled = false
        existing.weeklyReportContactType = null
        existing.weeklyReportContactId = null
        tableBusiness.updateItem(existing)

        logger.info("Reporte semanal desactivado para negocio=$business")
        return WeeklyReportConfigResponse(enabled = false)
    }
}
