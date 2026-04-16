package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Endpoint para analizar fotos de productos con IA (Claude Vision).
 * Recibe una imagen en base64 y devuelve nombre, descripcion y categoria sugeridos.
 *
 * Ruta: POST /{business}/business/products/analyze-photo
 */
class AnalyzeProductPhoto(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val categoryRepository: CategoryRepository,
    private val photoAnalyzer: ProductPhotoAnalyzer,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando analyze-photo para negocio=$business")

        requireApprovedProfile(cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN)
            ?: requireApprovedProfile(cognito, headers, tableProfiles, business, PROFILE_SALER)
            ?: return UnauthorizedException()

        val body = parseBody<AnalyzeProductPhotoRequestBody>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (body.imageBase64.isBlank()) {
            return RequestValidationException("La imagen es requerida")
        }

        // Obtener categorias existentes del negocio para sugerencia contextual
        val existingCategories = categoryRepository.listCategories(business)
            .map { it.name }

        val result = photoAnalyzer.analyze(
            imageBase64 = body.imageBase64,
            mediaType = body.mediaType ?: "image/jpeg",
            existingCategories = existingCategories
        )

        logger.debug("Analisis de foto completado: nombre='${result.suggestedName}' confidence=${result.confidence}")

        return AnalyzeProductPhotoResponse(
            suggestedName = result.suggestedName,
            suggestedDescription = result.suggestedDescription,
            suggestedCategory = result.suggestedCategory,
            confidence = result.confidence,
            status = HttpStatusCode.OK
        )
    }
}

/**
 * Body del request para analisis de foto.
 * Usa Gson en el backend, por eso no lleva @Serializable.
 */
data class AnalyzeProductPhotoRequestBody(
    val imageBase64: String = "",
    val mediaType: String? = "image/jpeg",
    val existingCategories: List<String> = emptyList()
)

/**
 * Respuesta del analisis de foto.
 */
class AnalyzeProductPhotoResponse(
    val suggestedName: String,
    val suggestedDescription: String,
    val suggestedCategory: String,
    val confidence: Double,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
