package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Tipo de promocion sugerida por el sistema.
 */
@Serializable
enum class PromoType {
    @SerialName("DISCOUNT_PERCENT")
    DiscountPercent,

    @SerialName("TWO_FOR_ONE")
    TwoForOne,

    @SerialName("COMBO")
    Combo;

    companion object {
        fun fromRaw(value: String?): PromoType =
            when (value?.uppercase()) {
                "TWO_FOR_ONE" -> TwoForOne
                "COMBO" -> Combo
                else -> DiscountPercent
            }
    }
}

/**
 * Estado de una promo sugerida.
 */
@Serializable
enum class PromoStatus {
    @SerialName("PENDING")
    Pending,

    @SerialName("APPROVED")
    Approved,

    @SerialName("REJECTED")
    Rejected,

    @SerialName("EXPIRED")
    Expired;

    companion object {
        fun fromRaw(value: String?): PromoStatus =
            when (value?.uppercase()) {
                "APPROVED" -> Approved
                "REJECTED" -> Rejected
                "EXPIRED" -> Expired
                else -> Pending
            }
    }
}

/**
 * DTO de una sugerencia de promo generada automaticamente.
 */
@Serializable
data class PromoSuggestionDTO(
    val id: String = "",
    val productId: String = "",
    val productName: String = "",
    val promoType: PromoType = PromoType.DiscountPercent,
    val discountPercent: Int? = null,
    val promoText: String = "",
    val reason: String = "",
    val status: PromoStatus = PromoStatus.Pending,
    val startDate: String? = null,
    val endDate: String? = null,
    val daysSinceLastSale: Int = 0,
    val createdAt: String? = null
)

/**
 * Respuesta con la lista de sugerencias de promo.
 */
@Serializable
data class PromoSuggestionsResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val suggestions: List<PromoSuggestionDTO> = emptyList()
)

/**
 * Request para aprobar/rechazar una promo sugerida.
 */
@Serializable
data class ReviewPromoRequestDTO(
    val action: String = "",
    val modifiedPromoText: String? = null,
    val modifiedDiscountPercent: Int? = null,
    val startDate: String? = null,
    val endDate: String? = null
)

/**
 * Request para configurar el umbral de baja rotacion.
 */
@Serializable
data class LowRotationConfigRequestDTO(
    val thresholdDays: Int = 7,
    val enabled: Boolean = true
)

/**
 * Respuesta con la configuracion actual de baja rotacion.
 */
@Serializable
data class LowRotationConfigResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val thresholdDays: Int = 7,
    val enabled: Boolean = false
)
