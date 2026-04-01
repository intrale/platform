package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

/**
 * Sentimiento de una review de cliente.
 */
@Serializable
enum class SentimentType {
    POSITIVE, NEUTRAL, NEGATIVE
}

/**
 * Review con su clasificacion de sentimiento.
 */
@Serializable
data class ClassifiedReviewDTO(
    val reviewId: String = "",
    val reviewText: String = "",
    val sentiment: String = "NEUTRAL",
    val themes: List<String> = emptyList(),
    val createdAt: String = ""
)

/**
 * Distribucion de sentimiento para el dashboard.
 */
@Serializable
data class SentimentDistributionDTO(
    val positive: Int = 0,
    val neutral: Int = 0,
    val negative: Int = 0,
    val total: Int = 0
)

/**
 * Tema recurrente con frecuencia.
 */
@Serializable
data class ThemeFrequencyDTO(
    val theme: String = "",
    val count: Int = 0,
    val sentiment: String = "NEUTRAL"
)

/**
 * Resumen semanal de feedback.
 */
@Serializable
data class WeeklySummaryDTO(
    val summary: String = "",
    val periodStart: String = "",
    val periodEnd: String = "",
    val totalReviews: Int = 0,
    val distribution: SentimentDistributionDTO = SentimentDistributionDTO()
)

/**
 * Alerta por reviews negativas.
 */
@Serializable
data class NegativeAlertDTO(
    val alertActive: Boolean = false,
    val negativeCount: Int = 0,
    val date: String = "",
    val reviews: List<ClassifiedReviewDTO> = emptyList()
)

/**
 * Respuesta completa del dashboard de sentimiento.
 */
@Serializable
data class ReviewSentimentDashboardResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val distribution: SentimentDistributionDTO = SentimentDistributionDTO(),
    val topThemes: List<ThemeFrequencyDTO> = emptyList(),
    val weeklySummary: WeeklySummaryDTO? = null,
    val negativeAlert: NegativeAlertDTO? = null,
    val recentReviews: List<ClassifiedReviewDTO> = emptyList()
)

/**
 * Respuesta de reviews filtradas por tema.
 */
@Serializable
data class ReviewsByThemeResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val theme: String = "",
    val reviews: List<ClassifiedReviewDTO> = emptyList()
)

/**
 * Request para enviar una review de cliente.
 */
@Serializable
data class SubmitReviewRequestDTO(
    val reviewText: String = "",
    val rating: Int? = null
)

/**
 * Respuesta al enviar una review clasificada.
 */
@Serializable
data class SubmitReviewResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val review: ClassifiedReviewDTO = ClassifiedReviewDTO()
)
