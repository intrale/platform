package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import java.util.UUID

// --- Request/Response DTOs ---

/**
 * Request para evaluar la calidad de una foto de producto.
 * La imagen se envia en base64.
 */
data class PhotoQualityRequest(
    val productId: String = "",
    val imageBase64: String = "",
    val mediaType: String = "image/jpeg",
    val productName: String? = null
)

/**
 * Respuesta con la evaluacion de calidad de una foto.
 */
class PhotoQualityResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val productId: String = "",
    val overallScore: Double = 0.0,
    val quality: String = "BAD",
    val issues: List<String> = emptyList(),
    val recommendations: List<String> = emptyList(),
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Respuesta con el historial de evaluaciones de un negocio.
 */
class PhotoQualityListResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val assessments: List<PhotoQualityAssessmentDto> = emptyList(),
    val totalLowQuality: Int = 0,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class PhotoQualityAssessmentDto(
    val productId: String = "",
    val overallScore: Double = 0.0,
    val quality: String = "BAD",
    val issues: List<String> = emptyList(),
    val recommendations: List<String> = emptyList(),
    val timestamp: Long = 0
)

/**
 * Endpoint protegido para evaluar la calidad de fotos de productos.
 * Solo accesible para administradores de negocio y vendedores.
 *
 * POST /{business}/business/photo-quality     -> Evaluar una foto
 * GET  /{business}/business/photo-quality      -> Listar evaluaciones (filtro opcional: ?filter=low)
 * GET  /{business}/business/photo-quality/{id} -> Obtener evaluacion de un producto
 */
class PhotoQualityFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val photoQualityService: PhotoQualityService,
    private val photoQualityRepository: PhotoQualityRepository,
    private val productRepository: ProductRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    private val validMediaTypes = setOf("image/jpeg", "image/png", "image/gif", "image/webp")

    // Limite de tamanio de imagen: ~10 MB en base64 (~7.5 MB binario)
    private val maxBase64Length = 10 * 1024 * 1024

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando business/photo-quality para negocio=$business function=$function")

        requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_SALER
        ) ?: return UnauthorizedException()

        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()

        return when (method) {
            HttpMethod.Post.value.uppercase() -> handleEvaluate(business, textBody)
            HttpMethod.Get.value.uppercase() -> handleGet(business, function, headers)
            else -> RequestValidationException("Metodo no soportado: $method")
        }
    }

    /**
     * POST: Evalua la calidad de una foto de producto usando Claude Vision.
     * La evaluacion se guarda como metadata asociada al producto.
     */
    private suspend fun handleEvaluate(business: String, textBody: String): Response {
        val request = parseBody<PhotoQualityRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        // Validaciones
        if (request.imageBase64.isBlank()) {
            return RequestValidationException("La imagen en base64 es requerida")
        }

        if (request.imageBase64.length > maxBase64Length) {
            return RequestValidationException("La imagen supera el tamanio maximo permitido (10 MB)")
        }

        if (request.mediaType !in validMediaTypes) {
            return RequestValidationException(
                "Tipo de imagen no soportado: ${request.mediaType}. Tipos validos: ${validMediaTypes.joinToString()}"
            )
        }

        // Si se indica productId, verificar que el producto existe
        val productName = if (request.productId.isNotBlank()) {
            val product = productRepository.getProduct(business, request.productId)
            if (product == null) {
                return ExceptionResponse("Producto no encontrado: ${request.productId}", HttpStatusCode.NotFound)
            }
            product.name
        } else {
            request.productName
        }

        // Evaluar la foto con Claude Vision (async en produccion, sync aca)
        logger.info("Evaluando calidad de foto para negocio=$business productId=${request.productId}")
        val result = photoQualityService.evaluatePhoto(
            imageBase64 = request.imageBase64,
            mediaType = request.mediaType,
            productName = productName
        )

        // Guardar resultado si hay productId
        if (request.productId.isNotBlank()) {
            val record = PhotoQualityRecord(
                id = UUID.randomUUID().toString(),
                businessId = business.lowercase(),
                productId = request.productId,
                overallScore = result.overallScore,
                quality = result.quality.name,
                issues = result.issues,
                recommendations = result.recommendations
            )
            photoQualityRepository.save(business, record)
            logger.debug("Evaluacion guardada para producto=${request.productId} score=${result.overallScore}")
        }

        return PhotoQualityResponse(
            productId = request.productId,
            overallScore = result.overallScore,
            quality = result.quality.name,
            issues = result.issues,
            recommendations = result.recommendations
        )
    }

    /**
     * GET: Obtiene evaluaciones de calidad.
     * - Sin parametros: lista todas las evaluaciones del negocio
     * - Con filter=low: solo las de baja calidad
     * - Con productId en la URL: evaluacion especifica de un producto
     */
    private fun handleGet(business: String, function: String, headers: Map<String, String>): Response {
        // Extraer productId si viene en la ruta (business/photo-quality/{productId})
        val segments = function.split("/")
        val productId = if (segments.size > 2) segments[2] else null

        if (!productId.isNullOrBlank()) {
            // Obtener evaluacion de un producto especifico
            val record = photoQualityRepository.getByProduct(business, productId)
                ?: return ExceptionResponse("No hay evaluacion para el producto: $productId", HttpStatusCode.NotFound)

            return PhotoQualityResponse(
                productId = record.productId,
                overallScore = record.overallScore,
                quality = record.quality,
                issues = record.issues,
                recommendations = record.recommendations
            )
        }

        // Listar evaluaciones
        val filter = headers["X-Query-Filter"]
        val assessments = if (filter == "low") {
            photoQualityRepository.listLowQuality(business)
        } else {
            photoQualityRepository.listByBusiness(business)
        }

        val lowQualityCount = photoQualityRepository.listLowQuality(business).size

        return PhotoQualityListResponse(
            assessments = assessments.map { it.toDto() },
            totalLowQuality = lowQualityCount
        )
    }

    private fun PhotoQualityRecord.toDto() = PhotoQualityAssessmentDto(
        productId = productId,
        overallScore = overallScore,
        quality = quality,
        issues = issues,
        recommendations = recommendations,
        timestamp = timestamp
    )
}
