package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Request para aprobar o rechazar una sugerencia de menu del dia.
 */
data class DailyMenuActionRequest(
    val action: String = "",
    val suggestionId: String = ""
)

/**
 * Respuesta del endpoint de aprobacion/rechazo de menu del dia.
 */
class DailyMenuApproveResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val suggestion: DailyMenuSuggestion? = null,
    val message: String = "",
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Endpoint protegido para que el administrador del negocio apruebe o rechace
 * una sugerencia de menu del dia.
 *
 * POST /{business}/business/daily-menu-approve
 * Body: { "action": "approve|reject", "suggestionId": "..." }
 *
 * Al aprobar, el menu se marca como APPROVED y los productos se destacan.
 * Al rechazar, se marca como REJECTED.
 */
class DailyMenuApproveFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableBusiness: DynamoDbTable<Business>,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val menuRepository: DailyMenuRepository,
    private val productRepository: ProductRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando business/daily-menu-approve para negocio=$business")

        requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: return UnauthorizedException()

        val request = parseBody<DailyMenuActionRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (request.suggestionId.isBlank()) {
            return RequestValidationException("El campo suggestionId es obligatorio")
        }

        val validActions = listOf("approve", "reject")
        if (request.action.lowercase() !in validActions) {
            return RequestValidationException("Accion invalida. Valores permitidos: ${validActions.joinToString(", ")}")
        }

        val suggestion = menuRepository.getSuggestionById(business, request.suggestionId)
            ?: return ExceptionResponse("Sugerencia no encontrada", HttpStatusCode.NotFound)

        if (suggestion.status != "PENDING") {
            return ExceptionResponse(
                "La sugerencia ya fue procesada (estado: ${suggestion.status})",
                HttpStatusCode.Conflict
            )
        }

        return when (request.action.lowercase()) {
            "approve" -> handleApprove(business, suggestion)
            "reject" -> handleReject(business, suggestion)
            else -> RequestValidationException("Accion invalida")
        }
    }

    private fun handleApprove(business: String, suggestion: DailyMenuSuggestion): Response {
        val updated = menuRepository.updateSuggestionStatus(business, suggestion.id, "APPROVED")
            ?: return ExceptionResponse("Error actualizando sugerencia", HttpStatusCode.InternalServerError)

        // Destacar los productos del menu en el catalogo
        suggestion.items.forEach { item ->
            if (item.productId.isNotBlank()) {
                val product = productRepository.getProduct(business, item.productId)
                if (product != null) {
                    productRepository.updateProduct(business, item.productId, product.copy(isFeatured = true))
                }
            }
        }

        // Guardar referencia del menu aprobado en el negocio
        val businessEntity = tableBusiness.getItem(Business().apply { name = business })
        if (businessEntity != null) {
            val recentMenus = menuRepository.getRecentApprovedMenus(business, days = 7)
            val menuSummaries = recentMenus.map { m ->
                mapOf("date" to m.date, "title" to m.title, "items" to m.items.map { it.productName })
            }
            businessEntity.lastMenusJson = com.google.gson.Gson().toJson(menuSummaries)
            tableBusiness.updateItem(businessEntity)
        }

        logger.info("Menu del dia APROBADO para negocio=$business id=${suggestion.id}")
        return DailyMenuApproveResponse(
            suggestion = updated,
            message = "Menu del dia aprobado y publicado en el catalogo"
        )
    }

    private fun handleReject(business: String, suggestion: DailyMenuSuggestion): Response {
        val updated = menuRepository.updateSuggestionStatus(business, suggestion.id, "REJECTED")
            ?: return ExceptionResponse("Error actualizando sugerencia", HttpStatusCode.InternalServerError)

        logger.info("Menu del dia RECHAZADO para negocio=$business id=${suggestion.id}")
        return DailyMenuApproveResponse(
            suggestion = updated,
            message = "Sugerencia rechazada. Podes pedir otra sugerencia o armar el menu manualmente."
        )
    }
}
