package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

// --- Responses ---

/**
 * Respuesta del dashboard de sentimiento.
 */
class ReviewSentimentDashboardResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val distribution: Map<String, Int> = emptyMap(),
    val topThemes: List<Map<String, Any>> = emptyList(),
    val weeklySummary: Map<String, Any>? = null,
    val negativeAlert: Map<String, Any>? = null,
    val recentReviews: List<Map<String, Any>> = emptyList(),
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Respuesta de reviews filtradas por tema.
 */
class ReviewsByThemeResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val theme: String = "",
    val reviews: List<Map<String, Any>> = emptyList(),
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Respuesta al enviar una nueva review.
 */
class SubmitReviewResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 201, "description" to "Created"),
    val review: Map<String, Any> = emptyMap(),
    status: HttpStatusCode = HttpStatusCode.Created
) : Response(statusCode = status)

// --- Request ---

data class SubmitReviewRequest(
    val reviewText: String = "",
    val rating: Int? = null
)

// --- Alerta threshold ---

private const val NEGATIVE_ALERT_THRESHOLD = 2

/**
 * Endpoint protegido para el dashboard de analisis de sentimiento de reviews.
 *
 * GET /{business}/business/review-sentiment -> Dashboard completo
 * GET /{business}/business/review-sentiment/by-theme?theme=X -> Reviews por tema
 * POST /{business}/business/review-sentiment -> Enviar nueva review para clasificar
 *
 * Requiere perfil BusinessAdmin aprobado.
 */
class ReviewSentimentFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableBusiness: DynamoDbTable<Business>,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val sentimentService: SentimentAnalysisService,
    private val reviewRepository: ReviewSentimentRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando business/review-sentiment para negocio=$business, function=$function")

        // Verificar que el negocio existe
        val key = Business().apply { name = business }
        tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()

        // Determinar sub-ruta
        val subPath = extractSubPath(function)

        return when {
            method == HttpMethod.Post.value.uppercase() -> handleSubmitReview(business, textBody, headers)
            method == HttpMethod.Get.value.uppercase() && subPath == "by-theme" -> handleGetByTheme(business, headers)
            method == HttpMethod.Get.value.uppercase() -> handleGetDashboard(business)
            else -> RequestValidationException("Metodo no soportado: $method")
        }
    }

    /**
     * POST: Recibe una review, la clasifica con IA y la almacena.
     * Este endpoint puede ser llamado por cualquier usuario autenticado (no solo admin).
     */
    private suspend fun handleSubmitReview(
        business: String,
        textBody: String,
        headers: Map<String, String>
    ): Response {
        val body = parseBody<SubmitReviewRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (body.reviewText.isBlank()) {
            return RequestValidationException("El texto de la review no puede estar vacio")
        }

        if (body.reviewText.length > 2000) {
            return RequestValidationException("El texto de la review no puede superar los 2000 caracteres")
        }

        body.rating?.let { rating ->
            if (rating < 1 || rating > 5) {
                return RequestValidationException("El rating debe estar entre 1 y 5")
            }
        }

        // Clasificar con IA
        val classification = sentimentService.classifyReview(body.reviewText)

        // Guardar review clasificada
        val review = ClassifiedReview(
            business = business,
            reviewText = body.reviewText,
            rating = body.rating,
            sentiment = classification.sentiment,
            themes = classification.themes,
            confidence = classification.confidence
        )

        val saved = reviewRepository.saveReview(review)

        // Verificar si hay alerta de reviews negativas
        checkNegativeAlert(business)

        logger.info("Review clasificada para negocio=$business: sentimiento=${classification.sentiment}, temas=${classification.themes}")

        return SubmitReviewResponse(
            review = reviewToMap(saved)
        )
    }

    /**
     * GET: Retorna el dashboard completo de sentimiento.
     */
    private suspend fun handleGetDashboard(business: String): Response {
        // Solo el admin del negocio ve el dashboard
        val allReviews = reviewRepository.getReviews(business)
        val weeklyReviews = reviewRepository.getReviewsSince(business, 7)

        // Distribucion de sentimiento
        val distribution = reviewRepository.getSentimentDistribution(allReviews)

        // Temas mas frecuentes con sentimiento predominante
        val themesWithSentiment = reviewRepository.getThemesWithSentiment(allReviews, 10)
        val topThemes = themesWithSentiment.map { (theme, count, sentiment) ->
            mapOf<String, Any>(
                "theme" to theme,
                "count" to count,
                "sentiment" to sentiment
            )
        }

        // Resumen semanal
        val weeklySummary = if (weeklyReviews.isNotEmpty()) {
            val summaryResult = sentimentService.generateWeeklySummary(weeklyReviews, business)
            val weeklyDistribution = reviewRepository.getSentimentDistribution(weeklyReviews)
            mapOf<String, Any>(
                "summary" to summaryResult.summary,
                "periodStart" to LocalDate.now().minusDays(7).toString(),
                "periodEnd" to LocalDate.now().toString(),
                "totalReviews" to weeklyReviews.size,
                "distribution" to weeklyDistribution
            )
        } else {
            null
        }

        // Alerta de reviews negativas del dia
        val negativeToday = reviewRepository.getNegativeReviewsToday(business)
        val negativeAlert = if (negativeToday.size >= NEGATIVE_ALERT_THRESHOLD) {
            mapOf<String, Any>(
                "alertActive" to true,
                "negativeCount" to negativeToday.size,
                "date" to LocalDate.now().toString(),
                "reviews" to negativeToday.map { reviewToMap(it) }
            )
        } else {
            mapOf<String, Any>(
                "alertActive" to false,
                "negativeCount" to negativeToday.size,
                "date" to LocalDate.now().toString()
            )
        }

        // Ultimas 20 reviews
        val recentReviews = allReviews
            .sortedByDescending { it.createdAt }
            .take(20)
            .map { reviewToMap(it) }

        logger.debug("Dashboard de sentimiento para negocio=$business: total=${allReviews.size}, semana=${weeklyReviews.size}")

        return ReviewSentimentDashboardResponse(
            distribution = distribution,
            topThemes = topThemes,
            weeklySummary = weeklySummary,
            negativeAlert = negativeAlert,
            recentReviews = recentReviews
        )
    }

    /**
     * GET by-theme: Retorna reviews filtradas por un tema especifico.
     */
    private fun handleGetByTheme(business: String, headers: Map<String, String>): Response {
        val theme = headers["X-Theme"]
            ?: return RequestValidationException("Se requiere el header X-Theme con el tema a buscar")

        val reviews = reviewRepository.getReviewsByTheme(business, theme)
            .sortedByDescending { it.createdAt }
            .map { reviewToMap(it) }

        logger.debug("Reviews por tema '$theme' para negocio=$business: ${reviews.size} encontradas")

        return ReviewsByThemeResponse(
            theme = theme,
            reviews = reviews
        )
    }

    /**
     * Verifica si hay 2+ reviews negativas hoy y loguea la alerta.
     */
    private fun checkNegativeAlert(business: String) {
        val negativeToday = reviewRepository.getNegativeReviewsToday(business)
        if (negativeToday.size >= NEGATIVE_ALERT_THRESHOLD) {
            logger.warn(
                "ALERTA: ${negativeToday.size} reviews negativas hoy para negocio=$business. " +
                "Se recomienda accion inmediata."
            )
        }
    }

    /**
     * Extrae la sub-ruta de la funcion.
     * Ej: "business/review-sentiment/by-theme" -> "by-theme"
     */
    private fun extractSubPath(function: String): String? {
        val parts = function.split("/")
        return if (parts.size > 2) parts.last() else null
    }

    private fun reviewToMap(review: ClassifiedReview): Map<String, Any> {
        val map = mutableMapOf<String, Any>(
            "reviewId" to review.reviewId,
            "reviewText" to review.reviewText,
            "sentiment" to review.sentiment,
            "themes" to review.themes,
            "createdAt" to review.createdAt
        )
        review.rating?.let { map["rating"] = it }
        return map
    }
}
