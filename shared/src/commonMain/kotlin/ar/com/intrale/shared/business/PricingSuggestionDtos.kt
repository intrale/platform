package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Sugerencia de pricing generada por IA basada en patrones de demanda.
 */
@Serializable
data class PricingSuggestionDTO(
    @SerialName("id")
    val id: String = "",
    @SerialName("productName")
    val productName: String = "",
    @SerialName("currentPrice")
    val currentPrice: Double = 0.0,
    @SerialName("suggestedPrice")
    val suggestedPrice: Double = 0.0,
    @SerialName("changePercent")
    val changePercent: Double = 0.0,
    @SerialName("reason")
    val reason: String = "",
    @SerialName("dataInsight")
    val dataInsight: String = "",
    @SerialName("timeSlot")
    val timeSlot: String? = null,
    @SerialName("dayOfWeek")
    val dayOfWeek: String? = null,
    @SerialName("status")
    val status: String = "pending",
    @SerialName("createdAt")
    val createdAt: String = "",
    @SerialName("scheduledStart")
    val scheduledStart: String? = null,
    @SerialName("scheduledEnd")
    val scheduledEnd: String? = null
)

/**
 * Respuesta con lista de sugerencias de pricing.
 */
@Serializable
data class PricingSuggestionsResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val suggestions: List<PricingSuggestionDTO> = emptyList()
)

/**
 * Entrada del historial de sugerencias aplicadas.
 */
@Serializable
data class PricingSuggestionHistoryDTO(
    @SerialName("id")
    val id: String = "",
    @SerialName("productName")
    val productName: String = "",
    @SerialName("originalPrice")
    val originalPrice: Double = 0.0,
    @SerialName("appliedPrice")
    val appliedPrice: Double = 0.0,
    @SerialName("changePercent")
    val changePercent: Double = 0.0,
    @SerialName("reason")
    val reason: String = "",
    @SerialName("status")
    val status: String = "",
    @SerialName("decidedAt")
    val decidedAt: String = "",
    @SerialName("impactSummary")
    val impactSummary: String? = null
)

/**
 * Respuesta con historial de sugerencias.
 */
@Serializable
data class PricingSuggestionHistoryResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val history: List<PricingSuggestionHistoryDTO> = emptyList()
)
