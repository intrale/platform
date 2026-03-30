package ar.com.intrale

import io.ktor.http.HttpStatusCode

data class ProductRecommendationPayload(
    val id: String,
    val name: String,
    val basePrice: Double,
    val isAvailable: Boolean,
    val stockQuantity: Int? = null,
    val isFeatured: Boolean = false,
    val promotionPrice: Double? = null,
    val score: Double = 0.0
)

class ProductRecommendationResponse(
    val recommendations: List<ProductRecommendationPayload> = emptyList(),
    val source: String = "co-occurrence",
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

fun ProductRecord.toRecommendationPayload(score: Double = 0.0) = ProductRecommendationPayload(
    id = id,
    name = name,
    basePrice = basePrice,
    isAvailable = isAvailable,
    stockQuantity = stockQuantity,
    isFeatured = isFeatured,
    promotionPrice = promotionPrice,
    score = score
)
