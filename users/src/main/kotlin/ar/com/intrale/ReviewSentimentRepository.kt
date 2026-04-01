package ar.com.intrale

import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Review clasificada almacenada en el repositorio.
 */
data class ClassifiedReview(
    val reviewId: String = UUID.randomUUID().toString(),
    val business: String = "",
    val reviewText: String = "",
    val rating: Int? = null,
    val sentiment: String = "NEUTRAL",
    val themes: List<String> = emptyList(),
    val confidence: Double = 0.0,
    val createdAt: String = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
)

/**
 * Repositorio para reviews clasificadas por sentimiento.
 * Usa almacenamiento en memoria (ConcurrentHashMap) por ahora.
 * En produccion se migrara a DynamoDB.
 */
class ReviewSentimentRepository {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")

    // business -> lista de reviews
    private val store = ConcurrentHashMap<String, MutableList<ClassifiedReview>>()

    /**
     * Guarda una review clasificada.
     */
    fun saveReview(review: ClassifiedReview): ClassifiedReview {
        store.getOrPut(review.business) { mutableListOf() }.add(review)
        logger.debug("Review guardada para negocio=${review.business}, sentimiento=${review.sentiment}")
        return review
    }

    /**
     * Obtiene todas las reviews de un negocio.
     */
    fun getReviews(business: String): List<ClassifiedReview> {
        return store[business]?.toList() ?: emptyList()
    }

    /**
     * Obtiene reviews de un negocio de los ultimos N dias.
     */
    fun getReviewsSince(business: String, days: Int): List<ClassifiedReview> {
        val cutoff = LocalDate.now().minusDays(days.toLong())
        return getReviews(business).filter { review ->
            try {
                val reviewDate = LocalDate.parse(review.createdAt.substring(0, 10))
                !reviewDate.isBefore(cutoff)
            } catch (e: Exception) {
                false
            }
        }
    }

    /**
     * Obtiene reviews negativas del dia actual.
     */
    fun getNegativeReviewsToday(business: String): List<ClassifiedReview> {
        val today = LocalDate.now().toString()
        return getReviews(business).filter { review ->
            review.sentiment == "NEGATIVE" && review.createdAt.startsWith(today)
        }
    }

    /**
     * Obtiene reviews filtradas por tema.
     */
    fun getReviewsByTheme(business: String, theme: String): List<ClassifiedReview> {
        return getReviews(business).filter { review ->
            review.themes.any { it.equals(theme, ignoreCase = true) }
        }
    }

    /**
     * Calcula la distribucion de sentimiento.
     */
    fun getSentimentDistribution(reviews: List<ClassifiedReview>): Map<String, Int> {
        return mapOf(
            "POSITIVE" to reviews.count { it.sentiment == "POSITIVE" },
            "NEUTRAL" to reviews.count { it.sentiment == "NEUTRAL" },
            "NEGATIVE" to reviews.count { it.sentiment == "NEGATIVE" }
        )
    }

    /**
     * Obtiene los temas mas frecuentes con conteo.
     */
    fun getTopThemes(reviews: List<ClassifiedReview>, limit: Int = 10): List<Pair<String, Int>> {
        return reviews
            .flatMap { it.themes }
            .groupingBy { it.lowercase() }
            .eachCount()
            .entries
            .sortedByDescending { it.value }
            .take(limit)
            .map { it.key to it.value }
    }

    /**
     * Obtiene los temas con su sentimiento predominante.
     */
    fun getThemesWithSentiment(reviews: List<ClassifiedReview>, limit: Int = 10): List<Triple<String, Int, String>> {
        val themeReviews = mutableMapOf<String, MutableList<ClassifiedReview>>()
        reviews.forEach { review ->
            review.themes.forEach { theme ->
                themeReviews.getOrPut(theme.lowercase()) { mutableListOf() }.add(review)
            }
        }

        return themeReviews.entries
            .sortedByDescending { it.value.size }
            .take(limit)
            .map { (theme, themeRevs) ->
                val predominant = themeRevs
                    .groupingBy { it.sentiment }
                    .eachCount()
                    .maxByOrNull { it.value }
                    ?.key ?: "NEUTRAL"
                Triple(theme, themeRevs.size, predominant)
            }
    }
}
