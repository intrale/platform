package ar.com.intrale.shared.client

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class RecommendedProductDTO(
    val id: String,
    val name: String,
    val basePrice: Double,
    val emoji: String? = null,
    val isAvailable: Boolean = true,
    val promotionPrice: Double? = null,
    val reason: String? = null
)

@Serializable
data class RecommendedProductsResponse(
    val statusCode: StatusCodeDTO = StatusCodeDTO(200, "OK"),
    val products: List<RecommendedProductDTO> = emptyList()
)
