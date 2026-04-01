package ar.com.intrale

/**
 * Registro interno de una sugerencia de promo para un producto con baja rotacion.
 */
data class PromoSuggestion(
    val id: String = "",
    val businessId: String = "",
    val productId: String = "",
    val productName: String = "",
    val promoType: String = "DISCOUNT_PERCENT",
    val discountPercent: Int? = null,
    val promoText: String = "",
    val reason: String = "",
    val status: String = "PENDING",
    val startDate: String? = null,
    val endDate: String? = null,
    val daysSinceLastSale: Int = 0,
    val createdAt: String = ""
)
